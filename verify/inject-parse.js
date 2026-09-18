/* ============================================================
 *  verify/inject-parse.js —— 「注入链」取证 · 第二步：真浏览器出数 + 判据
 *
 *  运行：node verify/inject-gen.js && node verify/inject-parse.js
 *
 *  只看两件事：
 *    ① 导入→渲染（inject.html 里的驱动报告）：题面里的 `<script>` / `onerror` / `javascript:` 有没有变成**元素/代码**
 *       —— 判据是"DOM 里没有 script/img/svg/iframe 这类节点" + "canary 数组仍然为空"；
 *    ② 分享文件（__inject-share.html）在真浏览器里打开：题干照常显示成**文字**，页面里的
 *       `<img` / `<svg` / `<iframe` 元素数量与**原壳一致**（题面那点标记一个都没变成节点）。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const HERE = path.join(__dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

let pass = 0, fail = 0; const failures = [];
function ok(c, t, d) {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d !== undefined ? '   ' + d : '')); }
  else { fail++; failures.push(t); console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + d : '')); }
}
function eq(a, e, t) { ok(JSON.stringify(a) === JSON.stringify(e), t + '   期望=' + JSON.stringify(e), JSON.stringify(a)); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }

if (!fs.existsSync(EDGE)) { console.log('  （没装 Edge，真机取件跳过）\n  PASS 0    FAIL 0'); process.exit(0); }
['inject.html', '__inject-share.html'].forEach(function (f) {
  if (!fs.existsSync(path.join(HERE, 'verify', f))) { console.error('先跑：node verify/inject-gen.js（缺 ' + f + '）'); process.exit(1); }
});

function run(file, name) {
  const dump = path.join(HERE, 'verify', '__inject-' + name + '-dump.html');
  try {
    execFileSync(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
      '--user-data-dir=' + path.join(process.env.TEMP, 'edge-inj-' + name + '-' + Date.now()),
      '--window-size=900,900', '--virtual-time-budget=20000',
      '--dump-dom', 'file:///' + path.join(HERE, 'verify', file).replace(/\\/g, '/')],
      { stdio: ['ignore', fs.openSync(dump, 'w'), 'ignore'], timeout: 90000 });
  } catch (e) { /* 超时也可能有 dump */ }
  return fs.existsSync(dump) ? fs.readFileSync(dump, 'utf8') : '';
}
/* 只看收件人/答题人**看得见**的字（脚本、样式、noscript 都不算）。
 * ⚠ 必须把 HTML 实体解回来：DOM 序列化会把题面里的 `<script>` 写成 `&lt;script&gt;`，
 *   不解实体就会把"文字里确实有它"误判成"没有"（第一版就这么假红了一次）。 */
function visible(dom) {
  return String(dom).replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/* ---------- ① 导入 → 渲染：诚实的"注入链第一跳" ---------- */
head('① 别人给的 txt → 我导入 → 答题界面渲染：标记只能当文字');
const domA = run('inject.html', 'render');
const rep = /<pre id="drvReport">([\s\S]*?)<\/pre>/.exec(domA);
if (!rep) {
  ok(false, '驱动写出了报告（没写出来说明页面根本没跑起来）');
} else {
  const body = rep[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const get = function (k) { const m = new RegExp('^' + k + '=(.*)$', 'm').exec(body); return m ? m[1].trim() : null; };
  ok(String(get('PARSED')) === '3', '那份"带攻击性标记"的题库正常切成 3 题（不是解析失败才"安全"）', 'PARSED=' + get('PARSED'));
  eq(get('RISKY_ELEMENTS'), '0', '  渲染出来的答题界面里：script/img/svg/iframe/object/embed/form 数量 = 0');
  eq(get('LITERAL_SCRIPT'), 'true', '  题面里的 `<script>…</script>` 是**当文字显示**的（textContent 里能找到原文）');
  eq(get('LITERAL_IMG'), 'true', '  `onerror=` 也是文字（它在选项文本里）');
  eq(get('PWNED_AFTER_RENDER'), '0:', '  canary 数组仍为空：没有任何一段攻击代码被执行（"0:" = 长度 0、内容为空）');
  eq(get('RISKY_AFTER_SUBMIT'), '0', '  判分 / 显示解析之后：仍然 0 个危险元素');
  eq(get('LITERAL_JS_URL'), 'true', '  解析里的 `javascript:` 是文字');
  eq(get('PWNED_AFTER_SUBMIT'), '0:', '  整条渲染链跑完 canary 仍为空（判分 + 解析显示都过了）');
  eq(String(get('WINDOW_ERRORS')).split(':')[0], '0', '  全程没有脚本错误（注入没有把页面搞坏）', get('WINDOW_ERRORS'));
  ok(domA.indexOf('INJECT_REPORT CLEAN') >= 0, '  页面自己打的结论：CLEAN');
}

/* ---------- ② 分享文件：别人打开那一份 ---------- */
head('② 我导出分享 → 别人在浏览器里打开：题面照常显示，且不多出任何元素');
const shell = fs.readFileSync(path.join(HERE, 'review_quiz.html'), 'utf8');
const share = fs.readFileSync(path.join(HERE, 'verify', '__inject-share.html'), 'utf8');
const count = function (s, needle) { return s.split(needle).length - 1; };
eq(count(share, '<img'), count(shell, '<img'), '  分享文件里的 `<img` 元素数与原壳一致（题面那点标记没变成节点）');
eq(count(share, '<svg'), count(shell, '<svg'), '  `<svg` 同理');
eq(count(share, '<iframe'), count(shell, '<iframe'), '  `<iframe` 同理');
eq(count(share, '<script'), count(shell, '<script') + 1, '  只多出 1 个 script —— 就是那个**载荷块**（数据）');
ok(share.indexOf('\\u003cscript>window.__pwned') >= 0, '  题面里的 `<script>` 在载荷里是转义形式（\\u003c）');

const domB = run('__inject-share.html', 'share');
const visB = visible(domB);
ok(visB.indexOf('注入A') >= 0, '  分享文件打开后，那道题的题面渲染出来了');
ok(visB.indexOf('<script>window.__pwned.push("script")</script>') >= 0, '  而且**整段标记是当文字显示**的（可见文字里能找到原文）');
eq(count(domB, '<img'), count(shell, '<img'), '  打开后的 DOM 里 `<img` 数量仍与原壳一致（没有被注入撑出元素）');
eq(count(domB, '<iframe'), count(shell, '<iframe'), '  `<iframe` 同理');
ok(visB.indexOf('这份文件自带试卷') >= 0, '  收件人看到的是"自带试卷"的正常提示（不是白屏/报错）');

console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
console.log('  PASS ' + pass + '    FAIL ' + fail);
if (fail) { console.log('  失败项：'); failures.forEach(function (f) { console.log('    - ' + f); }); }
process.exitCode = fail ? 1 : 0;
