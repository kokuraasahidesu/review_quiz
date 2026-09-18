/* ============================================================
 *  verify/exams.test.js —— 「多卷维护与分组上传」小类验收
 *
 *  运行： node verify/exams.test.js
 *
 *  三条盘档验收标准，逐条对应：
 *    ① 新建/重命名/删除试卷均即时生效且持久；删除后关联题目与记录按策略处理，不留孤儿数据
 *    ② 多文件一次性导入时，各文件题目归入正确试卷与对应题型分组，分组计数与实际一致
 *    ③ 手动指定题型上传时，即使文件内无题型标记也归入指定题型分组
 *
 *  "持久"是怎么验的：所有命名空间共用同一对后端，每次改动后用
 *  **新建一个 store 实例**（模拟页面重开）再读一遍 —— 内存缓存骗不过这一步。
 * ============================================================ */
const E = require('../core/exams.js');
const D = require('../core/data.js');
const AttemptCore = require('../core/attempt.js');     // 进度键名只由它给（不许手拼 '::progress'）
const P = require('../parser-core.js');

let pass = 0, fail = 0; const failures = [];
function brief(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return String(s);
  return s.length > 150 ? s.slice(0, 150) + '…(' + s.length + ' 字符)' : s;
}
function ok(c, t, d) { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + brief(d) : '')))
                         : (fail++, failures.push(t), console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + brief(d) : ''))); }
function eq(a, e, t) { const A = JSON.stringify(a), E2 = JSON.stringify(e); ok(A === E2, t + '   期望=' + brief(E2), A); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }

/* ---------------- 共用后端 + "重开页面" ---------------- */
function world() {
  const sm = new Map(), lg = new Map();
  const small = {
    getItem: k => (sm.has(k) ? sm.get(k) : null),
    setItem: (k, v) => { sm.set(String(k), String(v)); },
    removeItem: k => { sm.delete(k); },
    key: i => { const a = Array.from(sm.keys()); return i < a.length ? a[i] : null; },
    get length() { return sm.size; }
  };
  const large = {
    get: async k => (lg.has(k) ? JSON.parse(lg.get(k)) : null),
    set: async (k, v) => { lg.set(String(k), JSON.stringify(v)); },
    del: async k => { lg.delete(k); },
    keys: async () => Array.from(lg.keys())
  };
  return {
    small: small, large: large,
    store: (threshold) => D.createStore({ small: small, large: large, namespace: D.NS_GLOBAL,
                                          threshold: (threshold != null) ? threshold : 1024 * 1024 }),
    /* 模拟"关掉页面再打开"：新 store 实例，同一对后端 */
    reopen: (threshold) => D.createStore({ small: small, large: large, namespace: D.NS_GLOBAL,
                                           threshold: (threshold != null) ? threshold : 1024 * 1024 }),
    rawKeys: () => Array.from(sm.keys()).concat(Array.from(lg.keys()))
  };
}

const TXT_SINGLE = [
  '【单选】HTTP 默认端口？', 'A. 21', 'B. 80', '答案：B',
  '【单选】DNS 端口？', 'A. 53', 'B. 80', '答案：A',
  '【判断】TCP 面向连接。（　）', '答案：对'
].join('\n');

const TXT_MULTI = ['【多选】传输层协议有？', 'A. TCP', 'B. UDP', 'C. ICMP', '答案：AB'].join('\n');

const TXT_NO_MARK = [
  '1. 以下哪个是传输层协议？', 'A. TCP', 'B. ICMP', '答案：A',
  '2. 以下哪个是应用层协议？', 'A. HTTP', 'B. ARP', '答案：A'
].join('\n');

const TXT_NO_MARK_JUDGE = [
  '1. 地球是圆的。（　）', '答案：对',
  '2. 太阳从西边升起。（　）', '答案：错'
].join('\n');

const TXT_NO_MARK_SHORT = [
  '1. 简述 TCP 三次握手。', '答案：客户端发送 SYN；服务器回复 SYN+ACK',
  '2. 简述 DNS 解析过程。', '答案：本地查询；递归查询'
].join('\n');

const TXT_WRONG_MARK = ['【判断】其实这是单选？', 'A. 甲', 'B. 乙', '答案：A'].join('\n');

