/* ============================================================
 *  core/schema.js —— 核心结构定义（全部后续模块的地基）
 *
 *  定义五类结构 + 应用全局状态，并提供校验与版本迁移：
 *    Exam（试卷） / Question（题目） / ExamConfig（配置，形状校验）
 *    Record（答题记录） / WrongEntry（误答记录） / AppState（全局状态）
 *
 *  设计约束（决定了后续能否并行开发与 Node 可测）：
 *    1) 不依赖 DOM、不读任何全局变量，全部是纯函数
 *    2) 不重复定义配置默认值 —— 那是 quiz.js 的职责，这里只校验形状
 *    3) id 生成可注入（rng），保证测试可复现
 *    4) schemaVersion 缺失 / 未知时必须显式拒绝或迁移，绝不静默当新格式
 * ============================================================ */
(function (root, factory) {
  const isNode = (typeof module !== 'undefined' && module.exports);
  // 判断题正误归一的**唯一实现**在解析层的 segment.js（那里还有歧义原因，供校对面板用）。
  // 加载顺序上 segment.js 在 schema.js 之前（见契约第六章），所以这条依赖成立。
  const SegmentCore = isNode ? require('./parse/segment.js') : root.SegmentCore;
  if (!SegmentCore) throw new Error('SchemaCore 依赖 SegmentCore（core/parse/segment.js），加载顺序错了');
  const api = factory(SegmentCore);
  if (isNode) module.exports = api;
  root.SchemaCore = api;
})(typeof self !== 'undefined' ? self : this, function (SegmentCore) {
  'use strict';

  const SCHEMA_VERSION = 1;
  const TYPES = ['单选', '多选', '判断', '简答'];
  const OPTION_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

  /* ---------------- id 生成（可注入 rng 以便测试复现） ---------------- */
  let seq = 0;
  function newId(prefix, rng) {
    seq = (seq + 1) % 100000;
    const r = Math.floor((rng ? rng() : Math.random()) * 1e9).toString(36);
    const t = Date.now().toString(36);
    return (prefix || 'id') + '_' + t + '_' + seq.toString(36) + r.slice(0, 5);
  }

  /* ---------------- 结构工厂 ---------------- */
  function createQuestion(f, opts) {
    const o = opts || {};
    const q = {
      id: f && f.id ? String(f.id) : newId('q', o.rng),
      type: f && f.type,
      stem: (f && f.stem) ? String(f.stem) : '',
      options: null,
      answer: (f && f.answer != null) ? String(f.answer) : '',
      answerLetters: null,
      judgeValue: null,
      keywords: null,
      explanation: (f && f.explanation) ? String(f.explanation) : '',
      difficulty: (f && Number.isInteger(f.difficulty)) ? f.difficulty : null,
      review: (f && Array.isArray(f.review)) ? f.review.slice() : [],
      inTextBox: !!(f && f.inTextBox)
    };

    if ((q.type === '单选' || q.type === '多选') && f && Array.isArray(f.options)) {
      q.options = f.options.map(function (x, i) {
        return {
          label: (x && x.label) ? String(x.label).toUpperCase()
                : OPTION_LABELS[i] || String(i + 1),
          text: (x && x.text != null) ? String(x.text) : ''
        };
      });
      // 答案字母：优先用传入的 answerLetters，否则从 answer 里解析
      let letters = Array.isArray(f.answerLetters) ? f.answerLetters.map(function (s) { return String(s).toUpperCase(); })
                  : String(q.answer || '').toUpperCase().match(/[A-H]/g);
      q.answerLetters = letters ? letters.slice() : [];
    }

    if (q.type === '判断') {
      if (f && typeof f.judgeValue === 'boolean') q.judgeValue = f.judgeValue;
      else if (f && f.answer !== undefined) q.judgeValue = normalizeJudge(f.answer);
    }

    if (q.type === '简答' && f && Array.isArray(f.keywords)) {
      const seen = {};
      q.keywords = [];
      f.keywords.forEach(function (k) {
        const text = (typeof k === 'string') ? k : (k && k.text);
        if (!text) return;
        const t = String(text).trim();
        if (!t || seen[t]) return;
        seen[t] = 1;
        q.keywords.push({ text: t, via: (typeof k === 'object' && k && k.via) ? String(k.via) : '手动' });
      });
    }
    return q;
  }

  /* 判断题正误归一 → 只要布尔值（reason 由 segment 那边给校对面板用）。
   * ⚠ 早先这里有一份**简化副本**：不认否定式（把「不正确」当成认不出来）、不给歧义原因，
   * 与 segment 的版本结论不一致 —— 同一个答案经不同入口会得到不同结果。
   * 现在统一委托，杜绝第三份实现。 */
  function normalizeJudge(v) {
    return SegmentCore.normalizeJudge(v).value;
  }

  function createExam(f, opts) {
    const o = opts || {};
    const now = o.now || new Date().toISOString();
    return {
      id: (f && f.id) ? String(f.id) : newId('exam', o.rng),
      schemaVersion: SCHEMA_VERSION,
      title: (f && f.title) ? String(f.title) : '未命名试卷',
      createdAt: (f && f.createdAt) || now,
      updatedAt: now,
      config: (f && f.config) ? f.config : null,        // 形状由 quiz.js 负责
      configLocked: !!(f && f.configLocked),
      questions: (f && Array.isArray(f.questions)) ? f.questions.slice() : []
    };
  }

  function createWrongEntry(qid, now) {
    return { qid: String(qid), times: 1, lastWrongAt: now || new Date().toISOString() };
  }

  function createRecord(f) {
    const x = f || {};
    return {
      at: x.at || new Date().toISOString(),
      examId: x.examId ? String(x.examId) : '',
      score: Number(x.score) || 0,
      full: Number(x.full) || 0,
      percent: Number(x.percent) || 0,
      level: x.level || '',
      correctCount: Number(x.correctCount) || 0,
      total: Number(x.total) || 0,
      per: Array.isArray(x.per) ? x.per.slice() : []
    };
  }

  function createSession(examId, questionIds, configSnapshot, now) {
    return {
      examId: String(examId || ''),
      questionIds: Array.isArray(questionIds) ? questionIds.slice() : [],
      answers: {},
      cursor: 0,
      startedAt: now || new Date().toISOString(),
      submittedAt: null,
      score: null,
      configSnapshot: configSnapshot || null
    };
  }

  /* 应用全局状态（单一真相源）。落盘策略见项目文档：secrets 永不进导出。 */
  function createAppState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      secrets:   { apiKey: '', provider: 'dashscope', model: '' },
      settings:  { config: {}, ui: { theme: 'dark', lastExamId: '' } },
      exams:     {},
      index:     { examIds: [], updatedAt: '' },
      session:   null,
      wrongbook: {},
      records:   {},
      runtime:   { backendStatus: 'unknown', degraded: false, usageBytes: 0 }
    };
  }

  /* ---------------- 校验 ---------------- */
  function isNonEmptyStr(v) { return typeof v === 'string' && v.trim().length > 0; }

  function validateQuestion(q, exam) {
    const errors = [], warnings = [];
    if (!q || typeof q !== 'object') return { ok: false, errors: ['题目不是对象'], warnings: [] };
    if (!isNonEmptyStr(q.id)) errors.push('题目缺少 id');
    if (TYPES.indexOf(q.type) < 0) errors.push('题型非法：' + q.type + '（只能取 ' + TYPES.join('/') + '）');
    if (!isNonEmptyStr(q.stem)) errors.push('题干为空');

    if (q.type === '单选' || q.type === '多选') {
      const opts = Array.isArray(q.options) ? q.options : [];
      if (opts.length < 2) errors.push('选择题选项少于 2 个');
      const labels = opts.map(function (o) { return o && o.label; });
      if (new Set(labels).size !== labels.length) errors.push('选项标签重复');
      opts.forEach(function (o, i) {
        if (!o || !isNonEmptyStr(o.label)) errors.push('第 ' + (i + 1) + ' 个选项缺少标签');
        if (!o || !isNonEmptyStr(o.text)) warnings.push('第 ' + (i + 1) + ' 个选项内容为空');
      });
      const lettersRaw = q.answerLetters;
      const letters = Array.isArray(lettersRaw) ? lettersRaw : [];
      // **显式给了一个空数组** ≠ **没写这个字段**：
      //   · `answerLetters: []`  → 用户明确说"这道题没有答案字母" → 若 answer 里却有字母，是真矛盾
      //   · `answerLetters: null` / 字段缺失 → "没写"（分享导出 data.js 正是写 null 的形状）
      //     计分侧对 null/缺失会**回落到 answer 解析**、判分完全正确，所以这里只能给 warning，
      //     否则会把**合法数据**（本应用自己导出的分享文件！）整批挡在导入门口。
      const lettersExplicitEmpty = Array.isArray(lettersRaw) && lettersRaw.length === 0;
      if (letters.length === 0) warnings.push('选择题没有答案');
      // 尺子与计分侧一致：标签与答案字母都做全角/大小写归一后再比，
      // 否则手改数据里的 answerLetters:['a','c'] 会被误报"不在选项里"（计分侧明明认）。
      const labelSet = labels.map(function (L) { return SegmentCore.normLetters(L); });
      letters.forEach(function (L) {
        const norm = SegmentCore.normLetters(L);
        if (!norm || labelSet.indexOf(norm) < 0) errors.push('答案字母 ' + L + ' 不在选项里');
      });
      if (q.type === '单选' && letters.length > 1) errors.push('单选题答案多于一个：' + letters.join(''));
      if (q.type === '多选' && letters.length === 1) warnings.push('多选题只有 1 个正确答案');
      // 答案键自相矛盾：`answer` 与 `answerLetters` 指向不同的选项。
      // 为什么必须报错而不是"挑一个信"：`createQuestion` 优先用 answerLetters、
      // `applyDerived` 一律从 answer 重算 → 同一道题经两条路径得到**不同答案键**，
      // 用户答 'A' 在一处 0 分、在另一处满分，而校验完全静默。
      //
      // 尺子必须与**计分侧同一把**（委托 SegmentCore：全角归一、大小写、只抽 A–H）——
      // 否则 'ＡＣ' 这种在计分侧明明能判的作答会被这里误报成"矛盾"。
      // 单选还有一条既有约定：答案写了 `AB` 时**只取第一个字母**（多选转单选的收窄结果），
      // 所以单选只比首字母，不算矛盾。
      //
      // ⚠ 条件是"**任一侧**有字母"而不是 `letters.length > 0`：
      //  `answer='AC'` + `answerLetters=[]` 早先整段跳过 → 校验放行，而计分侧把空数组
      //   看成"有键但为空"→ 恒 `unscorable:'noAnswerKey'`（学生看到一道 3 分、答对永远 0 分的题）。
      if (isNonEmptyStr(q.answer) || letters.length > 0) {
        const fromAnswer = SegmentCore.normLetters(q.answer);
        const fromLetters = SegmentCore.normLetters(letters.join(''));
        // **只在"答案文本里有字母"时才比**：
        //   · 答案写的是选项内容（如 `甲`）而字母单独给 → 不算矛盾（文本型答案，旧数据里有）
        //   · 只给了字母、答案文本空着 → 也不算矛盾（答案文本没填而已，字母才是判分依据）
        if (fromAnswer) {
          const same = (q.type === '单选')
            ? (fromAnswer.charAt(0) === fromLetters.charAt(0))
            : ([...new Set(fromAnswer.split(''))].sort().join('') === [...new Set(fromLetters.split(''))].sort().join(''));
          if (!same) {
            // "答案里有字母、答案字母却是空" 只在**显式空数组**时算矛盾；
            // null/缺失属于"没写"，给 warning 让人看见，但**不挡导入**。
            if (lettersExplicitEmpty) {
              errors.push('答案自相矛盾：answer="' + q.answer + '" 与 answerLetters=[] 不一致（答案里有字母，答案字母却是空的）');
            } else if (lettersRaw == null) {
              warnings.push('没写答案字母，判分按 answer 文本解析');
            } else if (letters.length > 0) {
              errors.push('答案自相矛盾：answer="' + q.answer + '" 与 answerLetters=[' + letters.join(',') + '] 不一致');
            } else {
              // 写了字母但全是 A–H 之外的字符（如 ['Z']）→ 上面"不在选项里"已经报过，
              // 这里补一条说明，不再重复说成"空的"（P7）
              warnings.push('答案字母 [' + letters.join(',') + '] 里没有可用字母（A–H）');
            }
          }
        }
      }
    }

    if (q.type === '判断') {
      if (q.judgeValue !== true && q.judgeValue !== false && q.judgeValue !== null) {
        errors.push('判断题判分值非法（应为 true/false/null）');
      }
      if (q.judgeValue === null) warnings.push('判断题答案未确定，待人工校对（不参与判分）');
    }

    if (q.type === '简答') {
      const kws = Array.isArray(q.keywords) ? q.keywords : [];
      if (kws.length === 0) warnings.push('简答题没有采分关键词（无法自动判分）');
      kws.forEach(function (k, i) {
        if (!k || !isNonEmptyStr(k.text)) errors.push('第 ' + (i + 1) + ' 个关键词为空');
      });
      if (q.difficulty !== null && q.difficulty !== undefined) {
        if (!Number.isInteger(q.difficulty) || q.difficulty < 1 || q.difficulty > 5) {
          errors.push('难度应在 1-5，实际 ' + q.difficulty);
        }
      }
    }

    // 注意：这里刻意不做"卷内 id 重复"检查 ——
    // 那需要扫描整个 questions 数组，会让 validateExam 退化成 O(n²)
    // （2000 题时约 400 万次比较）。重复检测由 validateExam 用哈希表统一负责。
    return { ok: errors.length === 0, errors: errors, warnings: warnings };
  }

  function validateExam(exam) {
    const errors = [], warnings = [];
    if (!exam || typeof exam !== 'object') return { ok: false, errors: ['试卷不是对象'], warnings: [] };
    if (!isNonEmptyStr(exam.id)) errors.push('试卷缺少 id');
    if (!isNonEmptyStr(exam.title)) errors.push('试卷缺少标题');
    if (exam.schemaVersion !== SCHEMA_VERSION) {
      errors.push('试卷 schemaVersion 应为 ' + SCHEMA_VERSION + '，实际 ' + exam.schemaVersion);
    }
    if (exam.config !== null && exam.config !== undefined && typeof exam.config !== 'object') {
      errors.push('config 应为对象或 null');
    }
    const qs = Array.isArray(exam.questions) ? exam.questions : [];
    const ids = {};
    qs.forEach(function (q, i) {
      const r = validateQuestion(q, exam);
      r.errors.forEach(function (e) { errors.push('第 ' + (i + 1) + ' 题：' + e); });
      r.warnings.forEach(function (w) { warnings.push('第 ' + (i + 1) + ' 题：' + w); });
      if (q && q.id) { ids[q.id] = (ids[q.id] || 0) + 1; }
    });
    Object.keys(ids).forEach(function (k) {
      if (ids[k] > 1) errors.push('题目 id 重复：' + k + '（出现 ' + ids[k] + ' 次）');
    });
    return { ok: errors.length === 0, errors: errors, warnings: warnings };
  }

  function validateAppState(s) {
    const errors = [];
    if (!s || typeof s !== 'object') return { ok: false, errors: ['状态不是对象'] };
    ['secrets', 'settings', 'exams', 'index', 'wrongbook', 'records', 'runtime'].forEach(function (k) {
      if (!s[k] || typeof s[k] !== 'object') errors.push('缺少状态分区：' + k);
    });
    if (s.secrets && typeof s.secrets.apiKey !== 'string') errors.push('secrets.apiKey 应为字符串');
    if (s.exams) {
      Object.keys(s.exams).forEach(function (id) {
        if (s.exams[id] && s.exams[id].id !== id) errors.push('exams 键与试卷 id 不一致：' + id);
      });
    }
    if (s.index && !Array.isArray(s.index.examIds)) errors.push('index.examIds 应为数组');
    if (s.index && Array.isArray(s.index.examIds)) {
      s.index.examIds.forEach(function (id) {
        if (s.exams && !s.exams[id]) errors.push('索引指向不存在的试卷：' + id);
      });
    }
    return { ok: errors.length === 0, errors: errors };
  }

  /* ---------------- 版本门禁与迁移 ---------------- */
  // 版本从低到高的升级函数表；将来加 v2 就往这里补
  const MIGRATIONS = {
    // 0: function (p) { p.schemaVersion = 1; return p; }   // 示例：v0 → v1
  };

  function readPayload(payload) {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, error: '内容不是对象', hint: '请确认是本应用导出的文件' };
    }
    const v = payload.schemaVersion;
    if (v === undefined || v === null || v === '') {
      return { ok: false, error: '缺少 schemaVersion 字段',
               hint: '这不是本应用导出的结构，或是过旧的文件；请用本应用重新导出后再导入' };
    }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      return { ok: false, error: 'schemaVersion 非法：' + JSON.stringify(v), hint: '文件可能已损坏' };
    }
    if (v > SCHEMA_VERSION) {
      return { ok: false, error: '文件版本 v' + v + ' 高于当前程序支持的 v' + SCHEMA_VERSION,
               hint: '请升级到新版本程序后再打开（避免按旧规则误读新结构）' };
    }
    let cur = payload, applied = [];
    for (let from = v; from < SCHEMA_VERSION; from++) {
      const fn = MIGRATIONS[from];
      if (!fn) {
        return { ok: false, error: '缺少从 v' + from + ' 到 v' + (from + 1) + ' 的迁移规则',
                 hint: '该版本的升级路径未实现' };
      }
      cur = fn(cur);
      applied.push('v' + from + '→v' + (from + 1));
    }
    return { ok: true, payload: cur, version: v, migratedTo: SCHEMA_VERSION, applied: applied };
  }

  /* ---------------- 结构自带的字段白名单（分享导出要用） ---------------- */
  const EXAM_FIELDS = ['id', 'schemaVersion', 'title', 'createdAt', 'updatedAt',
                       'config', 'configLocked', 'questions'];
  const QUESTION_FIELDS = ['id', 'type', 'stem', 'options', 'answer', 'answerLetters',
                           'judgeValue', 'keywords', 'explanation', 'difficulty',
                           'review', 'inTextBox'];

  function pickFields(obj, fields) {
    const out = {};
    fields.forEach(function (k) { if (obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    TYPES: TYPES,
    OPTION_LABELS: OPTION_LABELS,
    EXAM_FIELDS: EXAM_FIELDS,
    QUESTION_FIELDS: QUESTION_FIELDS,
    pickFields: pickFields,
    newId: newId,
    normalizeJudge: normalizeJudge,
    createQuestion: createQuestion,
    createExam: createExam,
    createWrongEntry: createWrongEntry,
    createRecord: createRecord,
    createSession: createSession,
    createAppState: createAppState,
    validateQuestion: validateQuestion,
    validateExam: validateExam,
    validateAppState: validateAppState,
    readPayload: readPayload
  };
});
