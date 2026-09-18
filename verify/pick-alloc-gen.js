/* 「抽题规则：逐题型分配」取证 · 第一步：把"实测脚本"注入 review_quiz.html 的副本，供 headless Edge 出数 + 出图。
 * 运行： node verify/pick-alloc-gen.js
 *       然后（PowerShell）：
 *         msedge --headless=new --disable-gpu --hide-scrollbars --user-data-dir=<tmp> --window-size=420,900 `
 *                --virtual-time-budget=20000 --screenshot=docs\ui-pick-alloc.png --dump-dom `
 *                file:///D:/apps/tools/quiz-demo/verify/pick-alloc.html > verify\pick-alloc-dump.html
 *       最后： node verify/pick-alloc-parse.js   （把 dump 里的报告抠出来打印）
 *
 * 第一证据是**截图顶部的读数**（和画面出自同一次渲染）；报告只是它的文字副本。
 * 实测脚本走六步：① 默认「按题型数量」→ 面板摆的是四行逐题型**题数**；
 * ② 点「单选 +」→ 10 → 11 题（提示里也写清）；③ 切「按题型总分」→ 四行换成逐题型**目标分**；
 * ④ 目标分的「+」按每题分值走（0 → 2 分，不是 1）；⑤ 真抽一把：逐题型目标分 8/6/4/10 →
 * 题数 4/2/4/2、满分 28（用的是页面里的**真** pickQuestions）；⑥ 切「完全随机」→ 才出现题量口径那两行。
 */
const fs = require('fs');
const path = require('path');
const HERE = path.join(__dirname, '..');

