/* ============================================================
 *  ui/ai-single.js —— AI 生成解析面板（**整卷**：逐题补解析，先报账再跑）
 *
 *  ⚠ 页面只用到 mountBatch（导入 / 校对页那颗「生成解析」）。
 *    mount()（单题：解析 / 变式题 / 难度）这一轮按用户要求**从界面上撤掉了**
 *    （"不要分开，整合到一个生成解析按钮解析对应整卷"）；代码留在这里：
 *    自检页 P 节与 ai-single.test.js 还在用它，将来想放回来也只是加一颗按钮的事。
 *
 *  只做三件事：把"点哪道题、做哪个操作"转成 `AiCore.runSingle` 调用；
 *  把**通过了结构闸门**的结果写回草案（附加到原题 / 追加成新题）；把拒绝原因说清楚。
 *
 *  三条界面纪律（对应验收）：
 *    ① **点一次 = 一次请求**：按钮按下后立刻禁用，跑完才放开；界面上明写"单题不弹消耗确认"；
 *       `stats().requests` 就是请求计数（测试拿它当锚）；
 *    ② **被拒绝的结果不许落库**：拒绝时只显示原因 + "原题未改动、题库未写入"，**不画**"应用到原题"按钮；
 *    ③ 写回草案走 `ReviewCore`（`setExplanation/setDifficulty/appendQuestion`），这一步只是草案，
 *       真正落盘仍由「确认入库」那一刻的 `ReviewCore.commit` 把关。
 * ============================================================ */
