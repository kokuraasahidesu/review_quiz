/* ============================================================
 *  verify/grade.test.js —— 「四型计分执行」小类验收
 *
 *  运行： node verify/grade.test.js
 *
 *  三条盘档验收标准，逐条对应：
 *    ① 计分回归全绿：单选/判断对错、多选全对与两种半对模式与错选即零、
 *       简答命中比例与区间模式、无关键词不给分、歧义判断题不给分
 *    ② 每题返回的命中/未命中/错选明细与实际作答一致（对着固定样本逐项比对）
 *    ③ 所有得分都是 0.5 的整数倍，不出现循环小数级别的脏分数
 *
 *  三条反空转设计：
 *    · ①"给分"必须与"不给分"成对出现（每个分支都要有 0 分对照），
 *      否则一个"永远满分"的实现能通过全部正向断言。
 *    · ② 明细用**整个对象的深比较**（多一个键少一个键都算错），
 *      并对同一份作答做**顺序无关**验证（'BA' 与 'AB' 的明细必须一致）。
 *    · ③ 粒度用**遍历扫描**（题型 × 作答语料 × 配置组合）逐个数乘 2 是否为整数，
 *      而不是抽查两个数 —— 抽查抓不到 0.25 这种漏网。
 * ============================================================ */
const Q = require('../core/quiz.js');
const S = require('../core/schema.js');
const Seg = require('../core/parse/segment.js');
const P = require('../parser-core.js');

let pass = 0, fail = 0; const failures = [];
function brief(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return String(s);
  return s.length > 180 ? s.slice(0, 180) + '…(' + s.length + ' 字符)' : s;
}
function ok(c, t, d) { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + brief(d) : '')))
                         : (fail++, failures.push(t), console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + brief(d) : ''))); }
function eq(a, e, t) { const A = JSON.stringify(a), B = JSON.stringify(e); ok(A === B, t + '   期望=' + brief(B), A); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }

/* 生效配置：内置默认 + 指定覆盖（= 三层取值后的结果） */
function cfg(patch) { return Q.mergeConfig(Q.DEFAULT_CONFIG, patch || {}); }
const C = cfg();          // 单选2 多选3 判断1 简答5 / halfRatio .5 hitRatio / wrongChoiceZero true

/* 固定样本题目 */
const qSingle = { id: 's1', type: '单选', stem: '1+1=?', options: [{ label: 'A', text: '2' }, { label: 'B', text: '3' }], answerLetters: ['A'] };
const qJudgeT = { id: 'j1', type: '判断', stem: '地球是圆的', judgeValue: true };
const qJudgeF = { id: 'j2', type: '判断', stem: '太阳从西边升起', judgeValue: false };
const qJudgeX = { id: 'j3', type: '判断', stem: '答案本身认不出来', judgeValue: null };
const qMulti = { id: 'm1', type: '多选', stem: '选两个', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }, { label: 'C', text: 'c' }], answerLetters: ['A', 'B'] };
const qShort = { id: 'k1', type: '简答', stem: '答三点', keywords: [{ text: '甲' }, { text: '乙' }, { text: '丙' }] };
const qShortNone = { id: 'k2', type: '简答', stem: '没关键词', keywords: [] };

const sc = (q, a, c) => Q.scoreOne(q, a, c || C);

/* ============================================================ */
head('①-1 单选：按答案匹配（对/错/空/大小写/杂字符都成对验）');

eq([sc(qSingle, 'A').score, sc(qSingle, 'A').correct], [2, true], '单选：答对 → 2 分、correct=true');
eq([sc(qSingle, 'B').score, sc(qSingle, 'B').correct], [0, false], '单选：答错 → 0 分、correct=false');
eq(sc(qSingle, '').score, 0, '单选：不作答 → 0 分');
eq(sc(qSingle, undefined).score, 0, '单选：undefined → 0 分（不崩）');
eq(sc(qSingle, 'a').score, 2, '单选：小写 a 也认（大小写不敏感）');
eq(sc(qSingle, 'A。').score, 2, '单选：尾巴带标点仍认（只取前一个字母）');
eq(sc(qSingle, ' C').score, 0, '单选：答 C（不在选项里）→ 0 分');
eq(sc(qSingle, 'Ａ').score, 2, '单选：**全角 Ａ**（中文输入法常见）→ 2 分（早先当成没作答）');
eq(sc(qSingle, 'ａ').score, 2, '单选：全角小写 ａ → 2 分');
eq(sc(qMulti, 'ＡＢ').score, 3, '多选：全角 ＡＢ → 全对 3 分');
eq(sc(qMulti, ['A', 'B']).score, 3, '多选：作答传**数组** ["A","B"]（界面很可能这么给）→ 全对 3 分');
eq(sc(qMulti, new Set(['A', 'B'])).score, 3, '多选：作答传 **Set**（与答案键侧对称）→ 全对 3 分');
eq(sc(qSingle, ['A']).score, 2, '单选：作答传数组 ["A"] → 2 分');
// 红队三轮 P4：答案键是 Set 形态时也必须走同一把尺子（全角归一 + 只抽 A–H）
eq(sc({ id: 'ms', type: '多选', answerLetters: new Set(['ａ', 'ｂ']) }, 'AB').detail.want, ['A', 'B'],
   '答案键传 Set(["ａ","ｂ"]) → 归一大写（早先 Set 分支自己写了一遍，漏了全角）');
eq(sc({ id: 'ms2', type: '多选', answerLetters: new Set(['A', 'Z']) }, 'A').detail.want, ['A'],
   '  越过 A–H 的字母（Z）被过滤掉，与数组形态一致');
eq(sc(qMulti, {}).score, 0, '多选：作答传**对象** → 0 分（早先 String({}) 会挖出 B/C/E 字母，放水配置下还得分）');
eq(sc(qMulti, {}).detail.got, [], '  明细里 got=[]（不是 ["B","C","E"]）');
eq(sc(qSingle, 'A', cfg({ points: { '单选': 2.5 } })).score, 2.5, '单选：分值改成 2.5 → 得 2.5 分（半步粒度合法）');

head('①-2 判断：按答案匹配（含手写变体与"答案本身歧义就不给分"）');

