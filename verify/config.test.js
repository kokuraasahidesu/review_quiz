/* ============================================================
 *  verify/config.test.js —— 「三层取值与合并」小类验收
 *
 *  运行： node verify/config.test.js
 *
 *  三条盘档验收标准，逐条对应：
 *    ① 未锁定卷能继承全局的最新值；单卷未写的项取内置默认值（两项均有断言覆盖）
 *    ② 没有任何单卷设置时取值等于全局；没有任何全局设置时取值等于内置默认
 *    ③ 合并结果为深拷贝，修改返回值不会反向污染全局或内置默认
 *
 *  ⚠️ 这个文件的第一价值在于**验收③**：
 *     改造前实测 `resolveConfig(null,null).points['单选']=999` 会把 `DEFAULT_CONFIG`
 *     真的改成 999（浅拷贝导致嵌套对象共享引用），之后所有试卷的默认分值都跟着错。
 *     既有 verify.js 只测了优先级与锁定语义，**深拷贝这条从未被断言**，所以它一直活着。
 *     所以本文件会用"递归篡改整个返回值"的方式把这条钉死。
 * ============================================================ */
const Q = require('../core/quiz.js');
const S = require('../core/schema.js');
const E = require('../core/exams.js');
const D = require('../core/data.js');
const P = require('../parser-core.js');

let pass = 0, fail = 0; const failures = [];
function brief(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return String(s);
  return s.length > 150 ? s.slice(0, 150) + '…(' + s.length + ' 字符)' : s;
}
function ok(c, t, d) { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + brief(d) : '')))
                         : (fail++, failures.push(t), console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + brief(d) : ''))); }
function eq(a, e, t) { const A = JSON.stringify(a), B = JSON.stringify(e); ok(A === B, t + '   期望=' + brief(B), A); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }

/* 递归把所有叶子换成哨兵、给所有数组塞元素 —— 用来验"深拷贝" */
function mutateEverything(v, sentinel, seen) {
  seen = seen || new Set();
  if (!v || typeof v !== 'object') return;
  if (seen.has(v)) return;
  seen.add(v);
  if (Array.isArray(v)) { v.push(sentinel); v.forEach(function (x) { mutateEverything(x, sentinel, seen); }); return; }
  Object.keys(v).forEach(function (k) {
    if (v[k] && typeof v[k] === 'object') mutateEverything(v[k], sentinel, seen);
    else v[k] = sentinel;
  });
}

/* 来源标注自洽性检查：标注说来自哪层，值就必须真的等于那层的值 */
function sourceMismatches(globalCfg, exam) {
  const map = Q.configSources(globalCfg, exam);
  const resolved = Q.resolveConfig(globalCfg, exam);
  const own = (exam && exam.config) || null;
  const at = function (o, path) { return path.split('.').reduce(function (a, k) { return (a == null) ? undefined : a[k]; }, o); };
  const bad = [];
  Object.keys(map).forEach(function (p) {
    const layer = map[p];
    const src = layer === 'builtin' ? DEFAULT : (layer === 'global' ? globalCfg : own);
    const got = at(resolved, p), want = at(src, p);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      bad.push(p + ' 标注=' + layer + ' 实得=' + JSON.stringify(got) + ' 该层=' + JSON.stringify(want));
    }
  });
  return { map: map, resolved: resolved, bad: bad };
}

const DEFAULT = Q.DEFAULT_CONFIG;

