/* 「界面小字清单」取证 · 第一步：注入 review_quiz.html 的副本，把**各个状态下**字号 < 14px 的
 * 可见文字逐条列出来（带字号、类名、所属面板）。
 *
 * 运行： node verify/smalltext-gen.js [源 HTML]
 *        不带参数 → 用当前构建出来的 review_quiz.html；
 *        带参数   → 用别的成品当底（例如把 git 里的旧版导出来，做"删小字前后"的同口径对比）。
 *       然后（PowerShell）：
 *         msedge --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files `
 *                --user-data-dir=<tmp> --window-size=1280,1000 --virtual-time-budget=40000 `
 *                --dump-dom file:///D:/apps/tools/quiz-demo/verify/smalltext.html > verify\smalltext-dump.html
 *       最后： node verify/smalltext-parse.js
 *
 * 为什么要有它：用户要求"把一些不必要的小字都删掉"。小字散在 6 个面板里，
 * 光靠 grep 源码会漏（很多是运行时拼出来的），所以这里**按状态走一遍、量真实字号**，
 * 清单是机器给的，删哪些由人定 —— 删完再跑一次，数字就是证据。
 */
const fs = require('fs');
const path = require('path');
const HERE = path.join(__dirname, '..');
/* 题库正文**内联成 JS 字面量**（file:// 页面 fetch 本机文件会被浏览器拦，实测 Failed to fetch） */
const BANK = fs.readFileSync(path.join(HERE, 'fixtures', 'txt', 'sectioned_bank.txt'), 'utf8');
const BANK_LIT = JSON.stringify(BANK).replace(/</g, '\\u003c');

