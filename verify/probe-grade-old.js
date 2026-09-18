/* 四型计分执行 · 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-grade-old.js
 *
 * 目的：证明 verify/grade.test.js 里的锚**真的能抓到错行为**（不是空转）。
 * 每一行必须打印 "锚变红=true"；出现 false 说明那条断言在测空气。
 *
 * ⚠ 靠字符串替换定位代码：若 core/quiz.js 那几行被重构，探针会直接报
 *   「探针失效」并退出 1 —— 那是提醒你重新确认对应断言是否还有效。
 */
const fs = require('fs');
const path = require('path');
const HERE = path.join(__dirname, '..');
const SRC = path.join(HERE, 'core', 'quiz.js');
const TMP = path.join(HERE, 'core', '__probe_grade.js');

function load(mutate) {
  const src = fs.readFileSync(SRC, 'utf8');
  const out = mutate(src);
  if (out === src) throw new Error('探针失效：没替换到目标文本');
  fs.writeFileSync(TMP, out);
  delete require.cache[require.resolve(TMP)];
  return require(TMP);
}
/* 通用版：对任意模块做替换（临时文件放在它自己的目录里，相对 require 才找得到） */
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
function cleanup() { try { fs.unlinkSync(TMP); } catch (e) { /* ignore */ } }

const results = [];
function probe(name, fn) {
  let red = false;
  try { red = fn(); } catch (e) { red = '抛错:' + (e && e.message); }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red);
}
const C = require('../core/quiz.js').DEFAULT_CONFIG;
const QM = { id: 'm', type: '多选', answerLetters: ['A', 'B'] };
const QS = { id: 's', type: '单选', answerLetters: ['A'] };
const halfOK = v => Math.abs(v * 2 - Math.round(v * 2)) < 1e-9;

/* ---- 1. 多选答案键为空时走 setEq(∅,∅) = 白送满分 ---- */
probe('① 去掉"答案键为空不给分"的守卫 → ①-6 必须变红', function () {
  const Q = load(s => s.replace("      if (want.size === 0) { res.detail.unscorable = 'noAnswerKey'; return res; }", '      ;'));
  const r = Q.scoreOne({ id: 'm9', type: '多选', answerLetters: [] }, '', C);
  return r.score > 0 || r.correct === true;      // 旧行为：满分 + 计正确 → 锚红
});

/* ---- 2. 按命中比例不再受 halfRatio 封顶 ---- */
probe('② hitRatio 模式不乘 halfRatio（半对能拿满分）→ ①-3 必须变红', function () {
  const Q = load(s => s.replace('else ratio = want.size ? (hit.length / want.size) * hr : 0;',
                               'else ratio = want.size ? (hit.length / want.size) : 0;'));
  const r = Q.scoreOne(QM, 'A', C.multi.halfMode === 'hitRatio' ? C : { points: C.points, multi: { halfMode: 'hitRatio' } });
  return r.score !== 1;                          // 旧行为：3×(1/2)=1.5 → 锚（要 1）红
});

