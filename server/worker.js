'use strict';
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew', 'chicken']);
const TIER = { leather: 1, golden: 2, gold: 2, chainmail: 3, iron: 4, diamond: 5, netherite: 6, turtle: 2 };
const WEAPONS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword', 'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe'];
const ARMOR = [['head', 'helmet', 5], ['torso', 'chestplate', 6], ['legs', 'leggings', 7], ['feet', 'boots', 8]];
const FACES = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
const NOBREAK = ['chest', 'trapped_chest', 'barrel', 'furnace', 'blast_furnace', 'smoker', 'crafting_table', 'enchanting_table', 'anvil', 'ender_chest', 'shulker_box'];

// bảng màu bản đồ radar: tên khối -> 1 ký tự
const PAL = [['ore', 'o'], ['water', 'w'], ['lava', 'l'], ['leaves', 'f'], ['grass', 'g'], ['log', 't'], ['wood', 't'], ['planks', 'p'], ['sand', 's'], ['deepslate', 'r'], ['stone', 'r'], ['cobble', 'r'], ['dirt', 'd'], ['snow', 'n'], ['ice', 'i'], ['glass', 'i'], ['netherrack', 'x'], ['obsidian', 'b'], ['bedrock', 'b']];
const codeCache = new Map();
function blockCode(n) {
  let c = codeCache.get(n);
  if (!c) { c = 'u'; for (const [k, v] of PAL) if (n.includes(k)) { c = v; break; } codeCache.set(n, c); }
  return c;
}
const isAir = n => n === 'air' || n === 'cave_air' || n === 'void_air';

class Worker {
  constructor(def, ctx) {
    this.def = def; this.ctx = ctx;
    this.status = 'stopped'; this.mode = 'idle';
    this.task = null; this.guard = false;
    this.wantRun = false; this.retries = 0;
    this.bot = null; this.timers = []; this.retryTimer = null;
    this.lastAuth = 0; this.eating = false; this.geared = false;
  }
  get server() { return this.ctx.server(this.def.serverId); }
  get cfg() { return this.ctx.settings(); }
  log(l, t) { this.ctx.log(this.def.id, l, t); }

