/* 错题本视图装配 · 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-wrongview-ui-old.js
 * 每行必须打印 "锚变红=true"；出现 false 说明那条断言在测空气。
 *
 * 说明：本探针把 ui/wrong-view.js 的源码**字符串替换**回改造前的写法，
 * 用同一套 mini-dom 再挂一次，看验收锚会不会当场变红。
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
  delete require.cache[require.resolve('../core/wrong.js')];   // tmp 文件里 require 的是同一份核心
  return require(tmp);
}
function rm(rel) { try { fs.unlinkSync(path.join(HERE, rel)); } catch (e) { /* ignore */ } }

const DOM = require('./mini-dom.js');
const W = require('../core/wrong.js');
const A = require('../core/attempt.js');
const Q = require('../core/quiz.js');
const S = require('../core/schema.js');

const EX = S.createExam({
  id: 'P1', title: '探针卷', schemaVersion: S.SCHEMA_VERSION,
  questions: [
    S.createQuestion({ id: 'P1-q1', type: '单选', stem: '探针题干一', options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }], answerLetters: ['A'], explanation: '探针解析一' }),
    S.createQuestion({ id: 'P1-q2', type: '判断', stem: '探针题干二', judgeValue: true, explanation: '探针解析二' })
  ]
}, { now: '2026-10-20T00:00:00.000Z' });

function book() {
  const s = A.createSession({ examId: EX.id, title: EX.title, questions: EX.questions, config: Q.mergeConfig(Q.DEFAULT_CONFIG, {}) });
  EX.questions.forEach(function (q, i) { A.goto(s, i); A.answer(s, q.type === '判断' ? '×' : 'B'); A.submitCurrent(s); });
  const fin = A.finish(s, { confirmUnanswered: true, now: '2026-10-20T01:00:00.000Z' });
  const byId = {}; EX.questions.forEach(function (q) { byId[q.id] = q; });
  const b = W.createBook(EX.id, '2026-10-20T01:00:00.000Z');
  W.collect(b, fin.summary.per, { now: '2026-10-20T01:00:00.000Z', sessionAt: 'PS', questionsById: byId, answers: s.answers });
  return b;
}
function clone(e) { return JSON.parse(JSON.stringify(e)); }
function mountWith(View, books) {
  const doc = DOM.makeDoc();
  const c = doc.createElement('div');
  doc.documentElement.appendChild(c);
  const jumped = [];
  const v = View.mount({ container: c, books: books, onJump: function (id, i) { jumped.push([id, i]); } });
  return { doc: doc, c: c, v: v, jumped: jumped };
}

const results = [];
function probe(name, fn) {
  let red = false;
  try { red = fn(); } catch (e) { red = '抛错:' + (e && e.message); }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red);
}

const BK = book();
console.log('  前置：探针本子 ' + Object.keys(BK.entries).length + ' 条 / 卷 ' + EX.questions.length + ' 题');

/* ---- 1. refresh 只换 books、不重建卷册映射（改造前的原样） ---- */
probe('① refresh 不重建卷册映射 → ④-A/④-B（改名与改题干必须立刻生效）变红', function () {
  const View = loadFrom('ui/wrong-view.js',
    s => s.replace(/      refresh: function \(nextBooks, nextExams\) \{\n        if \(nextExams\) baseExams = Object\.assign\(\{\}, nextExams\);\n        if \(Array\.isArray\(nextBooks\)\) books = nextBooks;\n        rebuildExams\(\); paint\(\);\n      \},/,
                     '      refresh: function (nextBooks) { if (Array.isArray(nextBooks)) books = nextBooks; paint(); },'),
    'ui/__probe_wv1.js');
  try {
    const m = mountWith(View, [{ book: BK, exam: EX }]);
    const renamed = clone(EX); renamed.title = '改了名的卷';
    m.v.refresh([{ book: BK, exam: renamed }]);
    const titleStale = m.v.groups()[0].title !== '改了名的卷';       // 应立刻变新标题
    const mutated = clone(EX); mutated.questions[0].stem = '改过的题干';
    m.v.refresh([{ book: BK, exam: mutated }]);
    m.v.select('P1', 'P1-q1');
    const stemEl = DOM.byAttr(DOM.byClass(m.c, 'wv-tile')[0], 'data-wv', 'stem')[0];
    const stemStale = !stemEl || stemEl.textContent !== '改过的题干';
    return titleStale && stemStale;                                 // 两条都必须红
  } finally { rm('ui/__probe_wv1.js'); }
});

