/* ============================================================
 *  verify/attempt.test.js —— 「作答界面与触屏」小类验收（Node 侧部分）
 *
 *  运行： node verify/attempt.test.js
 *
 *  三条盘档验收标准，逐条对应：
 *    ① 四种题型都能正常作答与提交，简答题能输入多行文本
 *    ② 通过底部快捷面板修改参数后**立即生效**（下一题即按新设置行为），不需离开当前页
 *    ③ 窄屏无横向滚动、可点元素 ≥44px   ← 这一条**只有真浏览器能验**（在自检页 K 节），
 *        Node 侧只能验"渲染模型给了哪些可点元素"，边界如实标出
 *
 *  三条反空转设计：
 *    · ①"能提交"必须配"没作答不给提交"与"提交后不能改"的对照；
 *    · ②"立即生效"必须**跨题对照**（同一份会话里：改配置前提交的那题不变、
 *      改配置后提交的下一题按新设置走）—— 否则一个"读不到配置变化"的实现也能过；
 *    · 答案泄露面用**逐格遍历**（时机 × 已提交 × 已结束）与 FlowCore 对齐。
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
/* 真实样卷（含四型，含文本框穿透的题）——与 docx.test.js 同一份读取方式 */
function readSample() {
  const b = fs.readFileSync(path.join(__dirname, '..', 'sample.docx'));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

async function main() {
const parsed = await P.parseDocx(readSample());
const BANK = parsed.questions.map(q => S.createQuestion(q));
const KIND = {};
BANK.forEach(q => KIND[q.type] = (KIND[q.type] || 0) + 1);

/* ============================================================ */
head('①-A 题库与题型覆盖（四型都得有，不然"四种题型都能作答"无从谈起）');

ok(BANK.length >= 8, '样卷切出 ' + BANK.length + ' 题（够覆盖四型）');
eq(Object.keys(KIND).sort(), ['单选', '多选', '判断', '简答'].sort(), '四类题型齐全：' + JSON.stringify(KIND));
eq(BANK.map(q => A.INPUT_KIND[q.type]), BANK.map(q => ({ '单选': 'single', '多选': 'multi', '判断': 'judge', '简答': 'text' })[q.type]),
   '每类题型映射到正确的输入控件（单选/判断=按钮组、多选=可多选按钮组、简答=多行文本框）');

head('①-B "算不算已作答"：四型各自的判据（空/空白一律不算）');

const anyQ = t => ({ id: 'x', type: t });
eq([A.isAnswered(anyQ('单选'), ''), A.isAnswered(anyQ('单选'), '   '), A.isAnswered(anyQ('单选'), null)],
   [false, false, false], '单选：空/空白/null → 未作答');
eq([A.isAnswered(anyQ('单选'), 'A'), A.isAnswered(anyQ('单选'), 'a'), A.isAnswered(anyQ('单选'), ' Ａ ')],
   [true, true, true], '单选：A / a / 全角 Ａ → 已作答');
eq([A.isAnswered(anyQ('多选'), ''), A.isAnswered(anyQ('多选'), 'A'), A.isAnswered(anyQ('多选'), 'AB')],
   [false, true, true], '多选：空 → 未作答；选一个或多个 → 已作答');
eq([A.isAnswered(anyQ('判断'), ''), A.isAnswered(anyQ('判断'), '√'), A.isAnswered(anyQ('判断'), '错'), A.isAnswered(anyQ('判断'), '待定')],
   [false, true, true, false], '判断：√ / 错 → 已作答；认不出来的「待定」→ 视为未作答（不许拿它去提交）');
eq([A.isAnswered(anyQ('简答'), ''), A.isAnswered(anyQ('简答'), '   '), A.isAnswered(anyQ('简答'), '\n  \n'), A.isAnswered(anyQ('简答'), '要点')],
   [false, false, false, true], '简答：只有空白/换行 → 未作答；有内容 → 已作答');

head('①-C 作答规范化：多选排序、单选取首字母、**简答原样保留多行**');

eq(A.normalizeAnswer(anyQ('多选'), 'BA'), 'AB', '多选：BA → 存成 AB（顺序无关，便于比对）');
eq(A.normalizeAnswer(anyQ('多选'), ['B', 'A']), 'AB', '多选：数组作答也归一');
eq(A.normalizeAnswer(anyQ('单选'), ' a '), 'A', '单选：去空白并大写');
eq(A.normalizeAnswer(anyQ('简答'), '要点一\n要点二\n  缩进保留'), '要点一\n要点二\n  缩进保留',
   '**简答：换行与缩进原样保留**（trim 掉就没法按要点分行展示/订正了）');
eq(A.normalizeAnswer(anyQ('简答'), '第一行\r\n第二行'), '第一行\r\n第二行', '简答：CRLF 也原样保留');
eq(A.normalizeAnswer(anyQ('判断'), ' √ '), '√', '判断：保留用户原文（归一在判分侧做）');

head('①-D 提交：没作答不许提交、重复提交被挡、提交后锁定（改要走 reset）');

let ses = A.createSession({ title: 'T', questions: BANK, config: cfg({ reveal: { answerTiming: 'each', explainTiming: 'each' } }) });
const first = A.current(ses);
const noAns = A.submitCurrent(ses);
eq([noAns.ok, noAns.needAnswer], [false, true], '未作答就提交 → 被挡（needAnswer），不会产生 0 分记录');
A.answer(ses, first.type === '简答' ? '甲\n乙' : (first.type === '多选' ? 'AB' : 'A'));
const sub1 = A.submitCurrent(ses);
eq(sub1.ok, true, '作答后提交成功');
eq(sub1.result, Q.scoreOne(first, ses.answers[first.id], ses.config), '提交结果的判分**与直接调 scoreOne 完全一致**（相邻锚：不许两套算法）');
eq(A.submitCurrent(ses).already, true, '同一题再提交 → 被挡（already）');
const locked = A.answer(ses, 'B');
eq([locked.ok, locked.locked], [false, true], '提交后改答案 → 被挡（锁定）');
eq(A.reset(ses).ok, true, 'reset() 解锁');
eq(A.answer(ses, first.type === '简答' ? '改过的要点' : 'A').ok, true, '解锁后可以重新作答（人工订正/重做的入口）');

head('①-E 简答多行：从"输入"到"判分"整条路都不丢换行');

const shortQ = S.createQuestion({ id: 'sh1', type: '简答', stem: '写两个要点', keywords: [{ text: '甲' }, { text: '乙' }] });
const s2 = A.createSession({ title: 'S', questions: [shortQ], config: cfg({}) });
A.answer(s2, '甲要点\n\n乙要点');
eq(s2.answers.sh1, '甲要点\n\n乙要点', '多行（含空行）原样存进会话');
const r2 = A.submitCurrent(s2);
eq([r2.result.score, r2.result.correct], [5, true], '  判分能命中分行写的两个要点 → 5 分满分');
eq(A.view(s2).question.value, '甲要点\n\n乙要点', '  渲染模型里的 value 也是多行原文（textarea 回填不丢字）');
eq(A.answerText(shortQ), '甲、乙', '简答题的"正确答案"= 采分关键词列表');

/* ============================================================ */
head('②-A 面板改参数**立即生效**：同一份会话里"改前提交的题不变、改后提交的下一题按新设置走"');

const twoQs = BANK.filter(q => q.type === '单选').slice(0, 2);
eq(twoQs.length, 2, '取两道单选用于跨题对照');
let s3 = A.createSession({ title: 'P', questions: twoQs, config: cfg({ reveal: { answerTiming: 'end', explainTiming: 'end' } }) });
/* ⚠ 这里要验的是"时机=整卷后 → 不揭示"，所以**必须答对**：
 *   答错的话规则④（答错当场给正确答案）会揭示它，看起来就像时机设置没生效。 */
A.answer(s3, (twoQs[0].answerLetters || [])[0] || 'A');
const beforeChange = A.submitCurrent(s3);
eq([beforeChange.result.correct, beforeChange.reveal.showAnswer, A.view(s3).revealed, A.view(s3).answerText],
   [true, false, false, ''],
   '时机=整卷后 + **答对**：提交后**不揭示**，渲染模型里答案文本为空（界面拿不到答案就没有泄露途径）');
// 用户此刻在页面上点面板：把答案时机改成「答完一题」
const patched = F.setReveal(s3.config, 'answer', 'each');
eq([patched.ok, patched.config.reveal.answerTiming], [true, 'each'], '面板动作产出的新配置（answerTiming=each）');
const applied = A.setConfig(s3, patched.config);
eq(applied.ok, true, 'A.setConfig 把新配置写回会话（**不换页、不重建会话**）');
eq(A.view(s3).revealed, true, '  **立即生效**：当前这道已提交的题也跟着按新设置显示答案（用户就是想要这个）');
eq(A.view(s3).answerText !== '', true, '  而且答案文本确实给了（不是"只把开关翻了、界面还是空的"）');
A.next(s3);
A.answer(s3, 'B');
const afterChange = A.submitCurrent(s3);
eq([afterChange.reveal.showAnswer, A.view(s3).revealed], [true, true], '**下一题**提交后立刻揭示了（新设置生效）');
ok(A.view(s3).answerText !== '', '  而且渲染模型给了正确答案文本', A.view(s3).answerText);

head('②-B 面板改「自动翻页」：开着就跳、关着不跳（各一次对照）');

/* ⚠ 这组用例验"跳不跳"，所以**必须答对**才能观察到跳 —— 用户要求"答错了不自动翻页"之后，
 *   随手写个 'A' 很可能就答错了，于是"点了不跳"看起来像坏掉（实测踩到）。
 *   下面两个小工具按题型给"必对 / 必错"的作答（简答用关键词拼起来 / 一段必然命不中的话）。 */
function rightAnswerFor(q) {
  if (q.type === '判断') return q.judgeValue === true ? '√' : '×';
  if (q.type === '多选') return (q.answerLetters || []).slice().sort().join('');
  if (q.type === '单选') return (q.answerLetters || [])[0] || 'A';
  return (q.keywords || []).map(function (k) { return k.text; }).join('、');
}
function wrongAnswerFor(q) {
  if (q.type === '判断') return q.judgeValue === true ? '×' : '√';
  if (q.type === '简答') return '（这一答法必然拿不到采分关键词）';
  const right = rightAnswerFor(q);
  const labels = (q.options || []).map(function (o) { return o.label; });
  return labels.filter(function (l) { return right.indexOf(l) < 0; })[0] || 'Z';
}

// 自动翻页要能观察到"前进"，所以至少 3 题（在最后一题上无处可翻）
const threeQs = BANK.slice(0, 3);
let s4 = A.createSession({ title: 'N', questions: threeQs, config: cfg({ behavior: { autoCheck: true, autoNext: false } }) });
A.answer(s4, rightAnswerFor(s4.questions[0]));  // 答对（答错的话下一条就轮不到"翻页"了）
eq([A.submitCurrent(s4).advanced, s4.index], [false, 0], '自动翻页关着 → 提交后停在本题');
const onNext = F.setBehavior(F.setBehavior(s4.config, 'autoNext', true).config, 'autoNextMs', 0).config;
A.setConfig(s4, onNext);
A.next(s4);                                   // 走到第 2 题（第 1 题已提交）
A.answer(s4, rightAnswerFor(s4.questions[1]));
const j = A.submitCurrent(s4);
eq([j.result.correct, j.advanced, s4.index], [true, true, 2], '面板打开自动翻页（等待 0）→ 答对后**立刻**前进到下一题');
/* ⚠ 默认等待是 **1.5 秒**（用户要求）→ 这时**不许**由核心直接推进题号，
 *   而是把"过一会儿再跳"交出去（否则等 1.5 秒这件事根本无从发生）。 */
const s4b = A.createSession({ title: 'N', questions: threeQs, config: cfg({ behavior: { autoCheck: true, autoNext: true } }) });
eq([s4b.config.behavior.autoNextMs], [1500], '  新会话没写等待时间 → 用内置默认 1500 毫秒');
A.answer(s4b, rightAnswerFor(s4b.questions[0]));
const jb = A.submitCurrent(s4b);
eq([jb.result.correct, jb.advanced, jb.delayed, jb.waitMs, s4b.index], [true, false, true, 1500, 0],
   '  默认等待下**答对**：核心不动题号，交出 delayed/waitMs（"等 1.5 秒再翻"是界面的事）');
/* ⚠ 用户要求：**答错了不自动翻页**（得停在这一题看正确答案）—— 连"等一会儿再翻"都不该排。 */
const s4c = A.createSession({ title: 'N2', questions: threeQs, config: cfg({ behavior: { autoCheck: true, autoNext: true } }) });
A.answer(s4c, wrongAnswerFor(s4c.questions[0]));
const jc = A.submitCurrent(s4c);
eq([jc.result.correct, jc.advanced, jc.delayed, jc.waitMs, s4c.index], [false, false, false, 0, 0],
   '  答错：**不翻也不等**（连定时器都不排）');
const s4d = A.createSession({ title: 'N3', questions: threeQs, config: cfg({ behavior: { autoCheck: true, autoNext: true }, reveal: { answerTiming: 'end', explainTiming: 'end' } }) });
A.answer(s4d, wrongAnswerFor(s4d.questions[0]));
const jd = A.submitCurrent(s4d);
eq([jd.result.correct, jd.reveal.showAnswer, A.view(s4d).revealed, A.view(s4d).answerText !== '', jd.flow.willJump],
   [false, true, true, true, false],
   '  答错 + 时机=整卷后：**当场**揭示正确答案，且不翻页（用户要的那两条一起满足）');
eq(A.view(s4d).answerText, A.answerText(s4d.questions[0]), '  给的正是这道题的正确答案（不是"揭示了个空壳"）');

head('②-C 面板改「题量」：会话配置确实换了（抽题在开考时发生，属相邻范围）');

let s5 = A.createSession({ title: 'C', questions: BANK, config: cfg({ pick: { mode: 'random', randomBasis: 'count', count: 10 } }) });
const bump = F.quickAction(s5.config, { id: 'count+' });
eq(bump.ok, true, '面板「题量 +」成功');
A.setConfig(s5, bump.config);
eq(s5.config.pick.count, 11, '会话里的题量已变成 11（下一次抽题就会按它走）');
eq(A.view(s5).question.id, BANK[0].id, '**当前题不受影响**（改参数不会把用户正在答的题抽走）');

head('②-D 面板改「展示时机」后，"能不能看见答案"完全由 FlowCore 说了算（逐格对齐）');

const grid = [];
['each', 'end'].forEach(function (ansT) {
  ['each', 'end'].forEach(function (expT) {
    [false, true].forEach(function (submitted) {
      [false, true].forEach(function (finished) {
        const c = cfg({ reveal: { answerTiming: ansT, explainTiming: expT } });
        const s = A.createSession({ title: 'G', questions: [shortQ], config: c });
        if (submitted) { A.answer(s, '甲 乙'); A.submitCurrent(s); }
        // 未作答时交卷要先过"未答确认"门禁（题号导航小类加的）——
        // 这里模拟"用户已经确认仍然交卷"，只验揭示口径本身
        if (finished) A.finish(s, { confirmUnanswered: true });
        const m = A.view(s);
        const want = F.revealAt(c, { submitted: submitted, finished: finished });
        grid.push({
          时机: ansT + '/' + expT, 已提交: submitted, 已结束: finished,
          view答案: m.revealed, flow答案: want.showAnswer,
          文本框: m.answerText !== '', hit: (m.answerText !== '') === want.showAnswer
        });
      });
    });
  });
});
eq(grid.filter(g => !g.hit), [], '16 格（时机 × 已提交 × 已结束）全部对齐：渲染模型里"有答案文本"⟺ FlowCore 说可以揭示');
eq(grid.filter(g => !g.已结束 && !g.已提交 && g.文本框), [], '  答题期间（未提交）**一格都没有答案文本**');
eq(grid.filter(g => g.已结束 && !g.文本框), [], '  整卷结束后每一格都能看到答案');

/* ============================================================ */
head('③-A 渲染模型：可点元素都在模型里（尺寸/滚动只有真浏览器能验，这里给出清单）');

const mv = A.view(A.createSession({ title: 'V', questions: BANK, config: cfg({}) }));
eq(Object.keys(mv).sort(), ['answerLetters', 'answerText', 'canNext', 'canPrev', 'canSubmit', 'detail', 'explain',
    'finished', 'index', 'judgeTrue', 'lockAnswer', 'progress', 'progressText', 'question', 'revealReason',
    'revealed', 'score', 'showExplain', 'submitted', 'title', 'total'].sort(),
   '渲染模型的字段齐全（视图层只按它画；answerLetters/judgeTrue 是"标选项对错"要用的，只在允许揭示时给值）');
eq([mv.question.kind, Array.isArray(mv.question.options), typeof mv.question.value], [A.INPUT_KIND[BANK[0].type], true, 'string'],
   '  题目部分带 kind/options/value（选项按钮与文本框都从这里来）');
const judgeV = A.view(A.createSession({ title: 'J', questions: BANK.filter(q => q.type === '判断').slice(0, 1), config: cfg({}) }));
eq(judgeV.question.options.length, 0, '判断题：不靠 options（界面用固定的 对/错 两个大按钮）');
eq([judgeV.canPrev, judgeV.canNext], [false, false], '只有一道题时上一题/下一题都禁用');
eq(judgeV.canSubmit, false, '未作答时"提交本题"禁用（与 submitCurrent 的 needAnswer 一致）');

head('③-B 进度与结算：与既有两个真相源一致');

let s6 = A.createSession({ title: 'F', questions: BANK, config: cfg({}) });
eq(A.progress(s6), { index: 0, total: BANK.length, answered: 0, checked: 0, unanswered: BANK.length, percent: 0 },
   '初始进度：0 / ' + BANK.length);
BANK.forEach(function (q, i) {
  A.goto(s6, i);
  A.answer(s6, q.type === '简答' ? '甲 乙' : (q.type === '多选' ? 'AB' : (q.type === '判断' ? '√' : 'A')));
});
eq(A.progress(s6).answered, BANK.length, '全部作答后 answered = ' + BANK.length);
A.goto(s6, 0); A.submitCurrent(s6);
eq(A.progress(s6).checked, 1, '提交一题后 checked = 1');
const fin = A.finish(s6);
const direct = Q.scoreExam(BANK, s6.answers, s6.config);
eq([fin.summary.score, fin.summary.full, fin.summary.percent, fin.summary.level],
   [direct.score, direct.full, direct.percent, F.gradeLevel(direct.percent, s6.config).level],
   '交卷结算 == scoreExam + FlowCore.gradeLevel（相邻锚，不另算一套）');
eq(fin.summary.answered, BANK.length, '  已答题数正确');
eq(fin.summary.unanswered, [], '  没有未答题');
eq([A.view(s6).finished, A.view(s6).revealed], [true, true], '交卷后：模型标记结束、并允许看答案');
// 汇总页渲染所需的字段必须在模型里齐全（早先这条写成了 `/整卷结束/.test('整卷结束')` 的恒真断言）
const R6 = A.resultModel(s6);
eq([typeof R6.score, typeof R6.percent, typeof R6.level, R6.bands.length, R6.byType.length > 0],
   ['number', 'number', 'string', 3, true], '成绩页要用的字段齐全：分数/百分比/等级/三档区间/按题型汇总');

head('③-C 边界：空卷、越界跳转、非法参数都不崩');

const empty = A.createSession({ title: 'E', questions: [] });
eq(A.current(empty), null, '空卷：current() 返回 null');
eq(A.view(empty).progressText, '没有题目', '  渲染模型给出可读文案');
eq([A.next(empty).ok, A.prev(empty).ok, A.goto(empty, 5).ok], [false, false, false], '  翻页/跳转都明确失败（不抛）');
eq([A.submitCurrent(empty).ok, A.finish(empty).ok], [false, true], '  空卷不能提交，但能"交卷"（得 0 分而不是崩）');
eq([A.setConfig(empty, null).ok, A.setConfig(empty, cfg({})).ok], [false, true], 'setConfig(null) 被挡；正常配置通过');
eq(A.answer({ questions: [], index: 0, answers: {}, checked: {} }, 'A').ok, false, 'answer 在空会话上明确失败');

/* ============================================================
 *  ④ **真挂载**：四种题型渲染到界面上的东西（不是只看模型）
 *
 *  为什么补这一节：本小类原先只验了"模型说这道题有 4 个选项"，**没有验"那 4 个选项真的挂到界面上了"**。
 *  于是 `ui/attempt-view.js` 的单选/多选分支漏写 `box.appendChild(ul)` 时，
 *  选项按钮全被造出来却一个也没挂上去 —— 界面上**整类题点不了**，而这份测试依旧全绿。
 *  （用户的终端体验走查在真浏览器里一眼看出来了：`已答 0/10`、`提交本题` 灰着、选项区空白。）
 * ============================================================ */
head('④ 真挂载（mini-dom）：选项/输入框必须**出现在容器里**，不是造完就扔');

const DOM = require('./mini-dom.js');
const AttemptView = require('../ui/attempt-view.js');
const doc4 = DOM.makeDoc();
const host4 = doc4.createElement('div');
doc4.documentElement.appendChild(host4);
const four = [
  S.createQuestion({ id: 'v1', type: '单选', stem: '单选题干', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }, { label: 'C', text: 'c' }, { label: 'D', text: 'd' }], answerLetters: ['B'], answer: 'B' }),
  S.createQuestion({ id: 'v2', type: '多选', stem: '多选题干', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }, { label: 'C', text: 'c' }, { label: 'D', text: 'd' }], answerLetters: ['A', 'B'], answer: 'AB' }),
  S.createQuestion({ id: 'v3', type: '判断', stem: '判断题干', judgeValue: true }),
  S.createQuestion({ id: 'v4', type: '简答', stem: '简答题干', keywords: [{ text: '甲' }, { text: '乙' }] })
];
const sess4 = A.createSession({ examId: 'V4', title: '四型卷', questions: four, config: cfg({}), startedAt: 'T' });
const view4 = AttemptView.mount({ container: host4, session: sess4, onChange: function () {} });
const optsIn = function () { return DOM.byClass(host4, 'av-opt').length; };
const textIn = function () { return DOM.byClass(host4, 'av-text').length; };

