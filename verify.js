/* ============================================================
 *  verify.js —— 关键功能验证台（全部在 Node 里跑，不依赖浏览器）
 *  运行： node verify.js
 *
 *  覆盖：计分全分支 / 配置优先级 / 三种抽题算法 / AI 脏 JSON 容错 /
 *        AI 错误分类与重试 / 存储路由与降级 / 容量测算 / 分享脱敏与内嵌
 * ============================================================ */
const zlib = require('zlib');
const QuizCore = require('./core/quiz.js');
const AiCore   = require('./core/ai.js');
const DataCore = require('./core/data.js');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + label); }
  else { fail++; failures.push(label); console.log('  \x1b[31mFAIL\x1b[0m  ' + label + (extra !== undefined ? '   实际=' + JSON.stringify(extra) : '')); }
}
function eq(a, e, label) { const A = JSON.stringify(a), E = JSON.stringify(e); ok(A === E, label + '   期望=' + E, A); }
function near(a, e, tol, label) { ok(Math.abs(a - e) <= tol, label + '   期望≈' + e + '±' + tol, a); }
function head(t) { console.log('\n\x1b[36m======== ' + t + ' ========\x1b[0m'); }

const D = QuizCore.DEFAULT_CONFIG;
function cfg(over) { return QuizCore.deepMerge(D, over || {}); }

/* ==================== 1. 计分 ==================== */
async function main() {
head('1. 计分逻辑（单选/多选半对/判断/简答关键词）');

const qSingle = { id: 's1', type: '单选', answer: 'B', answerLetters: ['B'] };
let r = QuizCore.scoreOne(qSingle, 'B', cfg());
eq(r.score, 2, '单选答对 → 满分');
eq(r.correct, true, '单选答对 → correct=true');
eq(QuizCore.scoreOne(qSingle, 'C', cfg()).score, 0, '单选答错 → 0 分');
eq(QuizCore.scoreOne(qSingle, '', cfg()).score, 0, '单选择一个都不选 → 0 分');

const qJudgeT = { id: 'j1', type: '判断', answer: '√', judgeValue: true };
eq(QuizCore.scoreOne(qJudgeT, '√', cfg()).score, 1, '判断题：√ → 满分');
eq(QuizCore.scoreOne(qJudgeT, '对', cfg()).score, 1, '判断题：换写法"对" → 仍满分');
eq(QuizCore.scoreOne(qJudgeT, '错', cfg()).score, 0, '判断题：答错 → 0 分');
const qJudgeNull = { id: 'j2', type: '判断', answer: '待定', judgeValue: null };
eq(QuizCore.scoreOne(qJudgeNull, '√', cfg()).score, 0, '判断题：答案本身歧义 → 不给分（已在导入时标待校对）');

const qMulti = { id: 'm1', type: '多选', answer: 'ABC', answerLetters: ['A', 'B', 'C'] };
eq(QuizCore.scoreOne(qMulti, 'ABC', cfg()).score, 3, '多选全对 → 满分');
eq(QuizCore.scoreOne(qMulti, 'ACB', cfg()).score, 3, '多选顺序不同 → 仍满分');
eq(QuizCore.scoreOne(qMulti, '', cfg()).score, 0, '多选空选 → 0 分');

r = QuizCore.scoreOne(qMulti, 'AB', cfg({ multi: { halfMode: 'hitRatio', halfRatio: 0.5 } }));
near(r.score, 1, 0.001, '多选少选一个（无错选）按命中比例 → 2/3×0.5×3 = 1 分');
eq(r.detail.hit.length, 2, '  命中明细 2 个');
eq(r.detail.miss.length, 1, '  未命中明细 1 个');

r = QuizCore.scoreOne(qMulti, 'AB', cfg({ multi: { halfMode: 'fixed', halfRatio: 0.5 } }));
near(r.score, 1.5, 0.001, '多选半对用固定比例 0.5 → 1.5 分');

eq(QuizCore.scoreOne(qMulti, 'ABD', cfg({ multi: { wrongChoiceZero: true } })).score, 0,
   '多选有错选 + 错选即 0 分 → 0 分');
r = QuizCore.scoreOne(qMulti, 'ABD', cfg({ multi: { wrongChoiceZero: false, halfMode: 'hitRatio', halfRatio: 0.5 } }));
near(r.score, 1, 0.001, '多选有错选但允许部分分 → 仍按命中比例给 1 分');
eq(r.detail.wrong.length, 1, '  错选明细 1 个');

const qShort = { id: 'k1', type: '简答', answer: '略', keywords: [
  { text: '三次握手' }, { text: 'SYN' }, { text: 'ACK' }, { text: 'ESTABLISHED' }] };
r = QuizCore.scoreOne(qShort, '经过三次握手，发送 SYN 和 ACK，最终进入 ESTABLISHED 状态', cfg());
eq(r.score, 5, '简答 4 个关键词全命中 → 满分');
eq(r.detail.hitCount, 4, '  命中数=4');
r = QuizCore.scoreOne(qShort, '先三次握手，然后发送 SYN', cfg());
near(r.score, 2.5, 0.001, '简答命中 2/4 → 半分');
eq(r.detail.miss.length, 2, '  未命中明细 2 个');
eq(QuizCore.scoreOne(qShort, '完全不相干的一段话', cfg()).score, 0, '简答 0 命中 → 0 分');

// 同义词表（需求里归 AI，但本地留了小表）
r = QuizCore.scoreOne(qShort, '用 three-way handshake 建立连接', cfg({ short: { synonyms: { '三次握手': ['three-way handshake'] } } }));
eq(r.detail.hit.indexOf('三次握手') >= 0, true, '简答同义词表生效（three-way handshake → 三次握手）');

// 无关键词
eq(QuizCore.scoreOne({ id: 'k2', type: '简答', keywords: [] }, '随便答', cfg()).score, 0,
   '简答没有关键词 → 0 分（不误判为满分）');

// range 模式
r = QuizCore.scoreOne(qShort, '先三次握手，然后发送 SYN', cfg({ short: { scoreMode: 'range', minRatio: 0.6, maxRatio: 1.0 } }));
near(r.score, 4, 0.001, '简答 range 模式：命中率 0.5 → 0.6+0.4×0.5=0.8 → 4 分');

// 半分粒度
const fractional = QuizCore.scoreOne({ id: 'k3', type: '简答', keywords: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] }, 'a', cfg());
eq(fractional.score % 0.5, 0, '简答分数落在 0.5 的粒度上（不会出现 1.666 这种脏分）');

