/* 行为开关与分数线 · 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-flow-old.js
 *
 * 目的：证明 verify/flow.test.js 里的新锚**真的能抓到旧/错行为**（不是空转）。
 * 每一行必须打印 "锚变红=true"；出现 false 说明那条断言在测空气。
 *
 * ⚠ 靠字符串替换定位代码：若 core/flow.js 那几行被重构，探针会直接报
 *   「探针失效」并退出 1 —— 那是提醒你重新确认对应断言是否还有效。
 */
const fs = require('fs');
const path = require('path');
const HERE = path.join(__dirname, '..');
const SRC = path.join(HERE, 'core', 'flow.js');
const TMP = path.join(HERE, 'core', '__probe_flow.js');

function load(mutate) {
  const src = fs.readFileSync(SRC, 'utf8');
  const out = mutate(src);
  if (out === src) throw new Error('探针失效：没替换到目标文本');
  fs.writeFileSync(TMP, out);
  delete require.cache[require.resolve(TMP)];
  return require(TMP);
}
function cleanup() { try { fs.unlinkSync(TMP); } catch (e) { /* ignore */ } }

/* ⚠ 逐题型目标分的逻辑住在 **quiz.js**（抽题算法），不在 flow.js —— 需要另开一个加载器。
 *   以前只在 flow.js 上做字符串替换，探针 ⑧ 就是因为"替换不到"而报「探针失效」。 */
const QSRC = path.join(HERE, 'core', 'quiz.js');
const QTMP = path.join(HERE, 'core', '__probe_quiz.js');
function loadQuiz(mutate) {
  const src = fs.readFileSync(QSRC, 'utf8');
  const out = mutate(src);
  if (out === src) throw new Error('探针失效：没替换到目标文本（core/quiz.js）');
  fs.writeFileSync(QTMP, out);
  delete require.cache[require.resolve(QTMP)];
  return require(QTMP);
}
function cleanupQuiz() { try { fs.unlinkSync(QTMP); } catch (e) { /* ignore */ } }

const Q = require('../core/quiz.js');
const cfg = (p) => Q.mergeConfig(Q.DEFAULT_CONFIG, p || {});
const results = [];
function probe(name, fn) {
  let red = false, detail = '';
  try { red = fn(); } catch (e) { red = '抛错:' + (e && e.message); }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red);
}

/* ---- 1. 「整卷后」模式下把"已判分"直接当"可以显示" = 泄露答案 ---- */
probe('① 泄露：end 模式下只要判分就显示答案 → ①-C 的泄露哨兵必须变红', function () {
  const F = load(s => s.replace('else if (submitted && pol.answerEach) answer = true;',
                               'else if (submitted) answer = true;'));
  const leak = [];
  [undefined, 'answering', 'reviewing'].forEach(function (phase) {
    [false, true].forEach(function (submitted) {
      const r = F.revealAt(cfg({ reveal: { answerTiming: 'end', explainTiming: 'end' } }),
                           { submitted: submitted, phase: phase, finished: false });
      if (r.answer) leak.push({ phase: phase, submitted: submitted });
    });
  });
  return leak.length > 0;
});

/* ---- 2. 解析可以脱离答案先出现（等于把答案漏出去） ---- */
probe('② 泄露：解析不再被答案门控 → ①-E 必须变红', function () {
  const F = load(s => s.replace('const explain = explainWanted && answer;           // 规则③',
                               'const explain = explainWanted;'));
  const r = F.revealAt(cfg({ reveal: { answerTiming: 'end', explainTiming: 'each' } }), { submitted: true, finished: false });
  return r.explain === true;             // 旧行为下解析偷偷显示 → 锚（要求 false）红
});

/* ---- 3. 自动翻页**不看有没有作答**（空题也翻过去）----
 * ⚠ 语义在"去掉提交按钮"那轮改过：现在是"**点完就翻，不等判分**"（用户明确要求）。
 *   所以这条探针改盯**新的**真相源表达式，把它的 `answered` 守卫拆掉：
 *   于是"没作答也跳"，真值表里 wantNext = answered && an && !finished 会立刻变红。 */
