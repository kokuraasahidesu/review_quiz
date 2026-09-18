/* ============================================================
 *  verify/copy.test.js —— 「界面文案」静态闸门（不改逻辑，只守文字）
 *
 *  运行： node verify/copy.test.js
 *
 *  为什么要有它：用户报过两次**同一类**毛病 ——
 *    · 页脚写着 `**导入 / 校对 → 答题判分 → …**`（markdown 星号原样显示在页面上）；
 *    · 界面上到处是"误答本"，而页签叫「错题本」；校对面板里还漏出过"本小类"这种验收词。
 *  这些都**不是逻辑错**，跑多少功能测试都抓不到，只有把"文案"本身当被测对象才守得住。
 *
 *  三条判据（注释里的 `**` 是写作记号，**不算问题**；这里只看会进界面的字符串）：
 *    ① `**`（markdown 记号）不许出现在字符串字面量或 HTML 文本里 —— 否则用户看到两个星号；
 *       唯二豁免：`浏览器自检.html` 的检查项标题（诊断报告页，输出要直接贴进对话）与
 *       `core/ai.js` 发给模型的提示词（写作强调，不上界面）—— 两处都在下面显式登记。
 *    ② 界面用词统一：交给用户的文字里不许再出现数据层旧名「误答本」（界面叫「错题本」）；
 *       也不许出现验收术语「未校对」（界面统一「待校对」）。
 *    ③ 引号统一：产品里一律用「」，不许用『』（半角 () 在**数据值**里是冻结契约，不在本条管辖内）。
 *
 *  ⚠ 词法扫描是**真 tokenizer**（串/模板串/注释/正则各自识别），不是"剥注释再 grep"：
 *    正则字面量里就带引号（`/["']/`），粗糙剥法既会漏报也会误报。
 *    为了不让"扫描器自己坏了"伪装成全绿，末尾有一条**非空转**断言：捞到的字符串条数必须够多。
 *
 *  判据抽成 audit()，探针用**同一套判据**跑被改坏的源码（verify/probe-copy-old.js）。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const HERE = path.join(__dirname, '..');

function read(p) { return fs.readFileSync(p, 'utf8'); }
function readOr(p, d) { try { return read(p); } catch (e) { return d == null ? '' : d; } }

/* ---------------- 词法扫描：只认"字符串字面量"，注释一律跳过 ---------------- */
function stringLiterals(src) {
  const out = [];
  let i = 0, line = 1, prev = '';
  const n = src.length;
  while (i < n) {
    const c = src[i], c2 = src.substr(i, 2);
    if (c === '\n') { line++; i++; continue; }
    if (c2 === '//') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c2 === '/*') { i += 2; while (i < n && src.substr(i, 2) !== '*/') { if (src[i] === '\n') line++; i++; } i += 2; continue; }
    if (c === '"' || c === "'") {
      const q = c, start = line; let buf = ''; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { buf += src.substr(i, 2); i += 2; continue; }
        if (src[i] === '\n') line++;
        buf += src[i]; i++;
      }
      i++; out.push({ line: start, text: buf }); prev = q; continue;
    }
    if (c === '`') {
      const start = line; let buf = ''; i++;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { buf += src.substr(i, 2); i += 2; continue; }
        if (src[i] === '\n') line++;
        buf += src[i]; i++;
      }
      i++; out.push({ line: start, text: buf }); prev = '`'; continue;
    }
    if (c === '/') {
      /* 正则还是除法：看上一个有意义字符（标准启发式） */
      const isRe = !prev || '(,=:[!&|?{};+-*%~^<>'.indexOf(prev) >= 0;
      if (isRe) {
        i++; let cls = false;
        while (i < n && (cls || src[i] !== '/')) {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === '[') cls = true;
          if (src[i] === ']') cls = false;
          if (src[i] === '\n') line++;
          i++;
        }
        i++;
        while (i < n && /[a-z]/.test(src[i])) i++;
        prev = '/'; continue;
      }
      i++; prev = '/'; continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/* HTML 里的**文本**（剥掉 script/style 正文与注释）：模板页脚那类文案就住在这里 */
