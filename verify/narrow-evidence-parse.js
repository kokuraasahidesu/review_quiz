/* 窄屏取证 · 第三步：把 headless Edge 的 dump 汇总成 verify/narrow-numbers.json
 * 运行： node verify/narrow-evidence-parse.js   （需要先跑 narrow-evidence-gen.js + Edge 出 dump） */
const fs = require('fs');
const path = require('path');
const out = {};
['answer', 'review', 'wrong', 'demo'].forEach(function (k) {
  const p = path.join(__dirname, 'narrow-dump-' + k + '.html');
  if (!fs.existsSync(p)) { console.log(k + '：没有 dump（跳过）'); return; }
  const t = fs.readFileSync(p, 'utf8');
  /* ⚠ 认真正渲染出来的 <pre>，别拿 @@NARROW@@ 直接匹配 —— 注入脚本的**源码**里也有这个字面量 */
  const m = t.match(/<pre id="narrowReport">([\s\S]*?)<\/pre>/);
  if (!m) { console.log(k + '：没找到报告'); return; }
  const rep = JSON.parse(m[1].replace(/^@@NARROW@@/, '').replace(/@@END@@$/, '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  out[k] = rep;
  console.log('\n===== ' + k + '（' + rep.title + '）=====');
  console.log('  内容宽 ' + rep.width + 'px（浏览器视口 ' + rep.viewport + 'px）');
  console.log('  右溢 ' + rep.clipped.length + ' 处' + (rep.clipped.length ? '：' + rep.clipped.join(' / ') : ''));
  console.log('  触点<44px ' + rep.small.length + ' 处' + (rep.small.length ? '：' + rep.small.join(' / ') : ''));
  console.log('  块级重叠 ' + rep.overlap.length + ' 处' + (rep.overlap.length ? '：' + rep.overlap.join(' / ') : ''));
  console.log('  正文<13px ' + rep.tinyFont.length + ' 处' + (rep.tinyFont.length ? '：' + rep.tinyFont.join(' / ') : ''));
  console.log('  fixed 元素 ' + rep.fixed.length + ' 处' + (rep.fixed.length ? '：' + rep.fixed.join(' / ') : ''));
});
fs.writeFileSync(path.join(__dirname, 'narrow-numbers.json'), JSON.stringify(out, null, 1));
console.log('\n已写出 verify/narrow-numbers.json');