A.goto(sess4, 0); view4.refresh();
eq(optsIn(), 4, '**单选**：界面上真有 4 个选项按钮（不是只造了个 ul）',
   '容器里 av-opt 个数 = ' + optsIn());
ok(DOM.byClass(host4, 'av-opts').length === 1, '  选项列表本身也挂在界面上（av-opts 在容器里）');
A.goto(sess4, 1); view4.refresh();
eq(optsIn(), 4, '**多选**：界面上真有 4 个选项按钮');
A.goto(sess4, 2); view4.refresh();
eq(optsIn(), 2, '**判断**：界面上真有 2 个（对/错）');
A.goto(sess4, 3); view4.refresh();
eq([optsIn(), textIn()], [0, 1], '**简答**：没有选项、但有 1 个多行输入框');
/* 反向对照：模型说有选项 ≠ 界面有选项 —— 这条断言必须能与"只算模型"区分开 */
eq([A.view(sess4).question.kind, (A.view(sess4).question.options || []).length >= 2], ['text', false],
   '  同一道简答题：模型侧确实是 text 型（说明上面那条数的是**界面**，不是模型）');
A.goto(sess4, 0); view4.refresh();
ok(A.view(sess4).question.options.length === 4 && optsIn() === 4,
   '  单选：模型 4 个 且 界面 4 个（两个口径都查，才堵得住"漏挂"这类错）');

