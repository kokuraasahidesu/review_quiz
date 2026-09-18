/* ============================================================
 *  verify/wrongview-ui.test.js —— 错题本**视图装配**的 Node 侧验收
 *
 *  运行： node verify/wrongview-ui.test.js
 *
 *  与 wrongview.test.js 的分工：
 *    · wrongview.test.js  —— 视图模型（core/wrong.js 的 groupOf/detailOf/jumpTarget）；
 *    · 本文件             —— 真挂载 ui/wrong-view.js（用 verify/mini-dom.js 的极简 DOM），
 *                            验"装配"这件事：挂载画了什么、刷新会不会用**最新**的卷子、
 *                            选中后详情画了什么、题被删掉时跳转按钮是否真的禁用。
 *  布局/触屏尺寸/横向溢出仍属真浏览器 → 浏览器自检.html 的 M 节。
 *
 *  为什么值得单独一个文件：`refresh()` 早先只换 books、不重建卷册映射，
 *  于是"卷子改过之后刷新视图"永远拿到旧卷子 —— 模型测不出来，只有真挂载才看得见。
 *  本文件就是这个缺陷的**锚**（配 probe-wrongview-ui-old.js 证明它会变红）。
 * ============================================================ */
const DOM = require('./mini-dom.js');
const W = require('../core/wrong.js');
const A = require('../core/attempt.js');
const Q = require('../core/quiz.js');
const S = require('../core/schema.js');

let pass = 0, fail = 0; const failures = [];
function brief(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return String(s);
  return s.length > 190 ? s.slice(0, 190) + '…(' + s.length + ' 字符)' : s;
}
function ok(c, t, d) { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + brief(d) : '')))
                         : (fail++, failures.push(t), console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + brief(d) : ''))); }
function eq(a, e, t) { const A1 = JSON.stringify(a), B = JSON.stringify(e); ok(A1 === B, t + '   期望=' + brief(B), A1); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }
const cfg = p => Q.mergeConfig(Q.DEFAULT_CONFIG, p || {});

/* 一套三题的卷，三道全答错（误答数 = 3，便于"计数是否走样"一眼看出） */
function makeExam(id, title) {
  return S.createExam({
    id: id, title: title, schemaVersion: S.SCHEMA_VERSION,
    questions: [
      S.createQuestion({ id: id + '-q1', type: '单选', stem: title + '·单选一', options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }], answerLetters: ['A'], explanation: title + '·单选一解析' }),
      S.createQuestion({ id: id + '-q2', type: '判断', stem: title + '·判断一', judgeValue: true, explanation: title + '·判断一解析' }),
      S.createQuestion({ id: id + '-q3', type: '多选', stem: title + '·多选一', options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }, { label: 'C', text: '丙' }], answerLetters: ['A', 'B'], explanation: title + '·多选一解析' })
    ]
  }, { now: '2026-10-10T00:00:00.000Z' });
}
/* 真答一遍 → 真交卷 → 真收集（与浏览器 M 节同一条路） */
function roundFor(exam, answers, now) {
  const s = A.createSession({ examId: exam.id, title: exam.title, questions: exam.questions, config: cfg({}) });
  exam.questions.forEach(function (q, i) {
    if (answers[q.id] === undefined) return;
    A.goto(s, i); A.answer(s, answers[q.id]); A.submitCurrent(s);
  });
  const fin = A.finish(s, { confirmUnanswered: true, now: now });
  const byId = {}; exam.questions.forEach(function (q) { byId[q.id] = q; });
  const book = W.createBook(exam.id, now);
  W.collect(book, fin.summary.per, { now: now, sessionAt: 'S-' + exam.id, questionsById: byId, answers: s.answers });
  return { session: s, summary: fin.summary, book: book };
}
function cloneExam(exam) { return JSON.parse(JSON.stringify(exam)); }

const WrongView = require('../ui/wrong-view.js');

