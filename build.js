/* ============================================================
 *  build.js —— 一次性把「单文件离线版」生成出来
 *
 *  运行： node build.js
 *
 *  为什么需要它：
 *    最终交付物是"双击就能用、不联网、无后端"的单 HTML。
 *    所以所有 core/*.js 必须内联进 <script>。内联顺序有硬依赖：
 *        zip.js  →  docx.js  →  parser-core.js
 *    （docx 依赖 zip；parser-core 依赖两者，顺序错了会直接抛异常）
 *    以前是手工拼的，容易漏。现在固化成脚本 + 自检。
 *
 *  做三件事：
 *    ① 内联五个核心 + 内置样卷 base64
 *    ② 自检：占位符全部替换、内联顺序正确、产出的 JS 语法能过编译
 *    ③ 落盘到本目录，并同步一份到桌面
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HERE = __dirname;
const DESKTOP = path.join(process.env.USERPROFILE || 'C:\\Users\\asahi', 'Desktop');

/* 内联顺序 = 硬约束，写死在这里，不要"自动发现" */
/* 内联登记表。
 * 顺序 = **依赖顺序**，不是随便排的：
 *   data.js 必须排在 exams.js / text-format.js 之前（后两者 require DataCore），
 *   exams.js 又要排在 text-format.js 之前。排错了浏览器里会当场抛「依赖缺失」。
 */
const INLINE = [
  ['__ZIP_CORE__',         'core/parse/zip.js'],
  ['__DOCX_CORE__',        'core/parse/docx.js'],
  ['__TEXT_CORE__',        'core/parse/text.js'],
  ['__SEGMENT_CORE__',     'core/parse/segment.js'],
  ['__PARSER_CORE__',      'parser-core.js'],
  ['__SCHEMA_CORE__',      'core/schema.js'],
  ['__DATA_CORE__',        'core/data.js'],
  ['__QUIZ_CORE__',        'core/quiz.js'],
  ['__FLOW_CORE__',        'core/flow.js'],
  ['__WRONG_CORE__',       'core/wrong.js'],
  ['__EXAMS_CORE__',       'core/exams.js'],
  ['__TEXT_FORMAT_CORE__', 'core/text-format.js'],
  ['__REVIEW_CORE__',      'core/review.js'],
  ['__REVIEW_UI__',        'ui/review-panel.js'],
  ['__QUICK_UI__',         'ui/quick-panel.js'],
  ['__ATTEMPT_CORE__',     'core/attempt.js'],
  ['__ATTEMPT_VIEW__',     'ui/attempt-view.js'],
  ['__WRONG_VIEW__',       'ui/wrong-view.js'],
  ['__DELETE_DIALOG__',    'ui/delete-dialog.js'],
  ['__AI_CORE__',          'core/ai.js'],
  ['__AI_SETTINGS__',      'ui/ai-settings.js'],
  ['__AI_SINGLE__',        'ui/ai-single.js'],
  ['__AI_SCENE__',         'ui/ai-scene.js']
];
/* 必须按此先后出现在产物里（前一个的索引 < 后一个的索引）。
 * 只校验产物里**实际存在**的核心 —— 不同页面的内联集合本来就不同。 */
const ORDER_MUST = ['root.ZipCore', 'root.DocxCore', 'root.TextCore', 'root.SegmentCore', 'root.QuizParser',
                    'root.SchemaCore', 'root.DataCore', 'root.QuizCore', 'root.FlowCore', 'root.WrongCore', 'root.ExamsCore',
                    'root.TextFormatCore', 'root.ReviewCore', 'root.ReviewPanel', 'root.QuickPanel',
                    'root.AttemptCore', 'root.AttemptView', 'root.WrongView', 'root.DeleteDialog', 'root.AiCore', 'root.AiSettings',
                    'root.AiSingle', 'root.AiScene'];

const TARGETS = [
  { tpl: 'demo-template.html',    out: '解析器Demo.html' },
  { tpl: 'selftest-template.html', out: '浏览器自检.html' },
  { tpl: 'review-template.html',  out: '校对面板.html' },
  { tpl: 'answer-template.html',  out: '答题页.html' },
  { tpl: 'wrong-template.html',   out: '错题本.html' },
  /* 合并版：同一个壳里跑三份**原页面逻辑**（见 assembleApp 注释） */
  { tpl: 'app-template.html',     out: 'review_quiz.html', assemble: true }
];