/* ============================================================
 *  ⑤ 「提交本题」的**条件出现**语义（行为变更史，别搞混）
 *
 *  第一版：按钮常驻；→ 用户要求去掉 → 点选即答；
 *  → 现在（用户要求）：**又请回来，但只在"答了还没判"时出现**：
 *     · 单选/判断 + 自动判分开着 → 点选项那一刻就判，按钮不出现；
 *     · 多选/简答 → 不自动判分（用户要求），按钮出现，点了才判；
 *     · 自动判分关着 → 单选/判断也出现（判据就一句：答了但还没判）。
 *  判分/揭示的时机：点选项（自动判分）、点「提交本题」、离开该题（时机=答完一题即显示时）、
 *  或交卷统一结算；几种都**不锁定**，交卷前随时能改。
 * ============================================================ */
head('⑤ 「提交本题」只在该出现时出现 + 交卷常驻 + 题号可折叠 + 成绩圆环');

const doc5 = DOM.makeDoc();
const host5 = doc5.createElement('div');
doc5.documentElement.appendChild(host5);
const five = [
  S.createQuestion({ id: 'n1', type: '单选', stem: '第一题', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['B'], answer: 'B' }),
  S.createQuestion({ id: 'n2', type: '判断', stem: '第二题', judgeValue: true })
];
/* 每次都挂一份**干净**的视图（先把宿主清空，否则计数会把好几份视图叠起来数） */
const mk5 = function (timing) {
  host5.textContent = '';
  /* ⚠ 这一节只验"**展示时机**" —— 所以两个行为开关**显式关掉**（内置默认现在是开着的）：
   *   不关的话"点一下只记录、不判分"的断言会被 autoCheck 的默认值干掉（实测踩过）。 */
  const s = A.createSession({ examId: 'N5', title: '无提交卷', questions: five,
    config: cfg({ reveal: { answerTiming: timing }, behavior: { autoCheck: false, autoNext: false } }), startedAt: 'T' });
  const v = AttemptView.mount({ container: host5, session: s, onChange: function () {} });
  return { s: s, v: v };
};
const clickNext = function () { DOM.byAttr(host5, 'data-av', 'next')[0].click(); };
const clickOpt = function (i) { DOM.byClass(host5, 'av-opt')[i].click(); };
const fabText = function () { return DOM.byAttr(host5, 'data-av', 'finish')[0].textContent; };

const N1 = mk5('end');
eq(DOM.byAttr(host5, 'data-av', 'submit').length, 0,
   '**没作答时没有「提交本题」**（按钮只在"答了还没判"时出现，不常驻）');
const fabs = DOM.byAttr(host5, 'data-av', 'finish');
eq(fabs.length, 1, '  交卷按钮还在（唯一的前进动作）');
ok(/av-fab/.test(String(fabs[0].className)), '  而且是**右下角常驻**那颗（av-fab）', String(fabs[0].className));
eq(fabText().indexOf('2') >= 0, true, '  未答 2 题时角标带数字 2：' + fabText());
/* 用户本轮要求：「题号跳转功能说明不要单独列出来，和功能放一排」——
 * 说明不再单独占一行、也不再折叠（折叠会把唯一的说明一起藏掉）：整块是一行 flex：
 * 左「题号 · 点一下跳转」+ 右题号格。 */
const navBoxes = DOM.byClass(host5, 'av-nav');
eq(navBoxes.length, 1, '题号跳转是一整块 av-nav');
eq(DOM.byClass(host5, 'av-navfold').length, 0, '  **不再**是可折叠块（用户要求：说明与题号同一排，别把说明藏起来）');
const navHead = DOM.byClass(navBoxes[0], 'h')[0];
ok(!!navHead && navHead.textContent.indexOf('题号') >= 0 && navHead.textContent.indexOf('点一下跳转') >= 0,
   '  说明就在这块里、和题号同一排：' + (navHead && navHead.textContent));
eq(DOM.byClass(navBoxes[0], 'av-grid').length, 1, '  同一块里紧挨着就是题号格');
eq(DOM.byClass(host5, 'mk').length, 2, '选项各带一个角标 span（✓ / ✗ 不只靠颜色）');
/* 显示细节（量出来的）：判断题标签别把 √/× 写两遍；题号摘要别重复"已答/未答" */
A.goto(N1.s, 1); N1.v.refresh();
eq(DOM.byClass(host5, 'av-opt').map(function (b) { return b.textContent; }), ['√对✓', '×错✓'],
   '判断题两个选项的文字是"√ 对 / × 错"（圆标已含 √/×，不再写"对（√）"）');
A.goto(N1.s, 0); N1.v.refresh();
const navHead2 = DOM.byClass(DOM.byClass(host5, 'av-nav')[0], 'h')[0].textContent;
ok(navHead2.indexOf('已答') < 0 && /题号/.test(navHead2),
   '题号那行只说"题号 · 点一下跳转"（已答/未答由上面的徽章说，不重复）：' + navHead2);
/* 用户要求："去除顶部多余的一个题号显示" —— 顶部那行**不再**重复"第 N / M 题"（题号栏里已经有了） */
const headTxt = String(DOM.byClass(host5, 'av-head')[0].textContent);
ok(headTxt.indexOf('第 ') < 0, '  顶部那行不再重复题号（只剩卷名 + 已答读数）：' + headTxt);
ok(/已答 \d+\/\d+/.test(headTxt), '  但"已答 x/y"这个**进度读数**还在（题号栏里没有它）', headTxt);
eq(DOM.byClass(DOM.byClass(host5, 'av-head')[0], 'av-badge').length, 1,
   '  顶部那行只剩一枚徽章（原来两枚：题号 + 已答；题型徽章在题干卡里，不算）');

/* 底部快捷设置：**挂上之后不能被重绘清掉**（paint() 会清空 av-root；面板宿主必须在外层） */
eq(DOM.byClass(host5, 'qp-root').length, 1, '底部快捷设置面板**挂在界面上**（挂载后就有）');
N1.v.refresh();                                     // 手动重绘一次
eq(DOM.byClass(host5, 'qp-root').length, 1, '  重绘一次之后**它还在**（早先挂在 av-root 里，被 paint() 清掉了 → 面板从来没显示过）');
eq(DOM.byAttr(host5, 'data-qp', 'toggle').length, 1, '  面板的"收起/展开"按钮也在');
eq(DOM.byAttr(host5, 'data-qp', 'toggle')[0].textContent, '展开设置',
   '  而且**默认是收起态**（展开的面板会跟右下角常驻的「交卷」抢位置，实测压住过面板右侧的按钮）');
/* 用户要求：底部那张面板**不要标题**（「快捷设置」四个字会被左下角的「返回题库」压住），
 * 表头只剩那颗「展开设置 / 收起设置」按钮 —— 它就是这一排唯一的东西。 */
