/* ============================================================
 *  verify/namespace.test.js —— 「命名空间隔离」小类验收
 *
 *  运行： node verify/namespace.test.js
 *
 *  三条盘档验收标准，逐条对应：
 *    ① 两个不同命名空间写入同名键后各自读回自己的值，互不影响
 *    ② 删除一卷的数据不会影响另一卷的同名键与全局设置
 *    ③ 分享文件与出题者使用同一套前缀规则，接收者的记录不会进入出题者的命名空间
 *
 *  ⚠️ 本文件最容易写错、也最容易"看起来通过"的地方：
 *     隔离测试必须让两个命名空间**共用同一对后端**。
 *     file:// 下所有本地 HTML 共享同一份 localStorage/IndexedDB，这才是真实处境。
 *     若给每个命名空间各配一套假后端，它们本来就没共享任何东西，
 *     就算前缀规则被完全忽略，测试照样全绿 —— 那是空转。
 *     所以 ①-A 里专门断言"底层原始存储里两把前缀键都在"。
 * ============================================================ */
const DataCore = require('../core/data.js');

let pass = 0, fail = 0; const failures = [];
function brief(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return String(s);
  return s.length > 150 ? s.slice(0, 150) + '…(' + s.length + ' 字符)' : s;
}
function ok(c, t, d) { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + brief(d) : '')))
                         : (fail++, failures.push(t), console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + brief(d) : ''))); }
function eq(a, e, t) { const A = JSON.stringify(a), E = JSON.stringify(e); ok(A === E, t + '   期望=' + brief(E), A); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }

/* ---------------- 共用的假后端（**所有命名空间共用这一份**） ---------------- */
function makeSmall() {
  const m = new Map();
  return {
    _dump: () => Object.fromEntries(m),
    _keys: () => Array.from(m.keys()),
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: k => { m.delete(k); },
    key: i => { const a = Array.from(m.keys()); return i < a.length ? a[i] : null; },
    get length() { return m.size; }
  };
}
function makeLarge() {
  const m = new Map();
  return {
    _dump: () => Object.fromEntries(m),
    _keys: () => Array.from(m.keys()),
    get: async k => (m.has(k) ? JSON.parse(m.get(k)) : null),
    set: async (k, v) => { m.set(String(k), JSON.stringify(v)); },
    del: async k => { m.delete(k); },
    keys: async () => Array.from(m.keys())
  };
}
/* 关键：一个 small + 一个 large 被所有命名空间共享 */
function sharedWorld() {
  const small = makeSmall(), large = makeLarge();
  return {
    small: small, large: large,
    store: function (ns, threshold) {
      return DataCore.createStore({
        small: small, large: large, namespace: ns,
        threshold: (threshold != null) ? threshold : 8192
      });
    }
  };
}

