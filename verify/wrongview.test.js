/* ============================================================
 *  verify/wrongview.test.js —— 「分卷归集与详情」小类验收
 *
 *  运行： node verify/wrongview.test.js
 *
 *  三条盘档验收标准，逐条对应：
 *    ① 按试卷分组正确，分组内题目数与实际误答数一致
 *    ② 详情展示的原题、参考答案、解析与试卷中的数据完全一致
 *    ③ 可从误答项跳转到所属试卷的对应题目
 *
 *  三条反空转设计：
 *    · ① 分组数字与"逐本 entries 的长度"交叉核对，并配"空本子不出组 / 排序正确"的对照；
 *    · ② 详情用**逐字段深比较**与试卷里的原题对照（题干/选项/答案/解析），
 *      再配两条反向对照：卷子改了题干 → 必须报 `stale`；题被删了 → `stale` 且 `jump=null`；
 *    · ③ 跳转目标 `{examId,index}` 与卷内下标**逐题核对**（不是抽查一道）。
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
function makeStore() {
  const m = new Map();
  const s = { getItem: k => (m.has(String(k)) ? m.get(String(k)) : null), setItem: (k, v) => { m.set(String(k), String(v)); },
              removeItem: k => { m.delete(String(k)); }, key: () => null, get length() { return m.size; } };
  return D.createStore({ small: s, large: null, namespace: 'app' });
}
/* 造一套卷 + 跑一轮（answers 里没给的题 = 不作答，也算误答） */
async function roundFor(store, exam, answers, now, sessionAt) {
  const s = A.createSession({ examId: exam.id, title: exam.title, questions: exam.questions, config: cfg({}) });
  exam.questions.forEach(function (q, i) {
    if (answers[q.id] === undefined) return;
    A.goto(s, i); A.answer(s, answers[q.id]); A.submitCurrent(s);
  });
  const fin = A.finish(s, { confirmUnanswered: true, now: sessionAt });
  const byId = {}; exam.questions.forEach(function (q) { byId[q.id] = q; });
  const r = await W.collectToStore(store, {
    examId: exam.id, results: fin.summary.per, now: now, sessionAt: sessionAt,
    questionsById: byId, answers: s.answers
  });
  return { session: s, summary: fin.summary, collected: r };
}
function makeExam(id, title) {
  return S.createExam({
    id: id, title: title, schemaVersion: S.SCHEMA_VERSION,
    questions: [
      S.createQuestion({ id: id + '-q1', type: '单选', stem: title + '·单选一', options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }], answerLetters: ['A'], explanation: title + '·单选一解析' }),
      S.createQuestion({ id: id + '-q2', type: '判断', stem: title + '·判断一', judgeValue: true, explanation: title + '·判断一解析' }),
      S.createQuestion({ id: id + '-q3', type: '多选', stem: title + '·多选一', options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }, { label: 'C', text: '丙' }], answerLetters: ['A', 'B'], explanation: title + '·多选一解析' }),
      S.createQuestion({ id: id + '-q4', type: '简答', stem: title + '·简答一', keywords: [{ text: '要点一' }, { text: '要点二' }], explanation: title + '·简答一解析' })
    ]
  }, { now: '2026-09-30T00:00:00.000Z' });
}

