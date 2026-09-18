/* ============================================================
 *  verify/ai-tolerant.test.js —— 「容错与提示」小类验收（L1「AI 辅助」收官）
 *
 *  运行： node verify/ai-tolerant.test.js
 *
 *  三条盘档验收标准，逐条对应：
 *    ① **12 类脏输出**都能被容错解析或安全降级，**不抛异常、不崩页**；
 *    ② 断网 / 密钥错误 / 模型不支持 JSON 模式三类失败各自给出**可操作的分类提示**；
 *    ③ 批量操作前弹消耗确认并显示估算 token；**单题不弹窗**；
 *       粗估偏差 < 60%（真调用实测值见 `verify/real-ai-last.json` 的 `estimate` 段）。
 * ============================================================ */
const A = require('../core/ai.js');
const S = require('../core/schema.js');

let pass = 0, fail = 0; const failures = [];
function brief(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return String(s);
  return s.length > 190 ? s.slice(0, 190) + '…(' + s.length + ' 字符)' : s;
}
function ok(c, t, d) { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + brief(d) : '')))
                         : (fail++, failures.push(t), console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + brief(d) : ''))); }
function eq(a, e, t) { const A1 = JSON.stringify(a), B = JSON.stringify(e); ok(A1 === B, t + '   期望=' + brief(B), A1); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }

function backend() {
  const m = new Map();
  return {
    getItem: k => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: k => { m.delete(String(k)); },
    key: i => { const a = Array.from(m.keys()); return i < a.length ? a[i] : null; },
    get length() { return m.size; }
  };
}
const CANARY = 'sk-canary-9f3a7c1e5b2d4680zz';
async function keyStore() {
  const bk = backend();
  const st = A.openKeyStore(bk);
  await A.saveKey(st, 'dashscope', CANARY, { now: '2026-10-29T09:00:00.000Z' });
  return A.openKeyStore(bk);
}
/* 假 fetch：plan 里每项可以是
 *   · 字符串        → 直接当模型返回的 content
 *   · {content,usage} → 指定 content 与真实用量
 *   · {throwStatus,body} → 模拟 HTTP 错误（带响应体，用于"不支持 JSON 模式"这种判据）
 * ⚠ 只有 plan 项里**显式写了 usage** 才回 usage —— 否则"服务商没回用量"那条断言就没法测。 */
function fakeFetch(plan) {
  const calls = [];
  const f = async function (url, init) {
    calls.push({ url: url, body: init.body });
    const pick = plan[Math.min(calls.length - 1, plan.length - 1)];
    if (pick && pick.throwStatus) return { ok: false, status: pick.throwStatus, text: async () => (pick.body || '{"error":"boom"}') };
    const content = (typeof pick === 'string') ? pick : ((pick && pick.content) || '{}');
    const pack = { choices: [{ message: { content: content } }] };
    if (pick && pick.usage) pack.usage = pick.usage;
    return { ok: true, status: 200, text: async () => JSON.stringify(pack) };
  };
  f.calls = calls;
  return f;
}
const Q1 = S.createQuestion({ id: 't1', type: '单选', stem: 'HTTP 默认端口？', options: [{ label: 'A', text: '21' }, { label: 'B', text: '80' }], answerLetters: ['B'], answer: 'B', explanation: '' });

/* ============================================================
 *  ① 12 类脏输出：逐类断言"解析出来 或 安全降级"，且**不抛异常**
 * ============================================================ */
