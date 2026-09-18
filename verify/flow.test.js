/* ============================================================
 *  verify/flow.test.js —— 「行为开关与分数线」小类验收
 *
 *  运行： node verify/flow.test.js
 *
 *  三条盘档验收标准，逐条对应：
 *    ① 答案/解析按设定的时机显示：选『答完一题』时单题提交后即可见，
 *       选『整卷后』时答题期间不泄露答案
 *    ② 自动检查与自动翻页开关各自生效；关闭时不会有自动跳转或自动揭示
 *    ③ 分数线改动后等级定档随之变化；本轮题量既可用加减按钮调整，也可按分数定义
 *
 *  三条反空转设计：
 *    · ①"不泄露"用**穷举**所有 (时机 × 是否判分 × 是否结束) 组合 + 一条哨兵断言：
 *      只要"整卷后才显示"且还没结束，answer 就必须是 false。
 *      否则一个"永远显示答案"的实现也能碰巧通过"该显示时显示了"。
 *    · ② 用 32 种 (开关×状态) 组合的**真值表**，并断言"关闭 → 动作里绝不出现它"。
 *      否则一个"永远自动跳"的实现能通过"打开时确实跳了"。
 *    · ③ 分数线用**同一百分数的三套线**对锚（70 分：60 线→及格 / 75 线→不及格 / 70 线→优秀），
 *      并与 scoreExam 的 level 交叉核对 —— 两处各写一份判定就会打架。
 * ============================================================ */
const F = require('../core/flow.js');
const Q = require('../core/quiz.js');

let pass = 0, fail = 0; const failures = [];
function brief(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return String(s);
  return s.length > 170 ? s.slice(0, 170) + '…(' + s.length + ' 字符)' : s;
}
function ok(c, t, d) { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + brief(d) : '')))
                         : (fail++, failures.push(t), console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + brief(d) : ''))); }
function eq(a, e, t) { const A = JSON.stringify(a), B = JSON.stringify(e); ok(A === B, t + '   期望=' + brief(B), A); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }

/* 配置：内置默认打底再覆盖（= 三层取值后的生效配置） */
function cfg(patch) { return Q.mergeConfig(Q.DEFAULT_CONFIG, patch || {}); }

/* ============================================================ */
head('①-A 展示时机：默认是「答完一题即显示」（用户要求），但**未知值仍落回"整卷后"**');

const pol0 = F.revealPolicy(null);
eq([pol0.answer, pol0.explain], ['each', 'each'], '默认：答案与解析都**答完一题即显示**（刷题就是要当场知道对错）');
eq(pol0.answerLabel, '答完一题即显示', '  中文标签可直接上界面');
eq(pol0.fallback, [], '  默认值不算"落回"（没有异常项）');

const polBad = F.revealPolicy(cfg({ reveal: { answerTiming: 'midway', explainTiming: 'end' } }));
eq(polBad.answer, 'end', '未知时机（midway）→ **仍落回 end**（默认值改了，"坏值兜底"这一侧不许跟着松：绝不猜成 each 把答案漏出去）');
eq(polBad.fallback, ['reveal.answerTiming="midway"'], '  并点名那个非法值（不静默）');
// null = "这一层没写"（三层取值的既有语义），那是默认值、不是非法值 → 不该报警
const polNull = F.revealPolicy(cfg({ reveal: { answerTiming: null, explainTiming: null } }));
eq([polNull.answer, polNull.fallback], ['each', []], 'null 按"没写"处理 → 用**新默认 each** 且**不**报警（与 configSources/deepMerge 口径一致）');

head('①-B 展示时机：穷举真值表（时机 × 是否判分 × 是否整卷结束）');

const cases = [];
[['each', 'each'], ['each', 'end'], ['end', 'each'], ['end', 'end']].forEach(function (t) {
  [false, true].forEach(function (submitted) {
    [false, true].forEach(function (finished) {
      const c = cfg({ reveal: { answerTiming: t[0], explainTiming: t[1] } });
      const r = F.revealAt(c, { submitted: submitted, finished: finished });
      const wantAnswer = finished ? true : (submitted && t[0] === 'each');
      const wantExplain = (finished ? true : (submitted && t[1] === 'each')) && wantAnswer;
      cases.push({ t: t, submitted: submitted, finished: finished, answer: r.answer, explain: r.explain,
                   wantAnswer: wantAnswer, wantExplain: wantExplain, hit: r.answer === wantAnswer && r.explain === wantExplain });
    });
  });
});
eq(cases.filter(c => !c.hit), [], '16 种组合全部符合"该显示才显示"（' + cases.length + ' 条逐格核对）');
eq(cases.filter(c => c.finished && (!c.answer || !c.explain)), [], '整卷结束后答案与解析一律可见（不论时机）');

head('①-C **不泄露答案**：整卷后模式 + 答题期间，任何状态都不给答案（哨兵断言）');

const leak = [];
[['end', 'end'], ['end', 'each']].forEach(function (t) {
  [undefined, 'answering', 'reviewing'].forEach(function (phase) {
    [false, true].forEach(function (submitted) {
      const r = F.revealAt(cfg({ reveal: { answerTiming: t[0], explainTiming: t[1] } }), { submitted: submitted, phase: phase, finished: false });
      if (r.answer || r.explain) leak.push({ t: t, phase: phase, submitted: submitted, r: [r.answer, r.explain] });
    });
  });
});
eq(leak, [], '**12 种答题期状态一个都没泄露**（含"已判分但没结束"这种最容易漏的）');

const rEnd = F.revealAt(cfg({ reveal: { answerTiming: 'end', explainTiming: 'end' } }), { submitted: true, finished: false });
ok(rEnd.reasons.join('').indexOf('整卷结束后显示') >= 0, '  且给出可读原因（界面可以直接提示用户为什么看不到）', rEnd.reasons);

head('①-D 选「答完一题」：判分后即可见（未判分仍然不给）');

const eachCfg = cfg({ reveal: { answerTiming: 'each', explainTiming: 'each' } });
eq(F.revealAt(eachCfg, { submitted: true }).answer, true, 'each：已判分 → 答案可见');
eq(F.revealAt(eachCfg, { submitted: true }).explain, true, 'each：已判分 → 解析也可见');
eq(F.revealAt(eachCfg, { submitted: false }).answer, false, '  **没判分的题不给答案**（不然等于送答案）');
eq(F.revealAt(eachCfg, { phase: 'reviewing' }).answer, true, '  停在已提交的题上（phase=reviewing）→ 可见');

head('①-E 解析不得早于答案（解析里往往直接写着答案）');

const gated = F.revealAt(cfg({ reveal: { answerTiming: 'end', explainTiming: 'each' } }), { submitted: true, finished: false });
eq([gated.answer, gated.explain], [false, false], '答案选「整卷后」而解析选「答完一题」→ **两个都不显示**（不给解析反推答案的机会）');
eq(gated.policy.explainGatedByAnswer, true, '  策略层就标出了这个矛盾组合');
ok(gated.reasons.join('').indexOf('解析不会先出现') >= 0, '  原因里说清楚', gated.reasons);

/* ============================================================ */
head('②-A 自动检查 / 自动翻页：真值表（含**判分结果**这一轴：答错不许翻）');

const combos = [];
[false, true].forEach(function (ac) {
  [false, true].forEach(function (an) {
    [false, true].forEach(function (answered) {
      [false, true].forEach(function (checked) {
        [false, true].forEach(function (finished) {
          [null, true, false].forEach(function (correct) {
            const c = cfg({ behavior: { autoCheck: ac, autoNext: an } });
            const r = F.afterSubmit(c, { answered: answered, checked: checked, finished: finished, correct: correct });
            const has = k => r.actions.indexOf(k) >= 0;
            // 期望值**独立推导**（不抄实现）：
            const wantCheck = answered && ac && !checked;                  // 自动判分
            const isChecked = checked || wantCheck;                        // 这轮结束时是否已判分
            const judgedWrong = isChecked && correct === false;            // 已判分且答错
            const wantNext = answered && an && !finished && !judgedWrong;  // 自动翻页（答错除外）
            const bad = [];
            if (has('check') !== wantCheck) bad.push('check');
            if (has('next') !== wantNext) bad.push('next');
            if (r.checked !== isChecked) bad.push('checked标记');
            if (r.willJump !== wantNext) bad.push('willJump');
            if (answered && !ac && !checked && !has('needsManualSubmit')) bad.push('缺needsManualSubmit');
            if (finished && has('next')) bad.push('结束后还next');
            if (correct === false && isChecked && !has('revealAnswer')) bad.push('答错没给正确答案');
            combos.push({ ac: ac, an: an, answered: answered, checked: checked, finished: finished, correct: correct,
                          wantCheck: wantCheck, wantNext: wantNext, bad: bad });
          });
        });
      });
    });
  });
});
eq(combos.filter(c => c.bad.length), [], '96 种组合全部自洽（0 条异常）');
// 反空转：真值表里这几个键确实**两种取值都出现过**（否则"表"是残缺的）
eq([combos.filter(c => c.wantCheck).length > 0, combos.filter(c => c.wantNext).length > 0,
    combos.filter(c => !c.wantNext).length > 0, combos.filter(c => c.correct === false && c.checked && !c.answered).length > 0],
   [true, true, true, true], '  表里既有"该判分/该跳"也有"不该"的情形（不是一张恒真表）');

