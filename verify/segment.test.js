/* ============================================================
 *  verify/segment.test.js —— 「题型识别与歧义标定」小类验收
 *
 *  运行： node verify/segment.test.js
 *
 *  三条盘档验收标准，逐条对应：
 *    ① 四种题型标记及其常见别名均被正确归类；无标记的题干不会被误当新题
 *    ② 判断题答案的 12 种正误写法全部归一正确；『待定』等无法识别的答案
 *       使该题进入待校对列表且【判分时为 0 分而非乱判】
 *    ③ 选择题选项少于 2 个时被标为可疑并在校对面板高亮
 *       （面板属 app shell，这里交付并验证它要消费的"机器可读疑点分类"）
 * ============================================================ */
const P = require('../parser-core.js');        // 门面
const Segment = require('../core/parse/segment.js');
const Schema = require('../core/schema.js');
const Quiz = require('../core/quiz.js');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
function ok(c, t, d) { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + d : '')))
                         : (fail++, failures.push(t), console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + JSON.stringify(d) : ''))); }
function eq(a, e, t) { const A = JSON.stringify(a), E = JSON.stringify(e); ok(A === E, t + '   期望=' + E, A); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }

/* ============================================================
 * ① 题型识别：四类 + 常见别名
 * ============================================================ */
const ALIAS_CASES = [
  // 单选
  ['【单选】x', '单选'], ['[单选]x', '单选'], ['（单选）x', '单选'], ['(单选)x', '单选'],
  ['【单选题】x', '单选'], ['【单项选择题】x', '单选'], ['【单项选择】x', '单选'], ['单选题：x', '单选'],
  // 多选
  ['【多选】x', '多选'], ['[多选]x', '多选'], ['【多选题】x', '多选'],
  ['【多项选择题】x', '多选'], ['【多项选择】x', '多选'], ['多选题：x', '多选'],
  // 判断
  ['【判断】x', '判断'], ['[判断]x', '判断'], ['【判断题】x', '判断'],
  ['【是非题】x', '判断'], ['判断题：x', '判断'], ['是非题：x', '判断'],
  // 简答
  ['【简答】x', '简答'], ['[简答]x', '简答'], ['【简答题】x', '简答'],
  ['【问答】x', '简答'], ['【问答题】x', '简答'], ['【论述题】x', '简答'], ['问答题：x', '简答'],
  // 带题号前缀
  ['1.【单选】x', '单选'], ['2、[多选]x', '多选'], ['3) （判断）x', '判断'], ['4．单选题：x', '单选'],
  // 冒号形态：**必须带「题」字**才算标记
  ['单项选择题：x', '单选'], ['多项选择题：x', '多选'], ['论述题：x', '简答'],
  // 必须**不是**标记（否则会把题干误当新题）
  ['这是一段没有标记的文字', null], ['判断下列说法是否正确', null],
  ['答案解析：略', null], ['问：什么是 TCP', null], ['单选', null],
  ['【题型】x', null], ['答案：正确', null], ['解析：因为所以', null], ['', null], [null, null],
  // 裸别名 + 冒号 → **刻意不认**（"判断"既是题型名也是常用动词，切了会腰斩题干）
  ['判断：地球是圆的', null], ['单选：x', null], ['简答：x', null],
  ['问答：x', null], ['单项选择：x', null], ['多项选择：x', null], ['论述：x', null]
];