const DRIVER = [
  '(function () {',
  '  var lines = [], okAll = true, seen = {};',
  '  function step(name, got, want) {',
  '    var pass = JSON.stringify(got) === JSON.stringify(want);',
  '    if (!pass) okAll = false;',
  '    lines.push((pass ? "PASS  " : "FAIL  ") + name + "  | 实测=" + JSON.stringify(got) + " 期望=" + JSON.stringify(want));',
  '  }',
  '  function note(t) { lines.push("----  " + t); }',
  '  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }',
  '  async function waitFor(fn, tries) { var n = tries || 60; while (n-- > 0) { var v = fn(); if (v) return v; await sleep(50); } return null; }',
  '  function flush() {',
  '    var pre = document.getElementById("drvReport");',
  '    if (!pre) { pre = document.createElement("pre"); pre.id = "drvReport"; document.body.appendChild(pre); }',
  '    pre.textContent = lines.join("\\n");',
  '    var box = document.getElementById("drvHud");',
  '    if (!box) { box = document.createElement("div"); box.id = "drvHud"; document.body.appendChild(box); }',
  '    box.style.cssText = "position:fixed;left:0;bottom:0;right:0;z-index:99999;background:rgba(0,0,0,.9);color:#9f9;"',
  '      + "font:11px/1.5 Consolas,monospace;padding:5px 7px;max-height:12vh;overflow:auto;white-space:pre-wrap;word-break:break-all";',
  '    box.textContent = "[界面小字清单]\\n" + lines.join("\\n");',
  '    document.title = "小字清单 (" + lines.length + " 行)";',
  '    try { window.scrollTo(0, 0); } catch (x) { /* ignore */ }',
  '  }',
  '  /* 走一遍：把每一处"字号 < 14px 且真的有字"的可见文本记下来（去重） */',
  '  function collect(label) {',
  '    var out = 0;',
  '    Array.prototype.slice.call(document.querySelectorAll("body *")).forEach(function (el) {',
  '      if (el.id === "drvHud" || el.id === "drvReport" || el.closest("#drvHud, #drvReport")) return;',
  '      if (el.children.length) return;                       /* 只看叶子：整块的容器不算一条 */',
  '      var t = String(el.textContent || "").replace(/\\s+/g, " ").trim();',
  '      if (!t || t.length < 2) return;',
  '      var r = el.getBoundingClientRect();',
  '      if (r.width <= 0 || r.height <= 0) return;',
  '      var fs = parseFloat(getComputedStyle(el).fontSize) || 0;',
  '      if (fs >= 14) return;',
  '      var key = fs + "|" + (el.className || "") + "|" + t.slice(0, 40);',
  '      if (seen[key]) return;',
  '      seen[key] = 1; out++;',
  '      lines.push("SMALL  [" + fs + "px] ." + String(el.className || "(无类名)").split(" ")[0]',
  '        + "  <" + label + ">  " + JSON.stringify(t.slice(0, 90)));',
  '    });',
  '    return out;',
  '  }',
  '  async function run() {',
  '    try {',
  '      /* ⓪ 先导一份题库进去（否则题库首页是空的，进不了「答卷前设置」那一页） */',
  '      var bankText = ' + BANK_LIT + ';',
  '      document.querySelector("#tab-review").click();',
  '      await sleep(150);',
  '      var fin0 = document.querySelector("#revFile");',
  '      var dt0 = new DataTransfer();',
  '      dt0.items.add(new File([new TextEncoder().encode(bankText)], "sectioned_bank.txt", { type: "text/plain" }));',
  '      fin0.files = dt0.files;',
  '      fin0.dispatchEvent(new Event("change", { bubbles: true }));',
  '      await waitFor(function () { return document.querySelector("#revStage .qp-stat"); });',
  '      document.querySelector(".qp-commit").click();',
  '      await waitFor(function () { return /已入库/.test(String(document.querySelector("#revMsg").textContent)) ? 1 : null; });',
  '      /* ① 答题页：题库首页（列表里有一套卷） */',
  '      document.querySelector("#tab-answer").click();',
  '      await sleep(400);',
  '      collect("答题·题库首页");',
  '      /* ①-b 答卷前设置页（底部那份内联快捷面板 + 预览行都在这一页） */',
  '      var startBtn = document.querySelector(".libpick-row .libpick-go.primary");',
  '      if (startBtn) {',
  '        startBtn.click();',
  '        await waitFor(function () { return document.querySelector(".pk-card"); });',
  '        await sleep(300);',
  '        collect("答卷前设置页");',
  '        var back2 = Array.prototype.slice.call(document.querySelectorAll("button"))',
  '          .filter(function (b) { return /返回列表/.test(b.textContent); })[0];',
  '        if (back2) { back2.click(); await sleep(250); }',
  '      }',
  '      /* ② 载入内置样卷 → 答题中（第一题）+ 底部快捷面板 */',
  '      var smp = document.querySelector(".libpick-foot button") || document.querySelector("#ansHost button");',
  '      var byText = Array.prototype.slice.call(document.querySelectorAll("button"))',
  '        .filter(function (b) { return /载入内置样卷/.test(b.textContent); })[0];',
  '      if (byText) byText.click();',
  '      await waitFor(function () { return document.querySelector(".av-root"); });',
  '      await sleep(300);',
  '      collect("答题中·第一题");',
  '      var fab = Array.prototype.slice.call(document.querySelectorAll("button"))',
  '        .filter(function (b) { return /设置|快捷/.test(b.textContent); })[0];',
  '      if (fab) { fab.click(); await sleep(200); }',
  '      collect("答题中·底部面板");',
  '      if (fab) { fab.click(); await sleep(150); }',
  '      /* 底部快捷面板默认是折叠的（标题行那颗「展开」）—— 展开它，把里面的小字一起采下来 */',
  '      var toggle = document.querySelector("[data-qp=\\"toggle\\"]");',
  '      if (toggle) { toggle.click(); await sleep(200); }',
  '      collect("答题中·快捷面板展开");',
  '      if (toggle) { toggle.click(); await sleep(120); }',
  '      /* ③ 故意答错一题 → 解析 + 人工订正那几行小字 */',
  '      var opts = Array.prototype.slice.call(document.querySelectorAll(".av-opt"));',
  '      var wrong = opts.filter(function (b) { return b.getAttribute("data-av-value") !== "A" && b.getAttribute("data-av-value") !== "B"; })[0] || opts[1];',
  '      if (wrong) wrong.click();',
  '      await sleep(250);',
  '      collect("答题中·答错后");',
  '      /* ④ 交卷页（含右栏试题回顾 / 人工订正） */',
  '      var fin = document.querySelector("[data-av=\\"finish\\"]") || document.querySelector("[data-av=\\"submit\\"]");',
  '      if (fin) fin.click();',
  '      await sleep(200);',
  '      var confirmBtn = Array.prototype.slice.call(document.querySelectorAll("button"))',
  '        .filter(function (b) { return /确定|交卷|继续/.test(b.textContent) && b.offsetParent; })[0];',
  '      if (confirmBtn) { confirmBtn.click(); await sleep(400); }',
  '      await sleep(300);',
  '      collect("交卷页");',
  '      /* ⑤ 导入 / 校对：空态 + 载入样卷 + 密钥面板 + 单题智能 */',
  '      document.querySelector("#tab-review").click();',
  '      await sleep(250);',
  '      collect("导入·空态");',
  '      var demo = document.querySelector("#revDemo");',
  '      if (demo) { demo.click(); await waitFor(function () { return document.querySelector("#revStage .qp"); }); }',
  '      await sleep(300);',
  '      collect("导入·已载入样卷");',
  '      var aikey = document.querySelector("#revAikey");',
  '      if (aikey) { aikey.click(); await waitFor(function () { return document.querySelector("#revAihost [data-as=\\"input\\"]"); }); }',
  '      await sleep(200);',
  '      collect("导入·密钥面板");',
  '      var one = document.querySelector("#revAibatch");',
  '      if (one) { one.click(); await waitFor(function () { return document.querySelector("#revBatchhost .asg-root"); }); }',
  '      await sleep(200);',
  '      collect("导入·生成解析面板");',
  '      /* ⑥ 错题本：列表 + 磁贴展开 + 举一反三 */',
  '      document.querySelector("#tab-wrong").click();',
  '      await sleep(400);',
  '      collect("错题本·列表");',
  '      var item = document.querySelector("[data-wv=\\"item\\"]");',
  '      if (item) { item.click(); await sleep(250); }',
  '      collect("错题本·磁贴展开");',
  '      var mk = document.querySelector("[data-wv=\\"mistake\\"]");',
  '      if (mk) { mk.click(); await sleep(300); }',
  '      collect("错题本·举一反三面板");',
  '      step("清单采集完成（条数在 HUD 上）", true, true);',
  '    } catch (e) {',
  '      okAll = false; lines.push("FAIL  驱动抛错：" + (e && e.stack || e));',
  '    }',
  '    flush();',
  '  }',
  '  if (document.readyState === "complete") setTimeout(run, 1200);',
  '  else window.addEventListener("load", function () { setTimeout(run, 1200); });',
  '})();'
].join('\n');

try { new Function(DRIVER); } catch (e) { throw new Error('注入脚本有语法错误：' + e.message); }

const srcPath = process.argv[2] || path.join(HERE, 'review_quiz.html');
const src = fs.readFileSync(srcPath, 'utf8');
const at = src.lastIndexOf('</body>');
if (at < 0) throw new Error('没找到 </body>');
fs.writeFileSync(path.join(HERE, 'verify', 'smalltext.html'), src.slice(0, at) + '<script>\n' + DRIVER + '\n<\/script>\n' + src.slice(at), 'utf8');
console.log('generated verify/smalltext.html（源 ' + path.basename(srcPath) + '，注入点 ' + at + '）');
