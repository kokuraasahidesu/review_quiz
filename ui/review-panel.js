/* ============================================================
 *  ui/review-panel.js —— 校对入库面板的 DOM 层（移动端优先）
 *
 *  职责边界：**只做渲染与事件**，一切规则都在 core/review.js 里。
 *  这样"编辑/筛选/入库/取消"的正确性能在 Node 里测，
 *  这一层只剩"有没有把状态画出来、点得动点不动"。
 *
 *  两条实现上的硬约束：
 *    1) 输入框打字时**不整表重绘**（否则光标会被吞掉）。
 *       打字只更新草案；失焦(change)才刷新该行的待校对标记。
 *    2) 触屏可用：所有可点控件最小高度 44px、字号 16px（iOS 上小于 16px 会触发自动缩放）。
 *
 *  依赖：core/review.js（root.ReviewCore）
 *  加载顺序：… → schema.js → review.js → review-panel.js
 * ============================================================ */
(function (root, factory) {
  const isNode = (typeof module !== 'undefined' && module.exports);
  const ReviewCore = isNode ? require('../core/review.js') : root.ReviewCore;
  const api = factory(ReviewCore);
  if (isNode) module.exports = api;
  root.ReviewPanel = api;
})(typeof self !== 'undefined' ? self : this, function (ReviewCore) {
  'use strict';

  if (!ReviewCore) {
    throw new Error('review-panel 依赖缺失：请先加载 core/review.js（顺序不可颠倒）');
  }

  // 供测试与外部引用，避免测试里硬编码 class 名
  const SEL = {
    root: '.qp', list: '.qp-list', row: '.qp-row', stat: '.qp-stat',
    onlyReview: '.qp-only-review', fold: '.qp-fold', jump: '.qp-jump', commit: '.qp-commit', cancel: '.qp-cancel',
    type: '.qp-type', stem: '.qp-stem', answer: '.qp-answer', expl: '.qp-expl',
    opts: '.qp-opts', flags: '.qp-flags', reasons: '.qp-reasons',
    kw: '.qp-kw', kwText: '.qp-kwtext', kwVia: '.qp-kwvia', kwDel: '.qp-kwdel',
    kwInput: '.qp-kwinput', kwAdd: '.qp-kwbtn', blockers: '.qp-blockers'
  };

  const CSS = [
    '.qp{font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1b1b1f;background:#f6f7f9;',
    '  display:flex;flex-direction:column;height:100%;min-height:0}',
    '.qp *{box-sizing:border-box}',
    '.qp-bar{position:sticky;top:0;z-index:2;background:#fff;border-bottom:1px solid #e3e5e8;',
    '  padding:10px 12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
    '.qp-title{font-weight:600;flex:1 1 auto;min-width:0}',
    /* 题卡折叠（大卷友好）：summary 一行预览，点开才编辑 */
    '.qp-more{margin:6px 0 0}',
    '.qp-more-sum{cursor:pointer;font-size:13.5px;color:#6b7280;min-height:44px;padding:4px 0;overflow-wrap:anywhere;display:flex;align-items:center}',
    '.qp-more[open]>.qp-more-sum{margin-bottom:6px;color:#1b1b1f}',
    '.qp-stat{font-weight:400;color:#666;font-size:14px}',
    '.qp-filter{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 10px;',
    '  border:1px solid #cfd3d8;border-radius:10px;background:#fff;cursor:pointer;user-select:none}',
    '.qp-filter input{width:20px;height:20px}',
    /* 工具条上的按钮（「全部折叠」「到底部」）共用一套尺寸：44px 触控、`flex:0 0 auto` 不抢宽度 */
    '.qp-tool{flex:0 0 auto;min-height:44px;min-width:44px;padding:0 12px;border:1px solid #cfd3d8;',
    '  border-radius:10px;background:#fff;cursor:pointer;font:inherit;font-size:15px}',
    '.qp-tool[disabled]{opacity:.45;cursor:default}',
    '.qp-list{flex:1 1 auto;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:10px;-webkit-overflow-scrolling:touch}',
    '.qp-row{background:#fff;border:1px solid #e3e5e8;border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:10px}',
    '.qp-row.is-flagged{border-color:#e8a33d;box-shadow:0 0 0 2px #fdf1dc inset}',
    '.qp-rowhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.qp-idx{color:#888;font-size:14px;min-width:2.4em}',
    '.qp-type{min-height:44px;font-size:16px;padding:0 8px;border:1px solid #cfd3d8;border-radius:10px;background:#fff;flex:0 0 auto}',
    '.qp-flags{display:flex;gap:6px;flex-wrap:wrap}',
    '.qp-badge{background:#fdf1dc;color:#8a5a00;border:1px solid #e8c37f;border-radius:999px;',
    '  padding:4px 10px;font-size:13px;font-weight:600;line-height:1.6}',
    '.qp-f{display:flex;flex-direction:column;gap:6px;font-size:14px;color:#555}',
    '.qp-stem,.qp-answer,.qp-expl,.qp-kwinput{width:100%;min-height:44px;font-size:16px;',
    '  padding:10px;border:1px solid #cfd3d8;border-radius:10px;background:#fff;color:#1b1b1f;font-family:inherit}',
    '.qp-stem,.qp-expl{min-height:72px;resize:vertical}',
    '.qp-opts{font-size:15px;color:#333;display:flex;flex-direction:column;gap:4px}',
    '.qp-opt{background:#f3f4f6;border-radius:8px;padding:8px 10px}',
    '.qp-kws{display:flex;flex-direction:column;gap:8px}',
    '.qp-kw{display:flex;align-items:center;gap:8px;background:#eef3ff;border:1px solid #cdd9f5;',
    '  border-radius:10px;padding:8px 10px;flex-wrap:wrap}',
    '.qp-kwtext{font-weight:600}',
    '.qp-kwvia{font-size:13px;color:#4a5b8c;background:#fff;border-radius:999px;padding:2px 8px}',
    '.qp-kw-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
    '.qp-kwdel,.qp-kwbtn{min-height:44px;min-width:44px;font-size:16px;padding:0 14px;border-radius:10px;',
    '  border:1px solid #cfd3d8;background:#fff;cursor:pointer}',
    '.qp-kwdel{color:#b3261e;border-color:#f0c2be}',
    '.qp-kwadd{display:flex;gap:8px;align-items:center}',
    '.qp-kwinput{flex:1 1 auto;min-width:0}',
    '.qp-reasons{margin:0;padding-left:20px;color:#8a5a00;font-size:14px}',
    '.qp-foot{position:sticky;bottom:0;z-index:2;background:#fff;border-top:1px solid #e3e5e8;',
    '  padding:10px 12px;display:flex;gap:10px;align-items:center}',
    '.qp-btn{flex:1 1 0;min-height:48px;font-size:16px;font-weight:600;border-radius:12px;border:1px solid #cfd3d8;',
    '  background:#fff;cursor:pointer}',
    '.qp-commit{background:#1f6feb;border-color:#1f6feb;color:#fff}',
    '.qp-commit[disabled]{opacity:.5;cursor:not-allowed}',
    '.qp-cancel{color:#b3261e;border-color:#f0c2be}',
    '.qp-blockers{background:#fdecea;border:1px solid #f0c2be;color:#8c1d18;border-radius:10px;',
    '  padding:10px;font-size:14px;margin:0 10px}',
    '.qp-empty{color:#666;text-align:center;padding:24px 10px}',
    '@media (max-width:480px){.qp-list{padding:8px}.qp-row{padding:10px}}'
  ].join('\n');

  /* 小工具：把可能是 undefined / NaN 的尺寸读成数字（滚动量都从 DOM 读，脏值一律当 0） */
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }

  function injectStyle(doc) {
    if (!doc || doc.getElementById('qp-review-style')) return;
    const s = doc.createElement('style');
    s.id = 'qp-review-style';
    s.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(s);
  }

  function el(doc, tag, cls, text) {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  /*
   * 挂载面板。
   *   container  宿主元素（会被清空）
   *   draft      ReviewCore.createDraft 的产物
   *   opts       { store, title, onCommit, onCancel, onChange, confirmLabel }
   * 返回 panel 句柄；所有交互都可通过句柄在无鼠标环境下驱动（便于自动化测试）。
   */
  function mount(container, draft, opts) {
    if (!container) throw new Error('mount 需要一个宿主元素');
    const o = opts || {};
    const doc = container.ownerDocument;
    injectStyle(doc);

    let state = {
      draft: draft,
      /* 「只看待校对」**默认打开**（用户要求）：导入后第一眼就该看到"需要人工确认的那几题"。
       * 想临时看全部就取消勾选；调用方显式传 `onlyReview:false` 时按它来（开关仍完全可用）。 */
      onlyReview: (o.onlyReview === undefined) ? true : !!o.onlyReview,
      lastResult: null,
      error: '',
      committing: false
    };
    const listeners = { commit: [], cancel: [], change: [] };

    container.innerHTML = '';
    const rootEl = el(doc, 'div', 'qp');
    rootEl.innerHTML =
      '<div class="qp-bar">' +
        '<div class="qp-title">导入预览 · <span class="qp-stat"></span></div>' +
        '<label class="qp-filter"><input type="checkbox" class="qp-only-review">只看待校对</label>' +
        '<button type="button" class="qp-tool qp-fold">全部折叠</button>' +
        '<button type="button" class="qp-tool qp-jump">到底部</button>' +
      '</div>' +
      '<div class="qp-list"></div>' +
      '<div class="qp-foot">' +
        '<button type="button" class="qp-btn qp-cancel">取消（不导入）</button>' +
        '<button type="button" class="qp-btn qp-commit">确认入库</button>' +
      '</div>';
    container.appendChild(rootEl);

    const listEl = rootEl.querySelector(SEL.list);
    const statEl = rootEl.querySelector(SEL.stat);
    const onlyEl = rootEl.querySelector(SEL.onlyReview);
    const foldEl = rootEl.querySelector(SEL.fold);
    const jumpEl = rootEl.querySelector(SEL.jump);
    const commitEl = rootEl.querySelector(SEL.commit);
    const cancelEl = rootEl.querySelector(SEL.cancel);

    function emit(name, payload) {
      (listeners[name] || []).forEach(function (fn) { try { fn(payload); } catch (e) {} });
      if (name === 'change' && typeof o.onChange === 'function') o.onChange(payload);
      if (name === 'commit' && typeof o.onCommit === 'function') o.onCommit(payload);
      if (name === 'cancel' && typeof o.onCancel === 'function') o.onCancel(payload);
    }

    function applyResult(res) {
      if (!res || !res.ok) { state.error = (res && (res.error || res.hint)) || '操作未生效'; return res; }
      state.error = '';
      state.draft = res.draft;
      return res;
    }

    /* ---------- 单行渲染 ---------- */
    function buildRow(q, index) {
      const flags = ReviewCore.flagsOf(q);
      const row = el(doc, 'article', 'qp-row' + (flags.length ? ' is-flagged' : ''));
      row.setAttribute('data-index', String(index));

      const head = el(doc, 'div', 'qp-rowhead');
      head.appendChild(el(doc, 'span', 'qp-idx', '#' + (index + 1)));

      const sel = el(doc, 'select', 'qp-type');
      ReviewCore.TYPES.forEach(function (t) {
        const op = doc.createElement('option');
        op.value = t; op.textContent = t;
        if (t === q.type) op.selected = true;
        sel.appendChild(op);
      });
      sel.addEventListener('change', function () {
        applyResult(ReviewCore.setType(state.draft, index, sel.value));
        render();                       // 换题型会改结构，整表重绘
        emit('change', { index: index, field: 'type' });
      });
      head.appendChild(sel);

      const badges = el(doc, 'div', 'qp-flags');
      flags.forEach(function (f) { badges.appendChild(el(doc, 'span', 'qp-badge', f.label)); });
      head.appendChild(badges);
      row.appendChild(head);

      // 题干
      const fStem = el(doc, 'label', 'qp-f');
      fStem.appendChild(el(doc, 'span', null, '题干'));
      const stem = el(doc, 'textarea', 'qp-stem');
      stem.value = q.stem || '';
      stem.addEventListener('input', function () {                       // 打字：只更新草案，不重绘
        applyResult(ReviewCore.setStem(state.draft, index, stem.value));
        emit('change', { index: index, field: 'stem' });
      });
      stem.addEventListener('change', function () {                      // 失焦：刷新该行标记
        applyResult(ReviewCore.setStem(state.draft, index, stem.value));
        refreshRow(index);
      });
      fStem.appendChild(stem);
      row.appendChild(fStem);

      // 选项（只读：选项内容编辑不在本小类范围）
      const optWrap = el(doc, 'div', 'qp-opts');
      if ((q.options || []).length) {
        optWrap.appendChild(el(doc, 'span', null, '选项（暂不支持在这里改，要改请回原文件）'));
        q.options.forEach(function (op) {
          optWrap.appendChild(el(doc, 'div', 'qp-opt', op.label + '. ' + op.text));
        });
      }
      row.appendChild(optWrap);

      // 答案
      const fAns = el(doc, 'label', 'qp-f');
      fAns.appendChild(el(doc, 'span', null, '答案'));
      const ans = el(doc, 'input', 'qp-answer');
      ans.type = 'text';
      ans.value = q.answer || '';
      ans.addEventListener('input', function () {
        applyResult(ReviewCore.setAnswer(state.draft, index, ans.value));
        emit('change', { index: index, field: 'answer' });
      });
      ans.addEventListener('change', function () {
        applyResult(ReviewCore.setAnswer(state.draft, index, ans.value));
        refreshRow(index);            // 答案会影响判分值/关键词/待校对标记
      });
      fAns.appendChild(ans);
      row.appendChild(fAns);

      // 解析
      const fExpl = el(doc, 'label', 'qp-f');
      fExpl.appendChild(el(doc, 'span', null, '解析'));
      const expl = el(doc, 'textarea', 'qp-expl');
      expl.value = q.explanation || '';
      expl.addEventListener('input', function () {
        applyResult(ReviewCore.setExplanation(state.draft, index, expl.value));
        emit('change', { index: index, field: 'explanation' });
      });
      expl.addEventListener('change', function () {
        applyResult(ReviewCore.setExplanation(state.draft, index, expl.value));
        refreshRow(index);
      });
      fExpl.appendChild(expl);
      row.appendChild(fExpl);

      // 关键词（简答题才有）
      if (q.type === '简答') {
        const kwWrap = el(doc, 'div', 'qp-kws');
        (q.keywords || []).forEach(function (k, ki) {
          const chip = el(doc, 'div', 'qp-kw');
          chip.setAttribute('data-kw', String(ki));
          chip.appendChild(el(doc, 'span', 'qp-kwtext', k.text));
          chip.appendChild(el(doc, 'span', 'qp-kwvia', ReviewCore.keywordSourceLabel(k.via)));
          const del = el(doc, 'button', 'qp-kwdel', '删除');
          del.type = 'button';
          del.addEventListener('click', function () {
            applyResult(ReviewCore.removeKeyword(state.draft, index, ki));
            render();
            emit('change', { index: index, field: 'keywords' });
          });
          chip.appendChild(del);
          kwWrap.appendChild(chip);
        });

        const addWrap = el(doc, 'div', 'qp-kwadd');
        const kwIn = el(doc, 'input', 'qp-kwinput');
        kwIn.type = 'text';
        kwIn.placeholder = '新增采分关键词（来源记为手动添加）';
        const kwBtn = el(doc, 'button', 'qp-kwbtn', '添加');
        kwBtn.type = 'button';
        function doAdd() {
          const v = kwIn.value;
          const res = ReviewCore.addKeyword(state.draft, index, v, '手动');
          if (!res.ok) { state.error = res.error; return; }
          state.draft = res.draft;
          kwIn.value = '';
          render();
          emit('change', { index: index, field: 'keywords' });
        }
        kwBtn.addEventListener('click', doAdd);
        kwIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
        addWrap.appendChild(kwIn);
        addWrap.appendChild(kwBtn);
        kwWrap.appendChild(addWrap);
        row.appendChild(kwWrap);
      }

      // 待校对原因（显式列出，不只靠颜色）
      if (flags.length) {
        const ul = el(doc, 'ul', 'qp-reasons');
        flags.forEach(function (f) {
          const li = doc.createElement('li');
          li.textContent = f.text;
          ul.appendChild(li);
        });
        row.appendChild(ul);
      }
      /* 折叠：默认只露"#题号 + 题型 + 待校对标记 + 题干首 30 字"，点开才编辑。
       * 待校对的题**默认展开**（要改的正是它们，不该让人一个个点开）；
       * 做法是"先照旧往 row 里塞，最后把除行头以外的都搬进 details"，不用改上面每一处 append。 */
      const more = el(doc, 'details', 'qp-more');
      if (flags.length) more.setAttribute('open', 'open');
      const sumTxt = String(q.stem || '').replace(/\s+/g, ' ').trim();
      more.appendChild(el(doc, 'summary', 'qp-more-sum', sumTxt.slice(0, 30) + (sumTxt.length > 30 ? '…' : '') || '（题干为空）'));
      Array.prototype.slice.call(row.children).forEach(function (c) {
        if (c === head) return;                    // 行头（题号/题型/标记）永远露在外面
        if (typeof row.removeChild === 'function') row.removeChild(c);
        more.appendChild(c);
      });
      row.appendChild(more);
      return row;
    }

    /* ---------- 渲染 ---------- */
    // 错误区单独抽出来：整表重绘和"只刷新一行"都要能刷新它，
    // 否则"题干不能为空"这种输入校验失败会一声不响。
    function renderError() {
      const old = rootEl.querySelector(SEL.blockers);
      if (old) old.remove();
      if (!state.error) return;
      const box = el(doc, 'div', 'qp-blockers');
      box.textContent = state.error;
      rootEl.insertBefore(box, rootEl.querySelector(SEL.list));
    }

    function renderStat() {
      const st = ReviewCore.reviewStats(state.draft);
      statEl.textContent = st.total + ' 题 · 待校对 ' + st.needsReview + ' 题' +
        (state.onlyReview ? '（已筛选）' : '');
      onlyEl.checked = state.onlyReview;
    }

    /* ---------- 一键折叠 / 全部展开 ----------
     * 大卷常见痛点：待校对的题**默认展开**，一进来就是几百张展开的卡片；反过来，
     * 全都没问题时又想一口气展开扫一遍。所以做成**一个双向按钮**，标签跟着当前状态走。
     * ⚠ 标签描述的是**点下去会发生什么**，所以判据是"**有没有**开着的"而不是"是不是全开着"：
     *   只要还有一张开着 → 显示「全部折叠」（点它收拢）；一张都没开 → 显示「全部展开」（点它铺开）。
     *   （早先按"是否全开"判，于是"只开了一张"时标签写着"全部折叠"、点下去却是**展开** —— 界面在骗人。）
     * 状态**不额外记**，每次都从 DOM 现算 —— 用户手点某一张卡之后标签也是对的。 */
    function allDetails() {
      return Array.prototype.slice.call(listEl.querySelectorAll('details'));
    }
    function anyOpen() {
      return allDetails().some(function (d) { return d.hasAttribute('open'); });
    }
    function syncFoldLabel() {
      const ds = allDetails();
      foldEl.textContent = anyOpen() ? '全部折叠' : '全部展开';
      // 空列表时按钮没意义 → 置灰（但保留在 DOM 里，免得布局跳动）
      foldEl.disabled = (ds.length === 0);
    }
    /* open=true 全部展开，false 全部折叠；返回实际改了几张 */
    function foldAll(open) {
      let n = 0;
      allDetails().forEach(function (d) {
        if (open) { if (!d.hasAttribute('open')) { d.setAttribute('open', 'open'); n++; } }
        else { if (d.hasAttribute('open')) { d.removeAttribute('open'); n++; } }
      });
      syncFoldLabel();
      return n;
    }

    /* ---------- 一键到底部 / 回到顶部 ----------
     * 240 张卡片时用手指划到底要划半天。与「全部折叠」同一个套路：**一个双向按钮**，
     * 标签说明点下去会发生什么 —— 不在底部时显示「到底部」，已经在底部时显示「回到顶部」。
     * ⚠ 用**瞬间跳**而不是平滑滚动：平滑滚 240 张卡要一秒多，那时用户已经在怀疑"点了没反应"了。
     * ⚠ 真正在滚的**不一定是列表**：面板被放进"没有限定高度"的宿主时（合并版就是这样），
     *   `.qp-list` 会长到内容那么高、由**页面**来滚。所以按钮要认"实际能滚的那一层"，
     *   否则点了半天页面纹丝不动（实测踩过：列表 scrollHeight == clientHeight == 33610）。 */
    function panelWin() {
      try { if (doc && doc.defaultView) return doc.defaultView; } catch (e) { /* ignore */ }
      return (typeof window !== 'undefined') ? window : null;
    }
    function scroller() {
      if (num(listEl.scrollHeight) > num(listEl.clientHeight) + 4) return listEl;   // 列表自己是滚动容器
      const win = panelWin();
      const d = (win && win.document) || doc;
      return d.scrollingElement || d.documentElement || listEl;                      // 否则交给页面那一层
    }
    function atBottom() {
      const s = scroller();
      return num(s.scrollHeight) - (num(s.scrollTop) + num(s.clientHeight)) <= 8;
    }
    function canScroll() {
      const s = scroller();
      return num(s.scrollHeight) > num(s.clientHeight) + 4;
    }
    function syncJumpLabel() {
      jumpEl.textContent = atBottom() ? '回到顶部' : '到底部';
      jumpEl.disabled = !canScroll();
    }
    /* toBottom=true 跳到底，false 跳回顶；返回跳完后是否在底部 */
    function jump(toBottom) {
      const s = scroller();
      s.scrollTop = toBottom ? num(s.scrollHeight) : 0;
      syncJumpLabel();
      return atBottom();
    }
    if (listEl.addEventListener) listEl.addEventListener('scroll', function () { syncJumpLabel(); });
    (function () {
      const win = panelWin();
      if (win && win.addEventListener) win.addEventListener('scroll', function () { syncJumpLabel(); });
    })();

    function render() {
      const vis = ReviewCore.visibleIndices(state.draft, state.onlyReview);
      renderStat();

      listEl.innerHTML = '';
      if (!vis.length) {
        /* ⚠ 「只看待校对」默认打开之后，这条空态必须**说清楚"是被筛掉了"**，
         *   否则用户会以为导入失败（"怎么一道题都没有？"）—— 顺手告诉他怎么取消筛选。 */
        listEl.appendChild(el(doc, 'div', 'qp-empty',
          state.onlyReview
            ? ('没有待校对的题目 🎉（这份文件共 ' + (state.draft.questions || []).length
               + ' 题，取消勾选「只看待校对」可以看全部）')
            : '这份文件没有解析出题目'));
      } else {
        vis.forEach(function (i) { listEl.appendChild(buildRow(state.draft.questions[i], i)); });
      }
      syncFoldLabel();        // 整表重绘后标签要跟着新状态走（待校对的题默认是展开的）
      syncJumpLabel();        // 「到底部 / 回到顶部」也一样：重绘后重新量一次滚动高度
      renderError();
    }

    /* 只重画某一行 —— 保留其它行的输入状态 */
    function refreshRow(index) {
      const old = listEl.querySelector(SEL.row + '[data-index="' + index + '"]');
      if (!old) { render(); return; }
      // 若该行因为不再待校对而应当被筛掉，就走整表重绘
      if (state.onlyReview && !ReviewCore.needsReview(state.draft.questions[index])) { render(); return; }
      old.parentNode.replaceChild(buildRow(state.draft.questions[index], index), old);
      renderStat();
      renderError();
    }

    /* ---------- 事件 ---------- */
    onlyEl.addEventListener('change', function () {
      state.onlyReview = !!onlyEl.checked;
      render();
      emit('change', { field: 'onlyReview' });
    });

    /* 一键折叠：**不改数据**，纯视图动作，所以不发 change（免得被当成"用户改了内容"）。
     * 点一下就按当前状态取反：有开着的 → 全折叠；一张没开 → 全展开。 */
    foldEl.addEventListener('click', function () {
      foldAll(!anyOpen());
    });

    /* 一键到底部 / 回到顶部：同样是纯视图动作（不改数据、不发 change） */
    jumpEl.addEventListener('click', function () {
      jump(!atBottom());
    });

    cancelEl.addEventListener('click', function () {
      const res = ReviewCore.cancel(state.draft);
      emit('cancel', res);
    });

    // 唯一的入库入口。返回 Promise —— panel.commit() 必须拿到**本次**结果，
    // 不能像早期那样读 state.lastResult（那是上一次的，异步还没回来）。
    function doCommit() {
      if (state.committing) {
        // 防重复入库：连点两下"确认入库"会写出两份一样的卷子。
        // 这个判断必须是**同步**的（不能等 Promise），否则两次点击都通过了检查。
        return Promise.resolve({ ok: false, error: '正在入库，请稍候', inflight: true });
      }
      if (!o.store) {
        state.error = '没有可用的存储，无法入库';
        render();
        return Promise.resolve({ ok: false, error: state.error });
      }
      state.committing = true;
      commitEl.disabled = true;
      return ReviewCore.commit(state.draft, o.store, { title: o.title })
        .then(function (res) {
          state.lastResult = res;
          if (!res.ok) {
            state.error = res.error + (res.hint ? '：' + res.hint : '');
          } else {
            state.error = '';
          }
          render();
          emit('commit', res);
          return res;
        })
        .catch(function (e) {
          state.error = '入库时出错：' + (e && e.message || e);
          render();
          return { ok: false, error: state.error };
        })
        .then(function (res) {
          state.committing = false;
          commitEl.disabled = false;
          return res;
        });
    }
    commitEl.addEventListener('click', function () { doCommit(); });

    render();

    /* ---------- 句柄（自动化测试与宿主都通过它驱动） ---------- */
    return {
      SEL: SEL,
      root: rootEl,
      render: render,
      refreshRow: refreshRow,
      getDraft: function () { return state.draft; },
      setDraft: function (d) { state.draft = d; render(); },
      isOnlyReview: function () { return state.onlyReview; },
      setOnlyReview: function (v) { state.onlyReview = !!v; render(); },
      /* 一键折叠 / 全部展开（纯视图动作）：anyOpen 现算，foldAll 返回改了几张卡 */
      anyOpen: anyOpen,
      foldAll: foldAll,
      foldText: function () { return foldEl.textContent; },
      /* 一键到底部 / 回到顶部：jump(true/false)，atBottom/scroller 供测试与自检页读 */
      jump: jump,
      atBottom: atBottom,
      canScroll: canScroll,
      scroller: scroller,
      jumpText: function () { return jumpEl.textContent; },
      /* 重新量一次两个按钮的标签/可用性（宿主在"面板由隐藏变可见"时调用，见 review-template 的 __reviewRefresh） */
      syncLabels: function () { syncFoldLabel(); syncJumpLabel(); },
      openCount: function () {
        return allDetails().filter(function (d) { return d.hasAttribute('open'); }).length;
      },
      lastResult: function () { return state.lastResult; },
      error: function () { return state.error; },
      commit: function () { return doCommit(); },
      cancel: function () { cancelEl.click(); },
      on: function (name, fn) { (listeners[name] || (listeners[name] = [])).push(fn); return this; },
      rowCount: function () { return listEl.querySelectorAll(SEL.row).length; },
      statText: function () { return statEl.textContent; },
      /*
       * 触屏可用性自查：返回所有可点控件的高度。
       * 注意 `tap` 字段：复选框/单选框本身只是 20px 的视觉提示，
       * 真正的点击目标是包着它的 <label>（≥44px）—— 拿 checkbox 的 20px 判"不可点"是误报。
       */
      touchHeights: function () {
        const nodes = rootEl.querySelectorAll('button, input, select, textarea, .qp-filter');
        return Array.prototype.map.call(nodes, function (n) {
          const r = n.getBoundingClientRect();
          const kind = (n.tagName === 'INPUT') ? String(n.type || 'text') : n.tagName.toLowerCase();
          const tap = !(kind === 'checkbox' || kind === 'radio');
          return { tag: n.tagName.toLowerCase(), type: kind, cls: String(n.className || ''), h: Math.round(r.height), tap: tap };
        });
      }
    };
  }

  return { mount: mount, SEL: SEL, CSS: CSS, injectStyle: injectStyle };
});
