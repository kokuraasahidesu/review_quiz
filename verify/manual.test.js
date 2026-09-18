/* ============================================================
 *  verify/manual.test.js —— 「简答人工订正」小类验收（本大类最后一个小类）
 *
 *  运行： node verify/manual.test.js
 *
 *  三条盘档验收标准，逐条对应：
 *    ① 改判后该题得分与整卷总分、百分比、等级同步更新（固定样本可断言）
 *    ② 改判记录可见，能区分哪些题是人工订正过的
 *    ③ 订正不会影响其他题目的得分，也不会改写原始关键词配置
 *
 *  三条反空转设计：
 *    · ① 用**改判会同步整卷**的样本（65.4% → 76.9%），并配"撤销后必须回到原值"的反向对照，并配"撤销后必须回到原值"的反向对照；
 *    · ② 断言"痕迹"里有**改了什么**（命中了哪几个词、分数、备注），不只是"有个标记"；
 *    · ③ 其余题的 per 明细**逐字段深比较**（连 detail 都比），并深比较题目对象本身（关键词没被改写）。
 * ============================================================ */
const A = require('../core/attempt.js');
const Q = require('../core/quiz.js');
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

/* 与上一小类同一份固定样本：单选 2+2、判断 1、多选 3、简答 5 → 满分 13
 * 作答：对 / 错 / 对 / 半对 / 中 2/3 → 8.5 分、65.4%、及格（60/85 线） */
function makePaper() {
  return [
    S.createQuestion({ id: 'r1', type: '单选', stem: '单选一', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['A'] }),
    S.createQuestion({ id: 'r2', type: '单选', stem: '单选二', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['A'] }),
    S.createQuestion({ id: 'r3', type: '判断', stem: '判断一', judgeValue: true }),
    S.createQuestion({ id: 'r4', type: '多选', stem: '多选一', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }, { label: 'C', text: 'c' }], answerLetters: ['A', 'B'] }),
    S.createQuestion({ id: 'r5', type: '简答', stem: '简答一', keywords: [{ text: '甲' }, { text: '乙' }, { text: '丙' }] })
  ];
}
function finishedPaper(configPatch) {
  const QS = makePaper();
  const s = A.createSession({ title: '固定样本卷', questions: QS, config: cfg(configPatch) });
  ['A', 'B', '√', 'A', '甲 乙'].forEach(function (v, i) { A.goto(s, i); A.answer(s, v); A.submitCurrent(s); });
  A.finish(s);
  return s;
}

/* ============================================================ */
head('①-A 改判前：固定样本是 8.5 / 13 = 65.4% 及格');

const s = finishedPaper(null);
const before = A.resultModel(s);
eq([before.score, before.full, before.percent, before.level, before.correctCount], [8.5, 13, 65.4, '及格', 2],
   '改判前：8.5/13、65.4%、及格、正确 2 题（半对固定给 2 分）');
eq(before.manualCount, 0, '  还没有任何人工订正');

head('①-B 直接给分改判 → 该题 + 总分 + 百分比 + 等级**同步**更新');

const r1 = A.applyManual(s, 4, { score: 5, note: '要点丙其实答到了' });
eq([r1.ok, r1.auto.score, r1.after.score], [true, 3.5, 5], '简答从自动 3.5 → 人工 5 分');
const after = A.resultModel(s);
eq([after.score, after.full, after.percent, after.level], [10, 13, 76.9, '及格'],
   '整卷同步：10/13 = **76.9%**（改判的 5 分确实进了总分）');
eq(after.correctCount, 3, '  正确题数也跟着变（简答订正为满分 → 算对）');
eq(after.manualCount, 1, '  成绩单里出现"人工订正 1 题"');
eq(after.manualLabels, ['5'], '  并点名是第 5 题（验收②：能区分哪些题被订正过）');
eq(s.summary.per[4].score, 5, '  逐题明细里第 5 题也是 5 分');
eq(s.summary.per[4].manual, true, '  并在 per 明细上打了 manual 标记');

head('①-C 撤销订正 → 必须回到原值（反向对照，证明上面不是"改了就回不去"）');

const undo = A.clearManual(s, 4);
eq(undo.ok, true, '撤销成功');
const back = A.resultModel(s);
eq([back.score, back.percent, back.level, back.correctCount, back.manualCount],
   [8.5, 65.4, '及格', 2, 0], '撤销后：8.5 / 65.4% / 及格 / 正确 2 / 订正 0 —— 与改判前逐项一致');
