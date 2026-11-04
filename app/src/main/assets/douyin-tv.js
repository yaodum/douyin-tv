/*
 * douyin-tv.js —— 电视端抖音网页版的适配层（由 MainActivity 注入）
 *
 * 为什么需要这一层：抖音网页版是给"鼠标 + 显示器"设计的，电视上直接打开会遇到
 *   1) 视频只占画面中间一小块，四周全是侧栏、评论、推荐位；
 *   2) 遥控器方向键被网页焦点系统抢走，按一下跳一个按钮；
 *   3) 竖屏 9:16 视频在 16:9 电视上要决定裁切还是留黑边；
 *   4) 首次进入是扫码登录页，此时绝不能遮罩。
 *
 * 做法：把正在播的 <video> 节点提到 body 顶层全屏（不用 Fullscreen API，因为它要求
 * 用户手势，而 evaluateJavascript 不算手势），上下键实现成推荐流切换（四种策略自动择优），
 * 影院态由"有没有真在播的视频 + 有没有登录弹窗"推导，登录页自动退回网页模式。
 *
 * 全程 ES5：盒子上的 WebView 内核可能停在 Chrome 70~80，避免 let/箭头函数/模板字符串。
 * 契约：window.__dtv.{boot,swipe,togglePlay,toggleFit,seek,toggleCinema,setCinema,rebind,pause,info,state}
 */
