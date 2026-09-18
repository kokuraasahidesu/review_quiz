/* ============================================================
 *  verify/lock.test.js —— 「快照固化与脱钩」小类验收
 *
 *  运行： node verify/lock.test.js
 *
 *  三条盘档验收标准，逐条对应：
 *    ① 锁定后修改全局设置，该卷的配置**与据此产生的计分结果**均不变
 *    ② 锁定瞬间把当时的全局值一并固化（**不留空洞**）；未显式设置的项在快照里也是完整值
 *    ③ 解锁后该卷重新随全局变化，且**不再使用旧快照**
 *
 *  这个文件的两条反空转设计：
 *    · ① 必须配"不锁定时改全局、计分结果**确实会变**"的反向对照 ——
 *      否则一个"恒返回同一个值"的假实现也能让"不变"通过。
 *    · ③ 必须让**旧快照的值与新全局的值不同**，并断言取到的是新全局那个，
 *      才能证明解锁真的丢掉了旧快照（只改 configLocked 而留着快照的假解锁会在这里露馅）。
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

/* 枚举一份配置的全部叶子路径（数组算一个叶子 —— 与"整体替换"语义一致） */
function leafPaths(v, base, out) {
  out = out || []; base = base || '';
  if (Array.isArray(v) || !Q.isPlainObject(v)) { out.push(base); return out; }
  const ks = Object.keys(v);
  if (!ks.length) { out.push(base); return out; }
  ks.forEach(function (k) { leafPaths(v[k], base ? base + '.' + k : k, out); });
  return out;
}
function at(o, p) { return p.split('.').reduce(function (a, k) { return (a == null) ? undefined : a[k]; }, o); }

function makeStore() {
  const m = new Map();
  const small = {
    getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: k => { m.delete(k); }, key: i => { const a = Array.from(m.keys()); return i < a.length ? a[i] : null; },
    get length() { return m.size; }
  };
  return D.createStore({ small: small, large: null, namespace: D.NS_GLOBAL, threshold: 4096 });
}

/* 一份"四种题型都有、且计分对配置敏感"的卷子 */
function makeExam() {
  return S.createExam({
    id: 'E_LOCK',
    title: '锁定测试卷',
    questions: [
      S.createQuestion({ id: 'q1', type: '单选', stem: '单选？', options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }], answer: 'B', review: [] }),
      S.createQuestion({ id: 'q2', type: '多选', stem: '多选？', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }, { label: 'C', text: 'c' }], answer: 'AB', review: [] }),
      S.createQuestion({ id: 'q3', type: '判断', stem: '判断？（　）', answer: '对', review: [] }),
      S.createQuestion({ id: 'q4', type: '简答', stem: '简答？', answer: '甲甲；乙乙', keywords: [{ text: '甲甲', via: '手动' }, { text: '乙乙', via: '手动' }], review: [] })
    ]
  }, { now: '2026-09-18T02:00:00.000Z' });
}
/* 答案：单选对、多选只选一个（部分分）、判断对、简答命中一半 */
const ANSWERS = { q1: 'B', q2: 'A', q3: '对', q4: '甲甲' };

/* 锁定那一刻的全局 */
const G_LOCK = {
  points: { '单选': 5, '多选': 8, '判断': 2, '简答': 4 },
  multi: { halfCredit: true, halfMode: 'hitRatio', halfRatio: 0.5, wrongChoiceZero: true },
  short: { matchMode: 'contains' }
};
/* 锁定之后被改成的全局：分值、半对、简答匹配方式全变 → 计分必然不同 */
const G_LATER = {
  points: { '单选': 99, '多选': 99, '判断': 99, '简答': 99 },
  multi: { halfCredit: false, wrongChoiceZero: false },
  short: { matchMode: 'exact' }
};

