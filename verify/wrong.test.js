/* ============================================================
 *  verify/wrong.test.js —— 「误答自动收集与计数」小类验收
 *
 *  运行： node verify/wrong.test.js
 *
 *  三条盘档验收标准，逐条对应：
 *    ① 误答的题在交卷后自动进入对应试卷的误答本，题目与试卷归属正确
 *    ② 同一题重复误答时错误次数正确递增（连续两轮均答错则计数为 2）
 *    ③ 答对后的处理规则固定且可预测，不会出现历史记录被静默删除
 *
 *  三条反空转设计：
 *    · ① 用**四型混合的固定样本**（含多选半对、简答未全命中）逐题核对"谁进谁不进"，
 *      并配"全对那一轮一本为空"的反向对照；
 *    · ② 同一份卷子跑**两轮**（第二轮故意再错同一题）→ times 必须是 2、streak 必须是 2；
 *    · ③ 答对一轮后除 streak/rightTimes 外**其余字段逐字节不变**（深比较），
 *      并断言 `removed` 为空（没有任何东西被删掉）。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const W = require('../core/wrong.js');
const A = require('../core/attempt.js');
const Q = require('../core/quiz.js');
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
  const m = new Map();
  const s = { getItem: k => (m.has(String(k)) ? m.get(String(k)) : null), setItem: (k, v) => { m.set(String(k), String(v)); },
              removeItem: k => { m.delete(String(k)); }, key: () => null, get length() { return m.size; } };
  return { store: D.createStore({ small: s, large: null, namespace: ns || 'app' }), raw: m };
}
/* 跑一轮：作答 → 交卷 → 收集。answers 里没给的题 = 不作答（也算误答） */
async function runRound(store, examId, questions, answers, now, sessionAt) {
  const s = A.createSession({ examId: examId, title: '卷', questions: questions, config: cfg({}) });
  questions.forEach(function (q, i) {
    if (answers[q.id] === undefined) return;
    A.goto(s, i); A.answer(s, answers[q.id]); A.submitCurrent(s);
  });
  const fin = A.finish(s, { confirmUnanswered: true, now: sessionAt });
  const byId = {}; questions.forEach(function (q) { byId[q.id] = q; });
  const r = await W.collectToStore(store, {
    examId: examId, results: fin.summary.per, now: now, sessionAt: sessionAt,
    questionsById: byId, answers: s.answers
  });
  return { session: s, summary: fin.summary, collected: r };
}

async function main() {
const parsed = await P.parseDocx(readSample());
const BANK = parsed.questions.map(q => S.createQuestion(q));

/* ============================================================ */
head('①-A 四型混合样本：谁进误答本、谁不进（逐题核对）');

/* 手写三题：单选（答对）、多选（半对 → 误答）、简答（未全命中 → 误答） */
const FIX = [
  S.createQuestion({ id: 'w1', type: '单选', stem: '单选对的', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['A'] }),
  S.createQuestion({ id: 'w2', type: '多选', stem: '多选半对', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }, { label: 'C', text: 'c' }], answerLetters: ['A', 'B'] }),
  S.createQuestion({ id: 'w3', type: '简答', stem: '简答未全命中', keywords: [{ text: '甲' }, { text: '乙' }, { text: '丙' }] }),
  S.createQuestion({ id: 'w4', type: '判断', stem: '判断答错', judgeValue: true })
];
const ANS = { w1: 'A', w2: 'A', w3: '甲 乙', w4: '×' };      // w1 对；w2 半对；w3 中 2/3；w4 错
const W1 = makeStore();
const r1 = await runRound(W1.store, 'EX1', FIX, ANS, '2026-09-20T10:00:00.000Z', 'S1');
eq(r1.summary.per.map(p => p.correct), [true, false, false, false], '结算口径：只有第 1 题算"满分"（其余三题都没达满分）');
eq(r1.collected.added.sort(), ['w2', 'w3', 'w4'], '**自动进本的是三题误答**（多选半对、简答未全命中、判断答错）');
eq(r1.collected.ignored, ['w1'], '  答对的第 1 题**不进本**（不进本才正常）');
const book1 = r1.collected.book;
eq(Object.keys(book1.entries).sort(), ['w2', 'w3', 'w4'], '本子里正好三条');
eq([book1.entries.w2.qid, book1.entries.w2.examId], ['w2', 'EX1'], '  条目带 qid 与 examId（归属自己写在本子里）');
eq([book1.entries.w2.type, book1.entries.w2.stem], ['多选', '多选半对'], '  条目带题型与题干（错题本详情页要用）');
eq([book1.entries.w2.times, book1.entries.w2.streak], [1, 1], '  首次进本：times=1、streak=1');
eq([book1.entries.w2.lastScore, book1.entries.w2.lastFull], [2, 3], '  记下最后一次的得分/满分（半对固定给 2 分 → 2/3）');
eq(book1.entries.w3.lastAnswer, '甲 乙', '  记下最后一次的作答（简答多行也原样存）');
eq(r1.collected.stats, { total: 3, timesSum: 3, active: 3, mastered: 0, removed: 0 }, '统计：3 条、总次数 3、全部待纠正、零删除');

