/* 容错与提示 · 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-ai-tolerant-old.js
 * 每行必须打印 "锚变红=true"；出现 false 说明那条断言在测空气。
 */
const fs = require('fs');
const path = require('path');
const HERE = path.join(__dirname, '..');
function loadFrom(rel, mutate, tmpRel) {
  const src = fs.readFileSync(path.join(HERE, rel), 'utf8');
  const out = mutate(src);
  if (out === src) throw new Error('探针失效：没替换到目标文本（' + rel + '）');
  const tmp = path.join(HERE, tmpRel);
  fs.writeFileSync(tmp, out);
  delete require.cache[require.resolve(tmp)];
  return require(tmp);
}
function rm(rel) { try { fs.unlinkSync(path.join(HERE, rel)); } catch (e) { /* ignore */ } }

const S = require('../core/schema.js');
const CANARY = 'sk-canary-9f3a7c1e5b2d4680zz';
const Q1 = S.createQuestion({ id: 't1', type: '单选', stem: 'HTTP 默认端口？', options: [{ label: 'A', text: '21' }, { label: 'B', text: '80' }], answerLetters: ['B'], answer: 'B' });
const QS = [Q1, S.createQuestion({ id: 't2', type: '判断', stem: 'TCP 面向连接。', judgeValue: true })];

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
async function keyStoreFor(A) {
  const bk = backend();
  const st = A.openKeyStore(bk);
  await A.saveKey(st, 'dashscope', CANARY);
  return A.openKeyStore(bk);
}
function fakeFetch(plan) {
  const calls = [];
  const f = async function (url, init) {
    calls.push(url);
    const pick = plan[Math.min(calls.length - 1, plan.length - 1)];
    if (pick && pick.throwStatus) return { ok: false, status: pick.throwStatus, text: async () => (pick.body || '{}') };
    const content = (typeof pick === 'string') ? pick : ((pick && pick.content) || '{}');
    const pack = { choices: [{ message: { content: content } }] };
    if (pick && pick.usage) pack.usage = pick.usage;
    return { ok: true, status: 200, text: async () => JSON.stringify(pack) };
  };
  f.calls = calls;
  return f;
}

const results = [];
function probe(name, fn) {
  let red = false, note = '';
  try { const r = fn(); red = (r === true); if (typeof r === 'string') note = r; else if (r !== true) note = JSON.stringify(r); }
  catch (e) { red = '抛错:' + (e && e.message); }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red + (note ? '   ' + note : ''));
}
async function probeAsync(name, fn) {
  let red = false, note = '';
  try { const r = await fn(); red = (r === true); if (typeof r === 'string') note = r; else if (r !== true) note = JSON.stringify(r); }
  catch (e) { red = '抛错:' + (e && e.message); }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red + (note ? '   ' + note : ''));
}

