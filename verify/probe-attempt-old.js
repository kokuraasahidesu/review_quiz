/* 「作答界面与触屏」· 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-attempt-old.js
 *
 * 盯的是**真挂载**那几条：把 `ui/attempt-view.js` 改坏（选项造好却不挂／不渲染输入框），
 * `verify/attempt.test.js` ④ 节必须变红。判据用的是同一套 mini-dom 与同一个挂载入口。
 */
const fs = require('fs');
const path = require('path');
const HERE = path.join(__dirname, '..');
const DOM = require('./mini-dom.js');
const S = require('../core/schema.js');
const A = require('../core/attempt.js');
const Q = require('../core/quiz.js');

function loadView(mutate, tmpRel) {
  const src = fs.readFileSync(path.join(HERE, 'ui', 'attempt-view.js'), 'utf8');
  const out = mutate(src);
  if (out === src) throw new Error('探针失效：没替换到目标文本（ui/attempt-view.js）');
  const tmp = path.join(HERE, tmpRel);
  fs.writeFileSync(tmp, out);
  delete require.cache[require.resolve(tmp)];
  return require(tmp);
}
function rm(rel) { try { fs.unlinkSync(path.join(HERE, rel)); } catch (e) { /* ignore */ } }

const FOUR = [
  S.createQuestion({ id: 'p1', type: '单选', stem: '单选', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }, { label: 'C', text: 'c' }, { label: 'D', text: 'd' }], answerLetters: ['B'], answer: 'B' }),
  S.createQuestion({ id: 'p2', type: '简答', stem: '简答', keywords: [{ text: '甲' }] })
];
/* 挂载并数一数界面上真的有几个选项按钮 / 输入框 */
function mountedCounts(View, kindIndex) {
  const doc = DOM.makeDoc();
  const host = doc.createElement('div');
  doc.documentElement.appendChild(host);
  const s = A.createSession({ examId: 'P', title: '探针卷', questions: FOUR, config: Q.DEFAULT_CONFIG, startedAt: 'T' });
  const v = View.mount({ container: host, session: s, onChange: function () {} });
  A.goto(s, kindIndex); v.refresh();
  return { opts: DOM.byClass(host, 'av-opt').length, text: DOM.byClass(host, 'av-text').length };
}

const results = [];
function probe(name, fn) {
  let red = false, note = '';
  try { const r = fn(); red = (r === true); if (typeof r === 'string') note = r; else if (r !== true) note = JSON.stringify(r); }
  catch (e) { red = '抛错:' + (e && e.message); }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red + (note ? '   ' + note : ''));
}

/* 基线：没改坏时界面上确实有 4 个选项（否则下面的"变红"没有意义） */
const base = (function () {
  const View = require('../ui/attempt-view.js');
  return mountedCounts(View, 0).opts;
})();
console.log('  （基线：未改坏时单选界面上的选项数 = ' + base + '）');

/* ---- 1. 单选/多选分支漏挂 ul（**成品里真的犯过这个错**：整类题点不了） ---- */
probe('① 选项造好却不挂 → 「界面上真有 4 个选项」锚变红', function () {
  const View = loadView(s => s.replace("        box.appendChild(ul);            // ⚠ 这一行曾经漏了：选项按钮造好了却没挂上去（单选/多选整类点不了）\n", ''),
    'ui/__probe_av1.js');
  try {
    const c = mountedCounts(View, 0);
    return (c.opts === 0 && base === 4) ? true : ('居然还挂着：' + JSON.stringify(c));
  } finally { rm('ui/__probe_av1.js'); }
});

/* ---- 2. 简答不渲染输入框 ---- */
probe('② 简答不渲染输入框 → 「有 1 个多行输入框」锚变红', function () {
  const View = loadView(s => s.replace("        box.appendChild(ta);\n", ''),
    'ui/__probe_av2.js');
  try {
    const c = mountedCounts(View, 1);
    return (c.text === 0) ? true : ('居然还有个输入框：' + JSON.stringify(c));
  } finally { rm('ui/__probe_av2.js'); }
});

