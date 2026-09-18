/* ============================================================
 *  core/text-format.js —— 试卷的「结构化纯文本格式」（导出 / 导入 / 入库）
 *
 *  三件正事：
 *    ① exportExam      把一份 Exam 写成**可读、可手工编辑**的纯文本
 *    ② importExam      纯函数（**不接收 store**）把文本还原成 Exam；错就报**可定位**的错误
 *    ③ importToLibrary **唯一会写 store 的入口**；解析 + 逐题校验 + 整卷校验全过才写
 *
 *  —— 为什么这样切分（决定了第 3 条验收"导入失败不破坏已有数据"能不能成立）——
 *    importExam 的签名里没有 store，所以它**结构上不可能**改到题库；
 *    importToLibrary 先把所有校验跑完，再碰第一个字节。
 *
 *  —— 与 core/parse/segment.js 的承重关系（顺序不可颠倒）——
 *    导入每题一律：SegmentCore.applyDerived(q)  →  SchemaCore.createQuestion(q)
 *      applyDerived   负责重算 answerLetters / judgeValue / keywords（简答兜底）/ review
 *      createQuestion 负责把"不适用字段"归一成 null（非选择题 options/answerLetters、
 *                     非简答题 keywords、非判断题 judgeValue）并固定键序
 *    反过来先 createQuestion 再 applyDerived，会把刚归一好的 null 又改回 []，
 *    "逐字段无差异"当场不成立。
 *
 *  —— 文本里存什么、不存什么 ——
 *    存：id / type / stem / options(含 label) / answer / keywords(含 via) / explanation /
 *        difficulty / inTextBox / review（+ 卷头 id/title/时间/config/configLocked）
 *    不存：answerLetters / judgeValue —— 由 applyDerived 从 answer 重算，且与原始一致
 *    review **存但不当权威值**：它只是喂给 applyDerived 的输入种子。
 *      applyDerived 会把"本模块派生"的文案剥掉重算（答案改了，旧提示不会残留），
 *      而模块手写的 review（如 schema-parser.contract 里的"题型为自动识别，请确认"）
 *      applyDerived 会保留 —— 不存它就会在往返里丢掉，那才是真的信息损失。
 *    options/keywords 的 null 与 [] 是**两种不同形状**（前者=该题型不适用，后者=适用但为空），
 *      所以文本里必须能分别声明（options: null / options: []），否则往返不可能逐字段相同。
 *
 *  —— 行号口径 ——
 *    所有错误/警告都带 1 起的行号（空文本为 0，因为没有"出错的那一行"）。
 *
 *  —— 版面（谁在哪一行）——
 *    第 1 行        格式头（带版本）
 *    卷头段落       title / id / createdAt / updatedAt / schemaVersion / questions
 *    题块段落       ## 第 N 题 + id/type/stem/options/answer/keywords/explanation/difficulty/inTextBox/review
 *    卷尾段落       config / configLocked（标准 JSON，中文保持字面量，可手改分值）
 *    卷尾段落只在末尾，是为了守住一条对人和工具都有用的不变量：
 *      **正文里第一处题型词总是某个题目的 type 行**。
 *      这样"替换第一处『单选』"这类破坏/检索一定落在真题上；
 *      否则 config 的键（points 里就有 '单选'）会先被命中，错误就指错了地方。
 *      读取侧不依赖位置：这两个字段名不属于题块字段，卷头卷尾都认。
 * ============================================================ */
