/* ============================================================
 *  core/parse/zip.js —— 自研 ZIP 读取（docx 就是个 zip）
 *
 *  为什么不用 fflate / JSZip：
 *    单文件离线可用是硬需求，多一个库就多几十~几百 KB 要内联。
 *    现代浏览器与 Node 18+ 都有 DecompressionStream('deflate-raw')，
 *    所以只需要自己解析 ZIP 目录结构，压缩交给原生。
 *
 *  错误一律带 code + hint，供 UI 直接展示（本模块不抛裸字符串）。
 * ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ZipCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIG_EOCD = 0x06054b50;   // End of Central Directory
  const SIG_CENTRAL = 0x02014b50; // Central Directory File Header

  // OLE2 复合文件头（.doc / .xls 老格式）
  const OLE2_MAGIC = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
  // ZIP 本地文件头（PK\x03\x04）或空归档（PK\x05\x06）
  const ZIP_MAGIC = [0x50, 0x4B];

  function fail(code, message, hint) {
    const e = new Error(message);
    e.code = code;
    e.hint = hint || '';
    return e;
  }

  function toU8(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (input && input.buffer instanceof ArrayBuffer) return new Uint8Array(input.buffer);
    throw fail('E_BAD_INPUT', '输入不是 ArrayBuffer / Uint8Array', '请用 FileReader.readAsArrayBuffer 读取文件');
  }

  /* 只嗅探类型，不解压 —— 用于"上传即判定"的快速闸门 */
  function sniff(input) {
    let u8;
    try { u8 = toU8(input); } catch (e) { return { kind: 'unknown', error: e }; }
    if (!u8 || u8.length === 0) return { kind: 'empty' };
    if (u8.length < 4) return { kind: 'unknown' };
    let ole = true;
    for (let i = 0; i < OLE2_MAGIC.length; i++) if (u8[i] !== OLE2_MAGIC[i]) { ole = false; break; }
    if (ole) return { kind: 'ole2' };                       // .doc 老格式
    if (u8[0] === ZIP_MAGIC[0] && u8[1] === ZIP_MAGIC[1]) return { kind: 'zip' };
    return { kind: 'unknown' };
  }

  /* 原生解压（浏览器 / Node 18+ 均有） */
  async function inflateRaw(raw) {
    if (typeof DecompressionStream === 'undefined') {
      throw fail('E_NO_DEFLATE_SUPPORT', '当前浏览器不支持 DecompressionStream("deflate-raw")',
                 '请换用较新的 Chrome/Edge/Firefox 打开（本应用需要它来解压 docx）');
    }
    try {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) {
      throw fail('E_CORRUPT', 'docx 内部数据解压失败（文件可能损坏）', '请用 Word 重新打开另存后再试');
    }
  }

  function findEOCD(u8, dv) {
    const minPos = Math.max(0, u8.length - 22 - 65535);
    for (let i = u8.length - 22; i >= minPos; i--) {
      if (dv.getUint32(i, true) === SIG_EOCD) return i;
    }
    return -1;
  }

  /* 读取 ZIP 目录，返回 { 文件名: {method, raw} } */
  async function unzip(input) {
    const u8 = toU8(input);
    const s = sniff(u8);
    if (s.kind === 'empty') throw fail('E_EMPTY', '文件是空的', '请选择有效的 .docx 文件');
    if (s.kind === 'ole2') {
      throw fail('E_OLD_DOC', '这是 .doc 老格式（OLE2 复合文件），不是 .docx',
                 '请在 Word 里「另存为」→ 选择「Word 文档 (*.docx)」后再导入');
    }
    if (s.kind !== 'zip') {
      throw fail('E_NOT_ZIP', '这不是一个有效的 .docx 文件（没有 ZIP 结构）',
                 'docx 本质是 zip；该文件可能是别的格式改了扩展名，请确认后用 Word 另存为 .docx');
    }
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const eocd = findEOCD(u8, dv);
    if (eocd < 0) throw fail('E_CORRUPT', 'docx 目录结构损坏（找不到 EOCD）', '请用 Word 重新打开另存后再试');

    const count = dv.getUint16(eocd + 10, true);
    const cdOffset = dv.getUint32(eocd + 16, true);
    if (cdOffset >= u8.length) throw fail('E_CORRUPT', 'docx 目录偏移越界（文件被截断）', '文件下载或复制不完整，请重新获取');

    const entries = {};
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (p + 46 > u8.length) throw fail('E_CORRUPT', 'docx 中央目录被截断', '文件不完整，请重新获取');
      if (dv.getUint32(p, true) !== SIG_CENTRAL) break;
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOff = dv.getUint32(p + 42, true);
      const name = new TextDecoder('utf-8').decode(u8.subarray(p + 46, p + 46 + nameLen));

      if (localOff + 30 > u8.length) throw fail('E_CORRUPT', 'docx 本地头越界（文件被截断）', '文件不完整，请重新获取');
      // 本地头里的文件名/扩展长度可能与中央目录不同，必须重读
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const dataEnd = dataStart + compSize;
      if (dataEnd > u8.length) throw fail('E_CORRUPT', 'docx 数据段越界（文件被截断）', '文件不完整，请重新获取');

      entries[name] = { method: method, raw: u8.subarray(dataStart, dataEnd) };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  /* 取某个条目的文本内容（自动判断是否 deflate） */
  async function readEntryText(entries, name) {
    const e = entries[name];
    if (!e) return null;
    if (e.method === 0) {
      let s = new TextDecoder('utf-8').decode(e.raw);
      return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
    }
    if (e.method !== 8) {
      throw fail('E_UNSUPPORTED_METHOD', 'docx 使用了不支持的压缩方式（method=' + e.method + '）',
                 '请用 Word 重新另存为 .docx（标准 deflate）');
    }
    const bytes = await inflateRaw(e.raw);
    let s = new TextDecoder('utf-8').decode(bytes);
    return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
  }

  return { sniff: sniff, unzip: unzip, inflateRaw: inflateRaw, readEntryText: readEntryText,
           OLE2_MAGIC: OLE2_MAGIC, fail: fail };
});
