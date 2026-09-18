/* ============================================================
 *  verify/export-html.test.js —— 「独立 HTML 生成」小类验收（verify=self）
 *
 *  运行： node build.js && node verify/export-html.test.js   （依赖 build 产物）
 *
 *  三条验收标准，逐条对应：
 *    ① 导出的 HTML **不含任何外部 script/link 引用**，断网双击可直接打开并加载该试卷；
 *    ② 导出的文件能被浏览器**正常下载落盘**，且文件名可辨识（**含试卷标题**）；
 *    ③ 导出**多份不同试卷**的文件互不覆盖，各自加载自己的试卷。
 *
 *  「壳」用成品 `答题页.html` 的**文本**：页面在挂载前抓的那份 `SHELL` 就是同一份文档
 *  （浏览器 `outerHTML` 是它的再序列化，`docType` 由页面自己补）。所以这里跑的整条路
 *  —— 脱敏 → 内嵌 → 命名 → 外部引用自查 —— 与按钮点下去时**是同一套代码**。
 *
 *  每条都配**反向对照**（把闸门拆掉必须变红），见 verify/probe-export-html-old.js。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const D = require('../core/data.js');
const S = require('../core/schema.js');
const Q = require('../core/quiz.js');

const HERE = path.join(__dirname, '..');
const ANSWER_SHELL = fs.readFileSync(path.join(HERE, '答题页.html'), 'utf8');

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

const AT = '2026-11-02T15:30:00.000Z';
function makeExam(id, title, stems) {
  return S.createExam({
    id: id, title: title,
    config: Q.resolveConfig({ points: { '单选': 3, '简答': 8 } }, null),
    configLocked: true,
    questions: stems.map(function (st, i) {
      return S.createQuestion({ id: id + '-q' + (i + 1), type: '单选', stem: st,
        options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }], answerLetters: ['B'], answer: 'B' });
    })
  }, { now: AT });
}
const EXAM_A = makeExam('A1', '三次握手练习', ['TCP 三次握手的第一步是什么？', 'SYN 的作用是什么？']);
const EXAM_B = makeExam('B2', '路由与交换 / 复习（第 3 章）', ['默认路由的作用是什么？']);
const STATE_A = { exams: [EXAM_A] };
const STATE_B = { exams: [EXAM_B] };

/* 假浏览器环境：把 Blob / URL / a[download] 三件套记下来，看代码到底怎么调的 */
function fakeEnv(opts) {
  const o = opts || {};
  const log = { created: [], revoked: [], clicked: 0, appended: 0, removed: 0, blobs: [], anchors: [] };
  function FakeBlob(parts, bopts) {
    this.parts = parts; this.type = (bopts || {}).type || '';
    this.size = parts.join('').length;
    log.blobs.push(this);
  }
  const url = {
    createObjectURL: function (b) { const u = 'blob:fake-' + (log.created.length + 1); log.created.push({ url: u, blob: b }); return u; },
    revokeObjectURL: function (u) { log.revoked.push(u); }
  };
  const body = {
    children: [],
    appendChild: function (el) { el.parentNode = body; body.children.push(el); log.appended++; },
    removeChild: function (el) { body.children = body.children.filter(function (x) { return x !== el; }); log.removed++; }
  };
  const doc = {
    body: body,
    createElement: function (tag) {
      const el = { tag: tag, href: null, download: null, rel: null, style: {}, parentNode: null,
                   click: function () { log.clicked++; if (o.clickThrows) throw new Error('点击被拦截'); } };
      log.anchors.push(el);
      return el;
    }
  };
  return { env: { document: o.noDom ? null : doc, url: o.noUrl ? null : url, Blob: o.noBlob ? null : FakeBlob }, log: log, doc: doc };
}

head('①-A 壳本身零外部引用：成品答题页没有任何 src / link / @import');

/* 测试自带一份"剥掉 script/style 正文"的独立实现（**故意不复用库里的**：
 * 两边各写一遍，才可能相互发现对方"把源码里的字符串当标签"这类错）。 */
