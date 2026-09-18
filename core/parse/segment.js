/* ============================================================
 *  core/parse/segment.js —— 题型识别 · 正误归一 · 歧义标定 · 切题
 *
 *  从 parser-core.js 迁出（原文件头部就写着这三项归"题型识别与歧义标定"负责）。
 *  parser-core 现在只做门面：拿段落 → 交给本模块切成题。
 *
 *  本模块的三件正事：
 *    1) 题型识别：四类题型 + 常见别名，且【必须看到显式标记才开新题】
 *       —— 无标记的多行文字一律并入当前题的题干，绝不"猜"出一个新题。
 *    2) 判断题正误归一：12 种正误写法归一为 true/false；
 *       否定式（不正确/不对/不是/没错）按语义取反，不许把「不正确」判成"正确"。
 *    3) 歧义标定：认不出来 / 本身就自相矛盾（对错、正确与否、待定）的答案，
 *       一律 judgeValue=null + 进 review，绝不猜 —— 计分侧对 null 恒给 0 分。
 *
 *  依赖：core/parse/text.js（只要它的 fallbackKeywords）。无外部依赖。
 *  加载顺序：zip → docx → text → segment → parser-core
 * ============================================================ */
(function (root, factory) {
  const isNode = (typeof module !== 'undefined' && module.exports);
  const TextCore = isNode ? require('./text.js') : root.TextCore;
  const api = factory(TextCore);
  if (isNode) module.exports = api;
  root.SegmentCore = api;
})(typeof self !== 'undefined' ? self : this, function (TextCore) {
  'use strict';

  if (!TextCore) {
    throw new Error('segment-core 依赖缺失：请先加载 core/parse/text.js（顺序不可颠倒）');
  }

  /* ================= 一、题型识别 ================= */

  // 别名按"长的在前"排，保证 `单项选择题` 不会被 `单选` 先吃掉而漏掉后缀
  //
  // words      = 带括号时允许的写法（括号自带边界，宽松无风险）
  // colonWords = 不带括号、只靠冒号时允许的写法 —— **必须带「题」字**
  //   为什么：`判断` 既是题型名也是常用动词，「判断：地球是圆的」到底是题型标记
  //   还是题干续行，光看这一行分不出来。裸写别名就切题会把题干腰斩。
  //   而 `判断题：` 没有这种歧义。宁可少认一种写法，也不许切错题。
  const TYPE_ALIASES = [
    { type: '单选', words: ['单项选择题', '单项选择', '单选题', '单选'],
      colonWords: ['单项选择题', '单选题'], headerWords: ['单项选择题', '单项选择', '单选题'] },
    { type: '多选', words: ['多项选择题', '多项选择', '多选题', '多选'],
      colonWords: ['多项选择题', '多选题'], headerWords: ['多项选择题', '多项选择', '多选题'] },
    { type: '判断', words: ['判断题', '是非题', '判断'],
      colonWords: ['判断题', '是非题'], headerWords: ['判断题', '是非题'] },
    { type: '简答', words: ['简答题', '问答题', '论述题', '简答', '问答'],
      colonWords: ['简答题', '问答题', '论述题'], headerWords: ['简答题', '问答题', '论述题'] }
  ];

  // 可选题号前缀：`1.` `2、` `3)` `4．`
  const QNUM = '(?:\\d{1,3}\\s*[.、)．]\\s*)?';
  // 四类题型的合法取值（用于校验 opts.defaultType）
  const TYPES_FOR_SEGMENT = TYPE_ALIASES.map(function (g) { return g.type; });

  // 形态一：带括号 —— 【单选】 / [多选] / （判断） / (简答)   ← 括号是显式边界，宽松
  // 形态二：不带括号但带冒号 —— 单选题：/ 判断题：/ 简答题：    ← 必须带「题」字
  // 形态三：**整行就是一个题型名**（段头）—— 一、单选题 / 二、多选题 / 3. 判断题 / （四）简答题 / 单选题
  //   为什么补这一条：真实题集几乎都这么分节（"一、单选题 / 二、多选题 / 三、判断题"），
  //   而前两种形态都要求冒号或括号 → 整份文件**切出 0 题**（用户实测报障的那一份就是）。
  //   ⚠ 只认「带题字/无歧义」的写法（headerWords）：裸的 `单选` / `判断` 仍**不算**标记，
  //     因为「判断」既是题型名也是常用动词，一行里孤零零一个"判断"更可能是题干。
  //   ⚠ 整行必须**只有**这个标记（可带序号/括号序号/冒号），后面多一个字都不算 —— 这是它安全的原因。
  const CN_NUM = '[一二三四五六七八九十百零〇]';
  const HEAD_PREFIX = '(?:(?:' + CN_NUM + '+|\\d{1,3})\\s*[、.．)）]\\s*'
                    + '|第\\s*(?:' + CN_NUM + '+|\\d{1,3})\\s*(?:部分|章节|章|节)\\s*'
                    + '|[（(]\\s*' + CN_NUM + '+\\s*[）)]\\s*)?';
  const TYPE_MARKERS = TYPE_ALIASES.map(function (g) {
    return {
      type: g.type,
      re: new RegExp('^\\s*' + QNUM + '[【\\[（(]\\s*(?:' + g.words.join('|') + ')\\s*[】\\]）)]\\s*[：:]?\\s*'),
      reColon: new RegExp('^\\s*' + QNUM + '(?:' + g.colonWords.join('|') + ')\\s*[：:]\\s*'),
      reHeader: new RegExp('^\\s*' + HEAD_PREFIX + '(?:' + g.headerWords.join('|') + ')\\s*[：:]?\\s*$')
    };
  });

  /* 只回答"这一行是什么题型"，不改动输入。找不到标记 → null（不是"猜一个"）。 */
  function detectType(line) {
    const text = String(line == null ? '' : line);
    if (!text) return null;
    for (let i = 0; i < TYPE_MARKERS.length; i++) {
      const mk = TYPE_MARKERS[i];
      if (mk.re.test(text) || mk.reColon.test(text) || mk.reHeader.test(text)) return mk.type;
    }
    return null;
  }

  /* 命中标记时返回 {type, matched, rest, header}，未命中返回 null
   * header=true 表示"整行只是个段头"（没有随行的题干）—— 调用方据此知道
   * "接下来这些题都属于这一节"，于是才敢用题号/空行在节内断题。 */
  function matchTypeMarker(line) {
    const text = String(line == null ? '' : line);
    if (!text) return null;
    for (let i = 0; i < TYPE_MARKERS.length; i++) {
      const mk = TYPE_MARKERS[i];
      let m = text.match(mk.re);
      if (m) return { type: mk.type, matched: m[0], rest: text.slice(m[0].length), header: false };
      m = text.match(mk.reColon);
      if (m) return { type: mk.type, matched: m[0], rest: text.slice(m[0].length), header: false };
      m = text.match(mk.reHeader);
      if (m) return { type: mk.type, matched: m[0], rest: '', header: true };
    }
    return null;
  }

  /* ================= 二、判断题正误归一 ================= */

  /* ---------------- 答案字母归一（**唯一实现**） ----------------
   * 为什么放在解析层：`schema.js`（校验答案键）、`quiz.js`（判用户作答）都要用同一把尺子，
   * 而两者都已依赖本模块（见契约第六章的顺序门禁）。
   * 早先 schema 与 quiz 各有一份，于是出现"计分侧认 ＡＣ、校验侧不认"的两把尺子。
   */
  /* 全角 → 半角（中文输入法下很容易打出「Ａ」）。字母与数字都归一。 */
  function toHalfWidth(s) {
    return String(s).replace(/[\uFF21-\uFF3A\uFF41-\uFF5A\uFF10-\uFF19]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    });
  }
  /* 用户作答 / 答案键 → 字母串。
   *   · 接受字符串、数字、字母数组、Set（作答侧的几种合理形态都给过）
   *   · **拒绝对象/布尔/null** —— 早先 `String({})` = '[object Object]' 会被抽出 B/C/E，
   *     "其实没作答"就变成了"选错了 B、C、E"（放水配置下还能拿分）
   */
  function normLetters(s) {
    const one = function (x) { return (typeof x === 'string' || typeof x === 'number') ? toHalfWidth(x) : ''; };
    if (s instanceof Set) return [...s].map(one).join('').toUpperCase().replace(/[^A-H]/g, '');
    if (Array.isArray(s)) return s.map(one).join('').toUpperCase().replace(/[^A-H]/g, '');
    if (typeof s !== 'string' && typeof s !== 'number') return '';
    return toHalfWidth(s).toUpperCase().replace(/[^A-H]/g, '');
  }
  function toSet(s) { return new Set(normLetters(s).split('').filter(Boolean)); }
  /* 答案键集合：一律走同一把尺子（toSet → normLetters：全角/大小写/只抽 A–H）。
   * 早先 Set 分支自己写了一遍 `String(x).toUpperCase()`，成了第三种形态：
   * Set(['ａ','ｂ']) 得不到归一、Set(['A','Z']) 的 Z 也不过滤（数组形态却是对的）。 */
  function letterSet(v) {
    return toSet(v);
  }
  /* 单选题只取第一个字母 */
  function firstLetter(v) {
    if (Array.isArray(v) || v instanceof Set) { const s = letterSet(v); return s.size ? [...s][0] : ''; }
    return normLetters(v).charAt(0);
  }

  // 规格要求的 12 种写法（6 正 + 6 反）全部落在这里；另收 真/假/非/✓/✗ 等常见变体。
  const TRUE_EXACT  = ['√', '✓', '对', '正确', '是', '真', 't', 'true', 'y', 'yes', '1'];
  const FALSE_EXACT = ['×', '✗', 'x', '错', '错误', '否', '假', '非', 'f', 'false', 'n', 'no', '0'];

  // 子串兜底**刻意只用不会藏在别的词里的词**：
  //   · 排除 `是`/`否` —— "是否/能否/与否"里含它们，会把问句误判成答案
  //   · 排除单字母 t/f/x/y/n/1/0 —— "test" 里有 t、"none" 里有 n
  const TRUE_SUB  = ['正确', '是的', '对的', '√', '✓', '对'];
  const FALSE_SUB = ['错误', '错的', '×', '✗', '错'];
  // 否定前缀：不正确 / 不对 / 不是 / 没错 / 非正确
  const NEG_PREFIX = ['不', '非', '没'];
  // 否定词**出现在句中**时的判定表（自然写法：「这题不对」「我认为不正确」「不是错的」）
  const NEG_FALSE_WORDS = ['不正确', '不对', '不是', '非正确', '有误'];
  const NEG_TRUE_WORDS  = ['没错', '没有错', '不是错的', '并不错误'];
  // 问句式写法，本身就带歧义，不许猜。
  // 除了「是否/与否」，还要收自然口语变体：「是不是」「对不对」——
  // 它们含「不是/不对」，不先拦住就会被否定式规则判成"错"（把一个问句当成答案）。
  // 另收**对冲/含糊**说法（「不一定」「对了一半」）：那不是判断题的答案，按歧义处理，
  // 否则「这不一定对」会因为含「对」被判成 true（键=对时白拿满分）。
  const AMBIGUOUS_RE = /(是否|与否|能否|可否|是不是|对不对|行不行|好不好|可不可以|不一定|未必|可能|也许|大概|一半|半对|部分|半数|差不多|有些)/;

  const JUDGE_STRIP = /[\s\u3000。．.、,，;；:：!！?？"'“”‘’()（）【】\[\]]/g;

  function subJudgeToken(s) {
    // 先做整串精确匹配 —— 这里**允许单字**（是/否/t/f/1/0）。
    // 必要性：否定式里剩下的往往就是一个单字，如「不是」→ 余下「是」。
    // （子串兜底才需要排除单字，两件事的严格度不同，别混在一起）
    if (TRUE_EXACT.indexOf(s) >= 0) return true;
    if (FALSE_EXACT.indexOf(s) >= 0) return false;

    let t = false, f = false;
    for (let i = 0; i < TRUE_SUB.length; i++) if (s.indexOf(TRUE_SUB[i]) >= 0) { t = true; break; }
    if (!t) for (let i = 0; i < TRUE_EXACT.length; i++) {
      const w = TRUE_EXACT[i];
      if (w.length > 1 && s.indexOf(w) >= 0) { t = true; break; }
    }
    for (let i = 0; i < FALSE_SUB.length; i++) if (s.indexOf(FALSE_SUB[i]) >= 0) { f = true; break; }
    if (t && !f) return true;
    if (f && !t) return false;
    return null;
  }

  /*
   * 判断题答案归一。
   * 返回 { value: true|false|null, reason: string|null }
   *   value=null 表示"认不出来 / 本身歧义" → 上层会把它标进 review，计分侧对 null 恒给 0 分。
   * 绝不返回"猜的"结果。
   */
  function normalizeJudge(raw) {
    if (raw === true || raw === false) return { value: raw, reason: null };

    const shown = String(raw == null ? '' : raw).trim();
    const v = shown.toLowerCase().replace(JUDGE_STRIP, '');
    if (!v) return { value: null, reason: '判断题没有答案' };

    const isT = TRUE_EXACT.indexOf(v) >= 0;
    const isF = FALSE_EXACT.indexOf(v) >= 0;
    if (isT && !isF) return { value: true, reason: null };
    if (isF && !isT) return { value: false, reason: null };

    // 问句式：「正确与否」「是否」——本身就要求判断，不能当答案
    if (AMBIGUOUS_RE.test(v)) {
      return { value: null, reason: '判断题答案含「是否/与否」这类问法，存在歧义，待人工校对："' + shown + '"' };
    }
    // 反问/商量语气结尾（吗/呢/吧）：「这不是对的吗」「是对的吧」——
    // 这类句子里的正/误词是**反问**，直接按字面判必然出错（"这不是对的吗"其实意思是对）。
    if (/[吗呢吧]$/.test(v)) {
      return { value: null, reason: '判断题答案用了反问/商量语气，存在歧义，待人工校对："' + shown + '"' };
    }

    // 多重否定（`不是不对` / `不是不正确` / `既不…也不…`）：嵌套否定的语义要人来定，
    // 硬猜必然有一半是判反。放在前缀判定**之前**，否则前缀路径会把 `不是不对` 先判成 false。
    {
      const marks = v.match(/[不非没]/g);
      if (marks && marks.length >= 2) {
        return { value: null, reason: '判断题答案含多重否定，存在歧义，待人工校对："' + shown + '"' };
      }
    }

    // 否定式：`不正确`=错、`不对`=错、`不是`=错、`没错`=对
    // 早期实现漏了这一步，会把「不正确」判成"正确"——判反。
    for (let i = 0; i < NEG_PREFIX.length; i++) {
      const p = NEG_PREFIX[i];
      if (v.length > p.length && v.indexOf(p) === 0) {
        // `非` 有时是**程度副词**而不是否定：「非常正确」= 很正确（不是"不正确"）。
        // 不豁免就会双向判反：非常正确→false、非常错误→true（键=对时白拿满分）。
        if (p === '非' && v.indexOf('非常') === 0) continue;
        const inner = subJudgeToken(v.slice(p.length));
        if (inner === true)  return { value: false, reason: null };
        if (inner === false) return { value: true,  reason: null };
      }
    }
    // 否定词**不在句首**的自然写法：「这题不对」「我认为不正确」「显然不对」。
    // （前缀判定只管句首，这类串会掉进子串兜底 —— 里面含「对」→ 判成"对"，正好判反。）
    //
    // ⚠ 这一段必须夹在两道**既有护栏之后**，而且和子串兜底用同一个长度阈值：
    //   ① 「正误并存 → 歧义」护栏（对错/正确错误混在一句 = 自相矛盾，不许猜）
    //   ② >8 字的长句不猜（长句里的正/误词往往只是叙述）
    //   早先它排在两道护栏**之前**，把护栏短路了：'并不错误但是也不完全正确'（自相矛盾）
    //   被判成 true、16 字的叙述句被判成 false —— 等于用一个"更敢猜"的规则盖掉"不猜"的规则。
    const negBlock = (function () {
      if (v.length > 8) return null;                       // 长句交人工（与下面的长度护栏同一条规矩）
      let trueWord = null, falseWord = null, falseCount = 0;
      for (let i = 0; i < NEG_TRUE_WORDS.length; i++) {
        if (v.indexOf(NEG_TRUE_WORDS[i]) >= 0) { trueWord = NEG_TRUE_WORDS[i]; break; }
      }
      for (let i = 0; i < NEG_FALSE_WORDS.length; i++) {
        const w = NEG_FALSE_WORDS[i];
        if (v.indexOf(w) < 0) continue;
        // 「不是错的」里的「不是」是那个正向否定词的一部分，不算冲突
        if (trueWord && trueWord.indexOf(w) >= 0) continue;
        falseCount++;
        if (!falseWord) falseWord = w;
      }
      if (falseCount > 1) return { value: null, reason: '判断题答案含多重否定，存在歧义，待人工校对："' + shown + '"' };
      if (trueWord && falseWord) return { value: null, reason: '判断题答案同时含肯定与否定表述，存在歧义，待人工校对："' + shown + '"' };
      if (trueWord)  return { value: true,  reason: null };
      if (falseWord) return { value: false, reason: null };
      return null;
    })();

    const hasT = subJudgeToken(v) === true;
    const hasF = subJudgeToken(v) === false;

    // 同时含正/误表述（对错、正确错误）→ 自相矛盾，交人判
    let bothT = false, bothF = false;
    for (let i = 0; i < TRUE_SUB.length; i++)  if (v.indexOf(TRUE_SUB[i]) >= 0)  { bothT = true; break; }
    for (let i = 0; i < FALSE_SUB.length; i++) if (v.indexOf(FALSE_SUB[i]) >= 0) { bothF = true; break; }
    if (bothT && bothF) {
      return { value: null, reason: '判断题答案同时含正/误表述，存在歧义，待人工校对："' + shown + '"' };
    }
    // 两道护栏都过了，才轮到"句中否定式"结论
    if (negBlock) return negBlock;

    // 短答案（<=8 字）才允许子串兜底；长句子里的正/误词可能只是叙述，不猜
    if (v.length <= 8) {
      if (hasF) return { value: false, reason: null };
      if (hasT) return { value: true,  reason: null };
    } else if (hasT || hasF) {
      return { value: null, reason: '判断题答案过长且含正/误词，为避免误判，待人工校对："' + shown + '"' };
    }

    return { value: null, reason: '判断题答案无法识别："' + shown + '"' };
  }

  /* 是否需要人工校对（value=null 就是需要） */
  function judgeNeedsReview(raw) { return normalizeJudge(raw).value === null; }

  /* ================= 三、派生字段重算（切题与校对面板共用同一份规则） ================= */

  // 本模块自己派生出来的 review 文案。重算时先把它们清掉再重新推，
  // 否则用户把答案改对了、旧的"待校对"提示还挂在那儿。
  // 用户手写的、别的模块塞进来的 review 一律保留。
  const DERIVED_REVIEW_RE = new RegExp(
    '^(没有识别到答案' +
    '|简答关键词为自动生成' +
    '|简答有参考答案' +
    '|简答没有关键词' +
    '|判断题没有答案' +
    '|判断题答案无法识别' +
    '|判断题答案同时含' +
    '|判断题答案过长' +
    '|判断题答案含「是否' +
    '|题干里似乎混进了下一题' +
    '|选择题但选项少于 2 个)'
  );

  /*
   * 从 type / answer / options / keywords 重新算出所有派生字段：
   *   answerLetters（选择题）、judgeValue（判断题）、keywords（简答题）、review（所有人）
   * 幂等：applyDerived(applyDerived(q)) === applyDerived(q)
   *
   * 为什么独立成一个函数：切题时要用，校对面板用户改完答案/题型时也要用。
   * 两处各写一遍必然漂移 —— 面板改对了答案却忘了重算 judgeValue，
   * 就会出现"界面显示已修改、判分还是旧的"。
   */
  function applyDerived(q) {
    if (!q || typeof q !== 'object') return q;

    q.review = (Array.isArray(q.review) ? q.review : []).filter(function (s) {
      return !DERIVED_REVIEW_RE.test(String(s == null ? '' : s));
    });

    if (!q.answer) q.review.push('没有识别到答案');

    /* 安全网：题干里**又出现**"答案："或另一道题的题号 —— 说明切题可能漏了一刀
     * （整节并成一道题）。这条**由题干内容派生**（不是切题时一次性推的），
     * 所以用户把题干改好之后它会自己消失，不会永远挂着。
     * 简答题不查题号那条：简答材料里本来就常有一、1. 这类分点序号。 */
    const stemStr = String(q.stem || '');
    /* ⚠ 必须匹配**整行的开头**：题干里**引用**一句"答案：A 这种东西"不算漏切；
     *   真实漏切的形态是题干里多出一行以「答案：」打头的行。 */
    const looksUnsplit = /(?:^|\n)\s*[【\[]?\s*(?:正确|参考)?\s*答案\s*[】\]]?\s*[：:]/.test(stemStr) ||
      (q.type !== '简答' && /\n\s*\d{1,3}\s*[.、)．]\s*\S/.test(stemStr));
    if (looksUnsplit) {
      q.review.push('题干里似乎混进了下一题（出现了"答案："或题号）—— 可能漏切题，请核对');
    }

    if (q.type === '单选' || q.type === '多选') {
      const letters = q.answer ? (String(q.answer).toUpperCase().match(/[A-H]/g) || []) : [];
      // 单选题只取第一个字母：答案写"AB"是录入失误，不该变成多选语义
      q.answerLetters = (q.type === '单选') ? letters.slice(0, 1) : letters;
      q.judgeValue = null;
      // 注意：解析器原始产出里，非简答题的 keywords 仍是 []（不是 null）。
      // 归一成 null 是 schema 工厂的职责；消费解析器产出时按 (q.keywords || []) 防护。
      q.keywords = [];
      if (!Array.isArray(q.options)) q.options = [];
      if (q.options.length < 2) q.review.push('选择题但选项少于 2 个');
      return q;
    }

    q.answerLetters = null;

    if (q.type === '判断') {
      q.judgeValue = q.answer ? normalizeJudge(q.answer).value : null;
      q.keywords = [];
      if (q.answer && q.judgeValue === null) q.review.push(normalizeJudge(q.answer).reason);
      return q;
    }
    q.judgeValue = null;

    if (q.type === '简答') {
      if (!Array.isArray(q.keywords)) q.keywords = [];
      if (!q.keywords.length) {
        q.keywords = TextCore.fallbackKeywords(q.answer);
        if (q.keywords.length) {
          q.review.push('简答关键词为自动生成·需校对（原文档无加粗/高亮/颜色标记）');
        } else if (q.answer) {
          q.review.push('简答有参考答案，但自动切不出采分关键词（参考答案过长或没有标点），需人工填写采分点');
        } else {
          q.review.push('简答没有关键词（该题也没有参考答案）');
        }
      } else if (q.keywords.some(function (k) { return k.via === '自动(需校对)'; })) {
        // 关键词里只要还有"自动生成"的，就必须挂上需校对提示。
        // 必要性：关键词可能来自反序列化（导入 JSON / 结构化 txt），那时 review 提示是**没有**的；
        // 若这里不补，该题就会带着自动生成的关键词却**不被标记为待校对** —— 等于伪装成人工结果。
        q.review.push('简答关键词为自动生成·需校对（原文档无加粗/高亮/颜色标记）');
      }
      return q;
    }

    q.keywords = [];
    return q;
  }

  /* ================= 四、疑点分类（给校对面板按类别高亮用） ================= */

  // review 里存的是给人看的中文；面板要按类别高亮就不能靠猜文案，
  // 所以这里给稳定 id。新增 review 措辞时**必须**同步这里，否则面板漏高亮。
  const FLAG_RULES = [
    { id: 'judge-ambiguous',  label: '判断题答案歧义或无法识别，待人工校对',
      re: /判断题答案(无法识别|同时含|过长|含「是否)|判断题答案未确定/ },
    { id: 'judge-missing',    label: '判断题没有答案',                 re: /判断题没有答案/ },
    { id: 'no-answer',        label: '整题没有识别到答案',             re: /没有识别到答案/ },
    { id: 'too-few-options',  label: '选择题选项少于 2 个，可疑',       re: /选项少于 2 个/ },
    { id: 'choice-no-answer', label: '选择题没有答案',                 re: /选择题没有答案/ },
    { id: 'multi-one-answer', label: '多选题只有 1 个正确答案',         re: /多选题只有 1 个正确答案/ },
    { id: 'keywords-auto',    label: '简答关键词为自动生成，需校对',     re: /自动生成/ },
    { id: 'maybe-unsplit',    label: '题干里似乎混进了下一题（可能漏切题）',
      re: /(题干里似乎混进了下一题|出现了第二行「答案：」)/ },
    { id: 'keywords-missing', label: '简答缺采分关键词',
      re: /(切不出采分关键词|没有采分关键词|简答没有关键词)/ }
  ];

  /* 一道题命中哪些疑点 → [{id, label, text}]（text=原始 review 文案，便于面板直接显示） */
  function reviewFlags(q) {
    const out = [];
    const seen = {};
    const list = (q && Array.isArray(q.review)) ? q.review : [];
    for (let i = 0; i < list.length; i++) {
      const text = String(list[i] == null ? '' : list[i]);
      if (!text) continue;
      for (let j = 0; j < FLAG_RULES.length; j++) {
        const r = FLAG_RULES[j];
        if (!r.re.test(text)) continue;
        if (seen[r.id]) { seen[r.id].text += '；' + text; continue; }
        seen[r.id] = { id: r.id, label: r.label, text: text };
        out.push(seen[r.id]);
      }
    }
    return out;
  }

  /* 整卷扫描：只挑出需要人工看的题（校对面板就是渲染这个） */
  function collectReview(questions) {
    const out = [];
    (questions || []).forEach(function (q, i) {
      const flags = reviewFlags(q);
      if (flags.length) out.push({ index: i, type: q.type, stem: q.stem, flags: flags });
    });
    return out;
  }

  /* ================= 五、采分关键词（样式来源） ================= */

  // 从一组 run 里抽"被样式标记"的文字 → 采分关键词
  function pickKeywords(runs) {
    const kws = [];
    const push = function (t, why) {
      t = String(t || '').trim();
      if (!t) return;
      // 太长的（比如整句）不当关键词；标点剥掉
      t = t.replace(/^[\s，,。.、；;：:]+|[\s，,。.、；;：:]+$/g, '');
      if (!t || t.length > 24) return;
      if (kws.some(function (k) { return k.text === t; })) return;
      kws.push({ text: t, via: why });
    };
    (runs || []).forEach(function (r) {
      if (r.bold) push(r.text, '加粗');
      else if (r.highlight) push(r.text, '高亮');
      else if (r.shading) push(r.text, '底纹');
      else if (r.color) push(r.text, '字体色');
    });
    return kws;
  }

  /* ================= 六、切题 ================= */

  const RE_OPTION = /^\s*([A-Ha-h])\s*[.、)．:：]\s*(.*)$/;
  // 兼容：【答案】A / 答案：B / 正确答案: ABD / 参考答案：xxx（"参考"前缀 + 冒号可省略）
  const RE_ANSWER = /^\s*[【\[]?\s*(?:正确|参考)?\s*答案\s*[】\]]?\s*[：:]?\s*(.*)$/;
  const RE_EXPLAIN = /^\s*[【\[]?\s*(?:解析|解答|说明|分析)\s*[】\]]?\s*[：:]?\s*(.*)$/;
  const RE_QNUM = /^\s*(\d{1,3})\s*[.、)．]\s*/;
  /* 判断题答案写在题干末尾的写法：`…（×）` / `… （√）` / `…(错误)`。 */
  const RE_JUDGE_TAIL = /[（(]\s*(√|✓|×|✗|对|错|正确|错误)\s*[）)]\s*$/;

  /* 把"一行里挤着的多个选项"拆开：`A.甲 B.乙 C.丙 D.丁` → 4 个选项。
   *   · 只认**依次递增**的标签（A→B→C…，起始字母由 expectStart 给，用于"选项分多行"的文件）
   *     —— 选项文本里偶尔出现的 `B.` 不会把选项切成两半（它不满足"下一个"）。
   *   · 起点必须紧贴行首（调用方已用 RE_OPTION 的 `^` 保证），不会把题干里居中的 `A.` 当选项。
   *   · 一个都没拆出来时返回 []，调用方退回"整行当一个选项"的老路。 */
  function splitOptionLine(line, expectStart) {
    const s = String(line == null ? '' : line);
    const base = /^[A-H]$/.test(String(expectStart || '').toUpperCase()) ? String(expectStart).toUpperCase() : 'A';
    const re = /(?:^|\s)([A-Ha-h])\s*[.、)．:：]\s*/g;
    const marks = [];
    let m;
    while ((m = re.exec(s)) !== null) {
      const letter = m[1].toUpperCase();
      const want = String.fromCharCode(base.charCodeAt(0) + marks.length);
      if (letter !== want) continue;                 // 不是"下一个" → 不当边界
      marks.push({ start: m.index, contentAt: m.index + m[0].length, label: letter });
    }
    if (!marks.length) return [];
    return marks.map(function (mk, i) {
      const end = (i + 1 < marks.length) ? marks[i + 1].start : s.length;
      return { label: mk.label, text: s.slice(mk.contentAt, end).trim() };
    });
  }

  /* 判断题的答案写在题干末尾时把它取出来，并从题干里剥掉。
   * 只在"没有独立答案行"时调用（见 finish()），返回是否取到。 */
  function extractTailJudge(q) {
    if (!q) return false;
    const stem = String(q.stem || '');
    const m = stem.match(RE_JUDGE_TAIL);
    if (!m) return false;
    q.answer = m[1];
    q.stem = stem.slice(0, stem.length - m[0].length).replace(/\s+$/, '');
    return true;
  }

  /*
   * 把"段落"切成"题"。
   *
   * 默认约定（不传 opts）：只有 detectType 命中**显式标记**才开新题；
   *   无标记的行只会并入当前题题干 —— 不会被误当新题。
   *   这条不变，是本模块的立身之本。
   *
   * ⚠ 但"显式标记"不等于"每道题前面都写一遍题型"：真实题集绝大多数是**分节**写法
   *   （`一、单选题` 一段、`二、多选题` 一段…），节内靠题号或空行断题。
   *   所以补了两条节内断题规则（都只在"当前题已经写完"时才生效，见下面的注释）：
   *     · 带题号的行（`1.` `2、`）→ 开新题（多选/判断节常见：题与题之间没有空行）
   *     · 空行之后的整行文字 → 开新题（单选节常见：题干不编号，靠空行分隔）
   *
   * opts.defaultType（手动指定题型，用于"文件里根本没有题型标记"的情况）：
   *   给了它，才允许在没有显式标记时开新题 —— 靠题号（`1.` `2、`）或"第一行"断题。
   *   显式标记仍然优先：文件里哪题写了【多选】就是多选，不会被默认值盖掉。
   *   注意：这不是"强制全部改题型"（那是调用方在拿到题目后再改），
   *   它只回答"这份没有标记的文件，默认按什么题型切"。
   * opts.skipUntilNumber（配合 defaultType）：只在遇到题号时才开新题，
   *   用来跳过卷头标题（`计算机网络期末试卷`）那种"第一行不是题"的文件。
   *
   * opts.force（配合 defaultType）：**整份文件就按这个题型切，文件内部的标记不可信**。
   *   标记仍然会被剥掉（它不是题干的一部分），但题型号取 force 的值。
   *   为什么需要它：文件标着【判断】却带着 A/B 选项时，
   *   按判断切会把选项行并进题干 —— 之后无论怎么改题型都救不回选项了。
   */
  function segment(paras, opts) {
    const o = opts || {};
    const wantType = (o.defaultType && TYPES_FOR_SEGMENT.indexOf(o.defaultType) >= 0) ? o.defaultType : null;
    const forcedType = (o.force && wantType) ? wantType : null;   // 压制文件里的标记
    const defaultType = wantType;
    const skipUntilNumber = !!o.skipUntilNumber;
    const questions = [];
    let cur = null;
    /* 当前"节"的题型：段头（`一、单选题`）给的，或调用方用 defaultType 指定的。
     * 节内那些没有标记的题靠它定题型。 */
    let sectionType = defaultType;
    /* 上一行是空行（含只含空白的行）—— 真实题集里"空行 = 题与题的分隔"。 */
    let blockBreak = false;
    /* "这题已经写完了吗"：有答案、有解析，或判断题题干末尾自带了（√/×）。
     * **只有写完的题**才允许被下一行切开 —— 这样"多行题干 / 多行解析"永远不会被腰斩。 */
    const isComplete = function (q) {
      if (!q) return false;
      if (q.answer || q.explanation) return true;
      return q.type === '判断' && RE_JUDGE_TAIL.test(String(q.stem || ''));
    };

    const finish = function () {
      if (!cur) return;
      /* 段头会开出一个**空壳**题（`一、单选题` 自己没有题干），后面若又空行/又换节，
       * 别把空壳当题收进去 —— 否则题数里会多出"没有题干"的假题。 */
      if (!cur.stem && !cur.options.length && !cur.answer && !cur.explanation) { cur = null; return; }
      /* 判断题的答案常常写在题干末尾：`…（×）`。这是真实题集里极常见的写法，
       * 不认它就等于"整节判断题都没有答案"（用户实测那份 60 道判断全空）。 */
      if (cur.type === '判断' && !cur.answer) extractTailJudge(cur);
      applyDerived(cur);        // 派生字段（答案字母/判分值/关键词/review）只有这一处规则
      questions.push(cur);
      cur = null;
    };

    const open = function (type, stemText, rawText, p) {
      return {
        type: type,
        stem: String(stemText == null ? '' : stemText).replace(RE_QNUM, '').trim(),
        options: [], answer: '', explanation: '',
        keywords: [], inTextBox: !!p.inTextBox, review: [],
        number: (String(rawText).match(RE_QNUM) || [null, null])[1],
        // 本实现只认显式标记，从不"猜"题型，所以这个字段恒为 false。
        // 保留是为了不破坏既有的相邻契约（schema-parser.contract 会读它）。
        autoDetected: false
      };
    };

    /* 预先算好"下一行非空文字"：节内断题要用它做一次前瞻（见 1c 的 optionAhead）。 */
    const texts = (paras || []).map(function (p) { return String(p.text == null ? '' : p.text).trim(); });
    const nextNonEmpty = texts.map(function (_, i) {
      for (let k = i + 1; k < texts.length; k++) if (texts[k]) return texts[k];
      return '';
    });

    (paras || []).forEach(function (p, idx) {
      const text = texts[idx];
      const nextText = nextNonEmpty[idx];
      const afterBlank = blockBreak;
      blockBreak = false;
      /* 空行（含只含空白的行）**必须留成"分块信号"**，不能直接丢掉 ——
       * 单选节的题干不编号，题与题之间就只有一个空行；丢掉它整节会并成一道题。 */
      if (!text) { blockBreak = true; return; }

      // 1) 换了题型标记 → 开新题（显式标记永远优先）
      const hit = matchTypeMarker(text);
      if (hit) {
        finish();
        sectionType = forcedType || hit.type;    // 记住这一节的题型，供节内无标记的题沿用
        cur = open(sectionType, hit.rest, text, p);
        return;
      }

      // 1b) 没有标记但指定了默认题型：靠题号 / 第一行断题
      if (defaultType) {
        const numbered = RE_QNUM.test(text);
        const om0 = text.match(RE_OPTION);
        const isMeta = om0 || RE_ANSWER.test(text) || RE_EXPLAIN.test(text);
        // 题干行 = 带题号的，或（不跳过卷头时）当前还没开题的第一行
        if (numbered || (!cur && !skipUntilNumber && !isMeta)) {
          finish();
          cur = open(defaultType, text, text, p);
          return;
        }
      }

      if (!cur) return;   // 还没进任何题（比如标题/说明文字），跳过

      // 1c) 节内"下一题"的边界（**只在当前题已经写完时**才认，见 isComplete 的注释）
      if (sectionType && cur.type === sectionType && isComplete(cur)) {
        const isMeta = !!(text.match(RE_OPTION) || RE_ANSWER.test(text) || RE_EXPLAIN.test(text));
        const numbered = RE_QNUM.test(text);
        /* 空行分题只对"选择题/判断题"成立：简答题的**参考答案本身**就是一大段自由文字，
         * 里面完全可能有空行与新段落，拿空行切会把答案腰斩成新题。 */
        const blankSplit = afterBlank && cur.type !== '简答' &&
          (!!cur.answer || (cur.type === '判断' && RE_JUDGE_TAIL.test(String(cur.stem || ''))));
        /* ③ "这一行后面紧跟一行新的 `A.` 选项" —— 题干续行后面不会再冒出 A. 选项，
         *   所以它只可能是下一题的题干。这条把"既没有空行、也没有题号"的连排文件也救回来了。 */
        const optionAhead = cur.options.length >= 2 && /^\s*[Aa]\s*[.、)．:：]\s*\S/.test(nextText);
        if (!isMeta && (numbered || blankSplit || optionAhead)) {
          finish();
          cur = open(sectionType, text, text, p);
          return;
        }
      }

      // 2) 选项（一行里可能挤着好几个：`A.甲 B.乙 C.丙 D.丁`，真实题集极常见）
      const om = text.match(RE_OPTION);
      if (om && (cur.type === '单选' || cur.type === '多选' || cur.options.length)) {
        const want = String.fromCharCode(65 + cur.options.length);      // 接着已有的往下排（A→B→C…）
        const parts = splitOptionLine(text, want);
        (parts.length ? parts : [{ label: om[1].toUpperCase(), text: om[2].trim() }])
          .forEach(function (op) { cur.options.push(op); });
        return;
      }
      // 3) 答案（可能带样式关键词，简答要抓）
      const am = text.match(RE_ANSWER);
      if (am) {
        /* ⚠ 一题只该有一行答案。第二行答案意味着**前面漏切了一刀**（两题并成了一题）。
         *   以前这里是直接覆盖 —— 第一题的答案被悄悄换掉，界面上完全看不出来。
         *   现在保留第一行并把这件事挂成疑点（宁可让人看见，也不静默丢数据）。 */
        if (cur.answer) {
          cur.review.push('这一题出现了第二行「答案：」—— 前面可能漏切了一题（已保留第一行的答案），请核对');
          return;
        }
        cur.answer = am[1].trim();
        if (cur.type === '简答') cur.keywords = cur.keywords.concat(pickKeywords(p.runs));
        return;
      }
      // 4) 解析（多行解析：续行并进解析，不覆盖）
      const em = text.match(RE_EXPLAIN);
      if (em) {
        const val = em[1].trim();
        if (cur.explanation) { cur.explanation += '\n' + val; return; }
        cur.explanation = val;
        return;
      }

      // 5) 其余：若简答且带样式 → 可能是关键词所在段落；否则并入题干
      if (cur.type === '简答') {
        const kws = pickKeywords(p.runs);
        if (kws.length && !cur.answer) { cur.keywords = cur.keywords.concat(kws); return; }
      }
      /* 题干的第一行：段头开出来的空壳题靠这一行拿到题干（并顺手剥掉题号，
       * 否则 `1. 我国…` 的题号会留在题干里）。 */
      if (!cur.stem) { cur.stem = text.replace(RE_QNUM, '').trim(); return; }
      cur.stem += '\n' + text;
    });

    finish();
    return questions;
  }

  return {
    TYPE_MARKERS: TYPE_MARKERS,
    TYPE_ALIASES: TYPE_ALIASES,
    detectType: detectType,
    matchTypeMarker: matchTypeMarker,
    normalizeJudge: normalizeJudge,
    // 答案字母归一的唯一实现（schema / quiz 都委托它）
    toHalfWidth: toHalfWidth, normLetters: normLetters, toSet: toSet,
    letterSet: letterSet, firstLetter: firstLetter,
    judgeNeedsReview: judgeNeedsReview,
    reviewFlags: reviewFlags,
    collectReview: collectReview,
    FLAG_RULES: FLAG_RULES,
    applyDerived: applyDerived,
    DERIVED_REVIEW_RE: DERIVED_REVIEW_RE,
    pickKeywords: pickKeywords,
    segment: segment,
    splitOptionLine: splitOptionLine, extractTailJudge: extractTailJudge, RE_JUDGE_TAIL: RE_JUDGE_TAIL,
    RE_OPTION: RE_OPTION, RE_ANSWER: RE_ANSWER, RE_EXPLAIN: RE_EXPLAIN, RE_QNUM: RE_QNUM
  };
});
