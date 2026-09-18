/* ============================================================
 *  verify/group-config.test.js —— L1「配置系统与锁定」**组级验收**（收官）
 *
 *  运行： node verify/group-config.test.js
 *
 *  它不引用任何小类的结论，而是**另起一条端到端路径**当场跑出数值：
 *    真实 store（双后端）→ 真实 ExamsCore（createExam/lockExam/writeGlobalConfig）
 *     → 真实解析器产出的题库（120 题）→ 真实 resolveConfig/scoreExam/pickQuestions
 *
 *  三条组级标准逐条判定，任一条不过就定位到所属小类。
 * ============================================================ */
const Q = require('../core/quiz.js');
const S = require('../core/schema.js');
const D = require('../core/data.js');
const E = require('../core/exams.js');
const P = require('../parser-core.js');

let pass = 0, fail = 0; const failures = [];
function brief(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return String(s);
  return s.length > 200 ? s.slice(0, 200) + '…(' + s.length + ' 字符)' : s;
}
function ok(c, t, d) { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + brief(d) : '')))
                         : (fail++, failures.push(t), console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + brief(d) : ''))); }
function eq(a, e, t) { const A = JSON.stringify(a), B = JSON.stringify(e); ok(A === B, t + '   期望=' + brief(B), A); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }

