/* ============================================================
 *  ui/ai-settings.js —— AI 密钥与供应商能力表（只做 DOM）
 *
 *  该显示什么全部来自 `AiCore.keyModel()`（能力标注 + 配置状态 + 能否立刻调用三合一）；
 *  这一层只负责画、只把"填/清"转成回调，**不许自己判断哪家能不能直连**。
 *
 *  三条界面纪律：
 *    ① 输入框是 `type=password`，已保存的只展示**遮罩**（`AiCore.maskKey`），原文不回显；
 *    ② 不可直连的供应商**红标 + 给出为什么**（不是等用户填完 Key 再报一个看不懂的错）；
 *    ③ 反复强调"只存在本机、不随分享导出"——这是北极星要求，不能只写在文档里。
 * ============================================================ */
(function (root, factory) {
  const isNode = (typeof module !== 'undefined' && module.exports);
  const AiCore = isNode ? require('../core/ai.js') : root.AiCore;
  if (!AiCore) throw new Error('AiSettings 依赖 AiCore（core/ai.js），加载顺序错了');
  const api = factory(AiCore);
  if (isNode) module.exports = api;
  root.AiSettings = api;
})(typeof self !== 'undefined' ? self : this, function (AiCore) {
  'use strict';

  const CSS_ID = 'quiz-ai-settings-css';
  const CSS = [
    '.as-root{box-sizing:border-box;color:#1b1b1f;font:15px/1.6 system-ui,"Microsoft YaHei",sans-serif;overflow-wrap:anywhere}',
    '.as-root *{box-sizing:border-box;max-width:100%}',
    '.as-head{margin:0 0 6px;font-size:16px;font-weight:600}',
    '.as-privacy{border:1px solid #a9dcbb;background:#eefaf2;border-radius:8px;padding:8px 10px;margin:0 0 10px;font-size:13.5px;color:#14532d}',
    '.as-rows{display:flex;flex-direction:column;gap:10px}',
    '.as-row{border:1px solid #dfe3e8;border-radius:10px;padding:10px 12px;background:#fff}',
    '.as-row.blocked{border-color:#f0bdb8;background:#fdf7f6}',
    '.as-t{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
    '.as-name{font-weight:600;flex:1 1 140px;min-width:0}',
    '.as-badge{font-size:12.5px;border-radius:999px;padding:2px 8px;border:1px solid #dfe3e8;color:#6b7280;white-space:nowrap}',
    '.as-badge.ok{background:#eefaf2;border-color:#a9dcbb;color:#14532d}',
    '.as-badge.no{background:#fdf1f0;border-color:#f0bdb8;color:#8c1d18}',
    '.as-badge.warn{background:#fff8ec;border-color:#f0d3a8;color:#8a4b08}',
    '.as-meta{color:#6b7280;font-size:12.5px;margin:4px 0 0}',
    '.as-block{border:1px solid #f0d3a8;background:#fff8ec;border-radius:8px;padding:6px 8px;margin:6px 0 0;font-size:13px;color:#8a4b08}',
    '.as-form{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0 0}',
    '.as-in{flex:1 1 200px;min-width:0;min-height:44px;padding:0 10px;border:1px solid #cfd3d8;border-radius:10px;font:inherit}',
    '.as-btn{min-height:44px;padding:0 14px;border:1px solid #cfd3d8;border-radius:10px;background:#f6f7f9;cursor:pointer;font:inherit}',
    '.as-btn.primary{background:#2b6cb0;border-color:#2b6cb0;color:#fff}',
    '.as-btn[disabled]{opacity:.45;cursor:default}',
    '.as-msg{font-size:13px;margin:6px 0 0}',
    '.as-msg.ok{color:#14532d}',
    '.as-msg.err{color:#8c1d18}',
    '.as-foot{color:#6b7280;font-size:12.5px;margin:10px 0 0}',
    /* 就地入口（AI 面板里的那一行）：一行状态 + 一颗按钮，点开在下面展开完整设置 */
    '.as-entry{border:1px solid #dfe3e8;background:#f8f9fb;border-radius:10px;padding:8px 10px;margin:8px 0 0}',
    '.as-entry-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
    '.as-entry-state{flex:1 1 220px;min-width:0;font-size:13.5px;color:#6b7280}',
    '.as-entry-state.ok{color:#14532d}',
    '.as-entry-state.warn{color:#8a4b08}',
    '.as-entry-state.no{color:#8c1d18}',
    '.as-entry-box{margin-top:8px}',
    /* 只读状态行下面那句指路（"去哪儿填 Key"）：13.5px，不当小字糊在角落 */
    '.as-entry-hint{margin-top:2px;font-size:13.5px;color:#4a5158}'
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
   * mount({ container, store, doc, onChange })
   *   store    —— AiCore.openKeyStore(localStorage) 的产物（可为 null = 存储不可用）
   *   onChange(action) —— 'save' | 'clear'（落盘已完成，调用方据此刷新别处）
   * 返回 { el, destroy, refresh(), rows(), stats() }
   */
  function mount(opts) {
    const o = opts || {};
    const doc = o.doc || (o.container ? o.container.ownerDocument : null) ||
                (typeof document !== 'undefined' ? document : null);
    if (!doc) throw new Error('AiSettings.mount 需要一个 document');
    if (!o.container) throw new Error('AiSettings.mount 需要 container');
    injectCss(doc);

    const store = o.store || null;
    const rootEl = el(doc, 'div', 'as-root');
    rootEl.setAttribute('data-as-root', '1');
    o.container.appendChild(rootEl);

    let model = null, saves = 0, clears = 0, errors = 0;
    /* 结果提示要放在**被重画的那块之外**：
     * 保存/清除之后会 refresh() → paint() 会清空列表，行内提示当场就没了（实测过：
     * "没写进本地存储"这句刚设上就被重画抹掉，用户根本看不到）。所以存成状态、由 paint 重画出来。 */
    let status = null;

    function msg(box, text, kind) {
      const m = el(doc, 'div', 'as-msg ' + (kind || ''), text);
      box.appendChild(m);
      return m;
    }

    function paint() {
      rootEl.textContent = '';
      rootEl.appendChild(el(doc, 'h3', 'as-head', 'AI 密钥与供应商能力'));
      rootEl.appendChild(el(doc, 'div', 'as-privacy',
        '密钥只存本机，不上传、不随分享文件导出；本页只显示遮罩。'
        + (store ? '' : '　⚠ 当前存储不可用，填了也留不住（刷新就没了）。')));

      if (!model) {
        rootEl.appendChild(el(doc, 'div', 'as-meta', '正在读本地设置…'));
        return;
      }

      const list = el(doc, 'div', 'as-rows');
      model.rows.forEach(function (r) {
        const box = el(doc, 'div', 'as-row' + (r.browserDirect ? '' : ' blocked'));
        const top = el(doc, 'div', 'as-t');
        top.appendChild(el(doc, 'div', 'as-name', r.label));
        top.appendChild(el(doc, 'span', 'as-badge ' + (r.jsonMode ? 'ok' : 'warn'), r.jsonModeLabel));
        top.appendChild(el(doc, 'span', 'as-badge ' + (r.browserDirect ? 'ok' : 'no')
          + '" data-as="direct" data-as-value="' + (r.browserDirect ? '1' : '0'), r.directLabel));
        top.appendChild(el(doc, 'span', 'as-badge ' + (r.configured ? 'ok' : ''), r.configured ? '已填 Key' : '未填 Key'));
        box.appendChild(top);

        /* 每家只留**选它需要的技术事实**：接口 / 模型（+ CORS 只在不可直连时才写，那时它才是关键信息）。
         * 各家那句"便宜 / 长文本强 / 国内直连快"之类的推广小字按用户要求删掉了。 */
        box.appendChild(el(doc, 'div', 'as-meta', '接口：' + r.base + '　模型：' + r.models.join('、')
          + ((!r.browserDirect && r.cors) ? '　CORS：' + r.cors : '')));
        if (r.configured) {
          const m = el(doc, 'div', 'as-meta', '已保存：' + r.masked + (r.savedAt ? '（' + r.savedAt.replace('T', ' ').slice(0, 16) + '）' : ''));
          m.setAttribute('data-as', 'masked');
          box.appendChild(m);
        }
        /* 不可直连：红标 + 明确写出为什么，并且**禁用输入**（填了也没用，别让用户白折腾） */
        if (!r.browserDirect) {
          const b = el(doc, 'div', 'as-block', '不可直连：' + r.directNote);
          b.setAttribute('data-as', 'blocked-note');
          box.appendChild(b);
        }

        const form = el(doc, 'div', 'as-form');
        const input = el(doc, 'input', 'as-in');
        input.type = 'password';
        input.setAttribute('data-as', 'input');
        input.setAttribute('data-as-provider', r.key);
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('spellcheck', 'false');
        input.placeholder = r.browserDirect ? (r.keyHint || '粘贴 API Key（只存本机）') : '这家不支持直连，填了也用不了';
        input.disabled = !r.browserDirect;
        const saveBtn = el(doc, 'button', 'as-btn primary', '保存');
        saveBtn.type = 'button';
        saveBtn.setAttribute('data-as', 'save');
        saveBtn.setAttribute('data-as-provider', r.key);
        saveBtn.disabled = !r.browserDirect;
        const clearBtn = el(doc, 'button', 'as-btn', '清除');
        clearBtn.type = 'button';
        clearBtn.setAttribute('data-as', 'clear');
        clearBtn.setAttribute('data-as-provider', r.key);
        clearBtn.disabled = !r.configured;

        const note = el(doc, 'div', 'as-msg');
        saveBtn.addEventListener('click', async function () {
          const v = input.value;
          const res = await AiCore.saveKey(store, r.key, v, { now: new Date().toISOString() });
          if (!res.ok) { errors++; note.className = 'as-msg err'; note.textContent = res.error; return; }
          saves++;
          input.value = '';                                   // 存完就把输入框清掉，原文不留在 DOM 里
          /* ⚠ 不能一律说"已保存、刷新后仍在"：存储不可用时这句就是谎话。
           *   实测过：store 为 null 时 saveKey 仍然 ok（写进内存），但 **persisted=false** —— 界面必须跟着说实话。 */
          status = (res.persisted === false)
            ? { kind: 'err', text: res.masked + ' 没写进本地存储（这次的填写刷新后就没了）' }
            : { kind: 'ok', text: '已保存 ' + res.masked + '（只在本机；刷新后仍在，可直接用于调用）' };
          if (o.onChange) o.onChange('save', r.key);
          await refresh();
        });
        clearBtn.addEventListener('click', async function () {
          const res = await AiCore.clearKey(store, r.key);
          if (!res.ok) { errors++; note.className = 'as-msg err'; note.textContent = res.error; return; }
          clears++;
          status = { kind: 'ok', text: res.cleared ? ('已清除 ' + r.label + ' 的 Key') : (r.label + ' 本来就没填过') };
          if (o.onChange) o.onChange('clear', r.key);
          await refresh();
        });

        form.appendChild(input);
        form.appendChild(saveBtn);
        form.appendChild(clearBtn);
        box.appendChild(form);
        box.appendChild(note);
        list.appendChild(box);
      });
      rootEl.appendChild(list);
      if (status) {
        const s = el(doc, 'div', 'as-msg ' + (status.kind || ''), status.text);
        s.setAttribute('data-as', 'status');
        rootEl.appendChild(s);
      }
      /* ⚠ 那行"可直连且已填 Key 的：N 家（共 M 家）…"按用户要求删了：
       *   每家的徽章（可浏览器直连 / 未填 Key / 已填 Key）已经把同样的事说清楚了，再说一遍是噪音。 */
    }

    async function refresh() {
      model = await AiCore.keyModel(store);
      paint();
      return model;
    }

    paint();
    return {
      el: rootEl,
      destroy: function () { if (rootEl.parentNode) rootEl.parentNode.removeChild(rootEl); },
      refresh: refresh,
      rows: function () { return model ? model.rows : []; },
      model: function () { return model; },
      stats: function () { return { saves: saves, clears: clears, errors: errors, callable: model ? model.callableCount : -1 }; }
    };
  }

  /* ============================================================
   *  keyEntry({ doc, store, onChange, label })
   *
   *  用户报障："调用api没有输入api key的地方" —— 根因是**入口只有一处**（导入 / 校对页那颗
   *  「AI 密钥与供应商」按钮），而用户是在**错题本的举一反三 / 交卷页的整卷点评**上按的生成。
   *  所以这里给"每个 AI 面板"配一块**就地入口**：一行小字说清"现在能不能调用"，
   *  旁边一颗按钮，点开就在原地展开完整的密钥设置（选供应商 → 粘贴 → 保存），不用跳页、不用找。
   *
   *  ⚠ 复用同一个 mount()（**不另写一套填 Key 的表单**），所以"遮罩显示 / 不可直连红标 /
   *    只存本机"这三条纪律在哪儿都一致。
   *  返回 { el, refresh(), toggle(), open(), close(), isOpen(), stats() }
   * ============================================================ */
  function keyEntry(opts) {
    const o = opts || {};
    const doc = o.doc || (o.container ? o.container.ownerDocument : null) ||
                (typeof document !== 'undefined' ? document : null);
    if (!doc) throw new Error('AiSettings.keyEntry 需要一个 document');
    injectCss(doc);

    const store = o.store || null;
    let panel = null, model = null, opened = 0, saves = 0;

    const rootEl = el(doc, 'div', 'as-entry');
    rootEl.setAttribute('data-as-entry', '1');
    const bar = el(doc, 'div', 'as-entry-bar');
    const state = el(doc, 'span', 'as-entry-state', 'API Key：读取中…');
    state.setAttribute('data-as', 'entry-state');
    const btn = el(doc, 'button', 'as-btn primary', o.label || '填 / 换 API Key');
    btn.type = 'button';
    btn.setAttribute('data-as', 'keyentry');
    bar.appendChild(state);
    bar.appendChild(btn);
    rootEl.appendChild(bar);
    const box = el(doc, 'div', 'as-entry-box');
    box.setAttribute('data-as', 'entry-box');
    box.style.display = 'none';
    rootEl.appendChild(box);
    if (o.container) o.container.appendChild(rootEl);

    function paintState() {
      if (!model) { state.textContent = 'API Key：读取中…'; state.className = 'as-entry-state'; return; }
      const callable = model.callableCount || 0;
      const configured = (model.rows || []).filter(function (r) { return r.configured; });
      if (callable > 0) {
        state.textContent = 'API Key：已配置 ' + callable + ' 家（' + configured.map(function (r) { return r.masked; }).join('、') + '）';
        state.className = 'as-entry-state ok';
      } else if (configured.length) {
        state.textContent = 'API Key：填了 ' + configured.length + ' 家，但没有一家能直连';
        state.className = 'as-entry-state warn';
      } else {
        state.textContent = 'API Key：未填';
        state.className = 'as-entry-state no';
      }
    }

    async function refresh() {
      model = await AiCore.keyModel(store);
      paintState();
      if (panel) panel.refresh();
      return model;
    }
    function open() {
      if (!panel) {
        panel = mount({ doc: doc, container: box, store: store,
                        onChange: function (action) { if (action === 'save') saves++; if (o.onChange) o.onChange(action); refresh(); } });
      }
      box.style.display = '';
      opened++;
      const closeBtn = el(doc, 'button', 'as-btn', '收起密钥设置');
      closeBtn.type = 'button';
      closeBtn.setAttribute('data-as', 'entry-close');
      closeBtn.addEventListener('click', function () { close(); });
      /* 收起按钮挂在设置面板**之前**，点一下连面板一起收起来 */
      if (box.firstChild !== closeBtn) box.insertBefore(closeBtn, box.firstChild);
      return panel;
    }
    function close() {
      box.style.display = 'none';
      const c = box.querySelector ? box.querySelector('[data-as="entry-close"]') : null;
      if (c && c.parentNode) c.parentNode.removeChild(c);
    }
    /* `o.onClick`（可选）：把"点这颗按钮"交给宿主去做，这一处就**不再展开表单**。
     * 用途：**填 Key 只在「导入 / 校对」页做**（用户要求）——错题本那边的「举一反三」只留一行状态 +
     * 一颗「去「导入 / 校对」页填 Key」，点它由宿主切页并打开那边的密钥面板。
     * 状态文字（已配置 / 未填）仍走这里同一套逻辑，所以"哪儿都能看出填没填"。 */
    const external = (typeof o.onClick === 'function') ? o.onClick : null;
    if (external) {
      box.style.display = 'none';                  // 外部入口：本处永远不展开表单
      btn.textContent = o.label || '填 / 换 API Key';
    }
    if (external) {
      btn.addEventListener('click', function () { external(); });
    } else {
      btn.addEventListener('click', function () { if (box.style.display === 'none') open(); else close(); });
    }

    paintState();
    refresh();
    return {
      el: rootEl,
      refresh: refresh,
      open: open, close: close,
      toggle: function () { if (external) return external(); if (box.style.display === 'none') open(); else close(); },
      isOpen: function () { return box.style.display !== 'none'; },
      model: function () { return model; },
      stats: function () { return { opened: opened, saves: saves }; }
    };
  }

  /* ============================================================
   * 只读的**状态行**（没有输入框、没有保存按钮、没有展开表单）
   *
   * 用户要求："填 Key 这件事只保留一个地方" —— 填在「导入 / 校对」页顶部那颗
   * 「AI 密钥与供应商」里（那也是唯一挂完整面板的地方）。其余面板（单题智能 / 整卷批量 /
   * 举一反三 / 整卷总评）**不再各摆一套填 Key 的表单**，只留一行状态 + 一句指路。
   *
   * 为什么保留状态行：这些面板按下去就要联网，用户得能一眼看出"到底填没填"，
   * 否则点了半天不吭声只会被当成坏了。它不是"重复入口"——没有任何输入与保存能力。
   * 返回 { el, refresh(), model() }
   * ============================================================ */
  function keyStatus(opts) {
    const o = opts || {};
    const doc = o.doc || (o.container ? o.container.ownerDocument : null) ||
                (typeof document !== 'undefined' ? document : null);
    if (!doc) throw new Error('AiSettings.keyStatus 需要一个 document');
    injectCss(doc);

    const store = o.store || null;
    let model = null;

    const rootEl = el(doc, 'div', 'as-entry');
    rootEl.setAttribute('data-as-entry', '1');
    const bar = el(doc, 'div', 'as-entry-bar');
    const state = el(doc, 'span', 'as-entry-state', 'API Key：读取中…');
    state.setAttribute('data-as', 'entry-state');
    bar.appendChild(state);
    rootEl.appendChild(bar);
    /* 指路那一句：文案由宿主给（合并版说"去导入 / 校对页"；导入页自己说"点本页顶部那颗"） */
    if (o.where) {
      const hint = el(doc, 'div', 'as-entry-hint', o.where);
      hint.setAttribute('data-as', 'entry-hint');
      rootEl.appendChild(hint);
    }
    if (o.container) o.container.appendChild(rootEl);

    function paintState() {
      if (!model) { state.textContent = 'API Key：读取中…'; state.className = 'as-entry-state'; return; }
      const callable = model.callableCount || 0;
      const configured = (model.rows || []).filter(function (r) { return r.configured; });
      if (callable > 0) {
        state.textContent = 'API Key：已配置 ' + callable + ' 家（' + configured.map(function (r) { return r.masked; }).join('、') + '）';
        state.className = 'as-entry-state ok';
      } else if (configured.length) {
        state.textContent = 'API Key：填了 ' + configured.length + ' 家，但没有一家能直连';
        state.className = 'as-entry-state warn';
      } else {
        state.textContent = 'API Key：未填';
        state.className = 'as-entry-state no';
      }
    }
    async function refresh() {
      model = await AiCore.keyModel(store);
      paintState();
      return model;
    }
    paintState();
    refresh();
    return { el: rootEl, refresh: refresh, model: function () { return model; } };
  }

  return { CSS: CSS, CSS_ID: CSS_ID, mount: mount, keyEntry: keyEntry, keyStatus: keyStatus };
});
