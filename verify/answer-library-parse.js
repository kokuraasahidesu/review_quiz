/* 「导入 → 入库 → 答题」取证 · 第二步：把 dump 里的 <pre id="drvReport"> 抠出来打印。
 * 运行： node verify/answer-library-parse.js   （需要先跑 answer-library-gen.js + headless Edge）
 * ⚠ dump 里也包含注入脚本源码与题集正文，必须认**真正渲染出来的那个 <pre>**。 */
const fs = require('fs');
const path = require('path');
const t = fs.readFileSync(path.join(__dirname, 'answer-library-dump.html'), 'utf8');
const m = t.match(/<pre id="drvReport">([\s\S]*?)<\/pre>/);
if (!m) { console.log('没找到 drvReport（Edge 那一步出过 dump 吗？）'); process.exit(1); }
const txt = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const lines = txt.split('\n');
console.log(txt);
const bad = lines.filter(function (l) { return l.indexOf('FAIL') === 0; });
console.log('\n汇总：' + lines.filter(function (l) { return /^(PASS|FAIL)/.test(l); }).length + ' 条判定，FAIL ' + bad.length + ' 条');
process.exitCode = bad.length ? 1 : 0;