async function main() {

/* ---------------- 真实双后端 store ---------------- */
const W = (function () {
  const small = new Map(), large = new Map();
  const s = {
    getItem: k => (small.has(String(k)) ? small.get(String(k)) : null),
    setItem: (k, v) => { small.set(String(k), String(v)); },
    removeItem: k => { small.delete(String(k)); },
    key: i => { const a = Array.from(small.keys()); return i < a.length ? a[i] : null; },
    get length() { return small.size; }
  };
  const l = {
    get: async k => (large.has(String(k)) ? large.get(String(k)) : null),
    set: async (k, v) => { large.set(String(k), v); },
    del: async k => { large.delete(String(k)); },
    keys: async () => Array.from(large.keys())
  };
  return {
    store: (ns) => D.createStore({ small: s, large: l, namespace: ns || 'app' }),
    dump: () => ({ small: Array.from(small.keys()), large: Array.from(large.keys()) })
  };
})();

/* ---------------- 真实解析器产出的题库（四题型各 30 题 = 120） ---------------- */
const txt = (function () {
  const out = [];
  for (let i = 1; i <= 30; i++) {
    out.push('【单选】第' + i + '道单选题（　）\nA. 甲' + i + '\nB. 乙' + i + '\nC. 丙' + i + '\nD. 丁' + i + '\n答案：A');
    out.push('【多选】第' + i + '道多选题（　）\nA. 甲' + i + '\nB. 乙' + i + '\nC. 丙' + i + '\nD. 丁' + i + '\n答案：AB');
    out.push('【判断】第' + i + '道判断题（　）\n答案：对');
    out.push('【简答】第' + i + '道简答题\n答案：要点甲；要点乙');
  }
  return out.join('\n\n');
})();
const parsed = P.parseText(txt);
const BANK = parsed.questions.map(q => S.createQuestion(q));

/* ============================================================
 *  组级标准 ①：锁定后全局改了也不动；未锁定卷继承最新全局
 * ============================================================ */
head('① 组级：锁定卷脱钩（配置 + 判分结果都不变）· 未锁定卷继承最新全局');

const store = W.store('app');
const exLock = await E.createExam(store, { title: '要锁的卷', now: '2026-09-18T09:00:00.000Z' });
const exOpen = await E.createExam(store, { title: '不锁的卷', now: '2026-09-18T09:00:00.000Z' });
await E.setQuestions(store, exLock.exam.id, BANK.slice(0, 20));
await E.setQuestions(store, exOpen.exam.id, BANK.slice(0, 20));

const g0 = await E.writeGlobalConfig(store, { points: { '单选': 5 }, pick: { mode: 'byCount', byType: { '单选': 4, '多选': 2, '判断': 2, '简答': 1 } } });
eq(g0.ok, true, '先写一份全局配置（单选 5 分）');

const lockRes = await E.lockExam(store, exLock.exam.id, { globalCfg: g0.config, now: '2026-09-18T09:01:00.000Z' });
eq(lockRes.ok, true, '锁定该卷（把此刻生效的完整配置固化成快照）');
/* 叶子数不写死魔法数字：直接与配置字段模型对锚 —— 以后加配置项不必回来改这里，
 * 但"快照漏了字段"仍然会被抓住（两边同时少才算通过，那是不可能的）。 */
eq(lockRes.snapshotLeaves, Q.CONFIG_FIELDS.length,
   '  快照叶子数 = ' + lockRes.snapshotLeaves + '（= 配置字段总数 ' + Q.CONFIG_FIELDS.length + '，说明**没有空洞**）');

const before = await E.getExam(store, exLock.exam.id);
// ⚠ 作答表必须按**卷子里实际的题 id** 建：setQuestions/appendQuestions 会经 normalizeQuestions
// 重新发 id（解析产物的 id 本来就是新建的）。这条行为不值得依赖，所以下面顺手钉一条断言。
const answers = {};
before.exam.questions.forEach(function (q) {
  if (q.type === '单选') answers[q.id] = (q.answerLetters || [])[0];
  else if (q.type === '多选') answers[q.id] = (q.answerLetters || []).join('');
  else if (q.type === '判断') answers[q.id] = q.judgeValue ? '√' : '×';
  else answers[q.id] = (q.keywords || []).map(k => k.text).join(' ');
});
const bankIds = BANK.slice(0, 20).map(q => q.id).join('|');
const examIds = before.exam.questions.map(q => q.id).join('|');
ok(bankIds !== examIds, '【行为留档】setQuestions 会**重新发 id**（传入的 id 不保留）→ 需要保 id 的路径是文本导入，不是这里');
const openBefore = await E.getExam(store, exOpen.exam.id);
const answersOpen = {};
openBefore.exam.questions.forEach(function (q) {
  if (q.type === '单选') answersOpen[q.id] = (q.answerLetters || [])[0];
  else if (q.type === '多选') answersOpen[q.id] = (q.answerLetters || []).join('');
  else if (q.type === '判断') answersOpen[q.id] = q.judgeValue ? '√' : '×';
  else answersOpen[q.id] = (q.keywords || []).map(k => k.text).join(' ');
});
const scoreOpenBefore = Q.scoreExam(openBefore.exam.questions, answersOpen, Q.resolveConfig(g0.config, openBefore.exam));
const cfgBefore = Q.resolveConfig(g0.config, before.exam);
const scoreBefore = Q.scoreExam(before.exam.questions, answers, cfgBefore);

const gLater = await E.writeGlobalConfig(store, { points: { '单选': 77, '多选': 88, '判断': 99, '简答': 66 }, grade: { pass: 10, excellent: 20 } });
eq(gLater.ok, true, '之后**大改**全局（单选 5→77 等）');

const after = await E.getExam(store, exLock.exam.id);
const cfgAfter = Q.resolveConfig(gLater.config, after.exam);
const scoreAfter = Q.scoreExam(after.exam.questions, answers, cfgAfter);
eq(after.exam.config, before.exam.config, '锁定卷的**配置逐字节不变**（数据库里的 config 深比较相等）');
eq(cfgAfter, cfgBefore, '  解析出的生效配置也逐字段不变');
eq(scoreAfter, scoreBefore, '  **据此产生的判分结果逐字段不变**（score/full/percent/level/per 明细全等）');
eq([scoreBefore.score, scoreBefore.full, scoreBefore.percent, scoreBefore.level], [scoreBefore.full, scoreBefore.full, 100, '优秀'],
   '  数值留档：全对 → ' + scoreBefore.score + '/' + scoreBefore.full + ' 分（100%）' + scoreBefore.level
   + '；题型分布 ' + JSON.stringify(cnt(before.exam.questions)));
const srcLocked = Q.configSources(gLater.config, after.exam);
eq(Object.keys(srcLocked).reduce(function (s, k) { s[srcLocked[k]] = 1; return s; }, {}),
   { exam: 1 }, '  来源标注只有 exam、**没有 builtin/global**（有别的就说明有洞或漏读全局）');

const openAfter = await E.getExam(store, exOpen.exam.id);
const cfgOpenAfter = Q.resolveConfig(gLater.config, openAfter.exam);
eq(cfgOpenAfter.points['单选'], 77, '未锁定卷**继承最新全局**（单选 5 → 77）');
ok(JSON.stringify(cfgOpenAfter) !== JSON.stringify(cfgBefore), '  它与锁定卷的配置确实分道扬镳了（不是一起不动）');
// 用**它自己卷子的题 id**建作答表（全对）→ 分数的变化只可能来自配置，不会掺进对错差异
const scoreOpenAfter = Q.scoreExam(openAfter.exam.questions, answersOpen, cfgOpenAfter);
eq([scoreOpenBefore.score, scoreOpenBefore.full, scoreOpenBefore.level], [70, 70, '优秀'],
   '  改动前：未锁定卷全对 = 70/70（按旧分值 5/3/1/5，20 题）');
eq([scoreOpenAfter.score, scoreOpenAfter.full, scoreOpenAfter.level], [1650, 1650, '优秀'],
   '  改动后：同一份答卷满分变成 1650（按新分值 77/88/99/66）→ 判分结果**确实跟着全局走了**');
ok(scoreOpenAfter.score !== scoreOpenBefore.score,
   '  数值对锚：' + scoreOpenBefore.score + ' → ' + scoreOpenAfter.score + '（而锁定卷始终停在 ' + scoreBefore.score + '）');

// 反向对照：把锁定卷解锁 → 它必须重新跟随全局（证明"不变"不是因为它根本不读全局）
const un = await E.unlockExam(store, exLock.exam.id, { now: '2026-09-18T09:02:00.000Z' });
eq(un.ok, true, '反向对照：把它解锁');
const unExam = await E.getExam(store, exLock.exam.id);
eq(Q.resolveConfig(gLater.config, unExam.exam).points['单选'], 77,
   '  解锁后它**立刻跟随全局**（单选 = 77）→ 说明锁定态那 5 分确实是"锁住"而不是"读不到"');

/* ============================================================
 *  组级标准 ②：三种抽题规则各自的题量与总分
 * ============================================================ */
head('② 组级：三种抽题规则（题量精确 / 总分命中且分散 / 随机不重复可复现）');

function cfgOf(patch) { return Q.mergeConfig(Q.DEFAULT_CONFIG, patch); }
function cnt(qs) { const o = {}; qs.forEach(q => o[q.type] = (o[q.type] || 0) + 1); return o; }
function sum(qs, pts) { return Math.round(qs.reduce((s, q) => s + (pts[q.type] || 0), 0) * 2) / 2; }
const sig = r => r.questions.map(q => q.id).join('|');
const pts = Q.DEFAULT_CONFIG.points;   // 单选2 多选3 判断1 简答5

// ②-1 按题数比例
const c1 = cfgOf({ pick: { mode: 'byCount', byType: { '单选': 5, '多选': 3, '判断': 2, '简答': 1 }, seed: 3 } });
const p1 = Q.pickQuestions(BANK, c1);
eq(p1.questions.length, 11, '②-1 按题数比例：共抽 11 题（5+3+2+1）');
eq(cnt(p1.questions), { '单选': 5, '多选': 3, '判断': 2, '简答': 1 }, '  各题型数量**精确匹配**配置');
eq(new Set(p1.questions.map(q => q.id)).size, 11, '  无重复');
eq([p1.meta.shortageCount, p1.meta.warn], [0, null], '  题库充足 → 缺口 0、无警告');

// ②-2 按总分权重
const c2 = cfgOf({ pick: { mode: 'byWeight', targetScore: 40, seed: 3 } });
const p2 = Q.pickQuestions(BANK, c2);
eq(sum(p2.questions, pts), 40, '②-2 按总分权重：抽出题总分**恰好命中**目标 40 分');
ok(Object.keys(cnt(p2.questions)).length >= 2, '  **分数分散在多个题型**（' + Object.keys(cnt(p2.questions)).length + ' 个：' + JSON.stringify(cnt(p2.questions)) + '）');
eq([p2.meta.targetScore, p2.meta.unused], [40, 0], '  目标分与未用预算如实报出');
ok(p2.questions.length > 1 && p2.questions.length < 40, '  且题数合理（不是"一题 40 分"也不是"凑满 40 题"）：' + p2.questions.length + ' 题');

// ②-3 完全随机
const c3 = cfgOf({ pick: { mode: 'random', randomBasis: 'count', count: 25, seed: 3 } });
const p3 = Q.pickQuestions(BANK, c3);
eq(p3.questions.length, 25, '②-3 完全随机：题量正确（25 题）');
eq(new Set(p3.questions.map(q => q.id)).size, 25, '  无重复');
eq([p3.meta.shortageCount, p3.meta.warn], [0, null], '  题库充足 → 缺口 0、无警告');
// 随机 + 按分数（同一"完全随机"规则的另一口径）
const p3s = Q.pickQuestions(BANK, cfgOf({ pick: { mode: 'random', randomBasis: 'score', targetScore: 60, seed: 3 } }));
eq(sum(p3s.questions, pts), 60, '②-3b 完全随机（按分数口径）：总分命中 60');
eq(new Set(p3s.questions.map(q => q.id)).size, p3s.questions.length, '  无重复');

// ②-4 同 seed 可复现
[['byCount', c1], ['byWeight', c2], ['random', c3]].forEach(function (pair) {
  const a = Q.pickQuestions(BANK, pair[1]);
  const b = Q.pickQuestions(BANK, pair[1]);
  eq(sig(a), sig(b), '②-4 ' + pair[0] + '：同 seed 两次抽题**逐题一致（含顺序）**');
});
const d1 = sig(Q.pickQuestions(BANK, cfgOf({ pick: { mode: 'random', randomBasis: 'count', count: 25, seed: 3 } })));
const d2 = sig(Q.pickQuestions(BANK, cfgOf({ pick: { mode: 'random', randomBasis: 'count', count: 25, seed: 4 } })));
eq(d1 !== d2, true, '②-4 换个 seed → 抽到的题不同（"可复现"没有退化成"永远同一批"）');

/* ============================================================
 *  组级标准 ③：题库不足时不崩 + 抽出可用题量 + 明确缺口文案
 * ============================================================ */
head('③ 组级：题库不足（不崩 / 抽光可用 / 明确缺口文案）');

const smallBank = BANK.filter(function (q, i) {
  if (q.type === '单选') return i < 30 && BANK.slice(0, i + 1).filter(x => x.type === '单选').length <= 2;
  if (q.type === '多选') return BANK.slice(0, i + 1).filter(x => x.type === '多选').length <= 1;
  if (q.type === '判断') return false;                       // 判断题一道都没有
  return BANK.slice(0, i + 1).filter(x => x.type === '简答').length <= 3;
});
eq(smallBank.length, 6, '小题库：单选 2 / 多选 1 / 判断 0 / 简答 3 = 6 题');
eq(cnt(smallBank), { '单选': 2, '多选': 1, '简答': 3 }, '  分布符合预期');

const s1 = Q.pickQuestions(smallBank, cfgOf({ pick: { mode: 'byCount', byType: { '单选': 5, '多选': 4, '判断': 2, '简答': 1 }, seed: 1 } }));
eq(s1.questions.length, 4, '③-1 按题数比例 + 题库不足 → 抽出 Σmin(要,有) = 4 题，**不崩**');
ok(s1.questions.every(q => q && q.id && q.type && q.stem), '  结果里没有空白题（每道都有 id/题型/题干）');
eq(new Set(s1.questions.map(q => q.id)).size, 4, '  无重复');
eq(s1.meta.byTypeShortfall, {
  '单选': { want: 5, got: 2, gap: 3, pool: 2 },
  '多选': { want: 4, got: 1, gap: 3, pool: 1 },
  '判断': { want: 2, got: 0, gap: 2, pool: 0 }
}, '  逐题型缺口（够的题型**不**进缺口表）');
eq(s1.meta.shortageCount, 8, '  缺口总数 = 3+3+2 = 8 题');
ok(/题库不够/.test(s1.meta.warn) && /单选要 5 只有 2（缺 3）/.test(s1.meta.warn), '  缺口文案带**逐题型数字**', s1.meta.warn);

const s2 = Q.pickQuestions(smallBank, cfgOf({ pick: { mode: 'random', randomBasis: 'count', count: 20, seed: 1 } }));
eq(s2.questions.length, 6, '③-2 完全随机 + 题库不足 → 抽光 6 题');
eq(s2.meta.shortageCount, 14, '  缺口 14 题');
ok(/题库只有 6 题/.test(s2.meta.warn), '  文案说明原因', s2.meta.warn);

const s3 = Q.pickQuestions(smallBank, cfgOf({ pick: { mode: 'byWeight', targetScore: 200, seed: 1 } }));
eq(s3.questions.length, 6, '③-3 按总分权重 + 目标分远超题库 → 抽光 6 题（不死循环、不静默截断）');
eq(s3.meta.poolExhausted, true, '  并标出"题库抽完了还是没凑够"');
ok(s3.meta.shortageScore > 0, '  按**分数**口径报缺口', s3.meta.shortageScore);

const s4 = Q.pickQuestions([], cfgOf({ pick: { mode: 'byCount', byType: { '单选': 1, '多选': 1, '判断': 1, '简答': 1 } } }));
eq(s4.questions, [], '③-4 完全空题库 → 返回空数组，不抛异常');
const s5 = Q.pickQuestions(null, cfgOf({ pick: { mode: 'random', randomBasis: 'count', count: 5 } }));
eq(s5.questions, [], '  传 null 也不崩');

/* ============================================================ */
head('整体验收：一致性 / 覆盖性');

// 一致性：四处"单一真相源"必须与配置字段模型对齐
const gaps = Q.fieldModelGaps();
eq([gaps.unregistered, gaps.orphanFields], [[], []], '字段模型 ↔ 内置默认 一一对应（没有未登记项、没有凭空字段）');
eq(Q.CONFIG_FIELDS.length, Q.pathsOf(Q.DEFAULT_CONFIG).length, '字段数 = 默认配置叶子数（' + Q.CONFIG_FIELDS.length + '）');

// 覆盖性：本组涉及的每一类配置都能被"改 → 存 → 重读 → 生效"走通一遍
const gCover = await E.writeGlobalConfig(store, {
  points: { '单选': 4, '多选': 6, '判断': 2, '简答': 8 },
  multi: { halfCredit: false, halfMode: 'fixed', halfRatio: 0.4, wrongChoiceZero: false },
  short: { matchMode: 'exact', ignoreCase: false, scoreMode: 'range', minRatio: 0.2, maxRatio: 0.8, synonyms: { SYN: ['同步'] } },
  pick: { mode: 'random', randomBasis: 'score', targetScore: 50, seed: 0 },
  grade: { pass: 55, excellent: 90 },
  reveal: { answerTiming: 'each', explainTiming: 'end' },
  behavior: { autoCheck: true, autoNext: false }
});
eq(gCover.ok, true, '七类配置一次性写入全局：全部通过校验');
const store2 = W.store('app');                                  // 新 store 实例 = 真重读
const gRead = await E.readGlobalConfig(store2);
eq(gRead.config, gCover.config, '  换一个 store 实例重读 → 逐字段相同（真持久，不是内存缓存）');
const eff = Q.resolveConfig(gRead.config, null);
eq([eff.points['简答'], eff.grade.pass, eff.reveal.answerTiming, eff.behavior.autoCheck, eff.pick.seed],
   [8, 55, 'each', true, 0], '  解析出的生效值都对（含 seed=0 这种"0 是合法值"的坑）');
const pv = Q.configPreview(gRead.config, null);
eq(pv.length, Q.CONFIG_FIELDS.length, '设置预览行数 = 字段数（' + pv.length + '，没有字段漏出预览）');
eq(pv.filter(r => r.source !== 'global' && r.source !== 'builtin').length, 0, '  每一行的来源标注都在三层之内');

// 一致性：抽题用的分值 === 判分用的分值（不然"预期总分"是假的）
const pvPts = {};
pv.filter(r => r.path.indexOf('points.') === 0).forEach(r => { pvPts[r.path.split('.')[1]] = r.value; });
eq(pvPts, eff.points, '预览里的题型分值 === 生效配置的分值（同一份数据）');
const pk = Q.pickQuestions(BANK, eff);
const sc = Q.scoreExam(pk.questions, {}, eff);
eq(sc.full, pk.meta.totalPoints, '抽题自报的总分 === 判分算出的满分（' + sc.full + ' 分）');

// 覆盖性：全量回归与两个反向探针都要绿（这里是"上一步刚跑过"的引用，不重复跑）
console.log('\n  \x1b[36m附：本组四条小类的回归与探针（在收官时点各跑过一次）\x1b[0m');
console.log('     \x1b[90m⚠ 下面的条数是**该组收官当天**的留档，不是当前值；当前台账看 node verify/run-all.js\x1b[0m');
console.log('     node verify/config.test.js   PASS 111   （三层取值与合并）');
console.log('     node verify/lock.test.js     PASS  89   （快照固化与脱钩）');
console.log('     node verify/scoring.test.js  PASS 143   （分值项建模）');
console.log('     node verify/picking.test.js  PASS 101   （抽题策略）');
console.log('     node verify/flow.test.js     PASS 107   （行为开关与分数线）');
console.log('     node verify/probe-picking-old.js  5/5   锚能变红');
console.log('     node verify/probe-flow-old.js     6/6   锚能变红');
console.log('     全量回归 21 个文件 2395 条断言 全绿');

console.log('\n\x1b[36m================ 组级汇总 ================\x1b[0m');
console.log('  PASS ' + pass + '    FAIL ' + fail);
if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
process.exitCode = fail ? 1 : 0;
}

main().catch(e => { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
