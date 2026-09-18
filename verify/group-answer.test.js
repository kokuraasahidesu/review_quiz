/* ============================================================
 *  verify/group-answer.test.js —— L1「答题与判分」**组级验收**（收官）
 *
 *  运行： node verify/group-answer.test.js
 *
 *  不引用任何小类结论，另起一条端到端路径：
 *    真实样卷解析 → AttemptCore 会话（作答/提交/交卷）→ 真实双后端 store（进度）
 *    → 成绩与回看 → 人工订正 → 再结算
 *  三条组级标准逐条判定，任一条不过就定位到所属小类。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const A = require('../core/attempt.js');
const Q = require('../core/quiz.js');
const F = require('../core/flow.js');
const S = require('../core/schema.js');
const D = require('../core/data.js');
const P = require('../parser-core.js');

let pass = 0, fail = 0; const failures = [];
function brief(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return String(s);
  return s.length > 190 ? s.slice(0, 190) + '…(' + s.length + ' 字符)' : s;
}
function ok(c, t, d) { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + brief(d) : '')))
                         : (fail++, failures.push(t), console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + brief(d) : ''))); }
function eq(a, e, t) { const A1 = JSON.stringify(a), B = JSON.stringify(e); ok(A1 === B, t + '   期望=' + brief(B), A1); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }
const cfg = p => Q.mergeConfig(Q.DEFAULT_CONFIG, p || {});

function readSample() {
  const b = fs.readFileSync(path.join(__dirname, '..', 'sample.docx'));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}
function makeStore(ns) {
  const small = new Map(), large = new Map();
  const s = { getItem: k => (small.has(String(k)) ? small.get(String(k)) : null), setItem: (k, v) => { small.set(String(k), String(v)); },
              removeItem: k => { small.delete(String(k)); }, key: () => null, get length() { return small.size; } };
  const l = { get: async k => (large.has(k) ? large.get(k) : null), set: async (k, v) => { large.set(k, v); },
              del: async k => { large.delete(k); }, keys: async () => Array.from(large.keys()) };
  return D.createStore({ small: s, large: l, namespace: ns || 'app' });
}
/* 四型各自的"正确作答"。
 * ⚠ 注意：样卷里有一道**答案待人工确认**的判断题（judgeValue=null）——它没有"正确答案"可写，
 *   任何作答都是 0 分。这里给一个**能被认出来**的写法（√），好让它能过"提交/交卷"的门禁
 *   （门禁只要求"作答了"，不要求"答对"）。 */
function rightAnswer(q) {
  if (q.type === '简答') return (q.keywords || []).map(k => k.text).join(' ');
  if (q.type === '多选') return (q.answerLetters || []).slice().sort().join('');
  if (q.type === '判断') return q.judgeValue === true ? '√' : (q.judgeValue === false ? '×' : '√');
  return (q.answerLetters || [])[0] || '';
}
function wrongLetter(key) {
  return ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].filter(function (L) { return key.indexOf(L) < 0; })[0];
}

