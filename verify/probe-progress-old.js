/* 进度暂存与恢复 · 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-progress-old.js
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

const Q = require('../core/quiz.js');
const S = require('../core/schema.js');
const D = require('../core/data.js');
const QS = [
  S.createQuestion({ id: 'p1', type: '单选', stem: 's1', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['A'] }),
  S.createQuestion({ id: 'p2', type: '判断', stem: 's2', judgeValue: true })
];
const mkSes = A => A.createSession({ examId: 'E1', title: 't', questions: QS, config: Q.mergeConfig(Q.DEFAULT_CONFIG, {}) });
const pay = extra => Object.assign({ v: require('../core/attempt.js').PROGRESS_VERSION, answers: { p1: 'A' }, checked: {},
                                      questionIds: ['p1', 'p2'], index: 0 }, extra || {});

const results = [];
async function probe(name, fn) {
  let red = false;
  try { red = await fn(); } catch (e) { red = '抛错:' + (e && e.message); }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red);
}

(async function () {

/* ---- 1. 恢复：题号不还原 ---- */
await probe('① 恢复时丢掉当前题号 → ①-B 必须变红', async function () {
  const A = loadFrom('core/attempt.js', s => s.replace('    if (Number.isInteger(payload.index)) {', '    if (false) {'),
                     'core/__probe_attempt_p1.js');
  try {
    const s = mkSes(A);
    const r = A.restoreProgress(s, pay({ index: 1 }));
    return !(r.ok && s.index === 1);
  } finally { rm('core/__probe_attempt_p1.js'); }
});

/* ---- 2. 恢复：作答不还原 ---- */
await probe('② 恢复时丢掉作答 → ①-B 必须变红', async function () {
  const A = loadFrom('core/attempt.js', s => s.replace('      session.answers[id] = payload.answers[id];', '      void id;'),
                     'core/__probe_attempt_p2.js');
  try {
    const s = mkSes(A);
    const r = A.restoreProgress(s, pay());
    return !(r.ok && r.restored.answers === 1 && s.answers.p1 === 'A');
  } finally { rm('core/__probe_attempt_p2.js'); }
});

/* ---- 3. 卷子变了也照套（会把旧作答套错题） ---- */
await probe('③ 不检查"卷子是否同一份" → ①-D 必须变红', async function () {
  const A = loadFrom('core/attempt.js',
    s => s.replace("    if (!same) return { ok: false, reason: 'paper-changed', message: '试卷内容变了，上一轮的进度不再适用（已从新一轮开始）' };", '    void same;'),
    'core/__probe_attempt_p3.js');
  try {
    return A.restoreProgress(mkSes(A), pay({ questionIds: ['zz'] })).ok === true;
  } finally { rm('core/__probe_attempt_p3.js'); }
});

/* ---- 4. 陌生键也往会话里灌（脏数据） ---- */
await probe('④ 不丢弃陌生题键 → ①-E 必须变红', async function () {
  const A = loadFrom('core/attempt.js', s => s.replace('      if (!valid[id]) { dropped++; return; }', '      if (false) { dropped++; return; }'),
                     'core/__probe_attempt_p4.js');
  try {
    const s = mkSes(A);
    const r = A.restoreProgress(s, pay({ answers: { p1: 'A', '陌生题': 'X' } }));
    return !(r.restored.dropped === 1 && Object.keys(s.answers).length === 1);
  } finally { rm('core/__probe_attempt_p4.js'); }
});

/* ---- 5. 版本不符也照收 ---- */
await probe('⑤ 不校验版本 → ①-E 必须变红', async function () {
  const A = loadFrom('core/attempt.js', s => s.replace('    if (payload.v !== PROGRESS_VERSION) {', '    if (false) {'),
                     'core/__probe_attempt_p5.js');
  try {
    return A.restoreProgress(mkSes(A), pay({ v: 99 })).ok === true;
  } finally { rm('core/__probe_attempt_p5.js'); }
});

/* ---- 6. 存储抛错时不降级（把答题打断 / 谎报成功） ---- */
await probe('⑥ 写入抛错却谎报成功 → ③-B 必须变红', async function () {
  const A = loadFrom('core/attempt.js',
    s => s.replace('          } catch (e) { degrade(e); }\n        }\n        mem.set(key, QuizCore.snapshotConfig(payload));',
                   '          } catch (e) { /* 旧行为：吞掉错误 */ }\n          return { ok: true, where: "small", bytes: 0, degraded: false, notice: "", payload: payload };\n        }\n        mem.set(key, QuizCore.snapshotConfig(payload));'),
    'core/__probe_attempt_p6.js');
  try {
    const bad = { get: async () => null, set: async () => { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }, del: async () => {} };
    const ps = A.createProgressStore(bad, { examId: 'E1' });
    const r = await ps.save(mkSes(A));
    return !(r.ok === false && r.degraded === true && ps.isDegraded() === true);
  } finally { rm('core/__probe_attempt_p6.js'); }
});

