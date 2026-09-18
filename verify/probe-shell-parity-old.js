/* 「合并壳 vs 独立页」标记对照 · 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-shell-parity-old.js
 *
 * 拿 `verify/shell-parity.test.js` 导出的**同一套判据**（audit）跑被人为改坏的源码。
 * 第①条就是用户报障的原样复现："AI 密钥与供应商"在壳里退化成空 div（点不动、也没字）。
 */
const { audit, FILES } = require('./shell-parity.test.js');

const results = [];
function probe(name, keyword, mutate) {
  let red = false, note = '';
  try {
    const pick = lists => lists.filter(c => c[1].indexOf(keyword) >= 0);
    const base = pick(audit(FILES));
    if (!base.length) throw new Error('基线里没有含「' + keyword + '」的断言（关键词写错了）');
    const F2 = Object.assign({}, FILES);
    Object.keys(mutate).forEach(function (k) { F2[k] = mutate[k](FILES[k]); });
    const after = pick(audit(F2));
    const before = base.filter(c => c[0]).length, now = after.filter(c => c[0]).length;
    red = now < before;
    note = '基线通过 ' + before + '/' + base.length + ' → 改坏后 ' + now + '/' + after.length;
  } catch (e) { red = '抛错:' + (e && e.message); }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red + (note ? '   ' + note : ''));
}
function swap(needle, repl) {
  return function (src) {
    if (String(src).indexOf(needle) < 0) throw new Error('没找到待替换片段：' + needle);
    return String(src).replace(needle, repl);
  };
}

/* ---- ① 用户报障原样复现：AI 密钥入口在壳里退化成空 div ---- */
probe('① AI 密钥入口退化成空 div（用户报的那个 bug）→「标签种类一致」锚变红', '标签种类一致',
  { app: swap('<button class="big" type="button" id="revAikey">AI 密钥与供应商</button>',
              '<div id="revAikey"></div>') });

/* ---- ② idMap 目标 id 在壳里根本不存在（逻辑找不到元素） ---- */
probe('② 壳里少摆一个宿主（idMap 指过去是空的）→「id 在壳标记里都存在」锚变红', '壳标记里**都存在**',
  { app: swap('<div id="revStage"></div>', '') });

/* ---- ③ 整个面板的 idMap 被删空（等于这个面板没接线） ---- */
probe('③ RUN_PANE 的 idMap 被删空 →「每个 idMap 都登记了元素」锚变红', '每个 idMap 都登记了元素',
  { app: function (src) {
      const s = String(src);
      const at = s.indexOf("RUN_PANE('wrong'");
      if (at < 0) throw new Error('没找到 wrong 的 RUN_PANE');
      return s.slice(0, at) + "RUN_PANE('wrong', {}, function (document) {" + s.slice(s.indexOf('}, function (document) {', at) + '}, function (document) {'.length);
    } });

/* ---- ④ 少接一个面板（三缺一）：RUN_PANE 数量对不上 ---- */
probe('④ 三个面板少接一个 →「正好找到三个面板的 RUN_PANE」锚变红', '正好找到三个面板',
  { app: function (src) {
      const s = String(src);
      const at = s.indexOf("RUN_PANE('wrong'");
      if (at < 0) throw new Error('没找到 wrong 的 RUN_PANE');
      const end = s.indexOf('});', at);
      return s.slice(0, at) + s.slice(end + 3);
    } });

console.log('\n探针汇总：' + results.length + ' 条  ' +
  (results.every(r => r[1] === true) ? '全部能让锚变红=true' : '有探针没能让锚变红'));
const bad = results.filter(r => r[1] !== true);
if (bad.length) {
  bad.forEach(r => console.log('  未变红：' + r[0] + ' → ' + r[1]));
  process.exit(1);
}