// 整卷
const examQs = [qSingle, qJudgeT, qMulti, qShort];
const examR = QuizCore.scoreExam(examQs, { s1: 'B', j1: '√', m1: 'ABC', k1: '三次握手 SYN ACK ESTABLISHED' }, cfg());
eq(examR.score, 11, '整卷总分 = 2+1+3+5 = 11');
eq(examR.full, 11, '整卷满分 = 11');
eq(examR.correctCount, 4, '全对题数 = 4');
eq(examR.percent, 100, '百分比 = 100');
eq(examR.level, '优秀', '达到优秀线');
const examR2 = QuizCore.scoreExam(examQs, { s1: 'A', j1: '×', m1: 'D', k1: '' }, cfg());
eq(examR2.score, 0, '全错 → 0 分（多选要选错选项 D，选 A 属部分正确会拿半对分）');
eq(examR2.level, '不及格', '低于及格线');

/* ==================== 2. 配置优先级 ==================== */
head('2. 配置优先级（试卷锁定 / 全局默认）');
const gcfg = { points: { '单选': 9 } };
let rc = QuizCore.resolveConfig(gcfg, { config: { points: { '单选': 3 } }, configLocked: false });
eq(rc.points['单选'], 3, '未锁定：试卷自己的配置生效');
rc = QuizCore.resolveConfig(gcfg, { config: { points: { '单选': 3 } }, configLocked: true });
eq(rc.points['单选'], 3, '已锁定：用试卷配置');
rc = QuizCore.resolveConfig({ points: { '单选': 9, '判断': 8 } }, { config: { points: { '单选': 3 } }, configLocked: true });
eq(rc.points['单选'], 3, '已锁定：全局的 9 不覆盖试卷的 3');
eq(rc.points['判断'], 1, '已锁定：缺失项落回内置默认(1)，不读全局 —— 保证全局改动绝不影响锁定卷');
const lockedExam = QuizCore.lockConfig({ points: { '单选': 9, '判断': 8 } }, { id: 'E9', config: { points: { '单选': 3 } } });
eq(lockedExam.configLocked, true, 'lockConfig：把配置固化为快照并标记锁定');
eq(lockedExam.config.points['判断'], 8, '  锁定瞬间把当时的全局值 8 一起固化进去（不会丢）');
eq(lockedExam.config.points['多选'], 3, '  未显式设置的项在快照里也是完整的（取内置默认 3）');
const afterGlobalChange = QuizCore.resolveConfig({ points: { '单选': 999, '判断': 999 } }, lockedExam);
eq(afterGlobalChange.points['单选'], 3, '  锁后改全局：单选仍是快照里的 3（不受影响）');
eq(afterGlobalChange.points['判断'], 8, '  锁后改全局：判断仍是快照里的 8（不受影响）');
rc = QuizCore.resolveConfig(gcfg, null);
eq(rc.points['单选'], 9, '没有试卷时：用全局');

