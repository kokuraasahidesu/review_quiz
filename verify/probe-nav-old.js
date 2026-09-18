/* 题号导航 · 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-nav-old.js
 *
 * 目的：证明 verify/nav.test.js 里的锚**真的能抓到错行为**（不是空转）。
 * 每行必须打印 "锚变红=true"；出现 false 说明那条断言在测空气。
 * ⚠ 靠字符串替换定位代码：core/attempt.js 那几行被重构时会直接报「探针失效」。
 */
const fs = require('fs');
const path = require('path');
const HERE = path.join(__dirname, '..');
const SRC = path.join(HERE, 'core', 'attempt.js');
const TMP = path.join(HERE, 'core', '__probe_attempt.js');

function load(mutate) {
  const src = fs.readFileSync(SRC, 'utf8');
  const out = mutate(src);
  if (out === src) throw new Error('探针失效：没替换到目标文本');
  fs.writeFileSync(TMP, out);
  delete require.cache[require.resolve(TMP)];
  return require(TMP);
}
function cleanup() { try { fs.unlinkSync(TMP); } catch (e) { /* ignore */ } }

const results = [];
function probe(name, fn) {
  let red = false;
  try { red = fn(); } catch (e) { red = '抛错:' + (e && e.message); }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red);
}
const Q = require('../core/quiz.js');
const mk = n => Array.from({ length: n }, (_, i) => ({ id: 'q' + i, type: '单选', stem: 's' + i, answerLetters: ['A'] }));
const cfg = (A) => A.createSession({ title: 't', questions: mk(4), config: Q.mergeConfig(Q.DEFAULT_CONFIG, {}) });

/* ---- 1. 高亮：当前题标记错（或永远不高亮） ---- */
probe('① 当前题标记恒为 false → ①-A/①-C 必须变红', function () {
  const A = load(s => s.replace('answered: answered, checked: checked, current: i === session.index,',
                                'answered: answered, checked: checked, current: false,'));
  const s = cfg(A);
  return A.navModel(s).filter(c => c.current).length !== 1;
});

/* ---- 2. 高亮：跟着 index 走（点哪指哪） ---- */
probe('② 高亮固定在 0 号格 → ①-B 必须变红', function () {
  const A = load(s => s.replace('current: i === session.index,', 'current: i === 0,'));
  const s = cfg(A);
  A.goto(s, 3);
  const cur = A.navModel(s).filter(c => c.current);
  return !(cur.length === 1 && cur[0].index === 3);
});

/* ---- 3. 已答/未答：状态写死 ---- */
probe('③ 已答状态恒为 true → ②-A 必须变红', function () {
  const A = load(s => s.replace('const answered = isAnswered(q, session.answers[q.id]);\n      const checked = !!session.checked[q.id];',
                                'const answered = true;\n      const checked = !!session.checked[q.id];'));
  const s = cfg(A);
  return A.navModel(s).filter(c => c.answered).length !== 0;   // 一题没答却全是"已答"
});

/* ---- 4. 交卷门禁：有未答也放行 ---- */
probe('④ gate 恒 ok → ③-A 必须变红', function () {
  const A = load(s => s.replace('    if (!g.ok && !o.confirmUnanswered) {', '    if (false) {'));
  const s = cfg(A);
  return A.finish(s).ok === true;                              // 全未答却直接结算
});

/* ---- 5. 交卷门禁：提示不列题号 ---- */
probe('⑤ 未答提示不列题号 → ③-A/③-C 必须变红', function () {
  const A = load(s => s.replace("unanswered: unanswered, unansweredLabels: labels,",
                                "unanswered: unanswered, unansweredLabels: [],"));
  const s = cfg(A);
  A.answer(s, 'A');
  const r = A.finish(s);
  return r.ok === false && (r.unansweredLabels.length === 0);   // 挡住了但没告诉用户哪些题
});

/* ---- 6. 对错标记的泄露面：不只在允许揭示时给 ---- */
probe('⑥ correct 不看揭示口径 → ②-B 必须变红', function () {
  const A = load(s => s.replace('correct: (reveal.showAnswer && r) ? r.correct : null,', 'correct: r ? r.correct : null,'));
  const s = cfg(A);
  A.answer(s, 'B'); A.submitCurrent(s);                        // 故意答错；默认时机=整卷后
  return A.navModel(s)[0].correct !== null;                    // 不该给对错却给了 → 锚红
});

cleanup();
const bad = results.filter(r => r[1] !== true);
console.log('\n探针汇总：' + results.length + ' 条  全部能让锚变红=' + (bad.length === 0));
if (bad.length) { bad.forEach(b => console.log('  未变红：' + b[0] + ' → ' + b[1])); process.exitCode = 1; }