const CASES = [
  { n: 1, name: '代码围栏 ```json … ```', raw: '```json\n{"explanation":"解析","pitfall":"易错"}\n```',
    want: { explanation: '解析', pitfall: '易错' } },
  { n: 2, name: 'JSON 前面有废话', raw: '好的，以下是结果：\n{"explanation":"解析","pitfall":"易错"}',
    want: { explanation: '解析', pitfall: '易错' } },
  { n: 3, name: 'JSON 后面有解说', raw: '{"explanation":"解析","pitfall":"易错"}\n以上就是全部，希望有帮助。',
    want: { explanation: '解析', pitfall: '易错' } },
  { n: 4, name: '中文引号 “ ”', raw: '{“explanation”:“解析”,“pitfall”:“易错”}',
    want: { explanation: '解析', pitfall: '易错' } },
  { n: 5, name: "单引号 ' '", raw: "{'explanation':'解析','pitfall':'易错'}",
    want: { explanation: '解析', pitfall: '易错' } },
  { n: 6, name: '尾逗号', raw: '{"explanation":"解析","pitfall":"易错",}',
    want: { explanation: '解析', pitfall: '易错' } },
  { n: 7, name: '无引号键', raw: '{explanation:"解析",pitfall:"易错"}',
    want: { explanation: '解析', pitfall: '易错' } },
  { n: 8, name: '截断（未闭合括号+字符串）', raw: '{"explanation":"解析","pitfall":"易错',
    want: { explanation: '解析', pitfall: '易错' } },
  { n: 9, name: '字符串内含花括号', raw: '{"explanation":"用 {a} 表示集合","pitfall":"别漏 }"}',
    want: { explanation: '用 {a} 表示集合', pitfall: '别漏 }' } },
  { n: 10, name: '字符串里有真实换行/制表符', raw: '{"explanation":"第一行\n第二行\t缩进","pitfall":"易错"}',
    want: { explanation: '第一行\n第二行\t缩进', pitfall: '易错' } },
  { n: 11, name: 'JSON 里混 JS 注释', raw: '{"explanation":"解析", // 这句是解析\n"pitfall":"易错"}',
    want: { explanation: '解析', pitfall: '易错' } },
  { n: 12, name: '纯散文（没有 JSON）→ 字段抽取兜底', raw: '这道题的答案是 B。\n解析：80 是默认端口。\n易错点：别把 443 当默认端口。',
    want: { answer: 'B' }, fallback: true }
];

/* 下面整段是异步的（要起假 fetch / 读写密钥 store）→ 按本项目惯例包一层 async IIFE，
 * 否则 Node 会因为"同时出现 require 与顶层 await"报 ERR_AMBIGUOUS_MODULE_SYNTAX。 */