head('②-B **关闭时不会有自动跳转或自动揭示**（这是验收的原话）');

const offCfg = cfg({ behavior: { autoCheck: false, autoNext: false } });
const off = F.afterSubmit(offCfg, { answered: true, checked: false });
eq(off.actions, ['needsManualSubmit'], '两个开关都关着 + 用户已作答 → 动作只有"等手动提交"');
eq(off.actions.filter(a => a === 'check' || a === 'revealAnswer' || a === 'revealExplain' || a === 'next'), [],
   '  **没有判分、没有揭示、没有跳转**');
eq(off.willJump, false, '  willJump = false');
const offNone = F.afterSubmit(offCfg, { answered: false, checked: false });
eq(offNone.actions, [], '  连"作答"都没有时 → 一个动作都不做（不打扰）');

const offJump = F.afterSubmit(cfg({ behavior: { autoCheck: false, autoNext: true } }), { answered: true, checked: false });
eq(offJump.actions.indexOf('next') >= 0, true, '**自动翻页不等判分**：答完就跳（用户明确要求"点完自动翻"）');
eq([offJump.willJump, offJump.checked], [true, false], '  willJump = true 且这一题确实还没判分（跳 ≠ 判）');
const noAnsJump = F.afterSubmit(cfg({ behavior: { autoCheck: false, autoNext: true } }), { answered: false, checked: false });
eq(noAnsJump.willJump, false, '  但**没作答**时不跳（不把空题翻过去）');
ok(noAnsJump.notes.join('').indexOf('还没作答') >= 0, '  并说明原因', noAnsJump.notes);

head('②-C 两个开关**各自**生效（不互相绑架）');

const onlyCheck = F.afterSubmit(cfg({ behavior: { autoCheck: true, autoNext: false } }), { answered: true });
eq(onlyCheck.actions.indexOf('check') >= 0, true, '只开自动判分：答完就判（check）');
eq(onlyCheck.actions.indexOf('next'), -1, '  但不跳（自动翻页关着）');

const onlyNext = F.afterSubmit(cfg({ behavior: { autoCheck: false, autoNext: true } }), { answered: true, checked: true });
eq(onlyNext.actions.indexOf('next') >= 0, true, '只开自动翻页：**手动**提交（已判分）后照样自动跳（不被 autoCheck 绑架）');
eq(onlyNext.willJump, true, '  willJump = true');

const both = F.afterSubmit(cfg({ behavior: { autoCheck: true, autoNext: true } }), { answered: true });
eq(both.actions, ['check', 'revealAnswer', 'revealExplain', 'next'].filter(a => both.actions.indexOf(a) >= 0),
   '两个都开：判分 → 揭示 → 翻页，动作顺序也是这个（' + both.actions.join(' → ') + '）');

head('②-C2 「答错的题也自动翻页」（用户要求"错题是否自动翻页"给个开关）');

const wrongCfg = (patch) => cfg({ behavior: Object.assign({ autoCheck: true, autoNext: true, autoNextMs: 1500 }, patch || {}) });
const wrongCtx = { answered: true, checked: true, correct: false, score: 0, full: 2 };

/* 默认（开关关着）：老行为一个字不改 —— 答错就停在这一题 */
const wOff = F.afterSubmit(wrongCfg(null), wrongCtx);
eq([wOff.autoNextWrong, wOff.willJump, wOff.waitMs, wOff.jumpedDespiteWrong], [false, false, 0, false],
   '默认关着：答错 → 不翻、不排等待定时器，停在这一题看正确答案');
ok(wOff.notes.join('').indexOf('答错了') >= 0 && wOff.notes.join('').indexOf('不自动翻页') >= 0,
   '  备注直说"答错了 → 停在这一题看正确答案（不自动翻页）"', wOff.notes);

/* 开了：答错也照翻（等待时间照旧生效） */
const wOn = F.afterSubmit(wrongCfg({ autoNextWrong: true }), wrongCtx);
eq([wOn.autoNextWrong, wOn.willJump, wOn.waitMs], [true, true, 1500],
   '开了之后：答错也翻，而且**等待时间照旧生效**（不是立刻翻）');
eq(wOn.jumpedDespiteWrong, true, '  jumpedDespiteWrong = true（界面据此说清"这题答错了也翻"）');
ok(wOn.notes.join('').indexOf('答错的题也自动翻页') >= 0, '  备注解释为什么答错了还翻', wOn.notes);
/* 半对（有分但没满）算不算"没得全分"？算 —— 同一道门，措辞说"没得全分" */
const wHalf = F.afterSubmit(wrongCfg({ autoNextWrong: true }), { answered: true, checked: true, correct: false, score: 2, full: 3 });
eq([wHalf.notPerfect, wHalf.willJump], [true, true], '多选半对（2/3）同样属于"没得全分"，开了开关也翻');
const wHalfOff = F.afterSubmit(wrongCfg(null), { answered: true, checked: true, correct: false, score: 2, full: 3 });
ok(wHalfOff.notes.join('').indexOf('没得全分') >= 0, '  关着时那句措辞是"没得全分（半对 / 没答全）"，不是"答错了"', wHalfOff.notes);

/* 它只是 autoNext 的**子选项**：自动翻页关着时它管不着任何事 */
const wMaster = F.afterSubmit(wrongCfg({ autoNext: false, autoNextWrong: true }), wrongCtx);
eq([wMaster.autoNext, wMaster.willJump], [false, false], '自动翻页关着 → 光开"错题也翻"不跳（子选项被主开关按住）');
/* 边界不松动：没作答 / 整卷结束 都不翻（与开关无关） */
eq(F.afterSubmit(wrongCfg({ autoNextWrong: true }), { answered: false, checked: false }).willJump, false,
   '  开了它也不会把**没作答**的空题翻过去');
eq(F.afterSubmit(wrongCfg({ autoNextWrong: true }), Object.assign({ finished: true }, wrongCtx)).willJump, false,
   '  整卷结束后照样不跳（最后一题没有"下一题"）');
/* 真抽一次动件：面板点一下真的写进配置（不是死控件） */
const wAct = F.quickAction(cfg(null), { id: 'autoNextWrong', value: true });
eq([wAct.ok, wAct.config.behavior.autoNextWrong], [true, true], '面板动件 autoNextWrong 可用（点了真的写进配置）');
eq(F.quickAction(cfg(null), { id: 'autoNextWronges', value: true }).errors.map(e => e.code), ['E_FLOW_UNKNOWN_ACTION'],
   '  不认识的动件名照样被拦下（不静默）');
/* 面板行：自动翻页关着时这一行置灰 */
eq(F.quickModel(cfg({ behavior: { autoNext: false } }))[2].rows.filter(r => r.id === 'autoNextWrong').map(r => r.enabled),
   [false], '自动翻页关着 → 面板上「答错的题也自动翻页」这一行置灰（enabled:false）');
eq(F.quickModel(cfg(null))[2].rows.filter(r => r.id === 'autoNextWrong').map(r => [r.label, r.enabled]),
   [['答错的题也自动翻页', true]], '  开着时可用，标签就是用户说的那件事');

head('②-D 整卷结束后不再跳');
const fin = F.afterSubmit(cfg({ behavior: { autoCheck: true, autoNext: true } }), { answered: true, checked: true, finished: true });
eq(fin.actions.indexOf('next'), -1, 'finished → 不跳（没有"下一题"了）');
eq([fin.reveal.answer, fin.reveal.explain], [true, true], '  但答案与解析全部可见（整卷结束）');