eq([sc(qJudgeT, '√').score, sc(qJudgeT, '√').correct], [1, true], '判断（键=对）：答「√」→ 1 分');
eq(sc(qJudgeT, '×').score, 0, '判断（键=对）：答「×」→ 0 分');
eq(sc(qJudgeF, '错').score, 1, '判断（键=错）：答「错」→ 1 分');
eq(sc(qJudgeF, '对').score, 0, '判断（键=错）：答「对」→ 0 分');
// 否定式：用户写「不正确」意思是错 —— 必须与答案键用同一套归一（早先这里会认不出来 → 冤判 0 分）
eq(sc(qJudgeF, '不正确').score, 1, '判断（键=错）：答「不正确」→ **1 分**（否定式归一，不许冤判）');
eq(sc(qJudgeT, '不错误').score, 1, '判断（键=对）：答「不错误」→ 1 分（双重否定归一到"对"）');
eq(sc(qJudgeT, '不对').score, 0, '判断（键=对）：答「不对」→ 0 分（正确判错，没判反）');
eq(sc(qJudgeX, '对').score, 0, '**歧义判断题（答案键认不出来）→ 不管答什么都 0 分**');
eq(sc(qJudgeX, '×').score, 0, '  换一种作答也是 0 分（不是碰巧）');
eq(sc(qJudgeX, '对').correct, false, '  且不计入正确题数');
eq(sc(qJudgeT, '').score, 0, '判断：不作答 → 0 分');
eq(sc(qJudgeT, '待定').score, 0, '判断：作答认不出正误（待定）→ 0 分');
// **句中否定式**（红队抓出来的真缺陷）：否定词不在句首时，早先会掉进子串兜底 → 判成"对"= 判反
eq([sc(qJudgeF, '这题不对').score, sc(qJudgeT, '这题不对').score], [1, 0],
   '判断（键=错）：答「这题不对」→ **1 分**；同一作答在键=对时 → 0 分（否定词在句中也不许判反）');
[['我认为不正确', 1], ['我觉得不对', 1], ['这不对', 1], ['答案不正确', 1], ['显然不对', 1],
 ['这个说法不正确', 1], ['我认为不对', 1], ['有误', 1]].forEach(function (c) {
  eq(sc(qJudgeF, c[0]).score, c[1], '  句中说法的否定式：答「' + c[0] + '」→ 键=错时得 ' + c[1] + ' 分');
});
eq(sc(qJudgeT, '不是错的').score, 1, '双重否定「不是错的」→ 判成"对"，键=对时得 1 分');
eq(sc(qJudgeF, '不是错的').score, 0, '  （键=错时同样 0 分，没有判反）');

head('①-3 多选：全对 / 半对（默认固定给分）/ 另外两种半对模式 / 错选即零 / 不给部分分');

eq([sc(qMulti, 'AB').score, sc(qMulti, 'AB').correct], [3, true], '多选：全对（AB）→ 3 分、correct=true');
eq(sc(qMulti, 'BA').score, 3, '多选：顺序倒过来（BA）→ 仍是 3 分（集合比较，与顺序无关）');
/* ⚠ **默认半对规则 = 半对固定给 2 分**（用户要求："多选规则应该半对给两分"）。
 *   少选（命中了一部分、没全中、也没错选）→ 固定 halfScore 分，**不看命中几个**。 */
eq(sc(qMulti, 'A').score, 2, '多选·默认（半对固定给分）：只中 1/2 → **2 分**（用户要求；不看命中比例）');
eq(sc(qMulti, 'A').detail.mode, 'fixedScore', '  明细里标出用的哪种半对模式');
eq(sc(qMulti, 'A').detail.halfScore, 2, '  并标出这次给了几分（界面能解释这个 2 分怎么来的）');
eq(sc(qMulti, 'A', cfg({ multi: { halfScore: 1 } })).score, 1, '半对分数可配：halfScore=1 → 1 分');
eq(sc(qMulti, 'A', cfg({ multi: { halfScore: 4 }, points: { '多选': 3 } })).score, 3,
   '  ⚠ 封顶不超过满分：多选 3 分时 halfScore 给 4 也只算 3 分（不让配置把分数顶上天）');
eq(sc(qMulti, 'A', cfg({ multi: { halfMode: 'hitRatio' } })).score, 1,
   '多选·按命中比例（老模式，显式选它才生效）：1/2 × 0.5 = 0.25 倍 → 0.75 → 半步 = 1 分');
eq(sc(qMulti, 'A', cfg({ multi: { halfMode: 'fixed' } })).score, 1.5, '多选·固定比例：只中 1/2 → 固定 0.5 倍 = 1.5 分（不看命中多少）');
eq(sc(qMulti, 'AC').score, 0, '多选：错选 C（wrongChoiceZero=true）→ **0 分**');
eq(sc(qMulti, 'ABC').score, 0, '多选：多选一个错项 C → 0 分');
eq(sc(qMulti, 'AC', cfg({ multi: { wrongChoiceZero: false } })).score, 2,
   '多选：关掉"错选即零"→ 还是按半对固定给分（2 分）');
eq(sc(qMulti, 'AC', cfg({ multi: { wrongChoiceZero: false, halfMode: 'hitRatio' } })).score, 1,
   '多选：关掉错选即零 + 按命中比例 → 1/2 × 0.5 → 1 分');
eq(sc(qMulti, 'AC', cfg({ multi: { wrongChoiceZero: false, halfMode: 'fixed' } })).score, 1.5, '多选：关掉错选即零 + 固定比例 → 1.5 分');
eq(sc(qMulti, 'A', cfg({ multi: { halfCredit: false } })).score, 0, '多选：关掉"给部分分"→ 只中一半也给 0 分');
eq(sc(qMulti, 'AB', cfg({ multi: { halfCredit: false } })).score, 3, '  但全对仍然满分（关部分分不影响全对）');
eq(sc(qMulti, '').score, 0, '多选：不作答 → 0 分（不是"半对"）');
eq(sc(qMulti, 'C').score, 0, '多选：只选错项 → 0 分');
eq(sc(qMulti, 'AB', cfg({ points: { '多选': 4 } })).score, 4, '多选：分值改 4 → 全对 4 分');
eq(sc(qMulti, 'A', cfg({ points: { '多选': 4 } })).score, 2, '  半对：满分 4 分时也是 2 分（正好一半）');
// ⚠ 取整方向要说清：roundHalf = **半分向上进位**（0.75 → 1）。半对场景因此系统性偏高半分。
//   下面把两个方向都钉住，免得将来有人"照抄实现"当期望值（红队指出过这点）。
//   这两条走的是**按命中比例**那条老路（默认已经改成固定给分，所以这里显式选模式）。
eq(sc(qMulti, 'A', cfg({ multi: { halfMode: 'hitRatio' } })).score, 1,
   '半步取整（按命中比例）：3×0.25 = 0.75 → **向上进位**成 1 分（不是 0.5）');