/* ---- 2. 详情不从试卷现读，改用误答本里的快照冒充原题 ---- */
probe('② 详情拿快照冒充原题 → ②-B（原题逐字等于卷子）变红', function () {
  const View = loadFrom('ui/wrong-view.js',
    s => s.replace("      const stemEl = el(doc, 'div', null, d.question ? d.question.stem : ('（原题已不在试卷里）快照：' + d.snapshot.stem));",
                   "      const stemEl = el(doc, 'div', null, d.snapshot.stem);"),
    'ui/__probe_wv2.js');
  try {
    const mutated = clone(EX); mutated.questions[0].stem = '改过的题干';
    const m = mountWith(View, [{ book: BK, exam: mutated }]);
    m.v.select('P1', 'P1-q1');
    const stemEl = DOM.byAttr(DOM.byClass(m.c, 'wv-tile')[0], 'data-wv', 'stem')[0];
    return !stemEl || stemEl.textContent !== '改过的题干';           // 快照顶替原题 → 锚红
  } finally { rm('ui/__probe_wv2.js'); }
});

/* ---- 3. 题不在卷里也把按钮画成可用 ---- */
probe('③ 跳转按钮不按 d.jump 禁用 → ⑤-B（题被删→禁用）变红', function () {
  const View = loadFrom('ui/wrong-view.js',
    s => s.replace('      jump.disabled = !d.jump;', '      jump.disabled = false;'),
    'ui/__probe_wv3.js');
  try {
    const cut = clone(EX); cut.questions = cut.questions.filter(function (q) { return q.id !== 'P1-q2'; });
    const m = mountWith(View, [{ book: BK, exam: cut }]);
    m.v.select('P1', 'P1-q2');
    const btn = DOM.byAttr(m.c, 'data-wv', 'jump')[0];
    return !btn || btn.disabled !== true;                           // 按钮应当被禁用
  } finally { rm('ui/__probe_wv3.js'); }
});

/* ---- 5. 点击回调不再检查 jumpTarget.ok（按钮也不禁用 → 两道防线一起拆） ---- */
probe('⑤ 点击不校验 jumpTarget.ok → ⑤-C（禁用按钮不回调）变红', function () {
  const View = loadFrom('ui/wrong-view.js',
    s => s.replace('      jump.disabled = !d.jump;', '      jump.disabled = false;')
          .replace('      if (!t.ok) return false;', '      if (false) return false;'),
    'ui/__probe_wv5.js');
  try {
    const cut = clone(EX); cut.questions = cut.questions.filter(function (q) { return q.id !== 'P1-q2'; });
    const m = mountWith(View, [{ book: BK, exam: cut }]);
    m.v.select('P1', 'P1-q2');
    const btn = DOM.byAttr(m.c, 'data-wv', 'jump')[0];
    if (btn) btn.click();
    return m.jumped.length > 0;                                     // 跳不过去却回调了 → 锚红
  } finally { rm('ui/__probe_wv5.js'); }
});

