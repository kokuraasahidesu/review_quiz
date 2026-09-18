/* ============================================================
 *  verify/ai-scene.test.js —— 「整卷点评与举一反三」小类验收
 *
 *  运行： node verify/ai-scene.test.js
 *
 *  三条盘档验收标准，逐条对应：
 *    ① 总评内容基于本轮实际答题记录（能引用得分与误答题目），**不是通用套话**；
 *    ② 举一反三生成的新题可**一键加入当前试卷**，并出现在**对应题型分组**中；
 *    ③ 两处操作都在**用户点击后**才发请求，且失败时给**可读原因**。
 *
 *  假 fetch 跑（不联网零成本）；真调用见 `verify/real-ai.js`（新增总评 + 误答新题两段）。
 * ============================================================ */
const A = require('../core/ai.js');
const D = require('../core/data.js');
const E = require('../core/exams.js');
const S = require('../core/schema.js');
const DOM = require('./mini-dom.js');
const AiScene = require('../ui/ai-scene.js');

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

const CANARY = 'sk-canary-9f3a7c1e5b2d4680zz';
function backend() {
  const m = new Map();
  return {
    getItem: k => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: k => { m.delete(String(k)); },
    key: i => { const a = Array.from(m.keys()); return i < a.length ? a[i] : null; },
    get length() { return m.size; }
  };
}
function fakeFetch(plan) {
  const calls = [];
  const f = async function (url, init) {
    calls.push({ url: url, headers: Object.assign({}, init.headers), body: init.body });
    const pick = plan[Math.min(calls.length - 1, plan.length - 1)];
    if (pick && pick.throwStatus) return { ok: false, status: pick.throwStatus, text: async () => '{"error":"boom"}' };
    const content = (typeof pick === 'string') ? pick : JSON.stringify(pick);
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: content } }] }) };
  };
  f.calls = calls;
  return f;
}
async function keyStore(provider) {
  const bk = backend();
  const st = A.openKeyStore(bk);
  await A.saveKey(st, provider || 'dashscope', CANARY, { now: '2026-10-28T09:00:00.000Z' });
  return { store: A.openKeyStore(bk), backend: bk };
}
function appStore() {
  const bk = backend();
  return { store: D.createStore({ small: bk, large: null, namespace: D.NS_GLOBAL }), backend: bk };
}

/* 一套三题的卷 + 一轮"真结算"（用 scoreExam/FlowCore 得出 per，不手捏） */
const Q = require('../core/quiz.js');
const F = require('../core/flow.js');
function makePaper() {
  const qs = [
    S.createQuestion({ id: 'r1', type: '单选', stem: 'HTTP 默认端口是哪个？', options: [{ label: 'A', text: '21' }, { label: 'B', text: '80' }, { label: 'C', text: '443' }], answerLetters: ['B'], answer: 'B', explanation: '80 是明文默认端口。' }),
    S.createQuestion({ id: 'r2', type: '判断', stem: 'TCP 是面向连接的协议。', judgeValue: true, explanation: '三次握手。' }),
    S.createQuestion({ id: 'r3', type: '简答', stem: '简述三次握手的过程。', keywords: [{ text: 'SYN' }, { text: 'ACK' }], answer: 'SYN/ACK' })
  ];
  const answers = { r1: 'A', r2: '对', r3: 'SYN' };            // 单选错、判断对、简答半对
  const cfg = Q.mergeConfig(Q.DEFAULT_CONFIG, {});
  const scored = Q.scoreExam(qs, answers, cfg);
  const summary = Object.assign({}, scored, { level: F.gradeLevel(scored.percent, cfg).level });
  return { qs: qs, answers: answers, summary: summary };
}
const PAPER = makePaper();
const WRONG_QI = { lastAnswer: 'A', times: 2, lastScore: 0, lastFull: 2 };
/* 期望值一律**从真结算里算**，不写死字面量：写死过一次（以为 2/4 分，实际 3.5/8），
 * 结果一整排断言都在测"我脑子里的数"而不是产品的数。 */
const SC = PAPER.summary.score, FULL = PAPER.summary.full, PCT = PAPER.summary.percent;
const CC = PAPER.summary.correctCount, TT = PAPER.summary.total;
const WRONG_N = PAPER.summary.per.filter(function (p) { return !p.correct; }).length;

