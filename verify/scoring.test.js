/* ============================================================
 *  verify/scoring.test.js —— 「分值项建模」小类验收
 *
 *  运行： node verify/scoring.test.js
 *
 *  三条盘档验收标准，逐条对应：
 *    ① 各分值项均可修改并持久；非法值（负分值、比例超过 1、区间上下限颠倒）被拒绝并给出提示
 *    ② 同一组分值配置在全局修改后，未锁定卷立即生效、锁定卷保持不变
 *    ③ 分值项的当前生效值可在设置预览中看到
 *
 *  三条反空转设计：
 *    · ① 的"拒绝"必须配"合法补丁能通过且存储确实变了"的对照 ——
 *      否则一个恒返回 ok:false 的假校验也能全过。
 *    · ① 的"持久"必须用**新建 store 实例**（同一后端）重读 —— 内存缓存骗不过这一步。
 *    · ③ 的"预览"要与 resolveConfig 逐路径核对 —— 否则预览可能显示一套、判分用另一套。
 * ============================================================ */
const Q = require('../core/quiz.js');
const S = require('../core/schema.js');
const E = require('../core/exams.js');
const D = require('../core/data.js');

let pass = 0, fail = 0; const failures = [];
function brief(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return String(s);
  return s.length > 150 ? s.slice(0, 150) + '…(' + s.length + ' 字符)' : s;
}
function ok(c, t, d) { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + brief(d) : '')))
                         : (fail++, failures.push(t), console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + brief(d) : ''))); }
function eq(a, e, t) { const A = JSON.stringify(a), B = JSON.stringify(e); ok(A === B, t + '   期望=' + brief(B), A); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }

/* 同一份后端上再开一个 store —— 模拟"关掉再打开"，用来验真持久 */
function makeWorld() {
  const m = new Map();
  const mk = () => ({
    getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: k => { m.delete(k); }, key: i => { const a = Array.from(m.keys()); return i < a.length ? a[i] : null; },
    get length() { return m.size; }
  });
  return {
    store: () => D.createStore({ small: mk(), large: null, namespace: D.NS_GLOBAL, threshold: 4096 }),
    reopen: () => D.createStore({ small: mk(), large: null, namespace: D.NS_GLOBAL, threshold: 4096 })
  };
}
function at(o, p) { return String(p).split('.').reduce(function (a, k) { return (a == null) ? undefined : a[k]; }, o); }

/* 一份计分对配置敏感的卷子（用来验"预览与判分用同一套值"） */
function makeExam() {
  return S.createExam({
    id: 'E_SCORE', title: '分值测试卷',
    questions: [
      S.createQuestion({ id: 'q1', type: '单选', stem: '单选？', options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }], answer: 'B', review: [] }),
      S.createQuestion({ id: 'q2', type: '多选', stem: '多选？', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }, { label: 'C', text: 'c' }], answer: 'AB', review: [] }),
      S.createQuestion({ id: 'q4', type: '简答', stem: '简答？', answer: '甲甲；乙乙', keywords: [{ text: '甲甲', via: '手动' }, { text: '乙乙', via: '手动' }], review: [] })
    ]
  }, { now: '2026-09-18T06:00:00.000Z' });
}
const ANSWERS = { q1: 'B', q2: 'A', q4: '甲甲' };

