/* 「自动翻页小加载条」的**人眼截图**生成器（结论件：docs/ui-jumpbar.png）。
 * 运行： node verify/jumpbar-shot-gen.js
 *       然后（PowerShell）：
 *         msedge --headless=new --disable-gpu --hide-scrollbars --user-data-dir=<tmp> --window-size=520,760 `
 *                --virtual-time-budget=2600 --screenshot=docs\ui-jumpbar.png --dump-dom `
 *                file:///D:/apps/tools/quiz-demo/verify/jumpbar-shot.html > verify\jumpbar-shot-dump.html
 *
 * 为什么单独来一张：加载条只活在**等待窗口**里（默认 1.5 秒，最长 5 秒），
 * 而 `autonext-delay` 那条流水线跑完（虚拟时钟把等待等完了）才截图，条早消失了。
 * 这里把等待设成 **5 秒**、虚拟时钟预算压到 2.6 秒 —— 截图正好落在"正在翻页…"那一刻。
 * ⚠ 截图是给**人眼**看的证据；条的存在与动画时长由 autonext-delay 的 DOM 断言（33 条）硬证。
 * 判据不放这里，所以这份 HTML 不进仓库（见 .gitignore）。
 */
const fs = require('fs');
const path = require('path');
const HERE = path.join(__dirname, '..');

const DRIVER = [
  '(function () {',
  '  function run() {',
  '    try {',
  '      var Q = window.QuizCore, A = window.AttemptCore, V = window.AttemptView, SC = window.SchemaCore;',
  '      var mk = function (id, n) {',
  '        return SC.createQuestion({ id: id, type: "单选", stem: "第 " + n + " 题：下面哪个说法是对的？",',
  '          options: [{ label: "A", text: "选项甲" }, { label: "B", text: "选项乙" },',
  '                    { label: "C", text: "选项丙" }, { label: "D", text: "选项丁" }],',
  '          answerLetters: ["B"], answer: "B" });',
  '      };',
  '      var host = document.createElement("div"); host.id = "shotHost";',
  '      host.style.cssText = "padding:8px;background:#fff";',
  '      document.body.insertBefore(host, document.body.firstChild);',
  /* 把页面上原有的面板挪走：截图里只留"正在翻页"这一件事 */
  '      Array.prototype.slice.call(document.querySelectorAll(".qp-root")).forEach(function (n) {',
  '        if (n.parentNode && !host.contains(n)) n.parentNode.removeChild(n); });',
  '      var cfg = Q.mergeConfig(Q.DEFAULT_CONFIG, {',
  '        behavior: { autoCheck: true, autoNext: true, autoNextMs: 5000, autoNextWrong: false },',
  '        reveal: { answerTiming: "each", explainTiming: "each" } });',
  '      var s = A.createSession({ examId: "SHOT", title: "加载条截图",',
  '        questions: [mk("j1", 1), mk("j2", 2), mk("j3", 3)], config: cfg, startedAt: "T" });',
  '      V.mount({ container: host, session: s, onChange: function () {} });',
  '      host.querySelectorAll(".av-opt")[1].click();        // 选 B（答对）→ 排上"等 5 秒再翻"',
  '    } catch (e) { document.title = "shot 抛错：" + (e && e.message); }',
  '  }',
  '  if (document.readyState === "complete") setTimeout(run, 300);',
  '  else window.addEventListener("load", function () { setTimeout(run, 300); });',
  '})();'
].join('\n');

const src = fs.readFileSync(path.join(HERE, 'review_quiz.html'), 'utf8');
const at = src.lastIndexOf('</body>');
if (at < 0) throw new Error('没找到 </body>');
const out = src.slice(0, at) + '<script>\n' + DRIVER + '\n<\/script>\n' + src.slice(at);
fs.writeFileSync(path.join(HERE, 'verify', 'jumpbar-shot.html'), out, 'utf8');
try { new Function(DRIVER); } catch (e) { throw new Error('驱动脚本语法错误：' + e.message); }
console.log('generated verify/jumpbar-shot.html（注入点 ' + at + '，语法闸通过）');
