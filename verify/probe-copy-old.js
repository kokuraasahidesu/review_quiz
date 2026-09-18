/* 「界面文案」静态闸门 · 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-copy-old.js
 *
 * 做法与其它探针一致：拿 `verify/copy.test.js` 导出的**同一套判据**（audit），
 * 跑被人为改坏的源码，每一处"把文案改回原来的毛病"都必须让对应那条断言变红。
 */
const { audit, FILES } = require('./copy.test.js');

const results = [];
function probe(name, keyword, mutate) {
  let red = false, note = '';
  try {
    const pick = lists => lists.filter(c => c[1].indexOf(keyword) >= 0);
    const base = pick(audit(FILES));
    if (!base.length) throw new Error('基线里没有含「' + keyword + '」的断言（关键词写错了）');
    /* 深拷贝一份可改的文件表（两层：js / html） */
    const F2 = { js: Object.assign({}, FILES.js), html: Object.assign({}, FILES.html) };
    Object.keys(mutate).forEach(function (k) {
      const parts = k.split('::');
      F2[parts[0]][parts[1]] = mutate[k](FILES[parts[0]][parts[1]]);
    });
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

/* ---- ① 文案里又漏进 markdown 记号（用户看到两个星号） ---- */
probe('① 错题本徽章又写成 `**错题**` → 「界面文案里没有漏出来的 markdown 记号」锚变红',
  '界面文案里没有漏出来的 markdown 记号',
  { 'js::ui/wrong-view.js': swap("' 条错题'", "' 条**错题**'") });

/* ---- ② HTML 文本（页脚那类）又漏进 markdown 记号 ---- */
probe('② 「须知」里的数据声明又写成 `**数据只存你本机**` → 同一条锚变红（HTML 文本这一路也要守得住）',
  '界面文案里没有漏出来的 markdown 记号',
  { 'html::app-template.html': swap('数据只存你本机</b>',
                                    '**数据只存你本机**</b>') });

/* ---- ③ 界面文案又用回数据层旧名「误答本」---- */
probe('③ 报错文案又写「没有误答本数据」→ 「没有数据层旧名」锚变红',
  '数据层旧名',
  { 'js::core/wrong.js': swap("message: '这本错题本里还没有数据'", "message: '没有误答本数据'") });

/* ---- ④ 「未校对」这种半截说法又冒出来 ---- */
probe('④ 面板又写「只看未校对」→ 「没有『未校对』这种半截说法」锚变红',
  '半截说法',
  { 'js::ui/review-panel.js': swap('只看待校对</label>', '只看未校对</label>') });

/* ---- ⑤ 第一层引号又用『』（产品里该用「」） ---- */
probe('⑤ 按钮文案又用『只删试卷』→ 「第一层引号统一用「」」锚变红',
  '第一层引号统一用「」',
  { 'js::core/exams.js': swap("label: '只删试卷，保留记录'", "label: '『只删试卷』保留记录'") });

/* ---- ⑥ 扫描器在**某个文件**上失灵（一条字符串都捞不到）也必须是红的 ---- */
probe('⑥ 某个文件被扫描器漏掉（一条字符串都捞不到）→ 「逐文件都读到了字符串」锚变红',
  '逐文件都读到了字符串',
  { 'js::ui/wrong-view.js': function () { return ''; } });

console.log('\n探针汇总：' + results.length + ' 条  ' +
  (results.every(r => r[1] === true) ? '全部能让锚变红=true' : '有探针没能让锚变红'));
const bad = results.filter(r => r[1] !== true);
if (bad.length) {
  bad.forEach(r => console.log('  未变红：' + r[0] + ' → ' + r[1]));
  process.exit(1);
}
