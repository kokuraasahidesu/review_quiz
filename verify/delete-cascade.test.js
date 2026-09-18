/* ============================================================
 *  verify/delete-cascade.test.js —— 「删卷级联询问」小类验收
 *
 *  运行： node verify/delete-cascade.test.js
 *
 *  三条盘档验收标准，逐条对应：
 *    ① 选『是』(cascade)：该卷误答与记录一并删除，且**不可恢复**；
 *    ② 选『否』(keepRecords)：试卷被删、记录保留，但呈现**可理解的状态**
 *       （有明确的「已删除试卷」归属标识）；
 *    ③ 两种路径下存储里都不存在**指向已删试卷 ID 的孤儿可查询数据**（键扫描断言）。
 *
 *  ③ 是怎么判的（判据写死在本文件里，不靠口头解释）：
 *    · 级联路径：`exam::A*` / `wrong::A` / `record::A` 三类键**必须全部归零**；
 *    · 保留路径：残留的记录键**必须**都在墓碑（`index.deleted`）的覆盖下，
 *      即 `scanOrphans().orphans === []` 且 `identified` 恰好列出它们、并带可读归属标签。
 *      ——"有主"与"孤儿"是两回事，混在一起报就会得出"保留路径留了孤儿"的错误结论。
 *
 *  反空转：`verify/probe-delete-cascade-old.js`（5 条，逐条把行为回退，锚必须变红）。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const E = require('../core/exams.js');
const D = require('../core/data.js');
const W = require('../core/wrong.js');
const A = require('../core/attempt.js');
const Q = require('../core/quiz.js');
const S = require('../core/schema.js');
const DOM = require('./mini-dom.js');
const DeleteDialog = require('../ui/delete-dialog.js');
const WrongView = require('../ui/wrong-view.js');

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

/* ---------------- 共用后端 + "重开页面"（与 exams.test 同一套路） ---------------- */
function world() {
  const sm = new Map(), lg = new Map();
  const small = {
    getItem: k => (sm.has(k) ? sm.get(k) : null),
    setItem: (k, v) => { sm.set(String(k), String(v)); },
    removeItem: k => { sm.delete(k); },
    key: i => { const a = Array.from(sm.keys()); return i < a.length ? a[i] : null; },
    get length() { return sm.size; }
  };
  const large = {
    get: async k => (lg.has(k) ? JSON.parse(lg.get(k)) : null),
    set: async (k, v) => { lg.set(String(k), JSON.stringify(v)); },
    del: async k => { lg.delete(k); },
    keys: async () => Array.from(lg.keys())
  };
  return {
    store: (t) => D.createStore({ small: small, large: large, namespace: D.NS_GLOBAL, threshold: (t != null) ? t : 1024 * 1024 }),
    reopen: (t) => D.createStore({ small: small, large: large, namespace: D.NS_GLOBAL, threshold: (t != null) ? t : 1024 * 1024 }),
    rawKeys: () => Array.from(sm.keys()).concat(Array.from(lg.keys()))
  };
}
/* 键扫描：与已删试卷 id 有关的三类键，逐个列出来（判据的唯一来源） */
function keysOf(raw, examId) {
  const full = (k) => D.prefixedKey(D.NS_GLOBAL, k);
  const hit = { body: [], sub: [], record: [], wrong: [] };
  raw.forEach(function (k) {
    if (k === full(D.examBodyKey(examId))) hit.body.push(k);
    else if (k.indexOf(full(D.examSubPrefix(examId))) === 0) hit.sub.push(k);
    else if (k === full(D.recordKey(examId))) hit.record.push(k);
    else if (k === full(D.wrongKey(examId))) hit.wrong.push(k);
  });
  return hit;
}
const cfg = p => Q.mergeConfig(Q.DEFAULT_CONFIG, p || {});
function makeExam(id, title) {
  return S.createExam({
    id: id, title: title, schemaVersion: S.SCHEMA_VERSION,
    questions: [
      S.createQuestion({ id: id + '-q1', type: '单选', stem: title + '·题一', options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }], answerLetters: ['A'], explanation: '解析一' }),
      S.createQuestion({ id: id + '-q2', type: '判断', stem: title + '·题二', judgeValue: true, explanation: '解析二' })
    ]
  }, { now: '2026-10-20T00:00:00.000Z' });
}
/* 把卷子写进存储 + 造出"错题本 + 作答记录" */
async function seed(store, id, title) {
  const exam = makeExam(id, title);
  await store.set(D.examBodyKey(id), exam);
  await store.set(D.examSubKey(id, 'meta'), E.metaOf(exam));
  const idx = (await store.get('index')) || { examIds: [], updatedAt: null };
  if (idx.examIds.indexOf(id) < 0) idx.examIds.push(id);
  await store.set('index', idx);
  /* 真跑一轮，让误答本是**真收集**出来的（不是手捏的形状） */
  const s = A.createSession({ examId: id, title: title, questions: exam.questions, config: cfg({}) });
  exam.questions.forEach(function (q, i) { A.goto(s, i); A.answer(s, q.type === '判断' ? '×' : 'B'); A.submitCurrent(s); });
  const fin = A.finish(s, { confirmUnanswered: true, now: '2026-10-20T01:00:00.000Z' });
  const byId = {}; exam.questions.forEach(function (q) { byId[q.id] = q; });
  const book = W.createBook(id, '2026-10-20T01:00:00.000Z');
  W.collect(book, fin.summary.per, { now: '2026-10-20T01:00:00.000Z', sessionAt: 'S-' + id, questionsById: byId, answers: s.answers });
  await store.set(D.wrongKey(id), W.toJSON(book));
  await store.set(D.recordKey(id), [{ at: '2026-10-20T01:10:00.000Z', examId: id, score: 0, full: 4, percent: 0, level: '不及格' }]);
  return { exam: exam, book: book };
}

