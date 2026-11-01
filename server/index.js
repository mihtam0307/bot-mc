'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const { S, save, uid, DIR } = require('./store');
const { Worker, parseDirect } = require('./worker');
const ai = require('./ai');

const PORT = +process.env.PORT || 8080;
const UI = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'index.html');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const workers = new Map(), logs = [], aiLog = [], clients = new Set();
let aiState = { ok: false, at: 0 }, logDirty = false, startChain = Promise.resolve(), startEpoch = 0, dirtyT = null;

// ---------- log (chỉ giữ bản mới nhất) ----------
const fmt = e => `${new Date(e.ts).toLocaleTimeString('vi-VN')} [${e.lvl}] ${e.name}: ${e.text}`;
function log(id, lvl, text) {
  const b = S.bots.find(x => x.id === id);
  const e = { ts: Date.now(), id: id || null, name: b ? b.name : 'hệ thống', lvl, text: String(text).slice(0, 300) };
  logs.push(e); if (logs.length > 500) logs.shift();
  logDirty = true; bc({ t: 'log', e });
  if (lvl === 'error') console.error(fmt(e));
}
setInterval(() => { if (logDirty) { logDirty = false; fs.writeFile(path.join(DIR, 'latest.log'), logs.map(fmt).join('\n'), () => { }); } }, 5000);

// ---------- phát sóng ----------
function bc(obj) { const s = JSON.stringify(obj); for (const c of clients) if (c.readyState === 1) c.send(s); }
function stateMsg() {
  return {
    t: 'state', servers: S.servers, settings: S.settings, ai: aiState,
    mem: Math.round(process.memoryUsage().rss / 1048576),
    bots: S.bots.map(d => { const w = workers.get(d.id); return { id: d.id, name: d.name, serverId: d.serverId, ...(w ? w.brief() : { status: 'stopped', mode: 'idle' }) }; })
  };
}
function dirty() { if (!dirtyT) dirtyT = setTimeout(() => { dirtyT = null; bc(stateMsg()); }, 150); }
setInterval(() => bc(stateMsg()), 1000);

// ---------- bot ----------
const ctx = { server: id => S.servers.find(s => s.id === id), settings: () => S.settings, log, dirty, command };
function getWorker(id) {
  let w = workers.get(id);
  if (!w) { const d = S.bots.find(b => b.id === id); if (!d) return null; w = new Worker(d, ctx); workers.set(id, w); }
  return w;
}
function startBots(ids) {
  const ep = startEpoch;
  for (const id of ids) {
    startChain = startChain.then(async () => {
      if (ep !== startEpoch) return;
      const w = getWorker(id); if (!w || w.wantRun) return;
      const mb = process.memoryUsage().rss / 1048576;
      if (mb > S.settings.ramLimitMB) { log(id, 'error', `RAM ${Math.round(mb)}MB vượt giới hạn ${S.settings.ramLimitMB}MB — không chạy thêm bot`); return; }
      if ([...workers.values()].filter(x => x.wantRun).length >= S.settings.maxBots) { log(id, 'error', `Đã đạt tối đa ${S.settings.maxBots} bot chạy cùng lúc`); return; }
      w.start();
      await sleep(S.settings.staggerSec * 1000 + Math.random() * 1500);   // giãn cách tránh bị server chặn IP
    }).catch(e => log(id, 'error', e.message));
  }
}
function emergency() {
  startEpoch++;
  workers.forEach(w => w.stop());
  log(null, 'error', 'DỪNG KHẨN CẤP: đã ngắt toàn bộ bot');
  dirty();
}

// ---------- lệnh: thường -> AI, có dấu "-" -> gửi thẳng ----------
async function command(ids, text, opts = {}) {
  text = String(text || '').trim(); if (!text) return;
  const ws = ids.map(id => workers.get(id)).filter(w => w && w.status === 'running');
  if (!ws.length) { log(null, 'warn', 'Không có bot đang chạy để nhận lệnh'); return; }
  if (text.startsWith('-')) {
    const steps = parseDirect(text);
    if (!steps) { log(ws[0].def.id, 'warn', 'Lệnh "-" không hợp lệ: ' + text); return; }
    ws.forEach(w => w.execSteps(steps, opts.from)); return;
  }
  let r;
  try { r = await ai.plan(text, ws[0].context(), S.settings); }
  catch (e) { log(null, 'error', 'AI lỗi: ' + e.message); return; }
  const e = { ts: Date.now(), text, via: r.via, steps: r.steps, error: r.error || null, bots: ws.map(w => w.def.name) };
  aiLog.push(e); if (aiLog.length > 60) aiLog.shift(); bc({ t: 'ai', e });
  if (r.error) log(null, 'warn', r.error + ' → dùng bộ phân tích dự phòng');
  if (!r.steps.length) { log(ws[0].def.id, 'warn', 'Không hiểu lệnh: ' + text); return; }
  ws.forEach(w => w.execSteps(r.steps, opts.from));
}

