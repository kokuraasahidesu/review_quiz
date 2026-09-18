/* ============================================================
 *  verify/schema.test.js —— 核心结构定义的验收
 *  运行： node verify/schema.test.js
 *  覆盖该小类三条验收标准：
 *    ① 五类结构有字段定义与约束，能判定合法/非法样本
 *    ② 题目 id 卷内唯一；导出再导入后 id 保持不变
 *    ③ schemaVersion 缺失/未知/更高版本各有明确处置，不静默当新格式
 * ============================================================ */
const S = require('../core/schema.js');

let pass = 0, fail = 0; const failures = [];
function ok(c, t, d) { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + d : '')))
                         : (fail++, failures.push(t), console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + JSON.stringify(d) : ''))); }
function eq(a, e, t) { const A = JSON.stringify(a), E = JSON.stringify(e); ok(A === E, t + '   期望=' + E, A); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }

// 确定性 rng，保证 id 可复现
function mkRng(seed) { let a = seed >>> 0; return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const opts = { rng: mkRng(42), now: '2026-09-16T00:00:00.000Z' };

/* ============ ① 结构工厂 + 合法/非法样本判定 ============ */
head('① 五类结构定义与合法性判定');

const qSingle = S.createQuestion({ type: '单选', stem: '下列哪个协议工作在传输层？', answer: 'B',
  options: [{ label: 'A', text: 'HTTP' }, { label: 'B', text: 'TCP' }, { label: 'C', text: 'IP' }, { label: 'D', text: 'ARP' }],
  explanation: 'TCP 在传输层', difficulty: 2 }, opts);
eq(qSingle.answerLetters, ['B'], '单选：答案字母被解析出来');
eq(S.validateQuestion(qSingle).ok, true, '单选：合法样本通过校验');

const qMulti = S.createQuestion({ type: '多选', stem: '哪些是应用层协议？', answer: 'ABD',
  options: [{ label: 'A', text: 'DNS' }, { label: 'B', text: 'FTP' }, { label: 'C', text: 'TCP' }, { label: 'D', text: 'SMTP' }] }, opts);
eq(qMulti.answerLetters, ['A', 'B', 'D'], '多选：答案字母被解析出来');

const qJudge = S.createQuestion({ type: '判断', stem: '交换机工作在数据链路层。（　）', answer: '√' }, opts);
eq(qJudge.judgeValue, true, '判断：正误写法被归一为 true');
const qJudgeBad = S.createQuestion({ type: '判断', stem: '集线器可以隔离冲突域。（　）', answer: '待定' }, opts);
eq(qJudgeBad.judgeValue, null, '判断：歧义答案归一为 null（不强行判分）');
eq(S.validateQuestion(qJudgeBad).ok, true, '判断：歧义答案不算非法（是待校对）');
ok(S.validateQuestion(qJudgeBad).warnings.join().indexOf('待人工校对') >= 0, '判断：歧义项带出待校对警告');

const qShort = S.createQuestion({ type: '简答', stem: '简述三次握手。',
  answer: '客户端发 SYN…', keywords: [{ text: 'SYN', via: '加粗' }, { text: 'ACK', via: '高亮' }, { text: 'SYN', via: '重复项' }] }, opts);
eq(qShort.keywords.map(k => k.text), ['SYN', 'ACK'], '简答：关键词去重且保留来源');
eq(S.validateQuestion(qShort).ok, true, '简答：合法样本通过校验');
ok(S.validateQuestion(S.createQuestion({ type: '简答', stem: 'x', keywords: [] }, opts)).warnings.join().indexOf('没有采分关键词') >= 0,
   '简答：无关键词时给出警告（而非报错）');

// 非法样本
eq(S.validateQuestion(S.createQuestion({ type: '填空', stem: 'x' }, opts)).ok, false, '非法：题型不在四类内 → 拒绝');
eq(S.validateQuestion(S.createQuestion({ type: '单选', stem: 'x', answer: 'B', options: [{ label: 'A', text: 'a' }] }, opts)).ok, false,
   '非法：选择题选项少于 2 个 → 拒绝');
eq(S.validateQuestion(S.createQuestion({ type: '单选', stem: 'x', answer: 'D',
   options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }] }, opts)).ok, false,
   '非法：答案字母不在选项里 → 拒绝');
eq(S.validateQuestion(S.createQuestion({ type: '单选', stem: 'x', answer: 'AB',
   options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }] }, opts)).ok, false,
   '非法：单选题给了两个答案 → 拒绝');
eq(S.validateQuestion(S.createQuestion({ type: '多选', stem: 'x', answer: 'A',
   options: [{ label: 'A', text: 'a' }, { label: 'A', text: 'b' }] }, opts)).ok, false,
   '非法：选项标签重复 → 拒绝');
eq(S.validateQuestion(S.createQuestion({ type: '简答', stem: 'x', keywords: [{ text: 'ok' }], difficulty: 9 }, opts)).ok, false,
   '非法：难度 9 超范围 → 拒绝');
