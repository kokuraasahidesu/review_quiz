/* ============================================================
 *  verify/inline-order.test.js —— 单文件产物的「浏览器等价」验收
 *
 *  运行： node verify/inline-order.test.js
 *
 *  为什么单独验这一条：
 *    core/*.js 在 Node 里靠 require 互相找，在浏览器里靠 root.XxxCore 这种
 *    全局挂载 + <script> 的书写顺序。Node 全绿不等于双击 HTML 能用。
 *    这个文件不重读源码，而是直接从【构建出来的成品 HTML】里抠出内联代码，
 *    丢进一个"没有 module、只有 self"的沙箱里跑 —— 也就是浏览器的处境。
 *
 *  覆盖三个产物：解析器Demo.html / 浏览器自检.html / 校对面板.html
 *  不同产物内联的核心集合不同，所以顺序自检只针对"该产物里实际存在的"核心。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const TFNode = require('../core/text-format.js');   // Node 侧实现，用来跟沙箱结果对照

let pass = 0, fail = 0; const failures = [];
function brief(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return String(s);
  return s.length > 170 ? s.slice(0, 170) + '…(' + s.length + ' 字符)' : s;
}
function ok(c, t, d) { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + brief(d) : '')))
                         : (fail++, failures.push(t), console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + brief(d) : ''))); }
function eq(a, e, t) { const A = JSON.stringify(a), E = JSON.stringify(e); ok(A === E, t + '   期望=' + brief(E), A); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }

const HERE = path.join(__dirname, '..');

/* 基础解析链（三个产物都有） */
const CORES_BASE = ['core/parse/zip.js', 'core/parse/docx.js', 'core/parse/text.js',
                    'core/parse/segment.js', 'parser-core.js'];
/* 其余核心（按 build.js 的**依赖顺序**排，不是随便排的） */
const CORES_MORE = ['core/schema.js', 'core/data.js', 'core/quiz.js', 'core/flow.js', 'core/wrong.js', 'core/exams.js', 'core/text-format.js',
                    'core/review.js', 'ui/review-panel.js', 'ui/quick-panel.js', 'core/attempt.js', 'ui/attempt-view.js',
                    'ui/wrong-view.js', 'ui/delete-dialog.js', 'core/ai.js', 'ui/ai-settings.js', 'ui/ai-single.js', 'ui/ai-scene.js'];
const CORES_ALL = CORES_BASE.concat(CORES_MORE);

/* 从成品 HTML 里，按构建器打的分隔注释抠出内联代码 */
function extractCore(html, file) {
  const esc = file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const re = new RegExp('/\\* =+ 内联开始：' + esc + ' =+ \\*/([\\s\\S]*?)/\\* =+ 内联结束：' + esc + ' =+ \\*/');
  const m = html.match(re);
  return m ? m[1] : null;
}

/* 造一个"像浏览器"的沙箱：有 self / window / DecompressionStream、localStorage，没有 module */
function browserSandbox(extra) {
  const store = new Map();
  const localStorage = {
    getItem: k => (store.has(String(k)) ? store.get(String(k)) : null),
    setItem: (k, v) => { store.set(String(k), String(v)); },
    removeItem: k => { store.delete(String(k)); },
    key: i => { const a = Array.from(store.keys()); return i < a.length ? a[i] : null; },
    get length() { return store.size; }
  };
  const ctx = {
    TextDecoder, TextEncoder, Blob, Response, DecompressionStream, Uint8Array, DataView,
    ArrayBuffer, console, Date, Math, JSON, String, Number, Object, Array, Error, RegExp,
    Promise, setTimeout, localStorage
  };
  ctx.self = ctx; ctx.window = ctx; ctx.globalThis = ctx;
  if (extra) Object.keys(extra).forEach(k => { ctx[k] = extra[k]; });
  vm.createContext(ctx);
  return ctx;
}

