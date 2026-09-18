/* ============================================================
 *  verify/text.test.js —— 「纯文本(txt)导入：编码兼容层 + 兜底关键词」验收
 *
 *  运行（仓库根目录）： node verify/text.test.js
 *  约定：全过 → 退出码 0；有失败 → 非 0；末行汇总 `PASS n   FAIL m`
 *
 *  对照三条盘档规格逐条给出断言：
 *    ① 给定含三种题型的 txt：切题数、题型分布、选项/答案/解析全部抽出
 *    ② txt 来源的简答在无样式时生成兜底关键词，每条标为「自动(需校对)」，
 *       不伪装成人工标记；反向对照：没有答案 → 0 条关键词
 *    ③ UTF-8(BOM) / UTF-8 / GBK 三编码同内容 → 题干文字一致、零乱码；
 *       另纳入三种行尾变体（CRLF+BOM / CRLF+GBK / 裸 CR）
 *
 *  被验对象（只读，不修改任何既有文件）：
 *    core/parse/text.js  → TextCore
 *    parser-core.js      → QuizParser（parseText / fallbackKeywords 为冻结上游）
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const P = require('../parser-core.js');
const TextCore = require('../core/parse/text.js');

/* ---------------- 极小断言器 ---------------- */
let pass = 0, fail = 0; const failures = [];

// raw：完整序列化，**只用于比较**，绝不截断（截断比较会造成假 PASS）
function raw(v) {
  if (v === undefined) return 'undefined';
  try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; }
  catch (e) { return String(v); }
}
// brief：只用于**打印**，长值截断，但仍报出真实总长度
function brief(v) {
  const s = raw(v);
  return s.length > 110 ? s.slice(0, 110) + '…(共 ' + s.length + ' 字符)' : s;
}
const render = brief;
function ok(cond, title, detail) {
  if (cond) { pass++; console.log('  PASS  ' + title + (detail !== undefined ? '   ' + detail : '')); }
  else { fail++; failures.push(title); console.log('  FAIL  ' + title + (detail !== undefined ? '   ' + detail : '')); }
}
function eq(actual, expected, title) {
  const A = raw(actual), E = raw(expected);
  ok(A === E, title, '期望=' + brief(expected) + '   实际=' + brief(actual));
}
function noThrow(fn, title) {
  let v;
  try { v = fn(); }
  catch (e) { ok(false, title, '抛异常: ' + (e && e.message ? e.message : String(e))); return undefined; }
  ok(true, title, '实际=未抛异常，返回 ' + render(v));
  return v;
}
function head(t) { console.log('\n==== ' + t + ' ===='); }

/* ---------------- 固件读取（只读） ---------------- */
const FIX = path.join(__dirname, '..', 'fixtures');
const TXT = path.join(FIX, 'txt');

function readBuf(name) { return fs.readFileSync(path.join(TXT, name)); }
// ArrayBuffer 形态（浏览器 FileReader.readAsArrayBuffer 的产物）
function ab(name) { const b = readBuf(name); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
// Uint8Array 视图形态（注意 Node Buffer 是池化的，byteOffset 常常非 0）
function u8(name) { const b = readBuf(name); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); }
function dump(name) { return readBuf(name); }   // Buffer 形态（Buffer 是 Uint8Array 子类）

/* ---------------- 题目「形状」快照：只留契约关心的字段 ---------------- */
function shape(q) {
  return {
    type: q.type,
    stem: q.stem,
    options: q.options === null ? null : (q.options || []).map(o => o.label + ':' + o.text),
    answer: q.answer,
    answerLetters: q.answerLetters === null ? null : (q.answerLetters || []).slice().sort(),
    judgeValue: q.judgeValue,
    keywords: q.keywords === null ? null : (q.keywords || []).map(k => k.text + '|' + k.via),
    explanation: q.explanation,
    review: q.review
  };
}
function snap(text) { return { stats: P.parseText(text).stats, questions: P.parseText(text).questions.map(shape) }; }
function fffdCount(s) { const m = String(s).match(/\uFFFD/g); return m ? m.length : 0; }

const MANUAL_VIAS = ['加粗', '高亮', '字体色', '底纹', '手动'];

