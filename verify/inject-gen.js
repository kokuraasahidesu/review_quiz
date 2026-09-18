/* ============================================================
 *  verify/inject-gen.js —— 「注入链能不能打通」取证 · 第一步
 *
 *  运行：node verify/inject-gen.js && node verify/inject-parse.js
 *
 *  验的就是用户问的那条链：**别人给的 txt → 我导入 → 我导出分享 → 别人打开**。
 *  每一步都可能出问题（渲染拼接、导出转义、接收解析），所以这里把整条链跑一遍：
 *    ① 造一份"题面全是攻击性标记"的题库（txt）；
 *    ② 用**真实解析器**切题（Node 侧同一份代码）；
 *    ③ 用**真实导出路径**（exportStandalone + review_quiz.html 当壳）生成分享文件；
 *    ④ 真浏览器打开：导入页渲染那条链（inject.html）+ 分享文件本身（__inject-share.html）。
 *  判据在下一棒的 inject-parse.js 里（只看渲染结果与 DOM，不看注释与文案）。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const HERE = path.join(__dirname, '..');
const P = require('../parser-core.js');
const D = require('../core/data.js');
const S = require('../core/schema.js');

/* 攻击性题库：把常见的"能变成代码"的写法都塞进题面/选项/解析（还都是合法题干，能正常切题） */
const BANK = [
  '【单选】注入A <script>window.__pwned.push("script")</script>？',
  'A. 选项甲 <img src=x onerror="window.__pwned.push(\'img\')">',
  'B. 选项乙 <svg onload="window.__pwned.push(\'svg\')">',
  '答案：A',
  '解析：解析里放 </script><iframe src="javascript:window.__pwned.push(\'iframe\')"></iframe> 与 <a href="javascript:window.__pwned.push(\'js\')">点我</a>',
  '',
  '【判断】注入B "><img src=x onerror=window.__pwned.push("img2")>（　）',
  '答案：对',
  '',
  '【简答】注入C {{constructor.constructor("window.__pwned.push(1)")()}} 与 ${alert(1)} ？',
  '答案：关键词甲；关键词乙',
  '解析：<object data="data:text/html,<script>parent.__pwned.push(\'obj\')</script>"></object>'
].join('\n');

