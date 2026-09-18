/* ============================================================
 *  core/exams.js —— 卷册维护 · 题型分组 · 批量上传
 *
 *  职责：
 *    · 试卷的新建 / 重命名 / 删除 / 查看（每卷独立标题与唯一 id，改完立刻持久）
 *    · 按四类题型分组（题目 + 数量），供面板做分组视图
 *    · 单文件与多文件批量上传 —— 归入指定试卷、按题型自动分组；
 *      也支持"手动指定题型"（文件里没有标记或标记写错时）
 *
 *  依赖：core/schema.js（结构工厂）、core/data.js（键前缀 + 落点路由）、
 *        parser-core（解析）、core/parse/segment.js（派生字段重算）
 *  加载顺序：… → parser-core.js → schema.js → exams.js
 *
 *  落盘结构（沿用「命名空间隔离」小类冻结的前缀规则，不新造一套）：
 *    exam::<id>            卷本体（完整 Exam，含 questions）
 *    exam::<id>::meta      轻量索引：标题 / 总数 / 各题型计数 / 时间
 *                          列卷册时只读它，不必把所有大卷子都拉进内存
 *    index                 全局：{ examIds:[...], updatedAt }
 * ============================================================ */
(function (root, factory) {
  const isNode = (typeof module !== 'undefined' && module.exports);
  const SchemaCore  = isNode ? require('./schema.js')             : root.SchemaCore;
  const DataCore    = isNode ? require('./data.js')               : root.DataCore;
  const QuizCore    = isNode ? require('./quiz.js')               : root.QuizCore;
  const QuizParser  = isNode ? require('../parser-core.js')       : root.QuizParser;
  const SegmentCore = isNode ? require('./parse/segment.js')      : root.SegmentCore;
  const api = factory(SchemaCore, DataCore, QuizCore, QuizParser, SegmentCore);
  if (isNode) module.exports = api;
  root.ExamsCore = api;
})(typeof self !== 'undefined' ? self : this, function (SchemaCore, DataCore, QuizCore, QuizParser, SegmentCore) {
  'use strict';

  const miss = [];
  if (!SchemaCore) miss.push('core/schema.js');
  if (!DataCore) miss.push('core/data.js');
  if (!QuizCore) miss.push('core/quiz.js');
  if (!QuizParser) miss.push('parser-core.js');
  if (!SegmentCore) miss.push('core/parse/segment.js');
  if (miss.length) {
    throw new Error('exams-core 依赖缺失：请先加载 ' + miss.join('、') + '（顺序不可颠倒）');
  }

  const GROUP_TYPES = SchemaCore.TYPES.slice();     // ['单选','多选','判断','简答']

  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function fail(error, extra) { return Object.assign({ ok: false, error: error }, extra || {}); }
  function nowIso(o) { return (o && o.now) || new Date().toISOString(); }

  /* ================= 题型分组 ================= */

  function emptyGroups() {
    const g = {};
    GROUP_TYPES.forEach(function (t) { g[t] = []; });
    return g;
  }

  /* 按四类题型分组（保持卷内原顺序；每题带上它在卷内的下标） */
  function groupQuestions(questions) {
    const g = emptyGroups();
    (questions || []).forEach(function (q, i) {
      const t = (GROUP_TYPES.indexOf(q.type) >= 0) ? q.type : null;
      if (!t) return;                                  // 题型非法的题不进任何分组（也不会被静默当成别的类）
      g[t].push({ index: i, question: q });
    });
    return g;
  }

  /* 各题型数量 + 总数，供"分组计数"直接显示 */
  function groupCounts(questions) {
    const counts = {};
    GROUP_TYPES.forEach(function (t) { counts[t] = 0; });
    let total = 0, invalid = 0;
    (questions || []).forEach(function (q) {
      total++;
      if (GROUP_TYPES.indexOf(q.type) >= 0) counts[q.type]++;
      else invalid++;
    });
    counts.total = total;
    counts.invalid = invalid;
    return counts;
  }

  /* ================= 卷册基本操作 ================= */

  function metaOf(exam) {
    const counts = groupCounts(exam.questions);
    let review = 0;
    (exam.questions || []).forEach(function (q) {
      if (SegmentCore.reviewFlags(q).length) review++;
    });
    return {
      id: exam.id, title: exam.title,
      total: counts.total, counts: counts,
      needsReview: review,
      configLocked: !!exam.configLocked,
      createdAt: exam.createdAt, updatedAt: exam.updatedAt
    };
  }

  async function readIndex(store) {
    let idx = null;
    try { idx = await store.get('index'); } catch (e) { idx = null; }
    if (!idx || typeof idx !== 'object' || !Array.isArray(idx.examIds)) {
      idx = { examIds: [], updatedAt: null };
    }
    return idx;
  }

  /* 一次写入：卷本体 + 轻量 meta + 全局索引 */
  async function writeExam(store, exam) {
    const meta = metaOf(exam);
    const w1 = await store.set(DataCore.examBodyKey(exam.id), exam);
    const w2 = await store.set(DataCore.examSubKey(exam.id, 'meta'), meta);
    const idx = await readIndex(store);
    if (idx.examIds.indexOf(exam.id) < 0) idx.examIds.push(exam.id);
    idx.updatedAt = exam.updatedAt;
    await store.set('index', idx);
    return { meta: meta, placement: w1 && w1.where, metaPlacement: w2 && w2.where };
  }

  /*
   * 新建试卷。id 默认由结构工厂生成，并在这里**确保唯一**。
   * 若调用方显式指定了 id 且已被占用 → 明确报错，
   * 不能"悄悄换一个 id"（调用方拿着自己给的 id 去查会查不到，属于最难查的那类 bug）。
   */
  async function createExam(store, opts) {
    const o = opts || {};
    if (!store || typeof store.set !== 'function') return fail('没有可用的存储');
    const title = String(o.title == null ? '' : o.title).trim() || '未命名试卷';
    const now = nowIso(o);

    let exam = null;
    if (o.id != null && o.id !== '') {
      const exists = await store.get(DataCore.examBodyKey(o.id));
      if (exists != null) return fail('这份试卷 id 已存在：' + o.id + '（要么换个 id，要么直接打开它）');
      exam = SchemaCore.createExam({ id: o.id, title: title, questions: [] }, { now: now, rng: o.rng });
    } else {
      for (let attempt = 0; attempt < 8; attempt++) {
        const cand = SchemaCore.createExam({ title: title, questions: [] }, { now: now, rng: o.rng });
        const exists = await store.get(DataCore.examBodyKey(cand.id));
        if (exists == null) { exam = cand; break; }
      }
      if (!exam) return fail('连续生成 id 都撞车了，请检查随机源');
    }

    const w = await writeExam(store, exam);
    return { ok: true, exam: exam, meta: w.meta };
  }

  /*
   * 重算并写回某卷的轻量 meta。
   * 给"直接写卷本体、绕过卷册模块"的调用方用的（例如校对面板入库）——
   * 那种写法会让 meta 过期。listExams 只在 meta **缺失**时自愈，
   * 不会为"meta 过期"再读一次本体（那会让列卷册退化成全量加载）。
   */
  async function refreshMeta(store, id, opts) {
    const got = await getExam(store, id);
    if (!got.ok) return fail(got.error);
    const o = opts || {};
    if (o.now) { got.exam.updatedAt = o.now; await store.set(DataCore.examBodyKey(id), got.exam); }
    const meta = metaOf(got.exam);
    await store.set(DataCore.examSubKey(id, 'meta'), meta);
    return { ok: true, meta: meta };
  }

  /* 查看单卷 */
  async function getExam(store, id) {
    if (!store) return fail('没有可用的存储');
    const exam = await store.get(DataCore.examBodyKey(id));
    if (exam == null) return fail('找不到这份试卷：' + id);
    return { ok: true, exam: exam, meta: metaOf(exam) };
  }

  /* 重命名：标题在**卷本体与轻量 meta 两处**都要改，否则列卷册时会看到旧标题 */
  async function renameExam(store, id, title, opts) {
    const o = opts || {};
    const got = await getExam(store, id);
    if (!got.ok) return fail(got.error);
    const exam = got.exam;
    const next = String(title == null ? '' : title).trim();
    if (!next) return fail('标题不能为空');
    if (next === exam.title) return { ok: true, exam: exam, meta: metaOf(exam), changed: false };
    exam.title = next;
    exam.updatedAt = nowIso(o);
    const w = await writeExam(store, exam);
    return { ok: true, exam: exam, meta: w.meta, changed: true };
  }

  /*
   * 写入某卷的配置与锁定标记。
   * 这是**唯一**会改 `exam.config` / `exam.configLocked` 的入口 ——
   * 集中在一处，才能保证"存进去的一定是深拷贝、一定过整卷校验"。
   */
  async function setConfig(store, examId, patch, opts) {
    const o = opts || {};
    const p = patch || {};
    const got = await getExam(store, examId);
    if (!got.ok) return fail(got.error);
    const exam = got.exam;

    if ('config' in p) {
      const c = p.config;
      if (c !== null && (typeof c !== 'object' || Array.isArray(c))) {
        return fail('config 必须是对象或 null，收到：' + (Array.isArray(c) ? 'array' : typeof c));
      }
      // 深拷贝后再存：不让试卷与调用方共享同一个 config 对象
      // （否则调用方之后改自己那份，会悄悄改掉已入库的试卷）
      exam.config = (c === null) ? null : QuizCore.snapshotConfig(c);
    }
    if ('configLocked' in p) exam.configLocked = !!p.configLocked;

    // 拒绝"锁定但没有快照"的矛盾状态。
    // 为什么必须拦：这种卷 configLocked=true 却 config=null，resolveConfig 会退化成
    // "按未锁定处理"→ 照样读全局。用户以为锁住了，其实全局一改它就跟着变 ——
    // 与"锁定后全局不得影响该卷"直接冲突，而且**完全静默**。
    if (exam.configLocked && !exam.config) {
      return fail('已锁定但没有配置快照：这种状态会静默地继续读全局，等于没锁',
                  { hint: '请用 lockExam()（它会生成完整快照），或同时传入 config' });
    }

    exam.updatedAt = nowIso(o);
    const ve = SchemaCore.validateExam(exam);
    if (!ve.ok) return fail('写入配置后整卷校验未通过，未写入', { errors: ve.errors });
    const w = await writeExam(store, exam);
    return { ok: true, exam: exam, meta: w.meta };
  }

  /*
   * 锁定单卷：把"此刻生效的完整配置"固化成快照**写进试卷**。
   * 快照由 QuizCore.lockConfig 生成：默认打底 + 全局覆盖 + 单卷覆盖 → 一份无空洞的完整配置。
   */
  async function lockExam(store, examId, opts) {
    const o = opts || {};
    const got = await getExam(store, examId);
    if (!got.ok) return fail(got.error);
    const locked = QuizCore.lockConfig(o.globalCfg || null, got.exam);
    const r = await setConfig(store, examId, { config: locked.config, configLocked: true }, o);
    if (!r.ok) return r;
    return { ok: true, exam: r.exam, meta: r.meta, snapshotLeaves: countLeaves(r.exam.config) };
  }

  /*
   * 解锁：丢掉快照、回到"继承全局"的取值路径。
   *   · 已锁定 → 清空 config + 复位标记；被丢掉的那份快照**回传**给调用方留档
   *     （不写进试卷 —— Exam 结构是冻结的，没有地方放它）
   *   · **本来就没锁定 → 无操作**：不能顺手把它的"部分单卷配置"清掉。
   *     早先的实现在这里会把配置清成 null 且 discarded 报 null ——
   *     既丢了数据、又没告知，属于最坏的那种"静默破坏"。
   */
  async function unlockExam(store, examId, opts) {
    const o = opts || {};
    const got = await getExam(store, examId);
    if (!got.ok) return fail(got.error);

    if (!got.exam.configLocked) {
      return { ok: true, exam: got.exam, meta: metaOf(got.exam),
               changed: false, discarded: null,
               note: '该卷本来就没有锁定，配置原样保留' };
    }

    const discarded = got.exam.config ? QuizCore.snapshotConfig(got.exam.config) : null;
    const unlocked = QuizCore.unlockConfig(got.exam);
    const r = await setConfig(store, examId, { config: unlocked.config, configLocked: unlocked.configLocked }, o);
    if (!r.ok) return r;
    return { ok: true, exam: r.exam, meta: r.meta, changed: true, discarded: discarded };
  }

  /* 数一份配置有多少个叶子（用于"不留空洞"的体量断言）
   * 空对象也算**一个叶子** —— 它本身就是一个"存在但为空"的配置项（如 short.synonyms），
   * 算 0 会与"逐叶子核对"的口径不一致，导致体量断言出现无意义的差 1。 */
  function countLeaves(v) {
    if (Array.isArray(v)) return v.reduce(function (n, x) { return n + countLeaves(x); }, 0) || 1;
    if (QuizCore.isPlainObject(v)) {
      const ks = Object.keys(v);
      if (!ks.length) return 1;
      return ks.reduce(function (n, k) { return n + countLeaves(v[k]); }, 0);
    }
    return 1;
  }

  /* ---------------- 全局设置的读写（配置只是其中一个字段） ----------------
   * 全局设置存在一个键里（settings = {config, theme, …}）。
   * 配置**只存用户改过的部分**（部分覆盖），不是整份生效配置 ——
   * 这样将来调整内置默认值时，用户没显式改过的项还能跟着受益。
   */
  const SETTINGS_KEY = 'settings';

  async function readSettings(store) {
    if (!store) return fail('没有可用的存储');
    let st = null;
    try { st = await store.get(SETTINGS_KEY); } catch (e) { st = null; }
    if (!st || typeof st !== 'object' || Array.isArray(st)) st = {};
    return { ok: true, settings: st };
  }

  async function readGlobalConfig(store) {
    const r = await readSettings(store);
    if (!r.ok) return r;
    const c = r.settings.config;
    return { ok: true, settings: r.settings, config: (c && typeof c === 'object' && !Array.isArray(c)) ? c : null };
  }

  /*
   * 写入全局配置（**唯一**会改 settings.config 的入口）。
   * 校验用的是 QuizCore.applyGlobalPatch —— 它会拦住"补丁自己写到的字段"里的非法值
   * （含与它配对的区间字段），而历史遗留的非法值只作为 preexisting 报出来、不拦。
   * 不合格就**不写盘**，把逐字段错误交回调用方。
   */
  async function writeGlobalConfig(store, patch, opts) {
    const o = opts || {};
    const cur = await readGlobalConfig(store);
    if (!cur.ok) return cur;
    const v = QuizCore.applyGlobalPatch(cur.config, patch, { layer: '全局设置' });
    if (!v.ok) {
      return fail('配置里有非法值，未写入', {
        errors: v.errors, preexisting: v.preexisting, warnings: v.warnings,
        hint: v.errors.length ? v.errors[0].message : ''
      });
    }
    const settings = Object.assign({}, cur.settings, { config: v.config, updatedAt: nowIso(o) });
    await store.set(SETTINGS_KEY, settings);
    return { ok: true, config: v.config, effective: v.effective,
             warnings: v.warnings, preexisting: v.preexisting, settings: settings };
  }

  /* ============================================================
   *  删卷级联询问（政策层）
   *
   *  三条硬规矩（本小类的验收锚）：
   *    ① **不许悄悄删**：没给政策就返回 `needPolicy` + 询问模型，绝不替用户做决定；
   *    ② 选『是』(cascade)：卷本体 + 误答本 + 作答记录一起删，**不留墓碑**（不可恢复、零残留）；
   *    ③ 选『否』(keepRecords)：只删卷本体，记录**保留**并在索引里留一枚**墓碑**
   *       （`index.deleted`），于是残留记录有明确归属标识「已删除试卷《原标题》」——
   *       它不是"孤儿可查询数据"（`scanOrphans` 会把两者分开报）。
   * ============================================================ */

  const POLICY_CASCADE = 'cascade';
  const POLICY_KEEP = 'keepRecords';

  /*
   * 询问模型（**纯函数**）：只看"会删掉什么"，产出弹窗要说的每一句话。
   * 界面不许自己拼文案 —— 否则"两个选项的后果"会各写一套，迟早对不上。
   */
  function deletePlan(info) {
    const x = info || {};
    const examId = String(x.examId == null ? '' : x.examId);
    const title = String(x.title || ('试卷 ' + examId));
    const wrongCount = Math.max(0, Number(x.wrongCount) || 0);
    const recordCount = Math.max(0, Number(x.recordCount) || 0);
    const hasRecords = (wrongCount + recordCount) > 0;
    return {
      examId: examId, title: title,
      wrongCount: wrongCount, recordCount: recordCount, hasRecords: hasRecords,
      message: '删除《' + title + '》。这套卷还挂着 ' + wrongCount + ' 条错题、' + recordCount + ' 条作答记录，要一并删除吗？',
      note: hasRecords
        ? '选「一并删除」后这些记录无法恢复；选「只删试卷，保留记录」则记录留在错题本里，并标成「已删除试卷」。'
        : '这套卷没有任何关联记录，两个选项的结果一样（只删试卷本体）。',
      options: [
        { policy: POLICY_CASCADE, answer: 'yes', label: '一并删除（不可恢复）',
          detail: '删掉试卷本体 + ' + wrongCount + ' 条错题 + ' + recordCount + ' 条作答记录' },
        { policy: POLICY_KEEP, answer: 'no', label: '只删试卷，保留记录',
          detail: '记录留在错题本里，归属标识改成「已删除试卷」' }
      ]
    };
  }

  /* 读一遍"会删掉什么"（要碰存储，所以放这里；文案与选项走上面的纯函数） */
  async function deletePreview(store, id) {
    if (!store) return fail('没有可用的存储');
    const scope = DataCore.examScopeOf(id);
    const got = await getExam(store, scope.id);
    if (!got.ok) return fail('找不到这份试卷：' + scope.id);

    let wrongCount = 0, recordCount = 0;
    try {
      const book = await store.get(DataCore.wrongKey(scope.id));
      if (book && book.entries && typeof book.entries === 'object') wrongCount = Object.keys(book.entries).length;
      const rec = await store.get(DataCore.recordKey(scope.id));
      if (Array.isArray(rec)) recordCount = rec.length;
      else if (rec && Array.isArray(rec.list)) recordCount = rec.list.length;
    } catch (e) { /* 读不到就算 0：询问模型照样给得出来，删的时候照样按政策执行 */ }

    const plan = deletePlan({ examId: scope.id, title: got.exam.title, wrongCount: wrongCount, recordCount: recordCount });
    return { ok: true, plan: plan, prompt: plan, examId: scope.id, title: got.exam.title };
  }

  /* 墓碑（归属标识）：记在索引里，读卷册/巡检时都用得到 */
  function tombstoneOf(entry) {
    if (!entry) return null;
    return {
      examId: String(entry.id || entry.examId || ''),
      title: String(entry.title || ''),
      deletedAt: String(entry.at || entry.deletedAt || ''),
      wrongCount: Number(entry.wrongCount) || 0,
      recordCount: Number(entry.recordCount) || 0,
      label: '已删除试卷（原《' + String(entry.title || entry.id || '') + '》）'
    };
  }

  async function writeTombstone(store, entry) {
    const idx = await readIndex(store);
    const list = Array.isArray(idx.deleted) ? idx.deleted.filter(function (x) {
      return String(x && (x.id || x.examId)) !== String(entry.id);
    }) : [];
    list.push(entry);
    idx.deleted = list;
    idx.updatedAt = new Date().toISOString();
    await store.set('index', idx);
    return { ok: true, deletedExams: list.length };
  }

  async function readTombstones(store) {
    const idx = await readIndex(store);
    return Array.isArray(idx.deleted) ? idx.deleted.slice() : [];
  }

  /* 已删除的卷册（给界面用：错题本要显示「已删除试卷」分组） */
  async function deletedExams(store) {
    if (!store) return fail('没有可用的存储');
    const list = await readTombstones(store);
    return { ok: true, deleted: list.map(tombstoneOf).filter(function (t) { return !!t.examId; }) };
  }

  /* 某一卷的归属：活着 / 已删除（带标识） / 查无此卷 */
  async function ownerOf(store, examId) {
    if (!store) return fail('没有可用的存储');
    const scope = DataCore.examScopeOf(examId);
    try {
      const body = await store.get(DataCore.examBodyKey(scope.id));
      if (body != null) {
        const meta = await store.get(DataCore.examSubKey(scope.id, 'meta'));
        return { ok: true, kind: 'alive', examId: scope.id,
                 title: (meta && meta.title) || body.title || '', label: '' };
      }
    } catch (e) { /* 落到下面按"已删除/查无"处理 */ }
    const hit = (await readTombstones(store)).filter(function (x) {
      return String(x && (x.id || x.examId)) === scope.id;
    })[0];
    if (hit) return Object.assign({ ok: true, kind: 'deleted' }, tombstoneOf(hit));
    return { ok: true, kind: 'unknown', examId: scope.id, title: '', label: '' };
  }

  /*
   * 删除试卷。
   * 政策**必须显式**：
   *   {policy:'cascade'}       → 卷本体 + 误答本 + 作答记录一起删，并抹掉旧墓碑（零残留、不可恢复）
   *   {policy:'keepRecords'}   → 只删卷本体，记录保留 + 写墓碑（残留记录有明确归属标识）
   *   {keepRecords:true/false} → 兼容旧写法（等价于上面两条）
   *   什么都不给                 → `{ok:false, needPolicy:true, prompt}`，**不删任何东西**
   */
  async function deleteExam(store, id, opts) {
    const o = opts || {};
    if (!store) return fail('没有可用的存储');
    const scope = DataCore.examScopeOf(id);

    let policy = o.policy || '';
    if (!policy && o.keepRecords !== undefined) policy = o.keepRecords ? POLICY_KEEP : POLICY_CASCADE;
    if (policy !== POLICY_CASCADE && policy !== POLICY_KEEP) {
      const pv = await deletePreview(store, scope.id);
      if (!pv.ok) return Object.assign({ ok: false, needPolicy: true, examId: scope.id }, pv);
      return { ok: false, needPolicy: true, examId: scope.id, prompt: pv.plan,
               message: '删卷会连带清除记录，必须先选定政策（询问模型见 prompt）' };
    }

    const before = policy === POLICY_KEEP ? await deletePreview(store, scope.id) : null;
    const keep = policy === POLICY_KEEP;

    /* ⚠ 顺序很要紧：选『否』时必须**先写墓碑、再删卷本体**。
     *   反过来的话，一旦墓碑写不进去（配额满时索引可能写不动），
     *   就会变成"卷删了、记录留下了、却没有任何归属标识" —— 一堆真孤儿。
     *   先写墓碑则两种失败都是安全态：墓碑写失败 → 什么都没删；删卷失败 → 残留记录已有主。 */
    if (keep) {
      try {
        await writeTombstone(store, {
          id: scope.id, title: (before && before.title) || '', at: nowIso(o),
          wrongCount: (before && before.plan.wrongCount) || 0,
          recordCount: (before && before.plan.recordCount) || 0
        });
      } catch (e) {
        return fail('归属标识写不进去，为避免留下无主的记录，这次删除没有执行', {
          examId: scope.id, policy: policy, needTombstone: true,
          hint: '存储可能已满；可先腾出空间，或改选「一并删除（不可恢复）」（它要写的记录更少，更容易成功）'
        });
      }
    }

    const res = await store.purgeExam(scope.id, { includeRecords: !keep });
    const orphansKept = keep ? [scope.record, scope.wrong] : [];

    if (!keep) {
      /* 级联：连旧墓碑一起抹掉 —— 否则"已删除试卷"的标识会留着一个已经清空的卷 */
      const idx = await readIndex(store);
      if (Array.isArray(idx.deleted) && idx.deleted.some(function (x) { return String(x && (x.id || x.examId)) === scope.id; })) {
        idx.deleted = idx.deleted.filter(function (x) { return String(x && (x.id || x.examId)) !== scope.id; });
        await store.set('index', idx);
      }
    }

    return {
      ok: res.ok !== false, examId: scope.id,
      policy: policy,
      deleted: res.deleted || [],
      orphansKept: orphansKept
    };
  }

  /*
   * 列卷册。
   * 只读轻量 meta —— 不必把所有卷子（可能很大、可能在异步后端）都拉进内存。
   * 自愈：索引或 meta 缺失时（配额满时索引可能写不动）退回扫描键并重建，报 healed=true。
   * opts.fresh=true → 忽略 meta 缓存，直接从卷本体重算
   *   （给"直接写卷本体、绕过卷册模块"的调用方收尾用；日常列卷册不该开，会退化成全量加载）
   */
  async function listExams(store, opts) {
    const o = opts || {};
    if (!store) return fail('没有可用的存储');
    const idx = await readIndex(store);
    const out = [], seen = {};
    let healed = false;

    for (const id of idx.examIds) {
      if (seen[id]) continue;
      seen[id] = 1;
      let meta = null;
      if (!o.fresh) {
        try { meta = await store.get(DataCore.examSubKey(id, 'meta')); } catch (e) { meta = null; }
      }
      if (!meta) {
        const exam = await store.get(DataCore.examBodyKey(id));
        if (exam == null) continue;                      // 索引里的悬空 id：跳过（scanOrphans 会报）
        meta = metaOf(exam);
        healed = true;
      }
      out.push(meta);
    }

    // 自愈第二步：有卷本体但不在索引里的（索引丢了），补进来
    const bodyKeys = await store.keysWithPrefix(DataCore.KEY_EXAM + DataCore.NS_SEP);
    for (const k of bodyKeys) {
      const rest = k.slice(DataCore.KEY_EXAM.length + DataCore.NS_SEP.length);
      if (rest.indexOf(DataCore.NS_SEP) >= 0) continue;   // 这是子键（exam::<id>::xxx），不是卷本体
      if (seen[rest]) continue;
      seen[rest] = 1;
      const exam = await store.get(k);
      if (exam == null) continue;
      out.push(metaOf(exam));
      healed = true;
    }

    out.sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
    if (o.limit) return { ok: true, exams: out.slice(0, o.limit), healed: healed, total: out.length };
    return { ok: true, exams: out, healed: healed, total: out.length };
  }

  /* ================= 题目写入 ================= */

  /*
   * 归一化一批题目。
   * opts.type → **强制题型**（文件里标记写错时用）：改完立刻用 applyDerived 重算
   *             答案字母 / 判分值 / 关键词 / 待校对标记，避免"题型改了、判分还是旧的"。
   * 一律分配**新的 id**：导入是"新增题目"，复用旧 id 会和卷内已有题撞号。
   */
  function normalizeQuestions(questions, opts) {
    const o = opts || {};
    return (questions || []).map(function (q) {
      const c = clone(q);
      delete c.id;
      if (o.type) c.type = o.type;
      SegmentCore.applyDerived(c);
      return SchemaCore.createQuestion(c, { rng: o.rng });
    });
  }

  /*
   * 追加题目到指定试卷。
   * opts: { type, now, skipInvalid }
   *   skipInvalid=true → 把结构不合法的题挑出来报告（skipped[]），只写合法的那些；
   *   默认 false → 只要有一道不合法就整批拒绝（blocking[] 指名），**不写半个卷子**。
   */
  async function appendQuestions(store, examId, questions, opts) {
    const o = opts || {};
    const got = await getExam(store, examId);
    if (!got.ok) return fail(got.error);
    const exam = got.exam;

    const normalized = normalizeQuestions(questions, o);
    const blocking = [], accepted = [];
    normalized.forEach(function (q, i) {
      const v = SchemaCore.validateQuestion(q);
      if (v.ok) accepted.push(q);
      else blocking.push({ index: i, type: q.type, stem: q.stem, errors: v.errors });
    });

    if (blocking.length && !o.skipInvalid) {
      return fail('有 ' + blocking.length + ' 道题结构不合法，整批未写入', {
        blocking: blocking,
        hint: '修正后重试，或传 skipInvalid:true 只导入合法的那部分'
      });
    }

    const before = groupCounts(exam.questions);
    exam.questions = exam.questions.concat(accepted);
    exam.updatedAt = nowIso(o);

    const ve = SchemaCore.validateExam(exam);
    if (!ve.ok) return fail('追加后整卷校验未通过，未写入', { errors: ve.errors });

    const w = await writeExam(store, exam);
    return {
      ok: true, exam: exam, meta: w.meta,
      added: accepted.length, /** 真正写进去的那几道（**归一后的对象**：id 是新的，别再拿调用前的 id 去对） */
      accepted: accepted,
      skipped: blocking,
      before: before, after: w.meta.counts,
      placement: w.placement
    };
  }

  /* 覆盖式设置题目（用于"替换整卷"） */
  async function setQuestions(store, examId, questions, opts) {
    const got = await getExam(store, examId);
    if (!got.ok) return fail(got.error);
    const exam = got.exam;
    exam.questions = [];
    await writeExam(store, exam);                    // 先清空落盘，再走追加（复用同一套校验与归一）
    return appendQuestions(store, examId, questions, opts);
  }

  /* ================= 批量上传 ================= */

  /*
   * 多文件一次导入。
   *   files: [{ name, kind:'txt'|'docx', data, type? }]
   *          kind='txt' 时 data 可以是字符串（已解码）或 ArrayBuffer/Uint8Array（交给编码层探测）
   *          **每个文件可以各自指定 type**（覆盖 opts.type）——
   *          这样"这批都按单选导"与"只有这个文件按判断导"两种用法都成立。
   *   opts : { type, skipUntilNumber, skipInvalid, now }
   *
   * 三个关键行为：
   *   1) **一个文件坏掉不该拖垮整批** —— 逐个 try/catch，失败的记进 failed[]，其余照常导入。
   *   2) 全部解析完再**一次性追加**（一次卷本体写入 + 一次 meta 写入），避免 N 次写放大。
   *   3) 指定了题型时：先按该题型切（管**没有标记**的文件），再强制归一（管标记**写错**的文件）。
   *      强制发生在**每个文件解析之后**，所以一批文件可以混合不同题型。
   */
  async function importFiles(store, examId, files, opts) {
    const o = opts || {};
    const list = Array.isArray(files) ? files : [];
    if (!list.length) return fail('没有要导入的文件');

    const got = await getExam(store, examId);
    if (!got.ok) return fail(got.error);

    const results = [], collected = [], failed = [];
    for (const f of list) {
      const name = (f && f.name) || '(未命名)';
      const forceType = (f && f.type) || o.type || null;
      try {
        const parsed = await parseOne(f, o, forceType);
        if (!parsed || !Array.isArray(parsed.questions)) {
          failed.push({ name: name, error: '解析结果为空' });
          continue;
        }
        // 强制题型在**文件级**做掉，再交给整批追加 —— 之后追加不再改题型
        const qs = forceType ? normalizeQuestions(parsed.questions, { type: forceType, rng: o.rng })
                             : parsed.questions;
        results.push({
          name: name, kind: f.kind, total: qs.length,
          counts: groupCounts(qs),
          forced: forceType,
          encoding: parsed.meta && parsed.meta.encoding,
          parsedByType: parsed.stats.byType
        });
        collected.push.apply(collected, qs);
      } catch (e) {
        failed.push({ name: name, error: (e && (e.hint || e.message)) || String(e), code: e && e.code });
      }
    }

    if (!collected.length) {
      return fail('这一批文件没有解析出任何题目', { files: results, failed: failed });
    }

    const app = await appendQuestions(store, examId, collected, o);
    if (!app.ok) return Object.assign(app, { files: results, failed: failed });

    return {
      ok: true, examId: examId,
      files: results, failed: failed,
      added: app.added, skipped: app.skipped,
      meta: app.meta, before: app.before, after: app.after,
      groups: groupCounts(app.exam.questions)
    };
  }

  /*
   * 单文件解析：给了 type 就走"手动指定题型"的路。
   * 这里固定带 force:true —— 用户既然手动指定了题型，就是在断言"这份文件整体是 X 型"，
   * 文件内部的标记（可能写错）不该反过来盖掉用户的指定。
   * 代价是"文件里混着多种题型"时不能这么用；那种情况就别指定题型，交给标记自动归类。
   */
  async function parseOne(f, o, forceType) {
    const kind = (f && f.kind) || (typeof f.data === 'string' ? 'txt' : 'docx');
    const asOpts = { type: forceType, skipUntilNumber: o.skipUntilNumber, force: true };
    if (kind === 'txt') {
      if (typeof f.data === 'string') {
        return forceType ? QuizParser.parseTextAs(f.data, asOpts) : QuizParser.parseText(f.data);
      }
      return forceType ? QuizParser.parseTxtBytesAs(f.data, asOpts) : QuizParser.parseTxtBytes(f.data);
    }
    if (kind === 'docx') {
      return forceType ? QuizParser.parseDocxAs(f.data, asOpts) : QuizParser.parseDocx(f.data);
    }
    throw new Error('不支持的文件类型：' + kind);
  }

  /* ================= 孤儿数据巡检 ================= */

  /*
   * 扫全库找"悬空数据"：
   *   orphans        record::<id> / wrong::<id> 指向一份**不存在的卷**
   *   missingBodies  索引里登记了，但卷本体已经没了
   * "删除后不留孤儿数据"这条验收，就是拿它来判的。
   */
  async function scanOrphans(store) {
    if (!store) return fail('没有可用的存储');
    const idx = await readIndex(store);
    const keys = await store.keys();
    const alive = {};
    for (const id of idx.examIds) {
      const body = await store.get(DataCore.examBodyKey(id));
      if (body != null) alive[id] = true;
    }
    /* 墓碑：选『否』留下的那些记录，归属标识在这里 —— 它们是"有主"的，不算孤儿 */
    const dead = {};
    (Array.isArray(idx.deleted) ? idx.deleted : []).forEach(function (x) {
      const id = String(x && (x.id || x.examId) || '');
      if (id) dead[id] = tombstoneOf(x);
    });
    const orphans = [], identified = [];
    keys.forEach(function (k) {
      if (k.indexOf(DataCore.KEY_EXAM + DataCore.NS_SEP) === 0) return;   // 卷本体/子键不算孤儿
      let id = null, kind = '';
      if (k.indexOf(DataCore.KEY_RECORD + DataCore.NS_SEP) === 0) {
        id = k.slice(DataCore.KEY_RECORD.length + DataCore.NS_SEP.length); kind = 'record';
      } else if (k.indexOf(DataCore.KEY_WRONG + DataCore.NS_SEP) === 0) {
        id = k.slice(DataCore.KEY_WRONG.length + DataCore.NS_SEP.length); kind = 'wrong';
      } else return;
      if (alive[id]) return;                                             // 指向活着的卷 → 正常
      /* 指向已删卷但墓碑在 → 有明确归属标识，不是孤儿 */
      if (dead[id]) identified.push({ key: k, examId: id, kind: kind,
                                      label: dead[id].label, title: dead[id].title, deletedAt: dead[id].deletedAt });
      else orphans.push({ key: k, examId: id, kind: kind });
    });
    const missingBodies = idx.examIds.filter(function (id) { return !alive[id]; });
    return { ok: true, orphans: orphans, identified: identified, missingBodies: missingBodies,
             examIds: idx.examIds.slice(), alive: Object.keys(alive), deleted: Object.keys(dead) };
  }

  /* ---------------- 清除答题记录（用户要求） ----------------
   * 只清"**作答产生的东西**"：作答进度（含所有轮次）、成绩记录、可选的错题本。
   * 绝不碰卷本体（`exam::<id>`）与它的 `meta` —— 题库还在、题还在，清的只是"做过什么"。
   *
   * 实现要点（为什么这么做）：
   *   · 键**全部靠枚举算出来再按精确键删**（`purgeByScope({exact:[…]})`）——
   *     绝不写一个空前缀/`exam::` 这种大前缀去删：那会连卷本体一起带走（= 把用户的题库清了）。
   *     枚举本身用 `store.keys()`（本命名空间内的逻辑键，落点无关）。
   *   · 进度键是 `exam::<id>::progress` / `::progress-<tag>`（同卷多轮各一份），
   *     判别器只认子键名以 `progress` 开头的那一类；`meta` 一律留住。
   *   · **孤儿记录也算数**：卷从没入册（拖入的 docx / 分享文件）时，进度/错题照样在盘上，
   *     而它不在卷册索引里 —— 清除答题记录必须连这些一起清，否则"清过了却还在"。
   */
  function isProgressSubKey(k) {
    const sep = DataCore.NS_SEP;
    const s = String(k == null ? '' : k);
    const at = s.lastIndexOf(sep);
    if (at < 0) return false;
    return s.slice(at + sep.length).indexOf('progress') === 0;
  }

  /* 读一遍"会清掉什么"（给确认弹窗用；要碰存储，所以放这里）。 */
  async function attemptRecordPreview(store) {
    if (!store || typeof store.keys !== 'function') return fail('没有可用的存储');
    let keys = [];
    try { keys = await store.keys(); } catch (e) { return fail('读不了本机数据：' + ((e && e.message) || e)); }
    const list = (keys || []).map(String);
    const examPrefix = DataCore.examBodyKey('');              // 'exam::'
    const recPrefix = DataCore.recordKey('');                 // 'record::'
    const wrongPrefix = DataCore.wrongKey('');                // 'wrong::'

    const progressKeys = list.filter(function (k) { return k.indexOf(examPrefix) === 0 && isProgressSubKey(k); });
    const recordKeys = list.filter(function (k) { return k.indexOf(recPrefix) === 0; });
    const wrongKeys = list.filter(function (k) { return k.indexOf(wrongPrefix) === 0; });

    /* 作答过的题数（进度里 answers 的条目数）：只是给用户一个"我到底做了多少"的读数 */
    let answered = 0, progressExams = [];
    for (const k of progressKeys) {
      progressExams.push(String(k).slice(examPrefix.length).split(DataCore.NS_SEP)[0]);
      try {
        const rec = await store.get(k);
        if (rec && rec.answers && typeof rec.answers === 'object') answered += Object.keys(rec.answers).length;
      } catch (e) { /* 读不到就不计这一条：数字少算比"假装清过了"好 */ }
    }
    let wrongBooks = 0, wrongEntries = 0, wrongExams = [];
    for (const k of wrongKeys) {
      wrongExams.push(String(k).slice(wrongPrefix.length));
      try {
        const book = await store.get(k);
        const n = (book && book.entries && typeof book.entries === 'object') ? Object.keys(book.entries).length : 0;
        if (n > 0) { wrongBooks++; wrongEntries += n; }
      } catch (e) { /* 同上 */ }
    }
    let recordCount = 0;
    for (const k of recordKeys) {
      try {
        const rec = await store.get(k);
        if (Array.isArray(rec)) recordCount += rec.length;
        else if (rec && Array.isArray(rec.list)) recordCount += rec.list.length;
        else if (rec) recordCount += 1;
      } catch (e) { /* 同上 */ }
    }
    progressExams = progressExams.filter(function (x, i, a) { return x && a.indexOf(x) === i; });
    wrongExams = wrongExams.filter(function (x, i, a) { return x && a.indexOf(x) === i; });
    return {
      ok: true,
      progress: { keys: progressKeys, exams: progressExams, answered: answered, rounds: progressKeys.length },
      records: { keys: recordKeys, entries: recordCount },
      wrong: { keys: wrongKeys, books: wrongBooks, entries: wrongEntries, exams: wrongExams },
      total: progressKeys.length + recordKeys.length + wrongKeys.length
    };
  }

  /* 真清。`opts.includeWrong`（默认 false）= 连错题本一起清。 */
  async function clearAttemptRecords(store, opts) {
    const o = opts || {};
    if (!store || typeof store.purgeByScope !== 'function') return fail('没有可用的存储');
    const pv = await attemptRecordPreview(store);
    if (!pv.ok) return pv;
    const exact = pv.progress.keys.concat(pv.records.keys)
      .concat(o.includeWrong ? pv.wrong.keys : []);
    if (!exact.length) {
      return { ok: true, cleared: { progress: 0, records: 0, wrong: 0, answered: 0, wrongEntries: 0 },
               nothing: true, preview: pv };
    }
    /* ⚠ 只按精确键删（`prefix` 留空）—— 这是"绝不动题库"的硬保证 */
    const r = await store.purgeByScope({ exact: exact });
    if (!r || r.ok !== true) return fail((r && r.error) || '清除失败');
    const gone = (r.deleted || []).map(String);
    const cleared = {
      progress: pv.progress.keys.filter(function (k) { return gone.indexOf(k) >= 0; }).length,
      records: pv.records.keys.filter(function (k) { return gone.indexOf(k) >= 0; }).length,
      /* ⚠ 这一项报的是"**实际删掉了多少**"，而不是"选项开没开" ——
       *   早先写成 `o.includeWrong ? … : 0`，于是"没选却把错题本清了"这种越权 bug
       *   在读数上依然是 0（探针 ⑧ 抓到的：那条断言因此测不到东西）。 */
      wrong: pv.wrong.keys.filter(function (k) { return gone.indexOf(k) >= 0; }).length,
      answered: pv.progress.answered,
      wrongEntries: o.includeWrong ? pv.wrong.entries : 0
    };
    /* 清完再核一遍：还剩下的进度/成绩（本轮该清的）必须为 0，否则如实报告失败 */
    const after = await attemptRecordPreview(store);
    const leftover = after.ok ? (after.progress.keys.length + after.records.keys.length +
      (o.includeWrong ? after.wrong.keys.length : 0)) : -1;
    return { ok: leftover === 0, cleared: cleared, leftover: leftover, includeWrong: !!o.includeWrong,
             deleted: gone, preview: pv,
             message: leftover === 0 ? null : '还有 ' + leftover + ' 条记录没清掉（存储可能被别处占用）' };
  }

  return {
    GROUP_TYPES: GROUP_TYPES,
    groupQuestions: groupQuestions, groupCounts: groupCounts, metaOf: metaOf,
    createExam: createExam, getExam: getExam, renameExam: renameExam, deleteExam: deleteExam,
    deletePlan: deletePlan, deletePreview: deletePreview, ownerOf: ownerOf, deletedExams: deletedExams,
    attemptRecordPreview: attemptRecordPreview, clearAttemptRecords: clearAttemptRecords,
    POLICY_CASCADE: POLICY_CASCADE, POLICY_KEEP: POLICY_KEEP,
    setConfig: setConfig, lockExam: lockExam, unlockExam: unlockExam, countLeaves: countLeaves,
    readSettings: readSettings, readGlobalConfig: readGlobalConfig, writeGlobalConfig: writeGlobalConfig,
    SETTINGS_KEY: SETTINGS_KEY,
    refreshMeta: refreshMeta,
    listExams: listExams,
    normalizeQuestions: normalizeQuestions,
    appendQuestions: appendQuestions, setQuestions: setQuestions,
    importFiles: importFiles, scanOrphans: scanOrphans
  };
});
