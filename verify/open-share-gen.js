/* ============================================================
 *  verify/open-share-gen.js —— 「收件人打开分享文件」取件：生成四份待打开的文件
 *
 *  运行：node verify/open-share-gen.js   然后：node verify/open-share-parse.js
 *
 *  为什么单独一条：用户实测报障「导出时带的试卷在**其他浏览器**打开看不了」。
 *  这个缺陷最阴的地方是**出题者本机看不出来**（他的浏览器里题库本来就有那套卷），
 *  而收件人那边只有一片空题库 —— 光看"导出文件里有没有那段代码"（静态锚）**永远抓不到**。
 *  所以这里用真浏览器**打开成品**，只看"收件人到底看到了什么"。
 *
 *  生成的四份（都在 verify/ 下，gitignored：verify/__*）：
 *    __open-share.html          正常导出的一份                      → 期望：那套卷自己出来，能作答
 *    __open-share-nostore.html  同一份 + localStorage 被禁（抛）     → 期望：照样出题（记录降级但不空白）
 *    __open-share-bad.html      同一份 + 载荷 JSON 被改坏            → 期望：红字说明"读不出来 + 让出题者重发"
 *    __open-share-broken.html   同一份 + 脚本解析期就炸              → 期望：顶部红条"没能在当前浏览器里启动"
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const HERE = path.join(__dirname, '..');
const D = require('../core/data.js');
const S = require('../core/schema.js');

const shell = fs.readFileSync(path.join(HERE, 'review_quiz.html'), 'utf8');
const questions = [];
for (let i = 1; i <= 3; i++) {
  questions.push(S.createQuestion({
    id: 'OS' + i, type: '单选', stem: '取件题干 ' + i + '：下面哪个是对的？',
    options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }],
    answerLetters: ['B'], answer: 'B', explanation: '解析 ' + i
  }));
}
const exam = S.createExam({ id: 'OS-EXAM', title: '取件验证卷', questions: questions }, { now: '2026-11-20T00:00:00.000Z' });
const r = D.exportStandalone({ exams: [exam] }, shell, { examIds: ['OS-EXAM'], at: '2026-11-20T00:00:00.000Z', secrets: [] });
if (!r.ok) { console.error('导出失败：' + r.message); process.exit(1); }

const good = r.html;
const out = function (name, html) {
  const p = path.join(HERE, 'verify', name);
  fs.writeFileSync(p, html, 'utf8');
  return p;
};

/* 载荷块在原文里的位置：改坏/截断都对着它下手 */
const at = good.indexOf('id="exam-payload"');
const open = good.indexOf('>', at) + 1;
const close = good.indexOf('</script>', open);
if (at < 0 || close < 0) { console.error('导出文件里没定位到载荷块'); process.exit(1); }
const mid = Math.floor((open + close) / 2);

const noStore = '<script>try{Object.defineProperty(window,"localStorage",{configurable:true,'
  + 'get:function(){throw new Error("SecurityError: storage blocked");}});}catch(e){}</script>';
out('__open-share.html', good);
out('__open-share-nostore.html', good.replace('<head>', '<head>' + noStore));
out('__open-share-bad.html', good.slice(0, open) + good.slice(open, mid) + good.slice(close));
out('__open-share-broken.html', good.replace('function showTab(key) {', 'function showTab(key) { )'));

console.log('  单文件字节           =', Buffer.byteLength(good, 'utf8'));
console.log('  载荷块 / 读到卷数    =', D.payloadBlockCount(good).blocks, '/', (D.extractPayload(good) || { exams: [] }).exams.length);
console.log('  写出四份待打开文件：');
['__open-share.html', '__open-share-nostore.html', '__open-share-bad.html', '__open-share-broken.html']
  .forEach(function (n) { console.log('    verify/' + n + '   ' + (fs.statSync(path.join(HERE, 'verify', n)).size / 1024).toFixed(1) + ' KB'); });
console.log('  下一步：node verify/open-share-parse.js');