eq(S.validateQuestion(S.createQuestion({ type: '单选', stem: '', answer: 'A',
   options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }] }, opts)).ok, false, '非法：题干为空 → 拒绝');

/* ============ ② 试卷结构与 id 稳定性 ============ */
head('② 试卷结构、id 卷内唯一、导出再导入 id 不变');

const exam = S.createExam({ title: '计算机网络 期中卷', questions: [qSingle, qMulti, qJudge, qShort] }, opts);
eq(S.validateExam(exam).ok, true, '试卷：合法样本通过校验');
eq(exam.schemaVersion, S.SCHEMA_VERSION, '试卷：带 schemaVersion');
ok(!!exam.id && exam.id.indexOf('exam_') === 0, '试卷：有唯一 id');

// 卷内 id 唯一
const dupQ = Object.assign({}, qSingle, { id: qSingle.id });
eq(S.validateExam(S.createExam({ title: 'd', questions: [qSingle, dupQ] }, opts)).ok, false,
   '试卷：题目 id 重复 → 拒绝');
const ids = exam.questions.map(q => q.id);
eq(new Set(ids).size, ids.length, '试卷：四道题 id 互不相同');

// 导出 → 导入，id 必须不变
const exported = JSON.parse(JSON.stringify(Object.assign({ schemaVersion: S.SCHEMA_VERSION }, exam)));
const read = S.readPayload(exported);
eq(read.ok, true, '往返：readPayload 接受本版本载荷');
eq(read.payload.questions.map(q => q.id), ids, '往返：题目 id 逐一对上（未重新生成）');
eq(read.payload.questions[2].judgeValue, true, '往返：判断题判分信息保留');
eq(read.payload.questions[3].keywords.map(k => k.text), ['SYN', 'ACK'], '往返：采分关键词保留');
eq(read.applied, [], '往返：同版本不做迁移');

/* ============ ③ 版本门禁 ============ */
head('③ schemaVersion 门禁：缺失 / 非法 / 过高 / 需迁移');

let r = S.readPayload({ title: '没有版本号' });
eq(r.ok, false, '缺 schemaVersion → 拒绝');
ok(r.error.indexOf('缺少 schemaVersion') >= 0, '  错误信息点明缺失字段', r.error);
ok(!!r.hint, '  并给出可操作提示', r.hint);

r = S.readPayload({ schemaVersion: 'v1', title: 'x' });
eq(r.ok, false, 'schemaVersion 非法类型 → 拒绝');
ok(r.error.indexOf('非法') >= 0, '  错误信息点明非法', r.error);

r = S.readPayload({ schemaVersion: S.SCHEMA_VERSION + 1, title: '来自未来' });
eq(r.ok, false, '版本高于程序 → 拒绝');
ok(r.error.indexOf('高于') >= 0, '  错误信息说明版本过高', r.error);
ok(r.hint.indexOf('升级') >= 0, '  提示升级程序', r.hint);

r = S.readPayload(null);
eq(r.ok, false, 'null 载荷 → 拒绝且不抛异常');

// 迁移通道：版本低于当前且缺规则时必须明确报错（而不是静默放行）
S.SCHEMA_VERSION; // 当前为 1，构造一个 v0 载荷来验证迁移缺失路径
r = S.readPayload({ schemaVersion: 0, title: 'v0 老文件' });
eq(r.ok, false, '低版本但缺迁移规则 → 明确报错（不静默当新格式）', r.error || r.ok);
ok(!!r.hint, '  给出提示', r.hint);

/* ============ 应用全局状态（用户点名要的全局量） ============ */
head('④ 应用全局状态：形状、分区、索引一致性');

const st = S.createAppState();
eq(S.validateAppState(st).ok, true, '空状态通过校验');
['secrets', 'settings', 'exams', 'index', 'session', 'wrongbook', 'records', 'runtime']
  .forEach(k => ok(Object.prototype.hasOwnProperty.call(st, k), '  状态分区存在：' + k));
ok(typeof st.secrets.apiKey === 'string', '  secrets 独立分区（永不进导出）');

st.exams[exam.id] = exam;
st.index.examIds.push(exam.id);
eq(S.validateAppState(st).ok, true, '放入一卷并登记索引后仍合法');

const bad = JSON.parse(JSON.stringify(st));
bad.index.examIds.push('exam_不存在');
ok(S.validateAppState(bad).ok === false, '索引指向不存在的试卷 → 校验报错');
ok(S.validateAppState(bad).errors.join().indexOf('不存在的试卷') >= 0, '  错误信息可读');

/* ============ 字段白名单（供分享脱敏复用） ============ */
head('⑤ 字段白名单：只挑该带的字段');
const squeezed = S.pickFields(Object.assign({}, exam, { secretNote: '不该带走' }), S.EXAM_FIELDS);
eq(Object.prototype.hasOwnProperty.call(squeezed, 'secretNote'), false, '白名单外字段被剔除');
eq(Object.prototype.hasOwnProperty.call(squeezed, 'questions'), true, '白名单内字段保留');

console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
console.log('  PASS ' + pass + '    FAIL ' + fail);
if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
process.exitCode = fail ? 1 : 0;
