/* 窄屏与触屏布局 · 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-narrow-layout-old.js
 *
 * 做法与 wiring 探针一致：拿 `verify/narrow-layout.test.js` 导出的**同一套判据**（audit），
 * 跑被人为改坏的源码文本，每一处"把窄屏/触控/安卓那点事改回去"都必须让指定那组断言变红。
 */
const fs = require('fs');
const path = require('path');
const { audit, FILES } = require('./narrow-layout.test.js');

const results = [];
function probe(name, keyword, mutate) {
  let red = false, note = '';
  try {
    const pick = lists => lists.filter(c => c[1].indexOf(keyword) >= 0);
    const base = pick(audit(FILES));
    if (!base.length) throw new Error('基线里没有含「' + keyword + '」的断言（关键词写错了）');
    const F2 = Object.assign({}, FILES);
    Object.keys(mutate).forEach(function (k) { F2[k] = mutate[k](FILES[k]); });
    const after = pick(audit(F2));
    const before = base.filter(c => c[0]).length, now = after.filter(c => c[0]).length;
    red = now < before;
    note = '基线通过 ' + before + '/' + base.length + ' → 改坏后 ' + now + '/' + after.length;
  } catch (e) { red = '抛错:' + (e && e.message); }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red + (note ? '   ' + note : ''));
}
/* 改法：把某个片段换成另一个（找不到就抛错，避免"改了个寂寞"）
 * ⚠ 多行片段要**容忍 CRLF**：模板文件是 CRLF，探针里写的是 LF —— 只按 \n 找会"找不到片段"。 */
function swap(needle, repl) {
  return function (src) {
    const s = String(src);
    if (s.indexOf(needle) >= 0) return s.replace(needle, repl);
    const crlf = String(needle).replace(/\n/g, '\r\n');
    if (s.indexOf(crlf) >= 0) return s.replace(crlf, String(repl).replace(/\n/g, '\r\n'));
    throw new Error('没找到待替换片段：' + needle);
  };
}

/* ---- 1. 导入页拖入区又变回 39px（手机上点不准） ----
 * ⚠ 拖入区这轮从**答题页搬到了导入/校对页**（用户要求"整合到导入的页面里"），
 *   所以探针改的也是 review-template.html 的 `.drop`，看「拖入区 min-height」锚会不会红。 */
probe('① 拖入区退回 39px → 「拖入区 min-height」锚变红', '拖入区 min-height',
  { review: swap('flex-wrap:wrap;min-height:44px;cursor:pointer}', 'flex-wrap:wrap;cursor:pointer}') });

/* ---- 2. 错题本删除按钮退回 38px ---- */
probe('② 删卷按钮退回 38px → 「删除这套卷」锚变红', '删除这套卷',
  { wrongView: swap("'.wv-del{margin-left:auto;min-width:96px;padding:0 10px;font-size:14px;min-height:44px}'",
                    "'.wv-del{margin-left:auto;min-width:96px;padding:0 10px;font-size:14px;min-height:38px}'") });

/* ---- 3. 去掉横向溢出护栏（窄屏会左右晃） ---- */
probe('③ 去掉 overflow-x 护栏 → 「max-width:100% + overflow-x」锚变红', 'overflow-x',
  { answer: swap('html,body{margin:0;max-width:100%;overflow-x:hidden;overflow-x:clip}', 'html,body{margin:0}') });

/* ---- 4. 把某个交互控件的最小高度改小（选项/按钮点到就误触） ---- */
probe('④ 选项最小高度改小 → 「所有 min-height 都 ≥44px」锚变红', '所有 min-height',
  { attemptView: swap('.av-opt{display:flex;align-items:flex-start;gap:10px;width:100%;min-height:48px;padding:10px 12px;',
                      '.av-opt{display:flex;align-items:flex-start;gap:10px;width:100%;min-height:30px;padding:10px 12px;') });

/* ---- 5. 拿掉 viewport meta（手机按 980px 缩放，整页变小） ---- */
probe('⑤ 拿掉 viewport → 「viewport 是 width=device-width」锚变红', 'viewport 是 width=device-width',
  { answer: swap('<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">', '') });

/* ---- 6. 文件选择去掉 .docx（安卓选择器里选不到 Word 文档） ----
 * ⚠ 文件框 + 拖入区这轮从**答题页搬到了导入/校对页**，所以这条探针也跟着换页：
 *   改的是 review-template.html 里的 accept，看「accept 里带 .docx」锚会不会红。 */
probe('⑥ accept 丢掉 .docx → 「accept 里带 .docx」锚变红', 'accept 里带 .docx',
  { review: swap('accept=".docx,.txt,.md,text/plain"', 'accept=".txt,.md,text/plain"') });

