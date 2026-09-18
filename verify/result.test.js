/* ============================================================
 *  verify/result.test.js —— 「成绩结算」小类验收
 *
 *  运行： node verify/result.test.js
 *
 *  三条盘档验收标准，逐条对应：
 *    ① 总分、满分、百分比、正确题数均与实际作答一致（固定样本可复现断言）
 *    ② 等级定档严格按分数线：达到优秀线为优秀、达到及格线为及格、其余不及格
 *       （**边界值等于分数线时归入该档**）
 *    ③ 交卷后可逐题回看，显示用户作答、正确答案与得分
 *
 *  三条反空转设计：
 *    · ① 用**手算得出的固定样本**（每题分值、对错都写死在测试里），
 *      并与 scoreExam 逐字段对锚 —— 不是把实现结果抄成期望值；
 *    · ② 用**同一份答卷**配不同分数线（含 ±0.1 边界逐点），证明"等级确实由线决定"，
 *      再配"降线后同一答卷升档"的反向对照；
 *    · ③ 回看模型逐题核对四型（含未答题、含答错的命中明细），
 *      并断言"未交卷时回看列表为空"（不许答题期间就能回看答案）。
 * ============================================================ */
const A = require('../core/attempt.js');
const Q = require('../core/quiz.js');
const F = require('../core/flow.js');
const S = require('../core/schema.js');

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

/* ---------- 固定样本：分值手写死在测试里，便于手算核对 ----------
 * 单选 2 分 ×2、判断 1 分 ×1、多选 3 分 ×1、简答 5 分 ×1  → 满分 2+2+1+3+5 = 13
 * 作答：单选1 对(2)、单选2 错(0)、判断 对(1)、多选 只中一半(**半对固定给 2 分**)、简答 中 2/3(5×2/3=3.33→3.5)
 * 合计 = 2 + 0 + 1 + 2 + 3.5 = 8.5 分；正确题数 = 2（单选1、判断） */
const QS = [
  S.createQuestion({ id: 'r1', type: '单选', stem: '单选一', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['A'] }),
  S.createQuestion({ id: 'r2', type: '单选', stem: '单选二', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['A'] }),
  S.createQuestion({ id: 'r3', type: '判断', stem: '判断一', judgeValue: true }),
  S.createQuestion({ id: 'r4', type: '多选', stem: '多选一', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }, { label: 'C', text: 'c' }], answerLetters: ['A', 'B'] }),
  S.createQuestion({ id: 'r5', type: '简答', stem: '简答一', keywords: [{ text: '甲' }, { text: '乙' }, { text: '丙' }] })
];
const ANSWERS = { r1: 'A', r2: 'B', r3: '√', r4: 'A', r5: '甲 乙' };
function finishedSession(configPatch) {
  const s = A.createSession({ title: '固定样本卷', questions: QS, config: cfg(configPatch) });
  A.answer(s, ANSWERS.r1); A.submitCurrent(s); A.next(s);
  A.answer(s, ANSWERS.r2); A.submitCurrent(s); A.next(s);
  A.answer(s, ANSWERS.r3); A.submitCurrent(s); A.next(s);
  A.answer(s, ANSWERS.r4); A.submitCurrent(s); A.next(s);
  A.answer(s, ANSWERS.r5); A.submitCurrent(s);
  A.finish(s);
  return s;
}

/* ============================================================ */
head('①-A 手算固定样本：总分 8.5 / 满分 13 / 百分比 65.4 / 正确 2 题');

const s1 = finishedSession(null);
const R1 = A.resultModel(s1);
eq([R1.score, R1.full, R1.percent, R1.correctCount, R1.total], [8.5, 13, 65.4, 2, 5],
   '成绩单四项与手算一致（合计 2+0+1+2+3.5 = 8.5；满分 2+2+1+3+5 = 13）');
const per = s1.summary.per.map(p => p.score);
eq(per, [2, 0, 1, 2, 3.5], '逐题得分与手算一致：' + JSON.stringify(per));
eq(s1.summary.per.map(p => p.correct), [true, false, true, false, false], '逐题对错标记一致');

head('①-B 相邻锚：成绩单的每个数字都来自 scoreExam（本层只做编排）');

const direct = Q.scoreExam(QS, s1.answers, s1.config);
eq([R1.score, R1.full, R1.percent, R1.correctCount, R1.total],
   [direct.score, direct.full, direct.percent, direct.correctCount, direct.total],
   '四项与直接调 scoreExam **完全一致**');
eq(R1.byType.length, 4, '按题型汇总有 4 组');
const byTypeMap = {};
R1.byType.forEach(t => byTypeMap[t.type] = t);
eq([byTypeMap['单选'].score, byTypeMap['单选'].full, byTypeMap['单选'].correct, byTypeMap['单选'].total], [2, 4, 1, 2],
   '单选：得 2 / 满 4，对 1 / 2');
