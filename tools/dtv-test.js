/*
 * douyin-tv.js 回归测试（临时脚本，不进 APK）
 *   node tools/dtv-test.js app/src/main/assets/douyin-tv.js
 *
 * 手写一个够真的 DOM：元素注册表 + 简化选择器匹配 + 模拟抖音"点登录→扫码 tab→二维码"。
 * 覆盖：启动注入 / 未登录自动开二维码 / 扫码成功后转 in / 影院态提升与还原 /
 *       切流策略逐级回退并记忆 / 登录墙退回网页模式 / 画面模式 / 自检文本回传。
 */
const fs = require('fs');
const assert = require('assert');

const all = [];                       // 元素注册表，模拟"文档里所有元素"

function mkEl(tagName, attrs) {
  const el = {
    tagName: String(tagName).toUpperCase(), attrs: Object.assign({}, attrs || {}), children: [], parentNode: null, id: '',
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      contains(c) { return this._s.has(c); },
    },
    style: { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } },
    getAttribute(k) {
      if (k === 'class') return [...this.classList._s].join(' ');
      return k in this.attrs ? this.attrs[k] : null;
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getBoundingClientRect() { return this.rect; },
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; },
    insertBefore(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.unshift(c); return c; },
    removeChild(c) { c.parentNode = null; this.children = this.children.filter(x => x !== c); return c; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { this._dispatched = (this._dispatched || 0) + 1; return true; },
    contains(c) { let p = c; while (p) { if (p === this) return true; p = p.parentNode; } return false; },
    focus() {}, load() {}, play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; },
    click() { this._clicked = (this._clicked || 0) + 1; if (this._onClick) this._onClick(); },
    textContent: '', innerText: '', rect: { width: 0, height: 0, top: 0, bottom: 0 },
  };
  Object.defineProperty(el, 'nextSibling', {
    get() { const p = this.parentNode; if (!p) return null; const i = p.children.indexOf(this); return i < 0 ? null : (p.children[i + 1] || null); },
    configurable: true,
  });
  all.push(el);
  return el;
}

/* 简化选择器：tag / #id / .class / [attr] / [attr="v"] / [attr*="v"]，逗号并列 */
function matchOne(el, token) {
  token = token.trim();
  if (!token) return false;
  if (token[0] === '#') return el.id === token.slice(1);
  if (token[0] === '.') return el.classList.contains(token.slice(1));
  if (token[0] === '[') {
    const kv = token.match(/^\[([^=\]]+)([*^$]?=)"?([^"]*)"?\]$/);
    if (kv) {
      const av = el.getAttribute(kv[1]);
      if (av === null) return false;
      if (kv[2] === '=') return av === kv[3];
      if (kv[2] === '*=') return av.includes(kv[3]);
      return false;
    }
    const only = token.match(/^\[([^\]]+)\]$/);
    return only ? el.getAttribute(only[1]) !== null : false;
  }
  if (token === 'html') return el === documentElement;
  return el.tagName === token.toUpperCase();
}
function inDoc(el) {
  let p = el;
  while (p) { if (p === document) return true; p = p.parentNode; }
  return false;
}
function qsa(selStr) {
  const live = all.filter(inDoc);      // 真实 DOM：祖先被移除的元素不再可见
  const res = [];
  String(selStr).split(',').forEach(token => {
    live.forEach(e => { if (matchOne(e, token) && !res.includes(e)) res.push(e); });
  });
  return res;
}

const store = {};
const documentElement = mkEl('html');
const head = mkEl('head'), body = mkEl('body');
documentElement.appendChild(head); documentElement.appendChild(body);
const loc = { href: 'https://www.douyin.com/' };

const document = {
  documentElement, head, body, hidden: false, location: loc, scrollingElement: documentElement,
  cookie: 'ttwid=1; msToken=abc', addEventListener() {}, createElement: (t) => mkEl(t),
  querySelector: (s) => qsa(s)[0] || null,
  querySelectorAll: (s) => qsa(s),
  contains(c) { let p = c; while (p) { if (p === document) return true; p = p.parentNode; } return false; },
};
documentElement.parentNode = document;   // 真实 DOM 里 documentElement.parentNode === document