eq(DOM.byClass(host5, 'qk-title').length, 0, '底部面板没有标题文字（「快捷设置」已去掉）');
const tog5 = DOM.byAttr(host5, 'data-qp', 'toggle')[0];
if (tog5) tog5.click();
eq(DOM.byClass(host5, 'qk-title').length, 0, '  展开之后也仍然没有标题（不是"展开了才显示"）');
eq(DOM.byAttr(host5, 'data-qp', 'toggle')[0].textContent, '收起设置', '  展开后按钮写着「收起设置」');
if (DOM.byAttr(host5, 'data-qp', 'toggle')[0]) DOM.byAttr(host5, 'data-qp', 'toggle')[0].click();
eq(DOM.byClass(DOM.byClass(host5, 'av-root')[0], 'qp-root').length, 0,
   '  面板**不在 av-root 子树里**（这正是不被 paint() 清掉的原因）');

/* 点选即答：记录进 answers，但不等于"已提交"（判分留给「提交本题」或交卷） */
clickOpt(0);
eq([N1.s.answers.n1, !!N1.s.checked.n1], ['A', false], '**点一下选项就记下了答案**，而且**没被提交**');
eq(DOM.byAttr(host5, 'data-av', 'submit').length, 1,
   '  答了还没判 → 这时才出现「提交本题」（自动判分关着，单选也要显式提交）');
eq(fabText().indexOf('1') >= 0, true, '  角标跟着变成 1（未答只剩 1 题）：' + fabText());
clickNext();
eq([N1.s.answers.n1, !!N1.s.checked.n1], ['A', false],
   '  时机=整卷结束 → 离开该题也**不提前判分**（答案留给交卷那一刻看）');
A.goto(N1.s, 0); N1.v.refresh();
eq([DOM.byClass(host5, 'av-opt').length, DOM.byClass(host5, 'av-opt')[0].attrs['aria-pressed']],
   [2, 'true'], '  回到第 1 题：选项还在、且**选中的那个仍是按下的样子**（交卷前没锁死）');
clickOpt(1);
eq(N1.s.answers.n1, 'B', '  再点另一个选项 → **答案能改**（交卷前随时改，符合刷题直觉）');

/* 时机=答完一题即显示 → 离开该题时自动提交，答案当场就能看 */
const N2 = mk5('each');
clickOpt(1);
clickNext();
eq([N2.s.answers.n1, !!N2.s.checked.n1], ['B', true],
   '时机=答完一题即显示 → **离开该题时自动提交**（否则永远等不到揭示）');

/* 成绩页：圆环 + 刻度（分数不再只是一行文字） */
const N3 = mk5('end');
A.answer(N3.s, 'B'); A.submitCurrent(N3.s);
A.goto(N3.s, 1); A.answer(N3.s, '√'); A.submitCurrent(N3.s);
const finN3 = A.finish(N3.s, { confirmUnanswered: true, now: 'T2' });
N3.v.refresh();
const rings = DOM.byClass(host5, 'av-ring');
eq(rings.length, 1, '成绩页有**分数圆环**');
eq(/--p:100/.test(String((rings[0] && rings[0].style && rings[0].style.cssText) || '')), true,
   '  圆环带百分比变量，全对时 --p:100',
   String(rings[0] && rings[0].style && rings[0].style.cssText));
eq([finN3.summary.score, finN3.summary.full], [finN3.summary.full, finN3.summary.full],
   '  两题全对 → 分数 = 满分（圆环与分数出自同一份结算）');
eq(DOM.byClass(host5, 'av-scale').length, 1, '  还有及格/优秀**刻度条**');
eq(DOM.byClass(host5, 'av-nav').length, 1, '  交卷后题号那一块还在（仍是"说明 + 题号"同一排，逐题回看用）');
eq(DOM.byAttr(host5, 'data-av', 'finish').length, 0, '  交卷后常驻按钮消失（没有"再交一次"）');

head('⑤-b 交卷后：试题回顾进右栏；页面给了 onRestart 才有「再考一张」');

/* 试题回顾搬到右栏（电脑端并排；窄屏 DOM 顺序仍是 成绩单→题号→回顾，看不出区别） */
const sideCards = DOM.byClass(host5, 'av-side');
eq(sideCards.length, 1, '交卷后仍只有一右栏容器');
eq(DOM.byClass(sideCards[0], 'av-panel').length >= 1, true, '  **试题回顾卡片在右栏里**（.av-side 内）');
eq(DOM.byClass(DOM.byClass(host5, 'av-main')[0], 'av-ring').length, 1, '  成绩单的圆环在左栏（.av-main 内）');
ok(DOM.byClass(sideCards[0], 'av-panel')[0].textContent.indexOf('正确答案') >= 0,
   '  右栏那张卡确实是"你的作答 vs 正确答案"的回看卡',
   String(DOM.byClass(sideCards[0], 'av-panel')[0].textContent).slice(0, 40));
/* ⚠ 默认（mk5 没给 onRestart）**不该**画「再考一张」——错题本"跳过去"的视图就是这样 */
eq(DOM.byAttr(host5, 'data-av', 'restart').length, 0,
   '页面没提供 onRestart → 不画「再考一张」（错题本那种只读回看视图不该出现它）');

/* 提供 onRestart → 交卷后出现「再考一张」，点了回调一次、stats 记一次 */
const restarted = [];
const finS = A.createSession({ examId: 'N6', title: '再考一张', questions: five,
  config: cfg({ reveal: { answerTiming: 'each' } }), startedAt: 'T' });
host5.textContent = '';
const finV = AttemptView.mount({ container: host5, session: finS, onChange: function () {},
                                 onRestart: function (s) { restarted.push(s.examId); } });
A.answer(finS, 'B'); A.submitCurrent(finS);
A.finish(finS, { confirmUnanswered: true, now: 'T3' });
finV.refresh();
const rBtn = DOM.byAttr(host5, 'data-av', 'restart')[0];
ok(!!rBtn, '给了 onRestart → 交卷后出现「再考一张」');
ok(/再考一张/.test(String(rBtn && rBtn.textContent)), '  按钮文案写着「再考一张」：' + String(rBtn && rBtn.textContent));
if (rBtn) rBtn.click();
eq([restarted, finV.stats().restarts], [['N6'], 1], '点它 → 回调一次 + stats().restarts = 1（页面据此换一批题）');
eq(DOM.byAttr(host5, 'data-av', 'restart')[0].className.indexOf('primary') >= 0, true,
   '  它是**主按钮**（交卷后最想点的就是它）');

/* ⑤-c 「重新生成试卷」（原「再抽一次」）**搬出动作条**（用户要求挪到「返回题库」旁边）
 *  ⚠ 关键区分：答题中途那颗按钮现在由**页面外壳**画（在底部固定栏里，与「返回题库」并排），
 *    视图只在**交卷之后**画「再考一张」。所以这里钉的是"动作条里没有它"，
 *    页面那边由 wiring 锚 + 真浏览器（answer-library / prefer-redraw）覆盖。 */
head('⑤-c 答题中途的动作条：不再画「再抽一次 / 再考一张」（那颗按钮归页面外壳）');

const mkRedraw = function (opts) {
  const d = DOM.makeDoc();
  const h = d.createElement('div');
  const s = A.createSession({ examId: 'N7', title: '重新生成试卷', questions: five,
    config: cfg({ reveal: { answerTiming: 'each' } }), startedAt: 'T' });
  const v = AttemptView.mount(Object.assign({ container: h, session: s, onChange: function () {} }, opts || {}));
  return { doc: d, host: h, session: s, view: v };
};
const noR = mkRedraw(null);
eq(DOM.byAttr(noR.host, 'data-av', 'redraw').length, 0, '没给 onRestart：答题中途当然也没有「再抽一次」');
const withR = mkRedraw({ onRestart: function () {} });
eq(DOM.byAttr(withR.host, 'data-av', 'redraw').length, 0,
   '**给了 onRestart 也不在动作条里**（用户要求搬到「返回题库」旁边 → 由页面外壳画）');
eq(DOM.byAttr(withR.host, 'data-av', 'restart').length, 0,
   '  答题中途也不该出现交卷后才有的「再考一张」');
const actRow = DOM.byClass(withR.host, 'av-actions')[0];
eq(actRow ? DOM.byAttr(actRow, 'data-av', 'redraw').length + DOM.byAttr(actRow, 'data-av', 'restart').length : null, 0,
   '  动作条里只剩 上一题 / 下一题（外加按需的「提交本题」）');
eq(DOM.byAttr(withR.host, 'data-av', 'finish').length, 1, '  常驻「交卷」仍在（换一批不该把答题界面拆了）');
/* 反面对照：同一份会话**交卷之后**才会出现「再考一张」（⑤-b 已经点过它，这里只钉"先后关系"） */
const finWithR = mkRedraw({ onRestart: function () {} });
A.answer(finWithR.session, 'B'); A.submitCurrent(finWithR.session);
A.finish(finWithR.session, { confirmUnanswered: true, now: 'T3' });
finWithR.view.refresh();
eq([DOM.byAttr(finWithR.host, 'data-av', 'redraw').length, DOM.byAttr(finWithR.host, 'data-av', 'restart').length], [0, 1],
   '交卷之后才出现「再考一张」（动作条里始终没有「再抽一次」）');

/* ============================================================
 *  ⑥ 自动判分 / 自动下一题：**两个开关必须真的生效**
 *  （用户实测报障："答完题自动判正误和自动跳转都有问题" —— 根因是这两条链原来挂在
 *    「提交本题」按钮上，那一轮把按钮去掉时漏了触发点。这一节就是那个 bug 的回归锚。）
 * ============================================================ */
head('⑥ 自动判分 / 自动下一题（开关真的生效）');

