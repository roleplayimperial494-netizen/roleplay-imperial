// Roleplay Imperial — servidor do modo online (até 150 jogadores)
// Uso:  npm install  &&  npm start     (porta: variável PORT, padrão 3000)
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 3000;
const MAX = +process.env.MAX_PLAYERS || 150;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'users.json');
const TICK_MS = 120;                 // envio de posições (~8x por segundo)
const MAX_MONEY = 1e12;

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- contas (salvas em data/users.json, senha com scrypt) ----------
let users = {};
try { users = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { users = {}; }
let dirty = false, writing = false;
function flushDb() {
  if (!dirty || writing) return;
  dirty = false; writing = true;
  const tmp = DB_FILE + '.tmp';
  fs.writeFile(tmp, JSON.stringify(users), err => {
    if (!err) fs.rename(tmp, DB_FILE, () => { writing = false; });
    else writing = false;
  });
}
setInterval(flushDb, 5000);
const markDirty = () => { dirty = true; };
function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 32).toString('hex'); }

// ---------- ícone gerado na hora (PNG liso, sem arquivo extra) ----------
function makePng(size, rgb) {
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(size, 0); ih.writeUInt32BE(size, 4); ih[8] = 8; ih[9] = 2;
  const row = Buffer.alloc(1 + size * 3); for (let i = 0; i < size; i++) { row[1 + i * 3] = rgb[0]; row[2 + i * 3] = rgb[1]; row[3 + i * 3] = rgb[2]; }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const ICON192 = makePng(192, [27, 42, 68]), ICON512 = makePng(512, [27, 42, 68]);

const MANIFEST = JSON.stringify({
  name: 'Roleplay Imperial', short_name: 'Imperial', start_url: '/', display: 'fullscreen', display_override: ['fullscreen', 'standalone'],
  orientation: 'landscape', background_color: '#1b2a44', theme_color: '#1b2a44',
  icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }]
});
// service worker: sempre tenta a rede primeiro (o jogo nunca fica desatualizado)
const SW = `self.addEventListener('install',e=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;
e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open('ri1').then(x=>x.put(e.request,c)).catch(()=>{});return r}).catch(()=>caches.match(e.request)))});`;

// ---------- HTTP (serve o jogo) ----------
const INDEX = path.join(__dirname, 'index.html');
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const send = (type, body, cache) => { res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache || 'no-cache' }); res.end(body); };
  if (url === '/' || url === '/index.html') return fs.readFile(INDEX, (e, b) => e ? (res.writeHead(500), res.end('index.html não encontrado')) : send('text/html; charset=utf-8', b));
  if (url === '/manifest.json') return send('application/manifest+json', MANIFEST);
  if (url === '/sw.js') return send('application/javascript', SW);
  if (url === '/icon-192.png') return send('image/png', ICON192, 'public,max-age=86400');
  if (url === '/icon-512.png') return send('image/png', ICON512, 'public,max-age=86400');
  if (url === '/health') return send('application/json', JSON.stringify({ ok: true, online: players.size, max: MAX }));
  res.writeHead(404); res.end('404');
});

// ---------- jogo online ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024, perMessageDeflate: false });
const players = new Map();   // id -> jogador
const byName = new Map();    // nome minúsculo -> jogador
let nextId = 1;

const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function send(ws, o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }
function sendRaw(ws, s) { if (ws.readyState === 1) ws.send(s); }
function broadcast(o, except) { const s = JSON.stringify(o); for (const p of players.values()) if (p !== except) sendRaw(p.ws, s); }
const pub = p => ({ id: p.id, n: p.name, x: p.x, z: p.z, h: p.h, f: p.f });

// limitador simples (balde de fichas)
function allow(p, key, burst, perSec) {
  const now = Date.now(), b = p.rl[key] || (p.rl[key] = { t: burst, ts: now });
  b.t = Math.min(burst, b.t + (now - b.ts) / 1000 * perSec); b.ts = now;
  if (b.t < 1) return false; b.t -= 1; return true;
}

function persist(p, d) {
  const u = users[p.key]; if (!u) return;
  if (d.money !== undefined) u.money = clamp(Math.floor(num(d.money)), 0, MAX_MONEY);
  if (d.deliv !== undefined) u.deliv = clamp(Math.floor(num(d.deliv)), 0, 1e9);
  if (d.hasGun !== undefined) u.hasGun = !!d.hasGun;
  if (typeof d.x === 'string' && d.x.length < 12000) u.x = d.x;
  markDirty();
}