(async function () {
  const parsed = P.parseText(BANK);
  const questions = parsed.questions.map(function (q) { return S.createQuestion(q); });
  const exam = S.createExam({ id: 'INJ-1', title: '注入试探卷', configLocked: true, questions: questions },
                            { now: '2026-01-01T00:00:00.000Z' });

  /* ③ 真实导出路径：拿成品当壳，把这份"带攻击性标记"的卷打成分享文件 */
  const shell = fs.readFileSync(path.join(HERE, 'review_quiz.html'), 'utf8');
  const exp = D.exportStandalone({ exams: [exam] }, shell,
    { examIds: ['INJ-1'], at: '2026-01-01T00:00:00.000Z', secrets: [] });
  if (!exp.ok) { console.error('导出失败：' + exp.message); process.exit(1); }
  fs.writeFileSync(path.join(HERE, 'verify', '__inject-share.html'), exp.html, 'utf8');

  /* ④-a 导入页渲染链：把这份卷挂进真实答题界面，看渲染出来的 DOM */
  const DRIVER = `
(function () {
  var canary = [];
  window.__pwned = canary;
  window.__err = [];
  window.addEventListener('error', function (e) { window.__err.push(String(e.message)); }, true);
  var out = [];
  function push(s) { out.push(s); }
  function dump() {
    var pre = document.getElementById('drvReport');
    if (!pre) { pre = document.createElement('pre'); pre.id = 'drvReport'; document.body.appendChild(pre); }
    pre.textContent = out.join('\\n');
  }
  (async function () {
    /* 题库里带着「脚本结束标签」那种串：直接 JSON.stringify 塞进 script 块会当场截断驱动脚本
     * （第一版就栽在这儿：页面什么都没发生）。所以 '<' 一律转义成 \\u003c ——
     * 这也正是应用导出时对载荷做的那件事（见 core/data.js 的 payloadBlock）。
     * ⚠ 这段注释里不许出现反引号或裸的脚本结束标签：它本身就在模板字符串里。 */
    var BANK = ${JSON.stringify(BANK).replace(/</g, '\\u003c')};
    try {
    push('MODULES=' + [typeof QuizParser, typeof SchemaCore, typeof AttemptCore, typeof AttemptView, typeof QuizCore].join(','));
    dump();
    var parsed = QuizParser.parseText(BANK);
    var questions = parsed.questions.map(function (q) { return SchemaCore.createQuestion(q); });
    push('PARSED=' + questions.length);
    var host = document.getElementById('ansHost');
    push('HOST=' + !!host);
    var session = AttemptCore.createSession({ examId: 'INJ-1', title: '注入试探卷', questions: questions,
      config: QuizCore.resolveConfig(QuizCore.DEFAULT_CONFIG, null), startedAt: 'T' });
    push('SESSION=' + !!session);
    var view = AttemptView.mount({ container: host, session: session, onChange: function () {} });
    push('VIEW=' + !!view);
    await new Promise(function (r) { setTimeout(r, 400); });
    dump();
    var risky = host.querySelectorAll('script,img,svg,iframe,object,embed,form,a[href^="javascript"]');
    push('RISKY_ELEMENTS=' + risky.length);
    Array.prototype.slice.call(risky).forEach(function (e) { push('  risky: <' + e.tagName.toLowerCase() + '>'); });
    var text = String(host.textContent || '');
    push('LITERAL_SCRIPT=' + (text.indexOf('<script>window.__pwned.push("script")<\\/script>') >= 0));
    push('LITERAL_IMG=' + (text.indexOf('onerror=') >= 0));
    push('PWNED_AFTER_RENDER=' + canary.length + ':' + canary.join(','));
    /* 选 A 判分 → 解析那一段也要过一遍 */
    var opts = host.querySelectorAll('.av-opt');
    if (opts.length) opts[0].click();
    await new Promise(function (r) { setTimeout(r, 300); });
    var submit = host.querySelector('[data-av="submit"], .av-submit, .av-btn');
    if (submit) submit.click();
    await new Promise(function (r) { setTimeout(r, 500); });
    var risky2 = host.querySelectorAll('script,img,svg,iframe,object,embed,form,a[href^="javascript"]');
    push('RISKY_AFTER_SUBMIT=' + risky2.length);
    var text2 = String(host.textContent || '');
    push('LITERAL_JS_URL=' + (text2.indexOf('javascript:window.__pwned.push') >= 0));
    push('PWNED_AFTER_SUBMIT=' + canary.length + ':' + canary.join(','));
    push('WINDOW_ERRORS=' + window.__err.length + ':' + window.__err.join(' | '));
    document.title = 'INJECT_REPORT ' + (canary.length === 0 ? 'CLEAN' : 'PWNED');
    } catch (e) {
      push('DRIVER_ERROR=' + ((e && e.message) || e));
      document.title = 'INJECT_REPORT DRIVER_FAILED';
    }
    dump();
  })();
})();`;

  try { new Function(DRIVER); } catch (e) { console.error('驱动脚本语法错误：' + e.message); process.exit(1); }
  /* ⚠ 注入点必须是**最后一个 `</body>` 之前**：驱动要用 QuizParser / SchemaCore / AttemptView，
   *   它们定义在壳自己的那段 script 里 —— 插在 `<body>` 开头会在它们之前执行（第一版就这么白忙一场）。 */
  const at = shell.lastIndexOf('</body>');
  const app = shell.slice(0, at) + '<script>' + DRIVER + '<\/script>\n' + shell.slice(at);
  fs.writeFileSync(path.join(HERE, 'verify', 'inject.html'), app, 'utf8');

  console.log('  题库字节        =', Buffer.byteLength(BANK, 'utf8'));
  console.log('  解析出题数      =', questions.length);
  console.log('  分享文件        = verify/__inject-share.html  (' + (Buffer.byteLength(exp.html, 'utf8') / 1024).toFixed(1) + ' KB)');
  console.log('  载荷块 / 外部引用 =', D.payloadBlockCount(exp.html).complete, '/', D.externalRefsIn(exp.html).length);
  console.log('  渲染链页面      = verify/inject.html');
  console.log('  下一步：node verify/inject-parse.js');
})();