const doc6 = DOM.makeDoc();
const host6 = doc6.createElement('div');
doc6.documentElement.appendChild(host6);
const sixQ = [
  S.createQuestion({ id: 'a1', type: '单选', stem: '单选题干', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['B'], answer: 'B' }),
  S.createQuestion({ id: 'a2', type: '简答', stem: '简答题干', keywords: [{ text: '甲' }] }),
  /* ⚠ 多选**不能放最后一题**：那样"点完不翻"会被"最后一题不翻"的守卫挡住，
   *   测试会侥幸通过（实测踩过：多选那个 case 曾因此是假绿）。后面必须还有一题。 */
  S.createQuestion({ id: 'a3m', type: '多选', stem: '多选题干',
    options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }, { label: 'C', text: 'c' }], answerLetters: ['A', 'B'], answer: 'AB' }),
  S.createQuestion({ id: 'a4', type: '判断', stem: '判断题干（最后一题）', judgeValue: true })
];
const mk6 = function (beh) {
  host6.textContent = '';
  /* ⚠ 这组用例验的是"**跳不跳**（autoNext）"，不是"等多久" —— 所以把等待**显式压成 0**：
   *   内置默认从 0 变成 1.5 秒之后，"立刻翻"的断言会全部变成"等一会儿才翻"（实测踩过）。
   *   "等多久"由下面的 B6–B11 与 flow.test.js ②-E 专门验。 */
  const s = A.createSession({ examId: 'N6', title: '自动卷', questions: sixQ,
    config: cfg({ behavior: Object.assign({ autoNextMs: 0 }, beh || {}), reveal: { answerTiming: 'each' } }), startedAt: 'T' });
  const v = AttemptView.mount({ container: host6, session: s, onChange: function () {} });
  return { s: s, v: v };
};

/* ① 只开自动判分：点一下就该判分，且**停在本题**（看得见对错） */
const B1 = mk6({ autoCheck: true, autoNext: false });
DOM.byClass(host6, 'av-opt')[1].click();
eq([!!B1.s.checked.a1, B1.s.index, !!(B1.s.results && B1.s.results.a1)], [true, 0, true],
   '自动判分：**点一下选项就判分了**，而且停在本题');
const vd = DOM.byClass(host6, 'av-verdict');
eq(vd.length, 1, '  界面上立刻出现判分结论');
ok(/答对/.test(String(vd[0] && vd[0].textContent)), '  答对了就写"答对"：' + String(vd[0] && vd[0].textContent).slice(0, 24));

/* ② 只开自动翻页（不判分也翻）—— 用户明确要求"点完自动翻" */
const B2a = mk6({ autoCheck: false, autoNext: true });
DOM.byClass(host6, 'av-opt')[1].click();
eq([B2a.s.index, !!B2a.s.checked.a1], [1, false],
   '**只开自动翻页：点完就翻**（不用先判分，也不判分）');
eq(DOM.byClass(host6, 'av-verdict').length, 0, '  这一题没有判分卡（因为没开自动判分）');

/* ③ 自动判分 + 自动翻页：先判分，然后**立刻翻**（不拖 0.7 秒） */
const B2 = mk6({ autoCheck: true, autoNext: true });
DOM.byClass(host6, 'av-opt')[1].click();
eq([B2.s.index, !!B2.s.checked.a1], [1, true],
   '两个都开：**判分 + 立刻翻页**（点完即翻，不停留）');
A.goto(B2.s, 0); B2.v.refresh();
eq(DOM.byClass(host6, 'av-verdict').length, 1, '  回到第 1 题 → 判分结论仍在（判分确实发生了、可回看）');
eq(DOM.byClass(host6, 'av-opt')[1].getAttribute('aria-pressed'), 'true', '  而且选中的选项仍是按下态');

/* ④ 翻页不会连跳两格（翻完就在下一题，再点"下一题"只走一格） */
DOM.byAttr(host6, 'data-av', 'next')[0].click();
eq(B2.s.index, 1, '  从第 1 题点"下一题" → 到第 2 题（只走一格，没有连跳两格）');

/* ⑤ 两个开关都关（显式关掉）：点选项只记录、不判分、不翻 */
const B4 = mk6({ autoCheck: false, autoNext: false });
DOM.byClass(host6, 'av-opt')[1].click();
eq([!!B4.s.checked.a1, B4.s.index], [false, 0], '两个开关都关（显式关掉）：点选项**只记录**');

/* ⑥ 多选：自动翻页开着也**不翻**（多选要连点好几下，"点完"没有明确信号） */
const B4b = mk6({ autoCheck: false, autoNext: true });
A.goto(B4b.s, 2); B4b.v.refresh();                     // 第 3 题就是多选（后面还有第 4 题，别有"最后一题"的干扰）
DOM.byClass(host6, 'av-opt')[0].click();
eq(B4b.s.index, 2, '多选：点选第一个**不翻页**（还要继续点 B/C）');
eq(B4b.s.answers.a3m, 'A', '  但答案已经记下了');
DOM.byClass(host6, 'av-opt')[1].click();
eq([B4b.s.answers.a3m, B4b.s.index], ['AB', 2], '  继续点第二个 → 答案累加，且**仍然不翻页**');
/* 反向对照：同一条链上，单选题**是**会翻的（证明上面不是"整条链没生效"） */
A.goto(B4b.s, 0); B4b.v.refresh();
DOM.byClass(host6, 'av-opt')[1].click();
eq(B4b.s.index, 1, '  同一份会话里单选**立刻翻页**（对照：差别只在题型）');

/* ⑦ 简答题：自动翻页开着，打字不翻（离开才判/翻） */
const B5 = mk6({ autoCheck: true, autoNext: true });
A.goto(B5.s, 1); B5.v.refresh();
const ta5 = DOM.byClass(host6, 'av-text')[0];
ta5.value = '甲';
ta5.dispatchEvent('input');
eq([B5.s.index, !!B5.s.checked.a2], [1, false], '简答：输入过程中**不判也不翻**（免得打到一半就被判错/翻走）');
DOM.byAttr(host6, 'data-av', 'next')[0].click();            // 离开这道题
eq([!!B5.s.checked.a2, B5.s.index], [true, 2], '  离开该题 → **立刻判分**，并走到下一题');
eq(DOM.byClass(host6, 'av-verdict').length, 0,
   '  但本题（第 3 题）没被判分 → 不显示判分卡');

/* ⑧ 自动翻页**等待时间**（behavior.autoNextMs）：等一会儿再翻，而且能被打断/重新计时
 *    ⚠ 这条链跨越"核心"与"界面"两层，所以两头都要钉：
 *       核心 `submitCurrent` 在"要等"时**不许自己推进题号**（否则等待时间当场被跳过、设了等于没设）。 */
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

const B6 = mk6({ autoCheck: false, autoNext: true, autoNextMs: 60 });
DOM.byClass(host6, 'av-opt')[1].click();
eq([B6.s.index, B6.v.stats().pendingJump], [0, true], '配了 60 毫秒等待：点完**先不翻**，排了一个待跳定时器');
eq(DOM.byClass(host6, 'av-opt')[1].getAttribute('aria-pressed'), 'true', '  等待期间自己的选择看得见（没被立刻翻走）');
await sleep(140);
eq([B6.s.index, B6.v.stats().pendingJump], [1, false], '  等到点 → 自动翻到第 2 题，定时器收工');

/* 用户自己翻页 → 待跳必须**被取消**（否则过一会儿又跳一格，等于一次点击翻两题） */
const B7 = mk6({ autoCheck: false, autoNext: true, autoNextMs: 200 });
DOM.byClass(host6, 'av-opt')[1].click();
eq(B7.v.stats().pendingJump, true, '  200 毫秒等待 → 处于"待跳"状态');
DOM.byAttr(host6, 'data-av', 'next')[0].click();
eq([B7.s.index, B7.v.stats().pendingJump], [1, false], '用户自己点"下一题" → 待跳**被取消**');
await sleep(300);
eq(B7.s.index, 1, '  等过了原定时刻也不再跳（取消是真的生效，不是假取消）');

/* 等待期间改答案 → **重新计时**（不能两个定时器一起跑） */
const B8 = mk6({ autoCheck: false, autoNext: true, autoNextMs: 300 });
DOM.byClass(host6, 'av-opt')[0].click();
await sleep(120);
eq(B8.s.index, 0, '  120 毫秒时还在本题（等待中）');
DOM.byClass(host6, 'av-opt')[1].click();                  // 改答案（A → B）→ 重新计时
await sleep(250);
eq([B8.s.index, B8.s.answers.a1], [0, 'B'],
   '  改答案后重新计时：累计 370 毫秒（超过原来那 300）**仍在本页**，答案已是 B');
await sleep(160);
eq(B8.s.index, 1, '  再等到点才翻（没有提前翻，也没有连翻两格）');

/* 等待时间 = 0（默认值）→ 还是"点完即翻"，既有行为一点没被拖慢 */
const B9 = mk6({ autoCheck: false, autoNext: true, autoNextMs: 0 });
DOM.byClass(host6, 'av-opt')[1].click();
eq([B9.s.index, B9.v.stats().pendingJump], [1, false], '等待时间 0（默认）→ 仍然"点完立刻翻"，且根本不排定时器');

/* 自动判分 + 等待：判分归判分、翻页归翻页（核心不许抢先把题号推走） */
const B10 = mk6({ autoCheck: true, autoNext: true, autoNextMs: 150 });
DOM.byClass(host6, 'av-opt')[1].click();
eq([B10.s.index, !!B10.s.checked.a1, B10.v.stats().pendingJump], [0, true, true],
   '自动判分 + 等待 150 毫秒：**判了分却停在本题**（核心没抢先把题号推进，等待时间才算数）');
eq(DOM.byClass(host6, 'av-verdict').length, 1, '  等待期间判分结论已经看得见');
await sleep(230);
eq(B10.s.index, 1, '  等到点才翻到第 2 题');

/* 面板销毁 → 定时器必须一起撤掉（否则"看不见的页面"自己翻页） */
const B11 = mk6({ autoCheck: false, autoNext: true, autoNextMs: 120 });
DOM.byClass(host6, 'av-opt')[1].click();
B11.v.destroy();
await sleep(200);
eq([B11.s.index, B11.v.stats().pendingJump], [0, false], 'destroy() 撤掉待跳：销毁后不会再偷偷翻页');

/* ============================================================
 *  ⑥-c 用户要求：**每次自动翻页都要有一个小加载条提示翻页**
 *  （条跟着"待跳定时器"同生共死：排上就出现、翻页/取消就消失）
 * ============================================================ */
