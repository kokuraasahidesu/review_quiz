/* ============================================================
 *  verify/txt-integration.test.js —— 「txt 通道」的集成 + 相邻锚验收
 *
 *  运行： node verify/txt-integration.test.js
 *
 *  分工说明：
 *    verify/text.test.js 是「编码层 + 兜底关键词」的单元证据（子模块自己的测试）。
 *    本文件是我的独立验收：不重跑它的断言，而是从**集成后的门面**出发，
 *    验三件事它验不到的东西：
 *      A. 字节入口 parseTxtBytes 真的接上了（三编码 → 同一份题）
 *      B. 相邻锚：txt 解析产物喂给 core/schema.js 后，
 *         · 校验必须通过
 *         · 归一化必须符合契约的 null 表
 *         · 兜底关键词的 via 不许被 schema 洗成「手动」
 *      C. 诚实降级：解不出来时必须报 replaced>0，不许假装成功
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const Schema = require('../core/schema.js');
const QuizParser = require('../parser-core.js');

let pass = 0, fail = 0; const failures = [];
function ok(c, t, d) { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + d : '')))
                         : (fail++, failures.push(t), console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + JSON.stringify(d) : ''))); }
function eq(a, e, t) { const A = JSON.stringify(a), E = JSON.stringify(e); ok(A === E, t + '   期望=' + E, A); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }

const TXT = path.join(__dirname, '..', 'fixtures', 'txt');
const FILES = {
  'utf-8':     'basic_utf8.txt',
  'utf-8-bom': 'basic_utf8bom.txt',
  'gbk':       'basic_gbk.txt'
};
function bytes(name) {
  const b = fs.readFileSync(path.join(TXT, name));
  return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

/* 归一成"可比较的题面"，只留契约关心的字段 */
function shape(q) {
  return {
    type: q.type, stem: q.stem,
    options: q.options === null ? null : (q.options || []).map(o => o.label + ':' + o.text),
    answer: q.answer,
    answerLetters: q.answerLetters === null ? null : (q.answerLetters || []).slice().sort(),
    judgeValue: q.judgeValue,
    keywords: q.keywords === null ? null : (q.keywords || []).map(k => k.text + '|' + k.via),
    explanation: q.explanation
  };
}

