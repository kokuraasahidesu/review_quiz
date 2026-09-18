/* 「再抽一次」+「未作答优先」取证 · 第二步：把 dump 里的 <pre id="drvReport"> 抠出来打印。
 * 运行： node verify/prefer-redraw-parse.js     （需先跑 prefer-redraw-gen.js + headless Edge）
 *
 * ⚠ dump 里**也包含注入脚本的源码**（源码里有 "PASS  "/"FAIL  " 这些字面量），
 *   所以必须认**真正渲染出来的那个 <pre>**，不能拿关键字去 grep 整个 dump。
 */
const fs = require('fs');
const path = require('path');
const t = fs.readFileSync(path.join(__dirname, 'prefer-redraw-dump.html'), 'utf8');
const m = t.match(/<pre id="drvReport">([\s\S]*?)<\/pre>/);
if (!m) { console.log('没找到 drvReport（Edge 那一步出过 dump 吗？）'); process.exit(1); }
const txt = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const lines = txt.split('\n');
console.log(txt);
const bad = lines.filter(function (l) { return l.indexOf('FAIL') === 0; });
const steps = lines.filter(function (l) { return l.indexOf('PASS') === 0 || l.indexOf('FAIL') === 0; });
console.log('\n汇总：' + steps.length + ' 条断言，FAIL ' + bad.length + ' 条');
process.exitCode = bad.length ? 1 : 0;