(async function main() {

  /* ============================================================
   * ① 同名键在两个命名空间里各读各的
   * ============================================================ */
  head('①-A 共用后端时，两个命名空间的同名键互不影响');

  const W = sharedWorld();
  const A = W.store('nsA');
  const B = W.store('nsB');
  await A.set('q1', { who: 'A 的 q1' });
  await B.set('q1', { who: 'B 的 q1' });
  await A.set('shared-name', { from: 'A' });
  await B.set('shared-name', { from: 'B' });

  eq((await A.get('q1')).who, 'A 的 q1', 'A 读回自己的 q1');
  eq((await B.get('q1')).who, 'B 的 q1', 'B 读回自己的 q1');
  eq((await A.get('shared-name')).from, 'A', 'A 读回自己的 shared-name');
  eq((await B.get('shared-name')).from, 'B', 'B 读回自己的 shared-name');
  eq((await A.keys()).slice().sort(), ['q1', 'shared-name'], 'A 的 keys() 只看到自己的两个键');
  eq((await B.keys()).slice().sort(), ['q1', 'shared-name'], 'B 的 keys() 同样只看到自己的');

  // 反空转：底层存储里两把带前缀的键**确实都存在**
  const rawKeys = W.small._keys().concat(W.large._keys());
  ok(rawKeys.indexOf('nsA::q1') >= 0, '底层存储里有 nsA::q1（证明两边真的共用了存储）', rawKeys.join(' '));
  ok(rawKeys.indexOf('nsB::q1') >= 0, '底层存储里有 nsB::q1');
  ok(rawKeys.indexOf('nsA::__index__') >= 0 && rawKeys.indexOf('nsB::__index__') >= 0,
     '两个命名空间各有**独立**的落点索引');
  eq(W.small._dump()['nsA::q1'], JSON.stringify({ who: 'A 的 q1' }), '  落点正确：A 的 q1 在同步侧');
  eq(W.small._dump()['nsB::q1'], JSON.stringify({ who: 'B 的 q1' }), '  落点正确：B 的 q1 在同步侧');

  head('①-B 分布在不同后端时也互不影响（一个走同步、一个走异步）');

  const W2 = sharedWorld();
  const Cs = W2.store('smallNs', 8192);      // 大记录也留在同步侧
  const Cl = W2.store('largeNs', 10);        // 超过 10 字节就走异步侧
  const big = { pad: 'x'.repeat(300) };
  await Cs.set('same', big);
  await Cl.set('same', big);
  eq(Cs.placement('same'), 'small', '小阈值命名空间的同名键落在同步侧');
  eq(Cl.placement('same'), 'large', '大阈值命名空间的同名键落在异步侧');
  eq((await Cs.get('same')).pad.length, 300, '  从同步侧读回完好');
  eq((await Cl.get('same')).pad.length, 300, '  从异步侧读回完好');
  eq((await Cs.get('same')).pad, (await Cl.get('same')).pad, '  两边内容相同但彼此独立');
  await Cs.set('same', { pad: 'CHANGED' });
  eq((await Cl.get('same')).pad.length, 300, '改一个命名空间的值，另一个不受影响');
  eq((await Cs.get('same')).pad, 'CHANGED', '  自己这边确实改了');

  const raw2 = W2.small._keys().concat(W2.large._keys());
  ok(raw2.indexOf('smallNs::same') >= 0 && raw2.indexOf('largeNs::same') >= 0,
     '底层两侧都能看到两把前缀键', raw2.join(' '));

  head('①-C 前缀相似也不许串（exam_1 vs exam_10）');

  const W3 = sharedWorld();
  const n1 = W3.store('exam_1'), n10 = W3.store('exam_10');
  await n1.set('k', { v: 1 });
  await n10.set('k', { v: 10 });
  eq((await n1.get('k')).v, 1, 'exam_1 读到自己的');
  eq((await n10.get('k')).v, 10, 'exam_10 读到自己的');
  eq((await n1.keys()).slice().sort(), ['k'], 'exam_1 的 keys() 里只有自己那把');
  eq((await n10.keys()).slice().sort(), ['k'], 'exam_10 的 keys() 里只有自己那把');
  eq(DataCore.isInNamespace('exam_10::k', 'exam_1'), false,
     '分隔符 :: 挡住了前缀包含关系（exam_10::k 不属于 exam_1）');
  eq(DataCore.isInNamespace('exam_1::k', 'exam_10'), false, '反向同样不成立');
  eq(DataCore.nsOf('exam_10::k'), 'exam_10', 'nsOf 正确切出命名空间');
  eq(DataCore.keyOf('exam_10::k'), 'k', 'keyOf 正确切出键名');
  eq(DataCore.nsOf('没有分隔符'), null, '没有分隔符时 nsOf 返回 null（不瞎猜）');
  eq(DataCore.keyOf('没有分隔符'), null, '  keyOf 同样返回 null');

  /* ============================================================
   * ② 删一卷只影响本卷
   * ============================================================ */
  head('②-A 全局空间里放两卷 + 全局设置，只清其中一卷');

  const W4 = sharedWorld();
  const G = W4.store(DataCore.NS_GLOBAL, 200);
  await G.set('settings', { theme: 'dark', points: { '单选': 2 } });
  await G.set('index', { examIds: ['A', 'B'], updatedAt: '2026-09-16T00:00:00.000Z' });
  await G.set(DataCore.examBodyKey('A'), { id: 'A', title: '甲卷' });
  await G.set(DataCore.examSubKey('A', 'q1'), { id: 'q1', stem: 'A 的题' });
  await G.set(DataCore.examSubKey('A', 'qbig'), { pad: 'z'.repeat(500) });   // 超阈值 → 异步侧
  await G.set(DataCore.examBodyKey('B'), { id: 'B', title: '乙卷' });
  await G.set(DataCore.examSubKey('B', 'q1'), { id: 'q1', stem: 'B 的题' });
  await G.set(DataCore.recordKey('A'), { tries: 3 });        // 作答记录（默认不跟着删）
  await G.set(DataCore.recordKey('B'), { tries: 7 });

  eq(G.placement(DataCore.examSubKey('A', 'qbig')), 'large', 'A 的大子键落在异步侧（后面要验它也被清掉）');
  eq(G.placement('settings'), 'small', '全局设置落在同步侧');

  const beforeKeys = (await G.keys()).slice().sort();
  const res = await G.purgeExam('A');
  ok(res.ok, 'purgeExam(A) 成功');

  eq(res.deleted.slice().sort(),
     ['exam::A', 'exam::A::q1', 'exam::A::qbig'].sort(),
     '删掉的正好是 A 的卷本体 + 它的两个子键（含异步侧那个）');
  eq(await G.get(DataCore.examBodyKey('A')), null, 'A 的卷本体已删');
  eq(await G.get(DataCore.examSubKey('A', 'q1')), null, 'A 的子键已删');
  eq(await G.get(DataCore.examSubKey('A', 'qbig')), null, 'A 在**异步侧**的大子键也已删');
  ok(W4.large._keys().indexOf('app::exam::A::qbig') < 0, '  异步后端里确实清掉了');
  ok(W4.small._keys().indexOf('app::exam::A::q1') < 0, '  同步后端里确实清掉了');

  eq(await G.get(DataCore.examBodyKey('B')), { id: 'B', title: '乙卷' }, 'B 的卷本体原样保留');
  eq(await G.get(DataCore.examSubKey('B', 'q1')), { id: 'q1', stem: 'B 的题' }, 'B 的同名子键 q1 原样保留');
  eq(await G.get(DataCore.recordKey('B')), { tries: 7 }, 'B 的作答记录原样保留');
  eq(await G.get('settings'), { theme: 'dark', points: { '单选': 2 } }, '全局设置原样保留');
  eq(await G.get(DataCore.recordKey('A')), { tries: 3 },
     'A 的作答记录**默认不删**（级联政策属"删卷级联询问"小类，这里只提供机制）');

  const idxAfter = await G.get('index');
  eq(idxAfter.examIds, ['B'], '落点索引里摘掉了 A、保留了 B');
  eq(idxAfter.updatedAt !== '2026-09-16T00:00:00.000Z', true, '  索引时间戳已更新');

  const afterKeys = (await G.keys()).slice().sort();
  const shouldRemain = beforeKeys.filter(k => res.deleted.indexOf(k) < 0).sort();
  eq(afterKeys, shouldRemain, '剩余键集合 = 原集合 - 删除集合（没有误删）');

  head('②-B 删除的边界情形');

  // 卷 id 前缀相似：A 与 A2 不能互相误伤
  const W5 = sharedWorld();
  const G5 = W5.store(DataCore.NS_GLOBAL, 4096);
  await G5.set(DataCore.examBodyKey('A'), { id: 'A' });
  await G5.set(DataCore.examSubKey('A', 'x'), { v: 'A.x' });
  await G5.set(DataCore.examBodyKey('A2'), { id: 'A2' });
  await G5.set(DataCore.examSubKey('A2', 'x'), { v: 'A2.x' });
  await G5.purgeExam('A');
  eq(await G5.get(DataCore.examBodyKey('A')), null, '删 A：A 本体没了');
  eq(await G5.get(DataCore.examSubKey('A', 'x')), null, '  A 的子键没了');
  eq(await G5.get(DataCore.examBodyKey('A2')), { id: 'A2' }, '  A2 的本体**没被误伤**（id 前缀相似）');
  eq(await G5.get(DataCore.examSubKey('A2', 'x')), { v: 'A2.x' }, '  A2 的子键也没被误伤');

  // 删不存在的卷：什么都不删，也不报错
  const W6 = sharedWorld();
  const G6 = W6.store(DataCore.NS_GLOBAL, 4096);
  await G6.set('settings', { keep: true });
  const res6 = await G6.purgeExam('不存在的卷');
  eq(res6.ok, true, '删不存在的卷不报错');
  eq(res6.deleted, [], '  什么都没删');
  eq(await G6.get('settings'), { keep: true }, '  全局设置安然无恙');

  // 空前缀护栏：不许靠一个手滑的字符串清空整个命名空间
  const W7 = sharedWorld();
  const G7 = W7.store('guard');
  await G7.set('a', { v: 1 });
  await G7.set('b', { v: 2 });
  const bad = await G7.purgeByScope({ prefix: [''] });
  eq(bad.ok, false, '空前缀被拒绝（否则等于清空整个命名空间）');
  eq((await G7.keys()).slice().sort(), ['a', 'b'], '  拒绝之后数据一条没少');
  const bad2 = await G7.purgeByScope({ prefix: ['', 'a'] });
  eq(bad2.ok, false, '空前缀混在数组里也照样拒绝（不能只查第一个）');
  eq((await G7.keys()).slice().sort(), ['a', 'b'], '  依然一条没少');

  // 空卷 id：必须是"什么都不删"的空操作，绝不能变成"清光所有卷"
  const W7b = sharedWorld();
  const G7b = W7b.store(DataCore.NS_GLOBAL, 4096);
  await G7b.set(DataCore.examBodyKey('A'), { id: 'A' });
  await G7b.set(DataCore.examSubKey('A', 'q'), { v: 1 });
  await G7b.set(DataCore.examBodyKey('B'), { id: 'B' });
  await G7b.set('settings', { keep: 1 });
  const before7 = (await G7b.keys()).slice().sort();
  const empty = await G7b.purgeExam('');
  eq(empty.deleted, [], '空卷 id → 一个键都不删（不是"清光所有卷"）');
  eq((await G7b.keys()).slice().sort(), before7, '  整库原样');
  eq(await G7b.get('settings'), { keep: 1 }, '  全局设置原样');
  const emptyNull = await G7b.purgeExam(null);
  eq(emptyNull.deleted, [], '传 null 同样是空操作');
  eq((await G7b.keys()).slice().sort(), before7, '  整库仍原样');

  head('②-C 命名空间名里含分隔符 → 建 store 时就炸（否则前缀隔离会静默失效）');

  let nsErr = null;
  try { sharedWorld().store('a::b'); } catch (e) { nsErr = e; }
  ok(!!nsErr, 'namespace 含 "::" → createStore 直接抛错');
  ok(!!nsErr && /分隔符/.test(nsErr.message), '  错误信息说清了原因', nsErr && nsErr.message);
  eq(DataCore.isInNamespace('a::b::k', 'a'), true,
     '确实存在这个隐患：ns="a" 会把 "a::b::k" 认成自己的（所以必须提前拦住）');
  eq(DataCore.nsOf('a::b::k'), 'a', '  从 a::b::k 只能切出 "a"（边界被撑破）');
  let okNs = null;
  try { okNs = sharedWorld().store('a_b'); } catch (e) { okNs = null; }
  ok(!!okNs, '合法的命名空间照常可用（守卫没有误伤）');
  eq(DataCore.assertSafeNamespace('recv_E1'), 'recv_E1', 'assertSafeNamespace 对合法名原样返回');

  /* ============================================================
   * ③ 分享文件与出题者同一套前缀规则
   * ============================================================ */
  head('③-A 前缀规则是唯一真相源（调用方不手拼字符串）');

  eq(DataCore.NS_SEP, '::', '分隔符常量只有一个来源');
  eq(DataCore.NS_GLOBAL, 'app', '全局命名空间名固定');
  eq(DataCore.receiverNamespace('E1'), 'recv_E1', '接收者命名空间 = recv_ + 卷 id');
  eq(DataCore.examBodyKey('E1'), 'exam::E1', '卷本体键 = exam:: + 卷 id（精确键）');
  eq(DataCore.examSubPrefix('E1'), 'exam::E1::', '卷子键前缀带尾分隔符（挡住 A / A2 串号）');
  eq(DataCore.examSubKey('E1', 'q7'), 'exam::E1::q7', '子键 = 前缀 + 名字');
  eq(DataCore.recordKey('E1'), 'record::E1', '记录键');
  eq(DataCore.wrongKey('E1'), 'wrong::E1', '错题键');
  eq(DataCore.prefixedKey('ns', 'k'), 'ns::k', '命名空间加前缀');
  eq(DataCore.indexKeyOf('ns'), 'ns::__index__', '落点索引键按命名空间分离');
  eq(DataCore.examScopeOf('E1'),
     { id: 'E1', body: 'exam::E1', sub: 'exam::E1::', record: 'record::E1', wrong: 'wrong::E1' },
     'examScopeOf 一次给全一卷的作用域');
  // 空值安全
  eq(DataCore.receiverNamespace(null), 'recv_', 'receiverNamespace(null) 不抛');
  eq(DataCore.examBodyKey(undefined), 'exam::', 'examBodyKey(undefined) 不抛');

  head('③-B 出题者空间与接收者空间互斥');

  const authorNs = DataCore.NS_GLOBAL;
  const recvNs = DataCore.receiverNamespace('E1');
  eq(DataCore.isInNamespace(DataCore.prefixedKey(authorNs, 'exam::E1'), recvNs), false,
     '出题者的卷键**不**属于接收者空间');
  eq(DataCore.isInNamespace(DataCore.prefixedKey(recvNs, 'record::E1'), authorNs), false,
     '接收者的记录键**不**属于出题者空间');
  eq(DataCore.isInNamespace(DataCore.prefixedKey(recvNs, 'wrong::E1'), authorNs), false, '  错题键同理');
  eq(DataCore.isInNamespace(DataCore.prefixedKey(recvNs, 'session'), authorNs), false, '  会话键同理');
  eq(recvNs.indexOf(DataCore.NS_RECV_PREFIX), 0, '接收者空间一律以 recv_ 开头（一眼可辨）');

  head('③-C 共用后端时，接收者写入不会出现在出题者的 keys() 里');

  const W8 = sharedWorld();
  const author = W8.store(DataCore.NS_GLOBAL, 4096);
  await author.set(DataCore.examBodyKey('E1'), { id: 'E1', title: '要分享的卷' });
  await author.set('index', { examIds: ['E1'] });

  const receiver = W8.store(DataCore.receiverNamespace('E1'), 4096);
  await receiver.set(DataCore.recordKey('E1'), { tries: 1, score: 88 });
  await receiver.set(DataCore.wrongKey('E1'), { q7: { times: 2 } });
  await receiver.set('session', { at: 4 });

  eq((await author.keys()).slice().sort(), ['exam::E1', 'index'],
     '出题者只看到自己的键 —— 接收者的记录一条都没进来');
  eq((await receiver.keys()).slice().sort(), ['record::E1', 'session', 'wrong::E1'],
     '接收者只看到自己的键 —— 出题者的卷本体它看不到');
  eq(await author.get(DataCore.recordKey('E1')), null, '出题者读接收者的记录：null（不是串了数据）');
  eq(await receiver.get(DataCore.examBodyKey('E1')), null, '接收者读出题者的卷本体：null');

  // 底层存储里两套前缀并存，但互不干扰
  const raw8 = W8.small._keys();
  ok(raw8.indexOf('app::exam::E1') >= 0, '底层有出题者的 app::exam::E1', raw8.join(' '));
  ok(raw8.indexOf('recv_E1::record::E1') >= 0, '底层有接收者的 recv_E1::record::E1');
  ok(raw8.indexOf('app::__index__') >= 0 && raw8.indexOf('recv_E1::__index__') >= 0,
     '两个空间的落点索引各一份');

  await receiver.purgeExam('E1', { includeRecords: true });
  eq((await author.keys()).slice().sort(), ['exam::E1', 'index'],
     '接收者清理自己的数据后，出题者的数据一点没动');

  head('③-D 分享载荷里不含记录；接收者空间由载荷里的卷 id 决定');

  const shareState = {
    secrets: { apiKey: 'sk-不应出现' },
    settings: { theme: 'dark' },
    exams: [{
      id: 'E1', title: '要分享的卷', config: null, configLocked: false,
      questions: [{ id: 'q1', type: '判断', stem: '地球是圆的？', options: null, answer: '对',
                    answerLetters: null, judgeValue: true, keywords: null, explanation: '' }]
    }],
    records: { E1: [{ score: 88, at: '2026-09-16' }] },
    wrongbook: { E1: { q7: { times: 2 } } }
  };
  const payload = DataCore.sanitizeSharePayload(shareState, { examId: 'E1' });
  const payloadJson = JSON.stringify(payload);
  eq(payload.kind, 'quiz-share', '载荷类型正确');
  eq(payload.exams.length, 1, '只带指定的那一卷');
  eq(payload.exams[0].id, 'E1', '卷 id 在载荷里（接收者据此推自己的命名空间）');
  ok(payloadJson.indexOf('sk-') < 0, '载荷里没有密钥');
  ok(payloadJson.indexOf('wrongbook') < 0 && payloadJson.indexOf('records') < 0,
     '载荷里连 records/wrongbook 这两个**字段名**都没有（不是留 null）');
  eq(DataCore.findSecrets(payload), [], 'findSecrets 在载荷上查不到任何敏感项');

  const sharedHtml = DataCore.embedPayload('<html><body>试卷</body></html>', payload, { secrets: [] });
  const back = DataCore.extractPayload(sharedHtml);
  ok(!!back, '分享文件里的载荷能读回来');
  eq(back.exams[0].id, 'E1', '  读回的卷 id 一致');
  eq(DataCore.receiverNamespace(back.exams[0].id), 'recv_E1',
     '接收者的命名空间由**载荷里的卷 id**推出 —— 出题者与接收者同一套规则');

  /* ============================================================
   * ④ 相邻锚：校对入库 → 删卷，两条链路必须对得上
   * ============================================================ */
  head('④ 相邻锚：review.commit 写入的键能被 purgeExam 精确清掉');

  const Review = require('../core/review.js');
  const Parser = require('../parser-core.js');
  const W9 = sharedWorld();
  const store = W9.store(DataCore.NS_GLOBAL, 4096);

  const parsed = Parser.parseText('【判断】地球是圆的？（　）\n答案：对\n');
  const mk = () => Review.createDraft(parsed, { now: '2026-09-16T19:00:00.000Z' }).draft;
  const c1 = await Review.commit(mk(), store, { now: '2026-09-16T19:00:00.000Z', rng: null });
  const c2 = await Review.commit(mk(), store, { now: '2026-09-16T19:01:00.000Z', rng: null });
  ok(c1.ok && c2.ok, '先后入库两卷', (c1.error || '') + (c2.error || ''));

  const ksBefore = (await store.keys()).slice().sort();
  eq(ksBefore, ['exam::' + c1.examId, 'exam::' + c2.examId, 'index'].sort(),
     'review 用的键名与命名空间规则**完全吻合**（exam::<id> + index）');
  eq((await store.get('index')).examIds.length, 2, '索引里两卷都在');

  const purged = await store.purgeExam(c1.examId);
  eq(purged.deleted, ['exam::' + c1.examId], 'purgeExam 精确删掉这一卷（不多不少）');
  eq(await store.get(DataCore.examBodyKey(c2.examId)) !== null, true, '  另一卷原样保留');
  eq((await store.get('index')).examIds, [c2.examId], '  索引里只剩另一卷');
  eq((await store.keys()).slice().sort(), ['exam::' + c2.examId, 'index'].sort(), '  键集合干净');
  eq((await store.usage()) > 0, true, '  存储仍有内容（没被误清空）');

  console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
  console.log('  PASS ' + pass + '    FAIL ' + fail);
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