/* ==================== 3. 抽题 ==================== */
head('3. 抽题（按题数比例 / 按总分权重 / 完全随机）');
const pool = DataCore.synthQuestions(120);   // 每种题型 30 题
eq(pool.length, 120, '合成题库 120 题');

let pk = QuizCore.pickQuestions(pool, cfg({ pick: { mode: 'byCount', byType: { '单选': 10, '多选': 4, '判断': 3, '简答': 2 } } }));
eq(pk.questions.length, 19, 'byCount：共抽 19 题');
const cnt = {}; pk.questions.forEach(q => cnt[q.type] = (cnt[q.type] || 0) + 1);
eq(cnt, { '单选': 10, '多选': 4, '判断': 3, '简答': 2 }, 'byCount：各题型数量精确匹配');
eq(new Set(pk.questions.map(q => q.id)).size, 19, 'byCount：无重复题');

pk = QuizCore.pickQuestions(pool.slice(0, 5), cfg({ pick: { mode: 'byCount', byType: { '单选': 10, '多选': 4, '判断': 3, '简答': 2 } } }));
ok(pk.questions.length <= 5, 'byCount：题库不足时不崩，抽出可用的题');
ok(!!pk.meta.warn, 'byCount：题库不足时给出警告文案', pk.meta.warn);
ok(Object.keys(pk.meta.byTypeShortfall).length > 0, 'byCount：报告每种题型的缺口');

pk = QuizCore.pickQuestions(pool, cfg({ pick: { mode: 'byWeight', targetScore: 20 } }));
const totalScore = pk.questions.reduce((s, q) => s + D.points[q.type], 0);
eq(totalScore, 20, 'byWeight：抽出的题总分正好命中目标分 20');
const spread = {}; pk.questions.forEach(q => spread[q.type] = (spread[q.type] || 0) + 1);
ok(Object.keys(spread).length >= 2, 'byWeight：分数分散在多个题型上（不是全压一个题型）', spread);

pk = QuizCore.pickQuestions(pool, cfg({ pick: { mode: 'random', count: 25 } }));
eq(pk.questions.length, 25, 'random：抽 25 题');
eq(new Set(pk.questions.map(q => q.id)).size, 25, 'random：无重复');