(function (root, factory) {
  const isNode = (typeof module !== 'undefined' && module.exports);
  const AiCore = isNode ? require('../core/ai.js') : root.AiCore;
  const ReviewCore = isNode ? require('../core/review.js') : root.ReviewCore;
  if (!AiCore || !ReviewCore) throw new Error('AiSingle 依赖 AiCore / ReviewCore，加载顺序错了');
  const api = factory(AiCore, ReviewCore);
  if (isNode) module.exports = api;
  root.AiSingle = api;
})(typeof self !== 'undefined' ? self : this, function (AiCore, ReviewCore) {
  'use strict';

  const CSS_ID = 'quiz-ai-single-css';
  const CSS = [
    '.asg-root{box-sizing:border-box;color:#1b1b1f;font:15px/1.6 system-ui,"Microsoft YaHei",sans-serif;overflow-wrap:anywhere}',
    '.asg-root *{box-sizing:border-box;max-width:100%}',
    '.asg-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
    '.asg-title{font-weight:600;flex:1 1 160px;min-width:0}',
    '.asg-badge{font-size:12.5px;border-radius:999px;padding:2px 8px;border:1px solid #dfe3e8;color:#6b7280;white-space:nowrap}',
    '.asg-badge.ok{background:#eefaf2;border-color:#a9dcbb;color:#14532d}',
    '.asg-badge.no{background:#fdf1f0;border-color:#f0bdb8;color:#8c1d18}',
    '.asg-pick{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0 0}',
    '.asg-sel{min-height:44px;flex:1 1 220px;min-width:0;border:1px solid #cfd3d8;border-radius:10px;background:#fff;font:inherit;padding:0 8px}',
    '.asg-in{min-height:44px;width:130px;border:1px solid #cfd3d8;border-radius:10px;padding:0 8px;font:inherit}',
    '.asg-btns{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 0}',
    '.asg-btn{min-height:44px;padding:0 14px;border:1px solid #cfd3d8;border-radius:10px;background:#f6f7f9;cursor:pointer;font:inherit}',
    '.asg-btn.primary{background:#2b6cb0;border-color:#2b6cb0;color:#fff}',
    '.asg-btn[disabled]{opacity:.45;cursor:default}',
    '.asg-note{color:#6b7280;font-size:12.5px;margin:6px 0 0}',
    '.asg-box{border:1px solid #dfe3e8;border-radius:10px;background:#fff;padding:10px 12px;margin:8px 0 0}',
    '.asg-box.bad{border-color:#f0bdb8;background:#fdf7f6}',
    '.asg-box.good{border-color:#a9dcbb;background:#f6fdf8}',
    '.asg-k{font-weight:600;color:#1b1b1f}',
    '.asg-v{white-space:pre-wrap}',
    '.asg-err{margin:6px 0 0;padding-left:20px;color:#8c1d18;font-size:14px}',
    '.asg-warn{color:#8a4b08;font-size:13.5px;margin:6px 0 0}',
    '.asg-mask{position:fixed;inset:0;background:rgba(12,17,26,.45);display:flex;align-items:center;justify-content:center;padding:16px;z-index:9999}',
    '.asg-dlg{background:#fff;border-radius:14px;max-width:460px;width:100%;padding:16px;box-shadow:0 12px 40px rgba(0,0,0,.25)}',
    '.asg-dlg .asg-btns{margin-top:12px}'
  ].join('');

  function injectCss(doc) {
    if (!doc || doc.getElementById(CSS_ID)) return;
    const st = doc.createElement('style');
    st.id = CSS_ID; st.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(st);
  }
  function el(doc, tag, cls, text) {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  /*
   * mount({ container, store, fetchImpl, provider, model, getDraft, applyDraft, doc })
   *   store/fetchImpl —— 密钥 store 与 fetch（测试可注入假 fetch）
   *   getDraft()      —— 取当前草案（页面上就是校对面板的 getDraft）
   *   applyDraft(d)   —— 把改好的草案写回宿主
   * 返回 { el, destroy, refresh(), stats(), pending(), setProvider(), setIndex() }
   */
  function mount(opts) {
    const o = opts || {};
    const doc = o.doc || (o.container ? o.container.ownerDocument : null) ||
                (typeof document !== 'undefined' ? document : null);
    if (!doc) throw new Error('AiSingle.mount 需要一个 document');
    if (!o.container) throw new Error('AiSingle.mount 需要 container');
    injectCss(doc);

    const store = o.store || null;
    const fetchImpl = o.fetchImpl || (typeof fetch !== 'undefined' ? function (u, i) { return fetch(u, i); } : null);
    const getDraft = o.getDraft || function () { return { questions: [] }; };
    const direct = AiCore.providerRows().filter(function (r) { return r.browserDirect; });

    let provider = o.provider || direct[0].key;
    let model = o.model || (AiCore.PROVIDERS[provider] && AiCore.PROVIDERS[provider].models[0]) || '';
    let index = 0;
    let last = null, pending = null, busy = false;
    let requests = 0, clicks = 0, applied = 0, rejected = 0, applies = 0;

    const rootEl = el(doc, 'div', 'asg-root');
    rootEl.setAttribute('data-asg-root', '1');
    o.container.appendChild(rootEl);

    function providerRow() { return AiCore.providerRows().filter(function (r) { return r.key === provider; })[0] || direct[0]; }
    function question() {
      const qs = (getDraft() || {}).questions || [];
      if (!qs.length) return null;
      const i = Math.min(Math.max(0, index), qs.length - 1);
      return { q: qs[i], index: i };
    }

    /* 就地填 Key（用户报障："调用api没有输入api key的地方"）：
     * 入口原先只在导入 / 校对页那颗按钮上，用户在**本面板**点生成却无处填 Key。
     * 这里挂一块常驻入口（节点只建一次，paint() 反复重画也不丢展开状态）；
     * 宿主没内联 ai-settings.js（老单页版）时安静降级为纯文字提示。 */
    let keyEntry = null;
    function keyEntryNode() {
      if (keyEntry) return keyEntry.el;
      /* 用户要求"填 Key 只保留一个地方"：宿主给了 `keyHint`（导入 / 校对页那颗按钮）就只显示状态行。
       * 没给（独立单页版没有那颗按钮）→ 保留就地展开的老行为。 */
      if (o.keyHint && typeof AiSettings !== 'undefined' && AiSettings.keyStatus) {
        keyEntry = AiSettings.keyStatus({ doc: doc, store: store, where: o.keyHint });
      } else if (typeof AiSettings !== 'undefined' && AiSettings.keyEntry) {
        keyEntry = AiSettings.keyEntry({ doc: doc, store: store, onChange: function () { refresh(); } });
      } else return null;
      return keyEntry.el;
    }

    /* ---------- 画 ---------- */
    function paint() {
      rootEl.textContent = '';
      const row = providerRow();
      const d = getDraft() || {};
      const qs = d.questions || [];
      const cur = question();

      const bar = el(doc, 'div', 'asg-bar');
      bar.appendChild(el(doc, 'div', 'asg-title', '单题智能（解析 / 变式题 / 难度）'));
      bar.appendChild(el(doc, 'span', 'asg-badge', '供应商：' + row.label));
      bar.appendChild(el(doc, 'span', 'asg-badge', row.browserDirect ? '可浏览器直连' : '不可直连'));
      const keyBadge = el(doc, 'span', 'asg-badge');
      keyBadge.setAttribute('data-asg', 'key-badge');
      keyBadge.textContent = 'Key：读取中…';
      bar.appendChild(keyBadge);
      bar.appendChild(el(doc, 'span', 'asg-badge', row.jsonMode ? 'JSON 模式' : '无 JSON 模式'));
      rootEl.appendChild(bar);
      rootEl.appendChild(el(doc, 'div', 'asg-note', '点一次发一次请求；结构不合格的结果不会写回。'));
      const ke = keyEntryNode();
      if (ke) rootEl.appendChild(ke);

      if (!qs.length) {
        rootEl.appendChild(el(doc, 'div', 'asg-note', '还没有可操作的题目：先在下面导入文件（或点「载入内置样卷」）。'));
        return;
      }

      const pick = el(doc, 'div', 'asg-pick');
      const sel = el(doc, 'select', 'asg-sel');
      sel.setAttribute('data-asg', 'pick');
      qs.forEach(function (q, i) {
        const op = doc.createElement('option');
        op.value = String(i);
        op.textContent = '#' + (i + 1) + '　' + (q.type || '') + '　' + String(q.stem || '').slice(0, 24);
        if (i === (cur ? cur.index : 0)) op.selected = true;
        sel.appendChild(op);
      });
      sel.addEventListener('change', function () { index = Number(sel.value) || 0; last = null; pending = null; paint(); });
      pick.appendChild(sel);

      const modelIn = el(doc, 'input', 'asg-in');
      modelIn.setAttribute('data-asg', 'model');
      modelIn.value = model;
      modelIn.addEventListener('change', function () { model = String(modelIn.value || '').trim(); });
      pick.appendChild(modelIn);
      rootEl.appendChild(pick);

      const btns = el(doc, 'div', 'asg-btns');
      ['explain', 'variant', 'difficulty'].forEach(function (kind) {
        const b = el(doc, 'button', 'asg-btn' + (kind === 'explain' ? ' primary' : ''), '生成' + AiCore.KIND_LABEL[kind]);
        b.type = 'button';
        b.setAttribute('data-asg', 'run');
        b.setAttribute('data-asg-kind', kind);
        b.disabled = busy;
        b.addEventListener('click', function () { run(kind); });
        btns.appendChild(b);
      });
      rootEl.appendChild(btns);

      /* ---------- 结果区 ---------- */
      if (last && last.ok) {
        const box = el(doc, 'div', 'asg-box good');
        box.setAttribute('data-asg', 'result');
        if (last.kind === 'explain') {
          box.appendChild(el(doc, 'div', 'asg-k', '解析（含易错点）'));
          box.appendChild(el(doc, 'div', 'asg-v', '解析：' + last.value.explanation));
          box.appendChild(el(doc, 'div', 'asg-v', '易错点：' + last.pitfall));
        } else if (last.kind === 'difficulty') {
          box.appendChild(el(doc, 'div', 'asg-k', '难度评估'));
          box.appendChild(el(doc, 'div', 'asg-v', '难度：' + last.value.level + ' / 5　' + (last.value.reason || '')));
        } else {
          const q = last.question;
          box.appendChild(el(doc, 'div', 'asg-k', '变式题（同考点新题）'));
          box.appendChild(el(doc, 'div', 'asg-v', '题型：' + q.type + '　题干：' + q.stem));
          if ((q.options || []).length) box.appendChild(el(doc, 'div', 'asg-v', (q.options || []).map(function (x) { return x.label + '. ' + x.text; }).join('　')));
          box.appendChild(el(doc, 'div', 'asg-v', '答案：' + (q.type === '判断' ? (q.judgeValue ? '对' : '错') : (q.type === '简答' ? (q.keywords || []).map(function (k) { return k.text; }).join('、') : (q.answerLetters || []).join('')))));
        }
        if (last.warnings && last.warnings.length) box.appendChild(el(doc, 'div', 'asg-warn', '提示：' + last.warnings.join('；')));
        const acts = el(doc, 'div', 'asg-btns');
        const ap = el(doc, 'button', 'asg-btn primary', last.kind === 'variant' ? '加入这份卷' : '附加到原题');
        ap.type = 'button';
        ap.setAttribute('data-asg', 'apply');
        ap.addEventListener('click', function () { apply(); });
        const dis = el(doc, 'button', 'asg-btn', '丢弃');
        dis.type = 'button';
        dis.setAttribute('data-asg', 'discard');
        dis.addEventListener('click', function () { last = null; pending = null; paint(); });
        acts.appendChild(ap); acts.appendChild(dis);
        box.appendChild(acts);
        box.appendChild(el(doc, 'div', 'asg-note', '请求 ' + last.requestCount + ' 次 · 解析策略 ' + (last.strategy || 'direct')));
        rootEl.appendChild(box);
      } else if (last && !last.ok) {
        const box = el(doc, 'div', 'asg-box bad');
        box.setAttribute('data-asg', 'reject');
        box.appendChild(el(doc, 'div', 'asg-k', '这次的结果被拒绝了（原题未改动、题库未写入）'));
        const ul = el(doc, 'ul', 'asg-err');
        (last.errors || []).forEach(function (e) { ul.appendChild(el(doc, 'li', null, e)); });
        box.appendChild(ul);
        if (last.hint) box.appendChild(el(doc, 'div', 'asg-note', last.hint));
        box.appendChild(el(doc, 'div', 'asg-note', '请求 ' + (last.requestCount || 0) + ' 次 · 阶段 ' + (last.stage || '')));
        rootEl.appendChild(box);
      }
      /* ⚠ "本次会话：点击 N 次 · 请求 N 次…"这条**不再显示**：那是给测试看的计数器
       *   （`stats()` 照样返回，测试照旧断言），摆在用户面前只是噪音。 */
    }

    /* ---------- 跑一次 ---------- */
    async function run(kind) {
      const cur = question();
      if (!cur) return { ok: false, error: '没有可操作的题目' };
      clicks++;
      busy = true; last = null; pending = null; paint();
      if (!fetchImpl) { busy = false; last = { ok: false, errors: ['当前环境没有 fetch'], stage: 'env', requestCount: 0 }; paint(); return last; }
      let res;
      try {
        res = await AiCore.runSingle(store, fetchImpl, provider, kind, cur.q,
          { model: model }, { onRequest: function () { requests++; } });
      } catch (e) {
        res = { ok: false, kind: kind, stage: 'exception', errors: [(e && e.message) || String(e)], requestCount: 0 };
      }
      busy = false;
      last = res;
      if (res.ok) pending = res; else rejected++;
      paint();
      return res;
    }

    /* ---------- 采纳（写回草案） ---------- */
    function apply() {
      if (!pending || !pending.ok) return { ok: false, error: '没有通过校验的结果可采纳' };
      const cur = question();
      if (!cur) return { ok: false, error: '题目已经不在草案里了' };
      const d = getDraft();
      let r;
      if (pending.kind === 'explain') r = ReviewCore.setExplanation(d, cur.index, pending.patches.explanation);
      else if (pending.kind === 'difficulty') r = ReviewCore.setDifficulty(d, cur.index, pending.patches.difficulty);
      else r = ReviewCore.appendQuestion(d, pending.question);
      if (!r.ok) { last = { ok: false, errors: [r.error || '写回草案失败'], stage: 'apply', requestCount: 0 }; paint(); return r; }
      if (o.applyDraft) o.applyDraft(r.draft);
      applies++; applied++;
      last = null; pending = null;
      paint();
      return { ok: true, applied: pending ? '' : pending, draft: r.draft };
    }

    async function refresh() {
      const m = await AiCore.keyModel(store);
      const hit = m.rows.filter(function (r) { return r.key === provider; })[0];
      const badge = rootEl.querySelector ? rootEl.querySelector('[data-asg="key-badge"]') : null;
      if (badge) {
        /* 徽章只说"填没填 + 遮罩"：以前那句"（去「AI 密钥与供应商」填）"已经没必要了 ——
         * 面板里下面那一行就是填 Key 的入口（用户要求删掉不必要的小字）。 */
        badge.textContent = hit && hit.configured ? ('Key：' + hit.masked) : 'Key：未填';
        badge.className = 'asg-badge ' + (hit && hit.configured ? 'ok' : 'no');
      }
      return m;
    }

    paint();
    refresh();
    return {
      el: rootEl,
      destroy: function () { if (rootEl.parentNode) rootEl.parentNode.removeChild(rootEl); },
      refresh: refresh,
      run: run, apply: apply,
      setProvider: function (p) { provider = p; model = (AiCore.PROVIDERS[p] && AiCore.PROVIDERS[p].models[0]) || model; paint(); },
      setIndex: function (i) { index = i; last = null; paint(); },
      index: function () { return index; },
      provider: function () { return provider; },
      pending: function () { return pending; },
      last: function () { return last; },
      stats: function () { return { clicks: clicks, requests: requests, applied: applied, applies: applies, rejected: rejected }; }
    };
  }

  /* ============================================================
   *  整卷批量（**必须先弹消耗确认窗**；这是与单题的分野）
   * ============================================================ */
  function mountBatch(opts) {
    const o = opts || {};
    const doc = o.doc || (o.container ? o.container.ownerDocument : null) ||
                (typeof document !== 'undefined' ? document : null);
    if (!doc) throw new Error('AiSingle.mountBatch 需要一个 document');
    if (!o.container) throw new Error('AiSingle.mountBatch 需要 container');
    injectCss(doc);

    const store = o.keyStore || o.store || null;
    const fetchImpl = o.fetchImpl || (typeof fetch !== 'undefined' ? function (u, i) { return fetch(u, i); } : null);
    const direct = AiCore.providerRows().filter(function (r) { return r.browserDirect; });
    let provider = o.provider || direct[0].key;
    let model = o.model || (AiCore.PROVIDERS[provider] && AiCore.PROVIDERS[provider].models[0]) || '';
    let kind = o.kind || 'explain';
    const getQuestions = o.getQuestions || function () { return []; };
    const applyBatch = o.applyBatch || null;

    let plan = null, last = null, busy = false, dialog = null;
    let clicks = 0, confirms = 0, cancels = 0, requests = 0, okCount = 0, failCount = 0;

    const rootEl = el(doc, 'div', 'asg-root');
    rootEl.setAttribute('data-asg-root', 'batch');
    o.container.appendChild(rootEl);

    function questions() { const qs = getQuestions() || []; return qs; }
    function providerRow() { return direct.filter(function (r) { return r.key === provider; })[0] || direct[0]; }

    /* 就地填 Key（与单题面板同一块组件，见上面 keyEntryNode 的说明） */
    let keyEntry = null;
    function keyEntryNode() {
      if (keyEntry) return keyEntry.el;
      if (o.keyHint && typeof AiSettings !== 'undefined' && AiSettings.keyStatus) {
        keyEntry = AiSettings.keyStatus({ doc: doc, store: store, where: o.keyHint });
      } else if (typeof AiSettings !== 'undefined' && AiSettings.keyEntry) {
        keyEntry = AiSettings.keyEntry({ doc: doc, store: store, label: '填 / 换 API Key' });
      } else return null;
      return keyEntry.el;
    }

    function paint() {
      rootEl.textContent = '';
      const row = providerRow();
      const qs = questions();
      plan = AiCore.planBatch(kind, qs, { provider: provider, model: model });
      const head = el(doc, 'div', 'asg-bar');
      head.appendChild(el(doc, 'div', 'asg-title', '生成解析（' + plan.label + '）'));
      head.appendChild(el(doc, 'span', 'asg-badge', row.label));
      head.appendChild(el(doc, 'span', 'asg-badge', qs.length + ' 题'));
      head.appendChild(el(doc, 'span', 'asg-badge', '预计 ' + plan.totalTokens + ' tokens'));
      rootEl.appendChild(head);
      rootEl.appendChild(el(doc, 'div', 'asg-note',
        '批量会先弹消耗确认窗并显示估算 token（单题不弹）。逐题跑，单题失败只跳过那一题。'));
      const ke = keyEntryNode();
      if (ke) rootEl.appendChild(ke);

      const bar = el(doc, 'div', 'asg-btns');
      const run = el(doc, 'button', 'asg-btn primary', '开始生成解析');
      run.type = 'button';
      run.setAttribute('data-asg', 'run-batch');
      run.disabled = busy || !qs.length;
      run.addEventListener('click', function () { ask(); });
      bar.appendChild(run);
      rootEl.appendChild(bar);
      if (!qs.length) rootEl.appendChild(el(doc, 'div', 'asg-note', '还没有题目：先导入一份文件或载入内置样卷。'));

      if (last) {
        const box = el(doc, 'div', 'asg-box ' + (last.ok ? 'good' : 'bad'));
        box.setAttribute('data-asg', 'batch-result');
        box.appendChild(el(doc, 'div', 'asg-k', '批量结果：成功 ' + last.okCount + ' / 失败 ' + last.failCount + '（共 ' + last.total + '）'));
        (last.results || []).forEach(function (r, i) {
          const line = el(doc, 'div', 'asg-v', '#' + (i + 1) + ' ' + (r.ok ? '✔ ' + (r.patches && r.patches.difficulty ? ('难度 ' + r.patches.difficulty) : '已生成') : '✘ ' + (r.errors || []).join('；')));
          line.setAttribute('data-asg', 'batch-item');
          box.appendChild(line);
        });
        if (last.estimate && last.actual) {
          box.appendChild(el(doc, 'div', 'asg-note', '估算 ' + last.estimate.totalTokens + ' / 实耗 ' + last.actual.totalTokens
            + ' tokens（偏差 ' + last.deviation + '%）'));
        } else {
          box.appendChild(el(doc, 'div', 'asg-note', '本轮服务商没回用量，无法核偏差'));
        }
        rootEl.appendChild(box);
      }

      const st = el(doc, 'div', 'asg-note');
      st.setAttribute('data-asg', 'stats');
      st.textContent = '点击 ' + clicks + ' · 确认 ' + confirms + ' · 取消 ' + cancels + ' · 请求 ' + requests + ' · 成功 ' + okCount + ' · 失败 ' + failCount;
      rootEl.appendChild(st);
    }

    /* 消耗确认窗：未确认**一个请求都不发** */
    function ask() {
      clicks++;
      const qs = questions();
      if (!qs.length) return { ok: false, error: '没有可批量处理的题目' };
      if (!fetchImpl) { last = { ok: false, errors: ['当前环境没有 fetch'] }; paint(); return last; }
      const mask = el(doc, 'div', 'asg-mask');
      mask.setAttribute('data-asg', 'confirm-mask');
      const dlg = el(doc, 'div', 'asg-dlg');
      dlg.setAttribute('data-asg', 'confirm-dialog');
      dlg.appendChild(el(doc, 'div', 'asg-k', '要开始生成解析吗？'));
      dlg.appendChild(el(doc, 'div', null, plan.message));
      const rowBtns = el(doc, 'div', 'asg-btns');
      const yes = el(doc, 'button', 'asg-btn primary', '确认开始');
      yes.type = 'button';
      yes.setAttribute('data-asg', 'confirm-yes');
      const no = el(doc, 'button', 'asg-btn', '取消');
      no.type = 'button';
      no.setAttribute('data-asg', 'confirm-no');
      yes.addEventListener('click', function () { closeDialog(); confirms++; run(); });
      no.addEventListener('click', function () { closeDialog(); cancels++; paint(); });
      mask.addEventListener('click', function (e) { if (e && e.target === mask) { closeDialog(); cancels++; paint(); } });
      rowBtns.appendChild(yes); rowBtns.appendChild(no);
      dlg.appendChild(rowBtns);
      mask.appendChild(dlg);
      (rootEl.parentNode || rootEl).appendChild(mask);
      dialog = mask;
      paint();
      return { ok: true, pending: true };
    }
    function closeDialog() { if (dialog && dialog.parentNode) dialog.parentNode.removeChild(dialog); dialog = null; }

    async function run() {
      busy = true; paint();
      let res;
      try {
        res = await AiCore.runBatch(store, fetchImpl, provider, kind, questions(),
          { model: model, confirmed: true }, { onRequest: function () { requests++; } });
      } catch (e) {
        res = { ok: false, errors: [(e && e.message) || String(e)], results: [], requestCount: 0 };
      }
      busy = false; last = res;
      okCount += res.okCount || 0; failCount += res.failCount || 0;
      if (applyBatch) { try { applyBatch(res); } catch (e) { /* 应用失败不影响结果展示 */ } }
      paint();
      return res;
    }

    paint();
    return {
      el: rootEl,
      destroy: function () { closeDialog(); if (rootEl.parentNode) rootEl.parentNode.removeChild(rootEl); },
      refresh: paint,
      ask: ask, run: run,
      hasDialog: function () { return !!dialog; },
      plan: function () { return plan; },
      last: function () { return last; },
      stats: function () { return { clicks: clicks, confirms: confirms, cancels: cancels, requests: requests, okCount: okCount, failCount: failCount }; }
    };
  }

  return { CSS: CSS, CSS_ID: CSS_ID, mount: mount, mountBatch: mountBatch };
});
