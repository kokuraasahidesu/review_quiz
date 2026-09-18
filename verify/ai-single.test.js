/* ============================================================
 *  verify/ai-single.test.js —— 「单题智能生成」小类验收
 *
 *  运行： node verify/ai-single.test.js
 *
 *  三条盘档验收标准，逐条对应：
 *    ① 三类操作各自正确：解析**含易错点**、变式题**题型/选项/答案/关键词齐全**、难度是 **1-5 的整数**，
 *       且结果能"附加到原题"或"加入这份卷"；
 *    ② 结构不合格 → **拒绝 + 提示**，且**不写题库**（草案与存储逐字节不变）；
 *    ③ 单题操作**一次点击 = 一次请求**，**不弹消耗确认窗**。
 *
 *  本文件用**假 fetch**（不联网、零成本）；"用真实 Key 跑通"另见 `verify/real-ai.js`
 *  （读环境变量 DASHSCOPE_API_KEY，属于**人工触发**的真调用证据，不进自动回归）。
 * ============================================================ */
const A = require('../core/ai.js');
const D = require('../core/data.js');
const S = require('../core/schema.js');
const R = require('../core/review.js');
const DOM = require('./mini-dom.js');
const AiSingle = require('../ui/ai-single.js');

let pass = 0, fail = 0; const failures = [];
function brief(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return String(s);
  return s.length > 190 ? s.slice(0, 190) + '…(' + s.length + ' 字符)' : s;
}
function ok(c, t, d) { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + brief(d) : '')))
                         : (fail++, failures.push(t), console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + brief(d) : ''))); }
function eq(a, e, t) { const A1 = JSON.stringify(a), B = JSON.stringify(e); ok(A1 === B, t + '   期望=' + brief(B), A1); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }

/* 假后端 + 假 fetch（每次调用计一次；可指定"这一轮返回什么"） */
function backend() {
  const m = new Map();
  return {
    getItem: k => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: k => { m.delete(String(k)); },
    key: i => { const a = Array.from(m.keys()); return i < a.length ? a[i] : null; },
    get length() { return m.size; },
    raw: () => JSON.stringify(Array.from(m.entries()).sort())
  };
}
function fakeFetch(plan) {
  const calls = [];
  const f = async function (url, init) {
    calls.push({ url: url, headers: Object.assign({}, init.headers), body: init.body });
    const pick = plan[Math.min(calls.length - 1, plan.length - 1)];
    if (pick && pick.throwStatus) return { ok: false, status: pick.throwStatus, text: async () => '{"error":"boom"}' };
    const content = (typeof pick === 'string') ? pick : JSON.stringify(pick);
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: content } }] }) };
  };
  f.calls = calls;
  return f;
}
const CANARY = 'sk-canary-9f3a7c1e5b2d4680zz';
const ORIGIN = S.createQuestion({
  id: 'q_origin', type: '单选', stem: 'HTTP 默认端口是哪个？',
  options: [{ label: 'A', text: '21' }, { label: 'B', text: '80' }, { label: 'C', text: '443' }],
  answerLetters: ['A'], explanation: '', difficulty: null
});
function draftWith(q) {
  return R.createDraft({ questions: [JSON.parse(JSON.stringify(q))] }, { title: '草案' }).draft;
}
async function storeWithKey(bk, provider) {
  const st = A.openKeyStore(bk);
  await A.saveKey(st, provider || 'dashscope', CANARY, { now: '2026-10-27T10:00:00.000Z' });
  return A.openKeyStore(bk);                       // 换新实例 = 刷新后的处境
}

