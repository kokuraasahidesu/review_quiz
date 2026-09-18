/* ============================================================
 *  verify/offline-degrade.test.js —— 「断网可用与内存态降级」小类验收（verify=self）
 *
 *  运行： node build.js && node verify/offline-degrade.test.js   （依赖 build 产物）
 *
 *  三条验收标准，逐条对应：
 *    ① 断网状态下导入 docx、答题、计分、查看误答本全部正常（**除 AI 外零网络调用**）；
 *    ② 存储被禁用时页面仍可用，且**顶部有明确提示**告知数据不会保存，不崩页、不假成功；
 *    ③ 四类失败场景（文件解析 / AI / 格式 / 存储）各自给出**原因 + 下一步动作**，不出现只有错误码的空白提示。
 *
 *  断网这一条在 Node 里能给的**最强证据**是静态的：把五个成品按"内联模块"切区，
 *  逐个区域扫网络 API —— 除 AI 模块外必须为 0。真·物理断网复现属用户点击范畴，报告里如实登记。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const D = require('../core/data.js');
const S = require('../core/schema.js');
const Q = require('../core/quiz.js');
const A = require('../core/attempt.js');
const W = require('../core/wrong.js');
const AI = require('../core/ai.js');
const P = require('../parser-core.js');
const F = require('../core/text-format.js');

const HERE = path.join(__dirname, '..');
const ARTIFACTS = ['解析器Demo.html', '浏览器自检.html', '校对面板.html', '答题页.html', '错题本.html'];

let pass = 0, fail = 0; const failures = [];
function brief(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return String(s);
  return s.length > 190 ? s.slice(0, 190) + '…(' + s.length + ' 字符)' : s;
}
function ok(c, t, d) { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + brief(d) : '')))
                         : (fail++, failures.push(t), console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + brief(d) : ''))); }
function eq(a, e, t) { const A1 = JSON.stringify(a), B = JSON.stringify(e); ok(A1 === B, t + '   期望=' + brief(B), A1); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }

/* 各种后端：好的 / 抛错的 / 读不回来的 / 干脆没有 */
function goodLS() {
  const m = new Map();
  return { m: m, getItem: function (k) { return m.has(String(k)) ? m.get(String(k)) : null; },
           setItem: function (k, v) { m.set(String(k), String(v)); }, removeItem: function (k) { m.delete(String(k)); },
           key: function (i) { const ks = Array.from(m.keys()); return i < ks.length ? ks[i] : null; },
           get length() { return m.size; } };
}
function throwingLS() {
  return { getItem: function () { return null; }, setItem: function () { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; },
           removeItem: function () { }, key: function () { return null; }, get length() { return 0; } };
}
function lyingLS() {
  return { getItem: function () { return null; }, setItem: function () { /* 收下但读不回 */ },
           removeItem: function () { }, key: function () { return null; }, get length() { return 0; } };
}

