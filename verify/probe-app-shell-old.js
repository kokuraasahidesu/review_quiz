/* 「答题全能版」（合并单文件）· 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-app-shell-old.js
 *
 * 盯的是合并最容易翻车的三处：页签/面板被拆、id 撞车、切页签不刷新。
 * 判据 = `verify/app-shell.test.js` 里的原话（这里是重跑同一个文件，不是另写一套）。
 */
const fs = require('fs');
const path = require('path');
const HERE = path.join(__dirname, '..');
const SRC = path.join(HERE, 'review_quiz.html');
const BAK = path.join(HERE, 'verify', '__appbak.html');

const results = [];
function probe(name, keyword, mutate) {
  let red = false, note = '';
  try {
    const src = fs.readFileSync(SRC, 'utf8');
    const out = mutate(src);
    if (out === src) throw new Error('探针失效：没替换到目标文本');
    fs.writeFileSync(BAK, out, 'utf8');
    /* 让测试读被改坏的那份：临时把它换到成品位置再换回来 */
    fs.writeFileSync(SRC, out, 'utf8');
    let text = '';
    try {
      const { execFileSync } = require('child_process');
      text = execFileSync(process.execPath, [path.join(HERE, 'verify', 'app-shell.test.js')], { encoding: 'utf8' });
    } catch (e) {
      text = String((e && e.stdout) || '') + String((e && e.stderr) || '');
    } finally {
      fs.writeFileSync(SRC, src, 'utf8');
      try { fs.unlinkSync(BAK); } catch (e2) { /* ignore */ }
    }
    const base = /PASS (\d+)\s+FAIL (\d+)/.exec(text);
    red = !!(base && parseInt(base[2], 10) > 0);
    note = base ? ('改坏后 PASS=' + base[1] + ' FAIL=' + base[2]) : '（没读到汇总）';
  } catch (e) { red = '抛错:' + (e && e.message); }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red + (note ? '   ' + note : ''));
}
function swap(needle, repl) {
  return function (src) {
    if (src.indexOf(needle) < 0) throw new Error('没找到待替换片段：' + needle);
    return src.replace(needle, repl);
  };
}

/* 基线必须先全绿，否则下面的"变红"没有意义 */
(function () {
  const { execFileSync } = require('child_process');
  const t = execFileSync(process.execPath, [path.join(HERE, 'verify', 'app-shell.test.js')], { encoding: 'utf8' });
  const m = /PASS (\d+)\s+FAIL (\d+)/.exec(t);
  console.log('  （基线：' + (m ? 'PASS=' + m[1] + ' FAIL=' + m[2] : '没读到汇总') + '）');
})();

/* ---- 1. 页签/面板被拆掉一个（"一个文件"就不成立了） ---- */
probe('① 少一个面板 → 「恰好三个面板」锚变红', '面板',
  swap('<section class="pane" id="pane-wrong" role="tabpanel" hidden>', '<section id="pane-wrong" hidden>'));

/* ---- 2. 面板宿主 id 撞车（getElementById 会抓错面板） ---- */
probe('② 面板 id 撞车 → 「没有重复 id」锚变红', '重复 id',
  swap('id="ansHost"', 'id="revStage"'));

/* ---- 3. 切到错题本不重新读盘（刚交卷收进来的错题看不见） ---- */
probe('③ 切页签不刷新错题本 → 「切到错题本会重新读盘」锚变红', '重新读盘',
  swap("if (key === 'wrong' && typeof window.__wrongRefresh === 'function') window.__wrongRefresh();", 'void 0;'));

/* ---- 4. 三段逻辑改成"只搬一段"（合并版变成半个应用） ---- */
probe('④ 少装配一段页面逻辑 → 「来源标记」锚变红', '来源',
  function (src) {
    const i = src.indexOf('/* ==== 以下这段来自 review-template.html');
    const j = src.indexOf('/* ==== review-template.html 页面逻辑结束 ==== */');
    if (i < 0 || j < 0) throw new Error('没找到校对那段的装配标记');
    return src.slice(0, i) + src.slice(j + '/* ==== review-template.html 页面逻辑结束 ==== */'.length);
  });

/* ---- 5. 设置页少画一组（分数线没搬过去 → 用户在设置页改不了分数线） ---- */
probe('⑤ 设置页只画「抽题与题量」（分数线/判分没搬过去）→ 「三组都画」锚变红', '三组都画',
  swap("groups: ['抽题与题量', '分数线', '判分'],", "groups: ['抽题与题量'],"));

/* ---- 6. 底部快捷面板没排除那三组（答题界面又能改抽题设置了，还改不动正在答的题） ---- */
probe('⑥ 底部面板不排除抽题/分数线/判分 → 「excludeGroups」锚变红', '排除',
  swap("excludeGroups: ['抽题与题量', '分数线', '判分'],", ''));

/* ---- 7. 面板不支持 excludeGroups（参数传了也没人认 = 等于没排除） ---- */
probe('⑦ 面板不实现 excludeGroups 过滤 → 「真的实现了」锚变红', '真的实现',
  swap('if (o.excludeGroups && o.excludeGroups.length) {', 'if (false) {'));

/* ---- 8. 题库按钮改回旧名（「开始作答 / 答整卷 / 抽一轮」又各占一个按钮） ---- */
probe('⑧ 按钮名改回「抽一轮」→ 「叫开始作答」锚变红', '开始作答',
  swap("'开始作答'", "'抽一轮'"));

/* ---- 9. 启动成功不插旗（手机端白屏就再也没有兜底：自检会把正常启动也当失败/或什么都不报） ---- */
probe('⑨ 启动不插旗 __quizBooted → 「插旗在切面板之后」锚变红', '插旗',
  swap('window.__quizBooted = true;', '/* 忘了插旗 */'));

/* ---- 10. 载荷坏了那一支被摘掉（收件人只会看到空题库 → "打开了但没试卷"） ---- */
probe('⑩ 载荷损坏分支被摘掉 → 「当面报原因」锚变红', '当面报原因',
  swap('} else if (PAYLOAD_BAD) {', '} else if (false) {'));

/* ---- 11. 壳不等解析完就读载荷（同一个坑：读到的 outerHTML 里还没有载荷块） ---- */
probe('⑪ 壳解析前就读载荷 → 「也等 DOM 解析完」锚变红', '也等 DOM',
  swap("if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootShell);", 'bootShell();'));

const bad = results.filter(r => r[1] !== true);
console.log('\n探针汇总：' + results.length + ' 条  全部能让锚变红=' + (bad.length === 0));
if (bad.length) { bad.forEach(b => console.log('  未变红：' + b[0] + ' → ' + b[1])); process.exitCode = 1; }