eq(sc(qMulti, 'A', cfg({ multi: { halfMode: 'hitRatio' }, points: { '多选': 1 }, multi: { halfMode: 'hitRatio', halfRatio: 0.25 } })).score, 0,
   '半步取整（按命中比例）：1×0.125 = 0.125 → **进位到 0**（0.25 都不到）');
eq(sc(qMulti, 'A', cfg({ multi: { halfScore: 2.5 } })).score, 2.5, '半对固定给分支持半步（2.5 分是合法的半步值）');

head('①-3b 多选：**一个都没命中就不是半对**（红队抓出来的真缺陷）');

const cLoose = cfg({ multi: { halfMode: 'fixed', wrongChoiceZero: false } });
eq(sc(qMulti, 'C', cLoose).score, 0, '固定比例 + 关掉错选即零：全选错项（**0 命中**）→ 0 分（早先照给 1.5）');
eq(sc(qMulti, 'C', cLoose).detail.noHit, true, '  明细标出 "noHit"（界面能解释为什么 0 分）');
eq(sc(qMulti, 'C', cfg({ multi: { halfMode: 'fixed', halfRatio: 1, wrongChoiceZero: false } })).score, 0,
   '  极端配置 halfRatio=1 时全错也不能满分（早先直接 3/3）');
eq(sc(qMulti, 'A', cLoose).score, 1.5, '  对照：有 1 个命中 → 仍按固定比例给 1.5 分（没有把半对一并打死）');
eq(sc(qMulti, 'D', cfg({ multi: { halfMode: 'hitRatio', wrongChoiceZero: false } })).score, 0, '按命中比例 + 关掉错选即零：0 命中也是 0 分');
eq(sc(qMulti, 'H', cLoose).score, 0, '答一个不存在的字母 H（0 命中）→ 0 分');

head('①-4 简答：命中比例模式与分数区间模式');

eq([sc(qShort, '甲 乙 丙').score, sc(qShort, '甲 乙 丙').correct], [5, true], '简答：三点全中 → 5 分、correct=true');
eq(sc(qShort, '甲 乙').score, 3.5, '简答·命中比例：中 2/3 → 5×(2/3)=3.33 → 半步 = 3.5 分');
eq(sc(qShort, '甲').score, 1.5, '简答·命中比例：中 1/3 → 1.67 → 半步 = 1.5 分');
eq(sc(qShort, '完全不沾边').score, 0, '简答：一个都没中 → 0 分');
eq(sc(qShort, '').score, 0, '简答：不作答 → 0 分');
eq(sc(qShort, '完全不沾边', cfg({ short: { scoreMode: 'range', minRatio: 0.2, maxRatio: 0.8 } })).score, 1,
   '简答·区间模式：0/3 命中 → 落在下限 → 5×0.2 = 1 分');
eq(sc(qShort, '甲', cfg({ short: { scoreMode: 'range', minRatio: 0.2, maxRatio: 0.8 } })).score, 2,
   '简答·区间模式：1/3 命中 → 5×(0.2+0.6/3) = 2 分');
eq(sc(qShort, '甲 乙 丙', cfg({ short: { scoreMode: 'range', minRatio: 0.2, maxRatio: 0.8 } })).score, 4,
   '简答·区间模式：全中 → 落在上限 → 5×0.8 = 4 分');
eq(sc(qShort, '甲', cfg({ short: { minRatio: 0, maxRatio: 1 } })).score, 1.5,
   '简答·区间模式：区间 0~1 时与命中比例同值（1.5 分）');
// 同义写法与全等匹配
const qSyn = { id: 'k3', type: '简答', keywords: [{ text: '同步' }, { text: '确认' }] };
const cSyn = cfg({ short: { synonyms: { '同步': ['SYN', '三次握手'] } } });
eq(sc(qSyn, '三次握手 确认', cSyn).score, 5, '简答：同义写法命中（三次握手 = 同步）→ 5 分');
eq(sc(qSyn, 'SYN', cSyn).score, 2.5, '简答：同义写法（SYN）也命中 → 中 1/2 → 2.5 分');
eq(sc(qSyn, '确认', cSyn).score, 2.5, '简答：只中另一条 → 2.5 分');
eq(sc(qSyn, '同步', cSyn).score, 2.5, '简答：原文写法当然命中 → 2.5 分');
const cExact = cfg({ short: { matchMode: 'exact' } });
eq(sc(qSyn, '同步', cExact).score, 2.5, '简答·全等模式：作答完全等于关键词 → 命中');
eq(sc(qSyn, '同步 确认', cExact).score, 0, '简答·全等模式：作答多带内容 → **不算命中**（全等的语义）');
eq(sc(qSyn, '确认', cfg({ short: { ignoreCase: false } })).score, 2.5, '简答：忽略大小写开关不影响中文关键词');

head('①-5 不判分边界：无关键词不给分 / 未知题型不给分');

eq([sc(qShortNone, '甲 乙 丙').score, sc(qShortNone, '甲 乙 丙').correct], [0, false], '**无关键词的简答题 → 0 分**（不猜、不给分）');
eq(sc(qShortNone, '甲').detail.total, 0, '  明细里 total=0（界面据此提示"需人工采分"）');
eq(sc(qShortNone, '甲').detail.unscorable, 'noKeywords', '  并显式标出"不可判分"的原因');
eq(sc({ id: 'x', type: '连线', stem: '第五种题型' }, 'A').score, 0, '未知题型 → 0 分（不崩、不乱给分）');
eq(sc({ id: 'x2', type: '连线', stem: '第五种题型' }, 'A').full, 0, '  满分也是 0（配置里没有这个题型的分值）');
eq(sc({ id: 's9', type: '单选', stem: '答案键为空', answerLetters: [] }, 'A').score, 0, '答案键为空的单选 → 0 分（宁可不给分）');