/* ---- 3/4. 自动翻页**等待时间**那两条链（跨核心与界面的新行为） ----
 *   这两条要真等定时器，所以放在异步段里跑；判据仍然是"改坏之后锚必须变红"。 */
const THREE = [
  S.createQuestion({ id: 'd1', type: '单选', stem: '单选 1', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['B'], answer: 'B' }),
  S.createQuestion({ id: 'd2', type: '单选', stem: '单选 2', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['B'], answer: 'B' }),
  S.createQuestion({ id: 'd3', type: '单选', stem: '单选 3', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['B'], answer: 'B' })
];
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
function mountDelay(View, waitMs, beh) {
  const doc = DOM.makeDoc();
  const host = doc.createElement('div');
  doc.documentElement.appendChild(host);
  const cfg = Q.mergeConfig(Q.DEFAULT_CONFIG, { behavior: Object.assign({ autoNext: true, autoNextMs: waitMs }, beh || {}) });
  const s = A.createSession({ examId: 'PD', title: '等待探针', questions: THREE, config: cfg, startedAt: 'T' });
  const v = View.mount({ container: host, session: s, onChange: function () {} });
  return { doc: doc, host: host, s: s, v: v };
}

/* ---- 5. 多选又被自动判分（needsSubmit 不排除多选）→ ⑨ "点选项也不判分"锚变红 ---- */
const MIXED = [
  S.createQuestion({ id: 'm1', type: '单选', stem: '单选', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['B'], answer: 'B' }),
  S.createQuestion({ id: 'm2', type: '多选', stem: '多选', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['A', 'B'], answer: 'AB' })
];
function mountMixed(View, beh) {
  const doc = DOM.makeDoc();
  const host = doc.createElement('div');
  doc.documentElement.appendChild(host);
  const cfg = Q.mergeConfig(Q.DEFAULT_CONFIG, { behavior: Object.assign({ autoCheck: true, autoNext: true, autoNextMs: 0 }, beh || {}) });
  const s = A.createSession({ examId: 'PM', title: '多选探针', questions: MIXED, config: cfg, startedAt: 'T' });
  const v = View.mount({ container: host, session: s, onChange: function () {} });
  A.goto(s, 1); v.refresh();                       // 第 2 题是多选
  return { doc: doc, host: host, s: s, v: v };
}

probe('⑤ 多选被自动判分 → ⑨「多选点选项也不判分」锚变红', function () {
  const View = loadView(s => s.replace('      const needsSubmit = isText || isMulti;',
                                       '      const needsSubmit = isText;'),
    'ui/__probe_av5.js');
  try {
    const m = mountMixed(View);
    DOM.byClass(m.host, 'av-opt')[0].click();
    return (m.s.checked.m2 === true) ? true : '居然没判分（改坏没生效）';
  } finally { rm('ui/__probe_av5.js'); }
});

/* ---- 6. 「提交本题」按钮的出现条件被砍掉 → ⑨ "答了还没判就出现按钮"锚变红 ---- */
probe('⑥ 提交按钮的出现条件被砍 → ⑨「答了还没判就出现提交按钮」锚变红', function () {
  const View = loadView(s => s.replace('          if (m.canSubmit) {', '          if (false) {'),
    'ui/__probe_av6.js');
  try {
    const m = mountMixed(View, { autoCheck: false, autoNext: false });
    DOM.byClass(m.host, 'av-opt')[0].click();
    const n = DOM.byAttr(m.host, 'data-av', 'submit').length;
    return (n === 0) ? true : ('居然还有 ' + n + ' 个提交按钮（改坏没生效）');
  } finally { rm('ui/__probe_av6.js'); }
});