/* ---- 2b. 默认半对规则（用户要求："多选规则应该半对给两分"）被改回按命中比例 ---- */
probe('②-b 默认半对不给固定 2 分（退回按命中比例）→ ①-3「半对固定给分」锚必须变红', function () {
  const Q = load(s => s.replace("      if (m.halfMode === 'fixedScore') {", '      if (false) {'));
  const r = Q.scoreOne(QM, 'A', C);              // 只中一半
  return !(r.score === 2 && r.detail.mode === 'fixedScore');
});
/* ---- 2c. 半对分数被改小（2 → 1）同样要红 ---- */
probe('②-c 半对固定分数被改成 1 分 → ①-3「半对给 2 分」锚必须变红', function () {
  const Q = load(s => s.replace('halfScore: 2,', 'halfScore: 1,'));
  /* ⚠ 必须用**变异后那份模块**里的默认配置：上面那个 C 是从未变异的模块 require 来的，
   *   拿它当配置就永远看不到"默认值被改"（这个坑当场踩过一次）。 */
  const cfg = { points: Q.DEFAULT_CONFIG.points, multi: Q.DEFAULT_CONFIG.multi };
  return Q.scoreOne(QM, 'A', cfg).score !== 2;
});
/* ---- 2d. 半对分数不封顶（多选只值 1 分时也给 2 分）→ 封顶那条锚必须变红 ---- */
probe('②-d 半对分数不受满分封顶 → ①-3「封顶不超过满分」锚必须变红', function () {
  const Q = load(s => s.replace('const hs = roundHalf(clamp(numOr(m.halfScore, DEFAULT_CONFIG.multi.halfScore, 0, POINTS_MAX), 0, full));',
                                'const hs = roundHalf(numOr(m.halfScore, DEFAULT_CONFIG.multi.halfScore, 0, POINTS_MAX));'));
  return Q.scoreOne(QM, 'A', { points: { '多选': 1 }, multi: { halfScore: 4 } }).score !== 1;
});

/* ---- 3. 计分侧不再兜底半步粒度 ---- */
probe('③ 计分侧去掉 roundHalf(full) → ③-B 必须变红', function () {
  const Q = load(s => s.replace('let full = roundHalf(numOr(fullRaw, 0, 0, POINTS_MAX));',
                               'let full = numOr(fullRaw, 0, 0, POINTS_MAX);'));
  const r = Q.scoreOne(QS, 'A', { points: { '单选': 2.25 }, multi: C.multi, short: C.short });
  return !halfOK(r.score) || !halfOK(r.full);    // 旧行为：2.25 不是半步 → 锚红
});

/* ---- 4. 判断题归一退回"简化副本"（不认否定式） ---- */
probe('④ 退回不认否定式的简化归一 → ①-2/④ 必须变红', function () {
  const Q = load(s => s.replace(`  function normalizeJudgeLocal(v) {
    return SegmentCore.normalizeJudge(v).value;
  }`, `  function normalizeJudgeLocal(v) {
    if (v === true || v === false) return v;
    const s = String(v == null ? '' : v).trim().toLowerCase().replace(/[。．.\\s]/g, '');
    if (!s) return null;
    if (['√', '✓', '对', '正确', '是', 't', 'true', 'y', 'yes', '1'].indexOf(s) >= 0) return true;
    if (['×', '✗', 'x', '错', '错误', '否', 'f', 'false', 'n', 'no', '0'].indexOf(s) >= 0) return false;
    return null;
  }`));
  const weak = Q.normalizeJudge('不正确');       // 旧行为：null
  const scored = Q.scoreOne({ id: 'j', type: '判断', judgeValue: false }, '不正确', C).score;  // 旧行为：0
  return weak !== false || scored !== 1;
});

/* ---- 5. 部分 multi 块不逐键落回默认（缺 halfCredit 就当 false） ---- */
probe('⑤ multi 块不逐键合并默认 → ①-7 必须变红', function () {
  const Q = load(s => s.replace('const m = deepMerge(DEFAULT_CONFIG.multi, c.multi || null);',
                               'const m = c.multi || DEFAULT_CONFIG.multi;'));
  const r = Q.scoreOne(QM, 'A', { multi: { halfMode: 'fixed', halfRatio: 0.5 } });
  return r.score !== 1.5;                        // 旧行为：halfCredit 缺失→0 分 → 锚红
});

/* ---- 6. scoreExam 不挡畸形题项 ---- */
probe('⑥ scoreExam 不挡 null 题项（整卷崩）→ ①-8 必须变红', function () {
  const Q = load(s => s.replace('      if (!q || typeof q !== \'object\' || !q.id) { skippedInvalid++; return; }',
                               '      if (false) { skippedInvalid++; return; }'));
  try {
    const r = Q.scoreExam([QS, null], { s: 'A' }, C);
    return r.skippedInvalid !== 0 || r.total === 2;   // 旧行为：跳过数 0 或直接把 null 当一题 → 锚红
  } catch (e) { return true; }                        // 旧行为：直接抛 → 锚红
});