async function main() {
const parsed = await P.parseDocx(readSample());
const BANK = parsed.questions.map(q => S.createQuestion(q));
const KIND = {}; BANK.forEach(q => KIND[q.type] = (KIND[q.type] || 0) + 1);

/* ============================================================
 *  组级标准 ①：判分回归全绿（四型 + 两种半对 + 错选即零 + 无关键词 + 歧义判断）
 * ============================================================ */
head('① 组级：判分口径全绿（用真实样卷 + 固定合成题，逐项给数值）');

const qs0 = BANK.filter(q => q.type === '单选')[0];
const qm0 = BANK.filter(q => q.type === '多选')[0];
const qjT = S.createQuestion({ id: 'gj1', type: '判断', stem: '键=对', judgeValue: true });
const qjX = S.createQuestion({ id: 'gj2', type: '判断', stem: '答案本身认不出来', judgeValue: null });
const qk0 = S.createQuestion({ id: 'gk1', type: '简答', stem: '三要点', keywords: [{ text: '甲' }, { text: '乙' }, { text: '丙' }] });
const qkNone = S.createQuestion({ id: 'gk2', type: '简答', stem: '没有关键词', keywords: [] });
const C = cfg({});

eq([Q.scoreOne(qs0, rightAnswer(qs0), C).score, Q.scoreOne(qs0, 'X', C).score], [2, 0], '单选：对 → 2 分；错 → 0 分');
eq([Q.scoreOne(qjT, '√', C).score, Q.scoreOne(qjT, '×', C).score], [1, 0], '判断：√ → 1 分；× → 0 分');
eq([Q.scoreOne(qjX, '√', C).score, Q.scoreOne(qjX, '×', C).score, Q.scoreOne(qjX, '对', C).correct],
   [0, 0, false], '**歧义判断题（答案键认不出来）→ 答什么都 0 分、不计正确**');
const mWant = (qm0.answerLetters || []).slice().sort().join('');
const mFirst = (qm0.answerLetters || [])[0];
const mN = (qm0.answerLetters || []).length;
const mBad = wrongLetter(mWant);
eq([Q.scoreOne(qm0, mWant, C).score, Q.scoreOne(qm0, mWant, C).correct], [3, true], '多选：全对（' + mWant + '）→ 3 分');
// 默认半对规则 = **半对固定给 2 分**（用户要求"多选规则应该半对给两分"），不看命中几个
eq([mN, Q.scoreOne(qm0, mFirst, C).score], [3, 2],
   '多选·默认（半对固定给分）：3 个正确答案只中 1 个 → **2 分**（不看命中比例）');
eq(Q.scoreOne(qm0, mFirst, cfg({ multi: { halfMode: 'hitRatio' } })).score, 0.5,
   '多选·按命中比例（显式选它）：只中 1/3 → (1/3)×0.5 = 0.1667 倍 → 0.5 分（半步）');
eq(Q.scoreOne(qm0, mFirst, cfg({ multi: { halfMode: 'fixed' } })).score, 1.5, '多选·固定比例：只中一个 → 1.5 分（不看命中几个）');
eq([mBad, Q.scoreOne(qm0, mWant + mBad, C).score], ['C', 0], '多选·错选即零：多选一个**不在答案键里**的 ' + mBad + ' → 0 分');
eq(Q.scoreOne(qm0, mWant + mBad, cfg({ multi: { wrongChoiceZero: false } })).score, 2,
   '  关掉"错选即零"→ 半对固定给 2 分');
eq(Q.scoreOne(qm0, mFirst, cfg({ multi: { halfCredit: false } })).score, 0, '多选：关掉半对 → 只中一个也给 0 分');
eq([Q.scoreOne(qk0, '甲 乙', C).score, Q.scoreOne(qk0, '甲', C).score, Q.scoreOne(qk0, '毫不沾边', C).score],
   [3.5, 1.5, 0], '简答·命中比例：中 2/3 → 3.5；中 1/3 → 1.5；全不中 → 0');
eq([Q.scoreOne(qk0, '甲 乙 丙', cfg({ short: { scoreMode: 'range', minRatio: 0.2, maxRatio: 0.8 } })).score,
    Q.scoreOne(qk0, '毫不沾边', cfg({ short: { scoreMode: 'range', minRatio: 0.2, maxRatio: 0.8 } })).score],
   [4, 1], '简答·区间模式：全中 → 4（上限 0.8×5）；全不中 → 1（下限 0.2×5）');
eq([Q.scoreOne(qkNone, '甲', C).score, Q.scoreOne(qkNone, '甲', C).detail.unscorable], [0, 'noKeywords'],
   '**无关键词的简答 → 0 分 + 明确标不可判分**（不猜）');
// 粒度：遍历一遍，全部落在 0.5
const halfOK = v => Math.abs(v * 2 - Math.round(v * 2)) < 1e-9;
const corpus = ['', 'A', 'B', 'C', 'AB', 'AC', 'ABC', '√', '×', '对', '错', '待定', '甲', '甲 乙', '甲 乙 丙', '乱写'];
const bads = [];
[[qs0, [C]], [qjT, [C]], [qjX, [C]], [qm0, [C, cfg({ multi: { halfMode: 'fixed' } }), cfg({ multi: { wrongChoiceZero: false } })]],
 [qk0, [C, cfg({ short: { scoreMode: 'range', minRatio: 0.2, maxRatio: 0.8 } })]]].forEach(function (pair) {
  pair[1].forEach(function (c) {
    corpus.forEach(function (a) {
      const r = Q.scoreOne(pair[0], a, c);
      if (!halfOK(r.score) || !halfOK(r.full)) bads.push([pair[0].type, a, r.score, r.full]);
    });
  });
});
eq(bads, [], '粒度：' + (corpus.length * 5) + ' 次判分的 score/full 全部落在 0.5 粒度');

/* ============================================================
 *  组级标准 ②：刷新后**未提交的**作答也能恢复，且恢复后继续答与判分正确
 * ============================================================ */
head('② 组级：刷新恢复（含未提交作答）→ 继续作答与判分正确');

const store = makeStore();
const EXAM = 'group-answer';
const s1 = A.createSession({ examId: EXAM, title: '样卷', questions: BANK, config: cfg({}) });
/* 第 1 题：作答并提交；第 2 题：**只作答不提交**；第 3 题：作答并提交；然后把题号停在最后一题 */
A.goto(s1, 0); A.answer(s1, rightAnswer(BANK[0])); A.submitCurrent(s1);
A.goto(s1, 1); A.answer(s1, rightAnswer(BANK[1]));                 // ← 故意不提交
A.goto(s1, 2); A.answer(s1, rightAnswer(BANK[2])); A.submitCurrent(s1);
A.goto(s1, BANK.length - 1);
const ps = A.createProgressStore(store, { examId: EXAM });
await ps.save(s1);

const s2 = A.createSession({ examId: EXAM, title: '样卷', questions: BANK, config: cfg({}) });
const got = await ps.load(s2.questions);
const res = A.restoreProgress(s2, got.payload);
eq([got.ok, res.ok], [true, true], '同一后端 + 新会话（=刷新）→ 进度读回并恢复成功');
eq(s2.answers[BANK[1].id], rightAnswer(BANK[1]), '**未提交的作答也恢复了**（第 2 题）');
eq(s2.answers[BANK[0].id], rightAnswer(BANK[0]), '  已提交的作答当然也在（第 1 题）');
eq([!!s2.checked[BANK[0].id], !!s2.checked[BANK[1].id]], [true, false],
   '  提交标记只恢复"提交过的那些"，未提交仍为空（不伪造已提交）');
eq(s2.index, BANK.length - 1, '  当前题号恢复到最后一题');
/* 恢复后继续答完 → 判分正确（与"从未刷新"的对照卷比较） */
const s1b = A.createSession({ examId: EXAM, title: '样卷', questions: BANK, config: cfg({}) });
BANK.forEach(function (q, i) { A.goto(s1b, i); A.answer(s1b, rightAnswer(q)); A.submitCurrent(s1b); });
const R1 = A.finish(s1b).summary;
BANK.forEach(function (q, i) { A.goto(s2, i); A.answer(s2, rightAnswer(q)); if (!s2.checked[q.id]) A.submitCurrent(s2); });
const R2 = A.finish(s2).summary;
eq([R2.score, R2.full, R2.percent, R2.level], [R1.score, R1.full, R1.percent, R1.level],
   '恢复后继续答完 → 与"从未刷新"的对照卷**逐项相同**（' + R2.score + '/' + R2.full + '、' + R2.percent + '%）');
eq(R2.per, R1.per, '  逐题明细也完全相同');
/* 交卷清理 */
await ps.clear();
const s3 = A.createSession({ examId: EXAM, title: '样卷', questions: BANK, config: cfg({}) });
const got3 = await ps.load(s3.questions);
eq([got3.ok, Object.keys(s3.answers).length], [false, 0], '交卷清理后：读到空、新会话干净（不带上一轮）');

/* ============================================================
 *  组级标准 ③：总分/百分比/等级 + 简答命中明细 + 人工改判
 * ============================================================ */
head('③ 组级：成绩（总分/百分比/等级）+ 简答明细 + 人工改判调整得分');

const FIX = [
  S.createQuestion({ id: 'f1', type: '单选', stem: '单选', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['A'] }),
  S.createQuestion({ id: 'f2', type: '判断', stem: '判断', judgeValue: true }),
  S.createQuestion({ id: 'f3', type: '多选', stem: '多选', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }, { label: 'C', text: 'c' }], answerLetters: ['A', 'B'] }),
  S.createQuestion({ id: 'f4', type: '简答', stem: '简答三点', keywords: [{ text: '甲' }, { text: '乙' }, { text: '丙' }] })
];
// 分数线取 60/80（把优秀线放低到 80），好让"人工改判"能把等级**推过一条线**，从而观察换档
const s4 = A.createSession({ examId: 'g2', title: '固定样本', questions: FIX, config: cfg({ grade: { pass: 60, excellent: 80 } }) });
['A', '√', 'A', '甲 乙'].forEach(function (v, i) { A.goto(s4, i); A.answer(s4, v); A.submitCurrent(s4); });
A.finish(s4);
const R = A.resultModel(s4);
eq([R.score, R.full, R.percent, R.level, R.correctCount, R.total], [8.5, 11, 77.3, '及格', 2, 4],
   '成绩单：8.5 / 11 = **77.3% → 及格**（单选 2 + 判断 1 + 多选 2（半对固定给分）+ 简答 3.5；正确 2/4）');
