/* ============================================================
 *  verify/storage.test.js —— 「双后端路由」小类验收
 *
 *  运行： node verify/storage.test.js
 *
 *  三条盘档验收标准，逐条对应：
 *    ① 小记录写同步后端、超阈值记录写异步后端，两类都能原样读回（含 8KB 以上大字段）
 *    ② 同步后端配额满时自动降级到异步后端，且降级原因被标记为 quota，降级后数据仍能读回
 *    ③ keys() 能跨两个后端汇总当前命名空间下全部键；删除操作同时清理两侧
 *
 *  为什么另开一个文件而不是塞进 verify.js：
 *    既有 verify.js §6 只覆盖了主干（8000 字符的大记录、删同步侧的键），
 *    本小类的判据需要**精确阈值边界**、**8KB 以上大字段无损**、**删除清两侧**，
 *    这些必须有自己的断言，不能靠"看起来测过了"。
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

/* 与 core/data.js 内部同一套字节口径（阈值按 UTF-8 字节数算，不是字符数） */
function jsonBytes(v) { return Buffer.byteLength(JSON.stringify(v), 'utf8'); }

/* ---------------- 可注入的假后端（带内省，才能断言"两侧都清了"） ---------------- */
function fakeSmall(capacity) {
  const m = new Map();
  return {
    _dump: function () { return Object.fromEntries(m); },
    _has: function (k) { return m.has(k); },
    _size: function () { return m.size; },
    getItem: function (k) { return m.has(k) ? m.get(k) : null; },
    setItem: function (k, v) {
      let used = 0; m.forEach(function (val, key) { used += key.length + val.length; });
      if (capacity && used + String(k).length + String(v).length > capacity) {
        const e = new Error('quota exceeded'); e.name = 'QuotaExceededError'; throw e;
      }
      m.set(k, String(v));
    },
    removeItem: function (k) { m.delete(k); },
    key: function (i) { const a = Array.from(m.keys()); return i < a.length ? a[i] : null; },
    get length() { return m.size; }
  };
}
function fakeLarge() {
  const m = new Map();
  return {
    _dump: function () { return Object.fromEntries(m); },
    _has: function (k) { return m.has(k); },
    _size: function () { return m.size; },
    get: async function (k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
    set: async function (k, v) { m.set(k, JSON.stringify(v)); },
    del: async function (k) { m.delete(k); },
    keys: async function () { return Array.from(m.keys()); }
  };
}
function pair(opts) {
  const small = fakeSmall(opts && opts.capacity);
  const large = fakeLarge();
  const store = DataCore.createStore({
    small: small, large: large,
    threshold: (opts && opts.threshold != null) ? opts.threshold : 8192,
    namespace: (opts && opts.namespace) || 'ns'
  });
  return { small: small, large: large, store: store };
}
function deepEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

(async function main() {

  /* ============================================================
   * ① 阈值路由 + 原样读回（含 8KB 以上大字段）
   * ============================================================ */
  head('①-A 小记录 → 同步后端；超阈值 → 异步后端');

  const P1 = pair({ threshold: 8192 });
  const rSmall = await P1.store.set('tiny', { a: 1, s: 'hello' });
  eq(rSmall.where, 'small', '小记录写同步后端');
  eq(P1.small._has('ns::tiny'), true, '  同步后端里确实有它');
  eq(P1.large._has('ns::tiny'), false, '  异步后端里没有（不该两边都写）');

  const rLarge = await P1.store.set('big', { pad: 'x'.repeat(9000) });
  eq(rLarge.where, 'large', '超阈值记录写异步后端');
  eq(P1.large._has('ns::big'), true, '  异步后端里确实有它');
  eq(P1.small._has('ns::big'), false, '  同步后端里没有');
  ok(rLarge.bytes > 8192, '  记录字节数确实超阈值', String(rLarge.bytes));

  head('①-B 阈值是"超过才切"，不是"达到就切"——测精确边界');

  // JSON = {"p":"<n 个 x>"} → 固定 8 字节外壳 + n
  const atLimit = { p: 'x'.repeat(8184) };
  const overLimit = { p: 'x'.repeat(8185) };
  eq(jsonBytes(atLimit), 8192, '自检：构造出的记录**正好** 8192 字节', String(jsonBytes(atLimit)));
  eq(jsonBytes(overLimit), 8193, '自检：构造出的记录 8193 字节', String(jsonBytes(overLimit)));

  const P2 = pair({ threshold: 8192, namespace: 'edge' });
  const eAt = await P2.store.set('atLimit', atLimit);
  const eOver = await P2.store.set('overLimit', overLimit);
  eq(eAt.where, 'small', '正好等于阈值 → 仍走同步后端（判据是 bytes > threshold）');
  eq(eOver.where, 'large', '阈值 +1 字节 → 切异步后端');

  head('①-C 8KB 以上大字段必须**原样**读回');

  const bigField = '汉'.repeat(12000);                       // 12000 个 CJK 字符 = 36000 字节
  eq(Buffer.byteLength(bigField, 'utf8'), 36000, '自检：大字段本身 36000 字节（远超 8KB）');
  const bigRec = { qid: 'q1', text: bigField, tail: '尾部标记✅', n: 12345, arr: [1, 2, 3] };
  const wBig = await P2.store.set('hugeField', bigRec);
  eq(wBig.where, 'large', '含 36KB 字段的记录 → 异步后端');
  const backBig = await P2.store.get('hugeField');
  eq(backBig.text.length, 12000, '  读回：大字段长度一致');
  eq(backBig.text, bigField, '  读回：大字段逐字符相同（不是截断/乱码）');
  eq(deepEq(backBig, bigRec), true, '  读回：整条记录逐字段深等');
  eq(backBig.tail, '尾部标记✅', '  读回：emoji/多字节尾部完好');
  eq(backBig.arr, [1, 2, 3], '  读回：嵌套数组完好');

  // 同步侧的小记录也要原样
  const backTiny = await P1.store.get('tiny');
  eq(deepEq(backTiny, { a: 1, s: 'hello' }), true, '同步侧的小记录同样原样读回');

  // 空值/边界值不走样
  const P3 = pair({ threshold: 8192, namespace: 'v' });
  for (const c of [['vNull', null], ['vZero', 0], ['vEmpty', ''], ['vFalse', false], ['vArr', []], ['vObj', {}]]) {
    await P3.store.set(c[0], c[1]);
    eq(await P3.store.get(c[0]), c[1], '边界值 ' + JSON.stringify(c[1]) + ' 原样读回');
  }

  /* ============================================================
   * ② 配额满 → 自动降级（reason='quota'）
   * ============================================================ */
  head('②-A 同步后端配额满 → 自动降级到异步后端，原因标记为 quota');

  const P4 = pair({ capacity: 200, threshold: 10 * 1024, namespace: 'q' });
  const wQ = await P4.store.set('q1', { pad: 'y'.repeat(500) });
  eq(wQ.where, 'large', '配额满时自动降级到异步后端');
  eq(wQ.reason, 'quota', '  降级原因被标记为 quota');
  eq(P4.small._has('q::q1'), false, '  同步后端里没有留下半截数据');
  eq(P4.large._has('q::q1'), true, '  异步后端里是完整的');
  eq(P4.store.placement('q1'), 'large', '  落点索引记为 large');
  const backQ = await P4.store.get('q1');
  eq(backQ.pad.length, 500, '  降级后数据仍能读回（长度一致）');
  eq(backQ.pad, 'y'.repeat(500), '  降级后数据逐字符相同');

  head('②-B 降级之后存储没有"卡死"：小的还能走同步，大的继续降级');

  const wAfter = await P4.store.set('q2', { v: 1 });
  eq(wAfter.where, 'small', '降级之后，小记录照样写同步后端');
  eq(await P4.store.get('q2') && (await P4.store.get('q2')).v, 1, '  能读回');
  const wQ2 = await P4.store.set('q3', { pad: 'z'.repeat(400) });
  eq(wQ2.where, 'large', '第二条超配额记录同样降级');
  eq(wQ2.reason, 'quota', '  原因同样标为 quota');
  eq(await P4.store.get('q3') !== null, true, '  也能读回');
  const ksQ = (await P4.store.keys()).slice().sort();
  eq(ksQ, ['q1', 'q2', 'q3'], '  两条降级的 + 一条同步的，keys() 都汇总到了');

  head('②-C 非配额异常：有异步后端就降级并记录真实原因名');

  const P5 = pair({ threshold: 10 * 1024, namespace: 'err' });
  const boom = new Error('存储被禁用');
  boom.name = 'SecurityError';
  P5.small.setItem = function () { throw boom; };     // 同步后端彻底写不动（连索引也写不动）
  const wErr = await P5.store.set('k', { v: 1 });
  eq(wErr.where, 'large', '同步后端抛非配额异常 → 同样降级到异步后端');
  eq(wErr.reason, 'SecurityError', '  原因记录为真实错误名（不是硬编码成 quota）');
  eq(wErr.indexPersisted, false, '  如实报告：落点索引没能持久化');
  eq((await P5.store.get('k')).v, 1,
     '  降级后仍能读回 —— 靠的是"索引丢了就两端找"的兜底（挑刺发现的缺陷已修）');
  eq((await P5.store.keys()).indexOf('k') >= 0, true,
     '  keys() 也能靠扫描异步后端找到它（不依赖索引）');
  let delOK = null;
  try { await P5.store.del('k'); } catch (e) { delOK = e; }
  ok(!delOK, '  索引写不动时删除也不报错', delOK && delOK.message);
  eq(P5.large._has('err::k'), false, '    异步侧确实清掉了');
  eq(await P5.store.get('k'), null, '    再读为 null');

  // 回归：正常路径下 indexPersisted 必须是 true（别把"总是 false"当成修好了）
  const P5b = pair({ threshold: 100, namespace: 'err2' });
  eq((await P5b.store.set('s', { v: 1 })).indexPersisted, true, '正常路径：索引持久化成功（对照）');
  eq(P5b.store.placement('s'), 'small', '  落点可查');

  head('②-D 没有异步后端时，配额异常必须抛出（不许静默丢数据）');

  const onlySmall = fakeSmall(0);
  const storeOnly = DataCore.createStore({ small: onlySmall, large: null, threshold: 10 * 1024, namespace: 'only' });
  const boom2 = new Error('quota exceeded'); boom2.name = 'QuotaExceededError';
  onlySmall.setItem = function () { throw boom2; };
  let threw = null;
  try { await storeOnly.set('k', { v: 1 }); } catch (e) { threw = e; }
  ok(!!threw && threw.name === 'QuotaExceededError',
     '没有异步后端时，配额异常必须抛出', threw && threw.name);
  eq(storeOnly.placement('k'), null, '  也没有留下落点记录');

  head('②-E 索引过期时读取不许"看不见数据"（挑刺发现：索引写不动会导致读侧丢数据）');

  const P9 = pair({ threshold: 10 * 1024, namespace: 'stale' });
  await P9.store.set('k', { v: '第一版-小' });
  eq(P9.store.placement('k'), 'small', '先正常写一条小记录（索引记 small）');

  // 制造"索引过期"：同步后端从此写不动任何东西（连索引也写不动），
  // 但 removeItem 仍然可用（真实浏览器配额满时就是这个状态）。
  const staleBoom = new Error('quota exceeded'); staleBoom.name = 'QuotaExceededError';
  P9.small.setItem = function () { throw staleBoom; };
  const wStale = await P9.store.set('k', { pad: '新版本-大'.repeat(1000) });
  eq(wStale.where, 'large', '再写一条大记录 → 走异步后端');
  eq(wStale.indexPersisted, false, '  索引没能更新（仍记着 small）');
  eq(P9.store.placement('k'), 'small', '  落点索引确实是过期的（指向 small）');
  eq(P9.small._has('stale::k'), false, '  同步侧的老副本已被清掉');
  eq(P9.large._has('stale::k'), true, '  异步侧是新数据');

  const gotStale = await P9.store.get('k');
  ok(gotStale !== null, '索引过期时 get 仍能读到数据（不许返回 null）', gotStale);
  eq(gotStale.pad, '新版本-大'.repeat(1000), '  读到的正是异步侧那份新数据');
  eq(gotStale.v, undefined, '  不是那份旧的同步侧数据');

  head('②-F 异步后端里的 falsy 值也要原样读回（0 / false / 空串）');

  const P10 = pair({ threshold: 0, namespace: 'falsy' });   // 阈值 0 → 任何记录都走异步
  for (const c of [['f0', 0], ['fFalse', false], ['fEmpty', ''], ['fNull', null]]) {
    const w = await P10.store.set(c[0], c[1]);
    eq(w.where, 'large', '阈值 0：' + JSON.stringify(c[1]) + ' 也走异步后端');
    eq(await P10.store.get(c[0]), c[1], '  ' + JSON.stringify(c[1]) + ' 原样读回（不被真值判断吃掉）');
  }

  /* ============================================================
   * ③ keys() 跨后端汇总 + 删除同时清理两侧
   * ============================================================ */
  head('③-A keys() 汇总两个后端，且隔离命名空间');

  const P6 = pair({ threshold: 100, namespace: 'mix' });
  await P6.store.set('m1', { v: 1 });                     // 小 → 同步
  await P6.store.set('m2', { v: 2 });                     // 小 → 同步
  await P6.store.set('m3', { pad: 'x'.repeat(300) });      // 大 → 异步
  await P6.store.set('m4', { pad: 'y'.repeat(300) });      // 大 → 异步
  eq(P6.store.placement('m1'), 'small', '核对落点：m1 在同步侧');
  eq(P6.store.placement('m3'), 'large', '核对落点：m3 在异步侧');
  eq(P6.small._size() >= 2, true, '同步侧确实有至少 2 条（含内部索引）', String(P6.small._size()));
  eq(P6.large._size(), 2, '异步侧确实有 2 条');

  const ks = (await P6.store.keys()).slice().sort();
  eq(ks, ['m1', 'm2', 'm3', 'm4'], 'keys() 跨两个后端汇总出全部 4 个键');
  eq(ks.indexOf('__index__'), -1, '  内部索引键 __index__ 不出现在 keys() 里（它不是业务数据）');

  const other = pair({ threshold: 100, namespace: 'other' });
  await other.store.set('mx', { v: 9 });
  eq((await P6.store.keys()).indexOf('mx'), -1, '别的命名空间的键不会串进来');
  eq((await other.store.keys()).slice().sort(), ['mx'], '  那边只看到自己的');

  head('③-B 删除必须**同时清理两侧**');

  // (1) 删一个落在异步后端的键
  await P6.store.del('m3');
  eq(await P6.store.get('m3'), null, '删异步侧的键：读不到');
  eq(P6.large._has('mix::m3'), false, '  异步后端里已清除');
  eq(P6.small._has('mix::m3'), false, '  同步后端里也没有残留');
  eq(P6.store.placement('m3'), null, '  落点索引条目也删了');
  eq((await P6.store.keys()).slice().sort(), ['m1', 'm2', 'm4'], '  keys() 随之更新');

  // (2) 删一个落在同步后端的键
  await P6.store.del('m1');
  eq(await P6.store.get('m1'), null, '删同步侧的键：读不到');
  eq(P6.small._has('mix::m1'), false, '  同步后端里已清除');
  eq(P6.large._has('mix::m1'), false, '  异步后端里也没有');
  eq(P6.store.placement('m1'), null, '  落点索引条目也删了');

  // (3) 两侧**同时存在**同一个键（模拟历史遗留/半途迁移）→ 删除必须两侧都清
  P6.small.setItem('mix::dup', JSON.stringify({ v: 'small-copy' }));
  await P6.large.set('mix::dup', { v: 'large-copy' });
  eq(P6.small._has('mix::dup') && P6.large._has('mix::dup'), true, '  构造出"两侧都有"的键');
  await P6.store.del('dup');
  eq(P6.small._has('mix::dup'), false, '删除后：同步侧清除');
  eq(P6.large._has('mix::dup'), false, '删除后：异步侧也清除');

  // (4) 删一个不存在的键：不抛异常
  let delErr = null;
  try { await P6.store.del('never-existed'); } catch (e) { delErr = e; }
  ok(!delErr, '删不存在的键不抛异常', delErr && delErr.message);
  eq(await P6.store.get('never-existed'), null, '  读它得到 null（而不是 undefined）');

  /* ============================================================
   * ④ 上层业务代码不感知后端差异
   * ============================================================ */
  head('④-A 同一套 API，两种落点行为一致（返回值不做任何包装）');

  const P7 = pair({ threshold: 100, namespace: 'api' });
  await P7.store.set('s', { v: 'small' });
  await P7.store.set('l', { pad: 'p'.repeat(300), v: 'large' });
  const gs = await P7.store.get('s'), gl = await P7.store.get('l');
  eq(gs.v, 'small', '同步侧：get 直接返回业务对象本身');
  eq(gl.v, 'large', '异步侧：get 也直接返回业务对象本身（没有 {where,value} 这类包装）');
  eq(Object.prototype.hasOwnProperty.call(gs, 'where'), false, '  返回值里没有额外字段');
  eq([typeof P7.store.get('s').then, typeof P7.store.set, typeof P7.store.del, typeof P7.store.keys],
     ['function', 'function', 'function', 'function'], 'get/set/del/keys 全是 Promise 形态（调用方写法一致）');
  eq(await P7.store.get('不存在'), null, '不存在的键统一返回 null');
  eq(P7.store.placement('不存在'), null, 'placement 对未知键返回 null');

  head('④-B usage() 把两个后端都算进去');

  const used = await P7.store.usage();
  const expectUsed = jsonBytes({ v: 'small' }) + jsonBytes({ pad: 'p'.repeat(300), v: 'large' });
  eq(used, expectUsed, 'usage() = 两个后端记录字节数之和', used + ' / ' + expectUsed);

  /* ============================================================
   * ⑤ 相邻锚：校对入库面板（review.js）在双后端之上必须照样工作
   * ============================================================ */
  head('⑤ 相邻锚：review.commit 的卷子会被路由到正确的后端，且能读回');

  const Review = require('../core/review.js');
  const Parser = require('../parser-core.js');
  const P8 = pair({ threshold: 500, namespace: 'panel' });   // 阈值故意调小，逼卷子走异步侧

  const parsed = Parser.parseText([
    '【单选】正常？', 'A. 甲', 'B. 乙', '答案：B',
    '【判断】判断？（　）', '答案：对',
    '【简答】简答？', '答案：甲甲；乙乙'
  ].join('\n'));
  const mkDraft = () => Review.createDraft(parsed, { now: '2026-09-16T18:00:00.000Z', title: '路由联调卷' }).draft;
  const c = await Review.commit(mkDraft(), P8.store, { now: '2026-09-16T18:00:00.000Z' });
  ok(c.ok, '在双后端 store 上入库成功', c.error || c.hint || '');
  eq(c.placement, 'large', '  卷子本体超阈值 → 落异步后端', c.placement);
  eq(P8.store.placement('exam::' + c.examId), 'large', '  落点索引记为 large');
  eq(P8.store.placement('index'), 'small', '  轻量索引是小记录 → 落同步后端');
  eq(P8.large._has('panel::exam::' + c.examId), true, '  卷子在异步侧');
  eq(P8.small._has('panel::index'), true, '  索引在同步侧');

  const snap = await Review.storeSnapshot(P8.store);
  eq(Object.keys(snap).slice().sort(), ['exam::' + c.examId, 'index'], 'storeSnapshot 跨两个后端都能读到');
  const rt = Review.jsonToExam(Review.examToJson(snap['exam::' + c.examId]));
  eq(rt.ok, true, '  从快照里取出的卷子能走 JSON 往返', rt.error || '');
  eq(rt.exam.questions.length, 3, '  题数正确');
  eq(rt.exam.id, c.examId, '  卷子 id 一致');

  const ksPanel = (await P8.store.keys()).slice().sort();
  eq(ksPanel, ['exam::' + c.examId, 'index'], 'keys() 把分散在两个后端的键都汇总出来');

  console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
  console.log('  PASS ' + pass + '    FAIL ' + fail);
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
