/* ============================================================
 *  verify/safety.test.js —— 安全相关的**可复现**断言（防注入 / 防拒绝服务）
 *
 *  运行：node verify/safety.test.js
 *
 *  为什么单独开一个文件：这些断言回答的是"**别人递给我的东西**能不能伤到我"——
 *  与功能测试不是一回事，改动也常常不在同一个地方：
 *    ① 导入侧：恶意 docx（压缩炸弹 / 越界数字实体）不能让导入卡死或崩掉；
 *    ② 渲染侧：题面里的 HTML/JS 只能当**文字**显示，不能变成节点；
 *    ③ 导出侧：题面里的 `</script>` / 事件属性不能破坏分享文件结构，也不能带出机密键；
 *    ④ 接收侧：别人造的载荷只能落进白名单字段，不许污染原型或塞进未知键。
 *
 *  ⚠ 诚实划界：本文件是 **Node 侧**证据；"真浏览器里确实没执行"由
 *    `verify/inject-gen.js` + `verify/inject-parse.js` 那条流水线给（headless Edge 实跑）。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const HERE = path.join(__dirname, '..');

const ZipCore = require('../core/parse/zip.js');
const D = require('../core/data.js');
const S = require('../core/schema.js');
const Q = require('../core/quiz.js');

let pass = 0, fail = 0; const failures = [];
function brief(v) { const s = typeof v === 'string' ? v : JSON.stringify(v); return s == null ? String(s) : (s.length > 170 ? s.slice(0, 170) + '…' : s); }
function ok(c, t, d) {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d !== undefined ? '   ' + brief(d) : '')); }
  else { fail++; failures.push(t); console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + brief(d) : '')); }
}
function eq(a, e, t) { ok(JSON.stringify(a) === JSON.stringify(e), t + '   期望=' + brief(e), a); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }

/* ---------- 造一个最小可用的 .docx（zip：word/document.xml），供"恶意 docx"用例使用 ----------
 * ⚠ 读取端**不校验 CRC**（见 core/parse/zip.js 的 unzip），所以这里填 0 即可；
 *   要的就是"能被读进去"，好在解析层试恶意内容。 */
function crc32() { return 0; }
function makeDocx(documentXml) {
  const name = Buffer.from('word/document.xml', 'utf8');
  const data = zlib.deflateRawSync(Buffer.from(documentXml, 'utf8'));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
  local.writeUInt32LE(crc32(), 14); local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(Buffer.byteLength(documentXml), 22);
  local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14); central.writeUInt32LE(crc32(), 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(Buffer.byteLength(documentXml), 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const centralStart = local.length + name.length + data.length;
  const centralSize = central.length + name.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralSize, 12); eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([local, name, data, central, name, eocd]);
}
function docXmlWith(text) {
  return '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>'
    + text + '</w:t></w:r></w:p></w:body></w:document>';
}

