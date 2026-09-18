/* ============================================================
 *  ui/quick-panel.js —— 答题界面底部的「快捷面板」
 *
 *  分工（和 ui/review-panel.js 一样的分层）：
 *    · 该显示什么、值是多少、点了以后变成什么 —— 全在 core/flow.js（纯逻辑，Node 可穷举）
 *    · 这一层只做三件事：把 quickModel() 画出来、把点击转成 quickAction()、把新配置回抛给调用方
 *  所以"关掉自动翻页却还在跳"这类错误**不可能**在这一层发生 —— 它不做判断。
 *
 *  挂载：QuickPanel.mount({ container, config, onChange, onError })
 *    onChange(nextConfig, result)  —— 每次成功改动后回调（调用方负责落盘）
 *    onError(result)               —— 校验没过时回调（非法值仍会被拦下并给出提示）
 * ============================================================ */
(function (root, factory) {
  const isNode = (typeof module !== 'undefined' && module.exports);
  const FlowCore = isNode ? require('../core/flow.js') : root.FlowCore;
  if (!FlowCore) throw new Error('QuickPanel 依赖 FlowCore（core/flow.js），加载顺序错了');
  const api = factory(FlowCore);
  if (isNode) module.exports = api;
  root.QuickPanel = api;
})(typeof self !== 'undefined' ? self : this, function (FlowCore) {
  'use strict';

  const CSS_ID = 'quiz-quick-panel-css';
  /* ⚠ 这件事踩过：题库校对面板（`ui/review-panel.js`）也用 `.qp-*` 这套类名，**4 个类名完全撞车**
   *   （`.qp-title` / `.qp-row` / `.qp-btn` / `.qp-opt`）。合并版里两份 CSS 同处一份文档，于是
   *   校对面板那条 `.qp-row{display:flex;flex-direction:column}` 会把快捷面板的每一行压成竖排 ——
   *   实测：「− 数字 +」被拆成三行、抽题设置页被拉得老长。
   *   ⚠ **光加前缀挡不住**：两条规则设的是**不同属性**（对方设 flex-direction，我们没设），
   *   特异性再高也不产生覆盖，`column` 照样生效（第一版就栽在这儿）。所以这里做了两件事：
   *     ① 撞名的 4 个类**改名**：`.qp-title/.qp-row/.qp-btn/.qp-opt` → `.qk-*`；
   *     ② 其余规则一律带 `.qp-root ` 前缀（防对方以后再加规则又漏进来）。 */
  const CSS = [
    '.qp-root{position:fixed;left:0;right:0;bottom:0;z-index:40;background:#fff;border-top:1px solid #d7dbe0;',
    'box-shadow:0 -2px 10px rgba(0,0,0,.06);font:14px/1.5 system-ui,"Segoe UI",sans-serif;color:#222;',
    'padding:8px 12px calc(8px + env(safe-area-inset-bottom,0px));max-height:46vh;overflow:auto}',
    '.qp-root.qp-inline{position:static;border:1px solid #d7dbe0;border-radius:8px;box-shadow:none;max-height:none}',
    '.qp-root .qp-head{display:flex;align-items:center;gap:8px;margin:0 0 6px}',
    '.qp-root .qk-title{font-weight:600}',
    '.qp-root .qp-toggle{margin-left:auto;min-height:44px;min-width:44px;padding:0 10px;border:1px solid #c7ccd3;',
    'background:#f6f7f9;border-radius:8px;cursor:pointer;font:inherit}',
    '.qp-root .qp-groups{display:flex;flex-wrap:wrap;gap:10px 22px}',
    '.qp-root .qp-group{min-width:230px;flex:1 1 230px}',
    '.qp-root .qp-gname{font-weight:600;font-size:13px;color:#4a5158;margin:2px 0 4px}',
    '.qp-root .qk-row{display:flex;align-items:center;gap:8px;min-height:44px}',
    '.qp-root .qk-row .qp-label{flex:0 0 96px;color:#4a5158}',
    '.qp-root .qk-btn{min-width:44px;min-height:44px;border:1px solid #c7ccd3;background:#f6f7f9;border-radius:8px;',
    'cursor:pointer;font:inherit;font-size:18px;line-height:1}',
    '.qp-root .qk-btn[disabled]{opacity:.4;cursor:default}',
    '.qp-root .qp-num{width:76px;min-height:44px;text-align:center;border:1px solid #c7ccd3;border-radius:8px;font:inherit}',
    '.qp-root .qp-seg{display:flex;flex-wrap:wrap;gap:6px}',
    '.qp-root .qk-opt{min-height:44px;padding:0 12px;border:1px solid #c7ccd3;background:#f6f7f9;border-radius:8px;cursor:pointer;font:inherit}',
    '.qp-root .qk-opt[aria-pressed="true"]{background:#2b6cb0;border-color:#2b6cb0;color:#fff}',
    '.qp-root .qk-opt[disabled]{opacity:.4;cursor:default}',
    '.qp-root .qp-chk{width:22px;height:22px}',
    /* 置灰那一行（`enabled:false`）：跟 choice/stepper 的 disabled 观感一致 */
    '.qp-root .qk-row.off{opacity:.5}',
    '.qp-root .qk-row.off .qp-tap{cursor:default}',
    /* 开关的**真正可点区域**：44px（22px 方框在触屏上点不准，见 renderRow 的 toggle 分支） */
    '.qp-root .qp-tap{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;cursor:pointer}',
    '.qp-root .qp-unit{color:#6b7280}',
    '.qp-root .qp-note{font-size:12px;color:#6b7280;margin:2px 0 6px}',
    '.qp-root .qp-err{font-size:12px;color:#b42318;margin:2px 0 0}',
    '.qp-root .qp-msg{font-size:12px;color:#1a7f37;margin:2px 0 0}'
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
    if (text !== undefined && text !== null) n.textContent = String(text);   // 用户数据一律 textContent，不碰 innerHTML
    return n;
  }

  /* 画一行；onAction(id, value) 由 mount 提供 */
  function renderRow(doc, row, onAction) {
    const wrap = el(doc, 'div', 'qk-row');
    wrap.appendChild(el(doc, 'span', 'qp-label', row.label));
    if (row.kind === 'stepper') {
      const minus = el(doc, 'button', 'qk-btn', '−');
      minus.type = 'button'; minus.setAttribute('data-qp', row.id + '-');
      minus.disabled = (row.enabled === false) || (row.value <= row.min);
      const num = el(doc, 'input', 'qp-num');
      num.type = 'number'; num.value = String(row.value);
      num.min = String(row.min); num.max = String(row.max); num.step = String(row.step);
      num.setAttribute('data-qp', row.id);
      num.disabled = (row.enabled === false);
      const plus = el(doc, 'button', 'qk-btn', '+');
      plus.type = 'button'; plus.setAttribute('data-qp', row.id + '+');
      plus.disabled = (row.enabled === false) || (row.value >= row.max);
      minus.addEventListener('click', function () { onAction(row.id + '-', undefined); });
      plus.addEventListener('click', function () { onAction(row.id + '+', undefined); });
      num.addEventListener('change', function () {
        const v = Number(num.value);
        if (!isFinite(v) || num.value === '') { num.value = String(row.value); onAction(row.id, row.value); return; }
        onAction(row.id, v);
      });
      wrap.appendChild(minus); wrap.appendChild(num); wrap.appendChild(plus);
      if (row.unit) wrap.appendChild(el(doc, 'span', 'qp-unit', row.unit));
    } else if (row.kind === 'choice') {
      const seg = el(doc, 'div', 'qp-seg');
      (row.options || []).forEach(function (op) {
        const b = el(doc, 'button', 'qk-opt', op.label);
        b.type = 'button';
        /* `enabled:false` = 这一项现在没意义（比如自动翻页关着时的"翻页等待"）→ 置灰。
         * 与 stepper 的 `enabled` 同一套语义，别让两种行的行为不一致。 */
        b.disabled = (row.enabled === false);
        b.setAttribute('data-qp', row.id + '=' + op.value);
        b.setAttribute('aria-pressed', String(op.value === row.value));
        b.addEventListener('click', function () { onAction(row.id, op.value); });
        seg.appendChild(b);
      });
      wrap.appendChild(seg);
    } else if (row.kind === 'toggle') {
      const box = el(doc, 'input', 'qp-chk');
      box.type = 'checkbox'; box.checked = row.value === true;
      /* `enabled:false` = 这一项现在没意义（比如自动翻页关着时的"错题也翻"）→ 置灰。
       * 与 choice / stepper 的 `enabled` 同一套语义（三种行不许各说各话）。 */
      box.disabled = (row.enabled === false);
      if (row.enabled === false) wrap.className = 'qk-row off';
      box.setAttribute('data-qp', row.id);
      box.addEventListener('change', function () { onAction(row.id, box.checked); });
      /* ⚠ 开关的**可点区域**要够大：22px 的方框在手机上点不准。
       *   所以把它包进一个 44px 的 <label>（点方框、或点这块 44px 区域都算一次点击）。
       *   自检页 J 节的尺寸抽查就是按"label 那个盒子"量的（见 selftest-template 的 boxOf）。 */
      const tap = el(doc, 'label', 'qp-tap');
      tap.appendChild(box);
      wrap.appendChild(tap);
    }
    return wrap;
  }

  /*
   * mount(opts) → { el, destroy, refresh(config), stats() }
   *   opts.container  必填：挂到哪里
   *   opts.config     初始生效配置
   *   opts.onChange   (nextConfig, result) 成功改动后回调
   *   opts.onError    (result) 校验没过时回调
   *   opts.inline     true = 不进 fixed 底部条（自检页用）
   *   opts.collapsed  初始是否折叠
   *   opts.title      面板标题（缺省「快捷设置」）
   *   opts.groups     只画这些分组（缺省全画；「开始作答前的设置页」画「抽题与题量 / 分数线」两组）
   *   opts.excludeGroups 不画这些分组（答题时的底部面板用它挡掉上面两组）
   */
  function mount(opts) {
    const o = opts || {};
    const doc = (o.doc || (o.container ? o.container.ownerDocument : null) || (typeof document !== 'undefined' ? document : null));
    if (!doc) throw new Error('QuickPanel.mount 需要一个 document（Node 里只能测 quickModel/quickAction）');
    if (!o.container) throw new Error('QuickPanel.mount 需要 container');
    injectCss(doc);

    const rootEl = el(doc, 'div', 'qp-root' + (o.inline ? ' qp-inline' : ''));
    rootEl.setAttribute('data-qp-root', '1');
    const head = el(doc, 'div', 'qp-head');
    /* 标题：`undefined` = 用缺省「快捷设置」；给**空串** = 这一处不要标题
     * （答题时底部那张面板就是这种：标题会被左下角的「返回题库」压住，用户要求去掉）。 */
    const title = (o.title === undefined) ? '快捷设置' : o.title;
    if (title) head.appendChild(el(doc, 'span', 'qk-title', title));
    /* 折叠按钮的文案就是它干的事（用户要求把它从"展开"改成"展开设置"）：
     * 没有标题之后，这一颗按钮就是这排唯一的东西，说清"点它是展开设置"。 */
    const foldText = function (collapsed) { return collapsed ? '展开设置' : '收起设置'; };
    const fold = el(doc, 'button', 'qp-toggle', foldText(o.collapsed));
    fold.type = 'button'; fold.setAttribute('data-qp', 'toggle');
    head.appendChild(fold);
    rootEl.appendChild(head);
    const body = el(doc, 'div', 'qp-groups');
    rootEl.appendChild(body);
    const msg = el(doc, 'div', 'qp-msg', '');
    const err = el(doc, 'div', 'qp-err', '');
    rootEl.appendChild(msg); rootEl.appendChild(err);
    o.container.appendChild(rootEl);

    let cfg = o.config || null;
    let collapsed = o.collapsed === true;
    let clicks = 0, changes = 0, errors = 0;

    function paint() {
      body.textContent = '';
      body.style.display = collapsed ? 'none' : 'flex';
      fold.textContent = foldText(collapsed);
      let model = FlowCore.quickModel(cfg);
      /* opts.groups：只画指定的分组（答题页那个"抽题设置页"只要「抽题与题量」那一组）。
       * 不传 = 全部画出来（底部快捷面板就是全部）。 */
      if (o.groups && o.groups.length) model = model.filter(function (g) { return o.groups.indexOf(g.group) >= 0; });
      /* opts.excludeGroups：**排除**指定分组。答题时的底部面板用它把「抽题与题量 / 分数线」挡掉 ——
       * 那两组已搬到"开始作答前的设置页"：答到一半再改抽题设置不会换掉正在答的题，摆在那里只会让人以为
       * "改了就该立刻生效"。分数线也一并搬走（它是出卷前定的事）。 */
      if (o.excludeGroups && o.excludeGroups.length) {
        model = model.filter(function (g) { return o.excludeGroups.indexOf(g.group) < 0; });
      }
      model.forEach(function (grp) {
        const g = el(doc, 'div', 'qp-group');
        g.appendChild(el(doc, 'div', 'qp-gname', grp.group));
        (grp.rows || []).forEach(function (row) { g.appendChild(renderRow(doc, row, onAction)); });
        (grp.notes || []).forEach(function (n) { g.appendChild(el(doc, 'div', 'qp-note', n)); });
        body.appendChild(g);
      });
    }

    function onAction(id, value) {
      clicks++;
      const res = FlowCore.quickAction(cfg, { id: id, value: value });
      if (!res.ok) {
        errors++;
        err.textContent = '没有采用：' + (res.errors || []).map(function (e) { return e.message; }).join('；');
        msg.textContent = '';
        if (o.onError) o.onError(res);
        return;
      }
      err.textContent = '';
      cfg = res.config;
      changes++;
      msg.textContent = describe(id, res);
      paint();
      if (o.onChange) o.onChange(cfg, res);
    }

    function describe(id, res) {
      if (id === 'count+' || id === 'count-' || id === 'count') return '本轮题量：' + res.value + ' 题';
      if (id === 'score+' || id === 'score-' || id === 'score') return '目标总分：' + res.value + ' 分';
      if (id === 'basis') return '题量口径：' + (FlowCore.BASIS_LABELS[res.basis] || res.basis);
      if (id === 'mode') return '抽题规则：' + (FlowCore.PICK_MODE_LABELS[res.mode] || res.mode);
      if (id === 'prefer') return '抽取偏好：' + (FlowCore.PICK_PREFER_LABELS[res.prefer] || res.prefer);
      const tm = String(id).match(/^(byType|byTypeScore)\.(.+?)([+-])?$/);
      if (tm) {
        const isScore = (tm[1] === 'byTypeScore');
        return tm[2] + '：' + res.value + (isScore ? ' 分' : ' 题')
             + (res.modeChanged ? '（抽题规则已切到「' + (FlowCore.PICK_MODE_LABELS[res.mode] || res.mode) + '」）' : '');
      }
      if (id === 'answerTiming' || id === 'explainTiming') return (id === 'answerTiming' ? '答案' : '解析') + '展示时机：' + (FlowCore.REVEAL_LABELS[res.timing] || res.timing);
      if (id === 'autoCheck' || id === 'autoNext') return (id === 'autoCheck' ? '自动判分' : '自动翻页') + '：' + (res.value ? '开' : '关');
      /* 用户要求：**不要**那句「N 毫秒后翻」的绿字 ——
       * 选中的那一档本来就高亮着，再回一句"1000 毫秒后翻"只是噪音（同一件事说两遍）。
       * 返回空串 = 这一格清空（不显示任何绿字），但改动照样算数（changes 计数照旧）。 */
      if (id === 'autoNextMs') return '';
      if (id === 'timer') return '答题计时：' + (res.value ? '开（悬浮球可暂停）' : '关');
      if (id === 'grade.pass' || id === 'grade.excellent') return (id === 'grade.pass' ? '及格比例' : '优秀比例') + '：' + res.value + '%';
      if (id === 'points.多选') return '多选全对得分：' + res.value + ' 分'
        + (res.clampedHalf ? '（半对跟着压到 ' + res.half + ' 分）' : '');
      if (id === 'multi.halfScore') return '多选半对得分：' + res.value + ' 分'
        + (res.clampedToFull ? '（不能超过全对 ' + res.full + ' 分，已压回）' : '');
      return '已更新';
    }

    fold.addEventListener('click', function () { collapsed = !collapsed; paint(); });
    paint();

    return {
      el: rootEl,
      destroy: function () { if (rootEl.parentNode) rootEl.parentNode.removeChild(rootEl); },
      refresh: function (next) { cfg = next; paint(); },
      config: function () { return cfg; },
      /* 自检页要看三个计数：点了几次、生效几次、被拦几次 */
      stats: function () { return { clicks: clicks, changes: changes, errors: errors }; }
    };
  }

  return { CSS: CSS, CSS_ID: CSS_ID, mount: mount };
});