/* ---- 7. 多选 0 命中照给半对（独立红队抓出来的真缺陷） ---- */
probe('⑦ 去掉"0 命中不算半对"的守卫 → ①-3b 必须变红', function () {
  const Q = load(s => s.replace('      if (hit.length === 0) { res.score = 0; res.detail.noHit = true; return res; }', '      ;'));
  const loose = { points: C.points, multi: { halfMode: 'fixed', wrongChoiceZero: false } };
  const r = Q.scoreOne({ id: 'm', type: '多选', answerLetters: ['A', 'B'] }, 'C', loose);
  return r.score > 0;                                 // 旧行为：全错也拿 1.5 → 锚红
});

/* ---- 8. 句中否定式（独立红队抓出来的真缺陷） ---- */
probe('⑧ 整段去掉句中否定式结论 → ①-2 必须变红', function () {
  loadFrom('core/parse/segment.js', s => s.replace('    if (negBlock) return negBlock;', '    ;'),
           'core/parse/__probe_seg7.js');
  const Q = load(s => s.replace("const SegmentCore = isNode ? require('./parse/segment.js') : root.SegmentCore;",
                                "const SegmentCore = isNode ? require('./parse/__probe_seg7.js') : root.SegmentCore;"));
  try {
    const v = Q.normalizeJudge('这题不对');          // 应 false（否定）
    const score = Q.scoreOne({ id: 'j', type: '判断', judgeValue: false }, '这题不对', C).score;
    return v === true || score !== 1;                 // 旧行为：判成"对" → 答错给满分 → 锚红
  } finally { rm('core/parse/__probe_seg7.js'); }
});

/* ---- 9. 对象作答被 String() 挖出字母 ---- */
probe('⑨ 恢复 String(s||\'\') 式归一 → ①-1/②-B 必须变红', function () {
  const Seg = loadFrom('core/parse/segment.js',
    s => s.replace("    if (typeof s !== 'string' && typeof s !== 'number') return '';",
                   "    if (false) return '';"),
    'core/parse/__probe_seg6.js');
  const Q = load(s => s.replace("const SegmentCore = isNode ? require('./parse/segment.js') : root.SegmentCore;",
                                "const SegmentCore = isNode ? require('./parse/__probe_seg6.js') : root.SegmentCore;"));
  try {
    const r = Q.scoreOne({ id: 'm', type: '多选', answerLetters: ['A', 'B'] }, {},
                         { points: C.points, multi: { wrongChoiceZero: false } });
    return r.detail.got.length > 0 || r.score > 0;   // 旧行为：got=[B,C,E] 还得 1 分 → 锚红
  } finally { rm('core/parse/__probe_seg6.js'); void Seg; }
});

/* ---- 10. 幻影关键词进 total ---- */
probe('⑩ 不过滤空关键词 → ①-5/②-C 必须变红', function () {
  const Q = load(s => s.replace('        .filter(function (t) { return typeof t === \'string\' && t.trim() !== \'\'; });', '        ;'));
  const r = Q.scoreOne({ id: 'k', type: '简答', keywords: [{ text: '甲' }, { text: '' }] }, '甲', C);
  return r.detail.total !== 1 || r.correct !== true;  // 旧行为：total=2 → 满分不可达 → 锚红
});

/* ---- 11. （已废弃）"脏配置产出 NaN" 现在由 ③ 与 ⑱ 覆盖：R4 修复后字符串分值不再走 NaN 路径 ---- */

/* ================= 第三轮（独立红队二轮 R1~R8）================= */

