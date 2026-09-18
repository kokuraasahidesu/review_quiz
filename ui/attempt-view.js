/* ============================================================
 *  ui/attempt-view.js —— 作答界面（只画，不判断）
 *
 *  分工（与 review-panel / quick-panel 一致）：
 *    "该显示什么、能不能提交、答案要不要露" 全在 core/attempt.js + core/flow.js；
 *    这一层只做三件事：按渲染模型画、把点击/输入转成 AttemptCore 调用、重画。
 *
 *  触屏要求（验收硬标准）：
 *    · 主要可点元素 ≥44×44px（选项、按钮、输入框都在此列）
 *    · 窄屏（手机宽度）**不出现横向滚动**：全部用百分比/flex 布局，不用固定 px 宽度，
 *      长题干靠 overflow-wrap:anywhere 折行
 *  底部快捷面板由 ui/quick-panel.js 挂载；它改完参数直接写回会话，**不需要离开当前页**。
 * ============================================================ */
(function (root, factory) {
  const isNode = (typeof module !== 'undefined' && module.exports);
  const AttemptCore = isNode ? require('../core/attempt.js') : root.AttemptCore;
  const QuickPanel = isNode ? require('./quick-panel.js') : root.QuickPanel;
  /* FlowCore 也是硬依赖：**"会不会自动翻页"必须问它**（唯一真相源），不许界面自己判断。
   * 浏览器里它是全局；Node 里必须显式 require —— 否则引用未声明全局会直接 ReferenceError。 */
  const FlowCore = isNode ? require('../core/flow.js') : root.FlowCore;
  if (!AttemptCore || !QuickPanel || !FlowCore) {
    throw new Error('AttemptView 依赖 AttemptCore / QuickPanel / FlowCore，加载顺序错了');
  }
  const api = factory(AttemptCore, QuickPanel, FlowCore);
  if (isNode) module.exports = api;
  root.AttemptView = api;
})(typeof self !== 'undefined' ? self : this, function (AttemptCore, QuickPanel, FlowCore) {
  'use strict';

  const CSS_ID = 'quiz-attempt-css';
  const CSS = [
    '.av-root{--av-line:#d7dbe0;--av-fg:#1b1b1f;--av-dim:#6b7280;--av-ok:#1a7f37;--av-bad:#b42318;--av-key:#2b6cb0;',
    /* 底部留白按**面板实际高度**来：面板默认收起（约 67px），留 210px 会白扔 140px 的屏幕。
     * 面板展开时由 JS 给根节点加 .av-panel-open 再撑开（见 mount 里的 toggle 监听）。 */
    'box-sizing:border-box;max-width:760px;margin:0 auto;padding:10px 12px 84px;color:var(--av-fg);',
    'font:16px/1.6 system-ui,"Microsoft YaHei",sans-serif;overflow-wrap:anywhere;word-break:break-word}',
    '.av-root.av-panel-open{padding-bottom:330px}',
    '.av-root *{box-sizing:border-box;max-width:100%}',
    '.av-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:6px 0 10px;border-bottom:1px solid var(--av-line)}',
    '.av-title{font-weight:600;flex:1 1 160px;min-width:0}',
    '.av-badge{font-size:12.5px;color:var(--av-dim);border:1px solid var(--av-line);border-radius:999px;padding:2px 8px;white-space:nowrap}',
    '.av-bar{height:6px;background:#eef0f4;border-radius:999px;margin:8px 0 12px;overflow:hidden}',
    '.av-bar>i{display:block;height:100%;background:var(--av-key);width:0}',
    '.av-stem{font-size:17px;line-height:1.7;margin:10px 0 14px;white-space:pre-wrap}',
    '.av-opts{display:flex;flex-direction:column;gap:10px;margin:0 0 14px;padding:0;list-style:none}',
    '.av-opt{display:flex;align-items:flex-start;gap:10px;width:100%;min-height:48px;padding:10px 12px;',
    'text-align:left;border:1px solid var(--av-line);background:#f8f9fb;border-radius:10px;cursor:pointer;font:inherit;color:inherit}',
    '.av-opt:hover{background:#eef2f7}',
    '.av-opt[aria-pressed="true"]{border-color:var(--av-key);background:#e8f0fb;box-shadow:inset 3px 0 0 var(--av-key)}',
    '.av-opt .lb{flex:0 0 26px;height:26px;line-height:26px;text-align:center;border-radius:50%;background:#fff;border:1px solid var(--av-line);font-weight:600}',
    '.av-opt .tx{flex:1 1 auto;min-width:0}',
    /* 选中标记：不只靠颜色（色弱/阳光下也能看出选了哪个）。默认不占位，选中才显示。 */
    '.av-opt .mk{flex:0 0 auto;display:none;align-items:center;justify-content:center;min-width:24px;height:24px;',
    'border-radius:50%;background:var(--av-key);color:#fff;font-size:14px;font-weight:700}',
    '.av-opt[aria-pressed="true"] .mk{display:inline-flex}',
    '.av-opt[disabled]{opacity:.65;cursor:default}',
    '.av-text{display:block;width:100%;min-height:132px;max-height:300px;overflow:auto;padding:10px 12px;border:1px solid var(--av-line);',
    'border-radius:10px;font:inherit;line-height:1.6;resize:vertical;background:#fff;color:inherit}',
    '.av-hint{font-size:12.5px;color:var(--av-dim);margin:-6px 0 12px}',
    /* 动作条：**钉在视口底部**（不是"排在内容后面"）——用户报的"下一题被解析挤飞"就从结构上没了。
     * ⚠ 之前只写了 `position:sticky;bottom:0`，但本页 `body` 带 `overflow-x:hidden`，
     *   按规范 `overflow-y` 会被算成 `auto` → body 自己成了滚动容器 → sticky 相对 body 定位、**不粘视口**
     *   （真浏览器实测：按钮 bottom=1223 > 视口 762）。现在模板改成了 `overflow-x:clip`（不产生滚动容器），
     *   sticky 才真正相对视口；同时底部留出 72px 给收起的快捷面板（展开时让到 340px）。 */
    '.av-actions{display:flex;flex-wrap:wrap;gap:10px;position:sticky;bottom:72px;z-index:6;background:#fff;',
    'border-top:1px solid var(--av-line);padding:10px 0;margin:0;box-shadow:0 -6px 12px rgba(0,0,0,.05)}',
    '.av-root.av-panel-open .av-actions{bottom:340px}',
    /* 自动翻页的**小加载条**（用户要求："每次自动翻页时都要有一个小加载条提示翻页"）。
     * 它是动作条里的第一行（`flex:1 1 100%` 强制独占一行），所以永远贴着用户刚点完的地方，
     * 也不会跟右下角的「交卷」FAB / 左下角的「返回题库」抢位置。
     * 条的宽度用 CSS 动画从 0 走到 100%，时长 = 这一跳要等的毫秒数（内联 animation-duration）——
     * 走到头就是真的翻页（定时器与动画同一个时长，观感与行为对得上）。 */
    '.av-jumpbar{flex:1 1 100%;display:flex;align-items:center;gap:8px;font-size:12px;color:#4a5158}',
    '.av-jumpbar .pad{flex:1 1 auto;height:6px;border-radius:999px;background:#e6e9ee;overflow:hidden}',
    '.av-jumpbar .fill{display:block;height:100%;width:0;background:var(--av-key);border-radius:999px;',
    'animation-name:av-jumpbar-fill;animation-timing-function:linear;animation-fill-mode:forwards}',
    '@keyframes av-jumpbar-fill{from{width:0}to{width:100%}}',
    /* 答题计时的**悬浮球**（用户要求：做成不占位置的悬浮球、可暂停）：
     * `position:fixed` 脱离排版流（不挤任何一栏、不参与 grid/flex），右下角「交卷」FAB 的上方；
     * 56px 圆球（≥44px 触控），数字用等宽字体免得跳动；点一下暂停/继续。 */
    '.av-timer{position:fixed;right:14px;bottom:86px;bottom:calc(env(safe-area-inset-bottom, 0px) + 86px);z-index:46;width:74px;height:56px;border-radius:28px;',
    'border:1px solid var(--av-key);background:#eef3ff;color:var(--av-key);cursor:pointer;',
    'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;',
    'font:600 15px/1.1 ui-monospace,Consolas,monospace;box-shadow:0 4px 14px rgba(15,17,21,.18);padding:0}',
    '.av-timer b{font:inherit}',
    '.av-timer .tag{font:400 10.5px/1 system-ui,"Microsoft YaHei",sans-serif;letter-spacing:.5px}',
    '.av-timer.paused{background:#fff7e6;border-color:#e0a800;color:#8a4b08}',
    /* 快捷面板展开时球跟着让位（面板占 ~46vh，不让位就会被面板压住 / 挡住面板里的控件）——
     * 与动作条用同一个数（340px），两处一起动才不会打架。 */
    '.av-root.av-panel-open .av-timer{bottom:348px;bottom:calc(env(safe-area-inset-bottom, 0px) + 348px)}',
    /* 尊重系统的"减少动态效果"：那就把条直接铺满，别让它动 */
    '@media (prefers-reduced-motion:reduce){.av-jumpbar .fill{animation:none;width:100%}}',
    /* 分栏容器：窄屏就是单列（原样），宽屏由 JS 加 `.av-wide` 后变成**题干 | 答案解析**两栏 ——
     * 这样答错的解析不会再往下顶，「上一题 / 下一题」也就不被挤出屏幕（用户报的就是这个）。
     * ⚠ 用 JS 量**本容器宽度**来决定宽窄，而不是 `@media`：合并版/自检页里作答界面可能被放进
     *   一个 375px 的窄宿主中，而窗口本身是宽的 —— 用 media 会按窗口宽度误判成宽屏（实测踩过这类坑）。 */
    '.av-body{display:block}',
    '.av-navbox{min-width:0}',
    '.av-main{min-width:0}',
    '.av-side{min-width:0}',
    /* 窄屏（非 .av-wide）的交卷页：DOM 顺序是 题号栏 → 成绩单 → 试题回顾（为了让宽屏能把题号丢到右上），
     * 但手机上**成绩单应该排在最前面**（交卷后第一眼要看分数）。用 flex order 把顺序摆回来，
     * 不动 DOM —— 这样宽屏的 grid-area 布位与窄屏的阅读顺序各自都对。 */
    '.av-root:not(.av-wide).av-finished .av-body{display:flex;flex-direction:column}',
    '.av-root:not(.av-wide).av-finished .av-main{order:1}',
    '.av-root:not(.av-wide).av-finished .av-navbox{order:2}',
    '.av-root:not(.av-wide).av-finished .av-side{order:3}',
    '.av-root.av-wide{max-width:1100px;padding:12px 18px 84px}',
    /* 宽屏：题干 | 答案解析 两栏，**整块限高**，两栏各自滚 ——
     * 这样一屏就装下，动作条永远在视野里（用户报的"解析把下一题挤出去"从根上没了）。
     * ⚠ 不能只靠 `position:sticky`：本页 `body` 带 `overflow-x:hidden`，按规范它的
     *   `overflow-y` 会被算成 `auto` → body 自己成了滚动容器，sticky 相对它定位反而不粘视口
     *   （真浏览器实测：按钮 bottom=1223 > 视口 762）。所以走"限高 + 分栏内滚"这条不依赖 sticky 的路。 */
    '.av-root.av-wide .av-body{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr);',
    'gap:14px 16px;align-items:start;',
    /* 宽屏布位分两种状态（DOM 顺序固定 main → navBox → side，两种都靠 grid-area 摆）：
     *   · **交卷页**（默认）：左栏成绩单 ｜ 右上题号跳转 ｜ 右下试题回顾（用户上一轮的要求）；
     *   · **答题中**（:not(.av-finished)）：题号跳转放到**题目下面**（用户本轮要求：
     *     "题号跳转功能放在题目的下面"），右栏整列给答案解析。 */
    'grid-template-areas:"q n" "q a"}',
    '.av-root.av-wide:not(.av-finished) .av-body{grid-template-areas:"q a" "n a"}',
    '.av-root.av-wide .av-main{grid-area:q}',
    '.av-root.av-wide .av-navbox{grid-area:n;max-height:32vh;overflow:auto}',
    /* ⚠ 只有右栏限高内滚（解析可以很长）；左栏绝不再裁 —— 之前把 .av-main 也限高，选项就被切了。 */
    '.av-root.av-wide .av-side{grid-area:a;max-height:calc(100vh - 250px);overflow:auto}',
    /* 动作条照旧粘底（模板改成 overflow-x:clip 之后它真的粘视口了），这里只把外边距归零 */
    '.av-root.av-wide .av-actions{position:sticky;bottom:72px;z-index:6;background:#fff;',
    'border-top:1px solid var(--av-line);padding:10px 0;margin:0}',
    '.av-btn{min-height:48px;min-width:96px;padding:0 16px;border:1px solid var(--av-line);background:#f6f7f9;',
    'border-radius:10px;cursor:pointer;font:inherit}',
    '.av-btn.primary{background:var(--av-key);border-color:var(--av-key);color:#fff}',
    '.av-btn[disabled]{opacity:.45;cursor:default}',
    '.av-panel{border:1px solid var(--av-line);border-radius:10px;padding:10px 12px;background:#fbfcfd;margin:0 0 12px}',
    '.av-panel h4{margin:0 0 8px;font-size:18px;line-height:1.55}',
    /* 解析正文：比答案小一号但仍要"看着不费劲"（用户要求"答案解析的字体再大点"） */
    '.av-panel .av-expl{font-size:16.5px;line-height:1.7;margin:2px 0 0;color:var(--av-fg)}',
    '.av-panel .av-ans{font-size:18px;font-weight:600;line-height:1.5}',
    '.av-panel .av-ask{font-size:15px;line-height:1.7;color:var(--av-dim)}',
    '.av-verdict{font-weight:600}',
    '.av-verdict.ok{color:var(--av-ok)}',
    '.av-verdict.bad{color:var(--av-bad)}',
    '.av-kv{display:flex;flex-wrap:wrap;gap:6px 12px;font-size:13.5px;color:var(--av-dim);margin:6px 0 0}',
    '.av-kv b{color:var(--av-fg)}',
    '.av-chips{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 0}',
    '.av-chip{font-size:13px;border-radius:6px;padding:2px 8px;border:1px solid var(--av-line)}',
    '.av-chip.hit{background:#e9f7ee;border-color:#a9dcbb}',
    '.av-chip.miss{background:#fdf1f0;border-color:#f0bdb8}',
    '.av-chip.wrong{background:#fff4e5;border-color:#f0d3a8}',
    '.av-done{text-align:center;padding:16px 4px}',
    '.av-done .big{font-size:34px;font-weight:700;margin:6px 0}',
    /* 题号索引 */
    '.av-nav{border:1px solid var(--av-line);border-radius:10px;padding:8px 10px;background:#fbfcfd;margin:0 0 12px}',
    '.av-nav .h{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:13px;color:var(--av-dim);margin:0 0 8px}',
    '.av-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(48px,1fr));gap:8px}',
    '.av-no{min-height:48px;min-width:44px;border:1px solid var(--av-line);background:#fff;border-radius:10px;',
    'cursor:pointer;font:inherit;font-weight:600;color:var(--av-fg);position:relative}',
    '.av-no[data-state="answered"]{background:#e9f7ee;border-color:#a9dcbb}',
    '.av-no[data-state="current"]{background:var(--av-key);border-color:var(--av-key);color:#fff;box-shadow:0 0 0 2px rgba(43,108,176,.25)}',
    '.av-no .mk{position:absolute;top:2px;right:6px;font-size:12px;font-weight:700}',
    '.av-no .mk.ok{color:var(--av-ok)}',
    '.av-no .mk.bad{color:var(--av-bad)}',
    '.av-legend{display:flex;flex-wrap:wrap;gap:10px;font-size:12.5px;color:var(--av-dim);margin:8px 0 0}',
    '.av-legend i{display:inline-block;width:14px;height:14px;border-radius:4px;border:1px solid var(--av-line);vertical-align:-2px;margin-right:4px}',
    '.av-confirm{border:1px solid #f0d3a8;background:#fff8ec;border-radius:10px;padding:10px 12px;margin:0 0 12px}',
    '.av-confirm .msg{font-weight:600;margin:0 0 8px}',
    '.av-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
    /* 右下角常驻「交卷」：手机上拇指够得着，不随内容滚走；有未答题时带角标。
     * ⚠ 贴底那一档要**抬过手机自己的手势条 / 浏览器底栏**（用户报"答题时找不到返回首页的按钮"，
     *   那一排与这颗同在 `bottom:14px`）—— 安全区 + 固定余量，普通值先兜底（老浏览器不认 env()）。 */
    '.av-fab{position:fixed;right:14px;bottom:22px;bottom:calc(env(safe-area-inset-bottom, 0px) + 22px);',
    'z-index:45;min-height:52px;min-width:112px;padding:0 18px;border:0;',
    'border-radius:26px;background:var(--av-key);color:#fff;font:600 16px/1.2 inherit;cursor:pointer;',
    'box-shadow:0 6px 18px rgba(0,0,0,.24);display:inline-flex;align-items:center;gap:8px}',
    '.av-fab[disabled]{opacity:.45;cursor:default}',
    '.av-fab .cnt{background:#fff;color:var(--av-key);border-radius:999px;padding:1px 8px;font-size:13px;font-weight:700}',
    '.av-fab-off .av-fab,.av-fab[hidden]{display:none}',
    /* 快捷面板的表头给常驻按钮**让位**：按钮宽 112 + 右边距 14 + 间隙 12 = 138px
     * （实测：只留 118px 时，「展开」按钮和常驻「交卷」会贴在一起） */
    '.qp-head{padding-right:138px}',
    /* 题号索引可折叠：大卷时不再占满一屏 */
    '.av-navfold summary{cursor:pointer;font-size:13px;color:var(--av-dim);padding:2px 0;min-height:44px;display:flex;align-items:center}',
    '.av-navfold[open] summary{margin-bottom:6px}',
    /* 成绩单：分数大字 + 圆环 + 及格/优秀刻度 */
    '.av-ring{--p:0;width:132px;height:132px;border-radius:50%;margin:8px auto 12px;display:flex;align-items:center;justify-content:center;',
    'background:conic-gradient(var(--av-key) calc(var(--p)*1%),#e9edf2 0)}',
    '.av-ring>span{width:104px;height:104px;border-radius:50%;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center}',
    '.av-ring b{font-size:26px;line-height:1.15}',
    '.av-ring i{font-style:normal;font-size:12.5px;color:var(--av-dim)}',
    '.av-scale{position:relative;height:10px;border-radius:999px;background:#e9edf2;margin:12px 2px 4px}',
    '.av-scale .fill{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:var(--av-key)}',
    '.av-scale .tick{position:absolute;top:-4px;width:2px;height:18px;background:#b42318;border-radius:2px}',
    '.av-scale .tick.ex{background:#1a7f37}',
    '.av-scale-lb{display:flex;justify-content:space-between;font-size:12px;color:var(--av-dim)}',
    '@media (max-width:420px){.av-btn{flex:1 1 auto;min-width:0}.av-title{font-size:15px}}'
  ].join('');

  function injectCss(doc) {
    if (!doc || doc.getElementById(CSS_ID)) return;
    const st = doc.createElement('style');
    st.id = CSS_ID; st.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(st);
  }
  function el(doc, tag, cls, text) {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);   // 用户数据一律 textContent
    return n;
  }

  /*
   * mount({ container, session, onChange, onSubmit, onFinish, doc, mountPanel })
   *   onChange(session)  面板改完参数/作答后回调（调用方负责落盘，本层不碰存储）
   *   onSubmit(result)   提交一题后回调（带判分结果与揭示决策）
   *   onFinish(summary)  交卷后回调
   *   mountPanel=false   不挂快捷面板（自检页单独测面板时用）
   * 返回 { el, destroy, refresh(), session(), setSession(next), stats() }
   */
  function mount(opts) {
    const o = opts || {};
    const doc = o.doc || (o.container ? o.container.ownerDocument : null) ||
                (typeof document !== 'undefined' ? document : null);
    if (!doc) throw new Error('AttemptView.mount 需要一个 document');
    if (!o.container) throw new Error('AttemptView.mount 需要 container');
    injectCss(doc);

    let session = o.session || AttemptCore.createSession({ questions: [] });
    let submissions = 0, reveals = 0, confirmState = null;
    let restarts = 0;                                 // 「再考一张」点了几次（stats 里可核）

    const rootEl = el(doc, 'div', 'av-root');
    rootEl.setAttribute('data-av-root', '1');
    o.container.appendChild(rootEl);

    let panel = null, panelHost = null;

    /* 宽/窄由**本容器的实际宽度**决定（不是窗口宽度）：合并版里同一个作答界面可能被塞进 375px 的窄宿主。
     * ≥820px → 加 `.av-wide`：题干与答案解析并排、动作条钉在底部（用户要求"一页尽量装下、别把下一题挤出去"）。
     * ⚠ 必须量 rootEl（或它所在的宿主），而不是 window.innerWidth —— 自检页就是在宽窗口里放一个 375px 宿主。 */
    const WIDE_MIN = 820;
    function syncWide() {
      let w = 0;
      try {
        /* ⚠ 必须量**宿主/挂载点**的宽度，不能量 .av-root 自己的：
         *   .av-root 带 `max-width:760px`，在 1160px 的宽屏里它也只有 760 → 永远判不出宽屏
         *   （第一版就这么写的，真浏览器取证当场抓到：「1160px 宿主 → 没进宽屏模式」）。 */
        const host = o.container || rootEl.parentNode;
        if (host && host.getBoundingClientRect) w = host.getBoundingClientRect().width || 0;
        if (!w && host && host.clientWidth) w = host.clientWidth;
        if (!w && rootEl.getBoundingClientRect) w = rootEl.getBoundingClientRect().width || 0;
        if (!w && rootEl.clientWidth) w = rootEl.clientWidth;
      } catch (e) { w = 0; }                          // 量不到（mini-dom）→ 按窄屏走，行为与以前一致
      if (rootEl.classList && rootEl.classList.toggle) rootEl.classList.toggle('av-wide', w >= WIDE_MIN);
      return w;
    }
    const onWinResize = function () { syncWide(); };
    if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('resize', onWinResize);
    if (o.mountPanel !== false) {
      /* ⚠ 面板必须挂在 **av-root 之外**：paint() 第一行就是 `rootEl.textContent = ''`，
       *   早先面板宿主挂在 rootEl 里面 → 挂上之后被下一次重绘整棵清掉，
       *   于是"底部快捷设置"**从来没显示过**（页脚却还写着"改参数不需要跳页"）。
       *   面板本身是 fixed 定位，放哪儿都不影响它的位置。 */
      panelHost = el(doc, 'div');
      o.container.appendChild(panelHost);
      panel = QuickPanel.mount({
        container: panelHost, config: session.config,
        /* ⚠ **抽题与题量 / 分数线 两组不在这个面板里**（用户要求移到"开始作答前的设置页"）：
         *   答到一半改抽题设置**不会**换掉正在答的题（换了就等于把已答的丢掉），摆在答题界面上只会
         *   让人以为"改了就该立刻生效"；分数线同理 —— 那是出卷前定的事。 */
        excludeGroups: ['抽题与题量', '分数线', '判分'],
        /* ⚠ 这一处**不要标题**（`title: ''`）：左下角那颗固定的「返回题库」会压住表头文字
         *   （用户报的"返回题库把快捷设置的文字挡住了"）。去标题之后表头只剩「展开设置 / 收起设置」，
         *   那颗按钮就是这一排唯一的东西，谁也挡不住。 */
        title: '',
        /* ⚠ **默认收起**：展开的面板会占据屏幕底部一大块，而且会跟右下角常驻的「交卷」抢位置
         *   （实测：常驻按钮压住了面板右侧的"答案展示时机"按钮）。收起后只剩一行表头，
         *   右侧留白正好给常驻按钮；真要用面板时点「展开」，常驻按钮会自动让位（见下面的监听）。 */
        collapsed: true,
        onChange: function (nextCfg) {
          // **不跳页**：直接把新配置写回会话 → 下一题就按新设置走
          AttemptCore.setConfig(session, nextCfg);
          paint();
          if (o.onChange) o.onChange(session);
        }
      });
      /* 快捷面板一展开就把常驻「交卷」收起来，免得压住面板里的控件（收起时再放回来）。
       * 面板的表头按钮就是 data-qp="toggle"；两边同时翻，就不会出现"面板开了按钮还杵在上面"。 */
      try {
        const tg = doc.querySelector ? doc.querySelector('[data-qp="toggle"]') : null;
        if (tg && tg.addEventListener) {
          tg.addEventListener('click', function () {
            const cls = rootEl.classList;
            if (cls && cls.toggle) {
              cls.toggle('av-fab-off');
              /* 面板撑开后把底部留白一起放开（收起时只留 84px，省一屏空白） */
              cls.toggle('av-panel-open');
            } else {
              const on = !/av-fab-off/.test(String(rootEl.className || ''));
              rootEl.setAttribute('data-fab-off', String(on));
              rootEl.setAttribute('data-panel-open', String(on));
            }
          });
        }
      } catch (e) { /* mini-dom 里没有这些 API 也无所谓：收不起来只是视觉上多一个按钮 */ }
    }

    /* ---------- 画一题 ---------- */
    function paintQuestion(m, box) {
      if (!m.question) { box.appendChild(el(doc, 'div', 'av-hint', '这份试卷没有题目')); return; }
      const q = m.question;
      box.appendChild(el(doc, 'div', 'av-badge', q.typeLabel));
      box.appendChild(el(doc, 'div', 'av-stem', q.stem));

      const disabled = m.lockAnswer === true;
      if (q.kind === 'text') {
        const ta = el(doc, 'textarea', 'av-text');
        ta.value = q.value || '';
        ta.rows = 5;
        ta.setAttribute('data-av', 'input');
        ta.disabled = disabled;
        ta.setAttribute('placeholder', '在这里作答（可多行，分行写要点）');
        /* 自适应高度（上限由 CSS 的 max-height 管）：长答案不用在一个小框里来回滚 */
        const grow = function () {
          if (typeof ta.scrollHeight !== 'number' || !ta.style) return;
          ta.style.height = 'auto';
          const h = Math.max(132, Math.min(300, ta.scrollHeight + 2));
          ta.style.height = h + 'px';
        };
        grow();
        ta.addEventListener('input', function () {
          AttemptCore.answer(session, ta.value);
          grow();
          if (o.onChange) o.onChange(session);
          refreshActions();
          /* ⚠ 简答题**不做"输入即判分"**：打字是一串 input 事件，第一下按键就判分必然是误判。
           *   它的判分时机是"离开这道题 / 交卷"（见 leaveTo），这条对 autoCheck 开关也成立。 */
        });
        box.appendChild(ta);
        box.appendChild(el(doc, 'div', 'av-hint', '可多行输入，按采分关键词判分'));
      } else if (q.kind === 'judge') {
        const ul = el(doc, 'ul', 'av-opts');
        /* 标签只管"对/错"：圆标里已经有 √/× 了，再写一遍"对（√）"是重复 */
        [['true', '对'], ['false', '错']].forEach(function (p) {
          ul.appendChild(optionButton(m, p[0], p[1], disabled));
        });
        box.appendChild(ul);
      } else {
        const ul = el(doc, 'ul', 'av-opts');
        (q.options || []).forEach(function (op) {
          ul.appendChild(optionButton(m, op.label, op.label + '. ' + op.text, disabled));
        });
        box.appendChild(ul);            // ⚠ 这一行曾经漏了：选项按钮造好了却没挂上去（单选/多选整类点不了）
        if (!q.options || !q.options.length) box.appendChild(el(doc, 'div', 'av-hint', '这道题没有选项（可能是解析时丢了）'));
      }
    }

    function optionButton(m, value, label, disabled) {
      const q = m.question;
      const li = el(doc, 'li');
      const b = el(doc, 'button', 'av-opt');
      b.type = 'button';
      b.setAttribute('data-av', 'opt');
      b.setAttribute('data-av-value', String(value));
      const cur = String(m.question.value == null ? '' : m.question.value);
      const pressed = q.kind === 'judge'
        ? (value === 'true' ? cur === 'true' || cur === '√' || cur === '对' : cur === 'false' || cur === '×' || cur === '错')
        : (q.multi ? cur.indexOf(value) >= 0 : cur === value);
      b.setAttribute('aria-pressed', String(pressed));
      b.disabled = disabled === true;
      const lb = el(doc, 'span', 'lb', q.kind === 'judge' ? (value === 'true' ? '√' : '×') : value);
      const tx = el(doc, 'span', 'tx', label);
      const mk = el(doc, 'span', 'mk', '✓');            // 选中角标：不只靠颜色区分（CSS 只在 aria-pressed=true 时显示）
      b.appendChild(lb); b.appendChild(tx); b.appendChild(mk);
      b.addEventListener('click', function () {
        if (disabled) return;
        if (q.kind === 'judge') {
          AttemptCore.answer(session, value === 'true' ? '√' : '×');
        } else if (q.multi) {
          const set = new Set(cur.split('').filter(Boolean));
          if (set.has(value)) set.delete(value); else set.add(value);
          AttemptCore.answer(session, [...set].sort().join(''));
        } else {
          AttemptCore.answer(session, value);
        }
        afterAnswer();                 // 记录后按配置判分 / 自动翻页（原来这条链挂在「提交本题」上）
      });
      li.appendChild(b);
      return li;
    }

    /* ---------- 揭示区（答案/解析/命中明细） ---------- */
    function paintReveal(m, box) {
      if (!m.submitted) return;
      const p = el(doc, 'div', 'av-panel');
      const head = el(doc, 'div', 'av-verdict ' + (m.score && m.score.correct ? 'ok' : 'bad'));
      head.textContent = m.score
        ? (m.score.correct ? '答对了' : '答错了') + '（' + m.score.score + ' / ' + m.score.full + ' 分）'
        : '';
      p.appendChild(head);
      if (m.revealed) {
        /* 答错时明说一句"停在这儿看答案"（用户要求：答错要指出正确答案 **且** 不自动翻页）——
         * 不说的话，用户会以为"自动翻页怎么不灵了"。 */
        if (m.score && m.score.correct === false) {
          p.appendChild(el(doc, 'div', 'av-hint', '答错了：看完正确答案自己点「下一题」'));
        }
        p.appendChild(el(doc, 'h4', null, '正确答案：' + (m.answerText || '（无）')));
        if (m.showExplain) p.appendChild(el(doc, 'div', 'av-expl', m.explain || '（这道题没有解析）'));
        /* 明细标签按**题型**取舍（用户要求：多选题解析下面那排「命中 / 未命中」删掉）——
         * 所以把题型交给 paintDetail，界面层只做取舍，不动判分给的数据。 */
        if (m.detail) p.appendChild(paintDetail(m.detail, m.question && m.question.type));
      } else {
        p.appendChild(el(doc, 'div', 'av-hint', '答案与解析等整卷结束后显示'
          + (m.revealReason ? '（' + m.revealReason + '）' : '')));
      }
      box.appendChild(p);
    }

    /* 明细标签。`type` = 题型（'单选' / '多选' / '判断' / '简答'）。
     * 用户要求：**多选题不再显示「命中 / 未命中」**那排小标签 —— 选项上已经有 ✓ / ✗（自己的选择）与
     * 前面的「正确答案：AB」，再列一遍"命中 A、未命中 C"是重复信息。
     *   · 多选**保留「错选」**：它点出"你选的哪个是错的"，别处没有这个信息；
     *   · 简答的「命中 / 未命中」是**采分关键词**，保留（那是它唯一的得分依据，删了就没法自查）。 */
    function paintDetail(d, type) {
      const wrap = el(doc, 'div');
      const isMulti = (type === '多选');
      const kv = el(doc, 'div', 'av-kv');
      if (d.hit) kv.appendChild(el(doc, 'span', null, '命中 ' + d.hitCount + '/' + d.total));
      if (d.ratio != null) kv.appendChild(el(doc, 'span', null, '命中率 ' + Math.round(d.ratio * 100) + '%'));
      if (d.want != null && d.got != null) kv.appendChild(el(doc, 'span', null, '你答 ' + (Array.isArray(d.got) ? d.got.join('') || '（空）' : d.got)));
      if (kv.childNodes.length) wrap.appendChild(kv);
      const chips = el(doc, 'div', 'av-chips');
      if (!isMulti) {
        (d.hit || []).forEach(function (t) { chips.appendChild(el(doc, 'span', 'av-chip hit', '命中：' + t)); });
        (d.miss || []).forEach(function (t) { chips.appendChild(el(doc, 'span', 'av-chip miss', '未命中：' + t)); });
      }
      (d.wrong || []).forEach(function (t) { chips.appendChild(el(doc, 'span', 'av-chip wrong', '错选：' + t)); });
      if (chips.childNodes.length) wrap.appendChild(chips);
      if (d.unscorable) {
        wrap.appendChild(el(doc, 'div', 'av-hint',
          d.unscorable === 'noKeywords' ? '这道题没有采分关键词，不计分（需人工处理）'
          : d.unscorable === 'noAnswerKey' ? '这道题没有答案键，不计分' : '这道题不可自动判分'));
      }
      return wrap;
    }

    /* ---------- 题号索引（点哪跳哪 + 状态实时） ---------- */
    function paintNav(m, box) {
      const nav = el(doc, 'div', 'av-nav');
      const head = el(doc, 'div', 'h');
      head.appendChild(el(doc, 'span', null, '题号（点一下跳过去）'));
      /* ⚠ "已答 N / M""未答 K"这两枚徽章这里**不再重复画**：顶栏那行已经写了同样两个数
       *   （用户要求"把不必要的小字删掉"）。只留"人工订正"这一枚 —— 它别处没有。 */
      if (m.finished && session.summary && session.summary.manualCount) {
        head.appendChild(el(doc, 'span', 'av-badge', '人工订正 ' + session.summary.manualCount + ' 题'));
      }
      nav.appendChild(head);

      const grid = el(doc, 'div', 'av-grid');
      const cells = AttemptCore.navModel(session);
      const revealedAny = cells.some(function (c) { return c.revealed; });
      cells.forEach(function (cell) {
        const b = el(doc, 'button', 'av-no', cell.label);
        b.type = 'button';
        b.setAttribute('data-av', 'no');
        b.setAttribute('data-av-index', String(cell.index));
        b.setAttribute('data-state', cell.state);
        b.setAttribute('aria-current', String(cell.current));
        b.setAttribute('aria-label', '第 ' + cell.label + ' 题' + (cell.answered ? '（已答）' : '（未答）'));
        if (cell.correct === true) b.appendChild(el(doc, 'span', 'mk ok', '✓'));
        if (cell.correct === false) b.appendChild(el(doc, 'span', 'mk bad', '✗'));
        b.addEventListener('click', function () {
          leaveTo(function () {
            AttemptCore.goto(session, cell.index);
            confirmState = null;              // 跳题即关掉"未答提示"
          });
          if (o.onNavigate) o.onNavigate(session, cell.index);
        });
        grid.appendChild(b);
      });
      const lg = el(doc, 'div', 'av-legend');
      const item = function (color, text) {
        const s = el(doc, 'span');
        const i = el(doc, 'i'); i.style.background = color;
        s.appendChild(i); s.appendChild(el(doc, 'span', null, text));
        return s;
      };
      lg.appendChild(item('#2b6cb0', '当前题'));
      lg.appendChild(item('#e9f7ee', '已答'));
      lg.appendChild(item('#fff', '未答'));
      if (revealedAny) lg.appendChild(el(doc, 'span', null, '✓ 对 ✗ 错'));
      /* 折叠：50 题的卷子不该让题号网格占满一屏。
       * 默认收起（只留一行进度），交卷后**默认展开**（那会儿正是要逐题回看的时候）。 */
      const fold = el(doc, 'details', 'av-navfold');
      if (m.finished) fold.setAttribute('open', 'open');
      /* 只写"第几题"：折叠起来时这是唯一的进度指示；"点开跳题"这种说明由上面的标题承担 */
      const sum = el(doc, 'summary', null, '题号 · 第 ' + (m.index + 1) + ' / ' + m.progress.total + ' 题');
      fold.appendChild(sum);
      fold.appendChild(grid);
      fold.appendChild(lg);
      nav.appendChild(fold);
      box.appendChild(nav);
    }

    /* ---------- 交卷前的未答提示（返回继续 / 仍然交卷） ---------- */
    function paintConfirm(box) {
      if (!confirmState) return;
      const bar = el(doc, 'div', 'av-confirm');
      bar.appendChild(el(doc, 'div', 'msg', confirmState.message || '还有题没作答'));
      const row = el(doc, 'div', 'av-actions');
      const back = el(doc, 'button', 'av-btn', '返回继续作答');
      back.type = 'button'; back.setAttribute('data-av', 'back');
      /* 用户要求："未作答完点击交卷后的返回按钮应该自动跳转未作答的题目"。
       *   所以「返回继续作答」不只是关掉提示 —— 还要**直接跳到第一道没作答的题**，
       *   省得用户自己对着一串题号去找。目标下标由核心的 gate() 给出（就是提示里那一串题号的第 1 个），
       *   找不到（例如门禁因别的原因拦下）就只关提示，行为退化成老样子。 */
      back.addEventListener('click', function () {
        const list = (confirmState && confirmState.unanswered) || [];
        const target = list.length ? list[0] : null;
        confirmState = null;
        if (!target) { paint(); return; }
        leaveTo(function () { AttemptCore.goto(session, target.index); });
        if (o.onNavigate) o.onNavigate(session, target.index);
      });
      const go = el(doc, 'button', 'av-btn', '仍然交卷');
      go.type = 'button'; go.setAttribute('data-av', 'force');
      go.addEventListener('click', function () {
        confirmState = null;
        const r = AttemptCore.finish(session, { confirmUnanswered: true });
        paint();
        if (r.ok && o.onFinish) o.onFinish(r.summary);
      });
      row.appendChild(back); row.appendChild(go);
      bar.appendChild(row);
      box.appendChild(bar);
    }

    /* 简答题的人工订正区（只出现在回看卡片里，即交卷后） */
    function paintManual(box, r) {
      if (!r || r.type !== '简答') return;
      // **没作答的题不给订正入口**（否则成绩单会同时说"这题未答"又"这题订正过、有分"）
      if (!r.answered) {
        const hint = el(doc, 'div', 'av-panel');
        hint.appendChild(el(doc, 'h4', null, '人工订正'));
        hint.appendChild(el(doc, 'div', 'av-hint', '这一题没有作答，无法订正（要得分请先补上作答）'));
        box.appendChild(hint);
        return;
      }
      const p = el(doc, 'div', 'av-panel');
      const head = el(doc, 'h4');
      head.textContent = '人工订正' + (r.manual ? '（已订正：' + (r.autoScore != null ? '自动 ' + r.autoScore + ' → ' : '') + '人工 ' + r.score + '）' : '');
      p.appendChild(head);
      p.appendChild(el(doc, 'div', 'av-hint', '点关键词标为命中，或直接给分'));

      /* 关键词格子：自动命中的显示为已命中；未命中的点一下 = 人工标为命中 */
      const autoHit = (r.autoDetail && r.autoDetail.hit) || [];
      const manualHits = (r.manual && r.manual.hits) || [];
      const allKws = (r.detail && (r.detail.hit || []).concat(r.detail.miss || [])) || [];
      const chips = el(doc, 'div', 'av-chips');
      allKws.forEach(function (t) {
        const isAuto = autoHit.indexOf(t) >= 0;
        const isManual = manualHits.indexOf(t) >= 0;
        const b = el(doc, 'button', 'av-chip ' + ((isAuto || isManual) ? 'hit' : 'miss'), (isAuto ? '命中：' : (isManual ? '人工命中：' : '未命中：')) + t);
        b.type = 'button';
        b.setAttribute('data-av', 'kw');
        b.setAttribute('data-av-kw', t);
        b.setAttribute('aria-pressed', String(isAuto || isManual));
        b.disabled = isAuto;                           // 自动命中的不用点（人工命中可再点一下取消）
        b.addEventListener('click', function () {
          const next = manualHits.slice();
          const at = next.indexOf(t);
          if (at >= 0) next.splice(at, 1); else next.push(t);
          const res = AttemptCore.applyManual(session, session.index, { hits: next, score: (r.manual && r.manual.score != null) ? r.manual.score : null });
          if (res.ok) { paint(); if (o.onManual) o.onManual(res); }
        });
        chips.appendChild(b);
      });
      if (chips.childNodes.length) p.appendChild(chips);

      /* 直接给分 */
      const row = el(doc, 'div', 'av-actions');
      const num = el(doc, 'input', 'qp-num');
      num.type = 'number'; num.min = '0'; num.max = String(r.full); num.step = '0.5';
      num.value = String(r.manual && r.manual.score != null ? r.manual.score : r.score);
      num.setAttribute('data-av', 'manual-score');
      const apply = el(doc, 'button', 'av-btn', '按此分数订正');
      apply.type = 'button'; apply.setAttribute('data-av', 'manual-apply');
      apply.addEventListener('click', function () {
        const res = AttemptCore.applyManual(session, session.index, {
          score: Number(num.value), note: '手动指定分数',
          hits: (r.manual && r.manual.hits) || []
        });
        if (res.ok) { paint(); if (o.onManual) o.onManual(res); }
      });
      row.appendChild(num); row.appendChild(apply);
      if (r.manual) {
        const undo = el(doc, 'button', 'av-btn', '撤销订正');
        undo.type = 'button'; undo.setAttribute('data-av', 'manual-undo');
        undo.addEventListener('click', function () {
          const res = AttemptCore.clearManual(session, session.index);
          if (res.ok) { paint(); if (o.onManual) o.onManual(res); }
        });
        row.appendChild(undo);
      }
      p.appendChild(row);
      const kv = el(doc, 'div', 'av-kv');
      kv.appendChild(el(doc, 'span', null, '满分 ' + r.full + ' 分'));
      p.appendChild(kv);
      box.appendChild(p);
    }
    function paintSummary(box) {
      const s = session.summary;
      // ⚠ 渲染函数**不许有副作用**：早先这里用 `|| finish(confirmUnanswered:true)` 兜底，
      //   等于"画着画着把会话改成已交卷"。真没结算就如实画一句提示，结算交给「交卷」按钮。
      if (!s) { box.appendChild(el(doc, 'div', 'av-hint', '还没结算（请点「交卷」）')); return; }
      const R = AttemptCore.resultModel(session);
      const card = el(doc, 'div', 'av-done');
      card.appendChild(el(doc, 'h4', null, '整卷结束'));
      /* 分数一眼可读：大字 + 圆环 + 刻度条（及格/优秀线标出来，"差多少分"不再靠读数字） */
      const ring = el(doc, 'div', 'av-ring');
      if (ring.style) ring.style.cssText = '--p:' + Math.max(0, Math.min(100, Number(s.percent) || 0));
      const inner = el(doc, 'span');
      inner.appendChild(el(doc, 'b', null, String(Math.round(s.percent * 10) / 10) + '%'));
      inner.appendChild(el(doc, 'i', null, s.score + ' / ' + s.full + ' 分'));
      ring.appendChild(inner);
      card.appendChild(ring);
      card.appendChild(el(doc, 'div', null, '等级：' + s.level));
      if (R) {
        const scale = el(doc, 'div', 'av-scale');
        const fillEl = el(doc, 'i', 'fill');
        if (fillEl.style) fillEl.style.width = Math.max(0, Math.min(100, Number(s.percent) || 0)) + '%';
        scale.appendChild(fillEl);
        const pct = function (v) { return Math.max(0, Math.min(100, Number(v) || 0)); };
        const t1 = el(doc, 'i', 'tick');
        if (t1.style) t1.style.left = pct(R.pass) + '%';
        t1.setAttribute('title', '及格线 ' + R.pass + '%');
        const t2 = el(doc, 'i', 'tick ex');
        if (t2.style) t2.style.left = pct(R.excellent) + '%';
        t2.setAttribute('title', '优秀线 ' + R.excellent + '%');
        scale.appendChild(t1); scale.appendChild(t2);
        card.appendChild(scale);
        const lb = el(doc, 'div', 'av-scale-lb');
        lb.appendChild(el(doc, 'span', null, '0'));
        lb.appendChild(el(doc, 'span', null, '及格 ' + R.pass + '%'));
        lb.appendChild(el(doc, 'span', null, '优秀 ' + R.excellent + '%'));
        lb.appendChild(el(doc, 'span', null, '100'));
        card.appendChild(lb);
      }
      card.appendChild(el(doc, 'div', 'av-hint', '答对 ' + s.correctCount + ' / ' + s.total + ' 题　已答 '
        + s.answered + ' / ' + s.total + ' 题'
        + (s.unanswered.length ? '（未答 ' + s.unanswered.length + ' 题：第 ' + (s.skipped || []).join('、') + ' 题）' : '')
        + (s.manualCount ? '　人工订正 ' + s.manualCount + ' 题（第 ' + (s.manualLabels || []).join('、') + ' 题）' : '')));
      if (R) {
        const lines = el(doc, 'div', 'av-kv');
        /* 用户要求：分数线改说**比例**，并给出等效分数（"及格 60%（= 33 / 55 分）"）——
         * 只写"及格 60"会被读成"60 分"，而它是**占卷面满分的百分比**。 */
        const eqScore = function (p) { return Math.round(s.full * (Number(p) || 0)) / 100; };
        lines.appendChild(el(doc, 'span', null,
          '及格 ' + R.pass + '%（' + eqScore(R.pass) + ' / ' + s.full + ' 分）　优秀 ' + R.excellent + '%（' + eqScore(R.excellent) + ' / ' + s.full + ' 分）'));
        lines.appendChild(el(doc, 'span', null, R.note));
        if (timerOn() && timerTotal() > 0) lines.appendChild(el(doc, 'span', null, '用时 ' + fmtMs(timerTotal())));
        card.appendChild(lines);
        const bands = el(doc, 'div', 'av-hint');
        bands.textContent = '定档规则：' + R.bands.map(function (b) {
          return b.level + ' ' + b.from + '~' + b.to + (b.toInclusive ? '%' : '%（不含）');
        }).join('　');
        card.appendChild(bands);
        const chips = el(doc, 'div', 'av-chips');
        R.byType.forEach(function (t) {
          chips.appendChild(el(doc, 'span', 'av-chip', t.type + ' ' + t.score + '/' + t.full + '（对 ' + t.correct + '/' + t.total + '）'));
        });
        card.appendChild(chips);
      }
      box.appendChild(card);
    }

    /* 交卷后：当前这道题的"回看卡片"（用户作答 vs 正确答案 + 得分 + 明细） */
    function paintReview(box) {
      const list = AttemptCore.reviewList(session);
      const r = list[session.index];
      if (!r) return;
      const p = el(doc, 'div', 'av-panel');
      const head = el(doc, 'div', 'av-verdict ' + (r.correct ? 'ok' : 'bad'));
      head.textContent = '第 ' + r.label + ' 题（' + r.typeLabel + '）：'
        + (r.answered ? (r.correct ? '答对' : '答错') : '未作答')
        + '　得分 ' + r.score + ' / ' + r.full;
      p.appendChild(head);
      p.appendChild(el(doc, 'div', 'av-stem', r.stem));
      const kv = el(doc, 'div', 'av-kv');
      kv.appendChild(el(doc, 'span', null, '你的作答：' + (r.answered ? r.userAnswer : '（空）')));
      kv.appendChild(el(doc, 'span', null, '正确答案：' + (r.correctAnswer || '（无）')));
      p.appendChild(kv);
      if (r.explanation) p.appendChild(el(doc, 'div', null, '解析：' + r.explanation));
      if (r.detail && (r.detail.hit || r.detail.miss || r.detail.wrong)) p.appendChild(paintDetail(r.detail));
      if (r.unscorable) p.appendChild(el(doc, 'div', 'av-hint', '这道题不可自动判分（' + r.unscorable + '）'));
      box.appendChild(p);
    }

    /* ---------- 重画 ----------
     * ⚠ 这里**又把「提交本题」请回来了**（用户要求：多选与简答不自动判分）——
     *   但它不再常驻：**只有"这题答了却还没判分"时才出现**（多选/简答，或自动判分关着时的单选/判断）。
     *   于是"什么时候判分/揭示"由这几处决定：
     *     · 单选/判断 + 自动判分开着 → **点选项那一刻**就判（afterAnswer 里那条链）；
     *     · 多选/简答 → 用户点**「提交本题」**（submitThis 里那条链）；
     *     · 配置成"答完一题即显示"时 → **离开这道题**的那一刻自动提交它（否则永远等不到揭示）；
     *     · 交卷 → 统一结算（revel 时机=整卷结束时，答案也在这时显示）。
     *   这几种都**不锁定**已答的题：交卷前随时能改（刷题直觉）。
     */
    let actionsBox = null, fabBox = null;
    /* 待处理的"自动翻页"定时器：只在 `behavior.autoNextMs > 0` 时用得上。
     * 记 `pendingIndex` 是为了到点时**再看一眼**题号有没有变（用户可能自己翻走了 / 交卷了）。 */
    let jumpTimer = null, pendingIndex = -1;
    /* 正在等的这一跳要等多少毫秒（小加载条的动画时长就取它）。0 / null = 没有在等的跳。 */
    let pendingWaitMs = 0;
    /* ---------------- 答题计时（用户要求：悬浮球 + 可暂停 + 不占位置） ----------------
     * 状态住在 `session.timer = { ms, paused }` 里（随进度一起存本机，刷新/继续这一轮不归零）；
     * 视图这边只记三样东西：
     *   timerNode —— 当前那颗球的 DOM（paint 会重建整棵树，所以每次 paint 都要重新指过去）
     *   baseAt    —— 本段计时开始的那一刻（`ms` 是**之前累积**的）
     *   tickId    —— 每 500ms 只改球里的文字，**不重画整页**（重画会打断用户正在做的事） */
    let timerNode = null, baseAt = 0, tickId = null;
    function timerOn() { return behavior().timer === true; }
    function timerState() {
      if (!session.timer || typeof session.timer !== 'object') session.timer = { ms: 0, paused: false };
      if (typeof session.timer.ms !== 'number' || !isFinite(session.timer.ms)) session.timer.ms = 0;
      return session.timer;
    }
    /* 这一轮**累计已用**（毫秒）：暂停时就是 ms；跑着的时候再加上"本段已过去的时间" */
    function timerTotal() {
      const t = timerState();
      if (t.paused) return Math.max(0, Math.round(t.ms));
      const run = baseAt ? Math.max(0, Date.now() - baseAt) : 0;
      return Math.max(0, Math.round(t.ms + run));
    }
    /* mm:ss（超 1 小时给 h:mm:ss）—— 球和成绩单共用同一个格式 */
    function fmtMs(ms) {
      const total = Math.max(0, Math.round((ms || 0) / 1000));
      const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
      const pad = function (n) { return (n < 10 ? '0' : '') + n; };
      return (h > 0 ? (h + ':' + pad(m)) : String(m)) + ':' + pad(sec);
    }
    function stopTick() { if (tickId !== null) { clearInterval(tickId); tickId = null; } }
    function startTick() {
      stopTick();
      if (!timerOn()) return;
      tickId = setInterval(function () {
        if (!timerNode) return;                       // 还没画 / 已交卷：不碰
        timerNode.textContent = fmtMs(timerTotal());
      }, 500);
    }
    /* 暂停/继续（点球一下）。暂停时把本段折进 ms 并落盘（走 onChange → 页面的 save）。 */
    function toggleTimer() {
      const t = timerState();
      if (t.paused) { t.paused = false; baseAt = Date.now(); }
      else { t.ms = timerTotal(); t.paused = true; baseAt = 0; }
      paint();
      if (o.onChange) o.onChange(session);
      return { paused: t.paused, ms: t.ms };
    }
    /* 挂球：只在开了计时、且还没交卷时出现（交卷后用时写在成绩单里）。
     * `position:fixed` —— **不占排版位置**（用户明确要求）。 */
    function paintTimer() {
      timerNode = null;
      if (!timerOn() || session.finished) { stopTick(); return; }
      const t = timerState();
      if (!t.paused && !baseAt) baseAt = Date.now();   // 第一次开表（或恢复后继续）
      const b = el(doc, 'button', 'av-timer' + (t.paused ? ' paused' : ''));
      b.type = 'button';
      b.setAttribute('data-av', 'timer');
      b.setAttribute('aria-label', t.paused ? '已暂停，点一下继续计时' : '正在计时，点一下暂停');
      b.setAttribute('title', t.paused ? '已暂停 · 点一下继续' : '答题计时 · 点一下暂停');
      const digits = el(doc, 'b', null, fmtMs(timerTotal()));
      b.appendChild(digits);
      b.appendChild(el(doc, 'span', 'tag', t.paused ? '已暂停 ▶' : '计时 ⏸'));
      b.addEventListener('click', function () { toggleTimer(); });
      /* tick **只改这串数字**（不重画整页）：拿 digits 当更新目标 */
      timerNode = digits;
      rootEl.appendChild(b);
      startTick();
    }
    function behavior() { return (session.config && session.config.behavior) || {}; }
    function cancelJump() {
      if (jumpTimer !== null) { clearTimeout(jumpTimer); jumpTimer = null; }
      pendingIndex = -1;
      pendingWaitMs = 0;
    }
    /* 真的翻页。`from` = 排定时器时所在的题号：到点后题号变了就**不翻**（用户已经自己走过）。 */
    function doJump(from) {
      if (session.index !== from) return;
      const m = AttemptCore.view(session);
      if (m.finished) return;
      if (session.index >= session.questions.length - 1) return;
      AttemptCore.next(session);
      if (o.onNavigate) o.onNavigate(session, session.index);
      if (o.onChange) o.onChange(session);
      paint();
    }
    /* 按 FlowCore 给的 `waitMs` 排跳：0 = 立刻（同一个 tick 里翻），>0 = 等一会儿。
     * 期间用户再改答案 → afterAnswer 会先 cancelJump 再重排（= 重新计时）。 */
    function scheduleJump(waitMs) {
      const from = session.index;
      const wait = (typeof waitMs === 'number' && isFinite(waitMs) && waitMs > 0) ? Math.floor(waitMs) : 0;
      if (wait === 0) { doJump(from); return; }
      pendingIndex = from;
      pendingWaitMs = wait;                       // 小加载条的动画时长（0 的那条路已经立刻翻了，不会有条）
      jumpTimer = setTimeout(function () { jumpTimer = null; pendingIndex = -1; pendingWaitMs = 0; doJump(from); }, wait);
    }
    /*
     * **作答之后该发生什么**（这条链原来是挂在「提交本题」按钮上的，按钮去掉后必须补回来）：
     *   · 自动判分开着 → **单选/判断点完立刻判分**；
     *   · **多选与简答不自动判分**（用户要求：多选要连点好几下、简答在打字）——
     *     它们点了/打了只是"记下来"，判分要点「提交本题」（见 refreshActions 里那颗按钮）；
     *   · 自动翻页开着 → 要不要翻由 `FlowCore.afterSubmit().willJump` 决定，
     *     **等多久**由它的 `waitMs` 决定（`behavior.autoNextMs`）——界面只读这两个值，不自己解释配置；
     *   · ⚠ 需要"显式提交"的题型（多选/简答），**在提交之前绝不自动翻**：
     *     否则点一下多选 A 就被翻走，B/D 还没点（那是把用户的选择丢掉）。
     *   · 简答题永远不在这里判/跳（打字是一串事件）→ 它的时机是「提交本题 / 离开该题 / 交卷」。
     */
    function afterAnswer() {
      const b = behavior();
      /* ⚠ `kind` / `multi` **只存在于渲染模型里**（原始题对象上是 `type:'多选'`），
       *   读原始对象会永远拿到 undefined —— 那样"多选不自动翻"的守卫等于没有（浏览器实测抓到的）。 */
      const m0 = AttemptCore.view(session);
      const qv = m0.question || {};
      const isText = qv.kind === 'text';
      const isMulti = qv.multi === true;
      /* 这两个题型**不自动判分**：得用户点「提交本题」（用户要求） */
      const needsSubmit = isText || isMulti;
      if (b.autoCheck === true && !needsSubmit) {
        if (m0.canSubmit && !m0.submitted) {
          const r = AttemptCore.submitCurrent(session);
          if (r.ok) { submissions++; if (r.reveal && r.reveal.showAnswer) reveals++; }
        }
      }
      afterJudge();
    }
    /* 判分之后（不管是自动判的还是点「提交本题」判的）：算要不要翻、排定时器、重画 */
    function afterJudge() {
      const m1 = AttemptCore.view(session);
      /* 渲染模型里也没有 `answered` 这个字段：**"这题已作答" = canSubmit（已答未判）或 submitted（已判）** */
      const answered = !!(m1.canSubmit || m1.submitted);
      const qv1 = m1.question || {};
      const needsSubmit = (qv1.kind === 'text') || (qv1.multi === true);
      const res = FlowCore.afterSubmit(session.config, {
        answered: answered, checked: !!m1.submitted, finished: m1.finished,
        /* ⚠ 把判分结果整份交出去：**没得全分就不自动翻**（用户要求 —— 停在这一题看正确答案）。
         *   界面不自己判断对错/满分，只把渲染模型里的 score 原样转达。 */
        correct: m1.score ? (m1.score.correct === true) : null,
        score: m1.score ? m1.score.score : null,
        full: m1.score ? m1.score.full : null
      });
      cancelJump();                                   /* 重新作答 = 重新计时（绝不排两个定时器） */
      /* ⚠ 多选/简答**提交之前**不翻（点一下就被翻走会把还没点的选项丢掉） */
      const canJump = res.willJump && !(needsSubmit && !m1.submitted)
                      && session.index < session.questions.length - 1;
      if (canJump) scheduleJump(res.waitMs);
      if (o.onChange) o.onChange(session);
      paint();
    }
    /* 「提交本题」：多选/简答（以及自动判分关着时的单选/判断）用它显式判分 */
    function submitThis() {
      const r = AttemptCore.submitCurrent(session);
      if (!r.ok) return r;
      submissions++; if (r.reveal && r.reveal.showAnswer) reveals++;
      afterJudge();
      return r;
    }
    function autoSubmitOnLeave(m) {
      if (m.finished || !m.canSubmit || m.submitted) return false;
      const b = behavior();
      const timing = session.config && session.config.reveal && session.config.reveal.answerTiming;
      const isText = !!(m.question && m.question.kind === 'text');
      if (!isText) {
        /* 选择题：自动判分开着的话答题时就判过了，这里轮不到；
         * 关着的时候，只有"答完即看答案"还等得到判分 —— 没有提交按钮了，离开是唯一时机。 */
        if (b.autoCheck === true) return false;
        if (timing !== 'each') return false;
      }
      /* 简答题：**不论开关，离开就判** —— 打字途中判必然误判，交卷前又总得有个时机。 */
      const r = AttemptCore.submitCurrent(session);
      if (r.ok) { submissions++; if (r.reveal && r.reveal.showAnswer) reveals++; }
      return !!(r.ok && r.advanced);
    }
    function leaveTo(fn) {
      cancelJump();                                   // 手动翻页 → 取消待处理的自动跳
      const advanced = autoSubmitOnLeave(AttemptCore.view(session));
      if (!advanced) fn();                            // 自动提交时若已按配置翻页，就别再翻一次
      paint();
    }
    function refreshActions() {
      const m = AttemptCore.view(session);
      if (actionsBox) {
        actionsBox.textContent = '';
        const mk = function (id, label, cls, fn, disabled) {
          const b = el(doc, 'button', 'av-btn' + (cls ? ' ' + cls : ''), label);
          b.type = 'button'; b.setAttribute('data-av', id); b.disabled = !!disabled;
          b.addEventListener('click', fn);
          return b;
        };
        if (!m.finished) {
          /* 小加载条：只有当**有一个"等一会儿就翻"的定时器在跑**时才出现（用户要求"每次自动翻页
           * 时都要有一个小加载条提示翻页"）。所以它跟 `jumpTimer` 同生共死：排上就出现、
           * 翻页 / 取消 / 换题就消失 —— 不用另立一套状态。 */
          if (jumpTimer !== null) {
            const bar = el(doc, 'div', 'av-jumpbar');
            bar.setAttribute('data-av', 'jumpbar');
            bar.setAttribute('role', 'status');
            bar.setAttribute('aria-label', '正在自动翻页');
            const pad = el(doc, 'span', 'pad');
            const fill = el(doc, 'i', 'fill');
            /* 动画时长 = 这一跳要等的毫秒数（内联写死，别去读配置自己再解释一遍） */
            fill.style.animationDuration = pendingWaitMs + 'ms';
            pad.appendChild(fill);
            bar.appendChild(pad);
            bar.appendChild(el(doc, 'span', 'av-jumpnote', '正在翻页…'));
            actionsBox.appendChild(bar);
          }
          /* ⚠ 用户要求：多选/简答**不自动判分**，所以要给一颗「提交本题」（回答后、还没判分时出现）。
           *   自动判分关着时单选/判断也会出现这颗按钮 —— 判据就一句：**这题答了但还没判**。
           *   （单选/判断 + 自动判分开着时，判分是点选项时同步发生的，`canSubmit` 观察不到 → 按钮不出现。） */
          if (m.canSubmit) {
            actionsBox.appendChild(mk('submit', '提交本题', 'primary', function () { submitThis(); }));
          }
          actionsBox.appendChild(mk('prev', '上一题', '', function () { leaveTo(function () { AttemptCore.prev(session); }); }, !m.canPrev));
          actionsBox.appendChild(mk('next', '下一题', m.canSubmit ? '' : 'primary',
            function () { leaveTo(function () { AttemptCore.next(session); }); }, !m.canNext));
          /* ⚠ 「重新生成试卷」（原来的「再抽一次」）**不在这里**：用户要求把它挪到「返回题库」旁边
           *   （左下角那条固定栏）。那是**页面外壳**的位置，由页面自己画那颗按钮；
           *   这里只在交卷之后画「再考一张」（见下面的 else 分支）——两者不是同一颗按钮。 */
        } else if (o.onRestart) {
          /* 交卷之后（用户要求）：给一颗**「再考一张」**快捷键 —— 省得先回题库再找卷。
           * ⚠ 页面（answer-template）没提供 onRestart 时不画这颗按钮（错题本的"跳过去"视图就是这样），
           *   所以这里必须是 `else if (o.onRestart)`，不能无条件画。 */
          actionsBox.appendChild(mk('restart', '再考一张（按当前设置换一批题）', 'primary', function () {
            restarts++;
            o.onRestart(session);
          }));
        }
      }
      /* 右下角常驻「交卷」（未答时带角标） */
      if (fabBox) fabBox.textContent = '';
      if (!m.finished && fabBox) {
        const fab = el(doc, 'button', 'av-fab', '交卷');
        fab.type = 'button'; fab.setAttribute('data-av', 'finish'); fab.setAttribute('aria-label', '交卷');
        const un = m.progress.unanswered;
        if (un > 0) fab.appendChild(el(doc, 'span', 'cnt', String(un)));
        fab.addEventListener('click', function () {
          const r = AttemptCore.finish(session);            // 有未答题 → 不结算，先给提示
          if (!r.ok && r.needConfirm) {
            confirmState = r;
            paint();
            if (o.onGate) o.onGate(r);
            return;
          }
          paint();
          if (r.ok && o.onFinish) o.onFinish(r.summary);
        });
        fabBox.appendChild(fab);
      }
    }

    function paint() {
      if (session.finished) confirmState = null;      // 交卷后不该再留着"未答提示"
      syncWide();                                     // 先按**本容器宽度**定宽/窄（宽屏才分栏 + 钉住动作条）
      rootEl.textContent = '';
      const m = AttemptCore.view(session);
      /* 交卷状态也挂一个类：窄屏要靠它把「题号栏 → 成绩单 → 试题回顾」的 DOM 顺序摆回
       * 「成绩单 → 题号栏 → 试题回顾」（交卷后第一眼该看分数，不该先看题号网格）。 */
      if (rootEl.classList && rootEl.classList.toggle) rootEl.classList.toggle('av-finished', !!m.finished);
      const head = el(doc, 'div', 'av-head');
      head.appendChild(el(doc, 'div', 'av-title', m.title));
      /* ⚠ 顶部**不再重复显示「第 N / M 题」**（用户要求"去除顶部多余的一个题号显示"）：
       *   题号在下面那个「题号 · 第 N / M 题」的折叠栏里已经有了（点它就能跳题）。
       *   这里只留「已答 N/M」——那是**进度**读数，折叠栏里没有。 */
      head.appendChild(el(doc, 'span', 'av-badge', '已答 ' + m.progress.answered + '/' + m.progress.total));
      rootEl.appendChild(head);
      const bar = el(doc, 'div', 'av-bar');
      const fill = el(doc, 'i');
      fill.style.width = m.progress.percent + '%';
      bar.appendChild(fill);
      rootEl.appendChild(bar);

      const body = el(doc, 'div', 'av-body');
      rootEl.appendChild(body);
      const navBox = el(doc, 'div', 'av-navbox');   // 题号跳转单独一层：宽屏由 grid-area 摆位（答题中在题目下面、交卷页在右上）
      const main = el(doc, 'div', 'av-main');
      const side = el(doc, 'div', 'av-side');
      /* ⚠ DOM 顺序固定 **main → navBox → side**：窄屏按这个顺序读 —— 答题中是"题干 → 题号 → 解析"
       *   （用户要求题号放题目下面），交卷页由 `.av-finished` 的 flex order 摆成"成绩单 → 题号 → 回顾"。 */
      body.appendChild(main); body.appendChild(navBox); body.appendChild(side);
      if (m.finished) {
        /* 交卷之后：成绩单留在**左栏**；**题号跳题那栏搬到右栏顶部**（与答题时的位置一致 ——
         *   用户要求："作答完的页面按题号跳题那栏也放在右边上面一点的位置"），
         *   「试题回顾」顺下来放右栏下方。
         *   ⚠ DOM 顺序仍是 navBox → main → side，窄屏（display:block）看到的顺序与以前一样：
         *     题号索引 → 成绩单 → 试题回顾。 */
        paintSummary(main);                    // 成绩单（含人工订正计数）
        paintNav(m, navBox);                   // 题号索引：宽屏在右上，窄屏在最上面（仍可点 → 逐题回看）
        paintReview(side);                     // 试题回顾（当前这道题：你的作答 vs 正确答案 + 明细）
        paintManual(side, AttemptCore.reviewList(session)[session.index]);   // 简答题的订正入口（跟回顾贴在一起）
      } else {
        /* 用户要求："题号跳转功能放一边" + "选项要看得全" ⇒
         *   题号跳转挂进独立的 navBox（宽屏被排到**右栏顶部**），左栏只放题干与选项、**不限高**。 */
        paintNav(m, navBox);
        paintConfirm(main);                    // 未答提示（若正处于"待确认交卷"）
        paintQuestion(m, main);
        paintReveal(m, side);                  // 答案解析进右栏（宽屏并排；窄屏仍是顺序往下）
      }

      actionsBox = el(doc, 'div', 'av-actions');
      rootEl.appendChild(actionsBox);
      /* 常驻「交卷」单独挂在根上（fixed 定位，不随内容滚走） */
      fabBox = el(doc, 'div');
      rootEl.appendChild(fabBox);
      paintTimer();                                  // 答题计时的悬浮球（开了才出现）
      refreshActions();
      if (panel) panel.refresh(session.config);      // 面板显示的值与会话保持一致
    }

    paint();
    return {
      el: rootEl,
      destroy: function () {
        cancelJump();
        stopTick();                                  // 计时器也要一起撤（否则看不见的页面还在走表）
        if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('resize', onWinResize);
        if (panel) panel.destroy();
        if (panelHost && panelHost.parentNode) panelHost.parentNode.removeChild(panelHost);
        if (rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
      },
      refresh: paint,
      session: function () { return session; },
      setSession: function (nextSession) { cancelJump(); session = nextSession; baseAt = 0; if (panel) panel.refresh(session.config); paint(); },
      /* pendingJump = 现在有没有一个"等一会儿就翻"的定时器在跑（测试与自检页要看这个）；
       * timerMs/timerPaused = 计时球现在的读数与状态（测试与自检页读它） */
      stats: function () {
        return { submissions: submissions, reveals: reveals, restarts: restarts,
                 pendingJump: jumpTimer !== null, pendingIndex: pendingIndex, pendingWaitMs: pendingWaitMs,
                 timerOn: timerOn(), timerMs: timerTotal(), timerPaused: timerState().paused };
      },
      toggleTimer: toggleTimer,
      timerText: function () { return fmtMs(timerTotal()); }
    };
  }

  return { CSS: CSS, CSS_ID: CSS_ID, mount: mount };
});
