'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const DIR = path.join(__dirname, 'data');
fs.mkdirSync(DIR, { recursive: true });
const FILE = path.join(DIR, 'state.json');

const DEF = {
  token: crypto.randomBytes(6).toString('hex'),
  servers: [],
  bots: [],
  settings: {
    owners: [],            // tên người chơi được điều khiển bot qua /msg (rỗng = không ai)
    staggerSec: 5,         // giãn cách giữa các bot khi khởi chạy
    viewDistance: 'short', // tiny | short | normal | far  (nhỏ = ít RAM)
    autoEatAt: 14,
    retreatHp: 6,
    ramLimitMB: 1500,
    maxBots: 30,
    aiUrl: 'http://127.0.0.1:8081',
    aiModel: 'local'
  }
};

let S = {};
try { S = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { S = {}; }
S = { ...DEF, ...S, settings: { ...DEF.settings, ...(S.settings || {}) } };

let tm;
function save() {
  clearTimeout(tm);
  tm = setTimeout(() => fs.writeFileSync(FILE, JSON.stringify(S, null, 1)), 300);
}
const uid = () => crypto.randomBytes(4).toString('hex');
save();
module.exports = { S, save, uid, DIR };
