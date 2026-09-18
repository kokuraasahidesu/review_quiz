/* ============================================================
 *  verify/nav.test.js —— 「题号导航」小类验收
 *
 *  运行： node verify/nav.test.js
 *
 *  三条盘档验收标准，逐条对应：
 *    ① 点击任意题号能准确定位到该题，当前题号高亮
 *    ② 已答/未答状态随作答实时更新且与实际一致
 *    ③ 存在未答题时交卷会给出提示，可选择返回继续或确认交卷
 *
 *  三条反空转设计：
 *    · ①"定位准确"逐题遍历（1..N 每一格都点一次，核对跳到的就是那一题），
 *      并配"来回跳"对照 —— 否则一个只会 goto(0) 的实现也能过抽查；
 *    · ②状态与 isAnswered 逐格交叉核对，且**改一道题的作答就要看到那格变**（实时性）；
 *    · ③交卷门禁三段式：未答 → 拒绝并列出题号；"返回继续"后**会话与作答原封不动**；
 *      `confirmUnanswered` 才结算且 `forced=true`、`skipped` 记下题号。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const A = require('../core/attempt.js');
const Q = require('../core/quiz.js');
const F = require('../core/flow.js');
const S = require('../core/schema.js');
const P = require('../parser-core.js');

let pass = 0, fail = 0; const failures = [];
function brief(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return String(s);
  return s.length > 170 ? s.slice(0, 170) + '…(' + s.length + ' 字符)' : s;
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

async function main() {
const parsed = await P.parseDocx(readSample());
const BANK = parsed.questions.map(q => S.createQuestion(q));
/* 给每道题一个"能作答"的值（四型各自的合法作答） */
function answerWith(ses, q, correct) {
  if (q.type === '简答') return A.answer(ses, '甲 乙');
  if (q.type === '多选') return A.answer(ses, (q.answerLetters || []).slice().sort().join('') || 'A');
  if (q.type === '判断') return A.answer(ses, q.judgeValue === true ? (correct ? '√' : '×') : (correct ? '×' : '√'));
  return A.answer(ses, correct ? ((q.answerLetters || [])[0] || 'A') : 'Z'.replace('Z', 'D'));
}

/* ============================================================ */
head('①-A 题号索引：一格一题、编号正确、当前题只有一格高亮');

let s = A.createSession({ title: 'N', questions: BANK, config: cfg({}) });
const cells0 = A.navModel(s);
eq(cells0.length, BANK.length, '题号格子数 = 题目数（' + BANK.length + '）');
eq(cells0.map(c => c.label), BANK.map((q, i) => String(i + 1)), '编号是 1..N 的字符串（直接上界面）');
eq(cells0.map(c => c.index), BANK.map((q, i) => i), '每格带自己的下标（点击只认它）');
eq(cells0.filter(c => c.current).length, 1, '**当前题只有一格**');
eq(cells0.filter(c => c.current)[0].index, 0, '  初始当前题 = 第 1 题');
eq(cells0.map(c => c.state), ['current'].concat(BANK.slice(1).map(() => 'unanswered')),
   '初始状态：第 1 格 current，其余 unanswered');

head('①-B 点任意题号 → 准确定位（逐格遍历 + 来回跳对照）');

const visit = [];
for (let i = 0; i < BANK.length; i++) {
  const r = A.goto(s, i);
  visit.push({ 点: i + 1, ok: r.ok, viewIndex: A.view(s).index, current: A.current(s).id });
}
eq(visit.filter(v => !v.ok), [], '每一格都能点（' + visit.length + ' 格逐一点过）');
eq(visit.map(v => v.viewIndex), BANK.map((q, i) => i), '点第 k 格 → 视图 index 正好是 k-1（逐格核对，不是抽查）');
eq(visit.map(v => v.current), BANK.map(q => q.id), '  且 `current()` 拿到的就是那一题');
// 来回跳：最后 → 第一 → 中间 → 最后
[A.goto(s, BANK.length - 1), A.goto(s, 0), A.goto(s, Math.floor(BANK.length / 2)), A.goto(s, BANK.length - 1)]
  .forEach(function (r, k) { ok(r.ok, '  来回跳第 ' + (k + 1) + ' 次成功'); });
