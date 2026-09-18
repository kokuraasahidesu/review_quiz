/* 成绩结算 · 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-result-old.js
 *
 * 目的：证明 verify/result.test.js 里的锚**真的能抓到错行为**（不是空转）。
 * 每行必须打印 "锚变红=true"；出现 false 说明那条断言在测空气。
 * ⚠ 靠字符串替换定位代码：core/attempt.js / core/flow.js 那几行被重构时会直接报「探针失效」。
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
const results = [];
function probe(name, fn) {
  let red = false;
  try { red = fn(); } catch (e) { red = '抛错:' + (e && e.message); }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red);
}

const Q = require('../core/quiz.js');
const F = require('../core/flow.js');
const A0 = require('../core/attempt.js');
const S0 = require('../core/schema.js');
const QS = [
  S0.createQuestion({ id: 'r1', type: '单选', stem: 's1', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['A'] }),
  S0.createQuestion({ id: 'r2', type: '判断', stem: 's2', judgeValue: true }),
  S0.createQuestion({ id: 'r3', type: '简答', stem: 's3', keywords: [{ text: '甲' }, { text: '乙' }] })
];
const ANSW = { r1: 'A', r2: '√', r3: '甲' };
function build(A, patch) {
  const s = A.createSession({ title: 'p', questions: QS, config: Q.mergeConfig(Q.DEFAULT_CONFIG, patch || {}) });
  ['r1', 'r2', 'r3'].forEach(function (id, i) { A.goto(s, i); A.answer(s, ANSW[id]); A.submitCurrent(s); });
  A.finish(s);
  return s;
}

/* ---- 1. 得分累计错（只算第一题） ---- */
probe('① 总分只累计第一题 → ①-A 必须变红', function () {
  const A = loadFrom('core/attempt.js',
    s => s.replace('const scored = QuizCore.scoreExam(session.questions, session.answers, session.config, { manual: session.manual });',
                   'const scored = QuizCore.scoreExam(session.questions.slice(0, 1), session.answers, session.config, { manual: session.manual });'),
    'core/__probe_attempt_r1.js');
  const r = (function () { try { return A.resultModel(build(A)); } finally { rm('core/__probe_attempt_r1.js'); } })();
  return !(r && r.score === 2 && r.full === 2 + 1 + 2.5);     // 手算：2 + 1 + 2.5
});

/* ---- 2. 正确题数用错口径（把"半对"也算对） ---- */
probe('② 正确题数改看"得分>0" → ①-A 必须变红', function () {
  const A = loadFrom('core/attempt.js',
    s => s.replace('correctCount: s.correctCount, total: s.total,', 'correctCount: (s.per || []).filter(function (p) { return p.score > 0; }).length, total: s.total,'),
    'core/__probe_attempt_r2.js');
  // 简答只中一半（得分>0 但不是全对）→ 会把正确题数从 2 抬到 3
  const s = A.createSession({ title: 'p', questions: QS, config: Q.mergeConfig(Q.DEFAULT_CONFIG, {}) });
  ['r1', 'r2', 'r3'].forEach(function (id, i) { A.goto(s, i); A.answer(s, id === 'r3' ? '甲' : ANSW[id]); A.submitCurrent(s); });
  A.finish(s);
  const r = (function () { try { return A.resultModel(s); } finally { rm('core/__probe_attempt_r2.js'); } })();
  return !(r && r.correctCount === 2);                        // 只有单选与判断算全对
});

/* ---- 3. 定档边界：等于分数线时漏档（真相源在 quiz.js 的 levelOf，flow 只是委托它） ---- */
probe('③ 定档改 > 而不是 ≥ → ②-A 必须变红', function () {
  loadFrom('core/quiz.js',
    s => s.replace("    if (p >= g.excellent) return '优秀';", "    if (p > g.excellent) return '优秀';")
          .replace("    if (p >= g.pass) return '及格';", "    if (p > g.pass) return '及格';"),
    'core/__probe_quiz_r.js');
  const F = loadFrom('core/flow.js',
    s => s.replace("const QuizCore = isNode ? require('./quiz.js') : root.QuizCore;",
                   "const QuizCore = isNode ? require('./__probe_quiz_r.js') : root.QuizCore;"),
    'core/__probe_flow_r.js');
  try {
    const c = Q.mergeConfig(Q.DEFAULT_CONFIG, { grade: { pass: 60, excellent: 85 } });
    return F.gradeLevel(60, c).level !== '及格' || F.gradeLevel(85, c).level !== '优秀';
  } finally { rm('core/__probe_quiz_r.js'); rm('core/__probe_flow_r.js'); }
});