(async function main() {

  /* ============================================================
   * ①-A 分值项模型：覆盖面
   * ============================================================ */
  head('①-A 配置字段模型必须覆盖内置默认的每一个叶子');

  // 这里不写死条数（字段会随需求增长）——**严格一一对应**由 ⑤-A 的集合相等断言负责，
  // 这条只守"覆盖面没缩水"（防止有人图省事删字段）。
  ok(Array.isArray(Q.CONFIG_FIELDS) && Q.CONFIG_FIELDS.length >= 28,
     'CONFIG_FIELDS 覆盖面没缩水（≥28 项）', String(Q.CONFIG_FIELDS.length));
  const scoreFields = Q.CONFIG_FIELDS.filter(f => f.group === '题型分值' || f.group === '多选题' || f.group === '简答题');
  eq(scoreFields.map(f => f.path), [
    'points.单选', 'points.多选', 'points.判断', 'points.简答',
    'multi.halfCredit', 'multi.halfMode', 'multi.halfScore', 'multi.halfRatio', 'multi.wrongChoiceZero',
    'short.matchMode', 'short.ignoreCase', 'short.scoreMode', 'short.minRatio', 'short.maxRatio', 'short.synonyms'
  ], '分值项 = 4 个题型分值 + 5 个多选项 + 6 个简答项');
  ok(Q.CONFIG_FIELDS.every(f => f.label && f.group && f.kind), '  每一项都有中文标签/分组/类型');
  eq(Q.CONFIG_FIELD_MAP['multi.halfMode'].values, ['fixedScore', 'fixed', 'hitRatio'], '半对模式的三个取值与计分实现一致（默认 fixedScore 半对固定给分）');
  eq(Q.CONFIG_FIELD_MAP['short.scoreMode'].values, ['hitRatio', 'range'], '简答评分模式的两个取值与实现一致');

  /* ============================================================
   * ①-B 各分值项可改并**持久**
   * ============================================================ */
  head('①-B 改一组分值项 → 新 store 实例重读仍在（真持久）');

  const W = makeWorld();
  const store = W.store();
  const PATCH = {
    points: { '单选': 3.5, '多选': 6, '判断': 1.5, '简答': 9 },
    multi: { halfCredit: false, halfMode: 'fixed', halfScore: 3, halfRatio: 0.75, wrongChoiceZero: false },
    short: { matchMode: 'exact', ignoreCase: false, scoreMode: 'range', minRatio: 0.25, maxRatio: 0.75 }
  };
  const w1 = await E.writeGlobalConfig(store, PATCH, { now: '2026-09-18T06:10:00.000Z' });
  ok(w1.ok, '写入一组分值项成功', w1.error || '');
  eq(w1.effective.points, { '单选': 3.5, '多选': 6, '判断': 1.5, '简答': 9 }, '  生效的分值');
  eq(w1.effective.multi, { halfCredit: false, halfMode: 'fixed', halfScore: 3, halfRatio: 0.75, wrongChoiceZero: false }, '  生效的多选组');
  eq(w1.effective.short.matchMode, 'exact', '  生效的简答匹配方式');
  eq([w1.effective.short.minRatio, w1.effective.short.maxRatio], [0.25, 0.75], '  生效的简答区间');
  eq(w1.effective.short.synonyms, {}, '  没改的项仍是内置默认（部分覆盖语义）');

  const reopened = await E.readGlobalConfig(W.reopen());
  eq(reopened.config, PATCH, '**新 store 实例重读到的就是写进去的那份**（真落盘了）');
  const effReopened = Q.resolveConfig(reopened.config, null);
  eq(effReopened.points['多选'], 6, '  重读后生效的多选分值 = 6');
  eq(effReopened.short.maxRatio, 0.75, '  重读后生效的区间上限 = 0.75');

  // 增量补丁：只改一项，其余保持
  const w2 = await E.writeGlobalConfig(store, { points: { '判断': 2.5 } });
  ok(w2.ok, '增量补丁（只改判断题分值）成功');
  eq(w2.effective.points['判断'], 2.5, '  判断题分值 → 2.5');
  eq(w2.effective.points['单选'], 3.5, '  之前改过的单选分值仍在（3.5）');
  eq((await E.readGlobalConfig(W.reopen())).config.points['判断'], 2.5, '  增量结果也持久');

  /* ============================================================
   * ①-C 非法值必须被拒绝并给出提示（且不写盘）
   * ============================================================ */
  head('①-C 非法值逐例拒绝：错误码 + 字段路径 + 提示');

  const storageBefore = JSON.stringify((await E.readGlobalConfig(store)).config);

  const BAD_CASES = [
    ['负分值', { points: { '单选': -5 } }, 'E_CFG_NEGATIVE', 'points.单选'],
    ['分值不是数字', { points: { '多选': '6' } }, 'E_CFG_NOT_NUMBER', 'points.多选'],
    ['比例超过 1', { multi: { halfRatio: 3.5 } }, 'E_CFG_OUT_OF_RANGE', 'multi.halfRatio'],
    ['比例为负', { short: { minRatio: -0.1 } }, 'E_CFG_NEGATIVE', 'short.minRatio'],
    ['区间上下限颠倒', { short: { minRatio: 0.8, maxRatio: 0.2 } }, 'E_CFG_RANGE_INVERTED', 'short.maxRatio'],
    ['半对模式非法', { multi: { halfMode: 'whatever' } }, 'E_CFG_BAD_ENUM', 'multi.halfMode'],
    ['简答评分模式非法', { short: { scoreMode: 'magic' } }, 'E_CFG_BAD_ENUM', 'short.scoreMode'],
    ['开关不是布尔', { behavior: { autoNext: 'yes' } }, 'E_CFG_NOT_BOOLEAN', 'behavior.autoNext'],
    ['题数不是整数', { pick: { count: 2.5 } }, 'E_CFG_NOT_INTEGER', 'pick.count'],
    ['同义词不是数组', { short: { synonyms: { SYN: '同步' } } }, 'E_CFG_BAD_SYNONYMS', 'short.synonyms.SYN'],
    ['同义词里混了非字符串', { short: { synonyms: { SYN: ['同步', 42] } } }, 'E_CFG_BAD_SYNONYMS', 'short.synonyms.SYN'],
    ['分数线颠倒', { grade: { pass: 90, excellent: 60 } }, 'E_CFG_RANGE_INVERTED', 'grade.excellent'],
    ['分值超过 100', { grade: { pass: 120 } }, 'E_CFG_OUT_OF_RANGE', 'grade.pass']
  ];

  for (const c of BAD_CASES) {
    const r = await E.writeGlobalConfig(store, c[1]);
    eq(r.ok, false, c[0] + ' → 被拒绝');
    const hit = (r.errors || []).filter(e => e.code === c[2] && e.path === c[3]);
    ok(hit.length > 0, '  错误码与字段路径正确：' + c[2] + '@' + c[3],
       brief((r.errors || []).map(e => e.code + '@' + e.path)));
    ok(!!(hit[0] && hit[0].message && hit[0].message.length > 4), '  有可读提示', hit[0] && hit[0].message);
    ok(!!(hit[0] && hit[0].hint), '  有修复建议', hit[0] && hit[0].hint);
  }
  eq((await E.readGlobalConfig(store)).config && JSON.stringify((await E.readGlobalConfig(store)).config),
     storageBefore, '**连番非法写入之后，存储逐字节未变**');

  head('①-D 反向对照：合法补丁必须通过且确实改变存储（证明拒绝不是空转）');

  const okWrite = await E.writeGlobalConfig(store, { points: { '单选': 7 } }, { now: '2026-09-18T06:20:00.000Z' });
  ok(okWrite.ok, '合法补丁通过');
  eq(okWrite.effective.points['单选'], 7, '  生效值 = 7');
  ok(JSON.stringify((await E.readGlobalConfig(store)).config) !== storageBefore,
     '  **存储确实变了**（否则上面那条"未变"是空转）');
  eq((await E.readGlobalConfig(W.reopen())).config.points['单选'], 7, '  并已落盘');

  head('①-E 跨层组合出的非法值也要拦（补丁本身合法、合并后才颠倒）');

  const W2 = makeWorld();
  const s2 = W2.store();
  await E.writeGlobalConfig(s2, { short: { minRatio: 0.9 } });                 // 此时 max 还是默认 1 → 合法
  const cross = await E.writeGlobalConfig(s2, { short: { maxRatio: 0.1 } });   // 补丁只写 max，单看合法
  eq(cross.ok, false, '下限来自全局(0.9)、上限来自补丁(0.1) → 合并后颠倒 → 被拦');
  ok((cross.errors || []).some(e => e.code === 'E_CFG_RANGE_INVERTED'), '  错误码正确', brief(cross.errors));
  eq((await E.readGlobalConfig(s2)).config.short.maxRatio, undefined, '  没写进去');

  head('①-F 历史遗留的非法值不该挡住"没碰它"的补丁');

  const W3 = makeWorld();
  const s3 = W3.store();
  await s3.set('settings', { config: { short: { minRatio: 0.9, maxRatio: 0.1 } } });   // 模拟旧版本写坏的数据
  const fixOther = await E.writeGlobalConfig(s3, { points: { '单选': 4 } });
  ok(fixOther.ok, '只改分值 → 允许（补丁只为自己写到的字段负责）');
  eq(fixOther.effective.points['单选'], 4, '  改的那项生效');
  ok((fixOther.preexisting || []).some(e => e.code === 'E_CFG_RANGE_INVERTED'),
     '  但历史非法值被**如实报出**（看得见，不拦）', brief(fixOther.preexisting));
  const fixHalf = await E.writeGlobalConfig(s3, { short: { minRatio: 0.2 } });
  eq(fixHalf.ok, false, '一旦补丁碰到区间那一半 → 仍然颠倒 → 必须拦');

  /* ============================================================
   * ② 全局改后：未锁定立即生效 / 锁定不变
   * ============================================================ */
  head('②-A 同一组分值：未锁定卷立即生效');

  const baseExam = makeExam();
  const unlockedExam = { id: 'E_UNLOCKED', config: null, configLocked: false };
  const W4 = makeWorld();
  const s4 = W4.store();

  await E.writeGlobalConfig(s4, { points: { '单选': 2, '多选': 3, '判断': 1, '简答': 5 }, multi: { halfCredit: true, halfRatio: 0.5 }, short: { scoreMode: 'hitRatio' } });
  const before = Q.resolveConfig((await E.readGlobalConfig(s4)).config, unlockedExam);
  const scoreBefore = Q.scoreExam(baseExam.questions, ANSWERS, before);
  eq([before.points['单选'], before.multi.halfRatio, before.short.scoreMode], [2, 0.5, 'hitRatio'], '起点：分值/半对比例/简答模式');
  eq(scoreBefore.score, 6.5,
     '起点得分 = 2 + 多选半对（默认 fixedScore → 固定 2 分）+ 5×0.5 = 6.5');

  const wAfter = await E.writeGlobalConfig(s4, { points: { '单选': 10 }, multi: { halfRatio: 1 } });
  ok(wAfter.ok, '改全局：单选 2→10、半对比例 0.5→1');
  const after = Q.resolveConfig(wAfter.config, unlockedExam);
  const scoreAfter = Q.scoreExam(baseExam.questions, ANSWERS, after);
  eq(after.points['单选'], 10, '**未锁定卷立即生效**：单选分值 = 10');
  eq(after.multi.halfRatio, 1, '  半对比例 = 1');
  eq(scoreAfter.score, 14.5,
     '  得分随之变成 10 + 多选半对（仍是固定 2 分）+ 5×0.5 = 14.5');
  ok(JSON.stringify(scoreAfter) !== JSON.stringify(scoreBefore), '  与改之前确实不同',
     scoreBefore.score + ' → ' + scoreAfter.score);

  head('②-B 同一组分值：锁定卷保持不变');

  const lockedExam = Q.lockConfig(before, baseExam);           // 在"起点"那一刻锁定
  eq(lockedExam.configLocked, true, '在起点那一刻锁定该卷');
  const lockedAfter = Q.resolveConfig(wAfter.config, lockedExam);
  eq(lockedAfter.points['单选'], 2, '**锁定卷不受影响**：单选分值仍是 2（不是 10）');
  eq(lockedAfter.multi.halfRatio, 0.5, '  半对比例仍是 0.5');
  eq(Q.scoreExam(baseExam.questions, ANSWERS, lockedAfter), scoreBefore, '  计分结果与锁定时逐字段相同');
  ok(JSON.stringify(Q.scoreExam(baseExam.questions, ANSWERS, lockedAfter)) !== JSON.stringify(scoreAfter),
     '  且与"未锁定卷现在的得分"不同（说明隔离真的起作用）',
     scoreBefore.score + ' vs ' + scoreAfter.score);

  head('②-C 单卷覆写优先于全局，且同样"立即生效"');

  const own = { id: 'E_OWN', config: { points: { '单选': 20 }, multi: { halfCredit: false } }, configLocked: false };
  const cfgOwn = Q.resolveConfig(wAfter.config, own);
  eq(cfgOwn.points['单选'], 20, '单卷覆写的分值 20 赢过全局的 10');
  eq(cfgOwn.multi.halfCredit, false, '  单卷覆写的开关也赢过全局');
  const w5 = await E.writeGlobalConfig(s4, { points: { '单选': 30 } });
  eq(Q.resolveConfig(w5.config, own).points['单选'], 20, '  再改全局 → 单卷覆写仍然赢（仍是 20）');
  eq(Q.resolveConfig(w5.config, own).points['多选'], 3,
     '  而单卷没写的项跟着全局走（全局里 多选=3）');

  /* ============================================================
   * ③ 设置预览
   * ============================================================ */
  head('③-A 预览覆盖全部配置项，且与 resolveConfig 逐路径一致');

  const preview = Q.configPreview(w5.config, own);
  eq(preview.length, Q.CONFIG_FIELDS.length, '预览行数 = 配置字段数（' + preview.length + '）');
  eq(preview.map(r => r.path), Q.CONFIG_FIELDS.map(f => f.path), '  路径集合与字段模型完全一致（不多不少）');

  const effOwn = Q.resolveConfig(w5.config, own);
  const mism = preview.filter(r => JSON.stringify(r.value) !== JSON.stringify(at(effOwn, r.path)));
  eq(mism.map(r => r.path), [], '**每一行的 value 都等于 resolveConfig 的生效值**（预览与判分同一套值）');

  const srcOwn = Q.configSources(w5.config, own);
  const srcMism = preview.filter(r => r.source !== (srcOwn[r.path] || 'builtin'));
  eq(srcMism.map(r => r.path), [], '  每一行的来源标注与 configSources 一致');

  head('③-B 预览的显示文本可直接渲染（含单位与枚举中文）');

  const rowOf = p => preview.filter(r => r.path === p)[0];
  eq(rowOf('points.单选').display, '20 分', '数字项带单位：20 分');
  eq(rowOf('points.单选').unit, '分', '  单位字段也在');
  eq(rowOf('points.单选').sourceLabel, '本卷（快照/单卷设置）', '  来源：本卷');
  eq(rowOf('grade.pass').sourceLabel, '内置默认', '  从没被任何人改过的项 → 内置默认');
  eq(rowOf('pick.count').sourceLabel, '内置默认', '  抽题那组也没改过 → 内置默认');
  eq(rowOf('points.判断').sourceLabel, '全局设置',
     '对照：全局里写过的项 → 全局设置（不是"没改过"）');
  eq(rowOf('multi.halfMode').display, '半对固定给分（fixedScore）', '枚举项显示中文 + 原值');
  eq(rowOf('short.ignoreCase').display, '开', '布尔项显示 开/关');
  eq(rowOf('short.synonyms').display, '0 组同义写法', '同义词项显示组数');
  eq(rowOf('multi.halfMode').values, ['fixedScore', 'fixed', 'hitRatio'], '  枚举项带上可选值（设置界面要渲染下拉）');
  eq(preview.every(r => r.editable === true), true, '  每一行都可编辑');

  head('③-C 预览反映"当前生效值"：改全局预览跟着变；锁定卷预览不变');

  const pv1 = Q.configPreview({ points: { '单选': 2 } }, null);
  const pv2 = Q.configPreview({ points: { '单选': 10 } }, null);
  eq(pv1.filter(r => r.path === 'points.单选')[0].display, '2 分', '改全局前：单选 2 分');
  eq(pv2.filter(r => r.path === 'points.单选')[0].display, '10 分', '  改全局后：单选 10 分（预览跟着变）');

  const lockedForPreview = Q.lockConfig({ points: { '单选': 2 } }, baseExam);
  const pvLocked = Q.configPreview({ points: { '单选': 99 } }, lockedForPreview);
  const lRow = pvLocked.filter(r => r.path === 'points.单选')[0];
  eq(lRow.display, '2 分', '锁定卷预览显示快照里的 2 分（不受新全局 99 影响）');
  eq(lRow.source, 'exam', '  来源标注为 exam');
  eq(lRow.sourceLabel, '本卷（快照/单卷设置）', '  中文来源');
  eq(lRow.locked, true, '  并标出 locked=true（界面可据此禁用编辑）');
  eq(pv2.filter(r => r.path === 'points.单选')[0].locked, false, '对照：未锁定卷的那一行 locked=false');

  /* ============================================================
   * ④ 相邻锚
   * ============================================================ */
  head('④-A 相邻锚：写进去的配置能过 schema 校验，并直接喂给计分/抽题');

  const storedCfg = (await E.readGlobalConfig(s4)).config;
  const examWithCfg = S.createExam({ id: 'E_ANCHOR', title: '锚', questions: [], config: Q.resolveConfig(storedCfg, null) }, { now: '2026-09-18T07:00:00.000Z' });
  eq(S.validateExam(examWithCfg).ok, true, '全局配置写进试卷后仍通过 validateExam');
  const cfgForScore = Q.resolveConfig(storedCfg, null);
  eq(typeof Q.scoreOne(baseExam.questions[0], 'B', cfgForScore).score, 'number', '同一份配置能喂给 scoreOne');
  eq(Array.isArray(Q.pickQuestions(baseExam.questions, cfgForScore).questions), true, '  也能喂给 pickQuestions');

  head('④-B 相邻锚：锁定卷的快照也带着改后的分值项（随快照固化）');

  const W5 = makeWorld();
  const s5 = W5.store();
  await E.writeGlobalConfig(s5, { points: { '单选': 12 }, multi: { halfMode: 'fixed', halfRatio: 0.25 } });
  const c5 = await E.createExam(s5, { title: '快照固化分值', now: '2026-09-18T07:10:00.000Z' });
  const lk = await E.lockExam(s5, c5.exam.id, { globalCfg: (await E.readGlobalConfig(s5)).config });
  ok(lk.ok, '锁定成功');
  eq(lk.exam.config.points['单选'], 12, '快照里固化了改后的分值 12（不是默认 2）');
  eq(lk.exam.config.multi.halfMode, 'fixed', '  半对模式也固化了');
  eq(lk.exam.config.multi.halfRatio, 0.25, '  半对比例也固化了');
  await E.writeGlobalConfig(s5, { points: { '单选': 50 }, multi: { halfRatio: 0.9 } });
  eq(Q.resolveConfig((await E.readGlobalConfig(s5)).config, lk.exam).points['单选'], 12,
     '  之后再改全局，锁定卷仍是 12（分值项随快照固化）');

  /* ============================================================
   * ⑤ 挑刺：字段模型的"漏登记"必须变响
   * ============================================================ */
  head('⑤-A 字段模型自检：默认配置与 CONFIG_FIELDS 必须严格一一对应');

  const gaps = Q.fieldModelGaps();
  eq(gaps, { unregistered: [], orphanFields: [] },
     '**没有未登记的默认项、也没有多余的字段声明**（漏登记会让该项静默逃过校验与预览）');

  const defaultLeaves = Q.pathsOf(Q.DEFAULT_CONFIG).slice().sort();
  const fieldPaths = Q.CONFIG_FIELDS.map(f => f.path).slice().sort();
  eq(fieldPaths, defaultLeaves, '  字段声明与内置默认的叶子路径**集合完全相等**（' + defaultLeaves.length + ' 项）');

  // 反向对照：真的漏登记时，必须能观测到（否则上面那条是空转）
  const probeKey = '__probe_unregistered__';
  let warned = false, restored = false;
  try {
    Q.DEFAULT_CONFIG[probeKey] = 1;
    const g2 = Q.fieldModelGaps();
    eq(g2.unregistered, [probeKey], '临时加一项没登记的 → 自检立刻报出来');
    const v2 = Q.validateConfig(Q.DEFAULT_CONFIG);
    const w2 = v2.warnings.filter(w => w.code === 'W_CFG_FIELD_MODEL_GAP');
    ok(w2.length === 1, '  并且 validateConfig 会发出 W_CFG_FIELD_MODEL_GAP 警告', brief(w2.map(w => w.hint)));
    warned = true;
  } finally {
    delete Q.DEFAULT_CONFIG[probeKey];
    restored = JSON.stringify(Q.fieldModelGaps()) === JSON.stringify({ unregistered: [], orphanFields: [] });
  }
  ok(warned, '反向对照：漏登记确实会被抓到（上面那条不是空转）');
  ok(restored, '  探针已清理，默认配置恢复原状');

  head('⑤-B 预览对同义词表的显示（有内容时）');

  const synCfg = { short: { synonyms: { SYN: ['同步', 'SYN包'], ACK: ['确认'] } } };
  const synPv = Q.configPreview(synCfg, null);
  const synRow = synPv.filter(r => r.path === 'short.synonyms')[0];
  eq(synRow.display, '2 组同义写法', '同义词项显示组数（2 组）');
  eq(synRow.source, 'global', '  来源标为全局');
  eq(synRow.value, { SYN: ['同步', 'SYN包'], ACK: ['确认'] }, '  原始值也在（设置界面要能回填）');
  // 同义词表本身也要通过校验
  eq((await E.writeGlobalConfig(W5.store(), synCfg)).ok, true, '  这份同义词表能通过校验并写入');

  head('⑤-C 字段模型 ↔ 来源标注：每个已登记字段都必须拿得到来源（不许静默回退 builtin）');

  // 反空转动机：曾出现「值本身是用户数据表的项」（short.synonyms）被 configSources
  // 当容器下钻，于是它自己没有条目 → configPreview 把这一行的来源错显成 builtin。
  // 只测"某一行显示对不对"抓不住这类 bug；这里改为对**整个字段模型**做双向核对。
  function setAt(o, path, v) {
    const seg = path.split('.'); let cur = o;
    for (let i = 0; i < seg.length - 1; i++) { if (!Q.isPlainObject(cur[seg[i]])) cur[seg[i]] = {}; cur = cur[seg[i]]; }
    cur[seg[seg.length - 1]] = v;
  }
  const allCfg = {};
  Q.CONFIG_FIELDS.forEach(function (f) { setAt(allCfg, f.path, Q.deepClone(Q.getPath(Q.DEFAULT_CONFIG, f.path))); });

  const allSrc = Q.configSources(allCfg, null);
  const allFieldPaths = Q.CONFIG_FIELDS.map(function (f) { return f.path; }).sort();
  const srcKeys = Object.keys(allSrc).sort();
  eq(srcKeys, allFieldPaths,
     '全局写满所有字段后，来源表的键集合 **恰好等于** 字段模型（多一个=下钻到了用户数据，少一个=该字段拿不到来源）');

  const noSrc = allFieldPaths.filter(function (p) { return allSrc[p] !== 'global'; });
  eq(noSrc, [], '**每个字段**都被标成 global（有字段没标 → 就会被 configPreview 静默显示成 builtin）');

  const pvAll = Q.configPreview(allCfg, null);
  const pvBad = pvAll.filter(function (r) { return r.source !== 'global'; }).map(function (r) { return r.path + '=' + r.source; });
  eq(pvBad, [], '  预览里同样一行都不许错标（预览是设置界面直接渲染的数据）');
  eq(pvAll.length, Q.CONFIG_FIELDS.length, '  预览行数 = 字段数（' + Q.CONFIG_FIELDS.length + '），没有字段漏出预览');

  head('⑤-D 反向对照：把同义词表挖成"没写"时，它必须回退成 builtin（证明上面那条不是恒真）');

  const dropSyn = Q.deepClone(allCfg); delete dropSyn.short.synonyms;
  eq(Q.configSources(dropSyn, null)['short.synonyms'], 'builtin',
     '  全局里没写同义词表 → 来源回退 builtin（反向对照，证明 ⑤-C 的判定真的在测东西）');

  console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
  console.log('  PASS ' + pass + '    FAIL ' + fail);
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
