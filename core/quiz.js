/* ============================================================
 *  core/quiz.js —— 计分 + 抽题（纯函数，可在 Node 里穷举验证）
 *
 *  需求里的高风险点原话："计分逻辑分支多（多选半对、简答关键词打分），需要严格校验"
 *  所以这一层刻意做成：无副作用、不碰 DOM、所有分支可枚举。
 * ============================================================ */
(function (root, factory) {
  const isNode = (typeof module !== 'undefined' && module.exports);
  // 判断题"用户作答"与"答案键"必须用**同一套归一规则**，否则会出现
  // 「答案键=错、用户写"不正确"、判定却说认不出来 → 不给分」这种冤案。
  // 所以这里委托解析层的 SegmentCore（唯一实现），不再自带一份简化副本。
  const SegmentCore = isNode ? require('./parse/segment.js') : root.SegmentCore;
  if (!SegmentCore) throw new Error('QuizCore 依赖 SegmentCore（core/parse/segment.js），加载顺序错了');
  const api = factory(SegmentCore);
  if (isNode) module.exports = api;
  root.QuizCore = api;
})(typeof self !== 'undefined' ? self : this, function (SegmentCore) {
  'use strict';

  /* ---------------- 默认配置（全局默认；单卷可覆盖并可锁定） ---------------- */
  const DEFAULT_CONFIG = {
    // 各题型每题分值
    points: { '单选': 2, '多选': 3, '判断': 1, '简答': 5 },
    // 多选题：开启半对
    multi: {
      halfCredit: true,        // 是否给部分分
      /* 半对怎么给分（三种模式）：
       *   'fixedScore' 半对固定给 `halfScore` 分  ← **默认**（用户要求："多选规则应该半对给两分"）
       *   'fixed'      给满分的固定比例 `halfRatio`（不看命中几个）
       *   'hitRatio'   按命中比例给分，再乘 `halfRatio` 封顶（老默认） */
      halfMode: 'fixedScore',
      halfScore: 2,            // fixedScore 模式：半对（少选且没选错）固定给几分
      halfRatio: 0.5,          // 其余两种模式的封顶比例（标签见 CONFIG_FIELDS['multi.halfRatio']）
      wrongChoiceZero: true    // 只要有错选就 0 分
    },
    // 简答题
    short: {
      matchMode: 'contains',   // 'contains' 包含 | 'exact' 全等
      ignoreCase: true,
      scoreMode: 'hitRatio',   // 'hitRatio' 命中率×满分 | 'range' 映射到 [min,max]
      minRatio: 0.0,
      maxRatio: 1.0,
      synonyms: {}             // { 关键词: [同义写法...] }  —— 需求里归到 AI，但本地也留一个小表
    },
    // 抽题
    pick: {
      /* 'all' 全部作答（不抽题，整套卷都做）
       * | 'byCount' 按逐题型数量 | 'byWeight' 按逐题型目标分 | 'random' 完全随机
       * 默认 = **'random' 完全随机**（用户要求："给抽题改成随机的"）——
       * 停止口径用 `randomBasis`（默认 'count' = 抽够 `count` 题为止，默认 20 题）。
       * 想整套卷都做、或按题型分配，在「答卷前设置页」里改 `mode` 即可。 */
      mode: 'random',
      count: 20,               // 本轮题量（byCount 之外的 random 也用）
      /* 抽哪一批（用户要求："抽题可以选择随机或者未做答优先"）：
       *   'random'          完全随机（默认）
       *   'unansweredFirst' 未作答优先：**先抽"还欠着账"的题**（错题本里还没答对的，含上一轮没作答的），
       *                     再抽没进过本子的；同一档内再随机。
       *   实现见 pickQuestions 的 opts.priority（调用方从错题本算出每个 qid 的档位）。 */
      prefer: 'random',
      byType: { '单选': 10, '多选': 2, '判断': 4, '简答': 2 },  // byCount 用：逐题型数量
      /* byWeight 用：逐题型**目标分**。
       * ⚠ **全 0 = "用户没分配过"** → 落回"按 pick.targetScore 自动配比"（老行为）：
       *   旧快照里没有这个字段，落回内置默认（全 0），于是老卷的行为一点不变；
       *   一旦有任何一型 > 0，就改成"逐题型各自凑到自己的目标分"，此时 targetScore 不再参与。 */
      byTypeScore: { '单选': 0, '多选': 0, '判断': 0, '简答': 0 },
      targetScore: 100,        // 逐题型目标分全 0 时的"总目标分自动配比"；random + randomBasis='score' 也用它
      randomBasis: 'count',    // random 的停止口径：'count' 按题量 | 'score' 按目标总分
      seed: 1                  // 可复现（⚠ 0 是合法种子）
    },
    // 分数线
    grade: { pass: 60, excellent: 85 },
    // 展示时机
    // 展示时机（答完一题 / 整卷后）—— 二选一，不是"开/关"：
    // 旧的两个布尔 answerAfterEach / explainAfterEach 只能显示成"开/关"，
    // 用户看不出"开"到底意味着什么时候给答案。
    // ⚠ 默认改成 **'each'（答完一题即显示）**（用户要求）：刷题就是为了当场知道对错；
    //   想"整卷后才看答案"的（模拟考试）自己在面板/设置里改回 'end' 即可。
    reveal: { answerTiming: 'each', explainTiming: 'each' },
    // 答题行为
    //   autoCheck / autoNext：**默认都开着**（用户要求"快捷设置默认全部开启"）——
    //     答完一题自动判分 + 答完自动翻页；只想自己掌控就面板上关掉。
    //   autoNextMs：自动翻页的**等待时间**（毫秒）。默认 1500（1.5 秒，用户指定）。
    //     留出等待是为了"看一眼 ✓/对错再走"——它**不影响要不要翻**（那是 autoNext 的事），
    //     所以自动判分关着时它照样有效（跳 ≠ 判）。
    //   ⚠ 等待时间只对单选/判断这类"点一下就答完"的题型有意义；多选与简答永远不自动翻。
    //   autoNextWrong：**答错的题要不要也自动翻**（用户要求"错题是否自动翻页"给个开关）。
    //     默认 **false** = 保持既有行为：没得全分（答错 / 多选半对 / 简答没答全）就停在这一题看正确答案。
    //     开了它 → 连错题也照翻（答案与解析还能在交卷页 / 右栏回看）。
    //   timer：**答题计时**（用户要求）。开了就在答题界面挂一颗**悬浮球**（position:fixed，不占排版位置）
    //     显示用时，点一下暂停/继续；用时随进度一起存本机（刷新 / 「继续这一轮」不会归零）。
    //     默认 **false**（多数人只想安静刷题，不想被秒表盯着）。
    behavior: { autoCheck: true, autoNext: true, autoNextMs: 1500, autoNextWrong: false, timer: false }
  };

  /* ---------------- 深拷贝与合并（三层取值的基石） ----------------
   * 为什么要自己写而不用 Object.assign / slice：
   *   它们是**浅**拷贝。三层取值里"某一层没写的项"直接沿用上一层的嵌套对象，
   *   于是调用方一改返回值的嵌套字段，就会**反向污染内置默认或全局设置** ——
   *   实测过：`resolveConfig(null,null).points['单选']=999` 会把 DEFAULT_CONFIG 改成 999，
   *   之后所有试卷的默认分值都跟着错，且极难排查。
   *   所以合并结果必须是**完全独立**的深拷贝。
   */
  /* ================= 配置字段模型（唯一真相源） =================
   * 每一项 = 一个可配置的叶子：中文标签 / 分组 / 类型 / 取值范围 / 单位。
   * **校验（validateConfig）与设置预览（configPreview）都只读这一张表** ——
   * 以后加一个配置项只需在这里加一行，两处自动跟上，不会两处规则打架。
   */
  const TYPE_KEYS = ['单选', '多选', '判断', '简答'];
  /* 单题分值的上界：**一个常量两处用**（字段模型的 max + 计分侧的兜底上界），
   * 免得"配置层说合法、计分层却静默替换"（红队实测过：2e6 配置层合法、计分层落回默认）。 */
  const POINTS_MAX = 1000;
  /* 最小正分值：分值必须落在 0.5 的整数倍上，所以比 0.5 小的正值无法表达
   * （5e-324 这种"配置层合法、计分后变 0"会让该题从整卷分母里消失）。 */
  const POINTS_MIN_POS = 0.5;
  /* 自动翻页等待时间的上界（毫秒）：**配置字段模型与 flow 的唯一真相源共用这一个常量**。
   * 5 秒已经远超"看一眼 ✓ 再走"的合理范围；再大就是"忘了关自动翻页"的表现了。 */
  const AUTO_NEXT_MS_MAX = 5000;

  const CFG = {
    NOT_NUMBER: 'E_CFG_NOT_NUMBER', NEGATIVE: 'E_CFG_NEGATIVE', OUT_OF_RANGE: 'E_CFG_OUT_OF_RANGE',
    NOT_BOOLEAN: 'E_CFG_NOT_BOOLEAN', BAD_ENUM: 'E_CFG_BAD_ENUM', NOT_INTEGER: 'E_CFG_NOT_INTEGER',
    RANGE_INVERTED: 'E_CFG_RANGE_INVERTED', BAD_SYNONYMS: 'E_CFG_BAD_SYNONYMS', NOT_OBJECT: 'E_CFG_NOT_OBJECT',
    NOT_HALF_STEP: 'E_CFG_NOT_HALF_STEP',
    W_ZERO_POINTS: 'W_CFG_ZERO_POINTS', W_UNKNOWN_KEY: 'W_CFG_UNKNOWN_KEY',
    W_FIELD_MODEL_GAP: 'W_CFG_FIELD_MODEL_GAP'
  };

  const CONFIG_FIELDS = (function () {
    const F = [];
    const add = function (path, label, group, kind, extra) {
      F.push(Object.assign({ path: path, label: label, group: group, kind: kind }, extra || {}));
    };
    // 分值必须落在 0.5 的整数倍上：否则总分与单题分会出现 2.25 这种"脏分"，
    // 而计分侧承诺"所有得分都是 0.5 的整数倍"（见 scoreOne）。
    TYPE_KEYS.forEach(function (t) {
      add('points.' + t, t + '题每题分值', '题型分值', 'number',
          { min: 0, max: POINTS_MAX, unit: '分', multiple: 0.5 });
    });
    add('multi.halfCredit', '多选题给部分分（半对）', '多选题', 'boolean');
    add('multi.halfMode', '半对模式', '多选题', 'enum',
        { values: ['fixedScore', 'fixed', 'hitRatio'],
          valueLabels: { fixedScore: '半对固定给分', fixed: '固定比例', hitRatio: '按命中比例' } });
    /* 用户要求：**多选的全对得分与半对得分都能自己调**（设置页「判分」两组加减控件）。
     * 全对得分就是 `points.多选`（每题分值），半对得分是 `multi.halfScore`（fixedScore 模式下生效）。
     * 约束（flow 层自己兜）：半对 ≤ 全对，且四舍五入到 0.5 的整数倍。 */
    add('multi.halfScore', '半对固定给分', '多选题', 'number', { min: 0, max: POINTS_MAX, unit: '分', multiple: 0.5 });
    add('multi.halfRatio', '半对封顶比例', '多选题', 'number', { min: 0, max: 1, unit: '比例' });
    add('multi.wrongChoiceZero', '选错即 0 分', '多选题', 'boolean');
    add('short.matchMode', '简答匹配方式', '简答题', 'enum',
        { values: ['contains', 'exact'], valueLabels: { contains: '包含即命中', exact: '必须全等' } });
    add('short.ignoreCase', '简答忽略大小写', '简答题', 'boolean');
    add('short.scoreMode', '简答评分模式', '简答题', 'enum',
        { values: ['hitRatio', 'range'], valueLabels: { hitRatio: '按命中率', range: '映射到分数区间' } });
    add('short.minRatio', '分数区间下限', '简答题', 'number', { min: 0, max: 1, unit: '比例' });
    add('short.maxRatio', '分数区间上限', '简答题', 'number', { min: 0, max: 1, unit: '比例' });
    add('short.synonyms', '关键词同义写法', '简答题', 'synonyms');
    add('pick.mode', '抽题模式', '抽题', 'enum',
        { values: ['all', 'byCount', 'byWeight', 'random'], valueLabels: { all: '全部作答', byCount: '按题型数量', byWeight: '按题型总分', random: '完全随机' } });
    add('pick.count', '本轮抽题数', '抽题', 'number', { min: 0, int: true, unit: '题' });
    TYPE_KEYS.forEach(function (t) {
      add('pick.byType.' + t, t + '题抽题数', '抽题', 'number', { min: 0, int: true, unit: '题' });
    });
    /* 逐题型**目标分**（byWeight 用）。全 0 = 没分配过 → 仍按 pick.targetScore 自动配比（兼容旧快照）。 */
    TYPE_KEYS.forEach(function (t) {
      add('pick.byTypeScore.' + t, t + '题目标分', '抽题', 'number', { min: 0, unit: '分' });
    });
    add('pick.targetScore', '目标总分', '抽题', 'number', { min: 0, unit: '分' });
    add('pick.randomBasis', '随机抽题的停止口径', '抽题', 'enum',
        { values: ['count', 'score'], valueLabels: { count: '按题量', score: '按目标总分' } });
    add('pick.seed', '随机种子', '抽题', 'number', { int: true });
    /* 抽取偏好：完全是随机，还是"先抽没答对的/没做过的"。
     * 它跟 pick.mode 正交 —— byCount / byWeight / random 三种规则都能配它。 */
    add('pick.prefer', '抽取偏好', '抽题', 'enum',
        { values: ['random', 'unansweredFirst'], valueLabels: { random: '完全随机', unansweredFirst: '未作答优先' } });
    /* 用户要求：分数线改成**分数比例**（占卷面满分的百分比）。
     * 取值口径不变（0-100 的百分数，`levelOf` 就是拿 percent 比它），改的是**说法**：
     * 面板/成绩单上都写成「及格 60%」并给出等效分数，免得被读成"及格 60 分"。 */
    add('grade.pass', '及格比例', '分数线', 'number', { min: 0, max: 100, unit: '%' });
    add('grade.excellent', '优秀比例', '分数线', 'number', { min: 0, max: 100, unit: '%' });
    add('reveal.answerTiming', '答案展示时机', '展示', 'enum',
        { values: ['each', 'end'], valueLabels: { each: '答完一题即显示', end: '整卷结束后显示' } });
    add('reveal.explainTiming', '解析展示时机', '展示', 'enum',
        { values: ['each', 'end'], valueLabels: { each: '答完一题即显示', end: '整卷结束后显示' } });
    add('behavior.autoCheck', '自动判分', '行为', 'boolean');
    add('behavior.autoNext', '自动下一题', '行为', 'boolean');
    /* ⚠ 先前的标签写的是"判分后自动翻页"、注释还写着"要手点提交本题才翻" —— 都是上一轮
     *   "跳 ≠ 判"改完之后**没跟着改**的陈旧文案（用户看到的就是这行字），已一并更正。
     * 「答错的题也自动翻页」：默认**关**（= 没得全分就停在这一题看正确答案，用户要求过）。
     * 它只在 autoNext 开着时有意义（界面那一行会置灰）。 */
    add('behavior.autoNextWrong', '答错的题也自动翻页', '行为', 'boolean');
    /* 答题计时（用户要求）：开关本身在 flow/面板上，这里只是字段模型（类型 + 校验门）。 */
    add('behavior.timer', '答题计时', '行为', 'boolean');
    /* 自动翻页的等待时间（毫秒）。上界与 flow.js 的 AUTO_NEXT_MS_MAX 是**同一个数**：
     * 配置层说合法、界面层却按更小的上界截断，就是"两处规则打架"（红队踩过这类）。 */
    add('behavior.autoNextMs', '自动翻页等待', '行为', 'number',
        { min: 0, max: AUTO_NEXT_MS_MAX, int: true, unit: '毫秒' });
    return F;
  })();
  const CONFIG_FIELD_MAP = (function () {
    const m = {};
    CONFIG_FIELDS.forEach(function (f) { m[f.path] = f; });
    return m;
  })();
  // "下限不能大于上限"的字段对（跨字段校验，单看一个字段查不出来）
  const RANGE_PAIRS = [
    ['short.minRatio', 'short.maxRatio', '简答分数区间'],
    ['grade.pass', 'grade.excellent', '分数线']
  ];
  const SOURCE_LABELS = { builtin: '内置默认', global: '全局设置', exam: '本卷（快照/单卷设置）' };

  function getPath(obj, path) {
    return String(path).split('.').reduce(function (a, k) { return (a == null) ? undefined : a[k]; }, obj);
  }

  /* 枚举一份配置里"有哪些叶子路径"（与 CONFIG_FIELDS 同口径：数组/空对象算叶子） */
  function pathsOf(v, base, out) {
    out = out || []; base = base || '';
    if (Array.isArray(v) || !isPlainObject(v)) { out.push(base); return out; }
    const ks = Object.keys(v);
    if (!ks.length) { out.push(base); return out; }
    ks.forEach(function (k) { pathsOf(v[k], base ? base + '.' + k : k, out); });
    return out;
  }

  /*
   * 字段模型自检：内置默认里有没有"没登记进 CONFIG_FIELDS"的叶子，或反之。
   *
   * 为什么必须有：漏登记**不会报任何错**，只会让那一项
   *   · 静默逃过 validateConfig（非法值照收）
   *   · 静默从 configPreview 里消失（设置界面看不到它）
   * 这类"什么都不报"的缺口最危险 —— 所以既在 validateConfig 里发警告，
   * 也在 verify/scoring.test.js 里断言它为 0（CI 直接红）。
   */
  function fieldModelGaps() {
    const dl = pathsOf(DEFAULT_CONFIG).sort();
    const fl = CONFIG_FIELDS.map(function (f) { return f.path; }).sort();
    return {
      unregistered: dl.filter(function (p) { return fl.indexOf(p) < 0; }),
      orphanFields: fl.filter(function (p) { return dl.indexOf(p) < 0; })
    };
  }

  /*
   * 校验一份配置。
   *   · 只校验 CONFIG_FIELDS 里的字段；字段**没写**就跳过（由下层兜底，不报错）
   *   · 传进来的通常是**合并后的生效配置** —— 因为"上下限颠倒"这类问题
   *     单看一个补丁是查不出来的（下限来自全局、上限来自单卷时才会颠倒）
   *   · 未知键只给 warning：别把别人扩展的键当错误（向前兼容）
   * 返回 { ok, errors:[{path,label,code,message,hint}], warnings:[...] }
   */
  function validateConfig(cfg, opts) {
    const o = opts || {};
    const errors = [], warnings = [];
    const where = o.layer ? '（' + o.layer + '）' : '';
    if (!isPlainObject(cfg)) {
      return { ok: false, warnings: [], errors: [{ path: '', label: '配置', code: CFG.NOT_OBJECT,
               message: '配置必须是对象' + where, hint: '例如 { points: { 单选: 2 } }' }] };
    }

    CONFIG_FIELDS.forEach(function (f) {
      const v = getPath(cfg, f.path);
      if (v === undefined) return;                       // 没写 → 不校验
      const bad = function (code, message, hint) {
        errors.push({ path: f.path, label: f.label, code: code, message: message, hint: hint || '' });
      };
      // 精确到子键的错误：同义词表这类"字段内部还有一层"的，必须指出是哪一条。
      // 早期这里复用了 bad()，错误路径永远是父字段 short.synonyms，
      // 而补丁写的是 short.synonyms.SYN —— 责任过滤对不上，非法值会被**静默写入**。
      const badAt = function (p, code, message, hint) {
        errors.push({ path: p, label: f.label, code: code, message: message, hint: hint || '' });
      };

      if (f.kind === 'boolean') {
        if (typeof v !== 'boolean') bad(CFG.NOT_BOOLEAN, f.label + ' 必须是 true/false，收到 ' + JSON.stringify(v), '开关只接受 true 或 false');
        return;
      }
      if (f.kind === 'enum') {
        if (f.values.indexOf(v) < 0) {
          bad(CFG.BAD_ENUM, f.label + ' 只能是 ' + f.values.join(' / ') + '，收到 ' + JSON.stringify(v),
              '可选：' + f.values.map(function (x) { return x + '（' + ((f.valueLabels && f.valueLabels[x]) || '') + '）'; }).join('、'));
        }
        return;
      }
      if (f.kind === 'synonyms') {
        if (!isPlainObject(v)) { bad(CFG.NOT_OBJECT, f.label + ' 必须是对象（关键词 → 同义写法数组）', '例如 {"SYN":["同步","SYN包"]}'); return; }
        Object.keys(v).forEach(function (k) {
          const arr = v[k];
          if (!Array.isArray(arr) || arr.some(function (x) { return typeof x !== 'string'; })) {
            badAt(f.path + '.' + k, CFG.BAD_SYNONYMS, f.label + '.' + k + ' 必须是字符串数组', '例如 {"SYN":["同步"]}');
          }
        });
        return;
      }
      // number
      if (typeof v !== 'number' || !isFinite(v)) {
        bad(CFG.NOT_NUMBER, f.label + ' 必须是数字，收到 ' + JSON.stringify(v), '请填数字（不要带引号）'); return;
      }
      if (f.min != null && v < f.min) {
        bad(v < 0 ? CFG.NEGATIVE : CFG.OUT_OF_RANGE,
            f.label + ' 不能小于 ' + f.min + '，收到 ' + v,
            v < 0 ? '分值/比例不能是负数' : ''); return;
      }
      if (f.max != null && v > f.max) {
        bad(CFG.OUT_OF_RANGE, f.label + ' 不能大于 ' + f.max + '，收到 ' + v,
            f.unit === '比例' ? '比例必须落在 0 ~ 1 之间' : '分数不能超过 100'); return;
      }
      if (f.int && !Number.isInteger(v)) {
        bad(CFG.NOT_INTEGER, f.label + ' 必须是整数，收到 ' + v, '题数/种子只能是整数'); return;
      }
      // 半步粒度（只有声明了 multiple 的字段才查）：分值填 2.25 会让总分出现脏分。
      // ⚠ 判据必须是"**精确**整除"：早先用 `Math.abs(k - Math.round(k)) > 1e-9` 容差，
      //   `5e-324 / 0.5 = 1e-323` 的偏差小于 1e-9 → 极小值被当成合法（配置层放行、计分后变 0 分）。
      if (f.multiple != null) {
        const k = v / f.multiple;
        if (!isFinite(k) || k !== Math.round(k)) {
          bad(CFG.NOT_HALF_STEP, f.label + ' 必须是 ' + f.multiple + ' 的整数倍，收到 ' + v,
              '分数只支持 ' + f.multiple + ' 的粒度（例如 2、2.5、3）'); return;
        }
      }
      if (f.path.indexOf('points.') === 0 && v === 0) {
        warnings.push({ path: f.path, label: f.label, code: CFG.W_ZERO_POINTS,
                        message: f.label + ' 为 0：该题型不参与计分', hint: '如果是有意的可以忽略' });
      }
    });

    // 跨字段：上下限颠倒
    RANGE_PAIRS.forEach(function (p) {
      const lo = getPath(cfg, p[0]), hi = getPath(cfg, p[1]);
      if (typeof lo === 'number' && typeof hi === 'number' && lo > hi) {
        errors.push({ path: p[1], label: p[2], code: CFG.RANGE_INVERTED,
                      message: p[2] + ' 上下限颠倒：' + p[0] + '=' + lo + ' 大于 ' + p[1] + '=' + hi,
                      hint: '下限不能大于上限' });
      }
    });

    // 字段模型自检：默认配置里有没登记的项 → 它会逃过校验与预览，必须让这件事变响
    const gaps = fieldModelGaps();
    if (gaps.unregistered.length || gaps.orphanFields.length) {
      warnings.push({ path: '', code: CFG.W_FIELD_MODEL_GAP,
                      message: '配置字段模型与内置默认不一致（有项没登记）',
                      hint: '未登记：' + gaps.unregistered.join('、') + '；多余登记：' + gaps.orphanFields.join('、') });
    }

    // 未知键：只警告，不拦
    (function walk(v, base) {
      if (!isPlainObject(v)) return;
      Object.keys(v).forEach(function (k) {
        const p = base ? base + '.' + k : k;
        if (p === 'short.synonyms') return;             // 同义词表里的键是用户数据，不是配置项
        if (isPlainObject(v[k])) { walk(v[k], p); return; }
        if (!CONFIG_FIELD_MAP[p]) {
          warnings.push({ path: p, code: CFG.W_UNKNOWN_KEY, message: '不认识的配置项：' + p, hint: '会被原样保留（向前兼容）' });
        }
      });
    })(cfg, '');

    return { ok: errors.length === 0, errors: errors, warnings: warnings };
  }

  /*
   * 打补丁：合并 → **校验合并后的生效结果** → 通过才返回新配置。
   * 为什么校验的是合并结果而不是补丁本身：
   *   补丁只写 maxRatio=0.2 时，单看它合法；但如果下限来自全局（0.8），合并后就颠倒了。
   *   只有校验合并结果才拦得住这种跨层组合出的非法值。
   * 不合格就**不返回 config** —— 让调用方拿不到可写入的非法配置。
   */
  function applyConfigPatch(base, patch, opts) {
    const merged = deepMerge(base || DEFAULT_CONFIG, patch || {});
    const v = validateConfig(merged, opts);
    if (!v.ok) return { ok: false, errors: v.errors, warnings: v.warnings, rejectedPatch: deepClone(patch || {}) };
    return { ok: true, config: merged, warnings: v.warnings };
  }

  /* 把一项的值渲染成人看得懂的文本（设置预览用） */
  function displayConfigValue(f, v) {
    if (v === undefined) return '（未设置）';
    if (f.kind === 'boolean') return v ? '开' : '关';
    if (f.kind === 'enum') return (f.valueLabels && f.valueLabels[v]) ? (f.valueLabels[v] + '（' + v + '）') : String(v);
    if (f.kind === 'synonyms') return isPlainObject(v) ? (Object.keys(v).length + ' 组同义写法') : String(v);
    return String(v) + (f.unit ? ' ' + f.unit : '');
  }

  /*
   * 设置预览：把"当前生效的分值项"整理成可直接渲染的行。
   * 这正是"答题开始前的设置预览弹窗"需要的数据 ——
   * 每行带：中文标签 / 生效值 / 显示文本 / 单位 / 可选值 / **来自哪一层**（内置默认 / 全局 / 本卷）。
   */
  function configPreview(globalCfg, exam) {
    const eff = resolveConfig(globalCfg, exam);
    const srcMap = configSources(globalCfg, exam);
    return CONFIG_FIELDS.map(function (f) {
      const v = getPath(eff, f.path);
      const src = srcMap[f.path] || LAYER_BUILTIN;
      return {
        path: f.path, label: f.label, group: f.group, kind: f.kind, unit: f.unit || '',
        value: (v === undefined ? null : v), display: displayConfigValue(f, v),
        values: f.values || null, valueLabels: f.valueLabels || null,
        source: src, sourceLabel: SOURCE_LABELS[src] || src,
        editable: true, locked: !!(exam && exam.configLocked && src === LAYER_EXAM)
      };
    });
  }

  // 区间对的互查表：任一侧被改，另一侧的错误也算"本次要负责的"
  const RANGE_MEMBER = (function () {
    const m = {};
    RANGE_PAIRS.forEach(function (p) {
      (m[p[0]] = m[p[0]] || []).push(p[1]);
      (m[p[1]] = m[p[1]] || []).push(p[0]);
    });
    return m;
  })();

  /*
   * 给**全局配置**打补丁。与 applyConfigPatch 的区别在"谁负责"：
   *   applyConfigPatch      —— 整份生效配置必须合法（适合"要写入一份完整配置"的场景）
   *   applyGlobalPatch      —— **补丁只为自己写到的字段负责**（含与它配对的区间字段）
   *
   * 为什么要分开：
   *   历史数据里可能已经躺着非法值（旧版本写进去的）。若要求整份合法，
   *   用户每改一个字段都会被"另一半还没修好"的非法值挡住 —— 永远改不完。
   *   所以本次没碰到的非法值只作为 `preexisting` 报出来（看得见，但不拦）。
   *
   * 返回 { ok:true, config, effective, warnings, preexisting }
   *    config     = **要存起来的全局配置**（只含用户改过的项，未来的默认值改动仍能生效）
   *    effective  = 内置默认 ⊕ config（真正用于判分的那份）
   */
  function applyGlobalPatch(currentGlobal, patch, opts) {
    const base = deepMerge(DEFAULT_CONFIG, currentGlobal || {});
    const merged = deepMerge(base, patch || {});
    const v = validateConfig(merged, opts || { layer: '全局设置' });
    const touched = {};
    pathsOf(patch || {}).forEach(function (p) { touched[p] = 1; });

    const blocking = [], preexisting = [];
    v.errors.forEach(function (e) {
      const pair = RANGE_MEMBER[e.path] || [];
      // "本次补丁要负责"的两种情形：
      //   ① 错误路径正好是补丁写过的某个叶子
      //   ② 补丁写在了错误路径**下面**（错误报在父字段上，如 short.synonyms、
      //      或将来某个"块级"规则）—— 否则这种错误会被误判成历史遗留而放行
      const under = Object.keys(touched).some(function (p) { return p.indexOf(e.path + '.') === 0; });
      const mine = !!touched[e.path] || under || pair.some(function (p) { return !!touched[p]; });
      (mine ? blocking : preexisting).push(e);
    });
    if (blocking.length) {
      return { ok: false, errors: blocking, preexisting: preexisting, warnings: v.warnings,
               rejectedPatch: deepClone(patch || {}) };
    }
    // 存的是"当前全局 ⊕ 补丁"（部分覆盖），不是整份生效配置
    return { ok: true, config: deepMerge(currentGlobal || {}, patch || {}),
             effective: merged, warnings: v.warnings, preexisting: preexisting };
  }

  /* 校验一份"即将写入的全局设置补丁"（供存储层调用） */
  function validateGlobalPatch(currentGlobal, patch, opts) {
    return applyConfigPatch(currentGlobal || DEFAULT_CONFIG, patch, opts || { layer: '全局设置' });
  }

  function isPlainObject(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }

  // 深拷贝：数组与普通对象逐层重建；其它类型（Date/RegExp/函数…）原样返回（配置里不会出现）
  function deepClone(v) {
    if (Array.isArray(v)) return v.map(deepClone);
    if (isPlainObject(v)) {
      const out = {};
      Object.keys(v).forEach(function (k) { out[k] = deepClone(v[k]); });
      return out;
    }
    return v;
  }

  /*
   * 深合并：base 打底，over 覆盖。
   * 规则（已冻结）：
   *   · 两边都是普通对象 → 递归合并（**只覆写 over 写了的键**）
   *   · 其它情况（含数组）→ over 的值**整体替换** base 的值（数组不做逐项合并）
   *   · over 里值为 **undefined 或 null** → **跳过**（视为"这一层没写"）
   *     null 之所以也跳过：配置里没有哪个项"必须是 null"（DEFAULT_CONFIG 里一个 null 都没有），
   *     而放行 null 会**抹掉整个配置块** —— 实测 `{points:null}` 会让 cfg.points 变成 null，
   *     随后 `scoreOne` 读 `cfg.points[q.type]` 直接 TypeError 崩掉。宁可当"没写"。
   * 结果与 base / over **不共享任何嵌套引用**。
   */
  function deepMerge(base, over) {
    const out = deepClone(base);
    if (!over) return out;
    Object.keys(over).forEach(function (k) {
      const v = over[k];
      if (v === undefined || v === null) return;
      if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
      else out[k] = deepClone(v);
    });
    return out;
  }

  /* 多层合并：从左到右依次覆盖（第 1 层是兜底，最后一层优先级最高） */
  function mergeConfig(/* layer1, layer2, ... */) {
    let out = deepClone(DEFAULT_CONFIG);
    for (let i = 0; i < arguments.length; i++) {
      const layer = arguments[i];
      if (layer) out = deepMerge(out, layer);
    }
    return out;
  }

  /* 配置快照：取一份完全独立的深拷贝，用来固化"此刻生效的配置" */
  function snapshotConfig(cfg) { return deepClone(cfg); }

  /*
   * 逐路径标出"这个值来自哪一层" —— 让"继承全局 / 落回默认"变成可断言、可展示的东西。
   * 返回 { 'points.单选': 'exam'|'global'|'builtin', ... }
   *   · **一律下钻到叶子**（不整块打标），消费者只需要处理一种粒度
   *   · 数组与标量算叶子（与 deepMerge 的"数组整体替换"语义一致）
   *   · 已锁定的卷不读全局：来源只会是 exam（快照）或 builtin
   *   · 三个层里都没有的空对象不产出任何条目（没有值可归属）
   *   · 例外：`short.synonyms` 一律算叶子（里面的键是用户数据，不是配置项），
   *     因此它**总有**条目 —— 否则设置界面那一行会错显成 builtin
   */
  const LAYER_BUILTIN = 'builtin', LAYER_GLOBAL = 'global', LAYER_EXAM = 'exam';
  function configSources(globalCfg, exam) {
    const locked = !!(exam && exam.configLocked);
    const own = (exam && exam.config) || null;
    // 全局被忽略的**充要条件**是"锁定且有快照"——与 resolveConfig 的分支严格对齐。
    // 早先写成 !locked，于是"锁定但没有 config"这种卷会被错标：
    // resolveConfig 明明读了全局，标注却说 builtin —— 不变式当场破。
    const gOn = !(locked && own);
    const out = {};
    function walk(path, d, g, o, gOn) {
      const keys = {};
      [d, g, o].forEach(function (src) {
        if (isPlainObject(src)) Object.keys(src).forEach(function (k) { keys[k] = 1; });
      });
      Object.keys(keys).forEach(function (k) {
        const p = path ? path + '.' + k : k;
        const dv = isPlainObject(d) ? d[k] : undefined;
        const gv = (gOn && isPlainObject(g)) ? g[k] : undefined;
        const ov = isPlainObject(o) ? o[k] : undefined;
        // 只认"这一层真的写了"：null/undefined 与 deepMerge 一样视为没写
        const hasO = ov !== undefined && ov !== null;
        const hasG = gv !== undefined && gv !== null;
        let layer, win;
        if (hasO) { layer = LAYER_EXAM; win = ov; }
        else if (hasG) { layer = LAYER_GLOBAL; win = gv; }
        else { layer = LAYER_BUILTIN; win = dv; }
        // 只有"赢家是对象、且 base 也是对象"才是逐键合并 → 下钻；
        // 否则这一项是**整体替换**（标量/数组/null 覆盖），本身就算叶子。
        // 早先这里只看 base 是不是对象，于是 `{points:5}` 这种整体替换会被误标成 builtin。
        //
        // 例外：`short.synonyms` 里的键是**用户数据**（关键词 → 写法），不是配置项，
        // 不能再往下钻 —— 否则这一项自己就没有来源标注了（设置预览那一行会错显成 builtin）。
        if (p !== 'short.synonyms' && isPlainObject(win) && isPlainObject(dv)) {
          walk(p, dv, gv, ov, gOn); return;
        }
        out[p] = layer;
      });
    }
    walk('', DEFAULT_CONFIG, globalCfg || {}, own, gOn);
    return out;
  }

  // 试卷锁定 → 用试卷独立配置；未锁定 → 继承全局；锁定后全局不得影响它
  //
  // 注意语义（验证台逼出来的设计决策）：
  //   已锁定 + 试卷配置是"部分覆盖"时，**不读全局**，缺失项落回内置默认值。
  //   原因：需求要求"锁定后该试卷配置不可被全局设置覆盖"，若还去读全局，
  //   之后改全局就会悄悄改掉这份锁定卷 —— 违背锁定语义。
  //   想保留当时的全局值，请在锁定那一刻调用 lockConfig() 把它固化成完整快照。
  function resolveConfig(globalCfg, exam) {
    const locked = !!(exam && exam.configLocked);
    const own = (exam && exam.config) || null;
    if (locked && own) return mergeConfig(own);
    if (own) return mergeConfig(globalCfg, own);
    return mergeConfig(globalCfg);
  }

  // 锁定：把"当前生效的完整配置"固化成快照存回试卷，从此与全局脱钩
  function lockConfig(globalCfg, exam) {
    const e = Object.assign({}, exam || {});
    // 快照必须是深拷贝：锁定卷从此与全局彻底脱钩，改谁都不影响谁
    e.config = snapshotConfig(resolveConfig(globalCfg, Object.assign({}, e, { configLocked: false })));
    e.configLocked = true;
    return e;
  }

  /*
   * 解锁：回到"继承全局"的取值路径。
   *
   * **必须把 config 置 null（丢掉旧快照）**，只改 configLocked 是不够的：
   *   若只把 configLocked 改回 false 而留着那份完整快照，
   *   快照就会以"单卷设置"的身份**继续覆盖全局** ——
   *   名义上解锁、实际还在用旧快照，用户改了全局却发现这份卷没跟着变。
   *   这与"解锁后重新回到继承全局的取值路径"直接冲突。
   *
   * 代价（如实记录）：锁定时固化的那份快照**无法再从试卷里取回**。
   *   想在解锁后回到同一份值，请在解锁前自己保存 resolveConfig 的结果
   *   （ExamsCore.unlockExam 会把丢掉的那份快照回传，供调用方留档）。
   */
  function unlockConfig(exam) {
    const e = Object.assign({}, exam || {});
    e.config = null;
    e.configLocked = false;
    return e;
  }

  /* ---------------- 归一化 ---------------- */
  function normText(s, ignoreCase) {
    let t = String(s == null ? '' : s);
    t = t.replace(/\s+/g, '');
    t = t.replace(/[，,。.；;：:、！!？?（）()【】\[\]"'“”‘’]/g, '');
    if (ignoreCase) t = t.toLowerCase();
    return t;
  }
  /* 答案字母归一 —— 委托 SegmentCore（**唯一实现**）。
   * 早先 quiz 与 schema 各有一份，于是"计分侧认全角 ＡＣ、校验侧不认"两把尺子。 */
  function toHalfWidth(s) { return SegmentCore.toHalfWidth(s); }
  function normLetters(s) { return SegmentCore.normLetters(s); }
  function toSet(s) { return SegmentCore.toSet(s); }
  function letterSet(v) { return SegmentCore.letterSet(v); }
  function firstLetter(v) { return SegmentCore.firstLetter(v); }
  function setEq(a, b) { return a.size === b.size && [...a].every(x => b.has(x)); }

  /* ---------------- 单题判分 ----------------
   * 返回 { score, full, correct, detail }  —— detail 用于界面展示命中/未命中
   *
   * 粒度保证：**返回的 score 与 full 一律落在 0.5 的整数倍上**。
   *   · 分值本身由配置决定，配置侧用 `multiple: 0.5` 拦住 2.25 这种输入（见 CONFIG_FIELDS）；
   *   · 但计分函数可能被喂进手改过的非法配置，所以这里再兜一道 `roundHalf` ——
   *     "所有得分都是 0.5 的整数倍"是验收标准，不能只靠上游。
   */
  function scoreOne(q, userAnswer, cfg, opts) {
    const o = opts || {};
    // 缺项落回内置默认：与三层取值同一条语义。
    // 早先这里直接读 cfg.points / cfg.multi / cfg.short —— 喂进一份**部分**配置
    // （例如只有 {points:{...}}）会当场 TypeError 崩掉，而不是"按默认值判分"。
    const c = cfg || DEFAULT_CONFIG;
    // **逐键**落回内置默认（与 resolveConfig 的三层合并同一条语义）：
    // 一份只写了 {multi:{halfMode:'fixed'}} 的配置，`halfCredit` 缺失必须是"用默认的 true"，
    // 而不是被当成 false 把半对静默关掉（早先 `if (!m.halfCredit)` 正是这个坑）。
    const points = deepMerge(DEFAULT_CONFIG.points, c.points || null);
    const m = deepMerge(DEFAULT_CONFIG.multi, c.multi || null);
    const sh = deepMerge(DEFAULT_CONFIG.short, c.short || null);
    // 数值合法性兜底：`points.单选='abc'` 这种脏配置（**手改过的导出文件**能带进来，
    // 而 exam.config 的落库入口不跑 validateConfig）会让 full 变 NaN → **整卷 score=NaN**。
    // 兜底策略是"落回**内置默认分值**"，不是落 0 —— 落 0 会让这道题从整卷分母里消失，
    // 于是"答对 1/2"能显示成 100%（成绩虚高比报错更危险）。
    const numOr = function (v, dft, lo, hi) {
      if (typeof v !== 'number' || !isFinite(v)) return dft;
      return clamp(v, (lo == null ? -Infinity : lo), (hi == null ? Infinity : hi));
    };
    // 题目对象本身不合法（null / 非对象）：按"不可判分"返回 0，**不许抛** ——
    // 抛出去会让 scoreExam 的整个循环中断，等于整卷判不了分。
    if (!q || typeof q !== 'object') {
      return { score: 0, full: 0, correct: false, detail: { unscorable: 'badQuestion' } };
    }
    // 分值的上界：挡住"有限但溢出"的值（9e307 → v*2 溢出成 Infinity → 整卷 percent=NaN）。
    // 下界：比 0.5 小的正值无法用半步表达（roundHalf 会变 0 → 该题从分母消失）。
    const rawFull = points[q.type];
    const dfltFull = DEFAULT_CONFIG.points[q.type];
    const badPoints = (rawFull != null) &&
      !(typeof rawFull === 'number' && isFinite(rawFull) && rawFull >= 0 && rawFull <= POINTS_MAX &&
        !(rawFull > 0 && rawFull < POINTS_MIN_POS));
    const fullRaw = badPoints ? numOr(dfltFull, 0, 0, POINTS_MAX) : rawFull;
    let full = roundHalf(numOr(fullRaw, 0, 0, POINTS_MAX));
    if (!isFinite(full)) full = roundHalf(numOr(dfltFull, 0, 0, POINTS_MAX));
    if (!isFinite(full)) full = 0;
    const res = { score: 0, full: full, correct: false, detail: {} };
    // 分值配置有问题时**留下痕迹**（界面/成绩页可以提示"这项分值配置异常，暂按默认计"）。
    // 放在 `res` 顶层而不是 `detail` 里：各分支会**整体替换** `detail`（那是"作答比对"的地方），
    // 塞在 detail 里会被下一次赋值悄悄抹掉（早先就这么把标记丢了）。
    if (badPoints) res.cfgWarn = { badPoints: rawFull, pointsUsed: full };

    if (q.type === '单选' || q.type === '判断') {
      if (q.type === '单选') {
        const want = firstLetter(q.answerLetters !== undefined && q.answerLetters !== null ? q.answerLetters : q.answer);
        const got = normLetters(userAnswer).charAt(0);   // 与答案键同一把尺子（含全角 Ａ、数组作答）
        res.detail = { want: want, got: got };
        res.correct = !!want && got === want;
      } else {
        const want = q.judgeValue;                      // true / false / null（null = 答案本身有歧义）
        const norm = normalizeJudgeLocal(userAnswer);
        const raw = (userAnswer === undefined || userAnswer === null) ? '' : String(userAnswer);
        res.detail = {
          want: want, got: norm, raw: raw,
          // 用户答了、但认不出正误 → 界面要提示"这条要人工订正"，而不是静默判 0
          ambiguous: raw.trim() !== '' && norm === null,
          wantAmbiguous: want === null
        };
        res.correct = want !== null && norm !== null && want === norm;
      }
      res.score = res.correct ? full : 0;
      return res;
    }

    if (q.type === '多选') {
      // 答案键统一归一（形态 + 大小写）：题目对象可能是手搓/外部导入的（未经 createQuestion 归一），
      // 小写 ['a','b']、字符串 'AB' 与用户答的 'AB' 若不归一就**永远匹配不上**（静默 0 分）或直接崩。
      const want = letterSet(q.answerLetters !== undefined && q.answerLetters !== null ? q.answerLetters : q.answer);
      const got = toSet(userAnswer);
      // 明细数组一律**排序**：不给"用户先点 B 再点 A"留下不稳定顺序，
      // 否则界面高亮与测试比对都会飘（早先 hit/wrong 跟的是作答顺序，miss 跟的是答案顺序）。
      const hit = [...got].filter(x => want.has(x)).sort();
      const wrong = [...got].filter(x => !want.has(x)).sort();
      const miss = [...want].filter(x => !got.has(x)).sort();
      res.detail = { want: [...want].sort(), got: [...got].sort(), hit: hit, wrong: wrong, miss: miss,
                     wantCount: want.size, gotCount: got.size };

      // 答案键为空：不是"全对"，是**没法判分** → 不给分（与简答"无关键词不给分"同一条规矩）。
      // 早先这里走 setEq(∅,∅) = true → 一道没有答案键、又没作答的题会拿满分并计入正确题数。
      if (want.size === 0) { res.detail.unscorable = 'noAnswerKey'; return res; }

      if (setEq(got, want)) { res.score = full; res.correct = true; return res; }
      if (got.size === 0) { res.score = 0; return res; }          // 没作答：不给分（也不是"半对"）
      // **一个都没命中就不是"半对"**：固定比例模式下尤其危险 ——
      // 放水配置（wrongChoiceZero=false + halfMode=fixed）里全选错项本该 0 分，
      // 早先会照给 halfRatio（halfRatio=1 时直接满分）。
      if (hit.length === 0) { res.score = 0; res.detail.noHit = true; return res; }

      if (!m.halfCredit) { res.score = 0; return res; }
      if (wrong.length > 0 && m.wrongChoiceZero) { res.score = 0; return res; }

      /* 半对固定给分（用户要求："多选规则应该半对给两分"）：
       *   少选（命中了一部分、没全中，且按配置没有错选）→ **固定 `halfScore` 分**，不看命中几个。
       *   封顶不超过满分（多选只值 1 分时，"半对 2 分"不许把分数顶上天）；
       *   仍是半步粒度（roundHalf），避免脏分。 */
      if (m.halfMode === 'fixedScore') {
        const hs = roundHalf(clamp(numOr(m.halfScore, DEFAULT_CONFIG.multi.halfScore, 0, POINTS_MAX), 0, full));
        res.detail.mode = 'fixedScore';
        res.detail.halfScore = hs;
        res.score = hs;
        return res;
      }

      const hr = numOr(m.halfRatio, DEFAULT_CONFIG.multi.halfRatio, 0, 1);
      let ratio;
      if (m.halfMode === 'fixed') ratio = hr;                          // 固定比例：不看命中多少
      else ratio = want.size ? (hit.length / want.size) * hr : 0;      // 按命中比例（仍受 halfRatio 封顶）
      res.detail.mode = m.halfMode;
      res.detail.ratio = ratio;
      res.score = roundHalf(full * clamp(ratio, 0, 1));
      return res;
    }

    if (q.type === '简答') {
      // 关键词先过滤掉"空文本"条目：它们**永远不可能命中**，留在 total 里会让满分不可达
      // （答全也拿不到满分），明细里还会冒出 ""/null 这种看不懂的未命中项。
      const rawKws = Array.isArray(q.keywords) ? q.keywords : [];
      const kws = rawKws
        .map(function (k) { return (typeof k === 'string') ? k : (k && k.text); })
        .filter(function (t) { return typeof t === 'string' && t.trim() !== ''; });
      const ans = normText(userAnswer, sh.ignoreCase);
      // 人工订正入口一：**把某个关键词标记为命中**。
      // 命中集合是自动判定 ∪ 人工标记，之后的算分**仍走下面同一套公式** ——
      // 不另写一份"人工评分算法"，否则两种模式迟早算出两个数。
      const manualHits = Array.isArray(o.manualHits) ? o.manualHits : [];
      const hit = [], miss = [], forced = [];
      kws.forEach(function (kt) {
        const forms = [kt].concat((sh.synonyms && sh.synonyms[kt]) || []);
        const auto = forms.some(function (f) {
          const n = normText(f, sh.ignoreCase);
          if (!n) return false;
          return sh.matchMode === 'exact' ? ans === n : ans.indexOf(n) >= 0;
        });
        const byManual = !auto && manualHits.indexOf(kt) >= 0;
        if (byManual) forced.push(kt);
        (auto || byManual ? hit : miss).push(kt);
      });
      const total = kws.length;
      const ratio = total ? hit.length / total : 0;
      res.detail = {
        hit: hit, miss: miss, hitCount: hit.length, total: total, ratio: ratio,
        norm: ans,                                     // 归一后的作答：人工订正时要看"引擎到底比的是什么"
        matchMode: sh.matchMode, scoreMode: sh.scoreMode
      };
      if (forced.length) res.detail.manualHits = forced;    // 哪几条是人工标为命中的（痕迹）
      if (rawKws.length > total) res.detail.droppedKeywords = rawKws.length - total;   // 有词被丢 → 如实报出
      res.correct = total > 0 && hit.length === total;

      // 人工订正入口二：**直接给一个分数**（覆盖自动算分，含"没有关键词"的题）。
      // 仍受满分封顶 + 半步粒度约束，并且明确标出"这是人工分"。
      if (typeof o.manualScore === 'number' && isFinite(o.manualScore)) {
        res.score = roundHalf(clamp(o.manualScore, 0, full));
        res.detail.manualScore = true;
        // ⚠ 这里**不再写** detail.autoScore：那一刻 res.score 已经是人工分，写进去等于给"自动分"
        //   这个字段名贴上人工分（红队抓出的误导字段）。真正的自动分由 core/attempt.js 的
        //   session.auto[qid] 留档，回看卡片读那一份。
        res.correct = full > 0 && res.score >= full;
        return res;
      }

      if (total === 0) { res.score = 0; res.detail.unscorable = 'noKeywords'; return res; }

      const hr = numOr(sh.minRatio, DEFAULT_CONFIG.short.minRatio, 0, 1);
      const hx = numOr(sh.maxRatio, DEFAULT_CONFIG.short.maxRatio, 0, 1);
      if (sh.scoreMode === 'range') {
        res.score = roundHalf(full * clamp(hr + (hx - hr) * ratio, 0, 1));
      } else {
        res.score = roundHalf(full * ratio);
      }
      return res;
    }

    return res;                                        // 未知题型：0 分（不猜、不乱给分）
  }

  /* 判断题正误归一 —— 委托 SegmentCore（**唯一实现**）。
   * 保留这个名字是为了兼容既有调用方；返回值与 `SegmentCore.normalizeJudge(x).value` 恒等。 */
  function normalizeJudgeLocal(v) {
    return SegmentCore.normalizeJudge(v).value;
  }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function roundHalf(v) { return Math.round(v * 2) / 2; }   // 半分粒度，避免 1.333 这种脏分

  /* 等级定档（**唯一真相源**）：分数线改了就按新线定档，判分与成绩页都走这一个函数。
   * 边界口径：百分数 ≥ 优秀线 → 优秀；≥ 及格线 → 及格；否则不及格（"60 分算及格"）。
   * 早先这条三元表达式直接写在 scoreExam 里，将来成绩页/快捷面板若各写一份就会互相打架。 */
  function levelOf(percent, cfg) {
    const g = (cfg && cfg.grade) || DEFAULT_CONFIG.grade;
    const p = (typeof percent === 'number' && isFinite(percent)) ? percent : 0;
    if (p >= g.excellent) return '优秀';
    if (p >= g.pass) return '及格';
    return '不及格';
  }

  /* ---------------- 整卷判分 ----------------
   * opts.manual = { <题 id>: { hits:[关键词], score:数字 } } —— 人工订正（简答改判）走这里，
   * 于是"整卷重算"用的仍是**同一套算式**，不会出现"单题人工算 / 整卷自动算"两套口径。
   */
  function scoreExam(questions, answers, cfg, opts) {
    const A = answers || {};      // 没传作答表也照常判（全 0），不崩
    const o = opts || {};
    const manual = o.manual || {};
    const qs = Array.isArray(questions) ? questions : [];
    let got = 0, full = 0, right = 0, skippedInvalid = 0;
    const per = [];
    qs.forEach(function (q) {
      // 数组里混进 null / 非对象 / 没 id 的项：**跳过并计数**，不让它把整卷判分打断，
      // 也不静默当成 0 分题（那样 total 会对不上，用户看到"10 题里有 1 题不见了"）。
      if (!q || typeof q !== 'object' || !q.id) { skippedInvalid++; return; }
      const mo = manual[q.id];
      const r = scoreOne(q, A[q.id], cfg, mo ? { manualHits: mo.hits, manualScore: mo.score } : null);
      got += r.score; full += r.full;
      if (r.correct) right++;
      per.push({ id: q.id, type: q.type, score: r.score, full: r.full, correct: r.correct, detail: r.detail,
                 manual: mo ? true : false, cfgWarn: r.cfgWarn || null });
    });
    const pct = full ? (got / full) * 100 : 0;
    // 最后一道闸：任何情况下 score/full/percent 都必须是有限数
    const fin = function (v, dft) { return (typeof v === 'number' && isFinite(v)) ? v : dft; };
    // ⚠ 等级必须从**显示出来的那个百分数**派生：早先 percent 四舍五入、level 用未四舍五入的 pct，
    //   于是在 84.95% 这种边界上出现"显示 85%、等级却写及格"，成绩页注脚又按 85 算成"超过优秀线 0 分"。
    //   现在两者同源：用户看到的数字与等级永远自洽（红队组级审查抓出的两真相源问题）。
    const percent = fin(Math.round(pct * 10) / 10, 0);
    return {
      score: fin(roundHalf(got), 0), full: fin(roundHalf(full), 0), percent: percent,
      correctCount: right, total: per.length, skippedInvalid: skippedInvalid, per: per,
      level: levelOf(percent, cfg)
    };
  }

  /* ---------------- 抽题 ---------------- */
  const PICK_MODES = ['all', 'byCount', 'byWeight', 'random'];
  const RANDOM_BASIS = ['count', 'score'];
  /* 抽取偏好（"随机 or 未作答优先"里的后一半）。
   * 'unansweredFirst' 本身**不知道**谁没作答 —— 调用方把每个 qid 的档位算好传进 opts.priority
   * （见 pickQuestions 的第三个参数），这里只负责"高档位先抽、同档内仍按 seed 随机"。
   * 这样 core 不必读题本/作答记录，抽题依旧是纯函数 + 定种子可复现。 */
  const PICK_PREFER = ['random', 'unansweredFirst'];

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rnd) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* 某题型"每题满分"（抽题预算用）。非正数视为 0 —— 0 分题不能靠"加题"来凑分 */
  function unitPoints(points, t) {
    const v = points ? points[t] : undefined;
    return (typeof v === 'number' && isFinite(v) && v > 0) ? v : 0;
  }

  /* 建池：按题型分组，同时把"不该进试卷的东西"挑出来
   *   · 重复 id：同一题在题库里出现两次，会抽出两道一模一样的题（用户看到重复题、还重复计分）
   *   · 无效项（null / 无 id / 题型不在四类里）：不能进试卷（验收要求"不出现空白题"）
   * 两者都必须**报告**而不是静默丢弃 —— 丢的是用户自己的题。
   */
  function buildPool(all) {
    const byType = {}; TYPE_KEYS.forEach(function (t) { byType[t] = []; });
    const flat = [];
    const seen = Object.create(null);
    const invalid = [], duplicates = [];
    const list = Array.isArray(all) ? all : [];
    list.forEach(function (q, i) {
      if (!q || typeof q !== 'object') { invalid.push({ index: i, id: null, reason: 'notObject' }); return; }
      const id = (q.id == null) ? '' : String(q.id);
      if (!id) { invalid.push({ index: i, id: null, reason: 'noId' }); return; }
      if (seen[id]) { duplicates.push(id); return; }
      if (TYPE_KEYS.indexOf(q.type) < 0) { invalid.push({ index: i, id: id, reason: 'badType:' + String(q.type) }); return; }
      seen[id] = 1; byType[q.type].push(q); flat.push(q);
    });
    return {
      byType: byType, flat: flat, invalid: invalid, duplicates: duplicates,
      total: flat.length, rawLength: list.length
    };
  }

  /*
   * 抽题。三种规则：
   *   byCount   逐题型指定数量（精确匹配；不够就抽光并在 shortfall 里报缺口）
   *   byWeight  按目标总分自动配比（"均衡填充"：每轮把一题加到加入后累计分最小的题型）
   *   random    完全随机；停止口径由 pick.randomBasis 决定：'count' 按题量 / 'score' 按目标总分
   * 同一份配置 + 同一个 seed → 结果**逐题一致**（含顺序）；不同 seed → 不同。
   *
   * 结果里的 questions 一律是真题目对象（无 null / 无重复），顺序为"按题型分块"（random 模式为随机顺序）。
   *
   * 第三个参数 opts（可选）：
   *   priority  {qid: 档位}  —— 「未作答优先」用。数字越大越先抽；同档位内仍按 seed 随机。
   *             调用方从错题本/作答记录算出档位；不传 = 没有优先信息 = 完全随机。
   */
  function pickQuestions(all, cfg, opts) {
    const c = cfg || DEFAULT_CONFIG;
    const pick = c.pick || {};
    const points = c.points || DEFAULT_CONFIG.points;
    const dflt = DEFAULT_CONFIG.pick;
    const option = opts || {};
    const priority = (option.priority && typeof option.priority === 'object') ? option.priority : null;

    // 未知模式不静默乱抽：落回内置默认并如实报告（宁可抽成默认规则，也不猜用户想要哪个）
    const mode = (PICK_MODES.indexOf(pick.mode) >= 0) ? pick.mode : dflt.mode;
    // 偏好同理：不认识的值落回"完全随机"
    const prefer = (PICK_PREFER.indexOf(pick.prefer) >= 0) ? pick.prefer : dflt.prefer;
    const preferFallback = (PICK_PREFER.indexOf(pick.prefer) < 0)
      ? (pick.prefer === undefined ? null : pick.prefer) : null;
    // ⚠ 不能写 `pick.seed || 1` —— 0 是合法种子，会被 || 吞掉
    const seed = (typeof pick.seed === 'number' && isFinite(pick.seed)) ? pick.seed : dflt.seed;
    const rnd = mulberry32(seed);
    const poolRes = buildPool(all);
    const pool = poolRes.byType;

    const chosen = [];
    const byTypeWant = {};          // byCount：逐题型目标题数
    const byTypeWantScore = {};     // byWeight：逐题型目标分（全 0 = 没分配，走"总目标分自动配比"）
    const byTypeUnused = {};        // byWeight 逐题型模式：每型凑不满还剩多少分
    const zeroPointTypes = [];
    const defaulted = [];
    let basis = null, basisFallback = null;
    let targetScore = null, requestedCount = null, unused = 0;
    let allocatedScore = 0, perTypeScore = false;
    let poolExhausted = false;

    // "缺项落回内置默认" —— 与 resolveConfig 的三层取值同一条语义。
    // 早先这里把缺项当 0：传一份**部分**配置（例如 {pick:{mode:'byWeight'}}）会静默抽 0 题，
    // 用户只看到"没抽到题"，完全不知道为什么。落回默认并把落过的项记下来。
    const numOr = function (v, dft, path) {
      if (typeof v === 'number' && isFinite(v)) return v;
      if (path) defaulted.push(path);
      return dft;
    };

    /* 抽题的最小单元：先按档位分层，从高到低依次取满；同档位内洗一遍（seed 决定）。
     * 没有 priority（完全随机 / 调用方没给记录）时就退化成原来的 shuffle+slice。 */
    const tiered = function (list, n) {
      const want = Math.max(0, n);
      if (!priority) return shuffle(list, rnd).slice(0, want);
      const tiers = Object.create(null);
      const keys = [];
      list.forEach(function (q) {
        const raw = priority[String(q.id)];
        const w = (typeof raw === 'number' && isFinite(raw)) ? raw : 0;
        if (!tiers[w]) { tiers[w] = []; keys.push(w); }
        tiers[w].push(q);
      });
      keys.sort(function (a, b) { return b - a; });   // 档位高的先抽
      const out = [];
      keys.forEach(function (k) {
        if (out.length >= want) return;
        shuffle(tiers[k], rnd).forEach(function (q) { if (out.length < want) out.push(q); });
      });
      return out;
    };
    const grab = function (list, n) { return tiered(list, n); };

    if (mode === 'all') {
      /* 全部作答：**不抽题** —— 整套卷按**原顺序**都拿上（`buildPool.flat` 保留输入顺序，
       * 与"直接开整卷"的观感一致），只把重复 id / 无效题过滤掉并在 warn 里如实报告。 */
      poolRes.flat.forEach(function (q) { chosen.push(q); });
    } else if (mode === 'byCount') {
      const table = isPlainObject(pick.byType) ? pick.byType : null;
      if (!table) defaulted.push('pick.byType');
      TYPE_KEYS.forEach(function (t) {
        const raw = table ? table[t] : dflt.byType[t];
        const want = Math.max(0, Math.floor(numOr(raw, dflt.byType[t], table ? ('pick.byType.' + t) : null)));
        byTypeWant[t] = want;
        grab(pool[t], want).forEach(function (q) { chosen.push(q); });
      });

    } else if (mode === 'byWeight') {
      targetScore = Math.max(0, numOr(pick.targetScore, dflt.targetScore, 'pick.targetScore'));
      TYPE_KEYS.forEach(function (t) {
        if (pool[t].length > 0 && unitPoints(points, t) <= 0) zeroPointTypes.push(t);
      });
      /* ---- 逐题型目标分（用户手动分配）----
       * ⚠ **全 0 = "没分配过"** → 落回下面的"按总目标分自动配比"（老行为）。
       *   这条不是偷懒：旧卷的快照里没有 pick.byTypeScore，三层取值会让它落回内置默认（全 0），
       *   若把"全 0"当成"每型都要 0 分"，老卷会**一道题都抽不出来**。 */
      const scoreTable = isPlainObject(pick.byTypeScore) ? pick.byTypeScore : null;
      if (!scoreTable) defaulted.push('pick.byTypeScore');
      TYPE_KEYS.forEach(function (t) {
        const raw = scoreTable ? scoreTable[t] : dflt.byTypeScore[t];
        byTypeWantScore[t] = Math.max(0, numOr(raw, dflt.byTypeScore[t], scoreTable ? ('pick.byTypeScore.' + t) : null));
      });
      allocatedScore = roundHalf(TYPE_KEYS.reduce(function (s, t) { return s + byTypeWantScore[t]; }, 0));
      perTypeScore = allocatedScore > 0;

      if (perTypeScore) {
        /* 逐题型：**各自**凑到自己的目标分。与"完全随机 · 按分数"同一条规矩：装不下就跳过，
         * 绝不为了凑满而超预算（宁可少几分，也不悄悄多给题）。 */
        const pcount = {}; TYPE_KEYS.forEach(function (t) { pcount[t] = 0; });
        TYPE_KEYS.forEach(function (t) {
          const unit = unitPoints(points, t);
          let remaining = byTypeWantScore[t];
          if (unit <= 0) { byTypeUnused[t] = remaining; return; }   // 0 分题凑不了分
          shuffle(pool[t], rnd).forEach(function (q) {
            if (unit > remaining) return;
            chosen.push(q); pcount[t]++; remaining -= unit;
          });
          byTypeUnused[t] = roundHalf(remaining);
        });
        unused = roundHalf(TYPE_KEYS.reduce(function (s, t) { return s + byTypeUnused[t]; }, 0));
        /* 缺口是不是"题库抽干了"造成的：每个**要过分的**题型都摸到了池底 */
        poolExhausted = unused > 0 && TYPE_KEYS.every(function (t) {
          return unitPoints(points, t) <= 0 || byTypeWantScore[t] <= 0 || pcount[t] >= pool[t].length;
        });
      } else {
        const count = {}; TYPE_KEYS.forEach(function (t) { count[t] = 0; });
        let remaining = targetScore;
        // 均衡填充。迭代上界 = 池子总题数（每轮必然 +1 题且每型不超过自己的池子大小）→ 结构上不可能死循环。
        // 旧实现用固定 20000 次护栏，targetScore 填大（如 100000）时会**静默截断**且不报告。
        for (let step = 0; step < poolRes.total; step++) {
          let best = null, bestSum = Infinity, bestUnit = 0;
          TYPE_KEYS.forEach(function (t) {
            const unit = unitPoints(points, t);
            if (unit <= 0) return;                       // 0 分题凑不了分，不参与预算
            if (count[t] >= pool[t].length) return;      // 这个题型抽光了
            if (unit > remaining) return;                // 会超预算
            const sumAfter = (count[t] + 1) * unit;
            // 同分优先"每题分值更大"的题型：让累计分更快追平，分布也更匀（不会全压小分题型）
            if (sumAfter < bestSum || (sumAfter === bestSum && unit > bestUnit)) {
              best = t; bestSum = sumAfter; bestUnit = unit;
            }
          });
          if (best === null) break;
          count[best]++; remaining -= unitPoints(points, best);
        }
        TYPE_KEYS.forEach(function (t) {
          if (count[t] > 0) grab(pool[t], count[t]).forEach(function (q) { chosen.push(q); });
        });
        unused = remaining;
        const minUnit = TYPE_KEYS.reduce(function (m, t) {
          const u = unitPoints(points, t);
          return (u > 0 && (m === 0 || u < m)) ? u : m;
        }, 0);
        poolExhausted = unused > 0 && minUnit > 0 && unused >= minUnit &&
          TYPE_KEYS.every(function (t) { return unitPoints(points, t) <= 0 || count[t] >= pool[t].length; });
      }

    } else {
      // 完全随机
      const rawBasis = pick.randomBasis;
      if (rawBasis === undefined || rawBasis === null) basis = 'count';
      else if (RANDOM_BASIS.indexOf(rawBasis) >= 0) basis = rawBasis;
      else { basis = 'count'; basisFallback = rawBasis; }
      if (basis === 'score') {
        targetScore = Math.max(0, numOr(pick.targetScore, dflt.targetScore, 'pick.targetScore'));
        TYPE_KEYS.forEach(function (t) {
          if (pool[t].length > 0 && unitPoints(points, t) <= 0) zeroPointTypes.push(t);
        });
        let remaining = targetScore;
        // 洗一遍后按序尽量装：装不下的跳过继续看后面的（比"遇到装不下就停"能更贴近目标分）
        tiered(poolRes.flat, poolRes.flat.length).forEach(function (q) {
          const unit = unitPoints(points, q.type);
          if (unit <= 0 || unit > remaining) return;
          chosen.push(q); remaining -= unit;
        });
        unused = remaining;
        // 剩下的题每一道都装不下了（remaining 只会变小，先跳过的现在更装不下）
        poolExhausted = unused > 0 && chosen.length === poolRes.flat.length;
      } else {
        requestedCount = Math.max(0, Math.floor(numOr(pick.count, dflt.count, 'pick.count')));
        grab(poolRes.flat, requestedCount).forEach(function (q) { chosen.push(q); });
      }
    }

    /* ---- 汇总 ---- */
    const byType = {}, byTypePoints = {};
    TYPE_KEYS.forEach(function (t) { byType[t] = 0; byTypePoints[t] = 0; });
    chosen.forEach(function (q) { byType[q.type]++; byTypePoints[q.type] += unitPoints(points, q.type); });
    const totalPoints = roundHalf(TYPE_KEYS.reduce(function (s, t) { return s + byTypePoints[t]; }, 0));

    // 缺口：按题型（byCount 有逐题型目标数；byWeight 逐题型模式有逐题型目标分）；按题量；按分数
    const byTypeShortfall = {};
    if (mode === 'byCount') {
      TYPE_KEYS.forEach(function (t) {
        if (byType[t] < byTypeWant[t]) {
          byTypeShortfall[t] = { want: byTypeWant[t], got: byType[t], gap: byTypeWant[t] - byType[t], pool: pool[t].length };
        }
      });
    }
    const byTypeScoreShortfall = {};
    if (perTypeScore) {
      TYPE_KEYS.forEach(function (t) {
        const want = byTypeWantScore[t], got = roundHalf(byTypePoints[t]);
        if (want > 0 && got < want) {
          byTypeScoreShortfall[t] = { want: want, got: got, gap: roundHalf(want - got),
                                      pool: pool[t].length, unit: unitPoints(points, t) };
        }
      });
    }
    // ⚠ 旧实现用"要求总数 vs 整库题数"比大小算缺口 —— 逐题型各自不够时总数为 0，
    //   于是**真有缺口却报 shortage:0**，提示完全不出现。缺口必须由逐题型缺口汇总。
    const shortageCount = Object.keys(byTypeShortfall).reduce(function (s, t) { return s + byTypeShortfall[t].gap; }, 0)
      + (basis === 'count' && requestedCount > poolRes.total ? requestedCount - poolRes.total : 0);
    /* 分数缺口：逐题型模式按"各型差多少分"汇总；自动配比模式按"总目标分还剩多少"。
     * ⚠ 逐题型模式下**不能**再拿 targetScore 去算缺口 —— 那个字段此时根本不参与抽取，
     *   报"未能凑满目标分 100"就是胡说。 */
    const shortageScore = perTypeScore
      ? roundHalf(Object.keys(byTypeScoreShortfall).reduce(function (s, t) { return s + byTypeScoreShortfall[t].gap; }, 0))
      : ((targetScore != null && unused > 0) ? roundHalf(unused) : 0);

    const notes = [];
    if (shortageCount > 0) {
      if (mode === 'byCount') {
        notes.push('题库不够：' + Object.keys(byTypeShortfall).map(function (t) {
          const s = byTypeShortfall[t];
          return t + '要 ' + s.want + ' 只有 ' + s.got + '（缺 ' + s.gap + '）';
        }).join('、') + '，共缺 ' + shortageCount + ' 题');
      } else {
        notes.push('题库只有 ' + poolRes.total + ' 题，少于要求的 ' + requestedCount + ' 题');
      }
    }
    if (perTypeScore && shortageScore > 0) {
      notes.push('逐题型目标分没能凑满：' + Object.keys(byTypeScoreShortfall).map(function (t) {
        const s = byTypeScoreShortfall[t];
        return t + '目标 ' + s.want + ' 分、只凑到 ' + s.got + ' 分（差 ' + s.gap +
               (s.unit <= 0 ? '，该题型每题 0 分' : '，题库里还剩 ' + s.pool + ' 道可选') + '）';
      }).join('；') + '，共差 ' + shortageScore + ' 分');
    } else if (!perTypeScore && shortageScore > 0) {
      notes.push((poolExhausted ? '题库已抽完' : '受每题分值限制') + '，未能凑满目标分 ' + targetScore
        + '（已抽 ' + totalPoints + ' 分，差 ' + shortageScore + ' 分）');
    }
    if (perTypeScore && targetScore > 0 && targetScore !== allocatedScore) {
      notes.push('逐题型目标分合计 ' + allocatedScore + ' 分（已按它抽题），配置里的"目标总分 ' + targetScore + ' 分"这次不参与');
    }
    if (poolRes.duplicates.length) notes.push('题库里有 ' + poolRes.duplicates.length + ' 道重复 id 的题已被忽略');
    if (poolRes.invalid.length) notes.push('题库里有 ' + poolRes.invalid.length + ' 项无效题目已被忽略');
    if (zeroPointTypes.length && targetScore != null) notes.push('这些题型每题 0 分、不参与凑分：' + zeroPointTypes.join('、'));
    if (basisFallback !== null) notes.push('未知的随机口径 ' + JSON.stringify(basisFallback) + ' → 已按「按题量」处理');
    if (preferFallback !== null) notes.push('未知的抽取偏好 ' + JSON.stringify(preferFallback) + ' → 已按「完全随机」处理');
    if (prefer === 'unansweredFirst' && !priority) {
      notes.push('这轮要求「未作答优先」，但没拿到作答记录 → 已按完全随机抽');
    }
    if (defaulted.length) notes.push('这些字段没写、已落回内置默认：' + defaulted.join('、'));

    return {
      questions: chosen,
      meta: {
        mode: mode, modeFallback: (PICK_MODES.indexOf(pick.mode) < 0) ? (pick.mode === undefined ? null : pick.mode) : null,
        basis: basis, seed: seed,
        prefer: prefer, preferFallback: preferFallback,
        // 「未作答优先」是否真的生效：要求了 + 拿到档位表才算（UI 据此说"本轮按未作答优先抽的"）
        preferApplied: (prefer === 'unansweredFirst' && !!priority),
        // requested 保持"要求的总题数"这个**数字**口径（旧调用方在用）；
        // 按分数抽题的规则没有题数目标 → 如实给 null（比给 0 好：0 会被读成"要求 0 题"）。
        // 逐题型/目标分的明细放在 requestDetail 里。
        requested: (mode === 'all') ? poolRes.total
          : (mode === 'byCount') ? TYPE_KEYS.reduce(function (s, t) { return s + byTypeWant[t]; }, 0)
          : (basis === 'count' ? (requestedCount || 0) : null),
        requestDetail: {
          count: requestedCount,
          byType: (mode === 'byCount') ? byTypeWant : null,
          byTypeScore: perTypeScore ? byTypeWantScore : null,
          scorePerType: perTypeScore,
          targetScore: targetScore
        },
        defaulted: defaulted.slice(),
        picked: chosen.length, poolSize: poolRes.total, poolByType: TYPE_KEYS.reduce(function (o, t) { o[t] = pool[t].length; return o; }, {}),
        byType: byType, byTypePoints: byTypePoints, totalPoints: totalPoints,
        targetScore: targetScore, unused: roundHalf(unused),
        byTypeShortfall: byTypeShortfall, byTypeScoreShortfall: byTypeScoreShortfall,
        shortageCount: shortageCount, shortageScore: shortageScore,
        allocatedScore: allocatedScore, perTypeScore: perTypeScore, byTypeWantScore: byTypeWantScore,
        poolExhausted: poolExhausted,
        ignoredInvalid: poolRes.invalid.length, ignoredDuplicates: poolRes.duplicates.length,
        invalid: poolRes.invalid, duplicates: poolRes.duplicates,
        warn: notes.length ? notes.join('；') : null
      }
    };
  }

  /* 让"逐题型目标"适配**这份题库的实际构成**：题库里一道都没有的题型，目标一律置 0。
   *
   * 为什么必须做：内置默认是 单10/多2/判4/简2。碰上没有简答题的卷子，设置页会一直喊
   * "简答要 2 只有 0（缺 2）"，而用户**根本填不出这两道题** —— 那是把"出厂默认"当成了"用户的要求"。
   * 规则（只说这一条，别处不许再悄悄改用户的数）：
   *   · 只动**空题型**（该题型题库里 0 道）；有题的题型一律原值保留；
   *   · 别的字段（mode / count / targetScore / seed…）一概不碰。
   */
  function adaptPickToBank(all, cfg) {
    const c = cfg || DEFAULT_CONFIG;
    const pick = c.pick || {};
    const poolRes = buildPool(all);
    const pool = poolRes.byType;
    const srcCount = (pick.byType && typeof pick.byType === 'object') ? pick.byType : {};
    const srcScore = (pick.byTypeScore && typeof pick.byTypeScore === 'object') ? pick.byTypeScore : {};
    const num = function (v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; };
    const byType = {}, byTypeScore = {}, zeroed = [];
    TYPE_KEYS.forEach(function (t) {
      const cnt = Math.max(0, Math.floor(num(srcCount[t])));
      const sc = Math.max(0, num(srcScore[t]));
      const empty = (pool[t].length === 0);
      if (empty && (cnt > 0 || sc > 0)) zeroed.push({ type: t, byType: cnt, byTypeScore: sc });
      byType[t] = empty ? 0 : cnt;
      byTypeScore[t] = empty ? 0 : sc;
    });
    const out = deepClone(c);
    out.pick = out.pick || {};
    out.pick.byType = byType;
    out.pick.byTypeScore = byTypeScore;
    return {
      config: out,
      changed: zeroed.length > 0,
      zeroed: zeroed,
      poolByType: TYPE_KEYS.reduce(function (o, t) { o[t] = pool[t].length; return o; }, {}),
      poolSize: poolRes.total
    };
  }

  /* 答案文本（**唯一实现**，住在计分层：题型知识属于这里）。
   * 多选题用「、」分隔 —— 与"用户作答"的显示口径一致（同一张卡片里一边 `A、B`、
   * 另一边 `AB` 会让人以为答案不一样）。错题本详情页与回看卡片都读它。 */
  function answerText(q) {
    if (!q) return '';
    if (q.type === '单选') return (q.answerLetters || [])[0] || '';
    if (q.type === '多选') return (q.answerLetters || []).slice().sort().join('、');
    if (q.type === '判断') return q.judgeValue === true ? '对（√）' : (q.judgeValue === false ? '错（×）' : '（答案待人工确认）');
    return (q.keywords || []).map(function (k) { return k.text; }).join('、');
  }

  return {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    resolveConfig: resolveConfig, lockConfig: lockConfig, unlockConfig: unlockConfig,
    deepMerge: deepMerge,
    answerText: answerText,
    // 三层取值的公开工具（本小类新增）
    isPlainObject: isPlainObject, deepClone: deepClone,
    mergeConfig: mergeConfig, snapshotConfig: snapshotConfig, configSources: configSources,
    LAYER_BUILTIN: LAYER_BUILTIN, LAYER_GLOBAL: LAYER_GLOBAL, LAYER_EXAM: LAYER_EXAM,
    // 配置字段模型与校验（分值项建模）
    CFG: CFG, CONFIG_FIELDS: CONFIG_FIELDS, CONFIG_FIELD_MAP: CONFIG_FIELD_MAP,
    RANGE_PAIRS: RANGE_PAIRS, SOURCE_LABELS: SOURCE_LABELS, getPath: getPath,
    validateConfig: validateConfig, applyConfigPatch: applyConfigPatch,
    applyGlobalPatch: applyGlobalPatch, pathsOf: pathsOf, RANGE_MEMBER: RANGE_MEMBER, fieldModelGaps: fieldModelGaps,
    configPreview: configPreview, displayConfigValue: displayConfigValue,
    validateGlobalPatch: validateGlobalPatch,
    TYPE_KEYS: TYPE_KEYS, POINTS_MAX: POINTS_MAX, AUTO_NEXT_MS_MAX: AUTO_NEXT_MS_MAX,
    unitPoints: unitPoints,
    scoreOne: scoreOne, scoreExam: scoreExam, levelOf: levelOf, normalizeJudge: normalizeJudgeLocal,
    pickQuestions: pickQuestions, adaptPickToBank: adaptPickToBank, mulberry32: mulberry32, shuffle: shuffle,
    PICK_MODES: PICK_MODES, PICK_PREFER: PICK_PREFER, RANDOM_BASIS: RANDOM_BASIS,
    normText: normText, toSet: toSet, setEq: setEq
  };
});
