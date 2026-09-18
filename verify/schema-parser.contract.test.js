/* ============================================================
 *  verify/schema-parser.contract.test.js —— 相邻接口对照（第二遍·相邻锚）
 *
 *  只对照相邻的两个模块：parser-core（解析产出） 与 schema（结构契约）。
 *  证明：解析出的题能无损、零错误地变成结构定义的合法题目，
 *        且往返（导出→导入）后 id 与关键字段不丢。
 *
 *  为什么必须做：这两个模块是两个不同小类的产物，接口对不上时，
 *  单看各自测试都是绿的 —— 只有把真数据灌过去才会暴露。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const S = require('../core/schema.js');
const QuizParser = require('../parser-core.js');

let pass = 0, fail = 0; const failures = [];
function ok(c, t, d) { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + d : '')))
                         : (fail++, failures.push(t), console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + JSON.stringify(d) : ''))); }
function eq(a, e, t) { const A = JSON.stringify(a), E = JSON.stringify(e); ok(A === E, t + '   期望=' + E, A); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }

(async function main() {
  head('相邻锚：parser-core 的真实产出 → schema 的结构契约');

  const buf = fs.readFileSync(path.join(__dirname, '..', 'sample.docx'));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const parsed = await QuizParser.parseDocx(ab);
  eq(parsed.questions.length, 10, '解析器产出 10 道题');

  // 按既定映射规则转换：解析器的 autoDetected（题型是猜的）折进 review
  const mappingNote = [];
  const built = parsed.questions.map(function (p) {
    const review = (p.review || []).slice();
    if (p.autoDetected) { review.push('题型为自动识别，请确认'); mappingNote.push(p.stem.slice(0, 12)); }
    return S.createQuestion(Object.assign({}, p, { review: review }), { rng: Math.random });
  });

  // ① 全部通过结构校验
  const perQ = built.map(q => S.validateQuestion(q));
  const badQ = perQ.map((r, i) => r.ok ? null : ('第' + (i + 1) + '题：' + r.errors.join('；'))).filter(Boolean);
  eq(badQ, [], '10 道题全部通过结构校验（零错误）');

  // ② 警告只应来自"歧义判断题"，且恰好 1 条
  const warns = [];
  perQ.forEach(function (r, i) { r.warnings.forEach(w => warns.push('#' + (i + 1) + ' ' + w)); });
  eq(warns.length, 1, '只产生 1 条警告（歧义判断题）', JSON.stringify(warns));
  ok(warns[0].indexOf('#6') === 0 && warns[0].indexOf('待人工校对') >= 0,
     '该警告正是第 6 题的待人工校对', warns[0]);

  // ③ 汇总成试卷后仍合法
  const exam = S.createExam({ title: '计算机网络 期中模拟卷（解析器测试样卷）', questions: built }, { now: '2026-09-16T00:00:00.000Z' });
  const ve = S.validateExam(exam);
  eq(ve.ok, true, '整卷通过校验', JSON.stringify(ve.errors));
  eq(ve.warnings.length, 1, '整卷继承同一条警告');

  // ④ id 唯一
  const ids = exam.questions.map(q => q.id);
  eq(new Set(ids).size, 10, '10 个题目 id 互不相同');
  ok(ids.every(id => typeof id === 'string' && id.length > 0), '每个 id 都是非空字符串');

  // ⑤ 无信息丢失：逐字段对照解析产出
  //    注意：结构工厂会把"不适用"的字段统一归一化 ——
  //      非选择题 options: [] / undefined → null
  //      非判断题 judgeValue: undefined → null
  //      非选择题 answerLetters → null；非简答题 keywords → null
  //    这是有意的形状归一（下游只需判断 null = 不适用），不是丢信息。
  //    所以这里按语义比对，并把归一化规则本身也钉成断言。
  const losses = [], norm = [];
  parsed.questions.forEach(function (p, i) {
    const q = built[i];
    ['type', 'stem', 'answer', 'explanation', 'inTextBox'].forEach(function (f) {
      if (JSON.stringify(p[f]) !== JSON.stringify(q[f])) losses.push('#' + (i + 1) + '.' + f);
    });
    const isChoice = (p.type === '单选' || p.type === '多选');
    const isJudge  = (p.type === '判断');
    const isShort  = (p.type === '简答');

    if (isChoice) {
      if (JSON.stringify(p.options) !== JSON.stringify(q.options)) losses.push('#' + (i + 1) + '.options');
      if (JSON.stringify(p.answerLetters || []) !== JSON.stringify(q.answerLetters || [])) losses.push('#' + (i + 1) + '.answerLetters');
    } else {
      if (q.options !== null) norm.push('#' + (i + 1) + '.options 应为 null 实际 ' + JSON.stringify(q.options));
      if (q.answerLetters !== null) norm.push('#' + (i + 1) + '.answerLetters 应为 null');
    }
    if (isJudge) {
      if (JSON.stringify(p.judgeValue) !== JSON.stringify(q.judgeValue)) losses.push('#' + (i + 1) + '.judgeValue');
    } else if (q.judgeValue !== null) {
      norm.push('#' + (i + 1) + '.judgeValue 应为 null 实际 ' + JSON.stringify(q.judgeValue));
    }
    if (isShort) {
      if (JSON.stringify((p.keywords || []).map(k => k.text)) !== JSON.stringify((q.keywords || []).map(k => k.text))) losses.push('#' + (i + 1) + '.keywords');
    } else if (q.keywords !== null) {
      norm.push('#' + (i + 1) + '.keywords 应为 null');
    }
  });
  eq(losses, [], '无信息丢失：题型/题干/答案/解析/文本框标记/选项/判分值/答案字母/关键词全部一致');
  eq(norm, [], '归一化规则生效：不适用的字段一律为 null（下游据此判断，不会拿到空数组）');
  eq(built[0].options.length, 4, '选择题的 options 是数组（可安全 map）');
  eq(built[3].options, null, '判断题的 options 是 null（下游须判空，不可直接 map）');
  eq(built[6].keywords.length, 3, '简答题的 keywords 是数组');
  eq(built[0].keywords, null, '单选题的 keywords 是 null');

  // ⑥ 往返：导出 → readPayload → id 与关键字段不变
  const wire = JSON.parse(JSON.stringify(Object.assign({ schemaVersion: S.SCHEMA_VERSION }, exam)));
  const back = S.readPayload(wire);
  eq(back.ok, true, '往返：readPayload 接受');
  eq(back.payload.questions.map(q => q.id), ids, '往返：10 个 id 逐一对上');
  eq(back.payload.questions[6].keywords.map(k => k.text), ['SYN', 'SYN+ACK', 'ACK'], '往返：第 7 题加粗关键词完整');
  eq(back.payload.questions[9].inTextBox, true, '往返：第 10 题文本框标记保留');
  eq(back.payload.questions[5].judgeValue, null, '往返：第 6 题歧义判分值为 null（不被误改成 false）');
  eq(S.validateExam(back.payload).ok, true, '往返：还原后的试卷仍通过校验');
  eq(S.validateExam(back.payload).warnings.length, 1, '往返：警告条数不变');

  // ⑦ 反例：把解析结果的题型改坏，必须在结构层被拦住
  const broken = built.map((q, i) => i === 0 ? Object.assign({}, q, { type: '填空' }) : q);
  eq(S.validateExam(S.createExam({ title: 'x', questions: broken }, { now: 'n' })).ok, false,
     '反例：题型被改成非法值 → 结构层拦住');

  // ⑧ 大规模性能抽查：1000 题校验应远快于 O(n²)
  const many = [];
  for (let i = 0; i < 1000; i++) many.push(S.createQuestion({ type: '判断', stem: '题' + i, answer: '√' }, { rng: Math.random }));
  const bigExam = S.createExam({ title: '大卷', questions: many }, { now: 'n' });
  const t0 = Date.now();
  const bigRes = S.validateExam(bigExam);
  const ms = Date.now() - t0;
  eq(bigRes.ok, true, '1000 题整卷校验通过');
  ok(ms < 500, '1000 题校验耗时在 500ms 内（证明没有退化成 O(n²)）', ms + ' ms');

  console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
  console.log('  PASS ' + pass + '    FAIL ' + fail);
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
