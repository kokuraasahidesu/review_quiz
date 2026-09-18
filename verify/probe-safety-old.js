/* 安全断言 · 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-safety-old.js
 *
 * 做法同 probe-app-shell-old：把源码**真改坏**，再跑 verify/safety.test.js ——
 * 对应的那几条断言必须变红，否则说明它们在测空气。跑完一律还原（finally）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const HERE = path.join(__dirname, '..');
const TEST = path.join(HERE, 'verify', 'safety.test.js');

const results = [];
/* ⚠ 模板/源码可能是 CRLF：多行片段先按 LF 找，找不到再按 CRLF 找（不然会"改了个寂寞"） */
function applySwap(src, needle, repl) {
  if (src.indexOf(needle) >= 0) return src.replace(needle, repl);
  const n2 = needle.replace(/\n/g, '\r\n'), r2 = repl.replace(/\n/g, '\r\n');
  if (src.indexOf(n2) >= 0) return src.replace(n2, r2);
  throw new Error('没找到待替换片段：' + needle.split('\n')[0].slice(0, 60));
}
function probe(name, file, needle, repl) {
  const target = path.join(HERE, file);
  const bak = target + '.probe-bak';
  let red = false, note = '';
  try {
    const src = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(bak, src, 'utf8');
    fs.writeFileSync(target, applySwap(src, needle, repl), 'utf8');
    let text = '';
    try { text = execFileSync(process.execPath, [TEST], { encoding: 'utf8' }); }
    catch (e) { text = String((e && e.stdout) || '') + String((e && e.stderr) || ''); }
    const m = /PASS (\d+)\s+FAIL (\d+)/.exec(text);
    red = !!(m && parseInt(m[2], 10) > 0);
    note = m ? ('改坏后 PASS=' + m[1] + ' FAIL=' + m[2]) : '（没读到汇总）';
  } catch (e) { red = '抛错:' + (e && e.message); }
  finally {
    try { if (fs.existsSync(bak)) { fs.writeFileSync(target, fs.readFileSync(bak, 'utf8'), 'utf8'); fs.unlinkSync(bak); } } catch (e2) { /* ignore */ }
  }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red + (note ? '   ' + note : ''));
}

/* 基线必须先全绿，否则"变红"没有意义 */
(function () {
  const t = execFileSync(process.execPath, [TEST], { encoding: 'utf8' });
  const m = /PASS (\d+)\s+FAIL (\d+)/.exec(t);
  console.log('  （基线：' + (m ? 'PASS=' + m[1] + ' FAIL=' + m[2] : '没读到汇总') + '）');
})();

/* ---- 1. 解压不再设上限（压缩炸弹又能把内存打爆）---- */
probe('① 解压无上限 → 「压缩炸弹 → E_TOO_LARGE」锚变红', 'core/parse/zip.js',
  '        if (total > cap) {', '        if (false) {');

/* ---- 2. 越界数字实体不再兜住（恶意 docx 又把导入打断）：把"范围判断 + try/catch"两道一起拆掉 ---- */
probe('② 越界实体不兜 → 「恶意 docx 不让导入抛异常」锚变红', 'core/parse/docx.js',
  "    if (!isFinite(v) || v < 0 || v > 0x10FFFF) return '\\uFFFD';\n"
+ "    try { return String.fromCodePoint(v); } catch (e) { return '\\uFFFD'; }",
  '    return String.fromCodePoint(v);');

/* ---- 3. 载荷体积不再设限（几百 MB 的"试卷"一打开就卡死）---- */
probe('③ 载荷体积无上限 → 「超大载荷拒载」锚变红', 'core/data.js',
  '    if (body.length > MAX_PAYLOAD_BYTES) {', '    if (false) {');

/* ---- 4. 题面又拼 innerHTML（标记就不再是文字了）---- */
probe('④ 渲染层又用 innerHTML → 「渲染层不许拼 innerHTML」锚变红', 'ui/attempt-view.js',
  "'use strict';", "'use strict';\n  /* 探针：假装这里拼了一次 innerHTML */ var __probeHtml = 1; root.innerHTML = '';");

const bad = results.filter(function (r) { return r[1] !== true; });
console.log('\n探针汇总：' + results.length + ' 条  全部能让锚变红=' + (bad.length === 0));
if (bad.length) { bad.forEach(function (b) { console.log('  未变红：' + b[0] + ' → ' + b[1]); }); process.exitCode = 1; }