eq(A.view(s).index, BANK.length - 1, '来回跳之后停在最后一次点的题上');
eq(A.navModel(s).filter(c => c.current)[0].index, BANK.length - 1, '高亮也跟着走到那一格（唯一高亮）');
eq(A.goto(s, BANK.length).ok, false, '越界（点了不存在的第 N+1 题）明确失败，不静默跳到别处');
eq(A.view(s).index, BANK.length - 1, '  失败后仍停在原题（不产生副作用）');

head('①-C 高亮与"已答"是两个维度：当前题即使没答也高亮为 current');

A.goto(s, 2);
const st2 = A.navModel(s);
eq([st2[2].current, st2[2].answered, st2[2].state], [true, false, 'current'],
   '当前题未作答：current=true 且 state=current（高亮优先于"未答"底色）');

/* ============================================================ */
head('②-A 已答/未答逐格与 isAnswered 一致（改动即刻反映）');

let s2 = A.createSession({ title: 'R', questions: BANK, config: cfg({}) });
const mismatch0 = A.navModel(s2).filter(function (c) {
  return c.answered !== A.isAnswered(BANK[c.index], s2.answers[BANK[c.index].id]);
});
eq(mismatch0, [], '初始全"未答"：格子状态与 isAnswered 逐格一致');
eq(A.navModel(s2).filter(c => c.answered).length, 0, '  已答数为 0');
eq(A.progress(s2).unanswered, BANK.length, '  进度里的未答数也对得上');

// 实时性：答第 3 题 → 只有那一格变
A.goto(s2, 2); answerWith(s2, BANK[2], true);
const after3 = A.navModel(s2);
eq(after3[2].answered, true, '答完第 3 题 → **第 3 格立刻变已答**');
eq(after3.filter(c => c.answered).map(c => c.index), [2], '  而且只有第 3 格变（没有连坐）');
// 再答第 1 题
A.goto(s2, 0); answerWith(s2, BANK[0], true);
eq(A.navModel(s2).filter(c => c.answered).map(c => c.index), [0, 2], '再答第 1 题 → 已答集合 = [1,3]');
// 把第 3 题清空（模拟用户删掉作答）→ 状态要立刻退回去
A.reset(s2, 2); A.goto(s2, 2); A.answer(s2, '');
eq(A.navModel(s2)[2].answered, false, '把第 3 题清空 → 它立刻退回"未答"（状态是算出来的，不是记下来的）');
// 全部答一遍
BANK.forEach(function (q, i) { A.goto(s2, i); answerWith(s2, q, true); });
eq(A.navModel(s2).filter(c => c.answered).length, BANK.length, '全部作答后每一格都是已答');
eq(A.progress(s2).unanswered, 0, '  进度里的未答数 = 0');

head('②-B 提交状态与"对错标记"：提交可见、对错仅在允许揭示时才给（不泄露）');

let s3 = A.createSession({ title: 'C', questions: BANK.slice(0, 3), config: cfg({ reveal: { answerTiming: 'end', explainTiming: 'end' } }) });
A.goto(s3, 0); answerWith(s3, BANK[0], true); A.submitCurrent(s3);
const c30 = A.navModel(s3)[0];
eq([c30.checked, c30.revealed, c30.correct], [true, false, null],
   '时机=整卷后：格子能看出"已提交"，但**不给对错标记**（否则等于把每题对错提前漏出来）');
const s4 = A.createSession({ title: 'C2', questions: BANK.slice(0, 3), config: cfg({ reveal: { answerTiming: 'each', explainTiming: 'each' } }) });
A.goto(s4, 0); answerWith(s4, BANK[0], true); A.submitCurrent(s4);
const c40 = A.navModel(s4)[0];
eq([c40.checked, c40.revealed, c40.correct], [true, true, true], '时机=答完一题：已提交格子带上 ✓');
A.goto(s4, 1); answerWith(s4, BANK[1], false); A.submitCurrent(s4);
eq(A.navModel(s4)[1].correct, false, '  答错的格子带 ✗');
const fin = A.finish(s4, { confirmUnanswered: true });
eq(fin.ok, true, '交卷成功（跳过未答题）');
eq(A.navModel(s4).map(c => c.correct), [true, false, null],
   '整卷结束后：已提交的两格给出 ✓/✗，**没作答的那格不给对错**（它本来就没有判分结果，底色已经写着"未答"）');

/* ============================================================ */
head('③-A 交卷门禁：有未答题 → 拒绝结算并列出题号');

