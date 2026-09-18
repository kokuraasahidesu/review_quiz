/* 页面接线锚 · 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-wiring-old.js
 *
 * 做法：拿 `verify/wiring.test.js` 导出的**同一套判据**（audit）去跑被人为改坏的成品源码，
 * 每一处"把接线拆掉"都必须让**指定的那一组**断言变红。
 * 用同一套判据是关键：探针里另写一遍判断，两边迟早各说各话。
 */
const fs = require('fs');
const path = require('path');
const { audit } = require('./wiring.test.js');

const HERE = path.join(__dirname, '..');
const ANSWER = fs.readFileSync(path.join(HERE, '答题页.html'), 'utf8');
const WRONG = fs.readFileSync(path.join(HERE, '错题本.html'), 'utf8');
const REVIEW = fs.readFileSync(path.join(HERE, '校对面板.html'), 'utf8');
/* ⚠ 合并版成品也要进探针：外壳那几条锚（底部固定栏的搬移、页签折叠的悬浮…）只存在于它里面。
 *   以前这里不读它，那几条锚就没法被证伪（探针 ㉑ 第一版就"找不到片段"）。 */
const APPX = fs.readFileSync(path.join(HERE, 'review_quiz.html'), 'utf8');

const results = [];
/*
 * keyword：这一组断言靠这个关键词定位（锚是"成对"的，不能只看总数变少）
 * mutate：{answer, wrong, review, app} 四个改法，任一可为 null（不改）
 */
function probe(name, keyword, mutate) {
  let red = false, note = '';
  try {
    const pick = lists => lists.filter(c => c[1].indexOf(keyword) >= 0);
    const base = pick(audit(ANSWER, WRONG, REVIEW, APPX));
    if (!base.length) throw new Error('基线里没有含「' + keyword + '」的断言（关键词写错了）');
    const a2 = mutate.answer ? mutate.answer(ANSWER) : ANSWER;
    const w2 = mutate.wrong ? mutate.wrong(WRONG) : WRONG;
    const r2 = mutate.review ? mutate.review(REVIEW) : REVIEW;
    const x2 = mutate.app ? mutate.app(APPX) : APPX;
    const mutated = pick(audit(a2, w2, r2, x2));
    const before = base.filter(c => c[0]).length, after = mutated.filter(c => c[0]).length;
    red = after < before;
    note = '基线通过 ' + before + '/' + base.length + ' → 改坏后 ' + after + '/' + mutated.length;
  } catch (e) { red = '抛错:' + (e && e.message); }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red + (note ? '   ' + note : ''));
}

/* 改法：把某个片段换成另一个（找不到就抛错，避免"改了个寂寞"）
 * ⚠ 多行片段要**容忍 CRLF**：仓库里这些模板是 CRLF，而探针里写的是 LF ——
 *   只按 \n 找会"找不到片段"（㉑㉕ 第一版就卡在这儿）。 */
function swap(needle, repl) {
  return function (src) {
    const s = String(src);
    if (s.indexOf(needle) >= 0) return s.replace(needle, repl);
    const crlf = String(needle).replace(/\n/g, '\r\n');
    if (s.indexOf(crlf) >= 0) return s.replace(crlf, String(repl).replace(/\n/g, '\r\n'));
    throw new Error('没找到待替换片段：' + needle);
  };
}

/* ---- 1. 答题页不再自动收集（交卷后错题永不进本） ---- */
probe('① 交卷回调不再调 collectWrong → 「交卷回调」那组断言变红', '交卷回调',
  { review: null, answer: swap('collectWrong(summary)', 'void 0'), wrong: null });

/* ---- 2. 答题页改成自己写错题本（绕过唯一写入口） ---- */
probe('② 页面自己写错题本 → 「写入口」那组断言变红', '写入口',
  { review: null, answer: swap('WrongCore.collectToStore(', 'WrongCore.saveBook('), wrong: null });

/* ---- 3. 错题本页绕过弹窗直接删（静默删除） ---- */
probe('③ 绕过弹窗直接删 → 「真弹窗」那组断言变红', '真弹窗',
  { answer: null, review: null, wrong: swap('DeleteDialog.mount({', 'window.confirm(') });

/* ---- 4. 删除调用不带政策（依赖默认行为 = 静默删除旁路） ---- */
probe('④ 删除调用不带 policy → 「policy」那组断言变红', 'policy',
  { answer: null, review: null, wrong: swap('{ policy: policy, now: new Date().toISOString() }', '{ now: new Date().toISOString() }') });

