/* ============================================================
 *  verify/text-format.test.js —— 「结构化纯文本格式」盘档验收
 *
 *  运行： node verify/text-format.test.js
 *
 *  三条盘档标准（判定口径照原样，不放宽）：
 *    ① 任意试卷导出后再导入，逐字段无差异 —— 用 JSON.stringify 比**整个 Exam 对象**
 *       （id/schemaVersion/title/createdAt/updatedAt/config/configLocked/questions），
 *       每题覆盖 12 个字段（id/type/stem/options/answer/answerLetters/judgeValue/
 *       keywords/explanation/difficulty/review/inTextBox）
 *    ② 人为破坏的文本被拒绝，且错误能指出**出错行号**或明确原因
 *    ③ 导入失败时已有数据零变化（真实 store + 内存版 localStorage/IndexedDB 假后端，
 *       导入前后全量快照逐字节相等），并做**反向对照**（合法导入后快照必须变）
 *
 *  基准怎么造（这条决定了"逐字段无差异"是否有意义）：
 *    raw → SegmentCore.applyDerived → SchemaCore.createQuestion
 *    与 core/exams.js 的 normalizeQuestions、parser-core 的产出同序同形。
 *    若反过来先 createQuestion 再 applyDerived，非简答题的 keywords 会从 null 变回 []，
 *    整个判据当场失效（§1-G 把这个顺序钉成回归断言）。
 *
 *  断言器：每条都打印 PASS/FAIL + 实际值；**比较用完整值，只有显示截断**。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const S = require('../core/schema.js');
const Seg = require('../core/parse/segment.js');
const D = require('../core/data.js');
const E = require('../core/exams.js');
const P = require('../parser-core.js');
const TF = require('../core/text-format.js');

let pass = 0, fail = 0;
const failures = [];
function brief(v, lim) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return String(s);
  const L = lim || 150;
  return s.length > L ? s.slice(0, L) + '…(' + s.length + ' 字符)' : s;
}
function ok(c, t, d) {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d !== undefined ? '   ' + brief(d) : '')); }
  else { fail++; failures.push(t); console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + brief(d) : '')); }
}
/* 比较**完整值**（不截断），显示才截断 —— 截断绝不能造成假 PASS */
function eq(a, e, t) {
  const A = JSON.stringify(a), B = JSON.stringify(e);
  ok(A === B, t + (B !== undefined ? '   期望=' + brief(B, 90) : ''), A);
}
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }

/* ================= 基准构造：工厂形状（先派生、后工厂） ================= */
function mk(raw) {
  const q = JSON.parse(JSON.stringify(raw));
  Seg.applyDerived(q);
  return S.createQuestion(q);
}
function mkExam(title, raws, o) {
  const x = o || {};
  return S.createExam({
    title: title,
    questions: (raws || []).map(mk),
    config: (x.config === undefined ? null : x.config),
    configLocked: !!x.configLocked
  }, { now: x.now || '2026-09-17T09:00:00.000Z', id: x.id });
}
/* 12 个字段的完整摘要：一次比完，显示成一个紧凑数组 */
function qDigest(q) {
  return [q.id, q.type, q.stem, q.options, q.answer, q.answerLetters,
          q.judgeValue, q.keywords, q.explanation, q.difficulty, q.review, q.inTextBox];
}
function digests(exam) { return exam.questions.map(qDigest); }

/* ================= 假后端（内存版 localStorage + IndexedDB） ================= */
function world() {
  const sm = new Map(), lg = new Map();
  const small = {
    getItem: k => (sm.has(k) ? sm.get(k) : null),
    setItem: (k, v) => { sm.set(String(k), String(v)); },
    removeItem: k => { sm.delete(k); },
    key: i => { const a = Array.from(sm.keys()); return i < a.length ? a[i] : null; },
    get length() { return sm.size; }
  };
  const large = {
    get: async k => (lg.has(k) ? JSON.parse(lg.get(k)) : null),
    set: async (k, v) => { lg.set(String(k), JSON.stringify(v)); },
    del: async k => { lg.delete(k); },
    keys: async () => Array.from(lg.keys())
  };
  return {
    small, large,
    store: ns => D.createStore({ small, large, namespace: ns || D.NS_GLOBAL, threshold: 512 })
  };
}
/* 全量快照：排序后的键值对，逐字节可比 */
async function snapOf(store) {
  const ks = (await store.keys()).slice().sort();
  const o = {};
  for (const k of ks) o[k] = await store.get(k);
  return JSON.stringify(o);
}

/* ================= 文本手术（造"人为破坏"用） ================= */
function lineNoOf(text, needle) {
  const ls = text.split('\n');
  for (let i = 0; i < ls.length; i++) if (ls[i].indexOf(needle) >= 0) return i + 1;
  return -1;
}
function editLine(text, needle, newLine) {
  return text.split('\n').map(l => (l.indexOf(needle) >= 0 ? newLine : l)).join('\n');
}
function dropLine(text, needle) {
  return text.split('\n').filter(l => l.indexOf(needle) < 0).join('\n');
}
/* 删掉某个字段行及其 | 块 */
function dropFieldBlock(text, needle) {
  const ls = text.split('\n');
  const at = ls.findIndex(l => l.indexOf(needle) >= 0);
  if (at < 0) return text;
  const out = ls.slice(0, at);
  let i = at + 1;
  while (i < ls.length && /^\s*\|/.test(ls[i])) i++;
  return out.concat(ls.slice(i)).join('\n');
}
function firstErr(r) { return (r.errors && r.errors[0]) || {}; }
function errByCode(r, code) { return (r.errors || []).filter(e => e.code === code)[0] || {}; }

/* ================= 夹具 ================= */
const FULL_TITLE = '全覆盖卷（四种题型）';
function fullRaws() {
  return [
    { id: 'q_s1', type: '单选', stem: '下列哪个协议工作在传输层？',
      options: [{ label: 'A', text: 'HTTP' }, { label: 'B', text: 'TCP' }, { label: 'C', text: 'IP' }, { label: 'D', text: 'ARP' }],
      answer: 'B', explanation: 'HTTP 是应用层；IP、ARP 属于网络层；TCP 位于传输层。', difficulty: 3, inTextBox: true },
    { id: 'q_m1', type: '多选', stem: '下列哪些属于应用层协议？',
      options: [{ label: 'A', text: 'HTTP' }, { label: 'B', text: 'FTP' }, { label: 'C', text: 'TCP' }, { label: 'D', text: 'DNS' }],
      answer: 'ABD', explanation: 'TCP 是传输层协议。', difficulty: 5, inTextBox: false },
    { id: 'q_j1', type: '判断', stem: '交换机工作在数据链路层。（　）', answer: '√', difficulty: 1 },
    { id: 'q_j2', type: '判断', stem: '集线器可以隔离冲突域。（　）', answer: '' },
    { id: 'q_j3', type: '判断', stem: '这台设备很可靠。（　）', answer: '待定', difficulty: null },
    { id: 'q_k1', type: '简答', stem: '第一行题干（含 | 竖线与 = 等号）\n第二行题干 🙂\n第三行题干：中文标点，句号。',
      answer: '参考答案：先建立连接；再传输数据。', explanation: '解析第一行\n解析第二行', 
      keywords: [{ text: '手工甲', via: '手动' }, { text: '手工乙', via: '手动' }, { text: '样式丙', via: '高亮' },
                 { text: 'A|B 竖线', via: '底纹' }],
      difficulty: 4, inTextBox: true },
    { id: 'q_k2', type: '简答', stem: '简述 TCP 三次握手的过程。',
      answer: '客户端发送 SYN；服务器回复 SYN+ACK；客户端再发送 ACK 确认。', difficulty: 2 },
    { id: 'q_k3', type: '简答', stem: '说明 DNS 递归查询与迭代查询的区别。',
      answer: '递归查询由本地DNS服务器代为完成全部解析；迭代查询由客户端逐级询问。',
      keywords: [{ text: '本地DNS服务器', via: '字体色' }, { text: '根域名服务器', via: '加粗' }, { text: '服务器地址', via: '底纹' }] },
    { id: 'q_k4', type: '简答', stem: '这是一道没有关键词也切不出关键词的题。',
      answer: '这是一个超过十八个字符的非常长的参考答案内容描述'},
    { id: 'q_e1', type: '单选', stem: '选一个 emoji 题 🙂',
      options: [{ label: 'A', text: '甲. 含点|竖线' }, { label: 'B', text: '乙：含冒号=等号' }], answer: 'A' }
  ];
}
function fullExam() {
  return mkExam(FULL_TITLE, fullRaws(), {
    config: { points: { '单选': 2, '多选': 3, '判断': 1, '简答': 5 }, seed: 7, nested: { deep: [1, 2, { x: 'y' }] }, s: '含"引号"与\\反斜杠' },
    configLocked: true, id: 'exam_full_0001'
  });
}