let s5 = A.createSession({ title: 'G', questions: BANK, config: cfg({}) });
A.goto(s5, 0); answerWith(s5, BANK[0], true);
A.goto(s5, 3); answerWith(s5, BANK[3], true);
const blocked = A.finish(s5);
eq([blocked.ok, blocked.needConfirm], [false, true], '有未答题直接交卷 → **不结算**，返回 needConfirm');
eq(blocked.unansweredLabels, BANK.map((q, i) => i).filter(i => i !== 0 && i !== 3).map(i => String(i + 1)),
   '  提示里列出**未答题号**（' + blocked.unansweredLabels.join('、') + '）');
ok(/还有 \d+ 题没有作答/.test(blocked.message), '  文案可读', blocked.message);
eq([s5.finished, s5.summary], [false, null], '  会话**没有被标记交卷**（还能继续答）');

head('③-B "返回继续"：会话与作答原封不动，答完后门禁自然放行');

const before = JSON.stringify({ answers: s5.answers, index: s5.index, finished: s5.finished });
eq(A.goto(s5, blocked.unanswered[0].index).ok, true, '选"返回继续" → 跳到第一道未答题');
answerWith(s5, BANK[blocked.unanswered[0].index], true);
BANK.forEach(function (q, i) { if (!A.isAnswered(q, s5.answers[q.id])) { A.goto(s5, i); answerWith(s5, q, true); } });
const now = A.finish(s5);
eq([now.ok, now.needConfirm === true], [true, false], '全部答完后交卷 → 直接结算，不再要确认');
eq(now.summary.unanswered, [], '  summary 里没有未答题');
eq(now.summary.forced, false, '  forced=false（不是"带未答硬交"）');
ok(before !== JSON.stringify({ answers: s5.answers, index: s5.index, finished: s5.finished }),
   '  反向对照：这期间会话确实变了（不是"永远不动所以看起来没变"）');

head('③-C "仍然交卷"：明确确认后才结算，且如实记下跳过了哪些题');

let s6 = A.createSession({ title: 'F', questions: BANK, config: cfg({}) });
A.goto(s6, 0); answerWith(s6, BANK[0], true);
const g6 = A.gate(s6);
eq(g6.ok, false, 'gate() 直接问"能不能交卷" → false');
const forced = A.finish(s6, { confirmUnanswered: true });
eq([forced.ok, forced.summary.forced], [true, true], 'confirmUnanswered=true → 结算，且 forced=true（如实标记"带未答交卷"）');
eq(forced.summary.skipped, g6.unansweredLabels, '  summary.skipped 与门禁列出的题号一致（' + forced.summary.skipped.join('、') + '）');
eq(forced.summary.answered, 1, '  已答 1 题 / 共 ' + BANK.length + ' 题');
const scored = Q.scoreExam(BANK, s6.answers, s6.config);
eq([forced.summary.score, forced.summary.full, forced.summary.percent],
   [scored.score, scored.full, scored.percent], '  分数仍是 scoreExam 的结果（没因为跳过而算错）');
eq(s6.finished, true, '  会话已标记交卷');

head('③-D 边界：空卷、全未答、全已答三种极端');

const empty = A.createSession({ title: 'E', questions: [] });
eq(A.navModel(empty), [], '空卷：题号格子为空数组');
eq([A.gate(empty).ok, A.finish(empty).ok], [true, true], '空卷：门禁放行、可直接交卷（0 题 0 分，不崩）');
eq(A.view(empty).progressText, '没有题目', '  渲染模型文案可读');

let s7 = A.createSession({ title: 'A', questions: BANK.slice(0, 4), config: cfg({}) });
A.goto(s7, 1); A.reset(s7, 1);
eq(A.gate(s7).unansweredLabels, ['1', '2', '3', '4'], '全未答：门禁列出 1~4');
eq(A.finish(s7).ok, false, '  全未答也不许悄悄交卷');

let s8 = A.createSession({ title: 'B', questions: BANK.slice(0, 4), config: cfg({}) });
BANK.slice(0, 4).forEach(function (q, i) { A.goto(s8, i); answerWith(s8, q, true); });
eq([A.gate(s8).ok, A.gate(s8).message], [true, ''], '全已答：门禁放行、无提示文案');
eq(A.navModel(s8).map(c => c.answered), [true, true, true, true], '  四格全为已答');

console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
console.log('  PASS ' + pass + '    FAIL ' + fail);
if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
console.log('  \x1b[90m注：格子可点/高亮观感/提示弹层属真浏览器 → 见 浏览器自检.html 的 K 节\x1b[0m');
process.exitCode = fail ? 1 : 0;
}

main().catch(e => { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
