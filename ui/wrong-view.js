/* ============================================================
 *  ui/wrong-view.js —— 错题本视图（按卷分组 + 逐题详情 + 跳回原卷）
 *
 *  分工（与其它面板一致）：该显示什么全在 `core/wrong.js` 的 `groups/detailOf/jumpTarget`；
 *  这一层只画、只把点击转成回调。
 *
 *  ⚠ 详情里的**原题/答案/解析一律来自试卷**（detailOf 现读），不是误答本里的快照；
 *    卷子改过/题被删了会带 `stale` 标记，界面如实显示一句提醒，不拿快照冒充。
 * ============================================================ */
(function (root, factory) {
  const isNode = (typeof module !== 'undefined' && module.exports);
  const WrongCore = isNode ? require('../core/wrong.js') : root.WrongCore;
  if (!WrongCore) throw new Error('WrongView 依赖 WrongCore（core/wrong.js），加载顺序错了');
  const api = factory(WrongCore);
  if (isNode) module.exports = api;
  root.WrongView = api;
})(typeof self !== 'undefined' ? self : this, function (WrongCore) {
  'use strict';

  const CSS_ID = 'quiz-wrong-css';
  const CSS = [
    '.wv-root{box-sizing:border-box;max-width:780px;margin:0 auto;padding:10px 12px 24px;color:#1b1b1f;',
    'font:16px/1.6 system-ui,"Microsoft YaHei",sans-serif;overflow-wrap:anywhere;word-break:break-word}',
    /* 电脑端把内容放宽一点：一屏能多看几条（磁贴本身就是"就地展开"，越宽越省翻页） */
    '@media (min-width:900px){.wv-root{max-width:1040px;padding:14px 18px 28px}}',
    '.wv-root *{box-sizing:border-box;max-width:100%}',
    '.wv-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:6px 0 10px;border-bottom:1px solid #dfe3e8}',
    '.wv-title{font-weight:600;flex:1 1 160px;min-width:0}',
    '.wv-badge{font-size:12.5px;color:#6b7280;border:1px solid #dfe3e8;border-radius:999px;padding:2px 8px;white-space:nowrap}',
    '.wv-group{border:1px solid #dfe3e8;border-radius:10px;background:#fbfcfd;margin:12px 0;overflow:hidden}',
    '.wv-ghead{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;background:#f2f5f8}',
    '.wv-gname{font-weight:600;flex:1 1 150px;min-width:0}',
    '.wv-list{margin:0;padding:0;list-style:none}',
    '.wv-item{display:flex;align-items:flex-start;gap:10px;width:100%;min-height:48px;padding:10px 12px;',
    'border:0;border-top:1px solid #eceff2;background:#fff;text-align:left;cursor:pointer;font:inherit;color:inherit}',
    '.wv-item:hover{background:#f7f9fb}',
    '.wv-item[aria-current="true"]{background:#e8f0fb;box-shadow:inset 3px 0 0 #2b6cb0}',
    '.wv-times{flex:0 0 auto;font-weight:700;color:#b42318}',
    '.wv-stem{flex:1 1 auto;min-width:0}',
    '.wv-meta{font-size:13px;color:#6b7280}',
    '.wv-detail{border:1px solid #dfe3e8;border-radius:10px;background:#fff;padding:10px 12px;margin:12px 0}',
    /* 磁贴：**内联展开在它那道题下面**（本题与下一题之间），不是收在分组底部（用户要求） */
    '.wv-tile{border:1px solid #cdd9f5;border-left:3px solid #2b6cb0;border-radius:10px;background:#fff;',
    'padding:10px 12px;margin:2px 0 8px}',
    '.wv-tile-li{list-style:none;padding:0}',
    /* 举一反三按钮旁边的小字说明（用户要求：功能介绍与提示都写在按钮旁边） */
    '.wv-hint{font-size:13px;color:#6b7280;flex:1 1 220px;min-width:0;line-height:1.5}',
    '.wv-kv{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:14px;color:#6b7280;margin:6px 0 0}',
    '.wv-kv b{color:#1b1b1f}',
    '.wv-opts{margin:8px 0 0;padding:0;list-style:none}',
    '.wv-opts li{padding:4px 0}',
    '.wv-chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 0}',
    '.wv-chip{font-size:13px;border-radius:6px;padding:2px 8px;border:1px solid #dfe3e8}',
    '.wv-chip.wrong{background:#fdf1f0;border-color:#f0bdb8}',
    '.wv-chip.right{background:#e9f7ee;border-color:#a9dcbb}',
    '.wv-warn{border:1px solid #f0d3a8;background:#fff8ec;border-radius:8px;padding:8px 10px;margin:8px 0;font-size:13.5px}',
    '.wv-actions{display:flex;flex-wrap:wrap;gap:10px;margin:10px 0 0}',
    '.wv-btn{min-height:48px;min-width:110px;padding:0 16px;border:1px solid #dfe3e8;background:#f6f7f9;border-radius:10px;cursor:pointer;font:inherit}',
    '.wv-btn.primary{background:#2b6cb0;border-color:#2b6cb0;color:#fff}',
    '.wv-btn[disabled]{opacity:.45;cursor:default}',
    '.wv-empty{color:#6b7280;padding:14px 4px}',
    '.wv-sum{margin:0 0 10px;color:#6b7280;font-size:13.5px}',
    '.wv-dead{background:#fdf1f0;border-color:#f0bdb8;color:#8c1d18}',
    '.wv-del{margin-left:auto;min-width:96px;padding:0 10px;font-size:14px;min-height:44px}'
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
    if (text !== undefined && text !== null) n.textContent = String(text);   // 用户数据一律 textContent
    return n;
  }

  /*
   * mount({ container, books, exams, onJump, onDelete, doc })
   *   books: [{ book, exam, owner }]  —— 一组一套卷（exam 可为 null = 卷不在了；
   *                                      owner 来自 ExamsCore.ownerOf，带「已删除试卷」归属标识）
   *   exams: { id: exam }       —— detailOf 现读"原题"用；缺省时用 books 里那份
   *   onJump(examId, index)     —— 点「跳到这道题」时回调（上层负责导航）
   *   onDelete(examId, group)   —— 点「删除这套卷」时回调（上层负责弹询问窗并执行策略）
   * 返回 { el, destroy, groups(), select(examId, qid), selected(), stats(), refresh(books) }
   */
  function mount(opts) {
    const o = opts || {};
    const doc = o.doc || (o.container ? o.container.ownerDocument : null) ||
                (typeof document !== 'undefined' ? document : null);
    if (!doc) throw new Error('WrongView.mount 需要一个 document');
    if (!o.container) throw new Error('WrongView.mount 需要 container');
    injectCss(doc);

    let books = Array.isArray(o.books) ? o.books : [];
    let baseExams = Object.assign({}, o.exams || {});     // 调用方显式给的卷册（可选）
    let examMap = Object.assign({}, baseExams);
    let ownerMap = {};                                    // 卷 id → 归属（活着 / 已删除 / 查无）
    books.forEach(function (b) { if (b.exam && !examMap[b.exam.id]) examMap[b.exam.id] = b.exam; });
    function noteOwners() {
      books.forEach(function (b) {
        if (!b.book) return;
        if (b.owner) ownerMap[b.book.examId] = b.owner;
        else if (b.owner === undefined && b.exam) ownerMap[b.book.examId] = { kind: 'alive', title: b.exam.title };
      });
    }
    noteOwners();
    let sel = null;             // { examId, qid }
    let jumps = 0, deletes = 0, mistakes = 0;

    /* 卷册映射的**唯一重建点**：books 里带的卷永远以**最新那份**为准。
     * ⚠ 早先 refresh() 只换 books、不换 examMap：题干/标题改过之后刷新视图，
     *   详情里拿到的还是挂载那一刻的旧卷子 —— 于是"改过的题干"永远显示不出来（假的 stale 检验）。 */
    function rebuildExams() {
      examMap = Object.assign({}, baseExams);
      books.forEach(function (b) { if (b.exam) examMap[b.exam.id] = b.exam; });
      noteOwners();
    }
    rebuildExams();

    const rootEl = el(doc, 'div', 'wv-root');
    rootEl.setAttribute('data-wv-root', '1');
    o.container.appendChild(rootEl);

    function examOf(examId) { return examMap[examId] || null; }
    function bookOf(examId) {
      const hit = books.filter(function (b) { return b.book.examId === examId; })[0];
      return hit ? hit.book : null;
    }
    function model() {
      return WrongCore.groups(books.map(function (b) {
        return { book: b.book, exam: examOf(b.book.examId), owner: ownerMap[b.book.examId] };
      }));
    }

    /* ---------- 详情磁贴（内联展开在它那道题下面） ----------
     * 用户要求：
     *   · 单点条目 → 在**本题与下一题之间**展开这道题的磁贴（不是收在分组底部，也不是弹出层）；
     *   · 一次只开一个 —— 点开新的，旧的自动收回（`sel` 只有一个，天然如此）；
     *   · 「跳到这道题 / 举一反三」都放在磁贴里；举一反三旁边配一行小字说明；
     *   · 双击条目 = 直接跳（不必先展开再点按钮）。
     */
    function jumpTo(g, e) {
      const book = bookOf(g.examId);
      const t = WrongCore.jumpTarget(book, e.qid, { exam: examOf(g.examId), owner: ownerMap[g.examId] });
      if (!t.ok) return false;
      jumps++;
      /* ⚠ 把这一组错题的 qid 列表一起交出去：答题页据此**只出这些题**（题目列表 = 错题本里的题） */
      if (o.onJump) o.onJump(t.examId, t.index, t, { qids: g.entries.map(function (x) { return x.qid; }), qid: e.qid });
      return true;
    }
    function buildTile(g, e) {
      const book = bookOf(g.examId);
      const d = WrongCore.detailOf(book, e.qid, { exam: examOf(g.examId), owner: ownerMap[g.examId] });
      const card = el(doc, 'div', 'wv-tile');
      card.setAttribute('data-wv', 'tile');
      card.setAttribute('data-wv-qid', e.qid);
      if (!d.ok) { card.appendChild(el(doc, 'div', 'wv-empty', d.message || '打不开这条记录')); return card; }
      if (d.ownerKind === 'deleted') {
        card.appendChild(el(doc, 'div', 'wv-warn', '归属：' + d.ownerLabel + '（这套卷已经删掉了，记录按你的选择保留在这里）'));
      }
      card.appendChild(el(doc, 'div', null, '第 ' + (d.index >= 0 ? (d.index + 1) : '?') + ' 题　'
        + (d.question ? d.question.typeLabel : (d.snapshot.type || '')) + '　答错 ' + d.times + ' 次'
        + (d.streak === 0 && d.lastRightAt ? '（最近一次答对了）' : '')));
      if (d.stale) card.appendChild(el(doc, 'div', 'wv-warn', d.staleReason));
      /* 画出来的"原题"单独打一个 data-wv="stem" 钩子：
       * 验收要断言的是"这里显示的**就是**卷子里那一句"，用子串匹配会被解析等别的文本误伤
       * （实测过：题干恰好是解析的前缀时，"旧快照没冒充原题"那条断言会假通过/假失败）。 */
      const stemEl = el(doc, 'div', null, d.question ? d.question.stem : ('（原题已不在试卷里）快照：' + d.snapshot.stem));
      stemEl.setAttribute('data-wv', 'stem');
      card.appendChild(stemEl);
      if (d.question && d.question.options && d.question.options.length) {
        const ul = el(doc, 'ul', 'wv-opts');
        d.question.options.forEach(function (op) {
          const hit = (d.question.type === '多选' ? d.question.answerText.indexOf(op.label) >= 0 : d.question.answerText === op.label);
          ul.appendChild(el(doc, 'li', null, op.label + '. ' + op.text + (hit ? '　←　正确答案' : '')));
        });
        card.appendChild(ul);
      }
      const kv = el(doc, 'div', 'wv-kv');
      kv.appendChild(el(doc, 'span', null, '参考答案：'));
      kv.appendChild(el(doc, 'b', null, d.question ? d.question.answerText : '（不可用）'));
      kv.appendChild(el(doc, 'span', null, '你的作答：'));
      kv.appendChild(el(doc, 'b', null, d.lastAnswer == null ? '（未作答）' : String(d.lastAnswer)));
      kv.appendChild(el(doc, 'span', null, '得分：'));
      kv.appendChild(el(doc, 'b', null, d.lastScore + ' / ' + d.lastFull));
      card.appendChild(kv);
      card.appendChild(el(doc, 'div', 'wv-meta', '解析：' + ((d.question && d.question.explanation) || '（这道题没有解析）')));
      const chips = el(doc, 'div', 'wv-chips');
      (d.history || []).forEach(function (h) {
        chips.appendChild(el(doc, 'span', 'wv-chip ' + (h.kind === 'wrong' ? 'wrong' : 'right'),
          (h.kind === 'wrong' ? '错 ' : '对 ') + (h.at || '').replace('T', ' ').slice(0, 16) + '（' + h.score + '/' + h.full + '）'));
      });
      card.appendChild(chips);
      /* 磁贴里的按钮：跳到这道题 / 举一反三（+ 收起）。举一反三旁边那行小字是它的功能说明。 */
      const row = el(doc, 'div', 'wv-actions');
      const jump = el(doc, 'button', 'wv-btn primary', '跳到这道题');
      jump.type = 'button';
      jump.setAttribute('data-wv', 'jump');
      jump.disabled = !d.jump;
      jump.addEventListener('click', function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        jumpTo(g, e);
      });
      const mk = el(doc, 'button', 'wv-btn', '举一反三');
      mk.type = 'button';
      mk.setAttribute('data-wv', 'mistake');
      mk.disabled = !d.jump;                    // 卷不在就没法"加入本卷"
      mk.addEventListener('click', function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        mistakes++;
        if (o.onMistake) o.onMistake(g.examId, e.qid);
      });
      const hint = el(doc, 'span', 'wv-hint', '按考点出新题，可加入本卷（需先填 API Key）');
      const close = el(doc, 'button', 'wv-btn', '收起');
      close.type = 'button';
      close.setAttribute('data-wv', 'close');
      close.addEventListener('click', function () { sel = null; paint(); });
      row.appendChild(jump); row.appendChild(mk); row.appendChild(hint); row.appendChild(close);
      card.appendChild(row);
      return card;
    }

    function paint() {
      rootEl.textContent = '';
      const gs = model();
      const head = el(doc, 'div', 'wv-head');
      head.appendChild(el(doc, 'div', 'wv-title', '错题本'));
      head.appendChild(el(doc, 'span', 'wv-badge', gs.length + ' 套卷'));
      head.appendChild(el(doc, 'span', 'wv-badge', '共 ' + gs.reduce(function (s, g) { return s + g.total; }, 0) + ' 条错题'));
      rootEl.appendChild(head);
      rootEl.appendChild(el(doc, 'div', 'wv-sum',
        '点一条看原题与解析；「跳到这道题」回原卷。'));
      if (!gs.length) { rootEl.appendChild(el(doc, 'div', 'wv-empty', '还没有错题（答错的题会在交卷时自动收进来）')); return; }

      gs.forEach(function (g) {
        const box = el(doc, 'div', 'wv-group');
        const gh = el(doc, 'div', 'wv-ghead');
        gh.appendChild(el(doc, 'div', 'wv-gname', g.title + (g.examFound ? '' : (g.deleted ? '　（记录按你的选择保留）' : '　（未入册：可能是在「答题」页直接答过的卷）'))));
        gh.appendChild(el(doc, 'span', 'wv-badge', g.total + ' 条'));
        gh.appendChild(el(doc, 'span', 'wv-badge', '累计错 ' + g.timesSum + ' 次'));
        if (g.active) gh.appendChild(el(doc, 'span', 'wv-badge', '待纠正 ' + g.active));
        if (g.mastered) gh.appendChild(el(doc, 'span', 'wv-badge', '已答对过 ' + g.mastered));
        /* 已删除的卷标出来（归属标识），并且**不给**删除按钮（没什么可删的了） */
        if (g.deleted) {
          const tag = el(doc, 'span', 'wv-badge wv-dead', '已删除试卷');
          tag.setAttribute('data-wv', 'dead-tag');
          gh.appendChild(tag);
        } else if (o.onDelete) {
          const del = el(doc, 'button', 'wv-btn wv-del', '删除这套卷');
          del.type = 'button';
          del.setAttribute('data-wv', 'delete');
          del.setAttribute('data-wv-exam', g.examId);
          del.addEventListener('click', function () { deletes++; o.onDelete(g.examId, g); });
          gh.appendChild(del);
        }
        box.appendChild(gh);
        const ul = el(doc, 'ul', 'wv-list');
        g.entries.forEach(function (e) {
          const open = !!sel && sel.examId === g.examId && sel.qid === e.qid;
          const li = el(doc, 'li');
          const b = el(doc, 'button', 'wv-item');
          b.type = 'button';
          b.setAttribute('data-wv', 'item');
          b.setAttribute('data-wv-qid', e.qid);
          b.setAttribute('aria-current', String(open));
          b.setAttribute('aria-expanded', String(open));
          b.appendChild(el(doc, 'span', 'wv-times', '×' + e.times));
          const mid = el(doc, 'span', 'wv-stem', e.stem || e.qid);
          mid.appendChild(el(doc, 'div', 'wv-meta', (e.type || '') + '　最近错于 ' + (e.lastWrongAt || '').slice(0, 10)
            + (e.streak === 0 ? '　最近答对过' : '　连续错 ' + e.streak + ' 次')));
          b.appendChild(mid);
          /* 单击 = 展开/收回这道题的磁贴（磁贴插在**这一条下面**，也就是本题与下一题之间） */
          b.addEventListener('click', function () {
            sel = open ? null : { examId: g.examId, qid: e.qid };
            paint();
          });
          /* 双击 = 直接「跳到这道题」（用户要求；不必先展开再点按钮） */
          b.addEventListener('dblclick', function () {
            sel = { examId: g.examId, qid: e.qid };
            jumpTo(g, e);
          });
          li.appendChild(b);
          ul.appendChild(li);
          if (open) {
            const tileLi = el(doc, 'li', 'wv-tile-li');
            tileLi.appendChild(buildTile(g, e));
            ul.appendChild(tileLi);
          }
        });
        box.appendChild(ul);
        rootEl.appendChild(box);
      });
    }

    paint();
    return {
      el: rootEl,
      destroy: function () { if (rootEl.parentNode) rootEl.parentNode.removeChild(rootEl); },
      refresh: function (nextBooks, nextExams) {
        if (nextExams) baseExams = Object.assign({}, nextExams);
        if (Array.isArray(nextBooks)) books = nextBooks;
        rebuildExams(); paint();
      },
      groups: function () { return model(); },
      select: function (examId, qid) { sel = { examId: examId, qid: qid }; paint(); return sel; },
      selected: function () { return sel; },
      stats: function () { return { groups: model().length, jumps: jumps, deletes: deletes, mistakes: mistakes }; },
      owners: function () { return Object.assign({}, ownerMap); }
    };
  }

  return { CSS: CSS, CSS_ID: CSS_ID, mount: mount };
});
