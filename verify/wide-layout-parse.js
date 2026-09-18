/* 「电脑端一屏装下」取证 · 第二步：从 headless Edge 的 dump 里读出报告。
 * 运行： node verify/wide-layout-parse.js   （先跑 wide-layout-gen.js + Edge 出 dump） */
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, 'wide-layout-dump.html');
if (!fs.existsSync(p)) { console.error('没有 dump：先跑 node verify/wide-layout-gen.js，再用 headless Edge 打开 verify/wide-layout.html 存成 verify/wide-layout-dump.html'); process.exit(1); }
const t = fs.readFileSync(p, 'utf8');
const m = t.match(/<pre id="drvReport">([\s\S]*?)<\/pre>/);
if (!m) { console.error('没找到 drvReport（Edge 那一步出过 dump 吗？）'); process.exit(1); }
const text = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
const lines = text.split('\n');
lines.forEach(function (l) { console.log(l); });
const bad = lines.filter(function (l) { return /^FAIL/.test(l); });
console.log('\n汇总：' + lines.filter(function (l) { return /^(PASS|FAIL)/.test(l); }).length + ' 条判定，FAIL ' + bad.length + ' 条');
process.exitCode = bad.length ? 1 : 0;