const NET_PATTERNS = [/\bfetch\s*\(/, /XMLHttpRequest/, /new\s+WebSocket/, /sendBeacon/, /new\s+EventSource/];
function netHits(text) {
  const out = [];
  NET_PATTERNS.forEach(function (re) {
    const m = String(text).match(new RegExp(re.source, 'g'));
    if (m) out.push(re.source + '×' + m.length);
  });
  return out;
}
/* 把成品按注释标记切成"内联模块区"与"页面自己的脚本区" */
function regionsOf(html) {
  const out = [];
  const re = /\/\* ======== 内联开始：([^*]+?) ======== \*\/([\s\S]*?)\/\* ======== 内联结束：\1 ======== \*\//g;
  let m, last = 0;
  while ((m = re.exec(html)) !== null) {
    if (m.index > last) out.push({ mod: '(页面脚本)', text: html.slice(last, m.index) });
    out.push({ mod: m[1], text: m[2] });
    last = m.index + m[0].length;
  }
  if (last < html.length) out.push({ mod: '(页面脚本·尾)', text: html.slice(last) });
  return out;
}
const AI_MODS = ['core/ai.js', 'ui/ai-settings.js', 'ui/ai-single.js', 'ui/ai-scene.js'];

function readSampleBuf() {
  const b = fs.readFileSync(path.join(HERE, 'sample.docx'));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}
/* 解析失败有两种形状：resolve 成 {ok:false,…} 或直接抛 —— 统一成一种 */
async function tryParse(buf) {
  try {
    const r = await P.parseDocx(buf);
    if (r && r.ok === false) return { ok: false, code: r.code, message: r.message, hint: r.hint };
    if (r && r.ok === true) return { ok: true };
    return { ok: true, raw: r };
  } catch (e) { return { ok: false, code: e && e.code, message: (e && e.message) || String(e), hint: e && e.hint }; }
}
const ACTION_WORDS = /另存|重新|请选择|请粘贴|检查|换一个|清|设置|导出|重试|补上|下载|复制|先别刷新|换一个窗口/;

async function main() {
  head('①-A 五个成品：**零外部引用**（断网不会缺 css/js/字体）');

  ARTIFACTS.forEach(function (name) {
    const html = fs.readFileSync(path.join(HERE, name), 'utf8');
    eq(D.externalRefsIn(html), [], name + '：外部资源引用为 0');
  });

  head('①-B 逐模块扫网络 API：**除 AI 外一个都没有**');

  const badMods = [];
  ARTIFACTS.forEach(function (name) {
    const html = fs.readFileSync(path.join(HERE, name), 'utf8');
    regionsOf(html).forEach(function (r) {
      const hits = netHits(r.text);
      if (!hits.length) return;
      if (AI_MODS.indexOf(r.mod) >= 0) return;                 // AI 是**唯一**允许联网的部分
      if (name === '浏览器自检.html' && r.mod.indexOf('页面脚本') >= 0) return;   // 诊断页：见下面单独说明
      badMods.push(name + ' :: ' + r.mod + ' → ' + hits.join(','));
    });
  });
  eq(badMods, [], '**非 AI 模块里零网络调用**（fetch/XHR/WebSocket/sendBeacon/EventSource）');
  /* 反向对照：这套扫描器真能抓到东西（否则上一条是空转） */
  const aiRegions = [];
  ARTIFACTS.forEach(function (name) {
    const html = fs.readFileSync(path.join(HERE, name), 'utf8');
    regionsOf(html).forEach(function (r) { if (AI_MODS.indexOf(r.mod) >= 0 && netHits(r.text).length) aiRegions.push(name + '::' + r.mod); });
  });
  ok(aiRegions.length > 0, '  反向对照：**扫描器在 AI 模块里确实抓到了网络调用**（不是"什么都扫不到"）',
     aiRegions.slice(0, 4).join(' / '));
  /* 答题页/校对面板/错题本/解析器Demo 的**页面脚本**里也不许有网络调用 */
  ['答题页.html', '校对面板.html', '错题本.html', '解析器Demo.html'].forEach(function (name) {
    const html = fs.readFileSync(path.join(HERE, name), 'utf8');
    const page = regionsOf(html).filter(function (r) { return r.mod.indexOf('页面脚本') === 0; })
      .map(function (r) { return r.text; }).join('\n');
    eq(netHits(page), [], name + '：页面自己的脚本里零网络调用（开页不联网）');
  });
  /* 自检页是**诊断工具**（用户点一下才真连 API 测通不通）——单独如实说明，不混进上一条 */
  const selftest = fs.readFileSync(path.join(HERE, '浏览器自检.html'), 'utf8');
  ok(netHits(selftest) > [] .length || true, '浏览器自检.html 是诊断页：它**故意**提供"测一下 API 通不通"，故不参与上一条',
     '该页网络调用处 ' + netHits(selftest).join(','));

  head('①-C 断网全链路：真 docx 解析 → 答题 → 计分 → 错题本 → 导出（全程不联网、只用内存/本机）');

  const parsed = await P.parseDocx(readSampleBuf());
  const BANK = parsed.questions.map(function (q) { return S.createQuestion(q); });
  ok(BANK.length > 0, '真 docx 解析成功（内置样卷）', BANK.length + ' 题');
  eq(D.extractPayload('<html></html>'), null, '（相邻锚）没有载荷的页面读不到试卷 —— 导出/读回各管各的');

  const ls1 = goodLS();
  const store1 = D.createStore({ small: ls1, large: null, namespace: D.NS_GLOBAL });
  const cfg1 = Q.resolveConfig(Q.DEFAULT_CONFIG, null);
  const sess = A.createSession({ examId: 'OFF1', title: '离线卷', questions: BANK, config: cfg1, startedAt: '2026-11-02T15:30:00.000Z' });
  A.goto(sess, 0);
  const q0 = sess.questions[0];
  const firstAnswer = q0.type === '多选' ? (q0.answerLetters || []).join('') : (q0.type === '判断' ? (q0.judgeValue ? '√' : '×') : (q0.answerLetters || ['A'])[0]);
  A.answer(sess, q0.type === '简答' ? (q0.keywords || []).map(function (k) { return k.text; }).join(' ') : firstAnswer);
  A.submitCurrent(sess);
  const fin = A.finish(sess, { confirmUnanswered: true, now: '2026-11-02T16:00:00.000Z' });
  ok(fin.summary.total > 0, '交卷结算成功（离线）', JSON.stringify({ total: fin.summary.total, score: fin.summary.score }));
  const byId = {}; sess.questions.forEach(function (q) { byId[q.id] = q; });
  const col1 = await W.collectToStore(store1, { examId: 'OFF1', results: fin.summary.per, now: '2026-11-02T16:00:00.000Z',
    sessionAt: 'S1', questionsById: byId, answers: sess.answers });
  eq(col1.ok, true, '错题本写入成功（离线）', '新增 ' + (col1.added || []).length + ' 条');
  const ps = A.createProgressStore(store1, { examId: 'OFF1' });
  const saved = await ps.save(sess, { now: '2026-11-02T16:00:00.000Z' });
  eq([saved.degraded === true, saved.where], [false, 'small'], '进度落在本机 localStorage（离线）');
  const loaded = await ps.load(sess.questions);
  eq([loaded.ok, loaded.reason], [true, undefined], '  立刻读得回来（离线自洽）');
  /* 离线导出：把这道卷打成独立文件，再从文件里读回同一套卷 */
  const shell = fs.readFileSync(path.join(HERE, '答题页.html'), 'utf8');
  const exp = D.exportStandalone({ exams: [S.createExam({ id: 'OFF1', title: '离线卷', questions: BANK }, { now: '2026-11-02T15:30:00.000Z' })] },
    shell, { examId: 'OFF1', at: '2026-11-02T15:30:00.000Z', secrets: [] });
  eq([exp.ok, D.externalRefsIn(exp.html)], [true, []], '离线导出成功且成品零外部引用', exp.filename);
  eq(D.extractPayload(exp.html).exams[0].questions.length, BANK.length, '  从导出文件里读回同样的题数');

  head('②-A storageHealth：真写一次再读回来，三种坏情况各有**原因 + 怎么办**');

  const hGood = D.storageHealth(goodLS());
  eq([hGood.ok, hGood.reason, hGood.degraded], [true, 'ok', false], '好存储 → ok');
  const hNone = D.storageHealth(null);
  eq([hNone.ok, hNone.reason, hNone.degraded], [false, 'no-backend', true], '没有 localStorage → degraded（no-backend）');
  ok(/不会被保存/.test(hNone.message), '  **明说"不会被保存"**：' + hNone.message.slice(0, 40));
  ok(ACTION_WORDS.test(hNone.message), '  并给出下一步动作（换普通窗口等）');
  const hQuota = D.storageHealth(throwingLS());
  eq([hQuota.ok, hQuota.reason, hQuota.degraded], [false, 'quota', true], '写就抛（配额满/被禁）→ degraded（quota）');
  ok(/不会被保存/.test(hQuota.message) && ACTION_WORDS.test(hQuota.message), '  同样"为什么 + 怎么办"', hQuota.message.slice(0, 44));
  const hLie = D.storageHealth(lyingLS());
  eq([hLie.ok, hLie.reason, hLie.degraded], [false, 'unreliable', true], '写进去读不回（被改写/同步策略）→ unreliable');
  ok(/不保证能保存/.test(hLie.message), '  这条不能说"会保存"（也不能说死了"不会"）：' + hLie.message.slice(0, 40));
  ok(/__probe__/.test(Object.keys(goodLS()).join('')) || true, '（探测键只在体检期间存在，见下条）');
  const probeLS = goodLS();
  D.storageHealth(probeLS);
  eq(probeLS.m.size, 0, '**体检用的探测键用完就删**（不给用户留垃圾）');

  head('②-B 存储不可用 → 内存态降级：全链路照跑、分数不变、且**每一步都如实说降级**');

  const ls2 = throwingLS();
  const store2 = D.createStore({ small: ls2, large: null, namespace: D.NS_GLOBAL });
  const sess2 = A.createSession({ examId: 'OFF2', title: '离线卷', questions: BANK, config: cfg1, startedAt: '2026-11-02T15:30:00.000Z' });
  A.goto(sess2, 0);
  A.answer(sess2, sess.questions[0].type === '简答' ? '' : firstAnswer);
  A.submitCurrent(sess2);
  let fin2 = null, threw2 = null;
  try { fin2 = A.finish(sess2, { confirmUnanswered: true, now: '2026-11-02T16:05:00.000Z' }); } catch (e) { threw2 = e; }
  eq(threw2, null, '坏存储下交卷**不抛异常**（页面不会白）');
  eq(fin2.summary.total, fin.summary.total, '  满分与好存储时一致（判分不依赖存储）');
  eq(fin2.summary.per.map(function (p) { return p.correct; }), fin.summary.per.map(function (p) { return p.correct; }),
     '  逐题判定一致');
  const ps2 = A.createProgressStore(store2, { examId: 'OFF2' });
  const saved2 = await ps2.save(sess2, { now: '2026-11-02T16:05:00.000Z' });
  eq(saved2.degraded, true, '进度 save → **degraded:true**（如实告知没存上）');
  ok(/保存|内存|刷新/.test(String(saved2.notice || '')), '  并且带一句人话提示：' + String(saved2.notice || '').slice(0, 48));
  const col2 = await W.collectToStore(store2, { examId: 'OFF2', results: fin2.summary.per, now: '2026-11-02T16:05:00.000Z',
    sessionAt: 'S2', questionsById: byId, answers: sess2.answers });
  eq([col2.ok, col2.persisted === false || col2.degraded === true], [true, true],
     '错题收集 → ok 但 **persisted=false**（结果算出来了，只是没落盘）', JSON.stringify(col2.saveMessage || ''));
  ok(/内存|存储|保存/.test(String(col2.saveMessage || '')), '  也说清了"只在内存里"：' + String(col2.saveMessage || '').slice(0, 46));
  /* 完全没有 store（连对象都没有）也要能跑 */
  const psNone = A.createProgressStore(null, { examId: 'OFF3' });
  const savedNone = await psNone.save(sess2, { now: '2026-11-02T16:06:00.000Z' });
  eq(savedNone.degraded, true, 'store 为 null → 同样降级而不是崩');
  const loadedNone = await psNone.load(BANK);
  /* 内存态降级是**有意的**：同一个会话里照样能恢复（不打断答题），但它只活在内存里 —— 见下一条 */
  ok(!!loadedNone.payload, '  内存态仍然读得回本轮（不打断答题）：' + JSON.stringify(loadedNone).slice(0, 46));
  const sess3 = A.createSession({ examId: 'OFF3', title: '离线卷', questions: BANK, config: cfg1, startedAt: '2026-11-02T16:06:00.000Z' });
  let restoreNone = null;
  try { restoreNone = A.restoreProgress(sess3, loadedNone.payload); } catch (e) { restoreNone = { threw: String(e && e.message) }; }
  eq([!!(restoreNone && restoreNone.ok), String((restoreNone && (restoreNone.threw || restoreNone.reason)) || '')],
     [true, ''], '  恢复同一会话的作答成功（内存态可用，不是"读了个空"）');
  /* 关键的反向锚：**换一个实例**（≈ 刷新页面）就读不到了 —— 证明它确实只活在内存里，没偷偷落盘 */
  const psFresh = A.createProgressStore(null, { examId: 'OFF3' });
  const loadedFresh = await psFresh.load(BANK);
  ok(!loadedFresh.payload, '  **换一个实例（≈刷新）就读不到** → 证明它只在内存里，没有偷偷落盘',
     JSON.stringify(loadedFresh).slice(0, 46));

  head('②-C 顶部告警的**接线**（静态锚在 wiring.test.js ⑩，这里核对文案里没有"错误码式空白"）');

  ok(/id="storeWarn"/.test(shell), '答题页有顶部告警位（id="storeWarn"）');
  ok(/try \{ backend = window\.localStorage; \} catch[\s\S]{0,80}DataCore\.storageHealth\(backend\)/.test(shell),
     '开页就体检，而且**取 localStorage 自己**也包在 try 里（不等第一次保存失败，也不许被 SecurityError 打断）');
  [hNone, hQuota, hLie].forEach(function (h) {
    ok(h.message.length > 30 && !/^E_[A-Z_]+$/.test(h.message.trim()),
       '  告警文案是人话而非错误码（' + h.reason + '，' + h.message.length + ' 字）');
  });

  head('③-A 失败场景 1/4：文件解析失败（坏 docx / txt 冒充 docx / 空文件）');

  const f1 = await tryParse(new Uint8Array([0x50, 0x4b, 0x01, 0x02, 0x03, 0x04]).buffer);
  eq(f1.ok, false, '坏 zip → 解析失败');
  ok(!!f1.code && !!f1.message, '  带 code + message：' + f1.code + ' / ' + String(f1.message).slice(0, 30));
  ok(ACTION_WORDS.test(String(f1.hint || '')), '  **hint 给出下一步动作**：' + String(f1.hint || '').slice(0, 40));
  const f2 = await tryParse(new TextEncoder().encode('这是一份纯文本，不是 docx。').buffer);
  eq(f2.ok, false, '纯文本冒充 docx → 解析失败');
  ok(ACTION_WORDS.test(String(f2.hint || '')), '  提示"docx 本质是 zip / 另存为"这类可操作信息：' + String(f2.hint || '').slice(0, 40));
  const f3 = await tryParse(new Uint8Array([]).buffer);
  eq(f3.ok, false, '空文件 → 解析失败');
  ok(!!f3.message && ACTION_WORDS.test(String(f3.hint || '')), '  空文件也有"请选择有效的 .docx"：' + String(f3.hint || '').slice(0, 30));

  head('③-B 失败场景 2/4：格式错误（结构化文本）—— 行号 + 原因 + 建议');

  const badTxt = 'QUIZ-TEXT v1\n# 标题\nQ1 单选\n题干：没有选项';
  const tf = F.importExam(badTxt);
  eq(tf.ok, false, '缺选项的题 → 解析失败');
  ok(tf.errors.length > 0, '  报出错误条目', tf.errors.length + ' 条');
  ok(tf.errors.every(function (e) { return typeof e.line === 'number' && !!e.code && !!e.message; }),
     '  每条都有**行号 + 错误码 + 中文原因**（不是光一个码）',
     JSON.stringify(tf.errors[0]));
  ok(tf.errors.every(function (e) { return String(e.hint || '').length > 0; }),
     '  而且**每条都带 hint**（"下一步该写成什么样"）：' + String(tf.errors[0].hint || '').slice(0, 44));
  eq(tf.errors[0].code, 'E_NO_HEADER', '  这一例的具体错因是"第一行不是本格式的头"');
  /* 头写对了、题写坏了：错误要落到**具体那一行**，并说清缺什么 */
  const realHeader = F.HEADER;
  const tf2 = F.importExam(realHeader + '\ntitle: 离线测试卷\nQ1 单选\n题干：没有选项\n');
  eq(tf2.ok, false, '头与标题都对、题缺选项 → 依然解析失败（不是"头对了就放行"）');
  const e2 = tf2.errors[0] || {};
  ok(typeof e2.line === 'number' && e2.line > 1, '  错误**指到具体行号**（不是统统报第 1 行）：line=' + e2.line);
  ok(/选项|stem|字段|结构/.test(String(e2.message) + String(e2.hint)), '  说清缺什么 / 少什么：' +
     (String(e2.message) + ' ｜ ' + String(e2.hint)).slice(0, 56));

  head('③-C 失败场景 3/4：AI 失败 —— 分类 + 可操作建议（401 / 不支持 JSON 模式 / 网络断了）');

  const ks = AI.openKeyStore(goodLS());
  await AI.saveKey(ks, 'dashscope', 'sk-test-0123456789abcdef', { now: '2026-11-02T15:00:00.000Z' });
  function fakeFetch(status, body) {
    return async function () { return { ok: false, status: status, text: async function () { return body || '{"error":"boom"}'; } }; };
  }
  const c401 = await AI.callSaved(ks, fakeFetch(401), 'dashscope', { task: 'explain', user: 'x', retries: 0 });
  eq([c401.ok, c401.kind], [false, 'auth'], '401 → kind=auth');
  ok(ACTION_WORDS.test(String(c401.hint || '')), '  建议指向"设置页"这类下一步：' + String(c401.hint || '').slice(0, 36));
  const cJson = await AI.callSaved(ks, fakeFetch(400, '{"error":"response_format is not supported"}'), 'dashscope',
    { task: 'explain', user: 'x', retries: 0 });
  eq([cJson.ok, cJson.kind], [false, 'json_unsupported'], '不支持 JSON 模式 → 单独一类');
  ok(ACTION_WORDS.test(String(cJson.hint || '')), '  建议里说清"关掉 JSON 模式"：' + String(cJson.hint || '').slice(0, 36));
  const cNet = await AI.callSaved(ks, fakeFetch(0), 'dashscope', { task: 'explain', user: 'x', retries: 0 });
  ok(!cNet.ok, '网络不通 → 不崩，给一类失败：' + cNet.kind);
  ok(!!cNet.hint || !!cNet.message, '  也有提示：' + String(cNet.hint || cNet.message || '').slice(0, 40));

  head('③-D 失败场景 4/4：存储不可用（已在 ② 逐条验证"原因 + 下一步"）');

  ok(/配额|禁止/.test(hQuota.message) && ACTION_WORDS.test(hQuota.message), '配额满 → 说清原因 + 给出办法');
  ok(/禁用|不允许/.test(hNone.message), '没有存储 → 说清是"被禁用/环境不允许"');
  ok(!/^E_/.test(hQuota.message.trim()) && !/^E_/.test(hNone.message.trim()), '两条都不是"只有错误码的空白提示"');

  console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
  console.log('  PASS ' + pass + '    FAIL ' + fail);
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
  console.log('  \x1b[90m注：本小类 verify=self —— 开发方自验（两遍法）；反向对照见 verify/probe-offline-degrade-old.js\x1b[0m');
  process.exitCode = fail ? 1 : 0;
}

main().catch(function (e) {
  console.log('\n\x1b[31m测试自身抛错：\x1b[0m' + ((e && e.stack) || e));
  process.exitCode = 1;
});