/* ============================================================ */
head('②-E 自动翻页**等待时间**（behavior.autoNextMs）：只管"等多久"，不管"要不要跳"');

const d0 = F.autoNextDelay(cfg(null));
eq([d0.ms, d0.label, d0.custom, d0.fallback], [1500, '1.5 秒后再翻', false, null],
   '默认 1500 毫秒（用户要求"翻页等待 1.5 秒"）');
eq(d0.presets, [0, 200, 500, 1000, 1500, 2000], '  面板六档预设（毫秒；0.2 秒是用户要求补的"比较小的时间"档）');
eq(d0.presets.map(function (ms) { return d0.labels[ms]; }), ['立刻', '0.2 秒', '0.5 秒', '1 秒', '1.5 秒', '2 秒'], '  每档都有人话标签');
eq([d0.max, F.AUTO_NEXT_MS_MAX, Q.AUTO_NEXT_MS_MAX], [5000, 5000, 5000], '  上界 5000：flow / quiz / 面板**同一个数**（不各写一份）');
eq(F.AUTO_NEXT_MS_DEFAULT, Q.DEFAULT_CONFIG.behavior.autoNextMs,
   '  等待时间的默认值**只有一处定义**（flow 从 quiz 的配置模型取，不许各写一份）');

const d1 = F.afterSubmit(cfg({ behavior: { autoNext: true, autoNextMs: 800 } }), { answered: true, checked: false });
eq([d1.willJump, d1.waitMs], [true, 800], '等 800 毫秒：要不要跳（willJump）与等多久（waitMs）分头给');
eq(d1.jumpLabel, '0.8 秒后再翻', '  标签把毫秒折算成人话');
ok(d1.notes.join('').indexOf('800 毫秒') >= 0, '  备注里说清"等着 800 毫秒"', d1.notes);
eq(F.autoNextDelay(cfg({ behavior: { autoNextMs: 800 } })).custom, true, '  非预设值被标成"自定义"（面板要如实说）');

const dOff = F.afterSubmit(cfg({ behavior: { autoNext: false, autoNextMs: 2000 } }), { answered: true, checked: false });
eq([dOff.willJump, dOff.waitMs], [false, 0], '**不跳时 waitMs 恒为 0** —— 界面不会拿着一个非零值空等');
const dFin = F.afterSubmit(cfg({ behavior: { autoNext: true, autoNextMs: 2000 } }), { answered: true, checked: true, finished: true });
eq([dFin.willJump, dFin.waitMs, dFin.jumpLabel], [false, 0, '不翻页'], '整卷结束后也不等（没有下一题了）');

/* 非法值一律落回**默认值**（1.5 秒）并点名 —— 坏字段不许把节奏改成另一种极端，
 * 也不许静默变成 0 或 3 秒（前者像"没等"，后者像"卡住了"）。 */
[[-5, '负数'], ['abc', '非数字'], [99999, '超上界'], [500.5, '非整数'], [NaN, 'NaN'], [null, 'null（当"没写"）']]
  .forEach(function (p) {
    const d = F.autoNextDelay(cfg({ behavior: { autoNextMs: p[0] } }));
    const wantFallback = (p[0] !== null);
    eq([d.ms, d.fallback !== null], [1500, wantFallback],
       '  ' + p[1] + ' → ' + (wantFallback ? '落回默认 1.5 秒并点名' : 'null 按"没写"处理（不算非法）'));
  });
ok(/已按默认 1\.5 秒处理/.test(F.afterSubmit(cfg({ behavior: { autoNext: true, autoNextMs: 99999 } }),
   { answered: true, checked: false }).notes.join('')),
   '  面板备注里把"落回默认 1.5 秒"说清楚（用户看得见为什么）');

head('②-F 等待时间在配置层与面板里都是"正规字段"（不是法外之地）');

eq(F.setBehavior(cfg(null), 'autoNextMs', 1000).config.behavior.autoNextMs, 1000, '面板动件 autoNextMs → 真写进配置');
eq(F.quickAction(cfg(null), { id: 'autoNextMs', value: 500 }).config.behavior.autoNextMs, 500,
   'quickAction 认这个动件（**不是死控件** —— 分数线那两行就栽在这上面）');
eq(F.quickAction(cfg(null), { id: 'autoNextMs', value: 5000 }).ok, true, '  上界 5000 本身合法');
const msBad = F.setBehavior(cfg(null), 'autoNextMs', 'abc');
eq([msBad.ok, msBad.errors.map(e => e.code)], [false, ['E_FLOW_BAD_VALUE']], '非数字被拦下（不静默变 0）');
const msBig = F.setBehavior(cfg(null), 'autoNextMs', 6000);
eq([msBig.ok, msBig.errors.map(e => e.path)], [false, ['behavior.autoNextMs']], '超上界由配置层拦下（错误指向这个字段）');
eq(F.setBehavior(cfg(null), 'autoNextMs', -1).ok, false, '  负数被拦下');
eq(F.setBehavior(cfg(null), 'autoNext', true).errors, undefined, '  顺带：原有开关动件没被改坏');

/* ⚠ 现在**默认两个开关都开着**（用户要求"快捷设置默认全部开启"）——
 *   所以"关着时置灰"要用**显式关掉**的配置来验，不能拿默认配置当"关着"。 */
const offBeh = F.setBehavior(F.setBehavior(cfg(null), 'autoCheck', false).config, 'autoNext', false).config;
const msRow = F.quickModel(offBeh)[2].rows.filter(r => r.id === 'autoNextMs')[0];
eq([msRow.kind, msRow.value, msRow.options.length], ['choice', 1500, 6], '面板那一行是六档选择控件（值是毫秒数）');
eq(msRow.enabled, false, '自动翻页关着 → 这一行**置灰**（关着就没有"等多久"这回事）');
const msRowDflt = F.quickModel(cfg(null))[2].rows.filter(r => r.id === 'autoNextMs')[0];
eq([msRowDflt.enabled, msRowDflt.value], [true, 1500], '  默认（自动翻页开着）→ 可用，且停在 1.5 秒那一档');
const msRowOn = F.quickModel(F.setBehavior(cfg(null), 'autoNext', true).config)[2].rows.filter(r => r.id === 'autoNextMs')[0];
eq(msRowOn.enabled, true, '  打开自动翻页后可用');
const bNotes = F.quickModel(F.setBehavior(cfg(null), 'autoNext', true).config)[2].notes.join('');
ok(bNotes.indexOf('答完就翻') >= 0 && bNotes.indexOf('不必等判分') >= 0,
   '面板文案写明"答完就翻 … 不必等判分"（旧的"判分后自动翻页"是陈旧文案；这一行在"删小字"那轮压缩过）', bNotes);
ok(bNotes.indexOf('**') < 0, '  面板文字里**不留 markdown 记号**（`**加粗**` 会原样显示给用户看）', bNotes);
ok(bNotes.indexOf('多选') >= 0 && bNotes.indexOf('不自动翻') >= 0, '  并说清多选/简答不自动翻', bNotes);
const msPrev = Q.configPreview(F.setBehavior(cfg(null), 'autoNextMs', 1500).config, null)
  .filter(r => r.path === 'behavior.autoNextMs')[0];
ok(msPrev && String(msPrev.value) === '1500' && String(msPrev.display).indexOf('1500') >= 0,
   '设置预览也认识这个新字段（值 ' + (msPrev && msPrev.value) + '）', msPrev && msPrev.display);

/* ============================================================ */
head('②-G 用户要求：快捷设置**默认全部开启**（自动判分 + 自动翻页 + 等待 1.5 秒）');

eq([Q.DEFAULT_CONFIG.behavior.autoCheck, Q.DEFAULT_CONFIG.behavior.autoNext,
    Q.DEFAULT_CONFIG.behavior.autoNextMs, Q.DEFAULT_CONFIG.behavior.autoNextWrong, Q.DEFAULT_CONFIG.behavior.timer],
   [true, true, 1500, false, false],
   '内置默认：两个开关都开、翻页等待 1.5 秒；「答错的题也自动翻页」「答题计时」默认**关**（改默认只改 quiz.js 那一处）');
