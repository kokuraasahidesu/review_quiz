/* 组级红队（自演）· 攻击脚本：能跑出"违规"就打印 VIOLATION。
 * 运行： node verify/__redteam_L1.js       （临时件，裁决完删）
 * 立场：我是来**推翻**这三条组级标准的，不是来复述小类结论的。
 */
const fs = require('fs');
const path = require('path');
const HERE = path.join(__dirname, '..');
const D = require('../core/data.js');
const S = require('../core/schema.js');
const Q = require('../core/quiz.js');
const A = require('../core/attempt.js');
const W = require('../core/wrong.js');
const AI = require('../core/ai.js');

const SHELL = fs.readFileSync(path.join(HERE, '答题页.html'), 'utf8');
const CANARY = 'sk-redteam-canary-9f3a7c1e5b2d4680';
const findings = [];
function vio(why, evidence) { findings.push({ why: why, evidence: evidence }); console.log('  ✗ VIOLATION  ' + why + '   ' + evidence); }
function fine(t, d) { console.log('  · 挡住/成立  ' + t + (d ? '   ' + d : '')); }

function fakeLS() {
  const m = new Map();
  return { m: m, getItem: function (k) { return m.has(String(k)) ? m.get(String(k)) : null; },
           setItem: function (k, v) { m.set(String(k), String(v)); }, removeItem: function (k) { m.delete(String(k)); },
           key: function (i) { const ks = Array.from(m.keys()); return i < ks.length ? ks[i] : null; },
           get length() { return m.size; } };
}
function keysIn(ls, ns) { const o = []; for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (D.isInNamespace(k, ns)) o.push(k); } return o.sort(); }
function mkExam(id, title, stem) {
  return S.createExam({ id: id, title: title, config: Q.resolveConfig({ points: { '单选': 3 } }, null), configLocked: true,
    questions: [S.createQuestion({ id: id + '-q1', type: '单选', stem: stem || '默认端口？',
      options: [{ label: 'A', text: '21' }, { label: 'B', text: '80' }], answerLetters: ['B'], answer: 'B' })] }, {});
}
async function round(store, examId, questions, config, ans, tag) {
  const s = A.createSession({ examId: examId, title: 'x', questions: questions, config: config });
  A.goto(s, 0); A.answer(s, ans); A.submitCurrent(s);
  const fin = A.finish(s, { confirmUnanswered: true, now: tag });
  const byId = {}; questions.forEach(function (q) { byId[q.id] = q; });
  await W.collectToStore(store, { examId: examId, results: fin.summary.per, now: tag, sessionAt: tag, questionsById: byId, answers: s.answers });
  const ps = A.createProgressStore(store, { examId: examId });
  await ps.save(s, { now: tag });
  return fin.summary;
}