/* ---- 12. R1 negBlock 绕过长度护栏（新引入的过度判定） ---- */
probe('⑫ 去掉 negBlock 的长度护栏 → ④-B 语义锚必须变红', function () {
  const Seg = loadFrom('core/parse/segment.js',
    s => s.replace('if (v.length > 8) return null;                       // 长句交人工（与下面的长度护栏同一条规矩）',
                   'if (false) return null;'),
    'core/parse/__probe_seg2.js');
  const v = Seg.normalizeJudge('这道题的说法是正确的，但理由不对').value;   // 应 null（长句叙述，不猜）
  rm('core/parse/__probe_seg2.js');
  return v !== null;                                  // 旧行为：false → 锚红
});

/* ---- 13. R2 问句变体（是不是/对不对）没进歧义表 ---- */
probe('⑬ 去掉问句变体 → ④-B 必须变红', function () {
  const Seg = loadFrom('core/parse/segment.js',
    s => s.replace('/(是否|与否|能否|可否|是不是|对不对|行不行|好不好|可不可以|不一定|未必|可能|也许|大概|一半|半对|部分|半数|差不多|有些)/', '/(是否|与否|能否|可否|不一定|未必|可能|也许|大概|一半|半对|部分|半数|差不多|有些)/'),
    'core/parse/__probe_seg3.js');
  const v = Seg.normalizeJudge('是不是').value;
  rm('core/parse/__probe_seg3.js');
  return v !== null;                                  // 旧行为：false（被"不是"命中）→ 锚红
});

/* ---- 14. R3 正向否定词不与内部否定词冲突 ---- */
probe('⑭ 去掉 NEG_TRUE 的包含豁免 → ④-B 必须变红', function () {
  const Seg = loadFrom('core/parse/segment.js',
    s => s.replace('        if (trueWord && trueWord.indexOf(w) >= 0) continue;', '        '),
    'core/parse/__probe_seg4.js');
  const v = Seg.normalizeJudge('并不是错的').value;
  rm('core/parse/__probe_seg4.js');
  return v !== true;                                  // 旧行为：null（与"不是"冲突）→ 锚红
});

/* ---- 15. R3 多重否定护栏 ---- */
probe('⑮ 去掉多重否定护栏 → ④-B 必须变红', function () {
  const Seg = loadFrom('core/parse/segment.js',
    s => s.replace(/\{\n      const marks = v\.match\(\/\[不非没\]\/g\);[\s\S]*?\n    \}\n/, ''),
    'core/parse/__probe_seg5.js');
  const v = Seg.normalizeJudge('不是不对').value;
  rm('core/parse/__probe_seg5.js');
  return v !== null;                                  // 旧行为：false（判反）→ 锚红
});

/* ---- 16. R4 脏分值落 0（成绩虚高） ---- */
probe('⑯ 脏分值落 0 而不是内置默认 → ③-C 必须变红', function () {
  const Q = load(s => s.replace('const fullRaw = badPoints ? numOr(dfltFull, 0, 0, POINTS_MAX) : rawFull;',
                               'const fullRaw = badPoints ? 0 : rawFull;'));
  const g = { id: 'g', type: '判断', judgeValue: true }, d = { id: 'd', type: '单选', answerLetters: ['A'] };
  const R = Q.scoreExam([g, d], { g: '对', d: 'B' }, { points: { '单选': 'abc' }, multi: C.multi, short: C.short });
  return R.percent === 100 || R.level === '优秀';      // 旧行为：1/1 = 100% 优秀 → 锚红
});