const EX = makeExam('U1', 'U1 卷');
const run = roundFor(EX, { 'U1-q1': 'B', 'U1-q2': '×', 'U1-q3': 'A' }, '2026-10-11T10:00:00.000Z');

head('① 挂载：分组头、条目、次数、卷标题都画出来了（不是只算了个数）');

const doc = DOM.makeDoc();
const container = doc.createElement('div');
doc.documentElement.appendChild(container);
const jumped = [];
const mistakes = [];
let view = WrongView.mount({
  container: container, books: [{ book: run.book, exam: EX }],
  onJump: function (examId, index, t, extra) { jumped.push({ examId: examId, index: index, title: t && t.title, extra: extra }); },
  onMistake: function (examId, qid) { mistakes.push({ examId: examId, qid: qid }); }
});

eq(Object.keys(run.book.entries).sort(), ['U1-q1', 'U1-q2', 'U1-q3'], '前置：三题全错 → 本子里 3 条');
eq(view.groups().map(g => [g.examId, g.total]), [['U1', 3]], '视图模型给出 1 组 3 条');
const items = DOM.byAttr(container, 'data-wv', 'item');
eq(items.length, 3, '界面上真的画出 3 条（条目数 = 误答数）');
eq(items.map(n => n.getAttribute('data-wv-qid')), ['U1-q1', 'U1-q2', 'U1-q3'], '  每条都挂着题号（点击才知道点的是哪条）');
ok(DOM.byAttr(container, 'data-wv-root').length === 1, '  根节点挂在容器里（且只有一个）');
const headText = DOM.byClass(container, 'wv-ghead')[0].textContent;
ok(headText.indexOf('U1 卷') >= 0 && headText.indexOf('3 条') >= 0 && headText.indexOf('累计错 3 次') >= 0,
   '  分组头写着卷标题 / 条数 / 累计次数', headText);
ok(DOM.byClass(container, 'wv-head')[0].textContent.indexOf('共 3 条错题') >= 0,
   '  顶部汇总也是 3 条（两处计数同源）', DOM.byClass(container, 'wv-head')[0].textContent);
eq(DOM.byClass(container, 'wv-tile').length, 0, '没选中时**不画**磁贴（不是默认摊开第一条）');

head('② 点一条 → **磁贴内联展开在这条下面**（本题与下一题之间），详情从试卷现读');

items[0].click();
eq(view.selected(), { examId: 'U1', qid: 'U1-q1' }, '点第 1 条 → 选中状态记在视图上');
eq(DOM.byAttr(container, 'data-wv', 'item')[0].getAttribute('aria-current'), 'true', '  被点的那条标成当前项');
eq(DOM.byAttr(container, 'data-wv', 'item')[0].getAttribute('aria-expanded'), 'true', '  并标成"展开了"');
eq(DOM.byAttr(container, 'data-wv', 'item')[1].getAttribute('aria-current'), 'false', '  别的条目没被误标');
const card = DOM.byClass(container, 'wv-tile')[0];
ok(!!card, '磁贴画出来了');
eq([DOM.byClass(container, 'wv-tile').length, card.getAttribute('data-wv-qid')], [1, 'U1-q1'],
   '  而且只画了这一个（一次只开一个）');
/* ⚠ 位置是这条需求的核心：磁贴必须在**本题与下一题之间**，不是收在分组末尾、更不是弹层。
 *   结构：<li><button.wv-item></li> <li class="wv-tile-li"><div.wv-tile></li> <li>下一条… */
const listKids = DOM.byClass(container, 'wv-list')[0].children;
eq([listKids.length, listKids[0].className, listKids[1].className, listKids[2].className],
   [4, '', 'wv-tile-li', ''],
   '  列表结构 = [第1条, 磁贴, 第2条, 第3条]：磁贴紧跟被点那条（mini-dom 没有 nextSibling，用 children 下标）');
ok(listKids[1] && listKids[1].textContent.indexOf('参考答案：A') >= 0, '  磁贴里装的确实是这道题的详情');
ok(listKids[2] && listKids[2].textContent.indexOf(EX.questions[1].stem) >= 0,
   '  再往后才是**下一题**（磁贴夹在两者之间，不是分组底部）', String(listKids[2] && listKids[2].textContent).slice(0, 40));