// ⚠ 这里必须**另外**看回看卡片：整卷总分由 scoreExam 从 answers+config 重算（很稳健），
//   而卡片读的是 session.results —— 撤销时若不把 results 恢复成自动分，卡片会继续显示人工分。
const cardAfterUndo = A.reviewList(s)[4];
eq([cardAfterUndo.score, cardAfterUndo.manual], [3.5, null],
   '  回看卡片也回到自动分 3.5，且 manual 痕迹已清空（不留"人工分"在卡片上）');

head('①-D 标记关键词命中 → 也算改判（走的是同一套算分公式）');

const s2 = finishedPaper(null);
const r2 = A.applyManual(s2, 4, { hits: ['丙'] });
eq([r2.ok, r2.after.score], [true, 5], '把「丙」标为命中 → 3/3 命中 → 5 分满分');
eq(r2.after.detail.manualHits, ['丙'], '  明细里记下"哪几个词是人工算命中"的');
eq([A.resultModel(s2).percent, A.resultModel(s2).level], [76.9, '及格'], '  整卷同步到 76.9% / 及格');

const s3 = finishedPaper(null);
const r3 = A.applyManual(s3, 4, { hits: ['乙', '丙'] });
eq([r3.after.score, r3.after.detail.hitCount, r3.after.detail.total], [5, 3, 3],
   '再多标一个（乙+丙）→ 命中 3/3 → 仍是满分（人工标记与自动命中合并后不重复计）');
const s4 = finishedPaper(null);
const r4 = A.applyManual(s4, 4, { hits: ['不存在的关键词'] });
eq([r4.ok, r4.after.score], [true, 3.5], '标一个不存在的词 → 不影响命中率（仍 3.5 分），但痕迹照样记下');

head('①-E 分数被夹在 [0, 满分] 且仍是半步粒度（改造分不许绕过既有约束）');

const s5 = finishedPaper(null);
eq(A.applyManual(s5, 4, { score: 99 }).after.score, 5, '给 99 分 → 夹到满分 5');
const s6 = finishedPaper(null);
eq(A.applyManual(s6, 4, { score: -3 }).after.score, 0, '给 -3 分 → 夹到 0');
const s7 = finishedPaper(null);
eq(A.applyManual(s7, 4, { score: 2.3 }).after.score, 2.5, '给 2.3 分 → 归到半步 2.5');
eq(Q.scoreExam(s7.questions, s7.answers, s7.config, { manual: s7.manual }).score, A.resultModel(s7).score,
   '  整卷重算与 resultModel 用同一条路（相邻锚）');

head('①-F 没有关键词的简答也能人工给分（自动判不了，人能给）');

const QS8 = makePaper();
QS8[4] = S.createQuestion({ id: 'r5', type: '简答', stem: '没有采分关键词', keywords: [] });
const s8 = A.createSession({ title: 'x', questions: QS8, config: cfg({}) });
['A', 'B', '√', 'A', '随便写'].forEach(function (v, i) { A.goto(s8, i); A.answer(s8, v); A.submitCurrent(s8); });
A.finish(s8);
eq([A.resultModel(s8).score, s8.summary.per[4].detail.unscorable], [5, 'noKeywords'], '改判前：简答不可自动判分、整卷 5 分（2+0+1+2）');
const r8 = A.applyManual(s8, 4, { score: 4 });
eq([r8.ok, A.resultModel(s8).score, A.resultModel(s8).percent], [true, 9, 69.2], '人工给 4 分 → 整卷 5 → 9 分（69.2%）');

/* ============================================================ */
head('②-A 痕迹可见：改了什么、改前多少、改后多少、谁改的（备注）');

const s9 = finishedPaper(null);
A.applyManual(s9, 4, { hits: ['丙'], score: 4.5, note: '第 3 个要点写到了但表述不同', at: '2026-09-19T12:00:00.000Z' });
const rec = s9.manual.r5;
eq([rec.hits, rec.score, rec.note, rec.at], [['丙'], 4.5, '第 3 个要点写到了但表述不同', '2026-09-19T12:00:00.000Z'],
   '订正记录里有：标为命中的词、指定分数、备注、时间');
const look = A.reviewList(s9)[4];
eq([look.manual ? true : false, look.autoScore, look.manualScore], [true, 3.5, 4.5],
   '回看模型里能同时看到"自动 3.5"与"人工 4.5"（对照展示）');
eq([look.autoDetail.hitCount, look.detail.hitCount], [2, 3], '  自动明细（命中 2）与订正后明细（命中 3）分别留档');
eq(A.reviewList(s9).filter(function (x) { return x.manual; }).map(function (x) { return x.label; }), ['5'],
   '  只有第 5 题被标为人工订正（其余题 manual 为空）');
eq(A.reviewList(s9).slice(0, 4).map(function (x) { return x.manual; }), [null, null, null, null],
   '  前四题都没有订正痕迹');