  // ---------- vòng đời ----------
  start() {
    if (this.wantRun) return;
    this.wantRun = true; this.retries = 0;
    this._connect();
  }
  stop() {
    this.wantRun = false; this.guard = false;
    clearTimeout(this.retryTimer);
    this.cancel();
    const b = this.bot;
    this._cleanup();
    if (b) { try { b.quit('stop'); } catch { } setTimeout(() => { try { b.end(); } catch { } }, 500); }
    this.status = 'stopped'; this.mode = 'idle';
    this.ctx.dirty();
  }
  _cleanup() {
    this.timers.forEach(clearInterval); this.timers = [];
    this.bot = null; this.task = null;
  }
  _retry() {
    if (!this.wantRun) { this.status = 'stopped'; this.ctx.dirty(); return; }
    this.retries++;
    const sec = Math.min(60, 5 * this.retries);
    this.status = 'connecting'; this.ctx.dirty();
    this.log('warn', `Mất kết nối, thử lại sau ${sec}s`);
    this.retryTimer = setTimeout(() => this._connect(), sec * 1000);
  }
  _connect() {
    if (!this.wantRun) return;
    const s = this.server;
    if (!s) { this.log('error', 'Server không còn tồn tại'); this.wantRun = false; this.status = 'stopped'; return; }
    this.status = 'connecting'; this.ctx.dirty();
    let bot;
    try {
      bot = mineflayer.createBot({
        host: s.host, port: +s.port || 25565, username: this.def.name,
        version: s.version || undefined, auth: 'offline',
        viewDistance: this.cfg.viewDistance, checkTimeoutInterval: 60000, hideErrors: true
      });
    } catch (e) { this.log('error', 'Không tạo được bot: ' + e.message); return this._retry(); }
    this.bot = bot;
    bot.loadPlugin(pathfinder);
    bot.once('spawn', () => this._onSpawn(bot));
    bot.on('kicked', r => {
      const txt = typeof r === 'string' ? r : JSON.stringify(r);
      this.log('error', 'Bị kick: ' + txt.slice(0, 160));
      if (/ban/i.test(txt)) { this.wantRun = false; this.log('error', 'Bot bị ban — dừng tự kết nối lại'); }
    });
    bot.on('error', e => this.log('error', 'Lỗi: ' + (e && e.message)));
    bot.on('death', () => { this.log('warn', 'Bot đã chết'); this.cancel(); });
    bot.on('end', () => {
      if (this.bot !== bot) return;
      this._cleanup();
      this._retry();
    });
    bot.on('messagestr', m => this._onMsg(bot, m));
    bot.on('whisper', (u, m) => this._owner(u, m));
  }
  _onSpawn(bot) {
    if (this.bot !== bot) return;
    this.status = 'running'; this.retries = 0; this.mode = 'idle';
    this.log('info', 'Đã vào server');
    const mv = new Movements(bot, bot.registry);
    mv.canDig = true; mv.allow1by1towers = true; mv.allowParkour = true; mv.allowSprinting = true; mv.maxDropDown = 4;
    for (const n of NOBREAK) { const b = bot.registry.blocksByName[n]; if (b && mv.blocksCantBreak) mv.blocksCantBreak.add(b.id); }
    bot.pathfinder.setMovements(mv);
    bot.pathfinder.thinkTimeout = 3000; bot.pathfinder.tickTimeout = 20;
    const every = (ms, fn) => this.timers.push(setInterval(() => { try { fn(); } catch (e) { this.log('error', e.message); } }, ms));
    every(1500, () => this.autoEat());
    every(8000, () => this.gear());
    every(600, () => this.guardTick());
    every(2000, () => { // chống kẹt do vận tốc NaN (gói nổ lỗi)
      const v = bot.entity && bot.entity.velocity;
      if (v && (isNaN(v.x) || isNaN(v.y) || isNaN(v.z))) { v.x = v.y = v.z = 0; this.log('warn', 'Đã sửa vận tốc NaN'); }
    });
    this.ctx.dirty();
  }

  // ---------- đăng ký / đăng nhập tự động & lệnh qua /msg ----------
  _onMsg(bot, msg) {
    const m = msg.toLowerCase(), now = Date.now();
    const pw = this.def.password;
    if (now - this.lastAuth > 3000 && pw) {
      if (/(not registered|chưa đăng ký|register first|please register|\/register)/.test(m) && !/(already|đã đăng ký)/.test(m) && !/\/login/.test(m)) {
        this.lastAuth = now; bot.chat(`/register ${pw} ${pw}`); this.log('info', 'Tự đăng ký tài khoản');
      } else if (/(\/login|please log ?in|đăng nhập|already registered|đã đăng ký)/.test(m)) {
        this.lastAuth = now; bot.chat(`/login ${pw}`); this.log('info', 'Tự đăng nhập');
      }
    }
    const w = msg.match(/^\[(\w{3,16})\s*->\s*me\]\s*(.+)$/i);   // dạng EssentialsX
    if (w) this._owner(w[1], w[2]);
  }
  _owner(user, text) {
    const ok = (this.cfg.owners || []).some(o => o.toLowerCase() === user.toLowerCase());
    if (!ok) return;
    this.log('info', `Lệnh từ ${user}: ${text}`);
    this.ctx.command([this.def.id], text, { from: user });
  }
  reply(user, text) { if (user && this.bot) try { this.bot.chat(`/msg ${user} ${text}`); } catch { } }