(async function main() {
  /* ============ ⓪ 前置：字节入口是否已接上 ============ */
  head('⓪ 前置检查：门面上的字节入口');

  const hasBytesEntry = typeof QuizParser.parseTxtBytes === 'function';
  ok(hasBytesEntry, 'QuizParser.parseTxtBytes 已导出（txt 的字节级入口）');
  if (!hasBytesEntry) {
    console.log('\n\x1b[33m  字节入口尚未接上，后面的集成断言无法进行。\x1b[0m');
    console.log('  （先跑 verify/text.test.js 看编码层单元证据；集成由我补齐后重跑本文件。）');
    console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
    console.log('  PASS ' + pass + '    FAIL ' + fail);
    process.exitCode = 1;
    return;
  }

  ok(QuizParser.parseTxtBytes.length >= 1, 'parseTxtBytes 接受至少 1 个参数', 'arity=' + QuizParser.parseTxtBytes.length);
  eq(QuizParser.parseText.length, 1, '冻结签名未变：parseText(text) 仍是 1 元');

  /* ============ ① 三编码 → 同一份题 ============ */
  head('① 三编码同内容 → 切出的题必须逐字段一致（验收标准③的集成版）');

  const results = {};
  for (const [label, file] of Object.entries(FILES)) {
    const r = await QuizParser.parseTxtBytes(bytes(file));
    results[label] = r;
    ok(!!r && Array.isArray(r.questions), label + '：解析成功', (r && r.questions.length) + ' 题');
  }

  const labels = Object.keys(FILES);
  const base = results[labels[0]];

  eq(base.stats.total, 4, '切出 4 道题');
  eq(base.stats.byType, { '单选': 1, '多选': 1, '判断': 1, '简答': 1 }, '题型分布：单选1/多选1/判断1/简答1');

  for (const l of labels.slice(1)) {
    const r = results[l];
    eq(r.stats.total, base.stats.total, l + '：题数与 UTF-8 一致');
    eq(r.stats.byType, base.stats.byType, l + '：题型分布一致');
    eq(r.questions.map(shape), base.questions.map(shape), l + '：每道题的题干/选项/答案/解析逐字段一致');
    // "无乱码"的硬判据
    const bad = r.questions.filter(q => /\uFFFD/.test(q.stem + q.answer + q.explanation)).length;
    eq(bad, 0, l + '：题干/答案/解析里没有 U+FFFD（无乱码）');
  }

  // meta 里必须把编码与损失如实报出来，UI 才能提示
  eq(results['utf-8'].meta.encoding, 'utf-8', 'meta.encoding：UTF-8 无 BOM');
  eq(results['utf-8-bom'].meta.encoding, 'utf-8-bom', 'meta.encoding：UTF-8 带 BOM');
  eq(results['gbk'].meta.encoding, 'gbk', 'meta.encoding：GBK');
  eq(results['utf-8-bom'].meta.hadBom, true, 'meta.hadBom：只有带 BOM 那份为 true');
  eq(results['utf-8'].meta.hadBom, false, '  无 BOM 那份为 false');
  eq(results['gbk'].meta.hadBom, false, '  GBK 那份为 false');
  eq(labels.map(l => results[l].meta.replaced), [0, 0, 0], '三份的 replaced 都是 0（零解码损失）');
  ok(base.questions.every(q => q.stem.charAt(0) !== '\uFEFF'), 'BOM 没有残留进题干');

  /* ============ ①-b 行尾兼容：记事本存的是 CRLF，别让行尾变成题干的一部分 ============ */
  head('①-b 行尾兼容：LF / CRLF / 裸 CR 三种行尾 → 同一份题');

  const EOL = {
    'CRLF+UTF8BOM(记事本默认)': 'crlf_utf8bom.txt',
    'CRLF+GBK(老记事本ANSI)':   'crlf_gbk.txt',
    '裸CR(老式Mac)':            'cr_only_utf8.txt'
  };
  for (const [label, file] of Object.entries(EOL)) {
    if (!fs.existsSync(path.join(TXT, file))) { ok(false, label + ' 固件存在'); continue; }
    const r = await QuizParser.parseTxtBytes(bytes(file));
    eq(r.questions.map(shape), base.questions.map(shape),
       label + '：与纯 LF 版逐字段一致');
    const dirty = r.questions.filter(q => /[\r\n]/.test(q.stem)).length;
    eq(dirty, 0, label + '：题干里没有残留 \r 或 \n（行尾没被吃进题干）');
  }

  /* ============ ② 相邻锚：txt 产物 → core/schema.js ============ */
  head('② 相邻锚：txt 解析产物喂给 core/schema.js（只对照相邻接口）');

  let allOk = true, normBad = [];
  base.questions.forEach(q => {
    const cq = Schema.createQuestion(q);
    const v = Schema.validateQuestion(cq);
    if (!v.ok) { allOk = false; console.log('     × ' + q.type + ' 校验失败: ' + JSON.stringify(v.errors)); }

    // 契约的 null 归一表：非选择题 options/answerLetters 必须 null；非简答 keywords 必须 null
    const isChoice = (cq.type === '单选' || cq.type === '多选');
    if (!isChoice && (cq.options !== null || cq.answerLetters !== null)) normBad.push(cq.type + ' 的 options/answerLetters 应为 null');
    if (cq.type !== '简答' && cq.keywords !== null) normBad.push(cq.type + ' 的 keywords 应为 null');
    if (cq.type === '判断' && cq.judgeValue !== true) normBad.push('判断题 judgeValue 应为 true，实际 ' + cq.judgeValue);
    if (isChoice && (!Array.isArray(cq.options) || cq.options.length !== 4)) normBad.push(cq.type + ' 应有 4 个选项');
  });
  ok(allOk, '4 道题经 createQuestion 归一后，validateQuestion 全部通过');
  eq(normBad, [], '归一化符合契约的 null 表（非选择题 options=null，非简答 keywords=null）');

  /* ============ ③ 相邻锚（关键）：兜底关键词不许被 schema 洗成「手动」 ============ */
  head('③ 相邻锚（关键）：schema 对缺 via 的关键词默认填「手动」—— 兜底关键词必须扛住这一关');

  const short = base.questions.find(q => q.type === '简答');
  ok(!!short, '样卷里有简答题');
  ok(short.keywords.length >= 2, '简答生成了兜底关键词', short.keywords.length + ' 条');
  ok(short.keywords.every(k => k.via === '自动(需校对)'),
     '  解析层：每条的 via 都是「自动(需校对)」',
     JSON.stringify(short.keywords.map(k => k.via)));
  ok(short.keywords.every(k => ['加粗', '高亮', '字体色', '底纹', '手动'].indexOf(k.via) < 0),
     '  解析层：没有任何一条伪装成人工标记');
  ok(short.review.some(s => s.indexOf('自动生成') >= 0 && s.indexOf('需校对') >= 0),
     '  review 里明确标了「自动生成 + 需校对」', JSON.stringify(short.review));

  const cqShort = Schema.createQuestion(short);
  eq(cqShort.keywords.map(k => k.via),
     short.keywords.map(() => '自动(需校对)'),
     '经 createQuestion 往返后，via 仍是「自动(需校对)」（没被 schema 的默认值洗成「手动」）');
  ok(cqShort.keywords.every(k => k.via !== '手动'),
     '  往返后依然没有任何一条是「手动」');
  eq(cqShort.keywords.map(k => k.text), short.keywords.map(k => k.text), '  关键词文本也没被改动或丢序');
  ok(cqShort.review.some(s => s.indexOf('需校对') >= 0),
     '  往返后 review 提示仍在（人工校对的要求没丢）', JSON.stringify(cqShort.review));

  // 反向对照：真的「手动」标记必须原样保留 —— 证明上面不是碰巧
  const manual = Schema.createQuestion({ type: '简答', stem: 'x', keywords: [{ text: '人工标的', via: '手动' }] });
  eq(manual.keywords[0].via, '手动', '对照：真正的人工标记不会被翻转（schema 不篡改 via）');
  const noVia = Schema.createQuestion({ type: '简答', stem: 'x', keywords: [{ text: '没写via' }] });
  eq(noVia.keywords[0].via, '手动', '对照：缺 via 时 schema 默认「手动」——这正是必须显式带 via 的原因');

  /* ============ ④ 诚实降级：解不出来必须报，不许假装成功 ============ */
  head('④ 诚实降级：探测失手时要留下可观测的损失标记');

  const gbkBytes = bytes('basic_gbk.txt');
  const forced = await QuizParser.parseTxtBytes(gbkBytes, { encoding: 'utf-8' });
  ok(forced.meta.replaced > 0, '把 GBK 字节强制当 UTF-8 解 → replaced > 0（明确告知有损）', forced.meta.replaced);
  eq(forced.meta.lossy, true, '  lossy = true');

  // 关键判据：错编码必须"用不了"，绝不能悄悄给出一份看起来能用的卷子。
  // 实测事实：GBK 字节被当 UTF-8 解后，连【单选】这类题型标记本身都被破坏，
  // 于是一道题都切不出来 —— 用户看到的是"没识别出题目"，这是响亮的失败。
  eq(forced.stats.total, 0,
     '  损坏可见：题型标记被破坏 → 一道题都切不出来（不是一份悄悄错掉的卷子）');

  // 乱码确实存在于解码结果里（只是它把所有标记都毁了，所以进不了题干）
  const rawForced = QuizParser.decodeText(gbkBytes, 'utf-8');
  ok(/\uFFFD/.test(rawForced), '  解码后的原始文本里确实有 U+FFFD 替换符',
     (rawForced.match(/\uFFFD/g) || []).length + ' 个');
  const rawAuto = QuizParser.decodeAuto(gbkBytes).text;
  ok(rawForced !== rawAuto, '  错编码得到的文本与正确探测的文本不相等（不是"看着也能用"）');
  eq(results['gbk'].meta.replaced, 0, '对照：不强制时，自动探测正确认出 GBK，零损失');
  eq(QuizParser.decodeAuto(gbkBytes).text, rawAuto, '  自动探测结果可重复（同一文件两次一致）');

  /* ============ ⑤ 幂等：字节入口 = 解码 + 字符串入口 ============ */
  head('⑤ 幂等：字节入口与「手动解码 + parseText」结果一致');

  const bytesR = await QuizParser.parseTxtBytes(bytes('basic_utf8bom.txt'));
  const manualR = QuizParser.parseText(
    (() => { const b = bytes('basic_utf8bom.txt'); return new TextDecoder('utf-8').decode(b.subarray(3)); })()
  );
  eq(bytesR.questions.map(shape), manualR.questions.map(shape),
     'parseTxtBytes(x) 与 parseText(去掉BOM的文本) 逐字段一致');
  eq(bytesR.meta.encoding, 'utf-8-bom', '  字节入口额外提供了编码信息');
  eq(manualR.meta.encoding, undefined, '  字符串入口没有编码信息（它拿到的已经是文本了，这是正确的）');

  /* ============ ⑥ 边界：脏输入不许炸 ============ */
  head('⑥ 边界：脏输入');

  for (const [label, input] of [['null', null], ['undefined', undefined],
                                ['空', new Uint8Array(0)], ['随机二进制', new Uint8Array([1, 2, 3, 250, 251, 252, 253])]]) {
    let crashed = null, r = null;
    try { r = await QuizParser.parseTxtBytes(input); } catch (e) { crashed = e; }
    ok(!crashed && r && Array.isArray(r.questions), '脏输入 ' + label + '：不抛异常且返回空题集',
       crashed ? '抛了 ' + crashed.message : r.questions.length + ' 题');
  }

  /* ============ ⑦ 简答兜底关键词的三条分支（挑刺挑出来的缺陷，钉死它） ============ */
  head('⑦ 简答的 review 必须说真话：区分「没有答案」与「有答案但切不出关键词」');

  // 分支 A：答案很短、有标点 → 能生成兜底关键词
  //（注意：单字片段会被 minLen=2 正确过滤，所以这里用双字词）
  const shortAns = QuizParser.parseText('【简答】说明一下。\n答案：甲甲；乙乙');
  eq(shortAns.questions[0].keywords.map(k => k.text), ['甲甲', '乙乙'], 'A：短答案切出两条关键词');
  ok(shortAns.questions[0].keywords.every(k => k.via === '自动(需校对)'), '  A：都标为需校对');
  ok(shortAns.questions[0].review.some(s => s.indexOf('自动生成') >= 0), '  A：review 标了自动生成');
  // 单字被过滤是刻意行为，不是漏抽
  const oneChar = QuizParser.parseText('【简答】说明一下。\n答案：甲');
  eq(oneChar.questions[0].keywords, [], '  A：单字片段被 minLen=2 过滤（刻意行为）');

  // 分支 B：有答案，但整段过长 / 无标点 → 切不出关键词。
  //         早期实现会在这里谎报「也没有答案」，把用户引向错误方向。
  const longAns = QuizParser.parseText('【简答】说明一下。\n答案：这是一个超过十八个字符的非常长的参考答案内容描述');
  eq(longAns.questions[0].keywords, [], 'B：切不出关键词（整段超长）');
  const bReview = longAns.questions[0].review.join(' | ');
  ok(bReview.indexOf('自动切不出采分关键词') >= 0, '  B：review 走「有答案但切不出」分支', bReview);
  ok(bReview.indexOf('没有识别到答案') < 0,
     '  B：review 绝不能说「没有识别到答案」——答案明明解析出来了', bReview);
  ok(bReview.indexOf('需人工填写采分点') >= 0, '  B：明确告诉用户下一步该做什么', bReview);

  // 分支 C：真的没有答案 → 必须走另一条分支（判据用互斥的措辞，不用子串猜）
  const noAns = QuizParser.parseText('【简答】说明一下。\n解析：略');
  eq(noAns.questions[0].keywords, [], 'C：没有关键词');
  const cReview = noAns.questions[0].review.join(' | ');
  ok(cReview.indexOf('没有识别到答案') >= 0, '  C：review 明确指出没有识别到答案', cReview);
  ok(cReview.indexOf('自动切不出采分关键词') < 0,
     '  C：不会误走「有答案但切不出」分支', cReview);
  ok(cReview.indexOf('需人工填写采分点') < 0,
     '  C：不会要求用户去填采分点（因为压根没有答案）', cReview);

  // 对照组：docx 通道同样走 finish()，行为必须一致（同一份逻辑，不许分叉）
  const sampleBuf = (() => {
    const b = fs.readFileSync(path.join(__dirname, '..', 'sample.docx'));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  })();
  const docxR = await QuizParser.parseDocx(sampleBuf);
  const docxShort = docxR.questions.filter(q => q.type === '简答');
  ok(docxShort.length > 0 && docxShort.every(q => q.keywords.length > 0),
     '对照：docx 的简答关键词路径未受影响（' + docxShort.length + ' 道简答，均有样式关键词）');

  console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
  console.log('  PASS ' + pass + '    FAIL ' + fail);
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