const a1 = QuizCore.pickQuestions(pool, cfg({ pick: { mode: 'random', count: 20, seed: 7 } })).questions.map(q => q.id).join(',');
const a2 = QuizCore.pickQuestions(pool, cfg({ pick: { mode: 'random', count: 20, seed: 7 } })).questions.map(q => q.id).join(',');
const a3 = QuizCore.pickQuestions(pool, cfg({ pick: { mode: 'random', count: 20, seed: 8 } })).questions.map(q => q.id).join(',');
eq(a1, a2, '同 seed → 抽题结果完全一致（可复现）');
ok(a1 !== a3, '不同 seed → 结果不同');

/* ==================== 4. AI 脏 JSON 容错 ==================== */
head('4. AI 输出容错（模型不老实时的 10 种脏数据）');
const J = (x) => JSON.stringify(x);
let p;

p = AiCore.safeParseJson('{"explanation":"因为 TCP 三次握手","pitfall":"别和四次挥手搞混"}');
eq(p.strategy, 'direct', '干净 JSON → 直接解析');
eq(p.value.explanation, '因为 TCP 三次握手', '  字段正确');

p = AiCore.safeParseJson('```json\n{"level":3,"reason":"需要记住顺序"}\n```');
eq(p.ok, true, '```json 代码围栏 → 能解析');
eq(p.value.level, 3, '  字段正确');
ok(p.fixes.indexOf('去代码围栏') >= 0, '  记录用了"去代码围栏"');

p = AiCore.safeParseJson('好的，以下是解析：\n{"explanation":"答案是这样","pitfall":"注意单位"}');
eq(p.ok, true, '前面有废话 → 能解析');
ok(p.fixes.indexOf('裁掉 JSON 之外的文字') >= 0, '  记录用了"裁掉 JSON 之外"');

p = AiCore.safeParseJson('{"summary":"总体不错"}\n希望对你有所帮助！');
eq(p.value.summary, '总体不错', '后面有废话 → 能解析');

p = AiCore.safeParseJson('{“explanation”：“中文引号”}');
eq(p.ok, true, '中文全角引号 → 能解析');
eq(p.value.explanation, '中文引号', '  值正确');

p = AiCore.safeParseJson("{'summary':'单引号','advice':['a','b']}");
eq(p.ok, true, '单引号 JSON → 能解析');
eq(p.value.advice.length, 2, '  数组正确');

p = AiCore.safeParseJson('{"level":4,"reason":"偏难",}');
eq(p.ok, true, '尾逗号 → 能解析');
eq(p.value.level, 4, '  值正确');

p = AiCore.safeParseJson('{explanation: "无引号键", pitfall: "也是"}');
eq(p.ok, true, '键名无引号 → 能解析');
eq(p.value.pitfall, '也是', '  值正确');

p = AiCore.safeParseJson('{"explanation":"被截断了","pitfall":"还差一个括号"');
eq(p.ok, true, 'JSON 被截断（缺右括号）→ 能修复');
eq(p.value.pitfall, '还差一个括号', '  修复后值正确');

p = AiCore.safeParseJson('{"stem":"关于 {ABC} 集合的说法","answer":"A"}');
eq(p.ok, true, '字符串里含花括号 → 不会被误切');
eq(p.value.stem, '关于 {ABC} 集合的说法', '  字符串完整');

p = AiCore.safeParseJson('{"stem":"他说\\"你好\\"然后走了","answer":"B"}');
eq(p.value.stem, '他说"你好"然后走了', '字符串里含转义引号 → 正确');

p = AiCore.safeParseJson('[{"a":1},{"a":2}]');
eq(p.ok, true, '数组为根 → 能解析');
eq(p.value.length, 2, '  数组长度正确');

p = AiCore.safeParseJson('这道题的答案是 B，因为传输层负责端到端通信。\n章节：第三章\n难度：3');
eq(p.strategy, 'fieldFallback', '完全散文 → 走字段抽取兜底（页面不崩）');
eq(p.value.answer, 'B', '  兜底抽到 answer');
eq(p.value.level, 3, '  兜底抽到 level');

p = AiCore.safeParseJson('');
eq(p.ok, false, '空内容 → ok:false');
eq(p.strategy, 'empty', '  标记为 empty');

