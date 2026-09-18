/* 单题智能生成 · 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-ai-single-old.js
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
const ORIGIN = S.createQuestion({
  id: 'q_origin', type: '单选', stem: 'HTTP 默认端口是哪个？',
  options: [{ label: 'A', text: '21' }, { label: 'B', text: '80' }, { label: 'C', text: '443' }],
  answerLetters: ['A'], answer: 'A', explanation: ''
});
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
function fakeFetch(plan) {
  const calls = [];
  const f = async function (url, init) {
    calls.push(url);
    const pick = plan[Math.min(calls.length - 1, plan.length - 1)];
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: typeof pick === 'string' ? pick : JSON.stringify(pick) } }] }) };
  };
  f.calls = calls;
  return f;
}
async function storeWithKey(A) {
  const bk = backend();
  const st = A.openKeyStore(bk);
  await A.saveKey(st, 'dashscope', CANARY);
  return A.openKeyStore(bk);
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

/* ---- 1. 解析不要求易错点（回到"只在提示词里拜托模型"的旧写法） ---- */
probe('① explain 不要求 pitfall → ①-A「缺易错点就拒绝」锚变红', function () {
  const A = loadFrom('core/ai.js',
    s => s.replace("    explain: { explanation: 'string', pitfall: 'string' },", "    explain: { explanation: 'string' },"),
    'core/__probe_as1.js');
  try {
    const r = A.checkResult('explain', { explanation: '只给解析' });
    return r.ok === true ? true : '仍然被拒：' + JSON.stringify(r.errors);
  } finally { rm('core/__probe_as1.js'); }
});

/* ---- 2. 难度不要求整数（3.5 也放行） ---- */
probe('② 难度只判范围不判整数 → ①-C「必须 1-5 整数」锚变红', function () {
  const A = loadFrom('core/ai.js',
    s => s.replace("    difficulty: { level: 'intLevel' },", "    difficulty: { level: 'level' },"),
    'core/__probe_as2.js');
  try {
    const r = A.checkResult('difficulty', { level: 3.5 });
    return r.ok === true ? true : '仍然被拒：' + JSON.stringify(r.errors);
  } finally { rm('core/__probe_as2.js'); }
});

/* ---- 3. 变式题不检查"是不是把原题抄了一遍" ---- */
probe('③ 变式题不查抄原题 → ①-B「不能原样抄」锚变红', function () {
  const A = loadFrom('core/ai.js',
    s => s.replace(" if (origin && String(q.stem).trim() === String(origin.stem || '').trim()) problems.push('变式题题干与原题一模一样（要求换题面，不能原样抄）');", ''),
    'core/__probe_as3.js');
  try {
    const r = A.checkResult('variant', { type: '单选', stem: ORIGIN.stem, answer: 'A', options: [{ label: 'A', text: 'x' }, { label: 'B', text: 'y' }] }, ORIGIN);
    return r.ok === true ? true : '仍然被拒：' + JSON.stringify(r.errors);
  } finally { rm('core/__probe_as3.js'); }
});

/* ---- 4. 变式题跳过"四件套"闸门（只过 validate） ---- */
probe('④ 跳过四件套闸门 → ①-B「选项/答案不齐也拒绝」锚变红', function () {
  const A = loadFrom('core/ai.js',
    s => s.replace('    if (kind === \'variant\') {\n      const b = buildVariant(value, origin);',
                   '    if (false) {\n      const b = buildVariant(value, origin);'),
    'core/__probe_as4.js');
  try {
    const r = A.checkResult('variant', { type: '多选', stem: '新题面', answer: 'A', options: [{ label: 'A', text: 'x' }, { label: 'B', text: 'y' }] }, ORIGIN);
    return r.ok === true ? true : '仍然被拒：' + JSON.stringify(r.errors);
  } finally { rm('core/__probe_as4.js'); }
});

/* ---- 5. 单题默认重试（点一次偷偷发多次） ---- */
probe('⑤ 单题默认重试 → ③「单题 retries=0」锚变红', function () {
  const A = loadFrom('core/ai.js',
    s => s.replace('      retries: (o.retries != null ? o.retries : 0)', '      retries: (o.retries != null ? o.retries : 2)'),
    'core/__probe_as5.js');
  try {
    const r = A.singleRequest('explain', ORIGIN, {});
    return r.retries !== 0 ? true : 'retries 仍是 0';
  } finally { rm('core/__probe_as5.js'); }
});

/* ---- 6. 被拒绝的结果也给出 patches（于是"拒绝"挡不住写入） ---- */
await probeAsync('⑥ 拒绝也返回 patches → ②「不写题库」锚变红', async function () {
  const A = loadFrom('core/ai.js',
    s => s.replace('    const g = checkResult(kind, value, origin);\n    if (!g.ok) return g;',
                   '    const g = checkResult(kind, value, origin);\n    if (!g.ok) return { ok: false, kind: kind, patches: { explanation: String(value && value.explanation || "") } };'),
    'core/__probe_as6.js');
  try {
    const r = A.applyResult(ORIGIN, 'explain', { explanation: '只有解析没有易错点' });
    return r.patches !== undefined ? true : '拒绝结果仍无 patches';
  } finally { rm('core/__probe_as6.js'); }
});

/* ---- 7. 没有题也照发请求（白烧一次调用） ---- */
await probeAsync('⑦ 去掉"没有题就拦住" → ④「null 题零请求」锚变红', async function () {
  const A = loadFrom('core/ai.js',
    s => s.replace("    if (!question || !String(question.stem == null ? '' : question.stem).trim()) {\n      return { ok: false, kind: kind, stage: 'no_question', errors: ['没有可操作的题目（题干为空）'], requestCount: 0 };\n    }", ''),
    'core/__probe_as7.js');
  try {
    const st = await storeWithKey(A);
    const f = fakeFetch([{ explanation: '解析', pitfall: '易错点' }]);
    const n = { v: 0 };
    const r = await A.runSingle(st, f, 'dashscope', 'explain', null, {}, { onRequest: function () { n.v++; } });
    return (r.ok === true || n.v > 0) ? true : '居然还是零请求：' + JSON.stringify(r);
  } finally { rm('core/__probe_as7.js'); }
});

/* ---- 8. 单题也走"整卷那条重试路"（脏 JSON 自动重发） ---- */
await probeAsync('⑧ 脏结构自动重发 → ③「假 fetch 只被调用 3 次」锚变红', async function () {
  const A = loadFrom('core/ai.js',
    s => s.replace('      retries: (o.retries != null ? o.retries : 0)', '      retries: (o.retries != null ? o.retries : 2)'),
    'core/__probe_as8.js');
  try {
    const st = await storeWithKey(A);
    const f = fakeFetch(['{"explanation":"第一次没给易错点"}', '{"explanation":"第二次给了","pitfall":"易错点"}']);
    const r = await A.runSingle(st, f, 'dashscope', 'explain', ORIGIN, {}, {});
    return f.calls.length > 1 ? true : '只发了 1 次（r=' + JSON.stringify(r).slice(0, 60) + '）';
  } finally { rm('core/__probe_as8.js'); }
});

const bad = results.filter(r => r[1] !== true);
console.log('\n探针汇总：' + results.length + ' 条  全部能让锚变红=' + (bad.length === 0));
if (bad.length) { bad.forEach(b => console.log('  未变红：' + b[0] + ' → ' + b[1])); process.exitCode = 1; }

})();