/* ---- 5. 保留的记录不再读回来（选了『否』回到本页看不见记录） ---- */
probe('⑤ 不读已删除卷的误答本 → 「loadAllWithDeleted」那组断言变红', 'loadAllWithDeleted',
  { answer: null, review: null, wrong: swap('WrongCore.loadAllWithDeleted(', 'WrongCore.loadAll(') });

/* ---- 6. 校对面板不再挂 AI 密钥面板（能力表/密钥入口整块消失） ---- */
probe('⑥ 校对面板不挂 AI 面板 → 「AiSettings.mount」那组断言变红', 'AiSettings.mount',
  { answer: null, wrong: null, review: swap('AiSettings.mount({', 'void (') });

/* ---- 7. 「生成解析」不再读校对面板的草案（自己去别处捞题）→ 锚变红 ----
 * ⚠ 这一条原来盯的是单题智能的 `getDraft`；用户把两颗按钮合并成一颗「生成解析」之后，
 *   判据**跟着功能搬家**：改盯 mountBatch 的 `getQuestions`（同样必须来自 panel.getDraft()）。 */
probe('⑦ 生成解析不接校对面板草案 → 「解析对象 = 这份草案里还缺解析的题」锚变红', '解析对象 = ',
  { answer: null, wrong: null, review: swap('getQuestions: function () { return (panel.getDraft().questions || []).filter(',
                                            'getQuestions: function () { return (window.__other.questions || []).filter(') });

/* ---- 8. 导出不再落盘（算好了文件却没人交给浏览器） ---- */
probe('⑧ 导出不落盘 → 「落盘」那组断言变红', '落盘',
  { answer: swap('DataCore.downloadHtml(r.html, r.filename)', 'void 0'), review: null, wrong: null });

/* ---- 9. 壳改到挂载之后再抓（把运行时残留一起打包） ---- */
probe('⑨ 壳在挂载后抓 → 「挂载之前抓」那组断言变红', '壳在挂载',
  { answer: swap("  const SHELL = '<!doctype html>\\n' + document.documentElement.outerHTML;",
                 "  let SHELL = '';\n  setTimeout(function () { SHELL = '<!doctype html>\\n' + document.documentElement.outerHTML; }, 0);"),
    review: null, wrong: null });

/* ---- 10. 打开时不读自带载荷（导出文件双击打开加载不了那套卷） ---- */
probe('⑩ 不读自带载荷 → 「自带载荷」那组断言变红', '自带载荷',
  { answer: swap('DataCore.extractPayloadDetailed(srcHtml)', 'null'),
    review: null, wrong: null });

/* ---- 11. 打开分享文件时不切命名空间（接收者的记录会写进出题者的 app 空间） ---- */
probe('⑪ 不切接收者空间 → 「落盘空间切到」那组断言变红', '落盘空间切到',
  { answer: swap('storeNs = DataCore.receiverNamespaceFor(e0);', 'void 0;'), review: null, wrong: null });

/* ---- 12. 自己的卷不切回全局空间（会被写进上一份分享文件的空间） ---- */
/* ⚠ 这一条原本改的是答题页 `load(file)` 里那处赋值。拖入功能整合进导入页之后，
 *   锚**跟着功能搬家**（见 wiring.test.js 的注释）：
 *     · 答题页这边改成"每一处 NS_GLOBAL 都必须与 received=false 成对"→ 这里挨个破坏；
 *     · "拖进来的卷写全局空间"改锚在校对页的 store 命名空间上。 */
const killAllGlobals = function (src) {
  const s = String(src);
  if (s.indexOf('storeNs = DataCore.NS_GLOBAL;') < 0) throw new Error('没找到 storeNs = DataCore.NS_GLOBAL;');
  return s.split('storeNs = DataCore.NS_GLOBAL;').join('void 0;');
};
probe('⑫ 答题页每一处"切回全局空间"都拆掉 → 「成对出现」那组断言变红', '成对出现',
  { answer: killAllGlobals, review: null, wrong: null });
probe('⑫-b 校对页的 store 不再写全局空间 → 「自己拖进来的卷写全局空间」锚变红', '自己拖进来的卷写全局空间',
  { answer: null, review: swap('namespace: DataCore.NS_GLOBAL', 'namespace: "someone-else"'), wrong: null });

/* ---- 13. 不做存储体检（存储不可用时页面一声不吭，用户以为存上了） ----
 * ⚠ 形状变了（取 localStorage 自己也要包 try）：改成拆掉那句 try —— 静态锚要求它是 try 包出来的，
 *   拆掉就变红；语义上"没有兜住的体检"也正是原来要盯的那个坏形状。 */
