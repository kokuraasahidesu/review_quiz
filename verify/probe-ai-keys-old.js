/* 密钥与供应商能力表 · 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-ai-keys-old.js
 * 每行必须打印 "锚变红=true"；出现 false 说明那条断言在测空气。
 *
 * 做法：把 core/ai.js 的源码**字符串替换**回"容易写错的那种写法"，再拿同一批断言去看会不会变红。
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

const D = require('../core/data.js');

function backend() {
  const m = new Map();
  return {
    getItem: k => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: k => { m.delete(k); },
    key: i => { const a = Array.from(m.keys()); return i < a.length ? a[i] : null; },
    get length() { return m.size; },
    rawKeys: () => Array.from(m.keys()),
    rawText: () => Array.from(m.values()).join('\n')
  };
}
const CANARY = 'sk-canary-9f3a7c1e5b2d4680zz';

const results = [];
function probe(name, fn) {
  let red = false, note = '';
  try { const r = fn(); red = r === true ? true : r; if (typeof r === 'string') note = r; }
  catch (e) { red = '抛错:' + (e && e.message); }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red + (note ? '   ' + note : ''));
}
async function probeAsync(name, fn) {
  let red = false, note = '';
  try { const r = await fn(); red = r === true ? true : r; if (typeof r === 'string') note = r; }
  catch (e) { red = '抛错:' + (e && e.message); }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red + (note ? '   ' + note : ''));
}

(async function main() {

/* ---- 1. 能力位漏写（undefined 混过去） ---- */
probe('① browserDirect 不显式声明 → ②-A「capabilityGaps 为空」锚变红', function () {
  const A = loadFrom('core/ai.js',
    s => s.replace("      browserDirect: true, directNote: '',\n      keyHint: '以 sk- 开头，控制台「API-KEY 管理」里创建',",
                   "      keyHint: '以 sk- 开头，控制台「API-KEY 管理」里创建',"),
    'core/__probe_ai1.js');
  try { const gaps = A.capabilityGaps(); return gaps.length > 0 ? true : 'gaps 仍为空（锚没红）'; }
  finally { rm('core/__probe_ai1.js'); }
});

/* ---- 2. 不可直连的家不写原因（只留个红标） ----
 * 注意：`rowOf` 里还有一条兜底文案，所以"界面不至于空白"这条不会红；
 * 会红的是**能力位自检**（capabilityGaps 报出 directNote 缺失）—— 那正是验收要的"明确标注"闸门。 */
probe('② 不可直连不写 directNote → ②-A「没有一家漏写能力位」锚变红', function () {
  const A = loadFrom('core/ai.js',
    s => s.replace("      directNote: '这家没有开放 CORS，浏览器（含本页）直连一定被拦。要用它得自己搭个中转（或换上面任意一家）。',", ''),
    'core/__probe_ai2.js');
  try {
    const gaps = A.capabilityGaps();
    return gaps.length > 0 ? true : 'gaps 仍为空（锚没红）';
  } finally { rm('core/__probe_ai2.js'); }
});

/* ---- 3. 把不可直连的家当成可直连（用户会被 CORS 拦在半路） ---- */
probe('③ browserDirect 全填 true → ②-B「不可直连必须明确标注」锚变红', function () {
  const A = loadFrom('core/ai.js',
    s => s.replace("      browserDirect: false,\n      directNote: '这家没有开放 CORS，浏览器（含本页）直连一定被拦。要用它得自己搭个中转（或换上面任意一家）。',",
                   "      browserDirect: true, directNote: '',"),
    'core/__probe_ai3.js');
  try {
    const blocked = A.providerRows().filter(r => !r.browserDirect);
    return blocked.length === 0 ? true : '居然还有 blocked：' + blocked.length;
  } finally { rm('core/__probe_ai3.js'); }
});

/* ---- 4. 密钥写进 app 命名空间（会跟着分享/导出那条路走） ---- */
await probeAsync('④ 密钥 store 用 app 命名空间 → ①-A「只写进独立命名空间」锚变红', async function () {
  const A = loadFrom('core/ai.js',
    s => s.replace("  const SECRET_NAMESPACE = 'secret';", "  const SECRET_NAMESPACE = 'app';"),
    'core/__probe_ai4.js');
  try {
    const bk = backend();
    const st = A.openKeyStore(bk);
    await A.saveKey(st, 'dashscope', CANARY);
    const keys = bk.rawKeys();
    return keys.every(k => k.indexOf('app::') === 0) ? true : '实际键：' + JSON.stringify(keys);
  } finally { rm('core/__probe_ai4.js'); }
});

/* ---- 5. 读不回原文（"能直接用于调用"就成了空话） ----
 * 注意：Key 在本地还在，`configured` 仍是 true → 请求照样发得出去，只是**请求头里是空的**。
 * 所以会红的是"请求头里就是刚保存的那把 Key"这条断言（比"有没有发请求"更要害）。 */