head('①-B 反向对照：全对的一轮，一本为空（不是"永远往里塞"）');

const W2 = makeStore();
const ALLRIGHT = { w1: 'A', w2: 'AB', w3: '甲 乙 丙', w4: '√' };
const r2 = await runRound(W2.store, 'EX2', FIX, ALLRIGHT, '2026-09-20T11:00:00.000Z', 'S2');
eq(r2.summary.per.every(p => p.correct), true, '全对：每题都是满分');
eq([r2.collected.added, Object.keys(r2.collected.book.entries).length], [[], 0], '  误答本是空的（没有误答就不该有记录）');

head('①-C 试卷归属：A 卷的错题不落进 B 卷（各自一本）');

const W3 = makeStore();
const rA = await runRound(W3.store, 'EXA', FIX, ANS, '2026-09-20T12:00:00.000Z', 'SA');
const rB = await runRound(W3.store, 'EXB', FIX, { w1: 'B', w2: 'AB', w3: '甲 乙 丙', w4: '√' }, '2026-09-20T12:01:00.000Z', 'SB');
eq(Object.keys(rA.collected.book.entries).sort(), ['w2', 'w3', 'w4'], 'EXA：三条误答');
eq(Object.keys(rB.collected.book.entries), ['w1'], 'EXB：只有它自己错的那一条（w1）');
eq(W.wrongKey('EXA') !== W.wrongKey('EXB'), true, '两套卷的键不同：' + W.wrongKey('EXA') + ' / ' + W.wrongKey('EXB'));
const reA = await W.loadBook(W3.store, 'EXA');
eq([reA.ok, Object.keys(reA.book.entries).sort(), reA.book.examId], [true, ['w2', 'w3', 'w4'], 'EXA'],
   '从存储里按卷 id 读回来：还是 EXA 自己那三条（没被 EXB 污染）');

/* ============================================================ */
head('②-A 连续两轮都答错 → times=2、streak=2（验收原话）');

const W4 = makeStore();
const round1 = await runRound(W4.store, 'EX3', FIX, ANS, '2026-09-21T09:00:00.000Z', 'R1');
eq(round1.collected.book.entries.w2.times, 1, '第一轮：w2 进本、times=1');
const round2 = await runRound(W4.store, 'EX3', FIX, ANS, '2026-09-21T09:05:00.000Z', 'R2');
eq(round2.collected.incremented.sort(), ['w2', 'w3', 'w4'], '第二轮：三题都被"累加"（不是当成新条目）');
eq([round2.collected.book.entries.w2.times, round2.collected.book.entries.w2.streak], [2, 2],
   '  **连续两轮均答错 → 计数为 2、连续次数为 2**');
eq([round2.collected.book.entries.w3.times, round2.collected.book.entries.w4.times], [2, 2], '  另外两题也是 2');
eq(round2.collected.stats.total, 3, '  条目数仍是 3（没有重复建条目）');
eq(round2.collected.book.entries.w2.history.length, 2, '  历史留了两笔（每次误答一笔）');
eq(round2.collected.added, [], '  第二轮没有"新增"动作（全是累加）');

head('②-B 只错一次的那题不会被别的题连坐');