head('①-6 **答案键为空的多选**不许白送满分（红队抓出来的真缺陷）');

const qMultiEmpty = { id: 'm9', type: '多选', stem: '答案键丢了', answerLetters: [] };
eq([sc(qMultiEmpty, '').score, sc(qMultiEmpty, '').correct], [0, false],
   '多选：答案键为空 + 不作答 → **0 分、不计正确**（早先 setEq(∅,∅)=true → 白送 3 分）');
eq(sc(qMultiEmpty, '').detail.unscorable, 'noAnswerKey', '  并标出不可判分的原因');
eq(sc(qMultiEmpty, 'A').score, 0, '多选：答案键为空 + 乱答 → 0 分');
eq(sc(qMultiEmpty, 'AB').score, 0, '多选：答案键为空 + 答了内容 → 0 分');
eq(Q.scoreExam([qMultiEmpty], { m9: '' }, C).score, 0, '整卷口径也一样：这道题不贡献分数');
eq(Q.scoreExam([qMultiEmpty], { m9: '' }, C).correctCount, 0, '  也不计入正确题数');

head('①-7 部分配置 / 缺作答表 / 大小写答案键：不崩、不乱判（红队抓出来的真缺陷）');

eq(sc(qMulti, 'A', {}).score, 2, '只喂 {} 当配置：多选半对路径**不再 TypeError**，整份按内置默认算 → 2 分（半对固定给分）');
eq(sc(qMulti, 'A', { points: { '多选': 3 } }).score, 2,
   '只喂 {points}：multi 块整体落回内置默认（给部分分、半对固定 2 分）→ 2 分');
eq(sc(qShort, '甲', { points: { '简答': 5 } }).score, 1.5, '只喂 {points}：short 块落回默认 → 中 1/3 = 1.5 分');
eq(sc(qMulti, 'A', { multi: { halfMode: 'fixed', halfRatio: 0.5 } }).score, 1.5,
   '只喂 {multi:{halfMode,halfRatio}}：**halfCredit 缺失按默认 true**（不许被当成 false 静默关掉半对）→ 固定 0.5 → 1.5 分');
eq(sc(qMulti, 'AC', { multi: { wrongChoiceZero: false } }).score, 2,
   '只喂 {multi:{wrongChoiceZero:false}}：halfCredit / halfMode 都落回默认（半对固定给分）→ 2 分');
eq(sc(qShort, '甲', { short: { ignoreCase: false } }).score, 1.5,
   '只喂 {short:{ignoreCase}}：matchMode/scoreMode 落回默认 → 1.5 分');
eq(sc(qShort, '甲', { short: { scoreMode: 'range' } }).score, 1.5,
   '只喂 {short:{scoreMode:range}}：minRatio/maxRatio 落回默认 0~1 → 区间退化成命中比例 = 1.5 分');
eq(Q.scoreExam([qSingle, qJudgeT], undefined, C).score, 0, 'scoreExam 不传作答表 → 全 0 分，不崩');
eq(Q.scoreExam([qSingle], undefined, C).full, 2, '  满分照算（2 分）');
eq(Q.scoreExam(null, null, C).total, 0, 'scoreExam 传 null 题目列表 → total 0，不崩');
const qLower = { id: 'm8', type: '多选', stem: '答案键是小写', answerLetters: ['a', 'b'] };
eq([sc(qLower, 'AB').score, sc(qLower, 'AB').correct], [3, true], '答案键小写 [a,b] + 答 AB → 满分（不再永远匹配不上）');
eq(sc(qLower, 'AB').detail.want, ['A', 'B'], '  明细里的答案键也归一大写');
eq(sc({ id: 'k9', type: '简答', keywords: null }, '甲').score, 0, 'keywords 为 null → 0 分，不崩');

head('①-8 畸形题目对象：不许把整卷判分打断（红队抓出来的真缺陷）');

eq(sc({ id: 's7', type: '单选', answerLetters: 'AB' }, 'A').score, 2, '单选答案键写成字符串 "AB"（手改过导出文件）→ 仍能判，答 A 得 2 分');
eq(sc({ id: 's8', type: '单选', answerLetters: ['AB'] }, 'A').score, 2, '单选答案键写成 ["AB"] → 拆成单字母，答 A 得 2 分');
eq(sc({ id: 'm7', type: '多选', answerLetters: 'AB' }, 'AB').score, 3, '多选答案键写成字符串 "AB" → 全对 3 分（不再崩）');
eq(sc({ id: 'k7', type: '简答', keywords: ['甲', '乙'] }, '甲').score, 2.5, '关键词写成字符串数组 → 按 {text} 一样处理，中 1/2 = 2.5 分');
eq([sc(null, 'A').score, sc(null, 'A').detail.unscorable], [0, 'badQuestion'], '题目对象是 null → 0 分 + 标不可判分（不崩）');
const mixed = Q.scoreExam([{ id: 's1', type: '单选', answerLetters: ['A'] }, null, { id: 's2', type: '判断', judgeValue: true }, { type: '单选', answerLetters: ['B'] }],
                          { s1: 'A', s2: '√' }, C);
eq([mixed.score, mixed.correctCount, mixed.total, mixed.skippedInvalid], [3, 2, 2, 2],
   '整卷混进 null 与无 id 的项 → **其余题照常判**（3 分 / 2 题对 / 跳过 2 项并如实计数）');

/* ============================================================ */
head('②-A 明细：整对象深比较（多一个键少一个键都算错）');

eq(sc(qSingle, 'C').detail, { want: 'A', got: 'C' }, '单选明细 = {want, got}');
eq(sc(qJudgeT, '×').detail, { want: true, got: false, raw: '×', ambiguous: false, wantAmbiguous: false },
   '判断明细 = {want, got, raw, ambiguous, wantAmbiguous}');
