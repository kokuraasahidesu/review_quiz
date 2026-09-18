/* ============================================================
 *  verify/ai-keys.test.js —— 「密钥与供应商能力表」小类验收
 *
 *  运行： node verify/ai-keys.test.js
 *
 *  三条盘档验收标准，逐条对应：
 *    ① 填入 Key 后刷新页面仍保留，且能直接用于调用；
 *    ② 供应商列表展示各家的 JSON 模式与直连能力，不可直连的被明确标注；
 *    ③ 分享导出产物中不含密钥（扫描零命中）。
 *
 *  "刷新"怎么在 Node 里复现：换一个**新的 store 实例**（同一份后端）再读 ——
 *  这是本项目一贯的做法（旧内存缓存骗不过这一步）。真浏览器刷新见 自检页 O 节。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const HERE = path.join(__dirname, '..');
const A = require('../core/ai.js');
const D = require('../core/data.js');
const S = require('../core/schema.js');
const DOM = require('./mini-dom.js');
const AiSettings = require('../ui/ai-settings.js');

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

/* 一个"像 localStorage"的后端 + 能反复开新 store（模拟刷新） */
function backend() {
  const m = new Map();
  return {
    getItem: k => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: k => { m.delete(String(k)); },
    key: i => { const a = Array.from(m.keys()); return i < a.length ? a[i] : null; },
    get length() { return m.size; },
    rawKeys: () => Array.from(m.keys()),
    rawText: () => Array.from(m.values()).join('\n')
  };
}
const CANARY = 'sk-canary-9f3a7c1e5b2d4680zz';      // 只在本文件里用；成品里出现即泄漏

