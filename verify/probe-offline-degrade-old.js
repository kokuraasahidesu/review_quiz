/* 「断网可用与内存态降级」· 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-offline-degrade-old.js
 *
 * 覆盖四条：存储体检的"真写一次"、读回校验、降级时的实话文案、错题本落盘失败的人话提示。
 * 页面侧"开页体检并显示告警"的接线由 verify/probe-wiring-old.js ⑬ 负责。
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

function throwingLS() {
  return { getItem: function () { return null; }, setItem: function () { throw new Error('QuotaExceededError'); },
           removeItem: function () { }, key: function () { return null; }, get length() { return 0; } };
}
function lyingLS() {
  return { getItem: function () { return null; }, setItem: function () { }, removeItem: function () { },
           key: function () { return null; }, get length() { return 0; } };
}
function goodLS() {
  const m = new Map();
  return { m: m, getItem: function (k) { return m.has(String(k)) ? m.get(String(k)) : null; },
           setItem: function (k, v) { m.set(String(k), String(v)); }, removeItem: function (k) { m.delete(String(k)); },
           key: function (i) { const ks = Array.from(m.keys()); return i < ks.length ? ks[i] : null; },
           get length() { return m.size; } };
}

const results = [];
/* ⚠ 本文件里有的判据要跑异步（错题本落盘那条），所以 probe 支持 Promise —— 汇总在全部 await 之后。 */
async function probe(name, fn) {
  let red = false, note = '';
  try {
    const r = await fn();
    red = (r === true);
    if (typeof r === 'string') note = r; else if (r !== true) note = JSON.stringify(r);
  } catch (e) { red = '抛错:' + (e && e.message); }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red + (note ? '   ' + note : ''));
}

(async function () {

/* ---- 1. 体检只看"对象在不在"，不真写（配额满/被禁时得出"能存"的假结论） ---- */
await probe('① 体检不真写（只看对象在不在）→ ②-A「写不进去必须报 degraded」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace("    const key = prefixedKey(NS_GLOBAL, '__probe__');",
                   "    return { ok: true, reason: 'ok', degraded: false, message: '只看对象在不在' };\n    const key = prefixedKey(NS_GLOBAL, '__probe__');"),
    'core/__probe_od1.js');
  try {
    const h = D.storageHealth(throwingLS());
    return (h.ok === true) ? true : ('居然还是 degraded：' + JSON.stringify(h));
  } finally { rm('core/__probe_od1.js'); }
});

/* ---- 2. 不校验读回（写进去读不回也当成功） ---- */
await probe('② 不校验读回 → ②-A「读不回要报 unreliable」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace("      if (back !== token) {", '      if (false) {'),
    'core/__probe_od2.js');
  try {
    const h = D.storageHealth(lyingLS());
    return (h.ok === true) ? true : ('居然还是 degraded：' + JSON.stringify(h));
  } finally { rm('core/__probe_od2.js'); }
});

/* ---- 3. 降级文案退化成"只有错误码"（用户看不懂、也不知道下一步） ---- */
await probe('③ 告警文案退化成错误码 → ②-A/③-D「不是空白错误码」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace("               message: '本机存储写不进去（配额已满，或被浏览器策略禁止）——本次作答不会被保存，刷新就没了。'\n                 + '可以清一点浏览器存储、或换一个窗口/浏览器再试；正在刷题的话先别刷新。' };",
                   "               message: 'E_QUOTA' };"),
    'core/__probe_od3.js');
  try {
    const h = D.storageHealth(throwingLS());
    return (!/配额|禁止/.test(h.message) || !/不会被保存/.test(h.message)) ? true : ('居然还是人话：' + h.message);
  } finally { rm('core/__probe_od3.js'); }
});

/* ---- 4. 探测键不清理（每开一次页面就给用户的存储留一条垃圾） ---- */
await probe('④ 体检后不删探测键 → ②-A「探测键用完就删」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace("      if (typeof b.removeItem === 'function') b.removeItem(key);\n      if (back !== token) {",
                   "      if (back !== token) {"),
    'core/__probe_od4.js');
  try {
    const ls = goodLS();
    D.storageHealth(ls);
    return (ls.m.size > 0) ? true : '居然还是干净的';
  } finally { rm('core/__probe_od4.js'); }
});

/* ---- 5. 错题本落盘失败时把原始异常名直接甩给用户 ---- */
await probe('⑤ 落盘失败只报异常名 → ②-B「说清只在内存里」锚变红', async function () {
  const W = loadFrom('core/wrong.js',
    s => s.replace("      return { ok: false, degraded: true,\n               message: '错题本写不进本机存储（' + ((e && e.message) || e) + '）：这次只记在内存里，刷新后会丢失。' };",
                   "      return { ok: false, degraded: true, message: (e && e.message) || String(e) };"),
    'core/__probe_od5.js');
  try {
    const D = require('../core/data.js');
    const store = D.createStore({ small: throwingLS(), large: null, namespace: 'app' });
    const out = await W.collectToStore(store, { examId: 'X1', now: 'T', sessionAt: 'S', questionsById: {}, answers: {},
      results: [{ qid: 'q1', correct: false, score: 0, full: 1, type: '单选', stem: 's', qtype: '单选' }] });
    const msg = String(out.saveMessage || '');
    return (!/内存|存储/.test(msg)) ? true : ('居然还是人话：' + msg);
  } finally { rm('core/__probe_od5.js'); }
});

const bad = results.filter(r => r[1] !== true);
console.log('\n探针汇总：' + results.length + ' 条  全部能让锚变红=' + (bad.length === 0));
if (bad.length) { bad.forEach(b => console.log('  未变红：' + b[0] + ' → ' + b[1])); process.exitCode = 1; }

})();