eq(sc(qJudgeT, '待定').detail, { want: true, got: null, raw: '待定', ambiguous: true, wantAmbiguous: false },
   '判断明细：认不出来的作答 → ambiguous=true（界面据此提示人工订正）');
eq(sc(qJudgeX, '对').detail, { want: null, got: true, raw: '对', ambiguous: false, wantAmbiguous: true },
   '判断明细：答案键本身歧义 → wantAmbiguous=true');

head('②-B 多选明细：命中/未命中/错选与实际作答逐项一致');

eq(sc(qMulti, 'AB').detail, { want: ['A', 'B'], got: ['A', 'B'], hit: ['A', 'B'], wrong: [], miss: [], wantCount: 2, gotCount: 2 },
   '全对：hit 两项、wrong/miss 都空');
eq(sc(qMulti, 'AC').detail,
   { want: ['A', 'B'], got: ['A', 'C'], hit: ['A'], wrong: ['C'], miss: ['B'], wantCount: 2, gotCount: 2 },
   '错选 C：hit=[A]、wrong=[C]、miss=[B] —— 三个数组都对得上作答');
eq(sc(qMulti, 'BA').detail, sc(qMulti, 'AB').detail, '**顺序无关**：BA 与 AB 的明细完全一致（数组已排序）');
eq(sc(qMulti, 'C A').detail.hit, ['A'], '乱七八糟的输入「C A」也能正确抽出 A/C');
const mPartial = sc(qMulti, 'A');
eq([mPartial.detail.mode, mPartial.detail.halfScore], ['fixedScore', 2], '半对时分明显式标出模式与给了几分（固定给分模式）');
const mPartialRatio = sc(qMulti, 'A', cfg({ multi: { halfMode: 'hitRatio' } }));
eq([mPartialRatio.detail.mode, mPartialRatio.detail.ratio], ['hitRatio', 0.25], '  按命中比例模式同样标出模式与比例（0.25）');

head('②-C 简答明细：命中/未命中与作答逐项一致');

eq(sc(qShort, '甲和乙').detail,
   { hit: ['甲', '乙'], miss: ['丙'], hitCount: 2, total: 3, ratio: 2 / 3, norm: '甲和乙', matchMode: 'contains', scoreMode: 'hitRatio' },
   '命中「甲和乙」→ hit=[甲,乙]、miss=[丙]、ratio=2/3，并带上归一后的作答');
eq(sc(qShort, '甲 乙 丙').detail.miss, [], '全中时 miss 为空');
eq(sc(qShortNone, '随便写').detail.hitCount, 0, '无关键词时 hitCount=0');
// 幻影关键词（空文本条目）：永远不可能命中，留在 total 里会让满分不可达（红队抓出来的真缺陷）
const phantom = sc({ id: 'k8', type: '简答', keywords: [{ text: '甲' }, { text: '' }, { text: '   ' }] }, '甲');
eq([phantom.score, phantom.full, phantom.detail.total, phantom.correct], [5, 5, 1, true],
   '简答：关键词里混进空文本条目 → 先过滤（答全就能拿满分，total 只数真关键词）');
eq(phantom.detail.miss, [], '  明细里也不会出现 "" 这种看不懂的未命中项');
eq(phantom.detail.droppedKeywords, 2, '  被丢掉的条目数如实报出（不静默）');
eq(sc({ id: 'k9b', type: '简答', keywords: [{ text: '' }] }, '甲').detail.unscorable, 'noKeywords',
   '简答：关键词**全是**空的 → 标不可判分、0 分');
eq(sc(qShort, ' 甲 ', cfg({ short: { ignoreCase: true } })).detail.norm, '甲', 'norm 是归一后的作答（去空白），人工订正时看的就是它');

/* ============================================================ */
head('③-A 粒度：每个返回的 score/full 都是 0.5 的整数倍（遍历扫描）');

const halfOK = v => Math.abs(v * 2 - Math.round(v * 2)) < 1e-9;
const corpus = ['', 'A', 'B', 'C', 'D', 'AB', 'AC', 'BA', 'ABC', 'ABCD', ' A ', 'a', '√', '×', '对', '错', '不正确', '没错', '待定', '甲', '甲 乙', '甲 乙 丙', '丙乙甲', '随便写点别的'];
const configs = [];
[true, false].forEach(function (hc) {
  ['hitRatio', 'fixed'].forEach(function (hm) {
    [0, 0.1, 0.25, 0.5, 0.75, 1].forEach(function (hr) {
      [true, false].forEach(function (wz) {
        configs.push(cfg({ multi: { halfCredit: hc, halfMode: hm, halfRatio: hr, wrongChoiceZero: wz } }));
      });
    });
  });
});
[0, 0.2, 0.5].forEach(function (lo) {
  [1, 0.8, 0.5].forEach(function (hi) {
    if (lo > hi) return;
    configs.push(cfg({ short: { scoreMode: 'range', minRatio: lo, maxRatio: hi } }));
    configs.push(cfg({ short: { scoreMode: 'hitRatio', minRatio: lo, maxRatio: hi } }));
  });
});

const qs = [qSingle, qJudgeT, qJudgeF, qJudgeX, qMulti, qShort, qShortNone];
let scanned = 0; const dirty = [];
configs.forEach(function (c) {
  qs.forEach(function (q) {
    corpus.forEach(function (a) {
      const r = Q.scoreOne(q, a, c);
      scanned++;
      if (!halfOK(r.score)) dirty.push({ q: q.type, a: a, score: r.score, cfg: c });
      if (!halfOK(r.full)) dirty.push({ q: q.type, full: r.full });
    });
  });
});
eq(dirty, [], '遍历 ' + configs.length + ' 套配置 × ' + qs.length + ' 道题 × ' + corpus.length + ' 种作答 = **' + scanned + ' 次判分，全部落在 0.5 粒度**');
ok(scanned > 3000, '  扫描量足够（' + scanned + ' 次，不是抽查）');

head('③-B 非法分值（2.25）也不许产出脏分：配置侧拦 + 计分侧兜底');