eq(F.quickModel(cfg(null))[2].rows.filter(r => r.kind === 'toggle').map(r => [r.id, r.value]),
   [['autoCheck', true], ['autoNext', true], ['autoNextWrong', false], ['timer', false]],
   '面板上的开关默认态：自动判分/自动翻页按下，其余两个（错题也翻 / 答题计时）没按下');
const dBeat = F.afterSubmit(cfg(null), { answered: true, checked: false });
eq([dBeat.actions.indexOf('check') >= 0, dBeat.willJump, dBeat.waitMs], [true, true, 1500],
   '默认配置下答完一题：**判分 + 等 1.5 秒再翻**（三件事都按用户的默认来）');
/* ⚠ 还是要能**关掉**：默认开不等于写死开（用户可能就想自己掌控节奏） */
const dMute = F.afterSubmit(F.setBehavior(F.setBehavior(cfg(null), 'autoCheck', false).config, 'autoNext', false).config,
                            { answered: true, checked: false });
eq([dMute.actions.indexOf('check'), dMute.willJump, dMute.waitMs], [-1, false, 0], '  两个都关掉 → 不判分、不翻页');
/* 三层的规矩照旧：全局层/卷级写了就以它为准（默认值不许盖住用户的显式设置） */
eq(Q.resolveConfig({ behavior: { autoNextMs: 0 } }, null).behavior.autoNextMs, 0,
   '  显式写了 0（立刻翻）→ 以它为定，不被新默认值盖掉');

/* ============================================================ */
head('②-H 用户要求：**答错了要指出正确答案**，而且**不自动翻页**');

/* ① 答错 → 不管展示时机（这里显式设成"整卷后"），当场揭示答案 */
const wEnd = F.revealAt(cfg({ reveal: { answerTiming: 'end', explainTiming: 'end' } }),
                        { submitted: true, finished: false, correct: false });
eq([wEnd.answer, wEnd.wrong], [true, true], '答错 → 时机=整卷后也**当场揭示答案**（wrong=true）');
const wRight = F.revealAt(cfg({ reveal: { answerTiming: 'end', explainTiming: 'end' } }),
                          { submitted: true, finished: false, correct: true });
eq([wRight.answer, wRight.wrong], [false, false], '  对照：**答对**时照旧不揭示（时机说了算）—— 不是"一律揭示"');
eq(F.revealAt(cfg({ reveal: { answerTiming: 'end' } }), { submitted: false, finished: false, correct: false }).answer,
   false, '  对照：**没判分**时哪怕 correct=false 也不揭示（规则①不许破）');
eq(F.revealAt(cfg({ reveal: { answerTiming: 'each' } }), { submitted: true, correct: false }).explain !== undefined,
   true, '  解析仍按自己的时机走（答案强制给了，解析不跟着强制）');

/* ② 答错 → 不自动翻（也不排等待） */
const jw = F.afterSubmit(cfg({ behavior: { autoCheck: true, autoNext: true, autoNextMs: 1500 } }),
                         { answered: true, checked: true, correct: false });
eq([jw.willJump, jw.waitMs, jw.jumpLabel, jw.actions.indexOf('next'), jw.actions.indexOf('revealAnswer') >= 0],
   [false, 0, '不翻页', -1, true], '答错：**不跳**（waitMs=0、动作里没有 next），并把正确答案揭示出来');
ok(jw.notes.join('').indexOf('答错') >= 0 && jw.notes.join('').indexOf('不自动翻页') >= 0,
   '  说明里点明"答错了 → 停在这一题看正确答案（不自动翻页）"', jw.notes);
const jr = F.afterSubmit(cfg({ behavior: { autoCheck: true, autoNext: true, autoNextMs: 1500 } }),
                         { answered: true, checked: true, correct: true });
eq([jr.willJump, jr.waitMs], [true, 1500], '  对照：**答对**时照旧按设置翻（等 1.5 秒）');
const jn = F.afterSubmit(cfg({ behavior: { autoCheck: false, autoNext: true, autoNextMs: 0 } }),
                         { answered: true, checked: false, correct: null });
eq([jn.willJump, jn.checked], [true, false],
   '  对照：自动判分关着 → 不知道对错（correct=null），沿用老规矩"答完就翻"（跳 ≠ 判）');

/* ③ 面板文案要把这两条新规矩说出来 */
const wNotes = F.quickModel(cfg(null))[2].notes.join('');
ok(wNotes.indexOf('没得全分就不翻') >= 0, '  面板备注写明"没得全分就不翻"（不让用户以为自动翻页坏了）', wNotes);
ok(wNotes.indexOf('不自动判分') >= 0 && wNotes.indexOf('提交本题') >= 0,
   '  并写明"多选题与简答题不自动判分：答完点「提交本题」才判分"', wNotes);
ok(wNotes.indexOf('**') < 0, '  且不留 markdown 记号（面板上会原样显示）', wNotes);

/* ④ 「得全分才跳」：半对 / 没答全也不行（分与满分是两个口径，都要能判） */
const halfJump = F.afterSubmit(cfg({ behavior: { autoCheck: true, autoNext: true, autoNextMs: 1500 } }),
                               { answered: true, checked: true, correct: false, score: 3, full: 6 });
eq([halfJump.willJump, halfJump.waitMs, halfJump.notPerfect], [false, 0, true],
   '多选半对（3 / 6 分）：**不跳**，并标成 notPerfect');
ok(halfJump.notes.join('').indexOf('半对') >= 0,
   '  措辞是"没得全分（半对 / 没答全）"，不是"答错了"（别让半对的用户以为全错）', halfJump.notes);
const zeroJump = F.afterSubmit(cfg({ behavior: { autoCheck: true, autoNext: true, autoNextMs: 1500 } }),
                               { answered: true, checked: true, correct: false, score: 0, full: 6 });
ok(zeroJump.notes.join('').indexOf('答错了') >= 0, '  0 分才说"答错了"', zeroJump.notes);
const fullJump = F.afterSubmit(cfg({ behavior: { autoCheck: true, autoNext: true, autoNextMs: 1500 } }),
                               { answered: true, checked: true, correct: true, score: 6, full: 6 });
eq([fullJump.willJump, fullJump.waitMs], [true, 1500], '满分的题：照旧跳（等 1.5 秒）');
/* 边界：引擎说"全对"但配置把上限压到 <1（简答 maxRatio=0.8）→ 仍算得全分，
 * 否则这条规则在那种配置下**永远不触发**（用户会觉得自动翻页坏了）。 */
const cappedJump = F.afterSubmit(cfg({ behavior: { autoCheck: true, autoNext: true, autoNextMs: 0 } }),
                                 { answered: true, checked: true, correct: true, score: 4, full: 5 });
eq([cappedJump.willJump, cappedJump.notPerfect], [true, false],
   '引擎判"全对"但分数没到满分（简答 maxRatio<1）→ 仍算得全分、照跳');

/* ⑤ perfectOf 的三态：显式 prior > correct > 分数；什么都不知道时给 null（沿用"答完就翻"） */
eq([F.perfectOf({ correct: false }), F.perfectOf({ score: 5, full: 5 }), F.perfectOf({ score: 4, full: 5 })],
   [false, true, false], 'perfectOf：correct=false → false；分数到满分 → true；没到 → false');
eq(F.perfectOf({}), null, 'perfectOf：什么都没给（没判分）→ null');
eq(F.perfectOf({ perfect: false, correct: true }), false, 'perfectOf：调用方显式给的 perfect **优先**于 correct');
eq(F.perfectOf({ full: 0, score: 0 }), false,
   'perfectOf：满分 0 分的题 → 按"没得全分"处理（保守：宁可不跳，也别把 0 分题当成"全对"）');

/* ============================================================ */
head('③-A 分数线：边界值逐点定档（60 / 85 线）');

const gCfg = cfg({ grade: { pass: 60, excellent: 85 } });
[[0, '不及格'], [59.9, '不及格'], [60, '及格'], [70, '及格'], [84.9, '及格'], [85, '优秀'], [100, '优秀']]
  .forEach(function (p) {
    eq(F.gradeLevel(p[0], gCfg).level, p[1], '  ' + p[0] + ' 分 → ' + p[1]);
  });

head('③-B 改分数线 → 同一个分数换档（三套线对锚，证明"改动后定档随之变化"）');