/* ---- 4. 回看：未交卷也能回看（答题期间泄露） ---- */
probe('④ 回看不看"是否已交卷" → ③-C 必须变红', function () {
  const A = loadFrom('core/attempt.js',
    s => s.replace('    if (!session.finished) return [];\n    return session.questions.map(function (q, i) {', '    return session.questions.map(function (q, i) {'),
    'core/__probe_attempt_r3.js');
  const s = A.createSession({ title: 'p', questions: QS, config: Q.mergeConfig(Q.DEFAULT_CONFIG, {}) });
  const list = (function () { try { return A.reviewList(s); } finally { rm('core/__probe_attempt_r3.js'); } })();
  return list.length > 0;                                     // 未交卷却拿到了回看列表 → 锚红
});

/* ---- 5. 回看：未作答的题也算成"答对了" ---- */
probe('⑤ 回看里未答题当答对 → ③-B 必须变红', function () {
  const A = loadFrom('core/attempt.js',
    s => s.replace('      const r = session.results[q.id] || QuizCore.scoreOne(q, a, session.config,\n        man ? { manualHits: man.hits, manualScore: man.score } : null);',
                   '      const r = session.results[q.id] || { correct: true, score: 0, full: 0, detail: {} };'),
    'core/__probe_attempt_r4.js');
  const s = A.createSession({ title: 'p', questions: QS, config: Q.mergeConfig(Q.DEFAULT_CONFIG, {}) });
  A.finish(s, { confirmUnanswered: true });
  const list = (function () { try { return A.reviewList(s); } finally { rm('core/__probe_attempt_r4.js'); } })();
  return list[0].correct === true && list[0].answered === false;   // 没答却标"对" → 锚红
});

/* ---- 6. 回看：多选/简答的"正确答案"文本形态 ----
 * ⚠ `answerText` 的唯一实现已从 `core/attempt.js` 搬到 `core/quiz.js`
 *   （回看与错题本详情共用同一份，免得两处各写一份分隔符）。
 *   探针改造对象必须跟着搬 —— 否则字符串替换落空，探针自己就失效了。 */
probe('⑥ answerText 多选不分隔 → ③-A 必须变红', function () {
  const Qq = loadFrom('core/quiz.js',
    s => s.replace("if (q.type === '多选') return (q.answerLetters || []).slice().sort().join('、');",
                   "if (q.type === '多选') return (q.answerLetters || []).slice().sort().join('');"),
    'core/__probe_quiz_r5.js');
  const q = S0.createQuestion({ id: 'm', type: '多选', stem: 's', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['A', 'B'] });
  const txt = (function () { try { return Qq.answerText(q); } finally { rm('core/__probe_quiz_r5.js'); } })();
  return txt !== 'A、B';                                      // 与"用户作答"的显示口径不一致 → 锚红
});

/* ---- 7. P4（组级红队）：等级从"未四舍五入的 pct"派生 → 显示 85% 却写"及格" ---- */
probe('⑦ 等级不跟显示的百分数同源 → 组锚必须变红', function () {
  const Qq = loadFrom('core/quiz.js',
    s => s.replace('      level: levelOf(percent, cfg)', '      level: levelOf(fin(pct, 0), cfg)'),
    'core/__probe_quiz_p4.js');
  try {
    const qs = [], ans = {};
    for (let i = 0; i < 2100; i++) { qs.push({ id: 'q' + i, type: '单选', answerLetters: ['A'] }); if (i < 1784) ans['q' + i] = 'A'; }
    const c = Q.mergeConfig(Q.DEFAULT_CONFIG, { points: { '单选': 0.5 } });
    const r = Qq.scoreExam(qs, ans, c);
    return !(r.percent === 85 && r.level === F.gradeLevel(r.percent, c).level);   // 显示 85 但等级说及格 → 锚红
  } finally { rm('core/__probe_quiz_p4.js'); }
});

const bad = results.filter(r => r[1] !== true);console.log('\n探针汇总：' + results.length + ' 条  全部能让锚变红=' + (bad.length === 0));
if (bad.length) { bad.forEach(b => console.log('  未变红：' + b[0] + ' → ' + b[1])); process.exitCode = 1; }
