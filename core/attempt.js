/* ============================================================
 *  core/attempt.js —— 一次作答的会话状态（作答界面的大脑）
 *
 *  分工：
 *    · 判分口径      → core/quiz.js（scoreOne / scoreExam）
 *    · 该不该揭示/跳页 → core/flow.js（revealAt / afterSubmit）—— **唯一真相源**
 *    · 这一层只管：用户答了什么、哪题提交过、现在第几题、以及"界面该画成什么样"
 *
 *  为什么要有这一层：界面上最容易出的错是"哪个状态算已作答""提交后能不能改"
 *  "面板改了参数对当前题/下一题分别有什么影响"散落在 DOM 事件里 —— 那三件事
 *  全都做成纯函数后，Node 里就能穷举验证，浏览器只需要负责画。
 *
 *  会话对象是**可变**的（每次按键都深拷贝整卷会卡）；函数返回同一个 session 便于链式调用。
 * ============================================================ */
(function (root, factory) {
  const isNode = (typeof module !== 'undefined' && module.exports);
  const SchemaCore = isNode ? require('./schema.js') : root.SchemaCore;
  const QuizCore = isNode ? require('./quiz.js') : root.QuizCore;
  const FlowCore = isNode ? require('./flow.js') : root.FlowCore;
  const DataCore = isNode ? require('./data.js') : root.DataCore;
  if (!SchemaCore || !QuizCore || !FlowCore || !DataCore) {
    throw new Error('AttemptCore 依赖 SchemaCore / QuizCore / FlowCore / DataCore，加载顺序错了');
  }
  const api = factory(SchemaCore, QuizCore, FlowCore, DataCore);
  if (isNode) module.exports = api;
  root.AttemptCore = api;
})(typeof self !== 'undefined' ? self : this, function (SchemaCore, QuizCore, FlowCore, DataCore) {
  'use strict';

  const TYPES = ['单选', '多选', '判断', '简答'];
  /* 每类题型在界面上用哪种输入控件（视图层据此选 button / 多选按钮 / textarea） */
  const INPUT_KIND = { '单选': 'single', '多选': 'multi', '判断': 'judge', '简答': 'text' };
  const TYPE_LABEL = { '单选': '单选题', '多选': '多选题', '判断': '判断题', '简答': '简答题' };

  function lettersOf(v) { return QuizCore.toSet(v); }

  /* 某题"算不算已作答" —— 四类题型各有各的判据。
   * ⚠ 判断题**只认正误归一的结果**：早先还"先看有没有 A–H 字母"，于是 `'A'` 被判成已作答，
   *   而判分侧对 `'A'` 认不出正误 → 恒 0 分，还能躲过"未答"门禁（红队抓出的口径不一致）。 */
  function isAnswered(q, value) {
    if (!q) return false;
    if (q.type === '简答') return String(value == null ? '' : value).trim() !== '';
    if (q.type === '多选') return lettersOf(value).size > 0;
    if (q.type === '判断') return QuizCore.normalizeJudge(value) !== null;
    return lettersOf(value).size > 0;                       // 单选
  }

  /* 存进会话的规范化作答。
   * ⚠ 简答**原样保留**（含换行与缩进）—— 用户输入的多个要点本来就是分行的，
   *   这里若 trim 掉换行，后面的人工订正与"要点分行展示"就全乱了。 */
  function normalizeAnswer(q, value) {
    if (!q) return '';
    if (q.type === '简答') return String(value == null ? '' : value);
    if (q.type === '多选') return [...lettersOf(value)].sort().join('');
    if (q.type === '单选') return [...lettersOf(value)][0] || '';
    return String(value == null ? '' : value).trim();      // 判断：保留用户原文，归一在判分侧做
  }

  function createSession(opts) {
    const o = opts || {};
    const questions = Array.isArray(o.questions) ? o.questions.slice() : [];
    return {
      examId: o.examId || '', title: o.title || '未命名试卷',
      questions: questions, index: 0,
      answers: {},          // 题 id → 规范化作答
      checked: {},          // 题 id → true（已提交判分）
      results: {},          // 题 id → scoreOne 结果（可能是人工订正后的）
      manual: {},           // 题 id → { hits, score, note, at }  ← 人工订正痕迹（验收②）
      auto: {},             // 题 id → 自动判分留档（对照"自动 → 人工"）
      config: o.config || QuizCore.DEFAULT_CONFIG,   // ← 快捷面板改的就是**这一个引用**
      /* 答题计时（用户要求）：`ms` = 已累计毫秒，`paused` = 当前是否暂停。
       * 放在 session 里而不是视图里 —— 这样"刷新 / 继续这一轮"能接着走表（见 serialize/restore）。 */
      timer: { ms: 0, paused: false },
      finished: false, startedAt: o.startedAt || '', finishedAt: '', summary: null
    };
  }

  function current(session) {
    if (!session || !session.questions.length) return null;
    return session.questions[session.index] || null;
  }

  /* 作答（提交前可反复改）。提交过的题锁定 —— 想改要走 reset()。 */
  function answer(session, value) {
    const q = current(session);
    if (!q) return { ok: false, error: '没有当前题' };
    if (session.checked[q.id]) return { ok: false, error: '这一题已经提交过了', locked: true };
    session.answers[q.id] = normalizeAnswer(q, value);
    return { ok: true, stored: session.answers[q.id], session: session };
  }

  /* 解锁某题（人工订正/重做用）—— **必须连人工订正痕迹一起清掉**：
   * 只删 checked/results 而留着 manual，会让"解锁重做后重新提交"出现
   * "卡片显示 0 分、总分却按旧的人工分 5 分算"这种两处对不上的状态。 */
  function reset(session, index) {
    const i = (index == null) ? session.index : index;
    const q = session.questions[i];
    if (!q) return { ok: false, error: '题目下标越界' };
    delete session.checked[q.id]; delete session.results[q.id];
    const hadManual = !!session.manual[q.id];
    delete session.manual[q.id]; delete session.auto[q.id];
    if (session.finished) refreshSummary(session);
    return { ok: true, session: session, clearedManual: hadManual };
  }

  function goto(session, index) {
    if (!Number.isInteger(index) || index < 0 || index >= session.questions.length) {
      return { ok: false, error: '题目下标越界：' + index };
    }
    session.index = index;
    return { ok: true, session: session };
  }
  function next(session) { return goto(session, session.index + 1); }
  function prev(session) { return goto(session, session.index - 1); }

  /*
   * 提交当前题：判分 + 按**当前配置**决定"揭示什么、要不要自动翻页"。
   * 行为全部委托 FlowCore（唯一真相源）—— 界面层不许自己判断。
   */
  function submitCurrent(session, opts) {
    const o = opts || {};
    const q = current(session);
    if (!q) return { ok: false, error: '没有当前题' };
    if (session.checked[q.id] && !o.force) return { ok: false, error: '这一题已经提交过了', already: true };
    const a = session.answers[q.id];
    if (!isAnswered(q, a)) return { ok: false, error: '这一题还没作答', needAnswer: true };

    const result = QuizCore.scoreOne(q, a, session.config);
    session.checked[q.id] = true;
    session.results[q.id] = result;

    /* ⚠ 判分结果必须传给 flow：**没得全分不自动翻页**（要看正确答案）、**没得全分当场给答案**都靠它判。 */
    const judged = { correct: result.correct === true, score: result.score, full: result.full };
    const flow = FlowCore.afterSubmit(session.config, { answered: true, checked: true, finished: session.finished,
                                                        correct: judged.correct, score: judged.score, full: judged.full });
    const reveal = FlowCore.revealAt(session.config, { submitted: true, finished: session.finished,
                                                       correct: judged.correct, score: judged.score, full: judged.full });
    /* ⚠ 只有"立刻翻"（`waitMs === 0`）才由核心自己推进题号；
     *   配了等待时间（`behavior.autoNextMs > 0`）时核心**不动题号**，把 `delayed/waitMs` 交出去，
     *   由界面排一个定时器再调 `next()` —— 否则"等待时间"会被这里当场跳过（设了等于没设）。 */
    const wantsJump = flow.willJump;
    const immediateJump = wantsJump && flow.waitMs === 0;
    let advanced = false;
    if (immediateJump && session.index < session.questions.length - 1) { session.index++; advanced = true; }

    return { ok: true, result: result, flow: flow, reveal: reveal, advanced: advanced,
             delayed: wantsJump && flow.waitMs > 0, waitMs: wantsJump ? flow.waitMs : 0, session: session };
  }

  /*
   * 交卷前的校验：有未答题就**不能悄悄交卷** —— 要把题号列出来，
   * 由用户明确选择"返回继续"或"仍然交卷"（本函数只给数据，弹窗由界面画）。
   */
  function gate(session) {
    const unanswered = [];
    session.questions.forEach(function (q, i) {
      if (!isAnswered(q, session.answers[q.id])) {
        unanswered.push({ index: i, label: String(i + 1), id: q.id, type: q.type });
      }
    });
    const labels = unanswered.map(function (u) { return u.label; });
    return {
      ok: unanswered.length === 0,
      unanswered: unanswered, unansweredLabels: labels,
      message: unanswered.length
        ? ('还有 ' + unanswered.length + ' 题没有作答（第 ' + labels.join('、') + ' 题）')
        : ''
    };
  }

  /*
   * 题号索引模型：全部题号 + 作答状态，界面据此画格子。
   *   state：current（当前题） / answered / unanswered   —— 三个状态互斥，便于上色
   *   ⚠ `correct` 只在**答案已允许揭示**时才给值：
   *     时机=「整卷后」时，若在题号格里打勾叉，等于把每道题的对错提前漏出去。
   */
  function navModel(session) {
    return session.questions.map(function (q, i) {
      const answered = isAnswered(q, session.answers[q.id]);
      const checked = !!session.checked[q.id];
      const r = session.results[q.id];
      /* ⚠ 判分结果要传进去：**没得全分的题当场就能看答案**（用户要求"指出正确答案"），
       *   所以那一格的"已揭示/对错"也该跟着亮 —— 与题面给的答案保持一致，不两套口径。 */
      const reveal = FlowCore.revealAt(session.config, { submitted: checked, finished: session.finished,
                                                         correct: checked && r ? r.correct === true : null,
                                                         score: checked && r ? r.score : null,
                                                         full: checked && r ? r.full : null });
      return {
        index: i, label: String(i + 1),
        answered: answered, checked: checked, current: i === session.index,
        revealed: reveal.showAnswer,
        correct: (reveal.showAnswer && r) ? r.correct : null,
        state: (i === session.index) ? 'current' : (answered ? 'answered' : 'unanswered')
      };
    });
  }

  /* 交卷结算：整卷判分 + 等级定档（都用既有唯一真相源）。
   * 有未答题且没明确确认 → 不结算，返回 needConfirm（界面据此弹提示）。 */
  function finish(session, opts) {
    const o = opts || {};
    const g = gate(session);
    if (!g.ok && !o.confirmUnanswered) {
      return { ok: false, needConfirm: true, unanswered: g.unanswered,
               unansweredLabels: g.unansweredLabels, message: g.message, session: session };
    }
    const scored = QuizCore.scoreExam(session.questions, session.answers, session.config, { manual: session.manual });
    const grade = FlowCore.gradeLevel(scored.percent, session.config);
    session.finished = true;
    session.finishedAt = o.now || '';
    session.summary = buildSummary(session, g.unansweredLabels, !g.ok);
    return { ok: true, summary: session.summary, session: session };
  }

  /* 作答的**给人看**的写法（回看时显示"你答了什么"） */
  function displayAnswer(q, value) {
    if (!q) return '';
    if (q.type === '简答') return String(value == null ? '' : value);          // 多行原样
    if (q.type === '多选') { const s = [...lettersOf(value)].sort(); return s.length ? s.join('、') : ''; }
    if (q.type === '单选') return [...lettersOf(value)][0] || '';
    const v = QuizCore.normalizeJudge(value);
    if (v === true) return '对（√）';
    if (v === false) return '错（×）';
    return String(value == null ? '' : value).trim();                          // 认不出来的照原文显示
  }

  /*
   * 交卷后的**逐题回看**模型（验收③：交卷后可逐题回看，显示用户作答、正确答案与得分）。
   * 未提交的题也一并给出（按 0 分算），并在 answered 上标出来 —— 回看时"漏答了哪题"必须一眼看见。
   */
  function reviewList(session) {
    if (!session.finished) return [];
    return session.questions.map(function (q, i) {
      const a = session.answers[q.id];
      const answered = isAnswered(q, a);
      const man = session.manual[q.id] || null;
      // 回退计算也要带人工口徑：否则"有 manual 但 results 还没算过"的题会显出自动分，
      // 与整卷总分（按 manual 算）分叉。
      const r = session.results[q.id] || QuizCore.scoreOne(q, a, session.config,
        man ? { manualHits: man.hits, manualScore: man.score } : null);
      return {
        index: i, label: String(i + 1), id: q.id,
        type: q.type, typeLabel: TYPE_LABEL[q.type] || q.type, kind: INPUT_KIND[q.type] || 'text',
        stem: q.stem || '',
        answered: answered,
        userAnswer: answered ? displayAnswer(q, a) : '',
        userRaw: a == null ? '' : String(a),
        correctAnswer: answerText(q),
        correct: !!r.correct, score: r.score, full: r.full,
        // 人工订正痕迹（验收②）：能区分哪些题被订正过，并保留自动分做对照
        manual: man, manualScore: man ? r.score : null,
        autoScore: session.auto[q.id] ? session.auto[q.id].score : null,
        autoDetail: session.auto[q.id] ? session.auto[q.id].detail : null,
        detail: r.detail || {}, explanation: q.explanation || '',
        unscorable: (r.detail && r.detail.unscorable) || null,
        cfgWarn: r.cfgWarn || null
      };
    });
  }

  /*
   * 交卷后的**成绩单**模型：总分统计 + 等级定档 + 分数线 + 按题型汇总。
   * 全部数值都取自既有两个真相源（scoreExam / FlowCore.gradeLevel），本函数只做编排。
   */
  function resultModel(session) {
    const s = session.summary;
    if (!session.finished || !s) return null;
    const grade = FlowCore.gradeLevel(s.percent, session.config);
    const byType = {};
    (s.per || []).forEach(function (p) {
      const t = p.type || '未知';
      if (!byType[t]) byType[t] = { type: t, total: 0, score: 0, full: 0, correct: 0 };
      byType[t].total++; byType[t].score += p.score; byType[t].full += p.full;
      if (p.correct) byType[t].correct++;
    });
    const round1 = function (v) { return Math.round(v * 10) / 10; };
    return {
      title: session.title,
      score: s.score, full: s.full, percent: s.percent, level: s.level,
      correctCount: s.correctCount, total: s.total,
      answered: s.answered, skipped: s.skipped || [], forced: !!s.forced,
      manualCount: s.manualCount || 0, manualLabels: s.manualLabels || [],
      pass: grade.pass, excellent: grade.excellent,
      toPass: grade.toPass, toExcellent: grade.toExcellent, note: grade.note,
      bands: FlowCore.gradeBands(session.config),
      byType: Object.keys(byType).map(function (t) {
        const x = byType[t];
        return { type: t, total: x.total, correct: x.correct, score: round1(x.score), full: round1(x.full),
                 rate: x.full ? Math.round((x.score / x.full) * 1000) / 10 : 0 };
      })
    };
  }

  /* ============================================================
   *  进度暂存与恢复
   * ============================================================ */

  const PROGRESS_VERSION = 1;
  /* 进度键：走既有的"按试卷分命名空间"的键前缀规则（**不手拼字符串**），
   * 于是删卷时的 purgeExam 会一并把它清掉，不会留孤儿。
   * ⚠ 键规则住在 core/data.js（DataCore.examSubKey），不是 schema —— 别挂错模块。
   *
   * `roundTag`：**同一套卷可以有好几轮**（答整卷 / 按设置抽一轮 / 换一批再抽）。
   * 它们的题目集合不同，共用一个键就会互相覆盖（"抽一轮"答到一半去答整卷，
   * 两边的进度会彼此判为"不适用"并覆盖掉对方）。所以轮次不同 → 子键不同：
   *   不带 tag → `…::progress`（老键，独立单页/整卷默认走它，**向后兼容**）
   *   带 tag   → `…::progress-<tag>`（tag 由调用方给，取"这一轮抽中的题"的指纹）
   * 两者都在 `exam::<id>::` 前缀下 → 删卷照样按前缀清理（scanOrphans 也把 exam 子键整体排除）。 */
  function progressKey(examId, roundTag) {
    const tag = (roundTag == null) ? '' : String(roundTag);
    return DataCore.examSubKey(examId || '', tag ? ('progress-' + tag) : 'progress');
  }

  /* 序列化：只存"用户产生的东西"（作答、当前题号、已提交标记、配置），
   * **不存题目本体** —— 题从试卷来，进度只是覆盖在它上面的状态。 */
  function serializeProgress(session, opts) {
    const o = opts || {};
    return {
      v: PROGRESS_VERSION,
      examId: session.examId || '',
      title: session.title || '',
      index: session.index,
      answers: Object.assign({}, session.answers),
      checked: Object.assign({}, session.checked),
      // 人工订正痕迹也要跟着走：否则"订正过 → 刷新"会**悄悄丢掉改判**，
      // 而 checked 还在（回看卡片会拿自动分给人看，和用户刚做的订正对不上）。
      manual: JSON.parse(JSON.stringify(session.manual || {})),
      auto: JSON.parse(JSON.stringify(session.auto || {})),
      config: session.config ? QuizCore.snapshotConfig(session.config) : null,
      questionIds: session.questions.map(function (q) { return q.id; }),
      startedAt: session.startedAt || '',
      /* 答题计时随进度走：刷新（或「继续这一轮」）之后接着走表，而不是从 0 重新计。
       * 只存数字与暂停标记 —— 不存"表是什么时候开的"（那是运行时的东西，存了也会过期）。 */
      timer: {
        ms: (session.timer && isFinite(session.timer.ms)) ? Math.max(0, Math.round(session.timer.ms)) : 0,
        paused: !!(session.timer && session.timer.paused)
      },
      savedAt: o.now || ''
    };
  }

  /* 载荷体检：版本/结构/卷子是否还是同一份。任何一项不对 → 明确拒绝，**绝不半信半疑地套用**。 */
  function checkProgress(payload, questions) {
    if (!payload || typeof payload !== 'object') return { ok: false, reason: 'empty', message: '没有进度数据' };
    if (payload.v !== PROGRESS_VERSION) {
      return { ok: false, reason: 'version', message: '进度版本不匹配（' + payload.v + ' ≠ ' + PROGRESS_VERSION + '），已忽略旧进度' };
    }
    if (!payload.answers || typeof payload.answers !== 'object') return { ok: false, reason: 'shape', message: '进度数据缺少作答内容' };
    const ids = (questions || []).map(function (q) { return q.id; });
    const old = Array.isArray(payload.questionIds) ? payload.questionIds : [];
    // 卷子变过（加题/删题/重导入）→ 旧作答的下标与题 id 可能对不上，宁可从头开始也不套错
    const same = old.length === ids.length && old.every(function (id, i) { return id === ids[i]; });
    if (!same) return { ok: false, reason: 'paper-changed', message: '试卷内容变了，上一轮的进度不再适用（已从新一轮开始）' };
    return { ok: true };
  }

  /* 把进度套回会话（只认这张卷子自己的题 id，多出来的键一律丢掉，防止脏数据进会话） */
  function restoreProgress(session, payload, opts) {
    const c = checkProgress(payload, session.questions);
    if (!c.ok) return { ok: false, reason: c.reason, message: c.message };
    const valid = {};
    session.questions.forEach(function (q) { valid[q.id] = 1; });
    // ⚠ 顺序是硬约束：**先落配置，再算每题结果**。
    //   反过来的话 results 会用"恢复前的出厂配置"算（例如分值 2），
    //   而整卷总分用的是恢复后的配置（分值 5）—— 同一题卡片 2/2、总分 5/5，两处对不上。
    if (payload.config && (opts == null || opts.applyConfig !== false)) session.config = QuizCore.mergeConfig(payload.config);
    let answers = 0, checked = 0, dropped = 0;
    Object.keys(payload.answers).forEach(function (id) {
      if (!valid[id]) { dropped++; return; }
      session.answers[id] = payload.answers[id];
      answers++;
    });
    Object.keys(payload.checked || {}).forEach(function (id) {
      if (!valid[id] || !payload.checked[id]) return;
      session.checked[id] = true;
      checked++;
    });
    // 再恢复人工订正，最后据此重算 results —— 顺序反了会把人工分冲成自动分
    Object.keys(payload.manual || {}).forEach(function (id) {
      if (!valid[id]) return;
      session.manual[id] = payload.manual[id];
    });
    Object.keys(payload.auto || {}).forEach(function (id) {
      if (!valid[id]) return;
      session.auto[id] = payload.auto[id];
    });
    // 重算范围是 **checked ∪ manual**：只遍历 checked 的话，一份"有 manual 但没有 checked"
    // 的载荷（手改/第三方写的）会留下"卡片按自动分、总分按人工分"的分叉。
    const needRecompute = {};
    Object.keys(session.checked).forEach(function (id) { needRecompute[id] = 1; });
    Object.keys(session.manual).forEach(function (id) { needRecompute[id] = 1; });
    Object.keys(needRecompute).forEach(function (id) {
      const q = session.questions.filter(function (x) { return x.id === id; })[0];
      if (!q) return;
      const mo = session.manual[id];
      session.results[id] = QuizCore.scoreOne(q, session.answers[id], session.config,
        mo ? { manualHits: mo.hits, manualScore: mo.score } : null);
    });
    if (Number.isInteger(payload.index)) {
      session.index = Math.min(Math.max(0, payload.index), Math.max(0, session.questions.length - 1));
    }
    session.startedAt = payload.startedAt || session.startedAt;
    /* 答题计时接着走（旧载荷没有 timer 字段 → 保持 0，不会把"没计过时"的轮次算成计过） */
    if (payload.timer && typeof payload.timer === 'object' && isFinite(payload.timer.ms)) {
      session.timer = { ms: Math.max(0, Math.round(payload.timer.ms)), paused: !!payload.timer.paused };
    }
    return { ok: true, restored: { answers: answers, checked: checked, index: session.index, dropped: dropped,
                                  timerMs: session.timer ? session.timer.ms : 0 } };
  }

  /*
   * 进度存取适配器：**存储不可用就降级内存态并如实报告**，绝不让"存不上"影响本轮答题。
   *   save/load/clear 都是异步（存储后端可能是 IndexedDB 风格）
   *   mode() → 'storage' | 'memory'；isDegraded() → 是否已降级；lastError() → 降级原因
   */
  function createProgressStore(store, opts) {
    const o = opts || {};
    const key = progressKey(o.examId || '', o.roundTag);
    const mem = new Map();
    let mode = store ? 'storage' : 'memory';
    let lastError = store ? null : { name: 'NoStore', message: '没有可用的本地存储' };

    const degrade = function (e) {
      mode = 'memory';
      lastError = { name: (e && e.name) || 'Error', message: (e && e.message) || String(e) };
    };
    const notice = function () {
      return mode === 'storage' ? '' :
        '无法保存作答进度（' + (lastError ? lastError.message : '存储不可用') + '）：本轮照常答题与判分，但刷新后会丢失。';
    };

    return {
      key: key,
      mode: function () { return mode; },
      isDegraded: function () { return mode === 'memory'; },
      lastError: function () { return lastError; },
      notice: notice,
      async save(session, o2) {
        const payload = serializeProgress(session, o2 || {});
        if (mode === 'storage') {
          try {
            const r = await store.set(key, payload);
            return { ok: true, where: (r && r.where) || 'small', bytes: (r && r.bytes) || 0,
                     degraded: false, notice: '', payload: payload };
          } catch (e) { degrade(e); }
        }
        mem.set(key, QuizCore.snapshotConfig(payload));
        return { ok: false, degraded: true, where: 'memory', notice: notice(), payload: payload };
      },
      async load(questions) {
        let payload = null;
        if (mode === 'storage') {
          try { payload = await store.get(key); }
          catch (e) { degrade(e); }
        }
        if (payload == null && mem.has(key)) payload = mem.get(key);
        if (payload == null) return { ok: false, reason: 'empty', degraded: mode === 'memory', notice: notice(), payload: null };
        const c = checkProgress(payload, questions);
        if (!c.ok) return { ok: false, reason: c.reason, message: c.message, degraded: mode === 'memory', notice: notice(), payload: payload };
        return { ok: true, payload: payload, degraded: mode === 'memory', notice: notice() };
      },
      async clear() {
        mem.delete(key);
        if (mode === 'storage') {
          try { await store.del(key); return { ok: true, degraded: false, notice: '' }; }
          catch (e) { degrade(e); }
        }
        return { ok: true, degraded: mode === 'memory', notice: notice() };
      }
    };
  }

  /* ============================================================
   *  人工订正（简答改判）
   * ============================================================ */

  /* 整卷结算的唯一入口：finish 与"交卷后改判重算"都走它 —— 避免两套算法。 */
  function buildSummary(session, skippedLabels, forced) {
    const scored = QuizCore.scoreExam(session.questions, session.answers, session.config, { manual: session.manual });
    const grade = FlowCore.gradeLevel(scored.percent, session.config);
    const labels = skippedLabels || [];
    return {
      score: scored.score, full: scored.full, percent: scored.percent, level: grade.level,
      correctCount: scored.correctCount, total: scored.total,
      answered: session.questions.length - labels.length,
      unanswered: labels.length ? labels.map(function (lb) {
        const q = session.questions[Number(lb) - 1];
        return q ? q.id : lb;
      }) : [],
      skipped: labels, forced: !!forced,
      manualCount: Object.keys(session.manual).length,
      manualLabels: Object.keys(session.manual).map(function (id) {
        const i = session.questions.map(function (q) { return q.id; }).indexOf(id);
        return i >= 0 ? String(i + 1) : id;
      }).sort(function (a, b) { return Number(a) - Number(b); }),
      per: scored.per, grade: grade
    };
  }

  function refreshSummary(session) {
    if (!session.finished) return null;
    const g = gate(session);
    session.summary = buildSummary(session, g.unansweredLabels, session.summary ? session.summary.forced : false);
    return session.summary;
  }

  /*
   * 人工订正一道**简答题**。两种改法（可单用也可合用）：
   *   hits: ['关键词', …]  → 把某些关键词标为"命中"（之后的算分仍走 scoreOne 的同一套公式）
   *   score: 4.5           → 直接给分（覆盖自动算分，含"没有关键词"的题；仍受满分与半步粒度约束）
   * 只动这一题：其他题的 results / per 明细**逐字段不变**（测试里钉死）。
   * 自动分留档在 session.auto[id]，界面上对照展示"自动 3.5 → 人工 5"。
   */
  function applyManual(session, index, patch) {
    const q = session.questions[index];
    if (!q) return { ok: false, error: '题目下标越界：' + index };
    if (q.type !== '简答') return { ok: false, error: '只有简答题需要人工订正（' + q.type + ' 由客观规则判分）' };
    const p = patch || {};
    // **没作答的题不给订正**：否则成绩单会同时说"第 2 题未答"又"第 2 题人工订正"
    // 并把它的分数算进总分（自相矛盾）。要让空白题得分，请先补上作答。
    if (!isAnswered(q, session.answers[q.id])) {
      return { ok: false, error: '这一题还没作答，无法订正（请先作答，或直接跳过）', needAnswer: true };
    }
    // 区分"没给 hits"（undefined）与"明确给了一个空数组"（= 取消全部人工命中）
    const hasHits = Array.isArray(p.hits);
    const hits = hasHits ? p.hits.filter(function (t) { return typeof t === 'string' && t; }) : [];
    const score = (typeof p.score === 'number' && isFinite(p.score)) ? p.score : null;
    if (!hasHits && score == null) return { ok: false, error: '改判要么标记某个关键词命中，要么直接给分' };
    // 取消最后一个人工命中（hits 空、又没指定分数）→ 等价于**撤销订正**，
    // 早先这里会被当成"空改判"直接拒绝，界面点了没反应（静默失败）。
    if (hasHits && !hits.length && score == null) {
      if (!session.manual[q.id]) return { ok: false, error: '这道题本来就没有人工订正' };
      const cleared = clearManual(session, index);
      return { ok: true, session: session, cleared: true, manual: null, auto: cleared.auto, after: session.results[q.id] };
    }
    if (!session.auto[q.id]) {
      const a0 = QuizCore.scoreOne(q, session.answers[q.id], session.config);
      session.auto[q.id] = { score: a0.score, full: a0.full, correct: a0.correct, detail: a0.detail };
    }
    const before = session.results[q.id] || session.auto[q.id];
    session.manual[q.id] = { hits: hits, score: score, note: String(p.note == null ? '' : p.note), at: p.at || '' };
    session.checked[q.id] = true;                       // 订正过的题算已判分
    session.results[q.id] = QuizCore.scoreOne(q, session.answers[q.id], session.config,
      { manualHits: hits, manualScore: score });
    if (session.finished) refreshSummary(session);      // 已交卷 → 总分/百分比/等级**同步重算**
    return { ok: true, session: session, manual: session.manual[q.id],
             auto: session.auto[q.id], before: before, after: session.results[q.id] };
  }

  /* 撤销改判：回到自动判分（痕迹一并抹掉，不留"改过但看不出改了什么"的中间态） */
  function clearManual(session, index) {
    const q = session.questions[index];
    if (!q) return { ok: false, error: '题目下标越界：' + index };
    if (!session.manual[q.id]) return { ok: false, error: '这道题没有人工订正记录' };
    delete session.manual[q.id];
    // **一律**按自动口径重算，不看 auto 留档在不在：
    // 万一载荷里只有 manual 没有 auto（手改过的旧进度），按老条件会留着人工分。
    session.results[q.id] = QuizCore.scoreOne(q, session.answers[q.id], session.config);
    if (!session.checked[q.id] && !isAnswered(q, session.answers[q.id])) delete session.results[q.id];
    if (session.finished) refreshSummary(session);
    return { ok: true, session: session, auto: session.auto[q.id] || null };
  }

  function manualCount(session) { return Object.keys(session.manual).length; }

  function progress(session) {
    const qs = session.questions;
    let answered = 0, checked = 0;
    qs.forEach(function (q) {
      if (isAnswered(q, session.answers[q.id])) answered++;
      if (session.checked[q.id]) checked++;
    });
    return { index: session.index, total: qs.length, answered: answered, checked: checked,
             unanswered: qs.length - answered, percent: qs.length ? Math.round((answered / qs.length) * 100) : 0 };
  }

  /* 答案文本 —— **委托计分层**（唯一实现在 quiz.js：题型知识属于那里）。
   * 保留这个名字是为了兼容既有调用方；返回值与 `QuizCore.answerText(q)` 恒等。 */
  function answerText(q) {
    return QuizCore.answerText(q);
  }

  /*
   * 渲染模型：视图层只按这个画，不做任何判断。
   * ⚠ `answerText/explain/detail` 只在 FlowCore 说"可以揭示"时才非空 ——
   *   这是"答题期间不泄露答案"落到界面上的唯一出口。
   */
  function view(session) {
    const q = current(session);
    const submitted = !!(q && session.checked[q.id]);
    const r = q ? session.results[q.id] : null;
    /* ⚠ 判分结果要传：**没得全分**的题当场就能看正确答案（用户要求），与展示时机无关。 */
    const reveal = FlowCore.revealAt(session.config, { submitted: submitted, finished: session.finished,
                                                       correct: (submitted && r) ? r.correct === true : null,
                                                       score: (submitted && r) ? r.score : null,
                                                       full: (submitted && r) ? r.full : null });
    const st = progress(session);
    return {
      title: session.title, finished: session.finished,
      index: session.index, total: session.questions.length,
      progressText: st.total ? ('第 ' + (st.index + 1) + ' / ' + st.total + ' 题') : '没有题目',
      progress: st,
      question: q ? {
        id: q.id, type: q.type, typeLabel: TYPE_LABEL[q.type] || q.type, kind: INPUT_KIND[q.type] || 'text',
        stem: q.stem || '',
        options: (q.options || []).map(function (o) { return { label: o.label, text: o.text }; }),
        value: session.answers[q.id] || '',
        multi: q.type === '多选'
      } : null,
      submitted: submitted,
      lockAnswer: submitted,                        // 提交后锁定输入
      canSubmit: !!q && !submitted && isAnswered(q, session.answers[q.id]),
      canPrev: session.index > 0,
      canNext: session.index < session.questions.length - 1,
      revealed: reveal.showAnswer,                  // ← 这两个才是"能不能看见答案"
      showExplain: reveal.showExplain,
      /* ⚠ 下面三项**只在允许揭示时**才给值：界面要用它们给选项标"对/错"（用户要求），
       *   但提前给就等于把答案画在选项上了 —— 泄题。所以和 answerText 同一个门槛。 */
      answerLetters: (reveal.showAnswer && q && Array.isArray(q.answerLetters)) ? q.answerLetters.slice() : null,
      judgeTrue: (reveal.showAnswer && q && typeof q.judgeValue === 'boolean') ? q.judgeValue : null,
      answerText: reveal.showAnswer ? answerText(q) : '',
      explain: (reveal.showExplain && q && q.explanation) ? q.explanation : '',
      detail: (reveal.showAnswer && r) ? r.detail : null,
      score: (submitted && r) ? { score: r.score, full: r.full, correct: r.correct } : null,
      revealReason: reveal.showAnswer ? '' : (reveal.reasons || []).join('；')
    };
  }

  /* 快捷面板改参数：换掉会话里那**一个**配置引用 —— 下一题立刻按新设置走，不用离开当前页 */
  function setConfig(session, nextConfig) {
    if (!nextConfig) return { ok: false, error: '配置为空' };
    session.config = nextConfig;
    return { ok: true, session: session, policy: FlowCore.revealPolicy(nextConfig) };
  }

  return {
    TYPES: TYPES, INPUT_KIND: INPUT_KIND, TYPE_LABEL: TYPE_LABEL,
    isAnswered: isAnswered, normalizeAnswer: normalizeAnswer, answerText: answerText,
    createSession: createSession, current: current,
    answer: answer, reset: reset, goto: goto, next: next, prev: prev,
    submitCurrent: submitCurrent, finish: finish, progress: progress, view: view, setConfig: setConfig,
    navModel: navModel, gate: gate,
    displayAnswer: displayAnswer, reviewList: reviewList, resultModel: resultModel,
    PROGRESS_VERSION: PROGRESS_VERSION, progressKey: progressKey,
    serializeProgress: serializeProgress, checkProgress: checkProgress, restoreProgress: restoreProgress,
    createProgressStore: createProgressStore,
    applyManual: applyManual, clearManual: clearManual, manualCount: manualCount, refreshSummary: refreshSummary
  };
});