probe('③ 自动翻页不看"有没有作答" → ②-A 真值表变红', function () {
  const F = load(s => s.replace('const willJump = autoNext && answered && !finished && !wrongBlocked;',
                                'const willJump = autoNext && !finished && !wrongBlocked;'));
  const r = F.afterSubmit(cfg({ behavior: { autoCheck: false, autoNext: true } }), { answered: false, checked: false });
  return r.willJump === true;            // 旧行为下"空题也跳" → 锚（要求 false）红
});

/* ---- 4. 等级定档不看传入的分数线 ---- */
probe('④ 定档忽略分数线（写死内置默认）→ ③-B 必须变红', function () {
  const F = load(s => s.replace('const level = QuizCore.levelOf(p, cfg);            // ← 与判分用**同一个**函数',
                               'const level = QuizCore.levelOf(p, null);'));
  const a = F.gradeLevel(70, cfg({ grade: { pass: 75, excellent: 85 } })).level;
  const b = F.gradeLevel(70, cfg({ grade: { pass: 60, excellent: 70 } })).level;
  return a === b;                        // 旧行为下三套线给同一档 → 锚（要求换档）红
});

/* ---- 5. 「按分数定义」只写字段、不切规则 = 点了没反应 ---- */
probe('⑤ 切口径不切规则（randomBasis 写了没人看）→ ④-B 必须变红', function () {
  const F = load(s => s.replace('const switchedMode = (cur.mode !== \'random\');',
                               'const switchedMode = false;'));
  const r = F.setBasis(cfg({ pick: { mode: 'byCount' } }), 'score');
  return r.config.pick.mode !== 'random' || F.countControl(r.config).basis !== 'score';
});

/* ---- 6. 非数字静默变 0（输入框打错字 → 变成"要 0 题"） ---- */
probe('⑥ 非数字不拦、静默当 0 → ④-D 必须变红', function () {
  const F = load(s => s.replace('if (typeof value !== \'number\' || !isFinite(value)) return badValue(\'pick\', value);', ''));
  const r = F.setCount(cfg(null), 'abc');
  const codes = (r.errors || []).map(function (e) { return e.code; });
  return codes.indexOf('E_FLOW_BAD_VALUE') < 0;   // 旧行为下报的是别的码（或干脆通过）→ 锚红
});

/* ---- 7. 自动翻页的**等待时间**被忽略（waitMs 恒为 0 = 设置没生效） ---- */
probe('⑦ 等待时间不往外传（waitMs 恒 0）→ ②-E 的 waitMs 锚变红', function () {
  const F = load(s => s.replace('const waitMs = willJump ? delay.ms : 0;',
                                'const waitMs = 0;'));
  const r = F.afterSubmit(cfg({ behavior: { autoNext: true, autoNextMs: 800 } }), { answered: true, checked: false });
  return r.waitMs !== 800;               // 旧/坏行为下界面拿到 0 → 锚（要求 800）红
});

/* ---- 8. 逐题型目标分被忽略（退回"单一总目标分贪心"）→ ②-C 的逐题型锚变红 ---- */
probe('⑧ 逐题型目标分不生效（退回单一总目标分贪心）→ ②-C 变红', function () {
  const Q2 = loadQuiz(s => s.replace('perTypeScore = allocatedScore > 0;', 'perTypeScore = false;'));
  const mk = function (t, n) { const o = []; for (let i = 1; i <= n; i++) o.push({ id: t + i, type: t, stem: t + i, points: 2 }); return o; };
  const ban = mk('单选', 8).concat(mk('多选', 6)).concat(mk('判断', 5)).concat(mk('简答', 3));
  const r = Q2.pickQuestions(ban, Q2.mergeConfig(Q2.DEFAULT_CONFIG,
    { pick: { mode: 'byWeight', byTypeScore: { '单选': 8, '多选': 6, '判断': 4, '简答': 10 }, seed: 4 } }));
  const cnt = {}; r.questions.forEach(function (q) { cnt[q.type] = (cnt[q.type] || 0) + 1; });
  cleanupQuiz();
  return JSON.stringify(cnt) !== JSON.stringify({ '单选': 4, '多选': 2, '判断': 4, '简答': 2 });   // 坏行为分布不对 → 锚红
});

