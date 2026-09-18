/* ============================================================
 *  verify/mini-dom.js —— 极简 DOM 替身（只给 UI 层的 Node 侧测试用）
 *
 *  为什么需要它：`ui/wrong-view.js` 的全部决策都在 `core/wrong.js`（Node 侧已穷举），
 *  但"挂载 / 刷新 / 选中 / 跳转按钮禁用"这些**装配**行为只在真浏览器里发生过。
 *  结果是一个真实缺陷溜过去了：`refresh()` 只换 books、不重建卷册映射 ——
 *  卷子改名/改题干之后刷新视图，详情里拿到的还是挂载那一刻的旧卷子
 *  （于是"改过的题干"永远显示不出来，那条 stale 断言等于在测空气）。
 *
 *  所以这里造一个**够用就停**的 DOM：不做解析、不做布局、不做选择器引擎，
 *  只实现 ui/wrong-view.js 真正调用到的那几个成员。
 *  ⚠ 它**不是** jsdom，也不该长成 jsdom：看见一个就加一个，别提前实现。
 * ============================================================ */
'use strict';

function makeEl(doc, tag) {
  const el = {
    ownerDocument: doc,
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    className: '',
    id: '',
    type: '',
    disabled: false,
    attrs: {},
    children: [],
    parentNode: null,
    listeners: {},
    /* ⚠ 真 DOM 的元素一定有 `.style`（可写对象）。少了它，任何 `el.style.display = …` 都会把挂载炸掉 ——
     *   attempt-view 会顺手挂底部快捷面板，面板里就有 `style.display`（实测：漏了这条直接 TypeError）。 */
    style: {},
    _text: '',

    /* 真 DOM 的语义：写 textContent 会**清空子节点**（clear() 就靠这个） */
    get textContent() {
      return this._text + this.children.map(function (c) { return c.textContent; }).join('');
    },
    set textContent(v) {
      this._text = (v === undefined || v === null) ? '' : String(v);
      this.children.length = 0;
    },

    appendChild: function (child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    /* 真 DOM 的元素有 `childNodes`（含文本节点）。这里没有文本节点，就**按子元素对齐**：
     * 界面代码里用 `childNodes.length` 判"有没有塞进去东西"是合法写法，缺了它会在挂载时炸
     * （实测：自动判分那条路第一次走到 `paintDetail` 就 TypeError）。 */
    get childNodes() { return this.children; },
    removeChild: function (child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    setAttribute: function (k, v) {
      this.attrs[k] = String(v);
      if (k === 'id') this.id = String(v);
    },
    getAttribute: function (k) {
      return (k in this.attrs) ? this.attrs[k] : null;
    },
    addEventListener: function (t, fn) {
      this.listeners[t] = (this.listeners[t] || []).concat([fn]);
    },
    /* 真浏览器里 disabled 的按钮**不会**派发 click —— 这条语义必须照样实现，
     * 否则"禁用后点了也不回调"那条断言就是假的。 */
    click: function () {
      if (this.disabled) return false;
      (this.listeners.click || []).forEach(function (fn) { fn({ type: 'click', target: el }); });
      return true;
    },
    /* 真 DOM 有 dispatchEvent：测试要模拟"打字"（input 事件）时必须能用。
     * 传字符串或 {type} 都行 —— 免得每个调用点都去造事件对象。 */
    dispatchEvent: function (ev) {
      const t = (typeof ev === 'string') ? ev : (ev && ev.type);
      const payload = (ev && typeof ev === 'object') ? ev : { type: t, target: el };
      (this.listeners[t] || []).forEach(function (fn) { fn(payload); });
      return true;
    }
  };
  return el;
}

function makeDoc() {
  const doc = {
    createElement: function (tag) { return makeEl(doc, tag); },
    getElementById: function (id) {
      return walk(doc.documentElement).filter(function (n) { return n.id === id; })[0] || null;
    }
  };
  doc.documentElement = makeEl(doc, 'html');
  doc.head = makeEl(doc, 'head');
  doc.documentElement.appendChild(doc.head);
  return doc;
}

/* 深度优先、文档顺序 —— 遍历这棵树用，别指望选择器 */
function walk(node, out) {
  const acc = out || [];
  (node.children || []).forEach(function (c) { acc.push(c); walk(c, acc); });
  return acc;
}
/* 按属性找节点：byAttr(root,'data-wv','item') */
function byAttr(root, name, value) {
  return walk(root).filter(function (n) {
    return n.attrs[name] !== undefined && (value === undefined || n.attrs[name] === String(value));
  });
}
/* 按类名找节点（只支持单个类名，够用） */
function byClass(root, cls) {
  return walk(root).filter(function (n) {
    return (' ' + n.className + ' ').indexOf(' ' + cls + ' ') >= 0;
  });
}
function byTag(root, tag) {
  const t = String(tag).toUpperCase();
  return walk(root).filter(function (n) { return n.tagName === t; });
}

module.exports = { makeDoc: makeDoc, makeEl: makeEl, walk: walk, byAttr: byAttr, byClass: byClass, byTag: byTag };