p = AiCore.safeParseJson('%%%% 完全不是 JSON %%%%');
eq(p.ok, false, '彻底垃圾 → ok:false（不抛异常）');
eq(p.strategy, 'failed', '  标记为 failed');

/* ==================== 5. AI 校验 / 错误分类 / 重试 ==================== */
head('5. AI 结构校验、错误分类、重试骨架');
eq(AiCore.validate('explain', { explanation: 'x', pitfall: 'p' }).ok, true,
   'validate：explain 合法通过（**必须带 pitfall**：易错点是解析的一部分）');
eq(AiCore.validate('explain', { explanation: 'x' }).errors, ['缺少字段 pitfall'],
   'validate：只给解析、不给易错点 → 不通过（「单题智能生成」把易错点纳入了结构）');
eq(AiCore.validate('explain', {}).ok, false, 'validate：缺字段 → 不通过');
eq(AiCore.validate('variant', { type: '填空题', stem: 'x', answer: 'A' }).ok, false,
   'validate：题型不在四类里 → 不通过');
eq(AiCore.validate('variant', { type: '单选', stem: 'x', answer: 'A', options: [{ label: 'A', text: 't' }] }).ok, true,
   'validate：合法变式题通过');
eq(AiCore.validate('difficulty', { level: 9 }).ok, false, 'validate：难度 9 超范围 → 不通过');
eq(AiCore.validate('difficulty', { level: 3 }).ok, true, 'validate：难度 3 通过');

eq(AiCore.classifyError(null, 401).kind, 'auth', '错误分类：401 → 鉴权');
ok(AiCore.classifyError(null, 401).hint.indexOf('设置页') >= 0, '  给出了可操作建议');
eq(AiCore.classifyError(null, 429).kind, 'rate_limit', '错误分类：429 → 限流');
eq(AiCore.classifyError(null, 400).kind, 'bad_request', '错误分类：400 → 参数不支持（如模型不支持 JSON 模式）');
eq(AiCore.classifyError(new Error('Failed to fetch'), 0).kind, 'cors_or_network', '错误分类：Failed to fetch → 跨域/网络');
ok(AiCore.classifyError(new Error('Failed to fetch'), 0).hint.indexOf('CORS') >= 0, '  提示里点明跨域');
eq(AiCore.classifyError(null, 503).kind, 'server', '错误分类：503 → 服务端');
const abortErr = new Error('aborted'); abortErr.name = 'AbortError';
eq(AiCore.classifyError(abortErr, 0).kind, 'timeout', '错误分类：AbortError → 超时');

const req = AiCore.buildChatRequest('deepseek', { apiKey: 'sk-x', model: 'deepseek-chat', user: 'hi', jsonMode: true });
eq(req.url, 'https://api.deepseek.com/v1/chat/completions', 'buildChatRequest：URL 正确');
eq(req.headers['Authorization'], 'Bearer sk-x', '  Authorization 头正确');
eq(req.body.response_format.type, 'json_object', '  jsonMode 会带 response_format');
ok(AiCore.PROVIDERS.openai.cors.indexOf('❌') >= 0, '供应商表标注了 OpenAI 不可直连');
eq(AiCore.estimateTokens('这是一段中文').valueOf() >= 6, true, 'token 粗估：6 个中文 ≈ 6+ token');
ok(AiCore.estimateTokens('hello world') >= 2, 'token 粗估：英文按 4 字符 1 token');

// mock fetch：脏 JSON → 第二次成功
function mockFetch(script) {
  let i = 0;
  return async function () {
    const s = script[Math.min(i, script.length - 1)]; i++;
    if (s.throw) throw new Error(s.throw);
    return { ok: s.status < 400, status: s.status, text: async () => s.body };
  };
}
let call = await AiCore.callAi(mockFetch([{ status: 200, body: J({ choices: [{ message: { content: '{"explanation":"ok","pitfall":"易错点"}' } }] }) }]),
  'deepseek', { apiKey: 'k', task: 'explain', user: 'x' });