(function (root, factory) {
  const isNode = (typeof module !== 'undefined' && module.exports);
  const SchemaCore = isNode ? require('./schema.js') : root.SchemaCore;
  const DataCore   = isNode ? require('./data.js')   : root.DataCore;
  const ExamsCore  = isNode ? require('./exams.js')  : root.ExamsCore;
  const SegmentCore= isNode ? require('./parse/segment.js') : root.SegmentCore;
  const api = factory(SchemaCore, DataCore, ExamsCore, SegmentCore);
  if (isNode) module.exports = api;
  root.TextFormatCore = api;
})(typeof self !== 'undefined' ? self : this, function (SchemaCore, DataCore, ExamsCore, SegmentCore) {
  'use strict';

  if (!SchemaCore || !DataCore || !ExamsCore || !SegmentCore) {
    throw new Error('text-format 依赖缺失：请先加载 core/schema.js、core/data.js、core/exams.js、core/parse/segment.js（顺序不可颠倒）');
  }

  /* ================= 一、常量 ================= */

  const FORMAT_VERSION = 1;
  // 第一行。版本号是这一段里**第一个出现的数字字符** ——
  // 「把文本里第一处 '1' 换成别的版本号」这类破坏必须正好落在版本位上。
  const HEADER = '# quiz-demo 试卷文本格式 v1';
  const HEADER_RE = /^#\s*quiz-demo\s+试卷文本格式(?:\s+v(\S*))?\s*$/;
  const QUESTION_HEAD_RE = /^\s*##\s*第\s*(\d+)\s*题\s*$/;
  const HASH_RE = /^\s*#/;
  // 字段行：`key:` + 至多一个分隔空格 + 值（值原样取到行尾）
  const FIELD_RE = /^([A-Za-z_][A-Za-z0-9_]*):[ \t]?([\s\S]*)$/;
  // 块内容行：允许缩进，第一个 `|` 之后全是内容（内容里的 `|` 不必转义）
  const BLOCK_RE = /^[ \t]*\|([\s\S]*)$/;
  // 选项行：`A. 内容` / `10、内容` …（标签不含空白与分隔符）
  const OPTION_RE = /^([^\s.、)．:：]{1,8})\s*[.、)．:：][ \t]?([\s\S]*)$/;
  // 关键词行：`[加粗] 三次握手`
  const KEYWORD_RE = /^\[([^\[\]]*)\][ \t]?([\s\S]*)$/;

  const TYPES = SchemaCore.TYPES.slice();          // ['单选','多选','判断','简答']
  const CHOICE_TYPES = ['单选', '多选'];
  const KEYWORD_VIAS = ['加粗', '高亮', '字体色', '底纹', '自动(需校对)', '手动'];

  const HEADER_FIELDS = ['title', 'id', 'createdAt', 'updatedAt', 'schemaVersion', 'config', 'configLocked', 'questions'];
  const QUESTION_FIELDS = ['id', 'type', 'stem', 'options', 'answer', 'keywords', 'explanation', 'difficulty', 'inTextBox', 'review'];
  // 注意：options / keywords / review 三者的"值"不是文本，而是形状声明（null / [] / 一组列表项），
  // 见 declOf；config 是唯一走自己编码（JSON）的字段，见 rawScalarOf。

  // strict 模式下把语义告警升级成同义的短错误码（默认不升级：解析器自己就会产出这些待校对状态）
  const WARN_TO_ERROR = {
    W_FEW_OPTIONS: 'E_FEW_OPTIONS',
    W_DUP_OPTION: 'E_DUP_OPTION',
    W_LETTER_NOT_IN_OPTIONS: 'E_BAD_ANSWER'
  };

  const MAX_LIST_ITEMS = 20000;    // 防御：恶意文本不至于把内存打爆

  function mkErr(line, code, message, hint) {
    return { line: line, code: code, message: message, hint: hint || '' };
  }
  function clip(s, n) {
    const t = String(s == null ? '' : s);
    const lim = n || 60;
    return t.length > lim ? t.slice(0, lim) + '…' : t;
  }
  function byLine(a, b) { return (a.line || 0) - (b.line || 0); }

  /* ================= 二、转义与多行 =================
   * 规则（与 JSON 同一套约定，只有五个转义）：
   *   \\ → 反斜杠      \n → 换行      \r → 回车      \t → 制表      \s → 半角空格
   * 别的 \x 一律**报错**（E_BAD_ESCAPE）而不是猜 —— 猜错了就是静默改内容。
   *
   * 行尾空白用 \s / \t 转义（关键取舍，别改）：
   *   解析时对每一行先做**右侧去空白**再识别结构（字段名/空值/`|` 前缀/`##` 标题）。
   *   为什么必须去：行尾空格是复制粘贴与编辑器的常态，「手工编辑」这个前提要求
   *   不能强迫用户逐字节对齐；而且 `  |A. 甲   ` 这种"内容合法、只是尾部多几个空格"
   *   若被判成"不认识的行"，提示还看不出问题在哪。
   *   代价：**内容本身**以空格/制表符结尾时必须转义，否则会被当成手抖多敲的空白吃掉。
   *   所以导出端把行尾内容里的空白写成 \s / \t —— "内容里的行尾空白"与"手抖的空格"
   *   因此可区分，往返仍然逐字段相同。行首空白不在此列（仍是内容，不需要转义）。
   *
   * 多行值两种写法都合法：
   *   行内：stem: 第一行\n第二行
   *   块：  stem:
   *         |第一行
   *         |第二行
   * 收尾规则：块 = 连续的若干 `|` 行；遇到第一行不是 `|` 开头的就结束。
   *   —— 因为**每一条**内容行都带 `|` 前缀，内容里再出现 `|`（或以 `|` 开头）都不会提前收尾，
   *      不需要"猜终止符"，也不需要禁止某个字符出现在正文里。
   * 例外只有一个：config 是 JSON，走它自己的编码（本格式的转义层不参与）。
   *
   * 开头 BOM：解析前剥掉**一个** U+FEFF（只在最开头）。
   *   Windows 记事本的「UTF-8」长期默认带 BOM，用户存一次就中招；
   *   而 BOM 不可见，报"头不对"会让人无从下手。自家 core/parse/text.js 的 txt 通道也剥 BOM，
   *   两条导入路径必须一致。
   */

  function encInline(v) {
    return String(v == null ? '' : v)
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r');
  }

  /* 行尾内容专用：把结尾的空格/制表符转义掉（配合解析端的右侧去空白） */
  function escTrail(s) {
    return String(s == null ? '' : s).replace(/[ \t]+$/, function (m) {
      let out = '';
      for (let i = 0; i < m.length; i++) out += (m.charAt(i) === ' ') ? '\\s' : '\\t';
      return out;
    });
  }
  /* 会落在行尾的那一段内容，用这个编码 */
  function encLine(v) { return escTrail(encInline(v)); }

  function decEscapes(s, line, errors) {
    const t = String(s == null ? '' : s);
    if (t.indexOf('\\') < 0) return t;
    let out = '';
    for (let i = 0; i < t.length; i++) {
      const c = t.charAt(i);
      if (c !== '\\') { out += c; continue; }
      const n = t.charAt(i + 1);
      if (n === '\\') { out += '\\'; i++; }
      else if (n === 'n') { out += '\n'; i++; }
      else if (n === 'r') { out += '\r'; i++; }
      else if (n === 't') { out += '\t'; i++; }
      else if (n === 's') { out += ' '; i++; }
      else {
        errors.push(mkErr(line, 'E_BAD_ESCAPE',
          '无法识别的转义「\\' + (n === '' ? '（行尾孤立的反斜杠）' : clip(n, 4)) + '」',
          '值里的反斜杠要写成 \\\\；换行写 \\n、回车写 \\r、制表写 \\t、行尾空格写 \\s（与 JSON 同一约定）'));
        return null;
      }
    }
    return out;
  }

  /* 标量字段：单行用行内写法；含换行时改用块写法（人一眼能看出是几行） */
  function fieldLines(key, value) {
    const v = String(value == null ? '' : value);
    if (v === '') return [key + ':'];
    if (v.indexOf('\n') >= 0) {
      return [key + ':'].concat(v.split('\n').map(function (l) { return '  |' + encLine(l); }));
    }
    return [key + ': ' + encLine(v)];
  }

  /* config 用**标准 JSON**（中文键保持字面量，人能直接改分值），只额外做两处安全转义：
   *   <        → \u003c    （内联进 <script> 时不会被 "</script>" 提前闭合）
   *   U+2028/9 → \u2028/9  （行分隔符，不能裸出现在会被当成"行"处理的地方）
   * 两者都是 JSON 标准转义，JSON.parse 原样还原，不损失可读性也不损失保真。 */
  function jsonSafety(s) {
    return s.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  }
  function configToLine(cfg) {
    if (cfg === undefined || cfg === null) return 'null';
    return jsonSafety(JSON.stringify(cfg));
  }

  function derivedComment(q) {
    if (!q || typeof q !== 'object') return '# 派生字段（导入时自动重算，不必手改）：题目对象缺失';
    return '# 派生字段（导入时自动重算，不必手改）：answerLetters=' +
      JSON.stringify(q.answerLetters == null ? null : q.answerLetters) +
      ' judgeValue=' + JSON.stringify(q.judgeValue == null ? null : q.judgeValue) +
      ' keywords=' + (Array.isArray(q.keywords) ? q.keywords.length : 0) +
      ' review=' + (Array.isArray(q.review) ? q.review.length : 0);
  }

  /* ================= 三、导出 ================= */

  function exportExam(exam, opts) {
    const o = opts || {};
    if (!exam || typeof exam !== 'object') throw new TypeError('exportExam：需要一份试卷对象');
    if (exam.questions != null && !Array.isArray(exam.questions)) {
      throw new TypeError('exportExam：exam.questions 必须是数组（宁可直接炸掉，也不导出一份"看起来少了一半题"的文本）');
    }
    const qs = Array.isArray(exam.questions) ? exam.questions : [];
    const L = [];

    L.push(HEADER);
    [].push.apply(L, fieldLines('title', exam.title == null ? '' : exam.title));
    [].push.apply(L, fieldLines('id', exam.id == null ? '' : exam.id));
    [].push.apply(L, fieldLines('createdAt', exam.createdAt == null ? '' : exam.createdAt));
    [].push.apply(L, fieldLines('updatedAt', exam.updatedAt == null ? '' : exam.updatedAt));
    L.push('schemaVersion: ' + (Number.isInteger(exam.schemaVersion) ? exam.schemaVersion : SchemaCore.SCHEMA_VERSION));
    // 题数是**完整性校验**（像 Content-Length）：文本被截断时能立刻发现，不用等人工比对
    L.push('questions: ' + qs.length);

    qs.forEach(function (q, i) {
      const item = (q && typeof q === 'object') ? q : {};
      L.push('');
      L.push('## 第 ' + (i + 1) + ' 题');
      [].push.apply(L, fieldLines('id', item.id == null ? '' : item.id));
      [].push.apply(L, fieldLines('type', item.type == null ? '' : item.type));
      [].push.apply(L, fieldLines('stem', item.stem == null ? '' : item.stem));

      const ops = item.options;
      if (ops == null) L.push('options: null');
      else if (!ops.length) L.push('options: []');
      else {
        L.push('options:');
        ops.forEach(function (op) {
          const x = (op && typeof op === 'object') ? op : {};
          // 选项文本落在行尾 → 用 encLine（行尾空白要转义）
          L.push('  |' + encInline(x.label == null ? '' : x.label) + '. ' + encLine(x.text == null ? '' : x.text));
        });
      }

      [].push.apply(L, fieldLines('answer', item.answer == null ? '' : item.answer));

      const kws = item.keywords;
      if (kws == null) L.push('keywords: null');
      else if (!kws.length) L.push('keywords: []');
      else {
        L.push('keywords:');
        kws.forEach(function (k) {
          const x = (k && typeof k === 'object') ? k : {};
          L.push('  |[' + encInline(x.via == null ? '' : x.via) + '] ' + encLine(x.text == null ? '' : x.text));
        });
      }

      [].push.apply(L, fieldLines('explanation', item.explanation == null ? '' : item.explanation));
      L.push('difficulty: ' + (Number.isInteger(item.difficulty) ? item.difficulty : 'null'));
      L.push('inTextBox: ' + (item.inTextBox ? 'true' : 'false'));

      const rev = Array.isArray(item.review) ? item.review : [];
      if (!rev.length) L.push('review: []');
      else {
        L.push('review:');
        rev.forEach(function (s) { L.push('  |' + encLine(s)); });
      }

      if (o.includeDerivedComments) L.push(derivedComment(item));
    });

    /* 整卷配置放在**末尾**，是两个要求夹出来的唯一位置：
     *   ① config 必须是可读的标准 JSON（中文键保持字面量，人能直接手改分值）；
     *   ② 正文里第一处题型词应当是**真题型行** —— 这样"替换第一处『单选』"这类
     *      工具化破坏/检索一定落在某个题目的 type 行上，而不是落在配置的键里。
     * 读取侧不依赖位置：config / configLocked 不是题块字段，出现在卷头还是卷尾都按整卷字段处理
     * （见 4.2 的分派规则），所以手写文本把 config 写回卷头也照样能读。 */
    L.push('');
    L.push('# ===== 整卷配置（标准 JSON，可手工编辑；导入时按结构校验）=====');
    L.push('config: ' + configToLine(exam.config));
    L.push('configLocked: ' + (exam.configLocked ? 'true' : 'false'));

    return L.join('\n') + '\n';
  }

  /* ================= 四、导入（纯函数） ================= */

  /* 字段值一律**先原样收着**，等到用的时候再解码。
   * 为什么必须懒解码：config 那一行是 JSON，自带 \uXXXX 转义；
   * 若在收行时统一过一遍本格式的转义层，"config: {\"k\":\"\\u5355\"}" 会被判成非法转义。 */
  function mkVal(inlineRaw, items, lineNo) {
    return { inlineRaw: inlineRaw == null ? null : inlineRaw, items: items || null, line: lineNo };
  }
  function decItems(v, errors) {
    if (v._items === undefined) {
      v._items = (v.items || []).map(function (it) { return decEscapes(it.text, it.line, errors); });
    }
    return v._items;
  }
  /* 标量文本（走本格式的转义层） */
  function scalarOf(v, errors) {
    if (!v) return '';
    if (v._scalar === undefined) {
      v._scalar = v.items
        ? decItems(v, errors).map(function (t) { return t == null ? '' : t; }).join('\n')
        : decEscapes(v.inlineRaw == null ? '' : v.inlineRaw, v.line, errors);
    }
    return v._scalar == null ? '' : v._scalar;
  }
  /* 原样标量（只给 config：不套本格式的转义） */
  function rawScalarOf(v) {
    if (!v) return '';
    return v.items ? v.items.map(function (it) { return it.text; }).join('\n')
                   : (v.inlineRaw == null ? '' : v.inlineRaw);
  }
  /* 形状声明：null / [] / 列表项 / 缺失 / 非法 */
  function declOf(v) {
    if (!v) return { kind: 'missing' };
    if (v.items) return { kind: 'list', items: v.items };
    const s = (v.inlineRaw == null) ? '' : v.inlineRaw;
    if (s === 'null') return { kind: 'null' };
    if (s === '[]') return { kind: 'empty' };
    if (s === '') return { kind: 'missing' };
    return { kind: 'bad', raw: s };
  }
  /* 选择题答案字母（与 applyDerived 同一规则：单选题只认第一个字母） */
  function lettersOf(type, answer) {
    const all = answer ? (String(answer).toUpperCase().match(/[A-H]/g) || []) : [];
    return (type === '单选') ? all.slice(0, 1) : all;
  }

  function parseForImport(text, opts) {
    const o = opts || {};
    const errors = [];
    const warnings = [];
    let src = String(text == null ? '' : text);
    // 剥掉开头**一个** U+FEFF（只在最开头）：
    // Windows 记事本的「UTF-8」长期默认带 BOM，用户拿它存一次就中招；
    // 而 BOM 不可见，不剥的话报"第一行不是本格式的头"会让人完全无从下手。
    // 自家 core/parse/text.js 的 txt 通道也剥 BOM（hadBom），两条导入路径必须一致。
    // 文本中间出现的 U+FEFF 是内容，不动它。
    if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);
    const lines = src.split(/\r\n|\n|\r/);
    const total = lines.length;
    const meta = { formatVersion: null, title: null, declaredCount: null, parsedCount: 0 };
    // 右侧去空白后再做结构识别：行尾空格是复制粘贴与编辑器的常态，
    // 「可手工编辑」不要求用户逐字节对齐。
    // 内容自带的行尾空白由导出端转义成 \s / \t，所以这条不会吃掉内容（见 §2）。
    function lineAt(k) { return String(lines[k] == null ? '' : lines[k]).replace(/[ \t]+$/, ''); }

    function warn(line, code, message, hint) {
      warnings.push(mkErr(line, code, message, hint));
      if (o.strict) errors.push(mkErr(line, WARN_TO_ERROR[code] || 'E_BAD_STRUCTURE', message, hint));
    }

    function fail(questionLines) {
      errors.sort(byLine);
      const first = errors[0] || mkErr(0, 'E_EMPTY', '文本为空', '');
      return {
        ok: false, errors: errors, warnings: warnings, exam: null,
        summary: '导入失败：共 ' + errors.length + ' 处问题；第一处：第 ' + (first.line || 0) + ' 行 ' + first.message,
        meta: meta, lines: total, questionLines: questionLines || []
      };
    }

    /* ---- 4.1 头 ---- */
    if (!src.trim()) {
      errors.push(mkErr(0, 'E_EMPTY', '文本为空（没有任何内容）', '请粘贴或选择一份本格式的试卷文本'));
      return fail();
    }
    const hm = lineAt(0).match(HEADER_RE);
    if (!hm) {
      errors.push(mkErr(1, 'E_NO_HEADER',
        '第一行不是本格式的头：' + clip(lineAt(0), 40),
        '第一行必须是「' + HEADER + '」'));
      return fail();
    }
    const rawVer = hm[1];
    if (rawVer == null || !/^\d+$/.test(rawVer)) {
      errors.push(mkErr(1, 'E_BAD_VERSION',
        '头里没有可识别的格式版本号' + (rawVer == null ? '（缺少 vN）' : '：v' + clip(rawVer, 20)),
        '第一行应为「' + HEADER + '」'));
      return fail();
    }
    const ver = parseInt(rawVer, 10);
    meta.formatVersion = ver;
    if (ver !== FORMAT_VERSION) {
      errors.push(mkErr(1, 'E_BAD_VERSION',
        '格式版本不认识：v' + ver + '（本程序只认 v' + FORMAT_VERSION + '）',
        ver > FORMAT_VERSION ? '这份文本比程序新，请升级程序后再导入' : '这份文本比程序旧，暂无该版本的迁移规则'));
      return fail();
    }

    /* ---- 4.2 扫行：头字段 / 题块 / 块内容 ---- */
    let i = 1;
    const top = {};
    const topSeen = {};
    const blocks = [];
    let cur = null;

    function readVal(inlineRaw, lineNo) {
      if (inlineRaw !== '') return mkVal(inlineRaw, null, lineNo);
      const items = [];
      while (i + 1 < lines.length && items.length < MAX_LIST_ITEMS) {
        // 用 lineAt 取行：整个 `  |内容   ` 先右侧去空白，内容天然也就不带多余的尾随空白
        const bm = lineAt(i + 1).match(BLOCK_RE);
        if (!bm) break;
        i++;
        items.push({ text: bm[1], line: i + 1 });
      }
      return mkVal(null, items.length ? items : null, lineNo);
    }

    for (; i < lines.length; i++) {
      const line = lineAt(i);
      const lineNo = i + 1;
      if (!line.trim()) continue;                       // 空行：纯分隔
      if (HASH_RE.test(line)) {
        const qm = line.match(QUESTION_HEAD_RE);
        if (!qm) continue;                              // 其余 '#' 行 = 注释
        if (cur) blocks.push(cur);
        cur = { headLine: lineNo, num: parseInt(qm[1], 10), fields: {} };
        continue;
      }
      const fm = line.match(FIELD_RE);
      if (!fm) {
        errors.push(mkErr(lineNo, 'E_BAD_STRUCTURE', '不认识的行：' + clip(line, 50),
          '每一行要么是「字段名: 值」，要么是「## 第 N 题」，要么是「|」开头的块内容，要么是「#」注释'));
        continue;
      }
      const key = fm[1];
      const val = readVal(fm[2], lineNo);
      // 分派规则：题块内且是题块字段 → 归当前题；其余按整卷字段处理（卷头卷尾都认）。
      // 为什么整卷字段不限定位置：config/configLocked 由导出写在**卷尾**（见 §3 末尾说明），
      // 而手写文本把它们写在卷头也该能读 —— 位置不该成为格式的一部分。
      if (cur && QUESTION_FIELDS.indexOf(key) >= 0) {
        if (cur.fields[key]) {
          errors.push(mkErr(lineNo, 'E_BAD_STRUCTURE', '第 ' + cur.num + ' 题里字段重复出现：' + key, '每个字段只能出现一次'));
          continue;
        }
        cur.fields[key] = val;
      } else if (HEADER_FIELDS.indexOf(key) >= 0) {
        if (topSeen[key]) {
          errors.push(mkErr(lineNo, 'E_BAD_STRUCTURE', '整卷字段重复出现：' + key, '每个字段只能出现一次'));
          continue;
        }
        topSeen[key] = 1;
        top[key] = val;
      } else if (cur) {
        errors.push(mkErr(lineNo, 'E_BAD_STRUCTURE', '第 ' + cur.num + ' 题里不认识的字段：' + key,
          '可用字段：' + QUESTION_FIELDS.join(' / ')));
      } else {
        errors.push(mkErr(lineNo, 'E_BAD_STRUCTURE', '试卷头里不认识的字段：' + key,
          '可用字段：' + HEADER_FIELDS.join(' / ')));
      }
    }
    if (cur) blocks.push(cur);
    meta.parsedCount = blocks.length;

    /* ---- 4.3 头字段语义 ---- */
    const title = top.title ? scalarOf(top.title, errors) : '';
    meta.title = title;
    if (!title.trim()) {
      errors.push(mkErr(top.title ? top.title.line : 1, 'E_NO_TITLE',
        '缺少试卷标题（title）或标题为空', '标题必须非空：title: 计算机网络 期中模拟卷'));
    }

    let config = null;
    if (top.config) {
      const rawCfg = rawScalarOf(top.config).trim();
      if (rawCfg !== '' && rawCfg !== 'null') {
        let parsed = null, bad = null;
        try { parsed = JSON.parse(rawCfg); } catch (e) { bad = (e && e.message) || String(e); }
        if (bad) {
          errors.push(mkErr(top.config.line, 'E_BAD_CONFIG',
            'config 不是合法 JSON：' + clip(bad, 60),
            'config 必须是 JSON 对象或 null（本格式把非 ASCII 写成 \\uXXXX，仍是标准 JSON）'));
        } else if (parsed !== null && typeof parsed !== 'object') {
          errors.push(mkErr(top.config.line, 'E_BAD_CONFIG',
            'config 必须是对象或 null，实际是 ' + (typeof parsed), ''));
        } else {
          config = parsed;
        }
      }
    }

    let configLocked = false;
    if (top.configLocked) {
      const raw = scalarOf(top.configLocked, errors).trim();
      if (raw === 'true' || raw === '1') configLocked = true;
      else if (raw === 'false' || raw === '0' || raw === '') configLocked = false;
      else errors.push(mkErr(top.configLocked.line, 'E_BAD_STRUCTURE',
        'configLocked 只能是 true / false，实际「' + clip(raw, 20) + '」', ''));
    }

    if (top.schemaVersion) {
      const raw = scalarOf(top.schemaVersion, errors).trim();
      if (!/^\d+$/.test(raw) || parseInt(raw, 10) !== SchemaCore.SCHEMA_VERSION) {
        errors.push(mkErr(top.schemaVersion.line, 'E_BAD_STRUCTURE',
          '结构版本（schemaVersion）应为 ' + SchemaCore.SCHEMA_VERSION + '，实际「' + clip(raw, 20) + '」',
          '这一行由导出生成；手写文本可以省略（省略即按当前结构版本）'));
      }
    }

    if (top.questions) {
      const raw = scalarOf(top.questions, errors).trim();
      if (!/^\d+$/.test(raw)) {
        errors.push(mkErr(top.questions.line, 'E_BAD_STRUCTURE',
          'questions 必须是题数（非负整数），实际「' + clip(raw, 20) + '」',
          '这一行是完整性校验用的题数声明，应与实际题块数一致'));
      } else {
        meta.declaredCount = parseInt(raw, 10);
        if (meta.declaredCount !== blocks.length) {
          errors.push(mkErr(top.questions.line, 'E_TRUNCATED',
            '题数不符：头里声明 ' + meta.declaredCount + ' 题，实际解析到 ' + blocks.length + ' 题',
            '文本很可能被截断（或复制不全）；若你确实手工删过题，请把这行改成 questions: ' + blocks.length));
        }
      }
    }

    /* ---- 4.4 逐题 ---- */
    const questions = [];
    const questionLines = [];
    const seenIds = {};

    blocks.forEach(function (b) {
      const F = b.fields;
      const headLine = b.headLine;
      const lineOf = function (k) { return F[k] ? F[k].line : headLine; };

      const type = F.type ? scalarOf(F.type, errors).trim() : '';
      if (!type) {
        errors.push(mkErr(lineOf('type'), 'E_BAD_STRUCTURE', '第 ' + b.num + ' 题缺少 type（题型）',
          '必须有 type: ' + TYPES.join(' | ')));
        questionLines.push(lineOf('type'));
        return;
      }
      if (TYPES.indexOf(type) < 0) {
        errors.push(mkErr(lineOf('type'), 'E_UNKNOWN_TYPE',
          '未知题型「' + clip(type, 20) + '」', '只能取 ' + TYPES.join(' / ')));
        questionLines.push(lineOf('type'));
        return;
      }
      const isChoice = CHOICE_TYPES.indexOf(type) >= 0;

      const stem = F.stem ? scalarOf(F.stem, errors) : '';
      if (!F.stem) {
        errors.push(mkErr(headLine, 'E_BAD_STRUCTURE', '第 ' + b.num + ' 题缺少 stem（题干）', '题干不能为空'));
      } else if (!stem.trim()) {
        errors.push(mkErr(lineOf('stem'), 'E_BAD_STRUCTURE', '第 ' + b.num + ' 题的题干为空', '题干不能为空'));
      }

      let options = null, optionsDeclared = false;
      if (!F.options) {
        if (isChoice) {
          errors.push(mkErr(headLine, 'E_FEW_OPTIONS',
            '第 ' + b.num + ' 题是选择题，却没有 options（选项）段',
            '选择题必须写 options: null / options: [] 或 |A. 选项 列表'));
        }
      } else {
        optionsDeclared = true;
        const d = declOf(F.options);
        if (d.kind === 'null') options = null;
        else if (d.kind === 'empty') options = [];
        else if (d.kind === 'list') {
          options = [];
          const dec = decItems(F.options, errors);
          d.items.forEach(function (rawItem, k) {
            // 行号取**该列表项自己那一行**，不是 keywords/options 段首行 —— 定位要能直接跳过去
            const item = dec[k];
            const om = String(item == null ? '' : item).match(OPTION_RE);
            if (!om) {
              errors.push(mkErr(rawItem.line, 'E_BAD_STRUCTURE',
                '第 ' + b.num + ' 题第 ' + (k + 1) + ' 个选项无法解析：' + clip(item, 40),
                '选项行应写成「A. 选项内容」'));
              return;
            }
            options.push({ label: om[1].toUpperCase(), text: om[2] });
          });
        } else {
          errors.push(mkErr(F.options.line, 'E_BAD_STRUCTURE',
            '第 ' + b.num + ' 题的 options 声明不合法：' + clip(d.raw, 30),
            '只能是 options: null、options: [] 或 | 开头的选项列表'));
        }
      }

      const answer = F.answer ? scalarOf(F.answer, errors) : '';

      let keywords = null, keywordsDeclared = false;
      if (F.keywords) {
        keywordsDeclared = true;
        const d = declOf(F.keywords);
        if (d.kind === 'null') keywords = null;
        else if (d.kind === 'empty') keywords = [];
        else if (d.kind === 'list') {
          keywords = [];
          const dec = decItems(F.keywords, errors);
          d.items.forEach(function (rawItem, k) {
            const item = dec[k];
            const km = String(item == null ? '' : item).match(KEYWORD_RE);
            if (!km) {
              errors.push(mkErr(rawItem.line, 'E_BAD_KEYWORD',
                '关键词缺少来源标注：' + clip(item, 40),
                '关键词行应写成「[加粗] 三次握手」；来源取 ' + KEYWORD_VIAS.join(' / ')));
              return;
            }
            const via = km[1].trim();
            const ktext = km[2];
            if (KEYWORD_VIAS.indexOf(via) < 0) {
              errors.push(mkErr(rawItem.line, 'E_BAD_KEYWORD',
                '关键词来源非法：「' + clip(via, 20) + '」', '只能取 ' + KEYWORD_VIAS.join(' / ')));
              return;
            }
            if (!ktext.trim()) {
              errors.push(mkErr(rawItem.line, 'E_BAD_KEYWORD', '关键词文本为空', '每个关键词都要有文本'));
              return;
            }
            keywords.push({ text: ktext, via: via });
          });
        } else {
          errors.push(mkErr(F.keywords.line, 'E_BAD_KEYWORD',
            '关键词段声明不合法：' + clip(d.raw, 30),
            '只能是 keywords: null、keywords: [] 或 |[来源] 关键词 列表'));
        }
      } else if (type === '简答') {
        keywords = [];        // 没写就交给 applyDerived 用参考答案兜底（并挂"需校对"）
      }

      const explanation = F.explanation ? scalarOf(F.explanation, errors) : '';

      let difficulty = null;
      if (F.difficulty) {
        const raw = scalarOf(F.difficulty, errors).trim();
        if (raw === '' || raw === 'null') difficulty = null;
        else if (/^\d+$/.test(raw) && parseInt(raw, 10) >= 1 && parseInt(raw, 10) <= 5) difficulty = parseInt(raw, 10);
        else {
          errors.push(mkErr(F.difficulty.line, 'E_BAD_DIFFICULTY',
            '难度只能是 1-5 的整数或 null，实际「' + clip(raw, 20) + '」', ''));
        }
      }

      let inTextBox = false;
      if (F.inTextBox) {
        const raw = scalarOf(F.inTextBox, errors).trim();
        if (raw === 'true' || raw === '1') inTextBox = true;
        else if (raw === 'false' || raw === '0' || raw === '') inTextBox = false;
        else {
          errors.push(mkErr(F.inTextBox.line, 'E_BAD_STRUCTURE',
            'inTextBox 只能是 true / false，实际「' + clip(raw, 20) + '」', ''));
        }
      }

      let review = [];
      if (F.review) {
        const d = declOf(F.review);
        if (d.kind === 'empty') review = [];
        else if (d.kind === 'list') review = decItems(F.review, errors).map(function (t) { return t == null ? '' : t; });
        else {
          errors.push(mkErr(F.review.line, 'E_BAD_STRUCTURE',
            'review 声明不合法：' + clip(d.kind === 'bad' ? d.raw : d.kind, 30),
            'review 在本结构里恒为数组：只能是 review: [] 或 | 开头的待校对文案列表'));
        }
      }

      /* 语义告警（默认只报警告）：这些都是**解析器自己会产出**的状态，
       * 拒绝它们就等于拒绝用户真正的卷子。strict 模式下才升级成错误。 */
      if (isChoice) {
        const ops = Array.isArray(options) ? options : [];
        const labels = ops.map(function (x) { return x.label; });
        if (ops.length < 2) {
          warn(lineOf('options'), 'W_FEW_OPTIONS',
            '第 ' + b.num + ' 题是选择题但只有 ' + ops.length + ' 个选项（少于 2 个），导入后会被标为待校对', '');
        }
        if (new Set(labels).size !== labels.length) {
          warn(lineOf('options'), 'W_DUP_OPTION',
            '第 ' + b.num + ' 题的选项标签有重复：' + labels.join(''), '');
        }
        lettersOf(type, answer).forEach(function (L) {
          if (labels.indexOf(L) < 0) {
            warn(lineOf('answer'), 'W_LETTER_NOT_IN_OPTIONS',
              '第 ' + b.num + ' 题的答案字母 ' + L + ' 不在选项里（' + (labels.join('') || '无选项') + '）', '');
          }
        });
      }

      /* 承重顺序：先派生、后工厂（见文件头说明） */
      const raw = {
        type: type, stem: stem, options: options, answer: answer,
        keywords: keywords, explanation: explanation, difficulty: difficulty,
        inTextBox: inTextBox, review: review
      };
      const qid = F.id ? scalarOf(F.id, errors).trim() : '';
      if (qid) raw.id = qid;

      SegmentCore.applyDerived(raw);
      const q = SchemaCore.createQuestion(raw, { rng: o.rng });

      // 形状保真：文本里显式声明的 null / [] 是"形状"，工厂归一后要还原回去
      if (optionsDeclared) q.options = options;
      if (keywordsDeclared) q.keywords = keywords;

      if (q.id) {
        if (seenIds[q.id]) {
          errors.push(mkErr(lineOf('id'), 'E_DUP_ID', '题目 id 重复：' + clip(q.id, 40),
            '同一份卷子里的题目 id 必须唯一'));
        }
        seenIds[q.id] = 1;
      }
      questions.push(q);
      questionLines.push(headLine);
    });

    if (errors.length) return fail(questionLines);

    /* ---- 4.5 组装整卷（键序与 SchemaCore.createExam 完全一致，保证 JSON 逐字节可比） ---- */
    const now = o.now || new Date().toISOString();
    const createdAt = top.createdAt ? scalarOf(top.createdAt, errors) : now;
    let updatedAt = top.updatedAt ? scalarOf(top.updatedAt, errors) : createdAt;
    if (o.touch) updatedAt = now;

    let finalTitle = title;
    if (o.title != null && String(o.title).trim()) finalTitle = String(o.title);

    let id = (top.id ? scalarOf(top.id, errors).trim() : '') || SchemaCore.newId('exam', o.rng);
    if (o.newIds) {
      id = SchemaCore.newId('exam', o.rng);
      questions.forEach(function (q) { q.id = SchemaCore.newId('q', o.rng); });
    }

    const exam = {
      id: id,
      schemaVersion: SchemaCore.SCHEMA_VERSION,
      title: finalTitle,
      createdAt: createdAt,
      updatedAt: updatedAt,
      config: config,
      configLocked: configLocked,
      questions: questions
    };

    return {
      ok: true, errors: [], warnings: warnings, exam: exam, summary: '',
      meta: meta, lines: total, questionLines: questionLines
    };
  }

  function importExam(text, opts) {
    const r = parseForImport(text, opts);
    if (!r.ok) return { ok: false, errors: r.errors, summary: r.summary };
    return { ok: true, exam: r.exam, warnings: r.warnings, lines: r.lines };
  }

  /* ================= 五、入库（唯一会写 store 的入口） ================= */

  // 与 core/exams.js 同一套键：卷本体 exam::<id>、轻量 meta exam::<id>::meta、全局索引 index
  function indexEntryOk(idx) {
    return !!(idx && typeof idx === 'object' && Array.isArray(idx.examIds));
  }
  async function writeIndexEntry(store, examId, now) {
    let idx = null;
    try { idx = await store.get('index'); } catch (e) { idx = null; }
    if (!indexEntryOk(idx)) idx = { examIds: [], updatedAt: null };
    if (idx.examIds.indexOf(examId) < 0) idx.examIds.push(examId);
    idx.updatedAt = now;
    await store.set('index', idx);
  }
  async function uniqueExamId(store, candidate, rng) {
    let id = candidate;
    for (let k = 0; k < 8; k++) {
      const exists = await store.get(DataCore.examBodyKey(id));
      if (exists == null) return id;
      id = SchemaCore.newId('exam', rng);
    }
    return id;
  }
  /* newIds 时确保新题目 id 与**库里已有题目**都不撞（只读，不写） */
  async function avoidLibraryIdClash(store, questions, rng) {
    const used = Object.create(null);
    let ids = [];
    try {
      const idx = await store.get('index');
      ids = indexEntryOk(idx) ? idx.examIds.slice() : [];
    } catch (e) { ids = []; }
    if (!ids.length) {
      try {
        const ks = await store.keysWithPrefix(DataCore.KEY_EXAM + DataCore.NS_SEP);
        ks.forEach(function (kk) {
          const rest = kk.slice(DataCore.KEY_EXAM.length + DataCore.NS_SEP.length);
          if (rest.indexOf(DataCore.NS_SEP) >= 0) return;
          if (ids.indexOf(rest) < 0) ids.push(rest);
        });
      } catch (e) { /* 读不到就当没有历史数据；不阻塞导入 */ }
    }
    for (const id of ids) {
      let ex = null;
      try { ex = await store.get(DataCore.examBodyKey(id)); } catch (e) { ex = null; }
      if (ex && Array.isArray(ex.questions)) {
        ex.questions.forEach(function (q) { if (q && q.id) used[q.id] = 1; });
      }
    }
    (questions || []).forEach(function (q) {
      if (!q) return;
      let guard = 0;
      while (used[q.id] && guard++ < 8) q.id = SchemaCore.newId('q', rng);
      used[q.id] = 1;
    });
  }

  async function importToLibrary(store, text, opts) {
    const o = opts || {};
    if (!store || typeof store.set !== 'function') {
      return { ok: false, blocked: true, errors: [mkErr(0, 'E_NO_STORE', '没有可用的存储（store）',
        'importToLibrary 需要 core/data.js 的 createStore 产物')] };
    }

    /* 1) 解析（纯函数，碰不到 store） */
    const r = parseForImport(text, o);
    if (!r.ok) return { ok: false, blocked: true, errors: r.errors, summary: r.summary };
    const exam = r.exam;
    const qLines = r.questionLines || [];

    /* 2) 逐题校验 —— 与题库既有入口（exams.appendQuestions / review.commit）同一把尺子 */
    const blocking = [];
    exam.questions.forEach(function (q, i) {
      const v = SchemaCore.validateQuestion(q);
      if (!v.ok) {
        blocking.push(mkErr(qLines[i] || 0, 'E_INVALID_QUESTION',
          '第 ' + (i + 1) + ' 题：' + v.errors.join('；'),
          '结构不合法的题题库不收（先修好它，或从文本里删掉这一题）'));
      }
    });
    /* 3) 整卷校验 */
    const ve = SchemaCore.validateExam(exam);
    const examErrs = ve.ok ? [] : ve.errors.map(function (m) { return mkErr(0, 'E_INVALID_EXAM', m, ''); });

    if (blocking.length || examErrs.length) {
      const all = blocking.concat(examErrs).sort(byLine);
      const first = all[0];
      return {
        ok: false, blocked: true, errors: all,
        summary: '整卷校验未通过，未写入存储（存储零变化）：共 ' + all.length + ' 处问题；第一处：' +
                 (first.line ? '第 ' + first.line + ' 行 ' : '') + first.message
      };
    }

    /* 4) id 落点（只读检查，仍然不写） */
    if (o.newIds) {
      exam.id = await uniqueExamId(store, exam.id, o.rng);
      await avoidLibraryIdClash(store, exam.questions, o.rng);
    }

    /* 5) 全部通过 → 从这里开始才允许写 */
    const now = o.now || new Date().toISOString();
    await store.set(DataCore.examBodyKey(exam.id), exam);
    const meta = ExamsCore.metaOf(exam);
    await store.set(DataCore.examSubKey(exam.id, 'meta'), meta);
    await writeIndexEntry(store, exam.id, now);

    return { ok: true, exam: exam, meta: meta };
  }

  /* ================= 六、损坏检测 ================= */

  function diagnose(text) {
    const r = parseForImport(text, {});
    return {
      ok: r.ok,
      errors: r.errors || [],
      formatVersion: r.meta ? r.meta.formatVersion : null,
      questionCount: r.ok ? r.exam.questions.length : (r.meta ? r.meta.parsedCount : 0),
      title: r.meta ? r.meta.title : null
    };
  }

  return {
    FORMAT_VERSION: FORMAT_VERSION,
    HEADER: HEADER,
    KEYWORD_VIAS: KEYWORD_VIAS,
    exportExam: exportExam,
    importExam: importExam,
    importToLibrary: importToLibrary,
    diagnose: diagnose
  };
});
