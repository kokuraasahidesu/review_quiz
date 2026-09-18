/* ============================================================
 *  core/parse/docx.js —— docx → 带样式的段落（不负责"切题"）
 *
 *  职责边界（避免与"题型识别与歧义标定"小类重叠）：
 *    本模块只把 docx 变成"段落 + 每段的 run 及其样式"，不做题型判定、不切题。
 *
 *  三个关键设计：
 *    1) 文本框穿透：先把 <w:txbxContent> 整块抽出并从主 XML 里挖掉，
 *       否则文本框里的 <w:p> 会让外层 <w:p> 的非贪婪匹配提前结束，
 *       导致正文尾部内容丢失（这是 mammoth 一类库做不到的地方）。
 *    2) 样式按 run 粒度提取：加粗 / 高亮 / 字体颜色 / 底纹 四类，
 *       并处理 <w:b w:val="0"/> 这类"显式取消加粗"。
 *    3) 不用 DOMParser：改用正则逐层切分 —— 这样同一份代码在 Node 里也能跑，
 *       可以在命令行做真实验证（浏览器我跑不了）。
 * ============================================================ */
(function (root, factory) {
  const ZipCore = (typeof module !== 'undefined' && module.exports)
    ? require('./zip.js')
    : root.ZipCore;
  const api = factory(ZipCore);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DocxCore = api;
})(typeof self !== 'undefined' ? self : this, function (ZipCore) {
  'use strict';

  const DOC_PATH = 'word/document.xml';

  /* ---------------- XML 小工具 ---------------- */
  /* ⚠ 数字字符引用**必须兜住越界**：`&#99999999;` / `&#x110000;` 会让 `String.fromCodePoint` 抛 RangeError，
   *   一个改过的 docx 就能把"导入"整条路打断（**拒绝服务**，不是代码执行 —— 但一样是攻击面）。
   *   越界一律换成 U+FFFD（与"解不出来的字节"同一种表现），照 data.js 的实体解码器那样返回可读文本。
   *   （`&amp;` 放最后：先把 `&amp;#60;` 解成 `&#60;` 再解数字引用是错的，所以顺序不能动。） */
  function codePointOr(s, radix) {
    const v = parseInt(s, radix);
    if (!isFinite(v) || v < 0 || v > 0x10FFFF) return '\uFFFD';
    try { return String.fromCodePoint(v); } catch (e) { return '\uFFFD'; }
  }
  function unescapeXml(s) {
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, function (m, h) { return codePointOr(h, 16); })
      .replace(/&#(\d+);/g, function (m, d) { return codePointOr(d, 10); })
      .replace(/&amp;/g, '&');
  }

  /* ---------------- 段落 → runs（含四类样式） ---------------- */
  function parseRuns(paraXml) {
    const runs = [];
    const runRe = /<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g;
    let m;
    while ((m = runRe.exec(paraXml)) !== null) {
      const inner = m[1];
      const rprMatch = inner.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/);
      const rpr = rprMatch ? rprMatch[1] : '';

      // 加粗：<w:b/> 为真；<w:b w:val="0|false|off"/> 为假
      let bold = /<w:b\s*\/>/.test(rpr) || /<w:b\s+w:val="(1|true|on)"/i.test(rpr);
      if (/<w:b\s+w:val="(0|false|off)"/i.test(rpr)) bold = false;

      let highlight = null;
      const hl = rpr.match(/<w:highlight\s+w:val="([^"]+)"/i);
      if (hl && hl[1].toLowerCase() !== 'none') highlight = hl[1];

      let color = null;
      const co = rpr.match(/<w:color\s+w:val="([^"]+)"/i);
      if (co && co[1].toLowerCase() !== 'auto' && co[1].toLowerCase() !== '000000') color = co[1];

      let shading = null;
      const sh = rpr.match(/<w:shd[^>]*w:fill="([^"]+)"/i);
      if (sh && sh[1].toLowerCase() !== 'auto' && sh[1].toLowerCase() !== 'ffffff') shading = sh[1];

      const italic = /<w:i\s*\/>/.test(rpr);
      const underline = /<w:u\s/.test(rpr);

      let text = '';
      const tRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
      let t;
      while ((t = tRe.exec(inner)) !== null) text += unescapeXml(t[1]);
      if (/<w:tab\s*\/>/.test(inner)) text = '\t' + text;
      if (/<w:br\s*\/>/.test(inner)) text += '\n';

      if (text === '' && !bold && !highlight && !color && !shading) continue;
      runs.push({ text: text, bold: bold, italic: italic, underline: underline,
                  highlight: highlight, color: color, shading: shading });
    }
    return runs;
  }

  /* ---------------- document.xml → 段落数组 ---------------- */
  function extractParagraphs(docXml) {
    if (typeof docXml !== 'string' || docXml.indexOf('<w:body') < 0) {
      // 有些生成器不写 <w:body>，退化为"只要有 <w:p> 就继续"
      if (typeof docXml !== 'string' || docXml.indexOf('<w:p') < 0) {
        throw ZipCore.fail('E_NO_PARAGRAPHS', 'document.xml 里找不到任何段落（<w:p>）',
                           '该文件可能不是文字试卷，或结构异常；请用 Word 打开确认后另存');
      }
    }
    const paras = [];
    const boxes = [];

    // ① 先把文本框整块摘出来（含它内部的段落），并从主 XML 里挖掉
    const boxRe = /<w:txbxContent>([\s\S]*?)<\/w:txbxContent>/g;
    let b;
    while ((b = boxRe.exec(docXml)) !== null) boxes.push(b[1]);
    const mainXml = docXml.replace(boxRe, '');

    const collect = function (xml, inTextBox) {
      const pRe = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
      let m;
      while ((m = pRe.exec(xml)) !== null) {
        const runs = parseRuns(m[1]);
        const text = runs.map(function (r) { return r.text; }).join('').trim();
        paras.push({ runs: runs, text: text, inTextBox: inTextBox });
      }
    };

    collect(mainXml, false);                 // ② 正文
    boxes.forEach(function (bx) { collect(bx, true); });   // ③ 文本框内容（排在正文之后）

    if (paras.length === 0) {
      throw ZipCore.fail('E_NO_PARAGRAPHS', 'document.xml 里没有任何段落内容',
                         '该文件可能是空文档；请确认试卷内容已写入 Word 的正文或文本框中');
    }
    return paras;
  }

  /* ---------------- 对外：读 docx → 段落（含格式闸门） ---------------- */
  async function readParagraphs(input) {
    const entries = await ZipCore.unzip(input);          // 空/老doc/非zip/损坏 都在这里被拦住
    const docXml = await ZipCore.readEntryText(entries, DOC_PATH);
    if (docXml == null) {
      throw ZipCore.fail('E_NO_DOCUMENT_XML', 'docx 里找不到 ' + DOC_PATH,
                         '该文件可能不是 Word 文档（例如 .doc 改名、或是别的 zip 包）；请用 Word 打开后另存为 .docx');
    }
    return extractParagraphs(docXml);
  }

  /* ---------------- 非抛出式体检（供上传时即时提示） ---------------- */
  async function diagnose(input) {
    const s = ZipCore.sniff(input);
    if (s.kind === 'empty')   return { ok: false, code: 'E_EMPTY', message: '文件是空的', hint: '请选择有效的 .docx 文件' };
    if (s.kind === 'ole2')    return { ok: false, code: 'E_OLD_DOC', message: '这是 .doc 老格式，不是 .docx',
                                       hint: '请在 Word 里「另存为」→ 选择「Word 文档 (*.docx)」后再导入' };
    if (s.kind !== 'zip')     return { ok: false, code: 'E_NOT_ZIP', message: '这不是有效的 .docx（没有 ZIP 结构）',
                                       hint: 'docx 本质是 zip；该文件可能是别的格式改了扩展名' };
    try {
      const paras = await readParagraphs(input);
      const inBox = paras.filter(function (p) { return p.inTextBox; }).length;
      return { ok: true, paragraphs: paras.length, textBoxParagraphs: inBox };
    } catch (e) {
      return { ok: false, code: e.code || 'E_UNKNOWN', message: e.message, hint: e.hint || '' };
    }
  }

  return {
    DOC_PATH: DOC_PATH,
    unescapeXml: unescapeXml,
    parseRuns: parseRuns,
    extractParagraphs: extractParagraphs,
    readParagraphs: readParagraphs,
    diagnose: diagnose
  };
});
