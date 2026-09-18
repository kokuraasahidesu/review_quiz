/* ============================================================
 *  verify/wiring.test.js —— 页面**接线**锚（成品 HTML 的静态检查）
 *
 *  运行： node verify/wiring.test.js      （依赖 `node build.js` 的产物）
 *
 *  为什么单独一个文件：核心模块/视图各自都有穷举测试，但"**页面到底有没有把它们接上**"
 *  一直没人盯 —— 这类缺陷最阴：
 *    · 答题页的 `onFinish` 若不再调 `WrongCore.collectToStore`，交卷后错题**永远不会进本**，
 *      而 `wrong.test.js` 依旧全绿（它测的是函数，不是页面）；
 *    · 错题本页若绕过弹窗直接 `deleteExam(store, id, {policy:'cascade'})`，
 *      或者干脆调了个不带政策的版本，**询问就被跳过了**，而 `delete-cascade.test.js` 也依旧全绿。
 *
 *  ⚠ 诚实说明边界：这是**静态接线**证据（"代码里确实这么接的"），
 *    不是运行时证据。运行时由 `浏览器自检.html` 的 M/N 节（真交卷/真弹窗）+ 用户点击覆盖。
 * ============================================================ */
const fs = require('fs');
const path = require('path');

const HERE = path.join(__dirname, '..');
let pass = 0, fail = 0; const failures = [];
function brief(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return String(s);
  return s.length > 190 ? s.slice(0, 190) + '…(' + s.length + ' 字符)' : s;
}
function ok(c, t, d) { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + brief(d) : '')))
                         : (fail++, failures.push(t), console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + brief(d) : ''))); }
function eq(a, e, t) { const A = JSON.stringify(a), B = JSON.stringify(e); ok(A === B, t + '   期望=' + brief(B), A); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }

const ANSWER = fs.readFileSync(path.join(HERE, '答题页.html'), 'utf8');
const WRONG = fs.readFileSync(path.join(HERE, '错题本.html'), 'utf8');
const REVIEW = fs.readFileSync(path.join(HERE, '校对面板.html'), 'utf8');

/* 数某个调用在成品里出现几次（字面量匹配，够用且不会被注释干扰） */
function countCall(src, needle) { return src.split(needle).length - 1; }

/* ============================================================
 *  audit(答题页源码, 错题本页源码) → [[是否通过, 说明, 附注], …]
 *
 *  抽成函数是为了**让探针能拿同一套判据去跑被改坏的源码**
 *  （verify/probe-wiring-old.js：把接线拆掉，对应断言必须变红）。
 *  探针里重写一遍判据是不行的 —— 那样两边迟早各说各话。
 * ============================================================ */
/* ⚠ 第四个参数是**合并版成品**（review_quiz.html）：外壳那几条锚（底部固定栏的搬移、页签折叠…）
 *   只存在于合并版里。**必须走参数**（而不是在这个函数里 fs.readFileSync）——
 *   否则反向探针没法把"改坏的合并版"传进来，那几条锚就成了无法证伪的空气。 */