/* ---- 7. 交卷门禁的「返回继续作答」退回"只关提示、不跳题" → ⑩「自动跳到未作答那题」锚变红 ---- */
const GATE3 = [
  S.createQuestion({ id: 'g1', type: '单选', stem: '单选1', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['B'], answer: 'B' }),
  S.createQuestion({ id: 'g2', type: '单选', stem: '单选2', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['B'], answer: 'B' }),
  S.createQuestion({ id: 'g3', type: '单选', stem: '单选3', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['B'], answer: 'B' })
];
probe('⑦ 「返回继续作答」不再跳题（退回只关提示）→ ⑩「自动跳到未作答那题」锚变红', function () {
  const View = loadView(s => s.replace('        leaveTo(function () { AttemptCore.goto(session, target.index); });',
                                       '        paint();'),
    'ui/__probe_av7.js');
  try {
    const doc = DOM.makeDoc();
    const host = doc.createElement('div');
    doc.documentElement.appendChild(host);
    const s = A.createSession({ examId: 'PG', title: '门禁探针', questions: GATE3, config: Q.DEFAULT_CONFIG, startedAt: 'T' });
    const v = View.mount({ container: host, session: s, onChange: function () {} });
    DOM.byClass(host, 'av-opt')[0].click();                  // 第 1 题作答（单选点一下就判）
    A.goto(s, 2); v.refresh();                               // 停到最后一题（未答的是下标 1）
    DOM.byAttr(host, 'data-av', 'finish')[0].click();         // 交卷 → 门禁拦下
    DOM.byAttr(host, 'data-av', 'back')[0].click();           // 点「返回继续作答」
    /* 旧行为：只关提示，仍停在下标 2 → 探针返回 true（锚必红）；
     * 新行为：跳到下标 1（第一道未作答的）→ 返回 false（探针失效，说明改坏没生效）。 */
    return (s.index !== 1) ? true : ('居然还跳了：index=' + s.index);
  } finally { rm('ui/__probe_av7.js'); }
});

/* ---- 8. 「重新生成试卷」又被画回动作条（用户要求把它挪到「返回题库」旁边）---- */
const RESTART_Q = [
  S.createQuestion({ id: 'r1', type: '单选', stem: '单选1', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['B'], answer: 'B' }),
  S.createQuestion({ id: 'r2', type: '单选', stem: '单选2', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['B'], answer: 'B' })
];
probe('⑧ 动作条里又画回「再抽一次」→ ⑤-c「搬出动作条」锚变红', function () {
  const View = loadView(s => s.replace('        } else if (o.onRestart) {',
    "          actionsBox.appendChild(mk('redraw', '再抽一次', '', function () { restarts++; o.onRestart(session); }));\n" +
    '        } else if (o.onRestart) {'),
    'ui/__probe_av8.js');
  try {
    const doc = DOM.makeDoc();
    const host = doc.createElement('div');
    doc.documentElement.appendChild(host);
    const s = A.createSession({ examId: 'PR', title: '重新生成试卷探针', questions: RESTART_Q, config: Q.DEFAULT_CONFIG, startedAt: 'T' });
    View.mount({ container: host, session: s, onChange: function () {}, onRestart: function () {} });
    const n = DOM.byAttr(host, 'data-av', 'redraw').length;
    return (n > 0) ? true : '居然还是没画回来（改坏没生效）';
  } finally { rm('ui/__probe_av8.js'); }
});

/* ---- 9. 自动翻页不画小加载条（用户要求的那根"提示翻页"的条没了） ---- */
probe('⑨ 待跳时不画小加载条 → ⑥-c「出现小加载条」锚变红', function () {
  const View = loadView(s => s.replace('          if (jumpTimer !== null) {', '          if (false) {'),
    'ui/__probe_av9.js');
  try {
    const m = mountDelay(View, 200);
    DOM.byClass(m.host, 'av-opt')[1].click();               // 答对 → 排上待跳
    const pending = m.v.stats().pendingJump;
    const bars = DOM.byAttr(m.host, 'data-av', 'jumpbar').length;
    return (pending === true && bars === 0) ? true : ('居然还有 ' + bars + ' 根条（改坏没生效）');
  } finally { rm('ui/__probe_av9.js'); }
});

