/* ============================================================
 *  verify/docx.test.js —— 「docx 通道」小类验收
 *  运行： node verify/docx.test.js
 *
 *  对照本小类三条验收标准：
 *    ① 回归样卷导入：10 题切分正确、题型分布与文本框识别（回归全绿）
 *    ② 三色关键词全抽对，且每条标明来源（加粗/高亮/字体色）
 *    ③ 格式闸门：.doc 老格式 / 非 zip / 缺 document.xml / 空文件 / 截断 / 无段落
 *       各自给出带 code+hint 的可读错误，且【不产生半截数据】
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const P = require('../parser-core.js');       // 门面
const DocxCore = require('../core/parse/docx.js');
const ZipCore = require('../core/parse/zip.js');

let pass = 0, fail = 0; const failures = [];
function ok(c, t, d) { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + d : '')))
                         : (fail++, failures.push(t), console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + JSON.stringify(d) : ''))); }
function eq(a, e, t) { const A = JSON.stringify(a), E = JSON.stringify(e); ok(A === E, t + '   期望=' + E, A); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }

const FIX = path.join(__dirname, '..', 'fixtures');
function readFix(n) { const b = fs.readFileSync(path.join(FIX, n)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
function readSample() { const b = fs.readFileSync(path.join(__dirname, '..', 'sample.docx')); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }

(async function main() {
  /* ============ ① 回归样卷 ============ */
  head('① 回归样卷：切题 / 题型分布 / 文本框识别');

  const r = await P.parseDocx(readSample());
  eq(r.meta.source, 'docx', '来源标记为 docx');
  eq(r.stats.total, 10, '切出 10 道题');
  eq(r.stats.byType, { '单选': 2, '多选': 1, '判断': 4, '简答': 3 }, '题型分布：单选2/多选1/判断4/简答3');
  ok(r.meta.textBoxParagraphs >= 3, '识别出文本框段落', String(r.meta.textBoxParagraphs));
  const boxQ = r.questions.filter(q => q.inTextBox);
  eq(boxQ.length, 1, '其中恰好 1 道题来自文本框');
  eq(boxQ[0].type, '判断', '文本框里那道是判断题');
  eq(boxQ[0].judgeValue, true, '文本框内的答案也能判分');
  eq(r.stats.needsReview, 1, '有 1 道标为待人工校对（歧义判断题）');

  /* ============ ② 三色关键词 ============ */
  head('② 简答关键词：三种样式标记全部抽对，且标明来源');

  const k7 = r.questions[6].keywords;
  eq(k7.map(k => k.text), ['SYN', 'SYN+ACK', 'ACK'], '加粗：SYN / SYN+ACK / ACK');
  eq(k7.map(k => k.via), ['加粗', '加粗', '加粗'], '  来源全部标为「加粗」');

  const k8 = r.questions[7].keywords;
  eq(k8.map(k => k.text), ['TLS/SSL', '443', '数字证书'], '高亮：TLS/SSL / 443 / 数字证书');
  eq(k8.map(k => k.via), ['高亮', '高亮', '高亮'], '  来源全部标为「高亮」');

  const k9 = r.questions[8].keywords;
  eq(k9.map(k => k.text), ['本地DNS服务器', '根域名服务器', '服务器地址'], '字体色：三个关键词');
  eq(k9.map(k => k.via), ['字体色', '字体色', '字体色'], '  来源全部标为「字体色」');

  // 底纹（第四类样式）用合成 XML 单测，样卷里没用到
  const shadeXml = '<w:p><w:r><w:rPr><w:shd w:val="clear" w:color="auto" w:fill="FFFF00"/></w:rPr><w:t>底纹词</w:t></w:r></w:p>';
  const shadeRuns = DocxCore.parseRuns(shadeXml);
  eq(shadeRuns[0].shading, 'FFFF00', '底纹（w:shd w:fill）被识别');
  eq(P.pickKeywords(shadeRuns).map(k => k.via), ['底纹'], '底纹词进入关键词且来源标为「底纹」');

  // 显式取消加粗不能被误判
  const noBold = DocxCore.parseRuns('<w:p><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>不该是关键词</w:t></w:r></w:p>');
  eq(noBold[0].bold, false, '<w:b w:val="0"/> 正确判为「非加粗」（不误抓关键词）');
  const autoColor = DocxCore.parseRuns('<w:p><w:r><w:rPr><w:color w:val="auto"/></w:rPr><w:t>默认色</w:t></w:r></w:p>');
  eq(autoColor[0].color, null, '字体色 auto 不当作关键词');

  /* ============ ③ 格式闸门 ============ */
  head('③ 格式闸门：坏文件必须被明确拒绝，且不产出半截数据');

  async function gate(fixture, expectCode, label) {
    let produced = null, caught = null;
    try { produced = await P.parseDocx(readFix(fixture)); }
    catch (e) { caught = e; }
    const codeOk = caught && caught.code === expectCode;
    const noPartial = produced === null;
    const hasMsg = !!(caught && caught.message && caught.message.length > 4);
    const hasHint = !!(caught && caught.hint && caught.hint.length > 4);
    ok(codeOk && noPartial && hasMsg && hasHint,
       label + ' → ' + expectCode,
       'code=' + (caught && caught.code) + '  有可读消息=' + hasMsg + '  有建议=' + hasHint + '  未产出半截数据=' + noPartial);
    return caught;
  }

  const eDoc = await gate('old_format.doc', 'E_OLD_DOC', '.doc 老格式被拒绝');
  ok(eDoc.hint.indexOf('另存为') >= 0, '  提示里明确要求「另存为 .docx」', eDoc.hint);

  await gate('no_document.zip', 'E_NO_DOCUMENT_XML', '合法 zip 但缺 word/document.xml');
  await gate('random.bin', 'E_NOT_ZIP', '非 zip 随机字节');
  await gate('empty.docx', 'E_EMPTY', '0 字节空文件');
  await gate('truncated.docx', 'E_CORRUPT', '被截断的 docx');
  await gate('fake_zip.docx', 'E_CORRUPT', '伪造 zip 签名 + 垃圾内容');
  await gate('no_paragraphs.docx', 'E_NO_PARAGRAPHS', '结构合法但正文没有任何段落');

  // 前缀嗅探：非法输入不该抛异常
  eq(ZipCore.sniff(new Uint8Array(0)).kind, 'empty', 'sniff：空 → empty');
  eq(ZipCore.sniff(new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])).kind, 'ole2', 'sniff：OLE2 → ole2');
  eq(ZipCore.sniff(new Uint8Array([0x50, 0x4B, 3, 4])).kind, 'zip', 'sniff：PK → zip');
  eq(ZipCore.sniff(new Uint8Array([1, 2, 3, 4])).kind, 'unknown', 'sniff：其它 → unknown');
  eq(ZipCore.sniff('not a buffer').kind, 'unknown', 'sniff：非 buffer 不抛异常，返回 unknown');

  /* ============ ④ diagnose：非抛出式体检（上传即判定要用） ============ */
  head('④ diagnose：上传时即时判定（不抛异常，给 UI 直接用）');

  let d = await DocxCore.diagnose(readSample());
  eq(d.ok, true, '好文件：ok=true');
  eq(d.paragraphs, r.meta.paragraphs, '  段落数与真实解析一致', String(d.paragraphs));
  eq(d.textBoxParagraphs, r.meta.textBoxParagraphs, '  文本框段落数一致');

  d = await DocxCore.diagnose(readFix('old_format.doc'));
  eq(d.ok, false, '坏文件：ok=false');
  eq(d.code, 'E_OLD_DOC', '  给出 code');
  ok(!!d.hint, '  给出 hint');

  d = await DocxCore.diagnose(readFix('truncated.docx'));
  eq(d.code, 'E_CORRUPT', '  截断文件也走同一套分类');

  /* ============ ⑤ 关键设计验证：文本框在中间不会吃掉后文 ============ */
  head('⑤ 文本框穿透的正确性（这是本模块最核心的设计声明）');

  const mid = await P.parseDocx(readFix('textbox_middle.docx'));
  eq(mid.stats.total, 3, '文本框在中间时，仍切出 3 道题（正文2 + 文本框1）');
  const stems = mid.questions.map(q => q.stem);
  ok(stems.some(s => s.indexOf('正文第一题') >= 0), '第一道正文题在');
  ok(stems.some(s => s.indexOf('文本框里的题目') >= 0), '文本框里的题被穿透拿到');
  ok(stems.some(s => s.indexOf('正文第三题') >= 0),
     '**文本框之后**的正文题没被吃掉（这就是"先抽文本框再解析"要解决的问题）', JSON.stringify(stems));
  const midBox = mid.questions.filter(q => q.inTextBox);
  eq(midBox.length, 1, '恰好 1 道题被标记为来自文本框');

  /* ============ ⑥ 模块边界：docx 层不做切题 ============ */
  head('⑥ 模块边界：docx 层只产出"段落"，不产出"题"');

  const paras = await DocxCore.readParagraphs(readSample());
  ok(Array.isArray(paras) && paras.length > 0, 'readParagraphs 返回段落数组', String(paras.length));
  ok(paras[0] && Array.isArray(paras[0].runs), '每个段落带 runs（含样式）');
  eq(paras[0].hasOwnProperty('type'), false, '段落里没有"题型"字段（切题是上层的事）');
  eq(paras.filter(p => p.inTextBox).length, r.meta.textBoxParagraphs, '文本框标记在段落层就已就绪');

  /* ============ ⑦ 性能抽查：大文档不退化 ============ */
  head('⑦ 性能抽查');
  const bigXml = '<w:document xmlns:w="x"><w:body>' +
    Array.from({ length: 5000 }, (_, i) =>
      '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>关键词' + i + '</w:t></w:r><w:r><w:t>普通文字' + i + '</w:t></w:r></w:p>').join('') +
    '</w:body></w:document>';
  const t0 = Date.now();
  const bigParas = DocxCore.extractParagraphs(bigXml);
  const ms = Date.now() - t0;
  eq(bigParas.length, 5000, '5000 段落全部解析出来');
  ok(ms < 2000, '5000 段落解析耗时在 2 秒内', ms + ' ms');

  console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
  console.log('  PASS ' + pass + '    FAIL ' + fail);
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