head('②-B 非简答题不许改判（客观题由规则判分，人工改会失去意义）');

['r1', 'r3', 'r4'].forEach(function (id, k) {
  const idx = ['r1', 'r2', 'r3', 'r4'].indexOf(id);
  const rr = A.applyManual(s9, idx, { score: 999 });
  eq([rr.ok, /只有简答题/.test(rr.error || '')], [false, true], '改判 ' + id + '（' + ['单选', '单选', '判断', '多选'][idx] + '）被拒绝并说明原因');
});
const emptyPatch = A.applyManual(s9, 4, {});
eq([emptyPatch.ok, /要么/.test(emptyPatch.error || '')], [false, true],
   '（顺带）对简答提交空改判（既没标词也没给分）也被拒绝');
eq(A.clearManual(s9, 0).ok, false, '撤销一个没订正过的题 → 明确失败');

/* ============================================================ */
head('③-A 订正**只动这一题**：其余题的 per 明细逐字段不变（连 detail 都比）');

const s10 = finishedPaper(null);
const snapshot = function (ses) {
  return JSON.stringify(ses.summary.per.filter(function (p) { return p.id !== 'r5'; }));
};
const othersBefore = snapshot(s10);
const totalBefore = s10.summary.full;
A.applyManual(s10, 4, { score: 5 });
eq(snapshot(s10), othersBefore, '改判后其他四题的 per 明细**逐字段完全相同**（含 detail）');
eq(s10.summary.full, totalBefore, '  满分不变（改判不该改变分母）');
eq(s10.summary.per.filter(function (p) { return p.manual; }).map(function (p) { return p.id; }), ['r5'],
   '  只有被改判的那题带 manual 标记');
eq([s10.results.r1.score, s10.results.r2.score, s10.results.r3.score, s10.results.r4.score], [2, 0, 1, 2],
   '  其他题的判分结果对象也没被动过');

head('③-B 不改写原始关键词配置，也不改配置与作答');

const s11 = finishedPaper(null);
const paper = s11.questions;
const kwBefore = JSON.stringify(paper[4].keywords);
const paperBefore = JSON.stringify(paper);
const cfgBefore = JSON.stringify(s11.config);
const ansBefore = JSON.stringify(s11.answers);
A.applyManual(s11, 4, { hits: ['丙'], score: 4 });
eq(JSON.stringify(paper[4].keywords), kwBefore, '关键词数组**逐字段不变**（人工标记只活在订正记录里）');
eq(JSON.stringify(paper), paperBefore, '  整份题目对象都没被改写');
eq(JSON.stringify(s11.config), cfgBefore, '  配置没被改写（改判不是"改配置"）');
eq(JSON.stringify(s11.answers), ansBefore, '  用户的原始作答也没被改写');
eq(s11.manual.r5.hits, ['丙'], '  人工标记只记在 session.manual 里');

head('③-C 同一道题改判两次：以最后一次为准（不叠加、不留矛盾）');

const s12 = finishedPaper(null);
A.applyManual(s12, 4, { hits: ['丙'] });          // 补一个命中 → 简答满分 5 → 整卷 10（5+5）
const mid = A.resultModel(s12).score;
A.applyManual(s12, 4, { score: 2 });              // 再直接给 2 分 → 整卷 7（5+2）
eq([mid, A.resultModel(s12).score, A.manualCount(s12)], [10, 7, 1],
   '先标词（整卷 10 分）再直接给 2 分（整卷 7 分）→ 以最后一次为准，订正记录仍是 1 条');
eq([s12.manual.r5.score, s12.manual.r5.hits], [2, []],
   '  记录被**整体替换**（不做增量合并）：hits 清空、score=2 —— 界面每次都把当前勾选一起提交');

head('③-D 订正与"未交卷"的关系：未交卷也能改判（还没结算），但成绩单要等交卷');

const s13 = A.createSession({ title: 'x', questions: makePaper(), config: cfg({}) });
['A', 'B', '√', 'A', '甲 乙'].forEach(function (v, i) { A.goto(s13, i); A.answer(s13, v); });
A.goto(s13, 4); A.submitCurrent(s13);
eq(A.applyManual(s13, 4, { score: 5 }).ok, true, '未交卷时也能对已提交的简答改判');
eq(A.resultModel(s13), null, '  但成绩单仍未生成（没交卷就没有结算）');
eq(A.finish(s13, { confirmUnanswered: true }).ok, true, '  交卷后');
eq([A.resultModel(s13).score, A.resultModel(s13).manualCount], [10, 1], '  结算时**把已有的订正一起算进去**（5+5=10 分、1 题订正过）');