function markupText(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

/* 豁免名单：**显式登记**，每条都要写清为什么 */
const MD_EXEMPT = [
  { file: 'core/ai.js', has: '总评里必须', why: '发给模型的提示词（写作强调，不上界面）' },
  { file: 'core/ai.js', has: '不要写通用套话', why: '同上' },
  { file: 'core/ai.js', has: '不要写放之四海皆准的套话', why: '同上' },
  { file: 'core/ai.js', has: '引用记录里的真实数字', why: '同上' }
];
/* 自检页整页豁免：那一页是诊断报告，检查项标题的 `**` 就是为了让你复制粘贴给我 */
const MD_EXEMPT_FILES = ['selftest-template.html'];

function exempt(file, text) {
  if (MD_EXEMPT_FILES.indexOf(file) >= 0) return true;
  return MD_EXEMPT.some(function (e) { return e.file === file && text.indexOf(e.has) >= 0; });
}

const JS_FILES = [];
['ui', 'core', path.join('core', 'parse')].forEach(function (dir) {
  const d = path.join(HERE, dir);
  if (!fs.existsSync(d)) return;
  fs.readdirSync(d).filter(function (f) { return /\.js$/.test(f); }).sort()
    .forEach(function (f) { JS_FILES.push(path.join(dir, f).split(path.sep).join('/')); });
});
const HTML_FILES = ['answer-template.html', 'review-template.html', 'wrong-template.html',
                    'app-template.html', 'demo-template.html', 'selftest-template.html'];

function loadFiles() {
  const F = { js: {}, html: {} };
  JS_FILES.forEach(function (f) { F.js[f] = readOr(path.join(HERE, f)); });
  HTML_FILES.forEach(function (f) { F.html[f] = readOr(path.join(HERE, f)); });
  return F;
}
const FILES = loadFiles();

/* ---------------- 判据 ---------------- */
function audit(F) {
  const checks = [];
  const ok = function (c, t, d) { checks.push([!!c, t, d === undefined ? '' : String(d)]); };

  let litCount = 0, mdHits = [], wrongName = [], notChecked = [], cornerQuote = [], emptyFiles = [];

  Object.keys(F.js).forEach(function (f) {
    const src = F.js[f];
    let mine = 0;
    stringLiterals(src).forEach(function (s) {
      litCount++; mine++;
      const one = f + ':' + s.line;
      if (s.text.indexOf('**') >= 0 && !exempt(f, s.text)) mdHits.push(one + ' → ' + s.text.replace(/\s+/g, ' ').slice(0, 70));
      if (s.text.indexOf('误答本') >= 0) wrongName.push(one + ' → ' + s.text.slice(0, 60));
      if (s.text.indexOf('未校对') >= 0) notChecked.push(one + ' → ' + s.text.slice(0, 60));
      if (s.text.indexOf('『') >= 0 && s.text.indexOf('「') < 0) cornerQuote.push(one + ' → ' + s.text.slice(0, 60));
    });
    /* ⚠ 逐文件清点：某一天扫描器在**某个文件**上失灵（一条都捞不到），总量却还够 —— 那样就会静默放行 */
    if (mine === 0) emptyFiles.push(f);
  });
  Object.keys(F.html).forEach(function (f) {
    const m = markupText(F.html[f]);
    if (m.indexOf('**') >= 0 && MD_EXEMPT_FILES.indexOf(f) < 0) {
      mdHits.push(f + '（HTML 文本）');
    }
    if (m.indexOf('误答本') >= 0) wrongName.push(f + '（HTML 文本）');
    if (m.indexOf('未校对') >= 0) notChecked.push(f + '（HTML 文本）');
    if (m.indexOf('『') >= 0 && m.indexOf('「') < 0) cornerQuote.push(f + '（HTML 文本）');
  });

  /* ① markdown 记号不许漏进界面 */
  ok(mdHits.length === 0, '界面文案里没有漏出来的 markdown 记号（`**`）', mdHits.slice(0, 5).join(' | '));
  /* ② 术语统一 */
  ok(wrongName.length === 0, '交给用户的文字里没有数据层旧名「误答本」（界面统一「错题本」）', wrongName.slice(0, 5).join(' | '));
  ok(notChecked.length === 0, '没有「未校对」这种半截说法（界面统一「待校对」）', notChecked.slice(0, 5).join(' | '));
  /* ③ 引号统一：第一层引号一律「」，『』只允许出现在「」里面（中文里"引号中的引号"） */
  ok(cornerQuote.length === 0, '第一层引号统一用「」（『』只许出现在「」里面）', cornerQuote.slice(0, 5).join(' | '));
  /* 非空转：扫描器必须真的把**每个**文件都读到了（逐文件清点，总量够也可能某个文件漏捞） */
  ok(emptyFiles.length === 0, '扫描器逐文件都读到了字符串（漏捞一个文件就等于对那个文件放行）', emptyFiles.join(','));
  ok(litCount > 2000, '扫描器真的在读字符串（捞到 ' + litCount + ' 条；少于 2000 条说明它坏了）');

  return checks;
}

/* ---------------- 跑 ---------------- */
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

module.exports = { audit: audit, FILES: FILES, stringLiterals: stringLiterals, markupText: markupText };
