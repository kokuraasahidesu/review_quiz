/* 删卷级联询问 · 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-delete-cascade-old.js
 * 每行必须打印 "锚变红=true"；出现 false 说明那条断言在测空气。
 *
 * 做法：把 core/exams.js 的源码**字符串替换**回改造前的写法，用同一套真 store 跑一遍，
 * 看对应的验收锚会不会当场变红。
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
const W = require('../core/wrong.js');
const A = require('../core/attempt.js');
const Q = require('../core/quiz.js');
const S = require('../core/schema.js');

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
    store: () => D.createStore({ small: small, large: large, namespace: D.NS_GLOBAL, threshold: 1024 * 1024 }),
    rawKeys: () => Array.from(sm.keys()).concat(Array.from(lg.keys()))
  };
}
function makeExam(id, title) {
  return S.createExam({ id: id, title: title, schemaVersion: S.SCHEMA_VERSION, questions: [
    S.createQuestion({ id: id + '-q1', type: '单选', stem: '题一', options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }], answerLetters: ['A'], explanation: '解析' }),
    S.createQuestion({ id: id + '-q2', type: '判断', stem: '题二', judgeValue: true, explanation: '解析' })
  ] }, { now: '2026-10-25T00:00:00.000Z' });
}
async function seed(store, id, title) {
  const exam = makeExam(id, title);
  await store.set(D.examBodyKey(id), exam);
  const idx = (await store.get('index')) || { examIds: [], updatedAt: null };
  if (idx.examIds.indexOf(id) < 0) idx.examIds.push(id);
  await store.set('index', idx);
  const s = A.createSession({ examId: id, title: title, questions: exam.questions, config: Q.mergeConfig(Q.DEFAULT_CONFIG, {}) });
  exam.questions.forEach(function (q, i) { A.goto(s, i); A.answer(s, q.type === '判断' ? '×' : 'B'); A.submitCurrent(s); });
  const fin = A.finish(s, { confirmUnanswered: true, now: 't' });
  const byId = {}; exam.questions.forEach(function (q) { byId[q.id] = q; });
  const book = W.createBook(id, 't');
  W.collect(book, fin.summary.per, { now: 't', sessionAt: 'S-' + id, questionsById: byId, answers: s.answers });
  await store.set(D.wrongKey(id), W.toJSON(book));
  await store.set(D.recordKey(id), [{ at: 't', examId: id, score: 0, full: 6 }]);
  return book;
}
function residue(raw, id) {
  const full = k => D.prefixedKey(D.NS_GLOBAL, k);
  const hit = { body: 0, sub: 0, record: 0, wrong: 0 };
  raw.forEach(function (k) {
    if (k === full(D.examBodyKey(id))) hit.body++;
    else if (k.indexOf(full(D.examSubPrefix(id))) === 0) hit.sub++;
    else if (k === full(D.recordKey(id))) hit.record++;
    else if (k === full(D.wrongKey(id))) hit.wrong++;
  });
  return hit;
}

const results = [];
function probe(name, fn) {
  let red = false;
  try { red = fn(); } catch (e) { red = '抛错:' + (e && e.message); }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red);
}
async function probeAsync(name, fn) {
  let red = false;
  try { red = await fn(); } catch (e) { red = '抛错:' + (e && e.message); }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red);
}

(async function main() {

/* ---- 1. 没给政策也照删（改造前：默认 cascade） ---- */
await probeAsync('① 没政策就默认级联删 → ①-B（拒绝执行 + 零改动）变红', async function () {
  const E = loadFrom('core/exams.js',
    s => s.replace("    let policy = o.policy || '';", "    let policy = o.policy || POLICY_CASCADE;"),
    'core/__probe_del1.js');
  try {
    const WW = world(), st = WW.store();
    await seed(st, 'P1', '探针卷');
    const before = WW.rawKeys().slice().sort();
    const r = await E.deleteExam(st, 'P1');                       // 不传政策
    const notRefused = !(r.ok === false && r.needPolicy === true);
    const changed = WW.rawKeys().slice().sort().join('|') !== before.join('|');
    return notRefused && changed;                                 // 该拒绝却删了 → 锚红
  } finally { rm('core/__probe_del1.js'); }
});

/* ---- 2. 墓碑写不进去（writeTombstone 失效，但调用方以为成功了） ---- */
await probeAsync('② 选『否』不写墓碑 → ③-A（归属标识 + 零孤儿）变红', async function () {
  const E = loadFrom('core/exams.js',
    s => s.replace('  async function writeTombstone(store, entry) {', '  async function writeTombstone(store, entry) { return { ok: false };'),
    'core/__probe_del2.js');
  try {
    const WW = world(), st = WW.store();
    await seed(st, 'P2', '探针卷二');
    await E.deleteExam(st, 'P2', { policy: 'keepRecords', now: 't2' });
    const own = await E.ownerOf(st, 'P2');
    const scan = await E.scanOrphans(st);
    /* 没墓碑 → 归属查询给不出"已删除试卷"，两条残留记录被当孤儿 → 两条锚都得红 */
    return own.kind !== 'deleted' && scan.orphans.length === 2;
  } finally { rm('core/__probe_del2.js'); }
});

/* ---- 3. 巡检不认墓碑（把"有主"的记录报成孤儿） ---- */
await probeAsync('③ scanOrphans 不认墓碑 → ③-A（键扫描零孤儿）变红', async function () {
  const E = loadFrom('core/exams.js',
    s => s.replace('      if (id) dead[id] = tombstoneOf(x);', '      if (false) dead[id] = tombstoneOf(x);'),
    'core/__probe_del3.js');
  try {
    const WW = world(), st = WW.store();
    await seed(st, 'P3', '探针卷三');
    await E.deleteExam(st, 'P3', { policy: 'keepRecords', now: 't3' });
    const scan = await E.scanOrphans(st);
    return scan.orphans.length !== 0;                             // 有主的两条被误报成孤儿 → 锚红
  } finally { rm('core/__probe_del3.js'); }
});

