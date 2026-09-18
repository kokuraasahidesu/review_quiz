/* ============================================================
 *  test_api.js —— 真实 API 连通性测试（Node 侧跑，不需要浏览器）
 *
 *  用法：
 *    set DASHSCOPE_API_KEY=...   （或从注册表注入，见 README）
 *    node test_api.js [供应商] [模型]
 *
 *  测什么（curl 测不了的）：
 *    1) Key 是否有效、模型名是否可用
 *    2) 该模型是否支持 response_format: json_object（不支持会 400）
 *    3) 真实延迟、真实 token 消耗
 *    4) 真实输出能否被我们的容错解析器吃下并通过结构校验
 *
 *  安全：只从环境变量读 Key，任何输出都不打印 Key 本身。
 * ============================================================ */
const AiCore = require('./core/ai.js');

const KEY  = process.env.DASHSCOPE_API_KEY || '';
const PROV = process.argv[2] || 'dashscope';
const p    = AiCore.PROVIDERS[PROV];

let pass = 0, fail = 0;
const ok  = (c, t, d) => { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + d : '')))
                             : (fail++, console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d ? '   ' + d : ''))); };
const inf = (t, d) => console.log('  \x1b[36mINFO\x1b[0m  ' + t + (d ? '   ' + d : ''));
const head = t => console.log('\n\x1b[36m======== ' + t + ' ========\x1b[0m');

if (!p) { console.error('未知供应商: ' + PROV); process.exit(2); }
if (!KEY) {
  console.error('\n\x1b[31m没读到 DASHSCOPE_API_KEY\x1b[0m');
  console.error('先双击 D:\\apps\\tools\\set_dashscope_key.bat 设置好，再跑这个脚本。');
  process.exit(2);
}
inf('供应商', p.label + '   (' + p.base + ')');
inf('Key 状态', '已读到，长度 ' + KEY.length + '，前缀 ' + KEY.slice(0, 3) + '***（不打印完整内容）');

/* ---------- 原始探针：直接看 HTTP 状态，不被重试掩盖 ---------- */
async function rawProbe(jsonMode, model, user) {
  const req = AiCore.buildChatRequest(PROV, {
    apiKey: KEY, model: model, user: user, jsonMode: jsonMode, maxTokens: 200
  });
  const t0 = Date.now();
  try {
    const resp = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
    const text = await resp.text();
    const ms = Date.now() - t0;
    let content = '', usage = null;
    try {
      const j = JSON.parse(text);
      content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
      usage = j.usage || null;
    } catch (e) {}
    return { ok: resp.ok, status: resp.status, ms, text, content, usage };
  } catch (e) {
    const c = AiCore.classifyError(e, 0);
    return { ok: false, netError: true, ms: Date.now() - t0, kind: c.kind, text: c.text, hint: c.hint, err: e.message };
  }
}