head('⑥-c 自动翻页的小加载条（提示正在翻页）');

const B15 = mk6({ autoCheck: false, autoNext: true, autoNextMs: 300 });
eq(DOM.byAttr(host6, 'data-av', 'jumpbar').length, 0, '还没作答 → 没有加载条（没有在等的跳）');
DOM.byClass(host6, 'av-opt')[1].click();                      // 答对 → 排上"等 300 毫秒再翻"
eq(B15.v.stats().pendingJump, true, '点完 → 排上待跳');
const bar1 = DOM.byAttr(host6, 'data-av', 'jumpbar');
eq(bar1.length, 1, '  这时出现**小加载条**（data-av=jumpbar）');
ok(String(bar1[0] && bar1[0].textContent).indexOf('正在翻页') >= 0,
   '  条上写着"正在翻页…"：' + String(bar1[0] && bar1[0].textContent));
eq(DOM.byClass(bar1[0] || host6, 'av-jumpbar').length, 0, '  条里没有嵌套第二根条（只有一根）');
const fill = DOM.byClass(host6, 'fill');
eq(fill.length, 1, '  条里有一根会走的进度芯（.fill）');
eq(fill[0] ? fill[0].style.animationDuration : null, '300ms',
   '  动画时长**就是这一跳要等的毫秒数**（观感与行为同一个数，不各算一份）');
eq(B15.v.stats().pendingWaitMs, 300, '  stats 里也如实给出等待毫秒（测试与自检页读它）');
const actRow15 = DOM.byClass(host6, 'av-actions')[0];
ok(!!actRow15 && DOM.byAttr(actRow15, 'data-av', 'jumpbar').length === 1,
   '  条挂在动作条里（就在用户刚点完的地方，不去和「交卷」FAB 抢位置）');
await sleep(420);
eq([B15.s.index, DOM.byAttr(host6, 'data-av', 'jumpbar').length, B15.v.stats().pendingJump], [1, 0, false],
   '  等到了就翻页，条跟着消失（不留一根"永远 100%"的条在那儿）');

/* 等待期间用户自己翻页 → 待跳取消 → 条也必须立刻消失（不能骗人） */
const B16 = mk6({ autoCheck: false, autoNext: true, autoNextMs: 400 });
DOM.byClass(host6, 'av-opt')[1].click();
eq(DOM.byAttr(host6, 'data-av', 'jumpbar').length, 1, '待跳中：条在');
DOM.byAttr(host6, 'data-av', 'next')[0].click();               // 自己翻走 → 取消
eq([B16.v.stats().pendingJump, DOM.byAttr(host6, 'data-av', 'jumpbar').length], [false, 0],
   '用户自己翻页 → 取消待跳、条立刻收起（不是假取消）');

/* 等待时间 0（= 立刻翻）：没有等待窗口，所以没有条（这一条要如实说清，别硬凑一根闪一下的条） */
const B17 = mk6({ autoCheck: false, autoNext: true, autoNextMs: 0 });
DOM.byClass(host6, 'av-opt')[1].click();
eq([B17.s.index, DOM.byAttr(host6, 'data-av', 'jumpbar').length], [1, 0],
   '等待时间 0 → 同一个 tick 里就翻了，不会有加载条（没有"等待窗口"可提示）');

/* ============================================================
 *  ⑥-d 用户要求：**错题是否自动翻页**（behavior.autoNextWrong）
 * ============================================================ */
head('⑥-d 「答错的题也自动翻页」：开关真的管用（答错照样翻，且带着加载条）');

/* 关着（默认）：答错 → 不翻、没有条 —— 老行为一个字不改 */
const W1 = mk6({ autoCheck: true, autoNext: true, autoNextMs: 200 });
DOM.byClass(host6, 'av-opt')[0].click();                       // 选 A → 答错（正确答案 B）
eq([W1.s.results.a1.correct, W1.s.index, W1.v.stats().pendingJump, DOM.byAttr(host6, 'data-av', 'jumpbar').length],
   [false, 0, false, 0], '默认关着：答错 → 停在本题、不排定时器、也没有加载条');
await sleep(320);
eq(W1.s.index, 0, '  等过了也不翻（取消得干干净净）');

/* 开着：答错也排待跳，并显示加载条，到点真的翻 */
const W2 = mk6({ autoCheck: true, autoNext: true, autoNextMs: 200, autoNextWrong: true });
DOM.byClass(host6, 'av-opt')[0].click();                       // 选 A → 答错
eq([W2.s.results.a1.correct, W2.v.stats().pendingJump], [false, true],
   '开着：答错也**排上待跳**（不再停在这一题）');
eq(DOM.byAttr(host6, 'data-av', 'jumpbar').length, 1, '  同时出现小加载条（"每次自动翻页都要有"）');
eq(DOM.byAttr(host6, 'data-av', 'jumpbar')[0] ? DOM.byAttr(host6, 'data-av', 'jumpbar')[0].getAttribute('aria-label') : null,
   '正在自动翻页', '  条带 aria-label（读屏也知道在翻页）');
await sleep(320);
eq([W2.s.index, DOM.byAttr(host6, 'data-av', 'jumpbar').length], [1, 0], '  到点真的翻到第 2 题，条消失');
/* 对照：同一份配置下答**对**了也照旧翻（不是"只对错题生效"） */
const W3 = mk6({ autoCheck: true, autoNext: true, autoNextMs: 0, autoNextWrong: true });
DOM.byClass(host6, 'av-opt')[1].click();                       // 选 B → 答对
eq([W3.s.results.a1.correct, W3.s.index], [true, 1], '  对照：开着它时答对照样翻');
/* 主开关按住子开关：autoNext 关着时"错题也翻"不起作用 */
const W4 = mk6({ autoCheck: true, autoNext: false, autoNextMs: 200, autoNextWrong: true });
DOM.byClass(host6, 'av-opt')[0].click();
eq([W4.s.index, W4.v.stats().pendingJump], [0, false], '自动翻页关着 → 光开"错题也翻"不跳（子选项被按住）');

/* ============================================================
 *  ⑦ 用户要求：**答错了要指出正确答案，而且不自动翻页**
 *  （a1 的正确答案是 B，所以点第一个选项 A 就是"答错"）
 * ============================================================ */
head('⑦ 答错 → 当场给出正确答案 + 不自动翻页（真浏览器 DOM）');

const B12 = mk6({ autoCheck: true, autoNext: true, autoNextMs: 0 });   // 两个开关都开、等待 0（最容易看出"不翻"）
DOM.byClass(host6, 'av-opt')[0].click();                              // 选 A → 答错
eq([!!B12.s.checked.a1, B12.s.results.a1.correct], [true, false], '点错选项 → 当场判为错');
eq([B12.s.index, B12.v.stats().pendingJump], [0, false],
   '**停在本题、也不排定时器**（等待 0 时若还翻就说明新规则没生效）');
const badCard = DOM.byClass(host6, 'av-verdict');
eq(badCard.length, 1, '  判分卡在');
ok(/答错/.test(String(badCard[0] && badCard[0].textContent)), '  写着"答错了"：' + String(badCard[0] && badCard[0].textContent).slice(0, 20));
const ansHead = DOM.byClass(host6, 'av-panel').map(n => String(n.textContent)).join('｜');
ok(/正确答案：B/.test(ansHead), '  **把正确答案 B 给出来了**（时机=答完一题即显示；若不是这样，规则④也兜底）', ansHead.slice(0, 90));
/* 用户本轮要求：**删掉**「答错了：看完正确答案自己点「下一题」」那句提示 ——
 * 答错时选项已经标红/标绿、下面也写着正确答案，再叮嘱一遍是噪音。
 * "不自动翻页"这件事由上面那条 pendingJump 断言硬证（行为不依赖这句文案）。 */
ok(!/看完正确答案自己点/.test(ansHead) && !/答错了：/.test(ansHead),
   '  **不再**叮嘱"看完自己点下一题"（用户要求删掉；正确答案与红绿标注已经够了）', ansHead.slice(0, 120));

/* 用户本轮要求：**答错之后，你选的那个错项标红、正确项标绿**（单选/判断/多选都要）。
 * 判据落在 `data-mark` 上（颜色由 CSS 按它上色，测试读得到）。 */
const optMarks = function (host) {
  return DOM.byClass(host, 'av-opt').map(function (b) { return b.attrs['data-mark'] || ''; });
};
eq(optMarks(host6), ['bad', 'ok'],
   '答错（选了 A、答案是 B）→ 选错的 A 标 bad（红）、正确的 B 标 ok（绿）');
const marked = DOM.byClass(host6, 'av-opt').filter(function (b) { return (b.attrs['data-mark'] || '') !== ''; });
eq(marked.map(function (b) { return b.textContent.slice(-1); }), ['✗', '✓'],
   '  角标也跟着换字形（✗ / ✓，不只靠颜色 —— 色弱也能认）');
/* 没作答之前**不许**标（否则等于把答案提前画在选项上 = 泄题） */
const preMark = mk6({ autoCheck: true, autoNext: false, autoNextMs: 0 });
eq(optMarks(host6), ['', ''], '  一进来不标（没作答就没有对错可标）');
DOM.byClass(host6, 'av-opt')[0].click();                      // 选 A（错）→ 自动判分
eq(optMarks(host6), ['bad', 'ok'], '  判分之后立刻标（B12 那份也是这个结论，这里再确认一次）');
preMark.v.destroy();

/* 多选：正确的全绿、**你多选的那个**标红、没碰的不动 */
const M1 = mk6({ autoCheck: true, autoNext: false, autoNextMs: 0 });
A.goto(M1.s, 2); M1.v.refresh();                              // 第 3 题是多选（答案 AB，选项 A/B/C）
const mOpts = DOM.byClass(host6, 'av-opt');
eq(mOpts.length, 3, '多选题三个选项都在');
mOpts[0].click();                                             // 选 A（正确）
mOpts[2].click();                                             // 再选 C（错选）
const submitM = DOM.byAttr(host6, 'data-av', 'submit')[0];
ok(!!submitM, '多选答了之后出现「提交本题」（多选不自动判分）');
submitM.click();
eq(optMarks(host6), ['ok', 'ok', 'bad'],
   '多选提交后：A/B（正确答案）标绿、你多选的 C 标红');
