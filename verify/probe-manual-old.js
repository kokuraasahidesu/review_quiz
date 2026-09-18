/* 简答人工订正 · 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-manual-old.js
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
const S = require('../core/schema.js');
function paper() {
  return [
    S.createQuestion({ id: 'r1', type: '单选', stem: 's1', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['A'] }),
    S.createQuestion({ id: 'r2', type: '简答', stem: 's2', keywords: [{ text: '甲' }, { text: '乙' }, { text: '丙' }] })
  ];
}
/* 交卷后的会话：单选对(2)、简答中 1/3(≈0.83→1) → 整卷 3 分，简答 1 分 */
function build(A) {
  const s = A.createSession({ title: 't', questions: paper(), config: Q.mergeConfig(Q.DEFAULT_CONFIG, {}) });
  A.goto(s, 0); A.answer(s, 'A'); A.submitCurrent(s);
  A.goto(s, 1); A.answer(s, '甲'); A.submitCurrent(s);
  A.finish(s);
  return s;
}
const results = [];
async function probe(name, fn) {
  let red = false;
  try { red = await fn(); } catch (e) { red = '抛错:' + (e && e.message); }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red);
}

(async function () {

/* ---- 1. 改判只改「记录」不改分数（总分不重算） ---- */
await probe('① 改判后不重算总分 → ①-B 必须变红', async function () {
  const A = loadFrom('core/attempt.js', s => s.replace('    if (session.finished) refreshSummary(session);      // 已交卷 → 总分/百分比/等级**同步重算**', '    if (false) refreshSummary(session);'),
                     'core/__probe_attempt_m1.js');
  try {
    const s = build(A);
    const before = A.resultModel(s).score;
    A.applyManual(s, 1, { score: 5 });
    return A.resultModel(s).score === before;            // 整卷没变 → 锚红
  } finally { rm('core/__probe_attempt_m1.js'); }
});

/* ---- 2. 直接给分不夹满分（能给出超过满分的分） ---- */
await probe('② 直接给分不封顶 → ①-E 必须变红', async function () {
  const Qq = loadFrom('core/quiz.js',
    s => s.replace('        res.score = roundHalf(clamp(o.manualScore, 0, full));', '        res.score = roundHalf(o.manualScore);'),
    'core/__probe_quiz_m2.js');
  try {
    const q = { id: 'k', type: '简答', keywords: [{ text: '甲' }] };
    const c = Q.mergeConfig(Q.DEFAULT_CONFIG, {});
    const r = Qq.scoreOne(q, '甲', c, { manualScore: 99 });
    return r.score !== 5;                                // 99 分没被夹住 → 锚红
  } finally { rm('core/__probe_quiz_m2.js'); }
});

/* ---- 3. 人工命中不参与算分（只记痕迹） ---- */
await probe('③ 人工命中不计入命中率 → ①-D 必须变红', async function () {
  const Qq = loadFrom('core/quiz.js',
    s => s.replace('        const byManual = !auto && manualHits.indexOf(kt) >= 0;', '        const byManual = false;'),
    'core/__probe_quiz_m3.js');
  try {
    const q = { id: 'k', type: '简答', keywords: [{ text: '甲' }, { text: '乙' }] };
    const c = Q.mergeConfig(Q.DEFAULT_CONFIG, {});
    return Qq.scoreOne(q, '甲', c, { manualHits: ['乙'] }).score !== 5;   // 标了乙却不加分 → 锚红
  } finally { rm('core/__probe_quiz_m3.js'); }
});

/* ---- 4. 客观题也能被改判（失去规则判分的意义） ---- */
await probe('④ 客观题也允许改判 → ②-B 必须变红', async function () {
  const A = loadFrom('core/attempt.js',
    s => s.replace("    if (q.type !== '简答') return { ok: false, error: '只有简答题需要人工订正（' + q.type + ' 由客观规则判分）' };", '    '),
    'core/__probe_attempt_m4.js');
  try {
    const s = build(A);
    return A.applyManual(s, 0, { score: 999 }).ok === true;
  } finally { rm('core/__probe_attempt_m4.js'); }
});

/* ---- 5. 撤销后没回到自动分 ---- */
await probe('⑤ 撤销不恢复自动分 → ①-C 必须变红', async function () {
  const A = loadFrom('core/attempt.js',
    s => s.replace('    session.results[q.id] = QuizCore.scoreOne(q, session.answers[q.id], session.config);\n    if (!session.checked[q.id] && !isAnswered(q, session.answers[q.id])) delete session.results[q.id];',
                   '    /* 旧行为：撤销只删记录、留着人工分 */'),
    'core/__probe_attempt_m5.js');
  try {
    const s = build(A);
    const autoCard = A.reviewList(s)[1].score;               // 回看卡片上的自动分
    A.applyManual(s, 1, { score: 5 });
    A.clearManual(s, 1);
    // ⚠ 锚要看**回看卡片**（它读 session.results），不是整卷总分 ——
    //   总分由 scoreExam 从 answers+config 重算，撤销后本来就是对的（那条路很稳健）
    return A.reviewList(s)[1].score !== autoCard;            // 卡片还留着人工分 → 锚红
  } finally { rm('core/__probe_attempt_m5.js'); }
});

/* ---- 6. 改判痕迹不留档（看不出哪些题被订正过） ---- */
await probe('⑥ 不记录人工订正痕迹 → ②-A 必须变红', async function () {
  const A = loadFrom('core/attempt.js',
    s => s.replace('    session.manual[q.id] = { hits: hits, score: score, note: String(p.note == null ? \'\' : p.note), at: p.at || \'\' };', '    '),
    'core/__probe_attempt_m6.js');
  try {
    const s = build(A);
    A.applyManual(s, 1, { score: 5, note: 'x' });
    const look = A.reviewList(s)[1];
    return !(look.manual && A.resultModel(s).manualCount === 1);          // 痕迹没了 → 锚红
  } finally { rm('core/__probe_attempt_m6.js'); }
});

const fail2 = results.filter(x => x[1] !== true);
console.log('\n探针汇总：' + results.length + ' 条  全部能让锚变红=' + (fail2.length === 0));
if (fail2.length) { fail2.forEach(b => console.log('  未变红：' + b[0] + ' → ' + b[1])); process.exitCode = 1; }
})();