const W5 = makeStore();
const onlyW2 = { w1: 'A', w2: 'A', w3: '甲 乙 丙', w4: '√' };    // 只有 w2 半对
const o1 = await runRound(W5.store, 'EX4', FIX, onlyW2, '2026-09-21T10:00:00.000Z', 'T1');
eq([o1.collected.added, o1.collected.stats.total], [['w2'], 1], '只错一题 → 本子里只有一条');
const o2 = await runRound(W5.store, 'EX4', FIX, onlyW2, '2026-09-21T10:05:00.000Z', 'T2');
eq([o2.collected.book.entries.w2.times, o2.collected.stats.timesSum], [2, 2], '  再错一次 → times=2、总次数 2');

head('②-C 幂等：同一轮交卷重复收集不会把次数算两遍');

const W6 = makeStore();
const rb = await runRound(W6.store, 'EX5', FIX, ANS, '2026-09-21T11:00:00.000Z', 'SAME');
const again = await W.collectToStore(W6.store, {
  examId: 'EX5', results: rb.summary.per, now: '2026-09-21T11:00:01.000Z', sessionAt: 'SAME',
  questionsById: {}, answers: {}
});
eq([again.ok, again.skipped, again.reason], [true, true, 'duplicate'], '同一 sessionAt 再收集 → 明确跳过（duplicate）');
eq([again.book.entries.w2.times, again.stats.timesSum], [1, 3], '  次数没有翻倍（仍是 1 / 总计 3）');

/* ============================================================ */
head('③-A 答对后的规则：保留记录、清零连续错误、累加答对次数（**不许删**）');

const W7 = makeStore();
const c1 = await runRound(W7.store, 'EX6', FIX, ANS, '2026-09-22T09:00:00.000Z', 'U1');
const before = JSON.parse(JSON.stringify(c1.collected.book.entries.w2));
eq([before.times, before.streak], [1, 1], '先错一次：times=1、streak=1');
/* 第二轮：w2 答对（全选 AB），其余仍然错 */
const c2 = await runRound(W7.store, 'EX6', FIX, { w1: 'A', w2: 'AB', w3: '甲 乙', w4: '×' }, '2026-09-22T09:10:00.000Z', 'U2');
eq(c2.collected.mastered, ['w2'], '答对的那题动作是 **mastered**（不是删除）');
const after = c2.collected.book.entries.w2;
eq([after.times, after.streak, after.rightTimes], [1, 0, 1],
   '  答对后：**times 不变（1）**、连续错误清零（0）、答对次数 +1');
eq(Object.keys(c2.collected.book.entries).sort(), ['w2', 'w3', 'w4'], '  **记录还在**（三条一条不少）');
eq(c2.collected.book.removed === undefined || c2.collected.book.removed.length, 0, '  没有任何"被删除"的痕迹');
/* 除 streak/rightTimes/lastRightAt/history 之外，其余字段逐字节不变 */
const frozen = {};
['qid', 'examId', 'type', 'stem', 'times', 'firstWrongAt', 'lastWrongAt', 'lastAnswer', 'lastScore', 'lastFull']
  .forEach(function (k) { frozen[k] = [before[k], after[k]]; });
eq(frozen, {
  qid: ['w2', 'w2'], examId: ['EX6', 'EX6'], type: ['多选', '多选'], stem: ['多选半对', '多选半对'],
  times: [1, 1], firstWrongAt: ['2026-09-22T09:00:00.000Z', '2026-09-22T09:00:00.000Z'],
  lastWrongAt: ['2026-09-22T09:00:00.000Z', '2026-09-22T09:00:00.000Z'],
  lastAnswer: ['A', 'A'], lastScore: [2, 2], lastFull: [3, 3]
}, '  **除"连续错误/答对次数"外，其余字段逐字节不变**（历史没被改写）');
eq(after.history.length, 2, '  历史变成两笔（错一笔 + 对一笔）');
eq(after.history.map(h => h.kind), ['wrong', 'right'], '  两笔的顺序与类型正确');

head('③-B 再错一次 → 连续错误从 0 重新涨到 1（times 变 2）');