const DRIVER = [
  '(function () {',
  '  var lines = [], okAll = true;',
  '  function step(name, got, want) {',
  '    var pass = JSON.stringify(got) === JSON.stringify(want);',
  '    if (!pass) okAll = false;',
  '    lines.push((pass ? "PASS  " : "FAIL  ") + name + "  | 实测=" + JSON.stringify(got) + " 期望=" + JSON.stringify(want));',
  '  }',
  '  function flush() {',
  '    var pre = document.getElementById("drvReport");',
  '    if (!pre) { pre = document.createElement("pre"); pre.id = "drvReport"; document.body.appendChild(pre); }',
  '    pre.textContent = lines.join("\\n");',
  '    var box = document.getElementById("drvHud");',
  '    if (!box) { box = document.createElement("div"); box.id = "drvHud"; document.body.appendChild(box); }',
  '    box.style.cssText = "position:fixed;left:0;top:0;right:0;z-index:99999;background:rgba(0,0,0,.9);color:#9f9;"',
  '      + "font:11px/1.5 Consolas,monospace;padding:5px 7px;white-space:pre-wrap;word-break:break-all";',
  '    box.textContent = "[抽题规则 · 逐题型分配 · 实测]\\n" + lines.join("\\n");',
  '    document.title = "抽题规则逐题型分配 " + (okAll ? "ALL PASS" : "有 FAIL") + " (" + lines.length + " 条)";',
  '  }',
  '  function run() {',
  '    try {',
  '      var Q = window.QuizCore, V = window.AttemptView, A = window.AttemptCore;',
  '      var host = document.createElement("div"); host.id = "drvHost";',
  '      host.style.cssText = "padding:6px;border:2px dashed #b42318;margin:4px 0;background:#fff";',
  '      document.body.insertBefore(host, document.body.firstChild);',
  '      /* 把页面上原有的页签与面板挪走：同处 fixed 底部的另一个面板会盖住我的截图 */',
  '      Array.prototype.slice.call(document.querySelectorAll(".qp-root")).forEach(function (n) {',
  '        if (n.parentNode && !host.contains(n)) n.parentNode.removeChild(n); });',
  '      Array.prototype.slice.call(document.querySelectorAll(".pane")).forEach(function (n) { n.style.display = "none"; });',
  '      var cfg = Q.mergeConfig(Q.DEFAULT_CONFIG, { pick: { mode: "byCount" } });   // 显式从「按题型数量」起步',
  '      var s = A.createSession({ examId: "PA", title: "抽题分配实测", questions: [], config: cfg, startedAt: "T" });',
  '      /* ⚠ 抽题分配控件现在只在**"答卷前设置页"**里：答题时的底部面板已把「抽题与题量 / 分数线」两组',
  '       *   **排除**（见 ui/attempt-view.js 的 excludeGroups）。所以这里挂**同一个 QuickPanel 的 inline 模式**',
  '       *   （= 设置页那种挂法，不排除任何组）来驱动它 —— 验的仍是同一份渲染代码与同一套 flow/quiz 逻辑。 */',
  '      var v = window.QuickPanel.mount({ container: host, config: cfg, inline: true,',
  '        onChange: function (next) { A.setConfig(s, next); } });',
  '      var q = function (sel) { return host.querySelectorAll(sel); };',
  '      var ids = function (sel) { return Array.prototype.slice.call(q(sel)).map(function (n) { return n.getAttribute("data-qp"); }); };',
  '      step("inline 面板默认就是展开的（五个分组都在，不用先去点「展开」）",',
  '           q(".qp-gname").length >= 4, true);',
  '',
  '      /* ① 默认规则：四行逐题型「题数」 */',
  '      step("默认「按题型数量」→ 面板有四行逐题型题数", ids("[data-qp^=\\"byType.\\"]").filter(function (x) { return /\\+$/.test(x); }),',
  '           ["byType.单选+", "byType.多选+", "byType.判断+", "byType.简答+"]);',
  '      step("  此时没有「本轮题量 / 题量口径」（那是完全随机才用的）",',
  '           [q("[data-qp=\\"count\\"]").length, q("[data-qp=\\"basis=score\\"]").length], [0, 0]);',
  '      step("  规则那一行现在指着按题型数量", s.config.pick.mode, "byCount");',
  '',
  '      /* ② 点「单选 +」→ 10 → 11 题 */',
  '      var before = s.config.pick.byType["单选"];',
  '      q("[data-qp=\\"byType.单选+\\"]")[0].click();',
  '      step("点「单选 +」→ 题数 +1", [before, s.config.pick.byType["单选"]], [10, 11]);',
  '      step("  面板提示文字", String(q(".qp-msg")[0].textContent), "单选：11 题");',
  '',
  '      /* ③ 切「按题型总分」→ 四行换成目标分 */',
  '      q("[data-qp=\\"mode=byWeight\\"]")[0].click();',
  '      step("切「按题型总分」→ 四行换成逐题型目标分",',
  '           ids("[data-qp^=\\"byTypeScore.\\"]").filter(function (x) { return /\\+$/.test(x); }),',
  '           ["byTypeScore.单选+", "byTypeScore.多选+", "byTypeScore.判断+", "byTypeScore.简答+"]);',
  '      step("  规则那一行跟着变", s.config.pick.mode, "byWeight");',
  '',
  '      /* ④ 目标分的「+」按**每题分值**走（默认单选 2 分/题 → 0 → 2，不是 1） */',
  '      q("[data-qp=\\"byTypeScore.单选+\\"]")[0].click();',
  '      step("点「单选 +」→ 目标分按每题分值走（0 → 2 分）", s.config.pick.byTypeScore["单选"], 2);',
  '      var box = q("[data-qp=\\"byTypeScore.多选\\"]")[0];',
  '      box.value = "9"; box.dispatchEvent(new Event("change", { bubbles: true }));',
  '      step("手填「多选 9 分」→ 落地", s.config.pick.byTypeScore["多选"], 9);',
  '',
  '      /* ⑤ 真抽一把：用的是页面里真的 pickQuestions（不是另写一套） */',
  '      var bank = [];',
  '      ["单选", "多选", "判断", "简答"].forEach(function (t) {',
  '        for (var i = 1; i <= 10; i++) bank.push({ id: t + "-" + i, type: t, stem: t + i, points: Q.DEFAULT_CONFIG.points[t] });',
  '      });',
  '      var conf2 = Q.mergeConfig(Q.DEFAULT_CONFIG, { pick: { mode: "byWeight", seed: 4,',
  '        byTypeScore: { "单选": 8, "多选": 6, "判断": 4, "简答": 10 } } });',
  '      var picked = Q.pickQuestions(bank, conf2);',
  '      var cnt = {}; picked.questions.forEach(function (x) { cnt[x.type] = (cnt[x.type] || 0) + 1; });',
  '      step("真抽：逐题型目标分 8/6/4/10 → 题数按各自分值折算", cnt, { "单选": 4, "多选": 2, "判断": 4, "简答": 2 });',
  '      step("  逐题型小计正好等于各自目标分", picked.meta.byTypePoints, { "单选": 8, "多选": 6, "判断": 4, "简答": 10 });',
  '      step("  整卷满分 = 8+6+4+10", picked.meta.totalPoints, 28);',
  '      step("  没有缺口（目标分都凑满了）", picked.meta.shortageScore, 0);',
  '',
  '      /* ⑥ 切「完全随机」→ 才出现题量口径那两行 */',
  '      q("[data-qp=\\"mode=random\\"]")[0].click();',
  '      step("切「完全随机」→ 出现题量口径 + 本轮题量/目标总分",',
  '           [q("[data-qp=\\"basis=score\\"]").length > 0, !!(q("[data-qp=\\"count\\"]")[0] || q("[data-qp=\\"score\\"]")[0]),',
  '            q("[data-qp^=\\"byType.\\"]").length], [true, true, 0]);',
  '',
  '      /* 截图前切回「按题型总分」并摆一个像样的分配：让截图能直接看出新功能长什么样 */',
  '      q("[data-qp=\\"mode=byWeight\\"]")[0].click();',
  '      var setv = function (sel, val) { var el = q(sel)[0]; el.value = String(val); el.dispatchEvent(new Event("change", { bubbles: true })); };',
  '      setv("[data-qp=\\"byTypeScore.单选\\"]", 40);',
  '      setv("[data-qp=\\"byTypeScore.多选\\"]", 20);',
  '      setv("[data-qp=\\"byTypeScore.判断\\"]", 20);',
  '      setv("[data-qp=\\"byTypeScore.简答\\"]", 20);',
  '      step("截图前的分配：单选40 / 多选20 / 判断20 / 简答20",',
  '           [s.config.pick.mode, s.config.pick.byTypeScore["单选"], s.config.pick.byTypeScore["简答"]], ["byWeight", 40, 20]);',
  '',
  '      /* 截图前把面板滚到「抽题与题量」那一组 */',
  '      var proot = q(".qp-root")[0];',
  '      if (proot) proot.scrollTop = 0;',
  '      if (window.scrollTo) window.scrollTo(0, 0);',
  '      flush();',
  '    } catch (e) {',
  '      okAll = false; lines.push("FAIL  驱动抛错：" + (e && e.stack || e)); flush();',
  '    }',
  '  }',
  '  if (document.readyState === "complete") setTimeout(run, 900);',
  '  else window.addEventListener("load", function () { setTimeout(run, 900); });',
  '})();'
].join('\n');

const src = fs.readFileSync(path.join(HERE, 'review_quiz.html'), 'utf8');
const at = src.lastIndexOf('</body>');
if (at < 0) throw new Error('没找到 </body>');
const out = src.slice(0, at) + '<script>\n' + DRIVER + '\n<\/script>\n' + src.slice(at);
fs.writeFileSync(path.join(HERE, 'verify', 'pick-alloc.html'), out, 'utf8');
console.log('generated verify/pick-alloc.html（注入点 ' + at + '）');
