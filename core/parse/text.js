/* ============================================================
 *  core/parse/text.js —— 纯文本(txt)导入的「编码兼容层 + 兜底关键词」
 *
 *  为什么需要它：
 *    真实世界的中文 txt 有一大半是 GBK(代码页 936) 存的。
 *    直接当 UTF-8 解会得到满屏 ""，用户看到的结论是"这软件坏了"。
 *    而"先严格试 UTF-8，失败再退 GBK 家族"能在**零依赖**前提下
 *    覆盖绝大多数真实文件；真判不出来时用 replaced/lossy 明确告诉
 *    用户"这份有损"，而不是假装成功。
 *
 *  依赖：只用浏览器原生 API（TextDecoder）+ JS 标准库，零外部依赖。
 *        不 require 任何本仓库模块（保持"叶子模块"，内联顺序无约束）。
 *
 *  导出（接口已冻结，见 CONTRACT / 验收标准）：
 *    decodeAuto(input, opts) -> { text, encoding, hadBom, replaced, lossy, tried }
 *    decodeText(input, encodingLabel) -> string
 *    detectEncoding(input) -> { encoding, hadBom, reason }
 *    fallbackKeywords(answerText, opts) -> [{ text, via:'自动(需校对)' }]
 *    splitByPunctuation(s) -> string[]
 *
 *  加载顺序（构建内联时）：本模块无依赖，与 zip.js 同级，可任意先后。
 * ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TextCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FFFD = '\uFFFD';                     // U+FFFD 替换符：解码损失的唯一硬判据
  const BOM_BYTES = [0xEF, 0xBB, 0xBF];      // UTF-8 BOM
  const VIA_AUTO = '自动(需校对)';            // 兜底关键词的来源标记（契约冻结值）
  // 「人工/样式」来源：兜底关键词一个都不许落在这里，否则就是伪装
  const MANUAL_VIAS = ['加粗', '高亮', '字体色', '底纹', '手动'];
  const GB_FAMILY = ['gbk', 'gb18030', 'gb2312'];
  const SUPPORTED_ENCODINGS = ['utf-8', 'utf-8-bom', 'gbk', 'gb18030'];
  // 与 parser-core.js 的兜底切分规则保持逐字一致（行为一致是硬要求）
  const PUNCT_RE = /[，,。.；;、\n]+/;

  /* ================= 输入归一 ================= */

  // 任何输入都不许抛异常：认不出来的一律当"空字节"处理
  function toBytes(input) {
    if (input === null || input === undefined) return new Uint8Array(0);
    try {
      if (input instanceof Uint8Array) {
        // 注意 Node 的 Buffer 是池化分配的：必须尊重 byteOffset/byteLength，
        // 不能写成 new Uint8Array(buf.buffer)，否则会读到别人的字节。
        return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      }
      if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) {
        return new Uint8Array(input);
      }
      if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(input)) {
        return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      }
      // 跨 realm 的 typed array：instanceof 会失效，用鸭子类型兜一层
      if (input && input.buffer && typeof input.byteLength === 'number') {
        return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
      }
      if (Array.isArray(input)) return new Uint8Array(input);
    } catch (e) {
      return new Uint8Array(0);
    }
    return new Uint8Array(0);   // 数字/普通对象/函数… → 视为空输入
  }

  function hasBom(u8) {
    return !!u8 && u8.length >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF;
  }

  function countFffd(s) {
    const m = String(s == null ? '' : s).match(/\uFFFD/g);
    return m ? m.length : 0;
  }

  /* ================= TextDecoder 薄封装 ================= */
  // 本仓库的 zip.js 同样无条件使用 TextDecoder（浏览器/Node 18+ 均有），
  // 故这里不内置手写解码器，只在构造失败（标签不被支持）时优雅退出。

  function makeDecoder(label, fatal) {
    try { return new TextDecoder(label, { fatal: !!fatal }); } catch (e) { return null; }
  }

  // 非严格解码：绝不抛
  function decodeLoose(u8, label) {
    const d = makeDecoder(label, false);
    if (!d) return '';
    try { return d.decode(u8); } catch (e) { return ''; }
  }

  // 严格解码结果：{ supported, ok, text }
  function tryFatalDecode(u8, label) {
    const d = makeDecoder(label, true);
    if (!d) return { supported: false, ok: false, text: '' };
    try { return { supported: true, ok: true, text: d.decode(u8) }; }
    catch (e) { return { supported: true, ok: false, text: '' }; }
  }

  // GB 家族专用：严格优先；严格不行再退非严格，并要求"干净"（不含 U+FFFD）。
  // 存在的意义：某些实现/标签不支持 fatal，此时只能靠"结果里有没有替换符"判定。
  function tryGbClean(u8, label) {
    const f = tryFatalDecode(u8, label);
    if (f.ok) {
      if (f.text.indexOf(FFFD) < 0) return { ok: true, text: f.text, mode: 'fatal' };
      return { ok: false, text: f.text, mode: 'fatal-replaced' };
    }
    const n = makeDecoder(label, false);
    if (!n) return { ok: false, text: '', mode: 'unsupported-label' };
    try {
      const s = n.decode(u8);
      if (s.indexOf(FFFD) < 0) return { ok: true, text: s, mode: 'nonfatal-clean' };
      return { ok: false, text: s, mode: 'nonfatal-replaced' };
    } catch (e) {
      return { ok: false, text: '', mode: 'nonfatal-throw' };
    }
  }

  /* ================= 编码标签归一 ================= */
  // 只认冻结枚举里的四个；认不出来 → 返回 null（视为"没指定"）
  function canonLabel(x) {
    if (x === null || x === undefined) return null;
    const s = String(x).trim().toLowerCase();
    if (!s) return null;
    if (s.indexOf('bom') >= 0) return 'utf-8-bom';
    if (s === 'utf-8' || s === 'utf8' || s === 'utf8-bom') return 'utf-8';
    if (s === 'gb18030' || s === 'gb-18030') return 'gb18030';
    if (s === 'gbk' || s === 'gb2312' || s === 'gb-2312' || s === 'cp936' || s === 'ms936' || s === '936') return 'gbk';
    return null;
  }

  function decoderLabelFor(canon) {
    if (canon === 'gb18030') return 'gb18030';
    if (canon === 'gbk') return 'gbk';
    return 'utf-8';
  }

  /* ================= 1) decodeAuto：核心入口 ================= */

  function decodeAuto(input, opts) {
    const o = (opts && typeof opts === 'object') ? opts : {};

    // 字符串 → 调用方已经解码好了，不再猜
    if (typeof input === 'string') {
      return { text: input, encoding: 'given', hadBom: false, replaced: 0, lossy: false, tried: [] };
    }

    const u8 = toBytes(input);
    // 第 1 步：空输入（也兜住 null/undefined/认不出的类型）
    if (!u8 || u8.length === 0) {
      return { text: '', encoding: 'utf-8', hadBom: false, replaced: 0, lossy: false, tried: [] };
    }

    const forced = canonLabel(o.encoding);
    const bom = hasBom(u8);

    // 第 7 步：强制指定编码 → 跳过探测；hadBom 仍按第 2 步判断，损失仍然统计
    if (forced) {
      const isUtf8 = (forced === 'utf-8' || forced === 'utf-8-bom');
      // 只有真按 UTF-8 解时才剥 BOM；强制 GB 时绝不静默丢字节
      const body = (isUtf8 && bom) ? u8.subarray(3) : u8;
      const text = decodeLoose(body, decoderLabelFor(forced));
      const replaced = countFffd(text);
      return {
        text: text,
        encoding: isUtf8 ? (bom ? 'utf-8-bom' : 'utf-8') : forced,
        hadBom: bom,
        replaced: replaced,
        lossy: replaced > 0,
        tried: []
      };
    }

    // 第 2 步：UTF-8 BOM（算法短路，不进入探测，故 tried 保持为空 —— 第 6 步只记第 3~5 步）
    if (bom) {
      const text = decodeLoose(u8.subarray(3), 'utf-8');
      const replaced = countFffd(text);
      return { text: text, encoding: 'utf-8-bom', hadBom: true, replaced: replaced, lossy: replaced > 0, tried: [] };
    }

    // 第 3 步：先严格试 UTF-8
    const tried = ['utf-8'];
    const u = tryFatalDecode(u8, 'utf-8');
    if (u.ok) {
      // 严格解码成功即判定 UTF-8 —— 即使正文里本来就含合法的 U+FFFD 字符也不改判
      const replaced = countFffd(u.text);
      return { text: u.text, encoding: 'utf-8', hadBom: false, replaced: replaced, lossy: replaced > 0, tried: tried };
    }

    // 第 4 步：GB 家族，第一个"成功且干净"的胜出；对外统一报 'gbk'
    for (let i = 0; i < GB_FAMILY.length; i++) {
      const label = GB_FAMILY[i];
      tried.push(label);
      const g = tryGbClean(u8, label);
      if (g.ok) {
        const replaced = countFffd(g.text);
        return { text: g.text, encoding: 'gbk', hadBom: false, replaced: replaced, lossy: replaced > 0, tried: tried };
      }
    }

    // 第 5 步：全失败 → 退回 UTF-8 非严格解码，如实报损
    const loose = decodeLoose(u8, 'utf-8');
    const replaced = countFffd(loose);
    return { text: loose, encoding: 'utf-8', hadBom: false, replaced: replaced, lossy: replaced > 0, tried: tried };
  }

  /* ================= 2) decodeText：指定编码解码 ================= */

  function decodeText(input, encodingLabel) {
    if (typeof input === 'string') return input;      // 已是文本，原样返回
    const u8 = toBytes(input);
    if (!u8 || u8.length === 0) return '';
    const canon = canonLabel(encodingLabel) || 'utf-8';   // 认不出的标签 → 退回 utf-8，不抛
    const isUtf8 = (canon === 'utf-8' || canon === 'utf-8-bom');
    const body = (isUtf8 && hasBom(u8)) ? u8.subarray(3) : u8;
    return decodeLoose(body, decoderLabelFor(canon));
  }

  /* ================= 3) detectEncoding：只探测，不解码 ================= */

  function detectEncoding(input) {
    if (typeof input === 'string') {
      return { encoding: 'given', hadBom: false, reason: '输入已经是字符串（视为已解码文本），无需探测' };
    }
    const u8 = toBytes(input);
    if (!u8 || u8.length === 0) {
      return { encoding: 'utf-8', hadBom: false, reason: '输入为空（0 字节），无需探测，按空 UTF-8 文本处理' };
    }
    if (hasBom(u8)) {
      return { encoding: 'utf-8-bom', hadBom: true,
               reason: '前 3 字节是 EF BB BF（UTF-8 BOM），直接判定 UTF-8 并剥掉 BOM' };
    }

    const u = tryFatalDecode(u8, 'utf-8');
    if (u.ok) {
      return { encoding: 'utf-8', hadBom: false,
               reason: '整段字节通过 UTF-8 严格（fatal）解码，判定为 UTF-8' };
    }

    for (let i = 0; i < GB_FAMILY.length; i++) {
      const label = GB_FAMILY[i];
      const g = tryGbClean(u8, label);
      if (g.ok) {
        return { encoding: 'gbk', hadBom: false,
                 reason: 'UTF-8 严格解码失败；用 ' + label + ' 解码成功且不含 U+FFFD，判定为 GBK（实际标签 ' + label + '，对外统一报 gbk）' };
      }
    }

    return { encoding: 'utf-8', hadBom: false,
             reason: 'UTF-8 严格解码失败，' + GB_FAMILY.join('/') + ' 也都解不干净；退回 UTF-8 非严格解码，结果会含替换符（有损）' };
  }

  /* ================= 4) 兜底关键词 ================= */

  function splitByPunctuation(s) {
    if (s === null || s === undefined) return [];
    const str = String(s);
    if (!str) return [];
    // 与 parser-core 的 fallbackKeywords 用同一套分隔符（含 + 的折叠写法）
    return str.split(PUNCT_RE).filter(function (p) { return p !== ''; });
  }

  function numOr(v, dflt) {
    if (typeof v === 'number') return isFinite(v) ? v : dflt;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      return isFinite(n) ? n : dflt;
    }
    return dflt;
  }

  function fallbackKeywords(answerText, opts) {
    if (answerText === null || answerText === undefined || answerText === '') return [];
    const o = (opts && typeof opts === 'object') ? opts : {};
    const max = numOr(o.max, 6);
    const maxLen = numOr(o.maxLen, 18);
    const minLen = numOr(o.minLen, 2);
    if (!(max > 0)) return [];

    const parts = splitByPunctuation(answerText);
    const kept = [];
    for (let i = 0; i < parts.length && kept.length < max; i++) {
      const t = parts[i].trim();
      if (t.length < minLen || t.length > maxLen) continue;   // 长度过滤
      if (kept.indexOf(t) >= 0) continue;                     // 去重（保序）
      kept.push(t);
    }
    // via 永远是「自动(需校对)」：这是"不伪装成人工标记"的唯一判据
    return kept.map(function (t) { return { text: t, via: VIA_AUTO }; });
  }

  /* ================= 导出 ================= */

  return {
    decodeAuto: decodeAuto,
    decodeText: decodeText,
    detectEncoding: detectEncoding,
    fallbackKeywords: fallbackKeywords,
    splitByPunctuation: splitByPunctuation,
    // 便于 UI / 测试引用的常量（非冻结接口，不影响上述五个函数）
    VIA_AUTO: VIA_AUTO,
    MANUAL_VIAS: MANUAL_VIAS,
    SUPPORTED_ENCODINGS: SUPPORTED_ENCODINGS
  };
});
