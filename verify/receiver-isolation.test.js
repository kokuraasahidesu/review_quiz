/* ============================================================
 *  verify/receiver-isolation.test.js —— 「接收者隔离」小类验收（verify=self）
 *
 *  运行： node build.js && node verify/receiver-isolation.test.js   （依赖 build 产物）
 *
 *  三条验收标准，逐条对应：
 *    ① 接收者能正常作答与判分，记录只落本机（**出题者本机看不到接收者的记录**）；
 *    ② 同一浏览器打开两份不同分享文件，各自的试卷与记录**互不串**（用命名空间扫描断言）；
 *    ③ 清空接收者本地数据后重新打开分享文件，**试卷仍完好**（来自文件内嵌载荷，不依赖本机存储）。
 *
 *  做法：用一份**带枚举能力的假 localStorage**（真 localStorage 的 `key(i)/length` 就够扫命名空间了），
 *  把"出题者那一侧"和"接收者那一侧"都按页面里的**同一套调用**跑一遍
 *  （`createStore({namespace}) → AttemptCore.createProgressStore → save`、`WrongCore.collectToStore`），
 *  再逐键核对落到了哪个空间。页面侧的接线另有静态锚：verify/wiring.test.js ⑨。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const D = require('../core/data.js');
const S = require('../core/schema.js');
const Q = require('../core/quiz.js');
const A = require('../core/attempt.js');
const W = require('../core/wrong.js');

const HERE = path.join(__dirname, '..');
const ANSWER_SHELL = fs.readFileSync(path.join(HERE, '答题页.html'), 'utf8');

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

/* 假 localStorage：**必须实现 key(i)/length**，否则扫不了命名空间（只有一个 Map 是扫不出来的） */
function fakeLS() {
  const m = new Map();
  return {
    m: m,
    getItem: function (k) { return m.has(String(k)) ? m.get(String(k)) : null; },
    setItem: function (k, v) { m.set(String(k), String(v)); },
    removeItem: function (k) { m.delete(String(k)); },
    key: function (i) { const ks = Array.from(m.keys()); return i < ks.length ? ks[i] : null; },
    get length() { return m.size; }
  };
}
function allKeys(ls) { const out = []; for (let i = 0; i < ls.length; i++) out.push(ls.key(i)); return out; }
function keysIn(ls, ns) { return allKeys(ls).filter(function (k) { return D.isInNamespace(k, ns); }).sort(); }
function snapshot(ls) { const snap = {}; allKeys(ls).forEach(function (k) { snap[k] = ls.getItem(k); }); return snap; }

const AT = '2026-11-02T15:30:00.000Z';
function makeExam(id, title) {
  return S.createExam({
    id: id, title: title,
    config: Q.resolveConfig({ points: { '单选': 3, '简答': 8 } }, null),
    configLocked: true,
    questions: [
      S.createQuestion({ id: id + '-q1', type: '单选', stem: id + ' 第一题：默认端口？',
        options: [{ label: 'A', text: '21' }, { label: 'B', text: '80' }], answerLetters: ['B'], answer: 'B' }),
      S.createQuestion({ id: id + '-q2', type: '单选', stem: id + ' 第二题：传输层协议？',
        options: [{ label: 'A', text: 'TCP' }, { label: 'B', text: 'HTTP' }], answerLetters: ['A'], answer: 'A' }),
      S.createQuestion({ id: id + '-q3', type: '简答', stem: id + ' 第三题：简述三次握手',
        answer: 'SYN ACK', keywords: [{ text: 'SYN', via: '加粗' }, { text: 'ACK', via: '加粗' }] })
    ]
  }, { now: AT });
}
const EXAM_A = makeExam('A1', '三次握手练习');
const EXAM_B = makeExam('B2', '路由与交换');
/* 出题者的卷（app 空间）。注意配置是**锁定的自定义分值**，接收者要按同一口径判分。 */
const AUTHOR_FULL_A = Q.scoreExam(EXAM_A.questions, { 'A1-q1': 'B', 'A1-q2': 'A', 'A1-q3': 'SYN ACK' },
  Q.resolveConfig(Q.DEFAULT_CONFIG, EXAM_A)).full;