  // ---------- dữ liệu hiển thị ----------
  brief() {
    const b = this.bot, e = b && b.entity;
    return {
      status: this.status, mode: this.guard && this.mode === 'idle' ? 'guard' : this.mode,
      hp: b && this.status === 'running' ? Math.round(b.health || 0) : null,
      food: b && this.status === 'running' ? b.food : null,
      pos: e ? [e.position.x, e.position.y, e.position.z].map(Math.round) : null
    };
  }
  context() {
    const b = this.bot, p = b.entity.position;
    const items = b.inventory.items().slice(0, 12).map(i => `${i.name}x${i.count}`).join(', ') || 'trống';
    return `${this.def.name} ở (${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}), máu ${Math.round(b.health)}, đói ${b.food}, túi: ${items}`;
  }
  detail() {
    const b = this.bot, e = b.entity, inv = [];
    for (let i = 0; i < 46; i++) { const it = b.inventory.slots[i]; inv.push(it ? [it.name, it.count] : null); }
    return {
      id: this.def.id, hp: Math.round(b.health || 0), food: b.food, xp: b.experience ? b.experience.level : 0,
      pos: [e.position.x, e.position.y, e.position.z].map(v => Math.round(v * 10) / 10), yaw: e.yaw,
      dim: b.game && b.game.dimension, held: b.heldItem ? b.heldItem.name : null, hot: b.quickBarSlot,
      inv, mode: this.guard && !this.task ? 'guard' : this.mode, task: this.task ? this.task.name : null,
      ping: b.player ? b.player.ping : null, map: this.mapData(10)
    };
  }
  mapData(R) {
    const b = this.bot; if (!b.entity) return null;
    const p = b.entity.position.floored(); let s = '';
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      let c = '.';
      for (let dy = 3; dy >= -10; dy--) {
        const bl = b.blockAt(new Vec3(p.x + dx, p.y + dy, p.z + dz));
        if (bl && !isAir(bl.name)) { c = blockCode(bl.name); break; }
      }
      s += c;
    }
    const ents = [];
    for (const e of Object.values(b.entities)) {
      if (e === b.entity || !e.position) continue;
      const dx = Math.round(e.position.x - b.entity.position.x), dz = Math.round(e.position.z - b.entity.position.z);
      if (Math.abs(dx) > R || Math.abs(dz) > R) continue;
      const k = e.type === 'player' ? 'p' : e.type === 'hostile' ? 'h' : (e.name === 'item' || e.objectType === 'Item') ? 'i' : 'm';
      ents.push([dx, dz, k]);
    }
    return { R, g: s, ents };
  }

  // ---------- hệ thống tác vụ ----------
  chk(t) { if (t.cancelled) throw new Error('đã huỷ'); }
  stopMove() { try { this.bot.pathfinder.setGoal(null); this.bot.clearControlStates(); } catch { } }
  cancel() { if (this.task) this.task.cancelled = true; if (this.bot) this.stopMove(); }
  async run(name, fn, from) {
    this.cancel();
    const t = { name, cancelled: false };
    this.task = t; this.mode = name; this.ctx.dirty();
    let err = null;
    try { await fn(t); this.log('info', `Xong: ${name}`); }
    catch (e) { if (!t.cancelled) { err = e.message; this.log('error', `${name}: ${e.message}`); } }
    finally {
      if (this.task === t) { this.task = null; this.mode = 'idle'; if (this.bot) this.stopMove(); this.ctx.dirty(); }
    }
    if (from && !t.cancelled) this.reply(from, err ? 'lỗi: ' + err : 'xong ' + name);
  }
  async goto(goal, t, ms = 60000) {
    const p = this.bot.pathfinder.goto(goal); p.catch(() => { });
    let iv;
    const guardP = new Promise((_, rej) => {
      const t0 = Date.now();
      iv = setInterval(() => {
        if (t && t.cancelled) rej(new Error('đã huỷ'));
        else if (Date.now() - t0 > ms) rej(new Error('di chuyển quá lâu'));
      }, 200);
    });
    guardP.catch(() => { });
    try { await Promise.race([p, guardP]); }
    catch (e) { this.stopMove(); throw e; }
    finally { clearInterval(iv); }
  }

  // ---------- toàn bộ vật phẩm trong game ----------
  resolveItem(name) {
    const reg = this.bot.registry, q = String(name || '').toLowerCase().trim().replace(/\s+/g, '_');
    if (!q) return null;
    if (reg.itemsByName[q]) return reg.itemsByName[q];
    const all = reg.itemsArray;
    const byDisplay = all.find(i => i.displayName && i.displayName.toLowerCase().replace(/\s+/g, '_') === q);
    if (byDisplay) return byDisplay;
    return all.filter(i => i.name.includes(q)).sort((a, z) => a.name.length - z.name.length)[0] || null;
  }
  catalog() { return this.bot.registry.itemsArray.map(i => [i.name, i.displayName || i.name]); }
  async give(name, count) {
    const b = this.bot, it = this.resolveItem(name);
    if (!it) throw new Error(`không biết vật phẩm "${name}"`);
    const n = Math.min(Math.max(Math.floor(count) || 1, 1), it.stackSize || 64);
    if (b.game && b.game.gameMode === 'creative' && b.creative) {
      const Item = require('prismarine-item')(b.registry);
      const slot = [...Array(27).keys()].map(i => i + 9).concat([36, 37, 38, 39, 40, 41, 42, 43, 44]).find(i => !b.inventory.slots[i]);
      if (slot == null) throw new Error('túi đồ đã đầy');
      await b.creative.setInventorySlot(slot, new Item(it.id, n));
      return;
    }
    b.chat(`/give ${b.username} ${it.name} ${n}`);          // cần quyền OP trên server
    await sleep(1200);
    if (!b.inventory.count(it.id)) throw new Error('đã gửi /give nhưng chưa nhận được: bot cần quyền OP hoặc chế độ creative');
  }

  // ---------- trang bị, ăn uống ----------
  blockIds(target) {
    const reg = this.bot.registry, t = String(target || '').toLowerCase();
    if (reg.blocksByName[t]) return [reg.blocksByName[t].id];
    return Object.values(reg.blocksByName).filter(b => b.name.includes(t) && !b.name.startsWith('stripped')).map(b => b.id);
  }
  async equipTool(block) {
    const b = this.bot;
    let best = null, bt = block.digTime(null, false, false, false, [], []);
    for (const it of b.inventory.items()) {
      if (!/_(pickaxe|axe|shovel|hoe|sword|shears)$/.test(it.name) && it.name !== 'shears') continue;
      if (!block.canHarvest(it.type)) continue;
      const d = block.digTime(it.type, false, false, false, [], []);
      if (d < bt) { bt = d; best = it; }
    }
    if (best) await b.equip(best, 'hand');
  }
  async equipWeapon() {
    const it = WEAPONS.map(n => this.bot.inventory.items().find(i => i.name === n)).find(Boolean);
    if (it) await this.bot.equip(it, 'hand').catch(() => { });
  }
  async gear() {
    const b = this.bot; if (!b || this.status !== 'running' || this.gearing) return;
    this.gearing = true;
    try {
      const tier = n => TIER[n.split('_')[0]] || 0;
      for (const [slot, suf, idx] of ARMOR) {
        const c = b.inventory.items().filter(i => i.name.endsWith('_' + suf)).sort((a, z) => tier(z.name) - tier(a.name))[0];
        const cur = b.inventory.slots[idx];
        if (c && (!cur || tier(c.name) > tier(cur.name))) { await b.equip(c, slot).catch(() => { }); }
      }
      if (!b.inventory.slots[45]) { const sh = b.inventory.items().find(i => i.name === 'shield'); if (sh) await b.equip(sh, 'off-hand').catch(() => { }); }
    } finally { this.gearing = false; }
  }
  async eatNow(force) {
    const b = this.bot; if (this.eating) return;
    const foods = b.inventory.items().filter(i => b.registry.foodsByName[i.name] && !BAD_FOOD.has(i.name));
    if (!foods.length) { if (force) throw new Error('không có đồ ăn'); return; }
    foods.sort((a, z) => b.registry.foodsByName[z.name].foodPoints - b.registry.foodsByName[a.name].foodPoints);
    let pick = foods[0];
    if (b.health <= 8) { const g = foods.find(f => f.name === 'golden_apple' || f.name === 'enchanted_golden_apple'); if (g) pick = g; }
    this.eating = true;
    try { await b.equip(pick, 'hand'); await b.consume(); } catch (e) { if (force) throw e; } finally { this.eating = false; }
  }
  autoEat() {
    const b = this.bot; if (!b || !b.entity || this.eating) return;
    if (b.food <= this.cfg.autoEatAt || (b.health <= 8 && b.food < 20)) this.eatNow(false);
  }
  guardTick() {
    if (!this.guard || this.task || !this.bot || !this.bot.entity) return;
    const e = this.findTarget('hostile', 8);
    if (e) this.run('attack', t => this.attack(t, 'hostile', 20));
  }

  // ---------- thu thập / đào ----------
  async digBlock(block, t) {
    const b = this.bot;
    if (b.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)) > 4.2)
      await this.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 3), t, 30000);
    this.chk(t);
    if (!block.canHarvest(null) && block.harvestTools) {
      const ok = b.inventory.items().some(i => block.canHarvest(i.type));
      if (!ok) throw new Error(`thiếu công cụ phù hợp để đào ${block.name}`);
    }
    await this.equipTool(block);
    await b.dig(block, true);
  }
  async pickup(t) {
    const b = this.bot;
    for (let i = 0; i < 6; i++) {
      this.chk(t);
      const it = Object.values(b.entities).filter(e => (e.name === 'item' || e.objectType === 'Item') && e.position.distanceTo(b.entity.position) < 8)
        .sort((a, z) => a.position.distanceTo(b.entity.position) - z.position.distanceTo(b.entity.position))[0];
      if (!it) return;
      await this.goto(new goals.GoalNear(it.position.x, it.position.y, it.position.z, 0.8), t, 8000).catch(e => { if (t.cancelled) throw e; });
      await sleep(150);
    }
  }
  async wander(t) {
    const p = this.bot.entity.position, a = Math.random() * Math.PI * 2;
    await this.goto(new goals.GoalNearXZ(p.x + Math.cos(a) * 24, p.z + Math.sin(a) * 24, 3), t, 20000).catch(e => { if (t.cancelled) throw e; });
  }
  async collect(t, target, count) {
    const b = this.bot, ids = this.blockIds(target);
    if (!ids.length) throw new Error(`không biết khối "${target}"`);
    let got = 0, fails = 0;
    while (got < count) {
      this.chk(t);
      const cand = b.findBlocks({ matching: ids, maxDistance: 48, count: 16 }).map(p => b.blockAt(p)).filter(Boolean)
        .sort((a, z) => a.position.distanceTo(b.entity.position) - z.position.distanceTo(b.entity.position));
      if (!cand.length) {
        if (++fails > 4) throw new Error(`không tìm thấy ${target} quanh đây (đã lấy ${got}/${count})`);
        await this.wander(t); continue;
      }
      try { await this.digBlock(cand[0], t); got++; fails = 0; await this.pickup(t); }
      catch (e) { if (t.cancelled) throw e; this.log('warn', e.message); if (++fails > 6) throw e; await sleep(300); }
    }
  }

  // ---------- chế tạo / phù phép ----------
  async placeNear(t, item) {
    const b = this.bot, p = b.entity.position.floored();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
      const ref = b.blockAt(p.offset(dx, -1, dz)), tgt = b.blockAt(p.offset(dx, 0, dz));
      if (ref && ref.boundingBox === 'block' && tgt && isAir(tgt.name)) {
        await b.equip(item, 'hand'); await b.placeBlock(ref, new Vec3(0, 1, 0)); await sleep(200);
        return b.blockAt(p.offset(dx, 0, dz));
      }
    }
    throw new Error('không có chỗ trống để đặt ' + item.name);
  }
  async ensureTable(t, depth) {
    const b = this.bot, id = b.registry.blocksByName.crafting_table.id;
    let tb = b.findBlock({ matching: id, maxDistance: 24 });
    if (!tb) {
      let it = b.inventory.items().find(i => i.name === 'crafting_table');
      if (!it) { await this.craftDeep(t, 'crafting_table', 1, depth + 1); it = b.inventory.items().find(i => i.name === 'crafting_table'); }
      if (!it) throw new Error('không tạo được bàn chế tạo');
      tb = await this.placeNear(t, it);
    } else if (b.entity.position.distanceTo(tb.position) > 4) {
      await this.goto(new goals.GoalNear(tb.position.x, tb.position.y, tb.position.z, 2), t, 30000);
    }
    return tb;
  }
  async craftDeep(t, name, n = 1, depth = 0) {
    this.chk(t);
    const b = this.bot, reg = b.registry, item = this.resolveItem(name);
    if (!item) throw new Error(`không biết vật phẩm "${name}"`);
    if (depth > 3) throw new Error(`thiếu nguyên liệu cho ${name}`);
    const all = reg.recipes[item.id] || [];
    if (!all.length) throw new Error(`${name} không chế tạo được`);
    const needsTable = all.every(r => r.requiresTable);
    for (let attempt = 0; attempt < 2; attempt++) {
      let tb = null, rs = b.recipesFor(item.id, null, 1, null);
      if (!rs.length && (needsTable || attempt === 1)) { tb = await this.ensureTable(t, depth); rs = b.recipesFor(item.id, null, 1, tb); }
      if (rs.length) { await b.craft(rs[0], Math.ceil(n / (rs[0].result.count || 1)), tb || undefined); return; }
      if (attempt === 1) break;
      let filled = false;
      for (const r of all.slice(0, 6)) {          // thử tự chế nguyên liệu còn thiếu (ván, gậy, ...)
        const miss = (r.delta || []).filter(d => d.count < 0 && b.inventory.count(d.id) < -d.count);
        if (!miss.length) continue;
        try { for (const d of miss) await this.craftDeep(t, reg.items[d.id].name, -d.count - b.inventory.count(d.id), depth + 1); filled = true; break; }
        catch (e) { if (t.cancelled) throw e; }
      }
      if (!filled) break;
    }
    throw new Error(`không đủ nguyên liệu để chế ${name}`);
  }
  async enchant(t, itemName) {
    const b = this.bot, id = b.registry.blocksByName.enchanting_table.id;
    const tbl = b.findBlock({ matching: id, maxDistance: 48 });
    if (!tbl) throw new Error('không thấy bàn phù phép gần đây');
    await this.goto(new goals.GoalNear(tbl.position.x, tbl.position.y, tbl.position.z, 3), t, 40000);
    const ok = /(sword|axe|pickaxe|shovel|hoe|helmet|chestplate|leggings|boots|bow|crossbow|trident|fishing_rod|book)$/;
    const item = b.inventory.items().find(i => (itemName ? i.name === itemName : ok.test(i.name)) && !(i.enchants && i.enchants.length));
    if (!item) throw new Error('không có đồ để phù phép');
    const lapis = b.inventory.items().find(i => i.name === 'lapis_lazuli');
    if (!lapis) throw new Error('thiếu lapis lazuli');
    const tb = await b.openEnchantmentTable(tbl);
    try {
      await tb.putTargetItem(item); await tb.putLapis(lapis); await sleep(700);
      let choice = -1;
      for (let i = 2; i >= 0; i--) { const e = tb.enchantments[i]; if (e && e.level > 0 && b.experience.level >= e.level) { choice = i; break; } }
      if (choice < 0) throw new Error(`không đủ cấp XP (hiện ${b.experience.level})`);
      await tb.enchant(choice); await sleep(500); await tb.takeTargetItem();
    } finally { try { tb.close(); } catch { } }
  }

  // ---------- chiến đấu ----------
  findTarget(spec, range = 32) {
    const b = this.bot, me = b.entity.position;
    const s = String(spec || 'hostile').toLowerCase();
    return Object.values(b.entities).filter(e => e !== b.entity && e.position && e.isValid !== false && e.position.distanceTo(me) < range)
      .filter(e => {
        if (s === 'hostile' || s === 'nearest') return e.type === 'hostile';
        if (s === 'all' || s === 'any') return e.type === 'hostile' || e.type === 'animal' || e.type === 'mob';
        return (e.username || '').toLowerCase() === s || (e.name || '').toLowerCase() === s;
      })
      .sort((a, z) => a.position.distanceTo(me) - z.position.distanceTo(me))[0];
  }
  async attack(t, spec, maxSec = 90) {
    const b = this.bot, end = Date.now() + maxSec * 1000;
    let target = this.findTarget(spec), last = 0;
    if (!target) throw new Error('không thấy mục tiêu');
    await this.equipWeapon();
    while (Date.now() < end) {
      this.chk(t);
      if (!target || target.isValid === false) { target = this.findTarget(spec); if (!target) { this.stopMove(); return; } }
      if (b.health <= this.cfg.retreatHp) { await this.retreat(t, target); return; }
      const d = target.position.distanceTo(b.entity.position);
      b.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
      if (d < 3.6) {
        await b.lookAt(target.position.offset(0, (target.height || 1.6) * 0.85, 0), true);
        if (Date.now() - last >= 620) { b.attack(target); last = Date.now(); }
      }
      await sleep(80);
    }
    this.stopMove();
  }
  async retreat(t, from) {
    this.log('warn', 'Máu thấp — rút lui và ăn');
    this.bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(from, 20)), true);
    await sleep(2500);
    this.stopMove();
    await this.eatNow(false);
    throw new Error('đã rút lui vì máu thấp');
  }

  // ---------- các lệnh khác ----------
  player(name) {
    const b = this.bot;
    if (name) { const p = b.players[name]; if (p && p.entity) return p.entity; return b.nearestEntity(e => (e.username || e.name) === name); }
    for (const o of this.cfg.owners || []) { const p = b.players[o]; if (p && p.entity) return p.entity; }
    return null;
  }
  async follow(t, name) {
    const b = this.bot; let e = this.player(name);
    if (!e) throw new Error('không thấy ' + (name || 'chủ nhân'));
    b.pathfinder.setGoal(new goals.GoalFollow(e, 2), true);
    for (;;) {
      this.chk(t); await sleep(500);
      if (e.isValid === false) { e = this.player(name); if (!e) throw new Error('mất dấu mục tiêu'); b.pathfinder.setGoal(new goals.GoalFollow(e, 2), true); }
    }
  }
  async placeAt(t, name, x, y, z) {
    const b = this.bot, rn = this.resolveItem(name), item = b.inventory.items().find(i => i.name === (rn ? rn.name : name));
    if (!item) throw new Error('không có ' + name);
    if (x == null || isNaN(x)) { await this.placeNear(t, item); return; }
    const tgt = new Vec3(x, y, z), cur = b.blockAt(tgt);
    if (cur && !isAir(cur.name)) throw new Error('ô đích đã có khối');
    for (const f of FACES) {
      const ref = b.blockAt(tgt.offset(f[0], f[1], f[2]));
      if (!ref || ref.boundingBox !== 'block') continue;
      await this.goto(new goals.GoalNear(x, y, z, 3), t, 30000);
      await b.equip(item, 'hand');
      await b.placeBlock(ref, new Vec3(-f[0], -f[1], -f[2]));
      return;
    }
    throw new Error('không có khối nào để tựa vào khi đặt');
  }
  async breakAt(t, x, y, z) {
    const bl = this.bot.blockAt(new Vec3(x, y, z));
    if (!bl || isAir(bl.name)) throw new Error('ô đó không có khối');
    await this.digBlock(bl, t);
  }
  async drop(name, count) {
    const b = this.bot, all = !name || name === 'all', rn = all ? null : this.resolveItem(name);
    const items = b.inventory.items().filter(i => all || i.name === (rn ? rn.name : name));
    if (!items.length) throw new Error('không có đồ để thả');
    if (all) for (const it of items) await b.toss(it.type, null, it.count);
    else await b.toss(items[0].type, null, count || items.reduce((a, i) => a + i.count, 0));
  }
  async equipItem(name) {
    const b = this.bot, rn = this.resolveItem(name); name = rn ? rn.name : name;
    const it = b.inventory.items().find(i => i.name === name);
    if (!it) throw new Error('không có ' + name);
    const a = ARMOR.find(x => name.endsWith('_' + x[1]));
    await b.equip(it, a ? a[0] : name === 'shield' ? 'off-hand' : 'hand');
  }

  doInstant(s) {
    if (s.action === 'stop') { this.guard = false; this.cancel(); this.mode = 'idle'; this.log('info', 'Đã dừng mọi việc'); }
    else if (s.action === 'guard') { this.guard = s.on !== false; this.log('info', 'Chế độ bảo vệ: ' + (this.guard ? 'bật' : 'tắt')); }
    else if (s.action === 'say') this.bot.chat(s.text || '');
    else if (s.action === 'inv') this.log('info', 'Túi đồ: ' + (this.bot.inventory.items().map(i => `${i.name}x${i.count}`).join(', ') || 'trống'));
    this.ctx.dirty();
  }
  async doStep(t, s, from) {
    const b = this.bot;
    switch (s.action) {
      case 'goto':
        await this.goto(s.y == null ? new goals.GoalNearXZ(s.x, s.z, 1) : new goals.GoalNear(s.x, s.y, s.z, 1), t, 120000); break;
      case 'follow': await this.follow(t, s.target || from); break;
      case 'come': {
        const e = this.player(s.target || from);
        if (!e) throw new Error('không thấy người chơi để đến gần');
        await this.goto(new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2), t, 90000); break;
      }
      case 'collect': case 'mine': await this.collect(t, s.target, s.count || 1); break;
      case 'attack': await this.attack(t, s.target || 'hostile'); break;
      case 'craft': await this.craftDeep(t, s.item, s.count || 1); break;
      case 'enchant': await this.enchant(t, s.item); break;
      case 'equip': await this.equipItem(s.item); break;
      case 'give': await this.give(s.item, s.count || 1); break;
      case 'drop': await this.drop(s.item, s.count); break;
      case 'place': await this.placeAt(t, s.block, s.x, s.y, s.z); break;
      case 'break': await this.breakAt(t, s.x, s.y, s.z); break;
      case 'eat': await this.eatNow(true); break;
      default: this.doInstant(s);
    }
  }
  execSteps(steps, from) {
    if (!this.bot || this.status !== 'running') return;
    const instant = s => ['say', 'inv', 'guard', 'stop'].includes(s.action);
    if (steps.every(instant)) { steps.forEach(s => this.doInstant(s)); return; }
    this.run(steps[0].action, async t => { for (const s of steps) { this.chk(t); await this.doStep(t, s, from); } }, from);
  }
}

