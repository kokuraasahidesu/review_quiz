/* ============================================================
 *  verify/progress.test.js —— 「进度暂存与恢复」小类验收
 *
 *  运行： node verify/progress.test.js
 *
 *  三条盘档验收标准，逐条对应：
 *    ① 刷新页面后作答内容与当前题号均恢复，恢复后继续作答与计分结果正确
 *    ② 交卷后临时进度被清理；再次进入答题是全新一轮，不带着上一轮的作答
 *    ③ 存储不可用时降级为内存态并提示，不影响本轮答题与判分
 *
 *  三条反空转设计：
 *    · ① 用"**同一后端 + 新会话**"模拟刷新（不是新建 store 实例那种假刷新），
 *      并跑**两条平行宇宙**：A 一路答到底、B 中途"刷新"后恢复再答到底 —— 两者整卷结果必须**逐字段相同**；
 *    · ② 清理后不仅 load 为空，还要断言"新会话的作答表里没有旧键"（不残留才算干净）；
 *    · ③ 用**真的会抛错**的 store（setItem 抛 QuotaExceeded）验证降级，而不是传 null 走过场。
 * ============================================================ */
const A = require('../core/attempt.js');
const Q = require('../core/quiz.js');
const S = require('../core/schema.js');
const D = require('../core/data.js');

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

/* ---------- 固定样本卷（四型齐全，分值 2/1/3/5 → 满分 11） ---------- */
const QS = [
  S.createQuestion({ id: 'p1', type: '单选', stem: '单选一', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['A'] }),
  S.createQuestion({ id: 'p2', type: '判断', stem: '判断一', judgeValue: true }),
  S.createQuestion({ id: 'p3', type: '多选', stem: '多选一', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }, { label: 'C', text: 'c' }], answerLetters: ['A', 'B'] }),
  S.createQuestion({ id: 'p4', type: '简答', stem: '简答一', keywords: [{ text: '甲' }, { text: '乙' }] })
];
const ANSW = ['B', '√', 'AB', '甲\n乙'];   // p1 故意答错（B），其余对/满分 → 卷面 9/11，分数有区分度

/* ---------- 真实双后端 store（与 storage.test.js 同一套路） ---------- */
function makeStore(ns) {
  const small = new Map();
  const s = {
    getItem: k => (small.has(String(k)) ? small.get(String(k)) : null),
    setItem: (k, v) => { small.set(String(k), String(v)); },
    removeItem: k => { small.delete(String(k)); },
    key: i => { const a = Array.from(small.keys()); return i < a.length ? a[i] : null; },
    get length() { return small.size; }
  };
  const large = new Map();
  const l = {
    get: async k => (large.has(String(k)) ? large.get(String(k)) : null),
    set: async (k, v) => { large.set(String(k), v); },
    del: async k => { large.delete(String(k)); },
    keys: async () => Array.from(large.keys())
  };
  return { store: D.createStore({ small: s, large: l, namespace: ns || 'app' }), raw: small, largeRaw: large };
}
function newSession(configPatch) {
  return A.createSession({ examId: 'E1', title: '样卷', questions: QS, config: cfg(configPatch), startedAt: '2026-09-19T09:00:00.000Z' });
}
/* 一路答到底（作答 + 每题提交 + 交卷） */
function answerAll(ses, upto) {
  const n = upto == null ? QS.length : upto;
  for (let i = 0; i < n; i++) { A.goto(ses, i); A.answer(ses, ANSW[i]); A.submitCurrent(ses); }
  return ses;
}