const c3 = await runRound(W7.store, 'EX6', FIX, ANS, '2026-09-22T09:20:00.000Z', 'U3');
eq([c3.collected.book.entries.w2.times, c3.collected.book.entries.w2.streak, c3.collected.book.entries.w2.rightTimes],
   [2, 1, 1], '  又错了：times=2、streak 从 0 涨到 1、rightTimes 仍是 1');
eq([c3.collected.book.entries.w2.history.length, c3.collected.book.entries.w2.history.map(h => h.kind).join(',')],
   [3, 'wrong,right,wrong'], '  历史三笔：错→对→错（完整时间线，没丢中间那笔）');

head('③-C 只有"显式移除"才删记录，而且留痕');

const W8 = makeStore();
const d1 = await runRound(W8.store, 'EX7', FIX, ANS, '2026-09-23T09:00:00.000Z', 'V1');
const rm = W.remove(d1.collected.book, 'w2', { now: '2026-09-23T09:10:00.000Z', reason: '这题我看错了，本来是对的' });
eq([rm.ok, Object.keys(d1.collected.book.entries).sort()], [true, ['w3', 'w4']], '显式移除 w2 → 本子里只剩两条');
eq(d1.collected.book.removed, [{ qid: 'w2', at: '2026-09-23T09:10:00.000Z', reason: '这题我看错了，本来是对的' }],
   '  **删除留痕**（谁、什么时候、为什么）—— 与"静默删除"划清界限');
eq(W.remove(d1.collected.book, 'w1').ok, false, '移除一条本来就不在的记录 → 明确失败');

head('③-D 答对但本子里没有的题：不建记录（答对不是错题）');

const W9 = makeStore();
const e1 = await runRound(W9.store, 'EX8', FIX, ALLRIGHT, '2026-09-24T09:00:00.000Z', 'X1');
eq([e1.collected.ignored.sort(), e1.collected.stats.total], [['w1', 'w2', 'w3', 'w4'], 0], '四题全对 → 四题都被 ignored、本子为空');
const e2 = await runRound(W9.store, 'EX8', FIX, { w1: 'A', w2: 'A' }, '2026-09-24T09:05:00.000Z', 'X2');
eq([e2.collected.added.sort(), e2.collected.ignored], [['w2', 'w3', 'w4'], ['w1']],
   '第二轮只答了 w1/w2：w1 对 → ignored；**w2 半对 + w3/w4 未作答 → 三题都进本**（"没做"与"做错"一视同仁）');

head('③-E 未作答的题也算误答（"没做"与"做错"都要收集）');

const W10 = makeStore();
const f1 = await runRound(W10.store, 'EX9', FIX, { w1: 'A' }, '2026-09-25T09:00:00.000Z', 'Y1');
eq(f1.collected.added.sort(), ['w2', 'w3', 'w4'], '只答对第 1 题 → 其余三题（含未作答）全部进本');
eq(f1.collected.book.entries.w2.lastAnswer, null, '  未作答的题 lastAnswer 为 null（如实记录"没答"）');

/* ============================================================ */
head('整体验收：存储往返 / 版本门禁 / 与既有两个真相源一致');

const W11 = makeStore();
const g1 = await runRound(W11.store, 'EX10', FIX, ANS, '2026-09-26T09:00:00.000Z', 'Z1');
const key = W.wrongKey('EX10');
eq(key, 'wrong::EX10', '键走既有规则（DataCore.wrongKey，不手拼）');
eq(W11.raw.has(D.prefixedKey('app', key)), true, '落库真实键 = ' + D.prefixedKey('app', key));
const reload = await W.loadBook(W11.store, 'EX10');
eq([reload.ok, reload.empty, Object.keys(reload.book.entries).sort()], [true, false, ['w2', 'w3', 'w4']],
   '换新 store 实例读回：内容逐条都在（真持久）');
