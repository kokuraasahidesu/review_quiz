/* ============================================================
 *  core/wrong.js —— 误答本：自动收集与计数
 *
 *  规则（**一次固定，写死在这里，界面与测试都按它**）：
 *    · 误答 = 交卷结算里那题 **correct === false**（即"得分未达满分"）——
 *      单选/判断答错、多选只对一半（半对）、简答没全命中、未作答，全都算误答。
 *    · 答对 = correct === true。
 *    · 误答 → 计数：首次进本 times=1、streak=1；已有记录则 times+1、streak+1（**连续**误答次数）。
 *    · 答对 → **保留历史记录**，只把 streak 清零并累加 rightTimes（"错过的题答对了"是进步，不该抹掉历史）。
 *      ⚠ 绝不因为"答对"删除任何条目；要删只能走 `remove()`（显式、带理由、留痕）。
 *
 *  键：`DataCore.wrongKey(examId)` → `wrong::<examId>`（**按试卷分本**，不手拼字符串）。
 *  分层：`applyResults/collect` 是纯函数（Node 里可穷举）；`collectToStore` 才碰存储。
 * ============================================================ */
(function (root, factory) {
  const isNode = (typeof module !== 'undefined' && module.exports);
  const SchemaCore = isNode ? require('./schema.js') : root.SchemaCore;
  const DataCore = isNode ? require('./data.js') : root.DataCore;
  const QuizCore = isNode ? require('./quiz.js') : root.QuizCore;
  if (!SchemaCore || !DataCore || !QuizCore) throw new Error('WrongCore 依赖 SchemaCore / DataCore / QuizCore，加载顺序错了');
  const api = factory(SchemaCore, DataCore, QuizCore);
  if (isNode) module.exports = api;
  root.WrongCore = api;
})(typeof self !== 'undefined' ? self : this, function (SchemaCore, DataCore, QuizCore) {
  'use strict';

  const WRONG_VERSION = 1;

  function wrongKey(examId) { return DataCore.wrongKey(examId); }

  /* 一本错题本 = 一套卷子的误答集合 */
  function createBook(examId, now) {
    return { v: WRONG_VERSION, examId: String(examId || ''), entries: {}, updatedAt: now || '', lastSessionAt: '' };
  }

  function entryOf(book, qid) { return (book && book.entries) ? (book.entries[String(qid)] || null) : null; }

  /* 单题计提：把一条结算结果记进本子（纯函数，返回新建/更新后的条目） */
  function applyResult(book, per, ctx) {
    const c = ctx || {};
    const qid = String(per && per.id);
    if (!qid) return null;
    const now = c.now || '';
    const wrong = !(per && per.correct === true);            // 未达满分 → 误答
    const cur = book.entries[qid];

    if (wrong) {
      if (!cur) {
        // 基形来自 SchemaCore.createWrongEntry（qid/times/lastWrongAt），其余是本层扩展
        const base = SchemaCore.createWrongEntry(qid, now);
        book.entries[qid] = {
          qid: base.qid, times: base.times, lastWrongAt: base.lastWrongAt,
          examId: book.examId,                                 // 归属：哪套卷的错题（不靠外部推断）
          type: (c.type || ''), stem: (c.stem || ''),
          streak: 1, rightTimes: 0, firstWrongAt: now,
          lastAnswer: (c.answer === undefined ? null : c.answer),
          lastScore: (per && typeof per.score === 'number') ? per.score : 0,
          lastFull: (per && typeof per.full === 'number') ? per.full : 0,
          history: [{ at: now, kind: 'wrong', score: (per && per.score) || 0, full: (per && per.full) || 0 }]
        };
        return { qid: qid, action: 'added', entry: book.entries[qid] };
      }
      cur.times = (cur.times || 0) + 1;
      cur.streak = (cur.streak || 0) + 1;
      cur.lastWrongAt = now;
      if (c.type) cur.type = c.type;
      if (c.stem) cur.stem = c.stem;
      if (c.answer !== undefined) cur.lastAnswer = c.answer;
      if (per && typeof per.score === 'number') cur.lastScore = per.score;
      if (per && typeof per.full === 'number') cur.lastFull = per.full;
      cur.history = (cur.history || []).concat([{ at: now, kind: 'wrong', score: (per && per.score) || 0, full: (per && per.full) || 0 }]);
      return { qid: qid, action: 'incremented', entry: cur };
    }

    // 答对：只清连续错误，**保留**记录（验收③：历史不许被静默删除）
    if (!cur) return { qid: qid, action: 'ignored', entry: null };
    cur.streak = 0;
    cur.rightTimes = (cur.rightTimes || 0) + 1;
    cur.lastRightAt = now;
    cur.history = (cur.history || []).concat([{ at: now, kind: 'right', score: (per && per.score) || 0, full: (per && per.full) || 0 }]);
    return { qid: qid, action: 'mastered', entry: cur };
  }

  /*
   * 一次交卷 → 收集进本子（纯函数，原地改 book；返回逐题动作汇总）。
   * `opts.sessionAt` 用于**幂等**：同一轮交卷重复收集（双击/重放）不会把次数算两遍。
   */
  function collect(book, results, opts) {
    const o = opts || {};
    const sessionAt = o.sessionAt || '';
    if (sessionAt && book.lastSessionAt === sessionAt) {
      return { ok: false, skipped: true, reason: 'duplicate',
               message: '这一轮交卷已经收集过了（同一时刻），不重复计数',
               added: [], incremented: [], mastered: [], ignored: [], untouched: [] };
    }
    const list = Array.isArray(results) ? results : [];
    const out = { ok: true, skipped: false, added: [], incremented: [], mastered: [], ignored: [], untouched: [] };
    list.forEach(function (per) {
      const q = (o.questionsById || {})[per && per.id] || null;
      const r = applyResult(book, per, {
        now: o.now || '', type: q ? q.type : '', stem: q ? q.stem : '',
        answer: (o.answers || {})[per && per.id]
      });
      if (!r) { out.untouched.push(per && per.id); return; }
      if (r.action === 'added') out.added.push(r.qid);
      else if (r.action === 'incremented') out.incremented.push(r.qid);
      else if (r.action === 'mastered') out.mastered.push(r.qid);
      else out.ignored.push(r.qid);                          // 答对但本子里没有 → 不入本
    });
    book.updatedAt = o.now || book.updatedAt;
    if (sessionAt) book.lastSessionAt = sessionAt;
    out.stats = stats(book);
    return out;
  }

  /* 显式删除（只有这里能删；schema 里手动删除也要留痕，绝不静默） */
  function remove(book, qid, opts) {
    const o = opts || {};
    const id = String(qid);
    const cur = book.entries[id];
    if (!cur) return { ok: false, error: '这条记录不在错题本里' };
    delete book.entries[id];
    book.removed = (book.removed || []).concat([{ qid: id, at: o.now || '', reason: String(o.reason || '用户移除') }]);
    book.updatedAt = o.now || book.updatedAt;
    return { ok: true, removed: { qid: id, reason: String(o.reason || '用户移除') }, stats: stats(book) };
  }

  function stats(book) {
    const list = Object.keys(book.entries || {}).map(function (k) { return book.entries[k]; });
    let timesSum = 0;
    list.forEach(function (e) { timesSum += (e.times || 0); });
    return {
      total: list.length, timesSum: timesSum,
      active: list.filter(function (e) { return (e.streak || 0) > 0; }).length,     // 还没纠正过来的
      mastered: list.filter(function (e) { return (e.streak || 0) === 0; }).length, // 后来答对过的
      removed: (book.removed || []).length
    };
  }

  function toJSON(book) { return JSON.parse(JSON.stringify(book)); }

  function checkPayload(payload, examId) {
    if (!payload || typeof payload !== 'object') return { ok: false, reason: 'empty', message: '这本错题本里还没有数据' };
    if (payload.v !== WRONG_VERSION) {
      return { ok: false, reason: 'version', message: '错题本数据的版本不匹配（' + payload.v + ' ≠ ' + WRONG_VERSION + '）' };
    }
    if (!payload.entries || typeof payload.entries !== 'object') return { ok: false, reason: 'shape', message: '错题本数据里缺少 entries 字段' };
    if (examId != null && payload.examId && payload.examId !== String(examId)) {
      return { ok: false, reason: 'wrong-exam', message: '这本错题本属于另一套卷（' + payload.examId + '）' };
    }
    return { ok: true };
  }

  /* ---------------- 存储层（唯一碰 store 的地方） ---------------- */

  async function loadBook(store, examId) {
    if (!store) return { ok: true, book: createBook(examId), empty: true, degraded: true };
    let payload = null;
    try { payload = await store.get(wrongKey(examId)); }
    catch (e) { return { ok: true, book: createBook(examId), empty: true, degraded: true, error: (e && e.message) || String(e) }; }
    if (payload == null) return { ok: true, book: createBook(examId), empty: true };
    const c = checkPayload(payload, examId);
    if (!c.ok) return { ok: false, reason: c.reason, message: c.message, book: createBook(examId) };
    const book = createBook(examId, payload.updatedAt);
    book.entries = payload.entries || {};
    book.removed = payload.removed || [];
    book.lastSessionAt = payload.lastSessionAt || '';
    return { ok: true, book: book, empty: false };
  }

  async function saveBook(store, book) {
    if (!store) return { ok: false, degraded: true, message: '存储不可用，这次收集只在内存里' };
    try {
      const r = await store.set(wrongKey(book.examId), toJSON(book));
      return { ok: true, where: (r && r.where) || 'small', bytes: (r && r.bytes) || 0 };
    } catch (e) {
      /* ⚠ 别把原始异常名直接抛给用户（'QuotaExceededError' 不是提示）：说清"为什么 + 后果"，
       *   原始原因附在括号里留给排查用。 */
      return { ok: false, degraded: true,
               message: '错题本写不进本机存储（' + ((e && e.message) || e) + '）：这次只记在内存里，刷新后会丢失。' };
    }
  }

  /*
   * **孤儿误答本**：卷从没进过卷册索引，但它的误答本在盘上。
   * 什么时候发生（实测）：答题页**拖入自己的 docx** 或直接答内置样卷 —— 卷 id 就是文件名/`sample.docx`，
   * 这条路不会往卷册索引里写任何东西；可交卷时误答是**照样收进去**的（`wrong::<卷id>`）。
   * 于是用户答完一轮回到错题本，只能看到一句"本地还没有卷子"（记录明明在）——
   * 这是最容易被当成"我记录丢了"的那类缺陷，和"已删除卷保留记录"是同一个坑的两个面。
   * 只认**本命名空间**里 `wrong::` 前缀的键，且排除已知 id（活着的 + 已删除的）。
   */
  async function orphanIds(store, knownIds) {
    if (!store || typeof store.keysWithPrefix !== 'function') return [];
    /* 前缀由**唯一真相源**推出来（不许手拼 '::'）：wrongKey('') 正好是 'wrong::' */
    const prefix = DataCore.wrongKey('');
    const known = (Array.isArray(knownIds) ? knownIds : []).map(function (x) { return String(x == null ? '' : x); });
    let ks = [];
    try { ks = await store.keysWithPrefix(prefix); } catch (e) { return []; }
    const out = [];
    (ks || []).forEach(function (k) {
      const id = String(k).slice(prefix.length);
      if (!id || known.indexOf(id) >= 0 || out.indexOf(id) >= 0) return;
      out.push(id);
    });
    return out.sort();
  }

  /*
   * 交卷后一键收集：读本 → 计提 → 写回。
   * `opts.results` 直接用 `session.summary.per`（那是"每题得分/是否满分"的真相源）。
   */
  async function collectToStore(store, opts) {
    const o = opts || {};
    const examId = o.examId || '';
    const loaded = await loadBook(store, examId);
    if (!loaded.ok) return { ok: false, reason: loaded.reason, message: loaded.message };
    const r = collect(loaded.book, o.results, {
      now: o.now || '', sessionAt: o.sessionAt || '',
      questionsById: o.questionsById || {}, answers: o.answers || {}
    });
    if (r.skipped) return { ok: true, skipped: true, reason: r.reason, message: r.message, book: loaded.book, stats: stats(loaded.book) };
    const saved = await saveBook(store, loaded.book);
    return {
      ok: true, skipped: false, book: loaded.book, stats: r.stats,
      added: r.added, incremented: r.incremented, mastered: r.mastered, ignored: r.ignored,
      persisted: saved.ok, degraded: !!saved.degraded, saveMessage: saved.message || ''
    };
  }

  /* ============================================================
   *  视图模型：按卷分组 + 逐题详情 + 跳转目标
   *  ⚠ 一条硬规矩：**原题/答案/解析一律从"试卷"里现读**，不用误答本里那份快照冒充。
   *    误答本里的 `stem` 只是方便识别的副本；卷子改过就如实标 `stale`。
   * ============================================================ */

  /* 一组：一套卷的误答本 + 它的卷标题
   * ctx.owner（可选）= `ExamsCore.ownerOf` 的结论：`{kind:'alive'|'deleted'|'unknown', title, label, deletedAt}`。
   * ⚠ 卷被删掉但记录保留时，这一组**必须**显示"已删除试卷"的归属标识，而不是一句干巴巴的 `试卷 V2`：
   *   那是"删卷级联询问"选『否』那条路径的验收要求（残留记录要有明确归属）。 */
  function ownerLabelOf(book, exam, owner) {
    if (exam) return { title: exam.title || ('试卷 ' + book.examId), kind: 'alive', deletedAt: '' };
    if (owner && owner.kind === 'deleted') {
      return { title: owner.label || ('已删除试卷（原《' + (owner.title || book.examId) + '》）'),
               kind: 'deleted', deletedAt: owner.deletedAt || '' };
    }
    return { title: '试卷 ' + book.examId, kind: (owner && owner.kind) || 'unknown', deletedAt: '' };
  }

  function groupOf(book, exam, ctx) {
    const list = Object.keys(book.entries || {}).map(function (k) { return book.entries[k]; });
    list.sort(function (a, b) {
      if ((b.times || 0) !== (a.times || 0)) return (b.times || 0) - (a.times || 0);        // 错得多的在前
      return String(b.lastWrongAt || '').localeCompare(String(a.lastWrongAt || ''));
    });
    const own = ownerLabelOf(book, exam, (ctx || {}).owner);
    return {
      examId: book.examId,
      title: own.title,
      examFound: !!exam,
      ownerKind: own.kind,                                 // ← 归属：活着 / 已删除 / 查无（界面据此标明）
      deleted: own.kind === 'deleted',
      deletedAt: own.deletedAt,
      total: list.length,                                  // ← 分组内题目数（= 误答数，验收①）
      timesSum: list.reduce(function (s, e) { return s + (e.times || 0); }, 0),
      active: list.filter(function (e) { return (e.streak || 0) > 0; }).length,
      mastered: list.filter(function (e) { return (e.streak || 0) === 0; }).length,
      entries: list.map(function (e) {
        return { qid: e.qid, times: e.times || 0, streak: e.streak || 0,
                 lastWrongAt: e.lastWrongAt || '', lastRightAt: e.lastRightAt || '',
                 type: e.type || '', stem: e.stem || '',
                 lastAnswer: (e.lastAnswer === undefined ? null : e.lastAnswer), lastScore: e.lastScore || 0, lastFull: e.lastFull || 0 };
      }),
      updatedAt: book.updatedAt || ''
    };
  }

  /* 全部卷的分组（books: [{book, exam, owner}]；exam 可为 null = 那套卷已经不在了） */
  function groups(books) {
    return (books || []).map(function (b) { return groupOf(b.book, b.exam, { owner: b.owner }); })
      .filter(function (g) { return g.total > 0; })
      .sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
  }

  /* 逐题详情：**原题/答案/解析都取自试卷**（exam.questions 里那一题），并把不一致显式标出来 */
  function detailOf(book, qid, ctx) {
    const id = String(qid);
    const e = (book.entries || {})[id];
    if (!e) return { ok: false, reason: 'not-in-book', message: '这道题不在错题本里' };
    const c = ctx || {};
    const exam = c.exam || null;
    const own = ownerLabelOf(book, exam, c.owner);
    const questions = (exam && Array.isArray(exam.questions)) ? exam.questions : [];
    const index = questions.map(function (q) { return q.id; }).indexOf(id);
    const q = index >= 0 ? questions[index] : null;
    const sameStem = !!(q && e.stem && String(q.stem) === String(e.stem));
    return {
      ok: true, qid: id, examId: book.examId, examTitle: (exam && exam.title) || '',
      ownerKind: own.kind, ownerLabel: own.title,          // 归属标识（卷已删时是非空的可读标签）
      index: index,                       // 卷内下标（-1 = 该题已不在卷里）
      inExam: index >= 0,
      // 快照与现卷不一致 → 显式报告（绝不拿快照冒充"原题"）
      stale: !q || !sameStem,
      staleReason: !q ? (own.kind === 'deleted'
                          ? '这套卷已经被删除了（这是错题本里的快照存档）'
                          : '这道题已经不在试卷里了（快照仍留档）')
                      : (!sameStem ? '试卷里的题干已经改过了（下面是卷子里的最新版）' : ''),
      question: q ? { id: q.id, type: q.type, typeLabel: (q.type || ''), stem: q.stem || '',
                      options: (q.options || []).map(function (o) { return { label: o.label, text: o.text }; }),
                      answerText: QuizCore.answerText(q), explanation: q.explanation || '' } : null,
      snapshot: { stem: e.stem || '', type: e.type || '' },     // 误答本里的副本（仅供对照）
      times: e.times || 0, streak: e.streak || 0,
      firstWrongAt: e.firstWrongAt || '', lastWrongAt: e.lastWrongAt || '', lastRightAt: e.lastRightAt || '',
      lastAnswer: (e.lastAnswer === undefined ? null : e.lastAnswer),
      lastScore: e.lastScore || 0, lastFull: e.lastFull || 0,
      history: (e.history || []).slice(),
      jump: index >= 0 ? { examId: book.examId, index: index } : null   // ← 跳回该卷该题
    };
  }

  /* 供上层做"跳过去"的最小契约：目标卷 + 卷内下标 */
  function jumpTarget(book, qid, ctx) {
    const d = detailOf(book, qid, ctx);
    if (!d.ok) return d;
    if (!d.inExam) return { ok: false, reason: 'not-in-exam', message: '这道题已经不在试卷里了，无法跳转', qid: qid };
    return { ok: true, examId: d.examId, index: d.index, title: d.examTitle };
  }

  /* 从存储里把所有卷的误答本读出来（分组视图用）；examIds 由卷册索引给出 */
  async function loadAll(store, examIds) {
    const ids = Array.isArray(examIds) ? examIds : [];
    const out = [];
    for (let i = 0; i < ids.length; i++) {
      const r = await loadBook(store, ids[i]);
      if (r.ok && !r.empty) out.push({ examId: ids[i], book: r.book });
    }
    return out;
  }

  /*
   * 界面唯一入口：把**活着的卷**与**已删除的卷**（选『否』保留记录那种）一起读出来。
   * ⚠ 为什么必须合并：`ExamsCore.listExams` 只列活着的卷，已删除卷的误答本不在其中。
   *   只按 listExams 的 id 读 → 用户刚选了"保留记录"，回到错题本却**什么都看不到**
   *   （数据还在盘上，界面装作没有 —— 最容易被当成"我记录丢了"的那种缺陷）。
   */
  async function loadAllWithDeleted(store, aliveIds, deletedIds) {
    const ids = (Array.isArray(aliveIds) ? aliveIds : []).slice();
    (Array.isArray(deletedIds) ? deletedIds : []).forEach(function (id) {
      const x = String(id == null ? '' : id);
      if (x && ids.indexOf(x) < 0) ids.push(x);
    });
    return loadAll(store, ids);
  }

  return {
    WRONG_VERSION: WRONG_VERSION, wrongKey: wrongKey,
    createBook: createBook, entryOf: entryOf, applyResult: applyResult, collect: collect,
    remove: remove, stats: stats, toJSON: toJSON, checkPayload: checkPayload,
    loadBook: loadBook, saveBook: saveBook, collectToStore: collectToStore,
    orphanIds: orphanIds,
    groupOf: groupOf, groups: groups, detailOf: detailOf, jumpTarget: jumpTarget, loadAll: loadAll,
    loadAllWithDeleted: loadAllWithDeleted
  };
});
