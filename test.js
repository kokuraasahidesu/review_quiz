/* ============================================================
 *  test.js —— 在 Node 里跑解析核心做真实验证
 *  运行： node test.js
 *
 *  为什么能在 Node 跑：解析核心刻意不用 DOMParser，只用正则 + TextDecoder，
 *  解压用的是标准 DecompressionStream（Node 18+ / 浏览器都有）。
 *  → 这样我不需要浏览器也能验证算法，不用靠人肉双击碰运气。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const QuizParser = require('./parser-core.js');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '   实际=' + JSON.stringify(extra) : '')); }
}
function eq(actual, expect, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expect);
  ok(a === e, label + '  (期望 ' + e + ')', a);
}

(async function main() {
  const file = path.join(__dirname, 'sample.docx');
  console.log('读取: ' + file);
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  console.log('\n================ 解析结果 ================');
  const r = await QuizParser.parseDocx(ab);

  console.log('来源: ' + r.meta.source +
              '   段落 ' + r.meta.paragraphs +
              '   其中文本框段落 ' + r.meta.textBoxParagraphs);
  console.log('题型统计: ' + JSON.stringify(r.stats.byType) +
              '   待校对 ' + r.stats.needsReview + '   关键词 ' + r.stats.keywords);
  console.log('');

  r.questions.forEach(function (q, i) {
    console.log('  [' + (i + 1) + '] ' + q.type +
                (q.inTextBox ? ' (文本框内)' : '') +
                (q.review.length ? '  ⚠ ' + q.review.join(' / ') : ''));
    console.log('      题干: ' + q.stem.replace(/\n/g, ' ⏎ ').slice(0, 60));
    if (q.options.length) {
      console.log('      选项: ' + q.options.map(o => o.label + '.' + o.text).join('  '));
    }
    if (q.answer) console.log('      答案: ' + q.answer +
      (q.answerLetters ? '  → ' + q.answerLetters.join('') : '') +
      (q.judgeValue !== undefined && q.judgeValue !== null ? '  → ' + q.judgeValue : ''));
    if (q.keywords.length) {
      console.log('      关键词: ' + q.keywords.map(k => k.text + '[' + k.via + ']').join('、'));
    }
    if (q.explanation) console.log('      解析: ' + q.explanation.slice(0, 46));
    console.log('');
  });

  console.log('================ 断言 ================');
  const q = r.questions;

  eq(r.stats.total, 10, '总题数 = 10');
  eq(r.stats.byType, { '单选': 2, '多选': 1, '判断': 4, '简答': 3 }, '题型分布正确');
  eq(r.meta.textBoxParagraphs >= 3, true, '文本框里解析出至少 3 个段落');

  // 单选 1
  eq(q[0].type, '单选', 'Q1 类型=单选');
  eq(q[0].answer, 'B', 'Q1 答案=B（"答案："形式）');
  eq(q[0].answerLetters, ['B'], 'Q1 答案选项=B');
  eq(q[0].options.map(o => o.label), ['A', 'B', 'C', 'D'], 'Q1 四个选项');
  ok(q[0].explanation.length > 5, 'Q1 解析已提取');

  // 单选 2：无冒号的【答案】
  eq(q[1].answer, 'A', 'Q2 答案=A（"【答案】A" 无冒号也识别）');

  // 多选
  eq(q[2].type, '多选', 'Q3 类型=多选');
  eq(q[2].answerLetters, ['A', 'B', 'D'], 'Q3 答案拆成 ABD');

  // 判断
  eq(q[3].type, '判断', 'Q4 类型=判断');
  eq(q[3].judgeValue, true, 'Q4 "√" → true');
  eq(q[4].judgeValue, false, 'Q5 "错" → false');
  eq(q[5].judgeValue, null, 'Q6 歧义答案 → 不强行判分');
  ok(q[5].review.join().indexOf('无法识别') >= 0, 'Q6 被标记待人工校对');

  // 简答关键词三种标记
  const k7 = q[6].keywords.map(k => k.text);
  eq(k7, ['SYN', 'SYN+ACK', 'ACK'], 'Q7 抓到你「加粗」的关键词');
  ok(q[6].keywords.every(k => k.via === '加粗'), 'Q7 关键词来源=加粗');

  const k8 = q[7].keywords.map(k => k.text);
  eq(k8, ['TLS/SSL', '443', '数字证书'], 'Q8 抓到你「高亮」的关键词');
  ok(q[7].keywords.every(k => k.via === '高亮'), 'Q8 关键词来源=高亮');

  const k9 = q[8].keywords.map(k => k.text);
  eq(k9, ['本地DNS服务器', '根域名服务器', '服务器地址'], 'Q9 抓到你「字体颜色」的关键词');
  ok(q[8].keywords.every(k => k.via === '字体色'), 'Q9 关键词来源=字体色');

  // 文本框
  eq(q[9].inTextBox, true, 'Q10 来自文本框（mammoth 抓不到的那种）');
  eq(q[9].type, '判断', 'Q10 类型=判断');
  eq(q[9].judgeValue, true, 'Q10 文本框内答案可判分');

  // txt 通道
  const txt = '【单选】1. 1+1=?\nA. 1\nB. 2\nC. 3\nD. 4\n答案：B\n解析：常识\n' +
              '【判断】2. 地球是圆的。（　）\n答案：对\n' +
              '【简答】3. 简述水的三态。\n参考答案：固态、液态、气态\n';
  const rt = QuizParser.parseText(txt);
  eq(rt.stats.total, 3, 'txt 通道：3 题');
  eq(rt.stats.byType, { '单选': 1, '判断': 1, '简答': 1 }, 'txt 通道：题型分布');
  eq(rt.questions[1].judgeValue, true, 'txt 通道：判断题判分');
  ok(rt.questions[2].keywords.length > 0, 'txt 通道：简答自动兜底关键词');
  ok(rt.questions[2].review.join().indexOf('自动生成') >= 0, 'txt 通道：兜底关键词被标"需校对"');

  console.log('\n================ 汇总 ================');
  console.log('  PASS ' + pass + '   FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩了: ' + e.stack); process.exit(2); });