(async function main() {

  const baseExam = makeExam();
  const scoreWith = cfg => Q.scoreExam(baseExam.questions, ANSWERS, cfg);

  /* ============================================================
   * ① 锁定后改全局：配置与计分结果都不变
   * ============================================================ */
  head('①-A 锁定后改全局 → 该卷配置逐字节不变');

  const locked = Q.lockConfig(G_LOCK, baseExam);
  eq(locked.configLocked, true, 'lockConfig 标记为已锁定');
  const cfgAtLock = Q.resolveConfig(G_LOCK, locked);
  const cfgAfterGlobalChange = Q.resolveConfig(G_LATER, locked);
  eq(cfgAfterGlobalChange, cfgAtLock, '**改全局后该卷配置逐字节不变**');
  eq(cfgAfterGlobalChange.points['单选'], 5, '  分值仍是锁定那一刻的 5（不是后来的 99）');
  eq(cfgAfterGlobalChange.multi.halfCredit, true, '  半对开关仍是锁定那一刻的 true');
  eq(cfgAfterGlobalChange.short.matchMode, 'contains', '  简答匹配方式仍是锁定那一刻的 contains');

  head('①-B 计分结果同样不变（整对象深比较）+ 反向对照证明不是空转');

  const scoreLockedAtLock = scoreWith(cfgAtLock);
  const scoreLockedLater = scoreWith(cfgAfterGlobalChange);
  eq(scoreLockedLater, scoreLockedAtLock, '**锁定卷的 scoreExam 结果逐字段相同**（含 per 明细）');
  eq(scoreLockedAtLock.full, 19, '  满分 = 5+8+2+4 = 19');
  eq(scoreLockedAtLock.score, 11, '  得分 = 5 + 2（多选半对）+ 2 + 2（简答半命中）= 11');
  eq(scoreLockedAtLock.level, '不及格',
     '  等级按锁定时的 60 分线：57.9% < 60 → 不及格（**且改全局成 10 分线也不该把它变成及格**）');
  eq(scoreLockedLater.level, '不及格', '  锁定后等级同样不变');

  // 反向对照：同一份卷**不锁定**时，改全局必须让计分结果变化
  const unlockedExam = { id: 'E_UNLOCKED', config: null, configLocked: false };
  const scoreUnlockedAtLock = scoreWith(Q.resolveConfig(G_LOCK, unlockedExam));
  const scoreUnlockedLater = scoreWith(Q.resolveConfig(G_LATER, unlockedExam));
  ok(JSON.stringify(scoreUnlockedAtLock) !== JSON.stringify(scoreUnlockedLater),
     '**反向对照：不锁定时改全局，计分结果确实会变**（证明上面那条"不变"是真观察到的）',
     scoreUnlockedAtLock.score + ' → ' + scoreUnlockedLater.score);
  eq(scoreUnlockedLater.score, 99 + 0 + 99 + 49.5, '  未锁定卷在 G_LATER 下的得分 = 99+0+99+49.5');
  eq(scoreUnlockedAtLock, scoreLockedAtLock, '  锁定那一刻，锁定卷与未锁定卷的计分结果相同（起点一致）');

  /* ============================================================
   * ② 快照不留空洞：未显式设置的项也是完整值
   * ============================================================ */
  head('②-A 逐叶子核对：快照里必须有**每一个**配置项，且等于锁定那一刻的生效值');

  const effectiveAtLock = Q.resolveConfig(G_LOCK, { config: null, configLocked: false });
  const leaves = leafPaths(Q.DEFAULT_CONFIG);
  ok(leaves.length > 20, '内置默认的叶子路径数 = ' + leaves.length + '（体量够做核对）');

  const missing = [], wrongVal = [];
  leaves.forEach(function (p) {
    const got = at(locked.config, p);
    if (got === undefined) { missing.push(p); return; }
    if (JSON.stringify(got) !== JSON.stringify(at(effectiveAtLock, p))) {
      wrongVal.push(p + ' 快照=' + JSON.stringify(got) + ' 应为=' + JSON.stringify(at(effectiveAtLock, p)));
    }
  });
  eq(missing, [], '**没有任何缺失项**（' + leaves.length + ' 条叶子逐条核对）');
  eq(wrongVal, [], '**每一条都等于锁定那一刻的生效值**');

  const undefLeaves = leafPaths(locked.config).filter(function (p) { return at(locked.config, p) === undefined; });
  eq(undefLeaves, [], '快照里不存在 undefined 叶子（字面意义的"不留空洞"）');

  head('②-B 来源标注：快照里不该出现 builtin（有 builtin 就说明有空洞）');

  const srcOfLocked = Q.configSources(G_LATER, locked);
  const layerSet = Object.keys(srcOfLocked).reduce(function (s, k) { s[srcOfLocked[k]] = 1; return s; }, {});
  eq(Object.keys(layerSet), ['exam'], '快照的所有项都标为 exam（**没有 builtin**）');
  eq(srcOfLocked['points.单选'], 'exam', '  连没被任何人改过的项也在快照里 → exam');
  eq(srcOfLocked['grade.excellent'], 'exam', '  没被任何人碰过的 grade.excellent 也在快照里 → exam');
  // short.synonyms 是那一类"值本身是用户数据表"的项（里面的键 = 关键词 → 写法，不是配置项），
  // 所以它在 configSources 里**算叶子** → 有自己的来源条目。
  // （早先它被当容器下钻到 SYN/ACK 去了，于是这一行拿不到标注，configPreview 错显 builtin。）
  eq(srcOfLocked['short.synonyms'], 'exam', '  用户数据表项（short.synonyms）本身有来源标注 → exam');
  eq(at(locked.config, 'short.synonyms'), {}, '  它在快照里确实存在（= 空对象）');

  head('②-C 全局里"多出来"的键也要一并固化');

  const gExtra = { points: { '单选': 3 }, custom: { flag: true, list: [1, 2] } };
  const lockedExtra = Q.lockConfig(gExtra, baseExam);
  eq(lockedExtra.config.custom, { flag: true, list: [1, 2] }, '全局新增的 custom 块被固化进快照');
  eq(Q.resolveConfig({ custom: { flag: false } }, lockedExtra).custom.flag, true,
     '  之后改 global.custom 也影响不到它');

  /* ============================================================
   * ③ 解锁：回到继承全局，且不再使用旧快照
   * ============================================================ */
  head('③-A 解锁后形态正确：config=null、configLocked=false');

  const unlocked = Q.unlockConfig(locked);
  eq(unlocked.config, null, '解锁后试卷自己的 config 被清空（**旧快照被丢掉**）');
  eq(unlocked.configLocked, false, '  锁定标记复位');
  eq(Object.keys(unlocked).sort(), Object.keys(locked).sort(), '  其余字段原样保留');
  eq(unlocked.title, locked.title, '  标题保留');
  eq(unlocked.questions.length, 4, '  题目保留');

  head('③-B 解锁后随全局变化，且取到的**不是**旧快照里的值');

  const afterUnlock = Q.resolveConfig(G_LATER, unlocked);
  eq(afterUnlock.points['单选'], 99,
     '改全局后取值 = 99（旧快照里是 5）→ **确实不再使用旧快照**');
  eq(afterUnlock.multi.halfCredit, false, '  半对开关跟着新全局变成 false');
  eq(afterUnlock.short.matchMode, 'exact', '  简答匹配方式跟着新全局变成 exact');
  eq(afterUnlock, Q.resolveConfig(G_LATER, { config: null, configLocked: false }),
     '  与"从未锁定过的卷"取值完全一致（回到纯继承路径）');

  head('③-C 解锁后计分也跟着变，且与未锁定卷一致');

  const scoreAfterUnlock = scoreWith(afterUnlock);
  eq(scoreAfterUnlock, scoreUnlockedLater, '解锁后的计分结果 = 未锁定卷的结果');
  ok(JSON.stringify(scoreAfterUnlock) !== JSON.stringify(scoreLockedAtLock),
     '  与锁定时的计分结果**不同**（说明解锁真的生效了）',
     scoreLockedAtLock.score + ' → ' + scoreAfterUnlock.score);
  eq(scoreAfterUnlock.full, 396, '  满分按新全局 = (99+99+99+99) = 396');

  head('③-D 解锁后重新锁定：快照取的是**新**全局');

  const reLocked = Q.lockConfig(G_LATER, unlocked);
  eq(reLocked.configLocked, true, '重新锁定成功');
  eq(reLocked.config.points['单选'], 99, '新快照里是 99（证明旧快照 5 真的被丢掉了）');
  eq(Q.resolveConfig(G_LOCK, reLocked).points['单选'], 99, '  之后再改回 G_LOCK 也影响不到它');

  /* ============================================================
   * ④ 落盘：锁定/解锁必须真写进试卷
   * ============================================================ */
  head('④-A ExamsCore.lockExam / unlockExam：写盘 + 重新读出');

  const store = makeStore();
  const created = await E.createExam(store, { title: '落盘锁定卷', now: '2026-09-18T03:00:00.000Z' });
  ok(created.ok, '创建工作：' + created.exam.id);
  const cl = await E.lockExam(store, created.exam.id, { globalCfg: G_LOCK, now: '2026-09-18T03:01:00.000Z' });
  ok(cl.ok, 'lockExam 成功', cl.error || '');
  eq(cl.exam.configLocked, true, '  卷上标记为已锁定');
  ok(cl.snapshotLeaves >= leaves.length,
     '  快照叶子数 = ' + cl.snapshotLeaves + ' ≥ 默认叶子数 ' + leaves.length + '（口径已统一：空对象算一个叶子）');
  eq(cl.snapshotLeaves, E.countLeaves(effectiveAtLock),
     '  快照叶子数 = 锁定那一刻生效配置的叶子数（不多不少）');
  eq(cl.exam.config.points['单选'], 5, '  快照固化了锁定那一刻的全局值 5');

  const reread = await E.getExam(store, created.exam.id);
  eq(reread.exam.configLocked, true, '**重新读出来仍是已锁定**（真写盘了）');
  eq(reread.exam.config.points['单选'], 5, '  快照值也读得回来');
  const listed = await E.listExams(store);
  eq(listed.exams[0].configLocked, true, '  卷册 meta 里也带 configLocked');

  const un = await E.unlockExam(store, created.exam.id, { now: '2026-09-18T03:02:00.000Z' });
  ok(un.ok, 'unlockExam 成功');
  eq(un.exam.config, null, '  卷上 config 已清空');
  eq(un.exam.configLocked, false, '  标记复位');
  eq(un.discarded && un.discarded.points['单选'], 5, '  被丢掉的旧快照回传给调用方留档（值=5）');
  const reread2 = await E.getExam(store, created.exam.id);
  eq(reread2.exam.config, null, '**重新读出来 config 是 null**（解锁真写盘了）');
  eq(reread2.exam.configLocked, false, '  标记也是 false');
  eq((await E.listExams(store)).exams[0].configLocked, false, '  卷册 meta 同步');
  eq((await E.scanOrphans(store)).orphans, [], '  无孤儿数据');

  head('④-B 落盘后的值语义：锁定卷不受全局变化影响，解锁后受影响');

  const cfgLockedFromStore = Q.resolveConfig(G_LATER, reread.exam);
  const freshLock = await E.lockExam(store, created.exam.id, { globalCfg: G_LOCK });
  eq(Q.resolveConfig(G_LATER, freshLock.exam).points['单选'], 5, '锁定后：改全局不影响（仍是 5）');
  await E.unlockExam(store, created.exam.id);
  const afterUn = await E.getExam(store, created.exam.id);
  eq(Q.resolveConfig(G_LATER, afterUn.exam).points['单选'], 99, '解锁后：跟全局变（99）');

  head('④-C 边界：重复锁定、未锁定就解锁、非法 config、深拷贝隔离');

  const store2 = makeStore();
  const c2 = await E.createExam(store2, { title: '边界卷', now: '2026-09-18T04:00:00.000Z' });
  const l1 = await E.lockExam(store2, c2.exam.id, { globalCfg: { points: { '单选': 5 } } });
  const l2 = await E.lockExam(store2, c2.exam.id, { globalCfg: { points: { '单选': 999 } } });
  eq(l2.exam.config.points['单选'], 5,
     '**重复锁定**：已有快照时再锁不会把新全局盖进来（快照=该卷的选择；要刷新先解锁再锁）');

  const u1 = await E.unlockExam(store2, c2.exam.id);
  const u2 = await E.unlockExam(store2, c2.exam.id);
  eq(u2.ok, true, '未锁定时再解锁不报错');
  eq(u2.discarded, null, '  没有被丢掉的快照（discarded=null）');
  eq(u2.exam.config, null, '  config 仍是 null');

  eq((await E.setConfig(store2, c2.exam.id, { config: [1, 2] })).ok, false, 'setConfig 拒绝数组当 config');
  eq((await E.setConfig(store2, c2.exam.id, { config: 5 })).ok, false, 'setConfig 拒绝标量当 config');
  eq((await E.setConfig(store2, c2.exam.id, { config: null })).ok, true, 'setConfig 接受 null');
  eq((await E.setConfig(store2, '不存在的卷', { config: {} })).ok, false, 'setConfig 对不存在的卷报错');

  const callerOwned = { points: { '单选': 42 } };
  await E.setConfig(store2, c2.exam.id, { config: callerOwned });
  callerOwned.points['单选'] = -1;                            // 调用方之后改自己那份
  const storedNow = (await E.getExam(store2, c2.exam.id)).exam;
  eq(storedNow.config.points['单选'], 42,
     '**setConfig 存的是深拷贝**：调用方之后改自己的对象，不影响已入库的试卷');

  /* ============================================================
   * ⑤ 相邻锚
   * ============================================================ */
  head('⑤ 相邻锚：schema 校验通过 + 快照能直接喂给计分与抽题');

  eq(S.validateExam(freshLock.exam).ok, true, '锁定后的卷仍通过 validateExam');
  eq(S.validateExam(un.exam).ok, true, '解锁后的卷（config=null）同样通过');
  const cfgForScore = Q.resolveConfig(G_LATER, freshLock.exam);
  eq(cfgForScore.points['单选'], 5, '锁定卷的快照能直接喂给 scoreOne/scoreExam');
  const picked = Q.pickQuestions(baseExam.questions, cfgForScore);
  eq(Array.isArray(picked.questions), true, '  同一份快照也能喂给 pickQuestions（抽题不受全局影响）');
  const pickedUnlocked = Q.pickQuestions(baseExam.questions, Q.resolveConfig(G_LATER, afterUn.exam));
  ok(picked.questions.length >= 0 && pickedUnlocked.questions.length >= 0,
     '  两种取值都能抽出题（抽题结果取决于各自配置）',
     '锁定: ' + picked.questions.length + ' 题 / 解锁: ' + pickedUnlocked.questions.length + ' 题');

  head('④-D 挑刺修正：矛盾态必须被拒；未锁定时解锁必须是无操作而非清空');

  // 挑刺1 实测过的隐患：setConfig({configLocked:true}) 不带 config → 卷标着"已锁定"却散着读全局
  const s3 = makeStore();
  const c3 = await E.createExam(s3, { title: '矛盾态', now: '2026-09-18T05:00:00.000Z' });
  const badLock = await E.setConfig(s3, c3.exam.id, { configLocked: true });
  eq(badLock.ok, false, '**拒绝"锁定但没有快照"的矛盾状态**（否则它会静默继续读全局）');
  ok(badLock.hint && badLock.hint.indexOf('lockExam') >= 0, '  提示指向正确用法', badLock.hint);
  eq((await E.getExam(s3, c3.exam.id)).exam.configLocked, false, '  卷仍未被改成锁定');
  const okLock = await E.setConfig(s3, c3.exam.id, { config: Q.resolveConfig(G_LOCK, null), configLocked: true });
  eq(okLock.ok, true, '  同时给出快照则允许锁定');
  eq(Q.resolveConfig(G_LATER, okLock.exam).points['单选'], 5, '    并且确实与全局脱钩');

  // 挑刺2 实测过的隐患：对"未锁定但有部分配置"的卷解锁 → 配置被悄悄清掉且不告知
  const s4 = makeStore();
  const c4 = await E.createExam(s4, { title: '部分配置卷', now: '2026-09-18T05:10:00.000Z' });
  await E.setConfig(s4, c4.exam.id, { config: { points: { '单选': 33 } }, configLocked: false });
  const u4 = await E.unlockExam(s4, c4.exam.id);
  eq(u4.ok, true, '对未锁定的卷调 unlockExam 不报错');
  eq(u4.changed, false, '  changed=false（本来就没锁定 → 无操作）');
  eq(u4.discarded, null, '  discarded=null（什么都没丢）');
  eq((await E.getExam(s4, c4.exam.id)).exam.config, { points: { '单选': 33 } },
     '**该卷的部分配置原样保留**（旧实现会把它清成 null 却报 discarded=null —— 静默破坏）');
  eq(Q.resolveConfig(G_LATER, u4.exam).points['单选'], 33, '  取值仍是它自己写的 33');

  // 对照：真正锁定的卷解锁时，changed=true 且回传被丢掉的快照
  const lockedForUnlock = await E.lockExam(s4, c4.exam.id, { globalCfg: G_LOCK, now: '2026-09-18T05:11:00.000Z' });
  ok(lockedForUnlock.ok, '先把它锁定');
  const u5 = await E.unlockExam(s4, c4.exam.id);
  eq(u5.changed, true, '真正锁定的卷解锁 → changed=true');
  eq(u5.discarded && u5.discarded.points['单选'], 33,
     '  回传被丢掉的快照：该卷**自己写的** 单选=33（单卷优先于全局的 5）');
  eq(u5.discarded && u5.discarded.points['多选'], 8,
     '  而它**没写的** 多选 = 锁定那一刻的全局值 8（一并固化，无空洞）');
  eq(u5.discarded && u5.discarded.multi.halfCredit, true, '  半对开关也固化了全局的 true');
  eq((await E.getExam(s4, c4.exam.id)).exam.config, null, '  配置被清空');
  eq(Q.resolveConfig(G_LATER, u5.exam).points['单选'], 99, '  此后跟随全局（99）');

  console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
  console.log('  PASS ' + pass + '    FAIL ' + fail);
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
