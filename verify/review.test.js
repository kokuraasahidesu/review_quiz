/* ============================================================
 *  verify/review.test.js —— 「校对入库面板」小类验收（纯逻辑层）
 *
 *  运行： node verify/review.test.js
 *
 *  三条盘档验收标准，逐条对应：
 *    ① 可修改任意题的题型/题干/答案/解析并增删关键词，
 *       修改结果在确认入库后能从导出的 JSON 中看到
 *    ② 待校对项有显式标记且可一键筛选；筛选后只显示待校对题
 *    ③ 取消确认时题库与存储不发生任何变化（前后快照对比）
 *
 *  DOM 层（ui/review-panel.js）另由 浏览器自检.html 的 G 节在真浏览器里验：
 *  触屏目标尺寸与"筛选后界面上只剩待校对行"只有浏览器能给。
 *
 *  写法约定：**不写死题目下标**，一律按题干定位 ——
 *  样卷增删一题就全体错位的测试不值得维护。
 * ============================================================ */
const P = require('../parser-core.js');
const R = require('../core/review.js');
const Store = require('../core/data.js');
const Schema = require('../core/schema.js');

let pass = 0, fail = 0; const failures = [];
// 长值截断**只影响显示**：比较用的是未截断的完整 JSON（eq 里先比较再显示），不会造成假 PASS
function brief(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return String(s);
  return s.length > 160 ? s.slice(0, 160) + '…(' + s.length + ' 字符)' : s;
}
function ok(c, t, d) { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + brief(d) : '')))
                         : (fail++, failures.push(t), console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + brief(d) : ''))); }
function eq(a, e, t) { const A = JSON.stringify(a), E = JSON.stringify(e); ok(A === E, t + '   期望=' + brief(E), A); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }

/* ---------------- 内存版 localStorage（Node 里没有 localStorage） ---------------- */
function memStorage() {
  const m = new Map();
  return {
    getItem: function (k) { return m.has(k) ? m.get(k) : null; },
    setItem: function (k, v) { m.set(k, String(v)); },
    removeItem: function (k) { m.delete(k); },
    key: function (i) { const a = Array.from(m.keys()); return i < a.length ? a[i] : null; },
    get length() { return m.size; }
  };
}
function newStore() { return Store.createStore({ small: memStorage(), large: null, namespace: 'test' }); }

/* 按题干关键字定位题目（不写死下标） */
function find(d, kw) {
  const i = d.questions.findIndex(function (q) { return q.stem.indexOf(kw) >= 0; });
  if (i < 0) throw new Error('样卷里找不到题干含「' + kw + '」的题；现有：' + d.questions.map(q => q.stem).join(' | '));
  return i;
}

/* ---------------- 样卷 ---------------- */
const CLEAN = [
  '【单选】正常单选？', 'A. 甲', 'B. 乙', '答案：B', '解析：原始解析。',
  '【多选】正常多选？', 'A. 甲', 'B. 乙', '答案：AB',
  '【判断】歧义判断？（　）', '答案：待定',
  '【判断】正常判断？（　）', '答案：对',
  '【简答】简答一？', '答案：甲甲；乙乙'
].join('\n');

// 多一题"0 个选项的选择题"：它永远过不了结构校验，用来验阻塞清单与删题出口
const MIXED = CLEAN + '\n' + ['【单选】缺选项单选？', '答案：A'].join('\n');

