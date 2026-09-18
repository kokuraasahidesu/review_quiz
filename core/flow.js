/* ============================================================
 *  core/flow.js —— 答题流程的"行为开关与展示时机"纯逻辑
 *
 *  为什么单独一层：这三件事一旦散在界面代码里，最容易出的错就是
 *    · 答案在"整卷后"模式下被某一处忘了拦 → **答题期间泄露答案**
 *    · "自动检查/自动翻页"关掉了，某一处却还在自动跳
 *    · 分数线改了，某个页面还按老线定档
 *  所以把它们做成**无副作用、可枚举**的纯函数，界面只问它"现在该做什么"。
 *
 *  职责：
 *    · revealPolicy / revealAt  —— 答案与解析的展示时机（答完一题 / 整卷后）
 *    · afterSubmit              —— 提交一题之后：要不要判分 / 揭示 / 翻页（单一真相源）
 *    · gradeLevel / gradeBands  —— 分数线与等级定档（委托 QuizCore.levelOf，不另写一份）
 *    · countControl 等          —— 底部快捷面板的"大脑"：题量加减、按分数定义、分数线、开关
 *
 *  依赖：core/quiz.js（QuizCore）—— 校验与合并一律复用 applyConfigPatch，
 *        绝不在这一层自己写一份"什么值合法"。
 * ============================================================ */