function login(ws, c, d, reg) {
  const name = String(d.u || '').trim(), pw = String(d.p || '');
  if (!/^[\p{L}\p{N}_.\-]{2,14}$/u.test(name)) return send(ws, { t: 'err', m: 'Usuário: 2 a 14 letras/números (sem espaços)' });
  if (pw.length < 3 || pw.length > 64) return send(ws, { t: 'err', m: 'Senha: de 3 a 64 caracteres' });
  const key = name.toLowerCase();
  if (players.size >= MAX && !byName.has(key)) return send(ws, { t: 'err', m: 'Servidor cheio (' + MAX + '/' + MAX + '). Tente de novo em instantes' });
  let u = users[key];
  if (reg) {
    if (u) return send(ws, { t: 'err', m: 'Esse usuário já existe. Use outro nome ou toque em ENTRAR' });
    const salt = crypto.randomBytes(16).toString('hex');
    u = users[key] = { name, salt, hash: hashPw(pw, salt), money: 0, deliv: 0, hasGun: false, x: '', created: Date.now() };
    markDirty();
  } else {
    if (!u) return send(ws, { t: 'err', m: 'Usuário não encontrado. Toque em CRIAR CONTA' });
    const a = Buffer.from(hashPw(pw, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return send(ws, { t: 'err', m: 'Senha incorreta' });
  }
  const old = byName.get(key);
  if (old) { send(old.ws, { t: 'err', m: 'Sua conta entrou em outro aparelho' }); old.ws.close(); drop(old); }

  const p = { id: nextId++, ws, key, name: u.name, x: 0, z: 0, h: 0, f: 1, s: 0, moved: false, rl: {} };
  c.player = p; players.set(p.id, p); byName.set(key, p);
  send(ws, { t: 'ok', id: p.id, n: p.name, money: u.money, deliv: u.deliv, hasGun: !!u.hasGun, x: u.x || '', count: players.size, players: [...players.values()].filter(q => q !== p).map(pub) });
  broadcast({ t: 'join', id: p.id, n: p.name, x: p.x, z: p.z, h: p.h, f: p.f }, p);
  broadcast({ t: 'count', n: players.size });
}

function drop(p) {
  if (!p || !players.has(p.id)) return;
  players.delete(p.id); if (byName.get(p.key) === p) byName.delete(p.key);
  broadcast({ t: 'leave', id: p.id }); broadcast({ t: 'count', n: players.size });
}

wss.on('connection', (ws, req) => {
  const c = { player: null, authFail: 0 };
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  send(ws, { t: 'hello', n: players.size, max: MAX });

  ws.on('message', raw => {
    let d; try { d = JSON.parse(raw); } catch (e) { return; }
    if (!d || typeof d.t !== 'string') return;
    const p = c.player;

    if (!p) {
      if (d.t !== 'login' && d.t !== 'reg') return;
      if (++c.authFail > 8) { send(ws, { t: 'err', m: 'Muitas tentativas' }); return ws.close(); }
      return login(ws, c, d, d.t === 'reg');
    }

    switch (d.t) {
      case 'pos':
        p.x = clamp(num(d.x), -5000, 5000); p.z = clamp(num(d.z), -5000, 5000);
        p.h = num(d.h); p.f = d.f ? 1 : 0; p.s = clamp(num(d.s), 0, 200); p.moved = true; break;
      case 'chat': {
        if (!allow(p, 'chat', 25, 12)) return;
        const m = String(d.m || '').slice(0, 120); if (!m) return;
        broadcast({ t: 'chat', n: p.name, m });          // inclui o próprio (o cliente trata o eco)
        break; }
      case 'voice': {
        if (!allow(p, 'voice', 60, 40) || typeof d.d !== 'string' || d.d.length >= 4000) return;
        broadcast({ t: 'voice', n: p.name, s: d.s | 0, d: d.d }, p); break; }
      case 'save':
        if (allow(p, 'save', 4, 1)) persist(p, d); break;
      case 'inv': case 'invr': {
        if (!allow(p, 'inv', 10, 2)) return;
        const to = byName.get(String(d.to || '').toLowerCase()); if (!to || to === p) return;
        const o = String(d.o || '').slice(0, 8);
        send(to.ws, d.t === 'inv' ? { t: 'inv', from: p.name, o } : { t: 'invr', from: p.name, o, ok: d.ok ? 1 : 0 });
        break; }
    }
  });

  ws.on('close', () => { const p = c.player; if (p) { drop(p); flushDb(); } });
  ws.on('error', () => {});
});

// posições: só quem se mexeu, em lote
setInterval(() => {
  const moved = [];
  for (const p of players.values()) if (p.moved) { p.moved = false; moved.push([p.id, +p.x.toFixed(2), +p.z.toFixed(2), +p.h.toFixed(3), p.f, +p.s.toFixed(1)]); }
  if (!moved.length) return;
  const s = JSON.stringify({ t: 'st', p: moved });
  for (const p of players.values()) sendRaw(p.ws, s);
}, TICK_MS);

// derruba conexões mortas
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (e) {} } }, 30000);

function bye() { flushDb(); setTimeout(() => process.exit(0), 300); }
process.on('SIGINT', bye); process.on('SIGTERM', bye);

server.listen(PORT, () => console.log('🌐 Roleplay Imperial online na porta ' + PORT + ' · máx. ' + MAX + ' jogadores'));