function bodyMasked(html) {
  return String(html).replace(/(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi,
    function (m, open, tag, body, close) { return open + body.replace(/[^\n]/g, ' ') + close; });
}
const SHELL_TAGS = bodyMasked(ANSWER_SHELL);

eq(D.externalRefsIn(ANSWER_SHELL), [], '**成品答题页零外部引用**（断网双击就能开）');
ok(ANSWER_SHELL.indexOf('root.DataCore') >= 0 && ANSWER_SHELL.indexOf('root.AttemptView') >= 0
   && ANSWER_SHELL.indexOf('内联结束：ui/attempt-view.js') >= 0,
   '  应用代码与依赖都**内联**在同一份文件里（不是引用外部 js）',
   Buffer.byteLength(ANSWER_SHELL, 'utf8') + ' 字节');
eq((SHELL_TAGS.match(/<script[^>]*\ssrc\s*=/gi) || []).length, 0, '  全文没有 `<script src=…>`');
eq((SHELL_TAGS.match(/<link\b/gi) || []).length, 0, '  全文没有 `<link>`');

head('①-B 导出成品：零外部引用 + 断网打开即加载该试卷');

const rA = D.exportStandalone(STATE_A, ANSWER_SHELL, { examId: 'A1', at: AT, secrets: [] });
eq(rA.ok, true, '导出成功', rA.ok ? rA.filename : rA.message);
eq(D.externalRefsIn(rA.html), [], '**导出文件零外部引用**（验收标准①原句）');
const OUT_TAGS = bodyMasked(rA.html);
eq((OUT_TAGS.match(/<script[^>]*\ssrc\s*=/gi) || []).length, 0, '  导出文件里没有 `<script src=…>`');
eq((OUT_TAGS.match(/<link\b/gi) || []).length, 0, '  导出文件里没有 `<link>`');
eq(rA.bytes, Buffer.byteLength(rA.html, 'utf8'), '  报出的字节数 = 真实 UTF-8 字节数');
const bcA = D.payloadBlockCount(rA.html);
eq([bcA.blocks, bcA.complete], [1, 1], '结构完整：恰好 1 个载荷块、且它自己是完整的');
eq(bcA.scriptCloses, D.payloadBlockCount(ANSWER_SHELL).scriptCloses + 1,
   '收尾标签数 = 模板原有的 + 1（载荷只多出一个 script 元素，没有把别人的块截断）');
eq(D.rawCloseInPayload(rA.html), 0, '  载荷块里没有裸 `</script`（题面里的尖括号已被转义）');
/* "断网双击可直接打开并加载该试卷" —— 页面靠这段代码加载自带载荷 */
ok(rA.html.indexOf('DataCore.extractPayloadDetailed(srcHtml)') >= 0,
   '  导出文件里带着"打开即读自带载荷"的启动代码（接线在页面里，不是只写在文档里）');
/* 「断网双击可直接打开并加载该试卷」—— 靠的是"启动先读自带载荷"这一段（内置样卷已改成手动点，
 * 所以这里不再比"载荷 vs 样卷"的先后，而是比"载荷读取在启动分支里、且在 boot 之前"）。 */
ok(rA.html.indexOf('DataCore.extractPayloadDetailed(srcHtml)')
   < rA.html.indexOf('boot(e0.id,'),
   '  启动先读自带载荷、再建会话 —— 双击打开就是这份卷（不是空首页）');
/* 手机端报障（导出的卷在别的浏览器里"看不了"）的兜底：载荷**读得出来但坏了**时必须当面说，
 * 否则收件人只会看到一个空题库首页 → "打开了但没试卷"，出题者拿不到任何线索。 */
ok(/PAYLOAD_BAD\)[\s\S]{0,900}已回到题库首页/.test(rA.html),
   '  载荷坏了/被截断 → 红字说明原因（不再默默落回空题库）');
eq(D.extractPayload(rA.html).exams[0].id, 'A1', '  读回来就是这份卷（id 对得上）');
eq(D.extractPayload(rA.html).exams[0].title, '三次握手练习', '  标题也在');
eq(D.extractPayload(rA.html).exams[0].questions.length, 2, '  题目数一致（2 题）');
ok(rA.html.indexOf('TCP 三次握手的第一步是什么？') >= 0, '  题干原文在里面');