(async function () {
  /* ============ ① 导入侧：压缩炸弹 ============ */
  head('① 压缩炸弹：docx 里一段数据解压后远超上限 → 必须**报错**而不是把内存打爆');
  ok(ZipCore.INFLATE_MAX_BYTES >= 16 * 1024 * 1024 && ZipCore.INFLATE_MAX_BYTES <= 256 * 1024 * 1024,
     '上限是个"人话"量级（' + Math.round(ZipCore.INFLATE_MAX_BYTES / 1024 / 1024) + ' MB）：既拦得住炸弹，又装得下真实卷子');

  const bomb = zlib.deflateRawSync(Buffer.alloc(4 * 1024 * 1024, 0x41));   // 4 MB 的 'A' → 压完只有几 KB
  let bombErr = null;
  try { await ZipCore.inflateRaw(bomb, { maxBytes: 64 * 1024 }); } catch (e) { bombErr = e; }
  eq([!!bombErr, bombErr && bombErr.code], [true, 'E_TOO_LARGE'], '  4 MB 的"炸弹"配 64 KB 上限 → E_TOO_LARGE');
  ok(bombErr && /压缩炸弹/.test(bombErr.message) && /另存/.test(bombErr.hint),
     '  报错文案说清"为什么"与"怎么办"（不是裸错误码）', bombErr && bombErr.message);

  const small = zlib.deflateRawSync(Buffer.from('正常内容', 'utf8'));
  const back = await ZipCore.inflateRaw(small, { maxBytes: 64 * 1024 });
  eq(Buffer.from(back).toString('utf8'), '正常内容', '  同一个函数在小数据上照常工作（没把好文件也毙掉）');

  const big = zlib.deflateRawSync(Buffer.alloc(3 * 1024 * 1024, 0x42));
  const bigOut = await ZipCore.inflateRaw(big, { maxBytes: 8 * 1024 * 1024 });
  eq(bigOut.length, 3 * 1024 * 1024, '  3 MB（在上限内）完整解出来，字节数没错');

  /* ============ ② 导入侧：越界数字实体 ============ */
  head('② 恶意 docx：越界数字字符引用（&#99999999;）不能让导入抛异常');
  const P = require('../parser-core.js');
  const badDocx = makeDocx(docXmlWith('【单选】恶意实体测试&#99999999;？&#x110000;还在吗？'));
  ok(Buffer.isBuffer(badDocx) && badDocx.length > 60, '先确认测试用 docx（自造 zip）是有效的', badDocx.length + ' 字节');
  let parseErr = null, parsed = null;
  try { parsed = await P.parseDocx(badDocx.buffer.slice(badDocx.byteOffset, badDocx.byteOffset + badDocx.byteLength)); }
  catch (e) { parseErr = e; }
  ok(!parseErr, '  解析**没有抛异常**（修前这里是 RangeError: Invalid code point）', parseErr && (parseErr.message || parseErr));
  if (!parseErr) {
    const stem = String((parsed.questions[0] || {}).stem || '');
    ok(stem.indexOf('恶意实体测试') >= 0, '  可读部分照常解析出来', stem);
    ok(stem.indexOf('\uFFFD') >= 0, '  越界引用换成 U+FFFD（与"解不出来的字节"同一种表现）', JSON.stringify(stem));
    ok(stem.indexOf('\uFFFD\uFFFD') >= 0 || stem.indexOf('还在吗') >= 0, '  后面的正文没有被吞掉');
  }

  /* ============ ③ 渲染侧：题面里的标记只能是文字 ============ */
  head('③ 渲染侧：题面/选项/解析里的 HTML 与 JS 只能当文字（渲染层不许拼 innerHTML）');
  const viewSrc = fs.readFileSync(path.join(HERE, 'ui', 'attempt-view.js'), 'utf8');
  const wrongSrc = fs.readFileSync(path.join(HERE, 'ui', 'wrong-view.js'), 'utf8');
  ['attempt-view.js', 'wrong-view.js'].forEach(function (f, i) {
    const src = i === 0 ? viewSrc : wrongSrc;
    ok(src.indexOf('innerHTML') < 0, '  ' + f + ' 里**没有** innerHTML（用户数据一律走 textContent）');
  });
  const QUICK = fs.readFileSync(path.join(HERE, 'ui', 'quick-panel.js'), 'utf8');
  ok(/用户数据一律 textContent，不碰 innerHTML/.test(QUICK), '  快捷面板的取数函数有这条明确规矩（注释即约束）');

  /* ============ ④ 导出侧：结构不被题面破坏、机密键不外流 ============ */
  head('④ 导出侧：`</script>` 与事件属性不能破坏分享文件结构；机密键一个都不许出去');
  const evil = S.createExam({
    id: 'EVIL1', title: '注入试探卷', configLocked: true, questions: [
      S.createQuestion({ id: 'EVIL1-q1', type: '单选', stem: '</script><img src=x onerror="window.__pwned=1">',
        options: [{ label: 'A', text: '<svg onload=alert(1)>' }, { label: 'B', text: '正常选项' }],
        answerLetters: ['B'], answer: 'B',
        explanation: '解析里塞 `javascript:alert(1)` 与 </SCRIPT > 变体' })
    ]
  }, {});
  const pkg = D.buildSharePackage({ exams: [evil] }, { secrets: [], at: '2026-01-01T00:00:00.000Z' });
  const file = D.buildShareHtml({ exams: [evil] }, '<html><body>壳</body></html>',
                                { secrets: [], allowUnsafe: false, at: '2026-01-01T00:00:00.000Z' });
  ok(pkg && pkg.ok !== false, '  出厂闸门放行一份"题面带攻击性标记"的卷（它是数据，不是缺陷）');
  const html = (file && file.html) || '';
  eq((html.match(/<img src=x onerror/gi) || []).length, 0, '  分享文件里没有**原样拼出来的** `<img src=x onerror`（题面里的标记没有变成元素）');
  ok(html.indexOf('\\u003cimg src=x') >= 0, '  它以转义形式（\\u003c）待在载荷 JSON 里 —— 是数据');
  ok(html.indexOf('\\u003c/script') >= 0 || html.indexOf('\\u003c/SCRIPT') >= 0,
     '  题面里的 `</script>` 也被转义（截不断文件）');
  eq(D.rawCloseInPayload(html), 0, '  载荷块里没有裸 `</script`（结构完整）');
  eq(D.payloadBlockCount(html).complete, 1, '  仍然恰好 1 个**完整**载荷块');
  eq(D.externalRefsIn(html), [], '  题面里的 `<img src=x>` 之类不会变成"外部引用"（导出仍是零外部引用）');

  /* 机密键 / 未知键 / 原型污染：白名单必须一个不多一个不少 */
  const nasty = S.createQuestion({ id: 'N1', type: '单选', stem: '原型试探', options: [{ label: 'A', text: '甲' }],
    answerLetters: ['A'], answer: 'A' });
  nasty.__proto__ = { polluted: 'yes' };
  nasty.constructor = { polluted: 'yes' };
  nasty.onclick = 'window.__pwned=1';
  nasty.apikey = 'sk-should-never-leak';
  nasty.records = [{ a: 1 }];
  const san = D.sanitizeSharePayload({ exams: [{ id: 'X1', title: 'T', configLocked: true, questions: [nasty] }] }, {});
  const q0 = san.exams[0].questions[0];
  eq(Object.keys(q0).sort(), D.SHARE_QUESTION_FIELDS.slice().sort(), '  题目层的键 = 白名单（未知键/事件属性/机密键全被丢掉）');
  eq(Object.keys(san.exams[0]).sort(), D.SHARE_EXAM_FIELDS.slice().sort(), '  试卷层的键 = 白名单');
  eq(({}).polluted, undefined, '  原型没被污染（({}).polluted === undefined）');
  ok(JSON.stringify(san).indexOf('sk-should-never-leak') < 0, '  密钥形状的串没跟着载荷出去');

  /* ============ ⑤ 接收侧：别人造的载荷，白名单在**使用边界**上生效 ============ */
  head('⑤ 接收侧：手工造的恶意载荷（__proto__ / 未知键 / 超深嵌套 / 超大体积）');
  const hostileJson = JSON.stringify({
    kind: 'quiz-share', schemaVersion: 1, __proto__: { polluted: 'yes' },
    exams: [{ id: 'H1', title: 'T', configLocked: true, extra: 'x', questions: [
      { id: 'h1', type: '单选', stem: 's', options: [{ label: 'A', text: 'a' }], answerLetters: ['A'], answer: 'A',
        __proto__: { polluted: 'yes' }, onclick: 'x', scriptText: '<img onerror=1>',
        nested: { deep: { deeper: { deepest: 1 } } } }
    ] }]
  });
  const hostFile = '<html><body><script id="' + D.PAYLOAD_ID + '" type="application/json">' + hostileJson + '<\/script></body></html>';
  const got = D.extractPayload(hostFile);
  ok(!!got, '  恶意载荷能被读出来');
  eq(({}).polluted, undefined, '  解析别人的载荷没有污染原型');
  /* ⚠ `extractPayload` 是**原样读**（只负责 JSON.parse），白名单在它后面两道边界上：
   *   ① 导出时 sanitizeSharePayload；
   *   ② 使用时 SchemaCore.createQuestion / QuizCore.resolveConfig。
   *   所以这里要验的是"**用起来**之后未知字段进不了模型"，而不是"读的时候就没了"。 */
  const q2 = S.createQuestion(got.exams[0].questions[0]);
  eq(q2.onclick, undefined, '  过一道 createQuestion 之后：onclick 不是模型字段（渲染层读不到它）');
  eq(q2.scriptText, undefined, '  题面之外塞的 scriptText 同样进不了模型');
  eq(Object.keys(q2).indexOf('nested'), -1, '  未知嵌套字段也进不来（schema 只认自己的字段）');
  eq(({}).polluted, undefined, '  建模过程也没有污染原型');
  const cfgHostile = Q.resolveConfig({ behavior: { autoNextMs: 99999, evil: 'x' } }, null);
  const delay = require('../core/flow.js').autoNextDelay(cfgHostile);
  eq([delay.ms, !!delay.fallback], [1500, true], '  恶意配置里的 autoNextMs=99999 → 用时校验拦下、落回默认并点名（不会真等 100 秒）');
  const deep = { a: 1 }; let cur = deep;
  for (let i = 0; i < 60; i++) { cur.n = {}; cur = cur.n; }
  const stripped = D.sanitizeSharePayload({ exams: [{ id: 'D1', title: 'T', configLocked: true,
    questions: [S.createQuestion({ id: 'd1', type: '单选', stem: 's', options: [{ label: 'A', text: 'a' }],
      answerLetters: ['A'], answer: 'A', extraDeep: deep })] }] }, {});
  ok(JSON.stringify(stripped).length < 2000, '  超深/超宽字段进不了载荷（深度上限 ' + D.STRIP_MAX_DEPTH + ' 层，fail-closed）');

  /* 超大载荷：别人给你一份"几百 MB 的试卷"→ 打开就卡死，必须拒载而不是硬吃 */
  ok(D.MAX_PAYLOAD_BYTES >= 4 * 1024 * 1024 && D.MAX_PAYLOAD_BYTES <= 128 * 1024 * 1024,
     '  载荷体积上限是个"人话"量级（' + Math.round(D.MAX_PAYLOAD_BYTES / 1024 / 1024) + ' MB）');
  const huge = '<html><body><script id="' + D.PAYLOAD_ID + '" type="application/json">'
    + '{"kind":"quiz-share","exams":[],"pad":"' + 'x'.repeat(D.MAX_PAYLOAD_BYTES + 1024) + '"}'
    + '<\/script></body></html>';
  const hugeR = D.extractPayloadDetailed(huge);
  eq([hugeR.ok, hugeR.reason], [false, 'too-large'], '  超大载荷 → 拒载（reason=too-large），不当场 JSON.parse 硬吃');
  ok(/上限/.test(hugeR.message) && /MB/.test(hugeR.message), '  拒载理由说人话（含体积与上限）', hugeR.message);

  console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
  console.log('  PASS ' + pass + '    FAIL ' + fail);
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
  process.exitCode = fail ? 1 : 0;
})();