// ---------- cài đặt ----------
const NUM = { staggerSec: [1, 60], retreatHp: [0, 19], autoEatAt: [1, 19], ramLimitMB: [200, 8000], maxBots: [1, 100] };
function applySettings(p) {
  for (const k in NUM) if (p[k] != null && isFinite(+p[k])) S.settings[k] = Math.min(NUM[k][1], Math.max(NUM[k][0], +p[k]));
  if (['tiny', 'short', 'normal', 'far'].includes(p.viewDistance)) S.settings.viewDistance = p.viewDistance;
  if (typeof p.aiUrl === 'string' && /^https?:\/\//.test(p.aiUrl)) S.settings.aiUrl = p.aiUrl.trim();
  if (typeof p.aiModel === 'string') S.settings.aiModel = p.aiModel.trim().slice(0, 60) || 'local';
  if (Array.isArray(p.owners)) S.settings.owners = [...new Set(p.owners.filter(o => /^\w{3,16}$/.test(o)))];
  save(); dirty();
}
async function checkAi() { aiState = { ok: await ai.health(S.settings.aiUrl), at: Date.now() }; dirty(); }
setInterval(checkAi, 15000); checkAi();

// ---------- WebSocket ----------
function onMsg(c, m) {
  const ids = Array.isArray(m.ids) ? m.ids.filter(i => typeof i === 'string') : [];
  switch (m.t) {
    case 'addServer':
      if (!m.host) return;
      S.servers.push({ id: uid(), name: String(m.name || m.host).slice(0, 40), host: String(m.host).trim(), port: +m.port || 25565, version: String(m.version || '').trim() });
      save(); dirty(); break;
    case 'delServer':
      S.bots.filter(b => b.serverId === m.id).forEach(b => { const w = workers.get(b.id); if (w) w.stop(); workers.delete(b.id); });
      S.bots = S.bots.filter(b => b.serverId !== m.id); S.servers = S.servers.filter(s => s.id !== m.id); save(); dirty(); break;
    case 'addBots': {
      if (!S.servers.find(s => s.id === m.serverId)) return;
      const base = String(m.name || '').replace(/[^\w]/g, '').slice(0, 14); if (base.length < 3) return log(null, 'warn', 'Tên bot cần 3-14 ký tự chữ/số/_');
      const n = Math.min(Math.max(+m.count || 1, 1), 50);
      for (let i = 1; i <= n; i++) {
        const name = n > 1 ? base.slice(0, 13 - String(n).length) + i : base;
        if (S.bots.some(b => b.name === name && b.serverId === m.serverId)) continue;
        S.bots.push({ id: uid(), name, serverId: m.serverId, password: String(m.password || '').slice(0, 30) || 'Bot' + uid() });
      }
      save(); dirty(); break;
    }
    case 'delBot': { const w = workers.get(m.id); if (w) w.stop(); workers.delete(m.id); S.bots = S.bots.filter(b => b.id !== m.id); save(); dirty(); break; }
    case 'start': startBots(ids); break;
    case 'stop': ids.forEach(id => { const w = workers.get(id); if (w) w.stop(); }); break;
    case 'estop': emergency(); break;
    case 'cmd': command(ids, m.text).catch(e => log(null, 'error', e.message)); break;
    case 'settings': applySettings(m.patch || {}); break;
    case 'select': c.sel = typeof m.id === 'string' ? m.id : null; break;
    case 'aiping': checkAi(); break;
    case 'catalog': {
      const w = workers.get(m.id) && workers.get(m.id).bot ? workers.get(m.id) : [...workers.values()].find(x => x.status === 'running' && x.bot);
      if (w && w.bot.registry) c.send(JSON.stringify({ t: 'catalog', items: w.catalog() }));
      else log(null, 'warn', 'Cần ít nhất 1 bot đang chạy để tải danh sách vật phẩm');
      break;
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/ping') { res.end('ok'); return; }
  fs.readFile(UI, (e, buf) => { if (e) { res.statusCode = 404; res.end('Không thấy giao diện: ' + UI); } else { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(buf); } });
});
const wss = new WebSocketServer({
  server,
  verifyClient: (info, cb) => { const u = new URL(info.req.url, 'http://x'); cb(u.searchParams.get('token') === S.token, 401, 'bad token'); }
});
wss.on('connection', c => {
  clients.add(c); c.sel = null;
  c.send(JSON.stringify({ t: 'hello', logs: logs.slice(-200), ai: aiLog }));
  c.send(JSON.stringify(stateMsg()));
  c.on('message', d => { try { onMsg(c, JSON.parse(d)); } catch (e) { log(null, 'error', 'Tin nhắn lỗi: ' + e.message); } });
  c.on('close', () => clients.delete(c));
});
setInterval(() => {   // dữ liệu thời gian thực của bot đang được xem
  for (const c of clients) {
    if (!c.sel) continue;
    const w = workers.get(c.sel);
    if (w && w.status === 'running' && w.bot && w.bot.entity) { try { c.send(JSON.stringify({ t: 'detail', ...w.detail() })); } catch (e) { } }
  }
}, 500);

// ---------- chống sập & dọn RAM ----------
process.on('uncaughtException', e => log(null, 'error', 'Lỗi chưa bắt: ' + (e && e.message)));
process.on('unhandledRejection', e => log(null, 'error', 'Promise lỗi: ' + (e && e.message || e)));
if (global.gc) setInterval(() => global.gc(), 30000);

server.listen(PORT, '127.0.0.1', () => {
  console.log('==============================================');
  console.log(' Bầy Bot đang chạy:  127.0.0.1:' + PORT);
  console.log(' TOKEN (nhập 1 lần vào app):  ' + S.token);
  console.log('==============================================');
});