eq(call.ok, true, 'callAi：正常返回 → ok');
eq(call.attempts, 1, '  只请求了 1 次');

call = await AiCore.callAi(mockFetch([
  { status: 200, body: J({ choices: [{ message: { content: '模型今天不听话，没有 JSON' } }] }) },
  { status: 200, body: J({ choices: [{ message: { content: '{"explanation":"第二次好了","pitfall":"易错点"}' } }] }) }
]), 'deepseek', { apiKey: 'k', task: 'explain', user: 'x', retries: 2 });
eq(call.ok, true, 'callAi：首次脏输出 → 自动重试后成功');
eq(call.attempts, 2, '  重试了 1 次（共 2 次）');

call = await AiCore.callAi(mockFetch([{ status: 401, body: '{"error":"bad key"}' }]),
  'deepseek', { apiKey: 'bad', task: 'explain', user: 'x' });
eq(call.ok, false, 'callAi：401 → 失败');
eq(call.kind, 'auth', '  分类为 auth');
eq(call.attempts, undefined, '  鉴权错误不重试（直接返回）');

call = await AiCore.callAi(mockFetch([
  { status: 429, body: 'rate limited' },
  { status: 200, body: J({ choices: [{ message: { content: '{"explanation":"限流后成功","pitfall":"易错点"}' } }] }) }
]), 'zhipu', { apiKey: 'k', task: 'explain', user: 'x', retries: 2 });
eq(call.ok, true, 'callAi：429 限流 → 重试后成功');
eq(call.attempts, 2, '  重试计数正确');

call = await AiCore.callAi(mockFetch([{ throw: 'Failed to fetch' }]),
  'deepseek', { apiKey: 'k', task: 'explain', user: 'x', retries: 1 });
eq(call.kind, 'cors_or_network', 'callAi：网络异常 → 分类为跨域/网络');

/* ==================== 6. 存储路由与降级 ==================== */
head('6. 存储路由（小数据走同步 / 大数据走异步 / 配额满自动降级）');
function mockSmall(limitBytes) {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: function (k, v) {
      let used = 0; m.forEach((val, key) => used += key.length + val.length);
      if (limitBytes && used + k.length + v.length > limitBytes) {
        const e = new Error('quota exceeded'); e.name = 'QuotaExceededError'; throw e;
      }
      m.set(k, v);
    },
    removeItem: k => m.delete(k),
    key: i => Array.from(m.keys())[i] === undefined ? null : Array.from(m.keys())[i],
    get length() { return m.size; }
  };
}
function mockLarge() {
  const m = new Map();
  return {
    get: async k => (m.has(k) ? JSON.parse(m.get(k)) : null),
    set: async (k, v) => { m.set(k, JSON.stringify(v)); },
    del: async k => { m.delete(k); },
    keys: async () => Array.from(m.keys())
  };
}

let store = DataCore.createStore({ small: mockSmall(0), large: mockLarge(), threshold: 4096, namespace: 'exam_E1' });
let w = await store.set('small1', { a: 1 });
eq(w.where, 'small', '小记录 → 写同步后端');
eq((await store.get('small1')).a, 1, '  能读回');

w = await store.set('big1', { pad: 'x'.repeat(8000) });
eq(w.where, 'large', '超阈值记录 → 自动写异步后端');
eq((await store.get('big1')).pad.length, 8000, '  大记录能原样读回');

store = DataCore.createStore({ small: mockSmall(200), large: mockLarge(), threshold: 10 * 1024, namespace: 'exam_E2' });
w = await store.set('q1', { pad: 'y'.repeat(500) });
eq(w.where, 'large', '同步后端配额满 → 自动降级到异步后端');
eq(w.reason, 'quota', '  降级原因标记为 quota');
eq((await store.get('q1')).pad.length, 500, '  降级后仍能读回');

const ks = await store.keys();
ok(ks.indexOf('q1') >= 0, 'keys() 能跨两个后端汇总');