(async function main() {

  /* ============================================================
   * ① 卷册增删改查：即时生效 + 持久
   * ============================================================ */
  head('①-A 新建：立刻可读，且"重开页面"后还在');

  const W = world();
  const s = W.store();
  const c1 = await E.createExam(s, { title: '甲卷', now: '2026-09-16T20:00:00.000Z' });
  ok(c1.ok, '新建试卷成功', c1.error || ('id=' + (c1.exam && c1.exam.id)));
  const idA = c1.exam.id;
  ok(!!idA && typeof idA === 'string', '  每卷有唯一 id', idA);
  eq(c1.exam.title, '甲卷', '  标题正确');
  eq(c1.meta.total, 0, '  新卷 0 题');
  eq(c1.meta.counts, { '单选': 0, '多选': 0, '判断': 0, '简答': 0, total: 0, invalid: 0 }, '  分组计数全 0');

  const g1 = await E.getExam(s, idA);
  eq(g1.ok && g1.exam.title, '甲卷', '查看：立刻读得到');
  const g1r = await E.getExam(W.reopen(), idA);
  eq(g1r.ok && g1r.exam.title, '甲卷', '**持久**：重开页面（新 store 实例）后仍在');
  eq(W.rawKeys().indexOf('app::' + D.examBodyKey(idA)) >= 0, true, '  底层有卷本体键');
  eq(W.rawKeys().indexOf('app::' + D.examSubKey(idA, 'meta')) >= 0, true, '  底层有轻量 meta 键');
  eq(W.rawKeys().indexOf('app::index') >= 0, true, '  底层有全局索引键');

  const c2 = await E.createExam(s, { title: '乙卷', now: '2026-09-16T20:01:00.000Z' });
  ok(c2.ok, '再建一份', 'id=' + c2.exam.id);
  ok(c2.exam.id !== idA, '  两份卷 id 不同（唯一性）');
  const idB = c2.exam.id;

  const ls = await E.listExams(s);
  eq(ls.total, 2, '列卷册：2 份');
  eq(ls.exams.map(x => x.title).sort(), ['甲卷', '乙卷'].sort(), '  标题都在');
  eq(ls.healed, false, '  走的是 meta 快路径（没触发自愈）');

  head('①-B 重命名：立刻生效 + 持久（含 meta 同步）');

  const rn = await E.renameExam(s, idA, '甲卷（改名后）', { now: '2026-09-16T20:05:00.000Z' });
  eq(rn.ok, true, '重命名成功');
  eq(rn.changed, true, '  changed=true');
  eq((await E.getExam(s, idA)).exam.title, '甲卷（改名后）', '查看：标题已变');
  eq((await E.getExam(W.reopen(), idA)).exam.title, '甲卷（改名后）', '**持久**：重开后仍是新标题');
  const ls2 = await E.listExams(W.reopen());
  eq(ls2.exams.filter(x => x.id === idA)[0].title, '甲卷（改名后）',
     '列卷册（走 meta 快路径）看到的也是新标题 —— 两处都改了，没有不同步');
  eq(ls2.exams.filter(x => x.id === idB)[0].title, '乙卷', '  另一卷不受影响');

  const rn2 = await E.renameExam(s, idA, '甲卷（改名后）');
  eq(rn2.changed, false, '改成同一个标题 → changed=false（不做无谓写盘）');
  eq((await E.renameExam(s, idA, '   ')).ok, false, '空标题被拒绝');
  eq((await E.renameExam(s, '不存在的卷', 'x')).ok, false, '给不存在的卷改名被拒绝');

  head('①-C 加题后分组计数即时更新且持久');

  const ap = await E.appendQuestions(s, idA, P.parseText(TXT_SINGLE).questions, { now: '2026-09-16T20:10:00.000Z' });
  ok(ap.ok, '追加 3 题（2 单选 + 1 判断）', ap.error || '');
  eq(ap.added, 3, '  added=3');
  eq(ap.meta.counts, { '单选': 2, '多选': 0, '判断': 1, '简答': 0, total: 3, invalid: 0 }, '  分组计数正确');
  eq(ap.before.total, 0, '  before.total=0');
  eq(ap.after.total, 3, '  after.total=3');
  const ls3 = await E.listExams(W.reopen());
  eq(ls3.exams.filter(x => x.id === idA)[0].counts.total, 3, '**持久**：重开后 meta 里仍是 3 题');
  eq(ls3.exams.filter(x => x.id === idA)[0].counts['单选'], 2, '  单选题数持久');

  head('①-D 删除：按策略处理记录，且不留孤儿数据');

  // 先造出"关联记录"（作答记录 / 错题）
  await s.set(D.recordKey(idA), [{ score: 88, at: '2026-09-16' }]);
  await s.set(D.wrongKey(idA), { q1: { times: 2 } });
  await s.set(D.recordKey(idB), [{ score: 60 }]);
  const scanBefore = await E.scanOrphans(s);
  eq(scanBefore.orphans, [], '删除前：没有孤儿数据（记录都指向活着的卷）');

  const del = await E.deleteExam(s, idA, { policy: 'cascade' });
  eq(del.ok, true, '删除甲卷成功');
  eq(del.policy, 'cascade', '  策略 = cascade（连记录一起删）');
  eq(del.orphansKept, [], '  没有"特意保留"的东西');
  ok(del.deleted.length >= 3, '  删掉了卷本体 + meta 等多把键', del.deleted.length + ' 把：' + del.deleted.join(' '));
  eq(await E.getExam(s, idA), { ok: false, error: '找不到这份试卷：' + idA }, '查看：甲卷已不存在');
  eq(await s.get(D.recordKey(idA)), null, '  甲卷的作答记录也删了');
  eq(await s.get(D.wrongKey(idA)), null, '  甲卷的错题也删了');

  const rawAfter = W.rawKeys();
  eq(rawAfter.indexOf('app::' + D.examBodyKey(idA)), -1, '底层已无甲卷本体');
  eq(rawAfter.indexOf('app::' + D.examSubKey(idA, 'meta')), -1, '底层已无甲卷 meta');
  eq(rawAfter.indexOf('app::' + D.recordKey(idA)), -1, '底层已无甲卷记录');
  eq(rawAfter.indexOf('app::' + D.wrongKey(idA)), -1, '底层已无甲卷错题');
  eq(rawAfter.indexOf('app::' + D.examBodyKey(idB)) >= 0, true, '  乙卷本体还在');
  eq(rawAfter.indexOf('app::' + D.recordKey(idB)) >= 0, true, '  乙卷记录还在');

  const ls4 = await E.listExams(W.reopen());
  eq(ls4.exams.map(x => x.id), [idB], '**持久**：重开后卷册里只剩乙卷');
  const scanAfter = await E.scanOrphans(W.reopen());
  eq(scanAfter.orphans, [], '**不留孤儿数据**：删完后全库无悬空记录');
  eq(scanAfter.missingBodies, [], '  索引里也没有指向空卷的悬空条目');

  head('①-E 删除策略的另一条：keepRecords（保留记录，但必须如实列出）');

  const W2 = world();
  const s2 = W2.store();
  const cA = await E.createExam(s2, { title: '要留记录的卷' });
  await E.appendQuestions(s2, cA.exam.id, P.parseText(TXT_SINGLE).questions);
  await s2.set(D.recordKey(cA.exam.id), [{ score: 70 }]);
  await s2.set(D.wrongKey(cA.exam.id), { q9: { times: 1 } });
  const del2 = await E.deleteExam(s2, cA.exam.id, { keepRecords: true });
  eq(del2.policy, 'keepRecords', '策略 = keepRecords（旧写法兼容）');
  eq(del2.orphansKept.slice().sort(), [D.recordKey(cA.exam.id), D.wrongKey(cA.exam.id)].sort(),
     '  如实列出保留了什么（不是悄悄留下）');
  eq(await s2.get(D.examBodyKey(cA.exam.id)), null, '  卷本体照样删掉');
  /* ⚠ 这条断言在「删卷级联询问」小类里被**改严**了：
   *   以前残留记录一律算 orphan；现在保留路径会写墓碑（index.deleted），
   *   于是它们变成"有主"的 identified（带「已删除试卷（原《…》）」归属标识），
   *   `orphans` 必须为 0 —— 否则那条验收（两种路径都不留孤儿可查询数据）就过不了。 */
  const scan2 = await E.scanOrphans(s2);
  eq(scan2.orphans, [], '  巡检：**零孤儿**（残留记录都在墓碑覆盖下）');
  eq(scan2.identified.map(o => o.kind).sort(), ['record', 'wrong'], '  但如实报出 2 条"指向已删卷"的数据');
  eq(scan2.identified.map(o => o.examId), [cA.exam.id, cA.exam.id], '  指向的卷 id 也对');
  eq(scan2.identified.map(o => o.label)[0], '已删除试卷（原《要留记录的卷》）', '  并带可读归属标识');
  eq((await E.ownerOf(s2, cA.exam.id)).kind, 'deleted', '  归属查询：deleted（不是"查无此卷"）');

  /* ============================================================
   * ② 多文件批量导入：归入正确试卷 + 题型分组 + 计数一致
   * ============================================================ */
  head('②-A 三个文件一次导入同一卷');

  const W3 = world();
  const s3 = W3.store();
  const target = await E.createExam(s3, { title: '目标卷' });
  const other = await E.createExam(s3, { title: '无关卷' });
  await E.appendQuestions(s3, other.exam.id, P.parseText(TXT_SINGLE).questions);

  const imp = await E.importFiles(s3, target.exam.id, [
    { name: 'a.txt', kind: 'txt', data: TXT_SINGLE },              // 3 题：2 单选 + 1 判断
    { name: 'b.txt', kind: 'txt', data: TXT_MULTI },               // 1 题：1 多选
    { name: 'c.txt', kind: 'txt', data: TXT_NO_MARK_SHORT }        // 2 题，无标记 → 不指定题型则解析不出
  ], { now: '2026-09-16T21:00:00.000Z' });

  ok(imp.ok, '批量导入成功', imp.error || '');
  eq(imp.files.length, 3, '3 个文件都有结果');
  eq(imp.files.map(f => f.name), ['a.txt', 'b.txt', 'c.txt'], '  文件名按顺序回报');
  eq(imp.files[0].counts, { '单选': 2, '多选': 0, '判断': 1, '简答': 0, total: 3, invalid: 0 }, 'a.txt 归入 2 单选 + 1 判断');
  eq(imp.files[1].counts, { '单选': 0, '多选': 1, '判断': 0, '简答': 0, total: 1, invalid: 0 }, 'b.txt 归入 1 多选');
  eq(imp.files[2].total, 0, 'c.txt 无标记 → 0 题（不指定题型时这就是现状）');

  eq(imp.added, 4, '实际入库 4 题');
  eq(imp.meta.counts, { '单选': 2, '多选': 1, '判断': 1, '简答': 0, total: 4, invalid: 0 }, '分组计数 = 2 单选 / 1 多选 / 1 判断');
  eq(imp.groups, imp.meta.counts, '  返回值里的 groups 与 meta.counts 一致');
  eq(imp.files.reduce((n, f) => n + f.total, 0), imp.added, '各文件题数之和 = 入库题数（没有丢题）');

  const exT = await E.getExam(W3.reopen(), target.exam.id);
  eq(exT.ok, true, '**持久**：重开后目标卷在');
  eq(E.groupCounts(exT.exam.questions), imp.meta.counts, '  重开后实际题目的分组计数与回报一致');
  const exO = await E.getExam(W3.reopen(), other.exam.id);
  eq(E.groupCounts(exO.exam.questions).total, 3, '**题目归入了正确试卷**：无关卷仍是它原来的 3 题');

  head('②-B 分组视图：数量与实际题目对得上');

  const gv = E.groupQuestions(exT.exam.questions);
  eq(Object.keys(gv), ['单选', '多选', '判断', '简答'], '四类分组都在（哪怕某类为空）');
  eq(gv['单选'].length, 2, '单选分组 2 题');
  eq(gv['多选'].length, 1, '多选分组 1 题');
  eq(gv['判断'].length, 1, '判断分组 1 题');
  eq(gv['简答'].length, 0, '简答分组 0 题');
  const sumG = ['单选', '多选', '判断', '简答'].reduce((n, t) => n + gv[t].length, 0);
  eq(sumG, exT.exam.questions.length, '四组之和 = 卷内总题数（不重不漏）');
  eq(gv['单选'].map(x => x.question.stem).sort(), ['HTTP 默认端口？', 'DNS 端口？'].sort(), '  分组内容正确');
  ok(gv['单选'].every(x => x.question.type === '单选'), '  分组里每道题的题型确实是该组题型');
  eq(gv['多选'][0].question.answerLetters, ['A', 'B'], '  多选题的答案字母正确');

  head('②-C 一个文件坏掉不该拖垮整批');

  const oldDoc = require('fs').readFileSync(require('path').join(__dirname, '..', 'fixtures', 'old_format.doc'));
  const oldAb = oldDoc.buffer.slice(oldDoc.byteOffset, oldDoc.byteOffset + oldDoc.byteLength);
  const imp2 = await E.importFiles(s3, target.exam.id, [
    { name: 'good.txt', kind: 'txt', data: TXT_MULTI },
    { name: '坏文件.doc', kind: 'docx', data: oldAb },
    { name: '也good.txt', kind: 'txt', data: TXT_SINGLE }
  ], { now: '2026-09-16T21:10:00.000Z' });
  ok(imp2.ok, '批里有坏文件，整批仍然成功');
  eq(imp2.failed.length, 1, '  失败清单 1 条');
  eq(imp2.failed[0].name, '坏文件.doc', '  指名是哪个文件');
  eq(imp2.failed[0].code, 'E_OLD_DOC', '  带上错误码');
  ok(imp2.failed[0].error.indexOf('另存为') >= 0, '  错误信息含"另存为"提示', imp2.failed[0].error);
  eq(imp2.added, 4, '另外两个文件照常导入（1 多选 + 3）');
  eq(imp2.meta.counts.total, 8, '总数变为 4 + 4 = 8');

  head('②-D 结构不合法的题：默认整批拒绝，skipInvalid 才只导合法的');

  const W4 = world();
  const s4 = W4.store();
  const t4 = await E.createExam(s4, { title: '含坏题的卷' });
  // 一道没有选项的"单选"：结构校验会判不合法
  const badOne = [{ type: '单选', stem: '没有选项的单选题？', answer: 'A', options: [], keywords: [] }];
  const rej = await E.appendQuestions(s4, t4.exam.id, badOne);
  eq(rej.ok, false, '默认：有一道不合法就整批拒绝');
  eq(rej.blocking.length, 1, '  blocking 指名 1 道');
  ok(rej.blocking[0].errors.some(x => x.indexOf('选项少于 2 个') >= 0), '  指出原因', brief(rej.blocking[0].errors));
  eq((await E.getExam(s4, t4.exam.id)).exam.questions.length, 0, '  没有写入半个卷子');
  const skip = await E.appendQuestions(s4, t4.exam.id, badOne.concat(P.parseText(TXT_MULTI).questions), { skipInvalid: true });
  ok(skip.ok, 'skipInvalid=true → 成功');
  eq(skip.added, 1, '  只写入合法的那 1 道');
  eq(skip.skipped.length, 1, '  被剔除的也报出来');

  /* ============================================================
   * ③ 手动指定题型：文件内无标记也能归入指定分组
   * ============================================================ */
  head('③-A 无标记文件：不指定题型解析不出题，指定后就有了');

  eq(P.parseText(TXT_NO_MARK).stats.total, 0, '无标记文件 → 默认解析出 0 题（现状，也是本小类要解决的缺口）');
  const asSingle = P.parseTextAs(TXT_NO_MARK, { type: '单选' });
  eq(asSingle.stats.total, 2, '指定 type=单选 → 2 题');
  eq(asSingle.stats.byType, { '单选': 2 }, '  全部归入单选');
  eq(asSingle.questions[0].stem, '以下哪个是传输层协议？', '  题号被剥掉，题干干净');
  eq(asSingle.questions[0].options.map(o => o.label + ':' + o.text), ['A:TCP', 'B:ICMP'], '  选项抽出来了');
  eq(asSingle.questions[0].answerLetters, ['A'], '  答案字母正确');
  eq(asSingle.questions[1].answerLetters, ['A'], '  第二题也对');
  eq(asSingle.meta.defaultType, '单选', '  meta 里记下了"这是手动指定题型切出来的"');

  eq(P.parseTextAs(TXT_NO_MARK_JUDGE, { type: '判断' }).questions.map(q => q.judgeValue), [true, false],
     '无标记判断题：指定 type=判断 → 判分值 true/false 都算出来了');
  eq(P.parseTextAs(TXT_NO_MARK_SHORT, { type: '简答' }).questions.map(q => q.keywords.length), [2, 2],
     '无标记简答题：指定 type=简答 → 兜底关键词也生成了');

  head('③-B 批量导入时逐文件指定题型');

  const W5 = world();
  const s5 = W5.store();
  const t5 = await E.createExam(s5, { title: '混合题型导入' });
  const imp3 = await E.importFiles(s5, t5.exam.id, [
    { name: '无标记-单选.txt', kind: 'txt', data: TXT_NO_MARK },                 // 逐文件指定：单选
    { name: '无标记-判断.txt', kind: 'txt', data: TXT_NO_MARK_JUDGE, type: '判断' },
    { name: '无标记-简答.txt', kind: 'txt', data: TXT_NO_MARK_SHORT, type: '简答' }
  ], { now: '2026-09-16T22:00:00.000Z' });
  ok(imp3.ok, '三个"无标记"文件一次导入成功', imp3.error || '');
  eq(imp3.files.map(f => f.forced), [null, '判断', '简答'], '  各文件的强制题型如实回报');
  eq(imp3.files[0].total, 0, '第一个没指定题型 → 0 题（无标记就是解析不出）');
  eq(imp3.added, 4, '实际入库 2 判断 + 2 简答 = 4 题');
  eq(imp3.meta.counts, { '单选': 0, '多选': 0, '判断': 2, '简答': 2, total: 4, invalid: 0 },
     '**归入指定题型分组**：判断 2 / 简答 2');
  const t5ex = await E.getExam(W5.reopen(), t5.exam.id);
  eq(E.groupQuestions(t5ex.exam.questions)['判断'].length, 2, '重开后：判断分组 2 题');
  eq(E.groupQuestions(t5ex.exam.questions)['简答'].length, 2, '重开后：简答分组 2 题');

  head('③-C 整批统一指定题型（opts.type 作为默认）');

  const imp4 = await E.importFiles(s5, t5.exam.id, [
    { name: 'x.txt', kind: 'txt', data: TXT_NO_MARK },
    { name: 'y.txt', kind: 'txt', data: TXT_NO_MARK }
  ], { type: '多选', now: '2026-09-16T22:10:00.000Z' });
  ok(imp4.ok, '整批按"多选"导入成功');
  eq(imp4.files.map(f => f.forced), ['多选', '多选'], '  两个文件都按多选处理');
  eq(imp4.added, 4, '  共 4 题');
  eq(imp4.meta.counts['多选'], 4, '  多选分组变成 4 题');
  eq(imp4.meta.counts['判断'], 2, '  原来的判断分组不受影响');

  head('③-D 文件里标记**写错**时，强制题型能纠正');

  const wrong = P.parseText(TXT_WRONG_MARK);
  eq(wrong.stats.byType, { '判断': 1 }, '这份文件自己标的是【判断】');
  eq(wrong.questions[0].options.length, 0,
     '按标记切（判断题）：A/B 行没被当成选项，而是并进了题干 —— 这正是"标记写错"的代价');
  ok(wrong.questions[0].stem.indexOf('A. 甲') >= 0, '  能看出选项文字其实在题干里', brief(wrong.questions[0].stem));

  // force=true：整份文件按指定题型切，文件内部的标记不再作数（但会被剥掉）
  const asForced = P.parseTextAs(TXT_WRONG_MARK, { type: '单选', force: true });
  eq(asForced.stats.byType, { '单选': 1 }, 'force 之后题型 = 单选');
  eq(asForced.questions[0].stem, '其实这是单选？', '  原来的【判断】标记被剥掉，题干干净');
  eq(asForced.questions[0].options.map(o => o.label + ':' + o.text), ['A:甲', 'B:乙'],
     '  A/B 行这回**正确识别为选项**（不 force 的话它们会烂在题干里，救不回来）');
  eq(asForced.questions[0].answerLetters, ['A'], '  派生字段重算：答案字母 = [A]');
  eq(asForced.questions[0].judgeValue, null, '  不再是判断题：judgeValue 归 null');

  // 不 force（只给 defaultType）时，文件里的显式标记仍然优先
  const noForce = P.parseTextAs(TXT_WRONG_MARK, { type: '单选' });
  eq(noForce.stats.byType, { '判断': 1 }, '不 force 时显式标记优先（默认语义没被改动）');

  const imp5 = await E.importFiles(s5, t5.exam.id, [{ name: '标错的文件.txt', kind: 'txt', data: TXT_WRONG_MARK }],
                                   { type: '单选' });
  ok(imp5.ok, '导入成功（标记写错的也能纠正）', imp5.error || (imp5.blocking ? brief(imp5.blocking) : ''));
  eq(imp5.added, 1, '  入库 1 题');
  eq(imp5.meta.counts['单选'], 1, '  归入单选分组');
  eq(imp5.meta.counts['判断'], 2, '  没有污染判断分组');
  const imp5ex = await E.getExam(W5.reopen(), t5.exam.id);
  const oneSingle = E.groupQuestions(imp5ex.exam.questions)['单选'][0].question;
  eq(oneSingle.options.map(o => o.label + ':' + o.text), ['A:甲', 'B:乙'], '  重开后确认：这道题的选项真的存下来了');

  /* ============================================================
   * ④ 相邻锚：与「校对入库面板」的衔接
   * ============================================================ */
  head('④ 相邻锚：review.commit 入库的卷，卷册这边必须认得出来');

  const Review = require('../core/review.js');
  const W6 = world();
  const s6 = W6.store();
  const draft = Review.createDraft(P.parseText(TXT_SINGLE), { now: '2026-09-16T23:00:00.000Z', title: '从面板来的卷' }).draft;
  const committed = await Review.commit(draft, s6, { now: '2026-09-16T23:00:00.000Z', title: '从面板来的卷' });
  ok(committed.ok, 'review.commit 入库成功', committed.error || '');

  const ls6 = await E.listExams(s6);
  eq(ls6.total, 1, '卷册里能看到它');
  eq(ls6.exams[0].id, committed.examId, '  id 一致');
  eq(ls6.exams[0].title, '从面板来的卷', '  标题一致');
  eq(ls6.exams[0].counts, { '单选': 2, '多选': 0, '判断': 1, '简答': 0, total: 3, invalid: 0 },
     '  分组计数对得上');
  eq(ls6.healed, true,
     '  注意：review 只写了卷本体 + 索引，没写轻量 meta —— 卷册这边**自愈**补齐（healed=true）');

  const ap6 = await E.appendQuestions(s6, committed.examId, P.parseText(TXT_MULTI).questions);
  ok(ap6.ok, '用卷册这边往同一卷追加题目也成功');
  eq(ap6.meta.counts.total, 4, '  总数 3 → 4');
  eq((await E.listExams(W6.reopen())).exams[0].counts.total, 4, '**持久**：重开后 4 题');

  const del6 = await E.deleteExam(s6, committed.examId, { policy: 'cascade' });
  eq(del6.ok, true, '卷册这边能删掉面板入库的卷');
  eq((await E.listExams(W6.reopen())).total, 0, '  卷册清空');
  eq((await E.scanOrphans(W6.reopen())).orphans, [], '  无孤儿数据');

  /* ============================================================
   * ⑤ 挑刺：边界与"绕过卷册模块直接写"的情况
   * ============================================================ */
  head('⑤-A 显式指定 id 撞车 → 明确报错，不静默换 id');

  const W7 = world();
  const s7 = W7.store();
  const first = await E.createExam(s7, { id: 'EXAM_FIXED', title: '指定 id 的卷' });
  ok(first.ok && first.exam.id === 'EXAM_FIXED', '按指定的 id 建卷成功');
  const dup = await E.createExam(s7, { id: 'EXAM_FIXED', title: '重复 id 的卷' });
  eq(dup.ok, false, '同 id 再建 → 明确失败（不是悄悄换一个 id）');
  ok(dup.error.indexOf('EXAM_FIXED') >= 0, '  错误信息里带上冲突的 id', dup.error);
  eq((await E.listExams(s7)).total, 1, '  卷册里仍只有一份');
  const auto = await E.createExam(s7, { title: '自动 id 的卷' });
  ok(auto.ok && auto.exam.id !== 'EXAM_FIXED', '不指定 id 时自动生成且不撞车');

  head('⑤-B meta 是缓存：别的模块直接写卷本体后，要有修复路径');

  const W8 = world();
  const s8 = W8.store();
  const t8 = await E.createExam(s8, { title: '被外部改过的卷' });
  // 模拟"绕开卷册模块、直接写卷本体"（review.commit 就是这种写法）
  const body = (await E.getExam(s8, t8.exam.id)).exam;
  body.questions = P.parseText(TXT_SINGLE).questions;
  body.updatedAt = '2026-09-16T23:59:00.000Z';
  await s8.set(D.examBodyKey(t8.exam.id), body);

  const cached = await E.listExams(s8);
  eq(cached.exams[0].counts.total, 0,
     '默认走 meta 缓存 → 仍显示 0 题（缓存是旧的，这是"只读轻量 meta"的代价）');
  const freshList = await E.listExams(s8, { fresh: true });
  eq(freshList.exams[0].counts.total, 3, '{fresh:true} → 直接从卷本体重算，得到 3 题');
  eq(freshList.healed, true, '  并如实报 healed=true');
  const rm = await E.refreshMeta(s8, t8.exam.id);
  eq(rm.ok, true, 'refreshMeta 可用（给外部写入方收尾）');
  eq(rm.meta.counts.total, 3, '  重算后的 meta 是 3 题');
  const cached2 = await E.listExams(W8.reopen());
  eq(cached2.exams[0].counts.total, 3, '  修好之后默认路径就是对的了');
  eq(cached2.healed, false, '  走的仍是快路径');

  head('⑤-C 追加两次，题目 id 不重复');

  const W9 = world();
  const s9 = W9.store();
  const t9 = await E.createExam(s9, { title: 'id 唯一性' });
  await E.appendQuestions(s9, t9.exam.id, P.parseText(TXT_SINGLE).questions);
  await E.appendQuestions(s9, t9.exam.id, P.parseText(TXT_SINGLE).questions);   // 同一份再来一遍
  const ex9 = (await E.getExam(s9, t9.exam.id)).exam;
  eq(ex9.questions.length, 6, '同一份文件导入两次 → 6 题（内容重复是用户的事，id 不能重复）');
  eq(new Set(ex9.questions.map(q => q.id)).size, 6, '6 个题目 id 互不相同');
  eq(new Set(ex9.questions.map(q => q.stem)).size, 3, '  题干只有 3 种（确实是重复导入）');

  head('⑤-D 分组函数对非法题型不瞎归类');

  const mixed = [{ type: '单选', stem: 'a' }, { type: '填空', stem: 'b' }, { type: '多选', stem: 'c' }];
  const mc = E.groupCounts(mixed);
  eq(mc.total, 3, '总数仍算 3');
  eq(mc.invalid, 1, '  非法题型单独计数（不塞进任何一类）');
  eq([mc['单选'], mc['多选'], mc['判断'], mc['简答']], [1, 1, 0, 0], '  三类计数正确');
  const mg = E.groupQuestions(mixed);
  const allInGroups = ['单选', '多选', '判断', '简答'].reduce((n, t) => n + mg[t].length, 0);
  eq(allInGroups, 2, '分组视图里只有 2 道（非法题型不进任何组）');
  eq(mg['单选'][0].index, 0, '  分组里带的是**卷内下标**，不是组内下标');
  eq(mg['多选'][0].index, 2, '  第二组的也是卷内下标');

  head('⑤-E 空批与全失败批');

  const W10 = world();
  const s10 = W10.store();
  const t10 = await E.createExam(s10, { title: '空批' });
  eq((await E.importFiles(s10, t10.exam.id, [])).ok, false, '空文件列表 → 明确失败');
  eq((await E.importFiles(s10, t10.exam.id, null)).ok, false, 'files=null 也不炸');
  const oldDoc2 = require('fs').readFileSync(require('path').join(__dirname, '..', 'fixtures', 'old_format.doc'));
  const oldAb2 = oldDoc2.buffer.slice(oldDoc2.byteOffset, oldDoc2.byteOffset + oldDoc2.byteLength);
  const allBad = await E.importFiles(s10, t10.exam.id, [{ name: 'x.doc', kind: 'docx', data: oldAb2 }]);
  eq(allBad.ok, false, '全批都失败 → 明确失败');
  eq(allBad.failed.length, 1, '  失败清单里说清了是哪个文件');
  eq((await E.getExam(s10, t10.exam.id)).exam.questions.length, 0, '  卷子没被写脏');
  const toMissing = await E.importFiles(s10, '不存在的卷', [{ name: 'a.txt', kind: 'txt', data: TXT_SINGLE }]);
  eq(toMissing.ok, false, '给不存在的卷导文件 → 明确失败');
  ok(toMissing.error.indexOf('不存在的卷') >= 0, '  错误信息里带上那个 id', toMissing.error);

  /* ============================================================
   * 【新】清除答题记录（用户要求：首页新增）
   *  只清"作答产生的东西"：进度（含每一轮）、成绩记录、可选错题本；
   *  **卷本体 + meta + 设置 + 卷册索引一条都不许动**（这是这个功能的死线）。
   * ============================================================ */
  head('⑱ 清除答题记录：清记录、绝不碰题库');

  const WW = world();
  const st = WW.store();
  const ex1 = (await E.createExam(st, { id: 'E1', title: '卷一' })).exam;
  const ex10 = (await E.createExam(st, { id: 'E10', title: '卷十（id 是 E1 的前缀兄弟）' })).exam;
  const exOrphan = 'orphan.docx';                     // 从没入册的卷（拖入的 docx / 分享文件）
  await E.writeGlobalConfig(st, { grade: { pass: 66 } });

  /* 进度：E1 两份（整卷 + 抽一轮）、E10 一份、孤儿卷一份；成绩记录两份；错题本两本 */
  const mkProgress = function (examId, tag, answers) {
    return st.set(AttemptCore.progressKey(examId, tag), {
      v: 1, examId: examId, title: examId, index: 0, answers: answers, checked: {}, manual: {}, auto: {},
      config: null, questionIds: Object.keys(answers), updatedAt: new Date().toISOString()
    });
  };
  await mkProgress('E1', '', { 'E1-q1': 'A' });
  await mkProgress('E1', 'p1a2b-2', { 'E1-q1': 'A', 'E1-q2': 'B' });
  await mkProgress('E10', '', { 'E10-q1': 'C' });
  await mkProgress(exOrphan, '', { 'o-1': 'D' });
  await st.set(D.recordKey('E1'), [{ score: 3, at: 'T1' }]);
  await st.set(D.recordKey(exOrphan), [{ score: 9, at: 'T2' }, { score: 8, at: 'T3' }]);
  await st.set(D.wrongKey('E1'), { examId: 'E1', entries: { 'E1-q1': { qid: 'E1-q1', times: 1, rightTimes: 0 } } });
  await st.set(D.wrongKey(exOrphan), { examId: exOrphan, entries: { 'o-1': { qid: 'o-1', times: 2, rightTimes: 0 } } });

  const pv = await E.attemptRecordPreview(st);
  eq([pv.ok, pv.progress.rounds, pv.progress.exams.slice().sort()],
     [true, 4, ['E1', 'E10', 'orphan.docx']],
     '清除前先读数：4 份进度（含"同卷两轮"与"从没入册的卷"），卷 id 去重后 3 套');
  eq([pv.progress.answered, pv.records.entries, pv.wrong.books, pv.wrong.entries], [5, 3, 2, 2],
     '  读数里还有"答过 5 题 / 成绩 3 条 / 错题本 2 套 2 条"（弹窗据此摆真实数字）');

  /* 只清进度与成绩（错题本留着） */
  const clr1 = await E.clearAttemptRecords(st);
  eq([clr1.ok, clr1.leftover, clr1.cleared.progress, clr1.cleared.records, clr1.cleared.wrong],
     [true, 0, 4, 2, 0], '只清进度/成绩：4 份进度 + 2 份成绩清掉，错题本按默认**留着**');
  const after1 = await E.attemptRecordPreview(st);
  eq([after1.progress.rounds, after1.records.keys.length, after1.wrong.books], [0, 0, 2],
     '  清完再读一遍：进度 0 份、成绩 0 条、错题本仍是 2 套');
  /* ⚠ 光看读数不够：直接去存储里确认错题本**真的还在**（读数与存储两处都要对上） */
  const keptBook = await st.get(D.wrongKey('E1'));
  eq([!!keptBook, keptBook && Object.keys(keptBook.entries || {}).length], [true, 1],
     '  存储里那本错题本也还在（不是"读数说留着、其实删了"）');
  /* 死线：题库必须原封不动 */
  eq([(await E.getExam(st, 'E1')).ok, (await E.getExam(st, 'E10')).ok], [true, true],
     '**卷本体一条都没动**（E1 / E10 都还读得出来）');
  eq((await E.getExam(st, 'E1')).exam.questions.length, ex1.questions.length, '  题数照旧（不是被清成空卷）');
  eq((await E.getExam(st, 'E10')).exam.questions.length, ex10.questions.length,
     '  前缀兄弟 E10 也完好（只按精确键删，不做前缀匹配）');
  eq((await E.readGlobalConfig(st)).config.grade.pass, 66, '  本机全局设置没被动过');
  eq((await E.listExams(st)).exams.length, 2, '  卷册索引也没少');

  /* 连错题本一起清 */
  const clr2 = await E.clearAttemptRecords(st, { includeWrong: true });
  eq([clr2.ok, clr2.cleared.wrong, clr2.cleared.wrongEntries], [true, 2, 2],
     '带上 includeWrong：错题本 2 套（2 条）也清掉');
  eq((await E.attemptRecordPreview(st)).wrong.books, 0, '  清完错题本为 0');
  eq([(await E.getExam(st, 'E1')).ok, (await E.listExams(st)).exams.length], [true, 2],
     '  题库依然完好（错题本清了，卷还在）');

  /* 幂等 + 空库 */
  const clr3 = await E.clearAttemptRecords(st, { includeWrong: true });
  eq([clr3.ok, clr3.nothing], [true, true], '再清一次：没有记录可清 → nothing:true（不报错、不谎报清了东西）');
  const W0 = world();
  const pv0 = await E.attemptRecordPreview(W0.store());
  eq([pv0.ok, pv0.total, pv0.progress.answered], [true, 0, 0], '空库：读数为 0（不炸）');
  eq((await E.clearAttemptRecords(W0.store())).nothing, true, '  空库上清 → nothing:true');
  eq((await E.clearAttemptRecords(null)).ok, false, '没有存储 → 明确失败（不假装清成功）');

  /* ⚠ 反向对照：**只清记录**不等于"顺手清掉别的命名空间" —— 接收者空间的数据不许被动 */
  const Wr = world();
  const stG = D.createStore({ small: Wr.small, large: Wr.large, namespace: D.NS_GLOBAL });
  const stR = D.createStore({ small: Wr.small, large: Wr.large, namespace: 'recv_E1.abcd1234' });
  await stG.set(D.wrongKey('E1'), { examId: 'E1', entries: { 'E1-q1': { qid: 'E1-q1', times: 1 } } });
  await stR.set(AttemptCore.progressKey('E1', ''), { v: 1, examId: 'E1', answers: { 'E1-q1': 'A' } });
  const clrG = await E.clearAttemptRecords(stG, { includeWrong: true });
  eq([clrG.ok, clrG.cleared.wrong], [true, 1], '本机空间里的错题被清掉');
  const stillThere = await stR.get(AttemptCore.progressKey('E1', ''));
  eq(!!stillThere, true, '**接收者空间（分享文件那套）里的进度一点没动** —— 清记录只在本命名空间内生效');

  console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
  console.log('  PASS ' + pass + '    FAIL ' + fail);
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
