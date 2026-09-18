/* ============================================================
 *  core/ai.js —— AI 调用层（密钥与供应商能力表 + 请求构造 + 输出容错 + 错误分类）
 *
 *  已验证：5 家国产服务商的 CORS 都允许 file:// 的 Origin(null)，所以"纯前端直连"成立；
 *  第 6 家（OpenAI）实测**没有** CORS 头，浏览器直连必被拦 —— 这条必须显式标出来，
 *  而不是等用户填完 Key 再对着一个看不懂的报错发呆。
 *  真正会崩的地方是：模型不老实返回 JSON。这一层就是对症下药。
 *
 *  密钥纪律（**不要绕过这几条**）：
 *    · Key 只写进**独立命名空间** `secret`（与题库/记录的 `app` 分开）；
 *    · 键名由本模块统一给（不许别处手拼），且**不进任何分享载荷**（`scanForSecrets` 可直接扫产物）；
 *    · 界面只展示 `maskKey` 的遮罩形态，原文只在发起请求那一刻读出来。
 * ============================================================ */
(function (root, factory) {
  const isNode = (typeof module !== 'undefined' && module.exports);
  const DataCore = isNode ? require('./data.js') : root.DataCore;
  const SchemaCore = isNode ? require('./schema.js') : root.SchemaCore;
  const ExamsCore = isNode ? require('./exams.js') : root.ExamsCore;
  const QuizCore = isNode ? require('./quiz.js') : root.QuizCore;
  if (!DataCore || !SchemaCore || !ExamsCore || !QuizCore) throw new Error('AiCore 依赖 DataCore / SchemaCore / ExamsCore / QuizCore，加载顺序错了');
  const api = factory(DataCore, SchemaCore, ExamsCore, QuizCore);
  if (isNode) module.exports = api;
  root.AiCore = api;
})(typeof self !== 'undefined' ? self : this, function (DataCore, SchemaCore, ExamsCore, QuizCore) {
  'use strict';

  /* ---------------- 供应商表（全部走 OpenAI 兼容协议） ----------------
   * `browserDirect` 必须**显式**写死（不要去解析 cors 文案）：这是给用户看的承诺，
   * 也是 `callSaved` 的前置判断。改一家就改一行，别让界面去猜。 */
  const PROVIDERS = {
    dashscope: {
      label: '阿里百炼 DashScope', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      models: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen-long'],
      jsonMode: true,           // 支持 response_format: json_object
      cors: 'allow-origin: *',  // 实测
      browserDirect: true, directNote: '',
      keyHint: '以 sk- 开头，控制台「API-KEY 管理」里创建',
      note: '国内直连快，兼容模式'
    },
    deepseek: {
      label: 'DeepSeek', base: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      jsonMode: true, cors: 'allow-origin: null（专为本地页面开门）',
      browserDirect: true, directNote: '',
      keyHint: '以 sk- 开头',
      note: '便宜，适合批量生成变式题'
    },
    zhipu: {
      label: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4',
      models: ['glm-4-plus', 'glm-4-flash', 'glm-4-air'],
      jsonMode: true, cors: 'allow-origin: null',
      browserDirect: true, directNote: '',
      keyHint: '形如 xxxx.yyyy（id.secret）',
      note: 'flash 档便宜'
    },
    moonshot: {
      label: 'Moonshot Kimi', base: 'https://api.moonshot.cn/v1',
      models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
      jsonMode: true, cors: 'allow-origin: null',
      browserDirect: true, directNote: '',
      keyHint: '以 sk- 开头',
      note: '长文本强'
    },
    ark: {
      label: '火山方舟（豆包）', base: 'https://ark.cn-beijing.volces.com/api/v3',
      models: ['doubao-pro-32k', 'doubao-lite-32k'],
      jsonMode: true, cors: 'allow-origin: null',
      browserDirect: true, directNote: '',
      keyHint: '方舟控制台的 API Key',
      note: '需先在控制台创建接入点，模型名填 endpoint id'
    },
    openai: {
      label: 'OpenAI', base: 'https://api.openai.com/v1',
      models: ['gpt-4o-mini', 'gpt-4o'],
      jsonMode: true, cors: '❌ 实测无 CORS 头，浏览器直连会被拦',
      browserDirect: false,
      directNote: '这家没有开放 CORS，浏览器（含本页）直连一定被拦。要用它得自己搭个中转（或换上面任意一家）。',
      keyHint: '以 sk- 开头',
      note: '不可直连；必须中转'
    }
  };

  const PROVIDER_KEYS = Object.keys(PROVIDERS);

  function rowOf(providerKey) {
    const p = PROVIDERS[providerKey];
    if (!p) return null;
    return {
      key: providerKey, label: p.label, base: p.base,
      models: (p.models || []).slice(),
      jsonMode: !!p.jsonMode,
      jsonModeLabel: p.jsonMode ? '支持 JSON 模式' : '不支持 JSON 模式（需容错解析）',
      browserDirect: !!p.browserDirect,
      directLabel: p.browserDirect ? '可浏览器直连' : '不可浏览器直连',
      directNote: p.directNote || (p.browserDirect ? '' : '该服务未开放 CORS，浏览器直连会被拦'),
      cors: p.cors || '',
      keyHint: p.keyHint || '',
      note: p.note || ''
    };
  }

  /* 能力表（界面就是照行渲染的；文案只此一份） */
  function providerRows() { return PROVIDER_KEYS.map(rowOf); }

  /* 自检：每家都必须**显式**declared 两个能力位，谁忘了写就当场列出来（不许 undefined 混过去） */
  function capabilityGaps() {
    const gaps = [];
    PROVIDER_KEYS.forEach(function (k) {
      const p = PROVIDERS[k];
      if (typeof p.jsonMode !== 'boolean') gaps.push({ provider: k, field: 'jsonMode' });
      if (typeof p.browserDirect !== 'boolean') gaps.push({ provider: k, field: 'browserDirect' });
      if (p.browserDirect === false && !p.directNote) gaps.push({ provider: k, field: 'directNote' });
      if (!Array.isArray(p.models) || !p.models.length) gaps.push({ provider: k, field: 'models' });
    });
    return gaps;
  }

  /* ============================================================
   *  密钥本地化
   * ============================================================ */

  const SECRET_NAMESPACE = 'secret';   // 与 app / recv_<examId> 分开的独立空间（契约第十一章）
  const KEYS_KEY = 'apiKeys';          // 命名空间内的键名（唯一真相源，别处不许手拼）
  const KEYS_VERSION = 1;

  function keysKey() { return KEYS_KEY; }
  function secretNamespace() { return SECRET_NAMESPACE; }

  /* 用页面给的 localStorage 开一个**专用** store；拿不到就返回 null（调用方降级为内存态） */
  function openKeyStore(backend) {
    if (!backend) return null;
    try {
      return DataCore.createStore({ small: backend, large: null, namespace: SECRET_NAMESPACE });
    } catch (e) { return null; }
  }

  /* 只露头尾：sk-abcd…wxyz。太短就整串遮掉（别把短 key 露光） */
  function maskKey(key) {
    const s = String(key == null ? '' : key);
    if (!s) return '';
    if (s.length <= 8) return '•'.repeat(s.length);
    return s.slice(0, 4) + '…' + s.slice(-4);
  }

  function emptyBook() { return { v: KEYS_VERSION, keys: {} }; }

  function checkKeysPayload(payload) {
    if (payload == null) return { ok: true, book: emptyBook(), empty: true };
    if (typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'shape', message: '密钥记录形状不对' };
    if (payload.v !== KEYS_VERSION) return { ok: false, reason: 'version', message: '密钥记录版本不匹配（' + payload.v + ' ≠ ' + KEYS_VERSION + '）' };
    if (!payload.keys || typeof payload.keys !== 'object' || Array.isArray(payload.keys)) return { ok: false, reason: 'shape', message: '密钥记录缺少 keys' };
    return { ok: true, book: { v: KEYS_VERSION, keys: payload.keys }, empty: false };
  }

  async function loadBook(store) {
    if (!store) return { ok: true, book: emptyBook(), empty: true, degraded: true };
    let payload = null;
    try { payload = await store.get(KEYS_KEY); }
    catch (e) { return { ok: true, book: emptyBook(), empty: true, degraded: true, error: (e && e.message) || String(e) }; }
    const c = checkKeysPayload(payload);
    if (!c.ok) return Object.assign({ book: emptyBook(), empty: true }, c);
    return c;
  }

  function fail(error, extra) { return Object.assign({ ok: false, error: error }, extra || {}); }

  /*
   * 存一把 Key。已知供应商才收；空串 = 明确报错（想删请用 clearKey，别用空值蒙混）。
   * 返回值**不含** key 原文（只回遮罩），免得它顺着日志/界面到处跑。
   */
  async function saveKey(store, providerKey, key, opts) {
    const o = opts || {};
    const row = rowOf(providerKey);
    if (!row) return fail('未知供应商：' + providerKey);
    const raw = String(key == null ? '' : key).trim();
    if (!raw) return fail('Key 是空的：要么填一个，要么用「清除」删掉', { provider: providerKey });
    if (/\s/.test(raw)) return fail('Key 里不该有空白字符（多半是复制时带上了换行）', { provider: providerKey });
    const loaded = await loadBook(store);
    const book = loaded.book;
    const at = o.now || new Date().toISOString();
    book.keys[providerKey] = { key: raw, at: at };
    if (store) {
      try { await store.set(KEYS_KEY, { v: KEYS_VERSION, keys: book.keys }); }
      catch (e) { return fail('密钥没写进本地存储：' + ((e && e.message) || e), { provider: providerKey, degraded: true }); }
    }
    return { ok: true, provider: providerKey, masked: maskKey(raw), at: at, persisted: !!store };
  }

  async function clearKey(store, providerKey) {
    const row = rowOf(providerKey);
    if (!row) return fail('未知供应商：' + providerKey);
    const loaded = await loadBook(store);
    const book = loaded.book;
    const had = !!book.keys[providerKey];
    delete book.keys[providerKey];
    if (store) {
      try { await store.set(KEYS_KEY, { v: KEYS_VERSION, keys: book.keys }); }
      catch (e) { return fail('清除没写进本地存储：' + ((e && e.message) || e)); }
    }
    return { ok: true, provider: providerKey, cleared: had };
  }

  /* 读原文 —— **只给发起请求用**；界面请用 keyModel 的遮罩 */
  async function readKey(store, providerKey) {
    const loaded = await loadBook(store);
    const hit = loaded.book.keys[providerKey];
    return { ok: true, provider: providerKey, apiKey: hit ? String(hit.key) : '', at: hit ? hit.at : '', configured: !!hit };
  }

  async function hasKey(store, providerKey) {
    const r = await readKey(store, providerKey);
    return { ok: true, provider: providerKey, configured: r.configured };
  }

  /* 视图模型：能力标注 + 配置状态 + 能否立刻调用（三合一，界面不用自己拼判断） */
  async function keyModel(store) {
    const loaded = await loadBook(store);
    const rows = providerRows().map(function (r) {
      const hit = loaded.book.keys[r.key];
      return Object.assign({}, r, {
        configured: !!hit,
        masked: hit ? maskKey(hit.key) : '',
        savedAt: hit ? (hit.at || '') : '',
        callable: !!hit && r.browserDirect,
        blockReason: !r.browserDirect ? r.directNote : (!hit ? ('还没填 ' + r.label + ' 的 API Key') : '')
      });
    });
    return {
      ok: true, degraded: !!loaded.degraded, rows: rows,
      configuredCount: rows.filter(function (r) { return r.configured; }).length,
      callableCount: rows.filter(function (r) { return r.callable; }).length,
      blocked: rows.filter(function (r) { return !r.browserDirect; }).map(function (r) { return r.key; })
    };
  }

  /* 现在就能直接调用的供应商（过滤掉"没 key"和"不可直连"两类） */
  async function usableProviders(store) {
    const m = await keyModel(store);
    return { ok: true, providers: m.rows.filter(function (r) { return r.callable; }).map(function (r) { return r.key; }) };
  }

  /*
   * 分享/导出前的**硬闸门**：把要发出去的文本扫一遍，命中了任何一把原文或它的特征片段就报警。
   * 为什么连"片段"也扫：完整 key 太显眼，反而是尾部片段容易被截进日志/示例里带出去。
   */
  function scanForSecrets(text, keys) {
    const s = String(text == null ? '' : text);
    const list = (Array.isArray(keys) ? keys : []).map(function (k) { return String(k || ''); }).filter(Boolean);
    const hits = [];
    list.forEach(function (k, i) {
      if (s.indexOf(k) >= 0) { hits.push({ index: i, kind: 'full', sample: maskKey(k) }); return; }
      if (k.length >= 8) {
        const tail = k.slice(-6);
        if (tail && s.indexOf(tail) >= 0) hits.push({ index: i, kind: 'tail', sample: '…' + tail.slice(-4) });
      }
    });
    return { ok: hits.length === 0, hits: hits, scanned: list.length, bytes: s.length };
  }

  /* 把存储里所有已保存的 key 原文取出来（只为跑 scanForSecrets，别拿去做别的） */
  async function allKeys(store) {
    const loaded = await loadBook(store);
    return Object.keys(loaded.book.keys).map(function (k) { return String(loaded.book.keys[k].key); });
  }

  /* ============================================================
   *  请求构造
   * ============================================================ */
  function buildChatRequest(providerKey, opt) {
    const p = PROVIDERS[providerKey];
    if (!p) throw new Error('未知供应商: ' + providerKey);
    const o = opt || {};
    const body = {
      model: o.model || p.models[0],
      messages: [],
      temperature: (o.temperature != null ? o.temperature : 0.3)
    };
    if (o.system) body.messages.push({ role: 'system', content: o.system });
    body.messages.push({ role: 'user', content: o.user || '' });
    if (o.maxTokens) body.max_tokens = o.maxTokens;
    if (o.jsonMode) {
      if (!p.jsonMode) throw new Error(p.label + ' 不支持 JSON 模式，请改用容错解析');
      body.response_format = { type: 'json_object' };
      // 经验：开了 json_object 还必须在提示里出现 "json" 字样，否则部分服务商会 400
    }
    return {
      url: p.base + '/chat/completions',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (o.apiKey || '') },
      body: body
    };
  }

  /* ---------------- 上下文模板 ---------------- */
  const PROMPTS = {
    explain: '你是阅卷老师。请为下面这道题写一段简明解析（不超过 200 字），并指出易错点。\n' +
             '只输出 JSON，格式：{"explanation":"解析正文","pitfall":"易错点"}',
    variant: '你是命题老师。基于下面这道题，生成 1 道同考点的新题（题干与选项都要换，考点保持一致）。\n' +
             '只输出 JSON，格式：{"type":"单选|多选|判断|简答","stem":"题干","options":[{"label":"A","text":"..."}],"answer":"答案","explanation":"解析","keywords":["采分关键词"]}',
    difficulty: '请评估这道题的难度，1 最简单、5 最难。只输出 JSON：{"level":1-5,"reason":"一句话理由"}',
    review: '你是学习顾问。根据本次答题记录，写一段总评（150 字以内）：指出薄弱考点、给出复习建议。\n' +
            '总评里必须**引用记录里的真实数字**（得分/正确题数/百分数）并**至少点到一道错题的题干**，不要写通用套话。\n' +
            '只输出 JSON：{"summary":"总评","weakPoints":["薄弱点"],"advice":["建议"]}',
    keywords: '以下是简答题的参考答案。请提取 3-6 个采分关键词（判分点），并为每个关键词给出常见同义写法。\n' +
              '只输出 JSON：{"keywords":[{"text":"关键词","synonyms":["同义1","同义2"]}]}'
  };

  /* ---------------- 脏 JSON 容错（核心） ---------------- */
  // 扫出第一个平衡的 {...} 或 [...]，尊重字符串与转义
  function firstBalancedBlock(s) {
    const open = s.search(/[{[]/);
    if (open < 0) return null;
    const openCh = s[open], closeCh = openCh === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let i = open; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) { esc = false; }
        else if (c === '\\') { esc = true; }
        else if (c === '"') { inStr = false; }
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === openCh) depth++;
      else if (c === closeCh) { depth--; if (depth === 0) return s.slice(open, i + 1); }
    }
    return s.slice(open);   // 未闭合：交给截断修复
  }

  // 修复常见手写 JSON 毛病；返回处理过的文本和用过的修复项
  function repairJson(s) {
    const fixes = [];
    let t = s;

    // 0) 不可见字符：BOM / 零宽空格 / 不间断空格 —— 肉眼看不见，但会让 JSON.parse 直接失败
    if (/[\uFEFF\u200B-\u200D\u00A0]/.test(t)) {
      t = t.replace(/[\uFEFF\u200B-\u200D]/g, '').replace(/\u00A0/g, ' ');
      fixes.push('去不可见字符（BOM/零宽/不换行空格）');
    }

    // 1) 去 markdown 代码围栏（含"只开了没关"的半截围栏）
    const fence = t.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
    if (fence) { t = fence[1]; fixes.push('去代码围栏'); }
    else if (/```/.test(t)) { t = t.replace(/```(?:json|JSON)?/g, ''); fixes.push('去半截代码围栏'); }

    // 1b) 去 JS 风格注释（模型爱在 JSON 里写 // 说明；标准 JSON 不允许注释）
    if (/\/\*[\s\S]*?\*\//.test(t)) { t = t.replace(/\/\*[\s\S]*?\*\//g, ''); fixes.push('去 /* */ 注释'); }
    if (/(^|[^:"'\\])\/\/[^\n]*/.test(t)) { t = t.replace(/(^|[^:"'\\])\/\/[^\n]*/g, '$1'); fixes.push('去 // 注释'); }

    // 2) 只取第一个平衡块（去掉前后废话）
    const block = firstBalancedBlock(t);
    if (block && block !== t.trim()) { t = block; fixes.push('裁掉 JSON 之外的文字'); }

    // 3) 全角引号 / 中文引号 → 半角
    if (/[“”]/.test(t)) { t = t.replace(/[“”]/g, '"'); fixes.push('中文双引号→半角'); }
    if (/[‘’]/.test(t)) { t = t.replace(/[‘’]/g, "'"); fixes.push('中文单引号→半角'); }

    // 3b) Python/JS 字面量 → JSON 字面量（模型混语言时很常见）
    if (/\b(True|False|None)\b/.test(t)) {
      t = t.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');
      fixes.push('True/False/None → JSON 字面量');
    }
    if (/:\s*(undefined|NaN)\b/.test(t)) { t = t.replace(/:\s*(?:undefined|NaN)\b/g, ': null'); fixes.push('undefined/NaN → null'); }

    // 4) 去尾逗号  {"a":1,}
    if (/,\s*[}\]]/.test(t)) { t = t.replace(/,(\s*[}\]])/g, '$1'); fixes.push('去尾逗号'); }

    // 5) 单引号字符串 → 双引号（只处理简单的，避免误伤撇号）
    if (/'\s*:/.test(t) || /:\s*'/.test(t)) {
      t = t.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, function (m, inner) {
        return '"' + inner.replace(/"/g, '\\"') + '"';
      });
      fixes.push('单引号→双引号');
    }

    // 6) 无引号的键  {a:1} / {解析: "x"} / 全角冒号
    if (/[,{]\s*[A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*\s*:/.test(t)) {
      t = t.replace(/([,{]\s*)([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)(\s*:)/g, '$1"$2"$3');
      fixes.push('补键名引号');
    }
    if (/：/.test(t)) { t = t.replace(/：/g, ':'); fixes.push('全角冒号→半角'); }

    // 6b) 字符串里**未转义的真实换行/制表符**（模型直接回车换行）→ 转义
    let esc2 = false, inS = false, out = '';
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (inS) {
        if (esc2) { esc2 = false; out += c; continue; }
        if (c === '\\') { esc2 = true; out += c; continue; }
        if (c === '"') { inS = false; out += c; continue; }
        if (c === '\n') { out += '\\n'; continue; }
        if (c === '\r') { out += '\\r'; continue; }
        if (c === '\t') { out += '\\t'; continue; }
        out += c; continue;
      }
      if (c === '"') inS = true;
      out += c;
    }
    if (out !== t) { t = out; fixes.push('转义字符串里的真实换行/制表符'); }

    // 7) 截断修复：补齐未闭合的括号（在字符串外计数）
    let inStr = false, esc = false;
    const stack = [];
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' || c === ']') stack.pop();
    }
    if (inStr) { t += '"'; fixes.push('补未闭合字符串'); }
    if (stack.length) {
      // 去掉末尾残缺的键值（例如 ..."a":）
      t = t.replace(/,\s*"[^"]*"\s*:\s*$/, '');
      t = t.replace(/,\s*$/, '');
      for (let i = stack.length - 1; i >= 0; i--) t += (stack[i] === '{' ? '}' : ']');
      fixes.push('补未闭合括号 ×' + stack.length);
    }
    return { text: t, fixes: fixes };
  }

  // 主力：把任意模型输出变成对象；失败时返回 ok:false 并带上原因与原文片段
  function safeParseJson(raw) {
    const original = String(raw == null ? '' : raw);
    if (!original.trim()) return { ok: false, value: null, strategy: 'empty', error: '模型返回空内容', raw: original };

    // 策略 1：直接就是 JSON
    try { return { ok: true, value: JSON.parse(original), strategy: 'direct', raw: original }; } catch (e) {}

    // 策略 2：修复后再 parse
    const rep = repairJson(original);
    try {
      const v = JSON.parse(rep.text);
      return { ok: true, value: v, strategy: 'repaired', fixes: rep.fixes, raw: original };
    } catch (e2) {
      // 策略 3：放弃 JSON，用字段抽取兜底（至少别让页面崩）
      const fb = extractFields(original);
      if (fb) return { ok: true, value: fb, strategy: 'fieldFallback', fixes: rep.fixes.concat(['JSON 彻底不可解析，改用字段抽取']), raw: original };
      return { ok: false, value: null, strategy: 'failed', error: e2.message, raw: original.slice(0, 400) };
    }
  }

  // 兜底：模型干脆写成散文时，用标签把字段抠出来
  function extractFields(text) {
    const pick = function (names) {
      for (const n of names) {
        // 1) 行首标签：  答案：B   /  【解析】xxx
        const re = new RegExp('(?:^|\\n)\\s*[【\\[]?\\s*' + n + '\\s*[】\\]]?\\s*[：:]\\s*([^\\n]+)', 'i');
        const m = text.match(re);
        if (m && m[1].trim()) return m[1].trim();
        // 2) JSON 风格残留：  "answer": "B"
        const re2 = new RegExp('"' + n + '"\\s*[：:]\\s*"([^"]*)"', 'i');
        const m2 = text.match(re2);
        if (m2) return m2[1];
        // 3) 行内散文："这道题的答案是 B" / "难度为 3"
        const re3 = new RegExp(n + '\\s*(?:是|为|应?该?为?)?\\s*[：:]?\\s*([A-H](?![A-Za-z])|[√×对错]|\\d+)', 'i');
        const m3 = text.match(re3);
        if (m3) return m3[1];
      }
      return null;
    };
    const out = {};
    const exp = pick(['explanation', '解析', '说明']);
    if (exp) out.explanation = exp;
    const pit = pick(['pitfall', '易错点']);
    if (pit) out.pitfall = pit;
    const stem = pick(['stem', '题干', '题目']);
    if (stem) out.stem = stem;
    const ans = pick(['answer', '答案']);
    if (ans) out.answer = ans;
    const sum = pick(['summary', '总评', '总结']);
    if (sum) out.summary = sum;
    const lvl = pick(['level', '难度']);
    if (lvl && /\d/.test(lvl)) out.level = parseInt(lvl.replace(/[^\d]/g, ''), 10);
    const keys = Object.keys(out);
    return keys.length ? out : null;
  }

  /* ---------------- 校验：AI 返回是否满足我们的结构 ---------------- */
  const SCHEMAS = {
    /* ⚠ explain 必须带 `pitfall`（易错点）：验收要求"解析含易错点"，
     *   所以它是**结构的一部分**、缺了就得拒绝 —— 不能只在提示词里"请顺便也说一下易错点"。 */
    explain: { explanation: 'string', pitfall: 'string' },
    variant: { type: 'type', stem: 'string', answer: 'string' },
    /* 难度必须是 **1-5 的整数**：模型爱给 3.5 / "3 分" / 0，这些一律不认。 */
    difficulty: { level: 'intLevel' },
    /* 总评必须**点出薄弱考点并给建议**（验收原话），所以这两项也是结构的一部分，
     * 而且不能是空数组 —— "总评 + 空列表"等于没给建议。 */
    review: { summary: 'string', weakPoints: 'array', advice: 'array' },
    keywords: { keywords: 'array' }
  };
  function validate(task, obj) {
    const need = SCHEMAS[task];
    if (!need) return { ok: false, error: '未知任务 ' + task };
    if (!obj || typeof obj !== 'object') return { ok: false, error: '不是对象' };
    const bad = [];
    Object.keys(need).forEach(function (k) {
      const kind = need[k], v = obj[k];
      if (v == null) { bad.push('缺少字段 ' + k); return; }
      if (kind === 'string' && (typeof v !== 'string' || !v.trim())) bad.push(k + ' 应为非空字符串');
      if (kind === 'array' && !Array.isArray(v)) bad.push(k + ' 应为数组');
      if (kind === 'type' && ['单选', '多选', '判断', '简答'].indexOf(v) < 0) bad.push('题型非法: ' + v);
      if (kind === 'level' && (!Number.isFinite(v) || v < 1 || v > 5)) bad.push('难度应在 1-5，实际 ' + v);
      if (kind === 'intLevel' && (!Number.isInteger(v) || v < 1 || v > 5)) bad.push('难度应为 1-5 的整数，实际 ' + v);
    });
    if (task === 'variant') {
      if (obj.options && !Array.isArray(obj.options)) bad.push('options 应为数组');
      if (Array.isArray(obj.options)) {
        obj.options.forEach(function (o, i) {
          if (!o || typeof o.label !== 'string' || typeof o.text !== 'string') bad.push('第 ' + (i + 1) + ' 个选项格式不对');
        });
      }
    }
    if (task === 'review') {
      /* 空数组 / 全是空串 → 等于没写 */
      ['weakPoints', 'advice'].forEach(function (k) {
        if (Array.isArray(obj[k]) && !obj[k].filter(function (x) { return String(x == null ? '' : x).trim(); }).length) {
          bad.push(k + ' 是空的（要点出薄弱考点并给出建议）');
        }
      });
    }
    return { ok: bad.length === 0, errors: bad };
  }

  /* ============================================================
   *  单题智能生成（解析 / 变式题 / 难度）
   *
   *  三条硬规矩：
   *    ① **一次点击一次请求**：单题路径 `retries: 0`（整卷批量才允许重试）——
   *       `runSingle` 返回的 `requestCount` 必须恒为 1；
   *    ② **结构不合就拒绝**：`checkResult` 先过 `validate`，再过"变式题四件套"闸门，
   *       拒绝时**绝不改动原题、也不产出新题**（`applyResult` 根本不会被调用）；
   *    ③ 只在用户明确点击后发生：这一层自己不注册任何定时器/自动触发。
   * ============================================================ */

  /* 题目 → 给模型看的简报（不要把整个对象塞进去：字段名会干扰模型，也白烧 token） */
  function briefQuestion(q) {
    const x = q || {};
    const lines = ['题型：' + (x.type || '未知'), '题干：' + (x.stem || '')];
    if (Array.isArray(x.options) && x.options.length) {
      lines.push('选项：' + x.options.map(function (o) { return (o.label || '') + '. ' + (o.text || ''); }).join('　'));
    }
    if (x.type === '判断') lines.push('答案：' + (x.judgeValue === true ? '对' : (x.judgeValue === false ? '错' : '（未给）')));
    else if (x.type === '简答') lines.push('参考答案：' + (x.answer || '（未给）'));
    else lines.push('答案：' + (x.answer || (Array.isArray(x.answerLetters) ? x.answerLetters.join('') : '（未给）')));
    if (x.explanation) lines.push('现有解析：' + x.explanation);
    return lines.join('\n');
  }

  const KIND_LABEL = { explain: '解析', variant: '变式题', difficulty: '难度' };

  /* kind + 题目 → `callAi` 的 opt（唯一组装点，页面不许自己拼提示词） */
  function singleRequest(kind, q, opt) {
    const o = opt || {};
    const task = String(kind || '');
    if (!PROMPTS[task] || !SCHEMAS[task]) throw new Error('未知单题任务：' + kind);
    return {
      task: task,
      system: PROMPTS[task],
      /* `context` 给"举一反三"用：把"你当时错答了什么"贴在题面前面，让新题冲着那个误区去 */
      user: (o.context ? (String(o.context) + '\n\n') : '') + briefQuestion(q),
      model: o.model || '',
      jsonMode: o.jsonMode !== false,
      temperature: (o.temperature != null ? o.temperature : 0.3),
      /* **单题不重试**：点一次就是一次请求（验收③）。要再试是用户再点一次。 */
      retries: (o.retries != null ? o.retries : 0)
    };
  }

  function judgeFromAnswer(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (['对', '√', 'true', 't', 'yes', 'y', '正确', '是'].indexOf(s) >= 0) return true;
    if (['错', '×', 'x', 'false', 'f', 'no', 'n', '错误', '否'].indexOf(s) >= 0) return false;
    return null;
  }
  function lettersFrom(v) {
    return String(v == null ? '' : v).toUpperCase().match(/[A-H]/g) || [];
  }

  /*
   * 把模型给的变式题变成"能入库的题" —— 用 SchemaCore 的工厂 + 校验器，
   * **不在这里另写一套题型规则**（那就成了第三份实现，迟早和判分侧对不上）。
   */
  function buildVariant(value, origin) {
    const v = value || {};
    const f = { type: v.type, stem: v.stem, answer: (v.answer == null ? '' : String(v.answer)), explanation: v.explanation || '', options: null,
                answerLetters: null, judgeValue: null, keywords: null, difficulty: null };
    if (v.type === '单选' || v.type === '多选') {
      f.options = (Array.isArray(v.options) ? v.options : []).map(function (o, i) {
        return { label: String((o && o.label) || String.fromCharCode(65 + i)).toUpperCase(), text: String((o && o.text) || '') };
      });
      const L = lettersFrom(v.answer);
      f.answerLetters = L.length ? L : null;
    } else if (v.type === '判断') {
      f.judgeValue = (typeof v.judgeValue === 'boolean') ? v.judgeValue : judgeFromAnswer(v.answer);
    } else if (v.type === '简答') {
      f.keywords = (Array.isArray(v.keywords) ? v.keywords : []).map(function (k) { return { text: String((typeof k === 'string') ? k : ((k && k.text) || '')).trim(), via: 'AI生成' }; })
        .filter(function (k) { return k.text; });
    }
    if (Number.isInteger(v.difficulty)) f.difficulty = v.difficulty;
    const q = SchemaCore.createQuestion(f);
    const problems = [];

    /* 变式题"四件套齐全"的闸门（比 validate 更严，因为它带着**原题**做对照） */
    if (!String(q.stem || '').trim()) problems.push('变式题题干为空');
    if (origin && String(q.stem).trim() === String(origin.stem || '').trim()) problems.push('变式题题干与原题一模一样（要求换题面，不能原样抄）');
    if (q.type === '单选' || q.type === '多选') {
      if ((q.options || []).length < 2) problems.push(q.type + '题选项少于 2 个');
      const L = q.answerLetters || [];
      if (!L.length) problems.push('选择题没有答案');
      if (q.type === '单选' && L.length !== 1) problems.push('单选题答案应恰好 1 个，实际 ' + L.join(''));
      if (q.type === '多选' && L.length < 2) problems.push('多选题答案应至少 2 个，实际 ' + L.join(''));
      const labels = (q.options || []).map(function (o) { return String(o.label).toUpperCase(); });
      L.forEach(function (x) { if (labels.indexOf(String(x).toUpperCase()) < 0) problems.push('答案 ' + x + ' 不在选项里'); });
    } else if (q.type === '判断') {
      if (typeof q.judgeValue !== 'boolean') problems.push('判断题没有可识别的答案（对/错）');
    } else if (q.type === '简答') {
      if (!(q.keywords || []).length) problems.push('简答题没有采分关键词');
    }
    const schemaVerdict = SchemaCore.validateQuestion(q);
    if (!schemaVerdict.ok) problems.push.apply(problems, schemaVerdict.errors);
    /* 有了 id 才算"能入库的形状"（createQuestion 已自动给 id，这一步是防回归） */
    if (!q.id) problems.push('题目缺少 id');
    return { ok: problems.length === 0, problems: problems, question: q, warnings: schemaVerdict.warnings || [] };
  }

  /*
   * 结构闸门：**过不了就什么都不产出**（没有 question、没有 patches）。
   * 返回里带上 `errors`（给用户看的一句句原因）与 `value`（原样奉还，便于排查/重试）。
   */
  function checkResult(kind, value, origin) {
    const v = validate(kind, value);
    if (!v.ok) return { ok: false, kind: kind, stage: 'schema', errors: v.errors, value: value };
    if (kind === 'variant') {
      const b = buildVariant(value, origin);
      if (!b.ok) return { ok: false, kind: kind, stage: 'completeness', errors: b.problems, value: value };
      return { ok: true, kind: kind, question: b.question, warnings: b.warnings };
    }
    if (kind === 'difficulty') return { ok: true, kind: kind, level: value.level };
    return { ok: true, kind: kind, value: value };
  }

  /*
   * 落库前的"附加/新建"计算（**纯函数**，不改调用方的东西）：
   *   explain    → {patches:{explanation}}  （解析 + 易错点合成一段，写进原题的解析）
   *   difficulty → {patches:{difficulty}}   （1-5 的整数）
   *   variant    → {question}               （可直接入库的新题，id 已由工厂生成）
   * 已被拒绝的结果**绝不会**走到这里。
   */
  function applyResult(origin, kind, value) {
    const g = checkResult(kind, value, origin);
    if (!g.ok) return g;
    if (kind === 'explain') {
      const q = origin || {};
      const pit = '易错点：' + String(value.pitfall).trim();
      const body = String(value.explanation).trim();
      const already = String(q.explanation || '');
      const text = (already.indexOf(pit) >= 0) ? already : (body + '\n' + pit);
      return { ok: true, kind: kind, patches: { explanation: text }, pitfall: String(value.pitfall).trim() };
    }
    if (kind === 'difficulty') return { ok: true, kind: kind, patches: { difficulty: value.level } };
    return { ok: true, kind: kind, question: g.question, warnings: g.warnings || [] };
  }

  /*
   * 单题一键跑完：**恰好 1 次请求** → 结构闸门 → 落库前计算。
   * `hooks.onRequest()` 每次真要发请求时回调一次（测试与界面据此数请求数）。
   */
  async function runSingle(store, fetchImpl, providerKey, kind, question, opts, hooks) {
    const o = opts || {}, h = hooks || {};
    if (!PROMPTS[kind]) return { ok: false, kind: kind, stage: 'unknown', errors: ['未知单题任务：' + kind], requestCount: 0 };
    /* 没有题就没有"单题"可言：直接拦住，别浪费一次请求 */
    if (!question || !String(question.stem == null ? '' : question.stem).trim()) {
      return { ok: false, kind: kind, stage: 'no_question', errors: ['没有可操作的题目（题干为空）'], requestCount: 0 };
    }
    const row = rowOf(providerKey);
    if (!row) return { ok: false, kind: kind, stage: 'provider', errors: ['未知供应商：' + providerKey], requestCount: 0 };
    if (!row.browserDirect) return { ok: false, kind: kind, stage: 'provider', errors: [row.label + ' 不支持浏览器直连'], hint: row.directNote, requestCount: 0 };

    const opt = singleRequest(kind, question, o);
    const counted = function (url, init) { if (h.onRequest) h.onRequest(); return fetchImpl(url, init); };
    const raw = await callSaved(store, counted, providerKey, opt, h);
    if (!raw.ok) {
      /* `callAi` 自己也有一层结构校验（整卷批量会靠它重试）。单题路径把它**降级为提示**：
       * 统一由本层的闸门给结论，这样 stage/errors/value 三个字段的语义才一致
       * （否则用户看到的是"字段不完整：缺少字段 pitfall"这种带前缀的转述，还拿不到原值）。 */
      if (raw.kind === 'schema' && raw.raw !== undefined) {
        const g0 = checkResult(kind, raw.raw, question);
        return { ok: false, kind: kind, stage: 'schema', errors: (g0.errors || [raw.text]), value: raw.raw,
                 requestCount: 1, hint: '模型这次没按结构返回；可以再点一次，或换一个模型' };
      }
      return { ok: false, kind: kind, stage: 'call', errors: [raw.text || '调用失败'], hint: raw.hint || '', kind2: raw.kind, requestCount: 1 };
    }
    const g = checkResult(kind, raw.value, question);
    if (!g.ok) {
      return { ok: false, kind: kind, stage: g.stage, errors: g.errors, value: raw.value, usage: raw.usage || null,
               requestCount: 1, hint: '模型这次没按结构返回；可以再点一次，或换更强/更便宜的模型' };
    }
    const applied = applyResult(question, kind, raw.value);
    return {
      ok: true, kind: kind, provider: providerKey,
      patches: applied.patches || null, question: applied.question || null,
      value: raw.value, pitfall: applied.pitfall || '', warnings: applied.warnings || [],
      attempts: raw.attempts || 1, requestCount: 1, strategy: raw.strategy || '',
      /* 服务商回传的真实用量：批量汇总与"估算校准"都要用它 */
      usage: raw.usage || null
    };
  }

  /* ============================================================
   *  整卷点评（交卷后）与"举一反三"（误答本里一键出同考点新题）
   *
   *  两条与单题路径不同的地方：
   *    · 整卷总评一次调用 token 明显更大 → **必须先弹消耗确认窗**（`needConfirm` 时零请求）；
   *    · 总评必须**引用本轮记录**（分数/题面），光说套话一律拒绝（`checkReviewGrounding`）。
   * ============================================================ */

  function clip(s, n) {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? (t.slice(0, n) + '…') : t;
  }

  /*
   * 整卷简报：把"本轮到底发生了什么"写清楚，同时把可核对的事实抽出来（`facts`）。
   * `facts` 是反套话闸门的判据来源 —— 界面与测试都不许自己另算一遍。
   *
   * ⚠ `opts.answers`（题 id → 作答）**必须传**：交卷结算的 `per[]` 里**没有**"你答了什么"
   *   （那是回看层 `reviewList` 才拼的字段）。不传的话每一行都会写成"（未作答）"——
   *   那样总评就失去了最关键的误答线索（实测踩过）。正确答案一律走 `QuizCore.answerText`（唯一真相源）。
   */
  function examBrief(summary, questions, opts) {
    const s = summary || {};
    const o = opts || {};
    const answers = o.answers || {};
    const per = Array.isArray(s.per) ? s.per : [];
    const byId = {};
    (questions || []).forEach(function (q) { if (q && q.id) byId[q.id] = q; });
    const wrong = per.filter(function (p) { return !p.correct; });
    const lines = [];
    lines.push('本次成绩：' + num(s.score) + ' / ' + num(s.full) + ' 分（' + num(s.percent) + '%），等级「' + (s.level || '未定档') + '」'
      + '，答对 ' + num(s.correctCount) + ' / ' + num(s.total) + ' 题'
      + ((s.skipped && s.skipped.length) ? ('，漏答 ' + s.skipped.length + ' 题（第 ' + s.skipped.join('、') + ' 题）') : ''));
    if (s.manualCount) lines.push('其中 ' + s.manualCount + ' 题是人工订正过的（第 ' + (s.manualLabels || []).join('、') + ' 题）');
    lines.push('逐题情况：');
    const stems = [], numbers = [num(s.score), num(s.full), num(s.percent), num(s.correctCount), num(s.total)];
    per.forEach(function (p, i) {
      const q = byId[p.id] || {};
      const stem = clip(q.stem || p.stem || '', 40);
      if (stem) stems.push(clip(stem, 12));
      numbers.push(num(p.score));
      if (typeof p.full === 'number') numbers.push(String(p.full));
      const mine = (answers[p.id] !== undefined && answers[p.id] !== null && String(answers[p.id]) !== '')
        ? clip(answers[p.id], 30) : clip(p.userAnswer || '（未作答）', 30);
      const right = q.id ? clip(QuizCore.answerText(q), 30) : clip(p.correctAnswer || '', 30);
      lines.push('  第 ' + (i + 1) + ' 题【' + (p.type || q.type || '?') + '】' + (p.correct ? '✔ 答对' : '✘ 答错')
        + '　得分 ' + num(p.score) + '/' + num(p.full)
        + '　你的作答：' + mine
        + '　正确答案：' + (right || '（未给）')
        + (stem ? ('　题干：' + stem) : ''));
    });
    if (o.extra) lines.push(String(o.extra));
    const uniq = function (a) { return a.filter(function (x, i) { return x !== '' && a.indexOf(x) === i; }); };
    /*
     * `facts` 是反套话闸门的判据来源，分强弱两档（**别把 1/0 这种小整数当强证据**）：
     *   · strong：百分数、"得分/满分"、"答对/总题数"、以及题面里 2 位以上的数字（如端口 80/443）
     *     —— 这些几乎只可能来自本轮记录，蒙不出来；
     *   · weak：逐题得分这类小整数（"每天复习 1 小时"里也有个 1，判不了）。
     * 实测过：只用 weak 时，一句通用建议就能命中 "1" 而通过闸门 —— 那闸门就等于没有。
     */
    const strong = [];
    if (typeof s.percent === 'number') { strong.push(num(s.percent)); strong.push(num(s.percent) + '%'); }
    if (typeof s.score === 'number' && typeof s.full === 'number') strong.push(num(s.score) + '/' + num(s.full));
    if (typeof s.correctCount === 'number' && typeof s.total === 'number') strong.push(num(s.correctCount) + '/' + num(s.total));
    /* "得了 3.5 分"这种写法也得认（真人/模型都爱这么写）。注意只收**非零的得分**：
     * "0 分"太容易出现在否定句里，而小数/非零得分几乎只可能来自本轮记录。 */
    if (typeof s.score === 'number' && s.score !== 0) { strong.push(num(s.score) + '分'); strong.push(num(s.score) + ' 分'); strong.push('得分' + num(s.score)); }
    const bigInStems = (lines.join(' ').match(/\d{2,}/g) || []);
    return {
      text: lines.join('\n'),
      score: s.score, full: s.full, percent: s.percent, level: s.level || '',
      total: per.length, correctCount: s.correctCount || 0,
      wrongCount: wrong.length,
      wrongLabels: per.map(function (p, i) { return p.correct ? null : String(i + 1); }).filter(Boolean),
      facts: { numbers: uniq(numbers), strong: uniq(strong.concat(bigInStems)), stems: uniq(stems), wrongCount: wrong.length }
    };
  }
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? String(Math.round(v * 100) / 100) : String(v == null ? '' : v); }

  /* 整卷总评的请求（task='review'）：提示词里**明确要求引用**本轮的真实数字与错题 */
  function reviewRequest(summary, questions, opt) {
    const o = opt || {};
    const brief = examBrief(summary, questions, o);
    return {
      opt: {
        task: 'review',
        system: PROMPTS.review,
        user: brief.text + '\n\n（要求：总评里必须**引用上面这些真实数字与至少一道错题的题干**，不要写放之四海皆准的套话。）',
        model: o.model || '',
        jsonMode: o.jsonMode !== false,
        temperature: (o.temperature != null ? o.temperature : 0.3),
        retries: (o.retries != null ? o.retries : 0)
      },
      brief: brief
    };
  }

  /*
   * 反套话闸门：总评必须落到本轮记录上 —— 命中一个**强证据**（百分数 / 得分对 / 答对题数对 / 题面里的数字）
   * 或**误答题面片段**才算数；只有"1 个 1 分"这种弱整数不算（那种随便一句建议都能撞上）。
   * 为什么要有它：模型很容易回一段"多做练习、巩固基础"放之四海皆准的话，那样的点评对备考者一文不值，
   * 却完全"结构合法"。这条就是拦它的。
   */
  function checkReviewGrounding(value, brief) {
    const v = value || {};
    const text = [v.summary || ''].concat(Array.isArray(v.weakPoints) ? v.weakPoints : [], Array.isArray(v.advice) ? v.advice : []).join(' ');
    const facts = (brief && brief.facts) || { numbers: [], strong: [], stems: [], wrongCount: 0 };
    const strong = facts.strong || [];
    const hitStrong = strong.filter(function (n) { return n && text.indexOf(n) >= 0; });
    /* 题面命中允许"只提到前半句"：模型/真人常写"HTTP 默认端口"而不是整句。
     * 取题面前 6 个字当签名 —— 6 个字的题面片段足够具体，不会在通用建议里撞上。 */
    const hitStems = (facts.stems || []).filter(function (s) {
      if (!s) return false;
      if (text.indexOf(s) >= 0) return true;
      const sig = s.slice(0, 6);
      return sig.length >= 6 && text.indexOf(sig) >= 0;
    });
    const hitWeak = (facts.numbers || []).filter(function (n) { return n && text.indexOf(n) >= 0; });
    const ok = (hitStrong.length > 0) || (hitStems.length > 0);
    return {
      ok: ok, hitStrong: hitStrong, hitStems: hitStems, hitNumbers: hitWeak,
      reason: ok ? '' : '总评里没有引用本轮记录的任何得分/百分数/错题题干（读起来像通用套话），已拒绝'
    };
  }

  /*
   * 整卷总评：**先确认再发**。
   *   `opts.confirmed !== true` → 返回 `{ok:false, needConfirm:true, confirm}`（**零请求**）
   *   `opts.confirmed === true`  → 恰好 1 次请求 → 结构闸门 → 反套话闸门
   */
  async function runReview(store, fetchImpl, providerKey, summary, questions, opts, hooks) {
    const o = opts || {}, h = hooks || {};
    const row = rowOf(providerKey);
    const built = reviewRequest(summary, questions, o);
    const brief = built.brief;
    /* 整卷总评：确认窗里的估算也走同一口径（提示用真实简报算，输出用 review 的默认值） */
    const est = estimateRequest('review', null, Object.assign({}, o, { expectOutputTokens: o.expectOutputTokens }));
    const briefOnly = estimateTokens(built.opt.system + built.opt.user);
    const confirm = {
      task: 'review', provider: providerKey, providerLabel: row ? row.label : providerKey,
      promptTokens: briefOnly,
      expectOutputTokens: est.expectOutputTokens,
      totalTokens: briefOnly + est.expectOutputTokens,
      wrongCount: brief.wrongCount, total: brief.total,
      message: '整卷总评会把本轮的逐题记录（含得分与作答）发给 ' + (row ? row.label : providerKey)
        + '，预计消耗约 ' + (briefOnly + est.expectOutputTokens) + ' tokens（提示 ' + briefOnly + ' + 输出约 ' + est.expectOutputTokens + '）。要现在生成吗？'
    };
    if (o.confirmed !== true) return { ok: false, needConfirm: true, confirm: confirm, requestCount: 0 };
    if (!row) return { ok: false, needConfirm: false, stage: 'provider', errors: ['未知供应商：' + providerKey], requestCount: 0 };
    if (!row.browserDirect) return { ok: false, needConfirm: false, stage: 'provider', errors: [row.label + ' 不支持浏览器直连'], hint: row.directNote, requestCount: 0 };

    const counted = function (url, init) { if (h.onRequest) h.onRequest(); return fetchImpl(url, init); };
    const raw = await callSaved(store, counted, providerKey, built.opt, h);
    if (!raw.ok) {
      if (raw.kind === 'schema' && raw.raw !== undefined) {
        return { ok: false, needConfirm: false, stage: 'schema', errors: (validate('review', raw.raw).errors || [raw.text]), value: raw.raw,
                 requestCount: 1, confirm: confirm, brief: brief, hint: '模型这次没按结构返回；可以再点一次，或换一个模型' };
      }
      return { ok: false, needConfirm: false, stage: 'call', errors: [raw.text || '调用失败'], hint: raw.hint || '', kind2: raw.kind,
               requestCount: 1, confirm: confirm, brief: brief };
    }
    const g = validate('review', raw.value);
    if (!g.ok) return { ok: false, needConfirm: false, stage: 'schema', errors: g.errors, value: raw.value, requestCount: 1, confirm: confirm, brief: brief,
                        hint: '模型这次没按结构返回；可以再点一次，或换一个模型' };
    const ground = checkReviewGrounding(raw.value, brief);
    if (!ground.ok) {
      return { ok: false, needConfirm: false, stage: 'grounding', errors: [ground.reason], value: raw.value,
               grounding: ground, requestCount: 1, confirm: confirm, brief: brief,
               hint: '再点一次通常就好了；也可以换一个更强的模型' };
    }
    return { ok: true, needConfirm: false, provider: providerKey, value: raw.value, brief: brief,
             grounding: ground, confirm: confirm, attempts: raw.attempts || 1, requestCount: 1, strategy: raw.strategy || '',
             usage: raw.usage || null };
  }

  /*
   * 举一反三：误答条目 + 原题 → 同考点新题的请求。
   * 把"你当时选了什么 / 正确答案是什么 / 错过几次"写进提示词，让新题**冲着那个误区**去。
   */
  function mistakeBrief(question, entry) {
    const q = question || {}, e = entry || {};
    const lines = [briefQuestion(q)];
    if (e.lastAnswer !== undefined && e.lastAnswer !== null && String(e.lastAnswer) !== '') lines.push('你当时的错答：' + clip(e.lastAnswer, 40));
    if (e.times) lines.push('这道题你已经错了 ' + e.times + ' 次');
    if (e.lastScore !== undefined && e.lastFull !== undefined) lines.push('最近一次得分：' + num(e.lastScore) + '/' + num(e.lastFull));
    return lines.join('\n');
  }

  /* 误答本里一键出同考点新题（1 次请求；结构闸门复用单题那条路） */
  async function runMistakeVariant(store, fetchImpl, providerKey, question, entry, opts, hooks) {
    const o = opts || {};
    return runSingle(store, fetchImpl, providerKey, 'variant', question,
      Object.assign({}, o, { context: mistakeBrief(question, entry) }), hooks);
  }

  /*
   * 把新题**直接加入当前试卷**。三道闸门全过才写：
   *   ① 题目结构（SchemaCore.validateQuestion）；② 必须能在卷册里找到这套卷；③ 追加后整卷校验（exams 内部做）。
   * 返回里带上"落在哪个题型分组、那个分组的题数"——验收要求"出现在对应题型分组中"。
   */
  async function appendVariant(store, examId, question, opts) {
    const o = opts || {};
    if (!store) return { ok: false, error: '没有可用的存储' };
    if (!question || typeof question !== 'object') return { ok: false, error: '要加入的题目不是对象' };
    const made = SchemaCore.createQuestion(question);
    const v = SchemaCore.validateQuestion(made);
    if (!v.ok) return { ok: false, stage: 'schema', error: '这道题结构不合法，未加入试卷：' + v.errors.join('；'), errors: v.errors };
    if (!made.id) return { ok: false, stage: 'schema', error: '题目缺少 id，未加入试卷' };
    const r = await ExamsCore.appendQuestions(store, examId, [made], { now: o.now });
    if (!r.ok) return { ok: false, stage: 'store', error: r.error || '加入试卷失败', hint: r.hint || '', blocking: r.blocking || [] };
    /* ⚠ 追加时会**重新分配 id**（卷册层的归一策略），所以必须以 `accepted` 里那份为准 ——
     *   拿追加前的 id 去卷子里找，永远找不到（实测踩过：inGroup 恒为 false）。 */
    const stored = (r.accepted && r.accepted[0]) || made;
    const grouped = ExamsCore.groupQuestions(r.exam.questions);
    const bucket = grouped[stored.type] || [];
    return {
      ok: true, examId: r.exam.id, examTitle: r.exam.title, question: stored,
      /* groupQuestions 的元素是 `{index, question}`（不是题目本身） */
      type: stored.type, inGroup: bucket.some(function (x) { return x.question && x.question.id === stored.id; }),
      groupCount: bucket.length, before: r.before, after: r.after, added: r.added
    };
  }

  /* ---------------- 错误分类（给出人话 + 处理建议） ---------------- */
  function classifyError(err, status, body) {
    const msg = (err && (err.message || String(err))) || '';
    const m = msg.toLowerCase();
    const b = String(body == null ? '' : body).toLowerCase();
    if (err && err.name === 'AbortError') {
      return { kind: 'timeout', text: '请求超时', hint: '网络慢或模型排队，可降低题量后重试' };
    }
    if (status === 401 || status === 403) {
      return { kind: 'auth', text: 'API Key 无效或没有该模型权限', hint: '到设置页重新填写 Key；注意别把别家的 Key 填错供应商' };
    }
    if (status === 402) return { kind: 'billing', text: '账户余额不足', hint: '去服务商控制台充值' };
    if (status === 404) return { kind: 'not_found', text: '模型名或接口地址不对', hint: '检查模型名是否在该供应商的可用列表里（如豆包要填接入点 ID）' };
    if (status === 429) return { kind: 'rate_limit', text: '触发限流', hint: '等几秒重试，或把批量操作拆小' };
    /* 「模型不支持 JSON 模式」必须**单独成一类**：它跟"参数写错了"完全不同 ——
     * 用户该做的是关掉 JSON 模式（本应用的容错解析能兜住），而不是去改题、换 Key。
     * 判据：响应体点到 response_format / json_object / json mode（不少家就是这么回的）。 */
    if (/response_format|json_object|json mode|does not support[^.]*json/.test(b)) {
      return { kind: 'json_unsupported', text: '这家/这个模型不支持 JSON 模式（response_format）',
               hint: '在设置里关掉「JSON 模式」再试：本应用会对脏输出做容错解析，没有 JSON 模式也能用' };
    }
    if (status === 400) return { kind: 'bad_request', text: '请求被拒（参数不支持）', hint: '部分模型不支持 JSON 模式，可在设置里关掉 response_format 再试' };
    if (status >= 500) return { kind: 'server', text: '服务商侧错误 ' + status, hint: '过一会儿重试' };
    if (m.indexOf('failed to fetch') >= 0 || m.indexOf('networkerror') >= 0 || status === 0) {
      return { kind: 'cors_or_network', text: '请求发不出去（多为跨域被拦或断网）', hint: '1) 确认没在用不支持 CORS 的供应商（如 OpenAI）2) 断网时 AI 功能本就不可用 3) 检查是否被代理/VPN 拦截' };
    }
    return { kind: 'unknown', text: '未知错误：' + msg.slice(0, 120), hint: '可展开原始响应排查' };
  }

  /* ============================================================
   *  容错与提示：批量消耗确认 + 估算校准
   *
   *  批量与单题的分野（这是"容错与提示"小类的核心交付之一）：
   *    · 单题：点一次 = 一次请求，**不弹**消耗确认；
   *    · 批量（整卷多题）：**必须先弹**确认窗并显示估算 token，未确认 **零请求**。
   *  估算口径只有一个（`estimateTokens`），并用服务商回传的 `usage` 做过实测校准。
   * ============================================================ */

  /*
   * 各任务的**预期输出量**（token）。这是"粗估"的第二半，必须按任务给：
   * 解析/变式是长文本，难度只有几个字，总评更长。给一个统一的 300 会让小任务偏差爆掉。
   *
   * 下面这些数字是**真调用实测校准**出来的（百炼 qwen-plus，见 verify/real-ai-last.json）：
   *   单题解析 completion 实测 168；批量解析每题 104–134；整卷总评 completion 实测 165。
   * 取"比实测略高"的值（模型有时话多），既留余量又不至于高估到 60% 以上。
   * prompt 侧几乎不用调：估 93/321/263 对实测 121/322/289（偏差 ≤23%）。
   */
  const EXPECT_OUT = { explain: 170, variant: 200, difficulty: 40, review: 220, keywords: 120 };

  /* 单题的估算（提示 + 预期输出）；界面与脚本都用它，别各自硬编码 */
  function estimateRequest(kind, question, opt) {
    let promptTokens = 0;
    try {
      const built = singleRequest(kind, question, opt || {});
      promptTokens = estimateTokens(built.system + built.user);
    } catch (e) { promptTokens = 0; }
    const outPer = (opt && opt.expectOutputTokens != null) ? opt.expectOutputTokens : (EXPECT_OUT[kind] || 200);
    return { kind: kind, promptTokens: promptTokens, expectOutputTokens: outPer, totalTokens: promptTokens + outPer };
  }

  /* 批量计划（**纯函数**）：要发多少次请求、大概烧多少 token、确认窗该说什么 */
  function planBatch(kind, questions, opt) {
    const o = opt || {};
    const list = Array.isArray(questions) ? questions : [];
    const label = KIND_LABEL[kind] || String(kind || '任务');
    let promptTokens = 0, perItem = [];
    const model = o.model || '';
    list.forEach(function (q, i) {
      let built;
      try { built = singleRequest(kind, q, { model: model, context: o.context }); }
      catch (e) { built = null; }
      if (!built) { perItem.push({ index: i, id: q && q.id, skipped: true, reason: '未知任务：' + kind }); return; }
      const t = estimateTokens(built.system + built.user);
      promptTokens += t;
      perItem.push({ index: i, id: q && q.id, promptTokens: t, skipped: false });
    });
    const perOut = (o.expectOutputTokens != null ? o.expectOutputTokens : (EXPECT_OUT[kind] || 200));
    const outTokens = perOut * list.length;
    return {
      kind: kind, label: label, provider: o.provider || '', model: model,
      count: list.length, requests: list.length,
      promptTokens: promptTokens, expectOutputTokens: outTokens, expectOutputPerItem: perOut,
      totalTokens: promptTokens + outTokens,
      perItem: perItem,
      message: '要对 ' + list.length + ' 道题做「' + label + '」：会发 ' + list.length + ' 次请求，'
        + '预计消耗约 ' + (promptTokens + outTokens) + ' tokens（提示 ' + promptTokens + ' + 输出约 ' + outTokens + '）。'
        + '要现在开始吗？'
    };
  }

  /*
   * 批量执行：先确认（未确认直接返回 `needConfirm` 且**零请求**），确认后逐题跑。
   * 单题失败不拖垮整批：逐题结果都收在 `results[]` 里，失败项带上阶段与可读原因。
   */
  async function runBatch(store, fetchImpl, providerKey, kind, questions, opts, hooks) {
    const o = opts || {}, h = hooks || {};
    const plan = planBatch(kind, questions, Object.assign({}, o, { provider: providerKey }));
    plan.provider = providerKey;
    if (o.confirmed !== true) return { ok: false, needConfirm: true, confirm: plan, plan: plan, requestCount: 0 };
    const row = rowOf(providerKey);
    if (!row) return { ok: false, needConfirm: false, stage: 'provider', errors: ['未知供应商：' + providerKey], requestCount: 0 };
    if (!row.browserDirect) return { ok: false, needConfirm: false, stage: 'provider', errors: [row.label + ' 不支持浏览器直连'], hint: row.directNote, requestCount: 0 };

    const list = Array.isArray(questions) ? questions : [];
    const results = [];
    let requests = 0, okCount = 0, failCount = 0, promptUsed = 0, completionUsed = 0, usageSeen = 0;
    /* ⚠ 批量**允许重试**（这正是它与单题的区别之一）：一题一次调用，脏输出值得再要一次 */
    const retries = (o.retries != null ? o.retries : 1);
    for (let i = 0; i < list.length; i++) {
      if (h.onProgress) h.onProgress({ index: i, total: list.length });
      const r = await runSingle(store, fetchImpl, providerKey, kind, list[i],
        { model: o.model, context: o.context, retries: retries },
        Object.assign({}, h, { onRequest: function () { requests++; if (h.onRequest) h.onRequest(); } }));
      if (r.ok) okCount++; else failCount++;
      if (r.usage) {
        usageSeen++;
        if (typeof r.usage.promptTokens === 'number') promptUsed += r.usage.promptTokens;
        if (typeof r.usage.completionTokens === 'number') completionUsed += r.usage.completionTokens;
      }
      results.push({ index: i, id: list[i] && list[i].id, ok: r.ok, stage: r.stage || '',
                     question: r.question || null, patches: r.patches || null, value: r.value || null,
                     errors: r.errors || [], hint: r.hint || '', requestCount: r.requestCount, usage: r.usage || null });
    }
    const actual = usageSeen ? (promptUsed + completionUsed) : null;
    return {
      ok: failCount === 0, needConfirm: false, kind: kind, provider: providerKey,
      total: list.length, okCount: okCount, failCount: failCount, results: results,
      requestCount: requests, plan: plan,
      estimate: { promptTokens: plan.promptTokens, expectOutputTokens: plan.expectOutputTokens, totalTokens: plan.totalTokens },
      actual: actual ? { promptTokens: promptUsed, completionTokens: completionUsed, totalTokens: actual } : null,
      /* 估算偏差（有真实用量时才有值）：|估 - 实| / 实 */
      deviation: actual ? Math.round(Math.abs(plan.totalTokens - actual) / Math.max(1, actual) * 1000) / 10 : null
    };
  }

  /* 把服务商回传的真实用量汇总成"估算校准"结论（给界面/自检页显示，也给测试断言） */
  function estimateReport(pairs) {
    const rows = (Array.isArray(pairs) ? pairs : []).filter(function (p) {
      return p && typeof p.estimate === 'number' && typeof p.actual === 'number' && p.actual > 0;
    }).map(function (p) {
      return { label: p.label || '', estimate: p.estimate, actual: p.actual,
               deviation: Math.round(Math.abs(p.estimate - p.actual) / p.actual * 1000) / 10 };
    });
    const worst = rows.reduce(function (m, r) { return Math.max(m, r.deviation); }, 0);
    return { rows: rows, samples: rows.length, worstDeviation: worst,
             within60: worst < 60, note: '口径：|估-实|/实；验收要求偏差 < 60%' };
  }

  /* ---------------- token 粗估（用于批量操作的消耗确认弹窗） ---------------- */
  function estimateTokens(text) {
    const s = String(text == null ? '' : text);
    let cjk = 0, other = 0;
    for (const ch of s) { if (/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk++; else other++; }
    // 经验值：中文约 1 字 ≈ 1 token；英文约 4 字符 ≈ 1 token
    return Math.ceil(cjk * 1.0 + other / 4);
  }

  /* ---------------- 带重试的调用骨架（fetch 可注入，便于 Node 测试） ---------------- */
  async function callAi(fetchImpl, providerKey, opt, hooks) {
    const h = hooks || {};
    const req = buildChatRequest(providerKey, opt);
    const maxTry = (opt && opt.retries != null) ? opt.retries : 2;
    let last = null;
    for (let attempt = 0; attempt <= maxTry; attempt++) {
      try {
        if (h.onAttempt) h.onAttempt(attempt + 1);
        const resp = await fetchImpl(req.url, {
          method: 'POST', headers: req.headers, body: JSON.stringify(req.body)
        });
        const text = await resp.text();
        if (!resp.ok) {
          /* 把响应体一起交给分类器：像「模型不支持 JSON 模式」这种只能从响应体里认出来 */
          const c = classifyError(null, resp.status, text);
          last = { ok: false, kind: c.kind, text: c.text, hint: c.hint, status: resp.status, body: text.slice(0, 300) };
          // 限流/服务端错误才重试，鉴权类重试没意义
          if (!(resp.status === 429 || resp.status >= 500)) break;
          continue;
        }
        let content = '', usage = null;
        try {
          const j = JSON.parse(text);
          content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
          /* 服务商给的**真实用量**：拿它校准我们的 token 粗估（「容错与提示」小类的估算偏差证据就靠它） */
          if (j.usage && typeof j.usage === 'object') {
            usage = {
              promptTokens: j.usage.prompt_tokens != null ? j.usage.prompt_tokens : j.usage.input_tokens,
              completionTokens: j.usage.completion_tokens != null ? j.usage.completion_tokens : j.usage.output_tokens,
              totalTokens: j.usage.total_tokens
            };
          }
        } catch (e) {
          last = { ok: false, kind: 'bad_response', text: '响应不是合法 JSON', body: text.slice(0, 300) };
          break;
        }
        const parsed = safeParseJson(content);
        if (!parsed.ok) {
          last = { ok: false, kind: 'bad_json', text: '模型没返回可解析的 JSON', hint: '已自动重试过；可再点一次或换模型', raw: parsed.raw };
          /* 附带本次拿到的真实用量：即使这轮没解析成功，用量也已经产生了 */
          if (usage) last.usage = usage;
          continue;   // 输出格式问题值得重试
        }
        const v = validate(opt.task, parsed.value);
        if (!v.ok) {
          last = { ok: false, kind: 'schema', text: '字段不完整：' + v.errors.join('；'), raw: parsed.value };
          if (usage) last.usage = usage;
          continue;
        }
        return { ok: true, value: parsed.value, strategy: parsed.strategy, fixes: parsed.fixes || [], attempts: attempt + 1, usage: usage };
      } catch (e) {
        const c = classifyError(e, 0);
        last = { ok: false, kind: c.kind, text: c.text, hint: c.hint };
        if (c.kind === 'cors_or_network' && attempt >= maxTry) break;
      }
    }
    return last || { ok: false, kind: 'unknown', text: '未发起请求' };
  }

  /*
   * 用**已保存的 Key** 发起调用（页面唯一入口）。
   * 两道前置闸门：没填 key / 该家不可直连 → 直接返回明确原因，**不发请求**（省得用户对着 CORS 报错猜）。
   */
  async function callSaved(store, fetchImpl, providerKey, opt, hooks) {
    const row = rowOf(providerKey);
    if (!row) return { ok: false, kind: 'unknown_provider', text: '未知供应商：' + providerKey };
    if (!row.browserDirect) {
      return { ok: false, kind: 'no_direct', text: row.label + ' 不支持浏览器直连', hint: row.directNote };
    }
    const k = await readKey(store, providerKey);
    if (!k.configured) {
      return { ok: false, kind: 'no_key', text: '还没填 ' + row.label + ' 的 API Key', hint: '先在「AI 密钥」里填一个，它只存在你这台机器上' };
    }
    const merged = Object.assign({}, opt || {}, { apiKey: k.apiKey });
    const out = await callAi(fetchImpl, providerKey, merged, hooks);
    return Object.assign({ provider: providerKey, usingSavedKey: true }, out);
  }

  return {
    PROVIDERS: PROVIDERS, PROMPTS: PROMPTS, PROVIDER_KEYS: PROVIDER_KEYS,
    SECRET_NAMESPACE: SECRET_NAMESPACE, KEYS_VERSION: KEYS_VERSION,
    buildChatRequest: buildChatRequest,
    safeParseJson: safeParseJson, repairJson: repairJson,
    extractFields: extractFields, firstBalancedBlock: firstBalancedBlock,
    validate: validate, classifyError: classifyError,
    estimateTokens: estimateTokens, callAi: callAi, callSaved: callSaved,
    /* 单题智能生成 */
    briefQuestion: briefQuestion, singleRequest: singleRequest, checkResult: checkResult,
    applyResult: applyResult, runSingle: runSingle, buildVariant: buildVariant, KIND_LABEL: KIND_LABEL,
    /* 整卷点评 + 举一反三 */
    examBrief: examBrief, reviewRequest: reviewRequest, checkReviewGrounding: checkReviewGrounding,
    runReview: runReview, mistakeBrief: mistakeBrief, runMistakeVariant: runMistakeVariant, appendVariant: appendVariant,
    /* 容错与提示：批量确认 + 估算校准 */
    planBatch: planBatch, runBatch: runBatch, estimateReport: estimateReport, estimateRequest: estimateRequest,
    /* 能力表 */
    providerRows: providerRows, capabilityGaps: capabilityGaps,
    /* 密钥 */
    keysKey: keysKey, secretNamespace: secretNamespace, openKeyStore: openKeyStore,
    maskKey: maskKey, checkKeysPayload: checkKeysPayload,
    saveKey: saveKey, clearKey: clearKey, readKey: readKey, hasKey: hasKey,
    keyModel: keyModel, usableProviders: usableProviders,
    scanForSecrets: scanForSecrets, allKeys: allKeys
  };
});
