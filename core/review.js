/* ============================================================
 *  core/review.js —— 导入预览 / 人工校对 / 入库确认（纯逻辑，无 DOM）
 *
 *  设计要点（三条验收标准都落在这里）：
 *
 *  ① 改题型/题干/答案/解析、增删关键词 —— 全部是**返回新 draft 的纯函数**。
 *     改完立即用 SegmentCore.applyDerived 重算派生字段（答案字母/判分值/关键词/待校对标记），
 *     否则会出现"界面显示已改、判分还是旧的"。
 *
 *  ② 待校对标记与筛选：needsReview(q) 直接取 SegmentCore.reviewFlags 的分类结果；
 *     visibleIndices 在开启"只看待校对"时**只**返回待校对题的下标。
 *
 *  ③ 未确认不产生副作用：
 *     · 编辑操作只动 draft，不碰 store；
 *     · 唯一会写 store 的函数是 commit()；
 *     · cancel() **连 store 引用都不接收** —— 从签名上就不可能产生副作用。
 *
 *  依赖：core/parse/segment.js（派生重算与疑点分类）、core/schema.js（结构工厂与版本门禁）
 *  加载顺序：… → segment.js → parser-core.js → schema.js → review.js
 * ============================================================ */
(function (root, factory) {
  const isNode = (typeof module !== 'undefined' && module.exports);
  const SegmentCore = isNode ? require('./parse/segment.js') : root.SegmentCore;
  const SchemaCore  = isNode ? require('./schema.js')        : root.SchemaCore;
  const api = factory(SegmentCore, SchemaCore);
  if (isNode) module.exports = api;
  root.ReviewCore = api;
})(typeof self !== 'undefined' ? self : this, function (SegmentCore, SchemaCore) {
  'use strict';

  if (!SegmentCore || !SchemaCore) {
    throw new Error('review-core 依赖缺失：请先加载 core/parse/segment.js 与 core/schema.js（顺序不可颠倒）');
  }

  const TYPES = SchemaCore.TYPES;
  // 允许在面板上直接编辑的字段（选项内容编辑不在本小类范围）
  const EDITABLE_FIELDS = ['type', 'stem', 'answer', 'explanation'];
  const KEYWORD_VIAS = ['加粗', '高亮', '字体色', '底纹', '自动(需校对)', '手动'];

  /* ---------------- 小工具 ---------------- */
  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function fail(error, hint) { return { ok: false, error: error, hint: hint || '' }; }

  function stableJson(v) {
    // 键序固定的序列化：用于"前后快照逐字节对比"。
    // 直接用 JSON.stringify 会受插入顺序影响，两次等价的操作可能产生不同字符串。
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
    const keys = Object.keys(v).sort();
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + stableJson(v[k]); }).join(',') + '}';
  }

  /* ---------------- ① 草案的建立与编辑 ---------------- */

  /*
   * 从解析结果建立草案。**深拷贝**，绝不持有上游对象的引用 ——
   * 否则编辑会顺手改掉解析结果，撤销与否都说不清。
   * opts: { title, now, id }
   */
  function createDraft(parsed, opts) {
    if (!parsed || !Array.isArray(parsed.questions)) {
      return fail('解析结果里没有 questions 数组', '请先用 parser-core 解析文件，再把结果交给面板');
    }
    const o = opts || {};
    const now = o.now || new Date().toISOString();
    return {
      ok: true,
      draft: {
        id: o.id || ('draft-' + now + '-' + Math.random().toString(36).slice(2, 8)),
        createdAt: now,
        title: o.title || '导入的试卷',
        source: clone(parsed.meta || {}),
        stats: clone(parsed.stats || {}),
        questions: clone(parsed.questions)
      }
    };
  }

  /* 取出第 index 题的可写副本（只复制被改的那一题，其余共享引用 —— 省内存且天然不可变） */
  function withQuestion(draft, index, mutate) {
    if (!draft || !Array.isArray(draft.questions)) return fail('草案无效');
    if (!Number.isInteger(index) || index < 0 || index >= draft.questions.length) {
      return fail('题目下标越界：' + index, '共 ' + (draft.questions ? draft.questions.length : 0) + ' 题');
    }
    const next = clone(draft);
    const q = next.questions[index];
    const err = mutate(q);
    if (err) return fail(err);
    // 编辑后必须重算派生字段：判分值/答案字母/关键词/待校对标记
    SegmentCore.applyDerived(q);
    return { ok: true, draft: next, question: q };
  }

  /* 改任意可编辑字段 */
  function setField(draft, index, field, value) {
    if (EDITABLE_FIELDS.indexOf(field) < 0) {
      return fail('不允许编辑的字段：' + field, '可编辑：' + EDITABLE_FIELDS.join('/'));
    }
    if (field === 'type') return setType(draft, index, value);
    return withQuestion(draft, index, function (q) {
      if (field === 'stem' && !String(value == null ? '' : value).trim()) {
        return '题干不能为空';
      }
      if (field === 'answer' && Array.isArray(q.keywords)) {
        // 参考答案变了，**自动生成**的关键词就作废了 —— 必须丢掉让 applyDerived 重算，
        // 否则关键词会停在旧答案上（"改了答案、关键词还是老的"）。
        // 手工添加的与原文样式来的关键词保留：那是人/文档给的，不随答案漂移。
        q.keywords = q.keywords.filter(function (k) { return k.via !== '自动(需校对)'; });
      }
      q[field] = (value == null) ? '' : String(value);
    });
  }

  /*
   * 改题型。必须连带处理"换了题型之后不适用的字段"，否则会出现
   * 「判断题带着 options」这种结构非法状态。
   * 归一表（与 CONTRACT 第二节一致）：
   *   单选/多选 → 用 options + answerLetters；judgeValue/keywords 不适用
   *   判断      → 用 judgeValue；options/answerLetters/keywords 不适用
   *   简答      → 用 keywords；options/answerLetters/judgeValue 不适用
   */
  function setType(draft, index, type) {
    if (TYPES.indexOf(type) < 0) {
      return fail('题型非法：' + type, '只能取 ' + TYPES.join('/'));
    }
    return withQuestion(draft, index, function (q) {
      const wasChoice = (q.type === '单选' || q.type === '多选');
      const nowChoice = (type === '单选' || type === '多选');
      q.type = type;

      if (nowChoice) {
        // 从非选择题改成选择题时，没有现成选项 → 置空，由 applyDerived 标"选项少于 2 个"
        if (!wasChoice || !Array.isArray(q.options)) q.options = [];
        // 多选 → 单选：答案文本也要跟着收窄。
        // 只收窄 answerLetters（applyDerived 会做）而留着 answer='AB' 的话，
        // 这道题的"答案文本"和"答案字母"就互相矛盾了 —— 校验会（正确地）报错拒收，
        // 界面上也会显示一道单选却写着 AB。
        if (type === '单选') {
          const letters = String(q.answer == null ? '' : q.answer).toUpperCase().replace(/[^A-H]/g, '');
          if (letters.length > 1) q.answer = letters.charAt(0);
        }
      } else {
        q.options = [];
      }
      // 简答改走选择题时，旧的采分关键词不再适用；其余情况交给 applyDerived
      if (type !== '简答' && Array.isArray(q.keywords) && q.keywords.length) {
        // 保留关键词会让人误以为还能采分，所以清掉；用户需要可再手动加
        q.keywords = [];
      }
      if (type === '简答' && !Array.isArray(q.keywords)) q.keywords = [];
    });
  }

  /* 增删关键词 */
  function addKeyword(draft, index, text, via) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return fail('关键词不能为空');
    const v = (via == null || via === '') ? '手动' : String(via);
    if (KEYWORD_VIAS.indexOf(v) < 0) return fail('关键词来源非法：' + v, '可取 ' + KEYWORD_VIAS.join('/'));
    return withQuestion(draft, index, function (q) {
      if (q.type !== '简答') return '只有简答题有采分关键词（当前是 ' + q.type + '）';
      if (!Array.isArray(q.keywords)) q.keywords = [];
      if (q.keywords.some(function (k) { return k.text === t; })) return '已存在同名关键词：' + t;
      q.keywords.push({ text: t, via: v });
    });
  }

  function removeKeyword(draft, index, kwIndex) {
    return withQuestion(draft, index, function (q) {
      if (q.type !== '简答') return '只有简答题有采分关键词（当前是 ' + q.type + '）';
      if (!Array.isArray(q.keywords)) q.keywords = [];
      if (!Number.isInteger(kwIndex) || kwIndex < 0 || kwIndex >= q.keywords.length) {
        return '关键词下标越界：' + kwIndex;
      }
      q.keywords.splice(kwIndex, 1);
      // 删光之后 applyDerived 会重新跑兜底；若不希望它自动补回，
      // 用户在面板上把参考答案清掉即可（那时兜底也无从生成）。
    });
  }

  /* 删除草案里的某道题 —— 校对时"这题不要了"。
   * 为什么必须有：选项内容编辑不在本小类范围，而"0 个选项的选择题"永远通不过结构校验，
   * 没有这个出口用户会被卡死在"改也改不动、存也存不下"。 */
  /*
   * AI 单题结果的"落地"两个纯函数（「单题智能生成」小类用）：
   *   · 解析/难度 → 附加到原题（走 setField，不新增题目）
   *   · 变式题     → 追加成**新的一道题**（进草案；确认入库时才写盘）
   * 两者都**先过 SchemaCore.validateQuestion**：结构不合法一律拒绝、草案一个字节都不动。
   */
  function setDifficulty(draft, index, level) {
    if (!Number.isInteger(level) || level < 1 || level > 5) {
      return fail('难度必须是 1-5 的整数，实际 ' + level, 'AI 偶尔会给 3.5 或 0，这类一律不认');
    }
    return withQuestion(draft, index, function (q) { q.difficulty = level; });
  }

  function appendQuestion(draft, q) {
    if (!draft || !Array.isArray(draft.questions)) return fail('草案无效');
    if (!q || typeof q !== 'object') return fail('要追加的题目不是对象');
    const made = SchemaCore.createQuestion(q);
    const v = SchemaCore.validateQuestion(made);
    if (!v.ok) return fail('这道题结构不合法，未加入草案：' + v.errors.join('；'));
    /* id 撞车就换一个（AI 生成的题与原文题可能重名） */
    const ids = draft.questions.map(function (x) { return x.id; });
    if (ids.indexOf(made.id) >= 0) made.id = SchemaCore.newId ? SchemaCore.newId('q') : ('q_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
    const next = clone(draft);
    next.questions = next.questions.concat([made]);
    return { ok: true, draft: next, question: made, index: next.questions.length - 1, appended: true };
  }

  function removeQuestion(draft, index) {
    if (!draft || !Array.isArray(draft.questions)) return fail('草案无效');
    if (!Number.isInteger(index) || index < 0 || index >= draft.questions.length) {
      return fail('题目下标越界：' + index);
    }
    const next = clone(draft);
    const removed = next.questions.splice(index, 1)[0];
    return { ok: true, draft: next, removed: removed };
  }

  /* 关键词来源的中文标签（面板上要"标明每个关键词的来源或为手动添加"） */
  function keywordSourceLabel(via) {
    const v = String(via == null ? '' : via);
    if (v === '手动') return '手动添加';
    if (v === '自动(需校对)') return '自动生成·需校对';
    if (KEYWORD_VIAS.indexOf(v) >= 0) return v + '（原文样式）';
    return v || '未标注';
  }

  /* ---------------- ② 待校对标记与筛选 ---------------- */

  function flagsOf(q) { return SegmentCore.reviewFlags(q); }

  /* 是否需要人工校对：有任一疑点分类即算（含"关键词自动生成"） */
  function needsReview(q) { return flagsOf(q).length > 0; }

  /* 当前视图下应显示的题目下标 */
  function visibleIndices(draft, onlyReview) {
    const out = [];
    if (!draft || !Array.isArray(draft.questions)) return out;
    draft.questions.forEach(function (q, i) {
      if (!onlyReview || needsReview(q)) out.push(i);
    });
    return out;
  }

  function reviewStats(draft) {
    const qs = (draft && draft.questions) || [];
    const byFlag = {};
    let n = 0;
    qs.forEach(function (q) {
      const f = flagsOf(q);
      if (f.length) n++;
      f.forEach(function (x) { byFlag[x.id] = (byFlag[x.id] || 0) + 1; });
    });
    return { total: qs.length, needsReview: n, ok: qs.length - n, byFlag: byFlag };
  }

  /* ---------------- ③ 入库确认 / 取消 ---------------- */

  /*
   * 唯一会写 store 的函数。
   * 任何一步失败都在写之前返回 —— 不许留下半个卷子。
   */
  async function commit(draft, store, opts) {
    if (!draft || !Array.isArray(draft.questions)) return fail('草案无效');
    if (!store || typeof store.set !== 'function') return fail('没有可用的存储');

    const o = opts || {};
    const now = o.now || new Date().toISOString();

    // 1) 过结构工厂：不适用字段一律归一成 null，并分配 id
    let questions;
    try {
      questions = draft.questions.map(function (q) {
        return SchemaCore.createQuestion(q, { rng: o.rng });
      });
    } catch (e) {
      return fail('题目转换失败：' + (e && e.message));
    }

    // 2) 逐题体检 —— 先把"卡住入库的是哪几题"找出来，面板才好跳过去
    const blocking = [];
    questions.forEach(function (q, i) {
      const r = SchemaCore.validateQuestion(q);
      if (!r.ok) blocking.push({ index: i, type: q.type, stem: q.stem, errors: r.errors });
    });

    // 3) 造卷并校验 —— 校验不过就**不写**
    const exam = SchemaCore.createExam(
      { title: o.title || draft.title, questions: questions, config: o.config || null },
      { now: now, rng: o.rng }
    );
    const v = SchemaCore.validateExam(exam);
    if (blocking.length || !v.ok) {
      return {
        ok: false,
        error: '结构校验未通过，未入库（存储零变化）',
        hint: blocking.length
          ? '有 ' + blocking.length + ' 道题结构不合法，请修正后重试（或把该题删掉）'
          : v.errors.join('；'),
        blocking: blocking,
        errors: v.errors
      };
    }

    // 4) 落盘：卷子本体 + 轻量索引
    const placement = await store.set('exam::' + exam.id, exam);
    let index = null;
    try { index = await store.get('index'); } catch (e) { index = null; }
    if (!index || typeof index !== 'object' || !Array.isArray(index.examIds)) {
      index = { examIds: [], updatedAt: now };
    }
    if (index.examIds.indexOf(exam.id) < 0) index.examIds.push(exam.id);
    index.updatedAt = now;
    await store.set('index', index);

    return {
      ok: true, exam: exam, examId: exam.id,
      count: questions.length,
      needsReview: reviewStats(draft).needsReview,
      placement: placement && placement.where,
      storedAt: now
    };
  }

  /*
   * 取消导入。
   * 注意签名：**不接收 store** —— 从类型上就保证了它不可能改动题库或存储。
   * 返回被丢弃的草案 id，仅供调用方清界面状态。
   */
  function cancel(draft) {
    return { ok: true, discarded: (draft && draft.id) || null, cancelledAt: new Date().toISOString() };
  }

  /* ---------------- 导出 JSON（验收①要"能从导出的 JSON 中看到改动"） ----------------
   * 说明：这里只提供**面板自查用的卷子 JSON 快照**；
   *       正式的 txt/JSON 题库导入导出属「试卷导入导出txt」小类，不在本小类范围。
   */
  function examToJson(exam) {
    const payload = { schemaVersion: SchemaCore.SCHEMA_VERSION, kind: 'exam', exam: exam };
    return JSON.stringify(payload, null, 2);
  }

  function jsonToExam(text) {
    let payload;
    try { payload = JSON.parse(text); }
    catch (e) { return fail('不是合法 JSON：' + (e && e.message)); }
    if (!payload || typeof payload !== 'object') return fail('内容不是对象');
    if (payload.kind !== 'exam') return fail('这不是一份卷子快照（kind=' + payload.kind + '）');
    const r = SchemaCore.readPayload(payload);
    if (!r.ok) return fail(r.error, r.hint);
    const exam = r.payload.exam;
    const v = SchemaCore.validateExam(exam);
    if (!v.ok) return fail('卷子结构不合法', v.errors.join('；'));
    return { ok: true, exam: exam, version: r.version, applied: r.applied };
  }

  /* 前后快照对比用（键序稳定，逐字节可比） */
  function snapshot(v) { return stableJson(v); }

  /* 存储快照：把整个 store 读出来（验收③要用它做前后对比） */
  async function storeSnapshot(store) {
    const keys = (await store.keys()).slice().sort();
    const out = {};
    for (const k of keys) out[k] = await store.get(k);
    return out;
  }

  return {
    TYPES: TYPES, EDITABLE_FIELDS: EDITABLE_FIELDS, KEYWORD_VIAS: KEYWORD_VIAS,
    createDraft: createDraft,
    setField: setField, setType: setType,
    setStem: function (d, i, v) { return setField(d, i, 'stem', v); },
    setAnswer: function (d, i, v) { return setField(d, i, 'answer', v); },
    setExplanation: function (d, i, v) { return setField(d, i, 'explanation', v); },
    setDifficulty: setDifficulty, appendQuestion: appendQuestion,
    addKeyword: addKeyword, removeKeyword: removeKeyword,
    removeQuestion: removeQuestion,
    keywordSourceLabel: keywordSourceLabel,
    flagsOf: flagsOf, needsReview: needsReview,
    visibleIndices: visibleIndices, reviewStats: reviewStats,
    commit: commit, cancel: cancel,
    examToJson: examToJson, jsonToExam: jsonToExam,
    snapshot: snapshot, storeSnapshot: storeSnapshot, stableJson: stableJson
  };
});