const cardText = card.textContent;
ok(cardText.indexOf(EX.questions[0].stem) >= 0, '  原题 = 试卷里的题干（现读）', EX.questions[0].stem);
ok(cardText.indexOf('A') >= 0 && cardText.indexOf('←') >= 0, '  选项里标出了正确答案那一项');
ok(cardText.indexOf('参考答案：A') >= 0, '  参考答案：A（多选写法由 QuizCore.answerText 统一）');
ok(cardText.indexOf('U1 卷·单选一解析') >= 0, '  解析也画出来了');
ok(/答错 1 次/.test(cardText) && cardText.indexOf('你的作答：B') >= 0 && cardText.indexOf('得分：') >= 0,
   '  答错次数 / 你的作答 / 得分都在', cardText.slice(0, 60));
ok(DOM.byClass(container, 'wv-chip').length >= 1, '  历史留痕（错/对）画成了条目');

head('②-b 「跳到这道题 / 举一反三」都在磁贴里；举一反三旁边有功能小字');

const tileNow = DOM.byClass(container, 'wv-tile')[0];
ok(!!DOM.byAttr(tileNow, 'data-wv', 'jump')[0], '磁贴里有「跳到这道题」');
ok(!!DOM.byAttr(tileNow, 'data-wv', 'mistake')[0], '  也有「举一反三」');
ok(!!DOM.byAttr(tileNow, 'data-wv', 'close')[0], '  还有「收起」');
const mkBtn = DOM.byAttr(tileNow, 'data-wv', 'mistake')[0];
const hint = DOM.byClass(tileNow, 'wv-hint')[0];
/* ⚠ 文案精简过：现在是「按考点出新题，可加入本卷（需先填 API Key）」——同一件事不再写两遍 */
ok(!!hint && /考点/.test(hint.textContent) && /新题/.test(hint.textContent) && /API Key/.test(hint.textContent),
   '  举一反三按钮旁边写了功能说明小字（讲清"按考点出新题 / 要先配 Key"）', hint && hint.textContent);
const actRow = DOM.byClass(tileNow, 'wv-actions')[0];
eq(actRow.children.map(function (n) { return n.getAttribute('data-wv') || n.className; }),
   ['jump', 'mistake', 'wv-hint', 'close'],
   '  动作行的顺序 = 跳到这道题 / 举一反三 / 小字说明 / 收起（小字紧跟按钮）');

head('②-c 一次只开一个：点开新的，旧的自动收回');

DOM.byAttr(container, 'data-wv', 'item')[2].click();
eq([DOM.byClass(container, 'wv-tile').length, DOM.byClass(container, 'wv-tile')[0].getAttribute('data-wv-qid')],
   [1, 'U1-q3'], '点第 3 条 → 磁贴换成它的，**旧的自动收回**（仍然只有 1 个）');
eq(DOM.byAttr(container, 'data-wv', 'item')[0].getAttribute('aria-expanded'), 'false', '  第 1 条不再是展开态');
/* 再点同一条 = 收回（单点是开关，不是"只能开"） */
DOM.byAttr(container, 'data-wv', 'item')[2].click();
eq([DOM.byClass(container, 'wv-tile').length, view.selected()], [0, null], '再点同一条 → 收回（单点是开/关切换）');

head('②-d 双击条目 = 直接「跳到这道题」（不必先展开再点按钮）');

jumped.length = 0;
DOM.byAttr(container, 'data-wv', 'item')[1].dispatchEvent('dblclick');
eq(jumped.length, 1, '双击第 2 条 → 直接触发跳转（一次）');
eq([jumped[0].examId, jumped[0].index], ['U1', 1], '  带的是第 2 条的卷内下标 1');
eq(jumped[0].extra && jumped[0].extra.qid, 'U1-q2', '  并带上这道题的题号（答题页据此定位）');
eq(jumped[0].extra && jumped[0].extra.qids, ['U1-q1', 'U1-q2', 'U1-q3'],
   '  **还带上整组错题的 qid 列表**（答题页只出这些题 → 题目列表 = 错题本里的题）');