async function main() {
const store = makeStore();

/* ============================================================ */
head('①-A 按卷分组：分组数、组内题数、累计次数、卷标题都对得上');

const EX1 = makeExam('V1', '卷一');
const EX2 = makeExam('V2', '卷二');
/* 卷一：错 3 题（q1 答错、q3 半对、q4 未全命中）；卷二：错 1 题（q2 答错） */
const r1 = await roundFor(store, EX1, { 'V1-q1': 'B', 'V1-q2': '√', 'V1-q3': 'A', 'V1-q4': '要点一' }, '2026-10-01T10:00:00.000Z', 'P1');
const r2 = await roundFor(store, EX2, { 'V2-q1': 'A', 'V2-q2': '×', 'V2-q3': 'AB', 'V2-q4': '要点一 要点二' }, '2026-10-01T10:05:00.000Z', 'P2');
eq(Object.keys(r1.collected.book.entries).sort(), ['V1-q1', 'V1-q3', 'V1-q4'], '卷一收了 3 条（半对与未全命中都算误答）');
eq(Object.keys(r2.collected.book.entries), ['V2-q2'], '卷二收了 1 条');

const books = [
  { book: r1.collected.book, exam: EX1 },
  { book: r2.collected.book, exam: EX2 }
];
const gs = W.groups(books);
eq(gs.length, 2, '按卷分成 2 组');
const g1 = gs.filter(g => g.examId === 'V1')[0], g2 = gs.filter(g => g.examId === 'V2')[0];
eq([g1.title, g2.title], ['卷一', '卷二'], '组标题来自**卷册**里的标题（不是硬编码）');
eq([g1.total, g2.total], [3, 1], '**组内题数 = 实际误答数**（3 / 1）');
eq(gs.reduce((s, g) => s + g.total, 0), 4, '所有组的题目数之和 = 全部误答数（4）');
eq([g1.timesSum, g2.timesSum], [3, 1], '累计误答次数也对');

head('①-B 反向对照：空本子不出组；卷不在册时也要显示（带提醒）');

const emptyBook = W.createBook('V9', '');
eq(W.groups([{ book: emptyBook, exam: makeExam('V9', '空卷') }]), [], '没有任何误答的卷**不出组**（不显示空壳）');
const ghost = W.groups([{ book: r2.collected.book, exam: null }])[0];
eq([ghost.examId, ghost.examFound], ['V2', false], '卷已不在册时该组仍在（数据不能因为卷没了就消失）');
ok(/试卷 V2/.test(ghost.title), '  标题退化成可读的占位（不显示 undefined）', ghost.title);

head('①-C 组内排序：错得多的排前面（同次数按最近一次错的时间倒序）');

const EA = makeExam('V3', '卷三');
const rA1 = await roundFor(store, EA, { 'V3-q1': 'B', 'V3-q2': '×' }, '2026-10-02T09:00:00.000Z', 'A1');   // q1/q2 错
const rA2 = await roundFor(store, EA, { 'V3-q1': 'B', 'V3-q2': '√', 'V3-q3': 'AB', 'V3-q4': '要点一 要点二' }, '2026-10-02T09:05:00.000Z', 'A2'); // 只有 q1 再错
const gA = W.groups([{ book: rA2.collected.book, exam: EA }])[0];
// ⚠ 第一轮只答了 q1/q2 → q3/q4 **未作答也算误答**，所以本子里是四条；
//   第二轮 q2/q3/q4 都答对了 → 它们 streak 归零，只有 q1 还"连续错"。
eq(gA.entries.map(e => [e.qid, e.times]), [['V3-q1', 2], ['V3-q2', 1], ['V3-q3', 1], ['V3-q4', 1]],
   '错 2 次的 V3-q1 排最前（其余三条各错 1 次，按最近一次错的时间排在后面）');
eq([gA.active, gA.mastered], [1, 3], '  待纠正 1 条（q1 连续错 2 次）、已答对过 3 条（q2/q3/q4 第二轮答对了）');
eq(gA.total, 4, '  组内题数 = 4（与本子条目数一致）');
void rA1;

/* ============================================================ */
head('②-A 详情与试卷**逐字段一致**（原题/选项/参考答案/解析）');

const dMul = W.detailOf(r1.collected.book, 'V1-q3', { exam: EX1 });
const qMul = EX1.questions.filter(q => q.id === 'V1-q3')[0];
eq([dMul.ok, dMul.inExam, dMul.index, dMul.stale], [true, true, 2, false], '多选那条：能打开、在卷里、下标 2、不算过期');
eq([dMul.question.stem, dMul.question.type, dMul.question.explanation],
   [qMul.stem, qMul.type, qMul.explanation], '题干/题型/解析与试卷里的**完全一致**');
eq(dMul.question.options, qMul.options.map(o => ({ label: o.label, text: o.text })), '选项逐项一致（顺序也一致）');
eq(dMul.question.answerText, Q.answerText(qMul), '参考答案与 `QuizCore.answerText(卷里那题)` 一致：' + dMul.question.answerText);
eq(dMul.question.answerText, 'A、B', '  而且就是人读得懂的形式（多选用「、」分隔）');
eq([dMul.times, dMul.lastScore, dMul.lastFull, dMul.lastAnswer], [1, 2, 3, 'A'], '误答次数与最近一次作答/得分都在（半对固定给 2 分）');
eq(dMul.history.length, 1, '历史一笔');

const dShort = W.detailOf(r1.collected.book, 'V1-q4', { exam: EX1 });
const qShort = EX1.questions.filter(q => q.id === 'V1-q4')[0];
eq([dShort.question.answerText, dShort.lastAnswer], [Q.answerText(qShort), '要点一'], '简答那条：参考答案=关键词列表、你的作答原样');
eq(dShort.question.answerText, '要点一、要点二', '  参考答案可读：' + dShort.question.answerText);
const dJudge = W.detailOf(r2.collected.book, 'V2-q2', { exam: EX2 });
eq([dJudge.question.answerText, dJudge.question.type], ['对（√）', '判断'], '判断那条：参考答案显示为「对（√）」');

head('②-B 详情完整性：四型都覆盖到，且每条的 jump 都在');

const allQids = ['V1-q1', 'V1-q3', 'V1-q4'];
const missing = allQids.filter(function (qid) {
  const d = W.detailOf(r1.collected.book, qid, { exam: EX1 });
  return !(d.ok && d.question && d.question.stem && d.question.answerText !== '' && d.jump);
});
eq(missing, [], '卷一每条都能打开、都有原题与参考答案、都带 jump（' + allQids.length + ' 条逐条查）');
eq([W.detailOf(r1.collected.book, 'V1-q2', { exam: EX1 }).ok, W.detailOf(r1.collected.book, '不存在的题', { exam: EX1 }).reason],
   [false, 'not-in-book'], '不在本子里的题 q2 → 明确拒绝（不能凭空造详情）');

head('②-C 反向对照：卷子改了题干 / 题被删了 → 必须标 stale，不拿快照冒充');

const EX1B = S.createExam({
  id: 'V1', title: '卷一', schemaVersion: S.SCHEMA_VERSION,
  questions: [
    S.createQuestion(Object.assign({}, EX1.questions[0])),
    S.createQuestion(Object.assign({}, EX1.questions[1])),
    S.createQuestion(Object.assign({}, EX1.questions[2], { stem: '卷一·多选一【题干改过了】' })),
    S.createQuestion(Object.assign({}, EX1.questions[3]))
  ]
}, { now: '2026-10-03T00:00:00.000Z' });
const dStale = W.detailOf(r1.collected.book, 'V1-q3', { exam: EX1B });
eq([dStale.stale, dStale.inExam], [true, true], '题干改了 → `stale=true`（如实报告"卷子改过"）');
eq(dStale.question.stem, '卷一·多选一【题干改过了】', '  详情展示的是**卷子里的最新版**，不是误答本里的旧快照');
eq(dStale.snapshot.stem, '卷一·多选一', '  旧快照仍留档（对照用）：' + dStale.snapshot.stem);
ok(/题干已经改过/.test(dStale.staleReason), '  并给出可读原因', dStale.staleReason);

const EX1C = S.createExam({ id: 'V1', title: '卷一', schemaVersion: S.SCHEMA_VERSION, questions: [EX1.questions[0], EX1.questions[1], EX1.questions[3]] },
                          { now: '2026-10-03T00:00:00.000Z' });
const dGone = W.detailOf(r1.collected.book, 'V1-q3', { exam: EX1C });
eq([dGone.ok, dGone.inExam, dGone.stale, dGone.jump, dGone.question], [true, false, true, null, null],
   '题被删了 → `stale` 且 `jump=null`（**不能**跳到一道不存在的题）');
eq(dGone.snapshot.stem, '卷一·多选一', '  快照仍在（历史记录不许因为卷子改了而消失）');
eq(W.jumpTarget(r1.collected.book, 'V1-q3', { exam: EX1C }).reason, 'not-in-exam', '跳转明确拒绝并给原因');

/* ============================================================ */
head('③-A 跳转目标：逐题核对 `{examId, index}` 指向卷内那一题');

const jumpBad = [];
EX1.questions.forEach(function (q, i) {
  const t = W.jumpTarget(r1.collected.book, q.id, { exam: EX1 });
  if (!t.ok) { if (r1.collected.book.entries[q.id]) jumpBad.push([q.id, 'book 里有却跳不了']); return; }
  if (t.examId !== 'V1' || t.index !== i || EX1.questions[t.index].id !== q.id) jumpBad.push([q.id, t]);
});
eq(jumpBad, [], '卷内四题逐题核对：跳转目标都指向**卷内正确下标**的那道题');
eq(W.jumpTarget(r1.collected.book, 'V1-q3', { exam: EX1 }), { ok: true, examId: 'V1', index: 2, title: '卷一' },
   '（样例）多选那条跳到 卷一 的第 2 号下标（界面显示为第 3 题）');
eq(W.jumpTarget(r1.collected.book, 'V1-q2', { exam: EX1 }).ok, false, '不在本子里的题 → 跳不了（明确失败）');

head('③-B 跨卷不串：卷一的目标永远是卷一');

const cross = ['V2-q2'].map(function (qid) {
  const t = W.jumpTarget(r2.collected.book, qid, { exam: EX2 });
  return [t.examId, EX2.questions[t.index].id];
});
eq(cross, [['V2', 'V2-q2']], '卷二那条跳的是卷二自己的题（不串到卷一）');

/* ============================================================ */
head('整体验收：从存储读回后分组/详情/跳转仍然一致 + 真实样卷也能跑');

const reloaded = await W.loadAll(store, ['V1', 'V2', 'V3']);
eq(reloaded.map(b => b.examId).sort(), ['V1', 'V2', 'V3'], '从存储里读回三本（loadAll）');
const gs2 = W.groups(reloaded.map(function (b) {
  return { book: b.book, exam: ({ V1: EX1, V2: EX2, V3: EA })[b.examId] };
}));
// 分组按"最近更新"倒序（V3 最后动过 → 排最前）；V3 是 4 条（第一轮未作答的 q3/q4 也进本）
eq(gs2.map(g => [g.examId, g.total]), [['V3', 4], ['V2', 1], ['V1', 3]],
   '读回后：分组顺序按最近更新倒序、每组题数与落盘前一致（V3=4 / V2=1 / V1=3）');
const dRe = W.detailOf(reloaded.filter(b => b.examId === 'V1')[0].book, 'V1-q3', { exam: EX1 });
eq([dRe.question.stem, dRe.question.answerText, dRe.jump.index], [qMul.stem, 'A、B', 2],
   '  读回后的详情与跳转也一致（落盘→读回没有走样）');

/* 真实样卷也跑一遍（旁证：这条路对真数据同样成立） */
const parsed = await P.parseDocx(readSample());
const REAL = S.createExam({ id: 'REAL', title: '内置样卷', schemaVersion: S.SCHEMA_VERSION,
                            questions: parsed.questions.map(q => S.createQuestion(q)) }, { now: '2026-10-04T00:00:00.000Z' });
const rReal = await roundFor(store, REAL, { [REAL.questions[0].id]: 'Z' }, '2026-10-04T09:00:00.000Z', 'R1');
const gReal = W.groups([{ book: rReal.collected.book, exam: REAL }])[0];
eq(gReal.total, REAL.questions.length, '真实样卷：只答错第 1 题 → 其余（未作答）全进本，组内题数 = ' + gReal.total);
const dReal = W.detailOf(rReal.collected.book, REAL.questions[3].id, { exam: REAL });
eq([dReal.inExam, dReal.index, dReal.question.stem === REAL.questions[3].stem], [true, 3, true],
   '  第 4 题的详情来自样卷本体（题干逐字一致）');
ok(gReal.entries.every(e => e.times >= 1), '  每条都带次数（列表能显示）');

console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
console.log('  PASS ' + pass + '    FAIL ' + fail);
if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
console.log('  \x1b[90m注：列表/详情的点击观感属真浏览器 → 见 浏览器自检.html 的 M 节\x1b[0m');
process.exitCode = fail ? 1 : 0;
}

main().catch(e => { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