/* ---- 10. 顶部又重复显示题号（用户要求去掉的那一个）→ "顶部那行不再重复题号"锚变红 ---- */
probe('⑩ 顶部又加回题号徽章 → 「顶部那行不再重复题号」锚变红', function () {
  const View = loadView(s => s.replace("      head.appendChild(el(doc, 'span', 'av-badge', '已答 ' + m.progress.answered + '/' + m.progress.total));",
    "      head.appendChild(el(doc, 'span', 'av-badge', m.progressText));\n" +
    "      head.appendChild(el(doc, 'span', 'av-badge', '已答 ' + m.progress.answered + '/' + m.progress.total));"),
    'ui/__probe_av10.js');
  try {
    const doc = DOM.makeDoc();
    const host = doc.createElement('div');
    doc.documentElement.appendChild(host);
    const s = A.createSession({ examId: 'PN', title: '题号探针', questions: RESTART_Q, config: Q.DEFAULT_CONFIG, startedAt: 'T' });
    View.mount({ container: host, session: s, onChange: function () {} });
    const headTxt = String((DOM.byClass(host, 'av-head')[0] || {}).textContent);
    return headTxt.indexOf('第 ') >= 0 ? true : ('顶部居然还没有题号：' + headTxt);
  } finally { rm('ui/__probe_av10.js'); }
});

/* ---- 11. 答题界面的底部面板又长出标题（「快捷设置」那四个字挡住 / 被挡住）→ 锚变红 ---- */
probe('⑪ 底部面板又给回标题 → 「底部面板没有标题文字」锚变红', function () {
  const View = loadView(s => s.replace("        title: '',", "        title: '快捷设置',"),
    'ui/__probe_av11.js');
  try {
    const doc = DOM.makeDoc();
    const host = doc.createElement('div');
    doc.documentElement.appendChild(host);
    const s = A.createSession({ examId: 'PT', title: '标题探针', questions: RESTART_Q, config: Q.DEFAULT_CONFIG, startedAt: 'T' });
    View.mount({ container: host, session: s, onChange: function () {} });
    const titles = DOM.byClass(host, 'qk-title').length;
    return titles > 0 ? true : '换个写法之后居然还是没标题（改坏没生效）';
  } finally { rm('ui/__probe_av11.js'); }
});

/* ---- 12. 多选题又把「命中 / 未命中」标签画出来（用户要求删掉的那排）→ 锚变红 ---- */
const MULTI_Q = [
  S.createQuestion({ id: 'mm1', type: '多选', stem: '多选一题',
    options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }, { label: 'C', text: 'c' }],
    answerLetters: ['A', 'B'], answer: 'AB' })
];
probe('⑫ 多选题又画命中/未命中标签 → 「多选没有命中未命中标签」锚变红', function () {
  const View = loadView(s => s.replace('      if (!isMulti) {', '      if (true) {'),
    'ui/__probe_av12.js');
  try {
    const doc = DOM.makeDoc();
    const host = doc.createElement('div');
    doc.documentElement.appendChild(host);
    const cfg = Q.mergeConfig(Q.DEFAULT_CONFIG, { behavior: { autoCheck: false, autoNext: false } });
    const s = A.createSession({ examId: 'PM2', title: '多选标签探针', questions: MULTI_Q, config: cfg, startedAt: 'T' });
    const v = View.mount({ container: host, session: s, onChange: function () {} });
    A.answer(s, 'AB'); v.refresh();
    DOM.byAttr(host, 'data-av', 'submit')[0].click();
    const chips = DOM.byClass(host, 'av-chip').map(function (n) { return String(n.textContent); });
    const bad = chips.filter(function (t) { return t.indexOf('命中：') === 0 || t.indexOf('未命中：') === 0; });
    return bad.length > 0 ? true : ('居然还是没有那排标签（改坏没生效）：' + JSON.stringify(chips));
  } finally { rm('ui/__probe_av12.js'); }
});

