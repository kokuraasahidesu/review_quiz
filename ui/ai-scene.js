/* ============================================================
 *  ui/ai-scene.js —— 两个"场景化"AI 面板（只做 DOM）
 *
 *    mountReview()  交卷后的**整卷总评**：必须先过一道**消耗确认窗**（一次调用 token 明显更大），
 *                   确认后才发请求；结果显示总评 + 薄弱考点 + 建议。
 *    mountMistake() 误答本里的**举一反三**：对选中的误答题目生成同考点新题，
 *                   确认新题结构合法后可一键「加入这套卷」。
 *
 *  与单题面板（ai-single）的分工：单题**不弹**消耗确认（点一次一次请求），
 *  整卷总评**必须弹**（这就是两个小类的分野，别混）。
 * ============================================================ */
(function (root, factory) {
  const isNode = (typeof module !== 'undefined' && module.exports);
  const AiCore = isNode ? require('../core/ai.js') : root.AiCore;
  if (!AiCore) throw new Error('AiScene 依赖 AiCore（core/ai.js），加载顺序错了');
  const api = factory(AiCore);
  if (isNode) module.exports = api;
  root.AiScene = api;
})(typeof self !== 'undefined' ? self : this, function (AiCore) {
  'use strict';

  const CSS_ID = 'quiz-ai-scene-css';
  const CSS = [
    '.asc-root{box-sizing:border-box;color:#1b1b1f;font:15px/1.6 system-ui,"Microsoft YaHei",sans-serif;overflow-wrap:anywhere}',
    '.asc-root *{box-sizing:border-box;max-width:100%}',
    '.asc-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
    '.asc-title{font-weight:600;flex:1 1 150px;min-width:0}',
    '.asc-badge{font-size:12.5px;border-radius:999px;padding:2px 8px;border:1px solid #dfe3e8;color:#6b7280;white-space:nowrap}',
    '.asc-badge.ok{background:#eefaf2;border-color:#a9dcbb;color:#14532d}',
    '.asc-badge.no{background:#fdf1f0;border-color:#f0bdb8;color:#8c1d18}',
    '.asc-btn{min-height:44px;padding:0 14px;border:1px solid #cfd3d8;border-radius:10px;background:#f6f7f9;cursor:pointer;font:inherit}',
    '.asc-btn.primary{background:#2b6cb0;border-color:#2b6cb0;color:#fff}',
    '.asc-btn[disabled]{opacity:.45;cursor:default}',
    '.asc-note{color:#6b7280;font-size:13px;margin:6px 0 0}',
    '.asc-box{border:1px solid #dfe3e8;border-radius:10px;background:#fff;padding:10px 12px;margin:8px 0 0}',
    '.asc-box.good{border-color:#a9dcbb;background:#f6fdf8}',
    '.asc-box.bad{border-color:#f0bdb8;background:#fdf7f6}',
    '.asc-k{font-weight:600;margin:0 0 4px}',
    '.asc-v{white-space:pre-wrap}',
    '.asc-ul{margin:6px 0 0;padding-left:20px}',
    '.asc-ul li{margin:2px 0}',
    '.asc-mask{position:fixed;inset:0;background:rgba(12,17,26,.45);display:flex;align-items:center;justify-content:center;padding:16px;z-index:9999}',
    '.asc-dlg{background:#fff;border-radius:14px;max-width:460px;width:100%;padding:16px;box-shadow:0 12px 40px rgba(0,0,0,.25)}',
    '.asc-dlg .asc-row{display:flex;gap:10px;margin-top:12px}',
    '.asc-dlg .asc-row .asc-btn{flex:1 1 0}',
    '.asc-warn{color:#8a4b08;font-size:13.5px;margin:6px 0 0}'
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
  function badges(doc, row, box) {
    box.appendChild(el(doc, 'span', 'asc-badge', row.label));
    box.appendChild(el(doc, 'span', 'asc-badge ' + (row.browserDirect ? 'ok' : 'no'), row.directLabel));
    box.appendChild(el(doc, 'span', 'asc-badge', row.jsonMode ? 'JSON 模式' : '无 JSON 模式'));
  }

  /* 面板上的 Key 提示：用户要求"填 Key 只保留一个地方"（「导入 / 校对」页顶部那颗
   * 「AI 密钥与供应商」）——所以这两个面板**不再摆填 Key 的表单**，只留一行状态 + 一句指路。
   * ⚠ 独立单页版（没有"导入 / 校对"页可去）仍然就地展开：否则那一页会变成"要 Key 却没处填"。
   * 节点只建一次（paint 反复调用，重建会把展开状态抖掉）。 */
  function makeKeyEntry(doc, store, onChange, keyHint) {
    let entry = null;
    return function node() {
      if (entry) return entry.el;
      if (typeof AiSettings === 'undefined') return null;
      if (keyHint && AiSettings.keyStatus) {
        entry = AiSettings.keyStatus({ doc: doc, store: store, where: keyHint });
      } else if (AiSettings.keyEntry) {
        entry = AiSettings.keyEntry({ doc: doc, store: store, onChange: onChange });
      } else return null;
      return entry.el;
    };
  }

  /* ============================================================
   *  整卷总评
   * ============================================================ */
  function mountReview(opts) {
    const o = opts || {};
    const doc = o.doc || (o.container ? o.container.ownerDocument : null) ||
                (typeof document !== 'undefined' ? document : null);
    if (!doc) throw new Error('AiScene.mountReview 需要一个 document');
    if (!o.container) throw new Error('AiScene.mountReview 需要 container');
    injectCss(doc);

    /* ⚠ 两个 store 是两个命名空间：密钥在 `secret`、题库在 `app`。混成一个的话，
     *   "生成"能成、"加入试卷"必然找不到那套卷（实测踩过，见 verify/ai-scene.test.js）。 */
    const keyStore = o.keyStore || o.store || null;
    const fetchImpl = o.fetchImpl || (typeof fetch !== 'undefined' ? function (u, i) { return fetch(u, i); } : null);
    const direct = AiCore.providerRows().filter(function (r) { return r.browserDirect; });
    let provider = o.provider || direct[0].key;
    let model = o.model || (AiCore.PROVIDERS[provider] && AiCore.PROVIDERS[provider].models[0]) || '';
    const summary = o.summary || {};
    const questions = Array.isArray(o.questions) ? o.questions : [];
    const answers = o.answers || {};          // 题 id → 你的作答（交卷结算里没有这一项，必须由宿主传）

    let last = null, busy = false, dialog = null;
    let clicks = 0, requests = 0, confirms = 0, cancels = 0, rejected = 0;
    const keyEntryNode = makeKeyEntry(doc, keyStore, function () { paint(); }, o.keyHint);

    const rootEl = el(doc, 'div', 'asc-root');
    rootEl.setAttribute('data-asc-root', 'review');
    o.container.appendChild(rootEl);

    function paint() {
      rootEl.textContent = '';
      const row = direct.filter(function (r) { return r.key === provider; })[0] || direct[0];
      const head = el(doc, 'div', 'asc-head');
      head.appendChild(el(doc, 'div', 'asc-title', '整卷点评（交卷后）'));
      badges(doc, row, head);
      head.appendChild(el(doc, 'span', 'asc-badge', '本轮 ' + (summary.total || 0) + ' 题 · 答错 ' + ((summary.per || []).filter(function (p) { return !p.correct; }).length) + ' 题'));
      rootEl.appendChild(head);
      rootEl.appendChild(el(doc, 'div', 'asc-note', '整卷调用更贵：点一次先弹消耗确认。'));
      const ke0 = keyEntryNode();
      if (ke0) rootEl.appendChild(ke0);

      const bar = el(doc, 'div', 'asc-head');
      const run = el(doc, 'button', 'asc-btn primary', '生成整卷总评');
      run.type = 'button';
      run.setAttribute('data-asc', 'run-review');
      run.disabled = busy;
      run.addEventListener('click', function () { ask(); });
      bar.appendChild(run);
      const modelIn = el(doc, 'input', 'asc-btn');
      modelIn.setAttribute('data-asc', 'model');
      modelIn.value = model;
      modelIn.addEventListener('change', function () { model = String(modelIn.value || '').trim(); });
      bar.appendChild(modelIn);
      rootEl.appendChild(bar);

      if (last && last.ok) {
        const box = el(doc, 'div', 'asc-box good');
        box.setAttribute('data-asc', 'review-result');
        box.appendChild(el(doc, 'div', 'asc-k', '总评'));
        box.appendChild(el(doc, 'div', 'asc-v', last.value.summary));
        const wl = el(doc, 'ul', 'asc-ul');
        (last.value.weakPoints || []).forEach(function (x) { wl.appendChild(el(doc, 'li', null, x)); });
        box.appendChild(el(doc, 'div', 'asc-k', '薄弱考点'));
        box.appendChild(wl);
        const al = el(doc, 'ul', 'asc-ul');
        (last.value.advice || []).forEach(function (x) { al.appendChild(el(doc, 'li', null, x)); });
        box.appendChild(el(doc, 'div', 'asc-k', '建议'));
        box.appendChild(al);
        box.appendChild(el(doc, 'div', 'asc-note', '引用了本轮记录：'
          + (last.grounding.hitStrong || []).concat(last.grounding.hitStems || []).join('、')
          + '　·　请求 ' + last.requestCount + ' 次'));
        rootEl.appendChild(box);
      } else if (last && !last.ok && !last.needConfirm) {
        const box = el(doc, 'div', 'asc-box bad');
        box.setAttribute('data-asc', 'review-reject');
        box.appendChild(el(doc, 'div', 'asc-k', '这次没成（没有改动任何东西）'));
        const ul = el(doc, 'ul', 'asc-ul');
        (last.errors || []).forEach(function (e) { ul.appendChild(el(doc, 'li', null, e)); });
        box.appendChild(ul);
        if (last.hint) box.appendChild(el(doc, 'div', 'asc-note', last.hint));
        rootEl.appendChild(box);
      }
      /* ⚠ 那行"点击 N · 确认 N · 请求 N"的计数器**不再显示**（`stats()` 照样给测试用）。 */
    }

    /* 消耗确认窗：**先弹、后发**；点遮罩空白处 = 取消 */
    function ask() {
      if (!fetchImpl) { last = { ok: false, errors: ['当前环境没有 fetch'], requestCount: 0 }; paint(); return; }
      clicks++;
      const probe = AiCore.reviewRequest(summary, questions, { model: model, answers: answers });
      const c = {
        providerLabel: (direct.filter(function (r) { return r.key === provider; })[0] || { label: provider }).label,
        promptTokens: AiCore.estimateTokens(probe.opt.system + probe.opt.user),
        wrongCount: probe.brief.wrongCount, total: probe.brief.total
      };
      /* 这里**故意复用核心的估算口径**（estimateTokens），不自己编一个数字 */
      const mask = el(doc, 'div', 'asc-mask');
      mask.setAttribute('data-asc', 'confirm-mask');
      const dlg = el(doc, 'div', 'asc-dlg');
      dlg.setAttribute('data-asc', 'confirm-dialog');
      dlg.appendChild(el(doc, 'div', 'asc-k', '要生成整卷总评吗？'));
      dlg.appendChild(el(doc, 'div', null, '会把本轮 ' + c.total + ' 题的逐题记录（含得分与你的作答）发给 ' + c.providerLabel
        + '，预计消耗 ' + c.promptTokens + ' tokens 左右（答错 ' + c.wrongCount + ' 题）。'));
      const rowBtns = el(doc, 'div', 'asc-row');
      const yes = el(doc, 'button', 'asc-btn primary', '确认生成');
      yes.type = 'button';
      yes.setAttribute('data-asc', 'confirm-yes');
      const no = el(doc, 'button', 'asc-btn', '取消');
      no.type = 'button';
      no.setAttribute('data-asc', 'confirm-no');
      yes.addEventListener('click', function () { closeDialog(); confirms++; run(); });
      no.addEventListener('click', function () { closeDialog(); cancels++; });
      mask.addEventListener('click', function (e) { if (e && e.target === mask) { closeDialog(); cancels++; } });
      rowBtns.appendChild(yes); rowBtns.appendChild(no);
      dlg.appendChild(rowBtns);
      mask.appendChild(dlg);
      (rootEl.parentNode || rootEl).appendChild(mask);
      dialog = mask;
      paint();
    }
    function closeDialog() { if (dialog && dialog.parentNode) dialog.parentNode.removeChild(dialog); dialog = null; }

    async function run() {
      busy = true; paint();
      let res;
      try {
        res = await AiCore.runReview(keyStore, fetchImpl, provider, summary, questions,
          { model: model, confirmed: true, answers: answers },
          { onRequest: function () { requests++; } });
      } catch (e) {
        res = { ok: false, errors: [(e && e.message) || String(e)], stage: 'exception', requestCount: 0 };
      }
      busy = false; last = res;
      if (!res.ok) rejected++;
      paint();
      if (o.onResult) o.onResult(res);
      return res;
    }

    paint();
    return {
      el: rootEl,
      destroy: function () { closeDialog(); if (rootEl.parentNode) rootEl.parentNode.removeChild(rootEl); },
      ask: ask, confirm: function () { const y = rootEl.parentNode && rootEl.parentNode.querySelector ? rootEl.parentNode.querySelector('[data-asc="confirm-yes"]') : null; if (y) y.click(); return !!y; },
      run: run,
      hasDialog: function () { return !!dialog; },
      last: function () { return last; },
      stats: function () { return { clicks: clicks, confirms: confirms, cancels: cancels, requests: requests, rejected: rejected }; }
    };
  }

  /* ============================================================
   *  举一反三（误答本里一键出同考点新题 → 加入这套卷）
   * ============================================================ */
  function mountMistake(opts) {
    const o = opts || {};
    const doc = o.doc || (o.container ? o.container.ownerDocument : null) ||
                (typeof document !== 'undefined' ? document : null);
    if (!doc) throw new Error('AiScene.mountMistake 需要一个 document');
    if (!o.container) throw new Error('AiScene.mountMistake 需要 container');
    injectCss(doc);

    const keyStore = o.keyStore || o.store || null;
    const examStore = o.examStore || null;    // 题库在 app 命名空间，与密钥 store 不是同一个
    const fetchImpl = o.fetchImpl || (typeof fetch !== 'undefined' ? function (u, i) { return fetch(u, i); } : null);
    const direct = AiCore.providerRows().filter(function (r) { return r.browserDirect; });
    let provider = o.provider || direct[0].key;
    let model = o.model || (AiCore.PROVIDERS[provider] && AiCore.PROVIDERS[provider].models[0]) || '';
    const getSelection = o.getSelection || function () { return null; };

    let last = null, added = null, busy = false;
    let clicks = 0, requests = 0, rejects = 0, adds = 0;
    const keyEntryNode = makeKeyEntry(doc, keyStore, function () { paint(); }, o.keyHint);

    const rootEl = el(doc, 'div', 'asc-root');
    rootEl.setAttribute('data-asc-root', 'mistake');
    o.container.appendChild(rootEl);

    function paint() {
      rootEl.textContent = '';
      const row = direct.filter(function (r) { return r.key === provider; })[0] || direct[0];
      const sel = getSelection();
      const head = el(doc, 'div', 'asc-head');
      head.appendChild(el(doc, 'div', 'asc-title', '举一反三（同考点新题）'));
      badges(doc, row, head);
      rootEl.appendChild(head);
      rootEl.appendChild(el(doc, 'div', 'asc-note',
        sel ? ('当前选中：第 ' + ((sel.index || 0) + 1) + ' 题　' + String((sel.question && sel.question.stem) || '').slice(0, 30))
            : '先在错题列表里点一条，再生成同考点新题。'));
      const ke1 = keyEntryNode();
      if (ke1) rootEl.appendChild(ke1);

      const bar = el(doc, 'div', 'asc-head');
      const run = el(doc, 'button', 'asc-btn primary', '生成同考点新题');
      run.type = 'button';
      run.setAttribute('data-asc', 'run-variant');
      run.disabled = busy || !sel;
      run.addEventListener('click', function () { go(); });
      bar.appendChild(run);
      rootEl.appendChild(bar);

      if (last && last.ok) {
        const q = last.question;
        const box = el(doc, 'div', 'asc-box good');
        box.setAttribute('data-asc', 'variant-result');
        box.appendChild(el(doc, 'div', 'asc-k', '新题（' + q.type + '）'));
        box.appendChild(el(doc, 'div', 'asc-v', q.stem));
        if ((q.options || []).length) {
          box.appendChild(el(doc, 'div', 'asc-v', (q.options || []).map(function (x) { return x.label + '. ' + x.text; }).join('　')));
        }
        box.appendChild(el(doc, 'div', 'asc-v', '答案：' + (q.type === '判断' ? (q.judgeValue ? '对' : '错')
          : (q.type === '简答' ? (q.keywords || []).map(function (k) { return k.text; }).join('、') : (q.answerLetters || []).join('')))));
        const acts = el(doc, 'div', 'asc-head');
        const add = el(doc, 'button', 'asc-btn primary', '加入《' + ((sel && sel.examTitle) || '当前试卷') + '》');
        add.type = 'button';
        add.setAttribute('data-asc', 'add-variant');
        add.addEventListener('click', function () { addTo(); });
        acts.appendChild(add);
        box.appendChild(acts);
        if (added && added.ok) {
          box.appendChild(el(doc, 'div', 'asc-note', '已加入：' + added.type + ' 分组现在有 ' + added.groupCount + ' 题（整卷 ' + added.after.total + ' 题）'));
        }
        rootEl.appendChild(box);
      } else if (last && !last.ok) {
        const box = el(doc, 'div', 'asc-box bad');
        box.setAttribute('data-asc', 'variant-reject');
        box.appendChild(el(doc, 'div', 'asc-k', '这次没成（原题未改动、试卷未写入）'));
        const ul = el(doc, 'ul', 'asc-ul');
        (last.errors || []).forEach(function (e) { ul.appendChild(el(doc, 'li', null, e)); });
        box.appendChild(ul);
        if (last.hint) box.appendChild(el(doc, 'div', 'asc-note', last.hint));
        rootEl.appendChild(box);
      }

      /* ⚠ 那行"点击 N · 请求 N · 拒绝 N · 已加入 N"的计数器也删了（`stats()` 仍给测试用）。 */
    }

    async function go() {
      const sel = getSelection();
      if (!sel) { last = { ok: false, errors: ['还没有选中题目'] }; paint(); return last; }
      if (!fetchImpl) { last = { ok: false, errors: ['当前环境没有 fetch'] }; paint(); return last; }
      clicks++; busy = true; added = null; paint();
      let res;
      try {
        res = await AiCore.runMistakeVariant(keyStore, fetchImpl, provider, sel.question, sel.entry || {},
          { model: model }, { onRequest: function () { requests++; } });
      } catch (e) {
        res = { ok: false, errors: [(e && e.message) || String(e)], stage: 'exception', requestCount: 0 };
      }
      busy = false; last = res;
      if (!res.ok) rejects++;
      paint();
      return res;
    }

    async function addTo() {
      const sel = getSelection();
      if (!last || !last.ok || !sel) return { ok: false, error: '没有可加入的新题' };
      if (!examStore) {
        last = { ok: false, errors: ['没有连接题库存储，加不进试卷'], stage: 'no_exam_store' };
        paint();
        return last;
      }
      const r = await AiCore.appendVariant(examStore, sel.examId, last.question, {});
      if (!r.ok) { last = { ok: false, errors: [r.error], stage: r.stage || 'store' }; paint(); return r; }
      adds++; added = r;
      if (o.onAdded) o.onAdded(r, sel);
      paint();
      return r;
    }

    paint();
    return {
      el: rootEl,
      destroy: function () { if (rootEl.parentNode) rootEl.parentNode.removeChild(rootEl); },
      refresh: paint,
      run: go, add: addTo,
      last: function () { return last; },
      added: function () { return added; },
      stats: function () { return { clicks: clicks, requests: requests, rejects: rejects, adds: adds }; }
    };
  }

  return { CSS: CSS, CSS_ID: CSS_ID, mountReview: mountReview, mountMistake: mountMistake };
});