/* ---- 9. 逐题型「+」不按每题分值走（步长写死 1）→ ④-E 的步长锚变红 ---- */
probe('⑨ 逐题型目标分的「+」步长写死 1 → ④-E 的步长锚变红', function () {
  const F = load(s => s.replace('const step = isScore ? (QuizCore.unitPoints(points, type) > 0 ? QuizCore.unitPoints(points, type) : 1) : 1;',
                                'const step = 1;'));
  const r = F.bumpTypeValue(cfg({ pick: { mode: 'byWeight', byTypeScore: { '单选': 20 } } }), 'score', '单选', 1);
  return r.value !== 22;                 // 每题 2 分 → 应该 22；坏行为给 21 → 锚红
});

/* ---- 10. 写了逐题型的值却不切抽题规则（点了没反应）→ ④-E 的"自动切规则"锚变红 ---- */
probe('⑩ 写逐题型的值却不切规则 → ④-E 的 mode 锚变红', function () {
  const F = load(s => s.replace("const wantMode = isScore ? 'byWeight' : 'byCount';", 'const wantMode = cur.mode;'));
  const r = F.setTypeValue(cfg({ pick: { mode: 'random', randomBasis: 'count' } }), 'score', '单选', 20);
  return r.config.pick.mode !== 'byWeight';   // 值写进去了但规则还是 random → 锚（要求 byWeight）红
});

/* ---- 11. 「全部作答」那一支不生效（mode=all 落回"按随机/题量"那几行）→ ④-F 的"只剩规则一行"变红 ---- */
probe('⑪ mode=all 的分支不生效（还是摆出题量/口径那几行）→ ④-F 的"只有规则一行"必须变红', function () {
  const F = load(s => s.replace("    if (alloc.mode === 'all') {", '    if (false) {'));
  const m = F.quickModel(cfg({ pick: { mode: 'all' } }));
  return JSON.stringify(m[0].rows.map(r => r.id)) !== JSON.stringify(['mode']);   // 坏行为：多出 basis/count/score → 锚红
});

/* ---- 12. 「没得全分不自动翻页」被拿掉（答错也照翻）→ ②-H 的"不跳"锚变红 ---- */
probe('⑫ 没得全分也照翻（notPerfect 恒 false）→ ②-H 的"没得全分不跳"必须变红', function () {
  const F = load(s => s.replace('    const notPerfect = (perfect === false);',
                                '    const notPerfect = false;'));
  const r = F.afterSubmit(cfg({ behavior: { autoCheck: true, autoNext: true, autoNextMs: 1500 } }),
                          { answered: true, checked: true, correct: false });
  return r.willJump !== false || r.waitMs !== 0;      // 坏行为：还是跳（或还排着等待）
});

/* ---- 13. 「没得全分必须给出正确答案」被拿掉（时机=整卷后时就不给）→ ②-H 的"当场揭示"锚变红 ---- */
probe('⑬ 没得全分不揭示正确答案（规则④被删）→ ②-H 的"当场揭示"必须变红', function () {
  const F = load(s => s.replace('    if (notPerfect) answer = true;', '    /* 规则④被拿掉 */'));
  const r = F.revealAt(cfg({ reveal: { answerTiming: 'end', explainTiming: 'end' } }),
                       { submitted: true, finished: false, correct: false });
  return r.answer !== true;                           // 坏行为：整卷后时机下不给答案
});

/* ---- 14. 「得全分才跳」被放松成"只有 0 分不跳"（半对/没答全也照翻）→ ②-H 的半对锚变红 ---- */
probe('⑭ 半对也照翻（notPerfect 只看 0 分）→ ②-H 的"半对不跳"必须变红', function () {
  const F = load(s => s.replace('    const notPerfect = (perfect === false);',
                                '    const notPerfect = (perfect === false) && (c.score === 0);'));
  const r = F.afterSubmit(cfg({ behavior: { autoCheck: true, autoNext: true, autoNextMs: 0 } }),
                          { answered: true, checked: true, correct: false, score: 3, full: 6 });
  return r.willJump === true;                         // 坏行为：多选半对（3/6）也翻
});