function toArrayBuffer(buf) { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); }
function readBuf(p) { return toArrayBuffer(fs.readFileSync(p)); }
function txtBytes(n) {
  const b = fs.readFileSync(path.join(HERE, 'fixtures', 'txt', n));
  return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

(async function main() {
  const ARTIFACTS = [
    { out: '解析器Demo.html', tpl: 'demo-template.html' },
    { out: '浏览器自检.html', tpl: 'selftest-template.html' },
    { out: '校对面板.html',   tpl: 'review-template.html' },
    { out: '答题页.html',     tpl: 'answer-template.html' },
    { out: '错题本.html',     tpl: 'wrong-template.html' },
    /* 合并版：一个壳里跑三段原页面逻辑（由 build.js 的 assembleApp 装配） */
    { out: 'review_quiz.html', tpl: 'app-template.html' }
  ];

  /* ============ ① 成品 HTML：内联齐全、顺序正确、没被提前闭合 ============ */
  head('① 三个成品 HTML：内联齐全、顺序正确');

  for (const a of ARTIFACTS) {
    const art = a.out;
    const p = path.join(HERE, art);
    ok(fs.existsSync(p), art + ' 存在');
    if (!fs.existsSync(p)) continue;
    const html = fs.readFileSync(p, 'utf8');

    // 该产物里出现了哪些核心（用"内联开始"标记探测）
    const present = CORES_ALL.filter(f => html.indexOf('内联开始：' + f) >= 0);
    ok(present.length >= CORES_BASE.length, art + '：基础解析链 5 个核心都在',
       present.length + ' 个核心');
    const idx = present.map(f => html.indexOf('内联开始：' + f));
    let ordered = true;
    for (let i = 1; i < idx.length; i++) if (!(idx[i - 1] < idx[i])) ordered = false;
    ok(ordered, art + '：内联顺序正确',
       present.map((f, i) => path.basename(f, '.js') + '@' + idx[i]).join(' '));

    // 转义检查（正确做法）：
    //   · 内联代码里若残留裸 `</script`，成品的闭合标签数会比模板多 —— 这就是判据。
    //   · `<script`（只有开标签、没有斜杠）出现在 JS 字符串里是无害的，
    //     core/data.js 生成分享包时本来就要拼这个字符串，不能一律当错误。
    const tpl = fs.readFileSync(path.join(HERE, a.tpl), 'utf8');
    const tplCloses = (tpl.match(/<\/script\s*>/gi) || []).length;
    const artCloses = (html.match(/<\/script\s*>/gi) || []).length;
    eq(artCloses, tplCloses,
       art + '：闭合标签数与模板一致（内联代码里的 </script 已被转义成 <\\/script）');

    // 更硬的一条：**装着内联核心的那个 <script> 块**里，必须同时含全部"内联结束"标记。
    // 只要有一处裸 </script 漏进去，这个区间就会被提前截断，后面的"内联结束"标记就落空。
    // ⚠ 起点不能取"第一个 <script>"：合并壳的 <head> 里排着一段「启动自检」（要抢在一切之前注册），
    //   它本身就是第一个块 —— 从那儿切当然找不到核心。锚点改成**第一个核心所在的块**，判据一点没松。
    const inlAt = html.indexOf('内联开始：' + present[0]);
    const open = inlAt > 0 ? html.lastIndexOf('<script', inlAt) : -1;
    const close = open >= 0 ? html.indexOf('</script>', open) : -1;
    const firstBlock = (open >= 0 && close > open) ? html.slice(open, close) : '';
    const lost = present.filter(f => firstBlock.indexOf('内联结束：' + f) < 0);
    ok(open >= 0 && close > open && lost.length === 0,
       art + '：首个 script 块完整容纳全部内联核心（没被提前闭合）',
       lost.length ? '落空的：' + lost.join(',') : firstBlock.length + ' 字符');

    const left = html.match(/__[A-Z][A-Z0-9_]*__/g);
    ok(!left, art + '：无残留占位符', (left || []).join(','));

    // HTML 解析陷阱：script 数据里出现 `<!--` 会切进 "escaped" 状态，
    // 之后字符串里的 `<script` 会让解析器进入 double-escaped 状态，
    // 导致真正的 </script> 失效。这里必须一个都没有。
    eq((html.match(/<!--/g) || []).length, 0,
       art + '：全文件不含 <!-- （避免 script 数据双转义陷阱）');
  }

  /* ============ ② 解析链：浏览器式沙箱 ============ */
  head('② 浏览器式沙箱：解析链（zip → docx → text → segment → facade）');

  const demoHtml = fs.readFileSync(path.join(HERE, '解析器Demo.html'), 'utf8');
  const parts = CORES_BASE.map(f => extractCore(demoHtml, f));
  ok(parts.every(Boolean), '基础解析链的内联段落都能从成品里抠出来');

  const ctx = browserSandbox();
  ok(typeof ctx.module === 'undefined', '沙箱里没有 module（真·浏览器处境）');
  try {
    new vm.Script(parts.join('\n;\n')).runInContext(ctx);
    ok(true, '内联代码在浏览器式沙箱里加载成功（无 module / 有 self）');
  } catch (e) { ok(false, '内联代码加载失败', e.message); }

  ok(!!ctx.ZipCore, 'self.ZipCore 已挂载');
  ok(!!ctx.DocxCore, 'self.DocxCore 已挂载');
  ok(!!ctx.TextCore, 'self.TextCore 已挂载');
  ok(!!ctx.SegmentCore, 'self.SegmentCore 已挂载');
  ok(!!ctx.QuizParser && typeof ctx.QuizParser.parseDocx === 'function', 'self.QuizParser.parseDocx 可用');

  const r = await ctx.QuizParser.parseDocx(readBuf(path.join(HERE, 'sample.docx')));
  eq(r.stats.total, 10, '浏览器沙箱里：样卷切出 10 题');
  eq(r.stats.byType, { '单选': 2, '多选': 1, '判断': 4, '简答': 3 }, '  题型分布与 Node 侧完全一致');
  eq(r.meta.textBoxParagraphs, 3, '  文本框识别数一致');

  const fixDir = path.join(HERE, 'fixtures');
  for (const pair of [['old_format.doc', 'E_OLD_DOC'], ['random.bin', 'E_NOT_ZIP'], ['empty.docx', 'E_EMPTY']]) {
    let got = null;
    try { await ctx.QuizParser.parseDocx(readBuf(path.join(fixDir, pair[0]))); }
    catch (e) { got = e.code; }
    eq(got, pair[1], '浏览器沙箱里 ' + pair[0] + ' → ' + pair[1]);
  }

  /* ============ ②-b 沙箱里的 txt 通道（编码层） ============ */
  head('②-b 浏览器式沙箱：txt 编码层（GBK 必须在浏览器里也解对）');

  const NodeParser = require('../parser-core.js');
  const pick = q => q.type + '|' + q.stem + '|' + (q.options || []).map(o => o.label + ':' + o.text).join(',') +
                     '|' + q.answer + '|' + q.judgeValue + '|' + (q.keywords || []).map(k => k.text + k.via).join(',');

  for (const c of [['UTF-8', 'basic_utf8.txt', 'utf-8'],
                   ['UTF-8+BOM', 'basic_utf8bom.txt', 'utf-8-bom'],
                   ['GBK', 'basic_gbk.txt', 'gbk'],
                   ['CRLF+GBK', 'crlf_gbk.txt', 'gbk']]) {
    const inBox = await ctx.QuizParser.parseTxtBytes(txtBytes(c[1]));
    const inNode = await NodeParser.parseTxtBytes(txtBytes(c[1]));
    eq(inBox.stats.total, 4, c[0] + '：浏览器沙箱里切出 4 题');
    eq(inBox.meta.encoding, c[2], c[0] + '：编码判定 = ' + c[2]);
    eq(inBox.meta.replaced, 0, c[0] + '：零解码损失（无乱码）');
    eq(inBox.questions.map(pick), inNode.questions.map(pick), c[0] + '：题目逐字段与 Node 侧完全一致');
  }

  /* ============ ②-c 沙箱里的题型识别 / 正误归一 ============ */
  head('②-c 浏览器式沙箱：题型识别 + 判断题正误归一 + 疑点分类');

  eq(ctx.QuizParser.detectType('【单项选择题】x'), '单选', '沙箱里长别名归类正确');
  eq(ctx.QuizParser.detectType('判断：地球是圆的'), null, '沙箱里裸别名+冒号同样不认（保守规则一致）');
  eq(ctx.QuizParser.detectType('判断题：x'), '判断', '沙箱里「判断题：」被识别');

  const twelveT = ['√', '对', '正确', 'T', 'True', '是'];
  const twelveF = ['×', '错', '错误', 'F', 'False', '否'];
  ok(twelveT.every(w => ctx.QuizParser.normalizeJudge(w).value === true),
     '沙箱里 6 种"正"写法全部 true', twelveT.map(w => w + '=' + ctx.QuizParser.normalizeJudge(w).value).join(' '));
  ok(twelveF.every(w => ctx.QuizParser.normalizeJudge(w).value === false),
     '沙箱里 6 种"误"写法全部 false', twelveF.map(w => w + '=' + ctx.QuizParser.normalizeJudge(w).value).join(' '));
  eq(ctx.QuizParser.normalizeJudge('不正确').value, false, '沙箱里「不正确」→ false（不许判反）');
  eq(ctx.QuizParser.normalizeJudge('待定').value, null, '沙箱里「待定」→ null（待校对）');

  const boxJudge = ctx.QuizParser.parseText('【判断】待定题？（　）\n答案：待定\n【单选】零选项？\n答案：A\n');
  eq(boxJudge.questions[0].judgeValue, null, '沙箱端到端：待定判断题 judgeValue=null');
  const boxFlags = ctx.QuizParser.collectReview(boxJudge.questions);
  eq(boxFlags.length, 2, '沙箱端到端：collectReview 挑出 2 道可疑题');
  eq(boxFlags.map(x => x.flags.map(f => f.id)), [['judge-ambiguous'], ['too-few-options']],
     '  疑点分类正确');

  /* ============ ②-d 沙箱里的校对面板逻辑（含 localStorage 存储） ============ */
  head('②-d 浏览器式沙箱：校对入库逻辑（含真实 localStorage 后端）');

  const reviewHtml = fs.readFileSync(path.join(HERE, '校对面板.html'), 'utf8');
  const rparts = CORES_ALL.map(f => extractCore(reviewHtml, f));
  // 校对面板只内联它用得到的那几个；别的一律应为 null
  const PANEL_NEEDS = ['core/schema.js', 'core/data.js', 'core/review.js', 'ui/review-panel.js'];
  ok(PANEL_NEEDS.every(f => extractCore(reviewHtml, f)),
     '校对面板用到的核心都能抠出来', PANEL_NEEDS.map(f => !!extractCore(reviewHtml, f)).join(','));
  // 按文件名取段，避免"改了清单顺序就把反向验证指错文件"
  const byName = (function () {
    const m = {};
    CORES_ALL.forEach((f, i) => { m[f] = rparts[i]; });
    return function (n) { return m[n]; };
  })();

  const ctx2 = browserSandbox();
  try {
    new vm.Script(rparts.join('\n;\n')).runInContext(ctx2);
    ok(true, '校对面板的内联代码在沙箱里加载成功');
  } catch (e) { ok(false, '校对面板内联代码加载失败', e.message); }

  ok(!!ctx2.SchemaCore, 'self.SchemaCore 已挂载');
  ok(!!ctx2.ReviewCore, 'self.ReviewCore 已挂载');
  ok(!!ctx2.ReviewPanel, 'self.ReviewPanel 已挂载');
  ok(!!ctx2.DataCore, 'self.DataCore 已挂载');

  const NodeReview = require('../core/review.js');
  const boxDraft = ctx2.ReviewCore.createDraft(await ctx2.QuizParser.parseTxtBytes(txtBytes('basic_gbk.txt')),
                                               { now: '2026-09-16T15:00:00.000Z', title: '沙箱卷' });
  ok(boxDraft.ok, '沙箱里 createDraft 成功');
  const nodeDraft = NodeReview.createDraft(await NodeParser.parseTxtBytes(txtBytes('basic_gbk.txt')),
                                           { now: '2026-09-16T15:00:00.000Z', title: '沙箱卷' });
  eq(ctx2.ReviewCore.reviewStats(boxDraft.draft), NodeReview.reviewStats(nodeDraft.draft),
     '沙箱里的待校对统计与 Node 侧一致');
  eq(ctx2.ReviewCore.visibleIndices(boxDraft.draft, true), NodeReview.visibleIndices(nodeDraft.draft, true),
     '沙箱里的筛选结果与 Node 侧一致');

  const boxEdit = ctx2.ReviewCore.setAnswer(boxDraft.draft, 0, 'A');
  ok(boxEdit.ok, '沙箱里改答案成功');
  eq(boxEdit.draft.questions[0].answerLetters, ['A'], '  派生字段在沙箱里也重算正确');

  // 用沙箱里的 localStorage 后端跑一次"取消零变化 / 入库有变化"
  const boxStore = ctx2.DataCore.createStore({ small: ctx2.localStorage, large: null, namespace: 'box' });
  const snapFn = async () => ctx2.ReviewCore.snapshot(await ctx2.ReviewCore.storeSnapshot(boxStore));
  const s0 = await snapFn();
  ctx2.ReviewCore.cancel(boxDraft.draft);
  eq(await snapFn(), s0, '沙箱里取消后 localStorage 逐字节未变');
  const cBox = await ctx2.ReviewCore.commit(boxEdit.draft, boxStore, { now: '2026-09-16T15:10:00.000Z' });
  ok(cBox.ok, '沙箱里 commit 成功', cBox.error || '');
  ok((await snapFn()) !== s0, '  沙箱里入库后 localStorage 确实变了');
  eq(await boxStore.keys(), ['exam::' + cBox.examId, 'index'], '  沙箱里写入了卷子与索引两条记录');

  /* ============ ②-e 沙箱里的卷册 + 结构化文本格式（浏览器等价） ============ */
  head('②-e 浏览器式沙箱：ExamsCore + TextFormatCore（内联后能不能用）');

  const selfHtml = fs.readFileSync(path.join(HERE, '浏览器自检.html'), 'utf8');
  const selfParts = CORES_ALL.map(f => extractCore(selfHtml, f));
  ok(selfParts.every(Boolean), '自检页把全部核心都内联了（' + CORES_ALL.length + ' 个）',
     selfParts.filter(Boolean).length + '/' + CORES_ALL.length);

  const ctx3 = browserSandbox();
  try {
    new vm.Script(selfParts.join('\n;\n')).runInContext(ctx3);
    ok(true, '自检页的内联代码在沙箱里加载成功（依赖顺序也对）');
  } catch (e) { ok(false, '自检页内联代码加载失败', e.message); }
  ok(!!ctx3.ExamsCore, 'self.ExamsCore 已挂载');
  ok(!!ctx3.TextFormatCore, 'self.TextFormatCore 已挂载');
  ok(!!ctx3.DataCore && !!ctx3.SchemaCore, 'self.DataCore / self.SchemaCore 已挂载');

  if (ctx3.TextFormatCore && ctx3.ExamsCore && ctx3.SchemaCore) {
    const selfParsed = await ctx3.QuizParser.parseDocx(readBuf(path.join(HERE, 'sample.docx')));
    const boxExam = ctx3.SchemaCore.createExam({
      title: '沙箱往返卷',
      questions: selfParsed.questions.map(q => ctx3.SchemaCore.createQuestion(q)),
      config: { points: { '单选': 2 } }, configLocked: true
    }, { now: '2026-09-17T15:00:00.000Z' });

    const boxText = ctx3.TextFormatCore.exportExam(boxExam);
    const boxBack = ctx3.TextFormatCore.importExam(boxText);
    ok(boxBack.ok, '沙箱里导出→导入成功', boxBack.ok ? '' : brief(boxBack.errors));
    if (boxBack.ok) {
      eq(JSON.stringify(boxBack.exam), JSON.stringify(boxExam),
         '沙箱里也**逐字段完全还原**（整对象）');
      eq(ctx3.TextFormatCore.exportExam(boxBack.exam), boxText, '沙箱里二次导出逐字节相同');
    }

    // Node 侧导出**同一个** exam 对象，两边文本应当逐字节一致
    // （早先这里各自建了一份新卷 → 随机 id 不同 → 是测试写错了，不是环境差异）
    const nodeText = TFNode.exportExam(boxExam);
    eq(boxText, nodeText, '沙箱里导出的文本与 Node 侧**逐字节相同**');

    // 失败导入不许写存储（沙箱里用的是 localStorage shim）
    const boxStore = ctx3.DataCore.createStore({ small: ctx3.localStorage, large: null, namespace: 'ns_fmt', threshold: 4096 });
    await ctx3.ExamsCore.createExam(boxStore, { title: '沙箱已有卷' });
    const boxSnap = async () => ctx3.ReviewCore.snapshot(await ctx3.ReviewCore.storeSnapshot(boxStore));
    const s0 = await boxSnap();
    const badR = await ctx3.TextFormatCore.importToLibrary(boxStore, boxText.replace('单选', '填空题'), {});
    eq(badR.ok, false, '沙箱里坏文本入库被拦下');
    eq(await boxSnap(), s0, '  沙箱里失败后 store 逐字节未变');
    const okR = await ctx3.TextFormatCore.importToLibrary(boxStore, boxText, { newIds: true });
    ok(okR.ok, '沙箱里好文本入库成功', okR.ok ? '' : brief(okR.errors));
    ok((await boxSnap()) !== s0, '  沙箱里成功后 store 确实变了');
    eq((await ctx3.ExamsCore.scanOrphans(boxStore)).orphans, [], '  沙箱里无孤儿数据');
  }

  /* ============ ③ 反向验证：顺序错了必须立刻炸 ============ */
  head('③ 反向验证：内联顺序写错 / 漏内联，都必须当场报错而不是静默降级');

  const N = CORES_BASE.length;
  const bad = browserSandbox();
  let badErr = null;
  try { new vm.Script(parts[N - 1] + '\n;\n' + parts.slice(0, N - 1).join('\n;\n')).runInContext(bad); }
  catch (e) { badErr = e; }
  ok(!!badErr, '把门面放到最前 → 加载时立刻抛异常');
  ok(!!badErr && /依赖缺失/.test(badErr.message), '  异常信息明确指出"依赖缺失"', badErr && badErr.message);

  const noSeg = browserSandbox();
  let nsErr = null;
  try { new vm.Script([0, 1, 2, 4].map(i => parts[i]).join('\n;\n')).runInContext(noSeg); }
  catch (e) { nsErr = e; }
  ok(!!nsErr && /依赖缺失/.test(nsErr.message), '漏内联 segment.js → 当场抛「依赖缺失」', nsErr && nsErr.message);

  const noTxt = browserSandbox();
  let ntErr = null;
  try { new vm.Script([0, 1, 3, 4].map(i => parts[i]).join('\n;\n')).runInContext(noTxt); }
  catch (e) { ntErr = e; }
  ok(!!ntErr && /依赖缺失/.test(ntErr.message), '漏内联 text.js → segment.js 先抛「依赖缺失」', ntErr && ntErr.message);

  const noReview = browserSandbox();
  let nrErr = null;
  try {
    // 其余依赖**全部满足**（解析链 + schema + data），只缺 review.js → 必须是**面板自己**抛错。
    // ⚠ schema.js 现在也依赖 segment.js（判断题归一委托它），所以这条链必须带上 text/segment，
    //   否则会变成 schema 先抛 —— 那样这条断言就是"因错误的原因通过"。
    new vm.Script([byName('core/parse/text.js'), byName('core/parse/segment.js'), byName('core/schema.js'),
                   byName('core/data.js'), byName('ui/review-panel.js')].join('\n;\n'))
      .runInContext(noReview);
  } catch (e) { nrErr = e; }
  ok(!!nrErr && /review-panel 依赖缺失/.test(nrErr.message),
     '漏内联 review.js → **review-panel 自己**抛「依赖缺失」', nrErr && nrErr.message);

  const noSchema = browserSandbox();
  let ns2Err = null;
  try {
    // 解析链齐全、有 review.js，但**没有 schema.js** → 必须是 review-core 自己抛错，
    // 而不是被别的模块抢先抛（否则这条断言是"因错误的原因通过"）
    new vm.Script([byName('core/parse/text.js'), byName('core/parse/segment.js'),
                   byName('core/review.js'), byName('core/data.js')].join('\n;\n'))
      .runInContext(noSchema);
  } catch (e) { ns2Err = e; }
  ok(!!ns2Err && /review-core 依赖缺失/.test(ns2Err.message),
     '漏内联 schema.js → **review-core 自己**抛「依赖缺失」', ns2Err && ns2Err.message);

  /* ============ ④ 桌面入口 ============ */
  head('④ 桌面入口同步');
  const desk = path.join(process.env.USERPROFILE || 'C:\\Users\\asahi', 'Desktop');
  for (const item of ARTIFACTS) {
    const art = item.out;
    const p = path.join(desk, art);
    if (!fs.existsSync(p)) { ok(false, '桌面有 ' + art); continue; }
    const a = fs.readFileSync(p, 'utf8'), b = fs.readFileSync(path.join(HERE, art), 'utf8');
    ok(a === b, '桌面 ' + art + ' 与构建产物逐字节一致', fs.statSync(p).size + ' B');
  }

  console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
  console.log('  PASS ' + pass + '    FAIL ' + fail);
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
