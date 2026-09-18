/* 「手机端顶栏瘦身 + 工具折叠」取证 · 第二步：抠出驱动报告，打印判定 + 非零退出码。
 * 运行： node verify/mobile-ui-parse.js [dump 路径]   （默认 verify/mobile-ui-dump.html）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const p = process.argv[2] || path.join(__dirname, 'mobile-ui-dump.html');
const dump = fs.readFileSync(p, 'utf8');
const m = dump.match(/<pre id="drvReport"[^>]*>([\s\S]*?)<\/pre>/);
if (!m) {
  console.log('没找到驱动报告（<pre id="drvReport">）—— 页面可能没跑起来：' + p);
  process.exit(1);
}
const text = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
const lines = text.split('\n').filter(function (s) { return s.trim(); });
lines.forEach(function (l) {
  if (/^FAIL/.test(l)) console.log('\x1b[31m' + l + '\x1b[0m');
  else if (/^PASS/.test(l)) console.log('\x1b[32m' + l + '\x1b[0m');
  else console.log(l);
});
const fails = lines.filter(function (l) { return /^FAIL/.test(l); }).length;
const passes = lines.filter(function (l) { return /^PASS/.test(l); }).length;
console.log('\n汇总：' + (passes + fails) + ' 条判定，FAIL ' + fails + ' 条');
process.exit(fails ? 1 : 0);