async function main() {

/* ============================================================ */
head('①-A 进度键与载荷：按试卷分命名空间、只存用户产生的东西');

eq(A.progressKey('E1'), 'exam::E1::progress', '进度键走既有前缀规则（exam::<id>::progress，**不手拼**）');
ok(A.progressKey('E1') !== A.progressKey('E2'), '  两套卷的进度键不同（天然隔离）');

head('①-A2 轮次标记：同一套卷的"整卷"与"抽一轮"各存各的（否则会互相覆盖）');

eq(A.progressKey('E1', 'all'), 'exam::E1::progress-all', '带轮次标记 → 子键加后缀（老键 exam::E1::progress 不变，向后兼容）');
eq(A.progressKey('E1', null), 'exam::E1::progress', '  null/不传 = 老键（独立单页与整卷默认走它）');
ok(A.progressKey('E1', 'pA-18') !== A.progressKey('E1', 'pB-20'), '  不同轮次（不同抽题批次）→ 不同键');
ok(A.progressKey('E1', 'all').indexOf(D.examSubPrefix('E1')) === 0, '  仍在 exam::<id>:: 前缀下（删卷能按前缀一并清掉）');

{
  /* 真后端上验一遍"互不覆盖"：整卷存一份、抽一轮存另一份，两边都读得回自己那份 */
  const Wt = makeStore();
  const full = newSession(null); A.goto(full, 3);
  const one = newSession(null); A.goto(one, 1);
  await A.createProgressStore(Wt.store, { examId: 'E1', roundTag: 'all' }).save(full, { now: '2026-09-19T10:00:00.000Z' });
  await A.createProgressStore(Wt.store, { examId: 'E1', roundTag: 'p1-3' }).save(one, { now: '2026-09-19T10:01:00.000Z' });
  const lFull = await A.createProgressStore(Wt.store, { examId: 'E1', roundTag: 'all' }).load(QS);
  const lOne = await A.createProgressStore(Wt.store, { examId: 'E1', roundTag: 'p1-3' }).load(QS);
  eq([lFull.ok, lFull.payload.index], [true, 3], '整卷那份还在（没被抽一轮覆盖）');
  eq([lOne.ok, lOne.payload.index], [true, 1], '  抽一轮那份也在（没被整卷覆盖）');
  eq((await A.createProgressStore(Wt.store, { examId: 'E1' }).load(QS)).ok, false,
     '  而**不带轮次标记**的那个键是空的（老调用方不会被顺手写脏）');
  /* 删卷要连这些子键一起清掉（purge 是前缀式的，这条钉住"不留孤儿") */
  const E2 = require('../core/exams.js');
  await E2.createExam(Wt.store, { id: 'E1', title: '样卷', questions: QS });
  const del = await E2.deleteExam(Wt.store, 'E1', { policy: 'cascade', now: '2026-09-19T11:00:00.000Z' });
  eq(del.ok, true, '删掉这套卷');
  eq([(await A.createProgressStore(Wt.store, { examId: 'E1', roundTag: 'all' }).load(QS)).ok,
       (await A.createProgressStore(Wt.store, { examId: 'E1', roundTag: 'p1-3' }).load(QS)).ok],
     [false, false], '  两个轮次的进度键都被一并清掉（前缀式 purge，不留孤儿）');
}
const s0 = newSession(null);
A.goto(s0, 2); A.answer(s0, 'AB');
const pay = A.serializeProgress(s0, { now: '2026-09-19T10:00:00.000Z' });
eq(pay.v, A.PROGRESS_VERSION, '载荷带版本号');
eq([pay.examId, pay.index, pay.answers, pay.questionIds], ['E1', 2, { p3: 'AB' }, ['p1', 'p2', 'p3', 'p4']],
   '载荷含：卷 id、当前题号、作答、题目 id 列表（用来验"卷子没变"）');
ok(!('questions' in pay), '  **不存题目本体**（题从试卷来，进度只是覆盖其上的状态）');
eq(A.checkProgress(pay, QS).ok, true, '体检通过（同一份卷子）');

head('①-B 真·刷新：同一后端 + 新会话 → 作答与题号都回来（两条平行宇宙结果一致）');

const W = makeStore();
/* 宇宙 A：不刷新，一路答到底 */
const A1 = answerAll(newSession(null));
const RA = A.finish(A1).summary;
/* 宇宙 B：答两题 → 存进度 → **换一个新会话（=刷新）** → 恢复 → 接着答完 */
const Be = newSession(null);
A.goto(Be, 0); A.answer(Be, ANSW[0]); A.submitCurrent(Be);
A.goto(Be, 3); A.answer(Be, ANSW[3]); A.submitCurrent(Be);      // 故意跳到第 4 题再答（当前题号=3）
const ps = A.createProgressStore(W.store, { examId: 'E1' });
const saved = await ps.save(Be, { now: '2026-09-19T10:00:00.000Z' });
eq([saved.ok, saved.degraded], [true, false], '写进度成功（落在真后端上）');
eq(ps.mode(), 'storage', '  适配器处于 storage 模式（没降级）');
// store 会在键前面再加一层命名空间前缀（app::）—— 所以后端里的真实键是 app::exam::E1::progress
eq(D.prefixedKey('app', A.progressKey('E1')), 'app::exam::E1::progress', '后端里的真实键 = 命名空间前缀 + 试卷进度键');
ok(W.raw.has('app::exam::E1::progress') || W.largeRaw.has('app::exam::E1::progress'), '  后端里确实出现了这个键');

const Be2 = newSession(null);                                   // ← 这就是"刷新后的新页面"
eq([Object.keys(Be2.answers).length, Be2.index], [0, 0], '新会话是干净的（0 作答、第 1 题）');
const loaded = await ps.load(Be2.questions);
eq([loaded.ok, loaded.degraded], [true, false], 'load 成功');
const restored = A.restoreProgress(Be2, loaded.payload);
eq(restored.ok, true, '恢复成功');
eq(restored.restored, { answers: 2, checked: 2, index: 3, dropped: 0, timerMs: 0 },
   '恢复了 2 份作答、2 个提交标记、当前题号 3，且没有丢弃任何键（timerMs=0：这份载荷没计过时）');
/* 答题计时也要跟着进度回来（用户要求：刷新/继续这一轮不能把表归零） */
eq([Be2.timer.ms, Be2.timer.paused], [0, false], '  这一轮没开过表 → 计时状态是干净的 0/未暂停');
eq(Be2.answers, { p1: 'B', p4: '甲\n乙' }, '  作答内容逐键一致（含简答多行原样）');
eq([Be2.checked.p1, Be2.checked.p4, Be2.checked.p2], [true, true, undefined], '  提交标记也恢复（没提交的仍是空）');
eq(Be2.index, 3, '  当前题号恢复 = 第 4 题');
eq(Be2.results.p1, Q.scoreOne(QS[0], 'B', Be2.config), '  已提交题的判分结果也补回来了（回看/成绩页要用）');

/* 恢复后继续答完 → 与宇宙 A 对比 */
A.goto(Be2, 1); A.answer(Be2, ANSW[1]); A.submitCurrent(Be2);
A.goto(Be2, 2); A.answer(Be2, ANSW[2]); A.submitCurrent(Be2);
const RB = A.finish(Be2).summary;
eq([RB.score, RB.full, RB.percent, RB.correctCount, RB.level],
   [RA.score, RA.full, RA.percent, RA.correctCount, RA.level],
   '**两条平行宇宙整卷结果逐字段相同**（' + RA.score + '/' + RA.full + '、' + RA.percent + '%、正确 ' + RA.correctCount + '）');
eq(RB.per, RA.per, '  逐题明细也完全相同（恢复没有把任何一题搞乱）');
ok(RA.score > 0 && RA.score < RA.full, '  分数不是"全 0 或满分"这种看不出来的值（' + RA.score + '/' + RA.full + '）');

head('①-C 配置也随进度回来（面板改过的设置不该在刷新后丢掉）');

const Wc = makeStore();
const sc = newSession(null);
const patched = A.setConfig(sc, Q.mergeConfig(sc.config, { reveal: { answerTiming: 'each', explainTiming: 'each' }, grade: { pass: 50, excellent: 70 } })).session;
await A.createProgressStore(Wc.store, { examId: 'E1' }).save(sc);
const sc2 = newSession(null);
const lc = await A.createProgressStore(Wc.store, { examId: 'E1' }).load(sc2.questions);
A.restoreProgress(sc2, lc.payload);
eq([sc2.config.reveal.answerTiming, sc2.config.grade.pass], ['each', 50], '刷新后展示时机与分数线都还在');
eq(Q.validateConfig(sc2.config).ok, true, '  恢复出来的配置仍是合法配置（不是被拼坏的半截对象）');

head('①-C2 **恢复时先落配置、再算每题结果**（顺序反了会让卡片与总分分叉）');

// 红队组级审查抓出的真问题：早先 config 在"重算 results"之后才落地，
// 于是 results 用**恢复前的出厂配置**算（2 分），而总分用恢复后的配置算（5 分）。
const Wp = makeStore();
const sp = newSession(null);
A.goto(sp, 0); A.answer(sp, 'A'); A.submitCurrent(sp);
A.setConfig(sp, Q.mergeConfig(sp.config, { points: { '单选': 5 } }));      // 存档时的配置：单选 5 分
await A.createProgressStore(Wp.store, { examId: 'E1' }).save(sp);
const sp2 = newSession(null);                                             // 新会话是"出厂配置"（单选 2 分）
const lp = await A.createProgressStore(Wp.store, { examId: 'E1' }).load(sp2.questions);
A.restoreProgress(sp2, lp.payload);
A.finish(sp2, { confirmUnanswered: true });
eq([sp2.config.points['单选'], sp2.results.p1.score, A.reviewList(sp2)[0].score, sp2.summary.per[0].score],
   [5, 5, 5, 5], '同一题：会话配置 / 卡片 results / 回看列表 / 整卷 per 明细**四处同分**（都按恢复后的 5 分）');
eq([A.view(sp2).score.score, sp2.results.p1.full], [5, 5], '  视图顶部的得分与满分也跟着是 5（不是 2）');

head('①-C3 脏载荷（有 manual 没 checked）也不许让卡片与总分分叉');

// 自家写入端产不出这种载荷（applyManual 必置 checked、serialize 两者同写），
// 但手改/第三方写的进度可能长这样 —— 回看卡片的回退计算必须也带人工口径。
const sDirty = newSession(null);
A.goto(sDirty, 3); A.answer(sDirty, '甲 乙');
const dirtyPayload = {
  v: A.PROGRESS_VERSION, examId: 'E1', title: '样卷', index: 3,
  answers: { p4: '甲 乙' }, checked: {},                       // ← 故意不给 checked
  manual: { p4: { hits: [], score: 5, note: '手改载荷', at: '' } },
  questionIds: QS.map(function (q) { return q.id; }), startedAt: '', savedAt: ''
};
const rDirty = A.restoreProgress(sDirty, dirtyPayload);
eq(rDirty.ok, true, '脏载荷仍能恢复（体检只管版本/结构/卷子一致，不管 checked 与 manual 的搭配）');
A.finish(sDirty, { confirmUnanswered: true });
eq([A.reviewList(sDirty)[3].score, sDirty.summary.per[3].score, sDirty.results.p4.score], [5, 5, 5],
   '卡片 / 整卷明细 / results **三处同分**（都按人工口径 5 分，不是卡片 3.5、总分 5）');
eq(A.reviewList(sDirty)[3].manual.score, 5, '  痕迹也带上了');

head('①-D 卷子变了 → 拒绝恢复（宁可全新一轮，也不把旧作答套错）');

const Wd = makeStore();
await A.createProgressStore(Wd.store, { examId: 'E1' }).save(answerAll(newSession(null), 1));
const QS2 = QS.slice(0, 3).concat([S.createQuestion({ id: 'p5', type: '判断', stem: '新增题', judgeValue: false })]);
const sd = A.createSession({ examId: 'E1', title: '样卷', questions: QS2, config: cfg({}) });
const ld = await A.createProgressStore(Wd.store, { examId: 'E1' }).load(sd.questions);
const rd = A.restoreProgress(sd, ld.payload);
eq([rd.ok, rd.reason], [false, 'paper-changed'], '题目 id 列表对不上 → 拒绝恢复并说明原因');
eq(Object.keys(sd.answers).length, 0, '  会话保持干净（没有把旧作答部分套上）');

head('①-E 载荷损坏 / 版本不符 → 拒绝且不崩');

eq(A.checkProgress(null, QS).reason, 'empty', '空载荷 → empty');
eq(A.checkProgress({ v: 99, answers: {} }, QS).reason, 'version', '版本不符 → version（并提示忽略旧进度）');
eq(A.checkProgress({ v: A.PROGRESS_VERSION }, QS).reason, 'shape', '缺作答 → shape');
const bad = { v: A.PROGRESS_VERSION, answers: { p1: 'A', '不存在的题': 'X' }, checked: { '不存在的题': true }, questionIds: ['p1', 'p2', 'p3', 'p4'], index: 99 };
const sbad = newSession(null);
const rbad = A.restoreProgress(sbad, bad);
eq([rbad.ok, rbad.restored.dropped, rbad.restored.answers], [true, 1, 1], '多出来的陌生题键被**丢掉并计数**');
eq(Object.keys(sbad.answers), ['p1'], '  会话里只留下这张卷子自己的题');
eq(sbad.index, QS.length - 1, '  越界的题号被夹到最后一题（不越界、不崩）');

/* ============================================================ */
head('②-A 交卷后清理：进度没了、新会话不带上一轮');

const We = makeStore();
const psE = A.createProgressStore(We.store, { examId: 'E1' });
const se = answerAll(newSession(null));
await psE.save(se);
const beforeClear = await psE.load(se.questions);
eq(beforeClear.ok, true, '交卷前进度在（先确认它真的写进去了）');
A.finish(se);
const cleared = await psE.clear();
eq(cleared.ok, true, '交卷后清理成功');
const afterClear = await psE.load(se.questions);
eq([afterClear.ok, afterClear.reason], [false, 'empty'], '清理后 load 为空（没有残留脏数据）');
eq([We.raw.has('exam::E1::progress'), We.largeRaw.has('exam::E1::progress')], [false, false], '  后端里那个键也真的没了');
const fresh = newSession(null);
eq([Object.keys(fresh.answers).length, fresh.index, A.progress(fresh).answered], [0, 0, 0],
   '再次进入答题 = 全新一轮（0 作答、第 1 题、进度 0）');
const freshLoaded = await psE.load(fresh.questions);
eq([freshLoaded.ok, A.restoreProgress(fresh, freshLoaded.payload).ok], [false, false],
   '  想恢复也没有东西可恢复（不会带着上一轮的作答）');

head('②-B 清理只清这一套卷（不误伤别的卷）');

const Wm = makeStore();
const psA = A.createProgressStore(Wm.store, { examId: 'E1' });
const psB = A.createProgressStore(Wm.store, { examId: 'E2' });
await psA.save(newSession(null));
const sb = A.createSession({ examId: 'E2', title: '另一套', questions: QS, config: cfg({}) });
await psB.save(answerAll(sb, 2));
await psA.clear();
eq([(await psA.load(QS)).ok, (await psB.load(QS)).ok], [false, true],
   '清掉 E1 的进度，E2 的进度**原封不动**');
const sb2 = A.createSession({ examId: 'E2', title: '另一套', questions: QS, config: cfg({}) });
A.restoreProgress(sb2, (await psB.load(QS)).payload);
eq(A.progress(sb2).answered, 2, '  E2 恢复后仍有 2 题作答');

/* ============================================================ */
head('③-A 存储不可用：降级内存态 + 提示，但答题与判分照常');

const noStore = A.createProgressStore(null, { examId: 'E1' });
eq([noStore.mode(), noStore.isDegraded()], ['memory', true], '没有 store → 直接内存态');
ok(/无法保存作答进度/.test(noStore.notice()), '  给出可读提示', noStore.notice());
const sn = answerAll(newSession(null), 2);
const sr = await noStore.save(sn);
eq([sr.ok, sr.degraded, sr.where], [false, true, 'memory'], 'save 如实报告"没存到真存储、只在内存里"');
const sr2 = await noStore.load(sn.questions);
eq([sr2.ok, sr2.degraded], [true, true], '  内存里仍能读回来（降级但可用）');
const sn2 = newSession(null);
A.restoreProgress(sn2, sr2.payload);
eq(A.progress(sn2).answered, 2, '  恢复照常可用（2 题作答）');
// 关键：降级不影响本轮答题与判分
A.goto(sn, 2); A.answer(sn, ANSW[2]); A.submitCurrent(sn);
A.goto(sn, 3); A.answer(sn, ANSW[3]); A.submitCurrent(sn);
const R1 = A.finish(sn, { confirmUnanswered: true }).summary;
const R2 = A.finish(answerAll(newSession(null)), { confirmUnanswered: true }).summary;
eq([R1.score, R1.full, R1.percent, R1.level], [R2.score, R2.full, R2.percent, R2.level],
   '**降级态下交卷结果与正常态完全一致**（' + R1.score + '/' + R1.full + '）');

head('③-B 会抛错的存储（配额满）→ 也要降级而不是把答题打断');

const Wq = makeStore();
const throwStore = {
  get: async (k) => Wq.store.get(k),
  set: async () => { const e = new Error('quota exceeded'); e.name = 'QuotaExceededError'; throw e; },
  del: async () => { throw new Error('del failed'); }
};
const psq = A.createProgressStore(throwStore, { examId: 'E1' });
const sq = answerAll(newSession(null), 1);
const qr = await psq.save(sq);
eq([qr.ok, qr.degraded], [false, true], '写入抛错 → 不崩，降级为内存态');
eq(psq.lastError().name, 'QuotaExceededError', '  并如实记下错误名（便于提示用户）');
ok(/QuotaExceededError|quota/i.test(psq.notice()), '  提示里带上原因', psq.notice());
const qr2 = await psq.load(sq.questions);
eq(qr2.ok, true, '  降级后仍能从内存读回这份进度');
eq(A.finish(sq, { confirmUnanswered: true }).ok, true, '  本轮答题照常可以交卷（存储坏了不影响判分）');

head('③-C 相邻锚：进度落在既有命名空间规则里（不新造一套键）');

eq(A.progressKey('X').indexOf(D.examSubPrefix('X')), 0, '进度键以试卷分前缀开头（exam::X::，来自 DataCore 而非手拼）');
eq(D.nsOf(D.prefixedKey('app', A.progressKey('X'))), 'app', '  落库时归入 app 命名空间（与卷本体同域）');
eq(A.progressKey('X') !== D.examBodyKey('X'), true, '  与卷本体键不同（不会把卷子覆盖掉）');
eq(A.progressKey('A2').indexOf(D.examSubPrefix('A')), -1, '  卷 A 的前缀**不会**匹配到卷 A2 的进度键（不串号：exam::A:: 不是 exam::A2:: 的前缀）');

console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
console.log('  PASS ' + pass + '    FAIL ' + fail);
if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
console.log('  \x1b[90m注：真刷新（F5）只有真浏览器能验 → 见 浏览器自检.html 的 L 节\x1b[0m');
process.exitCode = fail ? 1 : 0;
}

main().catch(e => { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