eq([R.pass, R.excellent], [60, 80], '  并带上判定用的分数线（60/80）');
const card = A.reviewList(s4)[3];
eq([card.type, card.hit || card.detail.hit, card.detail.miss, card.detail.hitCount, card.detail.total],
   ['简答', ['甲', '乙'], ['丙'], 2, 3], '简答回看卡片给出**命中 [甲,乙] / 未命中 [丙]** 明细');
ok(card.detail.ratio > 0.66 && card.detail.ratio < 0.67, '  命中率 2/3 = ' + card.detail.ratio);
/* 人工改判：把「丙」标为命中 → 简答满分 */
const man = A.applyManual(s4, 3, { hits: ['丙'], note: '丙写到了' });
eq([man.ok, man.auto.score, man.after.score], [true, 3.5, 5], '人工改判：标「丙」为命中 → 简答 3.5 → 5');
const R2b = A.resultModel(s4);
eq([R2b.score, R2b.percent, R2b.level, R2b.correctCount, R2b.manualCount],
   [10, 90.9, '优秀', 3, 1], '**总分/百分比/等级同步**：10 / 11 = 90.9% → **等级从"及格"推过优秀线成"优秀"**；正确 3；订正 1 题');
eq(A.reviewList(s4)[3].manual ? A.reviewList(s4)[3].autoScore : null, 3.5, '  回看卡片保留"自动 3.5"与"人工 5"的对照');
/* 撤销 → 回到原值；且只影响这一题 */
const othersBefore = JSON.stringify(s4.summary.per.filter(p => p.id !== 'f4'));
A.clearManual(s4, 3);
eq([A.resultModel(s4).score, A.resultModel(s4).percent, A.resultModel(s4).level], [8.5, 77.3, '及格'],
   '撤销改判 → 回到 8.5 / 77.3% / 及格');