eq(view.stats().jumps, 1, '  视图记到 1 次跳转');

head('③ 跳转：题还在卷里 → 按钮可用，点击带回正确的卷内下标');

let jumpBtn = DOM.byAttr(container, 'data-wv', 'jump')[0];
if (!jumpBtn) { DOM.byAttr(container, 'data-wv', 'item')[0].click(); jumpBtn = DOM.byAttr(container, 'data-wv', 'jump')[0]; }
ok(!!jumpBtn && jumpBtn.disabled === false, '「跳到这道题」可用（disabled=false）');
jumped.length = 0;
jumpBtn.click();
eq([jumped[0].examId, jumped[0].index, jumped[0].title, jumped[0].extra.qid],
   ['U1', 0, 'U1 卷', 'U1-q1'], '点它 → 回调拿到 {卷, 卷内下标, 标题, 题号+整组 qid}');
eq(view.stats().jumps, 2, '  视图自己记到 2 次跳转');
const third = DOM.byAttr(container, 'data-wv', 'item')[2];
third.click();
eq(view.selected().qid, 'U1-q3', '改点第 3 条 → 选中跟着换');
DOM.byAttr(container, 'data-wv', 'jump')[0].click();
eq([jumped[1].examId, jumped[1].index], ['U1', 2], '  第 3 条跳的是卷内下标 2（不是固定第 1 题）');

head('③-b 举一反三：磁贴里的按钮 → 回调带上 {卷, 题号}');

DOM.byAttr(container, 'data-wv', 'item')[0].click();
DOM.byAttr(container, 'data-wv', 'mistake')[0].click();
eq(mistakes, [{ examId: 'U1', qid: 'U1-q1' }], '点「举一反三」→ 回调 {examId, qid}（页面据此挂 AI 面板）');
eq(view.stats().mistakes, 1, '  视图记到 1 次（stats 里能核）');

head('④ 刷新要用**最新**的卷子：改名 → 标题变；改题干 → 详情显示新版并标出提醒');

/* 改名：老实现的 refresh 只换 books、不重建卷册映射 → 标题与题干都会停在挂载那一刻 */
const renamed = cloneExam(EX); renamed.title = 'U1 卷（改名后）';
view.refresh([{ book: run.book, exam: renamed }]);
eq(view.groups()[0].title, 'U1 卷（改名后）', '卷子改名 → 刷新后分组标题跟着变');
ok(DOM.byClass(container, 'wv-ghead')[0].textContent.indexOf('U1 卷（改名后）') >= 0,
   '  界面上看到的也是新标题', DOM.byClass(container, 'wv-ghead')[0].textContent);
ok(DOM.byClass(container, 'wv-ghead')[0].textContent.indexOf('U1 卷（改名后）') >= 0
   && !/U1 卷[^（]/.test(DOM.byClass(container, 'wv-ghead')[0].textContent),
   '  旧标题没和新标题混着显示');

/* 改题干：详情必须现读卷子里的新版，并把"改过了"标出来 */
const snapshotStem = run.book.entries['U1-q1'].stem;
const mutated = cloneExam(EX); mutated.title = 'U1 卷';
mutated.questions[0].stem = '【改后】这道题的题干被改过了';
view.refresh([{ book: run.book, exam: mutated }]);
view.select('U1', 'U1-q1');
const card2 = DOM.byClass(container, 'wv-tile')[0].textContent;
const stem2 = DOM.byAttr(DOM.byClass(container, 'wv-tile')[0], 'data-wv', 'stem')[0];
eq(stem2.textContent, mutated.questions[0].stem,
   '详情里画出来的"原题"**逐字等于**卷子里的最新题干（用 data-wv="stem" 精确比对，不做子串猜测）');