eq(reload.book.entries.w2.times, 1, '  次数也对');
const badV = W.checkPayload({ v: 99, entries: {} }, 'EX10');
eq([badV.ok, badV.reason], [false, 'version'], '版本不符 → 明确拒绝（不猜着读）');
const otherExam = W.checkPayload({ v: W.WRONG_VERSION, examId: 'OTHER', entries: {} }, 'EX10');
eq([otherExam.ok, otherExam.reason], [false, 'wrong-exam'], '误答本属于另一套卷 → 拒绝（不串号）');
const noStore = await W.loadBook(null, 'EX10');
eq([noStore.ok, noStore.degraded, Object.keys(noStore.book.entries).length], [true, true, 0],
   '没有存储 → 降级为内存态（返回空本子，不崩）');
const saveFail = await W.saveBook(null, g1.collected.book);
eq([saveFail.ok, saveFail.degraded], [false, true], '存不上也如实报告（不谎报成功）');
// 与既有真相源一致：进本的判定完全来自 scoreExam 的 per[].correct
const direct = Q.scoreExam(FIX, ANS, cfg({}));
eq(direct.per.filter(p => !p.correct).map(p => p.id).sort(), g1.collected.added.sort(),
   '进本集合 == scoreExam 里 correct===false 的集合（同一真相源，不另算一遍）');
// 与 AttemptCore 的回看口径一致
eq(g1.session.summary.per.map(p => p.correct), direct.per.map(p => p.correct), '会话结算的 correct 标记与 scoreExam 逐题一致');
ok(BANK.length > 0, '（旁证）真实样卷也能跑这条路：' + BANK.length + ' 题', BANK.length);

head('①-E 未入册的卷也要看得见（孤儿误答本：答过但没进卷册索引的卷）');

/* 真实场景：答题页**拖入自己的 docx** 或直接答内置样卷 —— 卷 id 就是文件名，这条路不写卷册索引，
 * 但交卷时误答照样收进 `wrong::<卷id>`。不把它们捞出来，用户答完一轮回错题本只能看到"本地还没有卷子"。 */
const ORPH = makeStore();
{
  const s = A.createSession({ examId: 'file:我的题库.docx', title: '我的题库.docx（10 题）', questions: FIX, config: cfg({}) });
  A.goto(s, 0); A.answer(s, 'A'); A.submitCurrent(s);
  const fin = A.finish(s, { confirmUnanswered: true, now: '2026-09-21T10:00:00.000Z' });
  const byId = {}; FIX.forEach(function (q) { byId[q.id] = q; });
  await W.collectToStore(ORPH.store, { examId: 'file:我的题库.docx', results: fin.summary.per,
    now: '2026-09-21T10:00:00.000Z', sessionAt: 'S-ORPH', questionsById: byId, answers: s.answers });
}
eq(await W.orphanIds(ORPH.store, []), ['file:我的题库.docx'], '**孤儿本被认出来**（卷册里没有它，盘上有它）');
eq(await W.orphanIds(ORPH.store, ['file:我的题库.docx']), [], '  一旦它进了卷册索引（known 里有），就不再算孤儿');
eq(await W.orphanIds(ORPH.store, ['别的卷']), ['file:我的题库.docx'], '  known 里的**别的卷**不影响判定');
const orphLoaded = await W.loadAll(ORPH.store, await W.orphanIds(ORPH.store, []));
eq([orphLoaded.length, Object.keys(orphLoaded[0].book.entries).length], [1, 3],
   '  捞出来就是一本能直接渲染的本子（3 条误答）');
eq(await W.orphanIds(ORPH.store, []).then(function (x) { return x.length; }), 1, '  同一份存储里只认一次（不重复列出）');
/* 反向对照：本命名空间之外的键不算孤儿（错题本只该看自己空间里的东西） */
const OTHER = makeStore('recv_abc');
await OTHER.store.set(D.wrongKey('recv 里的卷'), W.toJSON(W.createBook('recv 里的卷')));
eq(await W.orphanIds(ORPH.store, []), ['file:我的题库.docx'], '  **另一个命名空间里的误答本不会被本空间认领**');
eq(await W.orphanIds(null, []), [], '  没有 store（存储不可用）→ 空表，不抛错');

console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
console.log('  PASS ' + pass + '    FAIL ' + fail);
if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
console.log('  \x1b[90m注：错题本的列表/详情界面属下一小类「分卷归集与详情」\x1b[0m');
process.exitCode = fail ? 1 : 0;
}

main().catch(e => { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