function fileOf(exam) {
  const r = D.exportStandalone({ exams: [exam] }, ANSWER_SHELL, { examId: exam.id, at: AT, secrets: [] });
  if (!r.ok) throw new Error('测试前置失败：导出没成功 → ' + r.message);
  return r;
}
/* 打开一份分享文件：完全按答题页的启动路径（读载荷 → 建会话 → 用 recv_<卷id> 建存储） */
function openShared(fileText) {
  const payload = D.extractPayload(fileText);
  const e0 = payload.exams[0];
  const questions = e0.questions.map(function (q) { return S.createQuestion(q); });
  /* ⚠ 命名空间走**页面用的同一个入口**（含内容指纹），测试不自己拼规则 */
  return { e0: e0, questions: questions, ns: D.receiverNamespaceFor(e0),
           config: Q.resolveConfig(Q.DEFAULT_CONFIG, e0) };
}
/* 跑一轮：作答 → 交卷 → 收错题（与答题页 collectWrong 同一套调用） */
async function runRound(store, examId, questions, config, answers, now, sessionAt) {
  const s = A.createSession({ examId: examId, title: '卷', questions: questions, config: config });
  questions.forEach(function (q, i) {
    if (answers[q.id] === undefined) return;
    A.goto(s, i); A.answer(s, answers[q.id]); A.submitCurrent(s);
  });
  const fin = A.finish(s, { confirmUnanswered: true, now: sessionAt });
  const byId = {}; questions.forEach(function (q) { byId[q.id] = q; });
  const col = await W.collectToStore(store, { examId: examId, results: fin.summary.per, now: now,
    sessionAt: sessionAt, questionsById: byId, answers: s.answers });
  return { session: s, summary: fin.summary, collected: col };
}