/* ---- 15. 「答错的题也自动翻页」被忽略（开了也照样停在错题上） ---- */
probe('⑮ autoNextWrong 被忽略（答错仍然不翻）→ ②-C2 必须变红', function () {
  const F = load(s => s.replace('const willJump = autoNext && answered && !finished && !wrongBlocked;',
                                'const willJump = autoNext && answered && !finished && !notPerfect;'));
  const r = F.afterSubmit(cfg({ behavior: { autoCheck: true, autoNext: true, autoNextWrong: true } }),
                          { answered: true, checked: true, correct: false, score: 0, full: 2 });
  return r.willJump !== true;            // 旧行为：答错不翻 → 锚（要求翻）红
});

/* ---- 16. 子开关反过来绑架主开关（自动翻页关着也能被"错题也翻"顶着跳） ---- */
probe('⑯ 子开关越过主开关（不跳时也报 jumpedDespiteWrong）→ ②-C2 的"子选项被按住"锚变红', function () {
  const F = load(s => s.replace('const willJump = autoNext && answered && !finished && !wrongBlocked;',
                                'const willJump = (autoNext || autoNextWrong) && answered && !finished && !wrongBlocked;'));
  const r = F.afterSubmit(cfg({ behavior: { autoCheck: true, autoNext: false, autoNextWrong: true } }),
                          { answered: true, checked: true, correct: false, score: 0, full: 2 });
  return r.willJump === true;            // 坏行为：主开关关着却跳了 → 锚红
});

/* ---- 17. 半对不再封顶在全对以内（用户能调，但不能调出"半对比全对还高"）→ ④-H 锚变红 ---- */
probe('⑰ 半对不再封顶 → ④-H「半对填 9 压回 3」锚变红', function () {
  const F = load(s => s.replace('    const half = round2(Math.min(v, cur.full));', '    const half = round2(v);'));
  const r = F.quickAction(cfg(null), { id: 'multi.halfScore', value: 9 });
  return r.config.multi.halfScore !== 3;          // 坏行为：留着 9 → 锚（要求 3）红
});

/* ---- 18. 调低全对时半对不跟着压（出现"半对 2 分、全对 1.5 分"）→ ④-H 锚变红 ---- */
probe('⑱ 调低全对时不压半对 → ④-H「半对一起压到 1.5」锚变红', function () {
  const F = load(s => s.replace('    if (clampedHalf) patch.multi = { halfScore: full };', '    if (false) patch.multi = { halfScore: full };'));
  const r = F.quickAction(cfg(null), { id: 'points.多选', value: 1.5 });
  return F.multiScoreCfg(r.config).half !== 1.5;  // 坏行为：半对还是 2 > 全对 1.5 → 锚红
});

/* ---- 19. 面板上的「答题计时」动件没接线（点了写不进配置）→ ④-I 锚变红 ---- */
probe('⑲ 计时开关不接线 → ④-I「点一下真的写进配置」锚变红', function () {
  const F = load(s => s.replace("    if (id === 'timer') return setBehavior(cfg, 'timer', a.value, o);", '    if (false) return null;'));
  return F.quickAction(cfg(null), { id: 'timer', value: true }).ok !== true;
});

/* ---- 20. 面板上少了「0.2 秒」那一档（用户要求补的"比较小的时间"）→ ②-E 的预设锚变红 ---- */
probe('⑳ 预设里没有 0.2 秒 → ②-E「六档预设」锚变红', function () {
  const F = load(s => s.replace('const AUTO_NEXT_MS_PRESETS = [0, 200, 500, 1000, 1500, 2000];',
                                'const AUTO_NEXT_MS_PRESETS = [0, 500, 1000, 1500, 2000];'));
  const d = F.autoNextDelay(cfg(null));
  return d.presets.indexOf(200) < 0;              // 坏行为：那一档没了 → 锚红
});

cleanup();
const bad = results.filter(r => r[1] !== true);
console.log('\n探针汇总：' + results.length + ' 条  全部能让锚变红=' + (bad.length === 0));
if (bad.length) { bad.forEach(b => console.log('  未变红：' + b[0] + ' → ' + b[1])); process.exitCode = 1; }