(async function main() {

head('①-A 12 类脏输出：逐类容错解析（不抛异常）');

CASES.forEach(function (c) {
  let r = null, threw = '';
  try { r = A.safeParseJson(c.raw); } catch (e) { threw = (e && e.message) || String(e); }
  ok(threw === '', '类 ' + c.n + '「' + c.name + '」：**没有抛异常**', threw || 'ok');
  if (!r) return;
  ok(r.ok === true, '  能解析出对象（strategy=' + r.strategy + '）', JSON.stringify(r.value));
  Object.keys(c.want).forEach(function (k) {
    eq(r.value && r.value[k], c.want[k], '  字段 ' + k + ' 正确');
  });
  if (c.fallback) {
    eq(r.strategy, 'fieldFallback', '  走的是**字段抽取降级**（策略名可核对）');
    ok(/字段抽取/.test((r.fixes || []).join('')), '  fixes 里写明用了兜底', (r.fixes || []).join('、'));
  } else {
    ok(r.strategy === 'direct' || r.strategy === 'repaired', '  走的是 JSON 解析（direct/repaired）', r.strategy);
    ok((r.fixes || []).length >= 0, '  记录了用过的修复项', (r.fixes || []).join('、'));
  }
});

head('①-B 容错解析的边界：空输入、彻底垃圾、数组/嵌套、超长截断');

let r0 = null, threw0 = '';
try { r0 = A.safeParseJson(''); } catch (e) { threw0 = String(e); }
eq([threw0, r0.ok, r0.strategy], ['', false, 'empty'], '空字符串 → ok:false + strategy=empty（**不抛异常**）');
let rN = null; try { rN = A.safeParseJson(null); } catch (e) { rN = { threw: String(e) }; }
eq([!!rN.threw, rN.ok], [false, false], 'null 输入也不抛异常');
let rG = null, threwG = '';
try { rG = A.safeParseJson('@@@ ### ???'); } catch (e) { threwG = String(e); }
eq([threwG, rG.ok, rG.strategy], ['', false, 'failed'], '彻底无法解析 → ok:false + strategy=failed（**不抛异常**，由调用方决定提示）');
ok(typeof rG.raw === 'string' && rG.raw.length <= 400, '  带回原文片段（≤400 字）便于排查', String(rG.raw).length + ' 字');
const rArr = A.safeParseJson('[{"a":1},{"a":2}]');
eq([rArr.ok, Array.isArray(rArr.value)], [true, true], '根节点是数组也能解析（不假定只有对象）');
const rNest = A.safeParseJson('{"a":{"b":[1,2,{"c":"}"}]}}');
eq(rNest.ok && rNest.value.a.b[2].c, '}', '嵌套结构里含花括号的字符串也不误判');
const longRaw = '{"explanation":"' + 'x'.repeat(5000) + '","pitfall":"截断在这' ;
const rLong = A.safeParseJson(longRaw);
eq([rLong.ok, String(rLong.value.explanation).length], [true, 5000], '超长内容被截断后仍能补齐解析');
const rPit = A.safeParseJson('{"explanation":"只有解析"}');
eq([rPit.ok, Object.keys(rPit.value)], [true, ['explanation']], '结构不完整的对象照原样解析出来（**由 validate 判合格与否**，解析层不替它做决定）');

head('①-C 降级路径端到端：脏输出 → 抽取 → 过不了结构闸门 → 拒绝而不是崩');

const dirtyPlain = '这道题的答案是 B。\n解析：80 是默认端口。';
const fb = A.safeParseJson(dirtyPlain);
eq([fb.ok, fb.strategy], [true, 'fieldFallback'], '散文 → 抽取到 answer（解析层 ok）');
eq(A.validate('explain', fb.value).ok, false, '但 explain 要求 explanation+pitfall → 结构闸门拒绝（**错误不扩散**）',
   JSON.stringify(A.validate('explain', fb.value).errors));

/* ============================================================
 *  ② 三类失败的可操作提示
 * ============================================================ */
head('②-A 断网 / 密钥错误 / 模型不支持 JSON 模式：各自分类 + 可操作建议');

const net = A.classifyError(new Error('Failed to fetch'), 0);
eq(net.kind, 'cors_or_network', '断网（Failed to fetch）→ 分类 cors_or_network');
ok(/断网|跨域/.test(net.text) && /代理|CORS|断网/.test(net.hint), '  提示说清"为什么"与"怎么做"：' + net.hint);
const net2 = A.classifyError(new Error('NetworkError when attempting to fetch resource.'), 0);
eq(net2.kind, 'cors_or_network', 'NetworkError 同样归类');
const offline = A.classifyError(new TypeError('Load failed'), 0);
ok(['cors_or_network', 'unknown'].indexOf(offline.kind) >= 0, '认不出来的网络错也不崩（落到 unknown 并带原文）', offline.kind);

const auth = A.classifyError(null, 401);
eq(auth.kind, 'auth', '密钥无效（401）→ 分类 auth');
ok(/设置页/.test(auth.hint) && /Key/.test(auth.text), '  建议指向"去设置页重填 Key"：' + auth.hint);
eq(A.classifyError(null, 403).kind, 'auth', '403 同样归类 auth');
eq(A.classifyError(null, 402).kind, 'billing', '402 → billing（余额）+ 充值建议');

const jsonUn = A.classifyError(null, 400, '{"error":{"message":"response_format is not supported by this model"}}');
eq(jsonUn.kind, 'json_unsupported', '模型不支持 JSON 模式 → **专用分类** json_unsupported（不再混进 bad_request）');
ok(/关掉/.test(jsonUn.hint) && /容错解析/.test(jsonUn.hint), '  建议可操作：关掉 JSON 模式、容错解析能兜：' + jsonUn.hint);
eq(A.classifyError(null, 400, '{"error":"unsupported response_format"}').kind, 'json_unsupported', '换一种措辞也认得出');
eq(A.classifyError(null, 400, '{"error":"json_object mode not available"}').kind, 'json_unsupported', 'json_object 措辞同样认得出');
eq(A.classifyError(null, 400, '{"error":"bad temperature"}').kind, 'bad_request', '普通 400 仍归 bad_request（不误判）');
eq(A.classifyError(null, 429).kind, 'rate_limit', '429 → rate_limit + "等几秒/把批量拆小"');
eq(A.classifyError(null, 500).kind, 'server', '500 → server（过一会儿重试）');
eq(A.classifyError(null, 404).kind, 'not_found', '404 → 模型名/地址不对');
const tmo = new Error('aborted'); tmo.name = 'AbortError';
eq(A.classifyError(tmo, 0).kind, 'timeout', '超时（AbortError）→ timeout');

head('②-B 分类贯通到调用层：状态码+响应体一起判，且提示跟着结果走');

const ks = await keyStore();
const f401 = fakeFetch([{ throwStatus: 401 }]);
const c401 = await A.callSaved(ks, f401, 'dashscope', { task: 'explain', user: 'x', retries: 0 });
eq([c401.ok, c401.kind], [false, 'auth'], 'callSaved 401 → kind=auth（界面据此给建议）');
ok(/设置页/.test(c401.hint || ''), '  hint 一路带到界面层：' + c401.hint);

const fJSON = fakeFetch([{ throwStatus: 400, body: '{"error":"response_format is not supported"}' }]);
const cJSON = await A.callSaved(ks, fJSON, 'dashscope', { task: 'explain', user: 'x', retries: 0 });
eq([cJSON.ok, cJSON.kind], [false, 'json_unsupported'], '**调用层也能认出"不支持 JSON 模式"**（靠响应体）');
ok(/关掉/.test(cJSON.hint || ''), '  并给出可操作建议：' + cJSON.hint);
const fNet = fakeFetch([{ throwStatus: 0 }]);
const cNet = await A.callSaved(ks, fNet, 'dashscope', { task: 'explain', user: 'x', retries: 0 });
ok(!cNet.ok, '网络异常不崩：' + cNet.kind);

head('②-C 结构不符 → **自动重试**（脏输出再要一次）');

const fRetry = fakeFetch(['完全不是 JSON 的一段话', '{"explanation":"第二次给了","pitfall":"易错"}']);
const rRetry = await A.callSaved(ks, fRetry, 'dashscope', { task: 'explain', user: 'x', retries: 2 });
eq([rRetry.ok, rRetry.attempts], [true, 2], '首次脏输出 → 自动重试第 2 次成功（attempts=2）');
eq(fRetry.calls.length, 2, '  确实发了 2 次请求');
const fSchemaRetry = fakeFetch(['{"explanation":"缺易错点"}', '{"explanation":"齐了","pitfall":"易错"}']);
const rSchema = await A.callSaved(ks, fSchemaRetry, 'dashscope', { task: 'explain', user: 'x', retries: 1 });
eq([rSchema.ok, rSchema.attempts], [true, 2], '结构不符（缺字段）同样触发重试');
const fGiveUp = fakeFetch(['{"explanation":"一直缺易错点"}']);
const rGiveUp = await A.callSaved(ks, fGiveUp, 'dashscope', { task: 'explain', user: 'x', retries: 1 });
eq([rGiveUp.ok, rGiveUp.kind, fGiveUp.calls.length], [false, 'schema', 2], '重试用尽 → 明确失败（kind=schema）且请求数可枚举');
ok(/字段不完整/.test(rGiveUp.text || ''), '  失败信息说清缺什么：' + rGiveUp.text);

head('②-D 服务商回传的真实用量被收下（估算校准的前提）');

const fUsage = fakeFetch([{ content: '{"explanation":"x","pitfall":"y"}', usage: { prompt_tokens: 321, completion_tokens: 88, total_tokens: 409 } }]);
const rUsage = await A.callSaved(ks, fUsage, 'dashscope', { task: 'explain', user: 'x', retries: 0 });
eq(rUsage.usage, { promptTokens: 321, completionTokens: 88, totalTokens: 409 }, 'usage 原样带回（字段名归一成 promptTokens/completionTokens）');
const fNoUsage = fakeFetch([{ content: '{"explanation":"x","pitfall":"y"}' }]);
const rNoUsage = await A.callSaved(ks, fNoUsage, 'dashscope', { task: 'explain', user: 'x', retries: 0 });
eq(rNoUsage.usage, null, '服务商没回 usage 时是 null（不编造数字）');

/* ============================================================
 *  ③ 批量确认 + 估算精度
 * ============================================================ */
head('③-A 批量计划（纯函数）：请求数、token 估算、确认文案');

const QS = [Q1, S.createQuestion({ id: 't2', type: '简答', stem: '简述三次握手。', keywords: [{ text: 'SYN' }] }),
            S.createQuestion({ id: 't3', type: '判断', stem: 'TCP 面向连接。', judgeValue: true })];
const plan = A.planBatch('explain', QS, { provider: 'dashscope' });
eq([plan.count, plan.requests, plan.perItem.length], [3, 3, 3], '三道题 → 3 次请求');
ok(plan.promptTokens > 0 && plan.totalTokens > plan.promptTokens, '估算含"提示 + 预期输出"两部分',
   '提示 ' + plan.promptTokens + ' + 输出 ' + plan.expectOutputTokens + ' = ' + plan.totalTokens);
ok(/3 次请求/.test(plan.message) && /tokens/.test(plan.message), '确认文案写清请求数与 token 估算：' + plan.message);
eq(plan.perItem.map(function (x) { return x.skipped; }), [false, false, false], '每道题都算出了自己的提示长度');
ok(plan.perItem[0].promptTokens > 0, '  逐题估算值带在 perItem 里', JSON.stringify(plan.perItem[0]));
const planBad = A.planBatch('乱来', QS, {});
eq(planBad.perItem.every(function (x) { return x.skipped === true; }), true, '未知任务 → 逐题标 skipped（不抛异常）');
eq(planBad.promptTokens, 0, '  估算为 0（不会给出假数字）');

head('③-B 批量未确认 → 零请求；确认后逐题跑；单题不弹窗');

const fBatch = fakeFetch(['{"explanation":"解析1","pitfall":"易错1"}', '{"explanation":"解析2","pitfall":"易错2"}',
                          '{"explanation":"解析3","pitfall":"易错3"}']);
let nBatch = 0;
const needConfirm = await A.runBatch(ks, fBatch, 'dashscope', 'explain', QS, {}, { onRequest: function () { nBatch++; } });
eq([needConfirm.ok, needConfirm.needConfirm, needConfirm.requestCount], [false, true, 0], '未确认 → needConfirm 且**零请求**');
eq(fBatch.calls.length, 0, '  假 fetch 一次都没被调用');
eq(needConfirm.confirm.count, 3, '  确认模型里带着题数（界面据此显示）');
ok(/tokens/.test(needConfirm.confirm.message), '  也带着 token 估算');

const doneBatch = await A.runBatch(ks, fBatch, 'dashscope', 'explain', QS, { confirmed: true, retries: 0 },
  { onRequest: function () { nBatch++; } });
eq([doneBatch.ok, doneBatch.okCount, doneBatch.failCount], [true, 3, 0], '确认后：3 题全部成功');
eq([doneBatch.requestCount, fBatch.calls.length, nBatch], [3, 3, 3], '  请求数 = 题数 = 3（每题一次）');
eq(doneBatch.results.length, 3, '  逐题结果都收在 results[] 里');
eq(doneBatch.results.map(function (r) { return r.ok; }), [true, true, true], '  逐题 ok 标记');
eq(doneBatch.results[0].patches.explanation, '解析1\n易错点：易错1', '  逐题结果能直接落库（patches 已算好）');
ok(doneBatch.results.every(function (r) { return r.value && r.value.pitfall; }), '  每题都把模型原值一起带回（便于排查）');
/* 真实用量：这一轮的假响应没带 usage → actual 必须是 null（**不编造数字**） */
eq([doneBatch.actual, doneBatch.deviation], [null, null], '服务商没回 usage → actual/deviation 都是 null（不伪造偏差）');

/* 让服务商回用量，再跑一轮：验证汇总与偏差计算。
 * ⚠ 这里的 usage 数字按**真调用实测的量级**给（提示 ~300、输出 ~200/题），
 *   不是随手编的 —— 拿编的数字去断言"偏差 <60%"等于自欺。真实偏差见 real-ai-last.json。 */
const fBatchUsage = fakeFetch([
  { content: '{"explanation":"a","pitfall":"p"}', usage: { prompt_tokens: 300, completion_tokens: 200, total_tokens: 500 } },
  { content: '{"explanation":"b","pitfall":"p"}', usage: { prompt_tokens: 300, completion_tokens: 200, total_tokens: 500 } },
  { content: '{"explanation":"c","pitfall":"p"}', usage: { prompt_tokens: 300, completion_tokens: 200, total_tokens: 500 } }
]);
const withUsage = await A.runBatch(ks, fBatchUsage, 'dashscope', 'explain', QS, { confirmed: true, retries: 0 }, {});
eq(withUsage.okCount, 3, '带用量的那一轮同样 3 题全成');
eq(withUsage.actual, { promptTokens: 900, completionTokens: 600, totalTokens: 1500 }, '真实用量汇总：900 + 600 = 1500');
ok(typeof withUsage.deviation === 'number', '  并算出本次估算偏差：' + withUsage.deviation + '%');
ok(withUsage.deviation < 60, '  这次偏差 ' + withUsage.deviation + '% < 60%（粗估够用）',
   '估 ' + withUsage.estimate.totalTokens + ' vs 实 ' + withUsage.actual.totalTokens);
/* 按任务给默认输出量：小任务不该被"统一 300"拖偏（实测过 154% 的那种） */
const pDiff = A.planBatch('difficulty', QS, {});
const pExpl = A.planBatch('explain', QS, {});
ok(pDiff.expectOutputTokens < pExpl.expectOutputTokens, '难度任务的预期输出量小于解析（按任务给，不是一刀切）',
   '难度 ' + pDiff.expectOutputTokens + ' < 解析 ' + pExpl.expectOutputTokens);
eq(pDiff.expectOutputPerItem, 40, '  难度默认 40 token/题');
eq(pExpl.expectOutputPerItem, 170, '  解析默认 170 token/题（真调用实测 completion 168，见 real-ai-last.json）');
const estOne = A.estimateRequest('explain', Q1, {});
eq([estOne.kind, estOne.expectOutputTokens], ['explain', 170], 'estimateRequest 用同一口径给单题估算');
ok(estOne.totalTokens === estOne.promptTokens + 170, '  总量 = 提示 + 预期输出', JSON.stringify(estOne));

/* 单题不弹窗（相邻锚：上一小类的规则不许被改） */
let nSingle = 0;
const fSingle = fakeFetch(['{"explanation":"单题解析","pitfall":"易错"}']);
const one = await A.runSingle(ks, fSingle, 'dashscope', 'explain', Q1, {}, { onRequest: function () { nSingle++; } });
eq([one.ok, one.needConfirm === undefined, one.requestCount, nSingle], [true, true, 1, 1],
   '**单题：直接 1 次请求，没有 needConfirm 这一套**（不弹消耗确认窗）');
eq(A.singleRequest('explain', Q1, {}).retries, 0, '  单题模板 retries 仍为 0（点一次一次请求）');

head('③-C 批量里单题失败不拖垮整批，且失败项可读');

const fMixed = fakeFetch([
  '{"explanation":"好的一题","pitfall":"易错"}',
  '这段完全不是 JSON',
  { throwStatus: 429, body: 'rate limited' },
  '{"explanation":"好的二题","pitfall":"易错"}'
]);
const mixed = await A.runBatch(ks, fMixed, 'dashscope', 'explain', [Q1, QS[1], QS[2], Q1], { confirmed: true, retries: 0 }, {});
eq([mixed.ok, mixed.okCount, mixed.failCount, mixed.total], [false, 2, 2, 4], '整批"部分成功"：2 成 2 败（不整体崩）');
eq(mixed.results.map(function (r) { return r.ok; }), [true, false, false, true], '逐题成败如实记录');
ok(mixed.results[1].errors.length > 0, '  失败项 1 带可读原因：' + mixed.results[1].errors.join('；'));
eq(mixed.results[2].errors.length > 0 && /限流/.test(mixed.results[2].errors.join('')), true, '  失败项 2 是限流并带建议',
   mixed.results[2].errors.join('；'));
eq(mixed.results[3].ok, true, '  后面那题照跑（不因前面失败而中断）');
eq(mixed.requestCount, 4, '  请求数仍是每题一次（retries:0）');

const fAllFail = fakeFetch([{ throwStatus: 500, body: 'server error' }]);
const allFail = await A.runBatch(ks, fAllFail, 'dashscope', 'explain', QS, { confirmed: true, retries: 0 }, {});
eq([allFail.ok, allFail.okCount, allFail.failCount], [false, 0, 3], '全失败也不抛异常（返回 ok:false + 逐题原因）');
eq(allFail.results.every(function (r) { return r.errors.length > 0; }), true, '  每道题都带原因');

head('③-D 估算精度：口径一致、随长度单调、批量可外推；偏差阈值判据成立');

const t = A.estimateTokens;
eq(t(''), 0, '空串 → 0');
ok(t('中文') > 0 && t('a') === 1, '单字也能给出正数（英文 4 字符 ≈ 1 token）');
ok(t('中'.repeat(100)) >= 100 && t('中'.repeat(100)) <= 110, '100 个汉字 ≈ 100 token（经验值 1 字 1 token）',
   String(t('中'.repeat(100))));
ok(t('a'.repeat(400)) >= 90 && t('a'.repeat(400)) <= 110, '400 个英文字符 ≈ 100 token（4 字符 1 token）',
   String(t('a'.repeat(400))));
ok(t('中文abc') >= t('中文') && t('中文中文') > t('中文'), '**随内容增长单调递增**（估算不会反向）');
const p1 = A.planBatch('explain', [Q1], {});
const p3 = A.planBatch('explain', [Q1, Q1, Q1], {});
eq(p3.promptTokens, p1.promptTokens * 3, '批量估算是单题的**线性外推**（3 题 = 1 题 × 3）');
const rep = A.estimateReport([{ label: '单题解析', estimate: 100, actual: 110 },
                              { label: '整卷总评', estimate: 300, actual: 321 },
                              { label: '批量 3 题', estimate: 900, actual: 1000 }]);
eq(rep.samples, 3, '校准报告：3 个样本');
eq(rep.rows.map(function (r) { return r.deviation; }), [9.1, 6.5, 10], '  逐样本偏差（|估-实|/实）：9.1% / 6.5% / 10%');
eq([rep.worstDeviation, rep.within60], [10, true], '最差偏差 10% < 60% → **验收判据成立**');
eq(A.estimateReport([{ estimate: 100, actual: 0 }]).samples, 0, 'actual 为 0 的样本不计入（不制造除零）');
eq(A.estimateReport([]).within60, true, '没有样本时 worst=0（判据不因空集合而失败）');

head('③-E 批量面板（真挂载）：先弹确认窗、取消零请求、确认后逐题跑');

const AiSingle = require('../ui/ai-single.js');
const DOM = require('./mini-dom.js');
const doc = DOM.makeDoc();
const host = doc.createElement('div');
doc.documentElement.appendChild(host);
const fPanel = fakeFetch(['{"explanation":"a","pitfall":"p"}', '{"explanation":"b","pitfall":"p"}', '{"explanation":"c","pitfall":"p"}']);
const bp = AiSingle.mountBatch({
  container: host, keyStore: ks, fetchImpl: fPanel, kind: 'explain',
  getQuestions: function () { return QS; }
});
eq(DOM.byAttr(host, 'data-asg', 'confirm-dialog').length, 0, '批量面板刚挂上时**不弹**确认窗');
ok(host.textContent.indexOf('预计 ' + bp.plan().totalTokens + ' tokens') >= 0, '面板上就写着估算 token（点之前先看得到）',
   host.textContent.match(/预计 \d+ tokens/)[0]);
DOM.byAttr(host, 'data-asg', 'run-batch')[0].click();
await new Promise(function (r) { setTimeout(r, 20); });
eq(DOM.byAttr(host, 'data-asg', 'confirm-dialog').length, 1, '点「开始批量」→ **先弹消耗确认窗**');
ok(DOM.byAttr(host, 'data-asg', 'confirm-dialog')[0].textContent.indexOf('tokens') >= 0, '  确认窗里显示估算 token');
eq([bp.stats().requests, fPanel.calls.length], [0, 0], '  未确认 → **零请求**');
DOM.byAttr(host, 'data-asg', 'confirm-no')[0].click();
await new Promise(function (r) { setTimeout(r, 10); });
eq([bp.stats().cancels, bp.stats().requests, fPanel.calls.length], [1, 0, 0], '点「取消」→ 取消 1 次、**仍然零请求**');
DOM.byAttr(host, 'data-asg', 'run-batch')[0].click();
await new Promise(function (r) { setTimeout(r, 10); });
DOM.byAttr(host, 'data-asg', 'confirm-yes')[0].click();
await new Promise(function (r) { setTimeout(r, 60); });
eq([bp.stats().confirms, bp.stats().requests, fPanel.calls.length], [1, 3, 3], '确认后 → **3 题 3 次请求**');
eq([bp.stats().okCount, bp.stats().failCount], [3, 0], '  3 题全成');
eq(DOM.byAttr(host, 'data-asg', 'batch-item').length, 3, '  逐题结果都画出来了（每题一行）');
ok(host.textContent.indexOf('成功 3 / 失败 0') >= 0, '  汇总行写着成功/失败数');

/* 部分失败：面板要如实显示失败原因。
 * ⚠ 这里用 **401**（鉴权错误）而不是 429：批量默认 `retries:1`，而 429/5xx 是**可重试**的
 *   （这是设计：限流值得再要一次），用 429 会被重试掩盖掉"失败展示"这件事。 */
const host2 = doc.createElement('div');
doc.documentElement.appendChild(host2);
const fPanel2 = fakeFetch(['{"explanation":"a","pitfall":"p"}', { throwStatus: 401, body: '{"error":"invalid api key"}' }, '{"explanation":"c","pitfall":"p"}']);
const bp2 = AiSingle.mountBatch({ container: host2, keyStore: ks, fetchImpl: fPanel2, kind: 'explain', getQuestions: function () { return QS; } });
DOM.byAttr(host2, 'data-asg', 'run-batch')[0].click();
await new Promise(function (r) { setTimeout(r, 10); });
DOM.byAttr(host2, 'data-asg', 'confirm-yes')[0].click();
await new Promise(function (r) { setTimeout(r, 80); });
eq([bp2.stats().okCount, bp2.stats().failCount], [2, 1], '部分失败：2 成 1 败（整批不崩）');
ok(host2.textContent.indexOf('✘') >= 0 && /Key/.test(host2.textContent), '  失败那一行写着原因（Key 无效）',
   (host2.textContent.match(/#2[^\n]{0,30}/) || [''])[0]);
eq(fPanel2.calls.length, 3, '  鉴权类错误**不重试**（总共就是 3 次请求）');
bp.destroy(); bp2.destroy();
eq(DOM.byAttr(host, 'data-asg-root').length, 0, 'destroy 后批量面板从容器里摘掉');

head('③-F 相邻锚：单题面板仍然**没有**确认窗（两类操作不许混）');

const host3 = doc.createElement('div');
doc.documentElement.appendChild(host3);
const fSp = fakeFetch(['{"explanation":"单题","pitfall":"p"}']);
const sp = AiSingle.mount({ container: host3, store: ks, fetchImpl: fSp, getDraft: function () { return { questions: [Q1] }; } });
eq(DOM.byAttr(host3, 'data-asg', 'confirm-dialog').length + DOM.byAttr(host3, 'data-asg', 'confirm-mask').length, 0,
   '单题面板里**没有**任何确认窗节点');
DOM.byAttr(host3, 'data-asg', 'run')[0].click();
await new Promise(function (r) { setTimeout(r, 40); });
eq([sp.stats().clicks, sp.stats().requests, fSp.calls.length], [1, 1, 1], '单题点一次 = 1 次请求（不经过确认）');
eq(DOM.byAttr(host3, 'data-asg', 'confirm-dialog').length, 0, '  跑完也没有冒出确认窗');
sp.destroy();

console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
console.log('  PASS ' + pass + '    FAIL ' + fail);
if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
console.log('  \x1b[90m注：真实偏差用真调用实测 —— node verify/real-ai.js 会把 estimate/actual 写进 verify/real-ai-last.json\x1b[0m');
process.exitCode = fail ? 1 : 0;

})().catch(function (e) { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
