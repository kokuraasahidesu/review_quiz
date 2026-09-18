/* 「独立 HTML 生成」· 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-export-html-old.js
 *
 * 做法与前几个小类一致：拿**被改坏的 `core/data.js`** 去跑锚点所依赖的那一个行为，
 * 每一处"把闸门/命名/落盘拆掉"都必须让对应断言变成红的（打印 `锚变红=true`）。
 * 判据写在这里而不是"另写一套"—— 这里断言的就是测试里那几句的原话。
 */
const fs = require('fs');
const path = require('path');
const HERE = path.join(__dirname, '..');
function loadFrom(mutate, tmpRel) {
  const src = fs.readFileSync(path.join(HERE, 'core', 'data.js'), 'utf8');
  const out = mutate(src);
  if (out === src) throw new Error('探针失效：没替换到目标文本（core/data.js）');
  const tmp = path.join(HERE, tmpRel);
  fs.writeFileSync(tmp, out);
  delete require.cache[require.resolve(tmp)];
  return require(tmp);
}
function rm(rel) { try { fs.unlinkSync(path.join(HERE, rel)); } catch (e) { /* ignore */ } }

const S = require('../core/schema.js');
const SHELL = fs.readFileSync(path.join(HERE, '答题页.html'), 'utf8');
const EXAM = S.createExam({ id: 'P1', title: '探针卷', questions: [
  S.createQuestion({ id: 'p1', type: '单选', stem: '题干', options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }], answerLetters: ['A'], answer: 'A' })
] }, { now: '2026-11-02T15:30:00.000Z' });
const STATE = { exams: [EXAM] };
const AT = '2026-11-02T15:30:00.000Z';

/* 与 export-html.test.js 里同款的假浏览器环境（探针自己带一份，避免依赖测试的内部实现） */
function fakeEnv(opts) {
  const o = opts || {};
  const log = { created: [], revoked: [], clicked: 0, anchors: [] };
  function FakeBlob(parts, bopts) { this.parts = parts; this.type = (bopts || {}).type || ''; }
  const url = {
    createObjectURL: function (b) { const u = 'blob:p-' + (log.created.length + 1); log.created.push({ url: u, blob: b }); return u; },
    revokeObjectURL: function (u) { log.revoked.push(u); }
  };
  const body = { children: [], appendChild: function (el) { el.parentNode = body; body.children.push(el); },
                 removeChild: function (el) { body.children = body.children.filter(function (x) { return x !== el; }); } };
  const doc = { body: body, createElement: function (tag) {
    const el = { tag: tag, href: null, download: null, rel: null, style: {}, parentNode: null, click: function () { log.clicked++; } };
    log.anchors.push(el); return el; } };
  return { env: { document: doc, url: url, Blob: FakeBlob }, log: log };
}

const results = [];
function probe(name, fn) {
  let red = false, note = '';
  try { const r = fn(); red = (r === true); if (typeof r === 'string') note = r; else if (r !== true) note = JSON.stringify(r); }
  catch (e) { red = '抛错:' + (e && e.message); }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red + (note ? '   ' + note : ''));
}

/* ---- 1. 外部引用检测器瞎了（返回空表）→ 被注入外部脚本的壳照样"导出成功" ---- */
probe('① externalRefsIn 恒返回空 → ①-C「外部引用必须拒绝导出」锚变红', function () {
  const D = loadFrom(s => s.replace('    const s = String(html == null ? \'\' : html);\n    const out = [];\n    const attr = /([a-zA-Z_:]',
                                    '    return [];\n    const s = String(html == null ? \'\' : html);\n    const out = [];\n    const attr = /([a-zA-Z_:]'),
    'core/__probe_ex1.js');
  try {
    const injected = SHELL.replace('<div id="host"></div>', '<div id="host"></div><script src="https://cdn.example.com/x.js"></script>');
    const r = D.exportStandalone(STATE, injected, { examId: 'P1', at: AT, secrets: [] });
    return (r.ok === true) ? true : '居然还是拒了：' + r.message.slice(0, 40);
  } finally { rm('core/__probe_ex1.js'); }
});

/* ---- 2. 不剥 script/style 正文 → **自己的源码字符串被当成标签**，干净页面也判"有外部引用" ---- */
probe('② 不剥 raw 正文 → ①-A/①-B「成品零外部引用」锚变红', function () {
  const D = loadFrom(s => s.replace('      /(<(script|style)\\b[^>]*>)([\\s\\S]*?)(<\\/\\2\\s*>)/gi,\n      function (m, open, tag, body, close) {\n        return open + body.replace(/[^\\n]/g, \' \') + close;      // 等长替换 → 下标仍然对得上\n      });',
                                    '      /$^/,\n      function (m, open, tag, body, close) { return m; });'),
    'core/__probe_ex2.js');
  try {
    const refs = D.externalRefsIn(SHELL);
    const r = D.exportStandalone(STATE, SHELL, { examId: 'P1', at: AT, secrets: [] });
    return (refs.length > 0 && r.ok === false) ? true
      : ('refs=' + refs.length + ' ok=' + r.ok + '（没被骗到？）');
  } finally { rm('core/__probe_ex2.js'); }
});

