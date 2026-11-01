'use strict';
// AI local (llama.cpp llama-server, API kiểu OpenAI). Nếu AI tắt/lỗi -> dùng bộ phân tích luật dự phòng.
const ACTIONS = new Set(['goto', 'follow', 'come', 'collect', 'mine', 'attack', 'guard', 'craft', 'enchant', 'equip', 'give', 'drop', 'eat', 'say', 'stop', 'inv']);

const SYS = `Bạn là bộ dịch lệnh cho bot Minecraft. CHỈ trả về JSON dạng {"steps":[...]}.
Mỗi step có "action" là một trong: goto{x,y,z}, follow{target}, come, collect{target,count}, mine{target,count}, attack{target}, guard{on}, craft{item,count}, enchant{item}, equip{item}, give{item,count}, drop{item,count}, eat, say{text}, stop, inv.
Dùng id tiếng Anh của Minecraft (oak_log, iron_ore, crafting_table, iron_pickaxe...). "gỗ" = "log". attack.target: "hostile" (quái), "nearest", hoặc tên người chơi/mob.
Ví dụ: "chặt 10 gỗ rồi làm bàn craft" -> {"steps":[{"action":"collect","target":"log","count":10},{"action":"craft","item":"crafting_table","count":1}]}`;

let chain = Promise.resolve();
function plan(text, ctx, settings) {
  const run = () => doPlan(text, ctx, settings);
  const p = chain.then(run, run);          // llama chỉ xử lý lần lượt -> xếp hàng
  chain = p.then(() => {}, () => {});
  return p;
}

async function doPlan(text, ctx, s) {
  let error = null;
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 90000);
    const res = await fetch(s.aiUrl.replace(/\/$/, '') + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        model: s.aiModel || 'local', temperature: 0, max_tokens: 300,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: SYS }, { role: 'user', content: `Trạng thái bot: ${ctx}\nLệnh: ${text}` }]
      })
    });
    clearTimeout(to);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const raw = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    const steps = clean(raw);
    if (steps.length) return { steps, via: 'llm', raw };
    error = 'AI trả về lệnh không hợp lệ: ' + raw.slice(0, 120);
  } catch (e) {
    error = e.name === 'AbortError' ? 'AI quá thời gian (90s)' : 'AI không phản hồi: ' + ((e.cause && e.cause.code) || e.message);
  }
  return { steps: rules(text), via: 'rules', error };
}

function clean(raw) {
  let o;
  try { o = JSON.parse(raw); } catch { const m = String(raw).match(/[\[{][\s\S]*[\]}]/); if (!m) return []; try { o = JSON.parse(m[0]); } catch { return []; } }
  const arr = Array.isArray(o) ? o : (o && o.steps) || [];
  const out = [];
  for (const s of arr) {
    if (!s || !ACTIONS.has(s.action)) continue;
    const r = { action: s.action };
    for (const k of ['target', 'item', 'text']) if (typeof s[k] === 'string') r[k] = s[k].slice(0, 100);
    for (const k of ['x', 'y', 'z', 'count']) if (s[k] != null && isFinite(+s[k])) r[k] = +s[k];
    if (s.on != null) r.on = !!s.on;
    if (r.action === 'mine') r.action = 'collect';
    out.push(r);
  }
  return out.slice(0, 8);
}

// ---------- bộ phân tích luật dự phòng (không cần AI) ----------
const RES = { 'đá đỏ': 'redstone_ore', 'kim cương': 'diamond_ore', 'gỗ': 'log', 'cây': 'log', 'đá': 'cobblestone', 'cát': 'sand', 'đất': 'dirt', 'sắt': 'iron_ore', 'than': 'coal_ore', 'vàng': 'gold_ore', 'đồng': 'copper_ore', 'lapis': 'lapis_ore' };
const MAT = { 'kim cương': 'diamond', 'gỗ': 'wooden', 'đá': 'stone', 'sắt': 'iron', 'vàng': 'golden' };
const TOOL = { 'cuốc': 'pickaxe', 'cúp': 'pickaxe', 'rìu': 'axe', 'kiếm': 'sword', 'xẻng': 'shovel' };
const THING = { 'bàn craft': 'crafting_table', 'bàn chế tạo': 'crafting_table', 'bàn': 'crafting_table', 'ván': 'oak_planks', 'gậy': 'stick', 'đuốc': 'torch', 'lò nung': 'furnace', 'lò': 'furnace', 'rương': 'chest', 'khiên': 'shield', 'cung': 'bow' };
const find = (map, s) => { const k = Object.keys(map).sort((a, b) => b.length - a.length).find(k => s.includes(k)); return k ? map[k] : null; };

function piece(p) {
  p = p.trim().toLowerCase();
  if (!p) return null;
  const n = +((p.match(/(\d+)/) || [])[1]) || null;
  let m;
  if (/^(dừng|ngừng|stop|thôi|đứng yên)/.test(p)) return { action: 'stop' };
  if ((m = p.match(/(?:đi đến|đi tới|tới|goto)\s*(-?\d+)[ ,]+(-?\d+)[ ,]+(-?\d+)/))) return { action: 'goto', x: +m[1], y: +m[2], z: +m[3] };
  if (/lại đây|đến đây|về đây|\bcome\b/.test(p)) return { action: 'come' };
  if ((m = p.match(/(?:theo|follow)\s*(.*)/))) return { action: 'follow', target: m[1].replace(/\b(tôi|mình|me)\b/g, '').trim() || undefined };
  if ((m = p.match(/(?:^|\s)(?:give|cho)\s+(?:tôi\s+|mình\s+)?(\d+\s+)?([a-z]+(?:_[a-z]+)*)/))) return { action: 'give', item: m[2], count: +(m[1] || 1) };
  if (/phù phép|enchant/.test(p)) return { action: 'enchant' };
  if (/(chế tạo|craft|làm|tạo|chế)(?=\s|$)/.test(p)) {
    const tool = find(TOOL, p), mat = find(MAT, p);
    let item = tool ? `${mat || 'wooden'}_${tool}` : find(THING, p);
    if (!item) { const e = p.match(/([a-z]+(?:_[a-z]+)+|\b(?:stick|torch|chest|furnace|bow|shield)\b)/); item = e && e[1]; }
    if (item) return { action: 'craft', item, count: n || 1 };
  }
  if (/(chặt|thu thập|lấy|nhặt|đào|khai thác|collect|chop|gather|mine|dig)/.test(p)) {
    let t = find(RES, p); if (!t) { const e = p.match(/([a-z]+(?:_[a-z]+)+)/); t = e && e[1]; }
    if (t) return { action: 'collect', target: t, count: n || 1 };
  }
  if (/(đánh|tấn công|giết|diệt|attack|kill)/.test(p)) {
    const w = p.split(/\s+/).pop();
    return { action: 'attack', target: /quái|mob|hostile|xung quanh/.test(p) || w.length < 3 ? 'hostile' : w };
  }
  if (/(^|\s)(ăn|eat)(\s|$)/.test(p)) return { action: 'eat' };
  if (/(bảo vệ|canh gác|guard)/.test(p)) return { action: 'guard', on: !/(tắt|off)/.test(p) };
  if (/(kho đồ|túi đồ|inventory)/.test(p)) return { action: 'inv' };
  return null;
}
function rules(text) {
  return String(text).split(/\s*(?:rồi|sau đó|xong|then|;|,)\s*/i).map(piece).filter(Boolean);
}

async function health(url) {
  try {
    const r = await fetch(url.replace(/\/$/, '') + '/health', { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch { return false; }
}

module.exports = { plan, health, rules };