(async function main() {

/* ============================================================ */
head('②-A 能力表：每家都必须显式声明 JSON 模式与直连能力');

const rows = A.providerRows();
eq(rows.length, 6, '表里有 6 家供应商');
eq(A.capabilityGaps(), [], '**没有一家漏写能力位**（capabilityGaps 为空：不接受 undefined 混过去）');
eq(rows.map(r => r.key), ['dashscope', 'deepseek', 'zhipu', 'moonshot', 'ark', 'openai'], ' 顺序稳定（界面按行渲染）');
ok(rows.every(r => typeof r.jsonMode === 'boolean'), '每家都有明确的 jsonMode 布尔值');
ok(rows.every(r => typeof r.browserDirect === 'boolean'), '每家都有明确的 browserDirect 布尔值');
ok(rows.every(r => /JSON 模式/.test(r.jsonModeLabel)), '每家都给出可读的 JSON 模式标注',
   rows.map(r => r.jsonModeLabel)[0]);
ok(rows.every(r => /直连/.test(r.directLabel)), '每家都给出可读的直连标注', rows.map(r => r.directLabel).join(' | '));

head('②-B 不可直连的家必须被**明确标注**（不是等用户填完 Key 再报错）');

const blocked = rows.filter(r => !r.browserDirect);
eq(blocked.map(r => r.key), ['openai'], '不可浏览器直连的就这几家：' + blocked.map(r => r.label).join('、'));
ok(blocked.every(r => r.directNote && r.directNote.length > 8), '每家都带一句"为什么不可直连"的说明',
   blocked.map(r => r.directNote).join(' | '));
ok(/CORS/i.test(blocked[0].directNote), '  OpenAI 的说明点到了 CORS（这才是真正的原因）', blocked[0].directNote);
ok(blocked[0].directLabel === '不可浏览器直连', '  标注文案本身就说清了结论：' + blocked[0].directLabel);
ok(rows.filter(r => r.browserDirect).every(r => r.directLabel === '可浏览器直连'), '可直连的 5 家标注为"可浏览器直连"');
eq(rows.filter(r => r.browserDirect).length, 5, '  可直连 5 家 / 不可直连 1 家');
ok(rows.every(r => r.cors && r.cors.length > 4), '每行还带着实测 CORS 依据（审计时能对上）',
   rows.map(r => r.key + ':' + r.cors).join(' | '));
ok(rows.every(r => r.models.length >= 2), '每家至少有 2 个可用模型');
ok(rows.every(r => /^https:\/\//.test(r.base)), '每家的 base 都是 https 端点');

head('①-A 存 Key：只写进**独立命名空间** secret');

const bk = backend();
const store = A.openKeyStore(bk);
eq([A.secretNamespace(), A.keysKey()], ['secret', 'apiKeys'], '命名空间与键名由核心统一给（不许别处手拼）');
eq(store.namespace, 'secret', '密钥 store 的命名空间就是 secret（与题库/记录的 app 分开）');
eq(bk.rawKeys(), [], '  刚开出来时后端是空的');

const bad1 = await A.saveKey(store, '不存在的家', 'sk-x');
eq([bad1.ok, /未知供应商/.test(bad1.error || '')], [false, true], '未知供应商 → 明确拒绝');
const bad2 = await A.saveKey(store, 'deepseek', '   ');
eq([bad2.ok, /空的/.test(bad2.error || '')], [false, true], '空 Key → 明确拒绝（想删请用「清除」，别用空值蒙混）');
const bad3 = await A.saveKey(store, 'deepseek', 'sk-abc\ndef');
eq([bad3.ok, /空白/.test(bad3.error || '')], [false, true], 'Key 里带换行/空白 → 明确拒绝（多半是复制带的）');
eq(bk.rawKeys(), [], '三条拒绝路径都**没有写盘**');

const saved = await A.saveKey(store, 'dashscope', CANARY, { now: '2026-10-26T10:00:00.000Z' });
eq([saved.ok, saved.provider, saved.persisted], [true, 'dashscope', true], '存一把百炼的 Key');
eq(saved.masked, 'sk-c…80zz', '返回值只给遮罩（原文不回传，免得顺着日志乱跑）', saved.masked);
ok(JSON.stringify(saved).indexOf(CANARY) < 0, '  **返回值里没有 Key 原文**');
ok(bk.rawKeys().indexOf('secret::apiKeys') >= 0, '密钥落在 secret 命名空间的那把键上', JSON.stringify(bk.rawKeys()));
ok(bk.rawKeys().every(k => k.indexOf('secret::') === 0), '  后端里的每一把键都在 secret 命名空间（没有 app:: 的身影）',
   JSON.stringify(bk.rawKeys()));
ok(bk.rawText().indexOf(CANARY) >= 0, '  原文确实存在本机后端里（这才有得读）');
ok(bk.rawText().indexOf('app::') < 0, '  密钥记录**不在** app 命名空间（分享走的就是 app/recv 那条路）');

head('①-B 刷新仍保留（换新 store 实例 = 关掉页面再打开）');

const store2 = A.openKeyStore(bk);                        // ← 相当于 F5 之后重新开页面
const hk = await A.hasKey(store2, 'dashscope');
eq([hk.ok, hk.configured], [true, true], '新实例里：这家已配置');
const rk = await A.readKey(store2, 'dashscope');
eq([rk.configured, rk.apiKey], [true, CANARY], '**原文读得回来（可直接用于调用）**');
eq(rk.at, '2026-10-26T10:00:00.000Z', '  保存时刻也留着');
eq((await A.hasKey(store2, 'deepseek')).configured, false, '没填过的家仍报未配置');

const m2 = await A.keyModel(store2);
eq([m2.rows.length, m2.configuredCount, m2.callableCount], [6, 1, 1], '视图模型：6 家 / 已填 1 / 现在就能调用 1');
const rowDash = m2.rows.filter(r => r.key === 'dashscope')[0];
eq([rowDash.configured, rowDash.masked, rowDash.callable, rowDash.blockReason], [true, 'sk-c…80zz', true, ''],
   '已填且可直连 → callable=true、没有阻塞原因');
const rowOA = m2.rows.filter(r => r.key === 'openai')[0];
eq([rowOA.configured, rowOA.browserDirect, rowOA.callable], [false, false, false], 'OpenAI：不可直连 → 永远不可调用');
ok(/CORS/.test(rowOA.blockReason), '  阻塞原因直接给出"为什么"：' + rowOA.blockReason);
eq(m2.blocked, ['openai'], '模型里单列出被阻塞的家：' + m2.blocked.join('、'));
eq((await A.usableProviders(store2)).providers, ['dashscope'], 'usableProviders 只给"已填 + 可直连"的家');

head('①-C 能**直接用于调用**：保存的 Key 真的进了请求头');

const calls = [];
const fakeFetch = async function (url, init) {
  calls.push({ url: url, headers: Object.assign({}, init.headers), body: init.body });
  return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"level":3,"reason":"中等"}' } }] }) };
};
const c1 = await A.callSaved(store2, fakeFetch, 'deepseek', { task: 'difficulty', user: '题面' });
eq([c1.ok, c1.kind, c1.text], [false, 'no_key', '还没填 DeepSeek 的 API Key'], '没填 Key 的家 → 直接拦住，不发请求');
eq(calls.length, 0, '  **一个请求都没发出去**');

const savedOA = await A.saveKey(store2, 'openai', CANARY, { now: '2026-10-26T11:00:00.000Z' });
eq(savedOA.ok, true, '（假设用户硬要填 OpenAI 的 Key 也存得下）');
const c2 = await A.callSaved(store2, fakeFetch, 'openai', { task: 'difficulty', user: '题面' });
eq([c2.ok, c2.kind], [false, 'no_direct'], '不可直连的家 → 拦住');
ok(/CORS/.test(c2.hint || ''), '  并把"为什么"告诉用户：' + c2.hint);
eq(calls.length, 0, '  **照样一个请求都没发**（不让用户对着 CORS 报错猜）');

const c3 = await A.callSaved(store2, fakeFetch, 'dashscope', { task: 'difficulty', user: '题目：1+1=?', jsonMode: true });
eq([c3.ok, c3.usingSavedKey, c3.provider, c3.attempts], [true, true, 'dashscope', 1], '已填 + 可直连 → 真发出去了且解析成功');
eq(calls.length, 1, '  正好 1 次请求');
eq(calls[0].headers.Authorization, 'Bearer ' + CANARY, '**请求头里就是刚保存的那把 Key**（这才叫"能直接用于调用"）');
eq(calls[0].url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', '  打的是这家自己的端点');
ok(calls[0].body.indexOf('json_object') >= 0, '  JSON 模式按能力表开着（response_format 进了请求体）');
const c4 = await A.callSaved(store2, fakeFetch, 'unknown-x', { task: 'difficulty' });
eq([c4.ok, c4.kind], [false, 'unknown_provider'], '未知供应商 → 拦住');
eq(calls.length, 1, '  仍然没发请求');

head('①-D 清除与版本门禁：删得掉、坏数据不认');

const cl = await A.clearKey(store2, 'deepseek');
eq([cl.ok, cl.cleared], [true, false], '清一个本来没填的家 → 如实说"本来就没有"');
const cl2 = await A.clearKey(store2, 'openai');
eq([cl2.ok, cl2.cleared], [true, true], '清掉 OpenAI → 确实清了');
eq((await A.readKey(A.openKeyStore(bk), 'openai')).configured, false, '**新实例里也确实没了**（清除落盘了）');
eq((await A.keyModel(A.openKeyStore(bk))).callableCount, 1, '  剩下的可调用家仍是 1（百炼那条没被连累）');

const bkBad = backend();
bkBad.setItem('secret::apiKeys', JSON.stringify({ v: 99, keys: { dashscope: { key: CANARY, at: 't' } } }));
const storeBad = A.openKeyStore(bkBad);
const mb = await A.keyModel(storeBad);
eq([mb.ok, mb.configuredCount], [true, 0], '版本不认识的密钥记录 → **一条都不认**（不猜、不部分读）');
const rb = await A.readKey(storeBad, 'dashscope');
eq([rb.ok, rb.configured, rb.apiKey], [true, false, ''], '  读原文也读不到（降级为"没填"）');
const bkShape = backend();
bkShape.setItem('secret::apiKeys', JSON.stringify({ v: 1, keys: [] }));
eq((await A.readKey(A.openKeyStore(bkShape), 'dashscope')).configured, false, 'keys 形状不对 → 也当没填（不炸）');

const savedNoStore = await A.saveKey(null, 'zhipu', CANARY);
eq([savedNoStore.ok, savedNoStore.persisted], [true, false], '存储不可用时：写入"成功"但如实报 persisted=false');
eq((await A.readKey(null, 'zhipu')).configured, false, '  **读不回来**（不给用户"存住了"的错觉）');

head('①-E 存储不可用时界面必须说实话（不许显示"刷新后仍在"）');

const docNo = DOM.makeDoc();
const hostNo = docNo.createElement('div');
docNo.documentElement.appendChild(hostNo);
const panelNo = AiSettings.mount({ container: hostNo, store: null });
await panelNo.refresh();
const inNo = DOM.byAttr(hostNo, 'data-as', 'input').filter(n => n.getAttribute('data-as-provider') === 'dashscope')[0];
inNo.value = CANARY;
DOM.byAttr(hostNo, 'data-as', 'save').filter(n => n.getAttribute('data-as-provider') === 'dashscope')[0].click();
await new Promise(function (r) { setTimeout(r, 0); });
ok(hostNo.textContent.indexOf('没写进本地存储') >= 0, '存储不可用 → 提示"没写进本地存储（刷新后就没了）"',
   (hostNo.textContent.match(/没写进本地存储[^）]*）?/) || [''])[0]);
ok(hostNo.textContent.indexOf('刷新后仍在') < 0, '  **不再谎报**"刷新后仍在"');
ok(hostNo.textContent.indexOf('存储不可用') >= 0, '  顶部一开始就打了预防针');
eq(DOM.byAttr(hostNo, 'data-as', 'status').length, 1, '  提示挂在**重画之外的状态行**上（不会刚设上就被刷新抹掉）');
panelNo.destroy();

head('③-A 分享产物零命中（真密钥 + 结构白名单双扫描）');

const exam = S.createExam({
  id: 'SHARE1', title: '要分享的卷', schemaVersion: S.SCHEMA_VERSION,
  questions: [S.createQuestion({ id: 'SHARE1-q1', type: '单选', stem: '题干', options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }], answerLetters: ['A'], explanation: '解析' })]
}, { now: '2026-10-26T12:00:00.000Z' });
const state = { exams: [exam], settings: { config: null }, records: [{ at: 't', score: 1 }], wrongBook: { SHARE1: {} } };
const payload = D.sanitizeSharePayload(state, { examId: 'SHARE1' });
const keysInStore = await A.allKeys(A.openKeyStore(bk));
eq(keysInStore.sort(), [CANARY].sort(), '前置：本机确实存着 1 把真 Key');

/* 真产物扫描：正文（JSON）+ 内嵌成单文件 HTML 之后的内容 */
const json = JSON.stringify(payload);
const html = D.embedPayload('<html><body>要发给别人的卷</body></html>', payload, { secrets: keysInStore });
const s1 = A.scanForSecrets(json, keysInStore);
const s2 = A.scanForSecrets(html, keysInStore);
eq([s1.ok, s1.hits.length, s2.ok, s2.hits.length], [true, 0, true, 0], '**分享载荷与分享 HTML 里都零命中**');
ok([json, html].every(t => t.indexOf(CANARY) < 0), '  连 Key 原文的子串都没有：' + brief(CANARY));
ok([json, html].every(t => t.indexOf(CANARY.slice(-6)) < 0), '  尾部特征片段也没有');
eq(D.findSecrets(payload), [], '结构白名单：分享载荷里没有任何敏感字段名/疑似密钥串');
eq(Object.keys(payload).sort(), ['exams', 'exportedAt', 'kind', 'schemaVersion'], '  载荷顶层键就是这 4 个（settings/records/wrongBook 连键都不出现）');
ok(json.indexOf('apiKeys') < 0 && json.indexOf('secret::') < 0 && json.indexOf('Bearer') < 0,
   '  载荷里没有 apiKeys / secret:: / Bearer 这些痕迹');

head('③-B 反向对照：把 Key 藏进题干这种"真会发生的泄漏"，两道闸门必须抓到');

/* 分享载荷是**白名单**重建的：往试卷对象上硬塞 apiKey 字段根本进不去（这是更强的一层保护）。
 * 真正会发生的泄漏是"用户把 Key 粘进了题干/解析"——那条路是白名单**允许**的，必须被文本扫描抓到。 */
const dirtyExam = Object.assign({}, exam, { apiKey: CANARY, token: 'abc' });
const dirtyPayload = D.sanitizeSharePayload({ exams: [dirtyExam] }, {});
eq(D.findSecrets(dirtyPayload), [], '往试卷对象上塞 apiKey/token → **载荷里根本不会出现**（白名单重建，注入字段被整个丢掉）');
eq(JSON.stringify(dirtyPayload).indexOf(CANARY) < 0, true, '  原文也没跟着进去');
const fsHits = D.findSecrets({ apiKey: CANARY });
eq(fsHits.length, 2, '  但 findSecrets 本身是真会抓的（字段名 + 密钥形状各报一条，证明不是恒真）',
   JSON.stringify(fsHits.map(h => h.why)));

const leakyExam = S.createExam({
  id: 'SHARE2', title: '粘贴事故', schemaVersion: S.SCHEMA_VERSION,
  questions: [S.createQuestion({ id: 'SHARE2-q1', type: '简答', stem: '题干里不小心粘了 ' + CANARY + ' 这串', keywords: [{ text: '甲' }] })]
}, { now: '2026-10-26T13:00:00.000Z' });
const leakyJson = JSON.stringify(D.sanitizeSharePayload({ exams: [leakyExam] }, {}));
const leakScan = A.scanForSecrets(leakyJson, keysInStore);
eq(leakScan.ok, false, '**题干里粘了 Key → 分享文本扫描立刻变红**（说明它不是在测空气）',
   JSON.stringify(leakScan.hits));
eq(leakScan.hits.map(h => h.kind), ['full'], '  报的是"完整 Key 命中"');
/* 尾部片段扫描单独验一次：只留尾巴的文本也必须被认出来 */
const tailOnly = '日志片段：…' + CANARY.slice(-6);
eq(A.scanForSecrets(tailOnly, keysInStore).hits.map(h => h.kind), ['tail'], '只露出尾部 6 个字符的文本也会被抓到');
eq(A.scanForSecrets('跟密钥无关的一段话', keysInStore).ok, true, '  普通文本当然不报（不误伤）');
eq(A.scanForSecrets('', keysInStore).ok, true, '  空文本也不报');
eq(A.scanForSecrets('随便什么', []).ok, true, '  没有已保存的 key 时扫描恒为通过（scanned=0）',
   JSON.stringify(A.scanForSecrets('随便什么', [])));

head('③-C 交付产物本身不含任何"像密钥"的串（扫描 5 个成品文件）');

const artifacts = ['解析器Demo.html', '浏览器自检.html', '校对面板.html', '答题页.html', '错题本.html'];
const hitsByFile = artifacts.map(function (f) {
  const t = fs.readFileSync(path.join(HERE, f), 'utf8');
  return { file: f, hits: (t.match(/sk-[A-Za-z0-9_\-]{16,}/g) || []).length };
});
eq(hitsByFile.map(h => h.hits), [0, 0, 0, 0, 0], '**5 个成品里都没有 sk- 开头的长串**',
   JSON.stringify(hitsByFile));
const keyMentions = artifacts.map(function (f) {
  const t = fs.readFileSync(path.join(HERE, f), 'utf8');
  return { file: f, n: (t.match(/secret::apiKeys/g) || []).length };
});
eq(keyMentions.map(h => h.n), [0, 0, 0, 0, 0], '  也没有把密钥键名硬编码进页面（键名只由核心给）', JSON.stringify(keyMentions));

head('⑤ 界面（真挂载）：遮罩显示、不可直连禁用输入、DOM 里不留原文');

const doc = DOM.makeDoc();
const host = doc.createElement('div');
doc.documentElement.appendChild(host);
const bk2 = backend();
const panel = AiSettings.mount({ container: host, store: A.openKeyStore(bk2),
  onChange: function () {} });
const m5 = await panel.refresh();
eq(m5.rows.length, 6, '面板把 6 家都画出来（模型直接来自 AiCore.keyModel）');
const rowsDom = DOM.byAttr(host, 'data-as', 'input');
eq(rowsDom.length, 6, '每家一个输入框');
eq(rowsDom.every(n => n.type === 'password'), true, '**输入框全是 type=password**（不裸显）');
const oaInput = rowsDom.filter(n => n.getAttribute('data-as-provider') === 'openai')[0];
eq(oaInput.disabled, true, '不可直连的家：输入框**直接禁用**（填了也用不了，别让用户白折腾）');
eq(DOM.byAttr(host, 'data-as', 'save').filter(n => n.getAttribute('data-as-provider') === 'openai')[0].disabled, true,
   '  保存按钮同样禁用');
eq(DOM.byAttr(host, 'data-as', 'blocked-note').length, 1, '  红标 + 一条"为什么不可直连"的说明');
ok(DOM.byAttr(host, 'data-as', 'blocked-note')[0].textContent.indexOf('CORS') >= 0, '  说明里点到 CORS');
eq(DOM.byAttr(host, 'data-as', 'blocked-note')[0].parentNode.className.indexOf('blocked') >= 0, true,
   '  整行带 blocked 样式（一眼能看出与别家不同）');
/* ⚠ 文案在"删小字"那一轮精简过：现在写的是「密钥只存本机，不上传、不随分享文件导出；本页只显示遮罩。」
 *   判据跟着锚**意图**（三条承诺都要写在脸上），不再逐字钉那句已删的"独立命名空间 secret"
 *   —— 命名空间是实现细节，用户不需要知道。 */
ok(host.textContent.indexOf('只存本机') >= 0 && host.textContent.indexOf('不上传') >= 0,
   '界面上明写"只存本机、不上传"');
ok(host.textContent.indexOf('不随分享文件导出') >= 0, '  也明写"不随分享文件导出"（北极星要求写在脸上）');

const dsInput = rowsDom.filter(n => n.getAttribute('data-as-provider') === 'dashscope')[0];
eq(dsInput.disabled, false, '可直连的家：输入框可用');
dsInput.value = CANARY;
DOM.byAttr(host, 'data-as', 'save').filter(n => n.getAttribute('data-as-provider') === 'dashscope')[0].click();
await new Promise(function (r) { setTimeout(r, 0); });      // 等异步保存落定
eq(panel.stats().saves, 1, '点「保存」→ 保存动作发生 1 次');
eq(bk2.rawText().indexOf(CANARY) >= 0, true, '  真写进了本机后端');
eq(host.textContent.indexOf(CANARY) < 0, true, '**DOM 里找不到 Key 原文**（只显示遮罩）');
eq(host.textContent.indexOf('sk-c…80zz') >= 0, true, '  显示的是遮罩形态：sk-c…80zz');
const dsInput2 = DOM.byAttr(host, 'data-as', 'input').filter(n => n.getAttribute('data-as-provider') === 'dashscope')[0];
eq(String(dsInput2.value || ''), '', '  保存后输入框被清空（原文不在 DOM 里留着）', String(dsInput2.value));
eq(DOM.byAttr(host, 'data-as', 'masked').length, 1, '  多出一行"已保存：遮罩"');
DOM.byAttr(host, 'data-as', 'clear').filter(n => n.getAttribute('data-as-provider') === 'dashscope')[0].click();
await new Promise(function (r) { setTimeout(r, 0); });
eq(panel.stats().clears, 1, '点「清除」→ 清除动作发生 1 次');
eq(panel.rows().filter(r => r.key === 'dashscope')[0].configured, false, '  模型里已变成未配置');
eq(JSON.parse(bk2.getItem('secret::apiKeys')).keys, {}, '  后端里那把键还在、内容已清空（只清内容，不删键）',
   bk2.getItem('secret::apiKeys'));
panel.destroy();
eq(DOM.byAttr(host, 'data-as-root').length, 0, 'destroy 后从容器里摘干净');

console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
console.log('  PASS ' + pass + '    FAIL ' + fail);
if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
console.log('  \x1b[90m注：真浏览器刷新后的保留 → 见 浏览器自检.html 的 O 节（两阶段）\x1b[0m');
process.exitCode = fail ? 1 : 0;

})().catch(function (e) { console.error('崩了: ' + (e && e.stack || e)); process.exit(2); });