async function main() {
  const ls = fakeLS();
  const AUTHOR_NS = D.NS_GLOBAL;
  /* 接收者空间 = recv_<卷id>.<内容指纹>（**唯一正确入口** receiverNamespaceFor） */
  const NS_A = D.receiverNamespaceFor(EXAM_A);
  const NS_B = D.receiverNamespaceFor(EXAM_B);

  head('①-A 定义清楚：接收者空间是 recv_ + 试卷ID + 内容指纹，与出题者的 app 空间是两个空间');

  eq(D.receiverNamespace('A1'), 'recv_A1', 'receiverNamespace("A1") = recv_A1（老口径仍在，供底层拼名字用）');
  eq(NS_A.indexOf(D.receiverNamespace('A1') + '.'), 0, '**新入口**在卷 id 后面接一段内容指纹：' + NS_A);
  ok(NS_A.indexOf(D.NS_RECV_PREFIX) === 0, '接收者空间一律以 recv_ 开头（一眼可辨）');
  ok(NS_A !== AUTHOR_NS, '**接收者空间 ≠ 出题者空间**（两个字符串本来就不一样）');
  eq(D.nsOf(NS_A + D.NS_SEP + 'record' + D.NS_SEP + 'A1'), NS_A, 'nsOf 能从整键里切回命名空间');
  ok(D.isInNamespace(NS_A + D.NS_SEP + 'wrong' + D.NS_SEP + 'A1', NS_A), 'isInNamespace 认自己的键');
  eq(D.isInNamespace(D.receiverNamespaceFor(EXAM_B) + D.NS_SEP + 'k', NS_A), false,
     '**前缀边界**：另一个空间的键不属于本空间（靠 `::` 兜住，不是裸 startsWith）');
  /* 指纹的语义：改内容 → 换空间；内容不变 → 空间不变 */
  const twin = S.createExam({ id: 'A1', title: '三次握手练习', config: EXAM_A.config, configLocked: true,
    questions: EXAM_A.questions }, { now: AT });
  eq(D.receiverNamespaceFor(twin), NS_A, '**同 id 同内容 → 同一个空间**（同一份卷反复打开能续答）');
  const other = S.createExam({ id: 'A1', title: '三次握手练习', config: EXAM_A.config, configLocked: true,
    questions: [S.createQuestion({ id: 'A1-q1', type: '单选', stem: '题干换了一句话：默认端口是多少？',
      options: [{ label: 'A', text: '21' }, { label: 'B', text: '80' }], answerLetters: ['B'], answer: 'B' })] }, { now: AT });
  ok(D.receiverNamespaceFor(other) !== NS_A, '**同 id 不同内容 → 不同空间**（这正是组级红队抓到的漏洞）',
     D.receiverNamespaceFor(other));

  head('①-B 出题者先在自己的 app 空间里作答（记录落在 app_.）');

  const authorStore = D.createStore({ small: ls, large: null, namespace: AUTHOR_NS });
  const authorQ = EXAM_A.questions;
  const authorRound = await runRound(authorStore, 'A1', authorQ, Q.resolveConfig(Q.DEFAULT_CONFIG, EXAM_A),
    { 'A1-q1': 'A', 'A1-q2': 'A', 'A1-q3': 'SYN ACK' },               // q1 故意答错，其余全对
    '2026-11-02T10:00:00.000Z', 'S-AUTHOR');
  const authorPs = A.createProgressStore(authorStore, { examId: 'A1' });
  await authorPs.save(authorRound.session, { now: '2026-11-02T10:00:00.000Z' });
  eq(authorRound.collected.added, ['A1-q1'], '出题者答错的是 q1 → 他的误答本里只有 q1');
  const authorSnap = snapshot(ls);
  const authorKeys = keysIn(ls, AUTHOR_NS);
  ok(authorKeys.length > 0, 'app 空间里确实有出题者的记录', authorKeys.join(' / '));
  ok(authorKeys.every(function (k) { return D.isInNamespace(k, AUTHOR_NS); }), '  而且全都在 app 空间里');
  eq(keysIn(ls, NS_A).length, 0, '此刻接收者空间还是空的（还没人打开分享文件）');

  head('①-C 接收者打开同一份分享文件：记录**只**落 recv_A1，app 空间一个字节都不变');

  const fileA = fileOf(EXAM_A);
  const openA = openShared(fileA.html);
  eq([openA.e0.id, openA.questions.length], ['A1', 3], '打开分享文件：拿到的是文件里那套卷（3 题）');
  eq(openA.ns, NS_A, '  接收者空间 = receiverNamespaceFor(载荷里的卷)（**由文件内容决定**，不靠本机存储）');
  const recvStoreA = D.createStore({ small: ls, large: null, namespace: openA.ns });
  const recvRound = await runRound(recvStoreA, openA.e0.id, openA.questions, openA.config,
    { 'A1-q1': 'B', 'A1-q2': 'B', 'A1-q3': 'SYN ACK' },                // 接收者答错的是 q2（与出题者不同）
    '2026-11-02T15:30:00.000Z', 'S-RECV');
  const recvPs = A.createProgressStore(recvStoreA, { examId: openA.e0.id });
  await recvPs.save(recvRound.session, { now: '2026-11-02T15:30:00.000Z' });

  eq(recvRound.collected.added, ['A1-q2'], '接收者答错的是 q2 → 他的误答本里只有 q2');
  const appKeysNow = keysIn(ls, AUTHOR_NS);
  eq(appKeysNow, authorKeys, '**app 空间的键集合一个没多、一个没少**（出题者的记录没被接收者碰到）');
  const appSame = authorKeys.every(function (k) { return ls.getItem(k) === authorSnap[k]; });
  eq(appSame, true, '  而且每个键的**值也逐字节没变**（不是"键在值被覆盖"）');
  const recvKeysA = keysIn(ls, NS_A);
  ok(recvKeysA.length > 0, '接收者的记录确实写下去了', recvKeysA.join(' / '));
  ok(recvKeysA.every(function (k) { return D.isInNamespace(k, NS_A); }), '  且**每一个键都在 recv_A1 空间内**');
  eq(recvKeysA.every(function (k) { return D.isInNamespace(k, AUTHOR_NS); }), false,
     '  没有任何一个接收者键落在 app 空间（两边的边界是硬的）');

  head('①-D 出题者本机**看不到**接收者的记录，接收者也看不到出题者的');

  const authorBook = (await W.loadBook(authorStore, 'A1')).book;
  const recvBook = (await W.loadBook(recvStoreA, 'A1')).book;
  eq(Object.keys(authorBook.entries).sort(), ['A1-q1'], '出题者翻自己的误答本：只有他答错的 q1');
  eq(Object.keys(recvBook.entries).sort(), ['A1-q2'], '接收者翻自己的误答本：只有他答错的 q2');
  ok(Object.keys(authorBook.entries).indexOf('A1-q2') < 0,
     '**出题者的本子里没有接收者那条**（同一个卷 id，串不到一起去）');
  ok(Object.keys(recvBook.entries).indexOf('A1-q1') < 0, '  反之亦然');
  /* 进度同理：两边各自的作答文本不同 */
  const authorLoaded = await A.createProgressStore(authorStore, { examId: 'A1' }).load(authorQ);
  const recvLoaded = await A.createProgressStore(recvStoreA, { examId: 'A1' }).load(openA.questions);
  eq([authorLoaded.ok, recvLoaded.ok], [true, true], '两边都能各自恢复自己的进度');
  ok(JSON.stringify(authorLoaded.payload) !== JSON.stringify(recvLoaded.payload),
     '**两份进度不是同一份**（出题者答的 A/A/SYN，接收者答的 B/B/SYN ACK）');

  head('②-A 同一浏览器打开**两份不同分享文件**：各自的试卷与记录互不串');

  const fileB = fileOf(EXAM_B);
  const openB = openShared(fileB.html);
  const recvStoreB = D.createStore({ small: ls, large: null, namespace: openB.ns });
  const roundB = await runRound(recvStoreB, openB.e0.id, openB.questions, openB.config,
    { 'B2-q1': 'A', 'B2-q2': 'B', 'B2-q3': 'SYN ACK' }, '2026-11-02T16:00:00.000Z', 'S-RECV-B');
  eq([openB.ns, openB.ns !== NS_A], [NS_B, true], '第二份文件的接收者空间与第一份不同');
  const groups = {};
  allKeys(ls).forEach(function (k) { const ns = D.nsOf(k); groups[ns] = (groups[ns] || 0) + 1; });
  eq(Object.keys(groups).sort(), [AUTHOR_NS, NS_A, NS_B].sort(),
     '**命名空间扫描**：全库只有这三个空间，没有"第四者"（也不会有裸键）', JSON.stringify(groups));
  const recvKeysB = keysIn(ls, NS_B);
  eq(recvKeysA.filter(function (k) { return recvKeysB.indexOf(k) >= 0; }), [], 'A 空间的键与 B 空间的键**零交集**');
  eq(keysIn(ls, AUTHOR_NS), authorKeys, '  出题者的 app 空间仍然纹丝不动');
  const bookA2 = (await W.loadBook(recvStoreA, 'A1')).book;
  const bookB2 = (await W.loadBook(recvStoreB, 'B2')).book;
  eq(Object.keys(bookA2.entries).sort(), ['A1-q2'], 'A 的误答本还是只有 A1 的题（没混进 B2 的）');
  eq(Object.keys(bookB2.entries).sort(), ['B2-q1', 'B2-q2'], 'B 的误答本只记 B2 的题');
  ok(JSON.stringify(bookA2).indexOf('B2-') < 0, '**A 的记录里搜不到 B 的题号**（双向不串）');
  ok(JSON.stringify(bookB2).indexOf('A1-') < 0, '**B 的记录里也搜不到 A 的题号**');
  /* 交叉读取：拿 B 的 store 去读 A 的卷 → 读不到任何东西（隔离的硬证据） */
  const cross = await W.loadBook(recvStoreB, 'A1');
  eq([cross.empty, cross.book.entries], [true, {}], '用 B 的空间去读 A 的误答本 → **空**（不是"读到了 A 的"）');
  const crossProgress = await A.createProgressStore(recvStoreB, { examId: 'A1' }).load(openA.questions);
  eq([crossProgress.ok, crossProgress.reason], [false, 'empty'], '  用 B 的空间恢复 A 的进度 → 也是空（各写各的）');

  head('②-B 相邻锚：**卷 id 撞名的两份不同文件**也必须各归各（组级红队抓到的真漏洞）');

  /* 现实里太容易发生：两个人都把题库文件叫 `题库.docx`（答题页正是拿文件名当卷 id），
   * 或者都用内置样卷 `sample.docx`。只按 id 建空间 → 甲的文件能看到乙的错题。 */
  const sameIdA = S.createExam({ id: '题库.docx', title: '甲的文件', config: EXAM_A.config, configLocked: true,
    questions: [S.createQuestion({ id: '题库.docx-q1', type: '单选', stem: '甲的第一题：默认端口？',
      options: [{ label: 'A', text: '21' }, { label: 'B', text: '80' }], answerLetters: ['B'], answer: 'B' })] }, { now: AT });
  const sameIdB = S.createExam({ id: '题库.docx', title: '乙的文件', config: EXAM_A.config, configLocked: true,
    questions: [S.createQuestion({ id: '题库.docx-q1', type: '单选', stem: '乙的第一题：MAC 在哪层？',
      options: [{ label: 'A', text: '网络层' }, { label: 'B', text: '数据链路层' }], answerLetters: ['B'], answer: 'B' })] }, { now: AT });
  const fA = D.exportStandalone({ exams: [sameIdA] }, ANSWER_SHELL, { examId: '题库.docx', at: AT, secrets: [] });
  const fB = D.exportStandalone({ exams: [sameIdB] }, ANSWER_SHELL, { examId: '题库.docx', at: AT, secrets: [] });
  eq([fA.ok, fB.ok], [true, true], '两份**卷 id 一模一样**的文件都能导出');
  const oA = openShared(fA.html), oB = openShared(fB.html);
  ok(oA.ns !== oB.ns, '**空间不同**（内容指纹把它们分开了）', oA.ns + '  vs  ' + oB.ns);
  const storeA = D.createStore({ small: ls, large: null, namespace: oA.ns });
  await runRound(storeA, oA.e0.id, oA.questions, oA.config, { '题库.docx-q1': 'A' }, AT, 'SAMEID');
  const storeB = D.createStore({ small: ls, large: null, namespace: oB.ns });
  const seenFromB = await W.loadBook(storeB, oB.e0.id);
  eq([seenFromB.empty, seenFromB.book.entries], [true, {}],
     '**乙的文件里看不到甲的错题**（这条就是组级红队打回的那条，现在钉住了）');
  const seenFromA = await W.loadBook(storeA, oA.e0.id);
  eq(Object.keys(seenFromA.book.entries), ['题库.docx-q1'], '  甲自己的错题还在自己的空间里');
  /* 同一份内容再导一次：必须还落在同一个空间（否则"关掉再打开，进度就没了"） */
  const fA2 = D.exportStandalone({ exams: [sameIdA] }, ANSWER_SHELL, { examId: '题库.docx', at: AT, secrets: [] });
  eq(openShared(fA2.html).ns, oA.ns, '  同一份内容重复导出 → 仍然是同一个空间（续答不断）');

  head('②-C 相邻锚：前缀很像的两个卷 id（A vs A1）也不会互相认领');

  const nsShort = D.receiverNamespace('A');
  ok(D.isInNamespace(NS_A + D.NS_SEP + 'record' + D.NS_SEP + 'A1', nsShort) === false,
     '`recv_A1::…` 不属于空间 `recv_A`（靠 `::` 分隔，朴素前缀匹配会在这里出错）',
     'recv_A vs ' + NS_A);
  const shortStore = D.createStore({ small: ls, large: null, namespace: nsShort });
  await shortStore.set('record' + D.NS_SEP + 'A', 'x');
  eq(keysIn(ls, nsShort), [(nsShort + D.NS_SEP + 'record' + D.NS_SEP + 'A'), nsShort + D.NS_SEP + '__index__'].sort(),
     'recv_A 空间里只有它自己那两个键（数据键 + 它自己的落点索引）');
  ok(keysIn(ls, nsShort).indexOf(NS_A + D.NS_SEP + 'record' + D.NS_SEP + 'A1') < 0,
     '  recv_A1 的记录没有被 recv_A 认领');
  await shortStore.del('record' + D.NS_SEP + 'A');

  head('③-A 判分口径跟着卷走：接收者拿到的配置就是出题者锁定的那份');

  eq(openA.config.points['单选'], EXAM_A.config.points['单选'], '单选分值 = 出题者锁定的值（3 分）');
  eq(openA.config.points['简答'], 8, '简答分值 = 8 分（不是接收者本机的默认值）');
  const recvScore = Q.scoreExam(openA.questions.flatMap(function () { return []; }).concat(openA.questions),
    { 'A1-q1': 'B', 'A1-q2': 'A', 'A1-q3': 'SYN ACK' }, openA.config);
  eq(recvScore.full, AUTHOR_FULL_A, '接收者判满分 = 出题者判满分（同一份卷、同一副配置）');
  ok(recvScore.score > 0, '  全对时确实拿到分', recvScore.score + '/' + recvScore.full);

  head('③-B 清空接收者本地数据后重新打开：试卷仍完好（来自文件内嵌载荷）');

  const beforeClear = allKeys(ls).length;
  /* 清空 recv_A1 这一整个空间（按空间逐键删；等价于用户清了本机数据/换了浏览器） */
  const victims = keysIn(ls, NS_A).concat(keysIn(ls, NS_B));
  for (const k of victims) ls.removeItem(k);
  eq(keysIn(ls, NS_A).length + keysIn(ls, NS_B).length, 0, '接收者空间已清空（' + victims.length + ' 个键被删）',
     '清前共 ' + beforeClear + ' 个键');
  const reopen = openShared(fileA.html);
  eq(reopen.e0.id, openA.e0.id, '重新打开同一份文件：**试卷还在**（id 一样）');
  eq(JSON.stringify(reopen.e0), JSON.stringify(openA.e0), '  载荷逐字段一致（试卷不依赖本机存储）');
  eq(reopen.questions.length, 3, '  3 道题都在');
  eq(reopen.questions[0].stem, EXAM_A.questions[0].stem, '  题干也没变');
  const freshStore = D.createStore({ small: ls, large: null, namespace: reopen.ns });
  const freshLoad = await A.createProgressStore(freshStore, { examId: reopen.e0.id }).load(reopen.questions);
  eq([freshLoad.ok, freshLoad.reason], [false, 'empty'], '  进度是全新的一轮（没有残留的旧进度可恢复）');
  const freshScore = Q.scoreExam(reopen.questions, { 'A1-q1': 'B', 'A1-q2': 'A', 'A1-q3': 'ACK SYN' }, reopen.config);
  eq(freshScore.score, recvScore.score, '  判分照样正确（换个词序也命中：ACK SYN）');
  eq(keysIn(ls, AUTHOR_NS), authorKeys, '**出题者的记录仍然完好**（清接收者数据不该动到 app 空间）');

  head('③-C 相邻锚：脏卷 id 会被挡在命名空间之外（不允许撑破隔离边界）');

  let e1 = null;
  try { D.createStore({ small: ls, large: null, namespace: 'recv_a' + D.NS_SEP + 'b' }); } catch (e) { e1 = e; }
  ok(!!e1 && /分隔符/.test(String(e1.message)), '含 `::` 的命名空间 → createStore 直接抛错（不静默放行）');
  let e2 = null;
  try { D.assertSafeNamespace('x' + D.NS_SEP + 'y'); } catch (e) { e2 = e; }
  ok(!!e2, 'assertSafeNamespace 同样拦住它');
  /* 页面侧的挡板（卷 id 含分隔符就拒绝载入）在 wiring 测试里钉住；这里证明"为什么必须挡" */
  const badFile = fileA.html.replace(/"id":"A1"/g, '"id":"A1' + D.NS_SEP + 'evil"');
  const badPayload = D.extractPayload(badFile);
  eq(badPayload.exams[0].id.indexOf(D.NS_SEP) >= 0, true,
     '构造一份"卷 id 含分隔符"的分享文件：id = ' + badPayload.exams[0].id);
  let e3 = null;
  try { D.createStore({ small: ls, large: null, namespace: D.receiverNamespace(badPayload.exams[0].id) }); } catch (e) { e3 = e; }
  ok(!!e3, '  直接拿它建空间会抛错 → 所以页面必须先挡（否则白屏）');

  console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
  console.log('  PASS ' + pass + '    FAIL ' + fail);
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
  console.log('  \x1b[90m注：本小类 verify=self —— 开发方自验（两遍法）；反向对照见 verify/probe-receiver-isolation-old.js\x1b[0m');
  process.exitCode = fail ? 1 : 0;
}

main().catch(function (e) {
  console.log('\n\x1b[31m测试自身抛错：\x1b[0m' + ((e && e.stack) || e));
  process.exitCode = 1;
});