/* ---- 7. 进度键绕过既有前缀规则（手拼字符串） ---- */
await probe('⑦ 进度键改成手拼 → ③-C 必须变红', async function () {
  const A = loadFrom('core/attempt.js',
    s => s.replace("    return DataCore.examSubKey(examId || '', tag ? ('progress-' + tag) : 'progress');",
                   "    return 'progress_' + (examId || '') + (tag ? ('_' + tag) : '');"),
    'core/__probe_attempt_p7.js');
  try {
    // 锚的原话是"进度键必须以试卷分前缀开头"（=== 0）；手拼之后它就不再成立 → 锚红
    return A.progressKey('X').indexOf(D.examSubPrefix('X')) !== 0
        || D.nsOf(D.prefixedKey('app', A.progressKey('X'))) !== 'app';
  } finally { rm('core/__probe_attempt_p7.js'); }
});

/* ---- 8b. 轮次标记被忽略（整卷与抽一轮共用一个键，互相覆盖）→ ①-A2 必须变红 ---- */
await probe('⑧b 轮次标记被忽略（两轮共用一个键）→ ①-A2 必须变红', async function () {
  const A = loadFrom('core/attempt.js',
    s => s.replace("    return DataCore.examSubKey(examId || '', tag ? ('progress-' + tag) : 'progress');",
                   "    return DataCore.examSubKey(examId || '', 'progress');"),
    'core/__probe_attempt_p8b.js');
  try {
    const m = new Map();
    const sm = { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v),
                 removeItem: k => m.delete(k), key: () => null, get length() { return m.size; } };
    const store = D.createStore({ small: sm, large: null, namespace: 'app' });
    const full = mkSes(A); A.goto(full, 3);
    const one = mkSes(A); A.goto(one, 1);
    await A.createProgressStore(store, { examId: 'E1', roundTag: 'all' }).save(full);
    await A.createProgressStore(store, { examId: 'E1', roundTag: 'p1-3' }).save(one);
    /* 坏行为：两份进度落同一个键 → 后写的把先写的顶掉，整卷那份再也读不回来 */
    const back = await A.createProgressStore(store, { examId: 'E1', roundTag: 'all' }).load(A.createSession({
      examId: 'E1', title: '样卷', questions: full.questions, config: full.config }).questions);
    return !(back.ok === true && back.payload.index === 3);
  } finally { rm('core/__probe_attempt_p8b.js'); }
});

/* ---- 9. 清理只清内存、不清后端（脏数据残留） ---- */
await probe('⑧ clear 只清内存不清后端 → ②-A 必须变红', async function () {
  const A = loadFrom('core/attempt.js',
    s => s.replace('          try { await store.del(key); return { ok: true, degraded: false, notice: \'\' }; }',
                   '          try { return { ok: true, degraded: false, notice: \'\' }; }'),
    'core/__probe_attempt_p8.js');
  try {
    const m = new Map();
    const sm = { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k), key: () => null, get length() { return m.size; } };
    const st = D.createStore({ small: sm, large: null, namespace: 'app' });
    const ps = A.createProgressStore(st, { examId: 'E1' });
    await ps.save(mkSes(A));
    await ps.clear();
    const after = await ps.load(QS);
    return after.ok === true;                             // 后端没清干净 → 还能读回 → 锚红
  } finally { rm('core/__probe_attempt_p8.js'); }
});

/* ---- 9. 恢复：先算结果后落配置（卡片与总分分叉） ---- */
await probe('⑨ 恢复时先用旧配置算结果 → ①-C2 必须变红', async function () {
  const A = loadFrom('core/attempt.js',
    s => s.replace("    if (payload.config && (opts == null || opts.applyConfig !== false)) session.config = QuizCore.mergeConfig(payload.config);\n    let answers = 0, checked = 0, dropped = 0;",
                   "    let answers = 0, checked = 0, dropped = 0;")
          .replace("    session.startedAt = payload.startedAt || session.startedAt;\n    return { ok: true, restored:",
                   "    if (payload.config) session.config = QuizCore.mergeConfig(payload.config);\n    session.startedAt = payload.startedAt || session.startedAt;\n    return { ok: true, restored:"),
    'core/__probe_attempt_p9.js');
  try {
    const s = A.createSession({ examId: 'E1', title: 't', questions: QS, config: Q.mergeConfig(Q.DEFAULT_CONFIG, {}) });
    A.goto(s, 0); A.answer(s, 'A'); A.submitCurrent(s);
    A.setConfig(s, Q.mergeConfig(s.config, { points: { '单选': 5 } }));
    const payload = A.serializeProgress(s);
    const s2 = A.createSession({ examId: 'E1', title: 't', questions: QS, config: Q.mergeConfig(Q.DEFAULT_CONFIG, {}) });
    A.restoreProgress(s2, payload);
    return s2.results.p1.score !== 5;                     // 卡片还按旧配置的 2 分 → 锚红
  } finally { rm('core/__probe_attempt_p9.js'); }
});

const fail2 = results.filter(x => x[1] !== true);
console.log('\n探针汇总：' + results.length + ' 条  全部能让锚变红=' + (fail2.length === 0));
if (fail2.length) { fail2.forEach(b => console.log('  未变红：' + b[0] + ' → ' + b[1])); process.exitCode = 1; }
})();