head('③-E 订正痕迹要能过"刷新"这一关（跨小类一致性：进度载荷必须带上 manual/auto）');

const D = require('../core/data.js');
const W = (function () {
  const m = new Map();
  const sm = { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k), key: () => null, get length() { return m.size; } };
  return D.createStore({ small: sm, large: null, namespace: 'app' });
})();

async function refreshCheck() {
  const s14 = finishedPaper(null);
  A.applyManual(s14, 4, { hits: ['丙'], score: 4.5, note: '第三点写到了' });
  const psA = A.createProgressStore(W, { examId: 'M1' });
  await psA.save(s14);
  const s15 = A.createSession({ examId: 'M1', title: '固定样本卷', questions: makePaper(), config: cfg({}) });
  const got = await psA.load(s15.questions);
  const r = A.restoreProgress(s15, got.payload);
  eq(r.ok, true, '恢复成功（同一后端 + 新会话 = 刷新）');
  eq(s15.manual.r5, { hits: ['丙'], score: 4.5, note: '第三点写到了', at: '' },
     '**人工订正记录跟着进度一起回来了**（否则刷新会悄悄丢掉改判、而 checked 还在）');
  eq([s15.results.r5.score, A.reviewList(s15)[4] ? null : null], [4.5, null],
     '  已提交题的 results 是按"带订正"的口径重算的（不是自动分 3.5）');
  A.finish(s15, { confirmUnanswered: true });
  eq([A.resultModel(s15).score, A.resultModel(s15).manualCount],
     [8.5 - 3.5 + 4.5, 1], '  刷新后结算：总分按订正后的 4.5 算（' + A.resultModel(s15).score + '）、订正 1 题');
}
const refreshP = refreshCheck();

refreshP.then(function () {
head('③-F 解锁重做必须连订正痕迹一起清（否则卡片与总分分叉）');

const s16 = finishedPaper(null);
A.applyManual(s16, 4, { score: 5 });
eq(A.resultModel(s16).score, 10, '先改判为满分（整卷 10 分）');
const rs = A.reset(s16, 4);
eq([rs.ok, rs.clearedManual], [true, true], 'reset() 解锁这一题，并报告"连人工订正一起清掉了"');
A.goto(s16, 4); A.answer(s16, '毫不沾边'); A.submitCurrent(s16);
A.finish(s16, { confirmUnanswered: true });
eq([s16.manual.r5, s16.summary.manualCount], [undefined, 0], '  重做后订正痕迹不再赖着（manual 里没有它）');
eq([s16.results.r5.score, A.reviewList(s16)[4].score, s16.summary.per[4].score], [0, 0, 0],
   '  卡片 / 回看 / 整卷明细**三处都是重做后的 0 分**（不再出现"卡片 0 分、总分按旧人工分"）');

head('③-G 没作答的题不给订正（成绩单不许自相矛盾）');

const s17 = A.createSession({ title: 'x', questions: makePaper(), config: cfg({}) });
A.goto(s17, 0); A.answer(s17, 'A'); A.submitCurrent(s17);
const blank = A.applyManual(s17, 4, { score: 5 });
eq([blank.ok, blank.needAnswer, /还没作答/.test(blank.error || '')], [false, true, true],
   '对**完全没作答**的简答改判 → 拒绝并说明原因（否则成绩单会同时说"未答"又"订正过、有分"）');
A.goto(s17, 4); A.answer(s17, '甲');
eq(A.applyManual(s17, 4, { score: 5 }).ok, true, '  补上作答后就能订正了');

head('③-H 取消最后一个人工命中 = 撤销订正（不许静默失败）');

const s18 = finishedPaper(null);
const addHit = A.applyManual(s18, 4, { hits: ['丙'] });
eq([addHit.ok, addHit.after.detail.hitCount], [true, 3], '先标「丙」为命中 → 命中 3/3');
const undoToggle = A.applyManual(s18, 4, { hits: [] });       // 界面上"再点一下取消"
eq([undoToggle.ok, undoToggle.cleared, s18.manual.r5], [true, true, undefined],
   '把最后一个命中取消（hits:[] 且没给分）→ **等价撤销订正**（早先这里直接报错、界面点了没反应）');
eq(s18.results.r5.score, 3.5, '  分数回到自动口径 3.5');

console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
console.log('  PASS ' + pass + '    FAIL ' + fail);
if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
console.log('  \x1b[90m注：订正区的点击观感属真浏览器 → 见 浏览器自检.html 的 K 节\x1b[0m');
process.exitCode = fail ? 1 : 0;
}).catch(function (e) { console.error('崩了(异步段): ' + (e && e.stack || e)); process.exit(2); });