(function () {
  'use strict';

  var doc = document, win = window;
  if (win.__dtv) { win.__dtv.rebind(); win.__dtv.boot(''); return; }

  var LS_FIT = 'dtv.fit', LS_WANT = 'dtv.want', LS_STRATEGY = 'dtv.strategy';

  /* localStorage 在部分内核/隐私模式下会抛异常，包一层；同时把值镜像到 <html data-*>，
     这样即使抖音把我们的 storage 清了，同一文档生命周期内偏好仍然在。 */
  var store = {
    read: function (k, d) {
      try { var v = win.localStorage.getItem(k); if (v) return v; } catch (e) {}
      try { var a = doc.documentElement.getAttribute('data-' + k); if (a) return a; } catch (e2) {}
      return d;
    },
    write: function (k, v) {
      try { win.localStorage.setItem(k, v); } catch (e) {}
      try { doc.documentElement.setAttribute('data-' + k, v); } catch (e2) {}
    }
  };

  var st = {
    v: null,              // 当前被提升为全屏的 video 元素
    slot: null,           // {parent,next} 原始位置，退出影院态时还原
    want: store.read(LS_WANT, '1') === '1',   // 用户意愿：想不想影院态
    cinema: false,        // 实际生效的影院态（由 want + 页面状态推导）
    fit: store.read(LS_FIT, 'contain'),
    strategy: store.read(LS_STRATEGY, ''),
    login: '',            // in / out / unknown —— 由 loginState() 推导
    loginTries: 0,        // 自动点登录的次数，防刷屏
    loginTriedAt: 0,
    busy: false,          // 正在切下一条，暂停自适应免得抢绑
    hud: null, bar: null, tip: null, tipTimer: 0
  };

  /* ------------------------------------------------------------ 小工具 */

  function $(sel, root) { try { return (root || doc).querySelector(sel); } catch (e) { return null; } }
  function $$(sel, root) { try { return [].slice.call((root || doc).querySelectorAll(sel)); } catch (e) { return []; } }
  function bridge() { return win.AndroidTV || null; }
  function toJsBridge(fn, arg) { var b = bridge(); if (b && b[fn]) { try { b[fn](arg); } catch (e) {} } }
  function log(m) { toJsBridge('log', String(m)); }

  /* ------------------------------------------------------------ 样式 */

  var CSS = [
    '.dtv-top{position:fixed!important;top:0!important;left:0!important;',
    'width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;',
    'margin:0!important;padding:0!important;border:0!important;background:#000!important;',
    'z-index:2147483645!important;outline:none!important;border-radius:0!important;transform:none!important;box-shadow:none!important}',
    '.dtv-contain{object-fit:contain!important}',
    '.dtv-cover{object-fit:cover!important}',
    '.dtv-backdrop{position:fixed!important;top:0;left:0;right:0;bottom:0;background:#000!important;',
    'z-index:2147483640!important;pointer-events:none!important}',
    '.dtv-hud{position:fixed!important;left:0;right:0;bottom:0;height:4px;background:rgba(255,255,255,.14);',
    'z-index:2147483646!important;pointer-events:none!important}',
    '.dtv-hud i{display:block;height:4px;width:0;background:#fe2c55}',
    '.dtv-tip{position:fixed!important;top:24px;left:24px;color:#fff;background:rgba(0,0,0,.62);',
    'padding:10px 16px;border-radius:6px;font:16px/1.4 sans-serif;z-index:2147483647!important;',
    'pointer-events:none!important;opacity:0;transition:opacity .18s}',
    '.dtv-tip.on{opacity:1}',
    // 未登录时把二维码提到最上层放大：电视坐一米外也能扫清
    '.dtv-qr{position:fixed!important;top:50%!important;left:50%!important;',
    'width:auto!important;height:auto!important;min-width:340px!important;min-height:340px!important;',
    'transform:translate(-50%,-50%)!important;z-index:2147483646!important;',
    'background:#fff!important;padding:16px!important;border-radius:8px!important;',
    'box-shadow:0 0 0 4px #fe2c55!important;object-fit:contain!important;'
  ].join('');

  function ensureStyle() {
    if ($('#dtv-style')) return;
    var s = doc.createElement('style');
    s.id = 'dtv-style';
    s.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(s);
  }

  function ensureLayered() {
    ensureStyle();
    if (!doc.body) return;
    if (!$('.dtv-backdrop') && st.cinema) {
      var bd = doc.createElement('div'); bd.className = 'dtv-backdrop'; doc.body.appendChild(bd);
    }
    if (!st.hud || !doc.contains(st.hud)) {
      st.hud = doc.createElement('div'); st.hud.className = 'dtv-hud';
      st.bar = doc.createElement('i'); st.hud.appendChild(st.bar); doc.body.appendChild(st.hud);
    }
    if (!st.tip || !doc.contains(st.tip)) {
      st.tip = doc.createElement('div'); st.tip.className = 'dtv-tip'; doc.body.appendChild(st.tip);
    }
  }

  function dropBackdrop() { var b = $('.dtv-backdrop'); if (b && b.parentNode) b.parentNode.removeChild(b); }

  function tip(msg, ms) {
    ensureLayered();
    if (!st.tip) return;
    st.tip.textContent = msg;
    st.tip.className = 'dtv-tip on';
    if (st.tipTimer) win.clearTimeout(st.tipTimer);
    st.tipTimer = win.setTimeout(function () { st.tip.className = 'dtv-tip'; }, ms || 1500);
  }

  /* ------------------------------------------------------------ 找"主角"视频 */

  /** 可见、面积最大、优先在播的那个。抖音会同时挂着预热视频和广告小窗，靠面积+播放态区分。 */
  function mainVideo() {
    var best = null, bestScore = -1, vs = $$('video');
    for (var i = 0; i < vs.length; i++) {
      var v = vs[i], r = v.getBoundingClientRect();
      if (r.width < 100 || r.height < 100) continue;
      var score = r.width * r.height + (v.paused || v.ended ? 0 : 2e7);
      if (score > bestScore) { bestScore = score; best = v; }
    }
    if (!best && st.v && doc.contains(st.v)) best = st.v;
    return best;
  }

  function isLifted(v) { return !!v && v.parentNode === doc.body; }

  function applyFit(v) {
    if (!v) return;
    var c = v.classList;
    if (!c.contains('dtv-top')) c.add('dtv-top');
    c.remove('dtv-cover', 'dtv-contain');
    c.add(st.fit === 'cover' ? 'dtv-cover' : 'dtv-contain');
  }

  /** 提到 body 顶层。不用 Fullscreen API 是因为它要求真实用户手势，注入脚本拿不到。 */
  function lift(v) {
    if (!v) return;
    if (v === st.v && isLifted(v)) { applyFit(v); return; }
    if (st.v && st.v !== v) release(st.v);
    st.slot = { parent: v.parentNode, next: v.nextSibling };
    doc.body.appendChild(v);
    applyFit(v);
    st.v = v;
    try { v.addEventListener('ended', onEnded, false); } catch (e) {}
    report();
  }

  /** 还原回原卡片；卡片已被抖音回收时，把节点销毁，免得留个隐形视频在出声。 */
  function release(v) {
    if (!v) return;
    try { v.removeEventListener('ended', onEnded, false); } catch (e) {}
    v.classList.remove('dtv-top', 'dtv-cover', 'dtv-contain');
    var home = st.slot && st.slot.parent;
    if (home && home !== doc.body && doc.contains(home)) {
      try { home.insertBefore(v, st.slot.next); } catch (e) { try { home.appendChild(v); } catch (e2) {} }
    } else {
      try { v.pause(); } catch (e3) {}
      try { if (v.parentNode === doc.body) v.parentNode.removeChild(v); } catch (e4) {}
    }
    st.slot = null;
    if (st.v === v) st.v = null;
  }

  /* ------------------------------------------------------------ 影院态：自适应 */

  /* ------------------------------------------------------------ 登录辅助
   *
   * 电视上没有键盘，登录只能靠手机扫码，所以未登录时必须主动把二维码推到眼前。
   * 口径全部走"文案 + 几何特征"，不依赖抖音的类名 —— 类名每次构建都变，
   * "登录""扫码登录"这几个字不会变。
   */

  var LOGIN_WORDS = /^\s*(登\s*录|立即登录|登录后查看更多)\s*$/;
  var QR_TAB_WORDS = /^\s*(扫[码碼]\s*登\s*录|二\s*维\s*码登\s*录|APP\s*扫码)\s*$/;

  /** 找"登录"入口按钮：文本极短且命中关键词、尺寸像个按钮、在视口内。 */
  function findLoginTrigger() {
    var all = $$('button, a, div, span');
    for (var i = 0; i < all.length; i++) {
      var e = all[i], t = (e.innerText || e.textContent || '');
      if (t.length > 14 || !LOGIN_WORDS.test(t)) continue;
      var r = e.getBoundingClientRect();
      if (r.width < 24 || r.height < 14) continue;
      if (r.bottom < 0 || r.top > win.innerHeight) continue;
      return e;
    }
    return null;
  }

  /** 按文案找元素（用来点"扫码登录"这种 tab）。 */
  function findByText(re, maxLen) {
    var all = $$('div, span, li, button, a, p');
    for (var i = 0; i < all.length; i++) {
      var e = all[i], t = (e.innerText || e.textContent || '');
      if (t.length > (maxLen || 16)) continue;
      if (!re.test(t)) continue;
      var r = e.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      return e;
    }
    return null;
  }

  /** 登录弹窗是否已经打开：出现"扫码登录/手机号登录/验证码登录"这类 tab 文案即算。 */
  function loginModalOpen() {
    var el = findByText(QR_TAB_WORDS) || findByText(/^\s*(手机[号號]登录|验证码登录|password|密码登录)\s*$/);
    if (el) return el;
    return $('[data-e2e="login-modal"], #login-modal, .login-guide-container, [class*="login-guide"]');
  }

  /**
   * 登录态判定。注意 sessionid 是 httpOnly，JS 读不到，所以不能只看 cookie；
   * 以"页面上还有没有登录按钮"为主，cookie 只作为已登录的强证据。
   */
  function loginState() {
    var c = '';
    try { c = doc.cookie || ''; } catch (e) {}
    if (/sessionid=[^;]+|sid_guard=[^;]+|uid_tt=[^;]+/.test(c)) return 'in';
    if ($('[data-e2e="user-info"], [data-e2e="profile-menu"], [data-e2e="avatar"], [aria-label="我的"]')) return 'in';
    if (findLoginTrigger()) return 'out';
    if (loginModalOpen()) return 'out';
    return 'unknown';
  }

  /** 找到二维码（同源时是 img/canvas），提到最上层放大，方便隔着一米多扫。 */
  function enlargeQr() {
    var pool = $$('img, canvas');
    var best = null, bestSide = 0;
    for (var i = 0; i < pool.length; i++) {
      var e = pool[i], r = e.getBoundingClientRect();
      var w = r.width, h = r.height;
      if (w < 70 || h < 70) continue;
      var ratio = w / h;
      if (ratio < 0.75 || ratio > 1.35) continue;   // 二维码是方的
      var alt = (e.getAttribute('alt') || '') + (e.getAttribute('src') || '').slice(0, 40);
      var looksQr = /二维码|qrcode|qr[^a-z]|captcha/i.test(alt) || e.tagName === 'CANVAS';
      var score = (looksQr ? 1e6 : 0) + w * h;
      if (score > bestSide) { bestSide = score; best = e; }
    }
    if (!best) return false;
    best.classList.add('dtv-qr');
    return true;
  }

  /**
   * 打开登录二维码。force=true 时是用户主动按键触发。
   * 返回值只用于提示文案，不代表登录成功。
   */
  function openLogin(force) {
    var opened = false;
    if (!loginModalOpen()) {
      var b = findLoginTrigger();
      if (b) { try { b.click(); opened = true; } catch (e) {} }
    } else {
      opened = true;
    }
    // 弹窗里默认可能停在"密码登录/手机号登录"，等它渲染完再切到扫码页
    win.setTimeout(function () {
      var tab = findByText(QR_TAB_WORDS);
      if (tab) { try { tab.click(); } catch (e) {} }
      win.setTimeout(function () {
        if (enlargeQr()) tip('二维码已放大，用手机抖音「扫一扫」', 3000);
        else if (force) tip('登录页已打开：若没看到二维码，请按返回键重试', 3000);
      }, 400);
    }, 600);
    st.loginTriedAt = Date.now();
    st.loginTries++;
    report();
    return opened;
  }

  /** 登录态发生"变成已登录"这一跳时收尾：清二维码放大、重置尝试次数。 */
  function onLoggedIn(prev) {
    if (prev === 'in') return;
    st.loginTries = 0;
    var q = $('.dtv-qr'); if (q) q.classList.remove('dtv-qr');
    tip('已登录，视频开始播放就自动全屏', 2500);
  }

  /** 自检文本：长按菜单键显示，出问题就靠这一屏定位。 */
  function diag() {
    var vids = $$('video'), info = [];
    for (var i = 0; i < vids.length && i < 4; i++) {
      var r = vids[i].getBoundingClientRect();
      info.push('v' + i + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)
        + (vids[i].paused ? ' 停' : ' 播') + ' ' + (vids[i].videoWidth || 0) + 'px');
    }
    var host = scrollHost();
    var lines = [
      '诊断 ' + doc.location.href,
      '登录态: ' + (st.login || loginState()) + '  尝试次数: ' + st.loginTries,
      '登录按钮: ' + (findLoginTrigger() ? '有' : '无') + '  弹窗: ' + (loginModalOpen() ? '开' : '关'),
      '视频数: ' + vids.length + ' → ' + (info.join(' / ') || '无'),
      '滚动容器: ' + (host ? (host.className || host.tagName).slice(0, 40) + ' sh=' + host.scrollHeight + ' ch=' + host.clientHeight : '未找到'),
      '策略: ' + (st.strategy || '未定') + '  影院: ' + st.cinema + ' 意愿: ' + st.want + ' 画面: ' + st.fit,
      'UA: ' + (win.__dtvUa || navigator.userAgent).slice(0, 52),
      'cookie键: ' + (doc.cookie || '').replace(/=[^;]*/g, '=').slice(0, 70)
    ];
    toJsBridge('diag', lines.join('\n'));
    return lines.join('\n');
  }


  /** 页面里是否已经有真在解码的视频（videoWidth>0 才算，占位元素是 0）。 */
  function realVideo() {
    var v = mainVideo();
    return v && v.videoWidth > 0 ? v : null;
  }

  function setCinema(on, fromUser) {
    st.cinema = !!on;
    if (fromUser) { st.want = !!on; store.write(LS_WANT, st.want ? '1' : '0'); }
    if (st.cinema) {
      ensureLayered();
      var v = realVideo() || mainVideo();
      if (v) lift(v); else { st.cinema = false; dropBackdrop(); }
    } else {
      if (st.v) release(st.v);
      dropBackdrop();
    }
    report();
  }

  function setFit(mode, quiet) {
    st.fit = mode === 'cover' ? 'cover' : 'contain';
    store.write(LS_FIT, st.fit);
    applyFit(st.v);
    if (!quiet) tip(st.fit === 'cover' ? '画面：铺满（上下被裁）——再长按确认键切回完整' : '画面：完整显示（左右黑边）');
  }

  /* ------------------------------------------------------------ 切流：策略择优 */

  /**
   * 当前条目指纹。抖音切条有两种实现：复用同一个 <video> 换 src，或整卡换节点，
   * 所以必须同时看"节点身份 + src 尾段 + 卡片 e2e + 标题"，只取其一必有一种检测不到。
   * 注意以 mainVideo()（此刻真正在播的那个）为准，不能用 st.v —— st.v 在切换成功前仍是旧的。
   */
  var idSeq = 0;
  function nodeId(v) {
    if (!v.__dtvId) { try { v.__dtvId = ++idSeq; } catch (e) { return 'x'; } }
    return v.__dtvId;
  }

  function sig() {
    var v = mainVideo() || st.v;
    if (!v) return 'none';
    var src = '';
    try { src = v.currentSrc || v.src || ''; } catch (e) {}
    var e2e = '', p = v;
    while (p && p !== doc.body) {
      if (p.getAttribute) {
        var a = p.getAttribute('data-e2e');
        if (a) { e2e = a; break; }
      }
      p = p.parentNode;
    }
    var h = $('[data-e2e="video-item-title"], h1');
    var t = h ? (h.textContent || '').replace(/\s+/g, '').slice(0, 20) : '';
    return nodeId(v) + '|' + src.slice(-40) + '#' + e2e + '#' + t;
  }

  /** 视频所属的竖向滚动容器。抖音推荐流是 scroll-snap 容器，不是 window 滚动。 */
  function scrollHost() {
    var start = null, vids = $$('video');
    for (var i = 0; i < vids.length; i++) {
      if (vids[i] !== st.v && vids[i].parentNode !== doc.body) { start = vids[i]; break; }
    }
    if (!start) start = $([
      '[data-e2e="feed-card-video"]', '[data-e2e="video-player"]',
      '.xg-container', '#douyin-right-container'
    ].join(',')) || doc.body;
    var probe = start;
    while (probe && probe !== doc.documentElement && probe !== doc.body) {
      var cs;
      try { cs = win.getComputedStyle(probe); } catch (e) { break; }
      if (/auto|scroll|hidden|overlay/.test(cs.overflowY) && probe.scrollHeight > probe.clientHeight + 80) return probe;
      probe = probe.parentNode;
    }
    return null;
  }

  var STRATEGIES = {
    /* ① 桌面键盘事件：抖音自己监听 ↑↓，命中时最顺、最不容易破坏它的虚拟列表 */
    key: function (dir) {
      var k = dir > 0 ? 'ArrowDown' : 'ArrowUp', code = dir > 0 ? 40 : 38;
      var ts = [doc, win, doc.body, doc.documentElement];
      var v = st.v || mainVideo();
      if (v) { ts.push(v); ts.push(v.parentNode); }        // 有些实现只监听播放器所在子树
      for (var i = 0; i < ts.length; i++) {
        if (!ts[i]) continue;
        try {
          ts[i].dispatchEvent(new win.KeyboardEvent('keydown', { key: k, code: k, keyCode: code, which: code, bubbles: true, cancelable: true }));
          ts[i].dispatchEvent(new win.KeyboardEvent('keyup', { key: k, code: k, keyCode: code, which: code, bubbles: true }));
        } catch (e) {}
      }
    },
    /* ② 直接点下一条卡片：抖音推荐流点击即激活，绕开所有滚动/键盘实现差异 */
    card: function (dir) {
      var v = st.v || mainVideo();
      if (!v) return;
      var card = v;
      while (card && card !== doc.body && !(card.getAttribute && card.getAttribute('data-e2e'))) card = card.parentNode;
      if (!card || card === doc.body) return;
      var r = card.getBoundingClientRect();
      var all = $$('[data-e2e]'), pick = null, pickD = 1e9;
      for (var i = 0; i < all.length; i++) {
        var e = all[i];
        if (e === card || !e.getBoundingClientRect) continue;
        var er = e.getBoundingClientRect();
        if (er.width < 120 || er.height < 120) continue;
        var delta = dir > 0 ? (er.top - r.bottom) : (r.top - er.bottom);
        // 只接受"紧挨着的那一张"，避免点到远处的推荐位
        if (delta > -60 && delta < win.innerHeight && Math.abs(delta) < pickD) { pickD = Math.abs(delta); pick = e; }
      }
      if (pick) { try { pick.click(); pick.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true })); pick.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true })); } catch (e) {} }
    },
    /* ② 整屏滚一格 */
    container: function (dir) {
      var host = scrollHost();
      if (!host) return;
      var step = Math.max(200, host.clientHeight * 0.97);
      if (host.scrollBy) { try { host.scrollBy({ top: dir * step, behavior: 'auto' }); } catch (e) { host.scrollTop += dir * step; } }
      else host.scrollTop += dir * step;
    },
    /* ③ 滚轮事件：抖音把 wheel 当主交互 */
    wheel: function (dir) {
      var el = st.v || doc.body;
      var step = Math.round(win.innerHeight * 0.95);
      try {
        el.dispatchEvent(new win.WheelEvent('wheel', {
          deltaY: dir * step, deltaMode: 0, bubbles: true, cancelable: true,
          clientX: Math.round(win.innerWidth / 2), clientY: Math.round(win.innerHeight / 2)
        }));
      } catch (e) {}
    },
    /* ④ 文档级滚动兜底 */
    doc: function (dir) {
      var se = doc.scrollingElement || doc.documentElement;
      var step = Math.round(win.innerHeight * 0.97);
      se.scrollTop = se.scrollTop + dir * step;
      try { win.scrollBy(0, dir * step); } catch (e) {}
    }
  };

  var ORDER = ['key', 'card', 'container', 'wheel', 'doc'];

  function swipe(dir) {
    if (st.busy) return;
    var before = sig();
    var list = ORDER.slice();
    if (st.strategy && list.indexOf(st.strategy) >= 0) {
      list = [st.strategy].concat(list.filter(function (x) { return x !== st.strategy; }));
    }
    st.busy = true;
    var i = 0;
    (function attempt() {
      if (i >= list.length) {
        st.busy = false;
        tip('这页不吃按键切换：按菜单键退出影院态，用方向键手动导航');
        return;
      }
      var name = list[i++];
      try { STRATEGIES[name](dir); } catch (e) {}
      win.setTimeout(function () {
        if (sig() !== before) {
          if (st.strategy !== name) { st.strategy = name; store.write(LS_STRATEGY, name); log('strategy=' + name); }
          st.busy = false;
          win.setTimeout(function () { rebind(); }, 240);
          win.setTimeout(function () { rebind(); }, 900);
        } else {
          attempt();
        }
      }, 700);
    })();
  }

  /* ------------------------------------------------------------ 播放控制 */

  function play(v) {
    if (!v) return;
    try {
      var p = v.play();
      if (p && p.catch) p.catch(function (err) { tip('自动播放被拦：' + (err && err.name ? err.name : 'unknown')); });
    } catch (e) {}
  }

  function togglePlay() {
    var v = st.v || mainVideo();
    if (!v) { tip('页面里还没有视频'); return; }
    if (v.paused || v.ended) { play(v); tip('播放'); } else { v.pause(); tip('暂停'); }
    report();
  }

  function seek(sec) {
    var v = st.v || mainVideo();
    if (!v || !isFinite(v.duration)) return;
    v.currentTime = Math.max(0, Math.min(v.duration - 0.2, v.currentTime + sec));
    tip((sec > 0 ? '+' : '') + sec + ' 秒');
  }

  /** 播完自动接下一条 —— 电视上最该有的行为。 */
  function onEnded(e) {
    if (e && e.target && e.target !== st.v) return;
    swipe(1);
  }

  function rebind() {
    if (!st.cinema) return;
    var v = mainVideo();
    if (!v) return;
    if (v !== st.v || !isLifted(v)) lift(v);
    else applyFit(v);
  }

  function progress() {
    if (!st.cinema || !st.bar) return;
    var v = st.v;
    if (v && isFinite(v.duration) && v.duration > 0) {
      st.bar.style.width = Math.round((v.currentTime / v.duration) * 100) + '%';
    }
  }

  function report() {
    var b = bridge();
    if (!b || !b.onState) return;
    var v = st.v, url = '';
    try { url = String(doc.location.href).replace(/["\\]/g, ''); } catch (e) {}
    var s = '{"cinema":' + (st.cinema ? 'true' : 'false')
      + ',"strategy":"' + st.strategy + '","fit":"' + st.fit
      + '","paused":' + (v ? (v.paused ? 'true' : 'false') : 'true')
      + ',"video":' + (v ? 'true' : 'false')
      + ',"want":' + (st.want ? 'true' : 'false')
      + ',"login":"' + (st.login || 'unknown') + '"'
      + ',"url":"' + url + '"}';
    try { b.onState(s); } catch (e) {}
  }

  /* ------------------------------------------------------------ 主循环 */

  function tick() {
    if (doc.hidden) return;
    var v = realVideo(), wall = loginModalOpen(), state = loginState();
    var prev = st.login;
    st.login = state;
    onLoggedIn(prev);

    // 未登录 → 主动把二维码推出来（最多 4 次，每次间隔 8 秒），电视上没有键盘只能扫
    if (state === 'out' && !wall && st.loginTries < 4 && Date.now() - st.loginTriedAt > 8000) {
      openLogin(false);
    }

    if (st.cinema) {
      if (!st.busy && (!v || wall || state === 'out')) {
        // 登录页或视频消失：把画面还给网页，方向键恢复焦点导航
        setCinema(false, false);
        tip(wall || state === 'out' ? '需要用手机号扫码登录，二维码已就绪' : '视频已停止，退出影院态', 2600);
      } else {
        rebind();
      }
    } else if (st.want && v && !wall && state !== 'out' && !st.busy) {
      // 一旦真的有视频在解码且没有弹窗，自动进入全屏
      setCinema(true, false);
    }
    progress();
    report();
  }

  function boot(ua) {
    if (ua) win.__dtvUa = ua;
    ensureStyle();
    ensureLayered();
    st.login = loginState();
    if (st.cinema) rebind();
    // 开机先看一眼登录态：未登录就立刻把"登录"入口点开，别等用户去找按钮
    if (st.login !== 'in') {
      // 未登录就主动把二维码推到眼前，电视上没有键盘，等着用户自己找按钮不现实
      win.setTimeout(function () { if (loginState() === 'out') openLogin(false); }, 1200);
    }
    if (ua) log('boot ua=' + ua + ' videos=' + $$('video').length + ' want=' + st.want + ' login=' + st.login);
    report();
    tip(st.cinema ? '↑↓ 切视频 · 确认 暂停 · 长按确认 换画面 · 菜单 退影院态'
                  : (st.login === 'out' ? '正在准备登录二维码，用手机抖音扫一扫' : '等待视频开始播放会自动全屏'), 3200);
  }

  win.setInterval(tick, 500);
  doc.addEventListener('visibilitychange', function () { if (!doc.hidden) tick(); }, false);

  win.__dtv = {
    boot: boot,
    rebind: function () { rebind(); },
    swipe: function (dir) { swipe(dir > 0 ? 1 : -1); },
    togglePlay: togglePlay,
    toggleFit: function () { setFit(st.fit === 'cover' ? 'contain' : 'cover'); },
    seek: seek,
    pause: function () { if (st.v) { try { st.v.pause(); } catch (e) {} } },
    setCinema: function (on) { setCinema(!!on, true); tip(on ? '影院态：开' : '影院态：关（方向键恢复网页导航）'); },
    openLogin: function () { var ok = openLogin(true); tip(ok ? '登录二维码已打开，手机扫码' : '页面上没找到登录入口，可能已经登录'); },
    diag: function () { return diag(); },
    loginState: loginState,
    toggleCinema: function () {
      var on = !(st.cinema && st.want);
      setCinema(on, true);
      if (on && !st.cinema) tip('暂无播放中的视频，影院态待命中');
      else tip(st.cinema ? '影院态：开（↑↓切视频 · 确认暂停）' : '影院态：关（方向键恢复网页导航）');
    },
    state: report,
    info: function () {
      var v = st.v || mainVideo();
      toJsBridge('toast', '影院=' + st.cinema + ' 意愿=' + st.want + ' 策略=' + (st.strategy || '未定')
        + ' 画面=' + st.fit + ' 视频=' + (v ? (v.videoWidth + 'x' + v.videoHeight) : '无'));
    }
  };

  boot('');
})();
