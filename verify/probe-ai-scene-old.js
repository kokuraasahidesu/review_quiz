/* 整卷点评与举一反三 · 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-ai-scene-old.js
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
const F = require('../core/flow.js');
const S = require('../core/schema.js');
const W = require('../core/data.js');
const EX = require('../core/exams.js');
const CANARY = 'sk-canary-9f3a7c1e5b2d4680zz';

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
const PAPER = (function () {
  const qs = [
    S.createQuestion({ id: 'p1', type: '单选', stem: 'HTTP 默认端口是哪个？', options: [{ label: 'A', text: '21' }, { label: 'B', text: '80' }], answerLetters: ['B'], answer: 'B' }),
    S.createQuestion({ id: 'p2', type: '判断', stem: 'TCP 面向连接。', judgeValue: true })
  ];
  const ans = { p1: 'A', p2: '对' };
  const cfg = Q.mergeConfig(Q.DEFAULT_CONFIG, {});
  const sc = Q.scoreExam(qs, ans, cfg);
  return { qs, ans, summary: Object.assign({}, sc, { level: F.gradeLevel(sc.percent, cfg).level }) };
})();
async function keyStoreFor(A) {
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

/* ---- 1. 简报里不带"你的作答"（结算里本来就没这项 → 逐行都写"未作答"） ---- */
probe('① 简报不带 answers → ①-A「每题都带着你的作答」锚变红', function () {
  const A = loadFrom('core/ai.js',
    s => s.replace("      const mine = (answers[p.id] !== undefined && answers[p.id] !== null && String(answers[p.id]) !== '')\n        ? clip(answers[p.id], 30) : clip(p.userAnswer || '（未作答）', 30);",
                   "      const mine = clip(p.userAnswer || '（未作答）', 30);"),
    'core/__probe_sc1.js');
  try {
    const b = A.examBrief(PAPER.summary, PAPER.qs, { answers: PAPER.ans });
    return b.text.indexOf('你的作答：A') < 0 ? true : '居然还是带上了';
  } finally { rm('core/__probe_sc1.js'); }
});

/* ---- 2. 反套话闸门失效（任何文字都放行） ---- */
probe('② 反套话闸门恒真 → ①-B「通用套话被拒」锚变红', function () {
  const A = loadFrom('core/ai.js',
    s => s.replace('    const ok = (hitStrong.length > 0) || (hitStems.length > 0);', '    const ok = true;'),
    'core/__probe_sc2.js');
  try {
    const b = A.examBrief(PAPER.summary, PAPER.qs, { answers: PAPER.ans });
    const g = A.checkReviewGrounding({ summary: '多做练习，每天复习 1 小时。', weakPoints: ['x'], advice: ['y'] }, b);
    return g.ok === true ? true : '竟然还是拒了';
  } finally { rm('core/__probe_sc2.js'); }
});

/* ---- 3. 闸门只看弱整数（"1 小时"也能过） ---- */
probe('③ 闸门只看弱数字 → ①-B「弱整数不算数」锚变红', function () {
  const A = loadFrom('core/ai.js',
    s => s.replace("    const hitStems = (facts.stems || []).filter(function (s) {", "    const hitStems = (facts.numbers || []).filter(function (s) {"),
    'core/__probe_sc3.js');
  try {
    const b = A.examBrief(PAPER.summary, PAPER.qs, { answers: PAPER.ans });
    const g = A.checkReviewGrounding({ summary: '每天复习 1 小时就够了。', weakPoints: ['x'], advice: ['y'] }, b);
    return g.ok === true ? true : '竟然还是拒了：' + JSON.stringify(g.hitStems);
  } finally { rm('core/__probe_sc3.js'); }
});

/* ---- 4. 总评不需要"薄弱考点/建议"（只回一段总评也算合格） ----
 * ⚠ 这条闸门有**两道**：SCHEMAS 里的字段要求 + review 专有的"空数组也算没写"。
 *   只拆一道仍然会被另一道拦住（说明防线是重叠的）—— 探针要两道一起拆才算拆干净。 */
probe('④ review 结构退回只要求 summary → ①-C「空列表即拒绝」锚变红', function () {
  const A = loadFrom('core/ai.js',
    s => s.replace("    review: { summary: 'string', weakPoints: 'array', advice: 'array' },", "    review: { summary: 'string' },")
          .replace("    if (task === 'review') {", '    if (false) {'),
    'core/__probe_sc4.js');
  try {
    return A.validate('review', { summary: 'x', weakPoints: [], advice: [] }).ok === true ? true : '竟然还是拒了';
  } finally { rm('core/__probe_sc4.js'); }
});

