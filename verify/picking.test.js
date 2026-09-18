/* ============================================================
 *  verify/picking.test.js —— 「抽题策略」小类验收
 *
 *  运行： node verify/picking.test.js
 *
 *  三条盘档验收标准，逐条对应：
 *    ① 按题数比例时各题型数量精确匹配配置；按总分权重时抽出的题总分命中目标分
 *       且分数分散在多个题型；随机模式题量正确且无重复
 *    ② 同一 seed 两次抽题结果完全一致，不同 seed 结果不同（可复现性断言）
 *    ③ 题库不足时抽出全部可用题并给出明确缺口提示，不报错、不出现空白题
 *
 *  三条反空转设计：
 *    · ①"精确匹配"必须配**错配的反向对照**（故意给一个错分布，断言它不匹配）——
 *      否则一个恒返回"全抽"的实现也能碰巧通过。
 *    · ②"同 seed 一致"必须配"不同 seed 不同"——否则一个**忽略种子**的实现（永远返回同一批）
 *      能完美通过"一致"这一条。
 *    · ③"题库不足"必须配"题库充足时**不该**报缺口"——否则一个**永远报缺口**的实现也能通过。
 * ============================================================ */
const Q = require('../core/quiz.js');

let pass = 0, fail = 0; const failures = [];
function brief(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return String(s);
  return s.length > 170 ? s.slice(0, 170) + '…(' + s.length + ' 字符)' : s;
}
function ok(c, t, d) { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + brief(d) : '')))
                         : (fail++, failures.push(t), console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + brief(d) : ''))); }
function eq(a, e, t) { const A = JSON.stringify(a), B = JSON.stringify(e); ok(A === B, t + '   期望=' + brief(B), A); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }

/* ---------- 合成题库：各题型数量与分值都由测试自己定，便于"精确"断言 ---------- */
function bank(spec, points, prefix) {
  // spec = { 单选: 8, 多选: 6, 判断: 5, 简答: 3 }
  const out = [];
  Object.keys(spec).forEach(function (t) {
    for (let i = 1; i <= spec[t]; i++) {
      out.push({ id: (prefix || 'q') + '-' + t + '-' + i, type: t, stem: t + '第' + i + '题', points: points[t] });
    }
  });
  return out;
}
const P4 = { '单选': 2, '多选': 3, '判断': 1, '简答': 5 };   // 与内置默认一致
function cfg(patch) {
  // 以内置默认打底再覆盖（三层取值里的"生效配置"）
  return Q.mergeConfig(Q.DEFAULT_CONFIG, patch || {});
}
const ids = r => r.questions.map(q => q.id);
const cntOf = qs => { const o = {}; qs.forEach(q => o[q.type] = (o[q.type] || 0) + 1); return o; };
const sumOf = (qs, pts) => Math.round(qs.reduce((s, q) => s + (pts[q.type] || 0), 0) * 2) / 2;

/* ============================================================ */
head('①-A byCount：逐题型数量精确匹配配置（含 0 的题型不许冒出来）');

const B1 = bank({ '单选': 8, '多选': 6, '判断': 5, '简答': 3 }, P4);
const r1 = Q.pickQuestions(B1, cfg({ pick: { mode: 'byCount', byType: { '单选': 4, '多选': 2, '判断': 3, '简答': 1 } } }));
eq(r1.questions.length, 10, 'byCount：共抽 10 题（4+2+3+1）');
eq(cntOf(r1.questions), { '单选': 4, '多选': 2, '判断': 3, '简答': 1 }, 'byCount：各题型数量**精确匹配**配置');

const r1b = Q.pickQuestions(B1, cfg({ pick: { mode: 'byCount', byType: { '单选': 0, '多选': 3, '判断': 0, '简答': 2 } } }));
eq(cntOf(r1b.questions), { '多选': 3, '简答': 2 }, 'byCount：配置为 0 的题型一题都不出（不是"抽到 0 题也算出现过"）');
eq(r1b.questions.length, 5, '  总数 = 5');

eq(new Set(ids(r1)).size, r1.questions.length, 'byCount：无重复 id');
const allInBank = r1.questions.every(q => B1.indexOf(q) >= 0);
ok(allInBank, 'byCount：抽出的每一道都真的来自题库（不是凭空造的题）');

// —— 反向对照：故意写一个错分布，必须**不**匹配（证明上面那条不是恒真）
const wrong = { '单选': 4, '多选': 3, '判断': 3, '简答': 1 };
ok(JSON.stringify(cntOf(r1.questions)) !== JSON.stringify(wrong),
   '反向对照：把多选写成 3 的错分布确实**不**匹配（"精确匹配"这条判定真的在测东西）', cntOf(r1.questions));

head('①-B byCount：抽出的题按题型分块（同类相邻），且每型内部是随机的');

const r1c = Q.pickQuestions(B1, cfg({ pick: { mode: 'byCount', byType: { '单选': 4, '多选': 2, '判断': 3, '简答': 1 } } }));
const seq = r1c.questions.map(q => q.type).join(',');
ok(/^单选(,单选)*,多选(,多选)*,判断(,判断)*,简答(,简答)*$/.test(seq),
   '顺序 = 单选块 → 多选块 → 判断块 → 简答块（试卷按题型分区）', seq);

/* ============================================================ */
head('②-A byWeight：总分命中目标分（可证紧界）+ 分数分散在多个题型');