await probeAsync('⑤ readKey 不回原文 → ①-C「请求头里就是那把 Key」锚变红', async function () {
  const A = loadFrom('core/ai.js',
    s => s.replace('    return { ok: true, provider: providerKey, apiKey: hit ? String(hit.key) : \'\', at: hit ? hit.at : \'\', configured: !!hit };',
                   '    return { ok: true, provider: providerKey, apiKey: \'\', at: \'\', configured: !!hit };'),
    'core/__probe_ai5.js');
  try {
    const bk = backend();
    const st = A.openKeyStore(bk);
    await A.saveKey(st, 'dashscope', CANARY);
    const got = [];
    const fake = async function (url, init) { got.push(init.headers.Authorization); return { ok: true, status: 200, text: async () => '{}' }; };
    await A.callSaved(A.openKeyStore(bk), fake, 'dashscope', { task: 'difficulty', user: 'x' });
    return got[0] !== 'Bearer ' + CANARY ? true : '请求头居然还是对的：' + got[0];
  } finally { rm('core/__probe_ai5.js'); }
});

/* ---- 6. 不可直连的家照样发请求（拦不住） ---- */
await probeAsync('⑥ 不可直连也照发请求 → ①-C「拦住不发请求」锚变红', async function () {
  const A = loadFrom('core/ai.js',
    s => s.replace('    if (!row.browserDirect) {', '    if (false) {'),
    'core/__probe_ai6.js');
  try {
    const bk = backend();
    const st = A.openKeyStore(bk);
    await A.saveKey(st, 'openai', CANARY);
    const got = [];
    const fake = async function (url, init) { got.push(url); return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"level":1,"reason":"x"}' } }] }) }; };
    const r = await A.callSaved(st, fake, 'openai', { task: 'difficulty', user: 'x' });
    return got.length > 0 ? true : '竟然没发请求（r=' + JSON.stringify(r) + '）';
  } finally { rm('core/__probe_ai6.js'); }
});

/* ---- 7. 泄漏扫描只看完整串（尾部片段会溜出去） ---- */
probe('⑦ 扫描不看尾部特征 → ③-B「尾部片段也会被抓到」锚变红', function () {
  const A = loadFrom('core/ai.js',
    s => s.replace('      if (k.length >= 8) {', '      if (false) {'),
    'core/__probe_ai7.js');
  try {
    const tailOnly = '日志片段：…' + CANARY.slice(-6);
    const r = A.scanForSecrets(tailOnly, [CANARY]);
    return r.ok === true ? true : '竟然抓到了：' + JSON.stringify(r.hits);
  } finally { rm('core/__probe_ai7.js'); }
});

/* ---- 8. 分享载荷不再按字段名过滤（只剩"值像不像密钥"这一层） ----
 * 会红的是"字段名 + 密钥形状各报一条"这条精确断言：拆掉字段名那一支后就只剩 1 条。 */
probe('⑧ 分享载荷不按字段名过滤 → ③-A「两条命中」对照锚变红', function () {
  const DataCore = loadFrom('core/data.js',
    s => s.replace('        if (v[k] != null && isForbiddenKey(k)) {', '        if (false) {'),
    'core/__probe_data_ai8.js');
  try {
    const hits = DataCore.findSecrets({ apiKey: CANARY });
    const nameHits = hits.filter(h => /敏感字段名/.test(h.why || ''));
    return nameHits.length === 0 && hits.length !== 2 ? true : 'field-name hits=' + nameHits.length + ' total=' + hits.length;
  } finally { rm('core/__probe_data_ai8.js'); }
});

/* ---- 9. 保存时不校验空白/空串（会把换行当 Key 存进去） ---- */
await probeAsync('⑨ 保存不校验空串/空白 → ①-A「明确拒绝」锚变红', async function () {
  const A = loadFrom('core/ai.js',
    s => s.replace('    if (!raw) return fail(', '    if (false) return fail(')
          .replace('    if (/\\s/.test(raw)) return fail(', '    if (false) return fail('),
    'core/__probe_ai9.js');
  try {
    const bk = backend();
    const st = A.openKeyStore(bk);
    const r1 = await A.saveKey(st, 'dashscope', '   ');
    return r1.ok === true ? true : '仍然被拦住了：' + JSON.stringify(r1);
  } finally { rm('core/__probe_ai9.js'); }
});

const bad = results.filter(r => r[1] !== true);
console.log('\n探针汇总：' + results.length + ' 条  全部能让锚变红=' + (bad.length === 0));
if (bad.length) { bad.forEach(b => console.log('  未变红：' + b[0] + ' → ' + b[1])); process.exitCode = 1; }

})();