store = DataCore.createStore({ small: mockSmall(0), large: mockLarge(), threshold: 100, namespace: 'nsA' });
const storeB = DataCore.createStore({ small: mockSmall(0), large: mockLarge(), threshold: 100, namespace: 'nsB' });
await store.set('k', { v: 1 });
await storeB.set('k', { v: 2 });
eq((await store.get('k')).v, 1, '命名空间隔离：A 读到自己的');
eq((await storeB.get('k')).v, 2, '命名空间隔离：B 读到自己的');

store = DataCore.createStore({ small: mockSmall(0), large: mockLarge(), threshold: 200 * 1024, namespace: 'exam_E3' });
await store.set('t', { v: 9 });
await store.del('t');
eq(await store.get('t'), null, '删除后读不到');

/* ==================== 7. 容量测算 ==================== */
head('7. 容量测算（回答"5MB 到底能装多少题"）');
const sample = DataCore.synthQuestions(500);
const cap = DataCore.capacityReport(sample, 5 * 1024 * 1024, s => zlib.deflateSync(Buffer.from(s, 'utf8')));
console.log('      样例题数            : ' + cap.sampleCount);
console.log('      原始 JSON 大小      : ' + (cap.rawBytes / 1024).toFixed(1) + ' KB   （每题 ' + cap.bytesPerQuestionRaw + ' 字节）');
console.log('      压缩后大小          : ' + (cap.compressedBytes / 1024).toFixed(1) + ' KB   （每题 ' + cap.bytesPerQuestionCompressed + ' 字节，压缩率 ' + cap.ratio + '）');
console.log('      5MB 原始能装        : 约 ' + cap.fitRaw + ' 题');
console.log('      5MB 压缩后能装      : 约 ' + cap.fitCompressed + ' 题');
ok(cap.ratio < 0.5, '压缩率有效（<50%）', cap.ratio);
ok(cap.fitCompressed > cap.fitRaw, '压缩后能装的题数明显更多');
ok(cap.fitRaw > 500, '即使不压缩，5MB 也能装下 500 题以上（个人使用足够）');

/* ==================== 8. 分享脱敏与内嵌 ==================== */
head('8. 分享导出（脱敏 + 安全内嵌）');
const state = {
  settings: { provider: 'deepseek', apiKey: 'sk-1234567890abcdefghijklmn', model: 'deepseek-chat' },
  exams: [{
    id: 'E1', title: '计算机网络期中卷', configLocked: true,
    config: { points: { '单选': 2 } },
    questions: [qSingle, qMulti, qShort, { id: 'weird', type: '判断', stem: '题干里带 </script> 结束标签', answer: '√', judgeValue: true }]
  }],
  records: { E1: [{ id: 'r1', score: 10 }] },
  wrongBook: { E1: [{ qid: 's1', times: 2 }] }
};
const leaks = DataCore.findSecrets(state);
ok(leaks.some(x => x.why.indexOf('疑似密钥') >= 0), '脱敏前：能扫出疑似密钥');
ok(leaks.some(x => /apikey|key/i.test(x.why)), '脱敏前：能扫出 apiKey 字段名（大小写不敏感）');
ok(leaks.some(x => x.why.indexOf('records') >= 0), '脱敏前：能扫出 records 字段名');

const payload = DataCore.sanitizeSharePayload(state, { examId: 'E1' });
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
eq(has(payload, 'settings'), false, '脱敏后：连 settings 这个键都不存在（不是留个 null，审计更硬）');
eq(has(payload, 'records'), false, '脱敏后：连 records 这个键都不存在');
eq(has(payload, 'wrongBook'), false, '脱敏后：连 wrongBook 这个键都不存在');
eq(payload.exams.length, 1, '脱敏后：试卷保留');
eq(payload.exams[0].questions.length, 4, '脱敏后：题目全保留');
eq(payload.exams[0].questions[2].keywords.length, 4, '脱敏后：简答采分关键词保留');
const leaks2 = DataCore.findSecrets(payload);
ok(leaks2.length === 0, '脱敏后：findSecrets 零命中（可安全分享）', leaks2.slice(0, 3));