(async function main() {

head('①-A 整卷简报：把本轮的真实数值与逐题情况都写进提示词（总评/测试的唯一事实来源）');

const b1 = A.examBrief(PAPER.summary, PAPER.qs, { answers: PAPER.answers });
ok(b1.text.indexOf(SC + ' / ' + FULL + ' 分') >= 0, '简报里写着真实得分（' + SC + '/' + FULL + '）', b1.text.split('\n')[0]);
ok(b1.text.indexOf(PCT + '%') >= 0, '  也写着百分数：' + PCT + '%');
ok(b1.text.indexOf('答对 ' + CC + ' / ' + TT) >= 0, '  也写着答对题数');
ok(b1.text.indexOf('HTTP 默认端口是哪个？') >= 0, '  逐题列出题干（错题也在里面）');
ok(b1.text.indexOf('你的作答：A') >= 0, '  **每题都带着"你的作答"**（来自 answers，结算里没有这一项）');
ok(b1.text.indexOf('正确答案：B') >= 0, '  以及正确答案（走 QuizCore.answerText 同一口径）');
ok(b1.text.indexOf('你的作答：（未作答）') < 0, '  **一行都没被误写成"未作答"**（不传 answers 时才会那样）');
ok(/✘ 答错/.test(b1.text) && /✔ 答对/.test(b1.text), '  对错标记与真实结算一致');
eq([b1.wrongCount, b1.wrongLabels.length], [WRONG_N, WRONG_N], '简报自己统计误答：' + WRONG_N + ' 题');
ok(b1.facts.strong.indexOf(String(PCT)) >= 0 && b1.facts.strong.indexOf(CC + '/' + TT) >= 0,
   '  可核对的"强证据"里含百分数与答对题数对', JSON.stringify(b1.facts.strong));
ok(b1.facts.stems.length >= 3, '  也抽出了题面片段（用于反套话判定）', JSON.stringify(b1.facts.stems));
const noAns = A.examBrief(PAPER.summary, PAPER.qs, {});
ok(noAns.text.indexOf('你的作答：（未作答）') >= 0, '反向对照：不传 answers → 退化成"（未作答）"（这就是必须传的理由）');

const req1 = A.reviewRequest(PAPER.summary, PAPER.qs, { answers: PAPER.answers });
eq(req1.opt.task, 'review', '请求模板的任务名是 review');
eq(req1.opt.retries, 0, '  总评也**不重试**（一次点击一次请求；确认窗里已经告知消耗）');
ok(req1.opt.user.indexOf('HTTP 默认端口是哪个？') >= 0 && req1.opt.user.indexOf(PCT + '%') >= 0,
   '  **发给模型的正文里就带着真实数字与错题面**（不是只写在文档里）');
ok(/必须/.test(req1.opt.user) && /套话/.test(req1.opt.user), '  并明确要求"引用真实数字与错题，不要套话"');

head('①-B 反套话闸门：只说通用建议一律拒绝，引用了本轮记录才通过');

const generic = { summary: '多做练习，每天复习 1 小时，注意基础。', weakPoints: ['基础不牢'], advice: ['每天练习'] };
const g1 = A.checkReviewGrounding(generic, b1);
eq([g1.ok, g1.hitStrong, g1.hitStems], [false, [], []], '通用套话（连"1 小时"这种弱整数都有）→ **拒绝**');
ok(/套话/.test(g1.reason), '  拒绝原因说得明白：' + g1.reason);
eq(A.checkReviewGrounding({ summary: '这次只拿了 ' + SC + ' 分，HTTP 默认端口那题答错了。', weakPoints: ['端口'], advice: ['背端口表'] }, b1).ok,
   true, '引用了得分与错题 → 通过');
eq(A.checkReviewGrounding({ summary: '总体还行。', weakPoints: ['题面：HTTP 默认端口'], advice: ['a'] }, b1).ok, true,
   '  只在薄弱点里提到错题面也算数（三处文本一起看）');
eq(A.checkReviewGrounding({ summary: '你这次是 ' + PCT + '% 的正确率。', weakPoints: ['x'], advice: ['y'] }, b1).ok, true,
   '  引用百分数也算数');
eq(A.checkReviewGrounding({ summary: '你答对了 ' + CC + '/' + TT + ' 题。', weakPoints: ['x'], advice: ['y'] }, b1).ok, true,
   '  引用"答对/总数"也算数');

head('①-C 总评结构：必须点出薄弱考点与建议（空列表等于没写）');

eq(A.validate('review', { summary: 'x', weakPoints: ['a'], advice: ['b'] }).ok, true, '总评 + 薄弱点 + 建议 三件齐全 → 通过');
eq(A.validate('review', { summary: 'x', advice: ['b'] }).errors, ['缺少字段 weakPoints'], '缺薄弱考点 → 拒绝');
eq(A.validate('review', { summary: 'x', weakPoints: [], advice: ['b'] }).errors,
   ['weakPoints 是空的（要点出薄弱考点并给出建议）'], '薄弱考点是空数组 → 拒绝');
eq(A.validate('review', { summary: 'x', weakPoints: ['  '], advice: ['b'] }).errors,
   ['weakPoints 是空的（要点出薄弱考点并给出建议）'], '  全是空白字符串也算空');
eq(A.validate('review', { summary: '', weakPoints: ['a'], advice: ['b'] }).errors, ['summary 应为非空字符串'], '总评空白 → 拒绝');

head('③-A 整卷总评：**先确认再发**（未确认零请求，确认后恰好 1 次）');

const ks = await keyStore();
const f1 = fakeFetch([{ summary: '本轮 ' + SC + '/' + FULL + ' 分，HTTP 默认端口这题答错了。', weakPoints: ['端口与协议对应关系'], advice: ['把常用端口表背一遍'] }]);
let counted1 = 0;
const needConfirm = await A.runReview(ks.store, f1, 'dashscope', PAPER.summary, PAPER.qs, { answers: PAPER.answers }, { onRequest: function () { counted1++; } });
eq([needConfirm.ok, needConfirm.needConfirm, needConfirm.requestCount], [false, true, 0], '没确认 → 返回 needConfirm 且**请求数 0**');
eq(f1.calls.length, 0, '  **一次请求都没发**（这才叫"用户点击后才发起"）');
ok(needConfirm.confirm.promptTokens > 0, '  确认模型带上了 token 估算：' + needConfirm.confirm.promptTokens + ' tokens');
ok(/2 题|每一题|逐题/.test(needConfirm.confirm.message) || /总评/.test(needConfirm.confirm.message), '  确认文案说清"会把本轮记录发给谁"', needConfirm.confirm.message);
eq(needConfirm.confirm.wrongCount, 2, '  也告知误答题数（2 题）');

const ok1 = await A.runReview(ks.store, f1, 'dashscope', PAPER.summary, PAPER.qs, { confirmed: true, answers: PAPER.answers }, { onRequest: function () { counted1++; } });
eq([ok1.ok, ok1.requestCount, ok1.attempts], [true, 1, 1], '确认后 → 通过且**恰好 1 次请求**');
eq(f1.calls.length, 1, '  假 fetch 只被调用 1 次');
eq(counted1, 1, '  onRequest 计数也是 1');
ok(ok1.grounding.ok === true && ok1.grounding.hitStrong.length >= 1, '  闸门记录了它引用了什么：' + JSON.stringify(ok1.grounding.hitStrong));
eq(ok1.value.weakPoints.length, 1, '  薄弱考点传了回来（界面要显示）');

head('③-B 总评的失败都要说人话（套话/缺字段/鉴权）');

const f2 = fakeFetch([{ summary: '多做练习，打好基础。', weakPoints: ['基础'], advice: ['多做题'] }]);
const bland = await A.runReview(ks.store, f2, 'dashscope', PAPER.summary, PAPER.qs, { confirmed: true, answers: PAPER.answers }, {});
eq([bland.ok, bland.stage], [false, 'grounding'], '模型回套话 → 拒绝，阶段标成 grounding');
ok(/套话/.test(bland.errors.join('')), '  原因可读：' + bland.errors.join('；'));
eq(bland.requestCount, 1, '  这一轮也只发了 1 次请求');

const f3 = fakeFetch([{ summary: '只给总评', advice: ['x'] }]);
const missing = await A.runReview(ks.store, f3, 'dashscope', PAPER.summary, PAPER.qs, { confirmed: true, answers: PAPER.answers }, {});
eq([missing.ok, missing.stage, missing.errors], [false, 'schema', ['缺少字段 weakPoints']], '缺薄弱考点 → 拒绝（schema 阶段）');
const f4 = fakeFetch([{ throwStatus: 401 }]);
const auth = await A.runReview(ks.store, f4, 'dashscope', PAPER.summary, PAPER.qs, { confirmed: true, answers: PAPER.answers }, {});
eq([auth.ok, auth.stage, auth.kind2], [false, 'call', 'auth'], '鉴权失败 → 归类 auth');
ok(/Key/.test((auth.errors || []).join('') + (auth.hint || '')), '  给出可操作建议：' + (auth.hint || ''));
const f5 = fakeFetch([{ throwStatus: 429 }]);
const limited = await A.runReview(ks.store, f5, 'dashscope', PAPER.summary, PAPER.qs, { confirmed: true, answers: PAPER.answers }, {});
eq([limited.ok, limited.kind2], [false, 'rate_limit'], '限流 → 归类 rate_limit 并有建议');
const blocked = await A.runReview(ks.store, f5, 'openai', PAPER.summary, PAPER.qs, { confirmed: true, answers: PAPER.answers }, {});
eq([blocked.ok, blocked.stage, blocked.requestCount], [false, 'provider', 0], '不可直连的家 → 拦住且零请求');
const noKey = await A.runReview(A.openKeyStore(backend()), f5, 'dashscope', PAPER.summary, PAPER.qs, { confirmed: true, answers: PAPER.answers }, {});
eq([noKey.ok, noKey.stage], [false, 'call'], '没填 Key → 拒绝（原因来自 callSaved）');

head('②-A 举一反三：误答条目进提示词（冲着你错的地方出新题）');

const mb = A.mistakeBrief(PAPER.qs[0], WRONG_QI);
ok(mb.indexOf('你当时的错答：A') >= 0, '简报里带上"你当时的错答"', mb.replace(/\n/g, ' | '));
ok(mb.indexOf('已经错了 2 次') >= 0, '  也带上错误次数（决定要不要练这一考点）');
ok(mb.indexOf('最近一次得分：0/2') >= 0, '  以及最近一次得分');
const req2 = A.singleRequest('variant', PAPER.qs[0], { context: mb });
ok(req2.user.indexOf('你当时的错答：A') >= 0 && req2.user.indexOf('HTTP 默认端口') >= 0,
   '  请求正文里既有原题也有错答（模型据此出同考点新题）');
eq(req2.retries, 0, '  单题路径仍然**不重试**');

const ks2 = await keyStore();
const f6 = fakeFetch([{ type: '单选', stem: 'HTTPS 默认使用哪个端口？', answer: 'C', options: [{ label: 'A', text: '21' }, { label: 'B', text: '80' }, { label: 'C', text: '443' }] }]);
let counted2 = 0;
const vr = await A.runMistakeVariant(ks2.store, f6, 'dashscope', PAPER.qs[0], WRONG_QI, {}, { onRequest: function () { counted2++; } });
eq([vr.ok, vr.requestCount, vr.attempts], [true, 1, 1], '一键出新题：通过且 1 次请求');
eq([f6.calls.length, counted2], [1, 1], '  假 fetch 与 onRequest 都只记 1 次');
eq(vr.question.type, '单选', '  新题题型合法');
ok(vr.question.stem !== PAPER.qs[0].stem, '  题面换了（不是抄原题）', vr.question.stem);

head('②-B 一键加入试卷：真的进卷、进对应题型分组、计数同步');

const app = appStore();
const made = await E.createExam(app.store, { id: 'EXSC', title: '场景卷' });
eq(made.ok, true, '先建一套卷');
const seeded = await E.setQuestions(app.store, 'EXSC', PAPER.qs, { now: '2026-10-28T09:00:00.000Z' });
eq([seeded.ok, seeded.after.total, seeded.after['单选']], [true, 3, 1], '  放进 3 道题（单选 1 / 判断 1 / 简答 1）');

const add1 = await A.appendVariant(app.store, 'EXSC', vr.question, { now: '2026-10-28T09:30:00.000Z' });
eq([add1.ok, add1.type, add1.inGroup], [true, '单选', true], '加入成功，并且**落在"单选"分组里**');
eq([add1.before.total, add1.after.total], [3, 4], '  整卷题数 3 → 4');
eq([add1.before['单选'], add1.after['单选'], add1.groupCount], [1, 2, 2], '  **单选分组计数 +1**（1 → 2），且分组里确实有这道新题');
const back = await E.getExam(app.store, 'EXSC');
eq(back.exam.questions.length, 4, '  读回卷子：4 道题');
ok(back.exam.questions.some(function (x) { return x.id === add1.question.id; }), '  新题在卷子里（id 对得上）');
const grouped = E.groupQuestions(back.exam.questions);
/* 卷册层追加题目时会**重新分配 id**（归一策略），所以对照要用"落盘后那第一道单选"的真 id */
const seededQs = (await E.getExam(app.store, 'EXSC')).exam.questions;
eq(grouped['单选'].map(function (x) { return x.question.id; }), [seededQs[0].id, add1.question.id],
   '分组视图里新题排在单选组末尾（对照用的是落盘后的真 id）');
eq(grouped['判断'].length + grouped['简答'].length, 2, '  别的分组数目没被改动');
const list = await E.listExams(app.store);
eq(list.exams[0].counts.total, 4, '  卷册 meta 也同步成 4 题（列表页看到的数一致）');

head('②-C 加入试卷的三道闸门：非法题一律不写，卷子逐字节不变');

const beforeRaw = JSON.stringify(await E.getExam(app.store, 'EXSC'));
const bad1 = await A.appendVariant(app.store, 'EXSC', { type: '单选', stem: '缺答案的选择题' }, {});
eq([bad1.ok, bad1.stage], [false, 'schema'], '结构不合法的题 → 拒绝');
ok(/选项少于 2 个|没有答案/.test(bad1.error), '  原因可读：' + bad1.error);
const bad2 = await A.appendVariant(app.store, '不存在的卷', vr.question, {});
eq([bad2.ok, bad2.stage], [false, 'store'], '卷不存在 → 拒绝');
ok(/找不到/.test(bad2.error), '  原因可读：' + bad2.error);
const bad3 = await A.appendVariant(null, 'EXSC', vr.question, {});
eq([bad3.ok, bad3.error], [false, '没有可用的存储'], '没有存储 → 拒绝');
const bad4 = await A.appendVariant(app.store, 'EXSC', null, {});
eq([bad4.ok, bad4.error], [false, '要加入的题目不是对象'], '不是题对象 → 拒绝');
eq(JSON.stringify(await E.getExam(app.store, 'EXSC')), beforeRaw, '**四种拒绝之后卷子逐字节未变**');
eq((await E.scanOrphans(app.store)).orphans, [], '  也没有留下任何孤儿数据');

head('③-C 界面（真挂载）：总评有确认窗、举一反三没有；两处失败都给可读原因');

const doc = DOM.makeDoc();
const host = doc.createElement('div');
doc.documentElement.appendChild(host);

/* 总评面板：点一次 → 只有确认窗（零请求）→ 取消 → 仍然零请求 → 再点并确认 → 1 请求 */
const fRev = fakeFetch([{ summary: '本轮 ' + SC + '/' + FULL + ' 分，HTTP 默认端口答错了。', weakPoints: ['端口'], advice: ['背端口表'] }]);
const rp = AiScene.mountReview({ container: host, store: ks.store, fetchImpl: fRev, summary: PAPER.summary, questions: PAPER.qs, answers: PAPER.answers });
eq(DOM.byAttr(host, 'data-asc', 'confirm-dialog').length, 0, '刚挂上时**没有**确认窗（不会自己弹出来打扰人）');
DOM.byAttr(host, 'data-asc', 'run-review')[0].click();
await new Promise(function (r) { setTimeout(r, 20); });
eq(DOM.byAttr(host, 'data-asc', 'confirm-dialog').length, 1, '点「生成整卷总评」→ **先弹消耗确认窗**');
ok(DOM.byAttr(host, 'data-asc', 'confirm-dialog')[0].textContent.indexOf('tokens') >= 0, '  确认窗里写着预计消耗');
eq([rp.stats().requests, fRev.calls.length], [0, 0], '  **此时一次请求都没发**');
DOM.byAttr(host, 'data-asc', 'confirm-no')[0].click();
await new Promise(function (r) { setTimeout(r, 10); });
eq([rp.stats().cancels, rp.stats().requests, fRev.calls.length], [1, 0, 0], '点「取消」→ 取消计数 1、**请求仍为 0**');
eq(DOM.byAttr(host, 'data-asc', 'confirm-dialog').length, 0, '  确认窗关掉了');
DOM.byAttr(host, 'data-asc', 'run-review')[0].click();
await new Promise(function (r) { setTimeout(r, 10); });
DOM.byAttr(host, 'data-asc', 'confirm-yes')[0].click();
await new Promise(function (r) { setTimeout(r, 40); });
eq([rp.stats().confirms, rp.stats().requests, fRev.calls.length], [1, 1, 1], '确认后 → 恰好 1 次请求');
eq(DOM.byAttr(host, 'data-asc', 'review-result').length, 1, '  画出总评结果卡');
ok(DOM.byAttr(host, 'data-asc', 'review-result')[0].textContent.indexOf('薄弱考点') >= 0, '  卡里有"薄弱考点"那一栏');
ok(host.textContent.indexOf('引用了本轮记录') >= 0, '  并告诉你它引用了什么（可核对）');
rp.destroy();

/* 举一反三面板：选中 → 一键出新题（**无**确认窗）→ 加入试卷 → 分组计数 +1 */
const fVar = fakeFetch([{ type: '多选', stem: '下面哪些属于传输层协议？', answer: 'AB', options: [{ label: 'A', text: 'TCP' }, { label: 'B', text: 'UDP' }, { label: 'C', text: 'HTTP' }] }]);
const host2 = doc.createElement('div');
doc.documentElement.appendChild(host2);
const selection = { examId: 'EXSC', examTitle: '场景卷', qid: 'r1', question: PAPER.qs[0], index: 0, entry: WRONG_QI };
const addedLog = [];
const mp = AiScene.mountMistake({ container: host2, keyStore: ks2.store, examStore: app.store, fetchImpl: fVar, getSelection: function () { return selection; },
  onAdded: function (r) { addedLog.push(r); } });
eq(DOM.byAttr(host2, 'data-asc', 'run-variant')[0].disabled, false, '选中题目后「生成同考点新题」可用');
DOM.byAttr(host2, 'data-asc', 'run-variant')[0].click();
await new Promise(function (r) { setTimeout(r, 40); });
eq([mp.stats().requests, fVar.calls.length], [1, 1], '点一次 → 1 次请求');
eq(DOM.byAttr(host2, 'data-asc', 'confirm-dialog').length + DOM.byAttr(host2, 'data-asc', 'confirm-mask').length, 0,
   '**举一反三不弹消耗确认窗**（单题操作）');
eq(DOM.byAttr(host2, 'data-asc', 'variant-result').length, 1, '画出新题结果卡');
ok(DOM.byAttr(host2, 'data-asc', 'variant-result')[0].textContent.indexOf('多选') >= 0, '  卡里写着题型');
DOM.byAttr(host2, 'data-asc', 'add-variant')[0].click();
await new Promise(function (r) { setTimeout(r, 40); });
eq(mp.stats().adds, 1, '点「加入《场景卷》」→ 加入成功 1 次');
eq(addedLog.length, 1, '  宿主收到回调（可以据此刷新界面）');
eq([addedLog[0].type, addedLog[0].groupCount, addedLog[0].after.total], ['多选', 1, 5],
   '  回调里带着"落在哪个分组 / 该分组几题 / 整卷几题"');
eq(fVar.calls.length, 1, '  加入试卷**没有再发请求**（那是纯本地写盘）');

/* 失败路径：脏结构 + 未选中 */
const fBad2 = fakeFetch([{ type: '多选', stem: '新题面', answer: 'A', options: [{ label: 'A', text: 'x' }, { label: 'B', text: 'y' }] }]);
const mpBad = AiScene.mountMistake({ container: host2, store: ks2.store, fetchImpl: fBad2, getSelection: function () { return selection; } });
DOM.byAttr(mpBad.el, 'data-asc', 'run-variant')[0].click();
await new Promise(function (r) { setTimeout(r, 40); });
eq(DOM.byAttr(mpBad.el, 'data-asc', 'variant-reject').length, 1, '脏结构 → 画拒绝框');
ok(mpBad.el.textContent.indexOf('原题未改动、试卷未写入') >= 0, '  拒绝框明写"原题未改动、试卷未写入"');
eq(DOM.byAttr(mpBad.el, 'data-asc', 'add-variant').length, 0, '  不画"加入"按钮');
mpBad.destroy();
const mpNone = AiScene.mountMistake({ container: host2, store: ks2.store, fetchImpl: fVar, getSelection: function () { return null; } });
eq(DOM.byAttr(mpNone.el, 'data-asc', 'run-variant')[0].disabled, true, '没选中题目 → 按钮禁用');
eq(mpNone.el.textContent.indexOf('先在错题列表里点一条') >= 0, true, '  并给出该怎么做');
mpNone.destroy();
mp.destroy();

console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
console.log('  PASS ' + pass + '    FAIL ' + fail);
if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
console.log('  \x1b[90m注：真调用（总评 + 误答新题）见 node verify/real-ai.js\x1b[0m');
process.exitCode = fail ? 1 : 0;

})().catch(function (e) { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