(async function main() {
  const model = process.argv[3] || p.models[0];

  /* ===== 1. 不带 JSON 模式：最小请求（验 Key + 模型） ===== */
  head('1. 最小请求（不带 JSON 模式）—— 先确认 Key 和模型名有效');
  inf('模型', model);
  let r = await rawProbe(false, model, '回答一个字：好');
  if (r.netError) {
    ok(false, '请求发不出去', r.kind + ' / ' + r.text);
    inf('建议', r.hint);
    console.log('\n\x1b[31m网络层就失败了，后面的测试没意义，先解决这个。\x1b[0m');
    process.exit(1);
  }
  ok(r.ok, 'HTTP ' + r.status + '   耗时 ' + r.ms + ' ms', r.ok ? '' : r.text.slice(0, 200));
  if (!r.ok) {
    // Key/权限类问题重试没意义，直接中止，别让人干等后面几组全红
    if (r.status === 401 || r.status === 403 || r.status === 402) {
      const c = AiCore.classifyError(null, r.status);
      inf('分类 / 建议', c.text + '  →  ' + c.hint);
      console.log('\n\x1b[31mKey 或权限问题，已中止后续测试。\x1b[0m');
      console.log('  修好后重跑：node test_api.js');
      process.exit(1);
    }
    inf('提示', '这一步就失败了，后面几组大概率也会失败，继续跑只为看清具体报错');
  }
  if (r.ok) {
    inf('模型回复', JSON.stringify(r.content).slice(0, 120));
    if (r.usage) inf('token 消耗', 'prompt=' + r.usage.prompt_tokens + ' completion=' + r.usage.completion_tokens + ' total=' + r.usage.total_tokens);
  }

  /* ===== 2. 带 JSON 模式：测 response_format 支持 ===== */
  head('2. 带 response_format: json_object —— 测该模型支不支持');
  let rj = await rawProbe(true, model, '只输出 JSON，不要任何其他文字：{"ok":true,"note":"连通性测试"}');
  if (rj.ok) {
    ok(true, 'JSON 模式可用   耗时 ' + rj.ms + ' ms');
    inf('原始输出', JSON.stringify(rj.content).slice(0, 160));
    const parsed = AiCore.safeParseJson(rj.content);
    ok(parsed.ok, '输出能被容错解析器吃下', '策略=' + parsed.strategy + (parsed.fixes && parsed.fixes.length ? ' 修复=' + parsed.fixes.join('/') : ''));
  } else {
    ok(false, 'JSON 模式 HTTP ' + rj.status, rj.text.slice(0, 220));
    const c = AiCore.classifyError(null, rj.status);
    inf('分类 / 建议', c.text + '  →  ' + c.hint);
    if (rj.status === 400) {
      inf('重要', '该模型可能不支持 json_object → 实现时必须提供"关掉 JSON 模式 + 靠容错解析"的降级开关');
    }
  }

  /* ===== 3. 真实任务：生成解析 ===== */
  head('3. 真实任务 A：生成题目解析（走完整 callAi：重试+解析+结构校验）');
  let call = await AiCore.callAi(fetch, PROV, {
    apiKey: KEY, model: model, task: 'explain',
    system: AiCore.PROMPTS.explain,
    user: '题干：下列哪个协议工作在传输层？\n选项：A.HTTP  B.TCP  C.IP  D.ARP\n正确答案：B',
    jsonMode: true, temperature: 0.3
  });
  ok(call.ok, '生成解析成功' + (call.attempts ? '（请求 ' + call.attempts + ' 次）' : ''), call.ok ? '' : (call.kind + ' / ' + call.text));
  if (call.ok) {
    inf('解析策略', call.strategy + (call.fixes && call.fixes.length ? '  修复=' + call.fixes.join('/') : ''));
    inf('解析正文', String(call.value.explanation).slice(0, 140));
    inf('易错点', String(call.value.pitfall || '（未返回）').slice(0, 100));
  }

  /* ===== 4. 真实任务：生成变式题（最复杂的结构） ===== */
  head('4. 真实任务 B：举一反三生成变式题（结构最复杂，最容易翻车）');
  call = await AiCore.callAi(fetch, PROV, {
    apiKey: KEY, model: model, task: 'variant',
    system: AiCore.PROMPTS.variant,
    user: '原题：下列哪个协议工作在传输层？ A.HTTP B.TCP C.IP D.ARP 答案：B',
    jsonMode: true, temperature: 0.7
  });
  ok(call.ok, '生成变式题成功' + (call.attempts ? '（请求 ' + call.attempts + ' 次）' : ''), call.ok ? '' : (call.kind + ' / ' + call.text));
  if (call.ok) {
    const v = call.value;
    inf('题型', v.type);
    inf('题干', String(v.stem).slice(0, 120));
    if (v.options) inf('选项数', String(v.options.length) + ' 个: ' + v.options.map(o => o.label + '.' + String(o.text).slice(0, 14)).join('  '));
    inf('答案', String(v.answer));
    if (v.keywords) inf('关键词', (Array.isArray(v.keywords) ? v.keywords.join('、') : String(v.keywords)).slice(0, 100));
  }

  /* ===== 5. 真实任务：难度评估（数字型，最容易被写成散文） ===== */
  head('5. 真实任务 C：难度评估（1~5 数字型，考验模型守格式）');
  call = await AiCore.callAi(fetch, PROV, {
    apiKey: KEY, model: model, task: 'difficulty',
    system: AiCore.PROMPTS.difficulty,
    user: '题干：简述 TCP 三次握手的过程。',
    jsonMode: true
  });
  ok(call.ok, '难度评估成功', call.ok ? '' : (call.kind + ' / ' + call.text));
  if (call.ok) inf('返回', 'level=' + call.value.level + '  reason=' + String(call.value.reason || '').slice(0, 90));

  /* ===== 6. 项目自带的 estimateTokens 准不准（对着真实 usage 校一下） ===== */
  head('6. 校准 token 粗估（决定"批量操作消耗确认弹窗"的数字准不准）');
  const sampleText = '题干：下列哪个协议工作在传输层？选项：A.HTTP B.TCP C.IP D.ARP 正确答案：B。请生成解析。';
  const est = AiCore.estimateTokens(sampleText);
  const r2 = await rawProbe(false, model, sampleText);
  if (r2.ok && r2.usage) {
    const real = r2.usage.prompt_tokens;
    const err = Math.abs(est - real) / real;
    inf('本地估算 vs 服务端实际', est + ' vs ' + real + '  偏差 ' + (err * 100).toFixed(0) + '%');
    ok(err < 0.6, 'token 粗估在可接受范围（<60% 偏差）', '用于弹窗提示量级足够');
  } else {
    inf('跳过', '这次没拿到 usage');
  }

  console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
  console.log('  PASS ' + pass + '    FAIL ' + fail);
  console.log(fail ? '  \x1b[33m有失败项：看上面每个 FAIL 的 HTTP 状态与返回片段\x1b[0m'
                   : '  \x1b[32m全部通过：这家供应商可以直接用于阶段 3\x1b[0m');
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('测试脚本崩了: ' + (e && e.stack || e)); process.exit(2); });
