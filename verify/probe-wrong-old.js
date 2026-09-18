/* 误答自动收集与计数 · 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-wrong-old.js
 * 每行必须打印 "锚变红=true"；出现 false 说明那条断言在测空气。
 */
const fs = require('fs');
const path = require('path');
const HERE = path.join(__dirname, '..');
function loadFrom(rel, mutate, tmpRel) {
  const src = fs.readFileSync(path.join(HERE, rel), 'utf8');
  const out = mutate(src);
  if (out === src) throw new Error('探针失效：没替换到目标文本（' + rel + '）');
  const tmp = path.join(HERE, tmpRel);
  fs.writeFileSync(tmp, out);
  delete require.cache[require.resolve(tmp)];
  return require(tmp);
}
function rm(rel) { try { fs.unlinkSync(path.join(HERE, rel)); } catch (e) { /* ignore */ } }

const Q = require('../core/quiz.js');
const D = require('../core/data.js');
const FIX = [
  { id: 'w1', type: '单选', stem: '对', answerLetters: ['A'] },
  { id: 'w2', type: '多选', stem: '半对', answerLetters: ['A', 'B'] },
  { id: 'w3', type: '简答', stem: '未全命中', keywords: [{ text: '甲' }, { text: '乙' }] }
];
const ANS = { w1: 'A', w2: 'A', w3: '甲' };                 // w1 对；w2/w3 误答
const per = Q.scoreExam(FIX, ANS, Q.mergeConfig(Q.DEFAULT_CONFIG, {})).per;

const results = [];
function probe(name, fn) {
  let red = false;
  try { red = fn(); } catch (e) { red = '抛错:' + (e && e.message); }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red);
}

/* ---- 1. 不看 correct：全对也进本 ---- */
probe('① 不判"是否满分"（全都当误答）→ ①-A/①-B 必须变红', function () {
  const W = loadFrom('core/wrong.js', s => s.replace('const wrong = !(per && per.correct === true);', 'const wrong = true;'),
                     'core/__probe_wrong1.js');
  try {
    const book = W.createBook('E', '');
    W.collect(book, per, { now: 't', sessionAt: 'S', questionsById: {}, answers: {} });
    return Object.keys(book.entries).length !== 2;          // 应恰好 2 条（w2/w3）
  } finally { rm('core/__probe_wrong1.js'); }
});

/* ---- 2. 答对时删记录（历史被静默删除） ---- */
probe('② 答对时删掉记录 → ③-A 必须变红', function () {
  const W = loadFrom('core/wrong.js',
    s => s.replace("    cur.streak = 0;\n    cur.rightTimes = (cur.rightTimes || 0) + 1;", "    delete book.entries[qid];\n    cur.rightTimes = (cur.rightTimes || 0) + 1;"),
    'core/__probe_wrong2.js');
  try {
    const book = W.createBook('E', '');
    W.collect(book, per, { now: 't1', sessionAt: 'S1', questionsById: {}, answers: {} });
    const right = Q.scoreExam(FIX, { w1: 'A', w2: 'AB', w3: '甲 乙' }, Q.mergeConfig(Q.DEFAULT_CONFIG, {})).per;
    W.collect(book, right, { now: 't2', sessionAt: 'S2', questionsById: {}, answers: {} });
    return !(book.entries.w2 && book.entries.w2.times === 1 && book.entries.w2.streak === 0);
  } finally { rm('core/__probe_wrong2.js'); }
});

/* ---- 3. 重复误答不累加（次数永远 1） ---- */
probe('③ 重复误答不累加 → ②-A 必须变红', function () {
  const W = loadFrom('core/wrong.js', s => s.replace('      cur.times = (cur.times || 0) + 1;', '      cur.times = 1;'),
                     'core/__probe_wrong3.js');
  try {
    const book = W.createBook('E', '');
    W.collect(book, per, { now: 't1', sessionAt: 'S1', questionsById: {}, answers: {} });
    W.collect(book, per, { now: 't2', sessionAt: 'S2', questionsById: {}, answers: {} });
    return book.entries.w2.times !== 2;                     // 连续两轮均答错 → 必须是 2
  } finally { rm('core/__probe_wrong3.js'); }
});

/* ---- 4. 不做幂等检查（同一轮重复收集会翻倍） ---- */
probe('④ 不做幂等检查 → ②-C 必须变红', function () {
  const W = loadFrom('core/wrong.js',
    s => s.replace("    if (sessionAt && book.lastSessionAt === sessionAt) {", "    if (false) {"),
    'core/__probe_wrong4.js');
  try {
    const book = W.createBook('E', '');
    W.collect(book, per, { now: 't1', sessionAt: 'SAME', questionsById: {}, answers: {} });
    W.collect(book, per, { now: 't2', sessionAt: 'SAME', questionsById: {}, answers: {} });
    return book.entries.w2.times !== 1;                     // 同一轮重复收集却翻倍 → 锚红
  } finally { rm('core/__probe_wrong4.js'); }
});

/* ---- 5. 键改成手拼（绕过既有前缀规则） ---- */
probe('⑤ 键改成手拼 → 整体验收的键锚必须变红', function () {
  const W = loadFrom('core/wrong.js',
    s => s.replace("  function wrongKey(examId) { return DataCore.wrongKey(examId); }", "  function wrongKey(examId) { return 'wrong_' + examId; }"),
    'core/__probe_wrong5.js');
  try {
    return W.wrongKey('EX10') !== 'wrong::EX10' || D.prefixedKey('app', W.wrongKey('EX10')) !== 'app::wrong::EX10';
  } finally { rm('core/__probe_wrong5.js'); }
});

/* ---- 6. 显式删除不留痕 ---- */
probe('⑥ 删除不留痕 → ③-C 必须变红', function () {
  const W = loadFrom('core/wrong.js',
    s => s.replace("    book.removed = (book.removed || []).concat([{ qid: id, at: o.now || '', reason: String(o.reason || '用户移除') }]);", '    '),
    'core/__probe_wrong6.js');
  try {
    const book = W.createBook('E', '');
    W.collect(book, per, { now: 't', sessionAt: 'S', questionsById: {}, answers: {} });
    W.remove(book, 'w2', { now: 't2', reason: '本来是对的' });
    return !(book.removed && book.removed.length === 1);
  } finally { rm('core/__probe_wrong6.js'); }
});

const bad = results.filter(r => r[1] !== true);
console.log('\n探针汇总：' + results.length + ' 条  全部能让锚变红=' + (bad.length === 0));
if (bad.length) { bad.forEach(b => console.log('  未变红：' + b[0] + ' → ' + b[1])); process.exitCode = 1; }
