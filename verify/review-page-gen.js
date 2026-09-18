/* 「导入 / 校对」页面外观 · 第一步：复制 review_quiz.html，注入一行"切到导入页"的脚本。
 * 运行： node verify/review-page-gen.js
 *       然后（PowerShell）：
 *         msedge --headless=new --disable-gpu --hide-scrollbars --user-data-dir=<tmp> --window-size=1280,860 `
 *                --virtual-time-budget=9000 --screenshot=docs/ui-import-page.png `
 *                file:///D:/apps/tools/quiz-demo/verify/review-page.html
 *
 * 为什么单独要一张"没有实测条"的干净图：README 上要给人看的是**界面长什么样**（拖入区在这儿、
 * 文件按钮在这儿）。带 HUD 的取证图（docs/ui-import-drop.png，出自 import-bank 流水线）留给"判定数"，
 * 两张图各司其职，不互相冒充。
 */
const fs = require('fs');
const path = require('path');
const HERE = path.join(__dirname, '..');

const CLICK = [
  '<script>',
  '(function () {',
  '  function go() { var t = document.getElementById("tab-review"); if (t) t.click(); window.scrollTo(0, 0); }',
  '  if (document.readyState === "complete") setTimeout(go, 800);',
  '  else window.addEventListener("load", function () { setTimeout(go, 800); });',
  '})();',
  '<\/script>'
].join('\n');

const src = fs.readFileSync(path.join(HERE, 'review_quiz.html'), 'utf8');
const at = src.lastIndexOf('</body>');
if (at < 0) throw new Error('没找到 </body>');
fs.writeFileSync(path.join(HERE, 'verify', 'review-page.html'), src.slice(0, at) + CLICK + '\n' + src.slice(at), 'utf8');
console.log('generated verify/review-page.html（注入点 ' + at + '）');
