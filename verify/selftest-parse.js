/* ============================================================
 *  verify/selftest-parse.js —— 读「浏览器自检.html」的 dump，只挑出**失败项**与汇总行
 *
 *  运行： node verify/selftest-parse.js [dump 路径]      （默认 verify/selftest-dump.html）
 *
 *  为什么要它：自检页的失败项散在 DOM 里，肉眼看 dump 等于大海捞针；而且这一页的
 *  FAIL 数**会在两次启动之间抖动**（个别小节依赖异步时序/刷新），所以只能"当场读同一个 dump"，
 *  不能拿上一次手抄的数字当基线。
 *
 *  生成 dump 的办法（PowerShell，注意 headless 的 --screenshot 与 --dump-dom 必须分两次跑）：
 *    msedge --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files `
 *           --user-data-dir=<tmp> --window-size=1280,900 --virtual-time-budget=30000 `
 *           --dump-dom file:///D:/apps/tools/quiz-demo/浏览器自检.html > verify\selftest-dump.html
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const p = process.argv[2] || path.join(__dirname, 'selftest-dump.html');
const t = fs.readFileSync(p, 'utf8');

const summary = t.match(/PASS\s*(\d+)\s*FAIL\s*(\d+)\s*WARN\s*(\d+)/);
const re = /<span class="mark ([PWF])">([^<]*)<\/span>\s*<span>([\s\S]{0,300}?)<\/span>/g;
const strip = function (s) { return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); };

let x, fails = [], warns = [];
while ((x = re.exec(t))) {
  const text = strip(x[3]);
  if (x[1] === 'F' && !/^PASS\s/.test(text)) fails.push(text);
  if (x[1] === 'W') warns.push(text);
}
console.log('汇总行: ' + (summary ? summary[0] : '（没找到 PASS/FAIL/WARN 汇总 —— 页面可能没跑起来）'));
console.log('失败项 ' + fails.length + ' 条：');
fails.forEach(function (s, i) { console.log('  ' + (i + 1) + '. ' + s.slice(0, 110)); });
console.log('提示项 ' + warns.length + ' 条：');
warns.forEach(function (s, i) { console.log('  ' + (i + 1) + '. ' + s.slice(0, 110)); });
process.exit(fails.length ? 1 : 0);