/* ---- 13. 计时悬浮球不画了（用户要求的那颗球没了）→ ⑪ 锚变红 ---- */
probe('⑬ 开了计时也不画悬浮球 → ⑪「出现计时悬浮球」锚变红', function () {
  const View = loadView(s => s.replace("      if (!timerOn() || session.finished) { stopTick(); return; }",
                                       "      if (true) { stopTick(); return; }"),
    'ui/__probe_av13.js');
  try {
    const doc = DOM.makeDoc();
    const host = doc.createElement('div');
    doc.documentElement.appendChild(host);
    const cfg = Q.mergeConfig(Q.DEFAULT_CONFIG, { behavior: { timer: true, autoCheck: false, autoNext: false } });
    const s = A.createSession({ examId: 'PT', title: '计时探针', questions: RESTART_Q, config: cfg, startedAt: 'T' });
    const v = View.mount({ container: host, session: s, onChange: function () {} });
    const n = DOM.byAttr(host, 'data-av', 'timer').length;
    v.destroy();                       // ⚠ 必须销毁：计时是 setInterval，留着它 Node 进程永不退出（踩过）
    return (n === 0) ? true : ('居然还画了 ' + n + ' 颗球（改坏没生效）');
  } finally { rm('ui/__probe_av13.js'); }
});

/* ---- 14. 点球不暂停（读数照走）→ ⑪「点一下 → 暂停」锚变红 ---- */
probe('⑭ 点球不暂停 → ⑪「点一下 → 暂停」锚变红', function () {
  const View = loadView(s => s.replace("      if (t.paused) { t.paused = false; baseAt = Date.now(); }\n      else { t.ms = timerTotal(); t.paused = true; baseAt = 0; }",
                                       "      if (t.paused) { t.paused = false; baseAt = Date.now(); }"),
    'ui/__probe_av14.js');
  try {
    const doc = DOM.makeDoc();
    const host = doc.createElement('div');
    doc.documentElement.appendChild(host);
    const cfg = Q.mergeConfig(Q.DEFAULT_CONFIG, { behavior: { timer: true, autoCheck: false, autoNext: false } });
    const s = A.createSession({ examId: 'PT2', title: '暂停探针', questions: RESTART_Q, config: cfg, startedAt: 'T' });
    const v = View.mount({ container: host, session: s, onChange: function () {} });
    DOM.byAttr(host, 'data-av', 'timer')[0].click();
    const paused = v.stats().timerPaused;
    v.destroy();                       // 同上：不销毁的话计时定时器会让 Node 不退出
    return (paused === false) ? true : '居然暂停了（改坏没生效）';
  } finally { rm('ui/__probe_av14.js'); }
});