/* ---- 6. 磁贴画到分组底部（不是"本题与下一题之间"）→ ② 的位置锚变红 ---- */
probe('⑥ 磁贴画到分组末尾（退回"底部显示"）→ ②「紧跟在被点那条后面」锚变红', function () {
  const View = loadFrom('ui/wrong-view.js',
    s => s.replace('            ul.appendChild(tileLi);', '            box.appendChild(tileLi);'),
    'ui/__probe_wv6.js');
  try {
    const m = mountWith(View, [{ book: BK, exam: EX }]);
    m.v.select('P1', 'P1-q1');
    const items = DOM.byAttr(m.c, 'data-wv', 'item');
    const li = items[0].parentNode;
    const nxt = li.nextSibling;                                     // mini-dom：用 parent 的 children 找下一个
    const kids = li.parentNode.children;
    const at = kids.indexOf(li);
    const nextIsTile = !!(kids[at + 1] && kids[at + 1].className === 'wv-tile-li');
    void nxt;
    return !nextIsTile;                                             // 磁贴不在下一位 → 锚红
  } finally { rm('ui/__probe_wv6.js'); }
});

/* ---- 7. 双击不再直接跳 → ②-d 的"双击 = 跳到这道题"锚变红 ---- */
probe('⑦ 双击不触发跳转（dblclick 监听被删）→ ②-d 锚变红', function () {
  const View = loadFrom('ui/wrong-view.js',
    s => s.replace(/          b\.addEventListener\('dblclick', function \(\) \{\n            sel = \{ examId: g\.examId, qid: e\.qid \};\n            jumpTo\(g, e\);\n          \}\);\n/, ''),
    'ui/__probe_wv7.js');
  try {
    const m = mountWith(View, [{ book: BK, exam: EX }]);
    const it = DOM.byAttr(m.c, 'data-wv', 'item')[1];
    it.dispatchEvent('dblclick');
    return m.jumped.length === 0;                                   // 双击没反应 → 锚（要求 ≥1 次跳转）红
  } finally { rm('ui/__probe_wv7.js'); }
});

/* ---- 8. 举一反三按钮不回调 / 小字说明不画 → ②-b 的两条锚变红 ---- */
probe('⑧ 举一反三按钮不回调 + 小字说明不画 → ②-b 锚变红', function () {
  const View = loadFrom('ui/wrong-view.js',
    s => s.replace('        if (o.onMistake) o.onMistake(g.examId, e.qid);', '        void 0;')
          .replace('      row.appendChild(jump); row.appendChild(mk); row.appendChild(hint); row.appendChild(close);',
                   '      row.appendChild(jump); row.appendChild(mk); row.appendChild(close);'),
    'ui/__probe_wv8.js');
  try {
    const doc = DOM.makeDoc();
    const c = doc.createElement('div');
    doc.documentElement.appendChild(c);
    const got = [];
    const v = View.mount({ container: c, books: [{ book: BK, exam: EX }], onMistake: function (id, qid) { got.push([id, qid]); } });
    v.select('P1', 'P1-q1');
    const tile = DOM.byClass(c, 'wv-tile')[0];
    const mk = DOM.byAttr(tile, 'data-wv', 'mistake')[0];
    if (mk) mk.click();
    const noHint = DOM.byClass(tile, 'wv-hint').length === 0;
    return got.length === 0 && noHint;                              // 两条都该红
  } finally { rm('ui/__probe_wv8.js'); }
});

/* ---- 4. 列表少画（只画第一条）→ ①-A（界面条目数=误答数）变红 ---- */
probe('④ 列表只画第一条 → ①-A（界面条目数 = 误答数）变红', function () {
  const View = loadFrom('ui/wrong-view.js',
    s => s.replace('        g.entries.forEach(function (e) {', '        g.entries.slice(0, 1).forEach(function (e) {'),
    'ui/__probe_wv4.js');
  try {
    const m = mountWith(View, [{ book: BK, exam: EX }]);
    const n = DOM.byAttr(m.c, 'data-wv', 'item').length;
    return n !== Object.keys(BK.entries).length;                    // 条目数应当恒等于本子长度
  } finally { rm('ui/__probe_wv4.js'); }
});

const bad = results.filter(r => r[1] !== true);
console.log('\n探针汇总：' + results.length + ' 条  全部能让锚变红=' + (bad.length === 0));
if (bad.length) { bad.forEach(b => console.log('  未变红：' + b[0] + ' → ' + b[1])); process.exitCode = 1; }