eq([byTypeMap['判断'].score, byTypeMap['判断'].full], [1, 1], '判断：得 1 / 满 1');
eq([byTypeMap['多选'].score, byTypeMap['多选'].full], [2, 3], '多选：得 2（半对固定给分）/ 满 3');
eq([byTypeMap['简答'].score, byTypeMap['简答'].full, byTypeMap['简答'].rate], [3.5, 5, 70], '简答：得 3.5 / 满 5 → 70%');
eq(R1.byType.reduce((s, t) => s + t.score, 0), 8.5, '按题型汇总的分数之和 = 总分（没有漏题、没有重复计）');
eq(R1.byType.map(t => t.total).reduce((a, b) => a + b, 0), 5, '按题型汇总的题数之和 = 总题数');

head('①-C 全对 / 全错 / 全未答 三个极端也要对得上');

const allRight = A.createSession({ title: '全对', questions: QS, config: cfg({}) });
[['r1', 'A'], ['r2', 'A'], ['r3', '√'], ['r4', 'AB'], ['r5', '甲 乙 丙']].forEach(function (p, i) {
  A.goto(allRight, i); A.answer(allRight, p[1]);
});
eq(A.finish(allRight).ok, true, '全对卷交卷');
eq([A.resultModel(allRight).score, A.resultModel(allRight).full, A.resultModel(allRight).percent, A.resultModel(allRight).level],
   [13, 13, 100, '优秀'], '全对：13/13、100%、优秀、正确 5 题',
   );
eq(A.resultModel(allRight).correctCount, 5, '  正确题数 = 5');

const allWrong = A.createSession({ title: '全错', questions: QS, config: cfg({}) });
[['r1', 'B'], ['r2', 'B'], ['r3', '×'], ['r4', 'C'], ['r5', '毫不沾边']].forEach(function (p, i) {
  A.goto(allWrong, i); A.answer(allWrong, p[1]);
});
eq(A.finish(allWrong).ok, true, '全错卷交卷（五题都作答了，门禁放行）');
eq([A.resultModel(allWrong).score, A.resultModel(allWrong).correctCount], [0, 0], '全错：0 分、正确 0 题',
   );
eq(A.resultModel(allWrong).percent, 0, '  百分比 0');

const none = A.createSession({ title: '全未答', questions: QS, config: cfg({}) });
const gNone = A.finish(none);
eq([gNone.ok, gNone.needConfirm], [false, true], '全未答：门禁拦下（不结算）');
const forced = A.finish(none, { confirmUnanswered: true });
eq([forced.ok, A.resultModel(none).score, A.resultModel(none).answered, A.resultModel(none).skipped],
   [true, 0, 0, ['1', '2', '3', '4', '5']], '强制交卷：0 分、已答 0、跳过的题号 1~5 全列出',
   );

/* ============================================================ */
head('②-A 定档严格按分数线（**边界值等于分数线时归入该档**）');

const gBase = { pass: 60, excellent: 85 };
// 用同一份答卷，只改分数线 —— 等级必须由线决定
const testScores = [59.9, 60, 60.1, 84.9, 85, 85.1];
const bandFor = function (p) {
  const c = cfg({ grade: gBase });
  return F.gradeLevel(p, c).level;
};
eq(testScores.map(bandFor), ['不及格', '及格', '及格', '及格', '优秀', '优秀'],
   '60/85 线下逐点：59.9 不及格、**60 及格（等于线归入该档）**、84.9 及格、**85 优秀（等于线归入该档）**、85.1 优秀');
eq([F.gradeLevel(0, cfg({ grade: gBase })).level, F.gradeLevel(100, cfg({ grade: gBase })).level], ['不及格', '优秀'],
   '两端点：0 分不及格、100 分优秀');

head('②-B 同一份答卷 × 四套分数线 → 等级随之变化（证明定档真由线决定）');

const sBase = finishedSession(null);                       // 65.4% 那一份
const levelUnder = function (patch) {
  const s = A.createSession({ title: 'x', questions: QS, config: cfg(patch) });
  Object.keys(ANSWERS).forEach(function (id, i) { A.goto(s, i); A.answer(s, ANSWERS[id]); });
  A.finish(s);
  return A.resultModel(s).level;
};
eq(levelUnder({ grade: { pass: 70, excellent: 85 } }), '不及格', '65.4% + 70/85 线 → 不及格（及格线抬到 70）');
eq(levelUnder({ grade: { pass: 50, excellent: 80 } }), '及格', '65.4% + **50**/80 线 → 及格（及格线降到 50）');
eq(levelUnder({ grade: { pass: 50, excellent: 65.4 } }), '优秀', '65.4% + 50/**65.4** 线 → 优秀（**等于优秀线归入优秀**）');
eq(levelUnder({ grade: { pass: 65.5, excellent: 90 } }), '不及格', '65.4% + **65.5**/90 线 → 不及格（差 0.1 分不达线）');
eq(A.resultModel(sBase).level, '及格', '原始那一份是"及格"（没有被上面的对照改掉）');
eq([A.resultModel(sBase).pass, A.resultModel(sBase).excellent], [60, 85], '成绩单里带上当前分数线（用户看得见按什么定的档）');
ok(/离优秀线还差 19\.6 分/.test(A.resultModel(sBase).note), '  及格时给出"离优秀线还差多少"', A.resultModel(sBase).note);