probe('⑬ 不做存储体检 → 「存储体检」那组断言变红', '存储体检',
  { answer: swap('try { backend = window.localStorage; } catch (e) { backend = null; }', 'backend = null;'),
    review: null, wrong: null });

/* ---- 13-b. 载荷坏了不说（收件人只看到空题库 → "打开了但没试卷"，出题者拿不到线索） ---- */
probe('⑬-b 载荷损坏分支被摘掉 → 「载荷读不出来」那组断言变红', '载荷读不出来',
  { answer: swap('} else if (PAYLOAD_BAD) {', '} else if (false) {'), review: null, wrong: null });

/* ---- 13-c. 不等解析完就读载荷（回到那个"收件人只看到空题库"的老毛病） ---- */
probe('⑬-c 解析前就读载荷 → 「等 DOM 解析完」那组断言变红', '等 DOM 解析完',
  { answer: swap("if (real && real.readyState === 'loading')", 'if (false)'), review: null, wrong: null });

/* ---- 14. 错题本不再捞"从没入册的卷"（答过的卷记录在盘上，界面装作没有） ---- */
probe('⑭ 不捞孤儿误答本 → 「从没入册的卷」那组断言变红', '从没入册',
  { answer: null, review: null,
    wrong: swap('const orphan = await WrongCore.orphanIds(store, ids.concat(deadIds));', 'const orphan = [];') });

/* ---- 15. 抽题不再吃「未作答优先」的档位表（选了未作答优先，抽出来还是完全随机） ---- */
probe('⑮ 「未作答优先」的档位不再传给抽题核心 → 「未作答优先」那组断言变红', '未作答优先',
  { answer: swap('QuizCore.pickQuestions(questions, c, tiers ? { priority: tiers } : null)', 'QuizCore.pickQuestions(questions, c)'),
    review: null, wrong: null });

/* ---- 16. 「换一批」不再刷新档位（刚答错的题这一轮不算欠账 → 优先规则时灵时不灵） ---- */
probe('⑯ 换一批不刷新档位表 → 「未作答优先」那组断言变红', '未作答优先',
  { answer: swap('await loadWrongTiers(roundCtx.examId);', 'void 0;'), review: null, wrong: null });

/* ---- 17. 档位退化成"要么优先要么随机"的假实现（不看错题本，全按中间档） ---- */
probe('⑰ 档位不从错题本读（读不出来一律中间档）→ 「未作答优先」那组断言变红', '未作答优先',
  { answer: swap('const got = await WrongCore.loadBook(makeStore(), examId);', 'const got = null;'),
    review: null, wrong: null });

/* ---- 18. 底部面板又长出标题（「快捷设置」那四个字会把「返回题库」压回去）→ 锚变红 ---- */
probe('⑱ 底部面板又传回标题 → 「明确传了空标题」锚变红', '明确传了空标题',
  { answer: swap("        title: '',", "        title: '快捷设置',"), review: null, wrong: null });

/* ---- 19. 折叠按钮又写回「展开」（用户要求改成「展开设置」）→ 锚变红 ---- */
probe('⑲ 折叠按钮写回「展开 / 收起」→ 「写着展开设置 / 收起设置」锚变红', '写着「展开设置 / 收起设置」',
  { answer: swap("return collapsed ? '展开设置' : '收起设置';", "return collapsed ? '展开' : '收起';"), review: null, wrong: null });

/* ---- 20. 「返回题库」不再问一句（一点就回首页）→ 「先走 askGoHome」锚变红 ---- */
probe('⑳ 返回题库不再二级确认 → 「先走 askGoHome」锚变红', '先走 askGoHome',
  { answer: swap("homeBtn.addEventListener('click', function () { askGoHome(); });",
                 "homeBtn.addEventListener('click', function () { goHome(); });"), review: null, wrong: null });

/* ---- 21. 「重新生成试卷」没被搬进底部栏（用户要求放到返回题库旁边）→ 锚变红 ---- */
probe('㉑ 重新生成试卷没搬进底部栏 → 「moveAnswerActions 两颗一起搬」锚变红', 'moveAnswerActions 把两颗',
  { answer: null, review: null, wrong: null,
    app: swap('    slot.appendChild(home);\n    if (redraw) slot.appendChild(redraw);',
              '    slot.appendChild(home);') });

