/* ============================================================
 *  parser-core.js —— 习题解析门面（façade）
 *
 *  职责已全部下沉，本文件只负责"读文件 → 拿段落 → 交给切题器 → 汇总统计"：
 *    core/parse/zip.js      自研 ZIP 读取（零依赖解压）
 *    core/parse/docx.js     docx → 带样式的段落（含格式闸门、文本框穿透）
 *    core/parse/text.js     txt 的编码兼容层（BOM/UTF-8/GBK + 兜底关键词）
 *    core/parse/segment.js  题型识别 · 判断题正误归一 · 歧义标定 · 切题
 *    本文件                 门面：对外 API 与历史完全一致，谁都不用改调用方式
 *
 *  加载顺序（构建内联时必须遵守）：
 *    zip.js → docx.js → text.js → segment.js → parser-core.js
 * ============================================================ */
(function (root, factory) {
  const isNode = (typeof module !== 'undefined' && module.exports);
  const ZipCore     = isNode ? require('./core/parse/zip.js')     : root.ZipCore;
  const DocxCore    = isNode ? require('./core/parse/docx.js')    : root.DocxCore;
  const TextCore    = isNode ? require('./core/parse/text.js')    : root.TextCore;
  const SegmentCore = isNode ? require('./core/parse/segment.js') : root.SegmentCore;
  const api = factory(ZipCore, DocxCore, TextCore, SegmentCore);
  if (isNode) module.exports = api;
  root.QuizParser = api;
})(typeof self !== 'undefined' ? self : this, function (ZipCore, DocxCore, TextCore, SegmentCore) {
  'use strict';

  const missing = [];
  if (!ZipCore)     missing.push('core/parse/zip.js');
  if (!DocxCore)    missing.push('core/parse/docx.js');
  if (!TextCore)    missing.push('core/parse/text.js');
  if (!SegmentCore) missing.push('core/parse/segment.js');
  if (missing.length) {
    // 内联顺序错了要立刻炸，不要静默降级成一堆空函数
    throw new Error('parser-core 依赖缺失：请先加载 ' + missing.join('、') + '（顺序不可颠倒）');
  }

  function makeStats(questions) {
    const byType = {};
    let review = 0, kw = 0;
    questions.forEach(q => {
      byType[q.type] = (byType[q.type] || 0) + 1;
      if (q.review.length) review++;
      kw += q.keywords.length;
    });
    return { total: questions.length, byType: byType, needsReview: review, keywords: kw };
  }

  /* ---------------- 对外入口 ---------------- */

  // docx：读取（含格式闸门）交给 DocxCore，切题交给 SegmentCore
  // 注意：DocxCore.readParagraphs 在闸门不通过时直接抛错，
  //       因此本函数不会产出"半截题目"。
  async function parseDocx(arrayBuffer) {
    const paras = await DocxCore.readParagraphs(arrayBuffer);
    const questions = SegmentCore.segment(paras);
    return {
      meta: { source: 'docx', paragraphs: paras.length,
              textBoxParagraphs: paras.filter(p => p.inTextBox).length },
      questions: questions, stats: makeStats(questions)
    };
  }

  // 已解码好的文本 → 切题。签名冻结为 1 元，不许改。
  function parseText(text) {
    const paras = parasFromText(text);
    const questions = SegmentCore.segment(paras);
    return {
      meta: { source: 'txt', paragraphs: paras.length, textBoxParagraphs: 0 },
      questions: questions, stats: makeStats(questions)
    };
  }

  function parasFromText(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    return lines.map(l => ({ runs: [{ text: l }], text: l.trim(), inTextBox: false }));
  }

  /*
   * 「手动指定题型」解析：用于**文件里根本没有题型标记**的情况。
   * opts: { type, skipUntilNumber }
   *   type            → 没有标记的题按这个题型切（显式标记仍然优先，不会被盖掉）
   *   skipUntilNumber → 只在遇到 `1.` `2、` 这类题号时才开新题（用来跳过卷头标题）
   * 不传 opts 时与 parseText 完全一致。
   */
  function parseTextAs(text, opts) {
    const o = opts || {};
    const paras = parasFromText(text);
    const questions = SegmentCore.segment(paras, { defaultType: o.type, skipUntilNumber: o.skipUntilNumber, force: o.force });
    return {
      meta: { source: 'txt', paragraphs: paras.length, textBoxParagraphs: 0,
              defaultType: o.type || null, skipUntilNumber: !!o.skipUntilNumber },
      questions: questions, stats: makeStats(questions)
    };
  }

  // 字节级入口：真实的 .txt 文件是字节，必须先解编码再切题。
  // 探测规则见 core/parse/text.js：BOM → 严格UTF-8 → GBK家族 → 非严格UTF-8(记账损失)
  async function parseTxtBytes(input, opts) {
    const d = TextCore.decodeAuto(input, opts);
    const r = parseText(d.text);
    r.meta.encoding = d.encoding;
    r.meta.hadBom = d.hadBom;
    r.meta.replaced = d.replaced;
    r.meta.lossy = d.lossy;
    r.meta.tried = d.tried;
    return r;
  }

  // 同上，但允许手动指定题型（见 parseTextAs 的说明）
  async function parseTxtBytesAs(input, opts) {
    const o = opts || {};
    const d = TextCore.decodeAuto(input, { encoding: o.encoding });
    const r = parseTextAs(d.text, { type: o.type, skipUntilNumber: o.skipUntilNumber });
    r.meta.encoding = d.encoding;
    r.meta.hadBom = d.hadBom;
    r.meta.replaced = d.replaced;
    r.meta.lossy = d.lossy;
    r.meta.tried = d.tried;
    return r;
  }

  // docx 版的手动指定题型
  async function parseDocxAs(arrayBuffer, opts) {
    const o = opts || {};
    const paras = await DocxCore.readParagraphs(arrayBuffer);
    const questions = SegmentCore.segment(paras, { defaultType: o.type, skipUntilNumber: o.skipUntilNumber, force: o.force });
    return {
      meta: { source: 'docx', paragraphs: paras.length,
              textBoxParagraphs: paras.filter(p => p.inTextBox).length,
              defaultType: o.type || null, skipUntilNumber: !!o.skipUntilNumber },
      questions: questions, stats: makeStats(questions)
    };
  }

  /* ---------------- 对外 API（与历史完全一致 + 本小类新增） ---------------- */
  return {
    // 门面自身
    parseDocx: parseDocx, parseText: parseText, parseTxtBytes: parseTxtBytes,
    // 手动指定题型（文件里没有题型标记时用）
    parseDocxAs: parseDocxAs, parseTextAs: parseTextAs, parseTxtBytesAs: parseTxtBytesAs,
    // 切题 / 题型识别 / 归一（实现已迁到 core/parse/segment.js）
    segment: SegmentCore.segment,
    detectType: SegmentCore.detectType,
    normalizeJudge: SegmentCore.normalizeJudge,
    pickKeywords: SegmentCore.pickKeywords,
    fallbackKeywords: TextCore.fallbackKeywords,
    // 疑点分类：给校对面板按类别高亮用（本小类新增）
    reviewFlags: SegmentCore.reviewFlags,
    collectReview: SegmentCore.collectReview,
    TYPE_MARKERS: SegmentCore.TYPE_MARKERS,
    TYPE_ALIASES: SegmentCore.TYPE_ALIASES,
    RE_OPTION: SegmentCore.RE_OPTION,
    RE_ANSWER: SegmentCore.RE_ANSWER,
    RE_EXPLAIN: SegmentCore.RE_EXPLAIN,
    RE_QNUM: SegmentCore.RE_QNUM,
    // 转出下层能力（保持历史 API 不变，demo 与旧测试仍在用）
    unzip: ZipCore.unzip, inflateRaw: ZipCore.inflateRaw,
    extractParagraphs: DocxCore.extractParagraphs, parseRuns: DocxCore.parseRuns,
    readParagraphs: DocxCore.readParagraphs, diagnose: DocxCore.diagnose,
    sniff: ZipCore.sniff,
    // txt 编码层
    decodeAuto: TextCore.decodeAuto, decodeText: TextCore.decodeText,
    detectEncoding: TextCore.detectEncoding,
    // 下层模块句柄（便于按模块引用）
    ZipCore: ZipCore, DocxCore: DocxCore, TextCore: TextCore, SegmentCore: SegmentCore
  };
});