eq(DOM.byClass(host6, 'av-opt').map(function (b) { return (b.attrs['data-mark'] || '') === '' ? '' : b.textContent.slice(-1); }),
   ['✓', '✓', '✗'], '  角标：两个正确 ✓、错选 ✗');
M1.v.destroy();

/* 用户本轮要求：**每次切换题型时要悬浮窗醒目标注**（同一题型连着答不打扰）。 */
const mkFlash = function () {
  host6.textContent = '';
  const s = A.createSession({ examId: 'NF', title: '题型提示卷', questions: sixQ,
    config: cfg({ behavior: { autoNextMs: 0 } }), startedAt: 'T' });
  const v = AttemptView.mount({ container: host6, session: s, onChange: function () {} });
  return { s: s, v: v };
};
const F1 = mkFlash();
eq(DOM.byAttr(host6, 'data-av', 'typeflash').length, 0, '刚进来**不弹**（只在"换题型"时弹）');
A.goto(F1.s, 1); F1.v.refresh();                       // 第 1 题单选 → 第 2 题简答
const fl1 = DOM.byAttr(host6, 'data-av', 'typeflash');
eq(fl1.length, 1, '换题型（单选 → 简答）→ 弹出悬浮提示');
const fl1n = fl1[0] || {};
eq(String(fl1n.textContent || ''), '切换到「简答题」', '  文案写明切到哪一型');
eq([(fl1n.attrs || {}).role, (fl1n.attrs || {})['aria-live']], ['status', 'polite'], '  无障碍：role=status + aria-live（读屏会播报）');
F1.v.refresh();
/* ⚠ 重绘会清空 av-root（提示块也一起没了）—— 要证的是"**不会越堆越多**"，不是"必须还在"：
 *   重绘通常意味着用户又操作了一下，提示提前消失是合理的。 */
ok(DOM.byAttr(host6, 'data-av', 'typeflash').length <= 1,
   '  同一题重绘不会叠出第二块（最多一块）', DOM.byAttr(host6, 'data-av', 'typeflash').length);
A.goto(F1.s, 2); F1.v.refresh();                       // 简答 → 多选
const fl2 = DOM.byAttr(host6, 'data-av', 'typeflash');
eq([fl2.length, String((fl2[0] || {}).textContent || '')], [1, '切换到「多选题」'], '  再换一次 → 换成「多选题」（旧的被替掉，不堆叠）');
F1.v.destroy();
/* 同一题型连着答：**不弹**（每题闪一下会很吵） */
const F2 = (function () {
  host6.textContent = '';
  const two = [S.createQuestion({ id: 's1', type: '单选', stem: '甲', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['A'], answer: 'A' }),
               S.createQuestion({ id: 's2', type: '单选', stem: '乙', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['B'], answer: 'B' })];
  const s = A.createSession({ examId: 'NF2', title: '同型卷', questions: two, config: cfg({ behavior: { autoNextMs: 0 } }), startedAt: 'T' });
  const v = AttemptView.mount({ container: host6, session: s, onChange: function () {} });
  return { s: s, v: v };
})();
A.goto(F2.s, 1); F2.v.refresh();
eq(DOM.byAttr(host6, 'data-av', 'typeflash').length, 0, '  同一题型（单选 → 单选）不弹');
F2.v.destroy();

/* 对照：答对 → 照旧翻（否则"答错不翻"就变成了"永远不翻"） */
const B13 = mk6({ autoCheck: true, autoNext: true, autoNextMs: 0 });
DOM.byClass(host6, 'av-opt')[1].click();                              // 选 B → 答对
eq([B13.s.results.a1.correct, B13.s.index], [true, 1], '  对照：答对仍然"点完就翻"（答错不翻 ≠ 一律不翻）');

/* 答错 + 时机=整卷后：规则④照样当场给答案（这是"答错了必须指出正确答案"的硬保证） */
const B14 = mk6({ autoCheck: true, autoNext: true, autoNextMs: 0 });
A.setConfig(B14.s, Q.mergeConfig(B14.s.config, { reveal: { answerTiming: 'end', explainTiming: 'end' } }));
B14.v.refresh();
DOM.byClass(host6, 'av-opt')[0].click();                              // 选 A → 答错
const ansHead2 = DOM.byClass(host6, 'av-panel').map(n => String(n.textContent)).join('｜');
ok(/正确答案：B/.test(ansHead2), '答错 + 时机=整卷后：**也**当场给出正确答案（不等到交卷）', ansHead2.slice(0, 90));
eq([B14.s.index, B14.v.stats().pendingJump], [0, false], '  并且不翻页');

/* ============================================================
 *  ⑨ 用户要求：**多选与简答不自动判分** + 「提交本题」 + **得全分才自动跳**
 * ============================================================ */
head('⑨ 多选/简答不自动判分 → 点「提交本题」才判；提交后**得全分**才自动跳');

/* a. 多选：自动判分**开着**，点选项也不判分（只是记下来），并出现「提交本题」 */
const S1 = mk6({ autoCheck: true, autoNext: true, autoNextMs: 0 });
A.goto(S1.s, 2); S1.v.refresh();                       // 第 3 题是多选（答案 AB），后面还有第 4 题可翻
eq(DOM.byAttr(host6, 'data-av', 'submit').length, 0, '多选还没作答 → 没有「提交本题」');
DOM.byClass(host6, 'av-opt')[0].click();               // 选 A
eq([!!S1.s.checked.a3m, DOM.byClass(host6, 'av-verdict').length, S1.s.index], [false, 0, 2],
   '多选：自动判分开着，点选项**也不判分、也不翻**（用户要求 —— 还没点完 B/C）');
eq(DOM.byAttr(host6, 'data-av', 'submit').length, 1, '  答了还没判 → 出现「提交本题」');
DOM.byClass(host6, 'av-opt')[1].click();               // 再选 B → 答案 AB（全对）
eq(S1.s.answers.a3m, 'AB', '  继续点第二个 → 答案累加（仍然没判分）');
DOM.byAttr(host6, 'data-av', 'submit')[0].click();
eq([!!S1.s.checked.a3m, S1.s.results.a3m.correct], [true, true], '点「提交本题」→ 这才判分（AB 全对）');
eq([S1.s.index, S1.v.stats().pendingJump], [3, false],
   '  **得全分** → 提交后立刻翻到下一题（等待 0）');
eq(DOM.byAttr(host6, 'data-av', 'submit').length, 0, '  判过之后按钮收起来（不常驻）');

/* b. 多选没答全（半对/0 分）：提交后**不翻**，并当场给出正确答案 */
const S2 = mk6({ autoCheck: true, autoNext: true, autoNextMs: 0 });
A.goto(S2.s, 2); S2.v.refresh();
DOM.byClass(host6, 'av-opt')[0].click();               // 只选 A（答案是 AB）
DOM.byAttr(host6, 'data-av', 'submit')[0].click();
eq([S2.s.results.a3m.correct, S2.s.index, S2.v.stats().pendingJump], [false, 2, false],
   '多选没答全 → **停在本题、不排定时器**（没得全分就不跳）');
ok(/正确答案/.test(String(DOM.byClass(host6, 'av-panel').map(function (n) { return n.textContent; }).join('｜'))),
   '  而且当场把正确答案写出来（规则④）');

/* c. 简答：打字不判分 → 点「提交本题」才判；关键词全命中 = 得全分 → 提交后自动跳 */
const S3 = mk6({ autoCheck: true, autoNext: true, autoNextMs: 0 });
A.goto(S3.s, 1); S3.v.refresh();                       // 第 2 题是简答（关键词「甲」）
const ta3 = DOM.byClass(host6, 'av-text')[0];
ta3.value = '甲'; ta3.dispatchEvent('input');
eq([!!S3.s.checked.a2, DOM.byAttr(host6, 'data-av', 'submit').length], [false, 1],
   '简答：打字**不自动判分**，但出现「提交本题」');
eq(S3.s.index, 1, '  而且不翻页（打字过程中绝不翻走）');
DOM.byAttr(host6, 'data-av', 'submit')[0].click();
eq([S3.s.results.a2.correct, S3.s.index], [true, 2], '点提交 → 判分（命中全部关键词 = 得全分）→ 自动翻');

/* d. 简答只答一半：提交后不翻（与多选同一条规矩） */
const S4 = mk6({ autoCheck: true, autoNext: true, autoNextMs: 0 });
A.goto(S4.s, 1); S4.v.refresh();
const ta4 = DOM.byClass(host6, 'av-text')[0];
ta4.value = '这一段里没有采分关键词'; ta4.dispatchEvent('input');
DOM.byAttr(host6, 'data-av', 'submit')[0].click();
eq([S4.s.results.a2.correct, S4.s.index, S4.v.stats().pendingJump], [false, 1, false],
   '简答没答全 → 不跳（停在这一题看参考答案）');

/* e. 判据就一句"答了但还没判"：自动判分**关着**时单选/判断也出现按钮 */
const S5 = mk6({ autoCheck: false, autoNext: false });
DOM.byClass(host6, 'av-opt')[1].click();               // 单选，选 B（正确）
eq([!!S5.s.checked.a1, DOM.byAttr(host6, 'data-av', 'submit').length], [false, 1],
   '自动判分关着时的单选：答了没判 → 也有「提交本题」');
DOM.byAttr(host6, 'data-av', 'submit')[0].click();
eq(!!S5.s.checked.a1, true, '  点它 → 判分');
eq(DOM.byAttr(host6, 'data-av', 'submit').length, 0, '  判完收起来');

/* f. 用户要求：**多选题解析下面那排「命中 / 未命中」删掉**（简答那排是采分关键词，保留） */
const chipTexts = function (host) {
  return DOM.byClass(host, 'av-chip').map(function (n) { return String(n.textContent); });
};
const S6 = mk6({ autoCheck: true, autoNext: false });   // 不自动翻：要停在解析卡上看标签
A.goto(S6.s, 2); S6.v.refresh();                        // 第 3 题是多选（答案 AB）
DOM.byClass(host6, 'av-opt')[0].click();                // 选 A（命中一半）
DOM.byClass(host6, 'av-opt')[1].click();                // 再选 B（全对）
DOM.byAttr(host6, 'data-av', 'submit')[0].click();
eq(S6.s.results.a3m.correct, true, '多选全对（AB）——作为"命中/未命中"那条的对照题');
eq(chipTexts(host6).filter(function (t) { return /^命中：/.test(t) || /^未命中：/.test(t); }), [],
   '**多选题的「命中 / 未命中」标签一个都没有**（用户要求删掉）', chipTexts(host6));