/* ---- 7. 实测数字快照被改坏（证明"数字"真被判据吃进去了，不是摆着好看） ---- */
probe('⑦ 实测数字快照被改坏 → 「375px 实测全为 0」锚变红', '375px 实测',
  { numbers: function (src) {
      const o = JSON.parse(src);
      o.answer.clipped = ['假造一条右溢'];
      return JSON.stringify(o);
    } });

/* ---- 8. 快捷面板的类名改回与校对面板撞车的 `.qp-*`（合并版里会被对方的 column 压成竖排） ---- */
probe('⑧ 类名改回撞车的 .qp-row/.qp-btn → 「撞名的 4 个类已改名」锚变红', '撞名的 4 个类已改名',
  { quickPanel: function (src) {
      if (String(src).indexOf('qk-row') < 0) throw new Error('没找到 qk-row（类名又改过了？）');
      return String(src).replace(/qk-(row|btn|opt|title)/g, 'qp-$1');
    } });

/* ---- 9. 开关又退回"裸 22px 方框"（触屏点不准）→ 「开关可点区域 44px」锚变红 ---- */
probe('⑨ 开关退回裸方框（没有 44px label）→ 「开关可点区域 44px」锚变红', '开关的可点区域 44px',
  { quickPanel: function (src) {
      if (String(src).indexOf('qp-tap') < 0) throw new Error('没找到 qp-tap（开关的可点区域又改过了？）');
      return String(src).replace(/el\(doc, 'label', 'qp-tap'\)/, 'el(doc, "span", "qp-tap-renamed")')
                        .replace('.qp-root .qp-tap{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;cursor:pointer}',
                                 '.qp-root .qp-tap{display:inline-flex}');
    } });