(async function main() {

head('①-A 解析：结构要求**含易错点**，并写进原题的解析字段');

eq(A.SCHEMAS === undefined, true, '（SCHEMAS 不对外导出，能力探针走 validate/checkResult）');
eq(A.checkResult('explain', { explanation: '只给解析' }).errors, ['缺少字段 pitfall'],
   '缺易错点 → 结构校验直接拒绝（易错点是解析的一部分，不是可选装饰）');
eq(A.checkResult('explain', { explanation: '  ', pitfall: '有' }).ok, false, '解析是空白串 → 也拒绝');
eq(A.checkResult('explain', { explanation: '解析正文', pitfall: '   ' }).ok, false, '易错点是空白串 → 也拒绝');

const explainRes = await A.runSingle(await storeWithKey(backend()), fakeFetch([{ explanation: '80 是默认端口。', pitfall: '容易把 443 当成默认端口。' }]),
  'dashscope', 'explain', ORIGIN, {}, {});
eq([explainRes.ok, explainRes.requestCount, explainRes.kind], [true, 1, 'explain'], '真跑一次：通过且**只发了 1 次请求**');
const exApplied = A.applyResult(ORIGIN, 'explain', explainRes.value);
eq(exApplied.ok, true, '结果可以"附加到原题"');
eq(exApplied.patches.explanation, '80 是默认端口。\n易错点：容易把 443 当成默认端口。',
   '**解析里带上了易错点**（合成一段写进 explanation，因为题结构里没有独立 pitfall 字段）',
   exApplied.patches.explanation);
eq(ORIGIN.explanation, '', '  纯函数：原题对象没被就地改动');
const again = A.applyResult(Object.assign({}, ORIGIN, { explanation: exApplied.patches.explanation }), 'explain', explainRes.value);
eq(again.patches.explanation, exApplied.patches.explanation, '  同一结果再应用一次不会把易错点堆两遍（幂等）');

head('①-B 变式题：题型 / 选项 / 答案 / 关键词四件套齐全，且不能原样抄原题');

const variantValue = { type: '多选', stem: '下面哪些是 HTTP 的默认端口？', answer: 'AB',
  options: [{ label: 'A', text: '80' }, { label: 'B', text: '443' }, { label: 'C', text: '3306' }],
  keywords: ['80', '443'], explanation: 'HTTP 80、HTTPS 443。' };
const vGate = A.checkResult('variant', variantValue, ORIGIN);
eq(vGate.ok, true, '四件套齐全的多选变式题通过结构闸门');
eq([vGate.question.type, vGate.question.options.length, vGate.question.answerLetters, vGate.question.stem],
   ['多选', 3, ['A', 'B'], '下面哪些是 HTTP 的默认端口？'], '  工厂产出的题型/选项/答案都对得上');
ok(!!vGate.question.id, '  并且拿到了 id（可直接入库的形状）', vGate.question.id);

const errs = k => A.checkResult('variant', k, ORIGIN).errors || [];
ok(errs({ type: '多选', stem: '新题', answer: 'A', options: variantValue.options }).some(e => /至少 2 个/.test(e)),
   '多选题只给 1 个答案 → 拒绝（半套答案不算变式题）',
   errs({ type: '多选', stem: '新题', answer: 'A', options: variantValue.options }).join('；'));
ok(errs({ type: '单选', stem: '新题', answer: 'D', options: variantValue.options }).some(e => /答案 D 不在选项里/.test(e)),
   '答案不在选项里 → 拒绝（本层与 schema 校验器各报一条，不冲突）',
   errs({ type: '单选', stem: '新题', answer: 'D', options: variantValue.options }).join('；'));
eq(errs({ type: '单选', stem: '新题', answer: '', options: variantValue.options }), ['answer 应为非空字符串'],
   '答案为空字符串 → 拒绝（"有空字段"也算缺：否则模型交白卷也当成功）');
ok(errs({ type: '单选', stem: '新题', answer: 'A', options: [{ label: 'A', text: 'x' }] }).some(e => /选项少于 2 个/.test(e)),
   '选项不足 2 个 → 拒绝',
   errs({ type: '单选', stem: '新题', answer: 'A', options: [{ label: 'A', text: 'x' }] }).join('；'));
eq(errs({ type: '判断', stem: '新题', answer: '也许吧' }), ['判断题没有可识别的答案（对/错）'], '判断题答案认不出来 → 拒绝');
eq(errs({ type: '简答', stem: '新题', answer: '参考答案文本' }), ['简答题没有采分关键词'], '简答题没有关键词 → 拒绝（否则入库后无法判分）');
eq(errs({ type: '填空', stem: '新题', answer: 'A' }), ['题型非法: 填空'], '题型不在四类里 → 拒绝');
eq(errs(Object.assign({}, variantValue, { stem: ORIGIN.stem })),
   ['变式题题干与原题一模一样（要求换题面，不能原样抄）'], '把原题抄一遍 → 拒绝（"变式"不能等于原题）');
ok(A.checkResult('variant', Object.assign({}, variantValue, { id: 'x' }), ORIGIN).ok, '  合法变式题不会因为带上多余字段就被拒');

head('①-C 难度：必须是 1-5 的**整数**');

[0, 6, 2.5, -1, '3', null].forEach(function (bad) {
  const r = A.checkResult('difficulty', { level: bad });
  eq(r.ok, false, '难度 ' + brief(bad) + ' → 拒绝');
});
eq(A.checkResult('difficulty', { level: 3 }).level, 3, '难度 3 通过');
eq(A.checkResult('difficulty', { level: 1 }).level, 1, '  下边界 1 通过');
eq(A.checkResult('difficulty', { level: 5 }).level, 5, '  上边界 5 通过');
eq(A.applyResult(ORIGIN, 'difficulty', { level: 4 }).patches, { difficulty: 4 }, '难度可"附加到原题"');
eq(ORIGIN.difficulty, null, '  纯函数：原题没被就地改动');

head('② 结构不合格 → 拒绝 + 提示，且**草案与存储逐字节不变**');

const bkR = backend();
const stR = await storeWithKey(bkR);
const dirty = fakeFetch(['{"explanation":"只有解析没有易错点"}']);
const draftR = draftWith(ORIGIN);
const bkBefore = bkR.raw(), draftBefore = R.stableJson(draftR);
const rej1 = await A.runSingle(stR, dirty, 'dashscope', 'explain', draftR.questions[0], {}, {});
eq([rej1.ok, rej1.stage, rej1.errors], [false, 'schema', ['缺少字段 pitfall']],
   '模型漏了易错点 → 拒绝并说明原因（stage 归到 schema，不是笼统的"调用失败"）');
eq(rej1.requestCount, 1, '  拒绝也是 1 次请求（点一次就一次）');
ok(rej1.value && rej1.value.explanation === '只有解析没有易错点', '  把模型原样返回值带回来，便于排查/重试',
   JSON.stringify(rej1.value));

/* 拿"被拒绝的结果"去应用 → 必须落不下来 */
const rejApply = A.applyResult(draftR.questions[0], 'explain', rej1.value);
eq([rejApply.ok, rejApply.patches], [false, undefined], '  被拒绝的结果**没有** patches（无从落库）');
eq(R.setExplanation(draftR, 0, '只有解析').ok, true, '对照：合法字符串当然能写进草案（说明上一条不是因为接口不存在）');
eq(R.stableJson(draftR), draftBefore, '  **草案逐字节未变**（被拒绝的结果没有碰过它）');
eq(bkR.raw(), bkBefore, '  **存储逐字节未变**（题库没被写入）');

/* 题库层面再确认一次：拒绝之后再"确认入库"，题库里的题目不含那条脏数据 */
const dirtyDraft = draftWith(ORIGIN);
eq(R.stableJson(dirtyDraft.questions), R.stableJson(draftR.questions),
   '  一份**同内容的**干净草案与入库前那道题逐字段相同（可作入库对照）');

const bkC = backend();
const stC = A.openKeyStore(bkC);
const committed = await R.commit(draftR, D.createStore({ small: { getItem: bkC.getItem, setItem: bkC.setItem, removeItem: bkC.removeItem, key: bkC.key, get length() { return bkC.length; } }, large: null, namespace: D.NS_GLOBAL }));
eq(committed.ok, true, '把这份草案确认入库（走既有 commit 通道）');
const storedExam = await stC.get('exam::' + committed.examId);
ok(JSON.stringify(storedExam).indexOf('只有解析') < 0, '  **题库里的这道题不含被拒绝的解析**');
ok(JSON.stringify(storedExam).indexOf('没有易错点') < 0, '  也不含被拒绝的易错点');

head('②-B 其它拒绝路径：模型啰嗦/越界/断网，都不许落库');

const bk2 = backend();
const st2 = await storeWithKey(bk2);
const draft2 = draftWith(ORIGIN);
const before2 = R.stableJson(draft2), storeBefore2 = bk2.raw();
const loose = await A.runSingle(st2, fakeFetch(['这道题的答案是 B，因为 80 是默认端口（解析如下）']), 'dashscope', 'variant', draft2.questions[0], {}, {});
eq(loose.ok, false, '模型写成散文、抠不出结构 → 拒绝');
eq(draft2.questions.length, 1, '  草案题目数没变（没有凭空多出一道题）');
eq(R.stableJson(draft2), before2, '  草案逐字节未变');
const half = await A.runSingle(st2, fakeFetch(['{"type":"多选","stem":"新题面","answer":"A","options":[{"label":"A","text":"x"},{"label":"B","text":"y"}]}']), 'dashscope', 'variant', draft2.questions[0], {}, {});
eq([half.ok, half.stage], [false, 'completeness'], '多选题只有 1 个答案 → 拒绝（阶段标成 completeness）');
ok(/至少 2 个/.test((half.errors || []).join('')), '  原因说得具体：' + (half.errors || []).join('；'));
const broken = await A.runSingle(st2, fakeFetch([{ throwStatus: 401 }]), 'dashscope', 'explain', draft2.questions[0], {}, {});
eq([broken.ok, broken.stage, broken.kind2], [false, 'call', 'auth'], '鉴权失败 → 拒绝并归类为 auth（不会静默吞掉）');
eq(R.stableJson(draft2), before2, '  三种拒绝之后草案仍然逐字节未变');
const rejectedCount = [loose, half, broken].filter(function (r) { return !r.ok; }).length;
eq(rejectedCount, 3, '  三次拒绝都如实返回 ok:false（没有一次假装成功）');

head('③ 一次点击 = 一次请求；不弹消耗确认窗');

const bk3 = backend();
const st3 = await storeWithKey(bk3);
const plan3 = [{ explanation: '解析一。', pitfall: '易错一。' }, { level: 4, reason: '需要两步推导' },
               { type: '单选', stem: '换个题面：80 端口属于谁？', answer: 'A', options: [{ label: 'A', text: 'HTTP' }, { label: 'B', text: 'FTP' }] }];
const f3 = fakeFetch(plan3);
const draft3 = draftWith(ORIGIN);
const r1 = await A.runSingle(st3, f3, 'dashscope', 'explain', draft3.questions[0], {}, {});
const r2 = await A.runSingle(st3, f3, 'dashscope', 'difficulty', draft3.questions[0], {}, {});
const r3 = await A.runSingle(st3, f3, 'dashscope', 'variant', draft3.questions[0], {}, {});
eq([r1.requestCount, r2.requestCount, r3.requestCount], [1, 1, 1], '三类操作各 1 次请求');
eq(f3.calls.length, 3, '  假 fetch 一共只被调用 3 次（三次点击 → 三次请求，没有多余探路请求）');
eq([r1.attempts, r2.attempts, r3.attempts], [1, 1, 1], '  每次都是第 1 次尝试就成（单题默认**不重试**）');
eq(A.singleRequest('explain', ORIGIN, {}).retries, 0, '  单题请求模板里 retries 默认为 0（要再试就再点一次）');
eq(A.singleRequest('explain', ORIGIN, { retries: 2 }).retries, 2, '  真要重试也能显式传（留给整卷批量用）');
eq(A.singleRequest('difficulty', ORIGIN, {}).task, 'difficulty', '  请求模板带着任务名（调用侧据此校验结构）');
ok(A.singleRequest('explain', ORIGIN, {}).user.indexOf('HTTP 默认端口是哪个？') >= 0, '  提示词里带上了题干');
ok(A.singleRequest('explain', ORIGIN, {}).user.indexOf('A. 21') >= 0, '  也带上了选项');
eq(f3.calls[0].headers.Authorization, 'Bearer ' + CANARY, '  请求头用的是**已保存的 Key**（走 callSaved 那条路）');
ok(f3.calls[0].body.indexOf('json_object') >= 0, '  开了 JSON 模式（结构校验的前提）');

head('③-B 界面（真挂载）：点一次发一次、拒绝不出现"采纳"按钮、无消耗确认窗');

const doc = DOM.makeDoc();
const host = doc.createElement('div');
doc.documentElement.appendChild(host);
const bkU = backend();
const stU = await storeWithKey(bkU);
let draftU = draftWith(ORIGIN);
const fU = fakeFetch(plan3);
const panel = AiSingle.mount({
  container: host, store: stU, fetchImpl: fU,
  getDraft: function () { return draftU; },
  applyDraft: function (d) { draftU = d; }
});
const runBtns = DOM.byAttr(host, 'data-asg', 'run');
eq(runBtns.map(function (n) { return n.getAttribute('data-asg-kind'); }), ['explain', 'variant', 'difficulty'], '界面上三个操作按钮');
ok(runBtns.every(function (n) { return n.disabled === false; }), '  默认全部可用');
/* ⚠ 文案精简过：现在是「点一次发一次请求；结构不合格的结果不会写回。」
 *   判据跟着锚**意图**：① 明说"点一次 = 一次请求"（别让用户以为会批量烧钱）；
 *   ② 单题路径**没有**消耗确认窗（下面那条结构断言才是硬判据，文字只是补充）。 */
ok(host.textContent.indexOf('点一次发一次请求') >= 0, '  界面上明写"点一次发一次请求"');
eq(DOM.byAttr(host, 'data-confirm').length, 0, '  **没有任何消耗确认窗节点**（单题路径不弹）');
ok(host.textContent.indexOf('消耗确认') < 0, '  也没有把"确认"混进别处');

runBtns[0].click();
await new Promise(function (r) { setTimeout(r, 30); });
eq(panel.stats().requests, 1, '点「生成解析」→ 恰好 1 次请求');
eq(panel.stats().clicks, 1, '  点击计数 1');
const ap = DOM.byAttr(host, 'data-asg', 'apply');
eq(ap.length, 1, '  通过校验 → 出现「附加到原题」按钮');
eq(DOM.byAttr(host, 'data-asg', 'reject').length, 0, '  没有拒绝框');

/* 拒绝路径：让下一轮返回缺 pitfall 的脏结构 */
fU.plan = null;
const fBad = fakeFetch(['{"explanation":"没有易错点"}']);
const panelBad = AiSingle.mount({ container: host, store: stU, fetchImpl: fBad,
  getDraft: function () { return draftU; }, applyDraft: function (d) { draftU = d; } });
DOM.byAttr(panelBad.el, 'data-asg', 'run')[0].click();
await new Promise(function (r) { setTimeout(r, 30); });
eq(panelBad.stats().rejected, 1, '脏结构 → 拒绝计数 1');
eq(DOM.byAttr(panelBad.el, 'data-asg', 'apply').length, 0, '  **不画"附加到原题"按钮**（拒绝的结果无处可落）');
eq(DOM.byAttr(panelBad.el, 'data-asg', 'reject').length, 1, '  画的是拒绝框');
ok(DOM.byAttr(panelBad.el, 'data-asg', 'reject')[0].textContent.indexOf('原题未改动、题库未写入') >= 0,
   '  拒绝框明写"原题未改动、题库未写入"');
eq(panelBad.stats().requests, 1, '  拒绝也只发了 1 次请求');
panelBad.destroy();

/* 采纳三条：解析 → 附加；难度 → 附加；变式 → 加一道题 */
const fGood = fakeFetch(plan3);
const panel3 = AiSingle.mount({ container: host, store: stU, fetchImpl: fGood,
  getDraft: function () { return draftU; }, applyDraft: function (d) { draftU = d; } });
const b3 = DOM.byAttr(panel3.el, 'data-asg', 'run');
const step = async function (i) { b3[i].click(); await new Promise(function (r) { setTimeout(r, 30); });
  DOM.byAttr(panel3.el, 'data-asg', 'apply')[0].click(); await new Promise(function (r) { setTimeout(r, 10); }); };
await step(0);
ok(String(draftU.questions[0].explanation).indexOf('易错点：易错一。') >= 0, '采纳解析 → 草案里那道题的解析带上了易错点',
   draftU.questions[0].explanation);
await step(2);
eq(draftU.questions[0].difficulty, 4, '采纳难度 → 草案里写上 4（1-5 的整数）');
await step(1);
eq(draftU.questions.length, 2, '采纳变式题 → 草案多了一道题');
eq(draftU.questions[1].stem, '换个题面：80 端口属于谁？', '  新题的题干就是模型给的新题面');
eq(panel3.stats(), { clicks: 3, requests: 3, applied: 3, applies: 3, rejected: 0 }, '三次点击 → 三次请求 → 三次采纳');
eq(fGood.calls.length, 3, '  假 fetch 也只被调用 3 次');

/* 采纳之后仍只是草案：没点「确认入库」，题库里什么都没有 */
ok(bkU.raw().indexOf('exam::') < 0, '**采纳只改草案**：题库里还没有这份卷（要等"确认入库"）', bkU.raw().slice(0, 120));

head('③-D 没有 Key / 不可直连：明确拦住，且**零请求**');

const bkNo = backend();
const stNo = A.openKeyStore(bkNo);                     // 有存储但没填 Key
const fNo = fakeFetch(plan3);
const noKey = await A.runSingle(stNo, fNo, 'dashscope', 'explain', ORIGIN, {}, {});
eq([noKey.ok, noKey.stage, noKey.requestCount], [false, 'call', 1], '没填 Key → 拒绝（阶段 call，因为 callSaved 里拦的）');
ok(/API Key/.test((noKey.errors || []).join('')), '  原因说得明白：' + (noKey.errors || []).join('；'));
eq(fNo.calls.length, 0, '  **零请求**（没 Key 就不该发出去）');

const bkO = backend();
const stO = await storeWithKey(bkO, 'openai');
const fO = fakeFetch(plan3);
const blocked = await A.runSingle(stO, fO, 'openai', 'explain', ORIGIN, {}, {});
eq([blocked.ok, blocked.stage, blocked.requestCount], [false, 'provider', 0], '不可直连的家 → 直接拒绝、请求数 0');
ok(/CORS/.test(blocked.hint || ''), '  并给出"为什么"：' + blocked.hint);
eq(fO.calls.length, 0, '  **零请求**');
const unknown = await A.runSingle(stO, fO, '没有这家', 'explain', ORIGIN, {}, {});
eq([unknown.ok, unknown.stage], [false, 'provider'], '未知供应商 → 拒绝');
const unknownKind = await A.runSingle(stO, fO, 'dashscope', '乱来', ORIGIN, {}, {});
eq([unknownKind.ok, unknownKind.stage, unknownKind.requestCount], [false, 'unknown', 0], '未知单题任务 → 拒绝且零请求');

head('④ 相邻锚：没有题目 / 空草案时也不炸，且不影响既有 AI 容错语义');

const emptyDraft = R.createDraft({ questions: [] }, { title: '空' }).draft;
const fEmpty = fakeFetch(plan3);
const emptyRun = await A.runSingle(await storeWithKey(backend()), fEmpty, 'dashscope', 'explain', null, {}, {});
eq([emptyRun.ok, emptyRun.stage, emptyRun.requestCount], [false, 'no_question', 0],
   '题目为 null → **当场拦住且零请求**（没题就没"单题"可言，别浪费一次调用）');
eq(fEmpty.calls.length, 0, '  假 fetch 一次都没被调用');
const blankRun = await A.runSingle(await storeWithKey(backend()), fEmpty, 'dashscope', 'explain', { type: '单选', stem: '   ' }, {}, {});
eq([blankRun.ok, blankRun.stage], [false, 'no_question'], '  题干只有空格 → 同样拦住');
eq(A.briefQuestion(null), '题型：未知\n题干：\n答案：（未给）', 'briefQuestion(null) 也给得出可读简报', A.briefQuestion(null));
eq(R.appendQuestion(emptyDraft, ORIGIN).draft.questions.length, 1, '空草案也能追加题目');
eq(R.setDifficulty(emptyDraft, 0, 3).ok, false, '  但给空草案的第 0 题设难度 → 明确失败（下标越界）');
eq(A.checkResult('keywords', { keywords: '不是数组' }).errors, ['keywords 应为数组'], '既有的 keywords 任务校验仍然有效');
eq(A.checkResult('review', { summary: '总评', weakPoints: ['a'], advice: ['b'] }).ok, true,
   'review 任务校验仍然有效（「整卷点评」小类起它还要求薄弱考点与建议，见 ai-scene.test.js）');
eq(A.checkResult('乱来', {}).ok, false, '未知任务的校验仍然拒绝');
eq(A.validate('explain', { explanation: 'x', pitfall: 'y' }).ok, true, 'validate 的口径与新结构一致');

console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
console.log('  PASS ' + pass + '    FAIL ' + fail);
if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
console.log('  \x1b[90m注：真 Key 端到端另见 node verify/real-ai.js（读 DASHSCOPE_API_KEY，不联网跑不了）\x1b[0m');
process.exitCode = fail ? 1 : 0;

})().catch(function (e) { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