/* ============================================================ */
async function main() {

  /* ================= ① 切题 ================= */
  head('① 切题：4 题 / 题型分布 / 选项·答案·解析全抽出（含半角 [多选] 兼容）');

  const dUtf8 = TextCore.decodeAuto(ab('basic_utf8.txt'));
  eq(dUtf8.encoding, 'utf-8', 'UTF-8 无 BOM 固件被识别为 utf-8');

  const r = P.parseText(dUtf8.text);
  eq(r.stats.total, 4, '切出 4 道题');
  eq(r.stats.byType, { '单选': 1, '多选': 1, '判断': 1, '简答': 1 }, '题型分布：单选1/多选1/判断1/简答1');

  // —— 单选 ——
  const single = r.questions[0];
  eq(single.type, '单选', '第 1 题是单选');
  eq(single.stem, 'HTTP 协议默认使用的端口是？', '  题干文字正确');
  eq(single.options.length, 4, '  选项 4 个');
  eq(single.options.map(o => o.label), ['A', 'B', 'C', 'D'], '  选项 label 依次为 A/B/C/D');
  eq(single.options.map(o => o.text), ['21', '80', '443', '8080'], '  选项正文全抽出');
  eq(single.answerLetters, ['B'], '  answerLetters 深等于 [\'B\']');
  ok(single.explanation.indexOf('443') >= 0, '  解析含 \'443\'', '实际=' + render(single.explanation));

  // —— 多选（固件里用的就是半角 [多选] ） ——
  const multi = r.questions[1];
  eq(multi.type, '多选', '第 2 题是「多选」——半角 [多选] 被识别');
  eq(multi.answerLetters.slice().sort(), ['A', 'B'], '  answerLetters 排序后深等于 [\'A\',\'B\']');
  ok(multi.explanation.indexOf('网络层') >= 0, '  解析含 \'网络层\'', '实际=' + render(multi.explanation));
  eq(multi.stem, '下列属于传输层协议的有？', '  半角标记没有残留在题干里');

  // —— 判断 ——
  const judge = r.questions[2];
  eq(judge.type, '判断', '第 3 题是判断');
  eq(judge.judgeValue, true, '  judgeValue === true（答案「√」归一正确）');

  // —— 简答 ——
  const short = r.questions[3];
  eq(short.type, '简答', '第 4 题是简答');
  ok(short.answer.indexOf('SYN+ACK') >= 0, '  参考答案含 \'SYN+ACK\'', '实际=' + render(short.answer));

  // —— 半角/全角标记的显式对照证据 ——
  ok(dUtf8.text.indexOf('[多选]') >= 0, '固件正文里确实用的是半角 [多选]（不是全角）');
  ok(dUtf8.text.indexOf('【单选】') >= 0 && dUtf8.text.indexOf('【判断】') >= 0 && dUtf8.text.indexOf('【简答】') >= 0,
     '  其余三题用的是全角【】——同一份卷子混用两种写法');
  const probeHalf = P.parseText('[多选]半角标记探针？\nA. 甲\nB. 乙\n【答案】AB\n');
  eq(probeHalf.stats.total, 1, '[多选] 探针切出 1 题');
  eq(probeHalf.questions[0].type, '多选', '  题型 = 多选');
  eq(probeHalf.questions[0].stem, '半角标记探针？', '  题干把 [多选] 标记剥干净');
  eq(probeHalf.questions[0].answerLetters.slice().sort(), ['A', 'B'], '  答案字母正确');
  const probeFull = P.parseText('【多选】半角标记探针？\nA. 甲\nB. 乙\n【答案】AB\n');
  eq(snap('[多选]半角标记探针？\nA. 甲\nB. 乙\n【答案】AB\n'),
     snap('【多选】半角标记探针？\nA. 甲\nB. 乙\n【答案】AB\n'),
     '半角 [多选] 与全角【多选】解析结果逐字段一致');

  /* ================= ② 兜底关键词 ================= */
  head('② 兜底关键词：自动生成 + 每条标「需校对」 + 不伪装成人工标记');

  ok(short.keywords.length >= 2, '简答生成了兜底关键词（>=2 条）', '实际=' + short.keywords.length + ' 条');
  eq(short.keywords.map(k => k.text),
     ['客户端发送 SYN', '服务器回复 SYN+ACK', '客户端再发送 ACK 确认'],
     '  切分结果：按「；」切成三条');
  eq(short.keywords.map(k => k.via), ['自动(需校对)', '自动(需校对)', '自动(需校对)'],
     '  每一条的 via 都严格等于「自动(需校对)」');
  ok(short.keywords.every(k => k.via === '自动(需校对)'), '  再逐条复查 via === \'自动(需校对)\'');
  ok(short.keywords.every(k => MANUAL_VIAS.indexOf(k.via) < 0),
     '  没有任何一条的 via 落在 [' + MANUAL_VIAS.join('/') + '] 里（不伪装成人工标记）');

  const reviewHit = short.review.filter(s => s.indexOf('自动生成') >= 0 && s.indexOf('需校对') >= 0);
  ok(reviewHit.length >= 1, 'review 里有条目同时含 \'自动生成\' 与 \'需校对\'',
     '实际 review=' + render(short.review));
  ok(short.review.some(s => s.indexOf('自动生成') >= 0), '  review 明确说明关键词是自动生成的');
  ok(short.review.some(s => s.indexOf('需校对') >= 0), '  review 明确要求人工校对');

  // 反向对照：没有答案的简答 → 不许凭空造关键词
  const noAns = P.parseText('【简答】这道题故意没有给参考答案。\n');
  eq(noAns.stats.total, 1, '反向对照：切出 1 道无答案简答');
  const nq = noAns.questions[0];
  eq(nq.type, '简答', '  题型是简答');
  eq(nq.answer, '', '  参考答案为空');
  eq(nq.keywords.length, 0, '  没有答案 → keywords.length === 0（不凭空造关键词）');
  ok(nq.review.some(s => s.indexOf('没有关键词') >= 0), '  review 里有条目提到没有关键词',
     '实际 review=' + render(nq.review));

  // 单元级：TextCore.fallbackKeywords 与 parser-core 的同名函数行为一致
  const ansText = short.answer;
  eq(TextCore.fallbackKeywords(ansText).map(k => k.text), P.fallbackKeywords(ansText).map(k => k.text),
     '单元：fallbackKeywords 切分结果与 parser-core 逐条一致');
  eq(TextCore.fallbackKeywords(ansText).map(k => k.via), P.fallbackKeywords(ansText).map(k => k.via),
     '  来源标记也一致（都是 自动(需校对)）');
  const samplesOf = ['甲甲；乙乙。丙丙, 丁丁、戊戊\n己己', '只有一个很长的句子没有任何标点符号', '', '，。；、', 'a b c'];
  eq(samplesOf.map(s => TextCore.fallbackKeywords(s)), samplesOf.map(s => P.fallbackKeywords(s)),
     '单元：5 组样本上与 parser-core 结果完全相同（含空串/纯标点）');

  eq(TextCore.fallbackKeywords(''), [], 'fallbackKeywords(\'\') === []');
  eq(TextCore.fallbackKeywords(null), [], 'fallbackKeywords(null) === []');
  eq(TextCore.fallbackKeywords(undefined), [], 'fallbackKeywords(undefined) === []');
  eq(TextCore.fallbackKeywords('甲甲；乙乙；甲甲；丙丙').map(k => k.text), ['甲甲', '乙乙', '丙丙'],
     '去重且保序（重复的「甲甲」只留第一条）');
  const many = ['甲甲', '乙乙', '丙丙', '丁丁', '戊戊', '己己', '庚庚'];
  eq(TextCore.fallbackKeywords(many.join('；'), { max: 3 }).map(k => k.text), ['甲甲', '乙乙', '丙丙'],
     'opts.max=3 截断到 3 条（默认是 6）');
  eq(TextCore.fallbackKeywords(many.join('；')).length, 6, '  默认 max=6');
  eq(TextCore.fallbackKeywords(many.join('；'), { max: 0 }), [], 'opts.max=0 → 空数组');
  eq(TextCore.fallbackKeywords('单', { minLen: 1 }).map(k => k.text), ['单'], 'opts.minLen=1 时单字保留');
  eq(TextCore.fallbackKeywords('单'), [], '  默认 minLen=2 → 单字被丢弃');
  eq(TextCore.fallbackKeywords('这是一个非常非常长的句子超过十八个字了真的', { maxLen: 18 }), [],
     '默认 maxLen=18 → 超长整句被丢弃');
  eq(TextCore.fallbackKeywords('这是一个非常非常长的句子超过十八个字了真的', { maxLen: 30 }).length, 1,
     '  放宽 maxLen 到 30 → 同一条被保留（证明是长度而不是别的原因丢弃）');
  ok(TextCore.fallbackKeywords(many.join('；'), { max: 99, minLen: 1, maxLen: 99 })
       .every(k => k.via === '自动(需校对)'),
     '无论怎么配 opts，via 恒为「自动(需校对)」');
  ok(TextCore.fallbackKeywords(many.join('；'), { max: 99 }).every(k => MANUAL_VIAS.indexOf(k.via) < 0),
     '  也恒不落在人工标记集合里');

  /* ================= ③ 三编码 + 行尾变体 ================= */
  head('③ 编码一致性：UTF-8(BOM) / UTF-8 / GBK 同内容 → 题干一致、零乱码');

  const dU8 = TextCore.decodeAuto(u8('basic_utf8bom.txt'));
  const dBuf = TextCore.decodeAuto(dump('basic_gbk.txt'));

  ok(dUtf8.text === dU8.text, 'UTF-8 与 UTF-8+BOM 的 text 字符串完全相等',
     '长度 ' + dUtf8.text.length + ' vs ' + dU8.text.length);
  ok(dUtf8.text === dBuf.text, 'UTF-8 与 GBK 的 text 字符串完全相等',
     '长度 ' + dUtf8.text.length + ' vs ' + dBuf.text.length);
  eq([dUtf8.encoding, dU8.encoding, dBuf.encoding], ['utf-8', 'utf-8-bom', 'gbk'],
     '三份的 encoding 分别是 utf-8 / utf-8-bom / gbk');
  eq([dUtf8.hadBom, dU8.hadBom, dBuf.hadBom], [false, true, false], 'hadBom 只有带 BOM 那份为 true');
  eq([dUtf8.replaced, dU8.replaced, dBuf.replaced], [0, 0, 0], '三份的 replaced 都是 0');
  eq([dUtf8.lossy, dU8.lossy, dBuf.lossy], [false, false, false], '  三份的 lossy 都是 false');
  eq(u8('basic_utf8bom.txt').slice(0, 3).join(','), '239,187,191', '固件自查：带 BOM 那份前三字节确是 EF BB BF');

  // 解析后逐字段一致
  const sUtf8 = snap(dUtf8.text), sBom = snap(dU8.text), sGbk = snap(dBuf.text);
  eq(sUtf8.questions.map(q => q.stem), sBom.questions.map(q => q.stem), 'UTF-8 vs BOM：所有题干数组完全相等');
  eq(sUtf8.questions.map(q => q.stem), sGbk.questions.map(q => q.stem), 'UTF-8 vs GBK：所有题干数组完全相等');
  eq(sBom.questions, sUtf8.questions, 'BOM 份与 UTF-8 份：全部题目逐字段一致（选项/答案/解析/关键词/review）');
  eq(sGbk.questions, sUtf8.questions, 'GBK 份与 UTF-8 份：全部题目逐字段一致');

  // 「无乱码」硬判据：正则数 U+FFFD
  const trio = [['utf-8', dUtf8], ['utf-8-bom', dU8], ['gbk', dBuf]];
  trio.forEach(([label, d]) => {
    eq(fffdCount(d.text), 0, label + '：解码文本里 \\uFFFD 出现次数为 0');
    eq(P.parseText(d.text).questions.filter(q => fffdCount(q.stem) > 0).length, 0,
       label + '：题干里 \\uFFFD 出现次数为 0');
    eq(fffdCount(d.text.replace(/\n/g, '')), 0, label + '：去掉换行后仍然 0 个替换符');
  });
  eq(fffdCount(dU8.text), 0, 'BOM 被剥掉、没有以 U+FEFF 残留形式混进正文');

  // tried：探测真的跑过（记录第 3~5 步试过的标签）
  eq(dUtf8.tried, ['utf-8'], 'UTF-8 无 BOM：tried = [\'utf-8\']（严格试过且一次成功）');
  ok(dUtf8.tried.length > 0, '  证明探测真的跑过（tried 非空）');
  eq(dBuf.tried, ['utf-8', 'gbk'], 'GBK：tried = [\'utf-8\',\'gbk\']（先严格试 UTF-8 失败，再试 gbk 成功）');
  ok(dBuf.tried.length > 0, '  证明探测真的跑过（tried 非空）');
  eq(dU8.tried, [], '带 BOM：算法第 2 步直接判定，不进入探测 → tried = []（第 6 步只记第 3~5 步）');
  ok(dBuf.tried.indexOf('utf-8') === 0, '  GBK 那份确实是「先试 UTF-8」而不是碰巧命中');

  // 换一种入参形态，结果必须一致（Buffer / ArrayBuffer / Uint8Array 都吃）
  eq(TextCore.decodeAuto(ab('basic_gbk.txt')).text, TextCore.decodeAuto(u8('basic_gbk.txt')).text,
     '同一文件：ArrayBuffer 入参与 Uint8Array 入参结果一致');
  eq(TextCore.decodeAuto(dump('basic_gbk.txt')).text, dBuf.text,
     '同一文件：Buffer（池化内存，byteOffset 非 0）入参结果一致');
  eq(TextCore.decodeAuto(ab('basic_utf8.txt')).text, TextCore.decodeAuto(dump('basic_utf8.txt')).text,
     '同一文件：ArrayBuffer 与 Buffer 结果一致（UTF-8）');

  // —— 行尾变体（Windows 记事本的真实产物） ——
  head('③b 行尾变体：CRLF+BOM / CRLF+GBK / 裸 CR → 与 LF 版逐字段一致，行尾不许吃进题干');

  const lfDump = dump('basic_utf8.txt');
  const variants = [
    ['crlf_utf8bom.txt', 'utf-8-bom', true],
    ['crlf_gbk.txt', 'gbk', false],
    ['cr_only_utf8.txt', 'utf-8', false]
  ];
  variants.forEach(([name, enc, bom]) => {
    const d = TextCore.decodeAuto(ab(name));
    eq(d.encoding, enc, name + '：编码识别为 ' + enc);
    eq(d.hadBom, bom, '  hadBom = ' + bom);
    eq(d.replaced, 0, '  replaced = 0（零解码损失）');
    eq(fffdCount(d.text), 0, '  正文里 \\uFFFD 出现次数为 0');

    // 它不是"碰巧和 LF 版一样"：原始字节里确实带着另一种行尾
    ok(d.text !== dUtf8.text, '  原始文本与 LF 版不同（行尾确实不一样，断言不是空转）',
       '长度 ' + d.text.length + ' vs ' + dUtf8.text.length);

    // 但解析结果必须逐字段一致
    eq(snap(d.text).questions, sUtf8.questions, '  解析后全部题目逐字段一致（行尾差异已被归一消化）');
    eq(snap(d.text).stats, sUtf8.stats, '  stats 也一致（4 题，题型分布相同）');

    // 行尾不许吃进题干
    const qs = P.parseText(d.text).questions;
    eq(qs.filter(q => q.stem.indexOf('\r') >= 0).length, 0, '  没有任何题干含 \\r');
    eq(qs.filter(q => q.stem.indexOf('\n') >= 0).length, 0, '  没有任何题干含 \\n');
    eq(qs.filter(q => q.answer.indexOf('\r') >= 0 || q.explanation.indexOf('\r') >= 0).length, 0,
       '  答案/解析里也没有 \\r');
  });
  // 字节级自查：三种行尾确实存在
  eq([dump('crlf_utf8bom.txt').filter(x => x === 13).length, dump('crlf_gbk.txt').filter(x => x === 13).length,
      dump('cr_only_utf8.txt').filter(x => x === 13).length, lfDump.filter(x => x === 13).length],
     [21, 21, 21, 0], '固件自查：两份 CRLF 各 21 个 \\r，裸 CR 版 21 个 \\r 且 0 个 \\n，LF 版 0 个 \\r');
  eq(dump('cr_only_utf8.txt').filter(x => x === 10).length, 0, '  裸 CR 版确实一个 \\n 都没有');
  // tried 与编码结论
  eq(TextCore.decodeAuto(ab('cr_only_utf8.txt')).tried, ['utf-8'], '裸 CR 版 tried = [\'utf-8\']');
  eq(TextCore.decodeAuto(ab('crlf_gbk.txt')).tried, ['utf-8', 'gbk'], 'CRLF+GBK 版 tried = [\'utf-8\',\'gbk\']');
  eq(TextCore.decodeAuto(ab('crlf_utf8bom.txt')).tried, [], 'CRLF+BOM 版按第 2 步短路 → tried = []');

  /* ================= ④ detectEncoding / decodeText ================= */
  head('④ 探测与指定解码：detectEncoding 只给标签，decodeText 不走探测');

  const det = [
    ['basic_utf8.txt', 'utf-8', false],
    ['basic_utf8bom.txt', 'utf-8-bom', true],
    ['basic_gbk.txt', 'gbk', false],
    ['crlf_utf8bom.txt', 'utf-8-bom', true],
    ['crlf_gbk.txt', 'gbk', false],
    ['cr_only_utf8.txt', 'utf-8', false]
  ];
  det.forEach(([name, enc, bom]) => {
    const d = TextCore.detectEncoding(ab(name));
    eq(d.encoding, enc, 'detectEncoding(' + name + ').encoding');
    eq(d.hadBom, bom, '  hadBom');
    ok(typeof d.reason === 'string' && d.reason.length >= 8, '  reason 是一句可读的判据',
       '实际=' + render(d.reason));
    eq(Object.prototype.hasOwnProperty.call(d, 'text'), false, '  只探测不解码（返回对象里没有 text）');
  });
  eq([dUtf8.encoding, dU8.encoding, dBuf.encoding],
     ['basic_utf8.txt', 'basic_utf8bom.txt', 'basic_gbk.txt'].map(n => TextCore.detectEncoding(ab(n)).encoding),
     'detectEncoding 与 decodeAuto 的结论逐份一致');

  eq(TextCore.decodeText(ab('basic_gbk.txt'), 'gbk'), dBuf.text, 'decodeText(gbk 字节, \'gbk\') 与 decodeAuto 一致');
  eq(TextCore.decodeText(ab('basic_utf8.txt'), 'utf-8'), dUtf8.text, 'decodeText(utf-8 字节, \'utf-8\') 与 decodeAuto 一致');
  eq(TextCore.decodeText(ab('basic_utf8bom.txt'), 'utf-8'), dUtf8.text,
     'decodeText(BOM 字节, \'utf-8\')：BOM 被剥掉 → 与无 BOM 版一致');
  eq(TextCore.decodeText('已经是文本', 'gbk'), '已经是文本', 'decodeText(字符串) 原样返回');
  eq(TextCore.decodeText(null, 'gbk'), '', 'decodeText(null) → 空串');
  eq(TextCore.decodeText(ab('basic_utf8.txt'), 'not-an-encoding'), dUtf8.text,
     'decodeText 遇到不认识的标签不抛异常，退回 utf-8');
  eq(TextCore.decodeText(ab('basic_utf8.txt'), 'gbk').length > 0, true, 'decodeText 用错编码也照解（由调用方负责）');

  /* ================= ⑤ 边界 ================= */
  head('⑤ 边界：脏输入不许抛异常；有损必须如实上报');

  eq(TextCore.decodeAuto(null),
     { text: '', encoding: 'utf-8', hadBom: false, replaced: 0, lossy: false, tried: [] },
     'decodeAuto(null)：完整默认结构（不抛异常）');
  eq(TextCore.decodeAuto(undefined),
     { text: '', encoding: 'utf-8', hadBom: false, replaced: 0, lossy: false, tried: [] },
     'decodeAuto(undefined)：完整默认结构');
  eq(TextCore.decodeAuto(new Uint8Array(0)),
     { text: '', encoding: 'utf-8', hadBom: false, replaced: 0, lossy: false, tried: [] },
     'decodeAuto(空 Uint8Array)：完整默认结构');
  noThrow(() => TextCore.decodeAuto(42), 'decodeAuto(数字) 不抛异常');
  noThrow(() => TextCore.decodeAuto({}), 'decodeAuto(普通对象) 不抛异常');
  noThrow(() => TextCore.decodeAuto([1, 2, 3]), 'decodeAuto(数组) 不抛异常');
  noThrow(() => TextCore.decodeAuto(function () {}), 'decodeAuto(函数) 不抛异常');
  noThrow(() => TextCore.decodeAuto(new DataView(new ArrayBuffer(4))), 'decodeAuto(DataView) 不抛异常');
  noThrow(() => TextCore.detectEncoding(null), 'detectEncoding(null) 不抛异常');
  noThrow(() => TextCore.detectEncoding(undefined), 'detectEncoding(undefined) 不抛异常');
  noThrow(() => TextCore.detectEncoding(new Uint8Array(0)), 'detectEncoding(空数组) 不抛异常');
  noThrow(() => TextCore.decodeText(undefined, undefined), 'decodeText(undefined, undefined) 不抛异常');
  noThrow(() => TextCore.fallbackKeywords(undefined, { max: -1 }), 'fallbackKeywords 脏 opts 不抛异常');
  noThrow(() => TextCore.splitByPunctuation(undefined), 'splitByPunctuation(undefined) 不抛异常');

  // 已解码字符串入参
  const given = TextCore.decodeAuto('【单选】已解码好的文本');
  eq(given.encoding, 'given', 'decodeAuto(字符串)：encoding = \'given\'（视为已解码）');
  eq(given.text, '【单选】已解码好的文本', '  text 原样返回');
  eq([given.hadBom, given.replaced, given.lossy], [false, 0, false], '  其余字段取默认值');
  eq(given.tried, [], '  tried = []（没有探测）');

  // 随机二进制：解不出来就必须说"有损"
  const rnd = TextCore.decodeAuto(fs.readFileSync(path.join(FIX, 'random.bin')));
  ok(rnd && typeof rnd.text === 'string', 'decodeAuto(随机二进制 4096B) 不抛异常且返回字符串');
  eq(rnd.encoding, 'utf-8', '  兜底编码报 utf-8（GBK 家族都解不干净）');
  ok(rnd.replaced > 0, '  replaced > 0（如实报损）', '实际 replaced=' + rnd.replaced);
  eq(rnd.lossy, true, '  lossy === true');
  ok(rnd.tried.length >= 2, '  tried 记录了试过的多个标签', '实际 tried=' + render(rnd.tried));
  eq(rnd.tried.slice(0, 4), ['utf-8', 'gbk', 'gb18030', 'gb2312'], '  依次试过 UTF-8 → gbk → gb18030 → gb2312');

  // 纯 ASCII 必须判 utf-8
  const ascii = TextCore.decodeAuto(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x41, 0x42, 0x0a]));
  eq(ascii.encoding, 'utf-8', '纯 ASCII 字节 → utf-8（不是 gbk）');
  eq(TextCore.decodeAuto(Buffer.from('Question A. 1\r\nAnswer: A\r\n', 'ascii')).encoding, 'utf-8',
     '  纯 ASCII 的 Buffer → utf-8');
  eq(TextCore.detectEncoding(Buffer.from('hello world')).encoding, 'utf-8', '  纯 ASCII 的 detectEncoding → utf-8');
  ok(TextCore.detectEncoding(Buffer.from('hello world')).encoding !== 'gbk', '  显式断言：不是 gbk');

  // 强制错编码 → 必须如实报损（诚实降级）
  const forcedBad = TextCore.decodeAuto(ab('basic_gbk.txt'), { encoding: 'utf-8' });
  ok(forcedBad.replaced > 0, '把 GBK 字节强当 UTF-8 解 → replaced > 0', '实际 replaced=' + forcedBad.replaced);
  eq(forcedBad.lossy, true, '  lossy === true');
  eq(forcedBad.encoding, 'utf-8', '  encoding 按强制值上报');
  eq(forcedBad.tried, [], '  强制指定时不做探测 → tried = []');
  ok(forcedBad.text !== dBuf.text, '  结果确实与正确探测不同（错编码不是"看起来也能用"）');

  const forcedOk = TextCore.decodeAuto(ab('basic_gbk.txt'), { encoding: 'gbk' });
  eq(forcedOk.text, dBuf.text, '强制 gbk 解 GBK 固件 → 与自动探测结果一致');
  eq([forcedOk.replaced, forcedOk.lossy], [0, false], '  零损失');
  eq(TextCore.decodeAuto(ab('basic_gbk.txt'), { encoding: 'gb2312' }).encoding, 'gbk',
     'opts.encoding 传 gb2312 别名 → 按 gbk 处理');
  eq(TextCore.decodeAuto(ab('basic_gbk.txt'), { encoding: 'gb18030' }).text, dBuf.text, '传 gb18030 也能正确解码');

  const forcedBom = TextCore.decodeAuto(ab('basic_utf8bom.txt'), { encoding: 'utf-8' });
  eq(forcedBom.hadBom, true, '强制 encoding 时 hadBom 仍按第 2 步判断 = true');
  eq(forcedBom.text, dUtf8.text, '  且 BOM 已剥掉（与无 BOM 版一致）');
  eq(forcedBom.encoding, 'utf-8-bom', '  encoding 反映真实的 BOM 事实');

  /* ================= ⑥ 签名冻结 + UMD 双环境 ================= */
  head('⑥ 签名冻结与 UMD：parseText 仍是 1 元；浏览器分支挂到 self.TextCore');

  eq(P.parseText.length, 1, 'require(\'../parser-core.js\').parseText.length === 1（arity 没变）');
  eq(typeof P.fallbackKeywords, 'function', 'QuizParser.fallbackKeywords 仍导出');
  ok(P.parseText('【单选】签名检查？\nA. 甲\nB. 乙\n答案：A\n').questions.length === 1,
     'QuizParser.parseText 仍接受字符串并正常切题');
  const emptyR = noThrow(() => P.parseText(''), 'QuizParser.parseText(\'\') 不炸');
  eq(emptyR && emptyR.stats.total, 0, '  空字符串 → 0 题');

  eq([typeof TextCore.decodeAuto, typeof TextCore.decodeText, typeof TextCore.detectEncoding,
      typeof TextCore.fallbackKeywords, typeof TextCore.splitByPunctuation],
     ['function', 'function', 'function', 'function', 'function'],
     'core/parse/text.js 的五个冻结接口都导出了');

  // 在 Node 里模拟浏览器内联：把 module 拿掉，只给一个假的 self
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'parse', 'text.js'), 'utf8');
  const mount = new Function('self', src + '\n;return self.TextCore;');
  const Browserish = mount({});
  ok(Browserish && typeof Browserish.decodeAuto === 'function',
     'UMD 浏览器分支：无 module 时把 API 挂到 self.TextCore 上');
  eq(Browserish && Browserish.decodeAuto(ab('basic_gbk.txt')).encoding, 'gbk',
     '  浏览器分支行为与 Node 分支一致（识别出 GBK）');
  eq(Browserish && Browserish.fallbackKeywords('甲甲；乙乙').map(k => k.via), ['自动(需校对)', '自动(需校对)'],
     '  浏览器分支的兜底关键词来源标记一致');

  eq(TextCore.splitByPunctuation(''), [], 'splitByPunctuation(\'\') === []');
  eq(TextCore.splitByPunctuation(null), [], 'splitByPunctuation(null) === []');
  eq(TextCore.splitByPunctuation('a，b,c。d.e；f;g、h\ni'), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
     'splitByPunctuation 覆盖全部 8 个分隔符');
  eq(TextCore.splitByPunctuation('没有标点的句子'), ['没有标点的句子'], '  没有分隔符时原样返回一段');
  eq(TextCore.splitByPunctuation('，，；；'), [], '  纯分隔符 → []（空片段被丢弃）');

  /* ================= 汇总 ================= */
  console.log('\n==== 汇总 ====');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  if (fail) {
    console.log('失败项：');
    failures.forEach(f => console.log('  - ' + f));
  }
  process.exitCode = fail ? 1 : 0;
}

main().catch(e => { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