const p70 = 70;
eq(F.gradeLevel(p70, cfg({ grade: { pass: 60, excellent: 85 } })).level, '及格', '70 分 + 60/85 线 → 及格');
eq(F.gradeLevel(p70, cfg({ grade: { pass: 75, excellent: 85 } })).level, '不及格', '70 分 + **75**/85 线 → 不及格（及格线抬到 75）');
eq(F.gradeLevel(p70, cfg({ grade: { pass: 60, excellent: 70 } })).level, '优秀', '70 分 + 60/**70** 线 → 优秀（优秀线降到 70，含等于）');
eq(F.gradeLevel(p70, cfg({ grade: { pass: 70, excellent: 85 } })).level, '及格', '70 分 + **70**/85 线 → 及格（等于及格线算及格）');

const gl = F.gradeLevel(72, cfg({ grade: { pass: 60, excellent: 85 } }));
eq([gl.toPass, gl.toExcellent], [-12, 13], '  gradeLevel 同时给出"离及格线 / 离优秀线"的距离（-12 = 已超出 12 分）');
ok(/离优秀线还差 13 分/.test(gl.note), '  提示文案', gl.note);

head('③-C 区间表与判定必须一致（左闭右开，最后一档含 100）');

const bands = F.gradeBands(cfg({ grade: { pass: 60, excellent: 85 } }));
eq(bands.map(x => [x.level, x.from, x.to]), [['不及格', 0, 60], ['及格', 60, 85], ['优秀', 85, 100]], '三档区间');
const bandMismatch = [];
for (let p = 0; p <= 100; p += 0.5) {
  const lv = F.gradeLevel(p, gCfg).level;
  const band = bands.filter(function (b) { return p >= b.from && (b.toInclusive ? p <= b.to : p < b.to); })[0];
  if (!band || band.level !== lv) bandMismatch.push([p, lv, band && band.level]);
}
eq(bandMismatch, [], '0~100 每 0.5 分逐点核对：区间表与 levelOf 判定完全一致（201 个点）');

head('③-D 相邻锚：判分模块的 level 与这里**同一真相源**');

const qs = [
  { id: 's1', type: '单选', stem: 'a', options: [{ label: 'A', text: 'x' }, { label: 'B', text: 'y' }], answerLetters: ['A'] },
  { id: 'j1', type: '判断', stem: 'b', judgeValue: true },
  { id: 'm1', type: '多选', stem: 'c', options: [{ label: 'A', text: 'x' }, { label: 'B', text: 'y' }], answerLetters: ['A', 'B'] },
  { id: 'k1', type: '简答', stem: 'd', keywords: [{ text: 'a' }, { text: 'b' }] }
];
const r1 = Q.scoreExam(qs, { s1: 'A', j1: '√', m1: 'AB', k1: 'a b' }, gCfg);
eq(r1.percent, 100, '全对 → 100%');
eq(r1.level, F.gradeLevel(r1.percent, gCfg).level, 'scoreExam.level === FlowCore.gradeLevel(...).level');
const r2 = Q.scoreExam(qs, { s1: 'B', j1: '√', m1: 'AB', k1: 'a' }, cfg({ grade: { pass: 60, excellent: 85 } }));
eq(r2.level, F.gradeLevel(r2.percent, gCfg).level, '半对时也一致（percent=' + r2.percent + ' → ' + r2.level + '）');
eq(Q.levelOf(84.9, gCfg), '及格', 'QuizCore.levelOf 已导出（两处共用一个实现）');

// 反向对照：把两条线**降下来**，同一份答卷的定档**必须**跟着升档
// （原先我拿"抬到 95/99"做对照，结果那份答卷本来就不及格、抬完还是不及格 —— 选错了对照样本）
const lenient = cfg({ grade: { pass: 50, excellent: 70 } });
const lenientLevel = Q.scoreExam(qs, { s1: 'B', j1: '√', m1: 'AB', k1: 'a' }, lenient).level;
eq(lenientLevel, '及格', '同一份答卷（' + r2.percent + '%）在 50/70 线下 → 及格');
ok(lenientLevel !== r2.level,
   '反向对照：分数线降下来后，同一份答卷的定档确实变了（证明"改线→换档"不是摆设）',
   r2.level + '（60/85） → ' + lenientLevel + '（50/70）');

/* ============================================================ */
head('④-A 本轮题量：加减按钮一步一题，并按当前口径走');

const base = cfg({ pick: { mode: 'random', randomBasis: 'count', count: 20, seed: 1 } });
const ctl = F.countControl(base);
eq([ctl.basis, ctl.count, ctl.step, ctl.affectsPick], ['count', 20, 1, true], '完全随机 + 按题量：口径=题量、步长 1、对抽题生效');

const plus = F.quickAction(base, { id: 'count+' });
eq(plus.ok, true, '点「+」成功');
eq(plus.config.pick.count, 21, '  count 20 → 21');
eq(plus.config.pick.mode, 'random', '  抽题规则仍是完全随机');
const minus = F.quickAction(plus.config, { id: 'count-' });
eq(minus.config.pick.count, 20, '再点「−」→ 回到 20（能来回走）');

const atMin = F.quickAction(cfg({ pick: { mode: 'random', randomBasis: 'count', count: 0 } }), { id: 'count-' });
eq([atMin.ok, atMin.value, atMin.clamped, atMin.atMin], [true, 0, true, true], 'count=0 时再点「−」→ 停在 0（clamped，不变成负数）');
eq(atMin.config.pick.count, 0, '  落地的仍是 0（0 是合法题量）');

head('④-B 按分数定义本轮题量（口径切换 + 加减按 5 分一档）');

const byScore = F.setBasis(base, 'score');
eq([byScore.ok, byScore.config.pick.randomBasis], [true, 'score'], '切口径到「按目标总分」');
eq(byScore.switchedMode, false, '  本来就在完全随机下 → 不动规则');
const scoreCtl = F.countControl(byScore.config);
eq([scoreCtl.basis, scoreCtl.step], ['score', 5], '  分数口径的步长 = 5 分');
const scoreUp = F.quickAction(byScore.config, { id: 'score+' });
eq(scoreUp.config.pick.targetScore, 105, '点「分数 +」→ targetScore 100 → 105');
eq(scoreUp.basis, 'score', '  确实是按分数口径动的');

// 关键：在「按题数配比」下点「按目标总分」—— 口径只在完全随机下有意义，
// 所以必须**一并切到完全随机**，否则点了半天界面毫无变化（假功能）
const fromByCount = F.setBasis(cfg({ pick: { mode: 'byCount' } }), 'score');
eq([fromByCount.ok, fromByCount.switchedMode, fromByCount.config.pick.mode], [true, true, 'random'],
   '在「按题数配比」下切口径 → 一并切到「完全随机」（并回报 switchedMode）');
eq(F.countControl(fromByCount.config).basis, 'score', '  切换后生效口径真的是分数（不是"点了没反应"）');
ok(/一并切到「完全随机」/.test(fromByCount.note), '  并给出可读说明', fromByCount.note);

// 关键：当前口径是「按题量」时，点分数那一行必须改分数、不许去改题量
const mixed = F.quickAction(base, { id: 'score+' });
eq(mixed.config.pick.targetScore, 105, '口径=题量时点「分数 +」→ 改的是 targetScore');
eq(mixed.config.pick.count, 20, '  且**没有**顺手改掉题量（不张冠李戴）');
const mixed2 = F.quickAction(byScore.config, { id: 'count+' });
eq(mixed2.config.pick.count, 21, '反过来：口径=分数时点「题量 +」→ 改的是 count');
eq(mixed2.config.pick.targetScore, 100, '  且没动 targetScore');

eq(F.setCount(base, 35).config.pick.count, 35, 'setCount(35) 直接落地');
eq(F.setCount(base, -5).value, 0, 'setCount(-5) → 夹到 0（按钮在 0 处本来就禁用）');
eq(F.setCount(base, 12345).value, F.COUNT_MAX, 'setCount(12345) → 夹到上限 ' + F.COUNT_MAX);

head('④-C 快捷面板的补丁只改自己写到的字段（不是整份覆盖）');

const before = cfg({ pick: { mode: 'random', randomBasis: 'count', count: 20 }, points: { '单选': 7 }, grade: { pass: 66, excellent: 88 } });
const afterBump = F.quickAction(before, { id: 'count+' }).config;
eq(afterBump.points, before.points, '改题量**不动**分值（单选仍是 7）');
eq(afterBump.grade, before.grade, '  不动分数线');
eq(afterBump.reveal, before.reveal, '  不动展示时机');
eq(Q.pathsOf(afterBump).length, Q.pathsOf(Q.mergeConfig(Q.DEFAULT_CONFIG, before)).length,
   '  合并后的叶子数不变（没有因为补丁丢字段）');

