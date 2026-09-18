/* ============================================================
 *  ui/delete-dialog.js —— 删卷级联询问弹窗（只做 DOM）
 *
 *  该说什么、有哪些选项**全部来自** `ExamsCore.deletePlan` 的询问模型：
 *  这一层不许自己拼一句"要一并删除吗"——否则两个选项的后果会各写一套文案，迟早对不上。
 *
 *  三条界面约束（都是"删数据"这类不可逆操作的硬要求）：
 *    ① **默认不选**：弹窗打开时没有预选、回车/点遮罩都不等于同意 —— 必须**明确点**某个选项；
 *    ② 破坏性选项要**说清后果**（不可恢复 / 保留什么），并且与"取消"分开摆；
 *    ③ 取消返回 `{policy:'cancel'}`，**不删任何东西**。
 * ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DeleteDialog = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CSS_ID = 'quiz-delete-dialog-css';
  const CSS = [
    '.dd-mask{position:fixed;inset:0;background:rgba(12,17,26,.45);display:flex;align-items:center;justify-content:center;',
    'padding:16px;z-index:9999}',
    '.dd-box{background:#fff;color:#1b1b1f;border-radius:14px;max-width:460px;width:100%;max-height:88vh;overflow:auto;',
    'padding:16px 16px 12px;box-shadow:0 12px 40px rgba(0,0,0,.25);font:16px/1.6 system-ui,"Microsoft YaHei",sans-serif}',
    '.dd-box *{box-sizing:border-box;max-width:100%}',
    '.dd-title{font-size:17px;font-weight:600;margin:0 0 8px}',
    '.dd-msg{margin:0 0 8px;overflow-wrap:anywhere}',
    '.dd-note{color:#6b7280;font-size:13.5px;margin:0 0 12px}',
    '.dd-opts{display:flex;flex-direction:column;gap:10px;margin:0 0 10px}',
    '.dd-opt{display:flex;flex-direction:column;gap:2px;align-items:flex-start;text-align:left;min-height:52px;',
    'padding:8px 12px;border:1px solid #dfe3e8;border-radius:10px;background:#f7f9fb;cursor:pointer;font:inherit;color:inherit}',
    '.dd-opt:hover{background:#eef3f9}',
    '.dd-opt b{font-weight:600}',
    '.dd-opt span{color:#6b7280;font-size:13.5px}',
    '.dd-opt.danger{border-color:#f0bdb8;background:#fdf1f0}',
    '.dd-opt.danger:hover{background:#fbe6e4}',
    '.dd-opt.danger b{color:#8c1d18}',
    '.dd-cancel{min-height:44px;width:100%;border:1px solid #dfe3e8;background:#fff;border-radius:10px;cursor:pointer;font:inherit}'
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
   * mount({ container, prompt, onChoose, onCancel, doc })
   *   prompt   = ExamsCore.deletePlan 的输出（必须带 options）
   *   onChoose(policy)  —— 用户**明确点**了某个选项（'cascade' | 'keepRecords'）
   *   onCancel()        —— 取消（点取消按钮或点遮罩空白处；写操作一律不发生）
   * 返回 { el, destroy, choose(policy), cancel(), stats(), prompt() }
   */
  function mount(opts) {
    const o = opts || {};
    const doc = o.doc || (o.container ? o.container.ownerDocument : null) ||
                (typeof document !== 'undefined' ? document : null);
    if (!doc) throw new Error('DeleteDialog.mount 需要一个 document');
    if (!o.container) throw new Error('DeleteDialog.mount 需要 container');
    const prompt = o.prompt || {};
    if (!Array.isArray(prompt.options) || !prompt.options.length) throw new Error('DeleteDialog.mount 需要 prompt.options（询问模型）');
    injectCss(doc);

    const mask = el(doc, 'div', 'dd-mask');
    mask.setAttribute('data-dd', 'mask');
    const box = el(doc, 'div', 'dd-box');
    box.setAttribute('data-dd', 'box');
    box.setAttribute('role', 'dialog');
    mask.appendChild(box);
    o.container.appendChild(mask);

    let chosen = null, cancels = 0, shows = 1;

    /* 标题与"取消"文案可以由询问模型给（`prompt.title` / `prompt.cancelLabel`）——
     * 「清除答题记录」用的是同一个弹窗（同一个"先问清楚再动手"的习惯），但它不是"删这套卷"。
     * 缺省值保持原样，所以删卷那条路的文案一个字没变。 */
    box.appendChild(el(doc, 'h2', 'dd-title', prompt.title || '删除这套卷？'));
    box.appendChild(el(doc, 'p', 'dd-msg', prompt.message || '确认要删除吗？'));
    box.appendChild(el(doc, 'p', 'dd-note', prompt.note || ''));

    const opts5 = el(doc, 'div', 'dd-opts');
    (prompt.options || []).forEach(function (op) {
      /* 危险项：删卷的 `cascade` 与"清除记录"里显式标 `danger` 的项，观感一致 */
      const danger = (op.policy === 'cascade') || (op.danger === true);
      const b = el(doc, 'button', 'dd-opt' + (danger ? ' danger' : ''));
      b.type = 'button';
      b.setAttribute('data-dd', 'opt');
      b.setAttribute('data-dd-policy', op.policy);
      b.appendChild(el(doc, 'b', null, op.label));
      b.appendChild(el(doc, 'span', null, op.detail || ''));
      b.addEventListener('click', function () { choose(op.policy); });
      opts5.appendChild(b);
    });
    box.appendChild(opts5);

    const cancelBtn = el(doc, 'button', 'dd-cancel', prompt.cancelLabel || '取消（什么都不删）');
    cancelBtn.type = 'button';
    cancelBtn.setAttribute('data-dd', 'cancel');
    cancelBtn.addEventListener('click', function () { cancel(); });
    box.appendChild(cancelBtn);

    /* 点遮罩空白处 = 取消（绝不等于同意）；点弹窗内部不冒泡处理 */
    mask.addEventListener('click', function (e) { if (e && e.target === mask) cancel(); });

    function choose(policy) {
      if (chosen) return { ok: false, error: '这个弹窗已经选过了', policy: chosen };   // 双击不再触发第二次删除
      chosen = String(policy);
      if (o.onChoose) o.onChoose(chosen, prompt);
      return { ok: true, policy: chosen };
    }
    function cancel() {
      if (chosen) return { ok: false, error: '这个弹窗已经选过了', policy: chosen };
      chosen = 'cancel'; cancels++;
      if (o.onCancel) o.onCancel(prompt);
      return { ok: true, policy: 'cancel' };
    }

    return {
      el: mask,
      destroy: function () { if (mask.parentNode) mask.parentNode.removeChild(mask); },
      choose: choose, cancel: cancel,
      prompt: function () { return prompt; },
      stats: function () { return { shows: shows, cancels: cancels, chosen: chosen }; }
    };
  }

  return { CSS: CSS, CSS_ID: CSS_ID, mount: mount };
});