(async function main() {

  /* ============================================================
   * ①-A 未锁定卷继承全局的**最新值**
   * ============================================================ */
  head('①-A 未锁定卷：改了全局，它跟着变（这就是"继承最新值"）');

  const examUnlocked = { id: 'E1', config: { multi: { halfCredit: false } }, configLocked: false };
  const g1 = { points: { '单选': 5 }, pick: { count: 30 } };
  const r1 = Q.resolveConfig(g1, examUnlocked);
  eq(r1.points['单选'], 5, '全局写了 points.单选=5 → 取值 5');
  eq(r1.pick.count, 30, '全局写了 pick.count=30 → 取值 30');
  eq(r1.multi.halfCredit, false, '单卷写了 multi.halfCredit=false → 取值 false（单卷优先）');
  eq(r1.multi.halfMode, 'fixedScore', '全局没写 multi.halfMode → 落回内置默认 fixedScore（半对固定给分）');
eq(r1.multi.halfScore, 2, '  落回默认 2 分（用户要求："多选规则应该半对给两分"）');
  eq(r1.multi.halfRatio, 0.5, '  落回默认 0.5');

  const g2 = { points: { '单选': 9 }, pick: { count: 50 } };
  const r2 = Q.resolveConfig(g2, examUnlocked);
  eq(r2.points['单选'], 9, '**把全局改成 9 之后，同一份未锁定卷取值变成 9**（继承最新值）');
  eq(r2.pick.count, 50, '  pick.count 也跟着全局变成 50');
  eq(r2.multi.halfCredit, false, '  单卷自己写的那项仍由单卷说了算（不受全局变化影响）');
  ok(r1.points['单选'] !== r2.points['单选'], '  旧解析结果不受影响（不是同一个对象）',
     r1.points['单选'] + ' → ' + r2.points['单选']);

  head('①-B 单卷未写的项落回**内置默认值**');

  // 全局只写了一项；单卷也只写了一项 → 其余全部应等于内置默认
  const g3 = { points: { '单选': 7 } };
  const exam3 = { config: { multi: { halfCredit: false } }, configLocked: false };
  const r3 = Q.resolveConfig(g3, exam3);
  eq(r3.points['多选'], DEFAULT.points['多选'], 'points.多选 落回默认 3（全局与单卷都没写）');
  eq(r3.points['判断'], DEFAULT.points['判断'], 'points.判断 落回默认 1');
  eq(r3.points['简答'], DEFAULT.points['简答'], 'points.简答 落回默认 5');
  eq(r3.pick.count, DEFAULT.pick.count, 'pick.count 落回默认 20');
  eq(r3.pick.mode, DEFAULT.pick.mode, 'pick.mode 落回默认 byCount');
  eq(r3.pick.byType, DEFAULT.pick.byType, 'pick.byType 落回默认整表');
  eq(r3.grade, DEFAULT.grade, 'grade 整块落回默认');
  eq(r3.reveal, DEFAULT.reveal, 'reveal 整块落回默认');
  eq(r3.behavior, DEFAULT.behavior, 'behavior 整块落回默认');
  eq(r3.short, DEFAULT.short, 'short 整块落回默认（简答那组没被任何层碰过）');
  eq(r3.points['单选'], 7, '对照：全局写了的项来自全局（不是默认 2）');

  head('①-C 已锁定卷：全局再变也不影响它，且缺项落回**内置默认**（不读全局）');

  const gLockBase = { points: { '单选': 5, '多选': 6 }, pick: { count: 30 } };
  const locked = Q.lockConfig(gLockBase, { id: 'E2', config: { multi: { halfCredit: false } } });
  eq(locked.configLocked, true, 'lockConfig 标记为已锁定');
  eq(locked.config.points['单选'], 5, '  快照里包含了锁定那一刻的全局值 5（完整快照）');
  eq(locked.config.pick.count, 30, '  也包含当时的 pick.count=30');

  const gAfter = { points: { '单选': 999, '多选': 999, '判断': 999 }, pick: { count: 999 } };
  const rLocked = Q.resolveConfig(gAfter, locked);
  eq(rLocked.points['单选'], 5, '**锁定后改全局 → 取值仍是快照里的 5**（全局影响不到它）');
  eq(rLocked.pick.count, 30, '  pick.count 同样是快照里的 30');
  eq(JSON.stringify(rLocked), JSON.stringify(Q.resolveConfig(gLockBase, locked)),
     '  锁定卷的取值与全局无关（换一份全局，结果逐字节相同）');

  // 锁定 + 部分覆盖：缺项落回内置默认，而**不是**去读全局
  const lockedPartial = { config: { multi: { halfCredit: false } }, configLocked: true };
  const rLP = Q.resolveConfig(gAfter, lockedPartial);
  eq(rLP.points['单选'], DEFAULT.points['单选'],
     '锁定卷没写的项落回**内置默认 2**（而不是全局的 999）——锁定即与全局脱钩');
  eq(rLP.pick.count, DEFAULT.pick.count, '  pick.count 也落回默认 20');

  /* ============================================================
   * ② 两个极端：整对象深比较
   * ============================================================ */
  head('②-A 没有任何单卷设置 → 取值等于"全局生效值"');

  const gOnly = { points: { '单选': 4 }, pick: { seed: 42 } };
  const expected = Q.mergeConfig(gOnly);
  eq(Q.resolveConfig(gOnly, null), expected, 'exam=null → 等于 mergeConfig(全局)');
  eq(Q.resolveConfig(gOnly, {}), expected, 'exam={} → 同上');
  eq(Q.resolveConfig(gOnly, { config: null }), expected, 'exam.config=null → 同上');
  eq(Q.resolveConfig(gOnly, { config: undefined }), expected, 'exam.config=undefined → 同上');
  eq(Q.resolveConfig(gOnly, { id: 'E' }), expected, '  只有 id 的卷 → 同上');
  ok(JSON.stringify(Q.resolveConfig(gOnly, null)) !== JSON.stringify(DEFAULT),
     '  对照：全局改过之后，它确实**不等于**内置默认（不是恒等于默认的假实现）');

  head('②-B 没有任何全局设置 → 取值等于内置默认');

  eq(Q.resolveConfig(null, null), DEFAULT, 'global=null, exam=null → 整对象等于 DEFAULT_CONFIG');
  eq(Q.resolveConfig(undefined, undefined), DEFAULT, 'undefined 同理');
  eq(Q.resolveConfig({}, {}), DEFAULT, '空对象层同理');
  eq(Q.resolveConfig(null, { config: null }), DEFAULT, '  空配置卷同理');
  eq(Q.resolveConfig({}, { config: {} }), DEFAULT, 'exam.config={} 也等于默认（空对象不改变任何项）');
  eq(Object.keys(Q.resolveConfig(null, null)).sort(), Object.keys(DEFAULT).sort(),
     '  键集合与默认一致（没多没少）');

  /* ============================================================
   * ③ 深拷贝：递归篡改返回值，不许污染任何输入
   * ============================================================ */
  head('③-A 递归篡改合并结果 → 内置默认与全局必须逐字节不变');

  const gDeep = { points: { '单选': 5 }, nested: { deep: [1, 2, { x: 'y' }] }, list: [{ a: 1 }, { b: 2 }] };
  const examDeep = { config: { multi: { halfCredit: false }, more: [{ c: 3 }] }, configLocked: false };

  const defBefore = JSON.stringify(DEFAULT);
  const gBefore = JSON.stringify(gDeep);
  const examBefore = JSON.stringify(examDeep);

  const result = Q.resolveConfig(gDeep, examDeep);
  mutateEverything(result, '__哨兵__');

  eq(JSON.stringify(DEFAULT), defBefore, '**内置默认逐字节未变**（哪怕把所有叶子都改了）');
  eq(JSON.stringify(gDeep), gBefore, '  **全局输入逐字节未变**');
  eq(JSON.stringify(examDeep), examBefore, '  **单卷输入逐字节未变**');

  // 再解析一次：结果必须还是正确的值（说明上一轮篡改没有留下任何后遗症）
  const again = Q.resolveConfig(gDeep, examDeep);
  eq(again.points['单选'], 5, '  重新解析仍得到正确的 5（默认没被改成哨兵）');
  eq(again.multi.halfCredit, false, '  单卷覆盖仍在');
  eq(again.nested.deep[2].x, 'y', '  深层嵌套值仍在');

  head('③-B 引用独立性：结果与任何输入都不共享嵌套对象/数组元素');

  const gRef = { arr: [{ a: 1 }], obj: { k: 'v' } };
  const rRef = Q.resolveConfig(gRef, null);
  ok(rRef.arr !== gRef.arr, '数组本身不是同一个对象');
  ok(rRef.arr[0] !== gRef.arr[0], '**数组元素也不是同一个对象**（旧实现这里就是共享的）');
  ok(rRef.obj !== gRef.obj, '嵌套对象不是同一个对象');
  rRef.arr[0].a = 42; rRef.obj.k = '改了'; rRef.points['单选'] = 77;
  eq(gRef.arr[0].a, 1, '  改结果数组元素 → 全局的没变');
  eq(gRef.obj.k, 'v', '  改结果嵌套对象 → 全局的没变');
  eq(DEFAULT.points['单选'], 2, '  改结果 → 内置默认的没变');

  head('③-C 反向对照：默认值被直接改动时，必须能被观测到（证明上面不是空转）');

  const originalSingle = DEFAULT.points['单选'];
  DEFAULT.points['单选'] = 12345;
  eq(Q.resolveConfig(null, null).points['单选'], 12345,
     '直接改 DEFAULT_CONFIG 后，解析结果确实跟着变 → 说明"未变"是真观察到的');
  DEFAULT.points['单选'] = originalSingle;
  eq(Q.resolveConfig(null, null).points['单选'], 2, '  已恢复原值');
  eq(JSON.stringify(DEFAULT), defBefore, '  恢复后与基线逐字节一致');

  head('③-D 三个公开工具同样必须返回独立副本');

  const src = { a: { b: [1, { c: 2 }] } };
  const srcBefore = JSON.stringify(src);
  const d1 = Q.deepClone(src);   mutateEverything(d1, 'X');
  eq(JSON.stringify(src), srcBefore, 'deepClone 的结果被篡改后，源对象未变');
  const d2 = Q.mergeConfig(src);  mutateEverything(d2, 'X');
  eq(JSON.stringify(src), srcBefore, 'mergeConfig 的结果被篡改后，源对象未变');
  eq(JSON.stringify(DEFAULT), defBefore, '  mergeConfig 也没有污染内置默认');
  const d3 = Q.snapshotConfig(Q.resolveConfig(src, null)); mutateEverything(d3, 'X');
  eq(JSON.stringify(src), srcBefore, 'snapshotConfig 的结果被篡改后，源对象未变');
  eq(JSON.stringify(DEFAULT), defBefore, '  快照也没有污染内置默认');
  ok(Q.deepClone(src) !== src && Q.deepClone(src).a !== src.a, 'deepClone 逐层新建');

  /* ============================================================
   * 可预测性 / 来源标注
   * ============================================================ */
  head('④-A 同一输入重复解析：逐字节相同（可预测、可断言）');

  const gP = { points: { '单选': 5 }, pick: { byType: { '单选': 1 } } };
  const examP = { config: { multi: { halfCredit: false } }, configLocked: false };
  const a1 = JSON.stringify(Q.resolveConfig(gP, examP));
  const a2 = JSON.stringify(Q.resolveConfig(gP, examP));
  eq(a1, a2, '连解析两次结果逐字节相同（键序也稳定）');
  eq(Object.keys(Q.resolveConfig(gP, examP)), Object.keys(DEFAULT),
     '  顶层键序与内置默认一致（顺序稳定，便于比对）');

  head('④-B 来源标注 configSources：逐路径自洽');

  const srcMap = Q.configSources(gP, examP);
  eq(srcMap['points.单选'], 'global', 'points.单选 标为来自 global');
  eq(srcMap['multi.halfCredit'], 'exam', 'multi.halfCredit 标为来自 exam');
  eq(srcMap['pick.count'], 'builtin', 'pick.count 标为来自 builtin');
  eq(srcMap['grade.pass'], 'builtin', 'grade.pass 标为 builtin');
  eq(srcMap['short.matchMode'], 'builtin', 'short.matchMode 标为 builtin');

  // 自洽性：标注说来自哪层，值就必须真的等于那层的值
  const con = sourceMismatches(gP, examP);
  eq(con.bad, [], '**每一条来源标注都与实际取值自洽**（共 ' + Object.keys(con.map).length + ' 条路径）');

  // 锁定卷（lockConfig 产出的**完整快照**）：来源应当**全是 exam**
  // —— 因为快照把当时所有生效值都固化了，没有任何一项还"继承"自别处。
  const lockedMap = Q.configSources(gAfter, locked);
  const layers = Object.keys(lockedMap).reduce(function (s, k) { s[lockedMap[k]] = 1; return s; }, {});
  eq(Object.keys(layers).sort(), ['exam'],
     '完整快照的来源**只有 exam**（快照把当时所有值都固化了）');
  eq(lockedMap['points.单选'], 'exam', '  快照里的项标为 exam');
  eq(lockedMap['grade.pass'], 'exam', '  连没被任何人改过的 grade.pass 也在快照里 → 标 exam');
  eq(Object.keys(lockedMap).length > 20, true, '  覆盖面：' + Object.keys(lockedMap).length + ' 条路径');

  // 手工写的**不完整**锁定配置：那才是"缺项落回内置默认、且不读全局"的锐利判据
  const partialMap = Q.configSources(gAfter, lockedPartial);
  const pLayers = Object.keys(partialMap).reduce(function (s, k) { s[partialMap[k]] = 1; return s; }, {});
  eq(Object.keys(pLayers).sort(), ['builtin', 'exam'],
     '不完整锁定配置的来源只有 builtin/exam（**没有 global**）——锁定即与全局脱钩');
  eq(partialMap['points.单选'], 'builtin',
     '  全局里明明有 999，但锁定卷没写它 → 标 builtin（落回默认，不读全局）');
  eq(partialMap['multi.halfCredit'], 'exam', '  自己写了的那项标 exam');
  eq(partialMap['grade.pass'], 'builtin', '  没写过的项标 builtin');

  /* ============================================================
   * ⑤ 相邻锚
   * ============================================================ */
  head('⑤-A 相邻锚 → schema：合并结果能作为整卷配置通过校验');

  const examForSchema = S.createExam({ title: '锚', questions: [], config: Q.resolveConfig(gP, examP), configLocked: false });
  eq(S.validateExam({ schemaVersion: 1, id: 'x', title: 't', createdAt: 'a', updatedAt: 'b', config: examForSchema.config, configLocked: false, questions: [] }).ok,
     true, 'resolveConfig 的结果能通过 validateExam（结构上是合法 config）');
  eq(Q.resolveConfig(null, { config: {} }), DEFAULT, '  空 config 不改变取值（与 schema 的"对象或 null"约定一致）');

  head('⑤-B 相邻锚 → exams：卷册操作不得偷偷改动配置');

  const W = (function () {
    const sm = new Map(), lg = new Map();
    const small = {
      getItem: k => (sm.has(k) ? sm.get(k) : null), setItem: (k, v) => { sm.set(String(k), String(v)); },
      removeItem: k => { sm.delete(k); }, key: i => { const a = Array.from(sm.keys()); return i < a.length ? a[i] : null; },
      get length() { return sm.size; }
    };
    const large = { get: async () => null, set: async () => {}, del: async () => {}, keys: async () => [] };
    return D.createStore({ small: small, large: large, namespace: D.NS_GLOBAL, threshold: 4096 });
  })();

  const cfgSnap = Q.resolveConfig({ points: { '单选': 6 } }, { config: { multi: { halfCredit: false } } });
  const created = await E.createExam(W, { title: '带配置的卷', now: '2026-09-18T00:00:00.000Z' });
  const withCfg = await E.appendQuestions(W, created.exam.id, P.parseText('【判断】x？（　）\n答案：对').questions);
  ok(withCfg.ok, '卷册追加题目成功');
  const renamed = await E.renameExam(W, created.exam.id, '改名后');
  eq(renamed.exam.config, null, '卷册操作没有凭空塞进配置（原样 null）');

  const examWithCfg = await E.createExam(W, { title: '配置卷', now: '2026-09-18T00:01:00.000Z' });
  const stored = S.createExam({ id: examWithCfg.exam.id, title: '配置卷', questions: [], config: cfgSnap }, { now: '2026-09-18T00:01:00.000Z' });
  const cfgBefore2 = JSON.stringify(stored.config);
  await W.set(D.examBodyKey(stored.id), stored);
  const renamd2 = await E.renameExam(W, stored.id, '又改名');
  eq(JSON.stringify(renamd2.exam.config), cfgBefore2, '重命名后配置逐字节未变');
  const listed = await E.listExams(W);
  ok(listed.exams.some(x => x.id === stored.id), '  卷册仍列得出它');
  eq(JSON.stringify((await E.getExam(W, stored.id)).exam.config), cfgBefore2, '  重新读出来的配置也逐字节未变');

  /* ============================================================
   * ⑥ 挑刺：边界形状（整体替换 / null / undefined / 数组）
   * ============================================================ */
  head('⑥-A 上层用**非对象**整体覆盖配置块：值替换了，标注也必须跟着对');

  const gBlock = { points: 5 };
  const rBlock = Q.resolveConfig(gBlock, null);
  eq(rBlock.points, 5, '整体替换生效：points 变成 5（合并规则：非对象 → 整体覆盖）');
  const cBlock = sourceMismatches(gBlock, null);
  eq(cBlock.map['points'], 'global', '来源标注 points = global（**整体替换的那一项自己算叶子**）');
  eq(cBlock.map['points.单选'], undefined,
     '  不再凭空产出 points.单选（旧实现会把它错标成 builtin，等于工具说谎）');
  eq(cBlock.bad, [], '  自洽性仍然成立（共 ' + Object.keys(cBlock.map).length + ' 条路径）');

  const gArr = { short: { synonyms: ['a', 'b'] } };
  const cArr = sourceMismatches(gArr, null);
  eq(Q.resolveConfig(gArr, null).short.synonyms, ['a', 'b'], '数组同样整体替换');
  eq(Q.resolveConfig(gArr, null).short.matchMode, 'contains', '  同层没被写的键仍是内置默认');
  eq(cArr.map['short.synonyms'], 'global', '  数组项的标注 = global');
  eq(cArr.map['short.matchMode'], 'builtin', '  同层未写项的标注 = builtin');
  eq(cArr.bad, [], '  自洽性成立');

  head('⑥-B 上层给 null：**不许抹掉配置块**（抹了会让下游崩）');

  const rNull = Q.resolveConfig({ points: null }, null);
  eq(rNull.points, DEFAULT.points, 'points:null 被当作"没写" → 整块仍是内置默认');
  eq(rNull.points['单选'], 2, '  取得到 points.单选 = 2（旧实现这里是 null，下一步就 TypeError）');

  // 实测过的崩溃点：旧实现下 cfg.points === null → scoreOne 读 cfg.points[q.type] 直接抛
  let scoreRes = null, scoreErr = null;
  try { scoreRes = Q.scoreOne({ type: '单选', answerLetters: ['A'], options: [] }, 'A', rNull); }
  catch (e) { scoreErr = e; }
  ok(!scoreErr, '**scoreOne 不崩**（旧实现下这里 TypeError）', scoreErr ? String(scoreErr.message) : '');
  eq(scoreRes && scoreRes.score, 2, '  而且判分正确（单选题 2 分）');

  const allNull = { points: null, multi: null, short: null, pick: null, grade: null, reveal: null, behavior: null };
  eq(Q.resolveConfig(allNull, null), DEFAULT, '整份都是 null → 等于内置默认（null 一律视为没写）');
  eq(Q.resolveConfig({ points: { '单选': null } }, null).points['单选'], 2, '嵌套层级的 null 同样视为没写');
  eq(Q.resolveConfig(null, { config: { points: null } }).points, DEFAULT.points, '单卷层给 null 也一样跳过');

  const cNull = sourceMismatches({ points: null }, null);
  eq(cNull.map['points.单选'], 'builtin', '  标注与合并规则一致：null 视为没写 → builtin');
  eq(cNull.bad, [], '  自洽性成立');

  head('⑥-C undefined 与"整块对象覆盖"的既有语义没被改坏');

  const rUndef = Q.resolveConfig({ points: { '单选': undefined, '多选': 7 } }, null);
  eq(rUndef.points['单选'], 2, 'undefined 视为没写 → 落回默认 2');
  eq(rUndef.points['多选'], 7, '  同一层正常写的 7 仍然生效');
  const rObj = Q.resolveConfig({ points: { '单选': 5 } }, { config: { points: { '多选': 9 } } });
  eq(rObj.points, { '单选': 5, '多选': 9, '判断': 1, '简答': 5 },
     '三层对象逐键合并：默认打底 + 全局单选 5 + 单卷多选 9，其余回默认');

  head('⑥-D 锁定但**没有** config 的卷：值与标注都必须与 resolveConfig 的分支对齐');

  const gL = { points: { '单选': 9 }, pick: { count: 44 } };
  const lockedNoCfg = { configLocked: true, config: null };
  const rLang = Q.resolveConfig(gL, lockedNoCfg);
  eq(rLang.points['单选'], 9, '锁定但没快照 → 没有"自己的配置"可锁，只能按未锁定处理（读到全局 9）');
  eq(rLang.pick.count, 44, '  pick.count 同样来自全局');
  const cLockedNoCfg = sourceMismatches(gL, lockedNoCfg);
  eq(cLockedNoCfg.map['points.单选'], 'global',
     '  标注也必须是 global（旧实现错标成 builtin，与 resolveConfig 的分支不一致）');
  eq(cLockedNoCfg.bad, [], '  **自洽性成立**（这条不变式抓出了上面那个不一致）');

  // 对照：有快照时全局被忽略，标注里不该出现 global
  const cLockedYes = sourceMismatches(gL, locked);
  eq(Object.keys(cLockedYes.map).reduce(function (s, k) { s[cLockedYes.map[k]] = 1; return s; }, {}),
     { exam: 1 }, '有快照时来源只有 exam（全局被忽略）');
  eq(cLockedYes.bad, [], '  自洽性同样成立');

  console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
  console.log('  PASS ' + pass + '    FAIL ' + fail);
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
