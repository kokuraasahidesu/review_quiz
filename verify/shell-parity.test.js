/* ============================================================
 *  verify/shell-parity.test.js —— 「合并壳 vs 三个独立页」标记对照闸门
 *
 *  运行： node verify/shell-parity.test.js
 *
 *  为什么必须有一条这样的闸门：合并壳（review_quiz.html）**不复制标记**，它只搬三个页面的
 *  "页面逻辑"，再把 `$('#file')` 这类选择器按 **idMap** 换成带面板前缀的真实 id。
 *  于是"逻辑找得到的元素"必须由壳**自己**摆出来 —— 一旦漏摆或摆错（把按钮写成空 div），
 *  页面不报错、功能测试也全绿，只有**用户**点上去才发现："调用api没有输入api key的地方"
 *  就是这么来的：独立版 校对面板.html 顶部那三颗 AI 按钮，在合并版里退化成三个空 div。
 *
 *  判据（逐条都可复现，不写死数量）：
 *    ① 每个 RUN_PANE 的 idMap 目标 id，都必须在**该面板的标记**里真的存在；
 *    ② 目标元素的**标签种类**要与独立页里同 id 的一致（按钮还是按钮、输入框还是输入框）；
 *    ③ 反过来：独立页标记里那些"用户要点的控件"（button/input/label/select/textarea），
 *       只要被 idMap 映射进来，就不许在壳里变成长度 0 的隐形元素。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const HERE = path.join(__dirname, '..');

function readOr(p, d) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return d == null ? '' : d; } }

/* 只看 `<script>` 之前的**标记**：内联进来的核心源码里也有 `id="…"` 那种字符串（是 JS 字面量，不是元素）。
 * ⚠ 从 `<body>` 起算：合并壳的 `<head>` 里现在排着一段「启动自检」脚本（要抢在一切之前注册 onerror，
 *   见 app-template.html 顶部），一刀切在"第一个 <script>"会把整个 body 标记都切掉 —— 那样本文件
 *   会**假装全过**（壳里一个 id 都找不到 → missing 反而…… 不，missing 会全红）。总之锚点得跟着结构走。 */
function markupOf(html) {
  const body = html.indexOf('<body');
  const from = body < 0 ? 0 : body;
  const i = html.indexOf('<script>', from);
  const end = i < 0 ? html.length : i;
  return html.slice(from, end);
}
/* 标记里 id → 标签名（同名多取，返回数组以暴露重复） */
function idTags(markup) {
  const map = {};
  const re = /<([a-z][a-z0-9]*)\b([^>]*?)\sid="([^"]+)"/gi;
  let m;
  while ((m = re.exec(markup))) {
    const tag = m[1].toLowerCase(), id = m[3];
    if (!map[id]) map[id] = [];
    map[id].push(tag);
  }
  return map;
}
/* 从壳里抠出每个 RUN_PANE 的 idMap：`RUN_PANE('review', { old: 'new', ... }, ...)` */
function runPaneMaps(appMarkup) {
  const out = {};
  const re = /RUN_PANE\('([a-z]+)',\s*\{([\s\S]*?)\}\s*,/g;
  let m;
  while ((m = re.exec(appMarkup))) {
    const pane = m[1], pairs = [];
    const pre = /([A-Za-z0-9_]+):\s*'([A-Za-z0-9_-]+)'/g;
    let p;
    while ((p = pre.exec(m[2]))) pairs.push({ from: p[1], to: p[2] });
    out[pane] = pairs;
  }
  return out;
}

const TEMPLATES = { answer: 'answer-template.html', review: 'review-template.html', wrong: 'wrong-template.html' };

const FILES = { app: readOr(path.join(HERE, 'app-template.html')) };
Object.keys(TEMPLATES).forEach(function (k) { FILES[k] = readOr(path.join(HERE, TEMPLATES[k])); });

function audit(F) {
  const checks = [];
  const ok = function (c, t, d) { checks.push([!!c, t, d === undefined ? '' : String(d)]); };

  const appMark = markupOf(F.app);
  const appTags = idTags(appMark);
  /* ⚠ RUN_PANE 调用在**脚本里**（标记之外），所以这份映射要从整份源码里抠 */
  const maps = runPaneMaps(F.app);
  const panes = Object.keys(maps);

  ok(panes.slice().sort().join(',') === 'answer,review,wrong',
     '壳里正好找到三个面板的 RUN_PANE idMap（少一个就等于整个面板没接线）', panes.join(','));
  ok(panes.every(function (p) { return maps[p].length > 3; }), '  每个 idMap 都登记了元素（不是空表）',
     panes.map(function (p) { return p + ':' + maps[p].length; }).join(' '));

  panes.forEach(function (pane) {
    const tplMark = markupOf(F[pane] || '');
    const tplTags = idTags(tplMark);
    const missing = [], mismatch = [], invisible = [];
    maps[pane].forEach(function (pair) {
      const want = tplTags[pair.from];
      const got = appTags[pair.to];
      if (!got) { missing.push(pair.to + '（壳里没有这个 id）'); return; }
      if (!want) return;   /* 独立页标记里没有这个 id：说明它由 JS 创建（比如面板宿主），不在本条管辖 */
      if (got.length !== 1) { mismatch.push(pair.to + ' 出现 ' + got.length + ' 次'); return; }
      if (got[0] !== want[0]) mismatch.push('#' + pair.from + ' 在独立页是 <' + want[0] + '>，壳里 #' + pair.to + ' 成了 <' + got[0] + '>');
    });
    ok(missing.length === 0, '面板「' + pane + '」：idMap 里的 id 在壳标记里**都存在**', missing.slice(0, 6).join(' | '));
    ok(mismatch.length === 0, '  而且**标签种类一致**（按钮就还得是按钮，不许退化成空 div）', mismatch.slice(0, 6).join(' | '));
  });

  /* ③ 交互控件不许在壳里变隐形：壳里被 idMap 指到的 button/input/label/select/textarea 数量要与独立页对得上 */
  Object.keys(TEMPLATES).forEach(function (pane) {
    const tplTags = idTags(markupOf(F[pane]));
    const mapsPane = maps[pane] || [];
    const interactive = mapsPane.filter(function (pair) {
      const t = tplTags[pair.from];
      return t && /^(button|input|label|select|textarea)$/.test(t[0]);
    });
    const lost = interactive.filter(function (pair) {
      const g = appTags[pair.to];
      return !g || !/^(button|input|label|select|textarea)$/.test(g[0]);
    });
    ok(lost.length === 0, '面板「' + pane + '」：' + interactive.length + ' 个交互控件在壳里一个都没丢',
       lost.map(function (x) { return x.from + '→' + x.to; }).join(' | '));
  });

  return checks;
}

if (require.main === module) {
  const checks = audit(FILES);
  let pass = 0, fail = 0;
  checks.forEach(function (c) {
    if (c[0]) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + c[1] + (c[2] ? '   ' + c[2] : '')); }
    else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + c[1] + (c[2] ? '   ' + c[2] : '')); }
  });
  console.log('\n  PASS ' + pass + '    FAIL ' + fail);
  process.exit(fail ? 1 : 0);
}

module.exports = { audit: audit, FILES: FILES, idTags: idTags, markupOf: markupOf, runPaneMaps: runPaneMaps };