(async function main() {

/* ---- 1. 去代码围栏 + 平衡块裁剪都失效（类1 靠这两道一起兜住） ----
 * ⚠ 只拆"去围栏"是**不够**的：`firstBalancedBlock` 还能把围栏里的 JSON 抠出来 ——
 *   也就是说真正兜住这一类的是"平衡块裁剪"。所以这条探针两道一起拆，
 *   并看**策略**有没有退化（test 里断言非兜底类必须是 direct/repaired）。 */
probe('① 不去围栏且不裁平衡块 → 类1「代码围栏」锚变红', function () {
  const A = loadFrom('core/ai.js',
    s => s.replace("    const fence = t.match(/```(?:json|JSON)?\\s*([\\s\\S]*?)```/);", '    const fence = null;')
          .replace("    else if (/```/.test(t)) { t = t.replace(/```(?:json|JSON)?/g, ''); fixes.push('去半截代码围栏'); }", '')
          .replace('    const block = firstBalancedBlock(t);', '    const block = null;'),
    'core/__probe_tol1.js');
  try {
    const r = A.safeParseJson('```json\n{"explanation":"解析","pitfall":"易错"}\n```');
    return (r.ok === false || r.strategy === 'fieldFallback') ? true : '策略仍是 ' + r.strategy;
  } finally { rm('core/__probe_tol1.js'); }
});

/* ---- 2. 中文引号不归一 ---- */
probe('② 中文引号不归一 → 类4「中文引号」锚变红', function () {
  const A = loadFrom('core/ai.js',
    s => s.replace("    if (/[“”]/.test(t)) { t = t.replace(/[“”]/g, '\"'); fixes.push('中文双引号→半角'); }", ''),
    'core/__probe_tol2.js');
  try {
    const r = A.safeParseJson('{“explanation”:“解析”,“pitfall”:“易错”}');
    return r.ok === false ? true : '竟然还是解析出来了';
  } finally { rm('core/__probe_tol2.js'); }
});

/* ---- 3. 真实换行不转义（策略会退化：值可能被抽取救回来，但**策略**变了） ----
 * ⚠ 这条只能看策略：`extractFields` 的 `"explanation":"([^"]*)"` 恰好能连换行一起captured，
 *   所以"值对不对"分辨不出来；而 test 里断言非兜底类必须是 direct/repaired —— 看策略才准。 */
probe('③ 不转义字符串里的真实换行 → 类10 锚变红（看策略）', function () {
  const A = loadFrom('core/ai.js',
    s => s.replace("        if (c === '\\n') { out += '\\\\n'; continue; }", '        if (c === \'\\n\') { out += c; continue; }'),
    'core/__probe_tol3.js');
  try {
    const r = A.safeParseJson('{"explanation":"第一行\n第二行","pitfall":"易错"}');
    return (r.strategy !== 'direct' && r.strategy !== 'repaired') ? true : '策略仍是 ' + r.strategy;
  } finally { rm('core/__probe_tol3.js'); }
});

/* ---- 4. 字段抽取兜底被拆（散文直接崩） ---- */
probe('④ 去掉字段抽取兜底 → 类12「散文降级」锚变红', function () {
  const A = loadFrom('core/ai.js',
    s => s.replace('      const fb = extractFields(original);', '      const fb = null;'),
    'core/__probe_tol4.js');
  try {
    const r = A.safeParseJson('这道题的答案是 B。\n解析：80 是默认端口。');
    return r.ok === false ? true : '竟然还是抽出来了';
  } finally { rm('core/__probe_tol4.js'); }
});

/* ---- 5. 抽取兜底抛异常（那就"崩页"了） ---- */
probe('⑤ 抽取兜底抛异常 → ①「不抛异常」锚变红', function () {
  const A = loadFrom('core/ai.js',
    s => s.replace('  function extractFields(text) {', '  function extractFields(text) { throw new Error(\'抽取炸了\');'),
    'core/__probe_tol5.js');
  try {
    let threw = false;
    try { A.safeParseJson('这道题的答案是 B。'); } catch (e) { threw = true; }
    return threw ? true : '居然没抛';
  } finally { rm('core/__probe_tol5.js'); }
});

/* ---- 6. 不支持 JSON 模式不单独分类（混进 bad_request） ---- */
probe('⑥ 不认"不支持 JSON 模式" → ②-A 专用分类锚变红', function () {
  const A = loadFrom('core/ai.js',
    s => s.replace("    if (/response_format|json_object|json mode|does not support[^.]*json/.test(b)) {", '    if (false) {'),
    'core/__probe_tol6.js');
  try {
    const c = A.classifyError(null, 400, '{"error":"response_format is not supported"}');
    return c.kind !== 'json_unsupported' ? true : '居然还是分对了';
  } finally { rm('core/__probe_tol6.js'); }
});

/* ---- 7. 调用层不看响应体（拿不到"不支持 JSON 模式"这条判据） ---- */
await probeAsync('⑦ callAi 不把响应体交给分类器 → ②-B 锚变红', async function () {
  const A = loadFrom('core/ai.js',
    s => s.replace('          const c = classifyError(null, resp.status, text);', '          const c = classifyError(null, resp.status);'),
    'core/__probe_tol7.js');
  try {
    const st = await keyStoreFor(A);
    const f = fakeFetch([{ throwStatus: 400, body: '{"error":"response_format is not supported"}' }]);
    const r = await A.callSaved(st, f, 'dashscope', { task: 'explain', user: 'x', retries: 0 });
    return r.kind !== 'json_unsupported' ? true : '居然还是分对了：' + r.kind;
  } finally { rm('core/__probe_tol7.js'); }
});

/* ---- 8. 批量不做前置确认（未确认也照发） ---- */
await probeAsync('⑧ 批量未确认也发请求 → ③-B「零请求」锚变红', async function () {
  const A = loadFrom('core/ai.js',
    s => s.replace('    if (o.confirmed !== true) return { ok: false, needConfirm: true, confirm: plan, plan: plan, requestCount: 0 };', ''),
    'core/__probe_tol8.js');
  try {
    const st = await keyStoreFor(A);
    const f = fakeFetch(['{"explanation":"a","pitfall":"p"}']);
    let n = 0;
    await A.runBatch(st, f, 'dashscope', 'explain', QS, {}, { onRequest: function () { n++; } });
    return n > 0 ? true : '居然还是零请求';
  } finally { rm('core/__probe_tol8.js'); }
});

/* ---- 9. 预期输出量一刀切（小任务偏差爆掉） ---- */
probe('⑨ 输出量一刀切 300 → ③-C「按任务给」锚变红', function () {
  const A = loadFrom('core/ai.js',
    s => s.replace("    const perOut = (o.expectOutputTokens != null ? o.expectOutputTokens : (EXPECT_OUT[kind] || 200));",
                   '    const perOut = (o.expectOutputTokens != null ? o.expectOutputTokens : 300);'),
    'core/__probe_tol9.js');
  try {
    const p = A.planBatch('difficulty', QS, {});
    return p.expectOutputPerItem !== 40 ? true : '竟然还是 40';
  } finally { rm('core/__probe_tol9.js'); }
});

/* ---- 10. usage 不进结果（没法校准、也没法算偏差） ---- */
await probeAsync('⑩ 不收 usage → ②-D「usage 原样带回」锚变红', async function () {
  const A = loadFrom('core/ai.js',
    s => s.replace('          if (j.usage && typeof j.usage === \'object\') {', '          if (false) {'),
    'core/__probe_tol10.js');
  try {
    const st = await keyStoreFor(A);
    const f = fakeFetch([{ content: '{"explanation":"x","pitfall":"y"}', usage: { prompt_tokens: 321, completion_tokens: 88, total_tokens: 409 } }]);
    const r = await A.callSaved(st, f, 'dashscope', { task: 'explain', user: 'x', retries: 0 });
    return !r.usage ? true : '居然还带着 usage';
  } finally { rm('core/__probe_tol10.js'); }
});

/* ---- 11. 单题也走批量那条确认路（把"单题不弹窗"弄丢） ---- */
probe('⑪ 单题模板默认重试 → ③-B「单题 retries=0」锚变红', function () {
  const A = loadFrom('core/ai.js',
    s => s.replace('      retries: (o.retries != null ? o.retries : 0)', '      retries: (o.retries != null ? o.retries : 2)'),
    'core/__probe_tol11.js');
  try {
    return A.singleRequest('explain', Q1, {}).retries !== 0 ? true : 'retries 仍是 0';
  } finally { rm('core/__probe_tol11.js'); }
});

const bad = results.filter(r => r[1] !== true);
console.log('\n探针汇总：' + results.length + ' 条  全部能让锚变红=' + (bad.length === 0));
if (bad.length) { bad.forEach(b => console.log('  未变红：' + b[0] + ' → ' + b[1])); process.exitCode = 1; }

})();