/* ---------------- 模拟抖音页面 ---------------- */
const feed = mkEl('div');
feed._oy = 'auto'; feed.scrollHeight = 2000; feed.clientHeight = 880; feed.scrollTop = 0; feed._idx = 0;
body.appendChild(feed);
const cards = [], videos = [];
for (let i = 0; i < 3; i++) {
  const card = mkEl('div', { 'data-e2e': 'feed-card-video' });
  card.rect = { width: 420, height: 760, top: i * 880, bottom: i * 880 + 760 };
  const v = mkEl('video');
  v.currentSrc = 'https://v.douyin.com/seed' + i + '.mp4'; v.src = v.currentSrc;
  v.videoWidth = 1080; v.videoHeight = 1920; v.paused = i !== 0; v.duration = 30; v.currentTime = 1;
  v.rect = { width: 400, height: 700, top: i * 880, bottom: i * 880 + 700 };
  card.appendChild(v); feed.appendChild(card); cards.push(card); videos.push(v);
}
// 站点侧模拟：容器被滚动 = 真的换了一条（播放态与几何位置跟着走）
feed.scrollBy = function (o) {
  this.scrollTop += (o && o.top) || 0;
  this._idx = Math.min(videos.length - 1, this._idx + 1);
  videos.forEach((v, i) => {
    v.paused = i !== this._idx;
    v.rect.top = (i - this._idx) * 880; v.rect.bottom = v.rect.top + 700;
    cards[i].rect.top = (i - this._idx) * 880; cards[i].rect.bottom = cards[i].rect.top + 760;
  });
};

// 未登录时的"登录"按钮：点它弹出带二维码的登录框
const loginBtn = mkEl('div');
loginBtn.textContent = loginBtn.innerText = '登录';
loginBtn.rect = { width: 88, height: 36, top: 20, bottom: 56 };
body.appendChild(loginBtn);
let modal = null;
loginBtn._onClick = () => openModal();

function openModal() {
  if (modal) return modal;
  modal = mkEl('div', { 'data-e2e': 'login-modal' });
  modal.rect = { width: 420, height: 520, top: 200, bottom: 720 };
  body.appendChild(modal);
  const pwdTab = mkEl('span'); pwdTab.textContent = pwdTab.innerText = '密码登录';
  pwdTab.rect = { width: 80, height: 24, top: 220, bottom: 244 };
  modal.appendChild(pwdTab);
  const qrTab = mkEl('span'); qrTab.textContent = qrTab.innerText = '扫码登录';
  qrTab.rect = { width: 80, height: 24, top: 250, bottom: 274 };
  modal.appendChild(qrTab);
  const qr = mkEl('img', { alt: '登录二维码', src: 'https://sso.douyin.com/qr.png' });
  qr.rect = { width: 160, height: 160, top: 300, bottom: 460 };
  modal.appendChild(qr);
  modal.qrTab = qrTab; modal.qr = qr;
  return modal;
}

/** 模拟手机扫码成功：登录按钮消失 + 拿到 sessionid */
function becomeLoggedIn() {
  loginBtn.remove();
  if (modal) { modal.remove(); modal = null; }
  document.cookie = 'ttwid=1; sessionid=fake_session_for_test; msToken=abc';
}

const AndroidTV = {
  calls: [], diags: [], toasts: [],
  onState(s) { this.calls.push(JSON.parse(s)); },
  log() {}, toast(m) { this.toasts.push(m); }, diag(m) { this.diags.push(m); },
};
const window = {
  document, location: loc, innerWidth: 1920, innerHeight: 1080, AndroidTV, navigator: { userAgent: 'node-harness' },
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  addEventListener() {}, focus() {}, scrollBy() {},
  setTimeout, clearTimeout, setInterval, clearInterval,
  KeyboardEvent: function (t, o) { Object.assign(this, o || {}); this.type = t; },
  WheelEvent: function (t, o) { Object.assign(this, o || {}); this.type = t; },
  MouseEvent: function (t, o) { Object.assign(this, o || {}); this.type = t; },
  getComputedStyle: (el) => ({ overflowY: el._oy || 'visible' }),
};
global.window = window; global.document = document;

new Function('window', 'document', fs.readFileSync(process.argv[2], 'utf8'))(window, document);
const dtv = window.__dtv;
const out = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
const pollUntil = (fn, ms) => new Promise(res => {
  const t0 = Date.now();
  (function step() {
    let ok = false;
    try { ok = !!fn(); } catch (e) { ok = false; }
    if (ok) return res(true);
    if (Date.now() - t0 > ms) return res(false);
    setTimeout(step, 80);
  })();
});