eq(DOM.byClass(host6, 'av-verdict').length, 1, '  但判分结论还在（删的是标签，不是解析卡）');
const multiPanel = String(DOM.byClass(host6, 'av-panel')[0].textContent);
ok(/正确答案：/.test(multiPanel) && /A/.test(multiPanel) && /B/.test(multiPanel),
   '  正确答案照旧写出来（含 A、B 两个字母）：' + multiPanel.slice(0, 60));
/* 错选那一枚**保留**：它点的是"你选的哪个是错的"，别处没有这个信息 */
const S7 = mk6({ autoCheck: true, autoNext: false });
A.goto(S7.s, 2); S7.v.refresh();
DOM.byClass(host6, 'av-opt')[0].click();                // 选 A（对）
DOM.byClass(host6, 'av-opt')[2].click();                // 再选 C（错选）
DOM.byAttr(host6, 'data-av', 'submit')[0].click();
eq(chipTexts(host6), ['错选：C'], '多选选了错的 → 只留「错选：C」这一枚（命中/未命中不出现）');
/* 反向对照：简答的「命中 / 未命中」是采分关键词，必须还在（否则这次改动就成了"整排都删"） */
const S8 = mk6({ autoCheck: true, autoNext: false });
A.goto(S8.s, 1); S8.v.refresh();
const ta8 = DOM.byClass(host6, 'av-text')[0];
ta8.value = '这一段里没有采分关键词'; ta8.dispatchEvent('input');
DOM.byAttr(host6, 'data-av', 'submit')[0].click();
eq(S8.s.results.a2.correct, false, '简答：没答到采分点 → 判错');
eq(chipTexts(host6).filter(function (t) { return /^未命中：/.test(t); }).length > 0, true,
   '**简答的「未命中：关键词」照旧显示**（那是它的得分依据，不能跟着多选一起删）', chipTexts(host6));

head('⑪ 答题计时：悬浮球（固定定位、不占位置）+ 点一下暂停 + 交卷后写用时');

const mkTimer = function (on) {
  const d = DOM.makeDoc();
  const h = d.createElement('div');
  d.documentElement.appendChild(h);
  const s = A.createSession({ examId: 'N9', title: '计时卷', questions: five,
    config: cfg({ behavior: { timer: on === true, autoCheck: false, autoNext: false } }), startedAt: 'T' });
  const v = AttemptView.mount({ container: h, session: s, onChange: function () {} });
  return { doc: d, host: h, session: s, view: v };
};
const T0 = mkTimer(false);
eq(DOM.byAttr(T0.host, 'data-av', 'timer').length, 0, '计时开关关着 → 不画悬浮球（默认不打扰）');
eq(T0.view.stats().timerOn, false, '  stats().timerOn = false');
const T1 = mkTimer(true);
const ball = DOM.byAttr(T1.host, 'data-av', 'timer')[0];
ok(!!ball, '开着 → 答题界面出现计时悬浮球');
eq(ball ? ball.tagName : null, 'BUTTON', '  它是真按钮（能点）');
eq(DOM.byClass(T1.host, 'av-timer').length, 1, '  只有一颗球（不重复画）');
eq(T1.view.stats().timerOn, true, '  stats().timerOn = true');
ok(/^\d+:\d\d$/.test(T1.view.timerText()), '  球上是 mm:ss 读数：' + T1.view.timerText());
await sleep(1200);
ok(T1.view.stats().timerMs >= 1000, '  过了 1.2 秒 → 累计 ≥ 1000ms（真的在走）', T1.view.stats().timerMs);
const beforePause = T1.view.stats().timerMs;
DOM.byAttr(T1.host, 'data-av', 'timer')[0].click();
eq(T1.view.stats().timerPaused, true, '点一下 → 暂停（stats().timerPaused = true）');
eq(T1.session.timer.paused, true, '  状态落在 session.timer 里（能随进度一起存本机）');
await sleep(700);
/* ⚠ 允许 1–2ms 的采样噪声：`beforePause` 是点击**之前**读的，而暂停落库发生在点击那一刻，
 *   两者之间正好可能跨过一个毫秒（机器忙时必现）。真正要证的是"**这 700ms 里没有增长**"。 */
ok(Math.abs(T1.view.stats().timerMs - beforePause) <= 2,
   '  暂停期间读数不再增长（真的停了，不是画着玩）', '暂停前 ' + beforePause + ' → 现在 ' + T1.view.stats().timerMs);
const pausedBall = DOM.byAttr(T1.host, 'data-av', 'timer')[0];
ok(/已暂停/.test(String(pausedBall && pausedBall.textContent)), '  球上写着「已暂停 ▶」：' + String(pausedBall && pausedBall.textContent));
ok(/已暂停/.test(String(pausedBall && pausedBall.getAttribute('aria-label'))), '  aria-label 也说清已暂停');
DOM.byAttr(T1.host, 'data-av', 'timer')[0].click();
eq(T1.view.stats().timerPaused, false, '再点一下 → 继续走表');
await sleep(1200);                        // ⚠ 别缩到 700：计时器每 500ms 一跳，机器忙时那一跳会被推迟，
                                          //   于是"又长了"这条会偶发变红（台账里出现过一次 231/1 的抖动）
ok(T1.view.stats().timerMs > beforePause, '  继续之后读数又长了', T1.view.stats().timerMs);
const T2 = mkTimer(true);
await sleep(1100);
A.answer(T2.session, 'B'); A.submitCurrent(T2.session);
A.finish(T2.session, { confirmUnanswered: true, now: 'T3' });
T2.view.refresh();
eq(DOM.byAttr(T2.host, 'data-av', 'timer').length, 0, '交卷之后球收起（不再占屏幕）');
const kvTxt = String((DOM.byClass(T2.host, 'av-kv')[0] || {}).textContent);
ok(/用时 \d+:\d\d/.test(kvTxt), '  成绩单里写一行「用时 mm:ss」：' + kvTxt.slice(0, 60));
ok(/及格 \d+%（\d+(\.\d+)? \/ \d+ 分）/.test(kvTxt) && /优秀 \d+%/.test(kvTxt),
   '  成绩单上的分数线写的是**比例**+等效分数（用户要求改比例）：' + kvTxt.slice(0, 80));
A.setConfig(T1.session, cfg({ behavior: { timer: false, autoCheck: false, autoNext: false } }));
T1.view.refresh();
eq(DOM.byAttr(T1.host, 'data-av', 'timer').length, 0, '把计时关掉 → 球立刻消失');
T1.view.destroy();

/* ============================================================
/* ============================================================
 * ⑩ 交卷门禁的「返回继续作答」要**自动跳到第一道没作答的题**（用户要求）
 *   "未作答完点击交卷后的返回按钮应该自动跳转未作答的题目"
 * ============================================================ */
head('⑩ 交卷门禁：点「返回继续作答」→ 直接跳到第一道未作答的题（用户要求）');

const G = mk6({ autoCheck: true, autoNext: false });
const sessG = G.s;
/* 四题（单选 / 简答 / 多选 / 判断）里只答第 1 题 → 未作答的应当是下标 1、2、3；
 * 再手动跳到最后一题，模拟"人不在第一道未答题上就点了交卷"。 */
DOM.byClass(host6, 'av-opt')[0].click();                 // 第 1 题作答（单选，点一下就判）
A.goto(sessG, 3); G.v.refresh();
eq(A.gate(sessG).unanswered.map(u => u.index), [1, 2, 3], '前置：第 2/3/4 题都没作答');
eq(sessG.index, 3, '前置：当前停在最后一题（不在第一道未答题上）');
DOM.byAttr(host6, 'data-av', 'finish')[0].click();       // 交卷 → 门禁拦下
eq([!!DOM.byClass(host6, 'av-confirm').length, A.view(sessG).finished], [true, false],
   '  未答完点交卷 → 给出提示、且**不**标记交卷');
const gateMsg = String(DOM.byClass(host6, 'av-confirm')[0].textContent);
ok(/还有 3 题没有作答/.test(gateMsg) && /第 2、3、4 题/.test(gateMsg), '  提示里点名是哪几题：' + gateMsg.slice(0, 44));
DOM.byAttr(host6, 'data-av', 'back')[0].click();          // ← 这一下必须"跳过去"
eq([sessG.index, A.view(sessG).finished], [1, false],
   '点「返回继续作答」→ **自动跳到第 2 题**（第一道未作答的），会话仍未交卷');
eq(DOM.byClass(host6, 'av-confirm').length, 0, '  提示关掉（回到答题界面）');
eq(DOM.byClass(host6, 'av-verdict').length, 0, '  没有提前判分/结算的痕迹');

/* 反向对照：把剩下三题都答掉 → 再点交卷不该再拦（门禁只在真有未答时出现） */
[1, 2, 3].forEach(function (i) {
  A.goto(sessG, i); G.v.refresh();
  const opts = DOM.byClass(host6, 'av-opt');
  if (opts.length) opts[0].click();
  else {
    const ta = DOM.byClass(host6, 'av-text')[0];
    if (ta) { ta.value = '甲'; ta.dispatchEvent('input'); }
  }
});
eq(A.gate(sessG).ok, true, '对照：四题都答完后门禁放行');
DOM.byAttr(host6, 'data-av', 'finish')[0].click();
eq([DOM.byClass(host6, 'av-confirm').length, A.view(sessG).finished], [0, true],
   '  再点交卷 → 直接结算（不再弹提示）');

console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
console.log('  PASS ' + pass + '    FAIL ' + fail);
if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
console.log('  \x1b[90m注：③ 的"窄屏无横向滚动 / 点击区 ≥44px"只有真浏览器能验 → 见 浏览器自检.html 的 K 节\x1b[0m');
process.exitCode = fail ? 1 : 0;
}

main().catch(e => { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