const vBad = Q.validateConfig(cfg({ points: { '单选': 2.25 } }));
eq([vBad.ok, vBad.errors.map(e => e.code)], [false, ['E_CFG_NOT_HALF_STEP']], '配置侧：分值 2.25 → E_CFG_NOT_HALF_STEP 拦下');
const rBad = Q.scoreOne(qSingle, 'A', cfg({ points: { '单选': 2.25 } }));
eq([rBad.full, rBad.score], [2.5, 2.5], '计分侧兜底：即便硬喂非法配置，返回值也被归到半步（2.5）');
eq(halfOK(rBad.score), true, '  兜底后仍是 0.5 的整数倍');

head('③-C 脏配置：不许把 NaN/Infinity 传出去，且**不许让成绩虚高**（红队两轮抓出来的真缺陷）');

// 手改过的导出文件能带进这种值，而 exam.config 的落库入口不跑 validateConfig → 计分侧必须自己兜住
const dirtyCfg = [
  ['points=字符串 abc', cfg({ points: { '单选': 'abc' } }), '单选', 'A'],
  ['points=Infinity', cfg({ points: { '单选': Infinity } }), '单选', 'A'],
  ['points=NaN', cfg({ points: { '多选': NaN } }), '多选', 'AB'],
  ['points=负数', cfg({ points: { '判断': -5 } }), '判断', '√'],
  ['points=有限但溢出 9e307', cfg({ points: { '单选': 9e307 } }), '单选', 'A'],
  ['points=有限但溢出 1e308', cfg({ points: { '单选': 1e308 } }), '单选', 'A']
];
const dirtyOut = dirtyCfg.map(function (c) {
  const q = c[2] === '多选' ? qMulti : (c[2] === '判断' ? qJudgeT : qSingle);
  const r = Q.scoreOne(q, c[3], c[1]);
  return { name: c[0], score: r.score, full: r.full, finite: isFinite(r.score) && isFinite(r.full) };
});
eq(dirtyOut.filter(function (x) { return !x.finite; }), [], '六种脏分值全部**不产出 NaN/Infinity**（含"有限但溢出"）');
// ⚠ 兜底落的是**内置默认分值**，不是 0：
//   落 0 会让这道题从整卷分母里消失 —— 实测过"答对 1/2 却显示 100 分/优秀"。
eq(dirtyOut.map(function (x) { return x.full; }), [2, 2, 3, 1, 2, 2], '  脏分值一律落回**内置默认分值**（单选 2 / 多选 3 / 判断 1），不是 0');
const dirtySingle = Q.scoreOne(qSingle, 'A', cfg({ points: { '单选': 'abc' } }));
eq(dirtySingle.cfgWarn, { badPoints: 'abc', pointsUsed: 2 }, '  并在结果里留下可核的标记（界面能提示"该题分值配置异常"）');
eq(sc(qSingle, 'A', cfg({ points: { '单选': 2 } })).cfgWarn, undefined, '  正常配置**没有**这个标记（不是恒有）');
const dirtyMulti = Q.scoreOne(qMulti, 'A', cfg({ multi: { halfMode: 'hitRatio', halfRatio: NaN } }));
eq([dirtyMulti.score, isFinite(dirtyMulti.score)], [1, true], 'halfRatio=NaN → 落回默认 0.5（按命中比例 → 1 分），不是 NaN');
const dirtyShort = Q.scoreOne(qShort, '甲', cfg({ short: { scoreMode: 'range', maxRatio: 'abc' } }));
eq([dirtyShort.score, isFinite(dirtyShort.score)], [1.5, true],
   'maxRatio=abc → 落回默认 1（区间退化成 0~1 → 命中 1/3 → 1.5 分），不是 NaN');
const dirtyExam = Q.scoreExam([qJudgeT, qSingle], { j1: '√', s1: 'B' }, cfg({ points: { '单选': 'abc' } }));
eq([dirtyExam.score, dirtyExam.full, dirtyExam.percent, dirtyExam.level], [1, 3, 33.3, '不及格'],
   '整卷：一条脏配置**不会**让成绩虚高（1/3 = 33.3%，与合法配置完全一致）');
eq(dirtyExam.per[1].cfgWarn, { badPoints: 'abc', pointsUsed: 2 }, '  且逐题明细里带上了标记');
eq([isFinite(dirtyExam.percent), dirtyExam.level !== '优秀'], [true, true], '  百分比有限、等级没有虚高成"优秀"');
// 红队三轮 P5：配置层的尺子与计分层必须一致（不许"配置说合法、计分静默替换"）
eq([cfg({ points: { '单选': 2e6 } }), cfg({ points: { '单选': 9e307 } }), cfg({ points: { '单选': 5e-324 } }),
    cfg({ points: { '单选': 1000.5 } })].map(function (c) { return Q.validateConfig(c).ok; }),
   [false, false, false, false],
   '超上界 / 溢出 / 比 0.5 还小 / 非半步 → **配置层就判非法**（早先全说合法）');
eq([cfg({ points: { '单选': 0 } }), cfg({ points: { '单选': 0.5 } }), cfg({ points: { '单选': 1000 } })]
    .map(function (c) { return Q.validateConfig(c).ok; }), [true, true, true],
   '  合法边界（0 / 0.5 / 1000）一律放行（0 分是合法配置：该题型不参与计分）');
eq(Q.CONFIG_FIELD_MAP['points.单选'].max, 1000, '  字段模型里分值有明确上界（1000）');
eq(Q.validateConfig(cfg({ points: { '单选': 5e-324 } })).errors.map(e => e.code), ['E_CFG_NOT_HALF_STEP'],
   '  比 0.5 小的正值 → E_CFG_NOT_HALF_STEP（早先被 1e-9 容差放过去）');

head('③-D 整卷：每题明细与单题判分一致，总分 = 各题之和');

