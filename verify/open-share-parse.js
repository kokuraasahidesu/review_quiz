/* ============================================================
 *  verify/open-share-parse.js —— 「收件人打开分享文件」真机取证（headless Edge）
 *
 *  运行：node verify/open-share-gen.js && node verify/open-share-parse.js
 *
 *  这一条**只认可见文字**：脚本注释里就写着"自带试卷""导出分享"这些词，搜全文等于自己骗自己
 *  （早先正是这么被骗过：导出文件里搜到卷名/题干，其实那只是载荷 JSON 里的数据，页面根本没渲染）。
 *  判据 = 「答案面板里到底有没有出题」+「出问题时有没有一句中文说明」。
 *
 *  无脚本那条（手机自带 HTML 查看器）走 CDP：本机 Edge 一加 `--blink-settings=scriptEnabled=false`，
 *  dump-dom 就返回空 —— 拿不到证据。CDP 的 `Emulation.setScriptExecutionDisabled` 是协议层的，
 *  关得掉页面脚本、又照样能取 DOM，是唯一靠谱的跑法。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');
const HERE = path.join(__dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

let pass = 0, fail = 0; const failures = [];
function ok(c, t, d) {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + d : '')); }
  else { fail++; failures.push(t); console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + d : '')); }
}
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

if (!fs.existsSync(EDGE)) { console.log('  （这台机器上没有 Edge，真机取件跳过）\n  PASS 0    FAIL 0'); process.exit(0); }
const files = ['__open-share.html', '__open-share-nostore.html', '__open-share-bad.html', '__open-share-broken.html'];
const missing = files.filter(function (f) { return !fs.existsSync(path.join(HERE, 'verify', f)); });
if (missing.length) { console.error('先跑：node verify/open-share-gen.js（缺 ' + missing.join(', ') + '）'); process.exit(1); }

/* ---------- 跑法一：dump-dom（脚本正常执行的那些） ---------- */
function dumpDom(name) {
  const file = path.join(HERE, 'verify', name);
  const dump = path.join(HERE, 'verify', '__' + name.replace(/\.html$/, '') + '-dump.html');
  try {
    execFileSync(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
      '--user-data-dir=' + path.join(process.env.TEMP, 'edge-os-' + name + '-' + Date.now()),
      '--window-size=420,900', '--virtual-time-budget=15000', '--dump-dom', 'file:///' + file.replace(/\\/g, '/')],
      { stdio: ['ignore', fs.openSync(dump, 'w'), 'ignore'], timeout: 60000 });
  } catch (e) { /* 超时/非零退出都可能，照样看 dump */ }
  return fs.existsSync(dump) ? fs.readFileSync(dump, 'utf8') : '';
}
/* 只看收件人**看得见**的字：脚本、样式、以及"脚本开着时不显示"的 <noscript> 都不算 */
function visible(dom) {
  return String(dom).replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

head('① 正常导出的一份：收件人打开**就该看到那套卷**（用户报障的那一条）');
const dGood = dumpDom('__open-share.html');
const vGood = visible(dGood);
ok(vGood.indexOf('取件验证卷') >= 0, '  卷名出来了（不是空题库首页）', vGood.slice(0, 80));
ok(vGood.indexOf('取件题干 1') >= 0, '  题干渲染出来了（真加载了那套卷，不是只读到 JSON）');
ok(vGood.indexOf('甲') >= 0 && vGood.indexOf('乙') >= 0, '  选项也在');
ok(vGood.indexOf('从下面的题库选一套卷开始') < 0 && vGood.indexOf('题库里还没有卷') < 0,
   '  **不是**"空题库首页"（这一条就是报障里的"看不了"）');
ok(vGood.indexOf('没能在当前浏览器里启动') < 0 && vGood.indexOf('本页有脚本报错') < 0,
   '  也没有弹兜底红条（正常启动）');
/* 用户报障："这个bug是我手机用导出分享之后的文件打开才有的" —— 分享文件**打开即作答**、不经过首页，
 * 所以"回到首页才展开页签排"对它没用：一进来那一排就得铺开，否则收件人只看到右上角一颗「展开 ▾」，
 * 找不到回首页/换页的路。 */
ok(/<div class="tabsrow open" id="tabsRow">/.test(dGood),
   '  页签那一排**一进来就是铺开的**（分享文件不经过首页，没有"回首页"那一下可按）',
   (dGood.match(/<div class="tabsrow[^>]*>/) || [''])[0]);
ok(vGood.indexOf('导入 / 校对') >= 0 && vGood.indexOf('错题本') >= 0 && vGood.indexOf('导出分享') >= 0,
   '  收件人看得见那些页签（回首页的路就在里面）');

head('② localStorage 被禁（有的浏览器在 file:// 下直接抛 SecurityError）');
const dNoStore = dumpDom('__open-share-nostore.html');
const vNoStore = visible(dNoStore);
ok(vNoStore.indexOf('取件题干 1') >= 0, '  照样出题（取 localStorage 的动作被 try 包住了，不再打断整页逻辑）');
ok(/存储|拿不到/.test(vNoStore), '  并且当面告诉用户"记录存不下来"', (vNoStore.match(/[^ ]*存储[^ ]*/) || [''])[0]);

head('③ 载荷被改坏（聊天软件转存 / 转码 / 截断）');
const dBad = dumpDom('__open-share-bad.html');
const vBad = visible(dBad);
ok(vBad.indexOf('取件题干 1') < 0, '  坏文件的题当然出不来');
ok(vBad.indexOf('这份分享文件里的试卷') >= 0, '  **但收件人看到的是一句中文原因**，不是空题库首页',
   (vBad.match(/这份分享文件里的试卷[^。]{0,60}/) || [''])[0]);
ok(vBad.indexOf('重新发一次') >= 0, '  并且告诉他怎么办（让出题者重发、用"文件"方式发）');

head('④ 脚本在解析期就炸（老引擎 / 文件被改坏）');
const dBroken = dumpDom('__open-share-broken.html');
const vBroken = visible(dBroken);
ok(vBroken.indexOf('没能在当前浏览器里启动') >= 0, '  顶部红条当面说"没启动"（不是白屏）');
ok(vBroken.indexOf('复制诊断信息') >= 0, '  并给一键复制诊断信息（用户能把原因发回来）');

/* ---------- 跑法二：CDP 关脚本（<noscript> 那句必须真的被显示） ---------- */
function listTargets(port) {
  return new Promise(function (res, rej) {
    http.get({ host: '127.0.0.1', port: port, path: '/json/list' }, function (r) {
      let b = '';
      r.on('data', function (d) { b += d; });
      r.on('end', function () { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
async function noScriptDom(file) {
  const port = 9345;
  const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--allow-file-access-from-files',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(process.env.TEMP, 'edge-os-nojs-' + Date.now()), 'about:blank'], { stdio: 'ignore' });
  try {
    let targets = null;
    for (let i = 0; i < 40 && !targets; i++) {
      await sleep(250);
      try { targets = await listTargets(port); } catch (e) { targets = null; }
    }
    if (!targets) throw new Error('CDP 端点没起来');
    const page = targets.filter(function (t) { return t.type === 'page'; })[0] || targets[0];
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(function (res, rej) { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    let seq = 0; const waits = new Map();
    ws.addEventListener('message', function (ev) {
      let m = null;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
    });
    const send = function (method, params) {
      return new Promise(function (res) {
        const id = ++seq;
        waits.set(id, res);
        ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      });
    };
    await send('Page.enable');
    await send('Emulation.setScriptExecutionDisabled', { value: true });
    await send('Page.navigate', { url: 'file:///' + file.replace(/\\/g, '/') });
    await sleep(2500);
    const doc = await send('DOM.getDocument', { depth: -1 });
    const html = await send('DOM.getOuterHTML', { nodeId: doc.result.root.nodeId });
    ws.close();
    return String(html.result.outerHTML);
  } finally { try { child.kill(); } catch (e2) { /* ignore */ } }
}

(async function () {
  head('⑤ 浏览器**根本不跑脚本**（手机自带的 HTML 查看器）');
  let noJs = null, err = null;
  try { noJs = await noScriptDom(path.join(HERE, 'verify', '__open-share.html')); }
  catch (e) { err = (e && e.message) || String(e); }
  if (err) {
    ok(false, '  关脚本取证跑得起来（CDP）', err);
  } else {
    /* 脚本开着时 <noscript> 的正文只是**一段被转义的文本**；关掉脚本它才是**元素** —— 用它当判据 */
    ok(/<noscript>\s*<p[\s\S]{0,400}?要靠 JavaScript 才能作答/.test(noJs),
       '  <noscript> 那句中文真的成了元素（= 脚本确实被关了，用户看得到它）');
    ok(noJs.indexOf('class="libpick') < 0 && noJs.indexOf('class="av-root') < 0,
       '  页面里没有任何脚本画出来的东西（所以那句说明就是收件人看到的全部）');
    ok(noJs.indexOf('要靠 JavaScript 才能作答') >= 0, '  那句话里有"换 Chrome / Edge / Safari 打开"的指路');
  }

  console.log('\n  PASS ' + pass + '    FAIL ' + fail);
  if (fail) { console.log('  失败项：'); failures.forEach(function (f) { console.log('    - ' + f); }); }
  process.exitCode = fail ? 1 : 0;
})();