/* ---- 3. 检测器还在，但导出流程不调它（有闸门不用） ---- */
probe('③ 导出不做外部引用自查 → ①-C「拒绝交出」锚变红', function () {
  const D = loadFrom(s => s.replace('    if (refs.length) {\n      return { ok: false, html: null, filename: null, payload: pkg.payload, scan: pkg.scan, refs: refs,',
                                    '    if (false) {\n      return { ok: false, html: null, filename: null, payload: pkg.payload, scan: pkg.scan, refs: refs,'),
    'core/__probe_ex3.js');
  try {
    const injected = SHELL.replace('<div id="host"></div>', '<div id="host"></div><link rel="stylesheet" href="https://cdn.example.com/a.css">');
    const r = D.exportStandalone(STATE, injected, { examId: 'P1', at: AT, secrets: [] });
    return (r.ok === true) ? true : '居然还是拒了：' + r.message.slice(0, 40);
  } finally { rm('core/__probe_ex3.js'); }
});

/* ---- 4. 文件名不含试卷标题（可辨识丢失） ---- */
probe('④ 文件名不带标题 → ②-A「含试卷标题」锚变红', function () {
  const D = loadFrom(s => s.replace("    const title = sanitizeFileName(e.title, 40) || '未命名试卷';", "    const title = 'export';"),
    'core/__probe_ex4.js');
  try {
    const f = D.shareFileName(EXAM, AT);
    return (f.indexOf('探针卷') < 0) ? true : ('居然还带着标题：' + f);
  } finally { rm('core/__probe_ex4.js'); }
});

/* ---- 5. 文件名是固定常量（多份导出互相覆盖） ---- */
probe('⑤ 文件名固定 → ③-A/③-C「多份互不覆盖」锚变红', function () {
  const D = loadFrom(s => s.replace("    return title + '-' + ts + (idTail ? '-' + idTail : '') + '.html';", "    return 'export.html';"),
    'core/__probe_ex5.js');
  try {
    const a = D.shareFileName({ id: 'A1', title: '甲卷' }, AT);
    const b = D.shareFileName({ id: 'B2', title: '乙卷' }, AT);
    return (a === b) ? true : ('居然还不同：' + a + ' / ' + b);
  } finally { rm('core/__probe_ex5.js'); }
});

/* ---- 6. 落盘后不回收 objectURL（几 MB 的 Blob 一直挂着） ---- */
probe('⑥ 不 revokeObjectURL → ②-B「回收」锚变红', function () {
  const D = loadFrom(s => s.replace('      if (href) { try { url.revokeObjectURL(href); } catch (e2) { /* 回收失败不影响交付 */ } }', '      void href;'),
    'core/__probe_ex6.js');
  try {
    const F = fakeEnv();
    const r = D.downloadHtml('<html></html>', 'x.html', F.env);
    return (r.ok === true && F.log.revoked.length === 0) ? true : ('revoked=' + F.log.revoked.length);
  } finally { rm('core/__probe_ex6.js'); }
});

/* ---- 7. 不给 <a> 设 download（浏览器只会"打开"，不会落盘） ---- */
probe('⑦ 不设 a.download → ②-B「download 属性 = 文件名」锚变红', function () {
  const D = loadFrom(s => s.replace('      a.download = name;                       // 关键：没有它浏览器只会"打开"而不是"落盘"', '      /* 忘了设 download */'),
    'core/__probe_ex7.js');
  try {
    const F = fakeEnv();
    const r = D.downloadHtml('<html></html>', '卷子.html', F.env);
    const a = F.log.anchors[0] || {};
    return (r.ok === true && a.download !== '卷子.html') ? true : ('download=' + a.download);
  } finally { rm('core/__probe_ex7.js'); }
});

/* ---- 8. 卷字段白名单改成"整卷拷贝"（答题记录跟着卷对象一起进载荷） ----
 * ⚠ 实测发现这里其实是**两层防线**：白名单一松，`answers` 这类脏字段刚进载荷就被
 *   `shareScan` 的敏感字段名挡下（`ok:false`，根本不产出文件）。
 *   所以锚的判据是"**要么被拦下、要么字段漏出去**"——两种都算 ③-F 变红（探针这里照它算）。 */
probe('⑧ 卷字段白名单改成整卷拷贝 → ③-F「答题记录一个字节都不进去」锚变红', function () {
  const D = loadFrom(s => s.replace('        SHARE_EXAM_FIELDS.forEach(function (k) {',
                                    '        Object.keys(e).forEach(function (k) {'),
    'core/__probe_ex8.js');
  const CANARY = 'CANARY-我的作答-9f3a2b';
  const DIRTY = Object.assign({}, EXAM, { answers: { p1: CANARY } });
  const r = D.exportStandalone({ exams: [DIRTY] }, SHELL, { examId: 'P1', at: AT, secrets: [] });
  /* ③-F 那条锚的判据：导出成功 + 哨兵搜不到 + 卷上的记录类字段为空 */
  const anchorOk = (r.ok === true) && (String(r.html).indexOf(CANARY) < 0)
    && Object.keys((r.payload && r.payload.exams && r.payload.exams[0]) || {})
         .filter(function (k) { return k === 'answers'; }).length === 0;
  return anchorOk ? '锚居然还没红（改坏没生效）' : true;
});

const bad = results.filter(r => r[1] !== true);
console.log('\n探针汇总：' + results.length + ' 条  全部能让锚变红=' + (bad.length === 0));
if (bad.length) { bad.forEach(b => console.log('  未变红：' + b[0] + ' → ' + b[1])); process.exitCode = 1; }