async function run() {
  assert(dtv, '__dtv 未导出');
  assert(document.querySelector('#dtv-style'), '样式未注入');
  out.push('启动注入通过（样式/HUD 已建）');

  // ① 未登录：识别为 out，并自动点开登录、切扫码 tab、放大二维码
  //    自动登录是异步链路（点登录→等渲染→点扫码 tab→放大），用轮询而不是猜固定毫秒
  const seen = await pollUntil(() => modal && modal.qr.classList.contains('dtv-qr'), 5000);
  assert(dtv.loginState() === 'out', '登录态应为 out，实际=' + dtv.loginState());
  assert(loginBtn._clicked >= 1, '没有自动点"登录"按钮');
  assert(modal, '登录弹窗没出现');
  assert(modal.qrTab._clicked >= 1, '没点到"扫码登录"tab');
  assert(seen, '二维码没放大');
  out.push('未登录自动开二维码：点到"登录"→"扫码登录"→二维码已放大');

  // ② 扫码成功 → 登录态转 in
  becomeLoggedIn();
  await wait(700);
  assert(dtv.loginState() === 'in', '扫码成功后仍是 ' + dtv.loginState());
  out.push('扫码成功后登录态转 in');

  // ③ 影院态：视频提升到 body 全屏
  dtv.setCinema(true);
  assert(videos[0].parentNode === body && videos[0].classList.contains('dtv-top'), '视频未提升');
  out.push('影院态：第0条已提升到 body 全屏');

  // ④ 上下键切流：key→card 都无效时应回退到 container 并记住
  const t0 = feed.scrollTop;
  dtv.swipe(1);
  const switched = await pollUntil(() => AndroidTV.calls.length
    && AndroidTV.calls[AndroidTV.calls.length - 1].strategy === 'container', 6000);
  assert(feed.scrollTop > t0, 'container 策略没滚动');
  assert(switched, '策略没被记成 container：' + JSON.stringify(AndroidTV.calls[AndroidTV.calls.length - 1]));
  out.push('swipe(1)：key→card→container 逐级回退命中，scrollTop ' + t0 + '→' + Math.round(feed.scrollTop) + '，策略已记住');

  dtv.rebind();
  assert(videos[1].parentNode === body && videos[1].classList.contains('dtv-top'), '第1条未接管');
  assert(videos[0].parentNode === cards[0] && !videos[0].classList.contains('dtv-top'), '第0条未还原');
  out.push('换绑：第1条接管全屏，第0条还原回原卡片');

  // ⑤ 登录墙再次出现 → 自动退回网页模式
  openModal();
  const backed = await pollUntil(() => AndroidTV.calls.length
    && AndroidTV.calls[AndroidTV.calls.length - 1].cinema === false, 3000);
  assert(backed, '登录墙下仍是影院态：' + JSON.stringify(AndroidTV.calls[AndroidTV.calls.length - 1]));
  assert(videos[1].parentNode === cards[1], '退出影院态时视频没还原');
  out.push('登录墙再现：自动退出影院态（扫码页可见）');

  // ⑥ 画面模式切换
  if (modal) { modal.remove(); modal = null; }
  dtv.setCinema(true);
  dtv.toggleFit();
  const covered = videos.filter(v => v.classList.contains('dtv-cover'));
  assert(covered.length === 1, 'cover 命中数=' + covered.length);
  out.push('画面模式：第' + videos.indexOf(covered[0]) + '条已切 cover（铺满裁切）');

  // ⑦ 自检浮层文本
  const d = dtv.diag();
  assert(typeof d === 'string' && /视频数/.test(d) && /登录态/.test(d), '诊断文本不完整');
  assert(AndroidTV.diags.length >= 1, '诊断没回传给原生浮层');
  out.push('自检浮层：含登录态/视频数/滚动容器，并已回传原生显示');

  console.log('\n全部通过：\n  - ' + out.join('\n  - ') + '\n');
  process.exit(0);
}
run().catch(e => { console.error('\n验证失败：' + e.message + '\n' + (e.stack || '').split('\n')[1] + '\n'); process.exit(1); });