(async function main() {

  head('①-A 四类题型标记 + 常见别名归类（' + ALIAS_CASES.length + ' 例）');
  let aliasBad = [];
  ALIAS_CASES.forEach(function (c) {
    const got = P.detectType(c[0]);
    if (got !== c[1]) aliasBad.push(JSON.stringify(c[0]) + ' → ' + got + '（应 ' + c[1] + '）');
  });
  eq(aliasBad, [], '全部别名归类正确（含 4 类 × 常见变体 + 带题号前缀）');
  eq(P.detectType('【多选】x'), '多选', '核对：半角/全角括号都能识别');
  eq(P.detectType('【单项选择题】x'), '单选', '核对：长别名不会被短别名截断');
  eq(P.detectType('判断下列说法是否正确'), null, '核对：无括号无冒号的「判断…」是题干，不是标记');

  head('①-B 无标记的题干不会被误当新题（这是本类唯一会"静默错卷"的风险）');

  // 一道单选，后面跟 3 行无标记续行
  const multiLine = P.parseText(
    '【单选】以下说法哪个正确？\n' +
    '这是题干的第二行，没有题型标记。\n' +
    '这是第三行，也不该开新题。\n' +
    'A. 甲\nB. 乙\n答案：A\n');
  eq(multiLine.stats.total, 1, '多行无标记续行仍只有 1 道题');
  eq(multiLine.questions[0].stem,
     '以下说法哪个正确？\n这是题干的第二行，没有题型标记。\n这是第三行，也不该开新题。',
     '  三行全部并入同一题的题干（一行都没丢）');

  // 全是无标记文字 → 0 题（不是 N 题）
  const noMarker = P.parseText('这是一份说明文档。\n第一段。\n第二段。\n第三段。\n');
  eq(noMarker.stats.total, 0, '整份无标记文本 → 0 题（不会被切成 4 个"题"）');

  // 混排：无标记前言 + 两题 → 前言不产生题，题数仍为 2
  const mixed = P.parseText('某某学校期末试卷\n考试时间 90 分钟\n【单选】1+1=?\nA. 1\nB. 2\n答案：B\n【判断】天是蓝的。（　）\n答案：对\n');
  eq(mixed.stats.total, 2, '卷头说明文字不会变成题，题数 = 2');
  eq(mixed.questions.map(q => q.type), ['单选', '判断'], '  题型依次正确');

  // 一个「看起来像标记但其实是题干」的行不能切题
  const trap = P.parseText('【判断】判断下列说法是否正确。（　）\n答案：对\n');
  eq(trap.stats.total, 1, '题干里含「判断…」字样也不会多切一题');
  eq(trap.questions[0].stem, '判断下列说法是否正确。（　）', '  题干完整保留');

  // 挑刺发现的真实误切：题干续行以「判断：」开头时，早期版本会把题干腰斩
  const cutRisk = P.parseText('【简答】请说明下列问题。\n判断：地球是圆的。（　）\n以上是题干的一部分。\n答案：略\n');
  eq(cutRisk.stats.total, 1, '题干续行以「判断：」开头 → 仍是 1 题（不被腰斩）');
  eq(cutRisk.questions[0].stem,
     '请说明下列问题。\n判断：地球是圆的。（　）\n以上是题干的一部分。',
     '  三行全在题干里，一行都没丢');
  eq(cutRisk.questions[0].type, '简答', '  题型没被改写成「判断」');
  const numRisk = P.parseText('【单选】下面哪个对？\n1. 判断：甲\n答案：A\n');
  eq(numRisk.stats.total, 1, '续行形如「1. 判断：甲」也不会多切一题');
  eq(numRisk.questions[0].stem, '下面哪个对？\n1. 判断：甲', '  该行并入题干');

  /* ============================================================
   * ② 判断题正误归一 + 歧义标定 + 判分 0
   * ============================================================ */
  head('②-A 规格要求的 12 种正误写法全部归一');

  const TWELVE = [
    ['√', true], ['对', true], ['正确', true], ['T', true], ['True', true], ['是', true],
    ['×', false], ['错', false], ['错误', false], ['F', false], ['False', false], ['否', false]
  ];
  let twelveBad = [];
  TWELVE.forEach(function (c) {
    const r = P.normalizeJudge(c[0]);
    if (r.value !== c[1]) twelveBad.push(c[0] + ' → ' + r.value);
    if (r.value !== null && r.reason) twelveBad.push(c[0] + ' 有值却带 reason');
  });
  eq(twelveBad, [], '12 种写法（√对正确T True是 / ×错错误F False否）全部归一正确');

  // 大小写与空格/标点
  eq(P.normalizeJudge('  TRUE  ').value, true, '大小写与空白不影响：TRUE → true');
  eq(P.normalizeJudge('√。').value, true, '句末标点不影响：√。 → true');
  eq(P.normalizeJudge(' 【正确】 ').value, true, '带括号注解不影响：【正确】 → true');

  head('②-B 否定式必须按语义取反（早期实现把「不正确」判成"正确"——判反）');

  const NEG = [['不正确', false], ['不对', false], ['不是', false], ['非正确', false],
               ['不正确。', false], ['没错', true]];
  let negBad = [];
  NEG.forEach(function (c) {
    const v = P.normalizeJudge(c[0]).value;
    if (v !== c[1]) negBad.push(c[0] + ' → ' + v + '（应 ' + c[1] + '）');
  });
  eq(negBad, [], '否定式全部取反正确（不正确/不对/不是/非正确/没错）');

  head('②-C 无法识别或本身歧义 → value=null + 进待校对，绝不猜');

  const AMBIG = ['待定', '不知道', 'TBD', '略', '无', '也许', '待确认',
                 '对错', '正确与否', '是否', '真假'];
  let ambBad = [], ambNoReason = [];
  AMBIG.forEach(function (w) {
    const r = P.normalizeJudge(w);
    if (r.value !== null) ambBad.push(w + ' → ' + r.value);
    if (!r.reason) ambNoReason.push(w);
  });
  eq(ambBad, [], '歧义/无法识别的答案一律 value=null（共 ' + AMBIG.length + ' 例）');
  eq(ambNoReason, [], '  且每例都带 reason（供校对面板显示原因）');
  eq(P.normalizeJudge('待定').reason.indexOf('待定') >= 0, true, '  reason 里带上原始答案，便于用户定位');
  eq(Segment.judgeNeedsReview('待定'), true, 'judgeNeedsReview(待定) = true');
  eq(Segment.judgeNeedsReview('对'), false, 'judgeNeedsReview(对) = false');

  head('②-D 端到端：待校对判断题进列表，且【判分 0 分】而不是乱判（相邻锚 → core/quiz.js）');

  const cfg = Quiz.resolveConfig();
  eq(cfg.points['判断'], 1, '取到默认配置（判断题 1 分/题）');

  const r = P.parseText('【判断】地球是方的。（　）\n答案：待定\n【判断】地球是圆的。（　）\n答案：不正确\n');
  eq(r.stats.total, 2, '切出 2 道判断题');

  const q0 = r.questions[0];
  eq(q0.judgeValue, null, '第 1 题（答案"待定"）judgeValue = null');
  ok(q0.review.length > 0, '  该题进入待校对（review 非空）', JSON.stringify(q0.review));

  // 判分侧：无论用户答什么，待校对题都必须 0 分（不参与判分）
  const sTrue = Quiz.scoreOne(q0, '对', cfg);
  const sFalse = Quiz.scoreOne(q0, '错', cfg);
  eq(sTrue.score, 0, '用户答"对" → 0 分（不参与判分）');
  eq(sFalse.score, 0, '用户答"错" → 0 分（不参与判分）');
  eq(sTrue.correct, false, '  且 correct=false');
  eq(sTrue.full, 1, '  题面满分仍是 1（不是把题删了，只是判不了）');

  const q1 = r.questions[1];
  eq(q1.judgeValue, false, '第 2 题（答案"不正确"）judgeValue = false（早期会判成 true）');
  eq(Quiz.scoreOne(q1, '错', cfg).score, 1, '  用户答"错" → 满分 1');
  eq(Quiz.scoreOne(q1, '对', cfg).score, 0, '  用户答"对" → 0 分');

  // 待校对清单（面板就是渲染这个）
  const reviewList = P.collectReview(r.questions);
  eq(reviewList.length, 1, 'collectReview 只挑出 1 道需要人工看的题');
  eq(reviewList[0].index, 0, '  指向第 0 题');
  ok(reviewList[0].flags.some(f => f.id === 'judge-ambiguous'),
     '  疑点分类为 judge-ambiguous', JSON.stringify(reviewList[0].flags.map(f => f.id)));

  /* ============================================================
   * ③ 选项少于 2 个 → 标为可疑 + 面板高亮契约
   * ============================================================ */
  head('②-E 反序列化后仍不许"伪装成人工标记"（这是结构化往返无损的前提）');

  function mkShort(kws) {
    return { type: '简答', stem: '题？', answer: '甲甲；乙乙', options: [],
             answerLetters: null, judgeValue: null, explanation: '', difficulty: null,
             inTextBox: false, review: [], keywords: kws };
  }
  const AUTO_KW = [{ text: '甲甲', via: '自动(需校对)' }, { text: '乙乙', via: '自动(需校对)' }];
  const MANUAL_KW = [{ text: '人工甲', via: '手动' }];
  const STYLE_KW = [{ text: '样式甲', via: '加粗' }];

  // 关键词在、review 提示丢了 —— 导入 JSON / 结构化 txt 时就是这个样子
  const r1 = mkShort(JSON.parse(JSON.stringify(AUTO_KW)));
  Segment.applyDerived(r1);
  ok(r1.review.some(s => s.indexOf('自动生成') >= 0 && s.indexOf('需校对') >= 0),
     '关键词全自动但提示丢失 → applyDerived 把提示补回来', JSON.stringify(r1.review));
  eq(Segment.reviewFlags(r1).map(f => f.id), ['keywords-auto'],
     '  疑点分类随之正确（不会被漏标成"无需校对"）');

  const r2 = mkShort(AUTO_KW.concat(MANUAL_KW));
  Segment.applyDerived(r2);
  ok(r2.review.some(s => s.indexOf('自动生成') >= 0),
     '自动 + 手工混着 → 仍要提示（里面还有自动生成的）');

  const r3 = mkShort(JSON.parse(JSON.stringify(MANUAL_KW)));
  Segment.applyDerived(r3);
  eq(r3.review, [], '只有手工关键词 → 不提示（不许诬告成自动生成）');
  eq(Segment.reviewFlags(r3), [], '  疑点分类为空');

  const r4 = mkShort(JSON.parse(JSON.stringify(STYLE_KW)));
  Segment.applyDerived(r4);
  eq(r4.review, [], '只有原文样式关键词 → 不提示');

  // 幂等：往返无损要靠这条性质（导入时会重跑一次 applyDerived）
  const base2 = mkShort(AUTO_KW.concat(MANUAL_KW));
  Segment.applyDerived(base2);
  const once = JSON.stringify(base2);
  Segment.applyDerived(base2);
  eq(JSON.stringify(base2), once, 'applyDerived 幂等（跑第二遍结果逐字节不变）');
  eq(base2.review.filter(s => s.indexOf('自动生成') >= 0).length, 1, '  提示没有被重复追加');

  head('③-A 选择题选项数校验');

  const fewOpts = P.parseText(
    '【单选】没有选项的单选题？\n答案：A\n' +
    '【多选】只有一个选项的多选题？\nA. 孤独的选项\n答案：A\n' +
    '【单选】正常的两选项题？\nA. 甲\nB. 乙\n答案：B\n');
  eq(fewOpts.stats.total, 3, '切出 3 题');

  const qFew0 = fewOpts.questions[0], qFew1 = fewOpts.questions[1], qOk = fewOpts.questions[2];
  eq(qFew0.options.length, 0, '第 1 题：0 个选项');
  eq(qFew1.options.length, 1, '第 2 题：1 个选项');
  eq(qOk.options.length, 2, '第 3 题：2 个选项（正常）');

  ok(qFew0.review.some(s => s.indexOf('选项少于 2 个') >= 0), '第 1 题（0 选项）被标为可疑',
     JSON.stringify(qFew0.review));
  ok(qFew1.review.some(s => s.indexOf('选项少于 2 个') >= 0), '第 2 题（1 选项）被标为可疑',
     JSON.stringify(qFew1.review));
  ok(!qOk.review.some(s => s.indexOf('选项少于 2 个') >= 0), '第 3 题（2 选项）不被误标');

  head('③-B 面板高亮契约：疑点必须是机器可读的分类，不能靠猜中文文案');

  const f0 = P.reviewFlags(qFew0), f1 = P.reviewFlags(qFew1), fOk = P.reviewFlags(qOk);
  ok(f0.some(f => f.id === 'too-few-options'), '0 选项题 → flag id = too-few-options',
     JSON.stringify(f0.map(f => f.id)));
  ok(f1.some(f => f.id === 'too-few-options'), '1 选项题 → flag id = too-few-options',
     JSON.stringify(f1.map(f => f.id)));
  eq(fOk.length, 0, '正常题 → 无任何疑点（面板不高亮）');
  eq(f0.filter(f => f.id === 'too-few-options')[0].label,
     '选择题选项少于 2 个，可疑', '  flag 带可直接显示的中文标签');
  ok(f0.filter(f => f.id === 'too-few-options')[0].text.length > 0,
     '  flag 带原始 review 文案（面板可直接展示）');

  const list = P.collectReview(fewOpts.questions);
  eq(list.map(x => x.index), [0, 1], 'collectReview 只列可疑题（0 与 1），正常题不入列');
  ok(list.every(x => x.flags.length > 0), '  每条都带 flags');
  eq(list[0].stem, '没有选项的单选题？', '  带上题干，面板可直接显示');

  // 分类函数的稳定性：同一输入重复调用结果一致（面板每帧渲染要用）
  eq(P.reviewFlags(qFew0), P.reviewFlags(qFew0), 'reviewFlags 可重复调用且结果稳定');
  eq(P.reviewFlags({}), [], 'reviewFlags 对空对象安全返回 []');
  eq(P.reviewFlags(null), [], 'reviewFlags(null) 安全返回 []');
  eq(P.collectReview(null), [], 'collectReview(null) 安全返回 []');

  head('③-C 相邻锚：解析层标"可疑"，schema 层也应判"非法"——两边必须同意');

  const cq = Schema.createQuestion(qFew0);
  const v = Schema.validateQuestion(cq);
  eq(v.ok, false, 'schema.validateQuestion 对 0 选项题判为不合法（与解析层的"可疑"一致）');
  ok(v.errors.some(e => e.indexOf('选项少于 2 个') >= 0), '  错误信息同样指向选项数',
     JSON.stringify(v.errors));
  ok(!v.ok && v.errors.length > 0, '  schema 给出的错误条数 > 0', String(v.errors.length));

  /* ============================================================
   * ④ 边界与稳健性
   * ============================================================ */
  head('④ 边界：脏输入不抛异常');

  let crashed = null;
  try {
    P.detectType(undefined); P.detectType(123); P.detectType({}); 
    P.normalizeJudge(undefined); P.normalizeJudge(null); P.normalizeJudge(0); P.normalizeJudge(false);
    P.normalizeJudge({}); P.segment(null); P.segment([]);
    P.reviewFlags(undefined); P.collectReview(undefined);
  } catch (e) { crashed = e; }
  ok(!crashed, '脏输入全部不抛异常', crashed && crashed.message);
  eq(P.normalizeJudge(true).value, true, 'normalizeJudge(true) 直通');
  eq(P.normalizeJudge(false).value, false, 'normalizeJudge(false) 直通');
  eq(P.normalizeJudge('').value, null, 'normalizeJudge("") → null（没有答案）');
  eq(P.normalizeJudge('').reason, '判断题没有答案', '  reason 明确是"没有答案"');

  head('⑤ 冻结接口与迁移完整性');
  eq(typeof P.segment, 'function', '门面仍导出 segment');
  eq(typeof P.detectType, 'function', '门面新增 detectType（契约里早就要求，之前一直缺）');
  eq(P.parseText.length, 1, 'parseText 仍是 1 元（冻结签名未变）');
  eq(P.normalizeJudge('对').value, true, '门面 normalizeJudge 返回 {value,reason} 形状未变');
  ok(Array.isArray(P.TYPE_MARKERS) && P.TYPE_MARKERS.length === 4, 'TYPE_MARKERS 仍是 4 组',
     String(P.TYPE_MARKERS.length));
  eq(typeof P.reviewFlags, 'function', '门面导出 reviewFlags');
  eq(typeof P.collectReview, 'function', '门面导出 collectReview');
  // 迁移完整性：切题逻辑只应存在于 segment.js 一处
  ok(!!P.SegmentCore && P.SegmentCore.segment === P.segment, '门面的 segment 就是 SegmentCore 的实现（无重复实现）');
  ok(P.TextCore && P.TextCore.fallbackKeywords === P.fallbackKeywords, 'fallbackKeywords 单点实现');
  eq(Segment.TYPE_ALIASES.map(g => g.type), ['单选', '多选', '判断', '简答'], '别名表覆盖且只覆盖四类题型');

  /* ============================================================
   * ⑥ 真实题集的**分节写法**（用户实测报障：整份文件切出 0 题）
   * ============================================================ */
  head('⑥-A 段头式题型标记（一、单选题 / 二、多选题 / 三、判断题）');

  eq(P.detectType('一、单选题'), '单选', '「一、单选题」= 段头标记（中文序号 + 无冒号，真实题集最常见）');
  eq(P.detectType('二、多选题'), '多选', '「二、多选题」同上');
  eq(P.detectType('三、判断题'), '判断', '「三、判断题」同上');
  eq(P.detectType('四、简答题'), '简答', '「四、简答题」同上');
  eq(P.detectType('（一）单选题'), '单选', '括号序号形态也认');
  eq(P.detectType('第3部分 多选题'), '多选', '「第 N 部分」形态也认');
  eq(P.detectType('3. 判断题'), '判断', '阿拉伯序号形态也认');
  eq(P.detectType('单选题'), '单选', '裸段头「单选题」也认（整行只有它）');
  // ⚠ 这两条是**刻意不认**：裸的 2 字别名太容易是题干
  eq(P.detectType('单选'), null, '裸的「单选」仍**不**算标记（可能是题干）');
  eq(P.detectType('判断'), null, '裸的「判断」仍**不**算标记（"判断"也是常用动词）');
  eq(P.detectType('二、多选题的特点是什么？'), null, '段头后缀了题干文字 → 不再是段头（不许把题干吃掉）');
  eq(P.detectType('1. 我国既拥有广阔的陆地'), null, '带题号的题干不是段头');
  eq(P.SegmentCore.matchTypeMarker('一、单选题').header, true, '  段头命中时 header=true（调用方据此知道"这一节开始了"）');
  eq(P.SegmentCore.matchTypeMarker('【单选】题干').header, false, '  行内标记 header=false（后面那些字是题干）');

  head('⑥-B 端到端：整份分节题集（fixture/text，节内靠题号或空行断题）');

  const bankTxt = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'txt', 'sectioned_bank.txt'), 'utf8');
  const bank = P.parseText(bankTxt);
  eq(bank.stats.byType, { '单选': 3, '多选': 3, '判断': 3, '简答': 1 }, '四节全部切开：3+3+3+1 = 10 题');
  eq(bank.questions.map(q => q.type).join(','), '单选,单选,单选,多选,多选,多选,判断,判断,判断,简答',
     '  题型顺序与文件一致（段头的作用范围就是它那一节）');
  /* 简答题的"关键词自动生成"是**既有设计**（参考答案没带样式时切不出采分点，挂出来让人补），
   * 与本次改动无关 —— 所以这里只看前 9 道选择题/判断题有没有疑点。 */
  eq(bank.questions.slice(0, 9).filter(q => q.review.length).length, 0, '  九道选择/判断题全部不需要人工校对（0 条疑点）');
  eq(bank.questions.filter(q => !q.answer).length, 0, '  每题都拿到了答案');
  eq(bank.questions.filter(q => !q.explanation).length, 0, '  每题都拿到了解析');

  head('⑥-C 单选节：题干不编号、一行挤着 4 个选项、靠空行分题');
  const s1 = bank.questions[0];
  eq(s1.stem, '下列哪一项是计算机网络中"传输层"的协议？', '题干就是那一行（没有混进选项/答案/解析）');
  eq(s1.options.map(o => o.label), ['A', 'B', 'C', 'D'], '**一行里的 4 个选项被拆成 4 个**（以前是 1 个）');
  eq(s1.options.map(o => o.text), ['TCP', 'IP', 'ARP', 'ICMP'], '  每个选项的文字也对');
  eq([s1.answer, s1.answerLetters], ['A', ['A']], '答案 A');
  eq(bank.questions[1].stem, 'HTTP 协议默认使用的端口号是（）。', '第二题的题干是**另起一道**（空行分题），不是接着上一题');
  eq(bank.questions.map(q => q.stem).filter(s => s.indexOf('答案：') >= 0).length, 0, '  没有任何题干里混进"答案："');

  head('⑥-D 多选/判断节：题与题之间**没有空行**，靠题号断题');
  const m1 = bank.questions[3];
  eq([m1.type, m1.stem, m1.answer], ['多选', '下列属于传输层协议的有（）。', 'AB'], '多选节：题号断题 + 「参考答案：」也认');
  eq(m1.options.length, 4, '  同一行 4 个选项照样拆开');
  const j1 = bank.questions[6];
  eq([j1.type, j1.stem, j1.answer, j1.judgeValue], ['判断', '交换机工作在 TCP/IP 的应用层。', '×', false],
     '判断题：答案写在题干末尾的（×）被取出来，并把括号从题干里剥掉');
  eq([bank.questions[7].judgeValue, bank.questions[8].judgeValue], [false, true], '  三道的正误分别是 ×、×、√');
  eq(bank.questions.filter(q => q.type === '判断').map(q => q.stem.indexOf('（')),
     [-1, -1, -1], '  题干里不再残留括号答案');
  eq(bank.questions.filter(q => /^\s*\d/.test(q.stem)).length, 0, '  题干里不再残留题号');

  /* 判断题**不编号**时，唯一的边界信号就是"空行" —— 这条单独钉住它：
   * 带选项的题型即使没有空行也能靠"下一行是新的 A. 选项"切出来，会把空行的作用掩盖掉。 */
  const judgeBlank = P.parseText('三、判断题\n\n甲题。（×）\n解析：略\n\n乙题。（√）\n解析：略\n');
  eq([judgeBlank.stats.total, judgeBlank.questions.map(q => q.judgeValue)], [2, [false, true]],
     '判断节**不编号、靠空行分题**也切得开（空行就是那条边界信号）');

  head('⑥-E 简答节：**不**按空行断题（参考答案本身就是自由文字）');
  const short = bank.questions[9];
  eq(short.type, '简答', '最后一道是简答题');
  ok(short.answer.indexOf('客户端发送 SYN') >= 0, '  参考答案取到了', short.answer);
  ok(short.explanation.indexOf('三步记') >= 0, '  解析也取到了（没被当成新题）', short.explanation);
  eq(bank.questions.filter(q => q.type === '简答').length, 1, '  简答节只有 1 题 —— 中间那个空行没有切出新题');

  head('⑥-F 一行多选项的拆分规则（只认依次递增的标签）');
  eq(P.SegmentCore.splitOptionLine('A.甲 B.乙 C.丙 D.丁', 'A').map(o => o.label + o.text), ['A甲', 'B乙', 'C丙', 'D丁'],
     '四个选项一行 → 拆成四个');
  eq(P.SegmentCore.splitOptionLine('B.乙 C.丙', 'B').map(o => o.label + o.text), ['B乙', 'C丙'],
     '选项分多行时，第二行从 B 起也能拆（起始字母由调用方给）');
  eq(P.SegmentCore.splitOptionLine('A.甲', 'A').map(o => o.text), ['甲'], '只有一个选项时原样返回');
  eq(P.SegmentCore.splitOptionLine('A.含 B. 字样的选项文本', 'A').map(o => o.label), ['A', 'B'],
     '文本里出现下一个标签 → 照拆（这是"选项挤在一行"的常规形态）');
  eq(P.SegmentCore.splitOptionLine('A.甲 C.丙', 'A').map(o => o.label + o.text), ['A甲 C.丙'],
     '跳号（A 后面直接 C）→ **不拆**（不满足"依次递增"，宁可整行当一个选项）');
  eq(P.SegmentCore.splitOptionLine('这段文字里有个 A. 但不是选项', 'A').map(o => o.label), ['A'],
     '只有行首那个标签算数（居中的 A. 不切）');

  head('⑥-G 判断题尾答案：只认明确的正误符号，空括号不算答案');
  eq(P.SegmentCore.extractTailJudge({ stem: '天是蓝的。（√）' }), true, '（√）被认出来');
  const tq = { stem: '天是蓝的。（√）' };
  P.SegmentCore.extractTailJudge(tq);
  eq([tq.answer, tq.stem], ['√', '天是蓝的。'], '  取到答案并把括号剥掉');
  const eq2 = { stem: '地球是圆的。（　）' };
  eq(P.SegmentCore.extractTailJudge(eq2), false, '**空括号**（待作答的括注）不算答案');
  eq(eq2.stem, '地球是圆的。（　）', '  题干原样不动');
  const mid = { stem: '（×）这句话对吗？' };
  eq(P.SegmentCore.extractTailJudge(mid), false, '括号在**中间**（不是题干末尾）→ 不认');

  head('⑥-H 安全网：段头开出的空壳题不许变成假题；漏切题要挂"可能漏切题"');
  const emptySections = P.parseText('一、单选题\n二、多选题\n三、判断题\n');
  eq(emptySections.stats.total, 0, '只有段头、一道题都没有 → 0 题（空壳不许当题收进去）');

  /* 连排文件（既没有空行、也没有题号）：靠"这一行后面紧跟新的 A. 选项"把它救回来
   *   —— 题干续行后面不会再冒出 A. 选项，所以那个信号是可靠的。 */
  const noSignal = P.parseText('一、单选题\n甲题（）\nA.甲 B.乙\n答案：A\n解析：略\n乙题（）\nA.甲 B.乙\n答案：B\n解析：略\n');
  eq(noSignal.stats.total, 2, '既无空行又无题号 → 也能切 2 题（靠"下一行是新的 A. 选项"这个前瞻信号）');
  eq(noSignal.questions.map(q => q.answer), ['A', 'B'], '  两题的答案各自正确，没有被覆盖');
  eq(noSignal.questions.filter(q => q.review.length).length, 0, '  没有疑点（切干净了）');
  // 真·切不动时（第二题连选项都没有）：答案不许被静默覆盖，必须挂出疑点
  const dupAns = P.parseText('一、单选题\n甲题（）\nA.甲 B.乙\n答案：A\n解析：略\n乙题（没有选项的怪题）\n答案：B\n');
  eq(dupAns.questions[0].answer, 'A', '第二题连选项都没有（前瞻信号也失效）→ 保留**第一行**答案');
  ok(dupAns.questions[0].review.join('').indexOf('第二行「答案：」') >= 0,
     '  并挂上"出现了第二行答案"的疑点（以前是静默覆盖，第一题的答案被悄悄换掉）', dupAns.questions[0].review);
  eq(P.reviewFlags(dupAns.questions[0]).filter(f => f.id === 'maybe-unsplit').length, 1,
     '  并且能被面板的疑点分类认出来');
  const withBlank = P.parseText('一、单选题\n甲题（）\nA.甲 B.乙\n答案：A\n解析：略\n\n乙题（）\nA.甲 B.乙\n答案：B\n解析：略\n');
  eq(withBlank.stats.total, 2, '  补一个空行 → 2 题（空行也是边界信号）');

  /* 题干里混进"答案："或题号 → 派生疑点（这条主要服务于**校对面板里手改题干**的场景：
   * 用户把漏切的题拼回去/贴进来时，面板要能提示它"可能没切开"） */
  const leaked = { type: '单选', stem: '甲题（）\n答案：A\n乙题（）', options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }],
                   answer: 'A', keywords: [], review: [] };
  P.SegmentCore.applyDerived(leaked);
  ok(leaked.review.join('').indexOf('可能漏切题') >= 0, '题干里出现整行「答案：」→ 挂"可能漏切题"疑点', leaked.review);
  const numbered = { type: '单选', stem: '甲题（）\n2. 乙题（）', options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }],
                     answer: 'A', keywords: [], review: [] };
  P.SegmentCore.applyDerived(numbered);
  ok(numbered.review.join('').indexOf('可能漏切题') >= 0, '题干里出现题号行 → 同样挂疑点', numbered.review);
  // 只是"引用"了这几个字（不在行首）不算漏切 —— 不许把正常题干判成可疑
  const quoted = { type: '单选', stem: '题干里出现"答案："三个字时怎么办？', options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }],
                   answer: 'A', keywords: [], review: [] };
  P.SegmentCore.applyDerived(quoted);
  eq(quoted.review, [], '题干里**引用**了"答案："（不在行首）→ 不算漏切（不误报）');
  const fixed = { type: '单选', stem: '干净的题干（）', options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }],
                  answer: 'A', keywords: [], review: leaked.review.slice() };
  P.SegmentCore.applyDerived(fixed);
  eq(fixed.review.filter(s => /可能漏切题/.test(s)), [], '  题干改干净后疑点自动消失（派生规则，不是一次性标记）');

  console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
  console.log('  PASS ' + pass + '    FAIL ' + fail);
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