head('④-D 非法值仍然被拦下（快捷面板不许成为绕过校验的后门）');

const rejects = [
  ['未知的抽题规则', function () { return F.setMode(base, 'byMagic'); }, 'E_FLOW_BAD_MODE'],
  ['未知的题量口径', function () { return F.setBasis(base, 'nope'); }, 'E_FLOW_BAD_BASIS'],
  ['未知的展示时机', function () { return F.setReveal(base, 'answer', 'midway'); }, 'E_FLOW_BAD_TIMING'],
  ['未知的时机项', function () { return F.setReveal(base, 'foo', 'each'); }, 'E_FLOW_BAD_REVEAL_KEY'],
  ['未知的行为开关', function () { return F.setBehavior(base, 'autoFly', true); }, 'E_FLOW_BAD_BEHAVIOR_KEY'],
  ['未知的分数线名', function () { return F.setGrade(base, 'perfect', 99); }, 'E_FLOW_BAD_GRADE_KEY'],
  ['分数线超范围（120）', function () { return F.quickAction(base, { id: 'grade.pass', value: 120 }); }, 'E_CFG_OUT_OF_RANGE'],
  ['分数线颠倒（及格 90 / 优秀 60）', function () { return F.quickAction(base, { id: 'grade.pass', value: 90 }); }, 'E_CFG_RANGE_INVERTED'],
  ['题量不是数字', function () { return F.setCount(base, 'abc'); }, 'E_FLOW_BAD_VALUE'],
  ['加减量不是数字', function () { return F.bumpCount(base, NaN); }, 'E_FLOW_BAD_VALUE'],
  ['不认识的动件', function () { return F.quickAction(base, { id: 'explode' }); }, 'E_FLOW_UNKNOWN_ACTION']
];
rejects.forEach(function (r) {
  const res = r[1]();
  const codes = (res.errors || []).map(function (e) { return e.code; });
  ok(res.ok === false && codes.indexOf(r[2]) >= 0, '拒绝：' + r[0] + ' → ' + r[2],
     (res.ok ? '竟然通过了' : '') + codes.join(','));
});
// 反向对照：合法值必须通过（否则上面 11 条"拒绝"可能只是恒拒绝）
const okRes = F.setGrade(base, 'pass', 70);
eq([okRes.ok, okRes.config.grade.pass, okRes.config.grade.excellent], [true, 70, 85], '反向对照：合法分数线（及格 70）通过并落地');

// ⚠ 这条序列**必须与浏览器自检页 J 节的实际点击一致**：J 节的计数器断言（8 次点击/7 生效/1 被拦）
//   就是按这段复算出来的。在 Node 里把它钉住，自检页那个计数器就不会悄悄过期
//   （组级红队发现过一次：模板里加了合法点击、计数器没跟着改，打开自检页会红）。
const jseq = [
  ['count+', undefined], ['basis', 'score'], ['score+', undefined],
  ['grade.pass+', undefined], ['grade.pass', 120],
  ['answerTiming', 'each'], ['autoNext', true], ['autoNext', false]
];
let jClicks = 0, jChanges = 0, jErrors = 0, jCfg = base;
jseq.forEach(function (a) {
  jClicks++;
  const r = F.quickAction(jCfg, { id: a[0], value: a[1] });
  if (r.ok) { jCfg = r.config; jChanges++; } else jErrors++;
});
eq([jClicks, jChanges, jErrors], [8, 7, 1],
   'J 节动件序列复算：8 次点击 / 7 次生效 / 1 次被拦（自检页那个计数器就是按它写的）');
ok(jErrors === 1 && jCfg.grade.pass === 65, '  唯一那次被拦是"及格线 120"（数值校验），配置停在被拦前的 65（没被改坏）',
   jCfg.grade.pass);

head('④-C 面板数据模型：分组、控件、备注都由 flow 层给出（界面不做判断）');

const model = F.quickModel(base);
eq(model.map(g => g.group), ['抽题与题量', '展示时机', '作答行为', '分数线', '判分'], '五个分组（判分是这一轮新增的）');
const allRows = model.reduce(function (a, g) { return a.concat(g.rows); }, []);
ok(allRows.every(r => r.id && r.label && r.kind), '  每一行都有 id/label/kind（' + allRows.length + ' 行）');
eq(allRows.filter(r => r.kind === 'choice').map(r => r.id), ['mode', 'basis', 'prefer', 'answerTiming', 'explainTiming', 'autoNextMs'],
   '  六个二选一控件（base 是「完全随机」→ 才有"题量口径""抽取偏好"那两行）');
eq(allRows.filter(r => r.kind === 'toggle').map(r => r.id), ['autoCheck', 'autoNext', 'autoNextWrong', 'timer'],
   '  四个开关（自动判分 / 自动翻页 / 答错的题也自动翻页 / 答题计时）');
eq(allRows.filter(r => r.kind === 'stepper').map(r => r.id),
   ['count', 'score', 'grade.pass', 'grade.excellent', 'points.多选', 'multi.halfScore'],
   '  六个加减控件（含新增的多选全对得分 / 多选半对得分）');
// 红队组级审查抓出的真功能坏：分数线那两行声明成 stepper，面板会发 `grade.pass+` 这种**带符号**的动件，
// 而 quickAction 早先只认不带符号的 `grade.pass` → 两个按钮点了永远报"不认识的动件"。
// 所以这里必须**真的点一次**（下面 ②-C' 段），光断言"行存在"会把坏控件当 PASS。
eq(F.quickAction(base, { id: 'grade.pass+' }).config.grade.pass, 65, '分数线「+」动件可用：及格线 60 → 65（不是死控件）');
eq(F.quickAction(base, { id: 'grade.excellent-' }).config.grade.excellent, 80, '分数线「−」动件可用：优秀线 85 → 80');
eq(F.quickAction(base, { id: 'grade.pass+', value: 1 }).ok, true, '  带符号的动件不会走到"不认识的动件"分支');
/* 新加的行同样要"真的点一次"：光断言"行存在"会把死控件当 PASS（上面那条教训）。 */
eq(F.quickAction(base, { id: 'autoNextMs', value: 1500 }).config.behavior.autoNextMs, 1500,
   '翻页等待那一行的动件可用（1500 毫秒）');
eq(allRows.filter(r => r.id === 'count').map(r => r.enabled), [true], '  口径=题量时题量行可用');
eq(F.quickModel(byScore.config).reduce((a, g) => a.concat(g.rows), []).filter(r => r.id === 'count').map(r => r.enabled),
   [false], '  口径=分数时题量行置灰');
ok(model[3].notes.join('').indexOf('及格 60% / 优秀 85%（都按卷面满分的百分比算）') >= 0, '  分数线那组把当前比例写在备注里（用户要求改成比例）', model[3].notes);
ok(model.every(g => (g.notes || []).join('').indexOf('**') < 0),
   '  四组备注都不含 markdown 记号（`**` 是给文档用的，面板上会原样显示出来）',
   model.map(g => g.notes).join(' ｜ '));

/* ============================================================ */
head('④-E 逐题型分配：两条"手动分配"规则（按题型数量 / 按题型总分）');

const tCount = F.typeAlloc(cfg({ pick: { mode: 'byCount' } }));   // ⚠ 内置默认已改成 all → 这里显式给 byCount
eq([tCount.mode, tCount.isScore, tCount.basis], ['byCount', false, 'count'], '「按题型数量」→ 单位是题');
eq(tCount.rows.map(r => r.id), ['byType.单选', 'byType.多选', 'byType.判断', 'byType.简答'], '四行的动件 id 与题型一一对应');
eq(tCount.rows.map(r => r.unit), ['题', '题', '题', '题'], '  单位都是「题」');
eq(tCount.rows.map(r => r.step), [1, 1, 1, 1], '  步长 1 题');
eq(tCount.total, 18, '  合计 = 内置默认 10+2+4+2 = 18 题');