const html = '<!doctype html><html><body><h1>答题</h1></body></html>';
const embedded = DataCore.embedPayload(html, payload, { secrets: [] });   // 显式声明"这里没有可比机密"（缺参会 fail-closed）
ok(embedded.indexOf('exam-payload') >= 0, '内嵌：payload 标签已插入');
ok(embedded.indexOf('sk-1234567890') < 0, '内嵌：文件里不含密钥');
const back = DataCore.extractPayload(embedded);
eq(back.exams[0].title, '计算机网络期中卷', '往返：能读回试卷');
eq(back.exams[0].questions[3].stem, '题干里带 </script> 结束标签', '往返：含 </script> 的题干完好（HTML 没被截断）');
eq(back.exams[0].questions[3].judgeValue, true, '往返：判断题判分信息保留');
eq(DataCore.extractPayload('<html><body>没有 payload</body></html>'), null, '没有 payload 的 HTML → 返回 null 不崩');

// 严谨验证：带 </script> 的 payload 不会把 <script> 提前闭合
const rawTagCount = (embedded.match(/<script/g) || []).length;
const rawCloseCount = (embedded.match(/<\/script>/g) || []).length;
eq(rawTagCount, 1, '安全性：文件中只有 1 个 <script 开标签');
eq(rawCloseCount, 1, '安全性：文件中只有 1 个 </script> 闭标签（题干里的那个已被转义）');

/* ==================== 汇总 ==================== */
console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
console.log('  PASS ' + pass + '    FAIL ' + fail);
if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
process.exitCode = fail ? 1 : 0;
}

main().catch(function (e) { console.error('验证台崩了: ' + (e && e.stack || e)); process.exit(2); });

/* ---- 追加：高熵样本，给压缩率一个诚实区间（合成题太重复，压缩率会虚高）---- */
(function () {
  const zlib2 = require('zlib');
  const D2 = DataCore;
  // 用种子化随机汉字拼出"每道题都不一样"的题，模拟真实试卷的文本熵
  function highEntropy(n, seed) {
    let a = seed >>> 0;
    const rnd = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pool = '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严龙飞';
    const rndWord = (len) => { let s=''; for(let i=0;i<len;i++) s += pool[Math.floor(rnd()*pool.length)]; return s; };
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({
        id: 'h' + i, type: ['单选','多选','判断','简答'][i % 4],
        stem: rndWord(38) + '？',
        options: [{label:'A',text:rndWord(24)},{label:'B',text:rndWord(24)},{label:'C',text:rndWord(24)},{label:'D',text:rndWord(24)}],
        answer: 'B',
        explanation: rndWord(46),
        keywords: [{text: rndWord(4)}, {text: rndWord(4)}, {text: rndWord(4)}]
      });
    }
    return out;
  }
  const he = highEntropy(500, 12345);
  const cap2 = D2.capacityReport(he, 5 * 1024 * 1024, s => zlib2.deflateSync(Buffer.from(s, 'utf8')));
  console.log('\n  [高熵样本 · 更接近真实试卷]');
  console.log('      每题原始            : ' + cap2.bytesPerQuestionRaw + ' 字节');
  console.log('      每题压缩后          : ' + cap2.bytesPerQuestionCompressed + ' 字节  （压缩率 ' + cap2.ratio + '）');
  console.log('      5MB 原始能装        : 约 ' + cap2.fitRaw + ' 题');
  console.log('      5MB 压缩后能装      : 约 ' + cap2.fitCompressed + ' 题');
  console.log('      => 结论：localStorage 5MB 本身就能装约 ' + cap2.fitRaw + ' 道真实大题；压缩后还有 ' + Math.round(1/cap2.ratio) + ' 倍余量。');
  console.log('         （第 7 节那个 0.021 的压缩率是合成题重复度太高导致的虚高，不可当真）');
})();
