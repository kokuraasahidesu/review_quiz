/* ============================================================
 *  verify/narrow-layout.test.js —— 「窄屏与触屏布局」小类验收（verify=self · 体验模式）
 *
 *  运行： node build.js && node verify/narrow-layout.test.js
 *
 *  三条验收标准，逐条对应：
 *    ① 手机宽度下逐页查看：无横向滚动、无元素重叠、题干与选项完整可读；
 *    ② 主要可点元素（选项、下一题、提交、底部设置）点击区域足够大；
 *    ③ 安卓浏览器上能选中并导入 docx、能下载导出文件。
 *
 *  ⚠ 诚实分层（体验模式下这点尤其重要）：
 *    · **第一证据是"看"** —— 真浏览器（headless Edge）在**内容宽 375px** 下渲染的截图 +
 *      画在页面上的实测数字（`verify/narrow-shot-*.png`，报告第三十二节里有读数）。
 *    · 本文件是**回归锚**：把"截图里成立的那些事实"固化成断言，防止后面改代码把它们改回去。
 *      实测数字快照在 `verify/narrow-numbers.json`（由 `verify/narrow-evidence-gen.js` 生成注入副本、
 *      再用 headless Edge 出数 → `verify/narrow-evidence-parse.js` 汇总），本文件同时校验
 *      "数字"与"对应的 CSS 事实还在"。
 *    · 安卓真机**没验**（本机没有安卓设备/模拟器）—— 见报告里如实登记的边界。
 *
 *  判据抽成 audit()，探针用**同一套判据**跑被改坏的源码（verify/probe-narrow-layout-old.js）。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const HERE = path.join(__dirname, '..');

function readOr(p, dflt) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return dflt == null ? '' : dflt; } }
const FILES = {
  answer: readOr(path.join(HERE, 'answer-template.html')),
  review: readOr(path.join(HERE, 'review-template.html')),
  wrong: readOr(path.join(HERE, 'wrong-template.html')),
  /* 合并壳也要进这份清单：手机端折叠与"顶栏删标题/简介"都发生在它身上 */
  app: readOr(path.join(HERE, 'app-template.html')),
  demo: readOr(path.join(HERE, 'demo-template.html')),
  selftest: readOr(path.join(HERE, 'selftest-template.html')),
  attemptView: readOr(path.join(HERE, 'ui', 'attempt-view.js')),
  quickPanel: readOr(path.join(HERE, 'ui', 'quick-panel.js')),
  wrongView: readOr(path.join(HERE, 'ui', 'wrong-view.js')),
  reviewPanel: readOr(path.join(HERE, 'ui', 'review-panel.js')),
  deleteDialog: readOr(path.join(HERE, 'ui', 'delete-dialog.js')),
  aiSettings: readOr(path.join(HERE, 'ui', 'ai-settings.js')),
  aiSingle: readOr(path.join(HERE, 'ui', 'ai-single.js')),
  aiScene: readOr(path.join(HERE, 'ui', 'ai-scene.js')),
  numbers: readOr(path.join(HERE, 'verify', 'narrow-numbers.json'), '{}')
};