(async function main() {

  /* ============================================================
   * ⓪ 模块形态与签名（冻结接口逐字）
   * ============================================================ */
  head('⓪ 模块形态与签名');
  ok(typeof TF.exportExam === 'function', 'exportExam 是函数');
  ok(typeof TF.importExam === 'function', 'importExam 是函数');
  ok(typeof TF.importToLibrary === 'function', 'importToLibrary 是函数');
  ok(typeof TF.diagnose === 'function', 'diagnose 是函数');
  eq(TF.FORMAT_VERSION, 1, 'FORMAT_VERSION 从 1 开始');
  eq(TF.HEADER, '# quiz-demo 试卷文本格式 v1', 'HEADER 是带版本标识的第一行');
  eq(TF.exportExam.length, 2, 'exportExam(exam, opts) 收 2 个参数');
  eq(TF.importExam.length, 2, 'importExam(text, opts) 只收 2 个参数 —— 结构上碰不到 store');
  eq(TF.importToLibrary.length, 3, 'importToLibrary(store, text, opts)');
  eq(TF.KEYWORD_VIAS, ['加粗', '高亮', '字体色', '底纹', '自动(需校对)', '手动'], '关键词来源枚举与冻结契约一致');

  head('⓪-B UMD 双环境：浏览器沙箱里靠 window 全局挂载也能跑');
  // 顺序 = build.js 的 INLINE 依赖顺序。core/quiz.js 必须排在 core/exams.js **之前**
  // —— exams.js 依赖 QuizCore（锁定/解锁要用 lockConfig）。
  const ORDER = ['core/parse/zip.js', 'core/parse/docx.js', 'core/parse/text.js', 'core/parse/segment.js',
                 'parser-core.js', 'core/schema.js', 'core/data.js', 'core/quiz.js',
                 'core/exams.js', 'core/text-format.js'];
  const sandbox = { self: {}, console: { log: function () {}, warn: function () {} }, Math, Date, JSON,
                    String, Number, Array, Object, RegExp, Error, TypeError, Set, Map, isFinite, parseInt, parseFloat,
                    TextDecoder: global.TextDecoder, Buffer: global.Buffer };
  sandbox.self = sandbox;                     // 浏览器里 self === window
  sandbox.window = sandbox;
  let sandboxErr = null;
  try {
    const ctx = vm.createContext(sandbox);
    ORDER.forEach(function (f) {
      const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      vm.runInContext(code, ctx, { filename: f });
    });
  } catch (e) { sandboxErr = e; }
  ok(!sandboxErr, '按内联顺序加载 ' + ORDER.length + ' 个文件不抛依赖缺失', sandboxErr && sandboxErr.message);
  ok(sandbox.TextFormatCore && typeof sandbox.TextFormatCore.exportExam === 'function',
     '浏览器侧挂的是 window.TextFormatCore');
  if (sandbox.TextFormatCore) {
    const t = sandbox.TextFormatCore.exportExam(mkExam('沙箱卷', [{ type: '判断', stem: '甲？（　）', answer: '对', difficulty: 5 }]));
    const b = sandbox.TextFormatCore.importExam(t);
    ok(b.ok && b.exam.questions[0].difficulty === 5, '沙箱里导出→导入可用（同一份代码两种环境都跑）', t.length + ' 字符');
  }

  /* ============================================================
   * ① 往返：逐字段无差异（盘档标准 1）
   * ============================================================ */
  head('①-A 全覆盖卷：整卷 JSON.stringify 逐字段相同');
  const examA = fullExam();
  const textA = TF.exportExam(examA);
  const backA = TF.importExam(textA);
  ok(backA.ok, '导出后再导入成功', backA.ok ? '' : brief(backA.errors));
  eq(backA.ok && JSON.stringify(backA.exam), JSON.stringify(examA),
     '**整个 Exam 对象逐字段无差异**（id/schemaVersion/title/createdAt/updatedAt/config/configLocked/questions）');
  if (backA.ok) {
    eq(backA.exam.questions.length, examA.questions.length, '题数一致');
    eq(backA.exam.id, examA.id, '  卷 id 还原');
    eq(backA.exam.createdAt, examA.createdAt, '  createdAt 原样还原（默认不 touch）');
    eq(backA.exam.updatedAt, examA.updatedAt, '  updatedAt 原样还原');
    eq(backA.exam.configLocked, true, '  configLocked=true 还原');
    eq(backA.exam.config.points['多选'], 3, '  嵌套 config 还原');
    eq(backA.exam.config.s, examA.config.s, '  含引号与反斜杠的 config 字符串还原');
    eq(backA.exam.config.nested.deep, [1, 2, { x: 'y' }], '  深层嵌套 config 还原');
    // 每题 12 个字段（完整值比较，只有显示截断）
    examA.questions.forEach(function (q, i) {
      eq(qDigest(backA.exam.questions[i]), qDigest(q),
         '  第 ' + (i + 1) + ' 题 12 字段（' + q.type + '）无差异');
    });
    ok(backA.warnings.length === 0, '  合法文本不产生告警', JSON.stringify(backA.warnings));
    // 分隔符类字符不能把内容切坏（题书点名的三种：题干多行、选项含 . ：、关键词含 |）
    const byId = id => backA.exam.questions.filter(q => q.id === id)[0];
    eq(byId('q_k1').keywords.map(k => k.text), ['手工甲', '手工乙', '样式丙', 'A|B 竖线'],
       '  关键词文本里的「|」不被当成分隔符（靠 [来源] 前缀定界，不靠竖线）');
    eq(byId('q_e1').options.map(o => o.text), ['甲. 含点|竖线', '乙：含冒号=等号'],
       '  选项文本里的「.」「：」「|」「=」原样保留（标签只认行首那一个）');
  }
  eq(TF.exportExam(backA.exam), textA, '两遍法：export→import→export **逐字节相同**');

  head('①-B 单题细分：判断三态 / 选择题字母 / 难度 / inTextBox');
  const j1 = mkExam('判断-有答案', [{ id: 'j1', type: '判断', stem: '地球是圆的？（　）', answer: '对', difficulty: 2, inTextBox: true }]);
  const j2 = mkExam('判断-无答案', [{ id: 'j2', type: '判断', stem: '没有答案的判断题？（　）', answer: '' }]);
  const j3 = mkExam('判断-歧义', [{ id: 'j3', type: '判断', stem: '歧义判断题？（　）', answer: '待定' }]);
  [[j1, '有答案'], [j2, '无答案'], [j3, '歧义答案(待定)']].forEach(function (c) {
    const t = TF.exportExam(c[0]);
    const b = TF.importExam(t);
    ok(b.ok, '判断-' + c[1] + ' 往返成功', b.ok ? '' : brief(b.errors));
    if (b.ok) {
      eq(JSON.stringify(b.exam), JSON.stringify(c[0]), '  整卷无差异（判断-' + c[1] + '）');
      eq(qDigest(b.exam.questions[0]), qDigest(c[0].questions[0]), '  12 字段无差异（判断-' + c[1] + '）');
    }
  });
  eq(backA.ok ? backA.exam.questions[2].judgeValue : null, true, '判断-有答案：judgeValue=true 由 answer 重算');
  eq(backA.ok ? backA.exam.questions[3].judgeValue : 'x', null, '判断-无答案：judgeValue=null');
  eq(backA.ok ? backA.exam.questions[4].judgeValue : 'x', null, '判断-歧义「待定」：judgeValue=null（不猜）');
  ok(backA.ok && backA.exam.questions[4].review.join().indexOf('待定') >= 0,
     '  歧义答案的待校对提示也在（往返后仍标记需人工核对）',
     backA.ok ? JSON.stringify(backA.exam.questions[4].review) : '');
  eq(backA.ok ? backA.exam.questions[0].answerLetters : 'x', ['B'], '单选：answerLetters=[B] 由 answer 重算');
  eq(backA.ok ? backA.exam.questions[1].answerLetters : 'x', ['A', 'B', 'D'], '多选：answerLetters=[A,B,D] 多字母');
  eq(backA.ok ? backA.exam.questions[0].difficulty : 'x', 3, 'difficulty=3 还原');
  eq(backA.ok ? backA.exam.questions[2].difficulty : 'x', 1, 'difficulty=1 还原');
  eq(backA.ok ? backA.exam.questions[4].difficulty : 'x', null, 'difficulty=null 还原');
  eq(backA.ok ? backA.exam.questions[0].inTextBox : 'x', true, 'inTextBox=true 还原');
  eq(backA.ok ? backA.exam.questions[1].inTextBox : 'x', false, 'inTextBox=false 还原');

  head('①-C 简答关键词：自动生成 / 手工 / 原文样式，via 逐条还原');
  const k1 = mkExam('关键词三态', [
    { id: 'ka', type: '简答', stem: '手工关键词题？', answer: '参考答案；含分号', keywords: [{ text: '手工甲', via: '手动' }, { text: '样式乙', via: '加粗' }] },
    { id: 'kb', type: '简答', stem: '自动关键词题？', answer: '客户端发送 SYN；服务器回复 SYN+ACK；客户端再发送 ACK 确认。' },
    { id: 'kc', type: '简答', stem: '长答案切不出关键词？', answer: '这是一个超过十八个字符的非常长的参考答案内容描述' }
  ]);
  const backK = TF.importExam(TF.exportExam(k1));
  ok(backK.ok, '关键词三态往返成功', backK.ok ? '' : brief(backK.errors));
  if (backK.ok) {
    eq(JSON.stringify(backK.exam), JSON.stringify(k1), '整卷无差异（关键词三态）');
    eq(backK.exam.questions[0].keywords.map(k => k.text + '|' + k.via),
       ['手工甲|手动', '样式乙|加粗'], '手工 + 原文样式关键词的 text 与 via 都还原');
    eq(backK.exam.questions[1].keywords.map(k => k.via),
       ['自动(需校对)', '自动(需校对)', '自动(需校对)'], '自动生成关键词的来源仍是「自动(需校对)」');
    ok(backK.exam.questions[1].review.some(s => s.indexOf('自动生成') >= 0 && s.indexOf('需校对') >= 0),
       '  自动关键词必带「需校对」提示（不许伪装成人工结果）', JSON.stringify(backK.exam.questions[1].review));
    eq(backK.exam.questions[2].keywords, [], '切不出关键词时 keywords 保持 []（不是 null）');
    ok(backK.exam.questions[2].review.some(s => s.indexOf('切不出采分关键词') >= 0),
       '  相应提示保留', JSON.stringify(backK.exam.questions[2].review));
  }

  head('①-D 形状保真：null（不适用）与 []（适用但为空）不能混');
  const shapeExam = mkExam('形状卷', [
    { id: 's1', type: '单选', stem: '选择题？', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answer: 'A' },
    { id: 's2', type: '判断', stem: '判断题？（　）', answer: '对' },
    { id: 's3', type: '简答', stem: '简答题？', answer: '甲；乙' }
  ]);
  const backS = TF.importExam(TF.exportExam(shapeExam));
  ok(backS.ok, '形状卷往返成功', backS.ok ? '' : brief(backS.errors));
  if (backS.ok) {
    eq(JSON.stringify(backS.exam), JSON.stringify(shapeExam), '整卷无差异（形状卷）');
    eq([backS.exam.questions[0].options === null, backS.exam.questions[0].keywords],
       [false, null], '选择题：options 是数组、keywords=null（非简答不适用）');
    eq([backS.exam.questions[0].judgeValue, backS.exam.questions[0].answerLetters],
       [null, ['A']], '选择题：judgeValue=null、answerLetters 由答案重算');
    eq([backS.exam.questions[1].options, backS.exam.questions[1].answerLetters, backS.exam.questions[1].keywords],
       [null, null, null], '判断题：options/answerLetters/keywords 全是 null');
    eq([backS.exam.questions[2].options, backS.exam.questions[2].answerLetters, backS.exam.questions[2].judgeValue],
       [null, null, null], '简答题：options/answerLetters/judgeValue 全是 null');
  }
  // 文本里显式声明 [] / null 时以声明为准（手写文本与历史数据能表达两种形状）
  const textShape = [
    TF.HEADER, 'title: 显式形状', 'questions: 1', '',
    '## 第 1 题', 'type: 单选', 'stem: 手写选择题？', 'options: []', 'answer: A', 'keywords: []',
    'review: []', 'inTextBox: false', 'difficulty: null'
  ].join('\n') + '\n';
  const rShape = TF.importExam(textShape);
  ok(rShape.ok, '显式 options: [] / keywords: [] 的文本能被导入', rShape.ok ? '' : brief(rShape.errors));
  if (rShape.ok) {
    eq([rShape.exam.questions[0].options, rShape.exam.questions[0].keywords], [[], []],
       '显式 [] 不会被工厂归一成 null（形状声明被尊重）');
    ok(rShape.warnings.some(w => w.code === 'W_FEW_OPTIONS'), '  0 个选项给告警而不是静默',
       JSON.stringify(rShape.warnings.map(w => w.code)));
  }
  const textShape2 = textShape.replace('options: []', 'options: null');
  const rShape2 = TF.importExam(textShape2);
  eq(rShape2.ok && rShape2.exam.questions[0].options, null, '显式 options: null 就是 null');

  head('①-E review 保真：派生文案重算、模块手写文案不丢');
  const rvExam = mkExam('review 卷', [
    { id: 'r1', type: '单选', stem: '题目？', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answer: 'A',
      review: ['题型为自动识别，请确认'] },
    { id: 'r2', type: '判断', stem: '题目？（　）', answer: '待定' },
    { id: 'r3', type: '简答', stem: '题目？', answer: '甲；乙' }
  ]);
  const backR = TF.importExam(TF.exportExam(rvExam));
  ok(backR.ok, 'review 卷往返成功', backR.ok ? '' : brief(backR.errors));
  if (backR.ok) {
    eq(JSON.stringify(backR.exam), JSON.stringify(rvExam), '整卷无差异（含手写 review 文案）');
    eq(backR.exam.questions[0].review, ['题型为自动识别，请确认'],
       '模块手写的 review（不是 applyDerived 派生的）往返后仍在');
    eq(backR.exam.questions[1].review, rvExam.questions[1].review, '派生 review 重算后一致');
  }
  // 手改答案 → 旧派生提示必须消失（派生字段跟着重算）
  const edited = TF.exportExam(rvExam).replace('answer: 待定', 'answer: 对');
  const backE2 = TF.importExam(edited);
  ok(backE2.ok, '把「待定」改成「对」后能导入', backE2.ok ? '' : brief(backE2.errors));
  if (backE2.ok) {
    eq(backE2.exam.questions[1].judgeValue, true, '改答案后 judgeValue 跟着变真');
    eq(backE2.exam.questions[1].review, [], '  旧的「无法识别」待校对提示**没有残留**');
    eq(backE2.exam.questions[0].review, ['题型为自动识别，请确认'], '  别的手写 review 不受影响');
  }

  head('①-F 手工编辑生效：题干/答案/难度/关键词改完重新导入即生效');
  let e3 = TF.exportExam(examA);
  e3 = editLine(e3, 'difficulty: 3', 'difficulty: 5');
  e3 = editLine(e3, 'answer: B', 'answer: A');
  e3 = editLine(e3, 'stem: 下列哪个协议工作在传输层？', 'stem: 改过的题干（手工编辑）');
  e3 = dropLine(e3, '  |[手动] 手工甲');
  const backE3 = TF.importExam(e3);
  ok(backE3.ok, '手工编辑后的文本能导入', backE3.ok ? '' : brief(backE3.errors));
  if (backE3.ok) {
    eq(backE3.exam.questions[0].difficulty, 5, '难度改动生效');
    eq(backE3.exam.questions[0].stem, '改过的题干（手工编辑）', '题干改动生效');
    eq(backE3.exam.questions[0].answer, 'A', '答案改动生效');
    eq(backE3.exam.questions[0].answerLetters, ['A'], '  派生答案字母跟着重算');
    eq(backE3.exam.questions[5].keywords.map(k => k.text), ['手工乙', '样式丙', 'A|B 竖线'], '关键词删掉一条后生效');

    // 改题干 > 多选题答案 也要跟着派生（多选只留声明的字母）
    let e4 = TF.exportExam(examA);
    e4 = editLine(e4, 'answer: ABD', 'answer: CD');
    const backE4 = TF.importExam(e4);
    eq(backE4.ok && backE4.exam.questions[1].answerLetters, ['C', 'D'], '多选答案改动后 answerLetters 重算');
    // 单选题答案写两个字母 → 只取第一个（与 applyDerived 同一规则）
    let e5 = TF.exportExam(examA);
    e5 = editLine(e5, 'answer: B', 'answer: BA');
    const backE5 = TF.importExam(e5);
    eq(backE5.ok && backE5.exam.questions[0].answerLetters, ['B'], '单选题答案写了两个字母时只取第一个');
  }

  head('①-G 承重顺序回归：先 applyDerived、后 createQuestion（顺序颠倒就 null→[]）');
  const orderRaw = { type: '单选', stem: '顺序检查？', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answer: 'A' };
  const rightOrder = (function () { const q = JSON.parse(JSON.stringify(orderRaw)); Seg.applyDerived(q); return S.createQuestion(q); })();
  const wrongOrder = (function () { const q = S.createQuestion(orderRaw); Seg.applyDerived(q); return q; })();
  eq(rightOrder.keywords, null, '先派生后工厂：选择题 keywords=null（工厂把不适用字段归一到 null）');
  eq(wrongOrder.keywords, [], '对照：先工厂后派生会把 null 改回 []（这就是不能颠倒的原因）');
  const orderBack = TF.importExam(TF.exportExam(mkExam('顺序卷', [orderRaw])));
  eq(orderBack.ok && orderBack.exam.questions[0].keywords, null, '本模块导入后 keywords=null（与工厂形状一致，不是 []）');
  eq(orderBack.ok && orderBack.exam.questions[0].options === null, false, '  选择题 options 仍是数组');

  head('①-H 空卷 / 单题 / 多题（≥5 题，题干含多行、emoji、中文标点）');
  const emptyExam = mkExam('空卷', [], { now: '2026-09-17T09:15:00.000Z' });
  const backEmpty = TF.importExam(TF.exportExam(emptyExam));
  ok(backEmpty.ok, '空卷（0 题）能往返', backEmpty.ok ? '' : brief(backEmpty.errors));
  eq(backEmpty.ok && JSON.stringify(backEmpty.exam), JSON.stringify(emptyExam), '  空卷逐字段还原（questions=[]）');
  const oneExam = mkExam('单题卷', [{ id: 'one', type: '判断', stem: '单题？（　）', answer: '错', difficulty: 5, inTextBox: true }]);
  const backOne = TF.importExam(TF.exportExam(oneExam));
  eq(backOne.ok && JSON.stringify(backOne.exam), JSON.stringify(oneExam), '单题卷逐字段还原');
  eq(backA.ok && backA.exam.questions.length >= 5, true, '多题卷（' + examA.questions.length + ' 题）逐字段还原见 ①-A');
  eq(backA.ok && backA.exam.questions[5].stem.split('\n').length, 3, '多行题干仍是 3 行');
  ok(backA.ok && backA.exam.questions[5].stem.indexOf('🙂') >= 0, '题干里的 emoji 完好',
     backA.ok ? backA.exam.questions[5].stem : '');

  head('①-I config 为 null / 非 null、configLocked 两种');
  const cfgNull = mkExam('config=null 卷', [{ type: '判断', stem: '甲？（　）', answer: '对' }]);
  const backCfgNull = TF.importExam(TF.exportExam(cfgNull));
  eq(backCfgNull.ok && JSON.stringify(backCfgNull.exam), JSON.stringify(cfgNull), 'config=null 整卷还原');
  const cfgLock = mkExam('configLocked=false 卷', [{ type: '判断', stem: '甲？（　）', answer: '对' }], { config: { a: 1 }, configLocked: false });
  const backCfgLock = TF.importExam(TF.exportExam(cfgLock));
  eq(backCfgLock.ok && JSON.stringify(backCfgLock.exam), JSON.stringify(cfgLock), 'configLocked=false 整卷还原');

  head('①-J newIds / touch / title 三个选项语义');
  const copy = TF.importExam(textA, { newIds: true });
  ok(copy.ok, 'newIds:true 导入成功');
  if (copy.ok) {
    ok(copy.exam.id !== examA.id, '卷 id 重新分配', copy.exam.id);
    eq(copy.exam.questions.filter(q => examA.questions.some(o => o.id === q.id)), [], '题目 id 全部重新分配');
    eq(new Set(copy.exam.questions.map(q => q.id)).size, examA.questions.length, '新题目 id 互不重复');
    eq(copy.exam.createdAt, examA.createdAt, '  默认不动 createdAt');
    eq(copy.exam.updatedAt, examA.updatedAt, '  默认不动 updatedAt');
  }
  const touched = TF.importExam(textA, { touch: true, now: '2030-01-01T00:00:00.000Z' });
  eq(touched.ok && touched.exam.updatedAt, '2030-01-01T00:00:00.000Z', 'touch:true → updatedAt 置为当前时间');
  eq(touched.ok && touched.exam.createdAt, examA.createdAt, '  createdAt 不受 touch 影响');
  const retitled = TF.importExam(textA, { title: '换标题' });
  eq(retitled.ok && retitled.exam.title, '换标题', 'title 选项覆盖标题');
  eq(retitled.ok && retitled.exam.questions.length, examA.questions.length, '  题目不受影响');

  /* ============================================================
   * ② 可读性与文本级幂等
   * ============================================================ */
  head('②-A 导出文本里"人看得见"的字段确实出现');
  ok(textA.indexOf(TF.HEADER) === 0, '第一行就是格式头', JSON.stringify(textA.split('\n')[0]));
  ok(textA.indexOf('title: ' + FULL_TITLE) >= 0, '  看得到标题');
  ok(textA.indexOf('type: 单选') >= 0 && textA.indexOf('type: 多选') >= 0 &&
     textA.indexOf('type: 判断') >= 0 && textA.indexOf('type: 简答') >= 0, '  看得到四种题型名');
  ok(textA.indexOf('stem: 下列哪个协议工作在传输层？') >= 0, '  看得到题干');
  ok(textA.indexOf('  |A. HTTP') >= 0, '  看得到选项（含标签）');
  ok(textA.indexOf('answer: B') >= 0, '  看得到答案');
  ok(textA.indexOf('  |[手动] 手工甲') >= 0, '  看得到简答采分关键词与来源');
  ok(textA.indexOf('  |[高亮] 样式丙') >= 0, '  看得到原文样式来源（高亮）');
  ok(textA.indexOf('  |[底纹] A|B 竖线') >= 0, '  看得到文本里含「|」的关键词（可读且不歧义）');
  ok(textA.indexOf('  |A. 甲. 含点|竖线') >= 0, '  看得到含「.」「：」「|」的选项');
  ok(textA.indexOf('explanation: HTTP 是应用层；IP、ARP 属于网络层；TCP 位于传输层。') >= 0, '  看得到解析');
  ok(textA.indexOf('difficulty: 3') >= 0 && textA.indexOf('difficulty: null') >= 0, '  看得到难度（含 null）');
  ok(textA.indexOf('inTextBox: true') >= 0 && textA.indexOf('inTextBox: false') >= 0, '  看得到 inTextBox');
  ok(textA.indexOf('configLocked: true') >= 0, '  看得到 configLocked');
  ok(textA.indexOf('questions: ' + examA.questions.length) >= 0, '  看得到题数声明（完整性校验）');
  ok(textA.indexOf('  |第二行题干 🙂') >= 0, '  多行题干在文本里也是多行（块写法）');
  ok(textA.indexOf('  |解析第二行') >= 0, '  多行解析同样是多行');
  const cfgLine = textA.split('\n').filter(l => l.indexOf('config: ') === 0)[0] || '';
  ok(cfgLine.indexOf('config: {"points":{"单选":2') === 0,
     'config 是**标准 JSON**、中文键保持字面量（人能直接手改分值配置）', cfgLine);
  eq(cfgLine.slice('config: '.length), JSON.stringify(examA.config),
     '  config 行就是 JSON.stringify 的结果（除 < 与 U+2028/9 的安全转义外不做加工）');
  ok(textA.indexOf('config: ') > textA.lastIndexOf('## 第'), '  config 段在所有题块之后（卷尾，不与正文抢第一处题型词）');
  eq(textA.indexOf('config: '), textA.lastIndexOf('config: '), '  config 只出现一次（卷头不重复）');
  eq(textA.indexOf('单选'), textA.indexOf('type: 单选') + 6,
     '正文里第一处「单选」正好在真题型行上（替换式破坏/检索落到真实题目，不会落到 config 的键里）');
  eq(textA.split('\n')[0].indexOf('1'), textA.split('\n')[0].indexOf('v1') + 1, '头里第一处「1」就是版本号（版本位可被精确定位）');
  const cfgLt = mkExam('安全转义卷', [{ type: '判断', stem: '甲？（　）', answer: '对' }],
                       { config: { html: '</script><b>', sep: 'a\u2028b' } });
  const ltText = TF.exportExam(cfgLt);
  ok(ltText.indexOf('</script>') < 0, 'config 里的 </script 被写成 \\u003c（内联进 <script> 不会被提前闭合）');
  eq(TF.importExam(ltText).ok && JSON.stringify(TF.importExam(ltText).exam), JSON.stringify(cfgLt),
     '  安全转义不影响往返（JSON.parse 原样还原）');
  const cfgTop = textA.replace('\nconfig: ', '\ntitle: 重复标题\nconfig: ');
  eq(TF.importExam(cfgTop).ok, false, '整卷字段重复出现（此处故意重复 title）→ 拒绝');

  head('②-B 两遍法：export→import→export 逐字节相同（空卷/单题/全覆盖/形状卷）');
  [[emptyExam, '空卷'], [oneExam, '单题卷'], [examA, '全覆盖卷'], [shapeExam, '形状卷'], [k1, '关键词三态卷']].forEach(function (c) {
    const t1 = TF.exportExam(c[0]);
    const b = TF.importExam(t1);
    const t2 = b.ok ? TF.exportExam(b.exam) : null;
    ok(b.ok && t2 === t1, c[1] + '：第二次导出与第一次逐字节相同', b.ok ? (t1.length + ' vs ' + (t2 || '').length) : brief(b.errors));
  });

  head('②-C includeDerivedComments：派生注释只给人看，导入时忽略');
  eq(TF.exportExam(examA).indexOf('# 派生字段'), -1, '默认不写派生注释（正文保持干净）');
  const cmt = TF.exportExam(examA, { includeDerivedComments: true });
  ok(cmt.indexOf('# 派生字段（导入时自动重算，不必手改）：answerLetters=["B"]') >= 0,
     'opts.includeDerivedComments=true 时写出派生字段快照', cmt.split('\n').filter(l => l.indexOf('# 派生字段') === 0)[0]);
  const backCmt = TF.importExam(cmt);
  eq(backCmt.ok && JSON.stringify(backCmt.exam), JSON.stringify(examA),
     '  带注释的文本仍逐字段还原（注释不参与解析）');
  const badCmt = cmt.split('\n').map(l => (l.indexOf('# 派生字段') === 0 ? '# 这行随便写点什么' : l)).join('\n');
  eq(TF.importExam(badCmt).ok, true, '  手改/删掉注释不影响导入（注释行被忽略）');

  head('②-D BOM 与行尾空白：容错，但不许吃掉内容里的行尾空白');
  const baseA = TF.importExam(textA).exam;
  const bomText = '\uFEFF' + textA;
  const backBom = TF.importExam(bomText);
  eq([backBom.ok, backBom.ok && JSON.stringify(backBom.exam)], [true, JSON.stringify(examA)],
     '文件开头带 UTF-8 BOM（记事本默认）→ 导入成功且逐字段一致');
  eq(JSON.stringify(TF.importExam(bomText).exam), JSON.stringify(baseA), '  带 BOM 与不带 BOM 的结果逐字段相同');
  eq([TF.diagnose(bomText).ok, TF.diagnose(bomText).questionCount, TF.diagnose(bomText).title],
     [true, examA.questions.length, FULL_TITLE], 'diagnose 也能吃带 BOM 的文本，题数/标题仍然对');
  eq(firstErr(TF.importExam('\uFEFF\uFEFF' + textA)).code, 'E_NO_HEADER',
     '只剥**开头一个** BOM（第二个属于内容，仍报头不对）');
  eq(firstErr(TF.importExam('\uFEFF')).code, 'E_EMPTY', '只有 BOM 的文本 → E_EMPTY');
  eq(TF.diagnose('\uFEFF').ok, TF.importExam('\uFEFF').ok, '  BOM-only 上 diagnose 与 importExam 结论一致');

  [['每行尾部加 3 个空格', t => t.split('\n').map(l => l + '   ').join('\n')],
   ['只给空值行加尾随空格', t => t.split('\n').map(l => (/:\s*$/.test(l) ? l + '   ' : l)).join('\n')],
   ['只给有值行加尾随空格', t => t.split('\n').map(l => (/:\s+\S/.test(l) ? l + '   ' : l)).join('\n')],
   ['`|` 列表项行加尾随空格', t => t.split('\n').map(l => (/^\s*\|/.test(l) ? l + '  ' : l)).join('\n')],
   ['记事本全家桶：BOM + CRLF + 行尾空格', t => '\uFEFF' + t.split('\n').map(l => l + '   ').join('\r\n')],
   ['去掉文件末尾的换行', t => t.replace(/\n$/, '')]
  ].forEach(function (c) {
    const dirty = c[1](textA);
    const r = TF.importExam(dirty);
    eq([r.ok, r.ok && JSON.stringify(r.exam)], [true, JSON.stringify(baseA)],
       '「' + c[0] + '」→ 导入成功，且逐字段与干净文本一致');
    eq(TF.diagnose(dirty).ok, true, '  diagnose 同样容错（' + c[0] + '）');
  });

  const twExam = mkExam('行尾空白卷', [
    { id: 'tw1', type: '单选', stem: '题干结尾有一个空格 ',
      options: [{ label: 'A', text: '选项尾有制表\t' }, { label: 'B', text: '选项尾有空格 ' }], answer: 'B' },
    { id: 'tw2', type: '简答', stem: '第一行尾有空格 \n第二行', answer: '甲；乙',
      explanation: '解析第一行\n解析尾有空格 ', difficulty: 3 },
    { id: 'tw3', type: '判断', stem: '判断？（　）', answer: '对', review: ['手写提示尾空格 '] }
  ]);
  const twText = TF.exportExam(twExam);
  ok(twText.indexOf('stem: 题干结尾有一个空格\\s') >= 0,
     '内容自带的行尾空格在导出时被转义成 \\s（与手抖多敲的空格区分开）',
     twText.split('\n').filter(l => l.indexOf('stem: 题干结尾') === 0)[0]);
  ok(twText.indexOf('  |A. 选项尾有制表\\t') >= 0, '  选项行尾的制表符被转义成 \\t',
     twText.split('\n').filter(l => l.indexOf('选项尾有制表') >= 0)[0]);
  ok(twText.indexOf('  |解析尾有空格\\s') >= 0, '  解析块行尾的空格也被转义',
     twText.split('\n').filter(l => l.indexOf('解析尾有空格') >= 0)[0]);
  const backTw = TF.importExam(twText);
  eq(backTw.ok && JSON.stringify(backTw.exam), JSON.stringify(twExam),
     '**内容自带的行尾空白不被容错吃掉**（整卷逐字段仍相同）');
  eq(backTw.ok && backTw.exam.questions[0].stem, '题干结尾有一个空格 ', '  stem 的行尾空格保留');
  eq(backTw.ok && backTw.exam.questions[0].options[0].text, '选项尾有制表\t', '  选项文本的行尾制表保留');
  eq(backTw.ok && backTw.exam.questions[2].review[0], '手写提示尾空格 ', '  review 条目的行尾空格保留');
  eq(TF.exportExam(backTw.exam), twText, '  含行尾转义的文本，两遍法仍逐字节相同');

  /* ============================================================
   * ③ 损坏文本：拒绝 + 可定位（盘档标准 2）
   * ============================================================ */
  head('③-A E_EMPTY / E_NO_HEADER：说不清在哪一行时给出明确原因');
  [['空文本', ''], ['全是空白', '   \n\n  \n']].forEach(function (c) {
    const r = TF.importExam(c[1]);
    eq([r.ok, firstErr(r).code, firstErr(r).line], [false, 'E_EMPTY', 0], c[0] + ' → E_EMPTY，行号 0（空文本没有出错行）');
    ok(typeof firstErr(r).message === 'string' && firstErr(r).message.length > 3, '  message 可读', firstErr(r).message);
  });
  [['无关垃圾', '这不是试卷文件\n随便写点什么\n12345\n'], ['HTML 片段', '<html><body>hello</body></html>'],
   ['二进制乱码', '\u0000\u0001\u0002\u0003\uFFFD\uFFFD'], ['只有头没有内容', TF.HEADER + '\n']].forEach(function (c) {
    const r = TF.importExam(c[1]);
    eq(r.ok, false, c[0] + ' → 被拒绝');
    eq(firstErr(r).line, 1, '  行号指向第 1 行');
    ok(['E_NO_HEADER', 'E_NO_TITLE'].indexOf(firstErr(r).code) >= 0, '  错误码明确', firstErr(r).code);
  });

  head('③-B E_BAD_VERSION：版本号不认识 / 缺失');
  const badVer = textA.replace(String(TF.FORMAT_VERSION), '999999');
  ok(badVer !== textA, '自检：确实改掉了版本号');
  const rVer = TF.importExam(badVer);
  eq([rVer.ok, firstErr(rVer).code, firstErr(rVer).line], [false, 'E_BAD_VERSION', 1], '版本号改坏 → E_BAD_VERSION 第 1 行');
  ok(/版本|version/i.test(firstErr(rVer).code + ' ' + firstErr(rVer).message), '  信息指向版本问题', firstErr(rVer).message);
  const noVer = textA.replace('试卷文本格式 v1', '试卷文本格式 v');
  const rNoVer = TF.importExam(noVer);
  eq([rNoVer.ok, firstErr(rNoVer).code, firstErr(rNoVer).line], [false, 'E_BAD_VERSION', 1], '版本号缺失 → 同样 E_BAD_VERSION');
  const olderVer = textA.replace(' v1', ' v0');
  eq([TF.importExam(olderVer).ok, firstErr(TF.importExam(olderVer)).line], [false, 1], '比程序旧的版本 → 也拒绝并指向第 1 行');

  head('③-C E_NO_TITLE / E_UNKNOWN_TYPE：行号指到真正出问题的那一行');
  const noTitle = editLine(textA, 'title: ', 'title:');
  const rNoTitle = TF.importExam(noTitle);
  eq([rNoTitle.ok, firstErr(rNoTitle).code], [false, 'E_NO_TITLE'], '标题缺失 → E_NO_TITLE');
  eq(firstErr(rNoTitle).line, lineNoOf(textA, 'title: '), '  行号指向 title 行');
  const badTypeText = textA.replace('type: 单选', 'type: 填空题');
  const rType = TF.importExam(badTypeText);
  eq([rType.ok, firstErr(rType).code], [false, 'E_UNKNOWN_TYPE'], '未知题型 → E_UNKNOWN_TYPE');
  eq(firstErr(rType).line, lineNoOf(badTypeText, 'type: 填空题'), '  行号正是那一行');
  eq(badTypeText.split('\n')[firstErr(rType).line - 1], 'type: 填空题', '  该行原文就是「填空题」那行（可定位 = 能直接跳到那行）');
  ok(firstErr(rType).message.indexOf('填空题') >= 0, '  message 里带上了非法取值', firstErr(rType).message);
  ok(rType.errors.every(e => e.line >= 1 && e.line <= badTypeText.split('\n').length + 1), '  所有行号都在文本范围内',
     JSON.stringify(rType.errors.map(e => e.line)));

  head('③-D E_TRUNCATED：题数声明与截断（完整性校验）');
  const ls = textA.split('\n');
  const cut = ls.slice(0, Math.max(2, Math.floor(ls.length / 2))).join('\n');
  const rCut = TF.importExam(cut);
  eq([rCut.ok, firstErr(rCut).code], [false, 'E_TRUNCATED'], '中途截断 → E_TRUNCATED');
  eq(firstErr(rCut).line, lineNoOf(textA, 'questions: '), '  行号指向题数声明行（这就是它的用途）');
  const countBad = textA.replace('questions: ' + examA.questions.length, 'questions: ' + (examA.questions.length + 2));
  const rCount = TF.importExam(countBad);
  eq([rCount.ok, firstErr(rCount).code], [false, 'E_TRUNCATED'], '题数与实际不符 → E_TRUNCATED');
  ok(firstErr(rCount).message.indexOf('声明') >= 0 && firstErr(rCount).message.indexOf('实际') >= 0, '  message 说清了声明值与实际值', firstErr(rCount).message);

  head('③-E E_BAD_CONFIG / E_BAD_DIFFICULTY / E_BAD_KEYWORD / E_BAD_ESCAPE');
  const badCfg = editLine(textA, 'config: ', 'config: {oops');
  const rCfg = TF.importExam(badCfg);
  eq([rCfg.ok, errByCode(rCfg, 'E_BAD_CONFIG').code, errByCode(rCfg, 'E_BAD_CONFIG').line],
     [false, 'E_BAD_CONFIG', lineNoOf(textA, 'config: ')], 'config 不是合法 JSON → E_BAD_CONFIG，行号指向 config 行');
  const rCfg2 = TF.importExam(editLine(textA, 'config: ', 'config: "字符串"'));
  eq([rCfg2.ok, errByCode(rCfg2, 'E_BAD_CONFIG').code], [false, 'E_BAD_CONFIG'], 'config 是标量 → 也拒绝（结构要求对象或 null）');
  const badDiff = editLine(textA, 'difficulty: 3', 'difficulty: 9');
  const rDiff = TF.importExam(badDiff);
  eq([rDiff.ok, firstErr(rDiff).code, firstErr(rDiff).line], [false, 'E_BAD_DIFFICULTY', lineNoOf(textA, 'difficulty: 3')],
     '难度 9 → E_BAD_DIFFICULTY 且指向难度行');
  const rDiff2 = TF.importExam(editLine(textA, 'difficulty: 3', 'difficulty: 高'));
  eq([rDiff2.ok, errByCode(rDiff2, 'E_BAD_DIFFICULTY').line], [false, lineNoOf(textA, 'difficulty: 3')], '难度写「高」→ 同样可定位');
  const badKw = editLine(textA, '|[手动] 手工甲', '  |[粗体] 手工甲');
  const rKw = TF.importExam(badKw);
  eq([rKw.ok, errByCode(rKw, 'E_BAD_KEYWORD').code, errByCode(rKw, 'E_BAD_KEYWORD').line],
     [false, 'E_BAD_KEYWORD', lineNoOf(textA, '手工甲')], '关键词来源非法 → E_BAD_KEYWORD 且指向该关键词行');
  ok(errByCode(rKw, 'E_BAD_KEYWORD').message.indexOf('粗体') >= 0, '  message 带上非法来源', errByCode(rKw, 'E_BAD_KEYWORD').message);
  const rKw2 = TF.importExam(textA.replace('  |[手动] 手工甲', '  |手工甲'));
  eq([rKw2.ok, firstErr(rKw2).code], [false, 'E_BAD_KEYWORD'], '关键词缺来源标注 → E_BAD_KEYWORD');
  const badEsc = editLine(textA, 'stem: 下列哪个协议工作在传输层？', 'stem: 甲\\q乙');
  const rEsc = TF.importExam(badEsc);
  eq([rEsc.ok, firstErr(rEsc).code, firstErr(rEsc).line], [false, 'E_BAD_ESCAPE', lineNoOf(textA, 'stem: 下列哪个')],
     '非法转义 \\q → E_BAD_ESCAPE 且指向该字段行');
  // 转义规则的正面用例：反斜杠必须成对，换行用 \n
  const escExam = mkExam('转义卷', [{ id: 'e1', type: '判断', stem: '路径 C:\\temp 与制表\t符号', answer: '对' }]);
  const escText = TF.exportExam(escExam);
  ok(escText.indexOf('stem: 路径 C:\\\\temp') >= 0, '导出时反斜杠被写两次（\\\\）', escText.split('\n').filter(l => l.indexOf('stem:') === 0)[0]);
  const backEsc = TF.importExam(escText);
  eq(backEsc.ok && JSON.stringify(backEsc.exam), JSON.stringify(escExam), '含反斜杠/制表的题干无损往返');
  const nlInjected = TF.importExam(editLine(textA, 'stem: 下列哪个协议工作在传输层？', 'stem: 第一行\\n第二行'));
  eq(nlInjected.ok && nlInjected.exam.questions[0].stem, '第一行\n第二行', '行内 \\n 被还原成真换行（与 JSON 同一约定）');

  head('③-F E_BAD_STRUCTURE / E_FEW_OPTIONS / E_DUP_ID：结构损坏');
  const stray = textA.split('\n').slice(0, 12).concat(['!!!! 这里是一行乱七八糟的东西']).concat(textA.split('\n').slice(12)).join('\n');
  const rStray = TF.importExam(stray);
  eq([rStray.ok, errByCode(rStray, 'E_BAD_STRUCTURE').line], [false, 13], '不认识的行 → E_BAD_STRUCTURE 且指向该行');
  ok(errByCode(rStray, 'E_BAD_STRUCTURE').message.indexOf('!!!!') >= 0, '  message 里带上了该行内容',
     errByCode(rStray, 'E_BAD_STRUCTURE').message);
  const unknownField = editLine(textA, 'answer: B', 'answer: B\nnonsense: 1');
  const rUF = TF.importExam(unknownField);
  eq([rUF.ok, firstErr(rUF).code], [false, 'E_BAD_STRUCTURE'], '题块里出现不认识的字段 → 拒绝');
  ok(firstErr(rUF).message.indexOf('nonsense') >= 0, '  message 点名该字段', firstErr(rUF).message);
  const dupField = editLine(textA, 'answer: B', 'answer: B\nanswer: C');
  eq([TF.importExam(dupField).ok, firstErr(TF.importExam(dupField)).code], [false, 'E_BAD_STRUCTURE'], '同一字段重复出现 → 拒绝');
  const noStem = dropLine(textA, 'stem: 下列哪个协议工作在传输层？');
  const rNoStem = TF.importExam(noStem);
  eq([rNoStem.ok, errByCode(rNoStem, 'E_BAD_STRUCTURE').code], [false, 'E_BAD_STRUCTURE'], '缺 stem（缺字段）→ 拒绝');
  const emptyStem = editLine(textA, 'stem: 下列哪个协议工作在传输层？', 'stem:');
  eq([TF.importExam(emptyStem).ok, firstErr(TF.importExam(emptyStem)).code], [false, 'E_BAD_STRUCTURE'], '题干为空 → 拒绝');
  const noOpts = dropFieldBlock(textA, 'options:');
  const rNoOpts = TF.importExam(noOpts);
  eq([rNoOpts.ok, errByCode(rNoOpts, 'E_FEW_OPTIONS').code], [false, 'E_FEW_OPTIONS'], '选择题整段没有 options → E_FEW_OPTIONS');
  ok(errByCode(rNoOpts, 'E_FEW_OPTIONS').line >= 1, '  带行号', String(errByCode(rNoOpts, 'E_FEW_OPTIONS').line));
  const dupId = editLine(textA, 'id: q_m1', 'id: q_s1');
  const rDupId = TF.importExam(dupId);
  eq([rDupId.ok, errByCode(rDupId, 'E_DUP_ID').code, errByCode(rDupId, 'E_DUP_ID').line],
     [false, 'E_DUP_ID', lineNoOf(textA, 'id: q_m1')], '题目 id 重复 → E_DUP_ID 且指向重复的那一行');
  const badDecl = editLine(textA, 'answer: B', 'answer: B\noptions: ABC');
  const rBadDecl = TF.importExam(badDecl);
  eq([rBadDecl.ok, errByCode(rBadDecl, 'E_BAD_STRUCTURE').code], [false, 'E_BAD_STRUCTURE'], 'options 写成一串非列表内容 → 拒绝');
  const rShapeNull = TF.importExam(textShape.replace('review: []', 'review: null'));
  eq([rShapeNull.ok, firstErr(rShapeNull).code], [false, 'E_BAD_STRUCTURE'], 'review: null → 拒绝（本结构里 review 恒为数组）');
  eq(TF.importExam(editLine(textShape, 'inTextBox: false', 'inTextBox: 也许')).ok, false, 'inTextBox 非布尔 → 拒绝');

  head('③-G strict 模式：解析器可产出的语义问题可升级成错误（默认只告警）');
  const rStrict = TF.importExam(textShape, { strict: true });
  eq([rStrict.ok, errByCode(rStrict, 'E_FEW_OPTIONS').code], [false, 'E_FEW_OPTIONS'], 'strict：选项少于 2 个 → E_FEW_OPTIONS');
  const dupOptText = editLine(textShape, 'options: []',
    'options:\n  |A. 甲\n  |A. 乙');
  const rDupOpt = TF.importExam(dupOptText);
  eq([rDupOpt.ok, rDupOpt.warnings.map(w => w.code)], [true, ['W_DUP_OPTION']], '默认：重复选项标签只告警');
  eq([TF.importExam(dupOptText, { strict: true }).ok, errByCode(TF.importExam(dupOptText, { strict: true }), 'E_DUP_OPTION').code],
     [false, 'E_DUP_OPTION'], 'strict：重复选项标签 → E_DUP_OPTION');
  const letterNotInOpts = editLine(textShape, 'answer: A', 'answer: D');
  const rLetter = TF.importExam(letterNotInOpts);
  eq([rLetter.ok, rLetter.warnings.map(w => w.code)], [true, ['W_FEW_OPTIONS', 'W_LETTER_NOT_IN_OPTIONS']],
     '默认：「答案字母不在选项里」只告警（解析器自己就会产出这种待校对题）');
  eq([TF.importExam(letterNotInOpts, { strict: true }).ok,
      errByCode(TF.importExam(letterNotInOpts, { strict: true }), 'E_BAD_ANSWER').code],
     [false, 'E_BAD_ANSWER'], 'strict：→ E_BAD_ANSWER');

  head('③-H 导入的失败形状：errors[{line,code,message,hint}] + summary');
  eq(Object.keys(rType).sort(), ['errors', 'ok', 'summary'], '失败返回 ok/errors/summary 三个键');
  ok(typeof rType.summary === 'string' && rType.summary.indexOf('第一处') >= 0, 'summary 一句话说清第一处问题', rType.summary);
  ok(rType.errors.every(e => typeof e.line === 'number' && typeof e.code === 'string' &&
     typeof e.message === 'string' && typeof e.hint === 'string'), '每条错误都有 line/code/message/hint');
  eq(JSON.stringify(Object.keys(TF.importExam(textA)).sort()), JSON.stringify(['exam', 'lines', 'ok', 'warnings']),
     '成功返回 ok/exam/warnings/lines 四个键');
  eq(typeof TF.importExam(textA).lines, 'number', 'lines 是行数');

  /* ============================================================
   * ④ diagnose 与 importExam 结论一致
   * ============================================================ */
  head('④ diagnose：结论一致 + 报出版本/题数/标题');
  const dGood = TF.diagnose(textA);
  eq([dGood.ok, dGood.questionCount, dGood.title, dGood.formatVersion],
     [true, examA.questions.length, FULL_TITLE, TF.FORMAT_VERSION], 'diagnose(好文本) 报出 ok/题数/标题/版本');
  const dBad = TF.diagnose(badTypeText);
  eq([dBad.ok, dBad.errors.length > 0], [false, true], 'diagnose(坏文本).ok=false 且给出错误清单');
  [['好文本', textA], ['空文本', ''], ['垃圾', '这不是试卷\n'], ['截断', cut], ['未知题型', badTypeText],
   ['题数不符', countBad], ['config 坏', badCfg], ['难度坏', badDiff], ['转义坏', badEsc], ['只有头', TF.HEADER + '\n']].forEach(function (c) {
    eq(TF.diagnose(c[1]).ok, TF.importExam(c[1]).ok, 'diagnose 与 importExam 在「' + c[0] + '」上结论一致');
  });
  eq(TF.diagnose('').formatVersion, null, '说不出版本时 formatVersion=null（不编造）');

  /* ============================================================
   * ⑤ 入库：真实 store 上"失败零变化 / 成功必变化"
   * ============================================================ */
  head('⑤-A 失败导入：store 全量快照逐字节不变（盘档标准 3）');
  const W = world();
  const store = W.store();
  const seed = await E.createExam(store, { title: '已有的重要试卷', now: '2026-09-17T10:00:00.000Z' });
  ok(seed.ok, '先放一份已有试卷');
  await E.appendQuestions(store, seed.exam.id, P.parseText('【判断】地球是圆的？（　）\n答案：对\n').questions);
  await store.set('settings', { theme: 'dark', keep: '这是全局设置，任何导入都不该动它' });
  const before = await snapOf(store);
  const brokenList = [
    ['未知题型', badTypeText], ['空文本', ''], ['全是空白', '   \n'],
    ['垃圾文本', '这不是试卷文件\n随便写点什么\n'], ['版本号坏', badVer], ['截断', cut],
    ['题数不符', countBad], ['config 坏', badCfg], ['难度坏', badDiff], ['关键词来源坏', badKw],
    ['转义坏', badEsc], ['结构乱', stray], ['id 重复', dupId], ['选项段缺失', noOpts], ['只有头', TF.HEADER + '\n']
  ];
  for (const c of brokenList) {
    const r = await TF.importToLibrary(store, c[1], { now: '2026-09-17T10:05:00.000Z' });
    eq([r.ok, r.blocked === true], [false, true], '「' + c[0] + '」→ importToLibrary 失败且标记 blocked');
    eq(await snapOf(store), before, '  store 逐字节未变（' + c[0] + '）');
  }
  eq(await store.get('settings'), { theme: 'dark', keep: '这是全局设置，任何导入都不该动它' }, '全局设置原样');

  head('⑤-B 最后一道题坏掉 → 整卷不入库（不许写一半）');
  const lsA = textA.split('\n');
  const atDiff3 = lsA.findIndex(l => l.indexOf('difficulty: 3') >= 0);
  const half = lsA.slice();
  half[atDiff3] = 'difficulty: 99';
  const rHalf = await TF.importToLibrary(store, half.join('\n'), {});
  eq([rHalf.ok, firstErr(rHalf).code, firstErr(rHalf).line], [false, 'E_BAD_DIFFICULTY', atDiff3 + 1],
     '文本第 ' + (atDiff3 + 1) + ' 行坏 → 整卷拒绝，行号指到该行');
  eq(await snapOf(store), before, '  store 仍逐字节未变');

  head('⑤-C 通过格式层但过不了题库尺子的题：入库被拦，存储零变化（与 exams/review 同一把尺子）');
  const rGate = await TF.importToLibrary(store, textShape, {});
  eq([rGate.ok, rGate.blocked], [false, true], '0 个选项的选择题：格式层可表达（importExam 通过），入库被拦');
  eq(TF.importExam(textShape).ok, true, '  对照：importExam 本身是通的（纯转换器不替题库做政策）');
  ok(rGate.errors.some(e => e.code === 'E_INVALID_QUESTION'), '  拦截理由挂在题目级错误上',
     JSON.stringify(rGate.errors.map(e => e.code)));
  eq(await snapOf(store), before, '  store 仍逐字节未变');

  head('⑤-D 反向对照：合法文本入库后快照必须变（否则上面全是空转）');
  const rOk = await TF.importToLibrary(store, textA, { now: '2026-09-17T10:20:00.000Z', newIds: true });
  ok(rOk.ok, '合法文本入库成功', rOk.ok ? '' : brief(rOk.errors));
  ok((await snapOf(store)) !== before, '  **快照确实变了**（反向对照成立）');
  eq(rOk.exam.questions.length, examA.questions.length, '  入库题数正确');
  const list = await E.listExams(store);
  eq(list.total, 2, '  卷册里现在 2 份（原有的 + 导入的）');
  const meta = list.exams.filter(x => x.id === rOk.exam.id)[0];
  eq(meta.counts, { '单选': 2, '多选': 1, '判断': 3, '简答': 4, total: 10, invalid: 0 }, '  卷册 meta 的各题型计数正确');
  eq(meta.title, FULL_TITLE, '  卷册 meta 标题正确');
  eq((await E.scanOrphans(store)).orphans, [], '  无孤儿数据（record::/wrong:: 一个都没多出来）');
  const reRead = await E.getExam(store, rOk.exam.id);
  eq(JSON.stringify(reRead.exam.questions), JSON.stringify(rOk.exam.questions), '  从 store 读回的题目与导入结果逐字段一致');
  eq(JSON.stringify(reRead.exam.config), JSON.stringify(examA.config), '  从 store 读回的 config 逐字段一致');

  head('⑤-E newIds / 同 id 覆盖 / touch / title 在入库路径上的语义');
  eq(rOk.exam.id !== examA.id, true, 'newIds:true → 卷 id 重新分配');
  eq(rOk.exam.questions.filter(q => examA.questions.some(o => o.id === q.id)), [], '  题目 id 也不与原卷撞');
  const oldIds = (await E.getExam(store, seed.exam.id)).exam.questions.map(q => q.id).concat(rOk.exam.questions.map(q => q.id));
  eq(new Set(oldIds).size, oldIds.length, '  与已有卷的题目 id 也不重复');
  const W2 = world();
  const store2 = W2.store();
  const r2 = await TF.importToLibrary(store2, textA, { now: '2026-09-17T11:00:00.000Z' });
  eq([r2.ok, r2.exam.id, JSON.stringify(r2.exam.questions.map(q => q.id))],
     [true, examA.id, JSON.stringify(examA.questions.map(q => q.id))], '不传 newIds → 卷 id 与题目 id 全原样保留');
  const again = await TF.importToLibrary(store2, textA, { now: '2026-09-17T11:05:00.000Z' });
  eq([again.ok, (await E.listExams(store2)).total], [true, 1], '同 id 再导入一次 → 覆盖，不产生重复');
  const store3 = W2.store('other');
  const rTitle = await TF.importToLibrary(store3, textA, { title: '入库改名', now: '2026-09-17T11:10:00.000Z' });
  eq(rTitle.ok && rTitle.exam.title, '入库改名', 'title 选项覆盖标题');
  eq(rTitle.ok && rTitle.meta.title, '入库改名', '  meta 里的标题同步');
  const rTouch = await TF.importToLibrary(store3, textA, { touch: true, now: '2030-05-05T00:00:00.000Z' });
  eq(rTouch.ok && rTouch.exam.updatedAt, '2030-05-05T00:00:00.000Z', 'touch:true → updatedAt 置为 now');
  const rNoStore = await TF.importToLibrary(null, textA, {});
  eq([rNoStore.ok, rNoStore.blocked, firstErr(rNoStore).code], [false, true, 'E_NO_STORE'], '没有 store → 明确拒绝且不抛异常');

  /* ============================================================
   * ⑥ 汇总
   * ============================================================ */
  console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  if (fail) {
    console.log('  失败项：');
    failures.forEach(f => console.log('    - ' + f));
  }
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
