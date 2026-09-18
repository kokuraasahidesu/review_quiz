/* 抽题策略 · 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-picking-old.js
 *
 * 目的：证明 verify/picking.test.js 里的新锚**真的能抓到旧行为**（不是空转）。
 * 做法：读 core/quiz.js → 把某一处新行为字符串替换回旧写法 → 落成临时模块 → 跑对应判定。
 * 每一行必须打印 "锚变红=true"；出现 false 说明那条断言在测空气。
 *
 * ⚠ 它靠**字符串替换**定位代码：若 core/quiz.js 那几行被重构，探针会直接报
 *   「探针失效：没替换到目标文本」并退出 1 —— 那不是产品坏了，是**提醒你重新确认**
 *   对应断言是否还有效（重构后锚可能已经不再对准旧缺陷）。
 */
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'core', 'quiz.js');
const TMP = path.join(__dirname, '..', 'core', '__probe_quiz.js');

function load(mutate) {
  const src = fs.readFileSync(SRC, 'utf8');
  const out = mutate(src);
  if (out === src) throw new Error('探针失效：没替换到目标文本');
  fs.writeFileSync(TMP, out);
  delete require.cache[require.resolve(TMP)];
  return require(TMP);
}
function cleanup() { try { fs.unlinkSync(TMP); } catch (e) { /* ignore */ } }

const P4 = { '单选': 2, '多选': 3, '判断': 1, '简答': 5 };
const bank = (spec) => {
  const out = [];
  Object.keys(spec).forEach(t => { for (let i = 1; i <= spec[t]; i++) out.push({ id: 'q-' + t + '-' + i, type: t, stem: t + i }); });
  return out;
};
const B = bank({ '单选': 50, '多选': 20, '判断': 50, '简答': 50 });
const cfg = (p) => p;
const sig = r => r.questions.map(q => q.id).join('|');
const results = [];
function probe(name, fn) {
  let red = false, detail = '';
  try { red = fn(); } catch (e) { red = '抛错:' + (e && e.message); }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red);
}

/* ---- 1. 种子的 `|| 1`（0 被吞） ---- */
probe('① 旧写法 `seed || 1`：seed=0 与 seed=1 结果相同 → ④-B 的"0 与 1 不同"必须变红', function () {
  const Q = load(s => s.replace(
    'const seed = (typeof pick.seed === \'number\' && isFinite(pick.seed)) ? pick.seed : dflt.seed;',
    'const seed = pick.seed || 1;'));
  const a = sig(Q.pickQuestions(B, cfg({ points: P4, pick: { mode: 'random', randomBasis: 'count', count: 20, seed: 0 } })));
  const b = sig(Q.pickQuestions(B, cfg({ points: P4, pick: { mode: 'random', randomBasis: 'count', count: 20, seed: 1 } })));
  return a === b;                       // 旧行为下两者相同 → 锚（要求不同）会红
});

/* ---- 2. 缺口总数拿"整库题数"比大小 ---- */
probe('② 旧写法（缺口=要求总数 vs 整库题数）：某题型不够但总量充足时报 0 → ⑤-B 必须变红', function () {
  const Q = load(s => s.replace(
    'const shortageCount = Object.keys(byTypeShortfall).reduce(function (s, t) { return s + byTypeShortfall[t].gap; }, 0)',
    'const shortageCount = ((TYPE_KEYS.reduce(function (s, t) { return s + byTypeWant[t]; }, 0)) > poolRes.total) ? 1 : 0'));
  const lop = Q.pickQuestions(bank({ '单选': 50, '多选': 0, '判断': 50, '简答': 50 }),
    cfg({ points: P4, pick: { mode: 'byCount', byType: { '单选': 1, '多选': 5, '判断': 1, '简答': 1 } } }));
  return lop.meta.shortageCount !== 5;  // 旧行为 = 0 ≠ 5 → 锚红
});

/* ---- 3. random 模式把"没抽到某题型"谎报成缺口 ---- */
probe('③ 旧写法（随机没抽到某题型=缺口）：题量充足也报警 → ⑤-D 必须变红', function () {
  const Q = load(s => s.replace(
    '    const byTypeShortfall = {};\n    if (mode === \'byCount\') {',
    '    const byTypeShortfall = {};\n' +
    '    if (mode === \'random\') { TYPE_KEYS.forEach(function (t) { if (byType[t] === 0 && pool[t].length > 0) byTypeShortfall[t] = { want: \'随机未抽到\', got: 0, gap: 0 }; }); }\n' +
    '    if (mode === \'byCount\') {'));
  const r = Q.pickQuestions(B, cfg({ points: P4, pick: { mode: 'random', randomBasis: 'count', count: 1, seed: 4 } }));
  return Object.keys(r.meta.byTypeShortfall).length !== 0 || r.meta.warn !== null;
});

/* ---- 4. 缺项当 0（`targetScore || 0`） ---- */
probe('④ 旧写法（缺项当 0）：部分配置静默抽 0 题 → ④-C 必须变红', function () {
  const Q = load(s => s.replace(
    'targetScore = Math.max(0, numOr(pick.targetScore, dflt.targetScore, \'pick.targetScore\'));',
    'targetScore = pick.targetScore || 0;'));
  const r = Q.pickQuestions(B, cfg({ points: P4, pick: { mode: 'byWeight' } }));
  return r.meta.targetScore !== 100 || r.questions.length === 0;
});