/* ---- 5. 没确认也照发（消耗确认形同虚设） ---- */
await probeAsync('⑤ 未确认也发请求 → ③-A「未确认零请求」锚变红', async function () {
  const A = loadFrom('core/ai.js',
    s => s.replace("    if (o.confirmed !== true) return { ok: false, needConfirm: true, confirm: confirm, requestCount: 0 };", ''),
    'core/__probe_sc5.js');
  try {
    const st = await keyStoreFor(A);
    const f = fakeFetch([{ summary: '本轮得分引用了真实数字。', weakPoints: ['x'], advice: ['y'] }]);
    let n = 0;
    await A.runReview(st, f, 'dashscope', PAPER.summary, PAPER.qs, { answers: PAPER.ans }, { onRequest: function () { n++; } });
    return n > 0 ? true : '居然仍然是零请求';
  } finally { rm('core/__probe_sc5.js'); }
});

/* ---- 6. 加入试卷不做结构闸门（脏题也能进卷） ----
 * ⚠ 这里其实有**三道**防线：ai.js 的 validateQuestion → 卷册层 appendQuestions 的校验 →
 *   `normalizeQuestions` 对非法题的丢弃。全拆掉才会"真写进去"（那不是一次字符串替换能做的）。
 *   所以这条探针**对准它会红的那条断言**：拆掉 ai.js 这道之后，拒绝的 stage 从 'schema' 退化成 'store'
 *   （错误信息也从"这道题结构不合法…"变成卷册层的转述）—— ②-C 里那条 `stage==='schema'` 当场红。 */
await probeAsync('⑥ appendVariant 不校验结构 → ②-C「stage=schema」断言变红', async function () {
  const A = loadFrom('core/ai.js',
    s => s.replace('    const v = SchemaCore.validateQuestion(made);\n    if (!v.ok) return { ok: false, stage: \'schema\', error: \'这道题结构不合法，未加入试卷：\' + v.errors.join(\'；\'), errors: v.errors };', ''),
    'core/__probe_sc6.js');
  try {
    const bk = backend();
    const app = W.createStore({ small: bk, large: null, namespace: W.NS_GLOBAL });
    await EX.createExam(app, { id: 'P', title: '探针卷' });
    const r = await A.appendVariant(app, 'P', { type: '单选', stem: '缺答案' }, {});
    /* 期望：拆掉之后 stage 不再是 'schema'（或干脆写进去了）→ 锚红 */
    return (r.stage !== 'schema' || r.ok === true) ? true : 'stage 仍是 schema：' + JSON.stringify(r);
  } finally { rm('core/__probe_sc6.js'); }
});

/* ---- 7. 加入试卷后不回真对象（拿旧 id 对不上 → inGroup 恒 false） ---- */
await probeAsync('⑦ appendVariant 不用 accepted → ②-B「inGroup=true」锚变红', async function () {
  const A = loadFrom('core/ai.js',
    s => s.replace('    const stored = (r.accepted && r.accepted[0]) || made;', '    const stored = made;'),
    'core/__probe_sc7.js');
  try {
    const bk = backend();
    const app = W.createStore({ small: bk, large: null, namespace: W.NS_GLOBAL });
    await EX.createExam(app, { id: 'P2', title: '探针卷二' });
    const q = S.createQuestion({ id: 'v1', type: '单选', stem: '新题面', options: [{ label: 'A', text: 'x' }, { label: 'B', text: 'y' }], answerLetters: ['A'], answer: 'A' });
    const r = await A.appendVariant(app, 'P2', q, {});
    return (r.ok === true && r.inGroup !== true) ? true : 'inGroup 仍然是对的：' + JSON.stringify(r);
  } finally { rm('core/__probe_sc7.js'); }
});

/* ---- 8. 误答上下文不进提示词（新题没有"冲着你错的地方"） ---- */
probe('⑧ 误答上下文不进提示词 → ②-A「带上错答/次数」锚变红', function () {
  const A = loadFrom('core/ai.js',
    s => s.replace("      user: (o.context ? (String(o.context) + '\\n\\n') : '') + briefQuestion(q),", '      user: briefQuestion(q),'),
    'core/__probe_sc8.js');
  try {
    const mb = A.mistakeBrief(PAPER.qs[0], { lastAnswer: 'A', times: 2 });
    const req = A.singleRequest('variant', PAPER.qs[0], { context: mb });
    return req.user.indexOf('你当时的错答：A') < 0 ? true : '居然还带着';
  } finally { rm('core/__probe_sc8.js'); }
});

const bad = results.filter(r => r[1] !== true);
console.log('\n探针汇总：' + results.length + ' 条  全部能让锚变红=' + (bad.length === 0));
if (bad.length) { bad.forEach(b => console.log('  未变红：' + b[0] + ' → ' + b[1])); process.exitCode = 1; }

})();
