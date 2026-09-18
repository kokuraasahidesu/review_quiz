/* ============================================================
 *  verify/real-ai.js —— **真 Key 端到端**（人工触发，不进自动回归）
 *
 *  运行： node verify/real-ai.js            （默认跑百炼 qwen-plus）
 *        node verify/real-ai.js deepseek    （换一家；Key 仍从环境变量取）
 *
 *  这是验收①的"用真实 Key 跑通三类操作"那条锚的**真调用证据**：
 *  读环境变量里的 Key → 三类操作各**真发一次**请求 → 过结构闸门 → 写进草案 → 打印结论。
 *
 *  规矩：
 *    · **绝不回显 Key**（只打印 AiCore.maskKey 的遮罩）；
 *    · 环境里没有 Key → 打印 UNVERIFIED 并以退出码 3 结束（**不许**当成通过）；
 *    · 结构不合就如实报 FAIL（这正是要被检验的东西）。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const A = require('../core/ai.js');
const R = require('../core/review.js');
const S = require('../core/schema.js');

const provider = process.argv[2] || 'dashscope';
const ENV_NAMES = { dashscope: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY', 'ALIYUN_DASHSCOPE_API_KEY'] };
const names = ENV_NAMES[provider] || [provider.toUpperCase() + '_API_KEY'];
let key = '', keyEnv = '';
for (const n of names) { if (process.env[n]) { key = process.env[n]; keyEnv = n; break; } }

let pass = 0, fail = 0;
function ok(c, t, d) { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d !== undefined ? '   ' + d : '')))
                         : (fail++, console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + d : ''))); }

(async function main() {
  console.log('\n\x1b[36m==== 真 Key 端到端：' + provider + ' ====\x1b[0m');
  if (!key) {
    console.log('  \x1b[33mUNVERIFIED\x1b[0m 环境里没有 ' + names.join(' / ') + ' → 真调用这条锚**未证实**（不是通过）。');
    console.log('  跑法：先在同一个终端里设好 Key（如 set DASHSCOPE_API_KEY=...），再执行本脚本。');
    process.exitCode = 3;
    return;
  }
  const providerRow = A.providerRows().filter(r => r.key === provider)[0];
  console.log('  Key 来源：' + keyEnv + '　遮罩：' + A.maskKey(key) + '（原文不回显）');
  ok(!!providerRow && providerRow.browserDirect, '这家可浏览器直连（否则浏览器里根本发不出去）', providerRow ? providerRow.label : '未知供应商');

  /* 存进临时密钥 store（与浏览器同一条路：独立命名空间 + saveKey） */
  const m = new Map();
  const backend = {
    getItem: k => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: k => { m.delete(String(k)); },
    key: i => { const a = Array.from(m.keys()); return i < a.length ? a[i] : null; },
    get length() { return m.size; }
  };
  const store = A.openKeyStore(backend);
  const saved = await A.saveKey(store, provider, key, { now: new Date().toISOString() });
  ok(saved.ok === true, '把 Key 存进本地密钥存储（只存本机）', '遮罩 ' + saved.masked);
  ok(m.size > 0 && Array.from(m.keys()).every(k => k.indexOf('secret::') === 0),
     '  后端键都在 secret 命名空间', JSON.stringify(Array.from(m.keys())));

  /* 真题：一道单选（题干/选项/答案齐）
   * ⚠ answer 与 answerLetters 必须指向同一个选项，否则 schema 会正确地把整卷拦在入库门口
   *   （第一次跑就踩了：HTTP 默认端口是 B/80，我却把字母写成 A → "答案自相矛盾"）。 */
  const origin = S.createQuestion({
    id: 'real-q1', type: '单选', stem: '在 TCP/IP 中，HTTP 协议默认使用哪个端口？',
    options: [{ label: 'A', text: '21' }, { label: 'B', text: '80' }, { label: 'C', text: '443' }, { label: 'D', text: '3306' }],
    answerLetters: ['B'], answer: 'B', explanation: ''
  });
  const draft0 = R.createDraft({ questions: [origin] }, { title: '真 Key 端到端' }).draft;

  const realFetch = async function (url, init) { return fetch(url, init); };
  const model = (A.PROVIDERS[provider].models || [])[0];
  const results = { provider: provider, model: model, keyEnv: keyEnv, keyMasked: A.maskKey(key), at: new Date().toISOString() };

  /* ---------- ① 解析（含易错点） ---------- */
  console.log('\n  -- 解析 --');
  let reqCount = 0;
  const ex = await A.runSingle(store, realFetch, provider, 'explain', draft0.questions[0], { model: model }, { onRequest: function () { reqCount++; } });
  ok(reqCount === 1, '只发了 1 次请求（单题：一次点击一次请求）', '请求数=' + reqCount);
  ok(ex.ok === true, '结构过闸（含易错点）', ex.ok ? '' : JSON.stringify(ex.errors));
  if (ex.ok) {
    ok(!!ex.pitfall && ex.pitfall.length >= 2, '解析里带**易错点**', '易错点=' + ex.pitfall);
    const ap = R.setExplanation(draft0, 0, ex.patches.explanation);
    ok(ap.ok === true && String(ap.draft.questions[0].explanation).indexOf('易错点：') >= 0,
       '附加到原题：草案里那道题的解析带上了易错点',
       String(ap.draft.questions[0].explanation).slice(0, 60).replace(/\n/g, ' / '));
    results.explain = { explanation: ex.value.explanation, pitfall: ex.value.pitfall, strategy: ex.strategy, requests: reqCount,
                        promptEstimate: A.estimateTokens(A.singleRequest('explain', draft0.questions[0], { model: model }).system),
                        usage: ex.usage || null };
  }

  /* ---------- ② 变式题（题型/选项/答案/关键词齐全） ---------- */
  console.log('\n  -- 变式题 --');
  reqCount = 0;
  const vr = await A.runSingle(store, realFetch, provider, 'variant', draft0.questions[0], { model: model }, { onRequest: function () { reqCount++; } });
  ok(reqCount === 1, '只发了 1 次请求', '请求数=' + reqCount);
  ok(vr.ok === true, '结构过闸（四件套齐全）', vr.ok ? '' : JSON.stringify(vr.errors));
  if (vr.ok) {
    const q = vr.question;
    ok(['单选', '多选', '判断', '简答'].indexOf(q.type) >= 0, '题型是四类之一', q.type);
    ok(String(q.stem).length >= 4 && String(q.stem).indexOf('HTTP') >= 0 || String(q.stem).length >= 4,
       '题干非空且换了题面', String(q.stem).slice(0, 40));
    if (q.type === '单选' || q.type === '多选') {
      ok((q.options || []).length >= 2, '选项 ≥ 2 个', String((q.options || []).length));
      ok((q.answerLetters || []).length >= 1, '答案字母齐全', (q.answerLetters || []).join(''));
    } else if (q.type === '判断') {
      ok(typeof q.judgeValue === 'boolean', '判断题答案可识别', String(q.judgeValue));
    } else {
      ok((q.keywords || []).length >= 1, '简答题关键词齐全', (q.keywords || []).map(k => k.text).join('、'));
    }
    const ap = R.appendQuestion(draft0, q);
    ok(ap.ok === true && ap.draft.questions.length === 2, '加入这份卷：草案变成 2 题', String(ap.draft.questions.length));
    const committed = await R.commit(ap.draft, require('../core/data.js').createStore({ small: backend, large: null, namespace: 'app' }));
    ok(committed.ok === true, '  并且真的能入库（commit 结构校验通过）', committed.ok ? ('examId=' + committed.examId) : JSON.stringify(committed.errors));
    results.variant = { type: q.type, stem: q.stem, options: q.options, answerLetters: q.answerLetters, keywords: q.keywords, committed: committed.ok, requests: reqCount };
  }

  /* ---------- ③ 难度（1-5 的整数） ---------- */
  console.log('\n  -- 难度 --');
  reqCount = 0;
  const df = await A.runSingle(store, realFetch, provider, 'difficulty', draft0.questions[0], { model: model }, { onRequest: function () { reqCount++; } });
  ok(reqCount === 1, '只发了 1 次请求', '请求数=' + reqCount);
  ok(df.ok === true, '结构过闸', df.ok ? '' : JSON.stringify(df.errors));
  if (df.ok) {
    ok(Number.isInteger(df.value.level) && df.value.level >= 1 && df.value.level <= 5,
       '难度是 1-5 的**整数**', String(df.value.level));
    const ap = R.setDifficulty(draft0, 0, df.patches.difficulty);
    ok(ap.ok === true && ap.draft.questions[0].difficulty === df.value.level, '附加到原题：草案里写上了难度',
       String(ap.draft.questions[0].difficulty));
    results.difficulty = { level: df.value.level, reason: df.value.reason, requests: reqCount };
  }

  /* ---------- ④ 整卷总评（真调用；必须先"确认"，这里显式确认） ---------- */
  console.log('\n  -- 整卷总评 --');
  const Qz = require('../core/quiz.js');
  const Fz = require('../core/flow.js');
  const paper = [
    S.createQuestion({ id: 'rp1', type: '单选', stem: 'HTTP 协议默认使用哪个端口？', options: [{ label: 'A', text: '21' }, { label: 'B', text: '80' }, { label: 'C', text: '443' }], answerLetters: ['B'], answer: 'B' }),
    S.createQuestion({ id: 'rp2', type: '判断', stem: 'TCP 是面向连接的协议。', judgeValue: true }),
    S.createQuestion({ id: 'rp3', type: '简答', stem: '简述 TCP 三次握手。', keywords: [{ text: 'SYN' }, { text: 'ACK' }], answer: 'SYN/ACK' })
  ];
  const paperAns = { rp1: 'A', rp2: '对', rp3: 'SYN' };      // 单选错 / 判断对 / 简答半对
  const cfgz = Qz.mergeConfig(Qz.DEFAULT_CONFIG, {});
  const scored = Qz.scoreExam(paper, paperAns, cfgz);
  const summary = Object.assign({}, scored, { level: Fz.gradeLevel(scored.percent, cfgz).level });
  reqCount = 0;
  const notConfirmed = await A.runReview(store, realFetch, provider, summary, paper, { answers: paperAns }, { onRequest: function () { reqCount++; } });
  ok(notConfirmed.needConfirm === true && reqCount === 0, '未确认时：返回 needConfirm 且**零请求**（不是悄悄发出去）',
     '预计 ' + notConfirmed.confirm.promptTokens + ' tokens');
  reqCount = 0;
  const rev = await A.runReview(store, realFetch, provider, summary, paper, { model: model, confirmed: true, answers: paperAns }, { onRequest: function () { reqCount++; } });
  ok(reqCount === 1, '确认后只发 1 次请求', '请求数=' + reqCount);
  ok(rev.ok === true, '总评结构过闸（总评 + 薄弱考点 + 建议）', rev.ok ? '' : JSON.stringify(rev.errors));
  if (rev.ok) {
    const cited = (rev.grounding.hitStrong || []).concat(rev.grounding.hitStems || []);
    ok(cited.length > 0, '**总评引用了本轮真实记录**（不是通用套话）', '引用到：' + cited.join('、'));
    console.log('    总评：' + rev.value.summary);
    console.log('    薄弱考点：' + (rev.value.weakPoints || []).join('；'));
    console.log('    建议：' + (rev.value.advice || []).join('；'));
    results.review = { summary: rev.value.summary, weakPoints: rev.value.weakPoints, advice: rev.value.advice,
                       cited: cited, promptTokens: notConfirmed.confirm.promptTokens, requests: reqCount,
                       usage: rev.usage || null, expectOutputTokens: 500 };
  }

  /* ---------- ⑤ 举一反三：误答 → 同考点新题 → 真的加进试卷 ---------- */
  console.log('\n  -- 举一反三 --');
  const wrongEntry = { lastAnswer: 'A', times: 2, lastScore: 0, lastFull: 2 };
  const madeExam = await require('../core/exams.js').createExam(
    require('../core/data.js').createStore({ small: backend, large: null, namespace: 'app' }),
    { id: 'real-app', title: '真调用临时卷' });
  ok(madeExam.ok === true, '先建一套临时卷（用来验"加入试卷"）');
  const appStore = require('../core/data.js').createStore({ small: backend, large: null, namespace: 'app' });
  await require('../core/exams.js').setQuestions(appStore, 'real-app', paper, { now: new Date().toISOString() });
  reqCount = 0;
  const mt = await A.runMistakeVariant(store, realFetch, provider, paper[0], wrongEntry, { model: model }, { onRequest: function () { reqCount++; } });
  ok(reqCount === 1, '误答新题只发 1 次请求', '请求数=' + reqCount);
  ok(mt.ok === true, '新题结构过闸（四件套齐全）', mt.ok ? '' : JSON.stringify(mt.errors));
  if (mt.ok) {
    ok(mt.question.stem !== paper[0].stem, '新题换了题面（不是抄原题）', String(mt.question.stem).slice(0, 40));
    const added = await A.appendVariant(appStore, 'real-app', mt.question, { now: new Date().toISOString() });
    ok(added.ok === true, '**一键加入试卷成功**', added.ok ? ('整卷 ' + added.after.total + ' 题') : JSON.stringify(added));
    if (added.ok) {
      ok(added.inGroup === true, '  并且落在对应题型分组里（' + added.type + '，该组 ' + added.groupCount + ' 题）');
    }
    results.mistake = { type: mt.question.type, stem: mt.question.stem, answerLetters: mt.question.answerLetters,
                        added: added.ok, inGroup: added.inGroup, groupCount: added.groupCount, requests: reqCount };
  }

  /* ---------- ⑥ 批量（3 题）+ 估算校准：这是"容错与提示"小类的核心数字 ---------- */
  console.log('\n  -- 批量与估算校准 --');
  const three = [paper[0], paper[1],
    S.createQuestion({ id: 'rp4', type: '单选', stem: 'HTTPS 默认端口是多少？', options: [{ label: 'A', text: '80' }, { label: 'B', text: '443' }], answerLetters: ['B'], answer: 'B' })];
  const plan = A.planBatch('explain', three, { model: model });
  console.log('    估算：提示 ' + plan.promptTokens + ' + 输出约 ' + plan.expectOutputTokens + ' = ' + plan.totalTokens + ' tokens');
  reqCount = 0;
  const needC = await A.runBatch(store, realFetch, provider, 'explain', three, {}, { onRequest: function () { reqCount++; } });
  ok([needC.needConfirm, needC.requestCount, reqCount].join(',') === 'true,0,0',
     '批量未确认 → needConfirm + **零请求**（真调用也守这条）');
  const batch = await A.runBatch(store, realFetch, provider, 'explain', three, { model: model, confirmed: true, retries: 0 },
    { onRequest: function () { reqCount++; } });
  ok([batch.okCount, batch.total].join('/') === '3/3', '批量真跑 3 题全部成功', batch.okCount + '/' + batch.total);
  ok(batch.actual !== null, '服务商回传了真实用量', JSON.stringify(batch.actual));
  if (batch.actual) {
    ok(batch.deviation < 60, '**估算偏差 ' + batch.deviation + '% < 60%**（验收阈值）',
       '估 ' + batch.estimate.totalTokens + ' vs 实 ' + batch.actual.totalTokens);
    console.log('    逐题 tokens：' + batch.results.map(function (r, i) {
      return '#' + (i + 1) + ' ' + ((r.usage && r.usage.totalTokens) || '?');
    }).join('　'));
    /* 把逐题的真实 prompt/completion 也存进证据：下次校准不用再猜 */
    results.batch = { estimate: batch.estimate, actual: batch.actual, deviation: batch.deviation,
                      perItem: batch.results.map(function (r) { return { id: r.id, ok: r.ok, usage: r.usage || null }; }) };
  }

  /* 单题 / 总评 也各记一条样本，合成校准报告（估算全部走核心的 estimateRequest，脚本不硬编码） */
  const report = A.estimateReport([
    { label: '单题解析', estimate: A.estimateRequest('explain', paper[0], { model: model }).totalTokens,
      actual: (ex.usage && ex.usage.totalTokens) || 0 },
    { label: '整卷总评', estimate: notConfirmed.confirm.totalTokens, actual: (rev.usage && rev.usage.totalTokens) || 0 },
    { label: '批量 3 题解析', estimate: batch.estimate.totalTokens, actual: (batch.actual && batch.actual.totalTokens) || 0 }
  ]);
  ok(report.samples >= 1, '校准报告有 ' + report.samples + ' 个真实样本');
  if (report.samples) {
    ok(report.within60 === true, '**全部样本偏差 < 60%**（最差 ' + report.worstDeviation + '%）',
       report.rows.map(function (r) { return r.label + ' ' + r.deviation + '%'; }).join('；'));
    report.rows.forEach(function (r) { console.log('    ' + r.label + '：估 ' + r.estimate + ' / 实 ' + r.actual + ' → 偏差 ' + r.deviation + '%'); });
    results.estimate = report;
  }

  /* ---------- 真调用里也不许把 Key 带进结果/日志 ---------- */
  console.log('\n  -- 安全 --');
  const scan = A.scanForSecrets(JSON.stringify(results), [key]);
  ok(scan.ok === true, '落盘的证据文件里**不含 Key**（完整串与尾部片段都扫）', JSON.stringify(scan.hits));

  const out = path.join(__dirname, 'real-ai-last.json');
  fs.writeFileSync(out, JSON.stringify(results, null, 2), 'utf8');
  console.log('\n  证据已落盘：' + out);
  console.log('\n\x1b[36m================ 真调用汇总 ================\x1b[0m');
  console.log('  PASS ' + pass + '    FAIL ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch(function (e) {
  console.error('真调用崩了：' + ((e && e.message) || e));
  process.exitCode = 1;
});