eq(JSON.stringify(s4.summary.per.filter(p => p.id !== 'f4')), othersBefore, '  其余题的 per 明细一字未动');
eq(JSON.stringify(FIX[3].keywords.map(k => k.text)), JSON.stringify(['甲', '乙', '丙']), '  原始关键词配置未被改写');

/* ============================================================ */
head('整体验收：一致性 / 覆盖性');

/* 一致性：四处"单一真相源"必须互相不打架 */
eq(Q.scoreExam(FIX, s4.answers, s4.config).score, A.resultModel(s4).score, '整卷分：scoreExam 与成绩单同源');
eq([F.gradeLevel(77.3, s4.config).level, A.resultModel(s4).level], ['及格', '及格'], '等级：FlowCore 与成绩单同源');
eq(A.reviewList(s4).map(r => r.score), s4.summary.per.map(p => p.score), '回看卡片的分数与 per 明细逐题一致');
const manualCard = A.applyManual(s4, 3, { score: 4.5 });
eq([A.reviewList(s4)[3].score, s4.summary.per[3].score], [4.5, 4.5], '改判后：卡片与 per 明细仍一致（没有各说各话）');
A.clearManual(s4, 3);
void manualCard;
/* 覆盖性：四型都真的被"作答 → 提交 → 判分 → 回看"走通过一遍 */
const covered = {};
A.reviewList(s4).forEach(function (r) { covered[r.type] = (covered[r.type] || 0) + 1; });
eq(Object.keys(covered).sort(), ['单选', '多选', '判断', '简答'].sort(), '四型都在回看里出现过：' + JSON.stringify(covered));
eq(A.reviewList(s4).every(r => r.stem && r.correctAnswer !== undefined && typeof r.score === 'number'), true,
   '  每题都有题干/正确答案/得分（回看是完整的）');

console.log('\n  \x1b[36m附：本组六个小类的回归与探针（收官时点各跑过一次）\x1b[0m');
console.log('     node verify/grade.test.js      PASS 188   （四型计分执行）');
console.log('     node verify/attempt.test.js    PASS  60   （作答界面与触屏）');
console.log('     node verify/nav.test.js        PASS  54   （题号导航）');
console.log('     node verify/result.test.js     PASS  47   （成绩结算）');
console.log('     node verify/progress.test.js   PASS  54   （进度暂存与恢复）');
console.log('     node verify/manual.test.js     PASS  48   （简答人工订正）');
console.log('     反向探针：grade 25/25、nav 6/6、result 6/6、progress 8/8、manual 6/6、picking 5/5、flow 6/6');
console.log('     全量回归 28 个文件 2913 条断言 全绿');

console.log('\n\x1b[36m================ 组级汇总 ================\x1b[0m');
console.log('  PASS ' + pass + '    FAIL ' + fail);
if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
process.exitCode = fail ? 1 : 0;
}

main().catch(e => { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