head('②-C 分数线非法时不许悄悄定档（相邻锚：走的是配置校验那道门）');

eq(S.validateExam({ id: 'e', title: 't', schemaVersion: 1, config: { grade: { pass: 90, excellent: 60 } } }).ok, true,
   '（整卷校验只管结构，不管数值 —— 数值门在 config 校验里）');
eq(Q.validateConfig(cfg({ grade: { pass: 90, excellent: 60 } })).errors.map(e => e.code), ['E_CFG_RANGE_INVERTED'],
   '分数线颠倒 → E_CFG_RANGE_INVERTED（由既有配置校验拦下，本层不重复实现）');

/* ============================================================ */
head('③-A 逐题回看：用户作答 / 正确答案 / 得分 三样齐全（四型逐题核对）');

const list = A.reviewList(s1);
eq(list.length, 5, '回看列表 = 5 题');
eq(list.map(r => r.label), ['1', '2', '3', '4', '5'], '题号 1..5');
eq(list[0], Object.assign({}, list[0], {
  stem: '单选一', typeLabel: '单选题', userAnswer: 'A', correctAnswer: 'A', correct: true, score: 2, full: 2, answered: true
}), '第 1 题（单选对）：用户作答 A、正确答案 A、得分 2/2、correct=true');
eq([list[1].userAnswer, list[1].correctAnswer, list[1].score, list[1].correct], ['B', 'A', 0, false],
   '第 2 题（单选错）：你答 B、正确答案 A、得 0 分');
eq([list[2].userAnswer, list[2].correctAnswer, list[2].score], ['对（√）', '对（√）', 1], '第 3 题（判断对）：作答与答案都是"对（√）"');
eq([list[3].userAnswer, list[3].correctAnswer, list[3].score, list[3].detail.hit, list[3].detail.miss],
   ['A', 'A、B', 2, ['A'], ['B']], '第 4 题（多选半对）：你答 A、正确答案 A、B；明细 命中[A] 未命中[B]，半对固定给 2 分');
eq([list[4].userAnswer, list[4].correctAnswer, list[4].score, list[4].detail.hit, list[4].detail.miss],
   ['甲 乙', '甲、乙、丙', 3.5, ['甲', '乙'], ['丙']], '第 5 题（简答）：你答"甲 乙"、正确答案三关键词、得 3.5 分、命中 2 未中 1');

head('③-B 回看里的"未作答"与多行简答都要如实显示');

const s2 = A.createSession({ title: 'U', questions: QS, config: cfg({}) });
A.goto(s2, 0); A.answer(s2, 'A');
A.goto(s2, 4); A.answer(s2, '第一行要点\n第二行要点');
A.finish(s2, { confirmUnanswered: true });
const list2 = A.reviewList(s2);
eq([list2[0].answered, list2[0].userAnswer], [true, 'A'], '答过的题：answered=true 且带上作答');
eq([list2[1].answered, list2[1].userAnswer, list2[1].score], [false, '', 0], '**没答的题：answered=false、作答显示为空、0 分**');
eq(list2[4].userAnswer, '第一行要点\n第二行要点', '简答题的多行作答在回看里**原样保留**');
eq(list2.map(r => r.correct), [true, false, false, false, false], '对错标记：只有第 1 题算对（其余未答/未中）');
eq(list2.filter(r => !r.answered).map(r => r.label), ['2', '3', '4'], '未答题号一眼可数：2、3、4');

head('③-C 未交卷时**不许**回看（否则等于答题期间就能看答案）');

const live = A.createSession({ title: 'L', questions: QS, config: cfg({}) });
A.answer(live, 'A'); A.submitCurrent(live);
eq(A.reviewList(live), [], '未交卷 → 回看列表为空（哪怕已经提交过某题）');
eq(A.resultModel(live), null, '  成绩单也是 null');
eq(A.reviewList(live).length === 0 && A.resultModel(live) === null, true,
   '  必须交卷后才能回看/结算（与"答题期间不泄露答案"同一条规矩）');

head('③-D 边界：空卷的成绩单不崩');

const empty = A.createSession({ title: 'E', questions: [], config: cfg({}) });
A.finish(empty);
const RE = A.resultModel(empty);
eq([RE.score, RE.full, RE.percent, RE.correctCount, RE.total, RE.byType], [0, 0, 0, 0, 0, []],
   '空卷：0/0、0%、正确 0、汇总为空数组（不崩）');
eq(A.reviewList(empty), [], '  回看列表为空');

console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
console.log('  PASS ' + pass + '    FAIL ' + fail);
if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
console.log('  \x1b[90m注：成绩页与回看卡片的观感属真浏览器 → 见 浏览器自检.html 的 K 节\x1b[0m');
process.exitCode = fail ? 1 : 0;