function audit(ANSWER, WRONG, REVIEW, APPSHELL) {
  APPSHELL = APPSHELL || fs.readFileSync(path.join(HERE, 'review_quiz.html'), 'utf8');
  const checks = [];
  const ok = (c, t, d) => checks.push([!!c, t, d]);
  const eq = (a, e, t) => checks.push([JSON.stringify(a) === JSON.stringify(e), t, JSON.stringify(e) + ' ← 实际 ' + JSON.stringify(a)]);


ok(ANSWER.indexOf('WrongCore.collectToStore(') >= 0, '答题页确实调了 WrongCore.collectToStore（唯一的写入口）');
eq(countCall(ANSWER, 'WrongCore.collectToStore('), 1, '  全页只有 1 个写入口（不多头写，避免两套口径）');
ok(/onFinish: function \(summary\) \{ clearProgress\(\); collectWrong\(summary\);/.test(ANSWER),
   '  交卷回调里**顺手**调 collectWrong（用户不需要再点一次"保存错题"）',
   (ANSWER.match(/onFinish:[^\n]*/) || [''])[0]);
ok(/results: \(summary && summary\.per\) \|\| \(view\.session\(\)\.summary \|\| \{\}\)\.per \|\| \[\]/.test(ANSWER),
   '  传给错题本的 results **就是**交卷结算的 per（同一真相源，不另算一次分）',
   (ANSWER.match(/results:[^\n]*/) || [''])[0]);
ok(/questionsById: byId/.test(ANSWER) && /answers: view\.session\(\)\.answers/.test(ANSWER),
   '  一起带上 questionsById / answers（条目才有题型、题干与你当时的作答）');
ok(/sessionAt:/.test(ANSWER), '  带上 sessionAt（幂等键：双击交卷不会把次数算两遍）');
ok(ANSWER.indexOf('WrongCore.saveBook(') < 0 && ANSWER.indexOf("store.set(DataCore.wrongKey") < 0,
   '  页面**没有**绕过 collectToStore 自己写错题本（也没有手拼 wrong:: 键）');
ok(ANSWER.indexOf('WrongCore') >= 0 && ANSWER.indexOf('collectWrong') >= 0
   && ANSWER.indexOf('WrongCore.collectToStore(') > ANSWER.indexOf('async function collectWrong'),
   '  collectWrong 的定义在调用之前（顺序上不会用到未定义）');


ok(WRONG.indexOf('DeleteDialog.mount(') >= 0, '错题本页挂的是 DeleteDialog（真弹窗，不是 window.confirm 一句话）');
eq(countCall(WRONG, 'DeleteDialog.mount('), 1, '  只有一处弹窗入口');
ok(WRONG.indexOf('window.confirm') < 0, '  没有用 window.confirm 糊过去（那东西说不清两个选项的后果）');
ok(WRONG.indexOf('ExamsCore.deletePreview(') >= 0
   && WRONG.indexOf('ExamsCore.deletePreview(') < WRONG.indexOf('DeleteDialog.mount('),
   '  先 deletePreview 读出"会删掉什么"，再弹窗（顺序正确）');
ok(/prompt: pv\.plan/.test(WRONG), '  弹窗吃的是询问模型（文案只此一份，页面不自己拼）');
ok(/onChoose: function \(policy\) \{ runDelete\(examId, policy, pv\.title\); \}/.test(WRONG),
   '  用户的选择直接进 runDelete（选什么就执行什么，不二次改写）',
   (WRONG.match(/onChoose:[^\n]*/) || [''])[0]);
ok(/onCancel: function \(\) \{ if \(dialog\) \{ dialog\.destroy\(\); dialog = null; \} tip\.textContent = '已取消：什么都没删'; \}/.test(WRONG),
   '  取消路径只销毁弹窗 + 提示"什么都没删"（不碰存储）');

/* 每一个 deleteExam 调用点都**必须**带显式政策：漏一个就等于多一条静默删除路径 */

function deleteCallSites(src) {
  const out = [];
  let at = src.indexOf('ExamsCore.deleteExam(');
  while (at >= 0) {
    out.push(src.slice(at, at + 160).replace(/\s+/g, ' '));
    at = src.indexOf('ExamsCore.deleteExam(', at + 1);
  }
  return out;
}
const sitesAnswer = deleteCallSites(ANSWER);
const sitesWrong = deleteCallSites(WRONG);
/* ⚠ 早先这里是"答题页不删卷（0 处）"——用户后来要求在**题库首页**也能删卷，于是答题页也有了一处。
 *   松动这条时**判据不许跟着松**：下面三条把"删卷必须问清政策"的规矩原样搬到答题页。 */
eq([sitesAnswer.length, sitesWrong.length], [1, 1], '答题页与错题本各只有 1 处执行删除（唯一入口）');
ok(sitesAnswer.concat(sitesWrong).every(s => /policy:/.test(s)), '**每一处都带 policy**（没有任何一处依赖默认行为）',
   sitesAnswer.concat(sitesWrong).join(' | '));
ok(ANSWER.indexOf('ExamsCore.deletePreview(') >= 0
   && ANSWER.indexOf('ExamsCore.deletePreview(') < ANSWER.indexOf('DeleteDialog.mount('),
   '答题页删卷也先 deletePreview 读出"会删掉什么"，再弹窗（顺序正确）');
ok(ANSWER.indexOf('window.confirm') < 0, '  答题页同样没用 window.confirm 糊过去');
/* ⚠ 答题页现在有**三处** DeleteDialog 挂载点：删卷 / 「清除答题记录」/「返回题库」的二级确认
 *   （用户要求"返回题库按钮加一个二级确认弹窗"）。三处都用同一个（不另写确认框）；
 *   错题本那边仍然只有一处。 */
ok(countCall(ANSWER, 'DeleteDialog.mount(') === 3 && countCall(WRONG, 'DeleteDialog.mount(') === 1,
   '答题页三处（删卷 / 清除答题记录 / 返回题库确认）、错题本一处，用的都是**同一个** DeleteDialog（文案只此一份）');
ok(/function askGoHome\(\)/.test(ANSWER) && /homeBtn\.addEventListener\('click', function \(\) \{ askGoHome\(\); \}\)/.test(ANSWER),
   '「返回题库」按钮点了先走 askGoHome（二级确认），不是直接 goHome',
   (ANSWER.match(/homeBtn\.addEventListener\('click'[^\n]*/) || [''])[0]);
ok(/title: '返回题库？'/.test(ANSWER) && /cancelLabel: '继续作答'/.test(ANSWER)
   && /已答 ' \+ st\.answered \+ ' \/ ' \+ st\.total/.test(ANSWER),
   '  确认框写清"这一轮已答几题 / 还有几题没答"，取消 = 「继续作答」');
/* 底部快捷面板：标题可缺省 + 折叠按钮写着「展开设置 / 收起设置」（用户要求） */
ok(/const title = \(o\.title === undefined\) \? '快捷设置' : o\.title;/.test(ANSWER) && /if \(title\) head\.appendChild/.test(ANSWER),
   '快捷面板：标题可缺省（`undefined` 用缺省文案，给**空串**就一个标题字都不画）');
eq(countCall(ANSWER, "        title: '',"), 1,
   '答题界面的底部面板明确传了空标题（用户要求去掉「快捷设置」那四个字，它被「返回题库」压住）');
ok(/'展开设置' : '收起设置'/.test(ANSWER) && !/\? '展开' : '收起';/.test(ANSWER),
   '  折叠按钮写着「展开设置 / 收起设置」（用户要求把「展开」改掉）');
/* 用户要求：翻页等待那一档选完后**不要**再弹一句「N 毫秒后翻」的绿字（选中的档本来就有高亮）。
 * ⚠ 判据看的是**那行旧代码没了**（`return '自动翻页等待：…'`），不能扫全文件找"毫秒后翻"——
 *   我们自己的注释里就写着"不要那句 N 毫秒后翻"，扫全文件必然假红（第一版就这么红的）。 */
ok(/if \(id === 'autoNextMs'\) return '';/.test(ANSWER)
   && ANSWER.indexOf("return '自动翻页等待：'") < 0,
   '改「翻页等待」时**不再**回一句「N 毫秒后翻」的绿字（用户要求）',
   (ANSWER.match(/if \(id === 'autoNextMs'\)[^\n]*/) || [''])[0]);
/* ---- ⑮ 答题计时（悬浮球 + 可暂停）与判分两组（用户要求） ---- */
ok(/\.av-timer\{position:fixed;right:14px;bottom:86px;bottom:calc\(env\(safe-area-inset-bottom, 0px\) \+ 86px\)/.test(ANSWER)
   && /\.av-timer\.paused\{/.test(ANSWER),
   '计时球是**固定定位**的（不占排版位置），并在右下角「交卷」FAB 上方，还抬过了手机自己的底栏',
   (ANSWER.match(/\.av-timer\{[^\n]*/) || [''])[0]);
ok(/'title', t\.paused \? '已暂停 · 点一下继续'/.test(ANSWER) && /data-av', 'timer'/.test(ANSWER),
   '  球上有点击暂停/继续的处理（title/aria-label 都说清状态）');
ok(/session\.timer = \{ ms: 0, paused: false \}/.test(ANSWER) && /timer: \{\s*ms:/.test(ANSWER),
   '计时状态住在 session.timer 里（随进度一起存本机 → 刷新/继续这一轮不归零）');
ok(/if \(payload\.timer && typeof payload\.timer === 'object'/.test(ANSWER),
   '  进度恢复时也把计时读回来');
ok(/id: 'timer', label: '答题计时（悬浮球）'/.test(ANSWER), '面板上有「答题计时（悬浮球）」开关');
ok(/id: 'points.多选', label: '多选全对得分'/.test(ANSWER) && /id: 'multi\.halfScore', label: '多选半对得分'/.test(ANSWER),
   '「判分」组两行：多选全对得分 / 多选半对得分（都能自己调）');
ok(/add\('grade\.pass', '及格比例'/.test(ANSWER) && /unit: '%' \}\)/.test(ANSWER),
   '分数线在字段模型里已改叫**比例**（unit=%）');
/* 用户要求：「重新生成试卷」（原「再抽一次」）挪到「返回题库」旁边 —— 两颗都在底部固定栏里。
 * ⚠ 外壳（app-template）的内容在成品里也有一份，所以直接扫**合并版成品**里的这两段字符串。 */
const APP_SHELL = APPSHELL;
ok(/id="ansRedraw" hidden>重新生成试卷</.test(APP_SHELL) && /id="ansHome" hidden>返回题库</.test(APP_SHELL),
   '底部固定位那两颗按钮都在答题面板里（返回题库 → 重新生成试卷），载入后被搬进 #ansBottomSlot');
ok(/btnRedraw: 'ansRedraw'/.test(APP_SHELL), '  合并版把页面的 `btnRedraw` 映射到外壳的 `#ansRedraw`（idMap 里登记过）');
ok(/slot\.appendChild\(home\);[\s\S]{0,200}?slot\.appendChild\(redraw\);/.test(APP_SHELL),
   '  moveAnswerActions 把两颗**一起**搬进固定栏（顺序：返回题库 → 重新生成试卷）');
ok(/if \(redrawBtn\) redrawBtn\.addEventListener\('click', function \(\) \{ redrawRound\(1\); \}\);/.test(ANSWER),
   '  「重新生成试卷」点了走 redrawRound(1)（= 按当前设置换一批题，和首页那颗「换一批」同一条路）',
   (ANSWER.match(/redrawBtn\.addEventListener[^\n]*/) || [''])[0]);
ok(/if \(redrawBtn\) redrawBtn\.hidden = !on;/.test(ANSWER),
   '  它与「返回题库」同进同出（只在有一轮在答时露出）');
ok(ANSWER.indexOf("mk('redraw'") < 0,
   '  而**视图的动作条里不再画**「再抽一次」（那颗按钮整块搬走了，不是两个地方各画一颗）');
/* ---- ⑬ 填 API Key 的入口**全应用只有一处**（用户要求"重复功能只保留一个"）----
 * 唯一入口 = 「导入 / 校对」页顶部那颗「AI 密钥与供应商」（挂完整面板）。
 * 其余面板（单题智能 / 整卷批量 / 举一反三 / 整卷总评）只留**只读状态行 + 指路**。 */
const AI_SET = fs.readFileSync(path.join(HERE, 'ui', 'ai-settings.js'), 'utf8');
ok(/function keyStatus\(opts\)/.test(AI_SET) && /keyEntry: keyEntry, keyStatus: keyStatus/.test(AI_SET),
   'ai-settings.js 多了一个**只读状态行** keyStatus（没有输入框、没有保存按钮），并导出');
ok(/class="as-entry-hint"|'as-entry-hint'/.test(AI_SET) && /\.as-entry-hint\{/.test(AI_SET),
   '  状态行下面那句"去哪儿填"有独立样式（13.5px，不当小字糊在角落）');
eq(countCall(APP_SHELL, "keyHint: '填 / 换 Key 用本页顶部那颗「AI 密钥与供应商」（只存本机，不上传）'"), 1,
   '导入 / 校对页那块 AI 面板只要状态行 + 指路（本页顶部那颗按钮就是唯一入口）');
ok(/填 \/ 换 Key 去「导入 \/ 校对」页顶部那颗「AI 密钥与供应商」/.test(APP_SHELL),
   '错题本与答题页的面板指路去「导入 / 校对」页');
/* ⚠ 判据必须用**真窗口文档**：合并版里这些面板拿到的是"作用域化的 document"，
 *   它只在面板内部查找 —— 用它会永远判成"独立单页版"，于是删掉的入口又悄悄回来。 */
ok(/window\.document\.getElementById\('tab-review'\)/.test(ANSWER)
   && /window\.document\.getElementById\('tab-review'\)/.test(WRONG),
   '答页面板与错题本都用**真窗口文档**判断"有没有导入页"（作用域化 document 会永远判错）',
   (ANSWER.match(/window\.document\.getElementById\('tab-review'\)[^\n]*/) || [''])[0]);
const wrongKeyHint = (WRONG.match(/keyHint: \(function \(\) \{[\s\S]{0,320}?\}\)\(\)/) || [''])[0];
ok(wrongKeyHint.indexOf('tab-review') >= 0 && !/keyHint: null/.test(WRONG),
   '错题本页面：合并版给 keyHint（只报状态）、独立单页版才保留就地入口（否则那一页没处填）');
/* ---- ⑭ 「须知」页（用户要求）：声明与警告集中一处 + 简易使用说明 + 作者小字 ---- */
ok(/id="tab-help"[^>]*>须知</.test(APP_SHELL) && /id="helpPage" class="sharepage hidden"/.test(APP_SHELL),
   '顶栏那一排有「须知」按钮，点开是一整页说明（#helpPage）');
ok(/id="helpClose"/.test(APP_SHELL) && /window\.__help = \{ open: open, close: close/.test(APP_SHELL),
   '  须知页有关闭按钮，也对外给了 window.__help（自检/取证要用）');
/* ⚠ 取到整块（含最下面的署名那行）：以前用 `help-sign` 当结尾，署名自己在它后面，会被切掉。 */
const helpAt = APP_SHELL.indexOf('<div id="helpPage"');
const helpPageHtml = helpAt < 0 ? '' : APP_SHELL.slice(helpAt, helpAt + 6000);
ok(helpPageHtml.length > 800, '能抠出须知页正文', helpPageHtml.length + ' 字符');
ok(/怎么用（三步）/.test(helpPageHtml) && /常用按钮/.test(helpPageHtml) && /声明与警告/.test(helpPageHtml),
   '  须知里有：简易使用说明（三步 + 常用按钮）与「声明与警告」小节');
/* 原来的零散声明**都收进须知**了（逐条点名字，少一条就红） */
const decls = ['数据只存你本机', '只有 AI 功能需要联网', 'AI 密钥只存本机', '分享文件只带试卷',
               '下载可能被拦', '删除不可恢复', '存储不可用或写满', '判分口径', '内容自负'];
eq(decls.filter(function (t) { return helpPageHtml.indexOf(t) < 0; }), [],
   '  九条声明/警告逐条都在须知里（数据本地 / 联网 / 密钥 / 分享只带卷 / 下载被拦 / 删除不可恢复 / 存储告警 / 判分口径 / 内容自负）');
ok(APP_SHELL.indexOf('数据只存你本机（localStorage）') < 0,
   '  而页脚那句旧声明**已经搬走**（不在别处再写一份）',
   (APP_SHELL.match(/数据只存你本机[^\n]{0,20}/) || [''])[0]);
/* 小字：GitHub 主页 / 项目仓库 / 邮箱；外加提意见与获取更新两段；最下面：制作署名 */
ok(/https:\/\/github\.com\/kokuraasahidesu("|\/|<\/)/.test(helpPageHtml)
   && /https:\/\/github\.com\/kokuraasahidesu\/review_quiz/.test(helpPageHtml),
   '  小字挂了 GitHub 主页与**新**项目仓库地址（review_quiz）');
ok(APP_SHELL.indexOf('easy_quiz_board') < 0, '  旧仓库名（easy_quiz_board）一处都不剩');
ok(/邮箱：/.test(helpPageHtml) && /liyi07@outlook\.com/.test(helpPageHtml),
   '  邮箱那一行写的是作者给的地址（liyi07@outlook.com）');
ok(/欢迎发邮件提意见/.test(helpPageHtml) && /留意.*我.*照着改|我会照着改/.test(helpPageHtml.replace(/\s+/g, '')),
   '  写了「欢迎发邮件提意见」并说明怎么写最好复现');
ok(/获取更新/.test(helpPageHtml) && /Watch/.test(helpPageHtml) && /Star/.test(helpPageHtml)
   && /review_quiz\.html/.test(helpPageHtml),
   '  写了「获取更新」：Watch / Star 项目仓库，并点明仓库里那个 review_quiz.html 永远是最新版');
ok(/由北京理工大学 2625 李佳祎使用 DeepSeek V4\.1 Flash 和亲爱的一百块钱制作/.test(helpPageHtml),
   '  最下面写着制作署名（**只在须知页里**）');
/* 用户要求：制作人信息不用在外面写 —— 页脚只留一句指路 */
ok(/id="footMore">使用说明、全部声明与作者信息都在顶部「须知」里。/.test(APP_SHELL)
   && APP_SHELL.indexOf('id="footCredit"') < 0
   && (APP_SHELL.match(/李佳祎/g) || []).length === 1,
   '页脚不再写制作人信息（全成品里"李佳祎"只出现在须知页那一处）');
ok(/attemptRecordPreview\(store\)/.test(ANSWER) && /clearAttemptRecords\(store, \{ includeWrong:/.test(ANSWER),
   '清除答题记录同样是"先问后清"：先 attemptRecordPreview 把真实数字摆出来，选完才 clearAttemptRecords',
   (ANSWER.match(/clearAttemptRecords\([^\n]*/) || [''])[0]);
ok(ANSWER.indexOf('ExamsCore.clearAttemptRecords(') > ANSWER.indexOf('async function runClearRecords'),
   '  runClearRecords 的定义在调用之前（顺序上不会用到未定义）');
/* 首页那颗按钮（用户要求"首页新增"）：只在题库首页的脚注里，且点它先进弹窗 */
ok(/data-lib', 'wipe'/.test(ANSWER) && /libpick-go libpick-del', '清除答题记录'/.test(ANSWER),
   '题库首页（首页）脚注里有「清除答题记录」按钮（data-lib=wipe）',
   (ANSWER.match(/data-lib', 'wipe'[^\n]*/) || [''])[0]);
ok(/title: '清除答题记录？'/.test(ANSWER) && /cancelLabel: '取消（什么都不清）'/.test(ANSWER),
   '  弹窗文案由询问模型给出（标题/取消都是这一件事的说法，不再借删卷那句）');
ok(/roundCtx = null;\s*\/\/ 刚被清掉的那份进度/.test(ANSWER),
   '  清完把 roundCtx 放下（首页不留「继续这一轮」的假承诺）');
/* 弹窗能力是**共用**的：标题/取消文案可配，但默认值一个字没变（删卷那条路照旧） */
const DIALOG = fs.readFileSync(path.join(HERE, 'ui', 'delete-dialog.js'), 'utf8');
ok(/prompt\.title \|\| '删除这套卷？'/.test(DIALOG) && /prompt\.cancelLabel \|\| '取消（什么都不删）'/.test(DIALOG),
   'DeleteDialog 的标题/取消可配且**默认值不变**（删卷那条路的文案没被改）');
ok(/policy: policy, now:/.test(ANSWER), '  答题页的政策同样来自用户的选择（页面不替用户改写）');
ok(/ExamsCore\.deleteExam\(store, examId, \{ policy: policy, now:/.test(WRONG),
   '  政策来自用户的选择（`policy` 变量），页面不替用户改写成别的政策',
   (WRONG.match(/ExamsCore\.deleteExam\([^\n]*/) || [''])[0]);


ok(WRONG.indexOf('ExamsCore.deletedExams(') >= 0, '页面查了"已删除卷册"');
ok(WRONG.indexOf('WrongCore.loadAllWithDeleted(') >= 0, '  并用 loadAllWithDeleted 把它们的误答本一起读回来');
ok(WRONG.indexOf('ExamsCore.ownerOf(') >= 0, '  每本都查归属（界面据此显示「已删除试卷（原《…》）」）');
/* 第三类：**从没入册的卷**（答题页拖入 docx / 内置样卷直接答题 → 卷 id 就是文件名），
 * 不捞出来，用户刚交完卷回到本页只看到"本地还没有卷子"（终身体验走查抓到的） */
ok(WRONG.indexOf('WrongCore.orphanIds(') >= 0, '  还把**从没入册的卷**的误答本捞出来（orphanIds）');
ok(/const orphan = await WrongCore\.orphanIds\(store, ids\.concat\(deadIds\)\)/.test(WRONG),
   '  孤儿判定排除"活着的 + 已删除的"（不重复列同一本）',
   (WRONG.match(/orphanIds\([^\n]*/) || [''])[0]);
ok(WRONG.indexOf('WrongCore.loadAll(store, orphan)') >= 0, '  孤儿本用 loadAll 读回来（exam:null 由视图给归属文案）');
ok(/owner: own\.ok \? own : null/.test(WRONG), '  归属信息随 books 传给视图（视图层不自己猜）');
ok(WRONG.indexOf("onDelete: function (examId) { askDelete(examId); }") >= 0,
   '  视图的"删除这套卷"回调接在 askDelete 上（先问后删）');


const atWrongCore = ANSWER.indexOf('内联开始：core/wrong.js');
const atCallWrong = ANSWER.indexOf('WrongCore.collectToStore(');
ok(atWrongCore >= 0 && atCallWrong > atWrongCore, '答题页：wrong.js 的内联在 collectToStore 调用之前');
const atDialog = WRONG.indexOf('内联开始：ui/delete-dialog.js');
const atMountDialog = WRONG.indexOf('DeleteDialog.mount(');
ok(atDialog >= 0 && atMountDialog > atDialog, '错题本页：delete-dialog.js 的内联在 mount 调用之前');
const atView = WRONG.indexOf('内联开始：ui/wrong-view.js');
ok(atView >= 0 && WRONG.indexOf('WrongView.mount(') > atView, '错题本页：wrong-view.js 的内联在 mount 调用之前');

/* ---- ⑥ 校对面板页：AI 密钥面板真的接上了，且密钥只走独立命名空间 ---- */
/* ⚠ 凡是"页面里不许出现 X"这类断言，只能扫**页面自己那段脚本**：
 *   整份成品里内联着 core/ai.js，它当然含有 apiKeys / keyModel 这些名字。 */
const REVIEW_PAGE = REVIEW.slice(REVIEW.indexOf('页面逻辑'));
ok(REVIEW_PAGE.length > 200, '能定位到校对面板自己的页面脚本段', REVIEW_PAGE.length + ' 字符');
ok(REVIEW.indexOf('AiSettings.mount(') >= 0, '校对面板挂了 AI 密钥面板（AiSettings.mount）');
eq(countCall(REVIEW, 'AiSettings.mount('), 1, '  只有一处挂载点');
ok(/store: AiCore\.openKeyStore\(window\.localStorage\)/.test(REVIEW),
   '  密钥 store 由 AiCore.openKeyStore 开（独立命名空间 secret），页面不自己拼命名空间',
   (REVIEW.match(/store: AiCore[^\n]*/) || [''])[0]);
ok(REVIEW_PAGE.indexOf("'secret::") < 0 && REVIEW_PAGE.indexOf('"secret::') < 0 && REVIEW_PAGE.indexOf('apiKeys') < 0,
   '  **页面脚本里没有**手拼密钥键名（键名只由核心给）');
ok(REVIEW_PAGE.indexOf('providerRows') < 0 && REVIEW_PAGE.indexOf('keyModel') < 0,
   '  页面脚本也不自己拼能力表（能力标注只由 AiCore.keyModel 给）');
const atAiCore = REVIEW.indexOf('内联开始：core/ai.js');
ok(atAiCore >= 0 && REVIEW.indexOf('AiCore.openKeyStore(') > atAiCore, '校对面板：ai.js 的内联在 openKeyStore 调用之前');
const atAiUi = REVIEW.indexOf('内联开始：ui/ai-settings.js');
ok(atAiUi >= 0 && REVIEW.indexOf('AiSettings.mount(') > atAiUi, '校对面板：ai-settings.js 的内联在 mount 调用之前');

/* ---- ⑦ 校对面板页：**一颗**「生成解析」按钮，接在草案上跑**整卷**（用户要求：不要分开）----
 * 用户原话："不要分开，整合到一个生成解析按钮解析对应整卷" ——
 * 原来的「单题智能」与「整卷批量」两颗按钮合成一颗；单题那条路从界面上撤掉了。 */
ok(REVIEW.indexOf('AiSingle.mount(') < 0, '校对面板**不再**挂单题智能面板（那颗按钮撤了）');
ok(REVIEW.indexOf('AiSingle.mountBatch(') >= 0, '  只挂整卷批量（AiSingle.mountBatch）= 生成解析');
eq(countCall(REVIEW, 'AiSingle.mountBatch('), 1, '  只有一处挂载点');
ok(/id="aibatch">生成解析</.test(REVIEW), '  那颗按钮就叫「生成解析」',
   (REVIEW.match(/id="aibatch"[^\n]*/) || [''])[0]);
ok(REVIEW.indexOf('id="aisingle"') < 0 && REVIEW.indexOf('id="singlehost"') < 0,
   '  而「单题智能」的按钮与宿主都删掉了（不留空壳）');
ok(/getQuestions: function \(\) \{ return \(panel\.getDraft\(\)\.questions \|\| \[\]\)\.filter/.test(REVIEW),
   '  解析对象 = **这份草案里还缺解析的题**（简答题 / 没有 explanation 的题）',
   (REVIEW.match(/getQuestions:[^\n]*/) || [''])[0]);
ok(/applyBatch: function \(res\) \{/.test(REVIEW) && REVIEW.indexOf('panel.setDraft(draft)') >= 0,
   '  生成的解析写回同一份草案（panel.setDraft）——入库仍由「确认入库」把关');
ok(/kind: 'explain'/.test(REVIEW), '  批量任务固定是 explain（解析），不再是可切换的多种任务');
ok(/store: AiCore\.openKeyStore\(window\.localStorage\)/.test(REVIEW), '  用的是同一个密钥 store（独立命名空间 secret）');
const atSingleUi = REVIEW.indexOf('内联开始：ui/ai-single.js');
ok(atSingleUi >= 0 && REVIEW.indexOf('AiSingle.mountBatch(') > atSingleUi, '校对面板：ai-single.js 的内联在 mountBatch 调用之前');

/* ---- ⑧ 答题页：导出成独立 HTML 的接线（① 挂载前抓壳 ② 打开先读自带载荷 ③ 真的落盘） ---- */
ok(/id="btnExport"/.test(ANSWER), '答题页有导出入口（按钮 id="btnExport"）');
eq(countCall(ANSWER, 'DataCore.exportStandalone('), 1, '  导出只走**唯一入口** DataCore.exportStandalone（一处调用）');
ok(/DataCore\.downloadHtml\(r\.html, r\.filename\)/.test(ANSWER),
   '  导出成品交给 DataCore.downloadHtml 落盘（不自己拼 Blob/a[download]）',
   (ANSWER.match(/DataCore\.downloadHtml\([^\n]*/) || [''])[0]);
/* 壳必须是**挂载前**抓的：抓在 boot/mount 之后就会把"上一次的作答界面"一起打包 */
const atShell = ANSWER.indexOf('const SHELL = ');
const atBootCall = ANSWER.indexOf('boot(e0.id,');
/* ⚠ 每条都要先 `atShell >= 0`：`indexOf` 找不到时返回 -1，而 `-1 < 任何下标` 恒真 ——
 *   少了这半句，"壳根本没抓"反而会被判成通过（探针 ⑨ 就是这么把它抓出来的）。 */
ok(atShell >= 0 && ANSWER.indexOf("document.documentElement.outerHTML", atShell) > atShell,
   '  壳取自 document.documentElement.outerHTML（运行时唯一拿得到整页的途径）');
ok(atShell >= 0 && atBootCall > atShell && atShell < ANSWER.indexOf('AttemptView.mount('),
   '  **壳在挂载/建会话之前抓**（抓晚了就会带上运行时残留）', 'SHELL@' + atShell + ' boot@' + atBootCall);
ok(ANSWER.indexOf('DataCore.extractPayloadDetailed(srcHtml)') >= 0,
   '  打开时先读**自带载荷**（导出的文件双击即加载该试卷）；走 *Detailed 版是为了拿到"读不出来的原因"');
/* 用户明确要求"不要默认展示内置题库"：内置样卷只在首页那个按钮的回调里解析，启动路径落在题库首页 */
ok(ANSWER.indexOf('DataCore.extractPayloadDetailed(srcHtml)') < ANSWER.indexOf('boot(e0.id,'),
   '  自带载荷优先（在同一个启动分支里先读载荷、再 boot）');
/* 手机端"打开看不了"的兜底：载荷坏了/断了必须**当面说清**，不许默默回到空题库（那等于"打开了但没有卷"） */
ok(/PAYLOAD_BAD\)[\s\S]{0,900}已回到题库首页/.test(ANSWER),
   '  载荷读不出来（JSON 坏了 / 块被截断）→ 红字说明原因 + 让出题者重发，而不是静默落回空题库');
/* ---- ⑩-a 自带载荷**必须等 DOM 解析完**再读 ----
 * 载荷块是导出器插在 `</body>` 之前的（也就是这段脚本**后头**），脚本按解析顺序执行 ——
 * 跑在这一行时 `documentElement.outerHTML` 里根本没有它。早先正是这样：收件人打开分享文件只看到
 * 一个空题库首页（用户报障"导出时带的试卷在其他浏览器打开看不了"；出题者本机看不出来）。
 * 真机证据：verify/open-share-gen.js + open-share-parse.js（打开成品，看那套卷有没有自己出来）。 */
ok(/function startFromPayload\(\)/.test(ANSWER) &&
   ANSWER.indexOf('function startFromPayload()') < ANSWER.indexOf('extractPayloadDetailed(srcHtml)'),
   '读自带载荷那一段包成了 startFromPayload（好被"解析完再跑"调度）');
ok(/readyState === 'loading'[\s\S]{0,160}addEventListener\('DOMContentLoaded', startFromPayload\)/.test(ANSWER) &&
   /else startFromPayload\(\);/.test(ANSWER),
   '**等 DOM 解析完**才读载荷（不然读到的 outerHTML 里还没有载荷块）');
ok(/function loadSample\([\s\S]{0,500}QuizParser\.parseDocx\(b64ToBuf\(SAMPLE_B64\)\)/.test(ANSWER),
   '  内置样卷只在 loadSample()（首页「载入内置样卷」按钮）里解析，不在启动路径上');
ok(/已回到题库首页[\s\S]{0,120}showHome\(\)/.test(ANSWER) || /showHome\(\);\s*\n\s*\}/.test(ANSWER),
   '  没有自带载荷 → 落在题库首页（showHome），不自动建会话');
ok(/AiCore\.allKeys\(AiCore\.openKeyStore\(window\.localStorage\)\)/.test(ANSWER),
   '  导出前把本机保存的 AI 密钥当"来源机密"送进扫描（页面不自己拼键名）');
const atDataCore = ANSWER.indexOf('内联开始：core/data.js');
ok(atDataCore >= 0 && ANSWER.indexOf('DataCore.exportStandalone(') > atDataCore, '答题页：data.js 的内联在导出调用之前');

/* ---- ⑨ 答题页：**接收者隔离**（分享文件 → recv_<卷id> 空间；自己拖进来的 → app 空间） ---- */
/* ⚠ 只扫**页面自己那段脚本**：整份成品里内联着 core/data.js，它当然含有 NS_SEP / NS_GLOBAL 这些名字。 */
const ANSWER_PAGE = ANSWER.slice(ANSWER.indexOf('const SHELL = '));
ok(ANSWER_PAGE.length > 500, '能定位到答题页自己的页面脚本段', ANSWER_PAGE.length + ' 字符');
ok(/let storeNs = DataCore\.NS_GLOBAL/.test(ANSWER), '默认落盘空间是全局空间（用常量 DataCore.NS_GLOBAL，不手写字符串）');
ok(/storeNs = DataCore\.receiverNamespaceFor\(e0\)/.test(ANSWER),
   '**打开分享文件时把落盘空间切到 DataCore.receiverNamespaceFor(载荷卷)**（接收者隔离的开关；含内容指纹，防卷 id 撞名）',
   (ANSWER.match(/storeNs = DataCore\.receiverNamespaceFor[^\n]*/) || [''])[0]);
ok(/namespace: storeNs/.test(ANSWER), 'makeStore 用的是 storeNs（命名空间不写死）');
eq(ANSWER_PAGE.indexOf("namespace: 'app'") + ANSWER_PAGE.indexOf('namespace: "app"'), -2,
   '  页面脚本里**没有**手写的 app 命名空间字面量（单双引号两种写法都找不到）');
/* ⚠ 这一条原本锚在 `load(file)`（拖入文件那条路）里。后来用户要求"把拖入功能整合到导入页"，
 *   答题页的拖入区与 load() 一起删了 —— 于是判据**跟着功能搬家**：
 *     · "自己拖进来的卷写全局空间"现在发生在**导入 / 校对页**（它的 store 就是全局命名空间）；
 *     · 答题页这边仍有三条入口写全局空间（题库里的卷 / 内置样卷 / 收到分享文件时切接收者空间），
 *       所以逐条钉住这两处 `storeNs = DataCore.NS_GLOBAL;` + `received = false;` 的配对，
 *       探针改掉其中任意一处都必须让锚变红。 */
const globalPairs = (ANSWER.match(/storeNs = DataCore\.NS_GLOBAL;[\s\S]{0,80}?received = false;/g) || []).length;
ok(globalPairs >= 2, '答题页里"自己的卷写全局空间"的每一处都是 NS_GLOBAL 与 received=false 成对出现',
   '找到 ' + globalPairs + ' 处');
const reviewStoreGlobal = (REVIEW.match(/namespace: DataCore\.NS_GLOBAL/) || []).length;
ok(reviewStoreGlobal >= 1, '自己拖进来的卷写全局空间（这条现在由导入 / 校对页承担）', '校对页出现 ' + reviewStoreGlobal + ' 次');
ok(/indexOf\(DataCore\.NS_SEP\) >= 0/.test(ANSWER),
   '卷 id 含命名空间分隔符 → **拒绝载入**（否则 createStore 抛错白屏，隔离边界也被撑破）');
eq(countCall(ANSWER, 'AttemptCore.createProgressStore(makeStore(),'), 1, '进度存储也走 makeStore()（命名空间只有一个来源）');
eq(countCall(ANSWER, 'WrongCore.collectToStore(makeStore(),'), 1, '错题存储同样走 makeStore()');

/* ---- ⑩ 答题页：存储不可用时**开页就明说**（不许沉默，也不许假成功） ---- */
ok(/id="storeWarn"/.test(ANSWER), '答题页顶部有"存储不可用"告警位（id="storeWarn"）');
/* ⚠ 判据跟着**必须成立的形状**走：取 `window.localStorage` **这个动作自身**会抛（隐私模式 / file:// 下
 *   直接 SecurityError），所以体检前必须先把它包进 try —— 早先没包 → 整个答题面板的页面逻辑当场中断，
 *   收件人打开分享文件只看到空壳（"导出带的试卷在别的浏览器看不了"的成因之一）。 */
ok(/try \{ backend = window\.localStorage; \} catch[\s\S]{0,80}DataCore\.storageHealth\(backend\)/.test(ANSWER),
   '开页做一次存储体检（**取 localStorage 自己就带 try**，真写一次再读回，不是只看对象在不在）',
   (ANSWER.match(/DataCore\.storageHealth\([^\n]*/) || [''])[0]);
ok(/HEALTH\.degraded/.test(ANSWER) && /warn\.textContent = '⚠ ' \+ HEALTH\.message/.test(ANSWER),
   '体检不过 → 把**原因 + 建议**原样显示在顶部（不是只甩一个错误码）');
ok(ANSWER.indexOf('const SHELL = ') < ANSWER.indexOf('DataCore.storageHealth('),
   '壳在体检**之前**抓（导出的文件不带"刚才那台机器"的告警文案）');

/* ---- ⑪ 答题页：抽题偏好「未作答优先」的接线（用户要求"抽题可以选择随机或者未做答优先"） ----
 * ⚠ 这一段的判据全部带上"未作答优先"四个字：`probe-wiring-old.js` 按关键词取这一组去跑改坏的源码。 */
ok(/WrongCore\.loadBook\(makeStore\(\), examId\)/.test(ANSWER_PAGE),
   '未作答优先的档位是从**本机错题本**读的（WrongCore.loadBook，不另开数据源）',
   (ANSWER_PAGE.match(/WrongCore\.loadBook\([^\n]*/) || [''])[0]);
ok(/const owed = \(\(e\.rightTimes \|\| 0\) === 0\) \|\| \(\(e\.streak \|\| 0\) > 0\)/.test(ANSWER_PAGE),
   '  未作答优先的判据：本子里**还没答对**（rightTimes=0）或**连续错着**（streak>0）→ 最优先');
ok(/map\[String\(q\.id\)\] = \(v == null\) \? 1 : v;/.test(ANSWER_PAGE),
   '  没进过本子的题算中间档（档位 1）—— 不当作"欠账"，也不当作"已答对"');
ok(/QuizCore\.pickQuestions\(questions, c, tiers \? \{ priority: tiers \} : null\)/.test(ANSWER_PAGE),
   '未作答优先真的把档位表传进 pickQuestions（第三个参数 priority，抽题核心不必读错题本）',
   (ANSWER_PAGE.match(/QuizCore\.pickQuestions\([^\n]*/) || [''])[0]);
ok(/if \(preferOf\(cfg\) !== 'unansweredFirst' \|\| !wrongTiers\) return null;/.test(ANSWER_PAGE),
   '  只有规则真的是「未作答优先」且**档位读到了**才算档位（否则退化成完全随机，不假装优先）');
ok(/await loadWrongTiers\(examId\);[\s\S]{0,900}?paintPickSettings\(\);/.test(ANSWER_PAGE),
   '  答卷前设置页打开时先读一遍档位 → **预览里就是这一批题**（未作答优先在点开始前就生效）');
ok(/await loadWrongTiers\(roundCtx\.examId\);/.test(ANSWER_PAGE),
   '  「再抽一次 / 换一批」也先刷新档位（未作答优先在答题中途同样生效）');
ok(ANSWER_PAGE.indexOf('wrongTiers') > 0 && ANSWER_PAGE.indexOf('wrongTiers = null') > 0,
   '  档位只是页面里的一个内存变量（读一次、用一轮），没有新存储、也没有写回盘');
ok(ANSWER_PAGE.indexOf("'wrong::") < 0 && ANSWER_PAGE.indexOf('"wrong::') < 0,
   '  未作答优先没有手拼错题本的键名（键名只由 DataCore 给）');

  return checks;
}

/* ---------------- 直接运行时：跑真产物 ---------------- */
const APP_SHELL_FILE = fs.readFileSync(path.join(HERE, 'review_quiz.html'), 'utf8');
function main() {
  const checks = audit(ANSWER, WRONG, REVIEW, APP_SHELL_FILE);
  checks.forEach(function (c) {
    if (c[0]) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + c[1] + (c[2] ? '   ' + brief(c[2]) : '')); }
    else { fail++; failures.push(c[1]); console.log('  \x1b[31mFAIL\x1b[0m  ' + c[1] + (c[2] !== undefined ? '   实际=' + brief(c[2]) : '')); }
  });
  console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
  console.log('  PASS ' + pass + '    FAIL ' + fail);
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
  console.log('  \x1b[90m注：这是**静态接线**证据；运行时路径由 浏览器自检.html 的 M/N 节 + 你点一次覆盖\x1b[0m');
  process.exitCode = fail ? 1 : 0;
}

module.exports = { audit: audit, countCall: countCall };
if (require.main === module) main();