head('①-C 反向：壳里有外部引用 → **拒绝交出**，而不是发一份"断网就瞎"的文件');

const INJECT = [
  ['被插件注入的 script', ANSWER_SHELL.replace('<div id="host"></div>', '<div id="host"></div><script src="https://cdn.example.com/x.js"></script>')],
  ['外部样式表', ANSWER_SHELL.replace('</head>', '<link rel="stylesheet" href="https://cdn.example.com/a.css"></head>')],
  ['CSS @import', ANSWER_SHELL.replace('</head>', '<style>@import url("https://cdn.example.com/b.css");</style></head>')],
  ['协议相对地址', ANSWER_SHELL.replace('<div id="host"></div>', '<div id="host"></div><img src="//cdn.example.com/p.png">')],
  ['行内样式里的 url()', ANSWER_SHELL.replace('<div id="host"></div>', '<div id="host"></div><div style="background:url(https://cdn.example.com/bg.png)"></div>')]
];
INJECT.forEach(function (v) {
  const refs = D.externalRefsIn(v[1]);
  ok(refs.length >= 1, '  体检能抓出「' + v[0] + '」', JSON.stringify(refs[0] || null));
  const r = D.exportStandalone(STATE_A, v[1], { examId: 'A1', at: AT, secrets: [] });
  eq([r.ok, r.html, r.filename], [false, null, null], '  → **拒绝导出**（不给半个能用的文件）');
  ok(r.refs && r.refs.length >= 1 && /外部引用/.test(String(r.message)), '  报告里点名"外部引用"：' + String(r.message).slice(0, 52));
});
/* 反向对照的反向：页面**正文里的网址是数据**，不是外部引用 —— 不能一起拦掉（否则天天误报）。
 * `https://dashscope.aliyuncs.com` 就是 AI 端点，本来就写在代码里。 */
const DATA_URL_SHELL = ANSWER_SHELL.replace('<div id="host"></div>',
  '<div id="host"></div><p>端点：https://dashscope.aliyuncs.com/compatible-mode/v1</p><a href="https://example.com/help">帮助</a>');
eq(D.externalRefsIn(DATA_URL_SHELL), [], '正文里的网址与 `<a href>` **不算外部引用**（只看 src / link / @import）');
eq(D.exportStandalone(STATE_A, DATA_URL_SHELL, { examId: 'A1', at: AT, secrets: [] }).ok, true, '  这种壳照样能导出');

head('②-A 文件名：**含试卷标题**、可辨识、跨平台安全');