/* ---- 4. 级联不删记录（记录留在盘上） ---- */
await probeAsync('④ 级联不删记录 → ②-A（三类键全部归零）变红', async function () {
  const E = loadFrom('core/exams.js',
    s => s.replace('    const res = await store.purgeExam(scope.id, { includeRecords: !keep });',
                   '    const res = await store.purgeExam(scope.id, { includeRecords: false });'),
    'core/__probe_del4.js');
  try {
    const WW = world(), st = WW.store();
    await seed(st, 'P4', '探针卷四');
    await E.deleteExam(st, 'P4', { policy: 'cascade', now: 't4' });
    const r = residue(WW.rawKeys(), 'P4');
    return r.wrong !== 0 || r.record !== 0;                        // 记录没删掉 → 锚红
  } finally { rm('core/__probe_del4.js'); }
});

/* ---- 5. 级联不抹旧墓碑（先"否"再"是"会留下空壳标识） ---- */
await probeAsync('⑤ 级联不抹旧墓碑 → ⑤-A（零残留标识）变红', async function () {
  const E = loadFrom('core/exams.js',
    s => s.replace('        idx.deleted = idx.deleted.filter(function (x) { return String(x && (x.id || x.examId)) !== scope.id; });', '        ;'),
    'core/__probe_del5.js');
  try {
    const WW = world(), st = WW.store();
    await seed(st, 'P5', '探针卷五');
    await E.deleteExam(st, 'P5', { policy: 'keepRecords', now: 't5a' });   // 先选"否" → 留墓碑
    await E.deleteExam(st, 'P5', { policy: 'cascade', now: 't5b' });       // 再选"是" → 该抹掉墓碑
    const own = await E.ownerOf(st, 'P5');
    return own.kind !== 'unknown';                                        // 空壳标识还在 → 锚红
  } finally { rm('core/__probe_del5.js'); }
});

/* ---- 6. 墓碑改成"删完卷再写"（旧顺序：写不进去时卷已经没了） ---- */
await probeAsync('⑥ 先删卷后写墓碑 → ③-E（写不进去就什么都不删）变红', async function () {
  const E = loadFrom('core/exams.js',
    s => s.replace('    if (keep) {\n      try {', '    if (keep && false) {\n      try {')
          .replace('    const res = await store.purgeExam(scope.id, { includeRecords: !keep });',
                   '    const res = await store.purgeExam(scope.id, { includeRecords: !keep });\n' +
                   "    if (keep) { await writeTombstone(store, { id: scope.id, title: (before && before.title) || '', at: nowIso(o) }); }"),
    'core/__probe_del6.js');
  try {
    const WW = world(), st = WW.store();
    await seed(st, 'P6', '探针卷六');
    const realSet = st.set.bind(st);
    st.set = function (key, value) {
      if (key === 'index') { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; return Promise.reject(e); }
      return realSet(key, value);
    };
    try { await E.deleteExam(st, 'P6', { policy: 'keepRecords', now: 't6' }); }
    catch (e) { return true; }                     // 旧顺序：写墓碑失败时卷**已经删了**，只能抛错收场 → 锚红
    const gone = residue(WW.rawKeys(), 'P6').body === 0;
    return gone;                                   // 没抛错的话，卷也已不在 → 同样锚红
  } finally { rm('core/__probe_del6.js'); }
});

/* ---- 7. 「清除答题记录」顺手把题库也清了（最危险的写法：拿大前缀去 purge） ---- */
await probeAsync('⑦ 清记录改成"按 exam:: 前缀删" → ⑱ 的"卷本体一条都没动"变红', async function () {
  const E = loadFrom('core/exams.js',
    s => s.replace('    const r = await store.purgeByScope({ exact: exact });',
                   "    const r = await store.purgeByScope({ exact: exact, prefix: [DataCore.examBodyKey('')] });"),
    'core/__probe_del7.js');
  try {
    const WW = world(), st = WW.store();
    await seed(st, 'P7', '探针卷七');
    await E.clearAttemptRecords(st, { includeWrong: true });
    const body = await st.get(D.examBodyKey('P7'));
    return !body;                                  // 卷本体被一起清了 → 锚（要求还在）红
  } finally { rm('core/__probe_del7.js'); }
});

/* ---- 8. 用户没选"一起清错题"，实现却把错题本也清了（越权） ---- */
await probeAsync('⑧ 默认连错题本一起清（越权）→ ⑱ 的"错题本按默认留着"变红', async function () {
  const E = loadFrom('core/exams.js',
    s => s.replace('      .concat(o.includeWrong ? pv.wrong.keys : []);',
                   '      .concat(pv.wrong.keys);'),
    'core/__probe_del8.js');
  try {
    const WW = world(), st = WW.store();
    await seed(st, 'P8', '探针卷八');            // seed 会写入错题本与成绩记录
    const r = await E.clearAttemptRecords(st);   // **不传** includeWrong
    return r.cleared.wrong !== 0;                // 没选却清掉了错题本 → 锚（要求 0）红
  } finally { rm('core/__probe_del8.js'); }
});

const bad = results.filter(r => r[1] !== true);
console.log('\n探针汇总：' + results.length + ' 条  全部能让锚变红=' + (bad.length === 0));
if (bad.length) { bad.forEach(b => console.log('  未变红：' + b[0] + ' → ' + b[1])); process.exitCode = 1; }

})();