/* ---- 22. 视图的动作条里又画了一颗「再抽一次」（两个地方各一颗）→ 锚变红 ---- */
probe('㉒ 动作条里又画「再抽一次」→ 「视图里不再画」锚变红', '动作条里不再画',
  { answer: swap("        } else if (o.onRestart) {",
                 "          actionsBox.appendChild(mk('redraw', '再抽一次', '', function () {}));\n        } else if (o.onRestart) {"),
    review: null, wrong: null });

/* ---- 23. 「生成解析」面板又摆回一套填 Key 的表单（重复入口回来了）→ 锚变红 ---- */
probe('㉓ 生成解析面板又塞回 keyEntry 表单 → 「只留状态行 + 指路」锚变红', '只要状态行',
  { answer: null, review: null, wrong: null,
    app: function (src) {
      const s = String(src);
      const needle = "    keyHint: '填 / 换 Key 用本页顶部那颗「AI 密钥与供应商」（只存本机，不上传）',";
      if (s.indexOf(needle) < 0) throw new Error('没找到导入页那条 keyHint');
      return s.split(needle).join('    /* 又摆回表单：不加 keyHint */');
    } });

/* ---- 24. 错题本又变成"就地填 Key"（作用域化 document 判错 → 静默退化）→ 锚变红 ---- */
probe('㉔ 错题本又就地填 Key（判据换成作用域化 document）→ 「用真窗口文档判断」锚变红', '真窗口文档',
  { answer: swap("window.document.getElementById('tab-review')", "document.getElementById('tab-review')"),
    wrong: swap("window.document.getElementById('tab-review')", "document.getElementById('tab-review')"),
    review: null, app: null });

/* ---- 25. 顶栏少了「须知」按钮（声明与说明又没处看）→ 锚变红 ---- */
probe('㉕ 拆掉「须知」按钮 → 「顶栏有须知按钮」锚变红', '顶栏那一排有「须知」按钮',
  { answer: null, review: null, wrong: null,
    app: swap('      <button class="tab tab-act" type="button" id="tab-help">须知</button>\n', '') });

/* ---- 26. 须知里少了一条声明（旧的零散声明被删、新的又没收全）→ 锚变红 ---- */
probe('㉖ 须知里少一条声明 → 「九条声明/警告逐条都在」锚变红', '九条声明/警告逐条都在',
  { answer: null, review: null, wrong: null,
    app: swap('<li><b>分享文件只带试卷</b>', '<li><b>（这条被删了）</b>') });

/* ---- 27. 旧声明又留在页脚（须知之外再写一份）→ 锚变红 ---- */
probe('㉗ 页脚又留着旧声明 → 「页脚那句旧声明已经搬走」锚变红', '页脚那句旧声明',
  { answer: null, review: null, wrong: null,
    app: swap('<span id="footMore">', '数据只存你本机（localStorage）；只有 AI 功能需要联网。<span id="footMore">') });

/* ---- 28. 页脚又写回制作人信息（用户要求只在须知里写）→ 锚变红 ---- */
probe('㉘ 页脚又写回制作人信息 → 「页脚不再写制作人信息」锚变红', '页脚不再写制作人信息',
  { answer: null, review: null, wrong: null,
    app: swap('<span id="footMore">使用说明、全部声明与作者信息都在顶部「须知」里。</span>',
              '<span id="footMore">由北京理工大学 2625 李佳祎制作</span>') });

/* ---- 29. 项目仓库地址没跟着换成新仓库 → 锚变红 ---- */
probe('㉙ 仓库地址还是旧的 → 「旧仓库名一处都不剩」锚变红', '旧仓库名',
  { answer: null, review: null, wrong: null,
    app: swap('https://github.com/kokuraasahidesu/review_quiz', 'https://github.com/kokuraasahidesu/easy_quiz_board') });

/* ---- 30. 翻页等待又回一句「N 毫秒后翻」的绿字 → 锚变红 ---- */
probe('㉚ 翻页等待又回绿字 → 「不再回一句毫秒后翻」锚变红', '毫秒后翻',
  { answer: swap("      if (id === 'autoNextMs') return '';",
                 "      if (id === 'autoNextMs') return '自动翻页等待：' + (res.value === 0 ? '点完立刻翻' : res.value + ' 毫秒后翻');"),
    review: null, wrong: null, app: null });

const bad = results.filter(r => r[1] !== true);
console.log('\n探针汇总：' + results.length + ' 条  全部能让锚变红=' + (bad.length === 0));
if (bad.length) { bad.forEach(b => console.log('  未变红：' + b[0] + ' → ' + b[1])); process.exitCode = 1; }