/* 判据：给定一批源码文本 → 断言清单 [[是否通过, 说明, 附注], …] */
function audit(F) {
  const checks = [];
  const ok = (c, t, d) => checks.push([!!c, t, d]);
  const eq = (a, e, t) => checks.push([JSON.stringify(a) === JSON.stringify(e), t, '期望 ' + JSON.stringify(e) + ' ← 实际 ' + JSON.stringify(a)]);

  /* ============ ① 窄屏流体布局：无横滚 / 不重叠 / 长文本可读 ============ */
  const PAGES = [['答题页', F.answer], ['校对面板', F.review], ['错题本', F.wrong]];
  PAGES.forEach(function (p) {
    const name = p[0], src = p[1];
    ok(/<meta[^>]+name=["']viewport["'][^>]+width=device-width/.test(src),
       name + '：viewport 是 width=device-width（手机按设备宽排版，不是按 980 缩放）');
    ok(/html,body\{[^}]*max-width:100%/.test(src) && /html,body\{[^}]*overflow-x:hidden/.test(src),
       name + '：html/body 有 max-width:100% + overflow-x:hidden（横向绝不出滚动条）');
    /* 固定像素宽度：只要 >375 就把窄屏撑破（max-width/min-width:0 不算） */
    const fixed = [];
    (src.match(/[^-]width:\s*(\d{3,})px/g) || []).forEach(function (m) {
      const n = parseInt(m.match(/(\d+)px/)[1], 10);
      if (n > 375) fixed.push(m.trim());
    });
    eq(fixed, [], name + '：没有 >375px 的固定 width（只有 max-width 那种上限）');
    ok(/flex-wrap:wrap/.test(src), name + '：顶栏是 flex-wrap（窄屏会自动换行，不挤成一行）');
  });

  /* 交互模块的触控高度：所有 min-height 规则一律 ≥44px */
  const UI = [['作答界面', F.attemptView], ['底部快捷面板', F.quickPanel], ['误答本视图', F.wrongView],
              ['校对面板', F.reviewPanel], ['删卷弹窗', F.deleteDialog], ['AI 密钥', F.aiSettings],
              ['单题智能', F.aiSingle], ['整卷/举一反三', F.aiScene]];
  let minRule = 999, minWho = '', rules = 0;
  UI.forEach(function (u) {
    (u[1].match(/min-height:\s*(\d+)px/g) || []).forEach(function (m) {
      const n = parseInt(m.match(/(\d+)/)[1], 10);
      rules++;
      if (n < minRule) { minRule = n; minWho = u[0] + ' ' + m; }
    });
  });
  ok(rules >= 20, '八个交互模块一共 ' + rules + ' 条 min-height 规则（不是个别地方加了就算）');
  eq([minRule, minWho], [44, minWho], '**所有 min-height 都 ≥44px**（最小的一条是 ' + minMin(minRule) + '）');

  /* 长文本：题干/选项容器必须能在窄屏里换行、且不被 flex 撑破 */
  ok(/\.av-opt\{[^}]*min-width:0|\.av-opt \.tx\{[^}]*min-width:0/.test(F.attemptView),
     '作答界面：选项文字容器 min-width:0（flex 子项不撑破，长选项会自己换行）');
  ok(/word-break|overflow-wrap|white-space:pre-wrap/.test(F.attemptView + F.wrongView),
     '错题/作答文本有换行兜底（word-break / overflow-wrap / pre-wrap）');
  /* 右下角常驻「交卷」与底部快捷面板同处屏幕右下：表头必须给它留够位置（实测贴住过） */
  const padM = F.attemptView.match(/\.qp-head\{padding-right:(\d+)px\}/);
  ok(!!padM && parseInt(padM[1], 10) >= 132,
     '  常驻「交卷」与快捷面板表头**不重叠**（表头预留宽度 ≥132px）',
     padM ? padM[1] + 'px' : '（没找到这条规则）');
  /* 底部留白按面板实际高度：收起 ~84px、展开才撑开（实测 210px 固定留白白扔 140px 屏幕） */
  ok(/padding:10px 12px 84px/.test(F.attemptView) && /\.av-root\.av-panel-open\{padding-bottom:330px\}/.test(F.attemptView),
     '  底部留白分两档：面板收起 84px / 展开 330px（不白扔屏幕）');
  /* 校对面板工具条：「一键折叠」「到底部」与「只看待校对」并排 —— 新按钮同样要 44px，且不许把那一行挤爆 */
  ok(/\.qp-tool\{[^}]*min-height:44px/.test(F.reviewPanel) && /\.qp-tool\{[^}]*flex:0 0 auto/.test(F.reviewPanel),
     '校对面板：工具条按钮 44px 且不参与伸缩（与「只看待校对」并排，不抢宽度）');
  ok(/class="qp-tool qp-fold"/.test(F.reviewPanel), '  「全部折叠 / 全部展开」按钮真的在工具条里（不是只写了 CSS 没挂上去）');
  ok(/class="qp-tool qp-jump"/.test(F.reviewPanel), '  「到底部 / 回到顶部」按钮同样在工具条里');
  ok(/fold:\s*'\.qp-fold'/.test(F.reviewPanel) && /jump:\s*'\.qp-jump'/.test(F.reviewPanel),
     '  选择器常量 SEL.fold / SEL.jump 都在（自检页靠它们取节点）');
  ok(/\.qp-list\{[^}]*overflow:auto/.test(F.reviewPanel), '  题卡列表自己是滚动容器（"到底部"才有意义）');
  /* 答题页题库首页：新加的按钮同样要 44px，长标题也不许把窄屏撑破 */
  ok(/\.libpick-go\{[^}]*min-height:44px/.test(F.answer) && /\.libpick-foot\{[^}]*flex-wrap:wrap/.test(F.answer),
     '答题页：题库首页的按钮 44px（触屏可点）、底部那行允许换行');
  ok(/\.libpick-row\{[^}]*flex-wrap:wrap/.test(F.answer) && /\.libpick-row \.t\{[^}]*overflow-wrap:anywhere/.test(F.answer),
     '  题库列表行允许换行、长标题可断行（窄屏不横向溢出）');
  /* ⚠ 合并版里两个面板同处一份文档、又都用 `.qp-*` 类名：校对面板的 `.qp-row{flex-direction:column}`
   *   曾把快捷面板的每一行压成竖排（实测「− 数字 +」被拆三行）。修法 = 撞名的 4 个类改名 + 规则带 `.qp-root ` 前缀。 */
  ok(/\.qp-root \.qk-row\{/.test(F.quickPanel) && /\.qp-root \.qk-btn\{/.test(F.quickPanel)
     && /\.qp-root \.qk-opt\{/.test(F.quickPanel) && /\.qp-root \.qk-title\{/.test(F.quickPanel),
     '快捷面板：与校对面板撞名的 4 个类已改名（qk-row/qk-btn/qk-opt/qk-title）');
  ok(!/'qp-(row|btn|opt|title)'/.test(F.quickPanel) && !/'\.qp-(row|btn|opt|title)\{/.test(F.quickPanel),
     '  且没有漏网的旧类名（类名串/CSS 规则串都不许再出现）');
  /* 开关（toggle）的**可点区域**：22px 的方框在触屏上点不准 → 外面必须包一层 44px 的 label。
   * 锚：类名 + 最小高度 + 真的用了 label 包（三样缺一都不算修好）。 */
  ok(/el\(doc, 'label', 'qp-tap'\)/.test(F.quickPanel) && /\.qp-root \.qp-tap\{[^}]*min-height:44px/.test(F.quickPanel)
     && /\.qp-root \.qp-tap\{[^}]*min-width:44px/.test(F.quickPanel),
     '快捷面板：开关的可点区域 44px（22px 方框外包一层 label，点方框或点那块区域都算）');
  /* 「工具」那个折叠壳没了：功能直接摆出来（用户要求），所以不应再有 <details class="tools"> */
  ok(!/<details class="tools">/.test(F.answer) && /<div class="actions">/.test(F.answer),
     '答题页：工具不再折叠（<details class="tools"> 已移除，改成直接摆出来的 .actions）');
  /* 手机端折叠（用户要求："手机端 ui 得让上面那部分按钮可以折叠"）+ 双端删顶栏标题与简介小字 */
  ok(!/<h1>/.test(F.app) && !/id="appTip"/.test(F.app) && !/四件事/.test(F.app),
     '合并版顶栏：大标题与那行简介小字都删掉了（双端，用户要求）');
  ok(/<div class="toolsrow" id="revTools">/.test(F.app)
     && /id="revToolsToggle"/.test(F.app) && /id="revToolsBody"/.test(F.app),
     '导入 / 校对页的工具栏包进了可折叠容器（revTools / revToolsToggle / revToolsBody）');
  ok(/\.tools-toggle\{display:none\}/.test(F.app)
     && /@media \(max-width:819px\)\{[\s\S]{0,200}?\.tools-toggle\{display:inline-flex/.test(F.app)
     && /\.toolsrow:not\(\.open\) \.tools-body\{display:none\}/.test(F.app),
     '  折叠**只在窄屏**生效：宽屏那颗按钮 display:none、工具一直摆着（"工具不折叠"是用户之前的要求）');
  ok(/const btn = document\.getElementById\('revToolsToggle'\);[\s\S]{0,900}?收起工具[\s\S]{0,400}?classList\.toggle\('open'\)/.test(F.app),
     '  折叠按钮真的接线了（点一下翻 .open 并改文案，不是摆设）');
  /* 手机端**页签那一排**也可折叠（用户要求）+「导出分享」就在那一排 */
  ok(/<div class="tabsrow" id="tabsRow">/.test(F.app) && /id="tabsToggle"/.test(F.app)
     && /<div class="tabs" id="tabsBar" role="tablist">/.test(F.app),
     '页签那一排包进了可折叠容器（tabsRow / tabsToggle / tabsBar）');
  ok(/\.tabs-toggle\{display:none\}/.test(F.app)
     && /\.tabsrow:not\(\.open\) \.tabs\{display:none\}/.test(F.app),
     '  页签折叠同样只在窄屏生效（宽屏页签一直摆着）');
  /* 用户要求："收起之后做成悬浮形式不要占一排位置" —— 收起态整块 position:fixed（脱离文档流） */
  ok(/\.tabsrow:not\(\.open\)\{position:fixed;top:8px;right:10px/.test(F.app)
     && /\.tabsrow:not\(\.open\) \.tabs-toggle\{box-shadow:/.test(F.app),
     '  收起态是**悬浮**的（position:fixed 右上角，不占页面上那一排的位置）');
  /* 用户要求："顶部栏点击跳转之后不要自动收起" —— 点页签那一段**不许**再 remove('open') */
  const tabsBarHandler = (F.app.match(/bar\.addEventListener\('click', function \(ev\) \{[\s\S]{0,400}?\}\);/) || [''])[0];
  ok(tabsBarHandler.length > 40 && tabsBarHandler.indexOf("remove('open')") < 0
     && tabsBarHandler.indexOf("classList.remove") < 0 && /appTabsSync\(\)/.test(tabsBarHandler),
     '  **点页签跳转之后不自动收起**（那一段只同步按钮文案，不再 remove(\'open\')）',
     tabsBarHandler.replace(/\s+/g, ' ').slice(0, 120));
  ok(/id="tab-share"[^>]*>导出分享</.test(F.app) && /\.tab-act\{border-color:var\(--key\)/.test(F.app),
     '  「导出分享」就在那一排（主色描出来，但它不是页签：role="tab" 仍然只有 3 个）');
  ok(/const btn = document\.getElementById\('tabsToggle'\);[\s\S]{0,1400}?const setOpen[\s\S]{0,400}?classList\.toggle\('open', !!on\)/.test(F.app),
     '  页签折叠按钮接线了（翻 .open；开关只有 setOpen 一处）');
  /* 用户要求：「收起的时候让按钮显示展开」+「在首页时自动切换为展开模式」 */
  ok(/btn\.textContent = open \? '收起 ▴' : '展开 ▾'/.test(F.app),
     '  **收起态那颗悬浮按钮写「展开 ▾」**（早先写的是"当前页名 ▾"，用户要求改成动作词）');
  ok(/window\.__tabsExpand = function \(\) \{ if \(!isOpen\(\)\) setOpen\(true\); \};/.test(F.app),
     '  壳暴露 __tabsExpand：**只展开、不收起**（"什么时候收起"仍只由用户那颗按钮决定）');
  ok(/!on && typeof window\.__tabsExpand === 'function'/.test(F.answer),
     '  答题面板回到**题库首页**时调它 → 首页自动展开（用户要求）；独立单页版没有这一排，typeof 兜住');
  /* 用户报障："这个bug是我手机用导出分享之后的文件打开才有的" —— 分享文件**直接落在作答界面**、
   * 永远不经过首页，所以"回首页才展开"对它没用：启动就得铺开，收件人才看得到页签（回首页的路）。 */
  ok(/\n  setOpen\(true\);[\s\S]{0,400}?\}\)\(\);/.test(F.app),
     '  启动就铺开那一排（分享文件打开即作答、不经过首页 —— 只挂"回首页"那一下等于没铺）');
  /* 导出分享页 + 「返回题库」的底部固定位 */
  ok(/<div id="sharePage" class="sharepage hidden"/.test(F.app) && /id="shareList"/.test(F.app)
     && /id="shareGo"/.test(F.app) && /id="shareOut"/.test(F.app),
     '导出分享页在（选卷列表 / 导出按钮 / 结果文本框）');
  ok(/<div id="ansBottomSlot" class="bottomslot"><\/div>/.test(F.app) && /\.bottomslot\{position:fixed;left:14px;bottom:22px/.test(F.app),
     '「返回题库」搬到**底部固定位**（左下，与右下角的交卷同一层）');
  /* 用户报「答题时找不到返回首页的按钮」：底部这一排（和右下角那颗交卷）**不能贴死屏幕最下沿** ——
   * 手机上那一条会被系统手势条 / 浏览器自己的底栏压住。判据 = 普通值兜底 + env(safe-area-inset-bottom)。 */
  ok(/\.bottomslot\{[^}]*bottom:22px;bottom:calc\(env\(safe-area-inset-bottom, 0px\) \+ 22px\)/.test(F.app),
     '  而且**抬过手机底栏**：普通值兜底 + `env(safe-area-inset-bottom)` 安全区');
  ok(/\.av-fab\{[^}]*bottom:22px;bottom:calc\(env\(safe-area-inset-bottom, 0px\) \+ 22px\)/.test(F.attemptView),
     '  右下角「交卷」同样抬起来（它本来和那排同在 bottom:14px）');
  ok(/\.av-timer\{[^}]*bottom:calc\(env\(safe-area-inset-bottom, 0px\) \+ 86px\)/.test(F.attemptView)
     && /av-panel-open \.av-timer\{bottom:348px;bottom:calc\(env\(safe-area-inset-bottom, 0px\) \+ 348px\)\}/.test(F.attemptView),
     '  计时球跟着抬（含"面板展开时让位到 348px"那一条）');
  ok(/const slot = document\.getElementById\('ansBottomSlot'\);/.test(F.app) && !/id="ansExport"/.test(F.app),
     '  搬的是 ansHome、而合并版里**没有**旧的「导出为独立 HTML」按钮（导出只有「导出分享」一处入口）');
  /* 用户要求："答题时顶部小字提示移到至底部声明上边" —— 提示在面板**末尾**（正文之后、页脚之前）。 */
  const tipAt = F.app.indexOf('<span class="tip" id="ansTip">');
  const ansHostAt = F.app.indexOf('<div id="ansHost">');
  /* ⚠ 页脚那句"数据只存你本机…"已经搬进「须知」页（用户要求：声明与警告集中到须知），
   *   所以这里的"声明"锚改成**页脚那行署名**（它仍是页面最下面那一行）。 */
  const footDeclAt = F.app.indexOf('id="footMore"');
  ok(tipAt > ansHostAt && footDeclAt > tipAt,
     '答题小字提示搬到底部：位置在正文之后、页脚之前（不再占顶部那一行）',
     'ansHost@' + ansHostAt + ' tip@' + tipAt + ' 页脚@' + footDeclAt);
  ok(F.app.indexOf('<h1') < 0 && /\.ansfootrow\{display:flex/.test(F.app),
     '  顶部确实没有标题/提示那一行了（h1 早已删掉）');
  /* 用户要求："在进入答题后声明后面再空一行防止被底部栏挡住" */
  ok(/<div id="ansFootSpace" class="footspace"><\/div>/.test(F.app)
     && /\.footspace\{display:none\}/.test(F.app) && /\.answering \.footspace\{display:block;height:76px\}/.test(F.app),
     '  声明后面有一块**只在答题时**出现的空行（76px，避免被底部固定栏压住）');
  ok(/de\.classList\.toggle\('answering'/.test(F.answer),
     '  答题态由页面逻辑挂在根元素上（`.answering`），首页态不显示这块空行');
  /* 电脑端（宽容器 ≥820px）：题干+选项 ｜（右上）题号跳转 +（右下）答案解析。
   * 左栏**不限高**（A/B/C/D 必须看得全），只有右栏限高内滚；动作条粘视口底（不受解析影响）。 */
  ok(/\.av-root\.av-wide\{max-width:1100px/.test(F.attemptView)
     && /grid-template-areas:"q n" "q a"/.test(F.attemptView)
     && /\.av-root\.av-wide:not\(\.av-finished\) \.av-body\{grid-template-areas:"q a" "n a"\}/.test(F.attemptView)
     && /\.av-root\.av-wide \.av-side\{grid-area:a;max-height:calc\(100vh - 250px\);overflow:auto\}/.test(F.attemptView)
     && /\.av-root\.av-wide \.av-navbox\{grid-area:n/.test(F.attemptView),
     '作答界面：宽屏 = 左栏题干（不限高）｜答题中题号跳转在**题目下面**、交卷页在右上｜解析占右栏（只右栏内滚）');
  ok(/body\.appendChild\(main\); body\.appendChild\(navBox\); body\.appendChild\(side\);/.test(F.attemptView),
     '  DOM 顺序固定 main → navBox → side（窄屏读作"题干 → 题号 → 解析"，题号在题目下面）');
  ok(!/\.av-root\.av-wide \.av-main\{[^}]*max-height/.test(F.attemptView)
     && /\.av-actions\{[^}]*position:sticky;bottom:72px/.test(F.attemptView),
     '  左栏**不许限高**（限了选项就被切）；动作条改成粘视口底（bottom:72px 让开快捷面板）');
  ok(/o\.container \|\| rootEl\.parentNode/.test(F.attemptView)
     && /rootEl\.classList\.toggle\('av-wide', w >= WIDE_MIN\)/.test(F.attemptView),
     '  而且宽窄按**宿主宽度**判（量 .av-root 自己会被它的 max-width:760px 卡住 → 永远判不出宽屏）');
  ok(/id="btnHome"/.test(F.answer) && /hidden>返回题库/.test(F.answer), '  顶栏有「返回题库」（默认藏起来，答题时才出现）');
  /* 交卷页（用户要求："作答完的页面按题号跳题那栏也放在右边上面一点的位置"）：
   * 题号栏必须挂进**独立的 navBox**（宽屏被 grid-area 丢到右上），成绩单留在 main，回顾留在 side。 */
  ok(/if \(m\.finished\) \{[\s\S]{0,600}?paintSummary\(main\);[\s\S]{0,200}?paintNav\(m, navBox\);/.test(F.attemptView),
     '交卷页：题号跳题那栏也在**右栏顶部**（与答题时同一个 navBox），不再塞回左栏成绩单里');
  ok(!/if \(m\.finished\) \{[\s\S]{0,600}?paintNav\(m, main\);/.test(F.attemptView),
     '  左栏只剩成绩单（没有把题号栏又塞回 main）');
  ok(/\.av-root:not\(\.av-wide\)\.av-finished \.av-main\{order:1\}/.test(F.attemptView)
     && /\.av-root:not\(\.av-wide\)\.av-finished \.av-navbox\{order:2\}/.test(F.attemptView)
     && /\.av-root:not\(\.av-wide\)\.av-finished \.av-side\{order:3\}/.test(F.attemptView),
     '  窄屏交卷页用 flex order 把顺序摆回「成绩单 → 题号栏 → 回顾」（DOM 顺序仍服务宽屏分栏）');
  ok(/classList\.toggle\('av-finished', !!m\.finished\)/.test(F.attemptView),
     '  交卷状态挂 .av-finished 类（上面那条 order 规则靠它生效）');
  ok(/\.qp-bar\{[^}]*flex-wrap:wrap/.test(F.reviewPanel), '  工具条允许换行（窄屏宁可换行，也不横向溢出）');

  /* ============ ② 实测数字快照（截图里读到的那些） ============ */
  let nums = null;
  try { nums = JSON.parse(F.numbers); } catch (e) { nums = null; }
  ok(!!nums && !!nums.answer && !!nums.review && !!nums.wrong, '有实测数字快照 narrow-numbers.json');
  if (nums) {
    [['answer', '答题页'], ['review', '校对面板'], ['wrong', '错题本']].forEach(function (p) {
      const r = nums[p[0]];
      if (!r) { ok(false, p[1] + '：快照里有这一页'); return; }
      eq([r.width, r.clipped.length, r.small.length, r.overlap.length, r.tinyFont.length],
         [375, 0, 0, 0, 0],
         p[1] + '：**内容宽 375px 实测** 右溢/触点<44/块级重叠/正文<13px 全为 0');
    });
  }
  /* ⚠ 拖入区从**答题页搬到了导入/校对页**（用户要求："把直接拖入文件的功能整合到导入的页面里"），
   *   所以这几条锚跟着换页：断言的是**校对页**（独立成品 校对面板.html 的模板）里的那一套。
   *   答题页那边反过来要**没有**拖入区了（换题入口统一走 导入 / 校对）。 */
  ok(/\.drop\{[^}]*min-height:44px/.test(F.review), '导入/校对页拖入区 min-height:44px（实测曾 39px）');
  ok(!/id="drop"/.test(F.answer) && !/<input[^>]+id="file"/.test(F.answer),
     '答题页已经**没有**拖入区/文件框了（拖入功能整合进导入页）');
  ok(/\.wv-del\{[^}]*min-height:44px/.test(F.wrongView), '错题本「删除这套卷」min-height:44px（实测曾 38px）');
  ok(/\.wv-meta\{font-size:13px/.test(F.wrongView), '错题本条目说明 13px（实测曾 12.5px，手机上偏小）');

  /* ============ ③ 安卓上的"选文件"与"下载" ============ */
  ok(/<input[^>]+type=["']file["']/.test(F.review) && /accept="[^"]*\.docx/.test(F.review),
     '导入/校对页用真 <input type="file"> 且 accept 里带 .docx（安卓文件选择器按它筛 Word 文档）');
  ok(/<input[^>]+id="file"[^>]*accept/.test(F.review) && /id="drop"/.test(F.review),
     '文件框 + 可见的 44px 拖入区（安卓上点的是那个大块，不是小控件；两者都在导入页）');
  ok(/DataCore\.downloadHtml\(r\.html, r\.filename\)/.test(F.answer),
     '导出落盘走 DataCore.downloadHtml（Blob + a[download]；安卓 Chrome 支持），页面不自己拼 <a download>');
  /* ⚠ 「另存为」这句原本在答题页的 load(file) 里（.doc 老格式的引导）；拖入功能整合进导入页之后，
   *   那条引导搬到了**导入 / 校对页**。判据保留原意（不能只甩错误、要给替代路径），跟着换页。 */
  ok(/另存为/.test(F.answer) || /另存为/.test(F.selftest) || /另存为/.test(F.review),
     '走不通的路给了替代路径（"另存为"），不是干瞪眼');
  ok(/accept="[^"]*\.txt/.test(F.review) && /accept="[^"]*\.md/.test(F.review),
     'accept 同时带 .txt/.md（安卓上也能选纯文本题库）');

  return checks;
}
function minMin(n) { return n + 'px'; }

/* ---------------- 直接运行时：跑真产物 ---------------- */
let pass = 0, fail = 0; const failures = [];
function brief(v) { const s = typeof v === 'string' ? v : JSON.stringify(v); return s == null ? String(s) : (s.length > 170 ? s.slice(0, 170) + '…' : s); }
function main() {
  const checks = audit(FILES);
  checks.forEach(function (c) {
    if (c[0]) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + c[1] + (c[2] ? '   ' + brief(c[2]) : '')); }
    else { fail++; failures.push(c[1]); console.log('  \x1b[31mFAIL\x1b[0m  ' + c[1] + (c[2] !== undefined ? '   实际=' + brief(c[2]) : '')); }
  });
  console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
  console.log('  PASS ' + pass + '    FAIL ' + fail);
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
  console.log('  \x1b[90m注：第一证据是真浏览器 375px 截图（见报告第三十二节）；本文件是与它对齐的回归锚\x1b[0m');
  process.exitCode = fail ? 1 : 0;
}
module.exports = { audit: audit, FILES: FILES };
if (require.main === module) main();