const fA = D.shareFileName(EXAM_A, AT);
ok(fA.indexOf('三次握手练习') >= 0, '文件名含试卷标题：' + fA);
ok(/\.html$/.test(fA), '  以 .html 结尾（双击就能开）');
ok(!/[\\/:*?"<>|\u0000-\u001f]/.test(fA), '  不含任何文件系统禁用字符');
eq(D.shareFileName(EXAM_A, AT), fA, '  同一个 at 下可复现（不是随机名）');

const NASTY = D.sanitizeFileName('  三次握手/复习: 第1章?*"<>|\n 二次 ', 40);
ok(!/[\\/:*?"<>|\u0000-\u001f]/.test(NASTY), '恶意标题被清洗（无禁用字符/控制字符）：' + NASTY);
eq(NASTY, NASTY.trim(), '  首尾不留空白');
eq(D.sanitizeFileName('...  ...'), '', '  只有点/空格的标题被清成空串');
eq(D.sanitizeFileName('x'.repeat(80)).length, 40, '  超长标题截到 40 字（不给文件系统留麻烦）');
eq(D.shareFileName({ id: 'X1', title: '' }, AT).indexOf('未命名试卷'), 0, '  没标题时兜底「未命名试卷」');
const fSlash = D.shareFileName(EXAM_B, AT);
ok(fSlash.indexOf('路由与交换') >= 0 && fSlash.indexOf('/') < 0 && fSlash.indexOf('（第 3 章）') >= 0,
   '  标题里带斜杠也不会变成子目录，标题本身照样可辨识：' + fSlash);

head('②-B 落盘：Blob + a[download] + 回收，一条不漏');

const F1 = fakeEnv();
const d1 = D.downloadHtml(rA.html, rA.filename, F1.env);
eq(d1.ok, true, '触发下载成功', d1.message);
eq(F1.log.blobs.length, 1, '  造了 1 个 Blob');
eq([F1.log.blobs[0].parts.length, F1.log.blobs[0].type], [1, 'text/html;charset=utf-8'],
   '  Blob 里装的正是导出内容，MIME 是 text/html;charset=utf-8');
eq(F1.log.blobs[0].parts[0] === rA.html, true, '  内容逐字节相同（不是截断或转成别的编码）');
eq(F1.log.created.length, 1, '  用了 URL.createObjectURL');
eq(F1.log.created[0].blob === F1.log.blobs[0], true, '  objectURL 就是从这个 Blob 来的');
eq(F1.log.clicked, 1, '  a.click() 恰好 1 次（不多点，避免下载两遍）');
eq(F1.log.anchors.length, 1, '  只造了 1 个 <a>（不往页面里堆临时元素）');
eq([F1.log.anchors[0].tag, F1.log.anchors[0].download], ['a', rA.filename],
   '**<a download> 属性 = 我们给的文件名**（没有它浏览器只会"打开"页面，不会落盘）');
eq(F1.log.anchors[0].href, F1.log.created[0].url, '  <a href> 指向刚创建的 objectURL');
eq([F1.log.anchors[0].rel, F1.log.anchors[0].style.display], ['noopener', 'none'],
   '  临时链不抢焦点、也不在页面上露出来');
eq(F1.log.revoked.length === 1 && F1.log.revoked[0] === F1.log.created[0].url, true,
   '**revokeObjectURL 同一地址回收**（几 MB 的 Blob 不会一直挂在内存里）');
eq(F1.doc.body.children.length, 0, '  临时 <a> 用完就摘掉（不留脏 DOM）');

const F2 = fakeEnv();
const d2 = D.downloadHtml('x', 'a/b:c?.html', F2.env);
eq(d2.filename, 'a_b_c_.html', 'downloadHtml 自己也会清洗文件名（传脏名进来也不怕）');
eq(D.downloadHtml('x', 'x', fakeEnv().env).ok, true, '文件名缺后缀时自动补 .html');
eq(D.downloadHtml('x', 'x.html', fakeEnv().env).filename, 'x.html', '  已有 .html 不会变成 x.html.html');

head('②-C 环境不行时说清楚，而且**不抛异常**');

eq(D.downloadHtml('x', 'n', fakeEnv({ noUrl: true }).env).reason, 'no-blob-url', '没有 URL.createObjectURL → reason=no-blob-url');
ok(/另存为/.test(D.downloadHtml('x', 'n', fakeEnv({ noUrl: true }).env).message), '  提示里给替代办法（手动另存为）');
eq(D.downloadHtml('x', 'n', fakeEnv({ noBlob: true }).env).reason, 'no-blob', '没有 Blob → reason=no-blob');
eq(D.downloadHtml('x', 'n', fakeEnv({ noDom: true }).env).reason, 'no-dom', '没有 document → reason=no-dom');
const F3 = fakeEnv({ clickThrows: true });
const d3 = D.downloadHtml('x', 'n', F3.env);
eq([d3.ok, d3.reason], [false, 'click-failed'], '点击抛错 → ok:false（不把异常甩给调用方）');
eq(F3.log.revoked.length, 1, '  **抛错也照样回收** objectURL（finally 里做的事）');

head('③-A 多份不同试卷：文件名互不覆盖，各自加载自己的卷');

const rA2 = D.exportStandalone(STATE_A, ANSWER_SHELL, { examId: 'A1', at: AT, secrets: [] });
const rB2 = D.exportStandalone(STATE_B, ANSWER_SHELL, { examId: 'B2', at: AT, secrets: [] });
eq([rA2.ok, rB2.ok], [true, true], '两套卷都导出成功');
ok(rA2.filename !== rB2.filename, '**文件名不同**（同一分钟导出也不撞名）', rA2.filename + '  vs  ' + rB2.filename);
const pA = D.extractPayload(rA2.html), pB = D.extractPayload(rB2.html);
eq([pA.exams[0].id, pB.exams[0].id], ['A1', 'B2'], '各自加载自己的试卷（载荷 id 不相干）');
eq([pA.exams[0].questions.length, pB.exams[0].questions.length], [2, 1], '  题数也各是各的');
ok(rA2.html.indexOf('默认路由的作用是什么？') < 0, '**A 的文件里没有 B 的题干**');
ok(rB2.html.indexOf('TCP 三次握手的第一步是什么？') < 0, '**B 的文件里没有 A 的题干**');
ok(rA2.html.indexOf('默认路由') < 0 && rB2.html.indexOf('三次握手练习') < 0, '  连标题都不串味');

head('③-B 相邻锚：把 B 导进"已经是 A 的文件"里 —— 旧卷要被换掉，只留一份');

const rInto = D.exportStandalone(STATE_B, rA2.html, { examId: 'B2', at: AT, secrets: [] });
eq(rInto.ok, true, '在 A 的成品上导出 B：成功');
eq(D.payloadBlockCount(rInto.html).blocks, 1, '  仍然只有 1 个载荷块（不是叠两个）');
eq(D.extractPayload(rInto.html).exams[0].id, 'B2', '  读回来是 B（旧块被替换，不是留着读旧的）');
ok(rInto.html.indexOf('TCP 三次握手的第一步是什么？') < 0, '**A 的题干彻底消失**（旧载荷没有跟着文件走）');

head('③-C 相邻锚：同一份卷导出两次 → 名字不同（不覆盖），载荷仍然是它自己');

const rAgain = D.exportStandalone(STATE_A, ANSWER_SHELL, { examId: 'A1', at: '2026-11-02T15:31:00.000Z', secrets: [] });
ok(rAgain.filename !== rA2.filename, '隔一分钟再导出 → 文件名不同（不会静默覆盖上一次的）');
eq(D.extractPayload(rAgain.html).exams[0].id, 'A1', '  两次导出的都是同一份卷');
eq(D.payloadBlockCount(rAgain.html).blocks, 1, '  每次都是干净的 1 个块');

head('③-E 多选打包（用户要求："可以选择一并打包的试卷"）');

/* 一份 state 里同时有 A1 与 B2；examIds 选几套就打包几套 */
const TWO = { exams: { A1: EXAM_A, B2: EXAM_B } };
const rBoth = D.exportStandalone(TWO, ANSWER_SHELL, { examIds: ['A1', 'B2'], at: AT, secrets: [] });
eq(rBoth.ok, true, '两套卷一起导出：成功', rBoth.ok ? rBoth.filename : rBoth.message);
eq(/^答题分享-2套-\d{8}-\d{4}\.html$/.test(rBoth.filename), true,
   '  多卷的文件名走"答题分享-N套-时间戳"（不堆一串标题）', rBoth.filename);
const pBoth = D.extractPayload(rBoth.html);
eq([pBoth.exams.length, pBoth.exams.map(function (e) { return e.id; })], [2, ['A1', 'B2']],
   '  载荷里**两套卷都在**（不是只带走第一套）');
ok(rBoth.html.indexOf('TCP 三次握手的第一步是什么？') >= 0 && rBoth.html.indexOf('默认路由的作用是什么？') >= 0,
   '  两份题干都在文件里');
eq(D.payloadBlockCount(rBoth.html).blocks, 1, '  仍然只有 1 个载荷块（多卷是放在同一个包里，不是叠块）');
eq(rBoth.exams.map(function (e) { return e.id; }), ['A1', 'B2'], '  结果里如实回报打包了哪几套');
eq(D.exportStandalone(TWO, ANSWER_SHELL, { examIds: ['B2'], at: AT, secrets: [] }).filename.indexOf('答题分享-2套') < 0,
   true, '只选一套时走**单卷**命名（老口径不变）');
const rAll = D.exportStandalone(TWO, ANSWER_SHELL, { examIds: [], examId: null, at: AT, secrets: [] });
eq(D.extractPayload(rAll.html).exams.length, 2, 'examIds 传空数组 = 没给 → 回到"全都要"');
eq(D.exportStandalone(TWO, ANSWER_SHELL, { examIds: ['A1', 'B2'], examId: 'A1', at: AT, secrets: [] }).filename,
   rBoth.filename, '  examIds 比 examId 优先（更具体的那个说了算）');

/* ============================================================
 * ③-F 用户要求：**转发时只转试卷本身，不包含答题记录**
 *   这条不是"顺便扫一眼"，而是**喂一份带答题记录的状态**再断言它们一个字节都没进去：
 *   把进度 / 成绩记录 / 错题本（含"作答过什么"的痕迹）都塞进 state，
 *   导出后用**只有记录里才有**的哨兵字符串去搜成品 HTML —— 搜到就是泄漏。
 * ============================================================ */
head('③-F 转发只带试卷本身：答题记录 / 成绩 / 错题本一个字节都不进分享文件');

const ANS_CANARY = 'CANARY-我的作答-9f3a2b';
const WRONG_CANARY = 'CANARY-错题本-5c7d1e';
const REC_CANARY = 'CANARY-成绩单-2a4b6c';
const CFG_CANARY = 'CANARY-进度里的配置-8e0f2a';

const STATE_DIRTY = {
  /* 卷本体照旧 */
  exams: [EXAM_A],
  /* 下面这些"答题记录"都必须被拒之门外 */
  progress: { A1: { answers: { 'A1-q1': ANS_CANARY }, index: 1, config: { note: CFG_CANARY } } },
  records: [{ examId: 'A1', score: 3, at: REC_CANARY }],
  wrongBook: { A1: { entries: { 'A1-q1': { stem: WRONG_CANARY, times: 2 } } } },
  /* 就算有人把它们**塞进卷对象**（历史数据的脏字段），也只允许白名单里的字段过去 */
  settings: { apiKeys: { x: REC_CANARY } },
  draft: { text: WRONG_CANARY }
};
const DIRTY_EXAM = Object.assign({}, EXAM_A, {
  /* 卷对象上的脏字段：白名单之外的键一个都不许出现在载荷里 */
  answers: { 'A1-q1': ANS_CANARY },
  lastAnswers: { 'A1-q1': ANS_CANARY },
  progress: { answers: { 'A1-q1': ANS_CANARY } },
  wrongEntries: [{ stem: WRONG_CANARY }],
  records: [{ at: REC_CANARY }]
});
const rDirtyRec = D.exportStandalone(Object.assign({}, STATE_DIRTY, { exams: [DIRTY_EXAM] }), ANSWER_SHELL,
  { examId: 'A1', at: AT, secrets: [] });
eq(rDirtyRec.ok, true, '带答题记录的状态照样能导出（不因为"有记录"就失败 —— 记录只是不跟着走）');
const pDirty = D.extractPayload(rDirtyRec.html);
eq(Object.keys(pDirty).sort(), ['exams', 'exportedAt', 'kind', 'schemaVersion'],
   '载荷顶层**只有这四样**（没有 progress / records / wrongBook / settings / draft）',
   Object.keys(pDirty).sort());
eq(Object.keys(pDirty.exams[0]).filter(function (k) {
     return ['answers', 'lastAnswers', 'progress', 'wrongEntries', 'records', 'settings'].indexOf(k) >= 0;
   }), [], '  卷对象上的答题记录类脏字段一个没过去（白名单之外一律丢）');
const dirtyTexts = [rDirtyRec.html.indexOf(ANS_CANARY), rDirtyRec.html.indexOf(WRONG_CANARY),
                    rDirtyRec.html.indexOf(REC_CANARY), rDirtyRec.html.indexOf(CFG_CANARY)];
eq(dirtyTexts, [-1, -1, -1, -1], '**成品 HTML 里搜不到任何一个哨兵**（作答 / 错题 / 成绩 / 进度配置）', dirtyTexts);
eq(D.payloadBlockCount(rDirtyRec.html).blocks, 1, '  仍然只有一个载荷块（多卷/多字段不另开块）');
/* 卷本身必须**照旧完整**：不能"为了不带记录"把题也丢了（反向对照，否则"全删"也能过） */
eq([pDirty.exams.length, pDirty.exams[0].questions.length, pDirty.exams[0].title],
   [1, 2, EXAM_A.title], '对照：试卷本身照旧完整（题数、标题都在）');
eq(pDirty.exams[0].questions[0].stem, EXAM_A.questions[0].stem, '  题干也在（不是空壳）');
/* 接收者那份文件里也不含"出题者的作答记录"这件事，换个说法再钉一次：**载荷块正文**里搜存储键名。
 * ⚠ 只能搜**载荷块**，不能搜整份 HTML：成品里内联着 core/data.js / core/attempt.js 的**代码**，
 *   代码里当然有 '::progress' 这些字面量 —— 拿它当泄漏信号是假阳性（这里踩过一次）。 */
const pBlockAt = rDirtyRec.html.indexOf('id="' + D.PAYLOAD_ID + '"');
const pBlock = pBlockAt < 0 ? '' : rDirtyRec.html.slice(pBlockAt, rDirtyRec.html.indexOf('</script>', pBlockAt));
ok(pBlock.length > 100, '能定位到载荷块正文（用于只扫"数据"、不扫"代码"）', pBlock.length + ' 字符');
const keyHits = ['::progress', 'wrong::', 'record::', 'answers', 'lastAnswers'].filter(function (k) {
  return pBlock.indexOf(k) >= 0;
});
eq(keyHits, [], '载荷块里连**答题记录的键名**都没有（只有试卷字段）', keyHits);
ok(pBlock.indexOf(EXAM_A.questions[0].stem) >= 0, '对照：载荷块里确实有试卷内容（不是空块）');

head('③-D 相邻锚：脱敏与采分能力没被导出路径绕过（同 ①/③ 的交界）');

const CANARY2 = 'sk-canary-should-not-travel-0001';
/* 情况一：密钥塞在**白名单外的字段**上（`exam.apiKey`）→ 白名单重建时整条丢掉，包是干净的，
 * 所以"照常导出"才是对的 —— 该断言的是**文件里搜不到那把 Key**，而不是"必须拒绝"。 */
const dirty = { exams: [Object.assign({}, EXAM_A, { apiKey: CANARY2 })] };
const rDirty = D.exportStandalone(dirty, ANSWER_SHELL, { examId: 'A1', at: AT, secrets: [CANARY2] });
eq(rDirty.ok, true, '白名单外的敏感字段 → **被整条丢弃**，包仍然干净（不是"有密钥就一律拒"）');
ok(rDirty.html.indexOf(CANARY2) < 0, '**导出文件里搜不到那把 Key**（连键名都不该有）',
   'ok=' + rDirty.ok);
/* 情况二：密钥被**粘进题干**（真在载荷里）→ 闸门必须拦下，而且不许静默改写题面 */
const pasted = { exams: [Object.assign({}, EXAM_A, {
  questions: [Object.assign({}, EXAM_A.questions[0], { stem: '题干里粘了 ' + CANARY2 })]
})] };
const rPasted = D.exportStandalone(pasted, ANSWER_SHELL, { examId: 'A1', at: AT, secrets: [CANARY2] });
eq([rPasted.ok, rPasted.html], [false, null], '**题干里粘了密钥 → 拒绝导出**（闸门在导出路径上真的生效）');
ok(/不要发出去/.test(String(rPasted.message)), '  报告说清"不要发出去"：' + String(rPasted.message).slice(0, 48));
const rKey = D.exportStandalone(STATE_A, ANSWER_SHELL, { examId: 'A1', at: AT, secrets: [CANARY2] });
eq(rKey.ok, true, '干净的卷子 + 同样的机密集合 → 照常导出');
eq(rKey.scan.checked.questions, 2, '  体检确实扫到了 2 道题（不是空转）');

console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
console.log('  PASS ' + pass + '    FAIL ' + fail);
if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
console.log('  \x1b[90m注：本小类 verify=self —— 开发方自验（两遍法）；反向对照见 verify/probe-export-html-old.js\x1b[0m');
process.exitCode = fail ? 1 : 0;