(async function () {
  await (async function () {
    let red = false, note = '';
    try {
      const View = loadView(s => s.replace('      if (wait === 0) { doJump(from); return; }',
                                          '      if (true) { doJump(from); return; }'),
        'ui/__probe_av3.js');
      const m = mountDelay(View, 200);
      DOM.byClass(m.host, 'av-opt')[1].click();
      red = (m.s.index !== 0) || (m.v.stats().pendingJump !== true);
      note = '改坏后：题号=' + m.s.index + ' 待跳=' + m.v.stats().pendingJump;
    } catch (e) { red = '抛错:' + (e && e.message); }
    finally { rm('ui/__probe_av3.js'); }
    results.push(['③ 配了等待时间却立刻翻 → ⑧ "点完先不翻、排着待跳"锚变红', red]);
    console.log((red === true ? '  OK  ' : '  ??  ') + '③ 配了等待时间却立刻翻 → ⑧ "点完先不翻、排着待跳"锚变红   锚变红=' + red + (note ? '   ' + note : ''));
  })();

  /* 手动翻页**不取消**待跳 → 定时器还在（8-⑦ 的锚会红）。
   * ⚠ 这条锚其实有**两道**防线：① `cancelJump()` 真的 clearTimeout；② 定时器到点时 `doJump`
   *   再核对一次题号（`session.index !== from` 就不跳）。只拆掉②不会变红（①已经把定时器撤了），
   *   所以这条探针拆的是①，判据看的是"手动翻页之后**还挂着待跳**"——这正是①独有的效果。 */
  await (async function () {
    let red = false, note = '';
    try {
      const View = loadView(s => s.replace('      if (jumpTimer !== null) { clearTimeout(jumpTimer); jumpTimer = null; }\n      pendingIndex = -1;\n      pendingWaitMs = 0;\n    }',
                                          '      pendingIndex = -1;\n      pendingWaitMs = 0;\n    }'),
        'ui/__probe_av4.js');
      const m = mountDelay(View, 120);
      DOM.byClass(m.host, 'av-opt')[1].click();               // 排上待跳
      DOM.byAttr(m.host, 'data-av', 'next')[0].click();       // 自己翻到第 2 题
      const stillPending = m.v.stats().pendingJump;           // ① 该被撤掉的那个定时器
      await sleep(260);                                       // 等过原定时刻
      red = (stillPending !== false) || (m.s.index !== 1);
      note = '改坏后：手动翻页后仍待跳=' + stillPending + '，最终题号=' + m.s.index + '（锚要求 false / 1）';
    } catch (e) { red = '抛错:' + (e && e.message); }
    finally { rm('ui/__probe_av4.js'); }
    results.push(['④ 手动翻页不取消待跳 → ⑧ "取消真的生效"锚变红', red]);
    console.log((red === true ? '  OK  ' : '  ??  ') + '④ 手动翻页不取消待跳 → ⑧ "取消真的生效"锚变红   锚变红=' + red + (note ? '   ' + note : ''));
  })();

  /* ---- ⑪~⑬ 用户本轮那几条界面规矩（判据在 attempt.test.js 里，所以在这里做"改源码 → 跑套件"）---- */
  const { execFileSync } = require('child_process');
  const VIEW_SRC = path.join(HERE, 'ui', 'attempt-view.js');
  const swapView = function (label, needle, repl) {
    let red = false, note = '';
    const bak = VIEW_SRC + '.probe-bak';
    try {
      const src = fs.readFileSync(VIEW_SRC, 'utf8');
      if (src.indexOf(needle) < 0) throw new Error('没找到待替换片段：' + needle.slice(0, 50));
      fs.writeFileSync(bak, src, 'utf8');
      fs.writeFileSync(VIEW_SRC, src.replace(needle, repl), 'utf8');
      let text = '';
      try { text = execFileSync(process.execPath, [path.join(__dirname, 'attempt.test.js')], { encoding: 'utf8' }); }
      catch (e) { text = String((e && e.stdout) || '') + String((e && e.stderr) || ''); }
      const m = /PASS (\d+)\s+FAIL (\d+)/.exec(text);
      red = !!(m && parseInt(m[2], 10) > 0);
      note = m ? ('改坏后 PASS=' + m[1] + ' FAIL=' + m[2]) : '（没读到汇总）';
    } catch (e) { red = '抛错:' + (e && e.message); }
    finally {
      try { if (fs.existsSync(bak)) { fs.writeFileSync(VIEW_SRC, fs.readFileSync(bak, 'utf8'), 'utf8'); fs.unlinkSync(bak); } } catch (e2) { /* ignore */ }
    }
    results.push([label, red]);
    console.log((red === true ? '  OK  ' : '  ??  ') + label + '   锚变红=' + red + (note ? '   ' + note : ''));
  };
  swapView('⑪ 选项不再标对错 → 「选错标红 / 正确标绿」锚变红',
    "      b.setAttribute('data-mark', mark);", "      b.setAttribute('data-mark', '');");
  swapView('⑫ 题型切换不弹悬浮提示 → 「换题型 → 弹出悬浮提示」锚变红',
    '      if (changed && !m.finished) showTypeFlash(', '      if (false) showTypeFlash(');
  swapView('⑬ 又加回「看完自己点下一题」那句叮嘱 → 「不再叮嘱」锚变红',
    "        p.appendChild(el(doc, 'h4', null, '正确答案：' + (m.answerText || '（无）')));",
    "        p.appendChild(el(doc, 'div', 'av-hint', '答错了：看完正确答案自己点「下一题」'));\n"
      + "        p.appendChild(el(doc, 'h4', null, '正确答案：' + (m.answerText || '（无）')));");

  const bad = results.filter(r => r[1] !== true);
  console.log('\n探针汇总：' + results.length + ' 条  全部能让锚变红=' + (bad.length === 0));
  if (bad.length) { bad.forEach(b => console.log('  未变红：' + b[0] + ' → ' + b[1])); process.exitCode = 1; }
})();
