#!/usr/bin/env node
/* ============================================================
 *  verify/run-all.js —— 全量回归入口（一键跑完 + 打出可核对的台账）
 *
 *  运行： node verify/run-all.js
 *
 *  为什么要有这个文件：以前"全量 N 条 / M 个文件 ALL GREEN"是**手抄**的台账，
 *  抄错过（文件数与实际不符、有的条数对不上号），而规矩要求数字能被独立复现。
 *  这里把回归集合**固定下来**，谁跑都是同一批、同一口径：
 *    1) test.js        —— 解析核心在 Node 里真跑真 docx
 *    2) verify.js      —— 旧版自检（容量/存储路由/分享脱敏/调用重试）
 *    3) verify/*.test.js —— 按文件名排序的 42 个套件
 *  每个文件只认**最后一行** `PASS n  FAIL n` 汇总（各套件都是这个格式），
 *  任何 FAIL、任何非零退出、任何"连汇总行都没有"都算失败并非零退出。
 *
 *  零依赖：只用 Node 自带的 fs / path / child_process。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');

const files = ['test.js', 'verify.js'].concat(
  fs.readdirSync(path.join(__dirname))
    .filter(function (f) { return /\.test\.js$/.test(f); })
    .sort()
    .map(function (f) { return 'verify/' + f; })
);

function pad(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}

// 取**最后一次**出现的 `PASS n` / `FAIL n`：各套件末尾都有一行 "  PASS 110    FAIL 0"
function lastCount(text, word) {
  const m = String(text).match(new RegExp(word + '\\s+(\\d+)', 'g'));
  if (!m) return null;
  return parseInt(m[m.length - 1].replace(/[^0-9]/g, ''), 10);
}

const rows = [];
let total = 0;
let badFiles = 0;

files.forEach(function (rel) {
  const r = spawnSync(process.execPath, [path.join(root, rel)], { cwd: root, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const p = lastCount(out, 'PASS');
  const f = lastCount(out, 'FAIL');

  if (p === null || f === null) {
    badFiles++;
    rows.push({ file: rel, pass: null, fail: null, status: r.status, why: '没有 PASS/FAIL 汇总行' });
    console.log('  ??    ' + pad(rel, 42) + '没有汇总行（脚本自己报错了？）  退出码=' + r.status);
    console.log('  ---- 输出尾部 ----');
    console.log(out.slice(-600));
    return;
  }

  const ok = (f === 0 && r.status === 0);
  if (!ok) badFiles++;
  total += p;
  rows.push({ file: rel, pass: p, fail: f, status: r.status, why: ok ? '' : 'FAIL>0 或退出码非零' });
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + pad(rel, 42) + pad(p, 6) + (ok ? '' : ('  FAIL=' + f + ' 退出码=' + r.status)));
});

console.log('');
console.log('================ 台账（可原样抄进文档） ================');
console.log(rows.map(function (x) { return x.pass === null ? '?' : x.pass; }).join(' + ') +
            ' = ' + total + ' 条断言 / ' + rows.length + ' 个文件');

const broken = rows.filter(function (x) { return x.fail === null || x.fail > 0 || x.status !== 0; });
if (broken.length) {
  console.log('');
  console.log('不合格的文件：');
  broken.forEach(function (x) {
    console.log('  ' + x.file + '  ' + (x.why || ''));
  });
  console.log('全量回归：' + total + ' 条 / ' + rows.length + ' 个文件，' + broken.length + ' 个文件不合格');
  process.exit(1);
}
console.log('全量回归：' + total + ' 条 / ' + rows.length + ' 个文件 ALL GREEN');