/* ---- 10. 宽屏那套（.av-wide 分栏 + 右栏限高内滚）被拿掉 → 「电脑端布局」锚变红 ---- */
probe('⑩ 宽屏分栏/限高规则被拿掉 → 「左栏题干｜右上题号｜右下解析」锚变红', '左栏题干（不限高）',
  { attemptView: function (src) {
      if (String(src).indexOf(".av-root.av-wide{max-width:1100px") < 0) throw new Error('没找到 .av-wide 规则（又改过了？）');
      return String(src).replace(/\.av-root\.av-wide\{[^']*/, ".av-root.av-wide{");
    } });

/* ---- 11. 宽窄改成量 .av-root 自己（被 max-width 卡住 → 永远判不出宽屏）→ 锚变红 ---- */
probe('⑪ 宽窄改成量 .av-root 自己 → 「按宿主宽度判」锚变红', '宽窄按',
  { attemptView: function (src) {
      if (String(src).indexOf('o.container || rootEl.parentNode') < 0) throw new Error('没找到宿主测量（又改过了？）');
      return String(src).replace('const host = o.container || rootEl.parentNode;', 'const host = rootEl;');
    } });

/* ---- 12. 交卷页又把题号栏塞回左栏（用户要求的是"也放右边上面"）→ 锚变红 ---- */
probe('⑫ 交卷页把题号栏塞回左栏 → 「题号栏在右栏顶部」锚变红', '右栏顶部',
  { attemptView: function (src) {
      const s = String(src);
      const at = s.indexOf('paintSummary(main);');
      if (at < 0) throw new Error('没找到交卷分支（又改过了？）');
      return s.replace(s.slice(at, s.indexOf('paintReview(side);', at)), '        paintSummary(main);\n        paintNav(m, main);\n        ');
    } });

/* ---- 13. 窄屏交卷页的阅读顺序没摆回来（手机上先看到题号网格）→ 锚变红 ---- */
probe('⑬ 去掉窄屏交卷页的 order 规则 → 「成绩单 → 题号栏 → 回顾」锚变红', '窄屏交卷页用 flex order',
  { attemptView: function (src) {
      const s = String(src);
      const full = "    '.av-root:not(.av-wide).av-finished .av-body{display:flex;flex-direction:column}',\n"
        + "    '.av-root:not(.av-wide).av-finished .av-main{order:1}',\n"
        + "    '.av-root:not(.av-wide).av-finished .av-navbox{order:2}',\n"
        + "    '.av-root:not(.av-wide).av-finished .av-side{order:3}',\n";
      if (s.indexOf(full) < 0) throw new Error('没找到那三条 order 规则（又改过了？）');
      return s.replace(full, '');
    } });

/* ---- 14. 顶栏又把「答题全能版 + 简介小字」加回来（用户要求双端删掉）→ 锚变红 ---- */
probe('⑭ 顶栏加回标题与简介小字 → 「顶栏删标题与简介」锚变红', '顶栏：大标题与那行简介小字',
  { app: function (src) {
      const s = String(src);
      /* ⚠ 模板是 CRLF，探针里写的是 LF —— 两种都试（以前只试 LF，改一次文件就"找不到顶栏"） */
      const needles = ['<span class="topacts" id="ansTopActs"></span>',
                       '<span class="topacts" id="ansTopActs"></span>\r\n'];
      const hit = needles.filter(function (n) { return s.indexOf(n) >= 0; })[0];
      if (!hit) throw new Error('没找到顶栏（又改过了？）');
      return s.replace(hit, '<h1>答题全能版（离线 · 单文件）</h1>\n    <span class="tip" id="appTip">一个文件，四件事：导入校对 · 答题判分 · 错题本 · 导出分享</span>\n    ' + hit.trim());
    } });

/* ---- 15. 手机端的工具折叠被拆掉（那一排按钮又铺满屏幕）→ 锚变红 ---- */
probe('⑮ 拆掉窄屏工具折叠 → 「折叠只在窄屏生效」锚变红', '折叠**只在窄屏**生效',
  { app: swap("  @media (max-width:819px){\n    .tools-toggle{display:inline-flex;align-items:center;justify-content:center}\n    .toolsrow:not(.open) .tools-body{display:none}\n  }", '') });

/* ---- 16. 折叠按钮不接线（点了没反应）→ 锚变红 ---- */
/* ⚠ 页签与工具**两处**都有这行，`replace` 只换第一处 → 这里用 split/join 全换掉，两条锚一起红 */
probe('⑯ 折叠按钮不接线 → 「折叠按钮真的接线了」锚变红', '折叠按钮真的接线了',
  { app: function (src) {
      const s = String(src);
      const needle = "if (row.classList && row.classList.toggle) row.classList.toggle('open');";
      if (s.indexOf(needle) < 0) throw new Error('没找到折叠接线（又改过了？）');
      return s.split(needle).join('/* 点了没反应 */');
    } });

/* ---- 17. 页签折叠那一段 CSS 被整块拆掉（那一排又常驻占一行）→ 锚变红 ----
 * ⚠ 这一段的 CSS 现在比原来长（多了"收起态悬浮"两条），所以按**开头那句**定位、
 *   把整个 media 块替换掉 —— 用整块字面量当 needle 一改 CSS 就会"找不到片段"。 */
probe('⑰ 拆掉页签折叠 → 「页签折叠只在窄屏生效」锚变红', '页签折叠同样只在窄屏生效',
  { app: function (src) {
      const s = String(src);
      const needle = '    .tabsrow:not(.open) .tabs{display:none}';
      if (s.indexOf(needle) < 0) throw new Error('没找到页签折叠那条规则');
      return s.split(needle).join('    /* 拆掉折叠：整排常驻 */');
    } });

/* ---- 17-b. 收起态改回"占一排"（用户要求做成悬浮）→ 「收起态是悬浮的」锚变红 ---- */
probe('⑰-b 收起态不悬浮（还占一排）→ 「收起态是悬浮的」锚变红', '收起态是**悬浮**的',
  { app: swap('    .tabsrow:not(.open){position:fixed;top:8px;right:10px;left:auto;z-index:55;margin:0;padding:0;',
              '    .tabsrow:not(.open){margin:0;padding:0;') });

/* ---- 17-c. 点页签又自动收起（用户明确要求不要）→ 「不自动收起」锚变红 ---- */
probe('⑰-c 点页签又自动收起 → 「点页签跳转之后不自动收起」锚变红', '点页签跳转之后不自动收起',
  { app: swap('    if (!t || !t.closest) return;\n    appTabsSync();',
              "    if (!t || !t.closest) return;\n    if (t.closest('.tab') && row.classList && row.classList.remove) row.classList.remove('open');\n    appTabsSync();") });

/* ---- 17-d. 小字提示挪回顶部（用户要求搬到底部声明上边）→ 「搬到底部」锚变红 ---- */
probe('⑰-d 小字提示挪回顶部 → 「答题小字提示搬到底部」锚变红', '答题小字提示搬到底部',
  { app: function (src) {
      const s = String(src);
      /* ⚠ CRLF/LF 都试（模板是 CRLF） */
      const rowLf = '  <div class="ansfootrow"><span class="tip" id="ansTip">从下面的题库选一套卷开始</span></div>\n';
      const row = (s.indexOf(rowLf) >= 0) ? rowLf : rowLf.replace(/\n/g, '\r\n');
      if (s.indexOf(row) < 0) throw new Error('没找到底部那行提示');
      const hostLf = '  <div id="ansHost"></div>\n';
      const host = (s.indexOf(hostLf) >= 0) ? hostLf : hostLf.replace(/\n/g, '\r\n');
      if (s.indexOf(host) < 0) throw new Error('没找到 #ansHost');
      return s.replace(row, '').replace(host,
        '  <div class="ansfootrow"><span class="tip" id="ansTip">从下面的题库选一套卷开始</span></div>' +
        (host.indexOf('\r\n') >= 0 ? '\r\n' : '\n') + host.replace(/^\s+/, '  '));
    } });

/* ---- 17-e. 声明后面那块空行被拆（答题时又被底部固定栏压住）→ 「声明后面有一块空行」锚变红 ---- */
probe('⑰-e 拆掉声明后的空行 → 「声明后面有一块只在答题时出现的空行」锚变红', '声明后面有一块**只在答题时**出现的空行',
  { app: swap('<div id="ansFootSpace" class="footspace"></div>', '') });

/* ---- 18. 「返回题库」的底部固定位被拆掉（用户要求放底部栏）→ 锚变红 ---- */
probe('⑱ 拆掉底部固定位 → 「搬到底部固定位」锚变红', '搬到**底部固定位**',
  { app: swap('<div id="ansBottomSlot" class="bottomslot"></div>', '') });

/* ---- 18-b. 底部那一排又贴死屏幕最下沿（手机上被手势条/浏览器底栏压住）→ 锚变红 ---- */
probe('⑱-b 底部固定位不抬过手机底栏 → 「抬过手机底栏」锚变红', '抬过手机底栏',
  { app: swap('.bottomslot{position:fixed;left:14px;bottom:22px;bottom:calc(env(safe-area-inset-bottom, 0px) + 22px);',
              '.bottomslot{position:fixed;left:14px;bottom:14px;') });

/* ---- 19. 答题中的题号又挪回题目下/右上（用户本轮要求：搬到**答案解析下面**）→ 锚变红 ---- */
probe('⑲ 题号挪回题目下面 → 「答案解析下面」锚变红', '答案解析下面',
  { attemptView: swap("    '.av-root.av-wide:not(.av-finished) .av-body{grid-template-areas:\"q a\" \"q n\"}',\n", '') });

/* ---- 19-b. 窄屏答题中不再把题号摆到最后（又回到"题干 → 题号 → 解析"）→ 锚变红 ---- */
probe('⑲-b 窄屏题号不在最后 → 「窄屏答题中摆成题干→解析→题号」锚变红', '窄屏答题中用 flex order',
  { attemptView: swap("    '.av-root:not(.av-wide):not(.av-finished) .av-side{order:2}',\n"
                    + "    '.av-root:not(.av-wide):not(.av-finished) .av-navbox{order:3}',\n",
                      "    '.av-root:not(.av-wide):not(.av-finished) .av-navbox{order:2}',\n") });

/* ---- 20~22 那三条（选项标对错 / 题型悬浮提示 / 删掉的那句叮嘱）判据在 attempt.test.js 里，
 *   所以探针挪到 probe-attempt-old.js ⑪~⑬ —— 探针必须跟着判据走，否则就是空转。 */


/* ---- 17-f. 收起态按钮又写回"当前页名"（用户要求写「展开 ▾」）→ 锚变红 ---- */
probe('⑰-f 收起态按钮写回当前页名 → 「收起态那颗悬浮按钮写展开」锚变红', '收起态那颗悬浮按钮写',
  { app: swap("btn.textContent = open ? '收起 ▴' : '展开 ▾';", "btn.textContent = open ? '收起 ▴' : '答题 ▾';") });

/* ---- 17-g. 回首页不再自动展开（用户要求"首页自动切展开模式"）→ 锚变红 ---- */
probe('⑰-g 回首页不自动展开 → 「首页自动展开」锚变红', '首页自动展开',
  { answer: swap("    if (!on && typeof window.__tabsExpand === 'function') {", '    if (false) {') });

/* ---- 17-h. 壳不再暴露 __tabsExpand（应答面板调了个不存在的钩子）→ 锚变红 ---- */
probe('⑰-h 壳不暴露 __tabsExpand → 「只展开、不收起」锚变红', '只展开、不收起',
  { app: swap('window.__tabsExpand = function () { if (!isOpen()) setOpen(true); };', 'window.__tabsExpand = null;') });

/* ---- 17-i. 启动不铺开那一排（分享文件打开即作答 → 收件人只看到一颗「展开 ▾」）→ 锚变红 ---- */
probe('⑰-i 启动不铺开页签排 → 「启动就铺开」锚变红', '启动就铺开',
  { app: swap('  setOpen(true);\n})();', '  appTabsSync();\n})();') });

const bad = results.filter(r => r[1] !== true);
console.log('\n探针汇总：' + results.length + ' 条  全部能让锚变红=' + (bad.length === 0));
if (bad.length) { bad.forEach(b => console.log('  未变红：' + b[0] + ' → ' + b[1])); process.exitCode = 1; }
