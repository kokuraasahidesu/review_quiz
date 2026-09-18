/* ============================================================
 *  core/data.js —— 存储路由 + 容量测算 + 分享脱敏/内嵌
 *
 *  为什么要"存储路由"：file:// 下 IndexedDB 能不能用你还没确认（探针待测）。
 *  把存储做成可注入的后端 + 自动降级，这样三种探针结果都能靠换一个后端解决，
 *  上层业务代码一行都不用改。
 * ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DataCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- 工具 ---------------- */
  function utf8Bytes(s) {
    // 不能用 Blob（Node 里也行但没必要），手算 UTF-8 字节数
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.codePointAt(i);
      if (c > 0xFFFF) i++;
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c < 0x10000) n += 3;
      else n += 4;
    }
    return n;
  }
  function jsonBytes(v) { return utf8Bytes(JSON.stringify(v)); }

  /* ---------------- 命名空间与键前缀：唯一真相源 ----------------
   * 为什么这件事必须集中管：
   *   file:// 下**所有本地 HTML 共享同一份 localStorage / IndexedDB**。
   *   两个分享文件若各写各的、键名又一样，就会互相串数据 —— 隔离只能靠前缀。
   *   而"出题者"与"分享文件里的接收者"必须用**同一套**前缀规则，
   *   否则出题者读不到自己的、或接收者的作答记录落到出题者的空间里去。
   *   所以：任何地方都不许手拼 '::'，一律调下面这些函数。
   */
  const NS_SEP = '::';
  const NS_GLOBAL = 'app';             // 全局空间：设置 / 落点索引 / 各卷本体
  const NS_RECV_PREFIX = 'recv_';      // 接收者本地空间：作答记录 / 错题 / 会话
  const INDEX_MARK = '__index__';      // 落点索引在该空间的键名

  const KEY_EXAM = 'exam';
  const KEY_RECORD = 'record';
  const KEY_WRONG = 'wrong';

  function receiverNamespace(examId) { return NS_RECV_PREFIX + String(examId == null ? '' : examId); }
  /*
   * 分享文件的**内容指纹**（组级红队抓到的真漏洞的补丁）：
   *   卷 id 会撞名 —— 两个人都把文件命名成 `题库.docx`（答题页正是拿文件名当卷 id），
   *   或者都用内置样卷（`sample.docx`）。光用 id 建接收者空间，**甲的文件与乙的文件记录会混在一起**。
   *   指纹只看**载荷内容**（标题 + 题数 + 每题 id/题型/题干前 24 字/答案前 8 字），所以：
   *     · 同一份内容反复打开 → 同一个空间（续答照旧）；
   *     · 内容不同（哪怕 id 一模一样）→ 不同空间（互不串）。
   *   FNV-1a 32 位足够（这里要的是"区分内容"，不是抗碰撞的安全哈希）。
   */
  function contentFingerprint(exam) {
    const e = exam || {};
    const qs = Array.isArray(e.questions) ? e.questions : [];
    const parts = [String(e.title == null ? '' : e.title), String(qs.length)];
    qs.forEach(function (q) {
      parts.push(String((q && q.id) || '') + '\u0002' + String((q && q.type) || '') + '\u0002' +
                 String((q && q.stem) || '').slice(0, 24) + '\u0002' + String((q && q.answer) || '').slice(0, 8));
    });
    const s = parts.join('\u0001');
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  /* 接收者空间的**唯一正确入口**（页面与测试都只调它）：`recv_<卷id>.<内容指纹>` */
  function receiverNamespaceFor(exam) {
    const e = exam || {};
    const id = String(e.id == null ? '' : e.id);
    const fp = contentFingerprint(e);
    return receiverNamespace(id + '.' + fp);
  }
  // 卷本体是**精确键**（不是前缀）—— 这样 exam::A 不会误伤 exam::A2
  function examBodyKey(examId) { return KEY_EXAM + NS_SEP + String(examId == null ? '' : examId); }
  // 卷的子键用带尾分隔符的前缀 —— 'exam::A::' 不会匹配 'exam::A2::x'
  function examSubPrefix(examId) { return KEY_EXAM + NS_SEP + String(examId == null ? '' : examId) + NS_SEP; }
  function examSubKey(examId, name) { return examSubPrefix(examId) + String(name == null ? '' : name); }
  function recordKey(examId) { return KEY_RECORD + NS_SEP + String(examId == null ? '' : examId); }
  function wrongKey(examId) { return KEY_WRONG + NS_SEP + String(examId == null ? '' : examId); }
  function examScopeOf(examId) {
    return { id: String(examId == null ? '' : examId),
             body: examBodyKey(examId), sub: examSubPrefix(examId),
             record: recordKey(examId), wrong: wrongKey(examId) };
  }

  function prefixedKey(ns, key) { return ns + NS_SEP + key; }
  function nsOf(fullKey) { const i = String(fullKey).indexOf(NS_SEP); return i < 0 ? null : String(fullKey).slice(0, i); }
  function keyOf(fullKey) { const i = String(fullKey).indexOf(NS_SEP); return i < 0 ? null : String(fullKey).slice(i + NS_SEP.length); }
  function isInNamespace(fullKey, ns) { return String(fullKey).indexOf(ns + NS_SEP) === 0; }
  function indexKeyOf(ns) { return ns + NS_SEP + INDEX_MARK; }

  // 命名空间里一旦含分隔符，隔离边界就被撑破：
  //   ns='a' 会把 'a::b::k' 认成自己的（前缀 'a::' 命中），于是两个空间串数据。
  //   这属于调用方的编程错误，必须在**建 store 这个唯一入口**上大声炸掉，不能静默放行。
  function assertSafeNamespace(ns) {
    if (String(ns).indexOf(NS_SEP) >= 0) {
      throw new Error('命名空间名里不能含分隔符 ' + JSON.stringify(NS_SEP) + '：' + JSON.stringify(ns) +
                      '（会让前缀隔离失效，两个空间互相串数据）');
    }
    return ns;
  }

  /*
   * 本机存储体检：**真写一次、再读回来、然后删掉**，才回答"能不能存"。
   * 为什么不能只看 `typeof localStorage`：隐私模式 / 配额满 / 被策略禁用时那个对象**存在**，
   * 但一写就抛 —— 只看存在性会给出"能存"的假结论，而用户最怕的正是"以为存上了，刷新全没了"。
   * 返回 `{ok, reason, degraded, message}`；`ok:false` 时 message 必须说清**为什么**（禁用了/配额满/读回不一致）
   * 与**怎么办**（换普通窗口 / 清点存储 / 先别刷新 / 导出留档）—— 只报错误码的空白提示是不合格的。
   */
  function storageHealth(backend) {
    const b = (backend == null) ? null : backend;
    if (!b || typeof b.setItem !== 'function' || typeof b.getItem !== 'function') {
      return { ok: false, reason: 'no-backend', degraded: true,
               message: '这台机器上拿不到可用的本地存储（浏览器禁用了本地存储，或本文件在不允许存储的环境里运行）'
                 + '——本次作答不会被保存，刷新就没了。想留住记录：换一个普通窗口（非隐私模式）重新打开本文件。' };
    }
    const key = prefixedKey(NS_GLOBAL, '__probe__');
    const token = 'ok:' + Date.now();
    try {
      b.setItem(key, token);
      const back = b.getItem(key);
      if (typeof b.removeItem === 'function') b.removeItem(key);
      if (back !== token) {
        return { ok: false, reason: 'unreliable', degraded: true,
                 message: '本机存储写进去又读不回来（数据可能被浏览器清理或被同步策略改写）——本次作答不保证能保存；'
                   + '建议换一个浏览器窗口，或先把题面导出成文件留档。' };
      }
      return { ok: true, reason: 'ok', degraded: false, message: '本机存储可用（记录只写你本机）' };
    } catch (e) {
      try { if (typeof b.removeItem === 'function') b.removeItem(key); } catch (e2) { /* 探测键清理失败不影响结论 */ }
      return { ok: false, reason: 'quota', degraded: true,
               message: '本机存储写不进去（配额已满，或被浏览器策略禁止）——本次作答不会被保存，刷新就没了。'
                 + '可以清一点浏览器存储、或换一个窗口/浏览器再试；正在刷题的话先别刷新。' };
    }
  }

  /* ---------------- 存储路由 ----------------   * small: 同步后端（localStorage 风格）  接口 getItem/setItem/removeItem/key/length
   * large: 异步后端（IndexedDB 风格）      接口 get/set/del/keys  （返回 Promise）
   * threshold: 单条记录超过这个字节数就走 large
   */
  function createStore(opts) {
    const small = opts.small, large = opts.large;
    // 注意用 != null 而不是 ||：阈值 0 是合法配置（"全部走异步后端"），
    // 用 || 会把显式的 0 当成"没传"，悄悄换成 200KB 默认值。
    const threshold = (opts.threshold != null) ? opts.threshold : 200 * 1024;
    const ns = assertSafeNamespace(opts.namespace || NS_GLOBAL);
    const INDEX_KEY = indexKeyOf(ns);         // 落点索引：**每个命名空间各一份**

    function readIndex() {
      try { return JSON.parse(small.getItem(INDEX_KEY) || '{}'); } catch (e) { return {}; }
    }
    function writeIndex(ix) { small.setItem(INDEX_KEY, JSON.stringify(ix)); }

    // 索引是"落点提示"，不是数据本体。
    // 配额满时连索引都可能写不下 —— 那时**不能**把整次写入判为失败：
    // 数据已经安全落到异步后端了，而读取侧有"索引丢了就两端找"的兜底（见 get）。
    // 早期版本在降级路径里直接调 writeIndex，于是"配额满"这个场景本身会把 set() 打挂。
    function writeIndexSafe(ix) {
      try { writeIndex(ix); return true; }
      catch (e) { return false; }
    }
    function fullKey(k) { return prefixedKey(ns, k); }

    return {
      namespace: ns,
      placement: function (k) { return readIndex()[k] || null; },

      /* 本命名空间内、按键前缀筛出来的键（落点无关） */
      async keysWithPrefix(prefix) {
        const p = String(prefix == null ? '' : prefix);
        const ks = await this.keys();
        return p ? ks.filter(function (k) { return k.indexOf(p) === 0; }) : ks;
      },

      /*
       * 按"作用域"清数据：只在本命名空间内生效，且只清指定的精确键与前缀。
       *   scope = { exact?: string[], prefix?: string[] }
       * 安全护栏：空串前缀会被**拒绝** —— 那等于清空整个命名空间，
       *           不能靠一个手滑的字符串就发生。
       */
      async purgeByScope(scope) {
        const s = scope || {};
        const exact = Array.isArray(s.exact) ? s.exact.slice() : [];
        const prefix = Array.isArray(s.prefix) ? s.prefix.slice() : [];
        for (const p of prefix) {
          if (!String(p)) return { ok: false, ns: ns, error: '拒绝空前缀（那会清空整个命名空间）', deleted: [] };
        }
        const all = await this.keys();
        const hit = [];
        all.forEach(function (k) {
          if (exact.indexOf(k) >= 0) { hit.push(k); return; }
          for (const p of prefix) { if (k.indexOf(p) === 0) { hit.push(k); return; } }
        });
        for (const k of hit) await this.del(k);
        return { ok: true, ns: ns, deleted: hit, kept: all.filter(k => hit.indexOf(k) < 0) };
      },

      /*
       * 删除**单卷**的数据。默认只删这份卷子自己的东西；
       * 作答记录/错题要不要跟着删，由调用方决定（那是"删卷级联询问"那小类的政策），
       * 这里只提供机制、不替用户做决定。
       * 同时把落点索引里的该卷 id 摘掉 —— 索引也是本小类要维护的东西。
       */
      async purgeExam(examId, o) {
        const opt = o || {};
        const scope = examScopeOf(examId);
        const res = await this.purgeByScope({
          exact: [scope.body].concat(opt.includeRecords ? [scope.record, scope.wrong] : []),
          prefix: [scope.sub]
        });
        // 维护索引：只摘掉这一卷，别的卷与设置一律不动
        let idx = null;
        try { idx = await this.get('index'); } catch (e) { idx = null; }
        if (idx && typeof idx === 'object' && Array.isArray(idx.examIds)) {
          const before = idx.examIds.length;
          idx.examIds = idx.examIds.filter(function (x) { return x !== scope.id; });
          if (idx.examIds.length !== before) {
            idx.updatedAt = new Date().toISOString();
            await this.set('index', idx);
          }
        }
        return { ok: res.ok, ns: res.ns, examId: scope.id, deleted: res.deleted, scope: scope };
      },

      async set(key, value) {
        const bytes = jsonBytes(value);
        const ix = readIndex();
        const fk = fullKey(key);

        if (bytes > threshold && large) {
          await large.set(fk, value);
          ix[key] = 'large';
          const okIdx = writeIndexSafe(ix);
          try { small.removeItem(fk); } catch (e) {}
          return { where: 'large', bytes: bytes, indexPersisted: okIdx };
        }
        try {
          small.setItem(fk, JSON.stringify(value));
          ix[key] = 'small';
          const okIdx = writeIndexSafe(ix);
          if (large) { try { await large.del(fk); } catch (e) {} }
          return { where: 'small', bytes: bytes, indexPersisted: okIdx };
        } catch (e) {
          const quota = /quota/i.test(e && (e.name + ' ' + e.message));
          if (!large) throw e;
          // 同步后端写不下 → 降级到异步后端（这就是需求里的"量大自动切换"）
          await large.set(fk, value);
          ix[key] = 'large';
          const okIdx = writeIndexSafe(ix);
          return { where: 'large', bytes: bytes, indexPersisted: okIdx,
                   reason: quota ? 'quota' : String(e && e.name) };
        }
      },

      async get(key) {
        const where = readIndex()[key];
        const fk = fullKey(key);
        // 快路径：索引命中就直接读对应后端
        if (where === 'small') {
          const s = small.getItem(fk);
          if (s != null) return JSON.parse(s);
        }
        if (where === 'large' && large) {
          const v = await large.get(fk);
          if (v != null) return v;
        }
        // 慢路径：索引缺失**或已过期**时两端都找一遍。
        // 索引是会过期的：配额满时数据能写进异步后端，索引却可能写不动；
        // 早期实现只看索引指向的那一侧，读不到就返回 null —— 数据还在却读不出来，等于丢数据。
        // 注意用 `!= null` 而不是真值判断：存进去的 0 / false / '' 都是合法值。
        if (large) { const v = await large.get(fk); if (v != null) return v; }
        const s = small.getItem(fk);
        return s == null ? null : JSON.parse(s);
      },

      async del(key) {
        const ix = readIndex();
        const fk = fullKey(key);
        try { small.removeItem(fk); } catch (e) {}
        if (large) { try { await large.del(fk); } catch (e) {} }
        delete ix[key];
        // 索引写不动也不能让删除失败：两侧该清的已经清了
        writeIndexSafe(ix);
      },

      async keys() {
        const ix = readIndex();
        const out = Object.keys(ix);
        if (large) {
          try {
            const lk = await large.keys();
            lk.forEach(function (fk) {
              if (fk.indexOf(ns + '::') === 0) {
                const k = fk.slice(ns.length + 2);
                if (k !== '__index__' && out.indexOf(k) < 0) out.push(k);
              }
            });
          } catch (e) {}
        }
        for (let i = 0; i < small.length; i++) {
          const fk = small.key(i);
          if (fk && fk.indexOf(ns + '::') === 0) {
            const k = fk.slice(ns.length + 2);
            if (k !== '__index__' && out.indexOf(k) < 0) out.push(k);
          }
        }
        return out;
      },

      // 估算当前命名空间总占用（字节）
      async usage() {
        let total = 0;
        const ks = await this.keys();
        for (const k of ks) total += jsonBytes(await this.get(k));
        return total;
      }
    };
  }

  /* ---------------- 容量测算（回答"5MB 到底能装多少题"） ---------------- */
  function capacityReport(questions, limitBytes, compress) {
    const limit = limitBytes || 5 * 1024 * 1024;
    const packed = { v: 1, questions: questions };
    const rawJson = JSON.stringify(packed);
    const rawBytes = utf8Bytes(rawJson);
    let compBytes = null;
    if (compress) {
      try { compBytes = compress(rawJson).length; } catch (e) { compBytes = null; }
    }
    const perRaw = questions.length ? rawBytes / questions.length : 0;
    const perComp = (compBytes != null && questions.length) ? compBytes / questions.length : null;
    return {
      sampleCount: questions.length,
      rawBytes: rawBytes, compressedBytes: compBytes,
      bytesPerQuestionRaw: Math.round(perRaw),
      bytesPerQuestionCompressed: perComp != null ? Math.round(perComp) : null,
      limitBytes: limit,
      fitRaw: perRaw ? Math.floor(limit / perRaw) : 0,
      fitCompressed: perComp ? Math.floor(limit / perComp) : 0,
      ratio: compBytes ? Math.round((compBytes / rawBytes) * 1000) / 1000 : null
    };
  }

  // 造一批"典型大小"的题，用于容量测算
  function synthQuestions(n) {
    const out = [];
    const types = ['单选', '多选', '判断', '简答'];
    for (let i = 0; i < n; i++) {
      const t = types[i % 4];
      const q = {
        id: 'q' + i, type: t,
        stem: '第' + (i + 1) + '题：下列关于计算机网络协议分层与数据封装过程的说法中，哪一项是正确的？',
        explanation: '解析：本题考查协议分层的职责边界与封装/解封装顺序，注意各层首部的添加位置。'
      };
      if (t === '单选' || t === '多选') {
        q.options = [
          { label: 'A', text: '传输层负责端到端可靠传输，并在数据前添加端口号首部' },
          { label: 'B', text: '网络层负责路由选择与拥塞控制，使用 IP 地址寻址' },
          { label: 'C', text: '数据链路层负责帧的封装与差错检测，使用 MAC 地址' },
          { label: 'D', text: '物理层负责比特流传输，不进行任何编码' }
        ];
        q.answer = t === '单选' ? 'B' : 'ABC';
        q.answerLetters = t === '单选' ? ['B'] : ['A', 'B', 'C'];
      } else if (t === '判断') {
        q.answer = i % 2 ? '√' : '×';
        q.judgeValue = !!(i % 2);
      } else {
        q.answer = '参考答案：先建立连接，再传输数据，最后释放连接。';
        q.keywords = [
          { text: '三次握手', via: '加粗' }, { text: 'SYN', via: '加粗' },
          { text: 'ACK', via: '加粗' }, { text: 'ESTABLISHED', via: '高亮' }
        ];
      }
      out.push(q);
    }
    return out;
  }

  /* ---------------- 分享脱敏 ---------------- */
  const FORBIDDEN_KEYS = ['apikey', 'api_key', 'key', 'keys', 'token', 'tokens', 'secret', 'secrets',
                          'records', 'record', 'answers', 'history', 'wrongbook', 'wrong', 'progress', 'draft',
                          /* 红队补的：这些键名同样一眼就是机密（收在名单里比"漏出去"强） */
                          'password', 'passwd', 'pwd', 'credential', 'credentials', 'authorization', 'auth',
                          /* 红队第七轮补的：复数形/凭证类同义词漏了一整排，`cookie` 更是典型的会话凭证 */
                          'cookie', 'cookies', 'privatekey', 'accesskey', 'secretkey'];
  /* 敏感**词**表：切词后按词命中。第七轮补了裸词 `key`（`myKey`/`key1`/`some_key_thing` 以前一条都拦不住）
   * 与 `tokens`/`secrets`/`cookie`/`privatekey`/`accesskey`（复数形态与书面语同义词）。 */
  const FORBIDDEN_WORDS = ['apikey', 'api', 'key', 'token', 'tokens', 'secret', 'secrets', 'keys', 'keybag',
                           'password', 'passwd', 'pwd',
                           'credential', 'credentials', 'authorization', 'auth', 'bearer',
                           'cookie', 'cookies', 'privatekey', 'accesskey', 'secretkey'];

  /*
   * 「像密钥的字符串」不止 sk- 一种。逐个给形状**并带上名字**，命中时能说清像哪家的什么：
   * 只认 sk- 是实测过的漏网 —— 百炼/OpenAI 是 sk-，但 GitHub、Slack、AWS、JWT 都不是。
   * ⚠ 每条都要够"紧"，否则会把普通题目文本判成泄漏（`Bearer` 必须后面真跟着一段 token）。
   */
  const SECRET_SHAPES = [
    { name: 'sk- 型（OpenAI/百炼/DeepSeek…）', re: /\bsk-[A-Za-z0-9_\-]{12,}\b/ },
    { name: 'Bearer 令牌', re: /\bBearer\s+[A-Za-z0-9._\-]{16,}\b/ },
    { name: 'JWT（三段点分）', re: /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/ },
    { name: 'GitHub 令牌', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
    { name: 'Slack 令牌', re: /\bxox[abprs]-[A-Za-z0-9\-]{10,}\b/ },
    { name: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: 'Google API Key', re: /\bAIza[0-9A-Za-z_\-]{30,}\b/ },
    { name: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ }
  ];
  /* ⚠ 这里曾有一个 `KEY_PATTERN = SECRET_SHAPES[0].re` 的"旧名字"。它没有任何调用点/导出，
   *   纯粹是历史包袱，而且**误导**：名字听起来像"唯一的密钥正则"，实际只是 8 条形状里的第 1 条。
   *   第七轮清掉（文档里凡是提"KEY_PATTERN"的地方也一并改口）。 */

  function secretShapesIn(text) {
    const s = String(text == null ? '' : text);
    return SECRET_SHAPES.filter(function (x) { return x.re.test(s); }).map(function (x) { return x.name; });
  }

  function findSecrets(obj, path) {
    const hits = [];
    const walk = function (v, p) {
      if (v == null) return;
      if (typeof v === 'string') {
        const shapes = secretShapesIn(v);
        if (shapes.length) hits.push({ path: p, why: '疑似密钥字符串（' + shapes.join('、') + '）', shapes: shapes });
        return;
      }
      if (typeof v !== 'object') return;
      if (Array.isArray(v)) { v.forEach((x, i) => walk(x, p + '[' + i + ']')); return; }
      Object.keys(v).forEach(function (k) {
        /* 键名也是文本：钥匙写进键名（`{'sk-…': [...]}`）跟写在值里一样是泄漏 —— 与 shareScan 同口径。
         * （`shareScan` 另外还按**字段名语义**判敏感键，那是闸门的额外一关；这里只做形状体检。） */
        const shapesInKey = secretShapesIn(k);
        if (shapesInKey.length) {
          hits.push({ path: p + '.' + k, why: '疑似密钥字符串出现在键名里（' + shapesInKey.join('、') + '）', shapes: shapesInKey });
        }
        /* ⚠ 这里刻意**只认有值的敏感字段**（宽口径：结构体检用）。
         *   真正当闸门用的是 `shareScan`：它连**值为 null 的敏感键名**也报（键名本身就是线索）。
         *   两者语义不同是**有意的**，且各有一条随仓断言钉住（见 share-payload.test.js ①-F）。 */
        if (v[k] != null && isForbiddenKey(k)) {
          hits.push({ path: p + '.' + k, why: '敏感字段名：' + k });
        }
        walk(v[k], p + '.' + k);
      });
    };
    walk(obj, '$');
    return hits;
  }

  /*
   * 分享载荷的**字段白名单**（唯一真相源）。
   * 为什么要把白名单写成常量：以前是内联在 map 里的对象字面量，
   * 加字段时靠"记得也加一行"，很容易顺手把 answers/records 带出去。现在测试可以直接拿它逐字段核对。
   */
  const SHARE_EXAM_FIELDS = ['id', 'title', 'config', 'configLocked', 'questions'];
  const SHARE_QUESTION_FIELDS = ['id', 'type', 'stem', 'options', 'answer', 'answerLetters',
                                 'judgeValue', 'keywords', 'explanation'];

  function deepClone(v) { return (v == null) ? v : JSON.parse(JSON.stringify(v)); }
  /* 键名归一：先 NFKC（全角 `ａｐｉＫｅｙ` 要能还原成 `apiKey`），再取字母。
   * 红队第四轮实测：不做 NFKC 时全角键名宽严两口径都放行，值原样带出去。 */
  function lowerKey(k) { return String(k).normalize ? String(k).normalize('NFKC').toLowerCase().replace(/[^a-z_]/g, '') : String(k).toLowerCase().replace(/[^a-z_]/g, ''); }
  /* 键名切词：camelCase / snake_case / kebab-case / 数字边界都拆开，逐词判定。
   * 为什么必须逐词：`x-api-key`、`accessToken`、`secretKey`、`clientSecret` 这类**复合键名**
   * 用整名精确匹配一条都拦不住（红队第二轮实测：这几个键名连着明文一起被带出去，扫描还判"零命中"）。 */
  function keyTokens(k) {
    const s = String(k).normalize ? String(k).normalize('NFKC') : String(k);
    return s
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .map(function (t) { return t.toLowerCase(); })
      .filter(Boolean);
  }
  /* 白名单式例外：这些键名虽然含敏感词，但业务上**确实**要保留。
   * ⚠ `keys` 第七轮从这张表里**删掉**了：它是机密袋子的常见键名，剥离侧放行它没有任何业务理由
   *   （当年只是为了少误删），结果形成"扫描说零命中、键名却还在"的自相矛盾。宁可多剔一个空键名。 */
  const KEY_NAME_EXCEPTIONS = ['keywords', 'keyword', 'keypoints', 'record'];
  /* 扫描（闸门）用**严格例外表**：只放行载荷自己的字段名 `keywords`（判分要用）。
   * 为什么扫描要比剥离更严：剥离侧为了不误删业务字段放了几个例外（keyword/keypoints/record），
   * 若扫描也用同一张表，就会出现"键名明明还在载荷里、扫描却说零命中"（红队 P3 实测）。
   * 现在的关系是：剥离尽量不误删 → 扫描按最严口径复核 → 复核不过就**拒绝导出**（而不是默默放行）。 */
  const STRICT_KEY_EXCEPTIONS = ['keywords'];

  function isForbiddenKey(k, opts) {
    const strict = !!(opts && opts.strict);
    const name = lowerKey(k);
    const exceptions = strict ? STRICT_KEY_EXCEPTIONS : KEY_NAME_EXCEPTIONS;
    if (exceptions.indexOf(name) >= 0) return false;
    if (FORBIDDEN_KEYS.indexOf(name) >= 0) return true;
    const toks = keyTokens(k);
    return toks.some(function (t) { return FORBIDDEN_WORDS.indexOf(t) >= 0; });
  }

  /*
   * 容器里的敏感键要**递归剔除**（而不是"顶层白名单对了就行"）。
   * 实测过：`exam.config.apiKey = 'sk-…'`、`options[0].token = 'sk-…'` 这种"塞进白名单容器内部"的写法，
   * 会被整对象透传带出去 —— 顶层白名单一条都拦不住（红队 P2）。
   * 规则：任何层级只要键名命中敏感词，整条删掉（连键一起，不是置空）。
   * ⚠ 深度上限**必须 fail-closed**：超深时早先是 `return v`（把整棵子树原样带出 = 反向泄漏），
   *   现在是**丢掉这棵子树**（宁可少带一点用户配置，也不能把深层的东西原样发出去）。
   */
  const STRIP_MAX_DEPTH = 32;
  function stripForbidden(v, depth) {
    const d = depth || 0;
    if (v == null || typeof v !== 'object') return v;
    if (d >= STRIP_MAX_DEPTH) return null;                       // fail-closed：超深直接丢
    if (Array.isArray(v)) return v.map(function (x) { return stripForbidden(x, d + 1); });
    const out = {};
    Object.keys(v).forEach(function (k) {
      if (isForbiddenKey(k)) return;                             // 连键一起丢掉
      out[k] = stripForbidden(v[k], d + 1);
    });
    return out;
  }

  /* state.exams 既可能是数组（测试/临时构造），也可能是契约里的**映射** `{[id]:exam}`
   * （`SchemaCore.createAppState()` 就是这个形状）—— 两种都收，否则唯一入口在真实 AppState 上直接崩。 */
  function examsOfState(st) {
    const e = st && st.exams;
    if (Array.isArray(e)) return e.filter(function (x) { return x && typeof x === 'object'; });
    if (e && typeof e === 'object') {
      return Object.keys(e).map(function (k) { return e[k]; }).filter(function (x) { return x && typeof x === 'object'; });
    }
    return [];
  }
  function normalizeSecret(s) {
    /* 比对前归一：去掉空白与零宽字符（长 key 在文档里折行、被复制时夹零宽空格都是现实场景）。
     * 否则"中间插一个换行"就能让值级比对失效（红队 P3 实测）。 */
    return String(s == null ? '' : s).replace(/[\s\u200B-\u200D\uFEFF]+/g, '');
  }

  // 生成"可分享"的载荷：只留试卷本体 + 配置（含关键词）
  function sanitizeSharePayload(state, opts) {
    const o = opts || {};
    const st = state || {};
    /* 选卷口径：`examIds`（多选，用户要求"可以选择一并打包的试卷"）> `examId`（单选）> 全都要。
     * ⚠ 两者都给时以 `examIds` 为准（它是更具体的那一个）；空数组按"没给"处理。 */
    const ids = (Array.isArray(o.examIds) && o.examIds.length) ? o.examIds.map(String) : null;
    const exams = examsOfState(st).filter(function (e) {
      if (ids) return ids.indexOf(String(e.id)) >= 0;
      return !o.examId || e.id === o.examId;
    });
    const payload = {
      kind: 'quiz-share', schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      exams: exams.map(function (e) {
        const out = {};
        SHARE_EXAM_FIELDS.forEach(function (k) {
          if (k === 'questions') return;
          const v = e[k];
          if (k === 'configLocked') out[k] = !!v;
          else if (k === 'config') {
            const cloned = (v && typeof v === 'object') ? deepClone(v) : null;
            const cfg = cloned ? stripForbidden(cloned) : null;
            /* ⚠ `config.short.synonyms` 的**键是关键词文本（用户数据）**，不是配置字段名：
             *   形如 {'API':['应用程序接口'], 'token':['令牌']} —— 拿敏感词表去剔键，
             *   会把这些采分同义词整表剔空：同一份作答判分从 5/5 掉到 0/5，而扫描还报"零命中"
             *   （红队第五轮实测）。同义词表按**数据**对待：原样保留（只深拷贝）。 */
            if (cloned && cloned.short && cloned.short.synonyms && typeof cloned.short.synonyms === 'object') {
              if (!cfg) { out[k] = cloned; }
              else {
                cfg.short = (cfg.short && typeof cfg.short === 'object') ? cfg.short : {};
                cfg.short.synonyms = cloned.short.synonyms;
                out[k] = cfg;
              }
            } else out[k] = cfg;
          }
          else out[k] = (v == null) ? v : v;
        });
        const qs = Array.isArray(e.questions) ? e.questions : [];
        out.questions = qs.filter(function (q) { return q && typeof q === 'object'; }).map(function (q) {
          const oq = {};
          SHARE_QUESTION_FIELDS.forEach(function (k) {
            /* 容器类字段一律**深拷贝 + 递归剔除**：既不带敏感子键，也不与原 state 共享引用
             * （共享引用下"改载荷"会穿回原卷，红队 P3）。 */
            if (k === 'options') { oq.options = q.options ? stripForbidden(deepClone(q.options)) : null; return; }
            if (k === 'keywords') { oq.keywords = q.keywords ? stripForbidden(deepClone(q.keywords)) : null; return; }
            if (k === 'answerLetters') { oq.answerLetters = q.answerLetters ? q.answerLetters.slice() : null; return; }
            if (k === 'judgeValue') { oq.judgeValue = (q.judgeValue === undefined ? null : q.judgeValue); return; }
            if (k === 'explanation') { oq.explanation = q.explanation || ''; return; }
            oq[k] = (q[k] === undefined ? null : q[k]);
          });
          return oq;
        });
        return out;
      })
      // 明确不带：settings(含密钥)、records、wrongBook、progress、draft
      // 做法是"键都不出现"，而不是留个 null —— 这样"分享文件里连敏感字段名都没有"这条
      // 不变量可以被 findSecrets/shareScan 直接断言，审计起来更硬。
    };
    return payload;
  }

  /*
   * 分享载荷的**出厂体检**（生成后立刻扫一遍，零命中才允许写文件）：
   *   ① 密钥形状：载荷里的**所有文本**（字符串值 + **对象键名**）都不许出现任何 SECRET_SHAPES；
   *   ② 敏感字段名：**连 null 值也算**（载荷比"任意对象"更严 —— 键名本身就是线索）；
   *   ③ 来源串味：state 里那些明确算秘密的值（`state.secrets`、`settings.apiKeys/keys/apiKey`、
   *      `records[].answer`…，见 secretsOfState），一个都不许在载荷里以**任何形式**出现
   *      （比对值级，防"换个键名照样带出去"；键名也算"形式"）。
   * 返回 `{ok, hits[], checked{...}}`；`ok === true` 才允许落盘。
   */
  function shareScan(payload, opts) {
    const o = opts || {};
    const hits = [];
    const minLen = function () { return o.minSecretLength != null ? o.minSecretLength : 8; };
    const secrets = (o.secrets || []).map(function (s, i) { return { s: normalizeSecret(s), i: i }; });
    /*
     * 一段**文本**的体检：① 密钥形状 ② 来源机密比对。
     * ⚠ 对象**键名**也要按文本扫（红队第七轮）：同义词表的**键就是用户写的关键词文本**，
     *   把密钥写进键名（`{'sk-…': ['应用程序接口']}`）在"只扫值"的实现里完全隐形，扫描还报零命中。
     *   键名是字符串 = 是文本，就必须过同样两关（路径白名单只豁免"字段名语义",不豁免"文本内容"）。
     */
    const scanText = function (text, path, where) {
      const tv = String(text == null ? '' : text);
      secretShapesIn(tv).forEach(function (n) { hits.push({ path: path, why: where + '出现密钥形状：' + n }); });
      const nv = normalizeSecret(tv);
      secrets.forEach(function (x) {
        /* 归一后再比：中间插空白/零宽字符也拦得住 */
        if (x.s && x.s.length >= minLen() && nv.indexOf(x.s) >= 0) {
          hits.push({ path: path, why: where + '出现来源机密（第 ' + (x.i + 1) + ' 条）' });
        }
      });
    };
    /* 路径白名单：这些路径下的**键是用户数据**（关键词文本），不能按**字段名**判敏感。
     * （文本内容照样扫 —— 见 scanText。） */
    const isDataKeysPath = function (p) { return /\.config\.short\.synonyms$/.test(p); };
    // ① + ②：载荷自身的形状与字段名
    const walk = function (v, p) {
      if (v == null) return;
      if (typeof v === 'string') { scanText(v, p, '载荷里'); return; }
      if (typeof v !== 'object') return;
      if (Array.isArray(v)) { v.forEach(function (x, i) { walk(x, p + '[' + i + ']'); }); return; }
      Object.keys(v).forEach(function (k) {
        scanText(k, p + '.' + k, '载荷里的键名');
        if (!isDataKeysPath(p) && isForbiddenKey(k, { strict: true })) {
          hits.push({ path: p + '.' + k, why: '载荷里出现敏感字段名：' + k });
        }
        walk(v[k], p + '.' + k);
      });
    };
    walk(payload, '$');
    const exams = (payload && payload.exams) || [];
    const questions = exams.reduce(function (n, e) { return n + ((e.questions || []).length); }, 0);
    return {
      ok: hits.length === 0, hits: hits,
      checked: { exams: exams.length, questions: questions, secrets: (o.secrets || []).length,
                 topKeys: payload ? Object.keys(payload).sort() : [] }
    };
  }

  /* 把一个 state 里"明确算秘密"的值收集出来（给 shareScan 做来源串味检查） */
  function secretsOfState(state) {
    const st = state || {};
    const out = [];
    const push = function (v) { if (typeof v === 'string' && v) out.push(v); };
    const fromBag = function (bag) {
      if (!bag || typeof bag !== 'object') return;
      Object.keys(bag).forEach(function (k) {
        const one = bag[k];
        if (typeof one === 'string') push(one);
        else if (one && typeof one === 'object') { push(one.key); push(one.apiKey); push(one.token); }
      });
    };
    /* 密钥可能落在这几个地方，一个都不能漏（红队 P3：早先漏了 schema 定义的 state.secrets）：
     *   · state.secrets（core/schema.js 的 createAppState 官方形状）
     *   · settings.apiKeys / settings.keys / settings.apiKey
     *   · 任何一层 settings.* 里形如 {key:...} 的袋子 */
    fromBag(st.secrets);
    const s = st.settings || {};
    fromBag(s.apiKeys);
    fromBag(s.keys);
    fromBag(s.secrets);
    push(s.apiKey);
    push(s.key);
    Object.keys(s).forEach(function (k) {
      const v = s[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) fromBag(v);
    });
    const recs = st.records;
    if (Array.isArray(recs)) recs.forEach(function (r) { if (r && r.answer != null) push(String(r.answer)); });
    /* 去重并丢掉过短的串：少于 8 字符的"机密"在正文里到处会出现（误报远多于收益），
     * 这条已知缺口在此写明 —— 形状扫描（SECRET_SHAPES）仍然覆盖短密钥的常见写法。 */
    const seen = {};
    return out.filter(function (x) {
      if (x.length < 8 || seen[x]) return false;
      seen[x] = 1; return true;
    });
  }

  /* ---------------- 内嵌进单个 HTML / 再读出来 ---------------- */
  const PAYLOAD_ID = 'exam-payload';
  /*
   * 把载荷内嵌成一个 JSON `<script>` 块。
   * 三条硬要求（都有对应断言）：
   *   ① **只有一对** script 标签：内容里的 `<` 一律转义成 `\u003c`，所以题面里写 `</script>`
   *      也截不断文件（不是"删掉那几个字"，而是让它以转义形式原样存活）；
   *   ② **可重复调用不破坏结构**：HTML 里已经有同一个 id 的载荷块时**替换**它，
   *      而不是再插一个（插两个会让 extractPayload 读到旧的那份，且 id 重复）。
   *   ③ 行分隔符 U+2028/U+2029 也要转义：它们在 JS 里是换行，会让 JSON 字符串炸掉。
   */
  /* 已有载荷块的识别：**属性顺序/引号/空白/大小写都不敏感**（HTML 属性名本来就不区分大小写）。
   * `TAG_ATTRS` 允许属性值里出现 `>`（`data-x="a>b"`），否则 id 会被漏掉（红队第四轮 P3）。 */
  const TAG_ATTRS = '(?:[^>"\']|"[^"]*"|\'[^\']*\')*';
  /* ⚠ 这里曾有两套判据：一条"明文正则"（payloadBlockRe）和一份"解码后再比"的逻辑。
   *   两套并存时实测出现过"计数说 1 个、读回说没有载荷"的自相矛盾（红队第四轮），
   *   而且明文正则天生识别不了 `id="&#101;xam-payload"`（第七轮实测）。现在**只有一套**：
   *   全部走 `findPayloadBlocks`（注释掩码 + 解码 id + 自己配对的收尾标签），
   *   清理 / 读回 / 计数 / 残留自检都调它。别再往这里加第二套。 */
  /*
   * HTML 字符引用解码（属性值在解析时会被解码，所以"&#101;xam-payload" 在 DOM 里就是 exam-payload）。
   * ⚠ 教训：识别 id **不能靠明文正则**（"拼写白名单"永远列不全）；但"自己能解码"也不够 ——
   *   浏览器对**没有分号**的数字引用照样解码（`id="exam-payloa&#100"` 在 DOM 里就是 exam-payload），
   *   第一版解码器要求分号，红队第七轮又绕过去了（真浏览器实测两个同 id 元素）。
   *   按 HTML 规范实现：无分号的数字引用，**仅当后面紧跟 `=` 或 ASCII 字母数字时不解码**。
   */
  function decodeCharRefs(s) {
    const src = String(s == null ? '' : s);
    const blocked = function (nextCh) { return !!nextCh && /[0-9A-Za-z=]/.test(nextCh); };
    let out = src.replace(/&#[xX]([0-9a-fA-F]+)(;?)/g, function (m, h, semi, off) {
      if (!semi && blocked(src.charAt(off + m.length))) return m;
      try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return m; }
    });
    out = out.replace(/&#(\d+)(;?)/g, function (m, d, semi, off) {
      if (!semi && blocked(src.charAt(off + m.length))) return m;
      try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return m; }
    });
    return out.replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&lt;/gi, '<')
              .replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
  }
  /*
   * ⚠⚠ 本文件会被**内联**进成品的 `<script>` 块里，所以源码里**绝对不能出现注释开符的那四个字符**：
   *   HTML 解析器在 script 数据里碰到它会切进 "escaped" 状态；之后字符串里再出现 `<script`
   *   就进入 double-escaped 状态，**真正的 `</script>` 会失效**（整份页面当场散架）。
   *   verify/inline-order.test.js 里有一条硬断言盯着这件事（全文件 0 个）。
   *   所以需要那四个字符时一律走这个常量（JS 里 `\!` 就是 `!`，源码与成品都不含原始形态）。
   */
  const COMMENT_OPEN = '<\!--';
  /*
   * 注释区间 —— **唯一**的注释判据（掩码与"注释里有没有载荷痕迹"都从它派生）。
   * ⚠ 未闭合的注释开符按 HTML 规范**一直吃到文件尾**（浏览器就是这么解析的）。
   *   这不是吹毛求疵：正是"注释里的开标签 + 注释外的 `</script>`"配成对，
   *   才导致旧实现把模板自己的 JS 整段删掉、还把载荷写进注释里（红队第七轮）。
   *   内嵌侧对"未闭合注释"是**拒绝**（见 embedPayload ⓪）。
   */
  function commentRegions(src) {
    const s = String(src == null ? '' : src);
    const out = [];
    let i = 0;
    for (;;) {
      const at = s.indexOf(COMMENT_OPEN, i);
      if (at < 0) break;
      const OPEN_LEN = COMMENT_OPEN.length;
      const close = s.indexOf('-->', at + OPEN_LEN);
      const end = close < 0 ? s.length : close + 3;
      out.push({ start: at, end: end, body: s.slice(at, end), closed: close >= 0 });
      i = end > at ? end : at + OPEN_LEN;
    }
    return out;
  }
  /* 注释区掩码：把注释换成**等长**空格（等长才能继续用同一套下标切片）。 */
  function maskComments(src) {
    const s = String(src == null ? '' : src);
    const regions = commentRegions(s);
    if (!regions.length) return s;
    let out = '', cur = 0;
    regions.forEach(function (r) {
      out += s.slice(cur, r.start) + new Array(r.end - r.start + 1).join(' ');
      cur = r.end;
    });
    return out + s.slice(cur);
  }
  /* 从一个开标签里取出（解码后的）id 属性值 */
  function idAttrOf(tagText) {
    const m = String(tagText).match(/\bid\s*=\s*(["\']?)([^"\'>\s]*)\1/i);
    return m ? decodeCharRefs(m[2]) : '';
  }
  /* 判定用：**大小写不敏感**（HTML5 里 id 值本身区分大小写，但"像我们的载荷块"这种事
   * 宁可保守 —— 把 `ID="EXAM-PAYLOAD"` 也当成需要处理的旧块，免得留下视觉/语义上的重复）。 */
  function isPayloadId(v) { return String(v).toLowerCase() === PAYLOAD_ID; }
  /* 标签是不是自闭合写法（`<script … />`） */
  function isSelfClosingTag(tagText) { return /\/\s*>$/.test(String(tagText)); }
  /* 列出源码里所有开标签（含非 script），带位置；用于"解码后按 id 配对" */
  function openTagsOf(src) {
    const out = [];
    const re = new RegExp('<([a-z][a-z0-9]*)\\b' + TAG_ATTRS + '?>', 'gi');
    let m;
    while ((m = re.exec(src)) !== null) out.push({ tag: m[1].toLowerCase(), text: m[0], at: m.index, end: m.index + m[0].length });
    return out;
  }
  /*
   * 列出**没有 `>` 收尾**的 script 开标签（一路到文件尾），带位置。
   * 为什么要单独查：`openTagsOf` 的正则要求标签以 `>` 结束，所以"断在半截的开标签"根本进不了定位器 ——
   * 既清不掉、也过不了残留自检，又是个"清不掉却没拒绝"的口子。
   * 只报 script（这是唯一会被解析器当成真元素的标签），且**尊重引号**（`data-x="a>b"` 里的 `>` 不算收尾）。
   */
  function unterminatedScriptTags(src) {
    const s = maskComments(src);
    const low = s.toLowerCase();
    const out = [];
    let i = 0;
    for (;;) {
      const at = low.indexOf('<script', i);
      if (at < 0) break;
      const next = low.charAt(at + 7);
      if (next && /[a-z0-9]/.test(next)) { i = at + 7; continue; }      // `<scripts` 之类不算标签名
      let j = at + 7, q = '';
      while (j < s.length) {
        const c = s.charAt(j);
        if (q) { if (c === q) q = ''; }
        else if (c === '"' || c === "'") q = c;
        else if (c === '>') break;
        j++;
      }
      if (j >= s.length) out.push({ at: at, text: s.slice(at) });       // 没找到收尾 `>` → 未闭合
      i = j + 1;
    }
    return out;
  }
  /*
   * **唯一**的载荷块定位器：在"注释已掩码"的文本上按解码后的 id 找开标签，再配到它自己的收尾标签。
   * 读回、计数、清理**全都走它** —— 曾经存在两套判据（正则 vs 解码），结果"计数说 1 个、读回说没有载荷"。
   */
  function findPayloadBlocks(src) {
    const s = String(src == null ? '' : src);
    const masked = maskComments(s);
    const low = s.toLowerCase();
    return openTagsOf(masked).filter(function (t) {
      return t.tag === 'script' && isPayloadId(idAttrOf(t.text));
    }).map(function (t) {
      const closeAt = low.indexOf('</script', t.end);
      const closeEnd = closeAt < 0 ? -1 : low.indexOf('>', closeAt) + 1;
      return { start: t.at, endOpen: t.end, closeStart: closeAt, end: closeEnd,
               complete: closeEnd > 0, selfClosing: isSelfClosingTag(t.text) };
    });
  }
  /* 注释里那些"像载荷块"的东西单独列出来：清不掉（也不该乱清）→ 由调用方拒绝。
   * ⚠ 不能用 findPayloadBlocks 去查注释**内部**：它第一步就把注释掩码掉了，永远返回 0（实测踩过）。
   *   这里直接在**原始**注释正文里找"解码后 id 是我们的"的 script 开标签。 */
  function payloadLikeInComments(src) {
    const s = String(src == null ? '' : src);
    return commentRegions(s).filter(function (r) {
      return openTagsOf(r.body).some(function (t) { return t.tag === 'script' && isPayloadId(idAttrOf(t.text)); });
    }).map(function (r) { return { at: r.start, closed: r.closed, text: r.body.slice(0, 60) }; });
  }
  /* 未闭合注释（有注释开符、没有 `-->`）：浏览器会把后面全部当注释，载荷块会被吞掉 → 内嵌侧拒绝 */
  function unclosedComments(src) {
    return commentRegions(src).filter(function (r) { return !r.closed; });
  }
  /*
   * 把载荷序列化成**一个** payload script 块（三条硬要求）：
   *   ① 内容里的 `<` 一律转义成 `\u003c` → 题面里写 `</script>` 也截不断文件（以转义形式原样存活）；
   *   ② 行分隔符 U+2028/U+2029 也要转义（它们在 JS 里是换行，会让 JSON 字符串炸掉）；
   *   ③ 只有一对 script 标签、id 固定（"已有旧块就替换"由 `embedPayload` 负责）。
   */
  function payloadBlock(payload) {
    const json = JSON.stringify(payload)
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
    return '<script id="' + PAYLOAD_ID + '" type="application/json">' + json + '<\/script>';
  }
  /*
   * 内嵌载荷块。**踩过的坑都在这里，别再回退**：
   *   ① 用 `String.replace(needle, tag)` 直接插 tag 是错的：tag 里的 `$&`/`` $` ``/`$'`/`$$`
   *      会被当成**替换模式**展开 —— 于是题干里的 `$$x^2$$` 变成 `$x^2$`、`$&` 变成 `</body>`，
   *      极端情况下 `` $` ``（替换前文）把模板原文塞进载荷、提前闭合 `</script>`。→ 一律**函数式替换**。
   *   ② 已有块识别不能依赖属性顺序/引号/空白/大小写（`<script type=… id=…>`、`ID = "…"` 都合法）。
   *   ③ **清不掉的写法一律 fail-closed 拒绝**：自闭合块、未闭合块、注释内的载荷痕迹、未闭合注释开符、
   *      到文件尾都没有 `>` 的半截开标签（见下面四道检查）。
   *   ④ 同 id 的**非 script 元素**只摘掉 id 属性本身（含引号），不能把标签拼坏（曾拼出 `<div">`）。
   *   ⑤ 插入点取**最后一个** `</body>`（模板 JS 里出现 `"</body>"` 时不能插进脚本字符串）。
   *   ⑥ 出厂闸门：缺 secrets → 报 `E_NEED_SECRETS`；载荷不干净 → 拒绝内嵌（除非显式 allowUnsafe）。
   */
  function embedPayload(html, payload, opts) {
    const o = opts || {};
    const src = String(html == null ? '' : html);
    if (o.allowUnsafe !== true && o.secrets === undefined) {
      const e = new Error('embedPayload 缺少 secrets 参数：无法做"来源机密比对"。请用 buildSharePackage(state)，'
        + '或显式传 {secrets:[...]}（确认没有可比机密就传 []），确实要跳过请传 {allowUnsafe:true}');
      e.code = 'E_NEED_SECRETS';
      throw e;
    }
    if (o.allowUnsafe !== true) {
      const sc = shareScan(payload, { secrets: o.secrets || [] });
      if (!sc.ok) {
        const e = new Error('分享载荷没通过敏感扫描（' + sc.hits.length + ' 处命中），已拒绝内嵌：'
          + sc.hits.slice(0, 3).map(function (h) { return h.path + ' → ' + h.why; }).join('；'));
        e.hits = sc.hits;
        throw e;
      }
    }
    const tag = payloadBlock(payload);

    /* ---- 清理与自检：一律**解码 id 后**判定，不猜拼写 ---- */
    const unsafe = function (msg, code) { const e = new Error(msg); e.code = code || 'E_UNSAFE_PAYLOAD_BLOCK'; return e; };

    /* ⓪ 注释异常：两种都 fail-closed（注释里的开标签会和注释外的收尾标签配错对）
     *   · 注释里有"像载荷块"的东西 → 清不掉也不该乱清（否则会把注释外的 script 一起吃掉）
     *   · 未闭合的注释开符 → 浏览器把后面全当注释，载荷会被吞掉、边界不可信 */
    const unclosed = unclosedComments(src);
    if (unclosed.length) {
      throw unsafe('输入里有 ' + unclosed.length + ' 处未闭合的注释（`' + COMMENT_OPEN + '` 之后找不到 `-->`）：'
        + '浏览器会把从那里到文件尾全部当注释，载荷块会被吞掉，已拒绝内嵌；请先补上 `-->`');
    }
    const inComment = payloadLikeInComments(src);
    if (inComment.length) {
      throw unsafe('输入里有 ' + inComment.length + ' 处注释内的载荷块痕迹（例如 `' + COMMENT_OPEN + ' <script id="' + PAYLOAD_ID + '"> -->`）：'
        + '注释里的开标签会和注释外的收尾标签配错对，已拒绝内嵌；请先手工删掉那段注释');
    }

    /* ⓪-B 未闭合的 script 开标签（找不到 `>` 就一路到文件尾）：只要它像我们的块就拒绝。
     * 为什么单独查：`openTagsOf` 要求标签以 `>` 收尾，所以"断在半截"的标签**进不了定位器** ——
     * 既清不掉、又过不了残留自检，又是同一类"清不掉却没拒绝"的口子。 */
    unterminatedScriptTags(src).forEach(function (t) {
      const chunk = decodeCharRefs(t.text);
      if (isPayloadId(idAttrOf(t.text)) || chunk.toLowerCase().indexOf(PAYLOAD_ID) >= 0) {
        throw unsafe('输入里有一段没有收尾 `>` 的 script 开标签，且里面出现了 ' + PAYLOAD_ID + '：'
          + '它的边界无法确定、也清不干净，已拒绝内嵌；请先手工修好或删掉那段标签');
      }
    });

    /* ① 自闭合的 payload 块：HTML 不支持自闭合 script，正文边界不确定 → 拒绝 */
    const firstBlocks = findPayloadBlocks(src);
    firstBlocks.forEach(function (b) {
      if (b.selfClosing) {
        throw unsafe('输入里有自闭合的载荷块（<script id="' + PAYLOAD_ID + '" … />）：HTML 不支持自闭合 script，'
          + '我无法确定它的内容到哪里结束，已拒绝内嵌以免把旧内容留在文件里；请先手工删掉那个块', 'E_SELF_CLOSING_BLOCK');
      }
      if (!b.complete) {
        throw unsafe('输入里有一个 id 为 ' + PAYLOAD_ID + ' 的 script 开标签没有收尾标签，'
          + '已拒绝内嵌（清不干净就可能把旧内容留在文件里）');
      }
    });

    /* ② 逐个删掉完整的旧块（连收尾标签一起，并吞掉紧跟的一个换行以保持逐字节幂等） */
    let src2 = src;
    for (let guard = 0; guard < 64; guard++) {
      const hit = findPayloadBlocks(src2)[0];
      if (!hit) break;
      let cutEnd = hit.end;
      if (src2.charAt(cutEnd) === '\n') cutEnd++;                 // 吞换行 → 幂等
      src2 = src2.slice(0, hit.start) + src2.slice(cutEnd);
    }
    /* ③ 同 id 的**非 script 元素**：只摘掉 id 属性（含引号），保留标签其余部分与内容 */
    for (let guard = 0; guard < 64; guard++) {
      const t = openTagsOf(maskComments(src2)).filter(function (x) { return x.tag !== 'script' && isPayloadId(idAttrOf(x.text)); })[0];
      if (!t) break;
      const stripped = t.text.replace(new RegExp('\\s+id\\s*=\\s*(["\']?)\\s*' + PAYLOAD_ID + '\\s*\\1', 'i'), '');
      src2 = src2.slice(0, t.at) + stripped + src2.slice(t.end);
    }
    /* ④ 残留自检：清完一个都不能剩（含"解码后才露馅"的写法） */
    const left = findPayloadBlocks(src2);
    if (left.length) {
      throw unsafe('清理后仍残留 ' + left.length + ' 个 id 为 ' + PAYLOAD_ID + ' 的 script 开标签，已拒绝内嵌'
        + '（请先手工删掉那个块）');
    }

    const at = src2.lastIndexOf('</body>');
    if (at >= 0) return src2.slice(0, at) + tag + '\n' + src2.slice(at);
    return src2 + tag;
  }
  /* 载荷体积上限（**防"巨大分享文件"把接收者卡死**）：分享文件是别人递过来的，
   * 里面可以塞一段几百 MB 的 JSON —— 不设限的话，收件人一打开就是"页面卡住不动"。
   * 32 MB 对真实卷子足够（纯文字题面 1 MB 已是超大），超了就当"读不出来"如实报原因。 */
  const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

  /* 读回载荷。与清理/计数**共用同一个定位器**（findPayloadBlocks） */
  function extractPayloadDetailed(html) {
    const src = String(html == null ? '' : html);
    const b = findPayloadBlocks(src).filter(function (x) { return x.complete; })[0];
    if (!b) return { ok: false, reason: 'no-payload', message: '这个文件里没有分享载荷块' };
    const body = src.slice(b.endOpen, b.closeStart);
    if (body.length > MAX_PAYLOAD_BYTES) {
      return { ok: false, reason: 'too-large',
               message: '载荷有 ' + Math.round(body.length / 1024 / 1024) + ' MB，超过 '
                 + Math.round(MAX_PAYLOAD_BYTES / 1024 / 1024) + ' MB 上限（这么大的试卷不正常，已拒绝载入）' };
    }
    try { return { ok: true, payload: JSON.parse(body), raw: body }; }
    catch (e) { return { ok: false, reason: 'bad-json', message: '载荷块里的 JSON 读不了：' + ((e && e.message) || e) }; }
  }
  function extractPayload(html) {
    const r = extractPayloadDetailed(html);
    return r.ok ? r.payload : null;
  }

  /* 统计一个文件里 payload 块的 script 标签对数（结构完整性用；应为 1）
   * 用**解码后**的 id 判定（与清理/读回同一个定位器），所以 `id="&#101;xam-payload"` 也数得出来。 */
  function payloadBlockCount(html) {
    const src = String(html == null ? '' : html);
    const blocks = findPayloadBlocks(src);
    const closes = (src.match(/<\/script\s*>/gi) || []).length;
    return { blocks: blocks.length, scriptCloses: closes,
             complete: blocks.filter(function (b) { return b.complete; }).length,
             rawScriptOpens: (src.match(/<script\b/gi) || []).length };
  }
  /* 载荷块内部是否残留裸 `</script`（转义失效的话会 > 0，文件就会被截断） */
  function rawCloseInPayload(html) {
    const src = String(html == null ? '' : html);
    const b = findPayloadBlocks(src).filter(function (x) { return x.complete; })[0];
    if (!b) return 0;
    return (src.slice(b.endOpen, b.closeStart).match(/<\/script/gi) || []).length;
  }

  /*
   * 「脱敏打包」的**唯一出厂入口**：生成载荷 → 立刻体检 → 只有零命中才交出去。
   * 为什么不把"扫一遍"留给调用方自觉：实测过一个来回就忘了（红队指出
   * `shareScan` 全仓零调用点）。这里把两步焊在一起，调用方拿到 `ok:false` 就**不许写文件**。
   * 注意：题干里真粘了密钥这种"内容级冲突"**不会**被静默改写 —— 只如实报出路径与原因，
   * 由人决定是先清理还是放弃导出（静默删改用户题面比拒绝导出更坏）。
   */
  function buildSharePackage(state, opts) {
    const o = opts || {};
    const payload = sanitizeSharePayload(state, o);
    const scan = shareScan(payload, { secrets: o.secrets || secretsOfState(state),
                                      minSecretLength: o.minSecretLength });
    return {
      ok: scan.ok, payload: payload, scan: scan,
      message: scan.ok
        ? ('分享包已生成：' + scan.checked.exams + ' 套卷 / ' + scan.checked.questions + ' 题，敏感扫描零命中')
        : ('分享包没通过敏感扫描（' + scan.hits.length + ' 处），不要发出去：'
           + scan.hits.slice(0, 3).map(function (h) { return h.path + ' → ' + h.why; }).join('；'))
    };
  }

  /*
   * **唯一出厂入口**：生成 + 体检 + 内嵌，一条路走完。
   * 为什么要有它：红队第二轮证实了"只提供零件"的后果 —— 契约里登记的两参流水线会跳过
   * 来源机密比对，而 `shareScan` 在生产代码里根本没有调用点。把三步焊在一起，
   * 调用方只需要给 `state` 与目标 HTML，`secrets` 与闸门口径都从 state 现算，没得忘。
   */
  function buildShareHtml(state, html, opts) {
    const o = opts || {};
    const pkg = buildSharePackage(state, o);
    if (!pkg.ok) return Object.assign({ ok: false, html: null }, pkg);
    const out = embedPayload(html, pkg.payload, { secrets: o.secrets || secretsOfState(state),
                                                  minSecretLength: o.minSecretLength });
    return { ok: true, html: out, payload: pkg.payload, scan: pkg.scan, message: pkg.message };
  }

  /* ---------------- 导出成"能直接发给别人的单文件" ---------------- */

  /* 文件名安全化：控制字符与 Windows 禁用字符全部换掉，收掉首尾的点/空格。
   * ⚠ Windows 还禁"保留名"（CON/PRN/AUX/NUL/COM1…），这里不特判 —— 因为文件名**必定**带
   *   时间戳与卷 id 后缀，`CON-20261102-1530-x1` 这种基名已经不是保留名了。 */
  function sanitizeFileName(s, max) {
    const cap = max || 40;
    let t = String(s == null ? '' : s)
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')      // 控制字符（含换行/制表）
      .replace(/[\\/:*?"<>|]+/g, '_')               // Windows 禁用字符
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.\s]+/, '')
      .replace(/[.\s]+$/, '');                      // 首尾的点/空格：Windows 会静默吞掉，留着只会让名字对不上
    if (t.length > cap) t = t.slice(0, cap).replace(/[.\s]+$/, '');
    return t;
  }
  /*
   * 导出文件名：**含试卷标题**（人一眼能认）+ 时间戳 + 卷 id 尾巴。
   * 为什么三段都要：标题满足"可辨识"；时间戳让同一份卷子反复导出也不互相覆盖；
   * 卷 id 尾巴让**同一分钟导出的不同卷子**也不撞名（验收标准③"多份互不覆盖"）。
   */
  function shareFileName(exam, at) {
    /* 也接受**一组卷**（多选打包）：那时用"答题分享-N套-时间戳"，不再堆一串标题（会超长、也认不出）。
     * 单卷的老口径一个字没变（既有测试逐字钉着它）。 */
    const many = Array.isArray(exam) ? exam : null;
    const e = many ? (many[0] || {}) : (exam || {});
    let d = at ? new Date(at) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    const pad = function (n) { return (n < 10 ? '0' : '') + n; };
    const ts = String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate())
             + '-' + pad(d.getHours()) + pad(d.getMinutes());
    if (many && many.length > 1) return '答题分享-' + many.length + '套-' + ts + '.html';
    const title = sanitizeFileName(e.title, 40) || '未命名试卷';
    const idTail = sanitizeFileName(e.id, 12);
    return title + '-' + ts + (idTail ? '-' + idTail : '') + '.html';
  }
  /*
   * 把 `<script>`/`<style>` 的**正文**换成等长空格（保留换行），只留标签本身。
   * 为什么必须这么做：本文件会被**内联**进成品的 script 里，于是源码里那些**字符串字面量**
   * （例如 `'<script src="' + x`）在"整篇文本"看来就像真的标签 —— 拿整篇文本判"有没有外部引用"，
   * 会被自己的源码片段骗到（实测：成品被判出 1 个 `<script src>` + 2 个 `<link>`，全是自己写的字符串）。
   * 真浏览器不会把这些当成元素（script 是 raw text），所以判标签必须在**剥掉正文**的文本上做。
   */
  function maskRawBodies(src) {
    return String(src == null ? '' : src).replace(
      /(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi,
      function (m, open, tag, body, close) {
        return open + body.replace(/[^\n]/g, ' ') + close;      // 等长替换 → 下标仍然对得上
      });
  }
  /*
   * 外部资源引用体检：**只看标签属性**（任何标签的 `src`、`<link>` 的 `href`、`<style>` 里的 `@import`）。
   * 为什么不能直接搜 `http://`：页面正文里的 AI 端点（`https://dashscope…`）是**数据**，不是外部引用，
   * 一并算作违规会天天误报。
   * 为什么必须查：导出是拿**运行时页面**当壳的，浏览器插件往 DOM 里注入一条 `<script src=…>` 就能
   * 把"零外部引用、断网可用"这条承诺破掉 → 出厂前自查，发现就拒绝并让人换干净窗口重导。
   */
  function externalRefsIn(html) {
    const s = String(html == null ? '' : html);
    const out = [];
    const attr = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/g;
    openTagsOf(maskComments(maskRawBodies(s))).forEach(function (t) {
      attr.lastIndex = 0;
      let m, src = null, href = null, cssUrl = null;
      while ((m = attr.exec(t.text)) !== null) {
        const name = m[1].toLowerCase();
        const val = m[2].replace(/^["']|["']$/g, '').trim();
        if (name === 'src') src = val;
        if (name === 'href' && t.tag === 'link') href = val;
        /* 行内 `style="background:url(http…)"` 也是外部资源（不是标签但一样会去网上取东西） */
        if (name === 'style' && /url\(\s*['"]?(https?:)?\/\//i.test(val)) cssUrl = val;
      }
      if (src) out.push({ why: '<' + t.tag + ' src="' + src.slice(0, 60) + '"', at: t.at });
      if (href) out.push({ why: '<link href="' + href.slice(0, 60) + '"', at: t.at });
      if (cssUrl) out.push({ why: '行内 style 里的 url(...)：' + cssUrl.slice(0, 60), at: t.at });
    });
    /* `@import` 只在 **style 正文**里有意义：这里刻意用**原文**（不是剥体后的文本）——
     * 剥体正是把 style 正文换成空格，拿它去查 `@import` 等于永远查不到（实测踩过）。 */
    (s.match(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi) || []).forEach(function (css) {
      if (/@import/i.test(css)) out.push({ why: 'CSS @import', at: s.indexOf(css) });
    });
    return out.slice(0, 8);
  }
  /*
   * 用 Blob + `a[download]` 直接把文件交给浏览器落盘。
   * ⚠ 依赖浏览器三件套（`Blob` / `URL.createObjectURL` / `a[download]`）；缺任何一件就**返回 ok:false 并说清原因**，
   *   不抛异常、不静默失败 —— 旧浏览器/受限环境下要能看出"是环境不行"，而不是"按钮没反应"。
   * ⚠ `revokeObjectURL` 放 finally：点击抛错也要回收，否则几 MB 的 Blob 会一直挂在内存里。
   * ⚠ 一律走注入的 `{document,url,Blob}`（默认取全局）—— 这样 Node 里能拿假环境把整条路跑一遍。
   */
  function downloadHtml(html, filename, env) {
    const e = env || {};
    /* ⚠ 注入语义：**键存在就以此为准**（`{url:null}` 表示"这个环境没有它"），键不存在才回落到全局。
     *   否则 Node 里有全局 URL/Blob，测试想模拟"老浏览器没有 createObjectURL"就永远模拟不出来。 */
    const doc = ('document' in e) ? e.document : (typeof document !== 'undefined' ? document : null);
    const url = ('url' in e) ? e.url : (typeof URL !== 'undefined' ? URL : null);
    const BlobCtor = ('Blob' in e) ? e.Blob : (typeof Blob !== 'undefined' ? Blob : null);
    const text = String(html == null ? '' : html);
    const name = sanitizeFileName(String(filename == null ? '' : filename).replace(/\.html$/i, ''), 120) + '.html';
    if (!doc || typeof doc.createElement !== 'function' || !doc.body) {
      return { ok: false, reason: 'no-dom', filename: name, message: '当前环境没有可用的 document，无法触发下载' };
    }
    if (!url || typeof url.createObjectURL !== 'function' || typeof url.revokeObjectURL !== 'function') {
      return { ok: false, reason: 'no-blob-url', filename: name,
               message: '这个浏览器不支持 URL.createObjectURL（旧版或受限环境），没法直接落盘；可以手动"另存为"页面' };
    }
    if (!BlobCtor) return { ok: false, reason: 'no-blob', filename: name, message: '这个浏览器不支持 Blob，没法直接落盘' };
    const blob = new BlobCtor([text], { type: 'text/html;charset=utf-8' });
    let href = null, err = null;
    try {
      href = url.createObjectURL(blob);
      const a = doc.createElement('a');
      a.href = href;
      a.download = name;                       // 关键：没有它浏览器只会"打开"而不是"落盘"
      a.rel = 'noopener';
      if (a.style) a.style.display = 'none';
      if (typeof doc.body.appendChild === 'function') doc.body.appendChild(a);
      a.click();
      if (a.parentNode && typeof a.parentNode.removeChild === 'function') a.parentNode.removeChild(a);
    } catch (ex) {
      err = ex;
    } finally {
      if (href) { try { url.revokeObjectURL(href); } catch (e2) { /* 回收失败不影响交付 */ } }
    }
    if (err) return { ok: false, reason: 'click-failed', filename: name,
                      message: '触发下载失败：' + ((err && err.message) || err) };
    return { ok: true, reason: 'ok', filename: name, bytes: utf8Bytes(text),
             message: '已交给浏览器下载：' + name };
  }
  /*
   * 「导出成独立 HTML」的**唯一入口**：载荷（脱敏 + 体检）→ 内嵌进"壳" → 命名 → 外部引用自查。
   * ⚠ **壳由调用方给**（页面在**挂载前**抓一次原始 HTML）：库不去抓 DOM —— 运行时页面带着一堆
   *   挂载残留，抓它等于把"上一次的作答界面"一起打包。
   * ⚠ 有外部引用就**拒绝交出**（`ok:false` + `refs`），而不是发一份"看起来能用、断网就瞎"的文件。
   */
  function exportStandalone(state, shellHtml, opts) {
    const o = opts || {};
    /* 与 sanitizeSharePayload 同一套选卷口径：examIds（多选打包）> examId > 全都要 */
    const ids = (Array.isArray(o.examIds) && o.examIds.length) ? o.examIds.map(String) : null;
    const picked = examsOfState(state).filter(function (e) {
      if (ids) return ids.indexOf(String(e.id)) >= 0;
      return !o.examId || e.id === o.examId;
    });
    const exam = picked[0] || null;
    const pkg = buildShareHtml(state, shellHtml, o);
    if (!pkg.ok) return Object.assign({ ok: false, html: null, filename: null, refs: [] }, pkg);
    const refs = externalRefsIn(pkg.html);
    if (refs.length) {
      return { ok: false, html: null, filename: null, payload: pkg.payload, scan: pkg.scan, refs: refs,
               message: '导出的页面里有 ' + refs.length + ' 处外部引用（例如 ' + refs[0].why + '）：'
                 + '断网打开就会缺东西，已拒绝交出；请在没有插件的窗口（或隐身窗口）重新打开本页再导出' };
    }
    return { ok: true, html: pkg.html,
             filename: shareFileName(picked.length > 1 ? picked : exam, o.at),
             payload: pkg.payload, exams: picked.map(function (e) { return { id: e.id, title: e.title }; }),
             scan: pkg.scan, refs: [], bytes: utf8Bytes(pkg.html), message: pkg.message };
  }

  return {
    utf8Bytes: utf8Bytes, jsonBytes: jsonBytes,
    createStore: createStore, capacityReport: capacityReport, synthQuestions: synthQuestions,
    storageHealth: storageHealth,
    findSecrets: findSecrets, sanitizeSharePayload: sanitizeSharePayload,
    shareScan: shareScan, secretsOfState: secretsOfState, buildSharePackage: buildSharePackage,
    buildShareHtml: buildShareHtml, examsOfState: examsOfState, isForbiddenKey: isForbiddenKey,
    exportStandalone: exportStandalone, downloadHtml: downloadHtml,
    shareFileName: shareFileName, sanitizeFileName: sanitizeFileName, externalRefsIn: externalRefsIn,
    keyTokens: keyTokens, FORBIDDEN_WORDS: FORBIDDEN_WORDS, STRIP_MAX_DEPTH: STRIP_MAX_DEPTH,
    SECRET_SHAPES: SECRET_SHAPES, secretShapesIn: secretShapesIn,
    SHARE_EXAM_FIELDS: SHARE_EXAM_FIELDS, SHARE_QUESTION_FIELDS: SHARE_QUESTION_FIELDS,
    FORBIDDEN_KEYS: FORBIDDEN_KEYS,
    embedPayload: embedPayload, extractPayload: extractPayload, extractPayloadDetailed: extractPayloadDetailed,
    MAX_PAYLOAD_BYTES: MAX_PAYLOAD_BYTES,
    payloadBlock: payloadBlock, payloadBlockCount: payloadBlockCount, rawCloseInPayload: rawCloseInPayload,
    PAYLOAD_ID: PAYLOAD_ID,
    // 命名空间与键前缀：唯一真相源（出题者与分享文件都调这里）
    NS_SEP: NS_SEP, NS_GLOBAL: NS_GLOBAL, NS_RECV_PREFIX: NS_RECV_PREFIX, INDEX_MARK: INDEX_MARK,    KEY_EXAM: KEY_EXAM, KEY_RECORD: KEY_RECORD, KEY_WRONG: KEY_WRONG,
    receiverNamespace: receiverNamespace, receiverNamespaceFor: receiverNamespaceFor, contentFingerprint: contentFingerprint,
    examBodyKey: examBodyKey, examSubPrefix: examSubPrefix, examSubKey: examSubKey,
    recordKey: recordKey, wrongKey: wrongKey, examScopeOf: examScopeOf,
    prefixedKey: prefixedKey, nsOf: nsOf, keyOf: keyOf,
    isInNamespace: isInNamespace, indexKeyOf: indexKeyOf,
    assertSafeNamespace: assertSafeNamespace
  };
});