ok(card2.indexOf('题干已经改过了') >= 0, '  并且显式标出「试卷里的题干已经改过了」');
ok(stem2.textContent !== snapshotStem, '  画出来的不是旧快照（' + brief(snapshotStem) + '）');
ok(DOM.byClass(container, 'wv-item')[0].textContent.indexOf(snapshotStem) >= 0,
   '  但列表里仍是当时那道题的快照（留档对照）', snapshotStem);

head('⑤ 题被删掉 → 禁用跳转，点了也不回调，并给出快照存档');

const deleted = 'U1-q3';
const delSnapshot = run.book.entries[deleted].stem;
const cut = cloneExam(EX);
cut.questions = cut.questions.filter(function (q) { return q.id !== deleted; });
view.refresh([{ book: run.book, exam: cut }]);
view.select('U1', deleted);
const card3 = DOM.byClass(container, 'wv-tile')[0].textContent;
const stem3 = DOM.byAttr(DOM.byClass(container, 'wv-tile')[0], 'data-wv', 'stem')[0].textContent;
const jumpedBefore = jumped.length;
ok(card3.indexOf('不在试卷里') >= 0, '  详情如实说明"这道题已经不在试卷里了"', card3.slice(0, 40));
ok(stem3.indexOf('（原题已不在试卷里）快照：' + delSnapshot) === 0,
   '  原题那一行换成了**快照存档**（并写明原题已不在试卷里）', stem3);
ok(card3.indexOf('参考答案：（不可用）') >= 0, '  参考答案不装样子（没有原题就写"不可用"）', card3.slice(0, 80));
jumpBtn = DOM.byAttr(container, 'data-wv', 'jump')[0];
ok(!!jumpBtn && jumpBtn.disabled === true, '「跳到这道题」被禁用');
jumpBtn.click();
eq(jumped.length, jumpedBefore, '  点禁用按钮**不会**触发跳转回调（mini-dom 也照 DOM 语义不派发 click）');

head('⑥ 卷不在册 / 空本子 / destroy：边界都要交代清楚');

const ghostBook = run.book;
view.refresh([{ book: ghostBook, exam: null }]);
ok(DOM.byClass(container, 'wv-ghead')[0].textContent.indexOf('未入册') >= 0,
   '卷已不在册 → 分组仍显示（数据不能因为卷没了就消失），并附提醒',
   DOM.byClass(container, 'wv-ghead')[0].textContent);
eq(view.groups()[0].examFound, false, '  模型里 examFound=false');

view.refresh([]);
eq(view.groups().length, 0, '换成空列表 → 分组为 0');
ok(container.textContent.indexOf('还没有错题') >= 0, '  给出明确的空态提示（不是一片空白）',
   container.textContent.slice(0, 50));
eq(DOM.byAttr(container, 'data-wv', 'item').length, 0, '  一条也没画');

view.destroy();
eq(DOM.byAttr(container, 'data-wv-root').length, 0, 'destroy() 之后视图从容器里摘干净');
eq(DOM.byClass(container, 'wv-root').length, 0, '  类名节点也没残留');
eq(DOM.byTag(doc.head, 'style').length, 1, 'CSS 只注入一次（多个视图共用同一份，不重复插）');

/* 再挂一个：确认 destroy 之后还能重新挂上（不是"一次性用完即废"） */
view = WrongView.mount({ container: container, books: [{ book: run.book, exam: EX }],
                         onJump: function (examId, index) { jumped.push({ examId: examId, index: index }); } });
eq(DOM.byAttr(container, 'data-wv', 'item').length, 3, '重新挂载 → 又能正常画 3 条');
eq(DOM.byTag(doc.head, 'style').length, 1, '  第二个视图没有重复插 CSS（仍只有 1 份）');

console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
console.log('  PASS ' + pass + '    FAIL ' + fail);
if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
console.log('  \x1b[90m注：真浏览器里的布局/触屏尺寸/横向溢出 → 见 浏览器自检.html 的 M 节\x1b[0m');
process.exitCode = fail ? 1 : 0;
