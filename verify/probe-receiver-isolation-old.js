/* 「接收者隔离」· 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-receiver-isolation-old.js
 *
 * 覆盖 `verify/receiver-isolation.test.js` 依赖的**每一条隔离不变量**：
 * 前缀、前缀边界、命名空间安全门、键真正被拼上命名空间。
 * 页面侧"切空间"的接线由 verify/probe-wiring-old.js ⑪/⑫ 负责。
 */
const fs = require('fs');
const path = require('path');
const HERE = path.join(__dirname, '..');
function loadFrom(mutate, tmpRel) {
  const src = fs.readFileSync(path.join(HERE, 'core', 'data.js'), 'utf8');
  const out = mutate(src);
  if (out === src) throw new Error('探针失效：没替换到目标文本（core/data.js）');
  const tmp = path.join(HERE, tmpRel);
  fs.writeFileSync(tmp, out);
  delete require.cache[require.resolve(tmp)];
  return require(tmp);
}
function rm(rel) { try { fs.unlinkSync(path.join(HERE, rel)); } catch (e) { /* ignore */ } }

function fakeLS() {
  const m = new Map();
  return { getItem: function (k) { return m.has(String(k)) ? m.get(String(k)) : null; },
           setItem: function (k, v) { m.set(String(k), String(v)); },
           removeItem: function (k) { m.delete(String(k)); },
           key: function (i) { const ks = Array.from(m.keys()); return i < ks.length ? ks[i] : null; },
           get length() { return m.size; } };
}

const results = [];
function probe(name, fn) {
  let red = false, note = '';
  try { const r = fn(); red = (r === true); if (typeof r === 'string') note = r; else if (r !== true) note = JSON.stringify(r); }
  catch (e) { red = '抛错:' + (e && e.message); }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red + (note ? '   ' + note : ''));
}

/* ---- 1. 接收者空间丢掉 recv_ 前缀（与出题者空间混在一起） ---- */
probe('① receiverNamespace 丢前缀 → ①-A「recv_ 开头 / 两个空间不同」锚变红', function () {
  const D = loadFrom(s => s.replace("  function receiverNamespace(examId) { return NS_RECV_PREFIX + String(examId == null ? '' : examId); }",
                                    "  function receiverNamespace(examId) { return String(examId == null ? '' : examId); }"),
    'core/__probe_ri1.js');
  try {
    return (D.receiverNamespace('A1') !== 'recv_A1') ? true : '居然还是 recv_A1';
  } finally { rm('core/__probe_ri1.js'); }
});

/* ---- 2. isInNamespace 退化成裸前缀（recv_A1x 被 recv_A1 认领） ---- */
probe('② isInNamespace 用裸前缀 → ①-A「前缀边界」锚变红', function () {
  const D = loadFrom(s => s.replace("  function isInNamespace(fullKey, ns) { return String(fullKey).indexOf(ns + NS_SEP) === 0; }",
                                    "  function isInNamespace(fullKey, ns) { return String(fullKey).indexOf(ns) === 0; }"),
    'core/__probe_ri2.js');
  try {
    return (D.isInNamespace('recv_A1x' + D.NS_SEP + 'k', 'recv_A1') === true) ? true : '居然还是 false';
  } finally { rm('core/__probe_ri2.js'); }
});

/* ---- 3. 命名空间安全门失效（含分隔符也放行 → 边界被撑破） ---- */
probe('③ assertSafeNamespace 不拦分隔符 → ③-C「含 :: 直接抛错」锚变红', function () {
  const D = loadFrom(s => s.replace('    if (String(ns).indexOf(NS_SEP) >= 0) {', '    if (false) {'),
    'core/__probe_ri3.js');
  try {
    let threw = false;
    try { D.createStore({ small: fakeLS(), large: null, namespace: 'a' + D.NS_SEP + 'b' }); } catch (e) { threw = true; }
    return (threw === false) ? true : '居然还是拦住了';
  } finally { rm('core/__probe_ri3.js'); }
});

/* ---- 4. 键根本不拼命名空间（所有空间共用一个平面 → 必然串数据） ---- */
probe('④ prefixedKey 不拼命名空间 → ②-A「命名空间扫描」锚变红', function () {
  const D = loadFrom(s => s.replace('  function prefixedKey(ns, key) { return ns + NS_SEP + key; }',
                                    '  function prefixedKey(ns, key) { return String(key); }'),
    'core/__probe_ri4.js');
  try {
    /* 同步判据：正常是 `recv_A1::record::A1`（`isInNamespace` 认它）；改坏后成裸键 → 不再属于该空间。
     * ⚠ 别用 `nsOf(...) === null`：裸键 `record::A1` 里仍有分隔符，nsOf 会切出 'record'（实测踩过）。 */
    const full = D.prefixedKey('recv_A1', 'record' + D.NS_SEP + 'A1');
    return (D.isInNamespace(full, 'recv_A1') === false) ? true : ('居然还被算作该空间的键：' + full);
  } finally { rm('core/__probe_ri4.js'); }
});

/* ---- 5. 接收者空间退回"只按卷 id"（卷 id 撞名的两份文件记录互串 —— 组级红队抓到的真漏洞） ---- */
probe('⑤ 空间退回只按卷 id → 「同 id 不同内容 → 不同空间」锚变红', function () {
  const D = loadFrom(
    s => s.replace('  function receiverNamespaceFor(exam) {\n    const e = exam || {};',
                   '  function receiverNamespaceFor(exam) {\n    const e = exam || {};\n    return receiverNamespace(String(e.id == null ? \'\' : e.id));'),
    'core/__probe_ri5.js');
  try {
    const S = require('../core/schema.js');
    const mk = function (stem) {
      return S.createExam({ id: '题库.docx', title: '一样', configLocked: true,
        questions: [S.createQuestion({ id: 'q1', type: '单选', stem: stem,
          options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['A'], answer: 'A' })] }, {});
    };
    return (D.receiverNamespaceFor(mk('甲题')) === D.receiverNamespaceFor(mk('乙题'))) ? true
      : '居然还是分开了：' + D.receiverNamespaceFor(mk('甲题'));
  } finally { rm('core/__probe_ri5.js'); }
});

const bad = results.filter(r => r[1] !== true);
console.log('\n探针汇总：' + results.length + ' 条  全部能让锚变红=' + (bad.length === 0));
if (bad.length) { bad.forEach(b => console.log('  未变红：' + b[0] + ' → ' + b[1])); process.exitCode = 1; }
