/*
 * douyin-tv.js 逻辑验证（临时脚本，不属于 APK 工程）
 * 手写最小 DOM 桩，跑通：boot / 影院态自适应 / lift+release / swipe 策略回退 / 画面模式。
 */
const fs = require('fs');
const assert = require('assert');

function mkEl(name, attrs) {
  const el = {
    tagName: name, attrs: Object.assign({}, attrs || {}), children: [], parentNode: null,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      contains(c) { return this._s.has(c); },
    },
    style: { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getBoundingClientRect() { return this.rect; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    insertBefore(c, ref) { c.parentNode = this; this.children.unshift(c); return c; },
    removeChild(c) { c.parentNode = null; this.children = this.children.filter(x => x !== c); return c; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { this._dispatched = (this._dispatched || 0) + 1; },
    contains(c) { let p = c; while (p) { if (p === this) return true; p = p.parentNode; } return false; },
    focus() {}, load() {}, play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; },
    textContent: '', rect: { width: 0, height: 0 },
  };
  Object.defineProperty(el, 'nextSibling', {
    get() { const p = this.parentNode; if (!p) return null; const i = p.children.indexOf(this); return i < 0 ? null : (p.children[i + 1] || null); },
    configurable: true,
  });
  return el;
}

const store = {};
const html = mkEl('html'), head = mkEl('head'), body = mkEl('body');
html.appendChild(head); html.appendChild(body);
const loc = { href: 'https://www.douyin.com/' };

// 模拟抖音推荐流：竖向滚动容器 + 3 张卡片，每卡一个 video
const feed = mkEl('div');
feed._oy = 'auto'; feed.scrollHeight = 2000; feed.clientHeight = 880; feed.scrollTop = 0; feed._idx = 0;
body.appendChild(feed);
const cards = [], videos = [];
for (let i = 0; i < 3; i++) {
  const card = mkEl('div', { 'data-e2e': 'feed-card-video' });
  const v = mkEl('video');
  v.currentSrc = 'https://v.douyin.com/seed' + i + '.mp4'; v.src = v.currentSrc;
  v.videoWidth = 1080; v.videoHeight = 1920; v.paused = i !== 0; v.duration = 30; v.currentTime = 1;
  v.rect = { width: 400, height: 700 };
  card.appendChild(v); feed.appendChild(card); cards.push(card); videos.push(v);
}
// 站点侧模拟：滚动容器被滚动 = 真的换了一条（播放态跟着走）
feed.scrollBy = function (o) {
  this.scrollTop += (o && o.top) || 0;
  this._idx = Math.min(videos.length - 1, this._idx + 1);
  videos.forEach((v, i) => { v.paused = i !== this._idx; });
};

let loginWall = null;
const document = {
  documentElement: html, head, body, hidden: false, location: loc, scrollingElement: html,
  addEventListener() {}, createElement: (t) => mkEl(t),
  contains(c) { let p = c; while (p) { if (p === document) return true; p = p.parentNode; } return false; },
  querySelector(sel) {
    if (sel === 'video') return videos.find(v => v.parentNode) || null;
    if (sel === '#dtv-style') return head.children.find(c => c.id === 'dtv-style') || null;
    if (sel === '.dtv-backdrop') return body.children.find(c => c.classList.contains('dtv-backdrop')) || null;
    if (/login/.test(sel)) return loginWall;
    return null;
  },
  querySelectorAll(sel) { return sel === 'video' ? videos.filter(v => v.parentNode) : []; },
};
html.parentNode = document; // 真实 DOM 里 documentElement.parentNode === document
const AndroidTV = { calls: [], onState(s) { this.calls.push(JSON.parse(s)); }, log() {}, toast() {} };
const window = {
  document, location: loc, innerWidth: 1920, innerHeight: 1080, AndroidTV,
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  addEventListener() {}, focus() {}, scrollBy() {}, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval,
  KeyboardEvent: function (t, o) { Object.assign(this, o || {}); this.type = t; },
  WheelEvent: function (t, o) { Object.assign(this, o || {}); this.type = t; },
  getComputedStyle: (el) => ({ overflowY: el._oy || 'visible' }),
};
global.window = window; global.document = document;

new Function('window', 'document', fs.readFileSync(process.argv[2], 'utf8'))(window, document);
const dtv = window.__dtv;
const out = [];

assert(dtv, '__dtv 未导出');
assert(document.querySelector('#dtv-style'), '样式未注入');
out.push('boot 通过：样式/HUD 已注入，AndroidTV 已收到状态上报 ' + AndroidTV.calls.length + ' 次');

// ① 有真视频在播且无登录墙 → 自动影院态 + 提升到 body
dtv.rebind(); dtv.setCinema(true);
assert(videos[0].parentNode === body, '视频未被提升到 body');
assert(videos[0].classList.contains('dtv-top'), '缺 dtv-top');
out.push('影院态：第0条已提升到 body 全屏（dtv-top）');

// ② 上下键切流：'key' 策略在本桩里无效，必须自动回退到 'container'
const t0 = feed.scrollTop;
dtv.swipe(1);

setTimeout(() => {
  assert(feed.scrollTop > t0, 'container 策略没滚动：scrollTop=' + feed.scrollTop);
  const s = AndroidTV.calls[AndroidTV.calls.length - 1];
  assert(s.strategy === 'container', '策略择优结果不是 container，而是 ' + JSON.stringify(s));
  out.push('swipe(1)：key 无效自动回退 container，scrollTop ' + t0 + '→' + feed.scrollTop + '，策略已记为 container');

  dtv.rebind();
  assert(videos[1].parentNode === body && videos[1].classList.contains('dtv-top'), '第1条未接管全屏');
  assert(videos[0].parentNode === cards[0] && !videos[0].classList.contains("dtv-top"), "第0条没还原回卡片");
  out.push('换绑：第1条接管全屏，第0条还原回原卡片（无孤儿节点残留 body）');

  // ③ 登录墙出现 → 自动退回网页模式
  loginWall = mkEl('div');
  setTimeout(() => {
    const last = AndroidTV.calls[AndroidTV.calls.length - 1];
    assert(last.cinema === false, '登录墙下仍是影院态：' + JSON.stringify(last));
    assert(videos[1].parentNode === cards[1], '退出影院态时第1条没还原');
    out.push('登录墙：自动退出影院态并还原视频（扫码页可见）');

    // ④ 画面模式：长按确认 → cover
    loginWall = null;
    dtv.setCinema(true); dtv.toggleFit();
    const covered = videos.filter(v => v.classList.contains('dtv-cover'));
    assert(covered.length === 1, 'cover 命中数=' + covered.length);
    out.push('画面模式：第' + videos.indexOf(covered[0]) + '条已切 cover（铺满裁切）');

    console.log('\n全部通过：\n  - ' + out.join('\n  - ') + '\n');
    process.exit(0);
  }, 1200);
}, 1700);