const pts = Q.DEFAULT_CONFIG.points;
const tScore = F.typeAlloc(cfg({ pick: { mode: 'byWeight' } }));
eq([tScore.mode, tScore.isScore, tScore.basis], ['byWeight', true, 'score'], '「按题型总分」→ 单位是分');
eq(tScore.rows.map(r => r.id), ['byTypeScore.单选', 'byTypeScore.多选', 'byTypeScore.判断', 'byTypeScore.简答'], '四行换成逐题型目标分');
eq(tScore.rows.map(r => r.step), [pts['单选'], pts['多选'], pts['判断'], pts['简答']],
   '  步长 = 该题型每题分值（按一下正好是一道题的分，凑分能精确落地）');
eq(tScore.rows.map(r => r.value), [0, 0, 0, 0], '  默认全 0 = 还没分配');
ok(tScore.notes.join('').indexOf('自动配比') >= 0, '  全 0 时说明"仍按目标总分自动配比"（老行为）', tScore.notes);

const implied = F.typeAlloc(cfg({ pick: { mode: 'byWeight', byTypeScore: { '单选': 9, '多选': 6 } } }));
eq([implied.total, implied.rows[0].implied, implied.rows[1].implied], [15, Math.floor(9 / pts['单选']), 2],
   '  合计 15 分，并给出"≈ 几题"的换算（只读，不写回配置）');
const zeroUnit = F.typeAlloc(cfg({ points: { '单选': 0 }, pick: { mode: 'byWeight', byTypeScore: { '单选': 5 } } }));
eq([zeroUnit.rows[0].step, zeroUnit.rows[0].implied, /每题 0 分/.test(zeroUnit.notes.join(''))], [1, null, true],
   '每题 0 分的题型：步长退回 1、不给换算、备注里点名（不许编一个数字糊弄）');

/* 动件：写值 + **自动切规则**（值写了但规则没切 = 点了没反应） */
const actC = F.quickAction(cfg(null), { id: 'byType.单选', value: 3 });
eq([actC.ok, actC.config.pick.byType['单选'], actC.config.pick.mode], [true, 3, 'byCount'],
   '填「单选 3 题」→ 写进配置并把规则切到「按题型数量」');
const actS = F.quickAction(cfg(null), { id: 'byTypeScore.单选', value: 20 });
eq([actS.config.pick.byTypeScore['单选'], actS.config.pick.mode], [20, 'byWeight'], '填「单选 20 分」→ 规则切到「按题型总分」');
const plusS = F.quickAction(cfg({ pick: { mode: 'byWeight', byTypeScore: { '单选': 20 } } }), { id: 'byTypeScore.单选+' });
eq([plusS.value, plusS.config.pick.byTypeScore['单选']], [20 + pts['单选'], 20 + pts['单选']],
   '「+」按每题分值走（20 → ' + (20 + pts['单选']) + '，不是 21）');
const plusC = F.quickAction(cfg({ pick: { mode: 'byCount', byType: { '单选': 3 } } }), { id: 'byType.单选+' });
eq(plusC.value, 4, '「+」按 1 题走：3 → 4');
const minusC = F.quickAction(cfg({ pick: { mode: 'byCount', byType: { '单选': 0 } } }), { id: 'byType.单选-' });
eq([minusC.ok, minusC.value, minusC.atMin], [true, 0, true], '已经 0 题时再按「−」→ 停在 0（不出现负数）');
eq(F.quickAction(cfg(null), { id: 'byType.生物', value: 1 }).errors.map(e => e.code), ['E_FLOW_BAD_TYPE'],
   '不存在的题型被拦（不是静默写进配置）');
eq(F.quickAction(cfg(null), { id: 'byType.单选', value: 'abc' }).errors.map(e => e.code), ['E_FLOW_BAD_VALUE'], '非数字被拦');
eq(F.quickAction(cfg(null), { id: 'byType.单选', value: -1 }).errors.map(e => e.code), ['E_FLOW_BAD_VALUE'], '负数被拦');
/* ⚠ 目标分**不设上限**（与 pick.targetScore 同一条规矩）：填大了就把题库抽光并如实报缺口，
 *   绝不静默截断。面板的 max 只用来禁用「+」按钮，不改写用户填的值。 */
eq(F.quickAction(cfg(null), { id: 'byTypeScore.单选', value: 99999 }).ok, true,
   '超大的目标分照样合法（配置层不设上限：抽不满就报缺口，不静默截断）');
eq(F.typeAlloc(cfg({ pick: { mode: 'byWeight', byTypeScore: { '单选': 99999 } } })).rows[0].value, 99999,
   '  面板也如实显示这个值（不改写成 1000）');
eq(F.quickAction(cfg(null), { id: 'byType.单选', value: 99999 }).ok, true,
   '题数同样不设上限（同上：题库不够就报缺口）');

/* 面板：**行随规则显隐**（不是置灰 —— 置灰的话随机那几行会一直占着面板，用户还得猜哪几行算数） */
const mCount = F.quickModel(cfg({ pick: { mode: 'byCount' } }));
eq(mCount[0].group, '抽题与题量', '分组名直说这是"抽题与题量"');
eq(mCount[0].rows.filter(r => r.kind === 'stepper').map(r => r.id),
   ['byType.单选', 'byType.多选', 'byType.判断', 'byType.简答'], '「按题型数量」只在面板上摆这四行加减控件');
eq(mCount[0].rows.filter(r => r.id === 'count' || r.id === 'basis').length, 0, '  没有"本轮题量/题量口径"那两行（那是完全随机才用的）');
const mScore = F.quickModel(cfg({ pick: { mode: 'byWeight' } }));
eq(mScore[0].rows.filter(r => r.kind === 'stepper').map(r => r.id),
   ['byTypeScore.单选', 'byTypeScore.多选', 'byTypeScore.判断', 'byTypeScore.简答'], '「按题型总分」摆的是逐题型目标分');
eq(mScore[0].rows[0].value, 'byWeight', '  规则那一行如实反映当前值');
eq(model[0].rows.filter(r => r.kind === 'stepper').map(r => r.id), ['count', 'score'],
   '「完全随机」才回到 本轮题量 / 目标总分 那两行');

/* ============================================================ */
head('④-F 「全部作答」：默认规则，且不抽题（答整卷并进设置项，用户要求）');

eq(cfg(null).pick.mode, 'random', '内置默认抽题规则 = **random（完全随机）**（用户要求"抽题改成随机的"）');
const mAll = F.quickModel(cfg(null));
eq(mAll[0].group, '抽题与题量', '  分组名不变（设置页与"答题面板排除表"都按这个名字过滤）');
eq(mAll[0].rows.map(r => r.id), ['mode', 'basis', 'count', 'score', 'prefer'],
   '  完全随机下摆的是"题量口径 + 本轮题量 / 目标总分 + 抽取偏好"（没有逐题型那四行）');
eq(mAll[0].rows.map(r => r.options && r.options.map(o => o.value)).filter(Boolean)[0],
   ['all', 'byCount', 'byWeight', 'random'], '  规则四选一（「全部作答」仍在选项里，改回整套卷做只要点一下）');
eq(mAll[0].rows.filter(r => r.id === 'mode')[0].options.map(o => o.label),
   ['全部作答', '按题型数量', '按题型总分', '完全随机'], '  选项文案');
/* 真的切一次（光断言"选项在"会把死控件当 PASS）：切到「全部作答」→ 只剩规则一行、且备注说不抽题 */
const toAll = F.quickAction(cfg({ pick: { mode: 'random' } }), { id: 'mode', value: 'all' });
eq([toAll.ok, toAll.config.pick.mode], [true, 'all'], '  面板上把规则切到「全部作答」→ 真的写进配置');
const mAllRows = F.quickModel(toAll.config)[0];
eq(mAllRows.rows.map(r => r.id), ['mode'], '  切过去之后这一组只剩"抽题规则"一行');
ok(mAllRows.notes.join('').indexOf('不抽题') >= 0, '  备注直说"整套卷都做、不抽题"', mAllRows.notes);
eq(F.quickModel(cfg(null)).map(g => g.group), ['抽题与题量', '展示时机', '作答行为', '分数线', '判分'],
   '  五组仍在（分数线/判分只是搬到设置页去显示，模型层没删、动件也照样能用）');
eq(F.quickAction(cfg(null), { id: 'grade.pass+', value: 1 }).ok, true, '  分数线动件在"全部作答"下照样可用');

/* ============================================================ */
head('④-G 「未作答优先」：面板上真能切，且与抽题规则正交（用户要求"抽题可以选择随机或者未做答优先"）');