const B2 = bank({ '单选': 20, '多选': 20, '判断': 20, '简答': 20 }, P4);

// 20 分这个目标在 {2,3,1,5} 下可精确凑出（例如 5×4）
const w20 = Q.pickQuestions(B2, cfg({ pick: { mode: 'byWeight', targetScore: 20 } }));
eq(sumOf(w20.questions, P4), 20, 'byWeight：目标分 20 时**精确命中**（抽出题总分 = 20）');
ok(w20.questions.length > 1, '  且不是只有一道题（' + w20.questions.length + ' 题）');
ok(Object.keys(cntOf(w20.questions)).length >= 2,
   'byWeight：分数**分散在多个题型**上（≥2 个题型）', cntOf(w20.questions));

// 不可精确凑出的目标分 → 用"可证的紧界"断言：不超预算，且剩余 < 最小可抽题型分值
const w7 = Q.pickQuestions(B2, cfg({ pick: { mode: 'byWeight', targetScore: 7 } }));
const s7 = sumOf(w7.questions, P4);
ok(s7 <= 7, 'byWeight：目标分 7 时抽出总分 ' + s7 + ' ≤ 7（绝不超预算）', s7);
ok(7 - s7 < 1, '  且剩余 ' + (7 - s7) + ' < 最小题型分值 1（这是均衡填充能达到的**紧界**，不是"随便凑"）');
eq(w7.meta.unused, 7 - s7, '  meta.unused 如实报出没花掉的预算');

// 目标分远大于题库容量 → 抽光而不是死循环
const wBig = Q.pickQuestions(B2, cfg({ pick: { mode: 'byWeight', targetScore: 100000 } }));
eq(wBig.questions.length, B2.length, 'byWeight：目标分 10 万 → 把题库抽光（80 题）而不是卡死/静默截断');
eq(wBig.meta.poolExhausted, true, '  并且 meta.poolExhausted 如实标出"题库抽完了还是没凑够"');
ok(wBig.meta.shortageScore > 0, '  缺口按**分数**口径报出', wBig.meta.shortageScore);
eq(new Set(ids(wBig)).size, wBig.questions.length, '  抽光时也无重复');

head('②-B byWeight：每种题型的"每题满分"决定配比（分值大的题型不该被冷落）');

const spread = cntOf(w20.questions);
ok(Object.keys(spread).length >= 2, '仍旧分散在多题型', spread);
// 分值在 cfg.points 里（与计分模块同源），不是 cfg.pick.points
const bigT = Q.pickQuestions(B2, cfg({ points: { '单选': 1, '多选': 6, '判断': 1, '简答': 6 }, pick: { mode: 'byWeight', targetScore: 12 } }));
const t12 = sumOf(bigT.questions, { '单选': 1, '多选': 6, '判断': 1, '简答': 6 });
eq(t12, 12, 'byWeight：换一套分值（1/6/1/6）目标 12 分仍精确命中');
// 同一份试卷若按**另一套分值**来算分，总分当然不同 —— 证明上面那条用的是 cfg.points 而不是写死的默认值
ok(sumOf(bigT.questions, P4) !== 12, '  反向对照：用默认分值 2/3/1/5 去算同一批题**不等于** 12（说明它确实读了 cfg.points）',
   sumOf(bigT.questions, P4));

/* ============================================================ */
head('②-C byWeight **逐题型目标分**：每个题型各自凑到自己的目标分（用户手动分配）');

/* 分值 2/3/1/5。逐题型目标 8/6/4/10 → 期望 4 单选 / 2 多选 / 4 判断 / 2 简答（每题分能整除） */
const alloc = Q.pickQuestions(B2, cfg({ pick: { mode: 'byWeight', byTypeScore: { '单选': 8, '多选': 6, '判断': 4, '简答': 10 }, seed: 4 } }));
eq(alloc.meta.perTypeScore, true, '逐题型目标分被识别为"分配过"（perTypeScore=true）');
eq(cntOf(alloc.questions), { '单选': 4, '多选': 2, '判断': 4, '简答': 2 }, '每型题数 = 目标分 ÷ 每题分（各自独立，不互相借分）');
eq(sumOf(alloc.questions, P4), 28, '  总满分 = 8+6+4+10 = 28');
eq(alloc.meta.byTypePoints, { '单选': 8, '多选': 6, '判断': 4, '简答': 10 }, '  逐题型小计**正好等于各自的目标分**');
eq(alloc.meta.shortageScore, 0, '  没有缺口');
eq(new Set(ids(alloc)).size, alloc.questions.length, '  无重复');

/* 只给一型分配分 → 其他三型一题都不出（这是"手动分配"的应有语义，不是漏抽） */
const onlyOne = Q.pickQuestions(B2, cfg({ pick: { mode: 'byWeight', byTypeScore: { '单选': 6, '多选': 0, '判断': 0, '简答': 0 }, seed: 4 } }));
eq(cntOf(onlyOne.questions), { '单选': 3 }, '只给单选分配 6 分 → 只有单选出 3 题（配置 0 的题型不出题）');

