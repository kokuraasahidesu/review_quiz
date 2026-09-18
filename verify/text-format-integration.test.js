/* ============================================================
 *  verify/text-format-integration.test.js —— 「结构化 txt 往返」的集成 + 相邻锚验收
 *
 *  运行： node verify/text-format-integration.test.js
 *
 *  分工：
 *    verify/text-format.test.js 是格式模块自己的单元证据（具体错误码/行号/语法细节）。
 *    本文件是我的独立验收：**只用冻结的 API**（不看它设计的具体语法），
 *    从**集成**角度验三件它验不到的事：
 *      A. 用**真实解析产物**（docx 样卷 + GBK txt 样卷）走往返，而不是手工造的题
 *      B. 相邻锚：卷册（ExamsCore）/ 校对面板（ReviewCore）/ 存储（DataCore）三方衔接
 *      C. 文本级幂等：export → import → export 必须逐字节相同（两遍法）
 *
 *  损坏用例一律用**与语法无关**的破坏方式（空串 / 垃圾 / 改版本号 / 截断 / 替换题型词），
 *  这样不会因为格式细节变了而误报。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const TF = require('../core/text-format.js');
const P = require('../parser-core.js');
const E = require('../core/exams.js');
const D = require('../core/data.js');
const S = require('../core/schema.js');
const Review = require('../core/review.js');
const Segment = require('../core/parse/segment.js');

let pass = 0, fail = 0; const failures = [];
function brief(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return String(s);
  return s.length > 160 ? s.slice(0, 160) + '…(' + s.length + ' 字符)' : s;
}
function ok(c, t, d) { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + brief(d) : '')))
                         : (fail++, failures.push(t), console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + brief(d) : ''))); }
function eq(a, e, t) { const A = JSON.stringify(a), B = JSON.stringify(e); ok(A === B, t + '   期望=' + brief(B), A); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }

/*
 * 手搓的题必须走"派生 → 工厂"这条链（与 core/exams.js:normalizeQuestions 同序）。
 * 为什么：applyDerived 见到空 answer 必然补 '没有识别到答案'，而 createQuestion 只是原样抄 review。
 * 若基准题带着不自洽的 review:[]，就会出现
 *   "要求往返后 review 仍是 []" 与 "要求往返后 review 含该提示" 同时成立 —— 逻辑上不可能。
 * 那不是模块的问题，是基准题造错了。
 */
function sq(f) { return S.createQuestion(Segment.applyDerived(Object.assign({}, f))); }

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
    small, large,
    store: (ns) => D.createStore({ small, large, namespace: ns || D.NS_GLOBAL, threshold: 512 })
  };
}
async function snapOf(store) {
  const ks = (await store.keys()).slice().sort();
  const o = {};
  for (const k of ks) o[k] = await store.get(k);
  return JSON.stringify(o);
}
function readDocx() {
  const b = fs.readFileSync(path.join(__dirname, '..', 'sample.docx'));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}
function readTxtFixture(name) {
  const b = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'txt', name));
  return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

