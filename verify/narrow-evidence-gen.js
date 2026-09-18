/* 窄屏取证 · 第一步：把成品复制一份并注入"测量脚本"（画 HUD + 写 JSON），供 headless Edge 出数。
 * 运行： node verify/narrow-evidence-gen.js
 *       然后（PowerShell，注意 headless 的 --window-size **管不了布局视口**，所以测量脚本自己把内容宽钉成 375px）：
 *         msedge --headless=new --disable-gpu --hide-scrollbars --window-size=420,900 \
 *                --virtual-time-budget=14000 --screenshot=docs\narrow-shot-<页>.png --dump-dom \
 *                file:///D:/apps/tools/quiz-demo/verify/narrow-<页>.html > verify\narrow-dump-<页>.html
 *       最后： node verify/narrow-evidence-parse.js   （汇总成 verify/narrow-numbers.json）
 * 第一证据是**截图里的人眼读数**（HUD 上的数字与画面出自同一次渲染）；JSON 只是它的机器可读副本。
 */
const fs = require('fs');
const path = require('path');
const HERE = path.join(__dirname, '..');

const MEASURE = [
  '(function () {',
  '  function vis(el) {',
  '    var r = el.getBoundingClientRect();',
  '    if (r.width <= 0 || r.height <= 0) return false;',
  '    var s = getComputedStyle(el);',
  '    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";',
  '  }',
  '  /* ⚠ 视口层（position:fixed）的**整棵子树**都不属于 375px 内容列：',
  '   *   fixed 的根按视口宽算（本机视口 526px），它的子孙（FAB 上的角标、快捷面板的表头）',
  '   *   也就跟着按视口排 —— 只把 fixed 根剔掉、子孙照量，会量出"右溢 108/139"这种**假阳性**',
  '   *   （实测踩过：这一版新增的常驻「交卷」FAB 与底部面板正好都是 fixed）。',
  '   *   真机上视口就是 375px，它们自然落在屏幕内，所以整棵剔除才是等价口径。 */',
  '  function inFixed(el) {',
  '    for (var p = el; p; p = p.parentElement) { if (getComputedStyle(p).position === "fixed") return true; }',
  '    return false;',
  '  }',
  '  function label(el) {',
  '    var t = (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 14);',
  '    var cls = (typeof el.className === "string" && el.className) ? "." + el.className.split(/\\s+/)[0] : "";',
  '    return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + cls + (t ? "「" + t + "」" : "");',
  '  }',
  '  function run() {',
  '    /* ⚠ headless Edge 的 --window-size **管不了布局视口**（实测 492/511/526 全看它心情）。',
  '     *   这三个页面是**纯流体布局、零媒体查询**（已 grep 核实），所以"把 html/body 的宽度钉成 375px"',
  '     *   与"真的 375px 视口"对布局等价。注：documentElement.clientWidth 对根元素返回的是**视口**宽，',
  '     *   所以判据必须看 **内容宽度**（body 的 rect），不能看它（踩过：HUD 上写着"布局宽 526"）。',
  '     *   position:fixed 的元素按视口算，单独剔除并标注。 */',
  '    var st = document.createElement("style");',
  '    st.textContent = "html{width:375px !important}body{width:375px !important;max-width:375px !important}"',
  '      + ".top,.foot{max-width:375px !important}";',
  '    document.head.appendChild(st);',
  '    var contentW = Math.round(document.body.getBoundingClientRect().width);',
  '    var de = document.documentElement;',
  '    var rep = { title: document.title, width: contentW, viewport: de.clientWidth, innerW: window.innerWidth,',
  '                scrollW: contentW, clipped: [], small: [], overlap: [], tinyFont: [], fixed: [] };',
  '    var all = Array.prototype.slice.call(document.querySelectorAll("body *"));',
  '    all.forEach(function (el) {',
  '      if (!vis(el)) return;',
  '      if (getComputedStyle(el).position === "fixed") { rep.fixed.push(label(el)); return; }',
  '      if (inFixed(el)) return;   /* 视口层里的子孙，另计（见 inFixed 注释） */',
  '      var r = el.getBoundingClientRect();',
  '      if (r.right > contentW + 1) rep.clipped.push(label(el) + " 右溢" + Math.round(r.right - contentW));',
  '      var tag = el.tagName.toLowerCase();',
  '      var inter = (tag === "button" || tag === "a" || tag === "select" || tag === "input" || tag === "textarea" || tag === "label");',
  '      if (inter && Math.round(r.height) < 44) rep.small.push(label(el) + " " + Math.round(r.width) + "x" + Math.round(r.height));',
  '      var txt = (el.children.length === 0 ? (el.textContent || "") : "").trim();',
  '      if (txt.length >= 25) { var fs = parseFloat(getComputedStyle(el).fontSize) || 0;',
  '        if (fs < 13) rep.tinyFont.push(label(el) + " " + fs + "px"); }',
  '    });',
  '    var seen = [];',
  '    all.forEach(function (e) { if (e.parentElement && !inFixed(e.parentElement) && seen.indexOf(e.parentElement) < 0) seen.push(e.parentElement); });',
  '    seen.forEach(function (p) {',
  '      var kids = Array.prototype.slice.call(p.children).filter(function (k) { return vis(k) && !inFixed(k); });',
  '      /* 只查**块级**两两重叠：行内盒子跨行时包围盒天然相交（假阳性，实测踩过），',
  '       * 而"卡片/按钮压在一起"才是真的错位。 */',
  '      kids = kids.filter(function (k) { var d = getComputedStyle(k).display; return d !== "inline" && d !== "inline-block"; });',
  '      for (var i = 0; i < kids.length; i++) for (var j = i + 1; j < kids.length; j++) {',
  '        var a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();',
  '        var ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);',
  '        var oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);',
  '        if (ox > 6 && oy > 6) rep.overlap.push(label(kids[i]) + "×" + label(kids[j]));',
  '      }',
  '    });',
  '    /* 把结论**画在页面上**（fixed 定位，不参与流式布局）——这样"数字"和"画面"出自同一次渲染，',
  '     * 截图上能直接读到，不存在"量的是一个视口、看的是另一个视口"的自欺。 */',
  '    var box = document.createElement("div");',
  '    box.setAttribute("id", "narrowHud");',
  '    box.style.cssText = "position:fixed;left:0;top:0;right:0;z-index:99999;background:rgba(0,0,0,.88);color:#9f9;"',
  '      + "font:11px/1.45 Consolas,monospace;padding:4px 6px;white-space:pre-wrap;word-break:break-all";',
  '    var lines = ["[实测] 内容宽 " + contentW + "px（浏览器视口 " + window.innerWidth + "）"',
  '      + (rep.clipped.length ? " **右溢" + rep.clipped.length + " 处**" : " 无右溢"),',
  '      "被裁 " + rep.clipped.length + "：" + rep.clipped.slice(0, 4).join(" / "),',
  '      "触点<44px " + rep.small.length + "：" + rep.small.slice(0, 4).join(" / "),',
  '      "重叠 " + rep.overlap.length + "：" + rep.overlap.slice(0, 3).join(" / "),',
  '      "小字 " + rep.tinyFont.length + "：" + rep.tinyFont.slice(0, 3).join(" / "),',
  '      "fixed 元素（按视口算，另计）" + rep.fixed.length + "：" + rep.fixed.slice(0, 2).join(" / ")];',
  '    box.textContent = lines.join("\\n");',
  '    document.body.appendChild(box);',
  '    var pre = document.createElement("pre"); pre.id = "narrowReport";',
  '    pre.textContent = "@@NARROW@@" + JSON.stringify(rep) + "@@END@@";',
  '    document.body.appendChild(pre);',
  '  }',
  '  setTimeout(run, 2200);',
  '})();'
].join('\n');

const PAGES = [
  { key: 'answer', src: '答题页.html' },
  { key: 'review', src: '校对面板.html' },
  { key: 'wrong', src: '错题本.html' },
  { key: 'demo', src: '解析器Demo.html' }
];

PAGES.forEach(function (p) {
  const html = fs.readFileSync(path.join(HERE, p.src), 'utf8');
  /* ⚠ 必须插在**最后一个** `</body>`：成品的内联源码里就有 `'</body>'` 这个字符串
   *   （data.js 的 `lastIndexOf('</body>')`、AI 容错里的样例），插到第一个就等于插进 JS 源码中间 → 整页报语法错。 */
  const at = html.lastIndexOf('</body>');
  if (at < 0) throw new Error('没找到 </body>：' + p.src);
  const out = html.slice(0, at) + '<script>\n' + MEASURE + '\n<\/script>\n' + html.slice(at);
  fs.writeFileSync(path.join(HERE, 'verify', 'narrow-' + p.key + '.html'), out, 'utf8');
  console.log('generated verify/narrow-' + p.key + '.html（注入点 ' + at + '）');
});