/* ---------------- 合并版装配：把三个页面的"页面逻辑"段抽出来，放进带作用域的壳里 ----------------
 * 原则：**不复制逻辑**。三段代码原样搬过去，只在各自的面板作用域里跑（壳里 RUN_PANE 把
 * getElementById/querySelector 重定向到本面板，并按 idMap 换 id）。这样"改一次三处都对"。
 * 代价是抽取要稳：起点认 `const SAMPLE_B64 = ` 或"页面逻辑"标记，终点认最后一个 `</script>`。
 */
const APP_PAGES = [
  { ph: '__PAGE_ANSWER__', src: 'answer-template.html' },
  { ph: '__PAGE_REVIEW__', src: 'review-template.html' },
  { ph: '__PAGE_WRONG__',  src: 'wrong-template.html' }
];
function pageCodeOf(src, name) {
  let at = src.indexOf('const SAMPLE_B64 = ');
  const marker = src.lastIndexOf('页面逻辑');
  if (marker >= 0 && (at < 0 || marker < at)) at = src.lastIndexOf('/*', marker);
  if (at < 0) throw new Error(name + '：找不到页面逻辑的起点（既没有 SAMPLE_B64 也没有"页面逻辑"标记）');
  const end = src.lastIndexOf('</script>');
  if (end < 0) throw new Error(name + '：找不到 </script>');
  const code = src.slice(at, end);
  check(code.indexOf('(function () {') >= 0 || /function\s+\w+\s*\(/.test(code),
        name + '：抽出来的页面逻辑看着不像代码，检查抽取锚点');
  check(code.indexOf('__PAGE_') < 0, name + '：页面逻辑里不该再有 __PAGE_ 占位符');
  return code;
}
function assembleApp(html) {
  for (const p of APP_PAGES) {
    if (html.indexOf(p.ph) < 0) continue;                    // 这个壳不需要这段
    const tpl = fs.readFileSync(path.join(HERE, p.src), 'utf8');
    let code = pageCodeOf(tpl, p.src);
    /* 样卷 base64 全页只内联一次（三段都用同一份），否则文件凭空胖一圈 */
    code = code.replace(/const SAMPLE_B64 = "__SAMPLE_B64__";/g, 'const SAMPLE_B64 = SHARED_SAMPLE_B64;');
    code = code.replace(/__TXT_FIXTURES__/g, txtFixJs);
    check(code.indexOf('__SAMPLE_B64__') < 0 && code.indexOf('__TXT_FIXTURES__') < 0,
          p.src + '：页面逻辑里还有没填的样卷/固件占位符');
    html = html.split(p.ph).join('\n/* ==== 以下这段来自 ' + p.src + '（原样，未改写） ==== */\n' +
                                 safeJs(code) + '\n/* ==== ' + p.src + ' 页面逻辑结束 ==== */\n');
  }
  const left = html.match(/__PAGE_[A-Z]+__/g);
  check(!left, '答题全能版：还有没装配的页面逻辑占位符 → ' + (left || []).join(', '));
  /* 三个面板共处一份文档：**全局 id 不能重复**（重复 id 会让 getElementById 抓错面板） */
  const ids = (html.match(/\sid="([^"]+)"/g) || []).map(s => s.replace(/\sid="/, '').replace(/"$/, ''));
  const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
  check(dup.length === 0, '答题全能版：id 重复 → ' + Array.from(new Set(dup)).join(', '));
  return html;
}

let problems = [];
function check(cond, msg) { if (!cond) problems.push(msg); return cond; }

/* 只把 </script 打断，其余原样 —— 否则内联的代码会提前闭合 script 标签 */
function safeJs(src) { return src.replace(/<\/script/gi, '<\\/script'); }

function inlineAll(js, name) {
  for (const [ph, file] of INLINE) {
    if (js.indexOf(ph) < 0) continue;              // 该模板不需要这个核心
    const code = safeJs(fs.readFileSync(path.join(HERE, file), 'utf8'));
    js = js.split(ph).join(
      '\n/* ======== 内联开始：' + file + ' ======== */\n' + code + '\n/* ======== 内联结束：' + file + ' ======== */\n');
  }
  const left = js.match(/__[A-Z][A-Z0-9_]*__/g);
  check(!left, name + '：还有占位符没被替换 → ' + (left || []).join(', '));
  return js;
}

/* 语法自检：把 <script> 块抠出来交给 vm 编译（只编译不执行，够抓语法错） */
function syntaxCheck(html, name) {
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  check(blocks.length > 0, name + '：没找到可检查的 <script> 块');
  blocks.forEach((code, i) => {
    try { new vm.Script(code); }
    catch (e) { problems.push(name + '：第 ' + (i + 1) + ' 个 <script> 语法错误 → ' + e.message); }
  });
  return blocks;
}

/* 顺序自检：只看产物里实际存在的核心，索引必须递增 */
function orderCheck(html, name) {
  const present = ORDER_MUST.filter(function (t) { return html.indexOf(t) >= 0; });
  let prev = -1, last = '';
  for (const token of present) {
    const at = html.indexOf(token);
    if (at < prev) { check(false, name + '：内联顺序错了 → ' + token + ' 出现在 ' + last + ' 之前'); return; }
    prev = at; last = token;
  }
}

/* ---------------- 主流程 ---------------- */
const sampleB64 = fs.readFileSync(path.join(HERE, 'sample.docx')).toString('base64');

// 自检页 E 节要用「同一份样卷的三种编码」内嵌进去（用户点开即测，不用选文件）
const TXT_FIX_FILES = { utf8: 'basic_utf8.txt', utf8bom: 'basic_utf8bom.txt', gbk: 'basic_gbk.txt' };
const txtFixJs = (() => {
  const parts = [];
  for (const k of Object.keys(TXT_FIX_FILES)) {
    const p = path.join(HERE, 'fixtures', 'txt', TXT_FIX_FILES[k]);
    if (!fs.existsSync(p)) { problems.push('缺少 txt 固件：fixtures/txt/' + TXT_FIX_FILES[k]); continue; }
    parts.push('  ' + k + ': "' + fs.readFileSync(p).toString('base64') + '"');
  }
  return 'const TXT_FIX = {\n' + parts.join(',\n') + '\n};';
})();

for (const t of TARGETS) {
  const tplPath = path.join(HERE, t.tpl);
  if (!fs.existsSync(tplPath)) { problems.push('模板不存在：' + t.tpl); continue; }

  let html = fs.readFileSync(tplPath, 'utf8');
  /* ⚠ 合并版要**先装配**再填样卷：装配会把三段页面逻辑搬进来（它们里面各自的 __SAMPLE_B64__/__TXT_FIXTURES__
   *   已由 assembleApp 就地处理成共享常量），顺序反了会把整份 base64 复制三遍。 */
  if (t.assemble) html = assembleApp(html);
  // 样卷 base64 先填（它和核心是两类占位符，分开处理更清楚）
  if (html.indexOf('__SAMPLE_B64__') >= 0) html = html.split('__SAMPLE_B64__').join(sampleB64);
  if (html.indexOf('__TXT_FIXTURES__') >= 0) html = html.split('__TXT_FIXTURES__').join(txtFixJs);
  html = inlineAll(html, t.out);

  syntaxCheck(html, t.out);
  orderCheck(html, t.out);

  const outPath = path.join(HERE, t.out);
  fs.writeFileSync(outPath, html, 'utf8');

  // 同步桌面副本（用户双击入口）
  let deskMsg = '（桌面副本没更新）';
  try {
    fs.writeFileSync(path.join(DESKTOP, t.out), html, 'utf8');
    deskMsg = '已同步桌面副本';
  } catch (e) { deskMsg = '桌面副本写入失败：' + e.message; }

  // 报**真实字节数**：早先这里用 html.length（字符数）当 KB，中文页面会被少报 ~17%，
  // 看日志时容易误判成"体积缩水了"（我本人就被绊过一次）。
  console.log('  ' + t.out.padEnd(18) + (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1).padStart(7) + ' KB   ' + deskMsg);
}

/* 顺带报一下核心文件体积，内联后的体积增长要心里有数 */
console.log('\n  核心体积：');
for (const [, f] of INLINE) {
  const p = path.join(HERE, f);
  if (fs.existsSync(p)) console.log('    ' + f.padEnd(24) + (fs.statSync(p).size / 1024).toFixed(1).padStart(7) + ' KB');
}

if (problems.length) {
  console.error('\n\x1b[31m构建自检失败：\x1b[0m');
  problems.forEach(p => console.error('  - ' + p));
  process.exit(1);
}
console.log('\n\x1b[32m构建完成，自检全过。\x1b[0m');