const examQs = [qSingle, qJudgeT, qJudgeF, qJudgeX, qMulti, qShort, qShortNone];
const answers = { s1: 'A', j1: '√', j2: '不正确', j3: '对', m1: 'AC', k1: '甲 乙' };
const R = Q.scoreExam(examQs, answers, C);
const eachSum = R.per.reduce((s, p) => s + p.score, 0);
const fullSum = R.per.reduce((s, p) => s + p.full, 0);
eq(R.score, Math.round(eachSum * 2) / 2, 'scoreExam.score === Σ per[].score（' + R.score + '）');
eq(R.full, fullSum, 'scoreExam.full === Σ per[].full（' + R.full + '）');
const mismatch = R.per.filter(function (p) {
  const q = examQs.filter(x => x.id === p.id)[0];
  const one = Q.scoreOne(q, answers[p.id], C);
  return JSON.stringify({ s: one.score, f: one.full, c: one.correct, d: one.detail }) !==
         JSON.stringify({ s: p.score, f: p.full, c: p.correct, d: p.detail });
});
eq(mismatch, [], '每题明细与 scoreOne 单独判分**逐字段一致**（两处不会两套算法）');
eq(halfOK(R.score) && halfOK(R.full), true, '整卷总分与满分同样是半步粒度');
eq([R.correctCount, R.total], [3, 7], '正确题数 = 3（单选对、判断 j1 对、j2「不正确」对；j3 歧义不算、多选错选、简答中 2/3 不算全对）');

/* ============================================================ */
head('④ 相邻锚：判断题归一在三个模块里必须**同一实现**（消灭第二/第三份副本）');

const JUDGES = ['√', '✓', '对', '正确', '是', '真', 't', 'TRUE', 'yes', '1', ' ×', '✗', 'x', '错', '错误', '否', '假', '非',
                'f', 'false', 'no', '0', '不正确', '不对', '不是', '没错', '非正确', '√。', '【正确】', '是否', '正确与否', '待定', '', null, true, false,
                // 红队补充：**否定词在句中**的自然写法（早先全部判反）
                '这题不对', '我认为不正确', '我觉得不对', '这不对', '答案不正确', '显然不对',
                '这个说法不正确', '我认为不对', '不是错的', '没有错', '有误', '并不错误'];
const diff = [];
JUDGES.forEach(function (v) {
  const a = Q.normalizeJudge(v);
  const b = Seg.normalizeJudge(v).value;
  const c = S.normalizeJudge(v);
  const d = P.normalizeJudge(v).value;
  if (!(a === b && b === c && c === d)) diff.push({ v: v, quiz: a, segment: b, schema: c, parser: d });
});
eq(diff, [], '三个模块 + 解析门面在 ' + JUDGES.length + ' 种写法上结论完全一致（含否定式与歧义）');
eq(Q.normalizeJudge('不正确'), false, '  「不正确」→ false（曾经 quiz 那份认不出来 → 冤判 0 分）');
eq(Q.normalizeJudge('没错'), true, '  「没错」→ true');
eq(Q.normalizeJudge('待定'), null, '  「待定」→ null（认不出来就是不认，不猜）');
eq(Seg.normalizeJudge('是否').reason !== null, true, '  歧义时 segment 还会给出 reason 供校对面板用', Seg.normalizeJudge('是否').reason);

/* 相邻锚：题目的 judgeValue 由解析层写入，计分层读它 —— 两边必须自洽 */
const judgeParsed = Seg.normalizeJudge('不正确');
eq(judgeParsed.value, false, '解析层把答案键「不正确」定为 false');
eq(Q.scoreOne({ id: 'jx', type: '判断', judgeValue: judgeParsed.value }, '不正确', C).correct, true,
   '  同一份答案键与同一份作答 → 判为"对"（两侧自洽，不会互相打架）');

head('④-B **语义锚**：不是"四模块一致"就够（四份一起错也会过），逐条钉住期望值');

// 红队指出：只断言"四个模块结论一致（diff===[]）"是**空转风险** —— 四份一起错也全绿。
// 所以下面这张表是**语义**期望值，与实现无关，改了实现就必须重新论证。
const JUDGE_SEMANTICS = [
  ['√', true], ['对', true], ['正确', true], ['真', true], ['TRUE', true], ['1', true],
  ['×', false], ['错', false], ['错误', false], ['非', false], ['0', false],
  ['不正确', false], ['不对', false], ['不是', false], ['非正确', false], ['有误', false],
  ['这题不对', false], ['我认为不正确', false], ['我觉得不对', false], ['这个说法不正确', false],
  ['没错', true], ['没有错', true], ['不是错的', true], ['并不是错的', true],
  // 问句式 / 自相矛盾 / 多重否定 / 长句叙述 → 一律不猜
  ['是不是', null], ['对不对', null], ['行不行', null], ['是否', null], ['正确与否', null],
  ['并不错误但是也不完全正确', null], ['这道题的说法是正确的，但理由不对', null],
  ['交换机和集线器不是一回事', null], ['这个选项的描述不是完全准确的', null],
  ['不是不对', null], ['不是不正确', null],
  ['这不是对的吗', null], ['是对的吧', null], ['错了吧', null],
  // 红队三轮 P1/P2：程度副词「非常」与对冲说法「不一定/对了一半」
  ['非常正确', true], ['非常对', true], ['非常错误', false], ['非常好', null],
  ['这不一定对', null], ['这不一定错', null], ['对了一半', null], ['错了一半', null],
  ['也许是错的', null], ['可能正确', null],
  // 红队四轮 P8：hedge 词表粒度补齐
  ['部分正确', null], ['部分错误', null], ['半数正确', null], ['差不多对', null],
  ['有些正确', null], ['大部分正确', null],
  // 红队四轮 (a)：不收「好」进 TRUE 表（收进去会让「这不好」判成 true）；这些一律 null
  ['好', null], ['不好', null], ['这不好', null], ['好得很', null],
  ['待定', null], ['', null], [null, null]
];
const semBad = JUDGE_SEMANTICS.filter(function (c) { return Seg.normalizeJudge(c[0]).value !== c[1]; })
  .map(function (c) { return c[0] + '→' + JSON.stringify(Seg.normalizeJudge(c[0]).value) + '（应 ' + JSON.stringify(c[1]) + '）'; });
eq(semBad, [], '判断题归一逐条对上语义期望（' + JUDGE_SEMANTICS.length + ' 条，含问句/矛盾/多重否定/长句）');
// 反向对照：这张表里"必须不猜"的那一档确实占了一定比例（不是清一色 true/false）
const nullCount = JUDGE_SEMANTICS.filter(function (c) { return c[1] === null; }).length;
ok(nullCount >= 10, '  其中"交人工（null）"有 ' + nullCount + ' 条 —— 歧义政策真的在起作用', nullCount);