// lệnh có dấu "-"  ->  danh sách bước
function parseDirect(txt) {
  const raw = txt.trim().replace(/^-+\s*/, '');
  const a = raw.split(/\s+/), c = (a.shift() || '').toLowerCase();
  const num = x => (x == null || x === '' || isNaN(+x)) ? undefined : +x;
  switch (c) {
    case 'goto': case 'go':
      return a.length >= 3 ? [{ action: 'goto', x: +a[0], y: +a[1], z: +a[2] }] : a.length === 2 ? [{ action: 'goto', x: +a[0], z: +a[1] }] : null;
    case 'follow': return [{ action: 'follow', target: a[0] }];
    case 'come': return [{ action: 'come', target: a[0] }];
    case 'mine': case 'collect': case 'dig': return a[0] ? [{ action: 'collect', target: a[0], count: num(a[1]) || 1 }] : null;
    case 'attack': case 'kill': return [{ action: 'attack', target: a[0] || 'hostile' }];
    case 'guard': return [{ action: 'guard', on: a[0] !== 'off' }];
    case 'craft': return a[0] ? [{ action: 'craft', item: a[0], count: num(a[1]) || 1 }] : null;
    case 'enchant': return [{ action: 'enchant', item: a[0] }];
    case 'give': return a[0] ? [{ action: 'give', item: a[0], count: num(a[1]) || 1 }] : null;
    case 'equip': return a[0] ? [{ action: 'equip', item: a[0] }] : null;
    case 'drop': return [{ action: 'drop', item: a[0], count: num(a[1]) }];
    case 'place': return a[0] ? [{ action: 'place', block: a[0], x: num(a[1]), y: num(a[2]), z: num(a[3]) }] : null;
    case 'break': return a.length >= 3 ? [{ action: 'break', x: +a[0], y: +a[1], z: +a[2] }] : null;
    case 'eat': return [{ action: 'eat' }];
    case 'say': case 'chat': return [{ action: 'say', text: raw.replace(/^\S+\s*/, '') }];
    case 'stop': return [{ action: 'stop' }];
    case 'inv': return [{ action: 'inv' }];
    default: return null;
  }
}

module.exports = { Worker, parseDirect };