/* 目标分不是每题分值的整数倍 → 不超预算，缺口如实报（2 分/题的情况下 7 分 → 3 题 6 分，差 1 分） */
const odd = Q.pickQuestions(B2, cfg({ pick: { mode: 'byWeight', byTypeScore: { '单选': 7, '多选': 0, '判断': 0, '简答': 0 }, seed: 4 } }));
eq([cntOf(odd.questions)['单选'], sumOf(odd.questions, P4)], [3, 6], '目标 7 分（每题 2 分）→ 抽 3 题 6 分，**绝不超预算**');
eq([odd.meta.shortageScore, !!odd.meta.byTypeScoreShortfall['单选']], [1, true], '  差 1 分如实报进 shortageScore 与逐题型缺口');
ok(/逐题型目标分没能凑满/.test(String(odd.meta.warn)) && !/未能凑满目标分/.test(String(odd.meta.warn)),
   '  warn 用的是**逐题型**口径（不再拿 targetScore 说事）', odd.meta.warn);

/* 题库不够：每型只剩 1 道，要 5 道 → 缺口按逐题型汇总 */
const thin = Q.pickQuestions(bank({ '单选': 1, '多选': 1, '判断': 1, '简答': 1 }, P4),
  cfg({ pick: { mode: 'byWeight', byTypeScore: { '单选': 4, '多选': 6, '判断': 2, '简答': 10 }, seed: 1 } }));
eq(cntOf(thin.questions), { '单选': 1, '多选': 1, '判断': 1, '简答': 1 }, '题库只有各 1 道 → 每型都抽到但都不够');
eq(thin.meta.shortageScore, (4 - 2) + (6 - 3) + (2 - 1) + (10 - 5), '  缺口 = 各型目标分 − 实得（2+3+1+5=11 分）');
ok(/逐题型目标分没能凑满/.test(String(thin.meta.warn)), '  提示里逐题型点名', thin.meta.warn);

/* 全 0 = 没分配过 → 老行为（按总目标分自动配比），且**不会**变成"一题不抽" */
const zeros = Q.pickQuestions(B2, cfg({ pick: { mode: 'byWeight', targetScore: 20, byTypeScore: { '单选': 0, '多选': 0, '判断': 0, '简答': 0 }, seed: 4 } }));
eq(zeros.meta.perTypeScore, false, '四型全 0 = 没分配过 → perTypeScore=false');
eq(sumOf(zeros.questions, P4), 20, '  落回"按总目标分 20 自动配比"（老行为，不是抽 0 题）');
ok(Object.keys(cntOf(zeros.questions)).length >= 2, '  且仍然分散在多题型（自动配比的特征）', cntOf(zeros.questions));