(async function main() {

/* ============================================================ */
head('①-A 询问模型（纯函数）：两个选项、后果写清、不预选');

const plan = E.deletePlan({ examId: 'E1', title: '甲卷', wrongCount: 3, recordCount: 2 });
eq(plan.options.map(o => o.policy), ['cascade', 'keepRecords'], '两个选项的政策名固定（级联 / 保留）');
eq(plan.options.map(o => o.answer), ['yes', 'no'], '  与验收里的『是』『否』一一对应');
ok(/3 条错题/.test(plan.message) && /2 条作答记录/.test(plan.message), '  询问文案把"会删掉多少条"说清楚', plan.message);
ok(/不可恢复/.test(plan.options[0].label) && /无法恢复/.test(plan.note), '  破坏性选项**明说不可恢复**', plan.options[0].label);
ok(/已删除试卷/.test(plan.options[1].detail), '  保留选项说明记录的归属会变成「已删除试卷」', plan.options[1].detail);
ok(/3 条错题/.test(plan.options[0].detail), '  每个选项都带自己的后果明细', plan.options[0].detail);
eq([plan.hasRecords, plan.wrongCount, plan.recordCount], [true, 3, 2], '  计数如实带出');
const plan0 = E.deletePlan({ examId: 'E2', title: '空卷', wrongCount: 0, recordCount: 0 });
eq(plan0.hasRecords, false, '没有任何关联记录时 hasRecords=false');
ok(/两个选项的结果一样/.test(plan0.note), '  并如实说明"两个选项结果一样"（不制造紧张感）', plan0.note);
const planX = E.deletePlan({});
eq([planX.examId, planX.title, planX.wrongCount], ['', '试卷 ', 0], '缺字段也不崩（空 id/标题退化成可读占位）');

head('①-B 没给政策 → 绝不删东西，只把询问模型交回去');

const W1 = world(); const s1 = W1.store();
const a1 = await seed(s1, 'EX_A', '甲卷');
const a2 = await seed(s1, 'EX_B', '乙卷');
const keysBefore = W1.rawKeys().slice().sort();
const ask = await E.deleteExam(s1, 'EX_A');                    // ← 不传政策
eq([ask.ok, ask.needPolicy], [false, true], '不传政策 → ok:false + needPolicy:true（拒绝执行）');
eq(ask.prompt.options.map(o => o.policy), ['cascade', 'keepRecords'], '  拒绝的同时把两个选项一起交回去');
eq(ask.prompt.wrongCount, Object.keys(a1.book.entries).length, '  询问里的错题条数是**真读出来的**', String(ask.prompt.wrongCount));
eq(ask.prompt.recordCount, 1, '  作答记录条数也真读出来了');
eq(W1.rawKeys().slice().sort(), keysBefore, '**存储一个字节都没变**（拒绝执行 ≠ 悄悄按默认删）');
eq((await E.getExam(s1, 'EX_A')).ok, true, '  甲卷还在');

head('②-A 选『是』（cascade）：卷 + 误答本 + 作答记录一起删，且不可恢复');

const del = await E.deleteExam(s1, 'EX_A', { policy: 'cascade', now: '2026-10-21T00:00:00.000Z' });
eq([del.ok, del.policy, del.orphansKept], [true, 'cascade', []], '级联删除成功，且没有"特意保留"的东西');
eq((await E.getExam(s1, 'EX_A')).ok, false, '甲卷本体没了（getExam 明确失败）');
const rawC = W1.rawKeys();
eq(keysOf(rawC, 'EX_A'), { body: [], sub: [], record: [], wrong: [] }, '**三类键全部归零**（本体/meta/记录/错题）');
const scanC = await E.scanOrphans(s1);
eq(scanC.orphans, [], '  键扫描：零孤儿');
eq(scanC.identified, [], '  也没有"已删卷残留"（级联路径不留墓碑）');
eq((await E.ownerOf(s1, 'EX_A')).kind, 'unknown', '  归属查询：查无此卷（不留"已删除试卷"标识）');
eq((await E.deletedExams(s1)).deleted, [], '  已删除卷册里也没有它');

/* 不可恢复：换新 store 实例（= 关掉页面再打开）后仍然查无，且没有任何一处留着它的数据 */
const s1b = W1.reopen();
eq((await E.getExam(s1b, 'EX_A')).ok, false, '**重开后仍然查不到**（不是内存里删了、盘上还在）');
eq(keysOf(W1.rawKeys(), 'EX_A'), { body: [], sub: [], record: [], wrong: [] }, '  盘上依旧零残留');
eq((await E.listExams(s1b)).exams.map(x => x.id), ['EX_B'], '  卷册里只剩乙卷');
eq((await W.loadBook(s1b, 'EX_A')).empty, true, '  甲卷的误答本也读不到了（不可恢复）');

head('②-B 级联的相邻锚：乙卷与全局设置**一个都没动**');

const rawAfterC = W1.rawKeys();
ok(keysOf(rawAfterC, 'EX_B').body.length === 1, '乙卷本体还在');
ok(keysOf(rawAfterC, 'EX_B').wrong.length === 1, '  乙卷误答本还在');
ok(keysOf(rawAfterC, 'EX_B').record.length === 1, '  乙卷作答记录还在');
eq((await E.getExam(s1b, 'EX_B')).exam.title, '乙卷', '  乙卷内容原样');
eq((await E.listExams(s1b)).healed, false, '  卷册索引自洽（没有悬空 id 触发自愈）');

head('②-C 旧写法兼容 + 空 id / 不存在的卷：都不许误伤');

const W2 = world(); const s2 = W2.store();
await seed(s2, 'EX_C', '丙卷');
const legacyYes = await E.deleteExam(s2, 'EX_C', { keepRecords: false });
eq([legacyYes.ok, legacyYes.policy], [true, 'cascade'], '旧写法 keepRecords:false 等价于 cascade');
const W2b = world(); const s2b = W2b.store();
await seed(s2b, 'EX_D', '丁卷');
const legacyNo = await E.deleteExam(s2b, 'EX_D', { keepRecords: true });
eq([legacyNo.ok, legacyNo.policy], [true, 'keepRecords'], '旧写法 keepRecords:true 等价于 keepRecords');
eq((await E.ownerOf(s2b, 'EX_D')).kind, 'deleted', '  并照样写了墓碑');

const W3 = world(); const s3 = W3.store();
await seed(s3, 'EX_E', '戊卷');
const beforeEmpty = W3.rawKeys().slice().sort();
const emptyDel = await E.deleteExam(s3, '', { policy: 'cascade' });
eq(emptyDel.ok, true, '空 id 的删除调用本身不报错（幂等语义）');
eq(emptyDel.deleted, [], '  但什么都没删');
eq(W3.rawKeys().slice().sort(), beforeEmpty, '**空 id 绝不会变成"清光所有卷"**');
const missingDel = await E.deleteExam(s3, '不存在的卷', { policy: 'cascade' });
eq([missingDel.ok, missingDel.deleted], [true, []], '删不存在的卷：成功但没删到东西（不炸）');
eq((await E.ownerOf(s3, 'EX_E')).kind, 'alive', '  戊卷毫发无损');

head('③-A 选『否』（keepRecords）：卷删了、记录留下，且带「已删除试卷」归属标识');

const W4 = world(); const s4 = W4.store();
const d4 = await seed(s4, 'EX_F', '己卷');
const wrongCount4 = Object.keys(d4.book.entries).length;
const keepDel = await E.deleteExam(s4, 'EX_F', { policy: 'keepRecords', now: '2026-10-22T09:30:00.000Z' });
eq([keepDel.ok, keepDel.policy], [true, 'keepRecords'], '保留策略执行成功');
eq(keepDel.orphansKept.slice().sort(), [D.recordKey('EX_F'), D.wrongKey('EX_F')].sort(), '  如实列出保留了哪两把键');
const rawK = W4.rawKeys();
eq([keysOf(rawK, 'EX_F').body, keysOf(rawK, 'EX_F').sub], [[], []], '试卷本体与 meta/子键都删掉了（只留记录）');
eq([keysOf(rawK, 'EX_F').wrong.length, keysOf(rawK, 'EX_F').record.length], [1, 1], '误答本与作答记录**两把键都留着**');
eq((await E.getExam(s4, 'EX_F')).ok, false, '  查看试卷：明确失败');

const own = await E.ownerOf(s4, 'EX_F');
eq([own.ok, own.kind, own.title], [true, 'deleted', '己卷'], '归属查询：kind=deleted 且带原标题');
eq(own.label, '已删除试卷（原《己卷》）', '**归属标识**可读且带原标题：' + own.label);
eq(own.deletedAt, '2026-10-22T09:30:00.000Z', '  删除时刻也记着（不是"不知道啥时候没的"）');
eq([own.wrongCount, own.recordCount], [wrongCount4, 1], '  墓碑里如实记着留下了多少条', JSON.stringify(own));

const de4 = await E.deletedExams(s4);
eq(de4.deleted.map(x => [x.examId, x.label]), [['EX_F', '已删除试卷（原《己卷》）']], '已删除卷册能查出来（界面据此显示）');
eq((await E.listExams(s4)).exams, [], '  但活着的卷册里已经没有它了');

const scan4 = await E.scanOrphans(s4);
eq(scan4.orphans, [], '**键扫描：零孤儿**（残留记录都在墓碑覆盖下）');
eq(scan4.identified.map(o => [o.kind, o.examId, o.label]).sort(),
   [['record', 'EX_F', '已删除试卷（原《己卷》）'], ['wrong', 'EX_F', '已删除试卷（原《己卷》）']].sort(),
   '  两条残留记录被列为"有主"（带归属标签），而不是孤儿');
eq(scan4.deleted, ['EX_F'], '  巡检也知道这一卷已被删除');

head('③-B 保留路径的误答本照样能读、能查详情，只是归属变成「已删除试卷」');

const back4 = await W.loadBook(s4, 'EX_F');
eq(back4.ok, true, '误答本仍能从存储读回');
eq(W.stats(back4.book).total, wrongCount4, '  条数与删除前一致（'+wrongCount4+' 条）');
/* ⚠ 这条是**真缺陷的锚**：已删除卷的误答本不在 `listExams` 里，
 *   界面若只按 listExams 的 id 去读，用户选了"保留记录"回到错题本会**什么都看不到**。 */
eq((await W.loadAll(s4, (await E.listExams(s4)).exams.map(x => x.id))).length, 0,
   '反向对照：只按"活着的卷"去读 → 一条都读不到（这就是界面会踩的坑）');
const aliveIds = (await E.listExams(s4)).exams.map(x => x.id);
const deadIds = (await E.deletedExams(s4)).deleted.map(x => x.examId);
eq([aliveIds, deadIds], [[], ['EX_F']], '  活着的卷：0 套；已删除的卷：1 套');
eq((await W.loadAllWithDeleted(s4, aliveIds, deadIds)).map(b => b.examId), ['EX_F'],
   '**合并两者去读** → 保留的记录读回来了（记录还在盘上，界面就不会装作没有）');
const g4 = W.groups([{ book: back4.book, exam: null, owner: own }])[0];
eq([g4.examId, g4.total, g4.examFound], ['EX_F', wrongCount4, false], '分组照常给出');
eq([g4.deleted, g4.ownerKind, g4.title], [true, 'deleted', '已删除试卷（原《己卷》）'],
   '**分组标题 = 归属标识**（不再是"试卷 EX_F"这种干巴巴的占位）');
const dq = Object.keys(back4.book.entries)[0];
const det4 = W.detailOf(back4.book, dq, { exam: null, owner: own });
eq([det4.ownerKind, det4.ownerLabel], ['deleted', '已删除试卷（原《己卷》）'], '详情也带归属标识');
ok(/这套卷已经被删除了/.test(det4.staleReason), '  并说明为什么看不到原题', det4.staleReason);
eq([det4.inExam, det4.jump], [false, null], '  跳转目标为空（卷没了就跳不过去，不装样子）');
eq(det4.snapshot.stem, back4.book.entries[dq].stem, '  快照仍留档（详情里作为存档显示）');

head('③-C 界面（真挂载）：已删除的卷标出来、不再给删除按钮、跳转禁用');

const doc = DOM.makeDoc();
const box = doc.createElement('div');
doc.documentElement.appendChild(box);
const jumped = [], asked = [];
const v4 = WrongView.mount({
  container: box, books: [{ book: back4.book, exam: null, owner: own }],
  onJump: function () { jumped.push(1); },
  onDelete: function (examId) { asked.push(examId); }
});
const gh4 = DOM.byClass(box, 'wv-ghead')[0].textContent;
ok(gh4.indexOf('已删除试卷（原《己卷》）') >= 0, '分组头写着「已删除试卷（原《己卷》）」', gh4);
ok(DOM.byAttr(box, 'data-wv', 'dead-tag').length === 1, '  带一个"已删除试卷"标记');
eq(DOM.byAttr(box, 'data-wv', 'delete').length, 0, '  **不再给"删除这套卷"按钮**（已经删过了）');
DOM.byAttr(box, 'data-wv', 'item')[0].click();
const jumpBtn = DOM.byAttr(box, 'data-wv', 'jump')[0];
ok(!!jumpBtn && jumpBtn.disabled === true, '「跳到这道题」禁用（卷没了）');
jumpBtn.click();
eq(jumped.length, 0, '  点了也不回调');
ok(DOM.byClass(box, 'wv-tile')[0].textContent.indexOf('归属：已删除试卷（原《己卷》）') >= 0,
   '  详情里写着归属', DOM.byClass(box, 'wv-tile')[0].textContent.slice(0, 40));

/* 活着的卷则相反：有删除按钮，点了会回调（→ 上层弹询问窗） */
const dOther = await seed(s4, 'EX_G', '庚卷');
const backG = await W.loadBook(s4, 'EX_G');
v4.refresh([{ book: back4.book, exam: null, owner: own }, { book: backG.book, exam: dOther.exam }]);
const delBtns = DOM.byAttr(box, 'data-wv', 'delete');
eq(delBtns.length, 1, '活着的卷有 1 个「删除这套卷」按钮（已删除的那卷不给）');
eq(delBtns[0].getAttribute('data-wv-exam'), 'EX_G', '  按钮带着卷 id');
delBtns[0].click();
eq(asked, ['EX_G'], '点它 → 回调把卷 id 交给上层（由上层去弹询问窗）');
eq(v4.stats().deletes, 1, '  视图自己记到 1 次删除请求');

head('③-D 异步后端（大字段走 IndexedDB 那条路）也要删干净');

/* 前几节都把阈值设得很大 → 记录全落在 small 后端。这里把阈值压到 64 字节，
 * 让错题本与作答记录**落进 large 后端**再删 —— 否则"三类键归零"只在小后端上成立了。 */
const W4b = world(); const s4b = W4b.store(64);
await seed(s4b, 'EX_F2', '己二卷');
const placeW = await s4b.set(D.wrongKey('EX_F2'), (await s4b.get(D.wrongKey('EX_F2'))) || { v: 1, entries: { a: { qid: 'a', times: 1 } } });
const placeR = await s4b.set(D.recordKey('EX_F2'), (await s4b.get(D.recordKey('EX_F2'))) || [{ at: 't' }]);
eq([placeW.where, placeR.where], ['large', 'large'], '前置：误答本与作答记录确实落在**异步后端**（大字段路由生效）');
const keep4b = await E.deleteExam(s4b, 'EX_F2', { policy: 'keepRecords', now: '2026-10-22T11:00:00.000Z' });
eq(keep4b.ok, true, '保留策略在异步后端上照样执行');
eq(keysOf(W4b.rawKeys(), 'EX_F2').body, [], '  卷本体（small）删掉了');
eq([keysOf(W4b.rawKeys(), 'EX_F2').wrong.length, keysOf(W4b.rawKeys(), 'EX_F2').record.length], [1, 1],
   '  异步后端里的记录**留着**（键扫描能看见两个后端的键）');
const scan4b = await E.scanOrphans(s4b);
eq(scan4b.orphans, [], '  巡检仍然零孤儿（keys() 把两个后端合起来看）');
eq(scan4b.identified.length, 2, '  两条残留照样"有主"');
const casc4b = await E.deleteExam(s4b, 'EX_F2', { policy: 'cascade' });
eq(casc4b.ok, true, '再选『是』→ 级联删除');
eq(keysOf(W4b.rawKeys(), 'EX_F2'), { body: [], sub: [], record: [], wrong: [] },
   '**异步后端里的记录也被清干净**（不是只删了 small 那一半）');
eq((await E.scanOrphans(s4b)).identified, [], '  墓碑也抹掉了');

head('③-E 墓碑写不进去时：宁可**不删**，也不留下无主的记录');

const W4c = world(); const s4c = W4c.store();
await seed(s4c, 'EX_J', '癸卷');
const keysJ = W4c.rawKeys().slice().sort();
const realSet = s4c.set.bind(s4c);
s4c.set = function (key, value) {                      // 模拟"索引写不动"（配额满时真会发生）
  if (key === 'index') { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; return Promise.reject(e); }
  return realSet(key, value);
};
const refused = await E.deleteExam(s4c, 'EX_J', { policy: 'keepRecords' });
eq([refused.ok, refused.needTombstone], [false, true], '归属标识写不进去 → 明确失败（不假装删成功）');
ok(/没有执行/.test(refused.error || ''), '  错误信息说清"这次删除没有执行"', refused.error);
eq(keysOf(W4c.rawKeys(), 'EX_J').body.length, 1, '**卷本体还在**（宁可没删，也不留下无主记录）');
eq(W4c.rawKeys().slice().sort(), keysJ, '  存储逐键未变');
s4c.set = realSet;                                     // 恢复后再删一次：这回走通
const retry = await E.deleteExam(s4c, 'EX_J', { policy: 'keepRecords', now: '2026-10-22T12:00:00.000Z' });
eq([retry.ok, (await E.ownerOf(s4c, 'EX_J')).kind], [true, 'deleted'], '  存储恢复后重试：删除成功且归属标识到位');
eq((await E.scanOrphans(s4c)).orphans, [], '  零孤儿');

head('④ 询问弹窗（真挂载）：两个选项、取消不删、双击不重复');

const doc2 = DOM.makeDoc();
const host2 = doc2.createElement('div');
doc2.documentElement.appendChild(host2);
const pv = await E.deletePreview(s4, 'EX_G');
eq(pv.ok, true, 'deletePreview 给得出询问模型');
eq(pv.plan.wrongCount, Object.keys(backG.book.entries).length, '  错题条数来自真实存储', String(pv.plan.wrongCount));
eq(pv.plan.recordCount, 1, '  记录条数也来自真实存储');

let chosenPolicy = null, cancels = 0;
const dlg = DeleteDialog.mount({
  container: host2, prompt: pv.plan,
  onChoose: function (p) { chosenPolicy = p; },
  onCancel: function () { cancels++; }
});
/* ⚠ 查询一律以**这个弹窗自己的节点**为根：多个弹窗先后挂进同一个容器时，
 *   在容器上查 'data-dd=opt' 会同时命中别的弹窗（第一版就踩了这个坑）。 */
const ddOpts = DOM.byAttr(dlg.el, 'data-dd', 'opt');
eq(ddOpts.map(n => n.getAttribute('data-dd-policy')), ['cascade', 'keepRecords'], '弹窗里两个选项按钮（政策名固定）');
eq(DOM.byAttr(dlg.el, 'data-dd', 'cancel').length, 1, '  还有一个明确写着"什么都不删"的取消按钮');
ok(DOM.byAttr(dlg.el, 'data-dd', 'box')[0].textContent.indexOf('无法恢复') >= 0, '  破坏性后果写在弹窗里', '不可恢复');
eq(chosenPolicy, null, '**打开时没有任何预选**（不点就不发生任何事）');
ddOpts[0].click();
eq(chosenPolicy, 'cascade', '点第 1 个选项 → 回调带回 cascade');
ddOpts[1].click();
eq(chosenPolicy, 'cascade', '  再点第 2 个：这一次不再触发（弹窗只认第一次选择）');
eq(dlg.stats().chosen, 'cascade', '  弹窗自己记着已选 cascade');
dlg.destroy();
eq(DOM.byAttr(host2, 'data-dd', 'box').length, 0, 'destroy 后弹窗从容器里摘掉');

const dlg2 = DeleteDialog.mount({ container: host2, prompt: pv.plan, onChoose: function () { chosenPolicy = '不该发生'; }, onCancel: function () { cancels++; } });
DOM.byAttr(dlg2.el, 'data-dd', 'cancel')[0].click();
eq([cancels, chosenPolicy], [1, 'cascade'], '取消 → 只走 onCancel，**onChoose 一次都没调**');
dlg2.destroy();
const dlg3 = DeleteDialog.mount({ container: host2, prompt: pv.plan, onCancel: function () { cancels++; } });
dlg3.el.click();                                  // 遮罩本身就是 el（byAttr 只遍历子节点，所以直接点它）
eq(cancels, 2, '点遮罩空白处也按"取消"处理（绝不等于同意）');
eq(dlg3.stats().chosen, 'cancel', '  弹窗自己记着是取消');
dlg3.destroy();
let threw = false;
try { DeleteDialog.mount({ container: host2, prompt: { message: '没有选项' } }); } catch (e) { threw = /options/.test(e.message); }
ok(threw, '询问模型缺 options → **当场抛错**（不许画一个"没有选项"的假弹窗）');

head('⑤-A 询问 → 选『是』的端到端：真删、真不可恢复（走界面同一条路）');

const W5 = world(); const s5 = W5.store();
const d5 = await seed(s5, 'EX_H', '辛卷');
const pv5 = await E.deletePreview(s5, 'EX_H');
eq(pv5.plan.wrongCount, Object.keys(d5.book.entries).length, '询问里报的错题条数与真本子一致');
let answer5 = null;
const dlg5 = DeleteDialog.mount({ container: host2, prompt: pv5.plan, onChoose: function (p) { answer5 = p; } });
DOM.byAttr(dlg5.el, 'data-dd', 'opt')[0].click();
dlg5.destroy();
eq(answer5, 'cascade', '界面选中的是 cascade（"是"）');
const done5 = await E.deleteExam(s5, 'EX_H', { policy: answer5, now: '2026-10-23T00:00:00.000Z' });
eq(done5.ok, true, '按界面选择执行删除');
eq(keysOf(W5.rawKeys(), 'EX_H'), { body: [], sub: [], record: [], wrong: [] }, '**删干净**');
eq((await E.scanOrphans(s5)).orphans, [], '  零孤儿');
eq((await E.scanOrphans(s5)).identified, [], '  零残留标识');
eq((await W.loadBook(W5.reopen(), 'EX_H')).empty, true, '  重开后误答本读不回来（不可恢复）');

head('⑤-B 询问 → 选『否』的端到端：记录留下且"有主"');

const W6 = world(); const s6 = W6.store();
const d6 = await seed(s6, 'EX_I', '壬卷');
const pv6 = await E.deletePreview(s6, 'EX_I');
const dlg6 = DeleteDialog.mount({ container: host2, prompt: pv6.plan, onChoose: function (p) { answer5 = p; } });
DOM.byAttr(dlg6.el, 'data-dd', 'opt')[1].click();
dlg6.destroy();
eq(answer5, 'keepRecords', '界面选中的是 keepRecords（"否"）');
const done6 = await E.deleteExam(s6, 'EX_I', { policy: answer5, now: '2026-10-23T10:00:00.000Z' });
eq(done6.ok, true, '按界面选择执行删除');
const scan6 = await E.scanOrphans(s6);
eq(scan6.orphans, [], '**零孤儿**（保留的记录都在墓碑覆盖下）');
eq(scan6.identified.length, 2, '  2 条残留记录被列为"有主"');
eq(scan6.identified.every(o => o.label === '已删除试卷（原《壬卷》）'), true, '  每一条都带同一个归属标识');
const back6 = await W.loadBook(W6.reopen(), 'EX_I');
eq(W.stats(back6.book).total, Object.keys(d6.book.entries).length, '**重开后记录还在**（选"否"就是真的保留）');
eq((await E.ownerOf(W6.reopen(), 'EX_I')).kind, 'deleted', '  归属仍是"已删除试卷"（信息没有随刷新丢掉）');

console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
console.log('  PASS ' + pass + '    FAIL ' + fail);
if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
console.log('  \x1b[90m注：弹窗的真浏览器观感（遮罩层级/触屏尺寸）→ 见 浏览器自检.html 的 N 节\x1b[0m');
process.exitCode = fail ? 1 : 0;

})().catch(function (e) { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