/* ---- 17. R5/R6 校验尺子与计分侧不一致（回到 R5 前的状态：尺子不归一 **且** 条件更宽） ---- */
probe('⑰ 校验退回"尺子不归一 + 条件更宽" → ④-C 必须变红', function () {
  const S = loadFrom('core/schema.js',
    s => s.replace('      if (isNonEmptyStr(q.answer) || letters.length > 0) {', '      if (isNonEmptyStr(q.answer) && letters.length > 0) {')
          .replace("        const fromAnswer = SegmentCore.normLetters(q.answer);\n        const fromLetters = SegmentCore.normLetters(letters.join(''));",
                   "        const fromAnswer = String(q.answer || '').toUpperCase().replace(/[^A-H]/g, '');\n        const fromLetters = String(letters.join('')).toUpperCase();")
          .replace('        if (fromAnswer) {', '        if (fromAnswer || fromLetters) {'),
    'core/__probe_schema.js');
  const errs = S.validateQuestion({ id: 'x', type: '多选', stem: 's', answer: 'ＡＣ', answerLetters: ['A', 'C'],
    options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }, { label: 'C', text: 'c' }] }).errors;
  rm('core/__probe_schema.js');
  return errs.length > 0;                             // 旧行为：全角被误报矛盾 → 锚红
});

/* ---- 18. R8 有限但溢出的分值（要同时去掉两道兜底才露出来） ---- */
probe('⑱ 分值计算退回旧写法 → ③-C 必须变红', function () {
  const Q = load(s => s.replace(/const fullRaw = badPoints \? numOr\(dfltFull, 0, 0, POINTS_MAX\) : rawFull;[\s\S]*?if \(!isFinite\(full\)\) full = 0;/,
                               'let full = roundHalf(points[q.type] || 0);'));
  const r = Q.scoreOne(QS, 'A', { points: { '单选': 9e307 }, multi: C.multi, short: C.short });
  return !isFinite(r.full) || !isFinite(r.score);     // 旧行为：Infinity → 锚红
});

/* ---- 19. 反问/商量语气结尾（吗/呢/吧）护栏 ---- */
probe('⑲ 去掉反问语气护栏 → ④-B 必须变红', function () {
  loadFrom('core/parse/segment.js', s => s.replace("    if (/[吗呢吧]$/.test(v)) {", "    if (false) {"),
           'core/parse/__probe_seg8.js');
  const Q = load(s => s.replace("const SegmentCore = isNode ? require('./parse/segment.js') : root.SegmentCore;",
                                "const SegmentCore = isNode ? require('./parse/__probe_seg8.js') : root.SegmentCore;"));
  try {
    return Q.normalizeJudge('这不是对的吗') !== null;   // 旧行为：false（按字面判）→ 锚红
  } finally { rm('core/parse/__probe_seg8.js'); }
});

/* ================= 第四轮（独立红队三轮 P1~P5）================= */

/* ---- 20. P1「非常」被当否定前缀（双向判反） ---- */
probe('⑳ 去掉「非常」豁免 → ④-B 必须变红', function () {
  const Seg = loadFrom('core/parse/segment.js',
    s => s.replace("        if (p === '非' && v.indexOf('非常') === 0) continue;", '        '),
    'core/parse/__probe_seg9.js');
  const v = Seg.normalizeJudge('非常正确').value;
  rm('core/parse/__probe_seg9.js');
  return v !== true;                                  // 旧行为：false（双向判反）→ 锚红
});

/* ---- 21. P2 对冲/含糊说法被当答案 ---- */
probe('㉑ 去掉 hedge 词表 → ④-B 必须变红', function () {
  const Seg = loadFrom('core/parse/segment.js',
    s => s.replace('|不一定|未必|可能|也许|大概|一半|半对|部分|半数|差不多|有些)', ')'),
    'core/parse/__probe_seg10.js');
  const v = Seg.normalizeJudge('这不一定对').value;
  rm('core/parse/__probe_seg10.js');
  return v !== null;                                  // 旧行为：true（键=对时白拿满分）→ 锚红
});