/* 逐题型目标分与"目标总分"同时写了 → 以逐题型为准，并把这件事说出来（不许悄悄忽略） */
const bothSet = Q.pickQuestions(B2, cfg({ pick: { mode: 'byWeight', targetScore: 100, byTypeScore: { '单选': 8, '多选': 6, '判断': 4, '简答': 10 }, seed: 4 } }));
eq(sumOf(bothSet.questions, P4), 28, '逐题型目标分优先：总满分 28（不是 targetScore 的 100）');
ok(/目标总分 100 分"这次不参与|这次不参与/.test(String(bothSet.meta.warn)), '  并在 warn 里明说"目标总分这次不参与"', bothSet.meta.warn);

/* 每题 0 分的题型：分配了分也抽不到 → 如实说出来，不假装凑满 */
const zeroPts = Q.pickQuestions(B2, cfg({ points: { '单选': 0, '多选': 3, '判断': 1, '简答': 5 },
  pick: { mode: 'byWeight', byTypeScore: { '单选': 10, '多选': 6, '判断': 0, '简答': 0 }, seed: 4 } }));
eq(cntOf(zeroPts.questions), { '多选': 2 }, '单选每题 0 分 → 即使分配了 10 分也抽不到（只出分得动的题型）');
ok(/每题 0 分/.test(String(zeroPts.meta.warn)), '  并如实点名"该题型每题 0 分"', zeroPts.meta.warn);

/* ============================================================ */
head('③-A random + 按题量：题量精确、无重复、来自题库');

const rnd25 = Q.pickQuestions(B2, cfg({ pick: { mode: 'random', randomBasis: 'count', count: 25, seed: 5 } }));
eq(rnd25.questions.length, 25, 'random(题量)：抽 25 题');
eq(new Set(ids(rnd25)).size, 25, 'random(题量)：25 题**无重复**');
ok(rnd25.questions.every(q => B2.indexOf(q) >= 0), 'random(题量)：每题都来自题库');
eq(rnd25.meta.basis, 'count', '  meta.basis = count（口径如实）');

const rnd0 = Q.pickQuestions(B2, cfg({ pick: { mode: 'random', randomBasis: 'count', count: 0, seed: 5 } }));
eq(rnd0.questions.length, 0, 'random(题量)：count=0 → 0 题（不报错、不硬塞题）');

head('③-B random + 按分数：总分不超目标，且题量随题库随机而变（真随机而非固定）');

const rndScore = Q.pickQuestions(B2, cfg({ pick: { mode: 'random', randomBasis: 'score', targetScore: 30, seed: 3 } }));
const rs = sumOf(rndScore.questions, P4);
eq(rndScore.meta.basis, 'score', 'random(分数)：meta.basis = score');
ok(rndScore.questions.length > 0, '  真的抽到了题（' + rndScore.questions.length + ' 题）');
ok(rs <= 30, '  抽出总分 ' + rs + ' ≤ 目标 30（不超预算）', rs);
ok(30 - rs < 5, '  剩余 ' + (30 - rs) + ' < 最大题型分值 5（洗牌后"装不下就跳过"能达到的紧界）');
eq(new Set(ids(rndScore)).size, rndScore.questions.length, '  无重复');

// 反向对照：分数口径与题量口径必须给出**不同**的结果形态（否则"按分数"这一支是假的）
const rndCount30 = Q.pickQuestions(B2, cfg({ pick: { mode: 'random', randomBasis: 'count', count: 30, seed: 3 } }));
eq(rndCount30.questions.length, 30, '  对照：同 seed 按题量口径 = 30 题');
ok(rndCount30.questions.length !== rndScore.questions.length,
   '反向对照：按分数口径抽到的题数与"按题量 30"不同 → "按分数"确实换了一套停止规则，不是别名',
   { 按分数: rndScore.questions.length, 按题量: rndCount30.questions.length });

head('③-C 未知口径/未知模式：不许静默乱抽，必须落回默认并如实报告');

const rndBad = Q.pickQuestions(B2, cfg({ pick: { mode: 'random', randomBasis: 'whatEver', count: 9, seed: 1 } }));
eq(rndBad.meta.basis, 'count', 'random：未知 randomBasis → 落回 count');
ok(/whatEver/.test(String(rndBad.meta.warn)), '  并且在 warn 里如实点名那个非法值', rndBad.meta.warn);
eq(rndBad.questions.length, 9, '  题量仍按 count=9 执行');

const badMode = Q.pickQuestions(B2, cfg({ pick: { mode: 'byMagic', count: 9 } }));
eq(badMode.meta.mode, 'random', '未知 mode → 落回内置默认 random（完全随机，不静默乱抽）');
eq(badMode.meta.modeFallback, 'byMagic', '  并记录下被顶掉的原值');

/* ============================================================ */
head('④ 可复现性：同 seed 逐题一致（含顺序）；不同 seed 必须不同');

function sig(r) { return r.questions.map(q => q.id).join('|'); }
[[{ mode: 'random', randomBasis: 'count', count: 20, seed: 7 }, 'random(题量)'],
 [{ mode: 'random', randomBasis: 'score', targetScore: 40, seed: 7 }, 'random(分数)'],
 [{ mode: 'byCount', byType: { '单选': 5, '多选': 3, '判断': 2, '简答': 1 }, seed: 7 }, 'byCount'],
 [{ mode: 'byWeight', targetScore: 25, seed: 7 }, 'byWeight']
].forEach(function (c) {
  const a = Q.pickQuestions(B2, cfg({ pick: c[0] }));
  const b = Q.pickQuestions(B2, cfg({ pick: c[0] }));
  eq(sig(a), sig(b), c[1] + '：同 seed 两次抽题**逐题一致**（连顺序都一样）');
});

const s7a = sig(Q.pickQuestions(B2, cfg({ pick: { mode: 'random', randomBasis: 'count', count: 20, seed: 7 } })));
const s8a = sig(Q.pickQuestions(B2, cfg({ pick: { mode: 'random', randomBasis: 'count', count: 20, seed: 8 } })));
ok(s7a !== s8a, '不同 seed → 结果不同（否则"可复现"退化成"永远同一批"）');

const bc7 = sig(Q.pickQuestions(B2, cfg({ pick: { mode: 'byCount', byType: { '单选': 5, '多选': 3, '判断': 2, '简答': 1 }, seed: 7 } })));
const bc9 = sig(Q.pickQuestions(B2, cfg({ pick: { mode: 'byCount', byType: { '单选': 5, '多选': 3, '判断': 2, '简答': 1 }, seed: 9 } })));
ok(bc7 !== bc9, 'byCount 也吃种子（同分布、不同 seed → 抽到的是不同的题）');

head('④-B 种子 0 与目标分 0 是**合法配置**，不许被 `||` 吞掉');

const seed0a = sig(Q.pickQuestions(B2, cfg({ pick: { mode: 'random', randomBasis: 'count', count: 20, seed: 0 } })));
const seed0b = sig(Q.pickQuestions(B2, cfg({ pick: { mode: 'random', randomBasis: 'count', count: 20, seed: 0 } })));
const seed1a = sig(Q.pickQuestions(B2, cfg({ pick: { mode: 'random', randomBasis: 'count', count: 20, seed: 1 } })));
eq(seed0a, seed0b, 'seed=0：同种子仍可复现');
ok(seed0a !== seed1a, 'seed=0 与 seed=1 是**不同**的种子（旧实现 `seed || 1` 会把 0 变成 1，两者会一模一样）');
eq(Q.pickQuestions(B2, cfg({ pick: { mode: 'byWeight', targetScore: 0 } })).meta.targetScore, 0,
   'targetScore=0 被如实采纳（旧实现 `|| 100` 会变成 100）');
eq(Q.pickQuestions(B2, cfg({ pick: { mode: 'byWeight', targetScore: 0 } })).meta.picked, 0, '  目标 0 分 → 0 题');

/* ============================================================ */
head('④-C 部分配置：缺项落回内置默认（与三层取值同一条语义），并如实报"落了哪些默认"');

// 只写 mode 的其他字段全缺 —— 旧实现把缺项当 0，会**静默抽 0 题**
const partial = Q.pickQuestions(B2, { points: P4, pick: { mode: 'byWeight' } });
eq(partial.meta.targetScore, Q.DEFAULT_CONFIG.pick.targetScore,
   'byWeight 没写 targetScore → 落回内置默认 ' + Q.DEFAULT_CONFIG.pick.targetScore + '（不是 0）');
ok(partial.questions.length > 0, '  因此真的抽到了题（' + partial.questions.length + ' 题），而不是静默 0 题');
// 逐题型目标分（pick.byTypeScore）也是后加的字段：这份部分配置里同样没写 → 一起落回默认。
// ⚠ 顺序按"代码里首次读它的顺序"（先 targetScore 后 byTypeScore），改顺序要跟着改这里。
eq(partial.meta.defaulted, ['pick.targetScore', 'pick.byTypeScore'],
   '  meta.defaulted 如实报出落了哪几项默认');
eq([partial.meta.perTypeScore, partial.meta.allocatedScore], [false, 0],
   '  逐题型目标分全 0 = **没分配过** → 走"按总目标分自动配比"（老行为，不是抽 0 题）');
ok(/落回内置默认/.test(String(partial.meta.warn)), '  warn 里也说明（用户看得见为什么）', partial.meta.warn);

const partialBC = Q.pickQuestions(B2, { points: P4, pick: { mode: 'byCount' } });
eq(partialBC.meta.requestDetail.byType, Q.DEFAULT_CONFIG.pick.byType,
   'byCount 整张 byType 表都没写 → 落回内置默认表（10/2/4/2）');
eq(partialBC.questions.length, 18, '  于是抽 18 题（旧实现：0 题）');

const noPick = Q.pickQuestions(B2, { points: P4 });
eq(noPick.meta.mode, 'random', '连 pick 整块都没有 → 用内置默认模式 random（完全随机）');
eq(noPick.questions.length, Q.DEFAULT_CONFIG.pick.count,
   '  于是按内置默认题量抽（' + Q.DEFAULT_CONFIG.pick.count + ' 题，不崩、不空抽）');

head('④-D 按分数抽题没有"题数目标"：requested 给 null，不许拿 0 冒充');

const scoreReq = Q.pickQuestions(B2, cfg({ pick: { mode: 'byWeight', targetScore: 20 } }));
eq(scoreReq.meta.requested, null, 'byWeight：requested = null（这条规则根本没有题数目标，给 0 会被读成"要求 0 题"）');
eq(scoreReq.meta.requestDetail.targetScore, 20, '  目标分在 requestDetail 里');
eq(Q.pickQuestions(B2, cfg({ pick: { mode: 'random', randomBasis: 'score', targetScore: 20 } })).meta.requested, null,
   'random + 按分数：同样 null');

/* ============================================================ */
head('⑤-A 题库不足（byCount）：抽出全部可用 + 逐题型缺口 + 不崩 + 无空白题');

const small = bank({ '单选': 2, '多选': 1, '判断': 0, '简答': 3 }, P4);
const sh = Q.pickQuestions(small, cfg({ pick: { mode: 'byCount', byType: { '单选': 5, '多选': 4, '判断': 2, '简答': 1 } } }));
// "抽出全部可用"的**正确口径**：每个题型取 min(要的, 有的) ——
// 简答要 1 有 3，只该取 1；不能说"抽光简答"（那是超额抽题，与"精确匹配"冲突）。
eq(sh.questions.length, 2 + 1 + 0 + 1, '抽出 Σmin(要, 有) = 4 题（不够的题型全抽光，够的按需抽）');
eq(cntOf(sh.questions), { '单选': 2, '多选': 1, '简答': 1 }, '  逐题型都对（判断池为空 → 一题不出；简答只要 1 就只给 1）');
ok(sh.questions.every(q => q && q.id && q.type), '结果里**没有空白题**（无 null / 无缺 id）');
eq(new Set(ids(sh)).size, sh.questions.length, '  无重复');

// 规则**真的要全部**时（每个题型都要得比库里的多）→ 一题不剩地全抽出来
const wantAll = Q.pickQuestions(small, cfg({ pick: { mode: 'byCount', byType: { '单选': 99, '多选': 99, '判断': 99, '简答': 99 } } }));
eq(wantAll.questions.length, small.length, '每个题型都要 99 → 把整个题库 6 题全抽出来（"抽出全部可用题"的字面口径）');
eq(cntOf(wantAll.questions), { '单选': 2, '多选': 1, '简答': 3 }, '  逐题型 = 库里有多少给多少');

head('⑤-B 缺口必须是**逐题型**的，且总数不能靠"整库题数"糊弄过去');

eq(sh.meta.byTypeShortfall['单选'], { want: 5, got: 2, gap: 3, pool: 2 }, '单选：要 5 只有 2 → 缺 3');
eq(sh.meta.byTypeShortfall['多选'], { want: 4, got: 1, gap: 3, pool: 1 }, '多选：要 4 只有 1 → 缺 3');
eq(sh.meta.byTypeShortfall['判断'], { want: 2, got: 0, gap: 2, pool: 0 }, '判断：要 2 只有 0 → 缺 2');
eq(sh.meta.byTypeShortfall['简答'], undefined, '简答：要 1 有 3 → **不算缺口**（不能把够的题型也报成缺口）');
eq(sh.meta.shortageCount, 8, '总缺口 = 3+3+2 = 8 题（旧实现拿"要求 12 题 vs 整库 6 题"比大小，只会报 6）');
ok(/题库不够/.test(String(sh.meta.warn)), '给出可读的缺口提示文案', sh.meta.warn);
ok(/单选要 5 只有 2（缺 3）/.test(String(sh.meta.warn)), '  文案里带**逐题型的数字**（不是一句"题库不足"）', sh.meta.warn);

// 这条是最狠的反空转：整库题数充分，但**某一个题型**不够 —— 旧实现会报 shortage:0（等于不提示）
const lopsided = bank({ '单选': 50, '多选': 0, '判断': 50, '简答': 50 }, P4);
const lop = Q.pickQuestions(lopsided, cfg({ pick: { mode: 'byCount', byType: { '单选': 1, '多选': 5, '判断': 1, '简答': 1 } } }));
eq(lop.meta.shortageCount, 5, '整库 150 题、只要 8 题，但多选一题都没有 → **仍然报缺 5 题**（总量充足不代表不缺）');
ok(!!lop.meta.warn, '  并且真的给了提示', lop.meta.warn);
eq(lop.questions.length, 3, '  抽到 3 题（多选 0 题，不硬凑）');

head('⑤-C 反向对照：题库充足时**不该**报缺口（否则"永远报警"也能过）');

const enough = Q.pickQuestions(B2, cfg({ pick: { mode: 'byCount', byType: { '单选': 5, '多选': 3, '判断': 2, '简答': 1 } } }));
eq(enough.meta.shortageCount, 0, '题库充足：shortageCount = 0');
eq(enough.meta.byTypeShortfall, {}, '  byTypeShortfall 为空对象');
eq(enough.meta.warn, null, '  warn = null（干净情况下不吓唬用户）');
eq(enough.meta.ignoredDuplicates, 0, '  也没有被忽略的重复题');
eq(enough.meta.ignoredInvalid, 0, '  也没有被忽略的无效题');
eq(enough.questions.length, 11, '  题量 = 5+3+2+1 = 11');

head('⑤-D random 题量不足：抽光可用的 + 按题量口径报缺口（不许虚报"某题型没抽到"）');

const rndSh = Q.pickQuestions(small, cfg({ pick: { mode: 'random', randomBasis: 'count', count: 20, seed: 4 } }));
eq(rndSh.questions.length, small.length, 'random：要 20 题只有 6 题 → 抽出全部 6 题');
eq(rndSh.meta.shortageCount, 14, '  缺口 = 14 题');
ok(!!rndSh.meta.warn, '  有提示', rndSh.meta.warn);
// 旧实现把"随机没抽到某题型"当成缺口写进 byTypeShortfall → 干净情况下也会报警。
// 用 count=1 做**确定性**构造：只抽 1 题，必定有 3 个题型"池里有题但一道没抽到"。
const rndOne = Q.pickQuestions(B2, cfg({ pick: { mode: 'random', randomBasis: 'count', count: 1, seed: 4 } }));
eq(rndOne.questions.length, 1, 'random：只抽 1 题');
eq(Object.keys(cntOf(rndOne.questions)).length, 1, '  只涉及 1 个题型（确定性地制造"3 个题型一道没抽到"）');
eq(rndOne.meta.byTypeShortfall, {}, 'random 且题量充足：byTypeShortfall 为空（"随机没选到某题型"**不是**缺口）');
eq(rndOne.meta.warn, null, '  warn = null（旧实现会因为这条虚报缺口而给出警告）');
ok(Object.keys(rndOne.meta.poolByType).every(t => rndOne.meta.poolByType[t] === 20),
   '  而池子里 4 个题型各有 20 题（确实"有题但没抽到"，不是没题）', rndOne.meta.poolByType);

head('⑤-E 脏题库：重复 id 与无效项被挡住并如实报告（不出现空白题）');

const dirty = [
  { id: 'dup-1', type: '单选', stem: 'a' },
  { id: 'dup-1', type: '单选', stem: 'a 的副本' },
  { id: 'ok-1', type: '判断', stem: 'b' },
  null,
  { type: '单选', stem: '没有 id' },
  { id: 'weird-1', type: '连线', stem: '第五种题型' },
  { id: 'ok-2', type: '简答', stem: 'c' }
];
const dr = Q.pickQuestions(dirty, cfg({ pick: { mode: 'random', randomBasis: 'count', count: 10, seed: 2 } }));
eq(dr.questions.length, 3, '只抽出 3 道**有效**题（dup-1 / ok-1 / ok-2）');
ok(dr.questions.every(q => q && q.id && q.type), '结果里没有空白题');
eq(new Set(ids(dr)).size, 3, '重复 id 只保留一道');
eq(dr.meta.ignoredDuplicates, 1, 'meta 如实报告忽略了 1 道重复题');
eq(dr.meta.ignoredInvalid, 3, 'meta 如实报告忽略了 3 个无效项（null / 无 id / 未知题型）');
ok(/重复 id/.test(String(dr.meta.warn)) && /无效题目/.test(String(dr.meta.warn)),
   'warn 里点名这两件事（丢题不许静默）', dr.meta.warn);

head('⑤-F 空题库 / 非数组：不崩、返回空、有提示');

const emptyRes = Q.pickQuestions([], cfg({ pick: { mode: 'byCount', byType: { '单选': 1, '多选': 1, '判断': 1, '简答': 1 } } }));
eq(emptyRes.questions, [], '空题库：返回空数组（不崩）');
eq(emptyRes.meta.shortageCount, 4, '  缺口 4 题');
const nullRes = Q.pickQuestions(null, cfg({ pick: { mode: 'random', randomBasis: 'count', count: 5 } }));
eq(nullRes.questions, [], '题库传 null：也不崩，返回空');

/* ============================================================ */
head('⑥ 相邻锚：抽出来的题能直接喂给计分，满分之和 = meta.totalPoints');

const B3 = bank({ '单选': 5, '多选': 5, '判断': 5, '简答': 5 }, P4);
const feed = Q.pickQuestions(B3, cfg({ pick: { mode: 'byCount', byType: { '单选': 2, '多选': 1, '判断': 1, '简答': 1 } } }));
const scored = Q.scoreExam(feed.questions, {}, cfg());
eq(scored.full, feed.meta.totalPoints,
   '整卷满分（由计分模块算）与抽题的 meta.totalPoints **完全一致**（两处对"满分"的口径必须相同）');
eq(scored.full, 2 * 2 + 3 + 1 + 5, '  且等于 4+3+1+5 = 13（逐题型分值 × 题数）');

const byTypePts = feed.meta.byTypePoints;
eq(byTypePts, { '单选': 4, '多选': 3, '判断': 1, '简答': 5 }, '逐题型分值小计也对得上');

/* ============================================================ */
head('⑦ 全部作答（mode=all）：不抽题、整套卷按原顺序上');

const Ball = bank({ '单选': 3, '多选': 2, '判断': 2, '简答': 1 }, P4);
const rAll = Q.pickQuestions(Ball, cfg({ pick: { mode: 'all' } }));
eq(rAll.questions.length, Ball.length, '全部作答：8 道全上（= 题库有效题数）');
eq(ids(rAll), Ball.map(q => q.id), '  **保持原顺序**（不是按题型分块，也不是随机顺序）');
eq(rAll.meta.mode, 'all', '  meta.mode = all');
eq([rAll.meta.requested, rAll.meta.picked], [Ball.length, Ball.length], '  requested = picked = 8（说了多少就做多少）');
eq([rAll.meta.shortageCount, rAll.meta.warn], [0, null], '  全部作答没有"缺口"这回事（不报假缺口）');
eq(rAll.meta.totalPoints, sumOf(Ball, P4), '  满分口径与计分一致（' + sumOf(Ball, P4) + ' 分）');
/* 反向对照：换成 byCount 只抽 2 题 → 证明"全部"不是恒等实现（否则上面那条毫无意义） */
eq(Q.pickQuestions(Ball, cfg({ pick: { mode: 'byCount', byType: { '单选': 2, '多选': 0, '判断': 0, '简答': 0 } } })).questions.length, 2,
   '  反向对照：同样这份题库换成按题型数量只抽 2 题（说明 all 不是"恒返回全部"）');

const rAllDirty = Q.pickQuestions(dirty, cfg({ pick: { mode: 'all' } }));
eq([rAllDirty.meta.ignoredDuplicates, rAllDirty.meta.ignoredInvalid], [1, 3],
   '全部作答同样过滤重复 id / 无效项（并如实报告）');
eq(Q.pickQuestions([], cfg({ pick: { mode: 'all' } })).questions, [], '空题库：返回空（不崩）');

/* ============================================================ */
head('⑧ 按题库构成自适应：没有的题型，目标自动置 0（用户要求）');

const noShort = bank({ '单选': 5, '多选': 4, '判断': 3 }, P4);          // 一道简答题都没有
const ad0 = Q.adaptPickToBank(noShort, cfg(null));
eq(ad0.config.pick.byType, { '单选': 10, '多选': 2, '判断': 4, '简答': 0 },
   '没有简答题 → 简答 2 变 0，其余三型原值保留（10/2/4）');
eq(ad0.zeroed, [{ type: '简答', byType: 2, byTypeScore: 0 }], '  并如实记下"动了哪一型、原来的值是多少"');
eq(ad0.changed, true, '  changed = true（界面据此提示"已自动置 0"）');
eq(ad0.poolByType, { '单选': 5, '多选': 4, '判断': 3, '简答': 0 }, '  同时报告题库各型题数');
const ad1 = Q.adaptPickToBank(bank({ '单选': 1, '多选': 1, '判断': 1, '简答': 1 }, P4), cfg(null));
eq([ad1.changed, ad1.zeroed], [false, []], '四型都有题 → 一个数都不动（不许借机改用户的数）');
const adScore = Q.adaptPickToBank(noShort, cfg({ pick: { mode: 'byWeight', byTypeScore: { '简答': 15, '单选': 10 } } }));
eq([adScore.config.pick.byTypeScore['简答'], adScore.config.pick.byTypeScore['单选']], [0, 10],
   '目标分同样按题型是否存在来置 0（有题的 10 分保留）');
eq(adScore.zeroed, [{ type: '简答', byType: 2, byTypeScore: 15 }], '  记下的原值也对（简答原本 2 题 / 15 分）');
/* ⚠ 不许污染入参/内置默认：改返回值不能反向改配置（三层取值那条老规矩） */
ad0.config.pick.byType['单选'] = 999;
eq([cfg(null).pick.byType['单选'], Q.DEFAULT_CONFIG.pick.byType['单选']], [10, 10],
   '返回值是深拷贝：改它不会污染传入的配置，也不会污染内置默认');
eq(Q.adaptPickToBank(noShort, cfg({ pick: { mode: 'byCount', byType: { '单选': 3 } } })).config.pick.byType['单选'], 3,
   '用户填的数（单选 3）原样保留 —— 适配只针对"题库里没有的题型"');

/* ============================================================ */
head('⑨ 「未作答优先」：档位高的先抽（用户要求"抽题可以选择随机或者未做答优先"）');

const pb = bank({ '单选': 10, '多选': 10, '判断': 10, '简答': 10 }, P4);    // 40 题
/* 档位表和"欠账"的题：id 尾号 1..3 的算欠账（档位 2），尾号 8..0 的算已经答对过（档位 0），
 * 中间的是"没进过本子"（档位 1）—— 调用方（answer-template）就是这么摊档位的。 */
function tiersOf(list) {
  const map = {};
  list.forEach(function (q) {
    const n = Number(String(q.id).split('-').pop());
    map[q.id] = (n <= 3) ? 2 : (n >= 8 ? 0 : 1);
  });
  return map;
}
const owedIds = pb.filter(q => Number(q.id.split('-').pop()) <= 3).map(q => q.id);
const doneIds = pb.filter(q => Number(q.id.split('-').pop()) >= 8).map(q => q.id);
const pCfg = cfg({ pick: { mode: 'random', prefer: 'unansweredFirst', count: 12, seed: 5 } });

const prefPick = Q.pickQuestions(pb, pCfg, { priority: tiersOf(pb) });
const gotIds = prefPick.questions.map(q => q.id);
eq(prefPick.questions.length, 12, '按题量 12 题照抽 12 题（偏好只改"抽哪几道"，不改题量）');
eq(owedIds.every(id => gotIds.indexOf(id) >= 0), true, '  12 道欠账题（档位 2）**一道不落**全被抽上（档位高的先抽满）');
eq(gotIds.filter(id => doneIds.indexOf(id) >= 0).length, 0, '  已经答对过的（档位 0）一道都没进来（还轮不到它们）');
eq([prefPick.meta.prefer, prefPick.meta.preferApplied], ['unansweredFirst', true], '  结果里如实报告"这轮按未作答优先抽的"');
/* 反空转：不传档位表时同一份配置**抽出来的是另一批**（否则"优先"只是个没人看的字段） */
const noTier = Q.pickQuestions(pb, pCfg);
ok(noTier.questions.map(q => q.id).join() !== gotIds.join(), '  不传档位表 → 抽的是另一批（证明偏好真的在起作用，不是摆设）',
   noTier.questions.length);
eq(noTier.meta.preferApplied, false, '  没拿到记录时如实报告 preferApplied=false');
ok(String(noTier.meta.warn || '').indexOf('没拿到作答记录') >= 0, '  并给一句"没拿到作答记录 → 按完全随机抽"的提示', noTier.meta.warn);
/* 同档位内仍然随机：档位表全 1 时结果必须与"不传档位表"逐题一致（同种子） */
const allOne = {}; pb.forEach(q => { allOne[q.id] = 1; });
eq(Q.pickQuestions(pb, pCfg, { priority: allOne }).questions.map(q => q.id).join(),
   noTier.questions.map(q => q.id).join(), '  档位全相同时，结果与完全随机**逐题一致**（同档内就是原来的随机）');
/* 可复现：同一份档位表 + 同一个 seed → 逐题一致 */
eq(Q.pickQuestions(pb, pCfg, { priority: tiersOf(pb) }).questions.map(q => q.id).join(), gotIds.join(),
   '同一档位表 + 同一个种子 → 逐题一致（可复现）');
/* 三种抽取规则都吃这个偏好：byCount 下欠账题同样优先 */
const bc = Q.pickQuestions(pb, cfg({ pick: { mode: 'byCount', prefer: 'unansweredFirst', byType: { '单选': 6, '多选': 0, '判断': 0, '简答': 0 }, seed: 5 } }),
  { priority: tiersOf(pb) });
eq(bc.questions.length, 6, '按题型数量（单选 6）同样按 6 题抽');
const bcNums = bc.questions.map(q => Number(q.id.split('-').pop()));
eq([bcNums.filter(n => n <= 3).length, bcNums.filter(n => n >= 8).length], [3, 0],
   '  抽出来的先是那 3 道欠账的、再补"没进过本子"的，已经答对过的一道都不进（偏好对 byCount 一样生效）', bcNums);
/* 未知偏好值：落回"完全随机"并如实提示（与未知 mode / 未知 randomBasis 同一条规矩） */
const badPref = Q.pickQuestions(pb, cfg({ pick: { mode: 'random', prefer: 'smart', count: 3, seed: 5 } }), { priority: tiersOf(pb) });
eq([badPref.meta.prefer, badPref.meta.preferFallback], ['random', 'smart'], '未知偏好值 → 落回完全随机，并如实记下原值');
ok(String(badPref.meta.warn || '').indexOf('未知的抽取偏好') >= 0, '  并在 warn 里说明（不静默）', badPref.meta.warn);
eq([Q.PICK_PREFER.indexOf('random') >= 0, Q.PICK_PREFER.indexOf('unansweredFirst') >= 0], [true, true],
   'PICK_PREFER 导出两项（界面层按它画选项，不另抄一份）');
/* 档位表里有题库外的 id / 非法值 → 一律当 0，不炸也不改变题量 */
const weird = { priority: { '不存在-的-题': 9 } };
const wq = Q.pickQuestions(pb, pCfg, weird);
eq(wq.questions.length, 12, '档位表里全是无关 id → 照常抽 12 题（不认识的一律当 0 档）');

console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
console.log('  PASS ' + pass + '    FAIL ' + fail);
if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
process.exitCode = fail ? 1 : 0;