(async function main() {

  /* ============ ⓪ 模块基本形态 ============ */
  head('⓪ 模块导出与签名');

  ok(typeof TF.exportExam === 'function', 'exportExam 是函数');
  ok(typeof TF.importExam === 'function', 'importExam 是函数');
  ok(typeof TF.importToLibrary === 'function', 'importToLibrary 是函数');
  ok(typeof TF.diagnose === 'function', 'diagnose 是函数');
  ok(typeof TF.FORMAT_VERSION === 'number' && TF.FORMAT_VERSION >= 1, 'FORMAT_VERSION 是 >=1 的数',
     String(TF.FORMAT_VERSION));
  ok(typeof TF.HEADER === 'string' && TF.HEADER.length > 0, 'HEADER 非空', TF.HEADER);
  eq(TF.exportExam.length >= 1, true, 'exportExam 至少收 1 个参数');
  eq(TF.importExam.length >= 1, true, 'importExam 至少收 1 个参数');
  eq(TF.importToLibrary.length >= 2, true, 'importToLibrary 至少收 (store, text)');
  // 纯函数：importExam 不该接收 store（第 3 条标准的"结构性保证"靠它）
  eq(TF.importExam.length <= 2, true, 'importExam 只收 (text, opts) —— 结构上碰不到存储');

  /* ============ ① 真实解析产物往返：逐字段无差异 ============ */
  head('①-A docx 样卷（10 题）往返');

  const docxExam = S.createExam({
    title: '计算机网络 期中模拟卷',
    // 基准必须用**工厂形状**：parseDocx 的产出带着 number / autoDetected 这类解析产物字段，
    // 它们不属于 Exam/Question 结构（QUESTION_FIELDS 里没有），
    // 拿解析器形状当基准会把"工厂正确丢弃非结构字段"误判成"信息丢失"。
    questions: (await P.parseDocx(readDocx())).questions.map(q => S.createQuestion(q)),
    config: { points: { '单选': 2, '多选': 3, '判断': 1, '简答': 5 }, seed: 7 },
    configLocked: true
  }, { now: '2026-09-17T09:00:00.000Z' });

  const textA = TF.exportExam(docxExam);
  ok(typeof textA === 'string' && textA.length > 200, '导出了非空文本', textA.length + ' 字符');
  ok(textA.indexOf('计算机网络 期中模拟卷') >= 0, '  文本里能看到试卷标题（可读、可手工找）');
  ok(textA.indexOf('单选') >= 0 && textA.indexOf('判断') >= 0 && textA.indexOf('简答') >= 0,
     '  文本里能看到题型名');
  ok(textA.indexOf(TF.HEADER) >= 0, '  文本里有格式头', TF.HEADER);

  const backA = TF.importExam(textA);
  ok(backA.ok, '导入成功', backA.ok ? '' : brief(backA.errors));
  if (backA.ok) {
    eq(JSON.stringify(backA.exam), JSON.stringify(docxExam),
       '**逐字段完全还原**：整个 Exam 对象（含 id/时间戳/config/configLocked/全部题目字段）');
    eq(backA.exam.questions.length, 10, '  10 题都在');
    eq(backA.exam.configLocked, true, '  configLocked 还原');
    eq(backA.exam.config.points['多选'], 3, '  嵌套 config 还原');
    eq(backA.exam.createdAt, docxExam.createdAt, '  createdAt 还原');
    eq(backA.exam.updatedAt, docxExam.updatedAt, '  updatedAt 还原（默认不 touch）');
    // 抽几个"最容易在往返里丢"的字段单独点名
    const q7 = backA.exam.questions[6];
    eq(q7.keywords.map(k => k.text + '|' + k.via), docxExam.questions[6].keywords.map(k => k.text + '|' + k.via),
       '  简答关键词的**来源 via** 也还原（加粗/高亮/字体色）');
    const q5 = backA.exam.questions[5];
    eq(q5.judgeValue, null, '  歧义判断题 judgeValue=null 还原');
    eq(q5.review, docxExam.questions[5].review, '  派生 review 提示也一致（不是空掉）');
  }

  head('①-B GBK txt 样卷（4 题，含自动生成关键词）往返');

  const txtParsed = await P.parseTxtBytesAs(readTxtFixture('basic_gbk.txt'), {});
  const txtExam = S.createExam({
    title: 'GBK 样卷',
    questions: txtParsed.questions.map(q => S.createQuestion(q)),
    config: null
  }, { now: '2026-09-17T09:05:00.000Z' });
  const textB = TF.exportExam(txtExam);
  const backB = TF.importExam(textB);
  ok(backB.ok, '导入成功', backB.ok ? '' : brief(backB.errors));
  if (backB.ok) {
    eq(JSON.stringify(backB.exam), JSON.stringify(txtExam), '**逐字段完全还原**（config=null 的情形）');
    const q3 = backB.exam.questions[3];
    eq(q3.keywords.map(k => k.via), ['自动(需校对)', '自动(需校对)', '自动(需校对)'],
       '  自动生成关键词的来源标注保留');
    eq(q3.review.some(s => s.indexOf('自动生成') >= 0 && s.indexOf('需校对') >= 0), true,
       '  「自动生成·需校对」提示也保留（往返后仍不许伪装成人工标记）');
    eq(Review.needsReview(q3), true, '**相邻锚**：往返后它仍被校对面板判为"需要校对"');
    eq(Review.flagsOf(q3).map(f => f.id), ['keywords-auto'], '  疑点分类一致');
  }

  head('①-C 多行题干 / emoji / 手工关键词 / 难度 / inTextBox');

  const tricky = S.createExam({
    title: '边界测试卷 🎯',
    questions: [
      sq({ type: '简答', stem: '第一行题干\n第二行题干（含 | 竖线与 = 等号）\n第三行',
           answer: '参考答案；含分号', explanation: '解析第一行\n解析第二行',
           keywords: [{ text: '手工甲', via: '手动' }, { text: '手工乙', via: '手动' }],
           difficulty: 5, inTextBox: true, review: [] }),
      sq({ type: '单选', stem: '选一个 🙂', options: [{ label: 'A', text: '甲. 含点' }, { label: 'B', text: '乙：含冒号' }],
           answer: 'B', difficulty: 1, review: [] }),
      sq({ type: '判断', stem: '没有答案的判断题？（　）', answer: '', review: [] }),
      sq({ type: '多选', stem: '多选？', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }, { label: 'C', text: 'c' }],
           answer: 'AC', difficulty: 3, review: [] })
    ],
    config: { nested: { deep: [1, 2, { x: 'y' }] }, s: '含"引号"与\\反斜杠' }
  }, { now: '2026-09-17T09:10:00.000Z' });

  const textC = TF.exportExam(tricky);
  const backC = TF.importExam(textC);
  ok(backC.ok, '含多行/emoji/特殊字符的卷子导入成功', backC.ok ? '' : brief(backC.errors));
  if (backC.ok) {
    eq(JSON.stringify(backC.exam), JSON.stringify(tricky), '**逐字段完全还原**（多行题干/解析、emoji、竖线、引号、反斜杠）');
    eq(backC.exam.questions[0].stem.split('\n').length, 3, '  多行题干仍是 3 行');
    eq(backC.exam.questions[0].inTextBox, true, '  inTextBox=true 还原');
    eq(backC.exam.questions[0].difficulty, 5, '  difficulty=5 还原');
    eq(backC.exam.questions[1].difficulty, 1, '  difficulty=1 还原');
    eq(backC.exam.questions[2].review.some(s => s.indexOf('没有识别到答案') >= 0), true,
       '  无答案判断题的派生提示仍存在');
    eq(backC.exam.config.nested.deep[2].x, 'y', '  深层嵌套 config 还原');
    eq(backC.exam.config.s, tricky.config.s, '  含引号/反斜杠的字符串还原');
  }

  head('①-D 空卷往返');

  const emptyExam = S.createExam({ title: '空卷', questions: [] }, { now: '2026-09-17T09:15:00.000Z' });
  const backE = TF.importExam(TF.exportExam(emptyExam));
  ok(backE.ok, '空卷也能往返');
  if (backE.ok) eq(JSON.stringify(backE.exam), JSON.stringify(emptyExam), '  空卷逐字段还原（questions=[]）');

  /* ============ ② 文本级幂等：export → import → export 逐字节相同 ============ */
  head('② 两遍法：export → import → export 必须逐字节相同');

  if (backA.ok) {
    const textA2 = TF.exportExam(backA.exam);
    eq(textA2 === textA, true, 'docx 样卷：第二次导出与第一次**逐字节相同**',
       textA2 === textA ? '' : ('长度 ' + textA.length + ' vs ' + textA2.length));
  }
  if (backC.ok) {
    const textC2 = TF.exportExam(backC.exam);
    eq(textC2 === textC, true, '边界卷：第二次导出与第一次逐字节相同');
  }

  /* ============ ③ 损坏文本：拒绝 + 可定位 ============ */
  head('③-A 与语法无关的破坏方式（空 / 垃圾 / 改版本 / 截断 / 换题型词）');

  const broken = [
    ['空文本', ''],
    ['全是空白', '   \n\n  \n'],
    ['完全无关的垃圾', '这不是试卷文件\n随便写点什么\n12345\n'],
    ['HTML 片段', '<html><body>hello</body></html>'],
    ['二进制乱码', '\u0000\u0001\u0002\u0003\uFFFD\uFFFD'],
    ['只有头没有内容', TF.HEADER + '\n']
  ];
  for (const c of broken) {
    const r = TF.importExam(c[1]);
    eq(r.ok, false, c[0] + ' → 被拒绝');
    ok(Array.isArray(r.errors) && r.errors.length > 0, '  给出错误清单', brief(r.errors));
    if (r.errors && r.errors.length) {
      const e0 = r.errors[0];
      ok(typeof e0.code === 'string' && e0.code.length > 0, '    错误带 code', e0.code);
      ok(typeof e0.message === 'string' && e0.message.length > 3, '    错误带可读 message', e0.message);
      ok(typeof e0.line === 'number' && e0.line >= 0, '    错误带行号（空文本可为 0）', String(e0.line));
    }
  }

  // 版本号改坏
  const badVer = textA.replace(String(TF.FORMAT_VERSION), '999999');
  ok(badVer !== textA, '自检：确实把版本号改掉了');
  const rVer = TF.importExam(badVer);
  eq(rVer.ok, false, '版本号不认识 → 被拒绝');
  ok(rVer.errors.some(e => /版本|version/i.test(e.code + ' ' + e.message)), '  错误信息指向版本问题',
     brief(rVer.errors));

  // 截断
  const lines = textA.split('\n');
  const cut = lines.slice(0, Math.max(2, Math.floor(lines.length / 2))).join('\n');
  const rCut = TF.importExam(cut);
  eq(rCut.ok, false, '中途截断 → 被拒绝');
  ok(rCut.errors.length > 0, '  给出错误清单', brief(rCut.errors));

  // 题型词换成不存在的
  const badType = textA.replace('单选', '填空题');
  ok(badType !== textA, '自检：确实替换了题型词');
  const rType = TF.importExam(badType);
  eq(rType.ok, false, '未知题型 → 被拒绝');
  ok(rType.errors.some(e => e.line >= 1), '  错误定位到具体行', brief(rType.errors.map(e => e.line + ':' + e.code)));
  ok(rType.errors.every(e => typeof e.line === 'number' && e.line <= badType.split('\n').length + 1),
     '  行号落在文本范围内');

  head('③-B 错误行号必须指向真实出问题的那一行');

  if (rType.errors.length && rType.errors[0].line >= 1) {
    const lineText = badType.split('\n')[rType.errors[0].line - 1] || '';
    ok(lineText.indexOf('填空题') >= 0 || rType.errors[0].code.indexOf('TYPE') >= 0,
       '  行号指向的那一行确实是"填空题"那行（或错误码明确指向题型）',
       '行' + rType.errors[0].line + ' = ' + brief(lineText));
  } else {
    ok(false, '未知题型应当给出具体行号');
  }

  head('③-C diagnose 与 importExam 结论一致');

  const dGood = TF.diagnose(textA);
  eq(dGood.ok, true, 'diagnose(好文本).ok = true');
  eq(dGood.questionCount, 10, '  报出题目数 10');
  eq(dGood.title, '计算机网络 期中模拟卷', '  报出标题');
  eq(dGood.formatVersion, TF.FORMAT_VERSION, '  报出版本号');
  const dBad = TF.diagnose(badType);
  eq(dBad.ok, false, 'diagnose(坏文本).ok = false');
  eq(dBad.errors.length > 0, true, '  给出错误清单');
  eq(TF.importExam(cut).ok, TF.diagnose(cut).ok, '截断文本上两者结论一致');
  eq(TF.importExam('').ok, TF.diagnose('').ok, '空文本上两者结论一致');

  /* ============ ④ 相邻锚 A：失败导入不破坏已有数据 ============ */
  head('④-A 导入失败 → store 逐字节不变；导入成功 → 必须变化（反空转）');

  const W = world();
  const store = W.store();
  const seed = await E.createExam(store, { title: '已有的重要试卷', now: '2026-09-17T10:00:00.000Z' });
  ok(seed.ok, '先放一份已有试卷');
  await E.appendQuestions(store, seed.exam.id, P.parseText('【判断】地球是圆的？（　）\n答案：对\n').questions);
  await store.set('settings', { theme: 'dark', keep: '这是全局设置，任何导入都不该动它' });
  const before = await snapOf(store);

  const failImport = await TF.importToLibrary(store, badType, { now: '2026-09-17T10:10:00.000Z' });
  eq(failImport.ok, false, '损坏文本 → importToLibrary 失败');
  eq(failImport.blocked, true, '  明确标记为"被拦下"', String(failImport.blocked));
  eq(await snapOf(store), before, '**导入失败后 store 逐字节未变**');
  eq(await store.get('settings'), { theme: 'dark', keep: '这是全局设置，任何导入都不该动它' },
     '  全局设置原样');

  const emptyBatch = await TF.importToLibrary(store, '', {});
  eq(emptyBatch.ok, false, '空文本同样失败');
  eq(await snapOf(store), before, '  存储仍逐字节未变');

  const libImport = await TF.importToLibrary(store, textA, { now: '2026-09-17T10:20:00.000Z', newIds: true });
  ok(libImport.ok, '合法文本 → 入库成功', libImport.ok ? '' : brief(libImport.errors));
  ok((await snapOf(store)) !== before, '**对照：入库成功后 store 确实变了**（否则上面那条是空转）');
  eq(libImport.exam.questions.length, 10, '  入库 10 题');

  head('④-B 相邻锚：入库后的卷册视图一致，且无孤儿数据');

  const list = await E.listExams(store);
  eq(list.total, 2, '卷册里现在有 2 份（原有的 + 导入的）');
  const importedMeta = list.exams.filter(x => x.id === libImport.exam.id)[0];
  eq(importedMeta.counts.total, 10, '  导入的那份 10 题');
  eq(importedMeta.counts['单选'], 2, '  单选 2');
  eq(importedMeta.counts['多选'], 1, '  多选 1');
  eq(importedMeta.counts['判断'], 4, '  判断 4');
  eq(importedMeta.counts['简答'], 3, '  简答 3');
  eq(importedMeta.title, '计算机网络 期中模拟卷', '  标题正确');
  eq((await E.scanOrphans(store)).orphans, [], '  无孤儿数据');

  const exBack = await E.getExam(store, libImport.exam.id);
  eq(JSON.stringify(exBack.exam.questions), JSON.stringify(libImport.exam.questions),
     '从 store 读回的题目与导入结果逐字段一致');

  head('④-C 相邻锚：newIds 语义正确（不撞已有 id）');

  ok(libImport.exam.id !== docxExam.id, 'newIds:true → 卷 id 重新分配');
  const oldIds = docxExam.questions.map(q => q.id);
  const newIds = libImport.exam.questions.map(q => q.id);
  eq(newIds.filter(id => oldIds.indexOf(id) >= 0), [], '  题目 id 也都重新分配（不与原卷撞号）');
  eq(new Set(newIds).size, 10, '  新 id 互不重复');
  const allIds = (await E.getExam(store, seed.exam.id)).exam.questions.map(q => q.id).concat(newIds);
  eq(new Set(allIds).size, allIds.length, '  与已有卷的题目 id 也不重复');

  head('④-D 相邻锚：不传 newIds 时 id 原样保留（这是"同一份卷子"的往返）');

  const W2 = world();
  const store2 = W2.store();
  const r2 = await TF.importToLibrary(store2, textA, { now: '2026-09-17T11:00:00.000Z' });
  ok(r2.ok, '入库成功');
  eq(r2.exam.id, docxExam.id, '  卷 id 与原卷相同');
  eq(r2.exam.questions.map(q => q.id), docxExam.questions.map(q => q.id), '  题目 id 全部原样保留');
  const again = await TF.importToLibrary(store2, textA, { now: '2026-09-17T11:05:00.000Z' });
  ok(again.ok, '再导入一次同一份（同 id）也不报错（覆盖）');
  eq((await E.listExams(store2)).total, 1, '  卷册里仍只有 1 份（没产生重复）');

  /* ============ ⑤ 相邻锚：与导出→导入→校对面板的闭环 ============ */
  head('⑤ 闭环：txt 解析 → 面板校对 → 导出 → 导入 → 仍需校对项一致');

  const messyParsed = P.parseText([
    '【判断】歧义题？（　）', '答案：待定',
    '【单选】零选项题？', '答案：A',
    '【简答】长答案题？', '答案：这是一个超过十八个字符的非常长的参考答案内容描述',
    '【单选】正常题？', 'A. 甲', 'B. 乙', '答案：B'
  ].join('\n'));
  const messyExam = S.createExam({
    title: '待校对卷',
    questions: messyParsed.questions.map(q => S.createQuestion(q))
  }, { now: '2026-09-17T12:00:00.000Z' });
  const beforeFlags = messyExam.questions.map(q => Review.flagsOf(q).map(f => f.id));
  eq(beforeFlags, [['judge-ambiguous'], ['too-few-options'], ['keywords-missing'], []],
     '起始：四道题的疑点分类分别是 歧义判断 / 选项不足 / 缺关键词 / 无');

  const messyText = TF.exportExam(messyExam);
  const messyBack = TF.importExam(messyText);
  ok(messyBack.ok, '含待校对项的卷子也能导出再导入', messyBack.ok ? '' : brief(messyBack.errors));
  if (messyBack.ok) {
    eq(JSON.stringify(messyBack.exam), JSON.stringify(messyExam), '  逐字段完全还原');
    eq(messyBack.exam.questions.map(q => Review.flagsOf(q).map(f => f.id)), beforeFlags,
       '**往返后疑点分类完全一致**（待校对项一个都没丢、也没多出来）');
    eq(messyBack.exam.questions.map(q => Review.needsReview(q)), [true, true, true, false],
       '  待校对判定一致');
  }

  /* ============================================================
   * ⑥ 手工编辑的真实情况（挑刺发现的两处健壮性缺陷，钉死它）
   * ============================================================ */
  head('⑥-A BOM / CRLF / 行尾空白 / 末尾换行：手工编辑过的文件必须照样能导入');

  // 基准里**故意带上内容自带的行尾空白**：容错不许把"内容"当成"手抖"吃掉
  const handExam = S.createExam({
    title: '手工编辑测试',
    questions: [
      sq({ type: '单选', stem: '题干结尾有一个空格 ', options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }],
           answer: 'B', explanation: '解析结尾也有空格  ', review: [] }),
      sq({ type: '简答', stem: '普通简答？', answer: '答案；甲甲',
           keywords: [{ text: '含尾空格 ', via: '手动' }], review: [] })
    ]
  }, { now: '2026-09-17T19:00:00.000Z' });
  const handText = TF.exportExam(handExam);

  function exact(label, t) {
    const r = TF.importExam(t);
    ok(r.ok, label + ' → 导入成功', r.ok ? '' : brief(r.errors));
    if (r.ok) eq(JSON.stringify(r.exam), JSON.stringify(handExam), '  ' + label + '：逐字段完全还原');
  }

  exact('基线（原样导出文本）', handText);
  exact('去掉文件末尾换行', handText.replace(/\n+$/, ''));
  exact('文件开头带 UTF-8 BOM（记事本默认）', '\uFEFF' + handText);
  exact('每行尾部多 3 个空格', handText.split('\n').map(l => l.length ? l + '   ' : l).join('\n'));
  exact('只给"空值行"加尾随空格', handText.split('\n').map(l => /:\s*$/.test(l) ? l + '   ' : l).join('\n'));
  exact('CRLF 行尾（Windows 记事本）', handText.replace(/\n/g, '\r\n'));
  exact('记事本全家桶：BOM + CRLF + 行尾空格',
        ('\uFEFF' + handText.replace(/\n/g, '\r\n')).split('\r\n').map(l => l.length ? l + ' ' : l).join('\r\n'));

  head('⑥-B 容错不许吃掉"内容自带的"行尾空白');

  const backHand = TF.importExam(handText);
  ok(backHand.ok, '含"内容自带行尾空白"的卷子导入成功');
  if (backHand.ok) {
    eq(backHand.exam.questions[0].stem, handExam.questions[0].stem,
       '题干结尾的空格被**保留**（区分"内容"与"手抖"）');
    eq(backHand.exam.questions[0].explanation, handExam.questions[0].explanation, '  解析结尾的空格也保留');
    // 关键词这里要和**基准**比，不要和我手写的字面量比：
    // SchemaCore.createQuestion 本来就会 trim 关键词文本（应用层既有的归一化，schema.test.js 有断言钉着），
    // 所以基准里那个关键词已经是 trim 过的。
    eq(backHand.exam.questions[1].keywords[0].text, handExam.questions[1].keywords[0].text,
       '  关键词与基准一致（关键词文本由工厂 trim，这是既有归一化）');
  }

  head('⑥-C diagnose 与 importExam 在"手工编辑过的文件"上结论一致');

  eq(TF.diagnose('\uFEFF' + handText).ok, true, 'diagnose 能吃带 BOM 的文本');
  eq(TF.diagnose(handText.split('\n').map(l => l.length ? l + '  ' : l).join('\n')).ok, true,
     'diagnose 能吃行尾空白');
  eq(TF.diagnose(handText.replace(/\n/g, '\r\n')).ok, true, 'diagnose 能吃 CRLF');
  eq(TF.diagnose('\uFEFF' + handText).questionCount, 2, '  题目数也算对');

  console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
  console.log('  PASS ' + pass + '    FAIL ' + fail);
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