/* ---- 22. P3 answer 有字母但 answerLetters 为空（校验放行 = 永远判 0 分） ---- */
probe('㉒ 校验条件退回"只看 answerLetters 非空" → ④-C 必须变红', function () {
  const S = loadFrom('core/schema.js',
    s => s.replace('if (isNonEmptyStr(q.answer) || letters.length > 0) {', 'if (isNonEmptyStr(q.answer) && letters.length > 0) {'),
    'core/__probe_schema2.js');
  const errs = S.validateQuestion({ id: 'x', type: '多选', stem: 's', answer: 'AC', answerLetters: [],
    options: [{ label: 'A', text: 'a' }, { label: 'C', text: 'c' }] }).errors;
  rm('core/__probe_schema2.js');
  return errs.length === 0;                           // 旧行为：放行 → 锚红
});

/* ---- 23. P4 Set 形态的答案键不走同一把尺子 ---- */
probe('㉓ letterSet 退回 Set 特例 → ①-1 必须变红', function () {
  loadFrom('core/parse/segment.js',
    s => s.replace('  function letterSet(v) {\n    return toSet(v);\n  }',
                   '  function letterSet(v) {\n    if (v instanceof Set) return new Set([...v].map(function (x) { return String(x).toUpperCase(); }));\n    return toSet(v);\n  }'),
    'core/parse/__probe_seg11.js');
  const Q = load(s => s.replace("const SegmentCore = isNode ? require('./parse/segment.js') : root.SegmentCore;",
                                "const SegmentCore = isNode ? require('./parse/__probe_seg11.js') : root.SegmentCore;"));
  try {
    const want = Q.scoreOne({ id: 'm', type: '多选', answerLetters: new Set(['ａ', 'ｂ']) }, 'AB', C).detail.want;
    return JSON.stringify(want) !== JSON.stringify(['A', 'B']);   // 旧行为：["Ａ","Ｂ"] → 锚红
  } finally { rm('core/parse/__probe_seg11.js'); }
});

/* ---- 24. P5 multiple 检查的极小值盲点 ---- */
probe('㉔ 半步检查退回容差写法 → ③-C 必须变红', function () {
  const Q = load(s => s.replace('if (!isFinite(k) || k !== Math.round(k)) {',
                                'if (Math.abs(k - Math.round(k)) > 1e-9) {'));
  const ok = Q.validateConfig(Q.mergeConfig(Q.DEFAULT_CONFIG, { points: { '单选': 5e-324 } })).ok;
  return ok === true;                                 // 旧行为：极小值被放行 → 锚红
});

/* ================= 第五轮（独立红队终审 P6~P8）================= */

/* ---- 25. P6 把"没写答案字母"与"显式空数组"当同一回事（挡住自家分享导出） ---- */
probe('㉕ 把 null/缺失也当矛盾 → ④-C 必须变红', function () {
  const S = loadFrom('core/schema.js',
    s => s.replace('            if (lettersExplicitEmpty) {', '            if (true) {'),
    'core/__probe_schema3.js');
  const errs = S.validateQuestion({ id: 'x', type: '多选', stem: 's', answer: 'AC', answerLetters: null,
    options: [{ label: 'A', text: 'a' }, { label: 'C', text: 'c' }] }).errors;
  rm('core/__probe_schema3.js');
  return errs.length > 0;                             // 旧行为：null 被当矛盾 → 合法数据被挡 → 锚红
});

/* ---- 26. P8 hedge 粒度（部分/半数/差不多/有些） ---- */
probe('㉖ 去掉 hedge 补充词 → ④-B 必须变红', function () {
  const Seg = loadFrom('core/parse/segment.js',
    s => s.replace('|部分|半数|差不多|有些)', ')'),
    'core/parse/__probe_seg12.js');
  const v = Seg.normalizeJudge('部分正确').value;
  rm('core/parse/__probe_seg12.js');
  return v !== null;                                  // 旧行为：true（键=对时白拿满分）→ 锚红
});

cleanup();
const bad = results.filter(r => r[1] !== true);
console.log('\n探针汇总：' + results.length + ' 条  全部能让锚变红=' + (bad.length === 0));
if (bad.length) { bad.forEach(b => console.log('  未变红：' + b[0] + ' → ' + b[1])); process.exitCode = 1; }