(function (root, factory) {
  const isNode = (typeof module !== 'undefined' && module.exports);
  const QuizCore = isNode ? require('./quiz.js') : root.QuizCore;
  if (!QuizCore) throw new Error('FlowCore 依赖 QuizCore（core/quiz.js），加载顺序错了');
  const api = factory(QuizCore);
  if (isNode) module.exports = api;
  root.FlowCore = api;
})(typeof self !== 'undefined' ? self : this, function (QuizCore) {
  'use strict';

  const DEFAULT = QuizCore.DEFAULT_CONFIG;

  /* 展示时机：二选一。**未知值一律落回 'end'（最不泄露的那一侧）** ——
   * 宁可"该显示时没显示"（用户再点一次），也绝不猜成 'each' 把答案提前漏出去。
   * ⚠ 内置默认已改成 'each'（用户要求"答完一题就显示"），但那是**默认值**，
   *   不是"未知值兜底"：坏值仍然落回不泄露的一侧。 */
  const REVEAL_VALUES = ['each', 'end'];
  const REVEAL_LABELS = { each: '答完一题即显示', end: '整卷结束后显示' };
  const DEFAULT_REVEAL = 'end';

  const BASIS_VALUES = ['count', 'score'];
  const BASIS_LABELS = { count: '按题量', score: '按目标总分' };
  /* 抽题规则四选一。**「全部作答」排第一**（默认）——
   * 不抽题、整套卷都做，是"我就是要做这套卷"最直白的表达；
   * 另三条都是"手动分配/自动配比"式的抽题：byCount = 每个题型几**题**，byWeight = 每个题型多少**分**。 */
  const PICK_MODE_LABELS = { all: '全部作答', byCount: '按题型数量', byWeight: '按题型总分', random: '完全随机' };
  const TYPE_KEYS = QuizCore.TYPE_KEYS;              // ['单选','多选','判断','简答']（与题型知识同一处）

  const GRADE_LEVELS = ['优秀', '及格', '不及格'];

  /* 自动翻页的**等待时间**（毫秒）：0 = 点完立刻翻。
   * 上界取自 QuizCore（与配置字段模型共用同一个数，避免"配置说合法、界面悄悄截断"）。 */
  const AUTO_NEXT_MS_MAX = QuizCore.AUTO_NEXT_MS_MAX || 5000;
  /* 自动翻页等待时间的**默认值**：与配置模型里的内置默认**同一个来源**（不许各写一份）。
   * 用户指定默认 1.5 秒（"看一眼 ✓/对错再走"）；改默认只改 quiz.js 那处。 */
  const AUTO_NEXT_MS_DEFAULT = (function () {
    const b = QuizCore.DEFAULT_CONFIG && QuizCore.DEFAULT_CONFIG.behavior;
    const v = b ? b.autoNextMs : null;
    return (typeof v === 'number' && isFinite(v) && v >= 0) ? v : 0;
  })();
  /* 面板上的预设档。用户要求"再设置一个比较小的时间" → 在「立刻」与「0.5 秒」之间补了 **0.2 秒**：
   * 「立刻」是 0（没有等待窗口、连加载条都看不到），0.5 秒对想快点过题的人又偏慢，中间这一档正好。
   * 顺序必须是升序（面板按数组顺序画按钮）。 */
  const AUTO_NEXT_MS_PRESETS = [0, 200, 500, 1000, 1500, 2000];
  const AUTO_NEXT_MS_LABELS = { 0: '立刻', 200: '0.2 秒', 500: '0.5 秒', 1000: '1 秒', 1500: '1.5 秒', 2000: '2 秒' };

  function revealCfg(cfg) { return (cfg && cfg.reveal) || DEFAULT.reveal; }
  function behaviorCfg(cfg) { return (cfg && cfg.behavior) || DEFAULT.behavior; }
  function gradeCfg(cfg) { return (cfg && cfg.grade) || DEFAULT.grade; }
  function pickCfg(cfg) { return (cfg && cfg.pick) || DEFAULT.pick; }
  function timingOf(v) { return REVEAL_VALUES.indexOf(v) >= 0 ? v : DEFAULT_REVEAL; }
  function numOr(v, dft) { return (typeof v === 'number' && isFinite(v)) ? v : dft; }
  /* 分数是 0.5 的整数倍，加减之后仍可能出现 39.999999999999996 这种浮点毛刺 → 统一抹平 */
  function round2(v) { return Math.round((numOr(v, 0)) * 100) / 100; }
  /*
   * "这一题**得全分**了吗"（用户要求：得全分之后才自动跳转）。
   * 三态：true 全分 / false 没得全分 / null 还不知道（没判分）。
   * 判据（任一为真即算全分）：
   *   ① 调用方直接给 `perfect`（界面上已经算好的）；
   *   ② 引擎的 `correct === true`（全对 / 关键词全命中）；
   *   ③ 分数确实到了满分（`score >= full`，且 full 为正）。
   * ⚠ 只有"已判分"才可能返回 false —— 没判分时返回 null，调用方据此**沿用"答完就翻"的老规矩**
   *   （用户之前明确要求过"自动翻页不必等判分"；跳 ≠ 判）。
   */
  function perfectOf(ctx) {
    const c = ctx || {};
    if (c.perfect === true) return true;               // 调用方显式给了就以它为准
    if (c.perfect === false) return false;
    if (c.correct === true) return true;
    const s = (typeof c.score === 'number' && isFinite(c.score)) ? c.score : null;
    const f = (typeof c.full === 'number' && isFinite(c.full)) ? c.full : null;
    if (s !== null && f !== null && f > 0 && s >= f) return true;
    if (c.correct === false || (s !== null && f !== null)) return false;
    return null;
  }

  /* 自动翻页等待时间：非法值（NaN / 负数 / 超上界 / 非整数）一律落回**默认值**（现在是 1.5 秒），
   * 并在 fallback 里点名。为什么落回默认而不是"立刻翻"：默认值本身就是"等一会儿"，落回它才不会
   * 让一个坏字段把节奏改成另一种极端；而且 1.5 秒短到不可能看起来像卡住。
   * `null`/没写 = "就是没配"，不算非法（不点名）。 */
  function autoNextDelay(cfg) {
    const b = behaviorCfg(cfg);
    const raw = (b && b.autoNextMs != null) ? b.autoNextMs : AUTO_NEXT_MS_DEFAULT;
    const ok = (typeof raw === 'number' && isFinite(raw) && raw >= 0 && raw <= AUTO_NEXT_MS_MAX &&
                Math.floor(raw) === raw);
    return {
      ms: ok ? raw : AUTO_NEXT_MS_DEFAULT,
      raw: raw,
      fallback: ok ? null : ('behavior.autoNextMs=' + JSON.stringify(raw)),
      custom: ok && AUTO_NEXT_MS_PRESETS.indexOf(raw) < 0,   // 不是面板上的预设值（手改过）
      presets: AUTO_NEXT_MS_PRESETS.slice(),
      labels: AUTO_NEXT_MS_LABELS,
      max: AUTO_NEXT_MS_MAX,
      /* 简短说法（"1.5 秒" / "立刻"）：写进提示语时不跟"后再翻"叠成别扭的句子 */
      labelShort: (function () {
        const ms = ok ? raw : AUTO_NEXT_MS_DEFAULT;
        return ms === 0 ? '立刻' : (AUTO_NEXT_MS_LABELS[ms] || (ms / 1000 + ' 秒'));
      })(),
      label: (function () {
        const ms = ok ? raw : AUTO_NEXT_MS_DEFAULT;
        if (ms === 0) return '立刻翻';
        return (AUTO_NEXT_MS_LABELS[ms] || (ms / 1000 + ' 秒')) + '后再翻';
      })()
    };
  }
  /* 浅合并两个 opts（只用来给内部调用加上 basis 覆盖） */
  function merge(a, b) {
    const o = {}; const src = [a || {}, b || {}];
    src.forEach(function (s) { Object.keys(s).forEach(function (k) { o[k] = s[k]; }); });
    return o;
  }

  /* ============================================================
   *  展示时机
   * ============================================================ */

  /* 当前生效的展示时机（未知值会被落回 end，并在 fallback 里点名，不静默）
   * ⚠ `null` 按"没写"处理（与三层取值的既有语义一致）：那是默认值，不是非法值，不该报警。*/
  function revealPolicy(cfg) {
    const r = revealCfg(cfg);
    const fallback = [];
    if (r.answerTiming != null && REVEAL_VALUES.indexOf(r.answerTiming) < 0) fallback.push('reveal.answerTiming=' + JSON.stringify(r.answerTiming));
    if (r.explainTiming != null && REVEAL_VALUES.indexOf(r.explainTiming) < 0) fallback.push('reveal.explainTiming=' + JSON.stringify(r.explainTiming));
    const answer = timingOf(r.answerTiming), explain = timingOf(r.explainTiming);
    return {
      answer: answer, explain: explain,
      answerLabel: REVEAL_LABELS[answer], explainLabel: REVEAL_LABELS[explain],
      answerEach: answer === 'each', explainEach: explain === 'each',
      // 解析比答案先出现 = 变相把答案漏了，所以"解析能否显示"要额外看答案这一侧
      explainGatedByAnswer: explain === 'each' && answer !== 'each',
      fallback: fallback,
      summary: '答案：' + REVEAL_LABELS[answer] + '；解析：' + REVEAL_LABELS[explain]
    };
  }

  /*
   * 此刻界面上该不该出现答案 / 解析。
   * ctx = { submitted: 这一题是否已判分, finished: 整卷是否已结束（交卷/时间到）,
   *         correct: 判分结果（true 对 / false 错 / null 还没判或不知道） }
   *
   * 四条硬规则：
   *   ① 未判分的题**永远**不显示答案 —— 显示了等于送答案
   *   ② 时机选 'end' 时，答题期间（未 finished）**一律不显示**，哪怕已经判分
   *   ③ 解析不得早于答案（解析里往往直接写着答案）
   *   ④ **没得全分必须当场给出正确答案**（用户要求："判分选错时要指出正确答案" + "得全分之后再自动跳转"）——
   *      这是规则②的**唯一例外**，而且是"用户已经答错/没答全、正需要看到正确答案"的场合，
   *      不是泄露（他不可能再利用它答这一题）。没判分时 perfect=null，规则①照样生效。
   */
  function revealAt(cfg, ctx) {
    const c = ctx || {};
    const pol = revealPolicy(cfg);
    const finished = (c.finished === true) || (c.phase === 'finished');
    // 'reviewing' = 本题已提交、正停在本题上（整卷还没结束）
    const submitted = (c.submitted === true) || (c.phase === 'reviewing');

    let answer = false;
    if (finished) answer = true;                       // 整卷结束：一律可看
    else if (submitted && pol.answerEach) answer = true;
    /* 规则④：已判分且没得全分 → 不管时机，当场给出正确答案 */
    const notPerfect = submitted && !finished && (perfectOf(c) === false);
    if (notPerfect) answer = true;

    let explainWanted = false;
    if (finished) explainWanted = true;
    else if (submitted && pol.explainEach) explainWanted = true;

    const explain = explainWanted && answer;           // 规则③
    const reasons = [];
    if (!answer && !finished) {
      reasons.push(submitted
        ? '当前时机是「整卷结束后显示」，答题期间不显示答案'
        : '这一题还没判分，不能显示答案');
    }
    if (explainWanted && !explain) reasons.push('答案还没显示，解析不会先出现');

    return {
      answer: answer, explain: explain,
      wrong: notPerfect,                               // 界面可据此说"没得全分，正确答案给你看"
      answerLabel: pol.answerLabel, explainLabel: pol.explainLabel,
      policy: pol,
      // 供界面直接用的"要不要显示答案区/解析区"
      showAnswer: answer, showExplain: explain,
      reasons: reasons
    };
  }

  /*
   * 提交/作答一题之后该做什么 —— **整个答题流程的唯一真相源**。
   * ctx = { answered:这一题用户是否已作答, checked:是否已判分, finished:整卷是否结束,
   *         correct:判分结果（true 对 / false 错 / null 没判或不知道） }
   *
   * 语义（随界面去掉「提交本题」按钮一起收紧）：
   *   · autoCheck 开 → 答完立刻判分（actions 里有 check）
   *   · autoCheck 关 → 不自动判分（needsManualSubmit；界面没有提交按钮了，留给"离开该题/交卷"）
   *   · autoNext  开 → **答完且"得全分"才跳**（`answered && !finished && perfect !== false`）——
   *     用户明确要求过"点完自动翻"（不必等判分），后来收紧成"**得全分之后再自动跳转**"：
   *     已判分但没得全分（答错 / 多选半对 / 简答没答全）⇒ **停在这一题**看正确答案，也不排等待定时器。
   *     ⚠ 没判分时（`autoCheck` 关着、或这题要用户点「提交本题」）不知道分数 ⇒ 沿用"答完就翻"的老规矩。
   *   · autoNextWrong 开（默认关）→ **答错的题也照翻**：`notPerfect` 不再拦着跳。
   *     它是 autoNext 的**子选项**（autoNext 关着时它不起作用，面板上那一行会置灰）。
   *   · `behavior.autoNextMs` → **跳之前等多少毫秒**（0 = 立刻）。它只管"等多久"，
   *     不管"要不要跳"；界面**只读返回的 `waitMs`**，不自己解释配置。
   *   · 没作答 → 不跳（自动翻页不会把一个空题翻过去）
   */
  function afterSubmit(cfg, ctx) {
    const c = ctx || {};
    const b = behaviorCfg(cfg);
    const autoCheck = b.autoCheck === true;
    const autoNext = b.autoNext === true;
    const autoNextWrong = b.autoNextWrong === true;
    const answered = c.answered === true;
    const alreadyChecked = c.checked === true;
    const finished = (c.finished === true) || (c.phase === 'finished');
    const correct = (c.correct === true) ? true : ((c.correct === false) ? false : null);

    const actions = [];
    let checked = alreadyChecked;
    if (answered && autoCheck && !checked) { actions.push('check'); checked = true; }
    if (answered && !autoCheck && !alreadyChecked) actions.push('needsManualSubmit');

    const reveal = revealAt(cfg, { submitted: checked, finished: finished,
                                   correct: correct, perfect: c.perfect, score: c.score, full: c.full });
    if (reveal.answer) actions.push('revealAnswer');
    if (reveal.explain) actions.push('revealExplain');

    /* 得全分才跳（用户要求）；没得全分 → 停在这一题看正确答案 —— 除非开了「答错的题也自动翻页」 */
    const perfect = checked ? perfectOf(c) : null;
    const notPerfect = (perfect === false);
    const wrongBlocked = notPerfect && !autoNextWrong;
    const willJump = autoNext && answered && !finished && !wrongBlocked;
    if (willJump) actions.push('next');
    /* 等待时间只对"要跳"这件事有意义：不跳时 waitMs 恒为 0（界面别拿着一个非零值空等）。 */
    const delay = autoNextDelay(cfg);
    const waitMs = willJump ? delay.ms : 0;

    return {
      autoCheck: autoCheck, autoNext: autoNext, autoNextWrong: autoNextWrong,
      checked: checked, finished: finished,
      correct: correct, perfect: perfect, notPerfect: notPerfect,
      jumpedDespiteWrong: !!(willJump && notPerfect),   // 这轮是"答错了也翻"（界面可据此说清楚）
      actions: actions,
      reveal: reveal,
      needsManualSubmit: actions.indexOf('needsManualSubmit') >= 0,
      willJump: willJump,
      waitMs: waitMs,                 // 界面**只读它**：0 = 立刻翻，>0 = 等这么多毫秒再翻
      jumpLabel: willJump ? delay.label : '不翻页',
      delayFallback: delay.fallback,  // 配置里那个等待时间非法时，点名（界面可显示）
      // 没做什么也要说清楚为什么（界面可以直接拿去做提示）
      notes: (function () {
        const n = [];
        if (answered && !autoCheck && !alreadyChecked) n.push('自动判分关着：这一题先不判分（点「提交本题」或交卷时统一判）');
        if (wrongBlocked) {
          /* 0 分说"答错了"，有分但没满说"没得全分（半对/没答全）" —— 措辞别让半对的用户以为全错 */
          const partial = (typeof c.score === 'number' && isFinite(c.score) && c.score > 0);
          n.push(partial ? '没得全分（半对 / 没答全）→ 停在这一题看正确答案（不自动翻页）'
                         : '答错了 → 停在这一题看正确答案（不自动翻页）');
        }
        else if (notPerfect && autoNextWrong) {
          n.push('这题没得全分，但开了「答错的题也自动翻页」→ 仍然翻（答案与解析在右栏 / 交卷页还能看）');
        }
        else if (alreadyChecked && !autoNext) n.push('自动翻页关着：停在本题，等用户自己翻');
        if (autoNext && !answered) n.push('自动翻页开着，但这题还没作答 → 不跳（不把空题翻过去）');
        if (willJump && waitMs > 0) n.push('自动翻页等着 ' + waitMs + ' 毫秒（' + delay.label + '）——期间再改答案会重新计时');
        if (autoNext && delay.fallback) n.push('自动翻页等待时间配置非法（' + delay.fallback + '）→ 已按默认 ' + delay.labelShort + '处理');
        return n;
      })()
    };
  }

  /* ============================================================
   *  分数线与定档
   * ============================================================ */

  function gradeLevel(percent, cfg) {
    const g = gradeCfg(cfg);
    const p = (typeof percent === 'number' && isFinite(percent)) ? percent : 0;
    const level = QuizCore.levelOf(p, cfg);            // ← 与判分用**同一个**函数
    const r1 = function (v) { return Math.round(v * 10) / 10; };
    return {
      percent: p, level: level,
      pass: g.pass, excellent: g.excellent,
      levelIndex: GRADE_LEVELS.indexOf(level),
      toPass: r1(g.pass - p), toExcellent: r1(g.excellent - p),
      note: level === '优秀' ? '超过优秀线 ' + r1(p - g.excellent) + ' 分'
          : (level === '及格' ? '离优秀线还差 ' + r1(g.excellent - p) + ' 分'
          : '离及格线还差 ' + r1(g.pass - p) + ' 分')
    };
  }

  /* 三档区间（左闭右开，最后一档含 100）—— 与 levelOf 的判定严格对应 */
  function gradeBands(cfg) {
    const g = gradeCfg(cfg);
    return [
      { level: '不及格', from: 0, to: g.pass, toInclusive: false },
      { level: '及格', from: g.pass, to: g.excellent, toInclusive: false },
      { level: '优秀', from: g.excellent, to: 100, toInclusive: true }
    ];
  }

  /* ============================================================
   *  底部快捷面板：题量与分数线（面板只调这些函数，不自己算）
   * ============================================================ */

  const COUNT_STEP = 1, SCORE_STEP = 5, COUNT_MAX = 999, SCORE_MAX = 1000;

  function countControl(cfg, opts) {
    const p = pickCfg(cfg), o = opts || {};
    const byType = (p.byType && typeof p.byType === 'object') ? p.byType : {};
    const byTypeTotal = Object.keys(byType).reduce(function (s, k) { return s + numOr(byType[k], 0); }, 0);
    const byTypeScore = (p.byTypeScore && typeof p.byTypeScore === 'object') ? p.byTypeScore : {};
    const byTypeScoreTotal = round2(Object.keys(byTypeScore).reduce(function (s, k) { return s + numOr(byTypeScore[k], 0); }, 0));
    // 口径：byWeight 与 random+score 都算"按分数"；其余（byCount / random+count）算"按题量"。
    // opts.basis 可以**显式指定**（面板上"目标总分"那一行的加减按钮要按分数口径动，
    // 不能因为当前口径是按题量就去改题量）。
    const derived = (p.mode === 'byWeight' || (p.mode === 'random' && p.randomBasis === 'score')) ? 'score' : 'count';
    const basis = (o.basis && BASIS_VALUES.indexOf(o.basis) >= 0) ? o.basis : derived;
    // 快捷题量只在"完全随机"下真的决定本轮抽多少题；byCount 是按题型配比、byWeight 是由分数倒推
    const affectsPick = (p.mode === 'random');
    const notes = [];
    if (p.mode === 'byCount') notes.push('每个题型各抽几题（合计 ' + byTypeTotal + ' 题）');
    if (p.mode === 'byWeight') notes.push(byTypeScoreTotal > 0
      ? '每个题型各自凑到目标分（合计 ' + byTypeScoreTotal + ' 分）'
      : '四行都是 0（还没分配）→ 仍按目标总分 ' + numOr(p.targetScore, 0) + ' 分自动配比');
    /* ⚠ 这些设置**只决定"下一轮抽哪些题"**：正在答的这一轮不会中途换题（换题＝丢掉已答的）。
     * 什么时候真的抽：从题库点「抽一轮」，或在答题页点「按当前设置重开一轮」。 */
    notes.push('只对下一轮生效；已开答的那一轮不换题');
    return {
      mode: p.mode, modeLabel: PICK_MODE_LABELS[p.mode] || String(p.mode),
      basis: basis, basisLabel: BASIS_LABELS[basis],
      count: numOr(p.count, 0), targetScore: numOr(p.targetScore, 0),
      byType: byType, byTypeTotal: byTypeTotal,
      byTypeScore: byTypeScore, byTypeScoreTotal: byTypeScoreTotal,
      perTypeScore: byTypeScoreTotal > 0,          // 逐题型目标分"分配过没有"
      types: TYPE_KEYS.slice(),
      min: numOr(o.min, 0),
      max: numOr(o.max, basis === 'score' ? SCORE_MAX : COUNT_MAX),
      step: numOr(o.step, basis === 'score' ? SCORE_STEP : COUNT_STEP),
      scoreStep: numOr(o.scoreStep, SCORE_STEP),
      affectsPick: affectsPick,
      hint: affectsPick ? ('本轮将随机抽 ' + (basis === 'score' ? ('约 ' + numOr(p.targetScore, 0) + ' 分') : (numOr(p.count, 0) + ' 题')))
                        : '只在「完全随机」下生效',
      notes: notes
    };
  }

  /* ============================================================
   *  逐题型分配（抽题规则的两条"手动分配"路线）
   *    · byCount  → pick.byType.<题型>      单位「题」
   *    · byWeight → pick.byTypeScore.<题型> 单位「分」（步长 = 该题型每题分值，落点才准）
   *  界面只读这里的 rows/notes，不自己判断单位与步长。
   * ============================================================ */
  function typeAlloc(cfg) {
    const p = pickCfg(cfg);
    const mode = (PICK_MODES.indexOf(p.mode) >= 0) ? p.mode : 'byCount';
    const byType = (p.byType && typeof p.byType === 'object') ? p.byType : {};
    const byTypeScore = (p.byTypeScore && typeof p.byTypeScore === 'object') ? p.byTypeScore : {};
    const points = (cfg && cfg.points) || DEFAULT.points;
    /* basis 只在这两条规则下有意义：byWeight 按分、其余按题。random 用 countControl 那套。 */
    const basis = (mode === 'byWeight') ? 'score' : 'count';
    const isScore = (basis === 'score');
    const rows = TYPE_KEYS.map(function (t) {
      const unit = QuizCore.unitPoints(points, t);          // 该题型每题分值（0 = 该题型每题 0 分）
      const value = isScore ? round2(numOr(byTypeScore[t], 0)) : Math.max(0, Math.floor(numOr(byType[t], 0)));
      /* 目标分的步长就用"每题分值"：这样 + 一次正好是一道题的分，凑分能精确落地；
       * 每题 0 分的题型凑不了分 → 步长退回 1，并在备注里点名（别让用户白按）。 */
      const step = isScore ? (unit > 0 ? unit : 1) : 1;
      return {
        type: t, kind: isScore ? 'score' : 'count',
        id: (isScore ? 'byTypeScore.' : 'byType.') + t,     // 面板动件 id（quickAction 直接认）
        label: t, value: value, unit: isScore ? '分' : '题',
        step: step, min: 0, max: isScore ? SCORE_MAX : COUNT_MAX,
        /* 只读的换算：这一型目标分大概等于几道题（每题分值为 0 时给 null，不编数字） */
        implied: isScore ? (unit > 0 ? Math.floor(value / unit) : null) : null,
        unitPoints: unit
      };
    });
    const total = round2(rows.reduce(function (s, r) { return s + r.value; }, 0));
    const notes = [];
    if (isScore) {
      if (total > 0) {
        notes.push(rows.map(function (r) {
          return r.type + ' ' + r.value + ' 分' + (r.implied === null ? '（每题 0 分，抽不到）' : '（≈ ' + r.implied + ' 题 × ' + r.unitPoints + ' 分）');
        }).join('　'));
      } else {
        notes.push('四行都是 0 → 仍按目标总分 ' + round2(numOr(p.targetScore, 0)) + ' 分自动配比');
      }
    } else {
      notes.push('合计 ' + total + ' 题');
    }
    return { mode: mode, modeLabel: PICK_MODE_LABELS[mode] || mode, basis: basis,
             isScore: isScore, rows: rows, total: total, notes: notes,
             allocKey: isScore ? 'byTypeScore' : 'byType'
    };
  }

  /* 写一型的值：**同时把 mode 切到对应规则**（用户点了"单选 30 题"，那这一轮就该按逐题型数量抽）
   * —— 否则值写进去了、抽取规则还是别的，界面点了没反应。这是显式动作，如实回报 modeChanged。 */
  function setTypeValue(cfg, kind, type, value, opts) {
    if (TYPE_KEYS.indexOf(type) < 0) {
      return { ok: false, errors: [{ path: 'pick', code: 'E_FLOW_BAD_TYPE',
               message: '未知题型：' + JSON.stringify(type), hint: '只有 ' + TYPE_KEYS.join(' / ') }] };
    }
    const isScore = (kind === 'score' || kind === 'byTypeScore');
    if (typeof value !== 'number' || !isFinite(value) || value < 0) {
      return { ok: false, errors: [{ path: 'pick.' + (isScore ? 'byTypeScore.' : 'byType.') + type,
               code: 'E_FLOW_BAD_VALUE', message: '不是有效数字：' + JSON.stringify(value),
               hint: isScore ? '目标分要填 0 或正数' : '题数要填 0 或正整数' }] };
    }
    const cur = pickCfg(cfg);
    const wantMode = isScore ? 'byWeight' : 'byCount';
    const modeChanged = (cur.mode !== wantMode);
    const patch = { pick: { mode: wantMode } };
    patch.pick[isScore ? 'byTypeScore' : 'byType'] = {};
    patch.pick[isScore ? 'byTypeScore' : 'byType'][type] = value;
    const r = applyQuick(cfg, patch, opts);
    return { ok: r.ok, kind: isScore ? 'score' : 'count', type: type, value: value,
             mode: wantMode, modeChanged: modeChanged, patch: patch, config: r.config, errors: r.errors };
  }

  function bumpTypeValue(cfg, kind, type, delta, opts) {
    if (typeof delta !== 'number' || !isFinite(delta)) return badValue('pick', delta);
    const isScore = (kind === 'score' || kind === 'byTypeScore');
    const p = pickCfg(cfg);
    const points = (cfg && cfg.points) || DEFAULT.points;
    const table = isScore ? ((p.byTypeScore && typeof p.byTypeScore === 'object') ? p.byTypeScore : {})
                          : ((p.byType && typeof p.byType === 'object') ? p.byType : {});
    const step = isScore ? (QuizCore.unitPoints(points, type) > 0 ? QuizCore.unitPoints(points, type) : 1) : 1;
    const raw = numOr(table[type], 0) + delta * step;
    const max = isScore ? SCORE_MAX : COUNT_MAX;
    const next = Math.min(max, Math.max(0, round2(raw)));
    const r = setTypeValue(cfg, kind, type, next, opts);
    return { ok: r.ok, kind: r.kind, type: type, value: r.value, step: step,
             atMin: next <= 0, atMax: next >= max, modeChanged: r.modeChanged,
             patch: r.patch, config: r.config, errors: r.errors,
             clamped: round2(raw) !== next };
  }

  /* 题量/分数加减：**统一走 applyConfigPatch 校验**，这一层不自己定"什么值合法" */
  function applyQuick(cfg, patch, opts) {
    const o = opts || {};
    const r = QuizCore.applyConfigPatch(cfg || DEFAULT, patch || {}, o);
    if (!r.ok) return { ok: false, errors: r.errors, warnings: r.warnings, patch: patch };
    return { ok: true, config: r.config, warnings: r.warnings, patch: patch };
  }

  const clampTo = function (v, ctl) {
    const step = ctl.step || 1;
    let n = Math.round(v / step) * step;              // 按步长对齐（分数按 5 分一档）
    n = Math.round(n * 100) / 100;                    // 去掉浮点毛刺
    const clamped = Math.min(ctl.max, Math.max(ctl.min, n));
    return { value: clamped, clamped: clamped !== n, atMin: clamped <= ctl.min, atMax: clamped >= ctl.max };
  };
  /* 非数字一律**拒绝**，不许静默变成 0 —— 输入框里手打一个错字不该被当成"要 0 题" */
  function badValue(id, v) {
    return { ok: false, errors: [{ path: id, code: 'E_FLOW_BAD_VALUE',
             message: '不是有效数字：' + JSON.stringify(v), hint: '请输入数字（题量与分数线都只接受数字）' }] };
  }

  function bumpCount(cfg, delta, opts) {
    if (typeof delta !== 'number' || !isFinite(delta)) return badValue('pick', delta);
    const ctl = countControl(cfg, opts);
    const raw = (ctl.basis === 'score' ? ctl.targetScore : ctl.count) + delta * (ctl.basis === 'score' ? ctl.scoreStep : ctl.step);
    const c = clampTo(raw, ctl);
    const patch = (ctl.basis === 'score')
      ? { pick: { mode: 'random', randomBasis: 'score', targetScore: c.value } }
      : { pick: { mode: 'random', randomBasis: 'count', count: c.value } };
    const r = applyQuick(cfg, patch, opts);
    return { ok: r.ok, value: c.value, clamped: c.clamped, atMin: c.atMin, atMax: c.atMax,
             basis: ctl.basis, patch: patch, config: r.config, errors: r.errors };
  }

  function setCount(cfg, value, opts) {
    if (typeof value !== 'number' || !isFinite(value)) return badValue('pick', value);
    const ctl = countControl(cfg, opts);
    const c = clampTo(value, ctl);
    const patch = (ctl.basis === 'score')
      ? { pick: { mode: 'random', randomBasis: 'score', targetScore: c.value } }
      : { pick: { mode: 'random', randomBasis: 'count', count: c.value } };
    const r = applyQuick(cfg, patch, opts);
    return { ok: r.ok, value: c.value, clamped: c.clamped, basis: ctl.basis, patch: patch, config: r.config, errors: r.errors };
  }

  /* 切换题量口径。
   * 口径只在「完全随机」这条规则下真的决定抽多少题 —— 所以当 mode 不是 random 时，
   * 这一步必须**同时把 mode 切到 random**，否则 randomBasis 写了也没人看，
   * 用户点一下界面却毫无变化（"点了没反应"是最气人的那种假功能）。
   * 这是显式动作（用户就是在点题量口径），并且把 mode 变更如实回报，不算"猜"。 */
  function setBasis(cfg, basis, opts) {
    if (BASIS_VALUES.indexOf(basis) < 0) {
      return { ok: false, errors: [{ path: 'pick.randomBasis', code: 'E_FLOW_BAD_BASIS',
               message: '未知的题量口径：' + JSON.stringify(basis), hint: '只能选 ' + BASIS_VALUES.join(' / ') }] };
    }
    const cur = pickCfg(cfg);
    const switchedMode = (cur.mode !== 'random');
    const patch = switchedMode
      ? { pick: { mode: 'random', randomBasis: basis } }
      : { pick: { randomBasis: basis } };
    const r = applyQuick(cfg, patch, opts);
    return { ok: r.ok, basis: basis, switchedMode: switchedMode, patch: r.patch, config: r.config, errors: r.errors,
             note: switchedMode ? ('抽题规则已一并切到「完全随机」——只有它才按这个口径决定本轮题量（原来是「' + (PICK_MODE_LABELS[cur.mode] || cur.mode) + '」）') : '' };
  }

  const PICK_MODES = ['all', 'byCount', 'byWeight', 'random'];
  /* 抽取偏好：随机 or 未作答优先。与规则正交 —— 三种"抽取类"规则都能配它。 */
  const PICK_PREFER = ['random', 'unansweredFirst'];
  const PICK_PREFER_LABELS = { random: '完全随机', unansweredFirst: '未作答优先' };
  function setPrefer(cfg, prefer, opts) {
    if (PICK_PREFER.indexOf(prefer) < 0) {
      return { ok: false, errors: [{ path: 'pick.prefer', code: 'E_FLOW_BAD_PREFER',
               message: '未知的抽取偏好：' + JSON.stringify(prefer), hint: '只能选 ' + PICK_PREFER.join(' / ') }] };
    }
    const patch = { pick: { prefer: prefer } };
    const r = applyQuick(cfg, patch, opts);
    return { ok: r.ok, prefer: prefer, patch: r.patch, config: r.config, errors: r.errors };
  }
  function setMode(cfg, mode, opts) {
    if (PICK_MODES.indexOf(mode) < 0) {
      return { ok: false, errors: [{ path: 'pick.mode', code: 'E_FLOW_BAD_MODE',
               message: '未知的抽题规则：' + JSON.stringify(mode), hint: '只能选 ' + PICK_MODES.join(' / ') }] };
    }
    let patch = { pick: { mode: mode } };
    if (mode === 'random') {
      const p = pickCfg(cfg);
      const basis = (p.randomBasis === 'score') ? 'score' : 'count';
      patch = { pick: { mode: 'random', randomBasis: basis } };
    }
    const r = applyQuick(cfg, patch, opts);
    return { ok: r.ok, mode: mode, patch: r.patch, config: r.config, errors: r.errors };
  }

  /*
   * 多选的"全对得分 / 半对得分"（用户要求：都能自己调）。
   *   全对得分 = `points.多选`（每题分值，判分侧就是拿它当满分）
   *   半对得分 = `multi.halfScore`（fixedScore 模式下生效）
   * 两条硬约束（在**动作这一层**兜住，别指望用户自己记住）：
   *   · 都是 0.5 的整数倍（计分侧承诺所有得分都是 0.5 的倍数）；
   *   · **半对 ≤ 全对**（把全对调到 2 分时，半对不能还写着 3 分）；改全对时若半对超了，一起压下来。
   * ⚠ 半对模式是 `fixedScore` 才用 halfScore；另外两种模式（fixed / hitRatio）用比例，不受这里影响，
   *   所以返回值里如实带上 `modeHint`，界面提示里可以说清"这一项只在半对固定给分模式下生效"。
   */
  const MULTI_SCORE_STEP = 0.5;
  function multiScoreCfg(cfg) {
    const points = (cfg && cfg.points) || DEFAULT.points;
    const multi = (cfg && cfg.multi) || DEFAULT.multi;
    const full = numOr(points['多选'], (DEFAULT.points || {})['多选'] || 0);
    const mode = (['fixedScore', 'fixed', 'hitRatio'].indexOf(multi.halfMode) >= 0) ? multi.halfMode : 'fixedScore';
    return {
      full: round2(full),
      half: round2(numOr(multi.halfScore, (DEFAULT.multi || {}).halfScore || 0)),
      mode: mode, modeHint: (mode === 'fixedScore') ? null : ('当前半对模式是「' + mode + '」，不用"半对得分"这一项')
    };
  }
  function setMultiFull(cfg, value, opts) {
    if (typeof value !== 'number' || !isFinite(value)) return badValue('points.多选', value);
    const cur = multiScoreCfg(cfg);
    const v = Math.max(0, Math.round(value / MULTI_SCORE_STEP) * MULTI_SCORE_STEP);
    const full = round2(v);
    const patch = { points: { '多选': full } };
    /* 全对压低到半对以下 → 半对跟着压下来（半对 ≤ 全对是硬约束） */
    const clampedHalf = (cur.half > full);
    if (clampedHalf) patch.multi = { halfScore: full };
    const r = applyQuick(cfg, patch, opts);
    return { ok: r.ok, value: full, clampedHalf: clampedHalf, half: clampedHalf ? full : cur.half,
             patch: patch, config: r.config, errors: r.errors };
  }
  function bumpMultiFull(cfg, delta, opts) {
    if (typeof delta !== 'number' || !isFinite(delta)) return badValue('points.多选', delta);
    return setMultiFull(cfg, multiScoreCfg(cfg).full + delta * MULTI_SCORE_STEP, opts);
  }
  function setMultiHalf(cfg, value, opts) {
    if (typeof value !== 'number' || !isFinite(value)) return badValue('multi.halfScore', value);
    const cur = multiScoreCfg(cfg);
    const v = Math.max(0, Math.round(value / MULTI_SCORE_STEP) * MULTI_SCORE_STEP);
    /* 半对不许超过全对：超了就**压到全对**并如实报告（界面上给出提示，不静默吞掉） */
    const half = round2(Math.min(v, cur.full));
    const clamped = half !== round2(v);
    const r = applyQuick(cfg, { multi: { halfScore: half } }, opts);
    return { ok: r.ok, value: half, clampedToFull: clamped, full: cur.full,
             patch: { multi: { halfScore: half } }, config: r.config, errors: r.errors };
  }
  function bumpMultiHalf(cfg, delta, opts) {
    if (typeof delta !== 'number' || !isFinite(delta)) return badValue('multi.halfScore', delta);
    return setMultiHalf(cfg, multiScoreCfg(cfg).half + delta * MULTI_SCORE_STEP, opts);
  }

  function setGrade(cfg, which, value, opts) {
    if (which !== 'pass' && which !== 'excellent') {
      return { ok: false, errors: [{ path: 'grade', code: 'E_FLOW_BAD_GRADE_KEY',
               message: '分数线只有 pass（及格线）与 excellent（优秀线）两条', hint: '' }] };
    }
    const patch = { grade: {} }; patch.grade[which] = value;
    const r = applyQuick(cfg, patch, opts);
    return { ok: r.ok, which: which, value: value, patch: patch, config: r.config, errors: r.errors };
  }

  /* 分数线加减（面板上的 +/− 按钮）。
   * ⚠ 早先面板把这两行声明成 stepper，发出的动件 id 是 `grade.pass+` / `grade.excellent+`，
   *   而 quickAction 只认 `grade.pass`（不带符号）→ 两个按钮**永远报"不认识的动件"**，
   *   是个点了没反应的死控件（组级红队抓出来的真功能坏）。 */
  function bumpGrade(cfg, which, delta, opts) {
    if (which !== 'pass' && which !== 'excellent') {
      return { ok: false, errors: [{ path: 'grade', code: 'E_FLOW_BAD_GRADE_KEY',
               message: '分数线只有 pass（及格线）与 excellent（优秀线）两条', hint: '' }] };
    }
    if (typeof delta !== 'number' || !isFinite(delta)) {
      return { ok: false, errors: [{ path: 'grade', code: 'E_FLOW_BAD_VALUE',
               message: '不是有效数字：' + JSON.stringify(delta), hint: '分数线只接受数字' }] };
    }
    const o = opts || {};
    const g = gradeCfg(cfg);
    const step = numOr(o.gradeStep, 5);
    const ctl = { min: numOr(o.min, 0), max: numOr(o.max, 100), step: step };
    const c = clampTo(numOr(g[which], 0) + delta * step, ctl);
    return setGrade(cfg, which, c.value, opts);
  }

  function setReveal(cfg, which, timing, opts) {
    const key = (which === 'answer' || which === 'answerTiming') ? 'answerTiming'
              : ((which === 'explain' || which === 'explainTiming') ? 'explainTiming' : null);
    if (!key) {
      return { ok: false, errors: [{ path: 'reveal', code: 'E_FLOW_BAD_REVEAL_KEY',
               message: '展示时机只有 answer（答案）与 explain（解析）两项', hint: '' }] };
    }
    if (REVEAL_VALUES.indexOf(timing) < 0) {
      return { ok: false, errors: [{ path: 'reveal.' + key, code: 'E_FLOW_BAD_TIMING',
               message: '未知的展示时机：' + JSON.stringify(timing), hint: '只能选 each（答完一题）/ end（整卷后）' }] };
    }
    const patch = { reveal: {} }; patch.reveal[key] = timing;
    const r = applyQuick(cfg, patch, opts);
    return { ok: r.ok, which: which, timing: timing, patch: patch, config: r.config, errors: r.errors };
  }

  const BEHAVIOR_KEYS = ['autoCheck', 'autoNext', 'autoNextWrong', 'timer', 'autoNextMs'];
  function setBehavior(cfg, which, on, opts) {
    if (BEHAVIOR_KEYS.indexOf(which) < 0) {
      return { ok: false, errors: [{ path: 'behavior', code: 'E_FLOW_BAD_BEHAVIOR_KEY',
               message: '行为开关只有 ' + BEHAVIOR_KEYS.slice(0, 3).join('（' + '）、') + ' 与 autoNextMs（自动翻页等待时间）', hint: '' }] };
    }
    const patch = { behavior: {} };
    if (which === 'autoNextMs') {
      /* 等待时间有取值范围，交给配置层校验（`CONFIG_FIELDS` 里 min/max/int 一处定义）——
       * 这里只把"非数字"提前挡住，好给出比 E_CFG_NOT_NUMBER 更直白的话。 */
      if (typeof on !== 'number' || !isFinite(on)) {
        return { ok: false, errors: [{ path: 'behavior.autoNextMs', code: 'E_FLOW_BAD_VALUE',
                 message: '等待时间要填数字（毫秒）：' + JSON.stringify(on), hint: '0 = 点完立刻翻' }] };
      }
      patch.behavior.autoNextMs = on;
    } else {
      patch.behavior[which] = on === true;
    }
    const r = applyQuick(cfg, patch, opts);
    return { ok: r.ok, which: which, value: which === 'autoNextMs' ? patch.behavior.autoNextMs : (on === true),
             patch: patch, config: r.config, errors: r.errors };
  }

  /* 面板的"一个动作 → 新配置"总入口：id 形如 count+1 / count-1 / count=30 / basis=score /
   * mode=byWeight / answerTiming=each / explainTiming=end / autoCheck=true / grade.pass=70 */
  function quickAction(cfg, action, opts) {
    const a = action || {};
    const id = String(a.id || '');
    const o = opts || {};
    // 面板上"目标总分"那一行的加减按钮强制走分数口径，"本轮题量"那一行强制走题量口径 ——
    // 否则当前口径是按题量时，点"分数 +5"会跑去改题量（张冠李戴）。
    if (id === 'count+' || id === 'count-') {
      return bumpCount(cfg, (id === 'count+') ? 1 : -1, merge(opts, { basis: 'count' }));
    }
    if (id === 'count' || id === 'count=') return setCount(cfg, a.value, merge(opts, { basis: 'count' }));
    if (id === 'score+' || id === 'score-') {
      return bumpCount(cfg, (id === 'score+') ? 1 : -1, merge(opts, { basis: 'score' }));
    }
    if (id === 'score' || id === 'score=') return setCount(cfg, a.value, merge(opts, { basis: 'score' }));
    if (id === 'basis' || id === 'basis=') return setBasis(cfg, a.value, o);
    if (id === 'mode' || id === 'mode=') return setMode(cfg, a.value, o);
    if (id === 'prefer' || id === 'prefer=') return setPrefer(cfg, a.value, o);
    if (id === 'answerTiming' || id === 'answer') return setReveal(cfg, 'answer', a.value, o);
    if (id === 'explainTiming' || id === 'explain') return setReveal(cfg, 'explain', a.value, o);
    if (id === 'autoCheck') return setBehavior(cfg, 'autoCheck', a.value, o);
    if (id === 'autoNext') return setBehavior(cfg, 'autoNext', a.value, o);
    if (id === 'autoNextWrong') return setBehavior(cfg, 'autoNextWrong', a.value, o);
    /* 答题计时（用户要求）：开了就在答题界面挂一颗悬浮球显示用时、可暂停 */
    if (id === 'timer') return setBehavior(cfg, 'timer', a.value, o);
    /* 判分两项（用户要求："多选全对和半对得分都可以自己调整"）：
     *   `points.多选` = 全对得分（每题分值）、`multi.halfScore` = 半对得分。 */
    if (id === 'points.多选' || id === 'points.多选+' || id === 'points.多选-') {
      const m = id.match(/([+-])$/);
      return m ? bumpMultiFull(cfg, m[1] === '+' ? 1 : -1, o) : setMultiFull(cfg, a.value, o);
    }
    if (id === 'multi.halfScore' || id === 'multi.halfScore+' || id === 'multi.halfScore-') {
      const m = id.match(/([+-])$/);
      return m ? bumpMultiHalf(cfg, m[1] === '+' ? 1 : -1, o) : setMultiHalf(cfg, a.value, o);
    }
    /* 等待时间那一行：面板既可能发 `autoNextMs`（选预设）也可能发 `autoNextMs=`（数量控件） */
    if (id === 'autoNextMs' || id === 'autoNextMs=') return setBehavior(cfg, 'autoNextMs', a.value, o);
    if (id === 'grade.pass' || id === 'grade.excellent' || id === 'grade.pass+' || id === 'grade.pass-' ||
        id === 'grade.excellent+' || id === 'grade.excellent-') {
      const which = id.indexOf('excellent') >= 0 ? 'excellent' : 'pass';
      const m = id.match(/([+-])$/);
      if (!m) return setGrade(cfg, which, a.value, o);          // 直接给值（不带符号）
      return bumpGrade(cfg, which, m[1] === '+' ? 1 : -1, o);   // 面板的 +/−
    }
    /* 逐题型分配：`byType.单选` / `byTypeScore.单选`，以及它们的 `+` / `-` 变体 */
    const tm = id.match(/^(byType|byTypeScore)\.(.+?)([+-])?$/);
    if (tm) {
      const kind = (tm[1] === 'byTypeScore') ? 'score' : 'count';
      return tm[3] ? bumpTypeValue(cfg, kind, tm[2], tm[3] === '+' ? 1 : -1, o)
                   : setTypeValue(cfg, kind, tm[2], a.value, o);
    }
    return { ok: false, errors: [{ path: '', code: 'E_FLOW_UNKNOWN_ACTION',
             message: '快捷面板不认识的动件：' + JSON.stringify(id), hint: '动件 id 见 core/flow.js 的 quickAction' }] };
  }

  /* 面板要渲染什么：声明式行（界面层只负责画，不负责判断） */
  function quickModel(cfg) {
    const ctl = countControl(cfg);
    const alloc = typeAlloc(cfg);
    const pol = revealPolicy(cfg);
    const b = behaviorCfg(cfg);
    const g = gradeCfg(cfg);
    const rows = [];
    /* ---- 抽题与题量 ----
     * 「按题型数量 / 按题型总分」两条规则都是**手动分配逐题型的目标** → 直接给四行加减控件；
     * 「完全随机」没有逐题型目标，才需要"停止口径 + 本轮题量/目标总分"那三行。
     * 行随规则显隐（不是置灰）：置灰的话随机那几行会一直占着面板，用户还得猜哪几行算数。 */
    const pickRows = [{ kind: 'choice', id: 'mode', label: '抽题规则', value: alloc.mode,
      options: PICK_MODES.map(function (m) { return { value: m, label: PICK_MODE_LABELS[m] }; }) }];
    let pickNotes;
    if (alloc.mode === 'all') {
      /* 全部作答：**不抽题** —— 逐题型那四行和"本轮题量 / 目标总分"都不该出现（都不参与）。
       * 这一轮做多少题由**卷子**决定，不由这几行决定（设置页会用真题库空跑一次，写出确切题数）。
       * 同理"抽取偏好"也不出现：一道都不抽，偏好没有作用对象。 */
      pickNotes = ['全部作答：整套卷都做，不抽题。只想做一部分，就把上面的规则换成按题型数量 / 按题型总分 / 完全随机。'];
    } else if (alloc.isScore || alloc.mode === 'byCount') {
      alloc.rows.forEach(function (r) {
        pickRows.push({ kind: 'stepper', id: r.id, label: r.label, value: r.value, step: r.step,
                        min: r.min, max: r.max, unit: r.unit });
      });
      pickNotes = alloc.notes.slice();
    } else {
      pickRows.push({ kind: 'choice', id: 'basis', label: '题量口径', value: ctl.basis,
        options: BASIS_VALUES.map(function (v) { return { value: v, label: BASIS_LABELS[v] }; }) });
      pickRows.push({ kind: 'stepper', id: 'count', label: '本轮题量', value: ctl.count, step: COUNT_STEP,
        min: 0, max: COUNT_MAX, unit: '题', enabled: ctl.basis === 'count' });
      pickRows.push({ kind: 'stepper', id: 'score', label: '目标总分', value: ctl.targetScore, step: SCORE_STEP,
        min: 0, max: SCORE_MAX, unit: '分', enabled: ctl.basis === 'score' });
      pickNotes = ctl.notes.concat([ctl.hint]);
    }
    /* 抽取偏好那一行：三种抽取规则都吃它，所以放在分支**之后**统一追加（all 模式除外）。 */
    const preferNow = (function () {
      const p = pickCfg(cfg);
      return (PICK_PREFER.indexOf(p.prefer) >= 0) ? p.prefer : 'random';
    })();
    if (alloc.mode !== 'all') {
      pickRows.push({ kind: 'choice', id: 'prefer', label: '抽取偏好', value: preferNow,
        options: PICK_PREFER.map(function (v) { return { value: v, label: PICK_PREFER_LABELS[v] }; }) });
      pickNotes = pickNotes.concat([preferNow === 'unansweredFirst'
        ? '未作答优先：先抽错题本里还没答对的，再抽没进过本子的；同档里仍然随机'
        : '完全随机：不看作答记录']);
    }
    rows.push({ group: '抽题与题量', rows: pickRows, notes: pickNotes });
    rows.push({ group: '展示时机', rows: [
      { kind: 'choice', id: 'answerTiming', label: '答案', value: pol.answer,
        options: REVEAL_VALUES.map(function (v) { return { value: v, label: REVEAL_LABELS[v] }; }) },
      { kind: 'choice', id: 'explainTiming', label: '解析', value: pol.explain,
        options: REVEAL_VALUES.map(function (v) { return { value: v, label: REVEAL_LABELS[v] }; }) }
    ], notes: pol.explainGatedByAnswer ? ['解析不会比答案先出现'] : [] });
    const dly = autoNextDelay(cfg);
    rows.push({ group: '作答行为', rows: [
      { kind: 'toggle', id: 'autoCheck', label: '答完一题自动判分', value: b.autoCheck === true },
      { kind: 'toggle', id: 'autoNext', label: '答完自动翻页', value: b.autoNext === true },
      /* 「答错的题也自动翻页」（用户要求"错题是否自动翻页"给个开关）：
       * 它是 autoNext 的子选项 —— 自动翻页关着时，那一行置灰（它管不着任何事）。 */
      { kind: 'toggle', id: 'autoNextWrong', label: '答错的题也自动翻页', value: b.autoNextWrong === true,
        enabled: b.autoNext === true },
      { kind: 'toggle', id: 'timer', label: '答题计时（悬浮球）', value: b.timer === true },
      /* 等待时间：`enabled:false` 时面板把按钮置灰（关着自动翻页就没有"等多久"这回事）。
       * ⚠ 先前的标签写的是"判分后自动翻页"、注释还写着"要手点提交本题才翻" —— 都是上一轮
       *   "跳 ≠ 判"改完之后**没跟着改**的陈旧文案（用户看到的就是这行字），已一并更正。 */
      { kind: 'choice', id: 'autoNextMs', label: '翻页等待', value: dly.ms, enabled: b.autoNext === true,
        options: dly.presets.map(function (ms) { return { value: ms, label: dly.labels[ms] }; }) }
    ], notes: (function () {
      /* 面板上这几行小字在"删小字"那一轮压缩过：只留**用户没法从标签上推出来的**事实
       *   （等待时间的前提条件 / 没得全分不翻 / 多选简答要手动提交），
       *   原来的"等待时间只改多久之后翻…"那种解释性长句删掉了。 */
      const n = [];
      if (b.autoNext !== true) n.push('自动翻页关着 → 等待时间与"错题也翻"都不起作用');
      if (b.autoNext === true && b.autoNextWrong !== true) n.push('答完就翻（' + dly.label + '），不必等判分；没得全分就不翻');
      if (b.autoNext === true && b.autoNextWrong === true) n.push('答完就翻（' + dly.label + '），答错 / 半对也翻（答案在右栏与交卷页还能看）');
      if (b.autoNext === true && dly.ms === 0) n.push('等待时间是 0 → 立刻翻，那就没有等待窗口（也看不到翻页加载条）');
      if (b.autoCheck === true) n.push('多选 / 简答不自动判分也不自动翻：点「提交本题」判分后自己翻');
      if (dly.custom) n.push('等待时间是自定义值 ' + dly.ms + ' 毫秒，照它走');
      if (dly.fallback) n.push('等待时间配置非法（' + dly.fallback + '）→ 已按"立刻翻"处理');
      return n;
    })() });
    rows.push({ group: '分数线', rows: [
      { kind: 'stepper', id: 'grade.pass', label: '及格比例', value: g.pass, step: 5, min: 0, max: 100, unit: '%' },
      { kind: 'stepper', id: 'grade.excellent', label: '优秀比例', value: g.excellent, step: 5, min: 0, max: 100, unit: '%' }
    ], notes: ['及格 ' + g.pass + '% / 优秀 ' + g.excellent + '%（都按卷面满分的百分比算）'
      + (g.pass > g.excellent ? '（⚠ 下限不能大于上限）' : '')] });
    /* 「判分」组（用户要求："多选全对和半对得分都可以自己调整"）：
     * 只放这两行 —— 全对得分就是 `points.多选`（每题分值），半对得分是 `multi.halfScore`。
     * 半对的 max 动态取全对得分：面板上的"+"到顶就灰掉，用户不会把半对调到比全对还高。 */
    const ms = multiScoreCfg(cfg);
    rows.push({ group: '判分', rows: [
      { kind: 'stepper', id: 'points.多选', label: '多选全对得分', value: ms.full, step: MULTI_SCORE_STEP,
        min: 0, max: SCORE_MAX, unit: '分' },
      { kind: 'stepper', id: 'multi.halfScore', label: '多选半对得分', value: ms.half, step: MULTI_SCORE_STEP,
        min: 0, max: ms.full, unit: '分' }
    ], notes: [
      '半对得分不超过全对得分（改全对时会自动一起压下来）',
      ms.modeHint || '少选且没选错 = 半对得分；错选一律 0 分'
    ] });
    return rows;
  }

  return {
    REVEAL_VALUES: REVEAL_VALUES, REVEAL_LABELS: REVEAL_LABELS, DEFAULT_REVEAL: DEFAULT_REVEAL,
    BASIS_VALUES: BASIS_VALUES, BASIS_LABELS: BASIS_LABELS, PICK_MODE_LABELS: PICK_MODE_LABELS,
    PICK_PREFER: PICK_PREFER, PICK_PREFER_LABELS: PICK_PREFER_LABELS,
    PICK_MODES: PICK_MODES, GRADE_LEVELS: GRADE_LEVELS,
    COUNT_STEP: COUNT_STEP, SCORE_STEP: SCORE_STEP, COUNT_MAX: COUNT_MAX, SCORE_MAX: SCORE_MAX,
    revealPolicy: revealPolicy, revealAt: revealAt, perfectOf: perfectOf, afterSubmit: afterSubmit,
    autoNextDelay: autoNextDelay,
    AUTO_NEXT_MS_MAX: AUTO_NEXT_MS_MAX, AUTO_NEXT_MS_DEFAULT: AUTO_NEXT_MS_DEFAULT,
    AUTO_NEXT_MS_PRESETS: AUTO_NEXT_MS_PRESETS,
    AUTO_NEXT_MS_LABELS: AUTO_NEXT_MS_LABELS,
    gradeLevel: gradeLevel, gradeBands: gradeBands,
    countControl: countControl, bumpCount: bumpCount, setCount: setCount,
    setBasis: setBasis, setMode: setMode, setGrade: setGrade, bumpGrade: bumpGrade,
    setMultiFull: setMultiFull, bumpMultiFull: bumpMultiFull,
    setMultiHalf: setMultiHalf, bumpMultiHalf: bumpMultiHalf, multiScoreCfg: multiScoreCfg,
    MULTI_SCORE_STEP: MULTI_SCORE_STEP,
    setReveal: setReveal, setBehavior: setBehavior,
    typeAlloc: typeAlloc, setTypeValue: setTypeValue, bumpTypeValue: bumpTypeValue,
    TYPE_KEYS: TYPE_KEYS.slice(),
    applyQuick: applyQuick, quickAction: quickAction, quickModel: quickModel
  };
});
