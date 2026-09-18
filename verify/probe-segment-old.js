/* 「题型识别与切题」· 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-segment-old.js
 *
 * 盯的是"真实题集的分节写法"那一批新行为：把 core/parse/segment.js 的对应实现逐个改回旧写法，
 * verify/segment.test.js ⑥ 节的锚必须变红。判据用的是同一份 fixture 与同一套切题入口。
 *
 * ⚠ 靠字符串替换定位代码：那几行被重构时探针会直接报「探针失效」并退出 1 —— 提醒重新确认断言。
 */
const fs = require('fs');
const path = require('path');
const HERE = path.join(__dirname, '..');
const SRC = path.join(HERE, 'core', 'parse', 'segment.js');
const TMP = path.join(HERE, 'core', 'parse', '__probe_segment.js');

/* 与 parser-core.parasFromText 同口径（探针要直接驱动被改坏的 SegmentCore） */
function parasFrom(text) {
  return String(text).replace(/\r\n?/g, '\n').split('\n')
    .map(function (l) { return { runs: [{ text: l }], text: l.trim(), inTextBox: false }; });
}

function load(mutate) {
  const src = fs.readFileSync(SRC, 'utf8');
  const out = mutate(src);
  if (out === src) throw new Error('探针失效：没替换到目标文本（core/parse/segment.js）');
  fs.writeFileSync(TMP, out);
  delete require.cache[require.resolve(TMP)];
  return require(TMP);
}
function rm() { try { fs.unlinkSync(TMP); } catch (e) { /* ignore */ } }

const BANK = fs.readFileSync(path.join(HERE, 'fixtures', 'txt', 'sectioned_bank.txt'), 'utf8');
function parseWith(Seg, text) { return Seg.segment(parasFrom(text)); }
function counts(qs) { const o = {}; qs.forEach(function (q) { o[q.type] = (o[q.type] || 0) + 1; }); return o; }

const results = [];
function probe(name, fn) {
  let red = false, note = '';
  try { const r = fn(); red = (r === true); if (typeof r === 'string') note = r; else if (r !== true) note = JSON.stringify(r); }
  catch (e) { red = '抛错:' + (e && e.message); }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red + (note ? '   ' + note : ''));
}

/* 基线：没改坏时这份 fixture 应该切出 3+3+3+1 */
(function () {
  const Seg = require('../core/parse/segment.js');
  const qs = parseWith(Seg, BANK);
  console.log('  （基线：' + qs.length + ' 题 ' + JSON.stringify(counts(qs)) + '）');
})();

/* ---- 1. 段头不认识（`一、单选题` 不算标记）→ 整份文件切出 0 题 ---- */
probe('① 段头不认 → ⑥-B「四节全切开」锚变红', function () {
  const Seg = load(s => s.replace(
    "      reHeader: new RegExp('^\\\\s*' + HEAD_PREFIX + '(?:' + g.headerWords.join('|') + ')\\\\s*[：:]?\\\\s*$')",
    '      reHeader: /$^/'));
  const qs = parseWith(Seg, BANK);
  rm();
  return qs.length !== 10;                 // 旧行为：0 题（用户实测报障的就是这个）
});

/* ---- 2. 一行多选项不拆（整行当一个选项）→ ⑥-C「4 个选项」锚变红 ---- */
probe('② 一行多选项不拆 → ⑥-C「拆成 4 个选项」锚变红', function () {
  const Seg = load(s => s.replace('    if (!marks.length) return [];', '    if (!marks.length || true) return [];'));
  const qs = parseWith(Seg, BANK);
  rm();
  return qs[0].options.length === 1;       // 坏行为：1 个选项（选项文字里还带着 B./C./D.）
});

/* ---- 3. 判断题尾答案不取 → ⑥-D「judgeValue=false/true」锚变红 ---- */
probe('③ 判断题尾答案不取 → ⑥-D 的 judgeValue 锚变红', function () {
  const Seg = load(s => s.replace('    const m = stem.match(RE_JUDGE_TAIL);', '    const m = null;'));
  const qs = parseWith(Seg, BANK);
  rm();
  const js = qs.filter(function (q) { return q.type === '判断'; });
  return js.length === 3 && js.every(function (q) { return q.judgeValue == null; });   // 坏行为：三道判断全空
});

/* ---- 4. 节内断题不做（题号/空行/前瞻三条全关）→ ⑥-B 题数锚变红 ---- */
probe('④ 节内断题不做 → ⑥-B「10 题」锚变红', function () {
  const Seg = load(s => s.replace('        if (!isMeta && (numbered || blankSplit || optionAhead)) {', '        if (false) {'));
  const qs = parseWith(Seg, BANK);
  rm();
  return qs.length !== 10;                 // 坏行为：整节并成 1 题
});

/* ---- 5. 空行不当分块信号（照旧直接丢掉）→ ⑥-D「判断节靠空行分题」锚变红 ---- */
probe('⑤ 空行不当分块信号 → ⑥-D「判断节靠空行分题」锚变红', function () {
  const Seg = load(s => s.replace('      if (!text) { blockBreak = true; return; }', '      if (!text) { return; }'));
  const qs = parseWith(Seg, '三、判断题\n\n甲题。（×）\n解析：略\n\n乙题。（√）\n解析：略\n');
  rm();
  // 坏行为：两道判断题并成一道（第二题"消失"，答案也被盖掉）
  return !(qs.length === 2 && qs[1] && qs[1].stem.indexOf('乙题') >= 0);
});

/* ---- 6. 第二行答案静默覆盖第一行（用户看不见的数据丢失）→ ⑥-H 锚变红 ---- */
probe('⑥ 第二行答案静默覆盖 → ⑥-H「保留第一行 + 挂疑点」锚变红', function () {
  const Seg = load(s => s.replace('        if (cur.answer) {', '        if (false) {'));
  const qs = parseWith(Seg, '一、单选题\n甲题（）\nA.甲 B.乙\n答案：A\n解析：略\n乙题（没有选项的怪题）\n答案：B\n');
  rm();
  return qs[0].answer !== 'A';            // 坏行为：答案被改成 B，且一点提示都没有
});

const bad = results.filter(function (r) { return r[1] !== true; });
console.log('\n探针汇总：' + results.length + ' 条  全部能让锚变红=' + (bad.length === 0));
if (bad.length) { bad.forEach(function (b) { console.log('  未变红：' + b[0] + ' → ' + b[1]); }); process.exitCode = 1; }
