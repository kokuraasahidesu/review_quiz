/* 「界面小字清单」取证 · 第二步：从 dump 里抠出清单，按面板分组打印 + 汇总条数。
 * 运行： node verify/smalltext-parse.js [dump 路径]   （默认 verify/smalltext-dump.html）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const p = process.argv[2] || path.join(__dirname, 'smalltext-dump.html');
const dump = fs.readFileSync(p, 'utf8');
const m = dump.match(/<pre id="drvReport">([\s\S]*?)<\/pre>/);
if (!m) {
  console.log('没找到驱动报告（<pre id="drvReport">）—— 页面可能没跑起来：' + p);
  process.exit(1);
}
const text = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
const rows = text.split('\n').filter(function (s) { return /^SMALL/.test(s); });
const groups = {};
rows.forEach(function (r) {
  const g = (r.match(/<([^>]+)>/) || [null, '?'])[1];
  (groups[g] = groups[g] || []).push(r.replace(/^SMALL\s+/, ''));
});
Object.keys(groups).forEach(function (g) {
  console.log('\n===== ' + g + '（' + groups[g].length + ' 条）');
  groups[g].forEach(function (r) { console.log('  ' + r); });
});
const fails = text.split('\n').filter(function (s) { return /^FAIL/.test(s); }).length;
/* 顺手统计"解释性长句"（≥20 字的小字）——用户抱怨的通常就是这一类，不是数字类徽章 */
const longRows = rows.filter(function (r) {
  const mm = r.match(/"([^"]*)"\s*$/);
  return mm && mm[1].length >= 20;
});
console.log('\n小字合计：' + rows.length + ' 条（FAIL ' + fails + ' 条）；'
  + '其中解释性长句（≥20 字）：' + longRows.length + ' 条');
process.exit(fails ? 1 : 0);
