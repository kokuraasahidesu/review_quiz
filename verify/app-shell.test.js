/* ============================================================
 *  verify/app-shell.test.js —— 「答题全能版」（合并成一个文件）小类验收（verify=self）
 *
 *  运行： node build.js && node verify/app-shell.test.js
 *
 *  三条验收标准：
 *    ① 只要**一个** HTML 文件：三个面板（答题 / 导入校对 / 错题本）都在里面，零外部引用；
 *    ② 面板之间**互不打架**：同一份文档里 id 不重复、各面板只看自己的元素、切页签能刷新；
 *    ③ 合并版**不复制页面逻辑**：三段代码来自原模板（改一次三处都对），且合并后导出分享仍可用。
 *
 *  ⚠ 诚实分层：静态断言管"结构没走样"，**行为**（真点三个页签、面板真挂载、答题→交卷→错题本串起来）
 *    由真浏览器走查覆盖（见报告第三十五节 + `verify/__app.png` 截图）。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const D = require('../core/data.js');
const S = require('../core/schema.js');

const HERE = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(HERE, 'review_quiz.html'), 'utf8');
const TPL = fs.readFileSync(path.join(HERE, 'app-template.html'), 'utf8');
const BUILD = fs.readFileSync(path.join(HERE, 'build.js'), 'utf8');
const WRONG_TPL = fs.readFileSync(path.join(HERE, 'wrong-template.html'), 'utf8');
const VIEW = fs.readFileSync(path.join(HERE, 'ui', 'attempt-view.js'), 'utf8');   // 答题界面（底部快捷面板在这）

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
function count(s, needle) { return s.split(needle).length - 1; }

head('① 一个文件装下三个面板：结构齐全、零外部引用');

ok(APP.length > 500000, '合并版是个实打实的大文件（三份核心 + 三段页面逻辑都在里面）',
   Math.round(Buffer.byteLength(APP, 'utf8') / 1024) + ' KB');
eq(D.externalRefsIn(APP), [], '**零外部引用**（断网双击就能用）');
eq(count(APP, '<section class="pane"'), 3, '恰好三个面板（答题 / 导入校对 / 错题本）');
eq(count(APP, 'role="tab"'), 3, '恰好三个页签');
['pane-answer', 'pane-review', 'pane-wrong'].forEach(function (id) {
  ok(count(APP, 'id="' + id + '"') === 1, '面板 ' + id + ' 在（且只出现一次）');
});
['ansHost', 'revStage', 'wrongHost'].forEach(function (id) {
  ok(count(APP, 'id="' + id + '"') === 1, '各面板有**自己的**宿主元素：' + id);
});
/* 三个视图都真的被挂载（不是把代码搬进来却不接） */
ok(/AttemptView\.mount\(/.test(APP), '答题面板挂了 AttemptView');
ok(/WrongView\.mount\(/.test(APP), '错题本面板挂了 WrongView');
ok(/ReviewPanel\.mount\(|\bpanel = ReviewPanel\.mount\(/.test(APP) || /ReviewPanel\.mount\(/.test(APP),
   '导入/校对面板挂了 ReviewPanel');
ok(/QuickPanel\.mount\(/.test(APP), '底部快捷面板也在（答题面板内）');

head('② 面板之间互不打架：id 唯一、只看自己、切页签会刷新');

/* ⚠ 只扫**脚本之前**的 HTML：内联进来的核心源码里也有 `id="…"` 这种字符串（那是 JS 字面量，不是元素），
 *   一起扫会误报。真正的合并风险只在页面标记这一层。
 * ⚠ 起点取 `<body>`：`<head>` 里现在排着一段「启动自检」脚本（app-template.html 顶部，必须在最前），
 *   从"第一个 <script>"一刀切会把 body 标记整个切掉，这条检查就变成空转。 */
const BODY_AT = APP.indexOf('<body');
const HTML_ONLY = APP.slice(BODY_AT < 0 ? 0 : BODY_AT, APP.indexOf('<script>', BODY_AT < 0 ? 0 : BODY_AT));
const ids = (HTML_ONLY.match(/\sid="([^"]+)"/g) || []).map(function (s) { return s.replace(/\sid="/, '').replace(/"$/, ''); });
const dup = Array.from(new Set(ids.filter(function (v, i) { return ids.indexOf(v) !== i; })));
eq(dup, [], '**页面标记里没有一个重复 id**（重复 id 会让 getElementById 抓错面板：' + ids.length + ' 个 id）');
eq(count(HTML_ONLY, 'id="host"') + count(HTML_ONLY, 'id="file"') + count(HTML_ONLY, 'id="tip"'), 0,
   '原来的裸 id（host / file / tip）在合并版里**一个都不剩**（全部加了面板前缀）');
eq(count(APP, 'RUN_PANE('), 4, 'RUN_PANE 出现 4 次（1 处定义 + 3 处调用）');
['RUN_PANE(\'answer\'', 'RUN_PANE(\'review\'', 'RUN_PANE(\'wrong\''].forEach(function (s) {
  ok(APP.indexOf(s) >= 0, '三个面板各跑一次作用域逻辑：' + s + ')');
});
ok(/getElementById: function \(id\) \{ return pane\.querySelector\('#/.test(APP) || /return pane\.querySelector\('#'/.test(APP),
   '作用域化的 document 把 getElementById 重定向到**本面板**');
ok(/mapSelector/.test(APP) && /replace\(\/#\(\[A-Za-z0-9_-\]\+\)\/g/.test(APP),
   '选择器里的 `#id` 会按 idMap 换成带前缀的真实 id（`$(\'#stage\')` 这类写法才落得进面板）');
ok(/createElement: function \(t\) \{ return document\.createElement\(t\); \}/.test(APP),
   '  但 createElement 用**真的** document（元素必须属于主文档）');
ok(/function showTab\(key\)/.test(APP) && /APP_PANES\[k\]\.hidden = \(k !== key\)/.test(APP),
   '切页签 = 只显示目标面板（其余 hidden）');
ok(/if \(key === 'wrong' && typeof window\.__wrongRefresh === 'function'\) window\.__wrongRefresh\(\);/.test(APP),
   '**切到错题本会重新读盘**（否则刚交卷收进来的错题看不见）');
ok(/window\.__wrongRefresh = function \(\) \{ showList\(\)/.test(WRONG_TPL),
   '错题本模板确实暴露了 __wrongRefresh（合并版与独立页共用同一份逻辑）');
/* 载荷文件（别人分享来的）打开后要直接进答题面板 */
ok(/DataCore\.extractPayload\(document\.documentElement\.outerHTML\)/.test(APP) &&
   /if \(hasPayload\)[\s\S]{0,120}showTab\('answer'\)/.test(APP),
   '这份文件自带分享载荷时 → 启动即切到答题面板');

/* ---- 手机端「打开看不了」的兜底（用户实测报障：导出带的试卷在别的浏览器里打不开） ----
 * 这类缺陷最坏的地方是**静默**：白屏 = 用户只能说"看不了"，出题者拿不到任何线索。
 * 所以：① 兜底自检脚本必须排在所有代码之前且只写 ES5；② 启动失败要当面用中文说清楚；
 *      ③ 载荷"读得出来但坏了"也要说话（以前默默落回空题库 → 用户以为"打开了，就是没试卷"）。 */
const diagAt = APP.indexOf('__quizDiag');
const zipAt = APP.indexOf('内联开始：core/parse/zip.js');
ok(diagAt >= 0 && zipAt > diagAt, '启动自检脚本排在**所有**内联核心之前（onerror 要抢在别人抛错之前注册）',
   'diag@' + diagAt + ' zip@' + zipAt);
const diagBlock = APP.slice(APP.indexOf('<script>'), APP.indexOf('</script>'));
const diagCode = diagBlock.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok(diagBlock.length > 800 && !/=>|\blet\b|\bconst\b|`/.test(diagCode),
   '  而且它只写 ES5（老引擎连这段都解析不了的话，就没有任何兜底了）',
   (diagCode.match(/=>|\blet\b|\bconst\b|`/g) || []).slice(0, 3).join(' '));
ok(/window\.__quizBooted = true/.test(APP), '启动成功会插旗 __quizBooted（自检据此区分"白屏"与"正常"）');
/* 壳这边读载荷也得等解析完：载荷块被插在 `</body>` 之前，也就是这段脚本后头 —— 同一个坑 */
ok(/function bootShell\(\)[\s\S]{0,1400}readyState === 'loading'\) document\.addEventListener\('DOMContentLoaded', bootShell\)/.test(APP),
   '  壳判断"这份文件自带载荷吗"也**等 DOM 解析完**（否则读到的 outerHTML 里没有载荷块）');
ok(APP.indexOf("if (hasPayload) showTab('answer')") < APP.indexOf('window.__quizBooted = true'),
   '  插旗排在切面板**之后**（切面板自己就抛错 → 照样算"没启动"）');
ok(/没能在当前浏览器里启动/.test(APP) && /复制诊断信息/.test(APP),
   '  没插旗 → 顶部铺一块中文红条 + 「复制诊断信息」（白屏变成用户能一句话反馈的东西）');
ok(/<noscript>/.test(APP) && /JavaScript/.test(APP), '脚本被关掉的浏览器（手机自带 HTML 查看器）也留了一句中文说明');
ok(/else if \(PAYLOAD_BAD\)[\s\S]{0,700}tip\.style\.color = '#b42318'/.test(APP) && /DataCore\.extractPayloadDetailed\(/.test(APP),
   '分享载荷**读得出来但坏了**（改坏/截断）时当面报原因，不再默默落回空题库');
ok(/手机上打开/.test(APP), '导出成功的回执里写了"手机上怎么打开"（免得用户以为文件坏了）');

/* 「导入之后答不了题」的回归锚（用户实测报障）：导入入库的卷必须有地方能答。
 * 三条链缺一不可：① 答题面板能从题库列卷并挂上；② 切回答题页会刷新套数；③ 入库回执能一键转交。 */
ok(/ExamsCore\.listExams\(store/.test(APP) && /className = 'libpick'/.test(APP),
   '答题面板能从**题库**列卷（导入入库的卷就存在那儿）—— 而且题库就是**首页**（默认就显示）');
ok(/window\.__answerBoot = function \(examId\)/.test(APP) && /QuizCore\.resolveConfig\(null, exam\)/.test(APP),
   '  并把它挂成一轮作答（判分口径跟着卷自己的配置走）');
ok(/if \(key === 'answer' && typeof window\.__answerRefresh === 'function'\) window\.__answerRefresh\(\);/.test(APP),
   '切回答题页会刷新「从题库选题（N）」上的套数（刚入库的卷要立刻能看到）');
ok(/window\.__answerLoadExam = function \(examId\)/.test(APP) && /showTab\('answer'\)/.test(APP),
   '合并版提供 __answerLoadExam：切页签 + 转交（**不在答题面板里重复实现**）');
ok(/已入库：[\s\S]{0,400}gopractice/.test(APP) || /gopractice/.test(APP),
   '入库成功的回执旁边有「去答题」直达按钮（独立单页版没有这个钩子 → 按钮不出现）');
ok(/id: 'answer'/.test(APP) === false && /libpick/.test(APP) && count(APP, 'id="libpick"') === 0,
   '题库面板是**运行时动态创建**的（不写死 id → 不必进 idMap，也不会与别的面板撞 id）');

/* 抽题（pickQuestions）接进答题流程：题库每套卷「开始作答」→ 先进"答卷前设置"页 → 再开答 */
/* ⚠ 判据跟着功能走：drawRound 现在是 `pickQuestions(questions, c, 档位表)`（"未作答优先"那一轮加的
 *   第三个参数）—— 所以这里锚**调用关系**（drawRound 里确实把题目和配置交给 pickQuestions），
 *   而不是某一种写法的字面量，否则加个参数就会误报"抽题引擎没人调"。 */
ok(/QuizCore\.pickQuestions\(questions, c[,)]/.test(APP) && /function drawRound\(/.test(APP),
   '答题页真的调用抽题引擎（pickQuestions）—— 在此之前它**零调用者**，面板上的设置等于空转');
ok(/'开始作答'/.test(APP) && !/'答整卷'/.test(APP) && !/'抽一轮'/.test(APP),
   '题库每套卷的那个按钮叫「开始作答」（原来的「答整卷 / 抽一轮」两个按钮已合并成一个；注释里提到旧名不算）');
ok(/async function openPickSettings\(examId\)/.test(APP) && /data-pk', 'start'/.test(APP),
   '点它先进"答卷前设置"页（改完点「开始作答」才开始 — 不再点一下就开抽）');
ok(/groups: \['抽题与题量', '分数线', '判分'\]/.test(APP),
   '设置页把**抽题与题量 + 分数线 + 判分**三组都画出来（判分是新增的：多选全对/半对得分）');
ok(/excludeGroups: \['抽题与题量', '分数线', '判分'\]/.test(VIEW) && /excludeGroups: \['抽题与题量', '分数线', '判分'\]/.test(APP),
   '答题时的底部快捷面板把这三组**排除**掉（设置只有设置页一处能改；改了也不换正在答的题）');
ok(/if \(o\.excludeGroups && o\.excludeGroups\.length\)/.test(APP),
   '  面板真的实现了 excludeGroups 过滤（不是传了个没人认的参数 —— 那样等于没排除）');
ok(/QuizCore\.adaptPickToBank\(all, base\)/.test(APP) && /pk-zero/.test(APP),
   '打开设置页时按题库构成适配：没有的题型自动置 0，并当面说明动了哪一型');
ok(/'all'/.test(APP) && /modeAll/.test(APP),
   '「全部作答」走 mode=all（不抽题、整套卷都做 —— 它就是原来那个「答整卷」）');
ok(/roundTag/.test(APP) && /roundTag: roundTag/.test(APP),
   '轮次标记传进进度存储（全部作答与抽题各存各的，不互相覆盖）');
ok(/async function redrawRound\(seedDelta\)/.test(APP) && /view\.session\(\)\.config/.test(APP),
   '「继续这一轮」用的是**当前会话的配置**（那一轮的设置原样，进度接着答）');
ok(/换一批/.test(APP) && /seed: seed/.test(APP), '「换一批」= 种子 +1（同一套卷换一批题）');
ok(/改设置再做一轮/.test(APP) && /openPickSettings\(roundCtx\.examId\)/.test(APP),
   '首页「上一轮」那行给的是「改设置再做一轮」→ 回设置页改（不再在答题界面改抽题）');

/* 主页形态（用户要求：工具不折叠 / 题库就是首页 / 答题中能返回 / 不默认加载内置样卷） */
ok(/function loadSample\(\)/.test(APP) && /载入内置样卷/.test(APP),
   '内置样卷改成首页底部的按钮（手动点，不再默认加载）');
ok(/function showHome\(\)/.test(APP) && /showHome\(\);[\s\S]{0,120}已回到题库首页/.test(APP),
   '答题面板默认落在题库首页（启动路径上不再自动建会话）');
ok(/async function goHome\(\)/.test(APP) && /homeBtn\.addEventListener\('click'/.test(APP),
   '答题中有「返回题库」：冲掉未落盘的进度 → 拆掉作答界面 → 回首页');
ok(/roundCtx\.cfg = QuizCore\.snapshotConfig\(view\.session\(\)\.config\);/.test(APP),
   '回首页前记下当前这一轮的设置（否则"答题时改设置 → 回首页 → 重开一轮"会按旧设置重抽）');
ok(/showHomeChrome\(false\)/.test(APP) && /homeBtn\.hidden/.test(APP),
   '「返回题库 / 导出」只在答题中出现（没有一轮可导出时不摆着让人误点）');
ok(/seq === roundSeq/.test(APP) && /function cancelFlash\(\)/.test(APP),
   '换轮次后不再冒"已自动保存"把新提示语盖回去（实测踩过：标题 9 题、提示语还说整卷）');

head('③ 合并版不复制逻辑：三段代码来自原模板，且合并后仍能导出分享');

[['answer-template.html', '答题'], ['review-template.html', '导入 / 校对'], ['wrong-template.html', '错题本']].forEach(function (p) {
  ok(APP.indexOf('以下这段来自 ' + p[0]) >= 0, '面板「' + p[1] + '」的逻辑来自 ' + p[0] + '（装配时打了来源标记）');
  ok(APP.indexOf('页面逻辑结束') >= 0, '  且有结束标记（三段都装配完整）');
});
eq(count(APP, 'const SHARED_SAMPLE_B64 = '), 1, '内置样卷 base64 **只内联一次**（三段共用，不再各带一份）');
eq(count(APP, 'const SAMPLE_B64 = SHARED_SAMPLE_B64;'), 3, '  三段页面逻辑都指向这一份（答题 / 校对 / 错题本）');
ok(/assembleApp/.test(BUILD) && /pageCodeOf/.test(BUILD), 'build.js 里有装配函数（合并版由构建期生成，不手抄）');
ok(/id 重复/.test(BUILD), '  构建期就会拦重复 id（早失败，不留到运行期）');
/* 合并版当分享壳：导出的文件仍然是一个文件、零外部引用、能读回该试卷 */
const EXAM = S.createExam({ id: 'APP1', title: '合并版导出卷', configLocked: true, questions: [
  S.createQuestion({ id: 'APP1-q1', type: '单选', stem: '合并版里导出的题？',
    options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }], answerLetters: ['B'], answer: 'B' })
] }, {});
const r = D.exportStandalone({ exams: [EXAM] }, APP, { examId: 'APP1', at: '2026-11-04T10:00:00.000Z', secrets: [] });
eq([r.ok, D.externalRefsIn(r.html)], [true, []], '拿合并版当壳导出：成功且零外部引用', r.ok ? r.filename : r.message);
eq([D.payloadBlockCount(r.html).blocks, D.extractPayload(r.html).exams[0].id], [1, 'APP1'],
   '  导出文件里只有 1 个载荷块，读回来就是这份卷');
ok(r.html.indexOf('答题全能版') >= 0 && r.html.indexOf('id="pane-wrong"') >= 0,
   '  导出的仍然是一个**带全部三个面板**的单文件');

console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
console.log('  PASS ' + pass + '    FAIL ' + fail);
if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
console.log('  \x1b[90m注：行为面（真点三个页签 / 面板真挂载 / 答题→交卷→错题本）由真浏览器走查覆盖，见报告第三十五节\x1b[0m');
process.exitCode = fail ? 1 : 0;