const prefRow = function (c) { return F.quickModel(c)[0].rows.filter(r => r.id === 'prefer')[0]; };
eq(prefRow(cfg(null)).options.map(o => [o.value, o.label]),
   [['random', '完全随机'], ['unansweredFirst', '未作答优先']], '  两选一，文案就是用户说的那两句');
eq(prefRow(cfg(null)).value, 'random', '  默认 = 完全随机（不看作答记录）');
const toPrefer = F.quickAction(cfg(null), { id: 'prefer', value: 'unansweredFirst' });
eq([toPrefer.ok, toPrefer.config.pick.prefer], [true, 'unansweredFirst'], '  点一下真的写进配置（不是死控件）');
eq(prefRow(toPrefer.config).value, 'unansweredFirst', '  重画之后控件停在新值上');
ok(F.quickModel(toPrefer.config)[0].notes.join('').indexOf('未作答优先：') >= 0,
   '  备注说清它优先抽什么', F.quickModel(toPrefer.config)[0].notes);
/* 与规则正交：按题型数量 / 按题型总分 下这一行照样在（它们同样走随机抽取，不是"只有随机才能配"） */
eq(['byCount', 'byWeight'].map(m => prefRow(F.quickAction(cfg(null), { id: 'mode', value: m }).config).value),
   ['random', 'random'], '  换规则不会把偏好改掉（两者独立，各自记各自的）');
eq(prefRow(F.quickAction(toPrefer.config, { id: 'mode', value: 'byCount' }).config).value, 'unansweredFirst',
   '  先选偏好再换规则 → 偏好还在');
/* 「全部作答」不抽题 → 这一行不该出现（没有作用对象，摆着只会让人以为它算数） */
eq(F.quickModel(F.quickAction(cfg(null), { id: 'mode', value: 'all' }).config)[0].rows.map(r => r.id), ['mode'],
   '  「全部作答」下不摆抽取偏好那一行');
const badPrefer = F.quickAction(cfg(null), { id: 'prefer', value: 'smart' });
eq([badPrefer.ok, badPrefer.errors.map(e => e.code)], [false, ['E_FLOW_BAD_PREFER']], '  不认识的值被拦下（不静默当成随机）');

/* ============================================================ */
head('④-H 判分：多选全对 / 半对得分都能自己调（用户要求）');

eq(F.multiScoreCfg(cfg(null)), { full: 3, half: 2, mode: 'fixedScore', modeHint: null },
   '内置默认：多选全对 3 分、半对 2 分（fixedScore 模式）');
const mFull = F.quickAction(cfg(null), { id: 'points.多选+', value: 1 });
eq([mFull.ok, mFull.config.points['多选'], mFull.value], [true, 3.5, 3.5], '点「多选全对得分 +」→ 3 → 3.5（步长 0.5）');
eq(F.quickAction(cfg(null), { id: 'points.多选', value: 4 }).config.points['多选'], 4, '直接给值也认（4 分）');
/* 半对 ≤ 全对：把全对压到 1.5 → 半对（原 2）**跟着压下来**，并如实报告 */
const clampDown = F.quickAction(cfg(null), { id: 'points.多选', value: 1.5 });
eq([clampDown.config.points['多选'], clampDown.config.multi.halfScore, clampDown.clampedHalf], [1.5, 1.5, true],
   '把全对压到 1.5 → 半对一起压到 1.5（并报告 clampedHalf，界面据此提示）');
/* 反过来：半对想超过全对 → 压回全对并报告 */
const clampUp = F.quickAction(cfg(null), { id: 'multi.halfScore', value: 9 });
eq([clampUp.config.multi.halfScore, clampUp.clampedToFull, clampUp.full], [3, true, 3],
   '半对填 9（全对只有 3）→ 压回 3，并报告 clampedToFull');
eq(F.quickAction(cfg(null), { id: 'multi.halfScore+', value: 1 }).config.multi.halfScore, 2.5,
   '半对「+」→ 2 → 2.5');
eq(F.quickAction(cfg(null), { id: 'multi.halfScore', value: 3.24 }).config.multi.halfScore, 3,
   '半对给 3.24 → 落到 0.5 的整数倍（3）');
eq(F.quickAction(cfg(null), { id: 'points.多选', value: 'x' }).errors.map(e => e.code), ['E_FLOW_BAD_VALUE'],
   '非数字被拦下（不静默变 0）');
/* 面板上确实有这两行（并给出 0.5 步长 —— 分值只能落在半步上） */
const judgeRows = F.quickModel(cfg(null)).filter(g => g.group === '判分')[0];
eq(judgeRows.rows.map(r => [r.id, r.label, r.step, r.unit]),
   [['points.多选', '多选全对得分', 0.5, '分'], ['multi.halfScore', '多选半对得分', 0.5, '分']],
   '「判分」组两行：多选全对得分 / 多选半对得分（步长 0.5）');
eq(judgeRows.rows.filter(r => r.id === 'multi.halfScore')[0].max, 3,
   '  半对那一行的 max = 当前全对得分（面板上的 + 到顶就灰掉）');
ok(F.quickModel(Q.mergeConfig(Q.DEFAULT_CONFIG, { multi: { halfMode: 'hitRatio' } }))
     .filter(g => g.group === '判分')[0].notes.join('').indexOf('不用"半对得分"') >= 0,
   '  换成按命中比例模式时，备注明说"不用半对得分这一项"');

head('④-I 答题计时开关（用户要求：悬浮球 + 可暂停）');

eq(Q.DEFAULT_CONFIG.behavior.timer, false, '内置默认：答题计时**关**（多数人只想安静刷题）');
const timerOn = F.quickAction(cfg(null), { id: 'timer', value: true });
eq([timerOn.ok, timerOn.config.behavior.timer], [true, true], '面板点一下 → 真的写进配置');
eq(F.quickModel(timerOn.config)[2].rows.filter(r => r.id === 'timer').map(r => [r.label, r.value]),
   [['答题计时（悬浮球）', true]], '  「作答行为」组里那一行叫「答题计时（悬浮球）」');
eq(F.quickModel(timerOn.config).filter(g => g.group === '作答行为')[0].rows.map(r => r.id),
   ['autoCheck', 'autoNext', 'autoNextWrong', 'timer', 'autoNextMs'],
   '  它排在"答错的题也自动翻页"后面、翻页等待前面');

/* ============================================================ */
head('⑤ 相邻锚：新配置项能被既有校验/预览认识（不是法外之地）');

const revealCfgOk = F.setReveal(base, 'answer', 'each').config;
eq(Q.validateConfig(revealCfgOk).ok, true, 'reveal 用 each/end 通过整卷校验');
const revBad = Q.validateConfig(Q.mergeConfig(Q.DEFAULT_CONFIG, { reveal: { answerTiming: 'midway' } }));
eq(revBad.ok, false, '  而 midway 被 validateConfig 拦下');
eq(revBad.errors.map(e => e.code), ['E_CFG_BAD_ENUM'], '  错误码 E_CFG_BAD_ENUM（走的是同一道门）');

const row = Q.configPreview(base, null).filter(r => r.path === 'reveal.answerTiming')[0];
eq(row.display, '答完一题即显示（each）', '设置预览里的显示文本是**人话**（不是"false"）');
// base 是 mergeConfig 之后的**完整**配置 → 在这一层它是"全局设置"，标注就该是 global
eq(row.source, 'global', '  来源标注：传进去的整份配置算"全局"这一层');
const rowBuiltin = Q.configPreview(null, null).filter(r => r.path === 'reveal.answerTiming')[0];
eq([rowBuiltin.value, rowBuiltin.display, rowBuiltin.source], ['each', '答完一题即显示（each）', 'builtin'],
   '完全不传配置时 → 内置默认是 each（用户要求"答完一题就显示"），显示的仍是那句人话');
const rowB = Q.configPreview(revealCfgOk, null).filter(r => r.path === 'reveal.answerTiming')[0];
eq([rowB.value, rowB.display, rowB.source], ['each', '答完一题即显示（each）', 'global'], '改过之后预览跟着变');

const behaviorRow = Q.configPreview(base, null).filter(r => r.path === 'behavior.autoNext')[0];
eq([behaviorRow.value, behaviorRow.display], [true, '开'], '行为开关仍按"开/关"显示（默认现在是开）');

console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
console.log('  PASS ' + pass + '    FAIL ' + fail);
if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
process.exitCode = fail ? 1 : 0;