head('④-C 答案键一致性校验：与计分侧**同一把尺子**，且不误伤既有约定');

const opts3 = [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }, { label: 'C', text: 'c' }];
function vq(patch) {
  return S.validateQuestion(Object.assign({ id: 'x', type: '多选', stem: 's', options: opts3 }, patch)).errors;
}
eq(vq({ answer: 'A', answerLetters: ['B'] }).length > 0, true, '该报错：answer=A 与 answerLetters=[B] 真矛盾');
eq(vq({ answer: 'A、B、C', answerLetters: ['A', 'C'] }).length > 0, true, '该报错：answer=A、B、C 与 [A,C] 不一致');
[['A、C', ['A', 'C']], ['A,C', ['A', 'C']], ['（A）', ['A']], ['A C', ['A', 'C']], ['答案：AC', ['A', 'C']],
 ['AC', ['C', 'A']], ['ＡＣ', ['A', 'C']], ['AC', ['a', 'c']], ['ac', ['A', 'C']]].forEach(function (c) {
  eq(vq({ answer: c[0], answerLetters: c[1] }), [], '该放行：answer="' + c[0] + '" + answerLetters=[' + c[1] + ']（写法不同但本质一致）');
});
eq(vq({ answer: 'A', answerLetters: ['Z'] }).length > 0, true, '该报错：答案字母 Z 根本不在选项里');
// 红队三轮 P3：`answer` 里有字母、`answerLetters` 却是空 —— 早先整段跳过 →
// 校验放行，而计分侧恒判"不可判分"（学生看到一道 3 分、答对永远 0 分的题）
eq(vq({ answer: 'AC', answerLetters: [] }).length > 0, true, '该报错：answer=AC 但 answerLetters 是空（会变成永远判 0 分）');
eq(vq({ answer: 'A', answerLetters: [] }).length > 0, true, '  单选同理');
eq(vq({ answer: '', answerLetters: [] }).length, 0, '  两边都空 → 不算矛盾（已有"选择题没有答案"warning 覆盖）');
// 收窄后的边界：**只在"答案文本里有字母"时才比**，文本型答案与"只给字母"都不误伤
const optsText = [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }];
function vqt(patch) {
  return S.validateQuestion(Object.assign({ id: 'x', type: '多选', stem: 's', options: optsText }, patch)).errors;
}
eq(vqt({ answer: '甲', answerLetters: [] }), [], '该放行：答案文本写成选项内容（甲）而没字母 —— 文本型答案，不算矛盾');
eq(vqt({ answer: '甲', answerLetters: ['A'] }), [], '该放行：答案文本=选项内容，字母单独给（旧数据里常见）');
eq(vqt({ answer: '', answerLetters: ['A'] }), [], '该放行：答案文本空着、只给了字母（字母才是判分依据）');
eq(vqt({ answer: 'A', answerLetters: ['A'] }), [], '该放行：字母与文本一致');
// 红队四轮 P6：**显式空数组** ≠ **没写这个字段**。
// 本应用自己的分享导出就是 `answerLetters: q.answerLetters || null`（data.js），
// 把 null/缺失也当矛盾 → 会把自家导出的合法文件整批挡在导入门口（而计分侧对它们本来是正确判分的）。
eq(vq({ answer: 'AC', answerLetters: [] }).length > 0, true, '该报错：**显式**空数组 + answer 有字母 → 真矛盾（计分侧会恒判不可判分）');
eq(vq({ answer: 'AC', answerLetters: null }), [], '该放行：answerLetters=null（"没写"）→ 不报错，只在 warnings 里提示');
eq(vq({ answer: 'AC' }), [], '该放行：字段缺失同理');
eq(vq({ answer: 'AC', answerLetters: null }).length === 0 &&
   S.validateQuestion({ id: 'x', type: '多选', stem: 's', options: opts3, answer: 'AC', answerLetters: null })
     .warnings.some(function (w) { return w.indexOf('没写答案字母') >= 0; }), true,
   '  但仍给一条 warning「没写答案字母，判分按 answer 文本解析」（看得见、不挡路）');
// 这条是"用户可见后果"的锚：分享导出形状必须**既能过校验、又能正确判分**
const shareShape = S.createQuestion({ id: 'sh', type: '多选', stem: 's', answer: 'AC',
  answerLetters: null, options: opts3 });
eq(S.validateExam({ id: 'e', title: 't', schemaVersion: 1, questions: [shareShape] }).ok, true,
   '**分享导出的形状**（answerLetters=null）能整卷过校验 → 导入不被挡');
eq([sc(shareShape, 'AC').score, sc(shareShape, 'AC').correct], [3, true], '  而且计分正确（答 AC 得 3 分）');
// 红队四轮 P7：写了 ['Z'] 时不许把用户写过的 Z 说成"空的"
const zErrs = vq({ answer: 'AC', answerLetters: ['Z'] });
eq(zErrs.length > 0, true, '该报错：答案字母写成了 Z（不在选项里）');
eq(zErrs.join('').indexOf('却是空的') < 0, true, '  但文案不许说"答案字母却是空的"（用户明明写了 Z）');
eq(S.createQuestion({ id: 'q0', type: '多选', stem: 's', options: opts3 }).answerLetters, [],
   '  连答案都没写的题也能建（只是 warning），校验不误伤');
// 单选既有约定：答案写了 AB 时只取第一个字母（多选转单选的收窄结果）—— 不许被新校验误伤
const singleAB = S.createQuestion(Seg.applyDerived({ id: 'x2', type: '单选', stem: 's', answer: 'AB',
  options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], keywords: [], review: [] }));
eq([singleAB.answer, singleAB.answerLetters], ['AB', ['A']], '单选 answer=AB → 派生答案字母只留 [A]（既有约定）');
eq(S.validateExam({ id: 'e', title: 't', schemaVersion: 1, questions: [singleAB] }).ok, true,
   '  整卷校验**通过**（早先这条会把导入整个卡死）');

console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
console.log('  PASS ' + pass + '    FAIL ' + fail);
if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
process.exitCode = fail ? 1 : 0;