(async function main() {

  /* ============================================================
   * ① 字段编辑 → 入库 → 导出 JSON 可见
   * ============================================================ */
  head('①-A 建立草案：深拷贝，不持有上游引用');

  const parsed = P.parseText(CLEAN);
  eq(parsed.stats.total, 5, '样卷切出 5 题');
  const created = R.createDraft(parsed, { now: '2026-09-16T10:00:00.000Z', title: '校对测试卷' });
  ok(created.ok, 'createDraft 成功');
  let draft = created.draft;
  eq(draft.questions.length, 5, '草案含 5 题');
  eq(R.createDraft(null).ok, false, 'createDraft(null) 明确失败而不是抛异常');

  const parsedSnapshot = R.snapshot(parsed.questions);
  const draftBefore = R.snapshot(draft);

  head('①-B 逐项编辑：题型 / 题干 / 答案 / 解析 / 关键词增删');

  const iSingle = find(draft, '正常单选');
  const iMulti  = find(draft, '正常多选');
  const iJudge  = find(draft, '歧义判断');
  const iShort  = find(draft, '简答一');

  let r;
  r = R.setStem(draft, iSingle, '改过的题干？');                 ok(r.ok, '改题干'); draft = r.draft;
  r = R.setAnswer(draft, iSingle, 'A');                         ok(r.ok, '改答案 B→A'); draft = r.draft;
  r = R.setExplanation(draft, iSingle, '改过的解析。');          ok(r.ok, '改解析'); draft = r.draft;
  r = R.setType(draft, iMulti, '单选');                         ok(r.ok, '改题型 多选→单选'); draft = r.draft;
  r = R.setAnswer(draft, iJudge, '对');                         ok(r.ok, '改答案 待定→对'); draft = r.draft;
  r = R.setAnswer(draft, iShort, '丙丙；丁丁');                  ok(r.ok, '改简答参考答案'); draft = r.draft;
  r = R.addKeyword(draft, iShort, '手工采分点');                 ok(r.ok, '加关键词（默认来源=手动）'); draft = r.draft;
  r = R.addKeyword(draft, iShort, '再加一个', '加粗');           ok(r.ok, '加关键词（指定来源=加粗）'); draft = r.draft;
  r = R.removeKeyword(draft, iShort, 0);                        ok(r.ok, '删第一个关键词'); draft = r.draft;

  const qS = draft.questions[iSingle], qM = draft.questions[iMulti],
        qJ = draft.questions[iJudge],  qK = draft.questions[iShort];
  eq(qS.stem, '改过的题干？', '题干已改');
  eq(qS.answer, 'A', '答案已改');
  eq(qS.answerLetters, ['A'], '  派生字段同步：答案字母重算为 [A]');
  eq(qS.explanation, '改过的解析。', '解析已改');
  eq(qM.type, '单选', '题型已改');
  eq(qM.answerLetters, ['A'], '  派生字段同步：多选 AB → 单选只留 [A]');
  eq(qM.judgeValue, null, '  旧题型残留清干净：judgeValue=null');
  eq(qJ.judgeValue, true, '答案改成"对" → judgeValue=true（派生字段跟着走）');
  eq(qJ.review.some(s => s.indexOf('待定') >= 0), false, '  原本的"待定"待校对提示已消失（不残留旧标记）');
  eq(qK.keywords.map(k => k.text), ['丁丁', '手工采分点', '再加一个'],
     '关键词：改答案后旧的自动关键词被换掉，再删一个、加两个，顺序正确');
  eq(qK.keywords.map(k => k.via), ['自动(需校对)', '手动', '加粗'], '  每条来源保持正确');
  eq(R.keywordSourceLabel(qK.keywords[0].via), '自动生成·需校对', '  第 1 条来源标注 = 自动生成·需校对');
  eq(R.keywordSourceLabel(qK.keywords[1].via), '手动添加', '  第 2 条来源标注 = 手动添加');
  eq(R.keywordSourceLabel(qK.keywords[2].via), '加粗（原文样式）', '  第 3 条来源标注 = 加粗（原文样式）');

  head('①-C 不可变性：编辑只产生新草案，不改上游也不改旧草案');

  eq(R.snapshot(parsed.questions), parsedSnapshot, '编辑没有污染解析结果（深拷贝生效）');
  ok(R.snapshot(draft) !== draftBefore, '编辑后的草案确实变了（否则后面的对比是空转）');
  eq(draft.questions.length, 5, '编辑过程没有增删题目');

  head('①-D 确认入库 → 导出 JSON → 改动全部可见');

  const store1 = newStore();
  const base1 = R.snapshot(await R.storeSnapshot(store1));
  const c1 = await R.commit(draft, store1, { now: '2026-09-16T11:00:00.000Z', title: '校对测试卷' });
  ok(c1.ok, 'commit 成功', c1.error ? c1.error + ' / ' + c1.hint : 'examId=' + c1.examId);
  eq(c1.count, 5, '  入库 5 题');
  ok(R.snapshot(await R.storeSnapshot(store1)) !== base1, '  入库后存储确实变了（对照：编辑阶段没变）');

  const json = R.examToJson(c1.exam);
  const back = R.jsonToExam(json);
  ok(back.ok, '导出的 JSON 能被读回（走 schema 版本门禁）', back.error || '');
  const bS = back.exam.questions[find({ questions: back.exam.questions }, '改过的题干')];
  eq(bS.stem, '改过的题干？', '导出 JSON 里：题干是改后的');
  eq(bS.answer, 'A', '导出 JSON 里：答案是改后的');
  eq(bS.answerLetters, ['A'], '导出 JSON 里：答案字母同步为 [A]');
  eq(bS.explanation, '改过的解析。', '导出 JSON 里：解析是改后的');
  const bM = back.exam.questions[find({ questions: back.exam.questions }, '正常多选')];
  eq(bM.type, '单选', '导出 JSON 里：题型是改后的');
  eq(bM.judgeValue, null, '导出 JSON 里：单选不带 judgeValue（归一表生效）');
  eq(bM.keywords, null, '导出 JSON 里：单选不带 keywords（归一表生效）');
  const bK = back.exam.questions[find({ questions: back.exam.questions }, '简答一')];
  eq(bK.keywords.map(k => k.text), ['丁丁', '手工采分点', '再加一个'], '导出 JSON 里：关键词增删结果保留');
  eq(bK.keywords.map(k => k.via), ['自动(需校对)', '手动', '加粗'], '导出 JSON 里：每条关键词的来源也保留');
  const bJ = back.exam.questions[find({ questions: back.exam.questions }, '歧义判断')];
  eq(bJ.judgeValue, true, '导出 JSON 里：改后的判分值 = true');

  // 对照：改动前的值不该还在
  const oldStem = P.parseText(CLEAN).questions[0].stem;
  ok(json.indexOf('改过的题干？') >= 0, '导出 JSON 文本里能找到新题干');
  ok(json.indexOf(oldStem) < 0, '  找不到旧题干（确实被替换，不是追加）');
  ok(json.indexOf('丙丙') >= 0 && json.indexOf('甲甲') < 0, '  参考答案也是替换而非追加');

  const inStore = await store1.get('exam::' + c1.examId);
  eq(R.snapshot(inStore), R.snapshot(c1.exam), 'store 里的卷子与导出的 JSON 内容一致');

  head('①-E 入库被卡住时说清楚是哪几题（不许默默少存）');

  const badDraft = R.createDraft(P.parseText(MIXED), { now: '2026-09-16T12:00:00.000Z' }).draft;
  const iBad = find(badDraft, '缺选项单选');
  const store2 = newStore();
  const base2 = R.snapshot(await R.storeSnapshot(store2));
  const c2 = await R.commit(badDraft, store2, { now: '2026-09-16T12:00:00.000Z' });
  eq(c2.ok, false, '含 0 选项选择题的草案 → commit 拒绝');
  ok(Array.isArray(c2.blocking) && c2.blocking.length === 1, '  返回阻塞清单（1 题）',
     JSON.stringify((c2.blocking || []).map(b => b.index)));
  eq(c2.blocking[0].index, iBad, '  阻塞的正是那一题');
  ok(c2.blocking[0].errors.some(e => e.indexOf('选项少于 2 个') >= 0), '  指出原因：选项少于 2 个',
     JSON.stringify(c2.blocking[0].errors));
  eq(R.snapshot(await R.storeSnapshot(store2)), base2, '  拒绝入库时存储**零变化**');

  // 出口一：把该题删掉即可入库（否则用户会被卡死）
  const rm = R.removeQuestion(badDraft, iBad);
  ok(rm.ok, 'removeQuestion 可用（校对时"这题不要了"）');
  eq(rm.draft.questions.length, badDraft.questions.length - 1, '  删后少一题');
  eq(rm.removed.stem, '缺选项单选？', '  返回被删的题，便于"撤销"');
  const c3 = await R.commit(rm.draft, store2, { now: '2026-09-16T12:05:00.000Z' });
  ok(c3.ok, '删掉阻塞题后可以入库', c3.error || '');

  // 出口二：把题型改成判断也能救回来（校验里 judgeValue=null 只是警告不是错误）
  const rescue = R.setType(badDraft, iBad, '判断');
  ok(rescue.ok, '把 0 选项题改成判断题');
  eq(rescue.draft.questions[iBad].options, [], '  选项被清空（不再适用）');
  eq(rescue.draft.questions[iBad].judgeValue, null, '  答案 A 无法归一 → judgeValue=null');
  const c3b = await R.commit(rescue.draft, newStore(), { now: '2026-09-16T12:06:00.000Z' });
  ok(c3b.ok, '改题型后也能入库（不会被卡死）', c3b.error || c3b.hint || '');

  /* ============================================================
   * ② 待校对标记 + 一键筛选
   * ============================================================ */
  head('②-A 每道题的待校对标记（显式、带分类 id 与原因）');

  const d2 = R.createDraft(P.parseText(MIXED), { now: '2026-09-16T13:00:00.000Z' }).draft;
  const iShort2 = find(d2, '简答一'), iJudge2 = find(d2, '歧义判断'), iBad2 = find(d2, '缺选项单选');
  const iSingle2 = find(d2, '正常单选'), iMulti2 = find(d2, '正常多选'), iJudgeOk2 = find(d2, '正常判断');
  const flagIds = d2.questions.map(q => R.flagsOf(q).map(f => f.id));

  eq(R.needsReview(d2.questions[iSingle2]), false, '正常单选：不需要校对');
  eq(R.needsReview(d2.questions[iMulti2]), false, '正常多选：不需要校对');
  eq(R.needsReview(d2.questions[iJudgeOk2]), false, '正常判断：不需要校对');
  eq(R.needsReview(d2.questions[iShort2]), true, '简答（关键词自动生成）：需要校对');
  eq(R.needsReview(d2.questions[iJudge2]), true, '判断（答案"待定"）：需要校对');
  eq(R.needsReview(d2.questions[iBad2]), true, '单选（0 个选项）：需要校对');
  ok(flagIds[iJudge2].indexOf('judge-ambiguous') >= 0, '  "待定"题分类 = judge-ambiguous', JSON.stringify(flagIds[iJudge2]));
  ok(flagIds[iShort2].indexOf('keywords-auto') >= 0, '  简答题分类 = keywords-auto', JSON.stringify(flagIds[iShort2]));
  ok(flagIds[iBad2].indexOf('too-few-options') >= 0, '  0 选项题分类 = too-few-options', JSON.stringify(flagIds[iBad2]));
  ok(R.flagsOf(d2.questions[iJudge2])[0].text.length > 0, '  每个分类都带原始中文原因（面板可直接显示）',
     R.flagsOf(d2.questions[iJudge2])[0].text);

  const st = R.reviewStats(d2);
  eq(st.total, d2.questions.length, '统计：总数 = 题目数');
  eq(st.needsReview, 3, '  待校对 3 题');
  eq(st.ok, st.total - 3, '  无需校对 = 总数 - 3');
  eq(st.needsReview + st.ok, st.total, '  两类相加 = 总数（不漏不重）');

  head('②-B 一键筛选：筛选后只显示待校对题');

  const all = R.visibleIndices(d2, false);
  const only = R.visibleIndices(d2, true);
  eq(all.length, d2.questions.length, '不筛选时显示全部题');
  eq(all, d2.questions.map((q, i) => i), '  且顺序就是原始顺序');
  eq(only, [iJudge2, iShort2, iBad2].sort((a, b) => a - b), '开启"只看待校对"后精确等于待校对集合');

  const expectOnly = d2.questions.map((q, i) => R.needsReview(q) ? i : -1).filter(i => i >= 0);
  eq(only, expectOnly, '  逐个核对（不是数量相等而已）');
  ok(only.every(i => R.needsReview(d2.questions[i])), '  筛选结果里每一题都确实待校对');
  ok(all.filter(i => only.indexOf(i) < 0).every(i => !R.needsReview(d2.questions[i])),
     '  被筛掉的每一题都确实不需要校对');
  eq(only.length, 3, '  筛掉的是另外 3 题');

  head('②-C 改好之后立刻退出待校对（筛选是活的，不是一次性快照）');

  const fix2 = R.setAnswer(d2, iJudge2, '对');
  ok(fix2.ok, '把"待定"改成"对"');
  eq(R.visibleIndices(fix2.draft, true).indexOf(iJudge2), -1, '  该题立刻从筛选结果里消失');
  eq(R.visibleIndices(fix2.draft, true).length, 2, '  待校对从 3 题降到 2 题');
  eq(R.reviewStats(fix2.draft).needsReview, 2, '  计数同步更新');
  eq(R.needsReview(fix2.draft.questions[iJudge2]), false, '  该题本身已不再需要校对');

  /* ============================================================
   * ③ 取消确认 → 题库与存储零变化
   * ============================================================ */
  head('③-A 编辑本身不碰存储（只有 commit 会写）');

  const store3 = newStore();
  const base3 = R.snapshot(await R.storeSnapshot(store3));
  eq(R.snapshot(await R.storeSnapshot(store3)), base3, '起始基线：空存储');

  let d3 = R.createDraft(P.parseText(MIXED), { now: '2026-09-16T14:00:00.000Z' }).draft;
  const j3 = find(d3, '歧义判断'), m3 = find(d3, '正常多选'), s3 = find(d3, '简答一'), b3 = find(d3, '缺选项单选');
  let rr;
  rr = R.setStem(d3, 0, '取消测试：改题干');        d3 = rr.draft;
  rr = R.setAnswer(d3, 0, 'A');                    d3 = rr.draft;
  rr = R.setExplanation(d3, 0, '取消测试：改解析');  d3 = rr.draft;
  rr = R.setType(d3, m3, '单选');                   d3 = rr.draft;
  rr = R.addKeyword(d3, s3, '取消测试关键词');       d3 = rr.draft;
  rr = R.removeKeyword(d3, s3, 0);                 d3 = rr.draft;
  rr = R.removeQuestion(d3, b3);                   d3 = rr.draft;

  eq(R.snapshot(await R.storeSnapshot(store3)), base3,
     '做完 7 步编辑后，存储仍逐字节等于基线（编辑全程零副作用）');
  ok(R.snapshot(d3) !== draftBefore, '  草案确实已被改脏（否则上面的对比没有意义）');
  eq(await store3.keys(), [], '  存储里始终一条记录都没有');

  head('③-B 取消：取消前后存储逐字节相等');

  const cancelRes = R.cancel(d3);
  ok(cancelRes.ok, 'cancel 返回成功');
  eq(cancelRes.discarded, d3.id, '  报出被丢弃的草案 id');
  eq(R.snapshot(await R.storeSnapshot(store3)), base3, '取消后存储与基线**逐字节相等**');
  eq(await store3.keys(), [], '  仍是空存储');

  head('③-C 反向对照：同一份草案如果确认，存储必须变化（证明"零变化"不是空转）');

  const c4 = await R.commit(d3, store3, { now: '2026-09-16T14:30:00.000Z', title: '取消测试卷' });
  ok(c4.ok, '同一份草案 commit 成功', c4.error || c4.hint || '');
  ok(R.snapshot(await R.storeSnapshot(store3)) !== base3, '  入库后存储与基线不同');
  const ks = await store3.keys();
  eq(ks.indexOf('exam::' + c4.examId) >= 0, true, '  存储里出现了卷子记录');
  eq(ks.indexOf('index') >= 0, true, '  存储里出现了索引记录');
  const idx = await store3.get('index');
  eq(idx.examIds, [c4.examId], '  索引里登记了该卷');
  eq((await store3.get('exam::' + c4.examId)) !== null, true, '  卷子本体可读回');

  head('③-D 取消的签名保证：cancel 连 store 都不接收');

  eq(R.cancel.length, 1, 'cancel 只接受 1 个参数（draft）—— 从签名上就不可能改存储');
  eq(R.cancel().ok, true, 'cancel() 无参调用也不炸');
  eq(R.cancel(null).ok, true, 'cancel(null) 也不炸');

  /* ============================================================
   * ④ 边界与相邻锚
   * ============================================================ */
  head('④-A 非法编辑被明确拒绝（不静默吞掉）');

  const d4 = R.createDraft(P.parseText(CLEAN), {}).draft;
  const i4 = find(d4, '正常单选'), iS4 = find(d4, '简答一');
  eq(R.setField(d4, i4, 'options', []).ok, false, '不允许编辑 options 字段');
  eq(R.setField(d4, i4, 'stem', '   ').ok, false, '题干不能改成空白');
  eq(R.setType(d4, i4, '填空').ok, false, '题型只能是四类之一');
  eq(R.setField(d4, 99, 'stem', 'x').ok, false, '题目下标越界被拒绝');
  eq(R.setField(d4, -1, 'stem', 'x').ok, false, '负数下标被拒绝');
  eq(R.removeKeyword(d4, i4, 0).ok, false, '非简答题不能删关键词');
  eq(R.addKeyword(d4, i4, 'x').ok, false, '非简答题不能加关键词');
  eq(R.addKeyword(d4, iS4, '   ').ok, false, '空关键词被拒绝');
  eq(R.addKeyword(d4, iS4, '甲甲').ok, false, '重复关键词被拒绝');
  eq(R.addKeyword(d4, iS4, '新词', '随便').ok, false, '非法来源被拒绝');
  eq(R.removeKeyword(d4, iS4, 99).ok, false, '关键词下标越界被拒绝');
  eq(R.removeQuestion(d4, 99).ok, false, '删题下标越界被拒绝');
  eq((await R.commit(d4, null)).ok, false, '没有存储时 commit 明确失败而不是抛异常');
  eq((await R.commit(null, newStore())).ok, false, '草案为 null 时 commit 明确失败');

  // 失败的操作不许改动草案
  eq(d4.questions[i4].stem, P.parseText(CLEAN).questions[0].stem, '连番失败操作后草案仍是原始状态');
  eq(R.snapshot(d4.questions), R.snapshot(R.createDraft(P.parseText(CLEAN), {}).draft.questions),
     '  整份草案与"从未被操作过"的草案逐字节一致');

  head('④-B 相邻锚：入库产物必须过 schema 的结构契约');

  const exam4 = c1.exam;
  eq(Schema.validateExam(exam4).ok, true, '入库的卷子通过 validateExam');
  eq(exam4.schemaVersion, Schema.SCHEMA_VERSION, '  schemaVersion 正确打标');
  eq(exam4.questions[iSingle].options.length, 2, '  选择题 options 是数组');
  eq(exam4.questions[iJudge].keywords, null, '  判断题 keywords 归一为 null');
  eq(exam4.questions[iJudge].options, null, '  判断题 options 归一为 null');
  eq(exam4.questions[iShort].judgeValue, null, '  简答题 judgeValue 归一为 null');
  eq(exam4.questions[iShort].options, null, '  简答题 options 归一为 null');
  ok(Array.isArray(exam4.questions[iShort].keywords), '  简答题 keywords 是数组');
  eq(new Set(exam4.questions.map(q => q.id)).size, exam4.questions.length, '  题目 id 互不相同');

  head('④-C JSON 往返与版本门禁');

  eq(R.snapshot(R.jsonToExam(json).exam), R.snapshot(exam4), '往返后卷子逐字段不变');
  eq(R.jsonToExam('{').ok, false, '坏 JSON 被拒绝');
  eq(R.jsonToExam('{"kind":"exam"}').ok, false, '缺 schemaVersion 被拒绝（版本门禁）');
  eq(R.jsonToExam('{"kind":"exam","schemaVersion":9999,"exam":{}}').ok, false, '版本过高被拒绝');
  eq(R.jsonToExam('{"kind":"share","schemaVersion":1,"exam":{}}').ok, false, 'kind 不对被拒绝');

  head('④-D 面板交付的可用性细节');

  eq(R.EDITABLE_FIELDS, ['type', 'stem', 'answer', 'explanation'], '可编辑字段清单稳定');
  eq(R.KEYWORD_VIAS, ['加粗', '高亮', '字体色', '底纹', '自动(需校对)', '手动'], '关键词来源枚举稳定');
  eq(R.TYPES, ['单选', '多选', '判断', '简答'], '题型枚举稳定');
  eq(['手动', '自动(需校对)', '加粗', '高亮', '字体色', '底纹', '奇怪值', '', null].map(R.keywordSourceLabel),
     ['手动添加', '自动生成·需校对', '加粗（原文样式）', '高亮（原文样式）', '字体色（原文样式）', '底纹（原文样式）', '奇怪值', '未标注', '未标注'],
     'keywordSourceLabel 覆盖全部来源枚举 + 异常输入');
  eq(R.visibleIndices(null, true), [], 'visibleIndices(null) 安全返回 []');
  eq(R.reviewStats(null), { total: 0, needsReview: 0, ok: 0, byFlag: {} }, 'reviewStats(null) 安全返回');
  eq([R.needsReview(null), R.needsReview({})], [false, false], 'needsReview 对空值安全');
  eq(R.flagsOf(null), [], 'flagsOf(null) 安全返回 []');
  eq(R.storeSnapshot.length, 1, 'storeSnapshot 接收 1 个参数（store）');

  /* ============================================================
   * ④-E 挑刺：改参考答案之后，关键词到底怎么处理（把规则写死，别靠碰巧）
   * ============================================================ */
  head('④-E 改参考答案后关键词的处理规则');

  const a1 = R.createDraft(P.parseText('【简答】题？\n答案：甲甲；乙乙'), {}).draft;
  eq(a1.questions[0].keywords.map(k => k.text), ['甲甲', '乙乙'], '起始：自动生成两条');
  const a1b = R.setAnswer(a1, 0, '丙丙；丁丁').draft;
  eq(a1b.questions[0].keywords.map(k => k.text), ['丙丙', '丁丁'],
     '只有自动关键词时：改答案 → 按新答案重新生成（不留旧的）');
  eq(a1b.questions[0].keywords.map(k => k.via), ['自动(需校对)', '自动(需校对)'],
     '  重新生成的仍标为「自动(需校对)」');

  const a2res = R.addKeyword(a1, 0, '手工词');
  const a2 = a2res.draft;
  eq(a2.questions[0].keywords.map(k => k.via), ['自动(需校对)', '自动(需校对)', '手动'],
     '在自动关键词基础上再加一条手工关键词');
  const a2b = R.setAnswer(a2, 0, '戊戊；己己').draft;
  eq(a2b.questions[0].keywords.map(k => k.text), ['手工词'],
     '改答案：自动的被丢掉，手工的留住（机器给的可以作废，人给的不许丢）');
  eq(a2b.questions[0].keywords.map(k => k.via), ['手动'], '  来源仍是「手动」');
  eq(a2b.questions[0].review.some(s => s.indexOf('自动生成') >= 0), false,
     '  不会误报"关键词为自动生成"');

  const a3 = R.createDraft({
    questions: [{ type: '简答', stem: '题？', answer: '甲', options: [], keywords: [{ text: '样式词', via: '加粗' }], review: [], explanation: '' }]
  }, {}).draft;
  const a3b = R.setAnswer(a3, 0, '乙乙；丙丙').draft;
  eq(a3b.questions[0].keywords.map(k => k.text + ':' + k.via), ['样式词:加粗'],
     '原文样式关键词不受改答案影响（文档标了什么就是什么）');

  /* ============================================================
   * ④-F 挑刺：面板静态自查（XSS 通道 / 触屏尺寸声明）
   * ============================================================ */
  head('④-F 面板静态自查：XSS 通道与触屏尺寸声明');

  const uiSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'ui', 'review-panel.js'), 'utf8');
  // 先把 `innerHTML\s*=` 里的换行折掉，否则 `x.innerHTML =\n  '<div…'` 这种跨行写法会看漏
  const uiFlat = uiSrc.replace(/innerHTML\s*=\s*/g, 'innerHTML=');
  const htmlAssigns = uiFlat.split('\n')
    .map((s, i) => ({ n: i + 1, s: s.trim() }))
    .filter(x => /innerHTML=/.test(x.s));
  eq(htmlAssigns.length, 3, '面板里只有 3 处 innerHTML 赋值');
  ok(htmlAssigns.every(x => /innerHTML=(''|""|'<|"<)/.test(x.s)),
     '  全部是"清空"或静态字符串字面量（用户数据一律走 textContent，无注入通道）',
     JSON.stringify(htmlAssigns.map(x => x.s.slice(0, 60))));
  ok(uiSrc.indexOf('.textContent') >= 0, '  用户可见文本用 textContent 写入');
  ok(uiFlat.indexOf('innerHTML=q.') < 0 && uiFlat.indexOf('innerHTML=(q.') < 0,
     '  没有任何一处把题目字段直接拼进 innerHTML');

  /* 用户要求：导入之后默认就停在"只看待校对"，别让人先自己去找勾选框。
     默认值写在 mount 的选项归一里，浏览器侧由 自检 G 节 + import-bank 流水线复核；
     这里先钉死源码形态，防止被"顺手改成 false"而无人察觉。 */
  ok(/onlyReview:\s*\(o\.onlyReview\s*===\s*undefined\)\s*\?\s*true/.test(uiSrc),
     '「只看待校对」默认打开（调用方显式传 false 时仍可关）');
  ok(uiSrc.indexOf('没有待校对的题目') >= 0,
     '  筛完为空给的是"没有待校对"的友好文案（不是白屏/报错）');

  const minHeights = (uiSrc.match(/min-height:\s*(\d+)px/g) || []).map(s => Number(s.match(/(\d+)/)[1]));
  ok(minHeights.length > 0, 'CSS 里声明了控件最小高度', minHeights.join(','));
  eq(minHeights.filter(h => h < 44), [], '  没有任何小于 44px 的声明（触屏点击目标）');
  ok(uiSrc.indexOf('@media') >= 0, '  有窄屏适配（移动端）');

  /* ============================================================
   * ④-G 挑刺：极端输入与重复入库
   * ============================================================ */
  head('④-G 极端输入与重复入库');

  const weird = R.createDraft(P.parseText('【单选】带"引号"的题干？\nA. 甲\nB. 乙\n答案：B'), {}).draft;
  const evilStem = '改后的"引号"与尖括号 <script>alert(1)</script> 和 emoji 🙂';
  const w2 = R.setStem(weird, 0, evilStem).draft;
  eq(w2.questions[0].stem, evilStem, '含引号/尖括号/emoji 的题干能原样保存');
  const evilExam = Schema.createExam({ questions: [Schema.createQuestion(w2.questions[0])] });
  const evilBack = R.jsonToExam(R.examToJson(evilExam));
  eq(evilBack.ok, true, '  含尖括号的题干也能走 JSON 往返', evilBack.error || '');
  eq(evilBack.exam.questions[0].stem, evilStem, '  JSON 往返后题干逐字符不变');

  const st5 = newStore();
  const cA = await R.commit(w2, st5, { now: '2026-09-16T16:00:00.000Z' });
  const cB = await R.commit(w2, st5, { now: '2026-09-16T16:00:01.000Z' });
  ok(cA.ok && cB.ok, '同一草案入库两次都成功');
  ok(cA.examId !== cB.examId, '逻辑层：两次入库 = 两份卷子（"一次确认一份卷子"的语义）',
     cA.examId + ' / ' + cB.examId);
  eq((await st5.get('index')).examIds.length, 2, '  索引里登记了两份');
  // 防连点是**面板**的职责（同步 in-flight 闸），在浏览器自检 G 节验证
  ok(uiSrc.indexOf('state.committing') >= 0, '  面板层有同步的 in-flight 防重闸（不然连点两下会写出两份）');

  const big = R.createDraft(P.parseText('【简答】长答案题？\n答案：' + '甲'.repeat(400)), {}).draft;
  eq(big.questions[0].keywords, [], '400 字无标点答案 → 切不出关键词（不硬凑）');
  ok(big.questions[0].review.some(s => s.indexOf('切不出采分关键词') >= 0),
     '  并如实提示需人工填写采分点');

  const emp = R.createDraft(P.parseText(''), {}).draft;
  eq(emp.questions, [], '空文本 → 空草案，不抛异常');
  eq(R.reviewStats(emp), { total: 0, needsReview: 0, ok: 0, byFlag: {} }, '  统计安全返回零值');
  const empCommit = await R.commit(emp, newStore(), { now: '2026-09-16T16:10:00.000Z' });
  ok(empCommit.ok, '空草案也能入库（一份 0 题的卷子，不报错）', empCommit.error || '');

  /* ============================================================
   * ⑤ 组级验收：三类"歧义/不完整"题 → 面板修改 → 入库 → 导出可见
   *    组级标准比小类严：这是「数据与解析基座」大类的收官判据，三类必须各自成立。
   * ============================================================ */
  head('⑤-A 三类问题同卷：先被拦住，逐类修好后能入库');

  const PROBLEMS = [
    '【单选】正常题？', 'A. 甲', 'B. 乙', '答案：B',
    '【判断】待定判断题？（　）', '答案：待定',                                    // 类①：判断题答案无法识别
    '【单选】零选项题？', '答案：A',                                             // 类②：选择题选项少于 2 个
    '【简答】长答案题？', '答案：这是一个超过十八个字符的非常长的参考答案内容描述'  // 类③：简答切不出关键词
  ].join('\n');

  let gd = R.createDraft(P.parseText(PROBLEMS), { now: '2026-09-16T17:00:00.000Z', title: '组级验收卷' }).draft;
  const gJudge = find(gd, '待定判断题'), gFew = find(gd, '零选项题'),
        gNoKw = find(gd, '长答案题'), gGood = find(gd, '正常题');

  eq(R.needsReview(gd.questions[gJudge]), true, '类①判断题（答案"待定"）被标为待校对');
  eq(R.needsReview(gd.questions[gFew]), true, '类②选择题（0 个选项）被标为待校对');
  eq(R.needsReview(gd.questions[gNoKw]), true, '类③简答题（切不出关键词）被标为待校对');
  eq(R.needsReview(gd.questions[gGood]), false, '对照组：正常题不需要校对');
  eq(R.reviewStats(gd).needsReview, 3, '整卷待校对 3 题');

  const store5 = newStore();
  const base5 = R.snapshot(await R.storeSnapshot(store5));
  const blocked = await R.commit(gd, store5, { now: '2026-09-16T17:00:00.000Z' });
  eq(blocked.ok, false, '未修改直接入库 → 被结构校验拦住（0 选项题是硬错误）');
  eq(blocked.blocking.map(b => b.index), [gFew], '  阻塞清单精确指向那一题');
  eq(R.snapshot(await R.storeSnapshot(store5)), base5, '  被拦住时存储零变化');

  head('⑤-B 逐类人工修改（走的就是面板那几个操作）');

  const rJudge = R.setAnswer(gd, gJudge, '对');
  ok(rJudge.ok, '类①：把答案从"待定"改成"对"'); gd = rJudge.draft;
  eq(R.needsReview(gd.questions[gJudge]), false, '  该题退出待校对');
  eq(gd.questions[gJudge].judgeValue, true, '  judgeValue 重算为 true');

  const rFew = R.setType(gd, gFew, '判断');
  ok(rFew.ok, '类②：把 0 选项题的题型改成判断（选项编辑不在本小类，改题型是出口之一）'); gd = rFew.draft;
  const rFew2 = R.setAnswer(gd, gFew, '错');
  ok(rFew2.ok, '  再把答案改成"错"'); gd = rFew2.draft;
  eq(R.needsReview(gd.questions[gFew]), false, '  该题退出待校对');
  eq(gd.questions[gFew].judgeValue, false, '  judgeValue 重算为 false');
  eq(gd.questions[gFew].options, [], '  不再适用的选项已清空');

  const rKw = R.addKeyword(gd, gNoKw, '手工采分点', '手动');
  ok(rKw.ok, '类③：给简答题手动加一条采分关键词'); gd = rKw.draft;
  eq(R.needsReview(gd.questions[gNoKw]), false, '  该题退出待校对');

  eq(R.reviewStats(gd).needsReview, 0, '三类全部修好后，整卷待校对归零');
  eq(R.visibleIndices(gd, true), [], '「只看待校对」筛选后为空（面板会显示"没有待校对的题目"）');

  head('⑤-C 修好后入库 → 三类修改都能从导出的 JSON 里看到');

  const done = await R.commit(gd, store5, { now: '2026-09-16T17:05:00.000Z', title: '组级验收卷' });
  ok(done.ok, '修好后入库成功', done.error || done.hint || '');
  const ex = R.jsonToExam(R.examToJson(done.exam));
  ok(ex.ok, '  导出的 JSON 能读回', ex.error || '');
  const qs = ex.exam.questions;
  eq(qs[gJudge].judgeValue, true, '  类①的修改可见：judgeValue=true（原来是 null）');
  eq(qs[gFew].type, '判断', '  类②的修改可见：题型已改为判断（原来是单选）');
  eq(qs[gFew].options, null, '    且选项按契约归一为 null');
  eq(qs[gFew].judgeValue, false, '    判分值 false 也写进去了');
  eq(qs[gNoKw].keywords.map(k => k.text), ['手工采分点'], '  类③的修改可见：手加的关键词在');
  eq(qs[gNoKw].keywords.map(k => k.via), ['手动'], '    来源标为「手动」');
  const exJson = R.examToJson(done.exam);
  // 精确断言：只看**该字段**有没有被替换，不要拿整份 JSON 做 indexOf ——
  // 类①的题干本身就叫「待定判断题？」，整串搜索必然命中，那是假失败。
  const gRef = R.createDraft(P.parseText(PROBLEMS), {}).draft;
  eq(gRef.questions[gJudge].answer, '待定', '  对照：修改前该题答案是"待定"');
  eq(qs[gJudge].answer, '对', '  导出里的答案已替换为"对"');
  ok(qs[gJudge].answer !== gRef.questions[gJudge].answer, '  与修改前的值确实不同');
  eq(qs[gNoKw].answer, gRef.questions[gNoKw].answer,
     '  类③只加关键词、不动参考答案（长答案按约定保留）');
  eq(qs[gNoKw].keywords.length, 1, '  且关键词只有人工那一条（原来一条都没有）');
  eq(gRef.questions[gNoKw].keywords, [], '  对照：修改前简答没有任何关键词');
  ok(exJson.indexOf('"via": "手动"') >= 0 || exJson.indexOf('"via":"手动"') >= 0,
     '  导出 JSON 文本里能看到 "via": "手动"');
  eq(qs[gGood].answer, 'B', '  对照组：没动过的题保持原样');

  head('⑤-D .doc 老格式：面板按**字节**拒绝并提示另存为（不是靠扩展名猜）');

  const pageSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'review-template.html'), 'utf8');
  ok(pageSrc.indexOf('ZipCore.sniff') >= 0, '页面先用 ZipCore.sniff 嗅探字节类型');
  ok(pageSrc.indexOf("kind === 'ole2'") >= 0, '  然后才按类型分流（不是只看扩展名）');
  ok(pageSrc.indexOf('另存为') >= 0 && pageSrc.indexOf('Word 文档 (*.docx)') >= 0,
     '  拒绝文案里明确要求"另存为 .docx"');
  ok(pageSrc.indexOf('endsWith') < 0 || pageSrc.indexOf("lower.endsWith('.txt')") < 0,
     '  扩展名不再决定路由（改名成 .txt 的 .doc 也会被拒绝，不会静默出 0 题）');
  const oldDoc = require('fs').readFileSync(require('path').join(__dirname, '..', 'fixtures', 'old_format.doc'));
  const oldAb = oldDoc.buffer.slice(oldDoc.byteOffset, oldDoc.byteOffset + oldDoc.byteLength);
  eq(require('../core/parse/zip.js').sniff(new Uint8Array(oldAb)).kind, 'ole2',
     '  .doc 固件嗅探结果 = ole2（面板就是靠这个判的）');
  const dg = await require('../core/parse/docx.js').diagnose(oldAb);
  eq(dg.ok, false, '  diagnose 明确拒绝');
  eq(dg.code, 'E_OLD_DOC', '  错误码 E_OLD_DOC');
  ok(dg.hint.indexOf('另存为') >= 0, '  提示里含「另存为」', dg.hint);

  console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
  console.log('  PASS ' + pass + '    FAIL ' + fail);
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