(async function () {
  console.log('\n=== 标准一：导出文件里不能有密钥 / 记录 / 错题，特殊字符不能破结构 ===');

  /* 攻击 1：把密钥塞到各个角落（含题干、含同义词表的键名） */
  const dirty = {
    exams: [Object.assign({}, mkExam('RT1', '红队卷', '题干粘了 ' + CANARY), {
      config: { points: { '单选': 3 }, apiKey: CANARY, short: { synonyms: { [CANARY]: ['别名'] } } }
    })],
    settings: { apiKeys: { dashscope: { key: CANARY } }, apiKey: CANARY },
    records: [{ answer: CANARY }], wrongBook: { X: { entries: {} } }, progress: {}, draft: {}
  };
  const r1 = D.exportStandalone(dirty, SHELL, { examId: 'RT1', at: '2026-11-03T10:00:00.000Z', secrets: D.secretsOfState(dirty) });
  if (r1.ok && String(r1.html).indexOf(CANARY) >= 0) vio('密钥随导出文件出去了', 'html 里搜到 canary');
  else fine('密钥（题干/配置/同义词键名/记录）→ ' + (r1.ok ? '未泄漏' : '拒绝导出：' + String(r1.message).slice(0, 30)), 'ok=' + r1.ok);
  /* 攻击 1b：只把密钥放题干（白名单挡不住，必须靠扫描） */
  const onlyStem = { exams: [mkExam('RT2', '红队卷2', '题干里有 ' + CANARY)] };
  const r1b = D.exportStandalone(onlyStem, SHELL, { examId: 'RT2', at: '2026-11-03T10:00:00.000Z', secrets: [CANARY] });
  if (r1b.ok) vio('题干里的来源机密没被拦下', 'ok=true');
  else fine('题干里的来源机密 → 拒绝导出', String(r1b.message).slice(0, 34));
  /* 攻击 2：特殊字符破结构 */
  const nasty = '甲</script><script>alert(1)</script> $& $\' $` $$ 乙 --> <!--';
  const r2 = D.exportStandalone({ exams: [mkExam('RT3', '特殊字符卷', nasty)] }, SHELL, { examId: 'RT3', at: '2026-11-03T10:00:00.000Z', secrets: [] });
  const bc = D.payloadBlockCount(r2.html);
  const back = D.extractPayload(r2.html);
  if (!r2.ok || bc.blocks !== 1 || D.rawCloseInPayload(r2.html) !== 0 || !back || back.exams[0].questions[0].stem !== nasty) {
    vio('特殊字符破坏了结构或往返', JSON.stringify({ ok: r2.ok, blocks: bc.blocks, rawClose: D.rawCloseInPayload(r2.html), same: !!(back && back.exams[0].questions[0].stem === nasty) }));
  } else fine('13 类特殊字符 → 1 个块 / 无裸闭合 / 往返逐字一致', 'blocks=' + bc.blocks);

  console.log('\n=== 标准二：接收者记录只落本机，不串出题者、不串另一份分享文件 ===');

  const ls = fakeLS();
  const AUTHOR = D.NS_GLOBAL;
  /* 出题者本机：同一台机器上作者自己的记录 */
  const authorStore = D.createStore({ small: ls, large: null, namespace: AUTHOR });
  await round(authorStore, 'RT9', mkExam('RT9', '作者的卷').questions, Q.resolveConfig(Q.DEFAULT_CONFIG, null), 'A', 'A1');
  const authorKeys = keysIn(ls, AUTHOR);

  /* 攻击 3：**两份不同的卷、卷 id 相同**（现实中：两个人都把文件命名成 题库.docx；或都用内置样卷） */
  const fileA = D.exportStandalone({ exams: [mkExam('题库.docx', '甲的文件', '甲的第一题：端口？')] }, SHELL,
    { examId: '题库.docx', at: '2026-11-03T10:00:00.000Z', secrets: [] });
  const fileB = D.exportStandalone({ exams: [mkExam('题库.docx', '乙的文件', '乙的第一题：MAC？')] }, SHELL,
    { examId: '题库.docx', at: '2026-11-03T10:05:00.000Z', secrets: [] });
  const payA = D.extractPayload(fileA.html).exams[0];
  const payB = D.extractPayload(fileB.html).exams[0];
  /* 按**页面现在的规则**建空间（攻击的必须是新实现，不能拿旧规则自证） */
  const nsA = D.receiverNamespaceFor(payA);
  const nsB = D.receiverNamespaceFor(payB);
  const sA = D.createStore({ small: ls, large: null, namespace: nsA });
  await round(sA, payA.id, payA.questions.map(function (q) { return S.createQuestion(q); }),
    Q.resolveConfig(Q.DEFAULT_CONFIG, payA), 'A', 'R1');
  const sB = D.createStore({ small: ls, large: null, namespace: nsB });
  const bookB = await W.loadBook(sB, payB.id);
  if (nsA === nsB || !bookB.empty) {
    vio('**两份不同的分享文件（卷 id 撞名）记录串了**', 'nsA=' + nsA + ' nsB=' + nsB +
      '，乙的文件里能看到甲的错题：' + JSON.stringify(Object.keys(bookB.book.entries)));
  } else fine('两份不同内容的文件（**卷 id 故意撞名** 题库.docx）→ 空间不同且互不可见',
    'nsA=' + nsA + ' / nsB=' + nsB);
  /* 攻击 3b：**同一份内容**再打开一次，必须仍然落在同一个空间（否则续答就断了） */
  const again = D.exportStandalone({ exams: [mkExam('题库.docx', '甲的文件', '甲的第一题：端口？')] }, SHELL,
    { examId: '题库.docx', at: '2026-11-03T11:00:00.000Z', secrets: [] });
  const payA2 = D.extractPayload(again.html).exams[0];
  if (D.receiverNamespaceFor(payA2) !== nsA) vio('同一份内容两次导出 → 空间不一致（续答会断）', D.receiverNamespaceFor(payA2) + ' ≠ ' + nsA);
  else fine('同一份内容重复导出 → 仍是同一个空间（续答不断）', nsA);
  if (keysIn(ls, AUTHOR).join('|') !== authorKeys.join('|')) vio('接收者动了出题者的 app 空间', keysIn(ls, AUTHOR).join(','));
  else fine('出题者 app 空间零改动', authorKeys.join(' / '));

  console.log('\n=== 标准三：断网可用 + 存储不可用能降级且明确提示、页面不崩 ===');

  /* 攻击 4：完全没有存储时，导出的文件还能不能开、能不能判分 */
  const noStore = (function () { return { getItem: function () { return null; }, setItem: function () { throw new Error('Disabled'); }, removeItem: function () { }, key: function () { return null; }, get length() { return 0; } }; })();
  const health = D.storageHealth(noStore);
  if (health.ok !== false || !/不会被保存/.test(health.message)) vio('存储被禁时体检没说实话', JSON.stringify(health));
  else fine('存储被禁 → degraded + 明说"不会被保存"', health.reason);
  const payloadFromFile = D.extractPayload(fileA.html);
  const qs = payloadFromFile.exams[0].questions.map(function (q) { return S.createQuestion(q); });
  let threw = null, scored = null;
  try {
    const cfg = Q.resolveConfig(Q.DEFAULT_CONFIG, payloadFromFile.exams[0]);
    scored = Q.scoreExam(qs, { '题库.docx-q1': 'B' }, cfg);
    const st = D.createStore({ small: noStore, large: null, namespace: D.receiverNamespace('题库.docx') });
    const ps = A.createProgressStore(st, { examId: '题库.docx' });
    const sv = await ps.save(A.createSession({ examId: '题库.docx', title: 'x', questions: qs, config: cfg }), { now: 'T' });
    if (sv.degraded !== true) vio('坏存储下进度 save 没报降级', JSON.stringify(sv));
  } catch (e) { threw = e; }
  if (threw) vio('断网/坏存储下流程抛异常', String(threw && threw.message));
  else fine('无存储也能开卷判分（分数 ' + scored.score + '/' + scored.full + '）+ 如实降级');
  /* 攻击 5：网络调用有没有跑到非 AI 模块 */
  const MODS = ['core/data.js', 'core/quiz.js', 'core/attempt.js', 'core/wrong.js', 'core/exams.js', 'core/parse/docx.js', 'ui/attempt-view.js'];
  const bad = [];
  MODS.forEach(function (m) {
    const t = fs.readFileSync(path.join(HERE, m), 'utf8');
    if (/\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|sendBeacon/.test(t)) bad.push(m);
  });
  if (bad.length) vio('非 AI 模块里有网络调用', bad.join(','));
  else fine('解析/判分/存储/视图七个模块零网络调用');

  console.log('\n=== 组级红队裁决：' + (findings.length ? '**reject**（' + findings.length + ' 条）' : 'pass（未发现违规）') + ' ===');
  findings.forEach(function (f, i) { console.log('  ' + (i + 1) + '. ' + f.why + '｜证据：' + f.evidence); });
})();