/* ---- 5. 不去重 / 不挡无效题 ---- */
probe('⑤ 旧写法（不按 id 去重、不过滤 null）：重复题与空白题进试卷 → ⑤-E 必须变红', function () {
  const Q = load(s => s.replace(
    '      if (seen[id]) { duplicates.push(id); return; }',
    '      if (false) { duplicates.push(id); return; }'));
  const dirty = [
    { id: 'dup-1', type: '单选', stem: 'a' }, { id: 'dup-1', type: '单选', stem: '副本' },
    { id: 'ok-1', type: '判断', stem: 'b' }, null, { id: 'ok-2', type: '简答', stem: 'c' }
  ];
  const r = Q.pickQuestions(dirty, cfg({ points: P4, pick: { mode: 'random', randomBasis: 'count', count: 10, seed: 2 } }));
  const hasBlank = r.questions.some(q => !q || !q.id);
  const dupCount = new Set(r.questions.map(q => q && q.id)).size !== r.questions.length;
  return hasBlank || dupCount;
});

/* ---- 6. 「全部作答」没实现（mode=all 落进"没有分支匹配"→ 走随机那条兜底路） ---- */
probe('⑥ mode=all 不实现（落成随机兜底抽取）→ ⑦ 的"整套卷按原顺序上"必须变红', function () {
  const Q = load(s => s.replace('    if (mode === \'all\') {', '    if (false) {'));
  /* ⚠ 题库要**大于随机的默认题量(20)**：题库比 20 小的话，兜底那条随机路会把 8 道全抽走、
   *   恰好与"全部作答"同数 —— 那样这个探针就测不出区别了（第一版就是这么白跑的）。 */
  const Big = bank({ '单选': 12, '多选': 8, '判断': 6, '简答': 4 });     // 30 道
  const r = Q.pickQuestions(Big, cfg({ points: P4, pick: { mode: 'all' } }));
  return r.questions.length !== Big.length;      // 坏行为：只抽 20 道 ≠ 30 道 → 锚红
});

/* ---- 7. 按题库自适应：从不适配（没有的题型照样留着目标，界面一直喊"缺 N 题"） ---- */
probe('⑦ adaptPickToBank 从不适配（空题型保留原值）→ ⑧ 的"简答自动置 0"必须变红', function () {
  const Q = load(s => s.replace('      const empty = (pool[t].length === 0);', '      const empty = false;'));
  const ad = Q.adaptPickToBank(bank({ '单选': 5, '多选': 4, '判断': 3 }),
    Q.mergeConfig(Q.DEFAULT_CONFIG, {}));
  return ad.config.pick.byType['简答'] !== 0;     // 坏行为：简答还是 2 → 锚红
});

/* ---- 8. 反向过头：把**有题**的题型也置 0（用户的数被清掉，抽不到题） ---- */
probe('⑧ adaptPickToBank 适配过头（有题的也置 0）→ ⑧ 的"其余三型原值保留"必须变红', function () {
  const Q = load(s => s.replace('      const empty = (pool[t].length === 0);', '      const empty = true;'));
  const ad = Q.adaptPickToBank(bank({ '单选': 5, '多选': 4, '判断': 3 }),
    Q.mergeConfig(Q.DEFAULT_CONFIG, {}));
  return ad.config.pick.byType['单选'] !== 10;    // 坏行为：单选被清成 0 → 锚红
});

/* ---- 9. 「未作答优先」的档位被忽略（grab 退回成"整库洗一遍"） ---- */
/* 坏行为 = 旧写法：`grab = shuffle(list,rnd).slice(0,n)`（根本没人看 priority）。
 * 锚（⑨ 的"12 道欠账题一道不落 / 已答对的 0 道"）此时必须变红：欠账题混不进来。 */
probe('⑨ 旧写法（档位被忽略，grab 直接洗整库）→ ⑨ 的"欠账题一道不落"必须变红', function () {
  const Q = load(s => s.replace('    const grab = function (list, n) { return tiered(list, n); };',
                                '    const grab = function (list, n) { return shuffle(list, rnd).slice(0, Math.max(0, n)); };'));
  const list = bank({ '单选': 10, '多选': 10, '判断': 10, '简答': 10 });
  const tiers = {};
  list.forEach(function (q) {
    const n = Number(String(q.id).split('-').pop());
    tiers[q.id] = (n <= 3) ? 2 : (n >= 8 ? 0 : 1);
  });
  const owed = list.filter(q => Number(q.id.split('-').pop()) <= 3).map(q => q.id);
  const r = Q.pickQuestions(list, cfg({ points: P4, pick: { mode: 'random', count: 12, seed: 5, prefer: 'unansweredFirst' } }),
    { priority: tiers });
  const got = r.questions.map(q => q.id);
  return !owed.every(id => got.indexOf(id) >= 0);     // 坏行为：8 道欠账里混不进若干道 → 锚红
});

/* ---- 10. 偏好看**错误的数据源**（档位表里的题一律当 0 档，等于没优先） ---- */
probe('⑩ 档位表读不出来也算"生效"（无优先却报 preferApplied）→ ⑨ 的 preferApplied 必须变红', function () {
  const Q = load(s => s.replace('        preferApplied: (prefer === \'unansweredFirst\' && !!priority),',
                                '        preferApplied: (prefer === \'unansweredFirst\'),'));
  const list = bank({ '单选': 10, '多选': 10 });
  const r = Q.pickQuestions(list, cfg({ points: P4, pick: { mode: 'random', count: 5, seed: 5, prefer: 'unansweredFirst' } }));
  return r.meta.preferApplied !== false;              // 坏行为：没档位表却报 true → 锚红
});

cleanup();
const bad = results.filter(r => r[1] !== true);
console.log('\n探针汇总：' + results.length + ' 条  全部能让锚变红=' + (bad.length === 0));
if (bad.length) { bad.forEach(b => console.log('  未变红：' + b[0] + ' → ' + b[1])); process.exitCode = 1; }
