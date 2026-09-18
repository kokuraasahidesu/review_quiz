# 契约冻结书（CONTRACT）

> **这是什么**：`review_quiz` 的内部设计契约 —— 字段形状、命名空间、配置模型、行为不变量，以及每处
> "为什么这么写 / 踩过什么坑"的结论。主要给**改这个仓库的人（或 AI）**看；只想用这个软件请回
> [`README.md`](README.md)。
> 本文件与 [`docs/verification-log.md`](docs/verification-log.md)（逐轮验收日志）都是**开发过程记录**，
> 不是使用文档。

> 本文件是**并行开发的前提**：所有模块只按这里写的签名与形状对接，谁都不许私自改。
> 改动契约 = 走「修改」流程回审，不许就地改。

---

## 一、五类结构（已冻结 · `core/schema.js`）

```js
Exam = {
  id, schemaVersion:1, title, createdAt, updatedAt,
  config: object|null,        // 形状与默认值归 quiz.js 管，schema 只校验是对象或 null
  configLocked: boolean,      // true = 配置已快照固化，全局改动不影响本卷
  questions: Question[]
}

Question = {
  id, type,                   // type ∈ 单选|多选|判断|简答（只有这四类）
  stem, options,              // options: [{label,text}] | null
  answer, answerLetters,      // answerLetters: string[] | null（选择题才有）
  judgeValue,                 // true|false|null（判断题才有；null=歧义待校对，不判分）
  keywords,                   // [{text, via}] | null（简答题才有；via=加粗/高亮/字体色/底纹/自动(需校对)/手动）
  explanation, difficulty,    // difficulty: 1-5 | null
  review: string[],           // 需人工确认的问题清单（空数组=无）
  inTextBox: boolean          // 来自 Word 文本框
}

ExamConfig   → 形状由 quiz.js 定义（schema 不重复定义默认值）
Record       → { at, examId, score, full, percent, level, correctCount, total, per[] }
WrongEntry   → { qid, times, lastWrongAt }
```

### ⚠️ 归一化规则（下游**必须**照此处理，别踩空）

| 字段 | 选择题 | 判断题 | 简答题 |
|---|---|---|---|
| `options` | **数组**（可直接 map） | `null` | `null` |
| `answerLetters` | **数组** | `null` | `null` |
| `judgeValue` | `null` | `true/false/null` | `null` |
| `keywords` | `null` | `null` | **数组**（可直接 map） |

**规则：`null` 表示"该题型不适用"，不是"空数组"。**
所以 UI 里**不要写** `q.options.map(...)`，要写 `(q.options || []).map(...)` 或先判题型。
（这条是相邻锚对照时发现的隐患，已在回归里钉死：判断题的 options 必须是 null、单选题的 keywords 必须是 null。）

---

## 二、应用全局状态（单一真相源 · 已冻结）

```js
AppState = {
  schemaVersion: 1,
  secrets:   { apiKey, provider, model },   // 独立分区：永不进任何导出
  settings:  { config, ui:{theme,lastExamId} },
  exams:     { [examId]: Exam },
  index:     { examIds:[], updatedAt },     // 轻量索引，避免启动时全量加载
  session:   Session|null,                  // 当前这一轮（易失可恢复）
  wrongbook: { [examId]: { [qid]: WrongEntry } },
  records:   { [examId]: Record[] },
  runtime:   { backendStatus, degraded, usageBytes }   // 只读运行时态
}
```

**两条硬规则**
1. **core 层拿不到 AppState**：配置/数据一律靠参数传进去 → 保证纯函数、可 Node 测、可并行。
2. **只有 `app/actions.js` 能改状态**：UI 只派发 action。这样"锁定卷不被全局改"这类语义只需在一处守住。

**落盘分工**：exams / wrongbook / records → IndexedDB；settings / index / session → localStorage（session 节流 500ms）；secrets → localStorage 独立命名空间；导入预览草稿与弹窗开关**不落盘**。

---

## 三、模块签名（已冻结）

```js
// core/schema.js
SCHEMA_VERSION, TYPES, EXAM_FIELDS, QUESTION_FIELDS
newId(prefix, rng) / normalizeJudge(v)
createQuestion(f, {rng}) / createExam(f, {rng, now})
createWrongEntry(qid, now) / createRecord(f) / createSession(examId, ids, cfgSnap, now)
createAppState()
validateQuestion(q, exam?) → {ok, errors[], warnings[]}
validateExam(exam)          → {ok, errors[], warnings[]}
validateAppState(state)     → {ok, errors[]}
readPayload(payload)        → {ok:true, payload, version, migratedTo, applied[]} | {ok:false, error, hint}
pickFields(obj, fields)

// core/parse/*（parser-core.js 已冻结，其余待建）
parseDocx(arrayBuffer) → {meta:{source,paragraphs,textBoxParagraphs}, questions[], stats}
parseText(string)      → {meta, questions[], stats}
segment(paragraphs)    → questions[]
detectType(line)       → '单选'|'多选'|'判断'|'简答'|null
normalizeJudge(str)    → true|false|null

// core/parse/zip.js（新增 · 自研 ZIP，零依赖）
sniff(input)              → {kind:'empty'|'ole2'|'zip'|'unknown'}   // 不抛异常，供上传即判定
unzip(input)              → { [文件名]: {method, raw} }             // 异步
inflateRaw(raw)           → Uint8Array                              // 原生 DecompressionStream('deflate-raw')
readEntryText(entries, n) → string|null
fail(code, msg, hint)     → Error（带 .code / .hint）

// core/parse/docx.js（新增 · docx → 带样式段落，不做切题）
parseRuns(pXml)        → [{text, bold, italic, underline, color, highlight, shading}]
extractParagraphs(xml)→ [{text, runs, inTextBox}]      // 文本框先抽后剔除，防吞后文
readParagraphs(input)  → 同上（异步；含格式闸门）
diagnose(input)        → {ok:true, paragraphs, textBoxParagraphs} | {ok:false, code, message, hint}

// core/parse/text.js（新增 · txt 的编码层 + 兜底关键词）
decodeAuto(input, opts) → {text, encoding, hadBom, replaced, lossy, tried[]}
//   input: ArrayBuffer|Uint8Array|Buffer；传 string 视为"已解码"，encoding='given'
//   encoding ∈ 'utf-8' | 'utf-8-bom' | 'gbk' | 'given'
//   replaced = text 里 U+FFFD 的个数（>0 = 有解码损失）；lossy = replaced>0
//   任何输入都不抛异常
//   探测顺序：BOM → utf-8(fatal) → gbk/gb18030/gb2312(fatal) → utf-8(非fatal，记账损失)
decodeText(input, encodingLabel) → string
detectEncoding(input) → {encoding, hadBom, reason}
fallbackKeywords(answerText, opts) → [{text, via:'自动(需校对)'}]   // opts:{max=6,maxLen=18,minLen=2}
splitByPunctuation(s) → string[]

// core/parse/segment.js（新增 · 题型识别 / 正误归一 / 歧义标定 / 切题）
TYPE_MARKERS, TYPE_ALIASES
detectType(line)        → '单选'|'多选'|'判断'|'简答'|null
matchTypeMarker(line)   → {type, matched, rest} | null
normalizeJudge(raw)     → {value: true|false|null, reason: string|null}
judgeNeedsReview(raw)   → boolean
reviewFlags(q)          → [{id, label, text}]      // 机器可读疑点分类（面板按 id 高亮）
collectReview(qs)       → [{index, type, stem, flags}]   // 校对面板就是渲染这个
FLAG_RULES
pickKeywords(runs)      → [{text, via}]
segment(paras)          → questions[]

// parser-core.js 新增（**只增不改**：上述已冻结签名一个都没动）
parseTxtBytes(input, opts) → parseText 的返回形状 + meta.encoding/hadBom/replaced/lossy
// 手动指定题型（文件里没有题型标记 / 标记写错时用）
parseTextAs(text, {type, skipUntilNumber, force})
parseTxtBytesAs(input, {type, skipUntilNumber, force, encoding})
parseDocxAs(buf, {type, skipUntilNumber, force})
//   type             → 没有标记的题按这个题型切（**显式标记仍然优先**，除非开 force）
//   force            → 整份文件都按 type 切，文件内部的标记不可信（但仍会从题干里剥掉）
//                      ⚠️ 标着【判断】却带 A/B 选项的文件，**必须** force：
//                         不 force 时选项行会被并进题干，之后改题型也救不回选项
//   skipUntilNumber  → 只在遇到 `1.` `2、` 时开新题（跳过卷头标题）
detectType / reviewFlags / collectReview / TYPE_ALIASES / SegmentCore
// segment(paras, {defaultType, skipUntilNumber, force}) —— 不传 opts 时行为与历史完全一致

// core/exams.js（新增 · 卷册维护 / 题型分组 / 批量上传）
GROUP_TYPES = ['单选','多选','判断','简答']
groupQuestions(qs) → {单选:[{index,question}],...}    // index = **卷内下标**，不是组内下标
groupCounts(qs)    → {单选,多选,判断,简答,total,invalid}
metaOf(exam)       → {id,title,total,counts,needsReview,configLocked,createdAt,updatedAt}
createExam(store, {title,id,now,rng}) → {ok,exam,meta}     // 显式 id 撞车 → 明确报错，不静默换 id
getExam(store,id) / renameExam(store,id,title,{now}) / deleteExam(store,id,{policy})
listExams(store,{fresh,limit}) → {ok,exams:[meta],healed,total}
refreshMeta(store,id,{now}) → {ok,meta}       // 给"直接写卷本体"的外部模块收尾用
normalizeQuestions(qs, {type,rng}) → qs       // 强制题型 + applyDerived 重算 + 分配新 id
appendQuestions(store,examId,qs,{type,now,skipInvalid}) → {ok,exam,meta,added,skipped,before,after}
setQuestions(store,examId,qs,opts)
// 配置与锁定（本小类新增；setConfig 是**唯一**会改 exam.config/configLocked 的入口）
setConfig(store, examId, {config, configLocked}, {now}) → {ok,exam,meta} | {ok:false,error,hint}
lockExam(store, examId, {globalCfg, now}) → {ok,exam,meta,snapshotLeaves}
unlockExam(store, examId, {now}) → {ok,exam,meta,changed,discarded} | {ok,exam,meta,changed:false,note}
countLeaves(cfg) → number
importFiles(store,examId,[{name,kind,data,type}],{type,skipUntilNumber,skipInvalid,now})
  → {ok,examId,files,added,skipped,failed,meta,before,after,groups}
scanOrphans(store) → {ok,orphans:[{key,examId,kind}],missingBodies,examIds,alive}

// core/review.js（新增 · 导入预览 / 人工校对 / 入库确认，纯逻辑无 DOM）
TYPES, EDITABLE_FIELDS=['type','stem','answer','explanation'], KEYWORD_VIAS
createDraft(parsed, {title, now, id}) → {ok:true, draft} | {ok:false, error, hint}
setField(draft, i, field, value) / setType / setStem / setAnswer / setExplanation → {ok, draft}
addKeyword(draft, i, text, via='手动') / removeKeyword(draft, i, kwIndex) → {ok, draft}
removeQuestion(draft, i) → {ok, draft, removed}
keywordSourceLabel(via) → '手动添加' | '自动生成·需校对' | '加粗（原文样式）' | …
flagsOf(q) / needsReview(q) → boolean
visibleIndices(draft, onlyReview) → number[]
reviewStats(draft) → {total, needsReview, ok, byFlag}
commit(draft, store, {title, now, rng}) → Promise<{ok, exam, examId, count, placement}>
                                      |      {ok:false, error, hint, blocking[], errors[]}
cancel(draft) → {ok, discarded}          // **不接收 store**
examToJson(exam) / jsonToExam(text) → {ok, exam} | {ok:false, error, hint}
snapshot(v) / storeSnapshot(store) / stableJson(v)

// ui/review-panel.js（新增 · 只做渲染与事件）
SEL, CSS, injectStyle(doc)
mount(container, draft, {store, title, onCommit, onCancel, onChange, onlyReview}) → panel
// panel: render/refreshRow/getDraft/setDraft/isOnlyReview/setOnlyReview/lastResult/error
//        commit() → Promise / cancel() / on(name, fn) / rowCount() / statText() / touchHeights()

// core/quiz.js（已冻结）
DEFAULT_CONFIG
resolveConfig(global, exam) → config      // 三层取值
lockConfig(global, exam)    → exam        // 锁定：把"当前生效的完整配置"固化成快照
unlockConfig(exam)          → exam        // 解锁：config 置 null（**丢掉旧快照**）+ 标记复位
// 三层取值的公开工具（新增）
isPlainObject(v) / deepClone(v)
mergeConfig(layer1, layer2, …) → config   // 从左到右依次覆盖（第 1 层兜底）
snapshotConfig(cfg) → config              // 独立深拷贝，用来固化"此刻生效的配置"
configSources(global, exam) → { 'points.单选': 'builtin'|'global'|'exam', … }
LAYER_BUILTIN / LAYER_GLOBAL / LAYER_EXAM
deepMerge(base, over) → config            // 深合并（深拷贝语义）
// 配置字段模型与校验（分值项建模 · 新增）
CFG                                       // 错误码表 E_CFG_* / W_CFG_*
CONFIG_FIELDS                             // 29 项 [{path,label,group,kind,min,max,int,values,valueLabels,unit}]
CONFIG_FIELD_MAP / TYPE_KEYS / SOURCE_LABELS / RANGE_PAIRS / RANGE_MEMBER
getPath(obj, 'a.b.c') / pathsOf(v)        // ☆ 口径与 CONFIG_FIELDS 一致：数组/空对象算叶子
validateConfig(cfg) → { ok, errors[], warnings[] }
//   校验**合并后的整份生效配置**（跨层组合出的"上下限颠倒"只有这样才能查到）
//   error/warning 形状 { path, label, code, message, hint }
applyConfigPatch(base, patch, opts) → { ok, config, errors[], warnings[], rejectedPatch? }
//   单卷补丁：校验"合并结果"，不通过就**不返回 config**
validateGlobalPatch(currentGlobal, patch, opts) → 同 applyConfigPatch
applyGlobalPatch(currentGlobal, patch, opts) → { ok, config, effective, warnings[], preexisting[], errors[], rejectedPatch? }
//   全局补丁：补丁**只为自己写到的字段负责**（错误路径正好是补丁写的叶子、
//   或补丁写在错误路径**下面**、或是区间对的另一侧）→ 才拦；
//   历史数据里躺着的非法值只报 preexisting（看得见但不拦，否则用户永远改不完）
//   config = 要存起来的（部分覆盖，只含用户改过的项）；effective = 默认 ⊕ config
displayConfigValue(field, v) → '5 分' / '开' / '偏严（strict）' / '0 组同义写法'
configPreview(global, exam) → [{path,label,group,kind,unit,value,display,values?,valueLabels?,source,sourceLabel,editable,locked}]
fieldModelGaps() → { unregistered[], orphanFields[] }   // 字段模型自检（比"遍历默认配置"更早发现问题）
scoreOne(q, userAnswer, cfg, opts) → {score, full, correct, detail, cfgWarn?}
//   opts.manualHits:[关键词] / opts.manualScore:数字 —— **人工订正**的受控入口（简答）：
//   命中集合 = 自动判定 ∪ 人工标记，之后**仍走同一套算分公式**；manualScore 受满分与半步粒度约束
//   detail 按题型（供界面展示与人工订正，**整对象可深比较**）：
//     单选 { want, got }
//     判断 { want:true|false|null, got:true|false|null, raw, ambiguous, wantAmbiguous }
//     多选 { want[], got[], hit[], wrong[], miss[], wantCount, gotCount, mode?, ratio? }  ← 数组一律已排序
//          （答案键为空时多一个 unscorable:'noAnswerKey'）
//     简答 { hit[], miss[], hitCount, total, ratio, norm, matchMode, scoreMode }
//          （无关键词时多一个 unscorable:'noKeywords'）
//   ⚠ score/full **一律落在 0.5 的整数倍**（配置侧 multiple:0.5 拦 + 计分侧 roundHalf 兜底）
//   ⚠ 缺项落回内置默认 + 数值兜底：喂 {points:…} / {} / 脏值（'abc'、Infinity、NaN）都不崩、不产 NaN
scoreExam(qs, answers, cfg, opts) → {score, full, percent, level, correctCount, total, per[]}
//   opts.manual = { <题 id>: { hits, score } } → 整卷重算也走同一条路（per[].manual 标出被订正的题）
//   answers 省略/null → 按全 0 判（不崩）；per[].detail 与 scoreOne 逐字段一致
pickQuestions(all, cfg) → { questions, meta }
//   questions：真题目对象数组（**无 null / 无重复 id**）
//   顺序：byCount/byWeight 按题型分块（单选块→多选块→判断块→简答块）；random 为随机顺序
//   meta = { mode, modeFallback, basis, seed, requested, requestDetail{count,byType,byTypeScore,scorePerType,targetScore},
//            picked, poolSize, poolByType, byType, byTypePoints, totalPoints,
//            targetScore, unused, byTypeShortfall, byTypeScoreShortfall, shortageCount, shortageScore,
//            allocatedScore, perTypeScore, byTypeWantScore,
//            poolExhausted, ignoredInvalid, ignoredDuplicates, invalid, duplicates,
//            defaulted[], warn }
//   · requested = **题数**口径的目标（按分数的规则没有题数目标 → null，不许拿 0 冒充）
//   · byTypeShortfall[t] = { want, got, gap, pool }，**只含真有缺口的题型**
//   · shortageCount = Σ gap（不是"要求总数 vs 整库题数"）；shortageScore = 分数口径缺口
//   · defaulted = 哪些字段没写、落回了内置默认（与三层取值同语义，见第十七章）

// core/data.js（已冻结）
createStore({small, large, threshold, namespace}) → Store
//   small: 同步后端（localStorage 风格）getItem/setItem/removeItem/key/length
//   large: 异步后端（IndexedDB 风格）get/set/del/keys（返回 Promise）；可为 null = 单后端模式
//   threshold: 单条记录**超过**这个 UTF-8 字节数才走 large（默认 200KB）
//              ⚠️ 用 opts.threshold != null 判断，不要写 `|| 默认值` —— 阈值 0 是合法配置
//   Store: { namespace, placement(key), set(key,value), get(key), del(key), keys(), usage(),
//            keysWithPrefix(prefix), purgeByScope({exact,prefix}), purgeExam(id, opts) }
//   set 返回 { where:'small'|'large', bytes, indexPersisted, reason? }
//     reason: 降级原因（配额满 = 'quota'，其它异常 = 错误名 e.name）
// 命名空间与键前缀（**唯一真相源** —— 任何地方都不许手拼 '::'）
NS_SEP='::', NS_GLOBAL='app', NS_RECV_PREFIX='recv_', INDEX_MARK='__index__'
KEY_EXAM='exam', KEY_RECORD='record', KEY_WRONG='wrong'
receiverNamespace(examId) → 'recv_<id>'
examBodyKey(id) → 'exam::<id>'          // 精确键（不是前缀）→ 挡住 A / A2 串号
examSubPrefix(id) → 'exam::<id>::'      // 带尾分隔符 → 同样挡住串号
examSubKey(id, name) / recordKey(id) / wrongKey(id) / examScopeOf(id)
prefixedKey(ns,key) / nsOf(fullKey) / keyOf(fullKey) / isInNamespace(fullKey,ns) / indexKeyOf(ns)
assertSafeNamespace(ns)                 // ns 含 '::' 直接抛（否则前缀隔离会被撑破）
capacityReport(qs, limitBytes, compress) / synthQuestions(n)
findSecrets(obj) / sanitizeSharePayload(state, {examId})
embedPayload(html, payload) / extractPayload(html)

// core/ai.js（已冻结）
PROVIDERS, PROMPTS
buildChatRequest(provider, opt) → {url, headers, body}
safeParseJson(raw) → {ok, value, strategy, fixes[], raw}
repairJson(s) / extractFields(t) / validate(task, obj) / classifyError(err, status)
estimateTokens(text) / callAi(fetchImpl, provider, opt, hooks)

// core/flow.js（已冻结 · 行为开关与展示时机）
REVEAL_VALUES=['each','end'] / REVEAL_LABELS / DEFAULT_REVEAL='end'
BASIS_VALUES=['count','score'] / BASIS_LABELS / PICK_MODE_LABELS / PICK_MODES / GRADE_LEVELS
COUNT_STEP=1 / SCORE_STEP=5 / COUNT_MAX=999 / SCORE_MAX=1000
revealPolicy(cfg) → { answer, explain, answerLabel, explainLabel, answerEach, explainEach,
                      explainGatedByAnswer, fallback[], summary }
revealAt(cfg, ctx) → { answer, explain, showAnswer, showExplain, policy, reasons[] }
//   ctx = { submitted, finished, phase:'answering'|'reviewing'|'finished' }
afterSubmit(cfg, ctx) → { autoCheck, autoNext, checked, finished, actions[], reveal,
                          needsManualSubmit, willJump, waitMs, jumpLabel, delayFallback, notes[] }
//   ctx = { answered, checked, finished, phase }
//   actions ⊂ ['check','needsManualSubmit','revealAnswer','revealExplain','next']（顺序固定）
//   waitMs = 要跳的话"等多少毫秒再跳"（0 = 立刻）；不跳时**恒为 0**
//   ★ 整个答题流程的**唯一真相源**：界面不许自己判断"要不要跳/要不要揭示/等多久"
gradeLevel(percent, cfg) → { level, percent, pass, excellent, levelIndex, toPass, toExcellent, note }
gradeBands(cfg) → [{level, from, to, toInclusive}]   // 左闭右开，最后一档含 100
countControl(cfg, opts) → { mode, modeLabel, basis, basisLabel, count, targetScore, byType, byTypeTotal,
                            byTypeScore, byTypeScoreTotal, perTypeScore, types,
                            min, max, step, scoreStep, affectsPick, hint, notes[] }
typeAlloc(cfg) → { mode, modeLabel, basis, isScore, allocKey, total, notes[],
                   rows: [{ type, kind:'count'|'score', id, label, value, unit:'题'|'分',
                            step, min, max, implied, unitPoints }] }
//   ★ 逐题型分配的唯一真相源（界面只读它）：按题型数量 → 单位「题」；按题型总分 → 单位「分」。
//     `step` 在分数档 = **该题型每题分值**（按一下正好一道题的分，凑分能精确落地）；
//     每题 0 分的题型：步长退回 1、`implied = null`、备注里点名（不许编一个数字糊弄）。
//     `implied` 是只读换算（≈ 几题），不回写配置。
setTypeValue(cfg, kind, type, value, opts) → { ok, kind, type, value, mode, modeChanged, patch, config, errors[] }
bumpTypeValue(cfg, kind, type, delta, opts) → { ok, …, value, step, atMin, atMax, clamped, modeChanged }
//   ⚠ 写逐题型的值时**一并把 mode 切到对应规则**（byCount / byWeight），并如实回报 modeChanged ——
//     否则"值写进去了、抽取规则还是别的"，界面点了等于没反应（与 setBasis 同一条教训）。
bumpCount(cfg, delta, opts) → { ok, value, clamped, atMin, atMax, basis, patch, config, errors[] }
setCount(cfg, value, opts) → 同上（value 按当前口径写入 count 或 targetScore）
setBasis(cfg, basis, opts) → { ok, basis, switchedMode, patch, config, errors[], note }
//   ⚠ mode 不是 random 时会**一并切到 random**（口径只在完全随机下有效，否则"点了没反应"）
setMode(cfg, mode, opts) / setGrade(cfg, which, value, opts) / bumpGrade(cfg, which, delta, opts) / setReveal(cfg, which, timing, opts)
//   bumpGrade：面板分数线行的 +/- 动件（步长 5、clamp 到 0~100；早先面板发 `grade.pass+` 而
//   quickAction 只认 `grade.pass` → 两个按钮是**死控件**，组级红队抓出）
setBehavior(cfg, which, on, opts) → { ok, which, value, patch, config, errors[] }
applyQuick(cfg, patch, opts) → { ok, config, warnings, patch, errors[] }   // 一律走 QuizCore.applyConfigPatch
quickAction(cfg, {id, value}) → 同上；id ∈ count+|count-|count|score+|score-|score|basis|mode|
                               answerTiming|explainTiming|autoCheck|autoNext|autoNextMs|
                               byType.<题型>[+|-]|byTypeScore.<题型>[+|-]|
                               grade.pass|grade.excellent
quickModel(cfg) → [{ group, rows:[{kind:'stepper'|'choice'|'toggle', id, label, value, enabled?, …}], notes[] }]
//   ⚠ 抽题那一组的行**随规则显隐**（不是置灰）：按题型数量 / 按题型总分 → 摆四行逐题型控件；
//     完全随机 → 才摆「题量口径 + 本轮题量 / 目标总分」。
//   `enabled:false` = 这一项现在没意义（stepper 与 choice 都会置灰）；notes 里**不要写 markdown 记号**

// ui/quick-panel.js（底部快捷面板 · 只画不判断）
QuickPanel.CSS / CSS_ID
QuickPanel.mount({ container, config, onChange(next,result), onError(result), inline, collapsed, doc })
  → { el, destroy, refresh(config), config(), stats() → {clicks, changes, errors} }

// core/attempt.js（已冻结 · 一次作答的会话状态 = 作答界面的大脑）
TYPES / INPUT_KIND {单选:single,多选:multi,判断:judge,简答:text} / TYPE_LABEL
isAnswered(q, value) → bool                  // 四型各自的"算不算答了"★
normalizeAnswer(q, value) → stored           // 简答**原样保留多行**；多选排序；单选取首字母
answerText(q) → 'A' / 'AB' / '对（√）' / '关键词、关键词'
createSession({ questions, config, title, examId, startedAt }) → session（**可变**对象）
PROGRESS_VERSION / progressKey(examId, roundTag?)   // 键走 DataCore.examSubKey（**不手拼**）
serializeProgress(session) / checkProgress(payload, questions) / restoreProgress(session, payload)
createProgressStore(store, { examId, roundTag? }) → { key, mode(), isDegraded(), lastError(), notice(), save(session), load(questions), clear() }
current(session) / goto(i) / next() / prev()
answer(session, value) → { ok, stored?, error?, locked? }    // 提交后锁定
reset(session, i?) → 解锁某题（人工订正/重做的入口）
submitCurrent(session) → { ok, result, flow, reveal, advanced, error?, needAnswer?, already? }
finish(session, opts) → { ok, summary } | { ok:false, needConfirm:true, unansweredLabels, message }
//   ⚠ 有未答题且没传 `confirmUnanswered:true` → **不结算**（题号导航小类加的门禁）；
//     强制结算时 summary.forced=true 且 summary.skipped 记下跳过的题号
//   summary = scoreExam + FlowCore.gradeLevel（+ answered/unanswered/skipped/forced）
progress(session) → { index, total, answered, checked, unanswered, percent }
view(session) → 渲染模型（**唯一给界面的数据**；答案文本只在允许揭示时非空）
navModel(session) → [{ index, label, answered, checked, current, revealed, correct, state }]
//   state = current | answered | unanswered（互斥，便于上色）；**当前题高亮优先于"未答"底色**
//   ⚠ correct 只在**答案已允许揭示**时才给值 —— 否则索引格里打勾叉等于提前泄露每题对错
displayAnswer(q, value) → 给人看的作答写法（多选用「、」分隔、简答多行原样）
reviewList(session) → 交卷后的逐题回看（未交卷返回 []）
//   [{ index,label,type,typeLabel,stem,answered,userAnswer,userRaw,correctAnswer,correct,score,full,
//      detail,explanation,unscorable,cfgWarn }]
resultModel(session) → 成绩单（未交卷返回 null）
//   { score,full,percent,level,correctCount,total,answered,skipped,forced,pass,excellent,toPass,toExcellent,
//     note,bands[],byType[{type,total,correct,score,full,rate}] }
gate(session) → { ok, unanswered[], unansweredLabels[], message }
//   交卷前校验：有未答 → ok:false 并列出题号（界面据此弹"返回继续 / 仍然交卷"）
setConfig(session, nextConfig) → { ok, session, policy }     // 面板改参数 → **立即生效**

// ui/attempt-view.js（作答界面 · 只画不判断）
AttemptView.CSS / CSS_ID
AttemptView.mount({ container, session, onChange, onSubmit, onFinish, mountPanel, doc })
  → { el, destroy, refresh(), session(), setSession(next), stats() → {submissions, reveals} }
```

---

## 四、并行开发的合同（子 Agent 必读）

1. **只准碰自己那一个** `core/**.js`（或 `ui/<你的视图>.js`）+ 自己的 `verify/<模块>.test.js`。
2. **不许碰**：`app/`、`index.html`、别人的模块文件、本契约。
3. **必须自跑测试并附原始输出**（贴命令行输出，不是"我测过了"）。
4. **不许引外部依赖**：单文件离线可用是硬需求，全部自研或用浏览器原生 API。
5. 交付格式：`文件路径 + 测试文件路径 + 原始测试输出 + 一句话说明契约未变`。

---

## 五、版本门禁（已冻结行为）

| 情况 | 处置 |
|---|---|
| 缺 `schemaVersion` | **拒绝** + 提示"请用本应用重新导出" |
| 类型非法（如 `"v1"`） | **拒绝** + 提示文件可能损坏 |
| 版本 **高于**程序 | **拒绝** + 提示升级程序 |
| 版本低但迁移规则缺失 | **拒绝** + 提示升级路径未实现 |
| 版本低且有迁移规则 | 逐级迁移，返回 `applied[]` |

**铁律：绝不静默当新格式处理。**

---

## 六、加载顺序与构建（新增 · 硬约束）

单文件离线版是把所有 `core/*.js` **内联进 `<script>`** 得到的，所以模块间的
依赖在浏览器里靠"书写顺序 + 全局挂载"解决，**顺序写错会当场抛异常**（不允许静默降级）：

```
core/parse/zip.js      →  root.ZipCore
core/parse/docx.js     →  root.DocxCore      （依赖 ZipCore）
core/parse/text.js     →  root.TextCore      （零依赖叶子模块，位置随意）
core/parse/segment.js  →  root.SegmentCore   （依赖 TextCore）
parser-core.js         →  root.QuizParser    （依赖上面四个，必须最后）
core/schema.js         →  root.SchemaCore    （零依赖）
core/data.js           →  root.DataCore      （零依赖）
core/quiz.js           →  root.QuizCore      （零依赖：默认配置 / 三层取值 / 计分 / 抽题）
core/flow.js           →  root.FlowCore      （依赖 QuizCore：展示时机 / 行为开关 / 分数线）
core/wrong.js          →  root.WrongCore     （依赖 SchemaCore + DataCore + QuizCore：误答本 + 分卷视图模型）
core/exams.js          →  root.ExamsCore     （依赖 SchemaCore + DataCore + QuizParser + SegmentCore）
core/text-format.js    →  root.TextFormatCore（依赖 SchemaCore + DataCore + ExamsCore + SegmentCore）
core/review.js         →  root.ReviewCore    （依赖 SegmentCore + SchemaCore）
ui/review-panel.js     →  root.ReviewPanel   （依赖 ReviewCore，只做 DOM）
ui/quick-panel.js      →  root.QuickPanel    （依赖 FlowCore，只做 DOM；`data-qp="<路径>=<值>"` 是点击钩子）
core/attempt.js        →  root.AttemptCore   （依赖 SchemaCore + QuizCore + FlowCore + DataCore）
ui/attempt-view.js     →  root.AttemptView   （依赖 AttemptCore + QuickPanel，只做 DOM）
ui/wrong-view.js       →  root.WrongView     （依赖 WrongCore，只做 DOM）
ui/delete-dialog.js    →  root.DeleteDialog   （零依赖模块，只吃询问模型，只做 DOM）
core/ai.js             →  root.AiCore       （依赖 DataCore：供应商能力表 / 密钥本地化 / 请求构造 / 输出容错）
ui/ai-settings.js      →  root.AiSettings   （依赖 AiCore，只做 DOM）
ui/ai-single.js        →  root.AiSingle     （依赖 AiCore + ReviewCore，只做 DOM）
ui/ai-scene.js         →  root.AiScene      （依赖 AiCore，只做 DOM：整卷总评 / 举一反三）
```

五个产出页面内联的核心集合不同（构建器只校验**该页面里实际存在**的核心的相对顺序）：

| 产出 | 内联的核心 |
|---|---|
| `解析器Demo.html` | zip → docx → text → segment → parser-core |
| `浏览器自检.html` | 全部 22 个（含 exams / text-format / review / quick-panel / attempt / wrong / wrong-view / delete-dialog / ai / ai-settings / ai-single），按上表的依赖顺序 |
| `校对面板.html` | zip → docx → text → segment → parser-core → schema → data → quiz → exams → review → review-panel → **ai → ai-settings → ai-single → ai-scene** |
| `答题页.html` | 解析核心 → schema/data/quiz/flow/wrong/**exams** → quick-panel/attempt/attempt-view → **ai/ai-scene** |
| `错题本.html` | 解析核心 → schema/data/quiz/flow/wrong/exams/text-format → quick-panel/attempt/attempt-view/**wrong-view**/**delete-dialog** → **ai/ai-scene** |

> `ui/wrong-view.js` 依赖 `core/wrong.js`，`ui/delete-dialog.js` 由页面自己接（它只吃询问模型），
> 所以两者都必须排在各自依赖之后（`build.js` 的 `ORDER_MUST` 管这条）。

> ⚠️ **内联顺序 = 依赖顺序，排错了浏览器里会当场抛「依赖缺失」**：
> `data.js` 必须排在 `exams.js` / `text-format.js` **之前**（后两者 require DataCore），
> `exams.js` 又必须排在 `text-format.js` 之前。
> `build.js` 的 `ORDER_MUST` 会对产物逐个校验这条顺序（只校验该产物里实际存在的核心）。

- **别手拼 HTML**：改完 `core/` 一律 `node build.js` 重新生成。
  构建器会自检：占位符无残留 / 顺序正确 / `</script` 已转义 / 产出 JS 能过语法编译。
- 转义规则：内联时把 `</script` 换成 `<\/script`（JS 里 `\/` 就是 `/`，运行时等价）。
  注意 `<script`（无斜杠）**不需要**转义——`core/data.js` 生成分享包时本来就要拼这个字符串。
- **危险组合**：script 数据里若出现 `<!--`，再碰上字符串里的 `<script`，
  HTML 解析器会进入 double-escaped 状态导致真正的 `</script>` 失效。产物里禁止出现 `<!--`。
- 产出：`解析器Demo.html`、`浏览器自检.html`、`校对面板.html`、`答题页.html`、`错题本.html`，并同步桌面副本。

---

## 七、回归入口（任何人改完都要跑）

```bash
node build.js                               # 构建 + 构建自检（改过 core/ 必跑）
node verify/schema.test.js                  # 53 条：结构/校验/id/版本/全局状态
node verify/schema-parser.contract.test.js  # 24 条：相邻接口对照（含 1000 题性能）
node verify/docx.test.js                    # 49 条：docx 通道（闸门/文本框穿透/关键词来源）
node verify/text.test.js                    # 205 条：txt 编码层（三种编码/行尾/边界/UMD 双分支）
node verify/txt-integration.test.js         # 70 条：txt 集成 + 相邻锚（schema 往返/review 说真话）
node verify/segment.test.js                 # 144 条：题型识别/正误归一/歧义标定/选项数/面板契约/**真实题集分节写法**
node verify/review.test.js                  # 214 条：校对面板逻辑（编辑/筛选/入库/取消 + 组级三类歧义端到端）
node verify/storage.test.js                 # 107 条：双后端路由（阈值边界/大字段/配额降级/keys/删两侧）
node verify/namespace.test.js               # 111 条：命名空间隔离（共用后端/删单卷/前缀真相源/分享互斥）
node verify/exams.test.js                   # 168 条：卷册增删改查/分组视图/批量上传/手动指定题型/两条删除路径
node verify/config.test.js                  # 111 条：三层取值/深拷贝隔离/来源标注/边界形状
node verify/lock.test.js                    # 89 条：快照固化/锁后隔离（含计分不变）/解锁脱钩/落盘
node verify/scoring.test.js                 # 143 条：分值项建模（字段模型/校验拒绝/持久/跨层/预览/来源双向核对）
node verify/picking.test.js                 # 122 条：抽题策略（三规则/逐题型目标分/可复现/缺口口径/脏题库/相邻锚）
node verify/flow.test.js                    # 175 条：展示时机/自动开关/翻页等待/分数线/快捷面板/逐题型分配（含泄露哨兵与真值表）
node verify/grade.test.js                   # 188 条：四型计分执行（分支数值/明细深比较/11088 次粒度扫描/归一唯一性）
node verify/attempt.test.js                 # 67 条：作答会话与渲染模型（四型作答/多行简答/面板立即生效/泄露面逐格对齐 + **真挂载：选项与输入框必须出现在界面上**）
node verify/nav.test.js                     # 54 条：题号导航（逐格定位/状态实时/交卷门禁三段式）
node verify/result.test.js                  # 47 条：成绩结算（手算固定样本/边界定档/逐题回看）
node verify/progress.test.js                # 68 条：进度暂存与恢复（真刷新/交卷清理/降级内存态/卷变拒绝/**轮次标记互不覆盖**）
node verify/manual.test.js                  # 61 条：简答人工订正（改判换档/痕迹可见/只动一题/撤销复原）
node verify/wrong.test.js                   # 62 条：误答自动收集与计数（进本判定/累加/答对不删/幂等/归属 + **孤儿误答本：答过但没入册的卷也要能被认出来**）
node verify/wrongview.test.js               # 42 条：分卷归集与详情（分组计数/详情逐字段对照/卷改卷删/stale/跳转下标）
node verify/wrongview-ui.test.js            # 45 条：错题本**视图装配**（挂载/选中/刷新取最新卷/禁用跳转/destroy，配 verify/mini-dom.js）
node verify/delete-cascade.test.js          # 119 条：删卷级联询问（询问模型/拒绝执行/两条路径键扫描/归属标识/异步后端/墓碑写失败/弹窗与真挂载）
node verify/wiring.test.js                  # 66 条：**页面接线**锚（答题页自动收集 / **导出按钮走唯一入口且真的落盘** / **接收者空间切换与脏卷 id 挡板** / **开页存储体检与顶部告警** / **错题本捞孤儿误答本** / 错题本先问后删 / 无静默删除旁路 / 保留记录可见 / 校对面板 AI 面板与单题智能）
node verify/export-html.test.js             # 87 条：独立 HTML 生成（零外部引用双向证 / 断网打开即加载 / Blob 落盘与文件名 / 多份互不覆盖 / 相邻锚）
node verify/receiver-isolation.test.js      # 61 条：接收者隔离（receiverNamespaceFor + 内容指纹 / 卷 id 撞名不串 / 出题者 app 空间零改动 / 双文件命名空间扫描 / 清空后重开 / 判分口径跟着卷走）
node verify/offline-degrade.test.js         # 70 条：断网可用与内存态降级（逐模块零网络调用 / 离线全链路 / storageHealth 四态 / 坏存储全链路 + 实话提示 / 四类失败场景可读提示）
node verify/narrow-layout.test.js           # 40 条：窄屏与触屏布局（viewport/流体护栏/34 条 min-height ≥44px / 375px 实测数字快照 / 安卓选文件与下载 / 面板工具条不横向溢出 / 题库列表按钮）
node verify/ai-keys.test.js                 # 105 条：密钥与供应商能力表（密钥本地化/刷新仍在/能直接调用/能力标注/分享零命中/界面）
node verify/ai-single.test.js               # 100 条：单题智能生成（解析含易错点/变式四件套/难度整数/结构拒绝不落库/一次点击一次请求/界面）
node verify/ai-scene.test.js                # 97 条：整卷点评与举一反三（简报带真实记录/反套话闸门/先确认再发/新题一键入卷进对应分组/两面板）
node verify/ai-tolerant.test.js             # 175 条：容错与提示（12 类脏输出零异常/三类失败专用分类/批量先确认零请求/估算口径与偏差判据/批量面板）
node verify/share-payload.test.js           # 286 条：脱敏打包（字段白名单递归剔除/零命中双向证/特殊字符结构与往返/完整性判分等价/出厂闸门/残留自检/同义词表/
                                            #        键名文本扫描/无分号数字引用/注释掩码与未闭合注释拒绝/单一载荷块定位器/半截开标签）
node verify/group-config.test.js            # 59 条：**L1「配置系统与锁定」组级验收**（真实 store→ExamsCore→解析题库 端到端）
node verify/group-answer.test.js            # 37 条：**L1「答题与判分」组级验收**（真实样卷→会话→进度→成绩→改判 端到端）
node verify/text-format.test.js             # 308 条：结构化文本格式（语法/错误码/行号/往返）
node verify/text-format-integration.test.js # 146 条：真实产物往返 + 跨模块锚 + 存储快照 + 手工编辑健壮性
node verify/persistence.test.js             # 28 条：**跨进程**持久化（文件后端，父进程写→子进程读）
node verify/inline-order.test.js            # 123 条：**六个**成品 HTML 的内联顺序 + 浏览器式沙箱
node test.js                                # 30 条：解析器
node verify.js                              # 150 条：计分/抽题/AI容错/存储/分享
node verify/app-shell.test.js               # 57 条：答题全能版（一个文件三个面板 / 页面标记零重复 id / 作用域化 document / 切页签刷新（含 __answerRefresh）/ 不复制逻辑 / 合并版也能当分享壳 / **导入→答题三条链** + **抽题接通**）
```

当前全绿：**30 + 150 + 105 + 97 + 100 + 175 + 57 + 124 + 111 + 119 + 49 + 168 + 87 + 175 + 188 + 37 + 59 + 123 + 89 + 61 + 111 + 40 + 54 + 70 + 28 + 122 + 68 + 61 + 47 + 214 + 24 + 53 + 143 + 144 + 286 + 107 + 146 + 308 + 205 + 70 + 68 + 62 + 45 + 42 = 4622 条断言**（44 个文件）。

⚠ **上面这行台账以 `node verify/run-all.js` 的输出为准**（它会现场重跑并把这一行原样打出来）。
早先这里是**手抄**的，抄错了两处：文件数写成与实际不符、"44 个文件"里其实把 `test.js` / `verify.js`
算进去了却没在别处说清；另有几条数字与文件对不上号。台账手抄=不可复现，已改为脚本产出。
（`run-all.js` 只认每个文件末尾那一行 `PASS n  FAIL n` 汇总；任何 FAIL、任何非零退出、
任何"连汇总行都没有"都算失败并非零退出 —— 它第一次跑就抓住了 `narrow-layout` 的 4 条 FAIL，
见下面"窄屏取证工具自身的两个缺陷"。）

### 第三十六章相关：`attempt.test.js` 的 ⑤ 节（19 条）

"去掉提交按钮"是**行为变更**，所以断言跟着换语义并**加固**：
没有 `data-av="submit"`、交卷是 `av-fab` 且角标跟着未答数走、题号可折叠（非回看收起/回看展开）、
选项带 ✓ 角标、点一下即记录但**未提交**（时机=end）、**离开该题也不提前判分**、
回到该题仍能改答案、时机=each 时离开即自动提交、成绩页有圆环（`--p`）与刻度条、
底部快捷面板**挂载后重绘仍在**（这条正是上面第 1 个缺陷的回归锚）。
**另有真调用证据**：`node verify/real-ai.js` 跑 5 段真操作（解析/变式/难度/整卷总评/举一反三）+ 3 题真批量，
并把**估算 vs 实耗**写进 `verify/real-ai-last.json`：单题解析 5.1%、整卷总评 8.6%、批量 3 题 21.9%（阈值 60%）。
另有 `浏览器自检.html` 的 A–R 十八节在**真浏览器**里跑：
G 节（面板触屏 + 真实 localStorage 的"取消不写/确认才写"）、H 节（结构化往返 + 卷册）、
**I 节（跨刷新持久化，两阶段：写入 → F5 → 复核）**、**J 节（快捷面板：触屏尺寸 + 点击→配置改动）**、**K 节（作答界面：375px 无横向滚动 + 点击区 ≥44px + 面板改动不跳页即生效）**、**L 节（作答进度：写入 → F5 → 复核恢复与交卷清理）**、**M 节（错题本：真交卷收集 → 分卷分组 → 详情现读原题/答案/解析 → 跳回原卷；卷改/卷删两条反向对照）**、**N 节（删卷询问：真弹窗/遮罩铺满/≥44px/取消不写盘 → 两条路径的真存储断言与收尾清理）**，
以及 E 节（真实浏览器的 GBK 解码）、**O 节（AI 密钥：界面填入 → F5 → 复核仍在且能直接用保存的 Key 发起调用）**、
**P 节（单题智能：三类操作各 1 次请求、脏结构不落草案）**、**Q 节（整卷点评与举一反三：先确认后发、入卷进分组）**、
**R 节（容错与提示：12 类脏输出 / 三类失败分类 / 批量先确认）**—— 那部分 Node 替代不了。

> `verify/persistence.test.js` 值得单独说：它**不用"新建一个 store 实例再读一遍"**来冒充持久化
> （那只证明没有内存缓存）。它起**真正的第二个进程**（`node verify/persistence.test.js --child`）去读
> 上一个进程用**文件后端**写下的数据，子进程把结论写进 result.json 由父进程核对 ——
> 绕开本机"禁止用命名管道捕获子进程输出"的限制。反向对照：清空磁盘后同一子进程必须报失败。
（`build.js` 的自检不单独计条数，它失败会直接以非 0 退出码终止构建。）

> `verify/inline-order.test.js` 值得单独说：它不重读源码，而是从**构建出来的成品**里
> 抠出内联代码，丢进一个"没有 `module`、只有 `self`"的 vm 沙箱里跑
> —— 也就是浏览器的真实处境。Node 里 `require` 全绿 ≠ 双击 HTML 能用，
> 这条就是补这个缺口的。它还带反向验证：故意颠倒顺序、或漏内联某一个核心，
> 都必须当场抛「依赖缺失」。
>
> `verify/txt-integration.test.js` 里的**相邻锚**抓到过一个真实隐患：
> `core/schema.js` 的 `createQuestion` 对**缺少 `via` 的关键词默认填 `'手动'`**。
> 也就是说，兜底关键词一旦在传递途中丢了 `via`，就会**伪装成人工标记**。
> 所以契约要求：自动化产生的关键词必须**显式**带 `via: '自动(需校对)'`，
> 且该值经 `createQuestion` 往返后必须不变。
>
> 简答题的 `review` 也由此冻结了三条互斥分支（`review` 是给用户看的，必须说真话）：
> 1. 切出了兜底关键词 → `'简答关键词为自动生成·需校对（原文档无加粗/高亮/颜色标记）'`
> 2. **有**参考答案但切不出候选（整段过长/无标点）→ `'简答有参考答案，但自动切不出采分关键词…需人工填写采分点'`
>    （早期这里谎报"也没有答案"，会把用户引向错误方向 —— 已由 `verify/txt-integration.test.js` ⑦ 钉死）
> 3. **没有**参考答案 → 先由通用规则推 `'没有识别到答案'`，再补 `'简答没有关键词（该题也没有参考答案）'`

---

## 八、题型识别与歧义标定（已冻结行为 · `core/parse/segment.js`）

### 题型标记文法

| 形态 | 例子 | 规则 |
|---|---|---|
| 带括号（宽松） | `【单选】` `[多选]` `（判断）` `(简答)` | 括号自带边界，四类别名全部允许 |
| 带冒号（**收敛**） | `单选题：` `判断题：` `简答题：` | **别名必须带「题」字** |
| **段头（整行只有题型名）** | `一、单选题` `二、多选题` `三、判断题` `（四）简答题` `第3部分 多选` `单选题` | 可带中文/阿拉伯序号、括号序号、`第 N 部分`；**整行必须只有这个标记** |
| 可选题号前缀 | `1.【单选】` `2、[多选]` `3) （判断）` `4．单选题：` | 三种形态都允许前缀 |

**为什么冒号形态必须带「题」字**：`判断` 既是题型名也是常用动词。
裸写 `判断：地球是圆的` 到底是不是新题，光看一行分不出来 ——
早期版本会把它当标记，**把上一题的题干腰斩**。
所以：宁可少认一种写法，也不许切错题。`判断：` / `单选：` / `论述：` 一律**不认**。
**段头形态同理只认「带题字」的写法**：`单选题` / `多选题` / `判断题` / `简答题` / `是非题` / `问答题` / `论述题` / `单项选择` / `多项选择`；
裸的 `单选` / `判断` 仍然**不算**标记（一个孤零零的"判断"更像题干）。

**为什么要补段头形态**（用户实测报障）：真实题集绝大多数是分节写法
（`一、单选题` 一段、`二、多选题` 一段…），而原先只认括号与冒号 → **整份文件切出 0 题**。

### 节内断题（段头的配套规则）

段头只说明"这一节是什么题型"，节内通常**不再逐题写题型**。所以节内允许三种边界信号，
**且都只在"当前题已经写完"（有答案 / 有解析 / 判断题题干自带 √×）时才生效** ——
这样"多行题干 / 多行解析"永远不会被腰斩：

| 信号 | 形态 | 覆盖的文件 |
|---|---|---|
| 题号 | `1.` `2、` `3)` 开头的新行 | 多选/判断节常见（题与题之间没有空行） |
| 空行 | 空行之后的整行文字（**简答题除外**） | 单选节常见（题干不编号，靠空行分隔） |
| 前瞻 | 这一行后面紧跟一行新的 `A.` 选项 | 既没空行也没题号的连排文件 |

**简答题不参与"空行分题"**：它的参考答案本身就是自由文字，里面完全可能有空行与新段落。

### 一行多选项 / 判断题尾答案

- **一行多选项**：`A.甲 B.乙 C.丙 D.丁` → 拆成 4 个选项（真实题集极常见）。
  只认**依次递增**的标签（起始字母由已有选项数决定），跳号（`A` 后面直接 `C`）与居中出现的标签都不拆。
- **判断题尾答案**：`我国大陆海岸线长约2.2万千米。（×）` → 取 `×` 当答案并把括号从题干剥掉。
  只认明确的正误符号（`√ ✓ × ✗ 对 错 正确 错误`）；**空括号 `（　）`（待作答的括注）不算答案**。

### 切题的安全网（宁可疑点，不许静默丢数据）

- 段头会开出一个**空壳题**（它自己没有题干）。若整节一道题都没有，空壳**必须被丢掉**，不能变成"没有题干的假题"。
- 一题出现**第二行 `答案：`** → 不再静默覆盖：保留第一行，并挂疑点
  `这一题出现了第二行「答案：」…`（以前第一题的答案会被悄悄换掉，界面上完全看不出来）。
- 题干里出现**整行**的 `答案：` 或题号行（多为面板里手改题干、把漏切的题贴回去）→ 挂疑点
  `题干里似乎混进了下一题…`。这条**由题干内容派生**（不是一次性标记）：题干改干净后疑点自己消失；
  只是**引用**了"答案："（不在行首）不算，不许误报。

**铁律：只见显式标记或上述三种节内信号才开新题。** 无信号的行只会并入当前题题干；
整份无标记、无题号、无空行的说明文字导出的题数必须是 **0**，不是"N 行 N 题"。

### 判断题正误归一（`normalizeJudge` → `{value, reason}`）

顺序：整串精确匹配 → 问句式否决 → 否定式取反 → 正/误并存判歧义 → 短串(≤8字)子串兜底 → 否则 `null`。

- **12 种规格写法**：`√ 对 正确 T True 是` → true；`× 错 错误 F False 否` → false
- **否定式按语义取反**：`不正确/不对/不是/非正确` → false；`没错` → true
  （早期实现把「不正确」判成 **true** —— 判反，已由 `verify/segment.test.js` ②-B 钉死）
- **问句式否决**：含 `是否/与否/能否/可否` → `null`（`正确与否` 不是答案）
- **正误并存**：`对错` → `null`
- **子串兜底刻意排除单字**：`是`/`否`（"是否"里含）、`t`/`f`/`x`/`y`/`n`/`1`/`0`（"test"里有 t）
- **长度上限**：整串 > 8 字时只认精确匹配，长句里的正/误词不当依据

### 歧义政策（唯一正确姿势：不猜）

`value === null` ⇒ 该题 `judgeValue = null`，进 `review`，**计分侧恒给 0 分且不看用户作答**
（`core/quiz.js: scoreOne` 的 `want !== null && got !== null` 保证）。
已知后果（如实记录，交由后续小类处理）：这类题仍占满分分母，学生会拿不满 100 分，
需要在"分卷归集/行为开关"或人工改分环节决定是改分还是删题。

### 疑点分类 id（校对面板按 id 高亮，**不许靠猜中文文案**）

| id | 含义 |
|---|---|
| `judge-ambiguous` | 判断题答案歧义或无法识别，待人工校对 |
| `judge-missing` | 判断题没有答案 |
| `no-answer` | 整题没有识别到答案 |
| `too-few-options` | 选择题选项少于 2 个，可疑 |
| `choice-no-answer` | 选择题没有答案 |
| `multi-one-answer` | 多选题只有 1 个正确答案 |
| `keywords-auto` | 简答关键词为自动生成，需校对 |
| `keywords-missing` | 简答缺采分关键词 |
| `maybe-unsplit` | 题干里似乎混进了下一题（可能漏切题）/ 出现了第二行「答案：」 |

> **维护约定**：`review` 里新增中文措辞时，**必须**同步 `core/parse/segment.js` 的
> `FLAG_RULES`，否则面板会漏高亮。`verify/segment.test.js` ③-B 会断言枚举与分类一致。

---

## 九、校对入库面板（已冻结行为 · `core/review.js` + `ui/review-panel.js`）

### 分层

```
core/review.js      纯逻辑：草案 / 编辑 / 筛选 / 入库 / 取消     ← Node 可测，170 条断言
ui/review-panel.js  只做渲染与事件，规则一行都不写              ← 真浏览器验（自检页 G 节）
```

**为什么这么切**：DOM 层没法在 Node 里可靠地测（本机 Edge headless 产出 0 输出，已实测）。
把规则全放进纯逻辑层，DOM 层就只剩"有没有画出来、点得动点不动"。

### 三条硬规则

1. **`commit()` 是唯一会写 store 的函数。** 编辑操作只改草案，一个字节都不落盘。
   入库前先逐题 `validateQuestion` + 整卷 `validateExam`，**任何一步不过就不写**，
   并把"是哪几题卡住了"放进 `blocking[]` 返回（面板据此跳转），绝不默默少存。
2. **`cancel()` 不接收 store** —— 从签名上就不可能产生副作用。验收用"前后快照逐字节相等"证明。
3. **编辑后必须重算派生字段**：`core/parse/segment.js` 的 `applyDerived(q)` 是**唯一**实现
   （切题与面板共用）。否则会出现"界面显示已改、判分还是旧的"。
   `applyDerived` 只清理**它自己派生**的 review 文案，用户手写的与别的模块塞的一律保留。

### 编辑语义（易踩，写死）

| 操作 | 语义 |
|---|---|
| 改题型 | 清掉新题型不适用的字段（`options`/`answerLetters`/`judgeValue`/`keywords`），再走 `applyDerived` |
| 改答案 | **作废自动生成的关键词**（`via='自动(需校对)'`）并按新答案重算；`手动` 与原文样式（加粗/高亮/字体色/底纹）来的关键词**保留** |
| 单选答案写多个字母 | 只取第一个（`AB` 是录入失误，不该变成多选语义） |
| 加关键词 | `via` 默认 `'手动'`；重名拒绝；非简答题拒绝 |
| 删题 `removeQuestion` | 校对时的"这题不要了"。**必须有**：选项内容编辑不在本小类范围，而 0 选项的选择题永远过不了结构校验，没有这个出口用户会被卡死 |
| 改题干为空白 | 拒绝（`ok:false`），草案保持原值 |

### 面板层约定

- 打字时**不整表重绘**（`input` 只更新草案），失焦 `change` 才刷新该行 —— 否则光标会被吞掉。
- 所有用户可见文本走 `textContent`；`innerHTML` 只用于**清空**与**静态骨架**（`verify/review.test.js` ④-F 静态扫描钉死）。
- 触屏：所有点击目标最小高度 44px、控件字号 ≥16px（避免 iOS 聚焦自动缩放）。
  筛选框的 `checkbox` 本身 20px，真正的点击目标是包着它的 `<label>`（≥44px）——
  量尺寸时别把 checkbox 当目标，那是误报。
- **防重复入库**：`panel.commit()` 有**同步**的 in-flight 闸（连点两下"确认入库"会写出两份卷子）。
  逻辑层的语义是"一次确认 = 一份卷子"，防连点是面板的职责。
- **一键折叠（`SEL.fold`，就在「只看待校对」右边）**：大卷一进来可能有几百张卡片。
  待校对的题**默认展开**（要改的正是它们），其余折叠；所以工具条给了一个**双向**按钮：
  - 标签描述**点下去会发生什么**，判据是"**有没有**开着的"（不是"是不是全开着"）：
    有开着的 → 显示「全部折叠」；一张没开 → 显示「全部展开」。
    ⚠ 早先按"是否全开"判，于是"只开了一张"时标签写着「全部折叠」、点下去却是**展开** —— 界面在骗人（自检页抓出来的）。
  - 状态**不额外记**，每次从 DOM 现算 → 用户手点某一张卡之后标签也是对的。
  - 纯视图动作：**不改数据、不发 `change`**；空列表时置灰；44px 触控高度、`flex:0 0 auto` 不抢宽度。
- **一键到底部 / 回到顶部（`SEL.jump`，紧挨着「全部折叠」）**：240 张卡片用手指划到底要划半天。
  同一个套路：**双向按钮**，标签说明点下去会发生什么（不在底部 → 「到底部」；已在底部 → 「回到顶部」）。
  - **瞬间跳，不做平滑动画**：平滑滚 240 张卡要一秒多，那时用户已经在怀疑"点了没反应"。
  - ⚠ **真正在滚的不一定是列表**：面板被放进"没有限定高度"的宿主时（合并版就是这样），
    `.qp-list` 会长到内容那么高（实测 `scrollHeight == clientHeight == 33610`），**由页面来滚**。
    所以按钮认的是"**实际能滚的那一层**"（`scroller()`：列表能滚就用列表，否则用 `scrollingElement`）——
    自检页里宿主有限高 → 列表在滚；合并版里页面在滚；两种都对。
  - 标签在 `scroll`（列表与 window 两处）与 `render()` 后现算；宿主"由隐藏变可见"时由
    `review-template.html` 的 `window.__reviewRefresh`（app-template 早就留了这个钩子，之前一直是空的）重算一次 ——
    隐藏时 `clientHeight` 是 0，量出来的可用性会假。

### 范围声明

- **选项内容编辑不在本小类**（只读展示）。需要改选项时先删题或改题型。
- **完整的 txt/JSON 题库导入导出不在本小类**。`examToJson` / `jsonToExam` 是**面板自查用的卷子快照**
  （走 schema 版本门禁），正式导入导出属「试卷导入导出txt」小类。
- 存储快照用的 `stableJson` 会排序键名 —— 键序不同的等价对象也要能逐字节比较。

---

## 十、双后端路由（已冻结行为 · `core/data.js` 的 `createStore`）

### 落点规则

| 条件 | 落点 | `set()` 返回 |
|---|---|---|
| `bytes <= threshold` 且同步后端写成功 | `small`（localStorage） | `{where:'small', bytes, indexPersisted}` |
| `bytes > threshold`（阈值是"**超过**才切"，等于阈值仍走同步） | `large`（IndexedDB） | `{where:'large', bytes, indexPersisted}` |
| 同步后端**抛任何异常**且存在异步后端 | `large`（降级） | `{where:'large', bytes, indexPersisted, reason}` |
| 同步后端抛异常且**没有**异步后端 | 抛出 | 异常向上冒泡（**不许静默丢数据**） |

`reason` 的取值：配额类异常 → `'quota'`（判据 `/quota/i` 匹配 `e.name + e.message`）；其它异常 → 真实错误名（如 `'SecurityError'`）。

### 两条容易写错的地方（都已由 `verify/storage.test.js` 钉死）

1. **索引是"落点提示"，不是数据本体，写不动不能算失败。**
   配额满时连 `ns::__index__` 都可能写不下。若让索引写入的异常冒出去，
   "配额满"这个场景本身就会把 `set()` 打挂 —— 而数据其实已经安全落到异步后端了。
   所以索引一律 best-effort（`writeIndexSafe`），并用 `indexPersisted:false` 如实上报。
2. **`get()` 必须容忍索引缺失或过期。**
   索引记着 `small`、数据其实在 `large`（索引没更新成功）时，
   只看索引指向的那一侧会**返回 null —— 数据还在却读不出来，等于丢数据**。
   所以 `get()` 先走索引快路径，未命中就**两端都找一遍**；
   判空一律用 `!= null`（存进去的 `0 / false / ''` 都是合法值，不能被真值判断吃掉）。

### keys() 与 del()

- `keys()` 汇总**两个后端**（异步后端按 `ns::` 前缀过滤，同步后端按 `ns::` 前缀扫描），
  内部索引键 `__index__` **不出现在结果里**，别的命名空间的键不会串进来。
- `del(key)` **同时清理两侧**（同步 `removeItem` + 异步 `del`）并删掉索引条目。
  两侧**同时存在**同一个键（历史遗留/半途迁移）时也必须都清掉。
  索引写不动时删除照样成功 —— 该清的已经清了。

---

## 十一、命名空间隔离（已冻结行为 · `core/data.js` 前缀规则）

### 为什么必须有

`file://` 下**所有本地 HTML 共享同一份 `localStorage` / `IndexedDB`**。
两个分享文件若各写各的、键名又一样，就会互相串数据。隔离**只能靠前缀**。

### 空间划分

| 空间 | 命名空间 | 放什么 |
|---|---|---|
| 全局 | `app`（`NS_GLOBAL`） | 全局设置、落点索引、各卷本体与子键 |
| 接收者本地 | `recv_<examId>`（`receiverNamespace`） | 作答记录、错题、会话 —— **分享文件只写这里** |

### 键的前缀规则（唯一真相源，调用方不许手拼 `'::'`）

```
exam::<id>            卷本体（**精确键**）
exam::<id>::<name>    卷的子键（前缀带尾分隔符）
record::<id>          作答记录
wrong::<id>           错题
index                 全局空间里的落点索引（每个命名空间各一份：<ns>::__index__）
```

**为什么要区分"精确键"与"带尾分隔符的前缀"**：卷 id 可能是 `A` 与 `A2`。
若卷本体也用前缀 `exam::A` 去匹配，`purgeExam('A')` 会连带删掉 `A2`。
所以本体用精确匹配、子键用 `exam::A::`（尾分隔符挡住 `exam::A2::x`）。

### 删除单卷

`store.purgeExam(examId, {includeRecords})`
- 只删**这一卷**的本体 + 子键；`includeRecords:true` 时才连带删该卷的 `record::`/`wrong::`。
  **级联政策属「删卷级联询问」小类**，这里只提供机制、不替用户做决定。
- 同步维护落点索引：只把该卷 id 从 `index.examIds` 摘掉，别的卷与全局设置一律不动。
- `examId` 为空/null → **空操作**（绝不变形为"清光所有卷"）。
- `purgeByScope({prefix:['']})`（空前缀）→ **拒绝**，返回 `{ok:false}`。
- `createStore({namespace})` 若命名空间含 `'::'` → **直接抛错**。
  否则 `ns='a'` 会把 `'a::b::k'` 认成自己的（`isInNamespace` 命中），隔离被静默撑破。

### 分享路径的同一条规则
出题者与接收者用**同一套函数**推前缀：
`sanitizeSharePayload` → `embedPayload` 把卷 id 放进分享 HTML →
接收者 `extractPayload` 取出 id → `receiverNamespace(id)` 得到自己的空间。
载荷里**连 `records`/`wrongbook` 的字段名都不出现**（不是留 `null`），
所以"接收者的记录不会进入出题者的命名空间"这条可以靠 `isInNamespace` 双向为假来断言。

---

## 十二、卷册维护与分组上传（已冻结行为 · `core/exams.js`）

### 落盘结构

| 键 | 内容 | 为什么 |
|---|---|---|
| `exam::<id>` | 完整 Exam（含 questions） | 卷本体；超过阈值会自动落异步后端 |
| `exam::<id>::meta` | `{id,title,total,counts,needsReview,updatedAt,…}` | **轻量**。列卷册只读它，不必把所有大卷子拉进内存 |
| `index` | `{examIds:[], updatedAt}` | 全局卷册索引 |

**meta 是派生缓存**，由 `writeExam` 在每次改动后重写。
若有模块**直接写卷本体**（例如 `review.commit` 只写本体 + 索引），meta 会缺失或过期：
- **缺失** → `listExams` 自愈（从本体重算），并报 `healed:true`
- **过期** → 默认仍走缓存（这是"只读轻量 meta"的代价）；
  需要时用 `listExams(store,{fresh:true})` 或 `refreshMeta(store,id)` 修

### 四条硬规则

1. **显式 id 撞车必须明确报错**，不许"悄悄换一个 id"——调用方拿着自己给的 id 去查会查不到。
2. **追加题目一律分配新 id**：导入是"新增"，复用旧 id 会和卷内已有题撞号。
3. **结构不合法的题默认整批拒绝**（`blocking[]` 指名，不写半个卷子）；
   要"只导合法的"就传 `skipInvalid:true`（被剔除的进 `skipped[]`）。**任何情况下都不写非法数据。**
4. **删除必须显式选政策**（政策细则见**第二十三章**「删卷级联询问」，此处只列接口形状）：
   - `deleteExam(store,id,{policy:'cascade'})` —— 连该卷的 `record::`/`wrong::` 一起删 → **零残留**
   - `deleteExam(store,id,{policy:'keepRecords'})` —— 保留记录 + 写墓碑，`orphansKept[]` 里**如实列出**留了什么
   - `deleteExam(store,id,{keepRecords:true/false})` —— 旧写法，等价于上两条（兼容保留）
   - `deleteExam(store,id)` **不传政策 → 拒绝执行**（`{ok:false, needPolicy:true, prompt}`，一个字节都不写）
   三种都清掉本体 / meta / 子键 / 索引条目。用 `scanOrphans(store)` 可以独立复核"没有孤儿数据"。

### 分组视图

- `groupQuestions` 的 `index` 是**卷内下标**（不是组内下标），面板据此定位到原题。
- **题型非法的题不进任何分组**，但计入 `counts.invalid`（不瞎归类、也不静默丢掉）。
- `四组之和 + invalid === total`，这条恒等式就是"分组计数与实际一致"的判据。

### 手动指定题型（本小类新增能力）

`parseTextAs / parseTxtBytesAs / parseDocxAs` 的 `type` 只回答"**没有标记**的题按什么切"，
**显式标记仍然优先**。要让"整份文件都是 X 型、内部标记不可信"，必须加 `force:true`。

> ⚠️ **踩过的坑**：文件标着 `【判断】` 却带着 `A. / B.` 选项时，
> 按判断切会把选项行**并进题干**；之后无论怎么改题型都救不回选项了（信息已经挪走了）。
> 只有 `force:true` 会在解析阶段就按目标题型切，选项才会被正确识别。
> `core/exams.js` 的 `importFiles` 只要收到 `type` 就固定带 `force:true` ——
> 用户手动指定题型，就是在断言"这份文件整体是 X 型"。
> 代价：**混着多种题型的文件不能这么用**，那种就不指定题型、交给标记自动归类。

批量导入的另外两条：
- **一个文件坏掉不拖垮整批**：逐文件 try/catch，失败的进 `failed[]`（带 `name` 与 `code`），其余照常导入。
- **每个文件可以各自指定 `type`**（`files[i].type` 覆盖 `opts.type`），所以一批里能混不同题型。
- 全部解析完再**一次性追加**（一次本体写入 + 一次 meta 写入），避免 N 次写放大。

---

## 十三、结构化纯文本格式（`core/text-format.js`）

### 形态（实测导出，可读可手改）

```
# quiz-demo 试卷文本格式 v1
title: 计算机网络 期中模拟卷
id: exam_mu3mw4qw_49uonv
createdAt: 2026-09-17T13:00:00.000Z
updatedAt: 2026-09-17T13:00:00.000Z
schemaVersion: 1
questions: 3

## 第 1 题
id: q_mu3mw4qw_1er09s
type: 单选
stem: HTTP 默认端口？
options:
  |A. 21
  |B. 80
answer: B
keywords: null
explanation: HTTP 用 80。
difficulty: null
inTextBox: false
review: []

## 第 3 题
type: 简答
answer: 客户端发送 SYN；服务器回复 SYN+ACK
keywords:
  |[自动(需校对)] 客户端发送 SYN
  |[自动(需校对)] 服务器回复 SYN+ACK
review:
  |简答关键词为自动生成·需校对（原文档无加粗/高亮/颜色标记）

# ===== 整卷配置（标准 JSON，可手工编辑；导入时按结构校验）=====
config: {"points":{"单选":2,"简答":5}}
configLocked: true
```

### 冻结的接口

```js
FORMAT_VERSION, HEADER, KEYWORD_VIAS
exportExam(exam, opts) → string
importExam(text, {newIds, touch, title}) → {ok,exam,warnings,lines} | {ok:false,errors:[{line,code,message,hint}],summary}
importToLibrary(store, text, opts) → Promise<{ok,exam,meta} | {ok:false,errors,blocked:true}>
diagnose(text) → {ok, errors, formatVersion, questionCount, title}
```

### 五条硬规则

1. **导入的顺序是 `applyDerived` → `createQuestion`，不许颠倒。**
   实测：颠倒会让非简答题的 `keywords` 从 `null` 变成 `[]`，**"逐字段无差异"直接不成立**。
2. **`importExam` 不接收 store** —— criterion ③ 的"失败不破坏已有数据"有一半是**结构性**保证。
   另一半由 `importToLibrary` 承担：**先解析 + 逐题校验 + 整卷校验，全部通过才写**。
3. **错误必须可定位**：每条错误带 `line`（1 起）与稳定 `code`。
   码表：`E_NO_HEADER / E_BAD_VERSION / E_EMPTY / E_NO_TITLE / E_UNKNOWN_TYPE / E_FEW_OPTIONS /
   E_BAD_ANSWER / E_DUP_OPTION / E_BAD_KEYWORD / E_BAD_ESCAPE / E_BAD_CONFIG / E_BAD_DIFFICULTY /
   E_TRUNCATED / E_BAD_STRUCTURE / E_DUP_ID / E_INVALID_QUESTION / E_INVALID_EXAM / E_NO_STORE`
   配套警告码：`W_FEW_OPTIONS / W_LETTER_NOT_IN_OPTIONS / W_DUP_OPTION`。
4. **默认（不传 `newIds`/`touch`）= 逐字段完全还原**，含 `id` 与 `createdAt`/`updatedAt`。
   `newIds:true` 当副本导入（卷与题目都换新 id）；`touch:true` 才把 `updatedAt` 更新。
5. **`config` 里的中文保持字面量**，不许整体转义成 `\uXXXX` ——
   否则"可读且可手工编辑"这条要求就落空了。安全的必要转义（如 `<` → `\u003c`）可以保留。

### "结构损坏"与"语义可疑"必须分开（已裁定的口径）

验收②点名的三类是「缺字段 / 未知题型 / 结构错乱」—— 这些是**文本结构损坏**，一律**硬拒且可定位**。

而 `选项少于 2 个` / `答案字母不在选项内` / `选项标签重复` / `没有答案` / `判断题答案无法识别`
这些是**解析器自己就会产出**的状态，**默认接受并给 `W_*` 警告**，只有传 `opts.strict:true` 才升级成
`E_FEW_OPTIONS` / `E_BAD_ANSWER` / `E_DUP_OPTION`。

**为什么默认不能报错**（两条独立理由，都已实测）：
1. 验收①要求"**任意**试卷导出后再导入完整还原"，而 `【单选】零选项题？/答案：A` 这种卷子
   正是解析器的正常产物（默认口径下实测逐字段完全还原）。默认报错会让验收①对它失效。
2. 更早小类已冻结**相反方向**的要求：这类题要"标为可疑"而不是拒绝，
   且组级标准要求它们"在预览面板中可被人工修改后入库"。

### 转义规则（五个）

`\\`→反斜杠、`\n`→换行、`\r`→回车、`\t`→制表、**`\s`→半角空格**；其它 `\x` 一律报 `E_BAD_ESCAPE`。
`\s`/`\t` 只用在**落在行尾的那段内容**上，于是两种空白被区分开：
**内容自带的尾随空白 = 转义后的 `\s`/`\t`（保真）**；**手抖多敲的尾随空白 = 裸空白（被容错吃掉）**。

### 读入的容错（手工编辑过的文件必须照样能导入）

- **开头一个 U+FEFF 会被剥掉**（记事本的「UTF-8」长期默认带 BOM；`core/parse/text.js` 的 txt 通道本来就剥）。
  只剥一个：`\uFEFF\uFEFF…` 的第二个算内容 → 仍报 `E_NO_HEADER`；只有 BOM → `E_EMPTY`。
  `importExam` / `importToLibrary` / `diagnose` 走同一个解析器，口径必然一致。
- **每行右侧的 ASCII 空格与制表符在结构识别前被去掉**（字段名、空值判定、`|` 前缀、`## 第 N 题` 一视同仁）。
  **不去 U+3000（全角空格）** —— 判断题干「（　）」里的全角空格是内容，去掉就是吃内容。
- 文件末尾缺换行、CRLF、BOM+CRLF+行尾空格的组合都要能吃。

### `questions: N` 是完整性校验（像 Content-Length）

靠它把"题块被截断"变成可定位的 `E_TRUNCATED`；
否则从题块边界截断的文本会静默变成一份"少了几题"的合法卷子。

### 已知的唯一有损面（如实记录，未放宽判据）

`answerLetters` / `judgeValue` **与 `answer` 不一致**的历史对象无法还原 —— 因为导入端一律从 `answer` 重算。
同理，`review` 里"长得像派生文案但不会被重算"的条目会被剥掉，非规范化的 `review: []` 会被补上。
**前提是应用自身的管线永远从 `answer` 派生**（`segment()`→`parser-core`、`review.commit`、
`exams.appendQuestions` 都是），所以真实试卷里这些字段恒自洽 —— 这三类只对"手搓的 JSON"成立。

### `review` 字段的定位

它**不是权威值，只是喂给 `applyDerived` 的输入种子**：导出写全量；导入先当种子，`applyDerived`
剥掉派生文案再重算。于是"手改答案后旧提示不会残留"与"用户手写的条目照旧保留"能同时成立
（仓库里已有这种数据：`verify/schema-parser.contract.test.js` 会往 review 里 push
`'题型为自动识别，请确认'`，不存它那份卷子往返必然丢信息）。

---

## 十四、配置系统：三层取值与合并（已冻结行为 · `core/quiz.js`）

### 三层优先级

```
内置默认 DEFAULT_CONFIG  ←  全局设置 globalCfg  ←  单卷设置 exam.config
（低优先级，兜底）                                  （高优先级，逐键覆盖）
```

| 卷的状态 | 取值 |
|---|---|
| **未锁定**（`configLocked !== true`）且有自己的 config | 默认 ← 全局 ← 单卷，三层逐键合并。**改全局，它跟着变**（"继承最新值"） |
| **未锁定**且没有自己的 config | 等于"全局生效值"（`mergeConfig(globalCfg)`） |
| **已锁定**（`configLocked === true`）且有 config | **只读自己的 config**，缺项落回**内置默认**（**不读全局**） |
| 已锁定但没有 config | 等于全局生效值（没有快照可锁，只能按未锁定处理） |

> **锁定为什么必须"不读全局"**：需求是"锁定后该试卷配置不可被全局设置覆盖"。
> 若锁定后仍去读全局，之后改全局就会**悄悄改掉这份锁定卷** —— 违背锁定语义。
> 想保留"锁定那一刻的全局值"，请在锁定时调 `lockConfig()` —— 它拍的是**完整快照**。

### 合并规则（`deepMerge`，已冻结）

- 两边都是**普通对象** → 递归逐键合并（只覆写上层写了的键）
- 其它情况（含**数组**）→ 上层的值**整体替换**下层
- 上层的值是 **`undefined` 或 `null`** → **跳过**（视为"这一层没写"）
  - `null` 为什么也跳过：配置里没有哪个项"必须是 null"（`DEFAULT_CONFIG` 里一个 null 都没有），
    而放行 null 会**抹掉整个配置块**。实测过：`{points:null}` 会让 `cfg.points` 变成 `null`，
    随后 `scoreOne` 读 `cfg.points[q.type]` **直接 TypeError 崩掉**。宁可当"没写"。
- 结果与任何输入层（含内置默认）**不共享任何嵌套引用**

### 深拷贝是硬要求（曾经真的坏了）

`resolveConfig` / `mergeConfig` / `snapshotConfig` / `deepClone` 的结果都必须是**完全独立**的深拷贝。

> **踩过的坑**：旧 `deepMerge` 用 `Object.assign({}, base)` 做浅拷贝，且只在上层"也写了该键"时才递归 ——
> 于是缺省的嵌套键**共享引用**。实测 `resolveConfig(null,null).points['单选']=999`
> 会把 `DEFAULT_CONFIG` 真的改成 999，**之后所有试卷的默认分值都跟着错**。
> 既有 `verify.js` 只测了优先级与锁定语义，**深拷贝这条从未被断言**，所以它一直活着。
> 现在由 `verify/config.test.js` ③ 用"**递归篡改整个返回值**"的方式钉死，并带反向对照。

### `configSources`：把"继承自哪一层"变成可断言的东西

`configSources(globalCfg, exam)` → `{ 'points.单选': 'builtin'|'global'|'exam', … }`
- **一律下钻到叶子**，消费者只处理一种粒度；数组与标量算叶子（与"整体替换"语义一致）
- **唯一例外：`short.synonyms` 本身就算叶子**（里面的键是用户数据「关键词 → 写法」，不是配置项）。
  早先它被当容器下钻到 `short.synonyms.SYN`，于是这一项自己**没有来源条目** →
  `configPreview` 那一行静默错显成 `builtin`（工具说谎）。
- 某一层用**非对象**整体替换了一个配置块（例如 `{points:5}`）→ 那一项自己算叶子，标出该层
  （早先这里会凭空产出 `points.单选` 并错标成 `builtin`，等于工具说谎）
- 与 `null`/`undefined` 的处理一致：视为"没写"
- 自洽不变式：**标注说来自哪层，值就必须真的等于那层的值**（`verify/config.test.js` 逐路径核对）
- 第二条不变式：**来源表的键集合 ≡ 字段模型**（`verify/scoring.test.js` ⑤-C 双向核对，带反向对照）

---

## 十五、快照固化与脱钩（已冻结行为 · `QuizCore.lockConfig/unlockConfig` + `ExamsCore.lockExam/unlockExam`）

### 锁定：固化"锁定那一刻的完整配置"

`lockConfig(globalCfg, exam)` 按 `configLocked:false` 求出**当时生效的完整配置**并深拷贝成快照。
于是快照**没有任何空洞**：
- `DEFAULT_CONFIG` 的每一个叶子路径在快照里都存在（`verify/lock.test.js` ②-A 逐条核对 29 条）
- `configSources` 对快照的标注**只有 `exam`、没有 `builtin`**（有 builtin 就说明有洞）
- 全局里"多出来"的键（默认配置里没有的）也会一并固化
- 快照里不存在 `undefined` 叶子

同时它**尊重该卷已有的单卷配置**：快照 = 默认 ⊕ 全局 ⊕ 该卷自己的部分配置
（所以一份写过 `单选=33` 的卷锁定后，快照里就是 33，而不是全局的 5）。

### 脱钩：锁定后全局怎么改都不影响它

`resolveConfig` 对"已锁定 + 有快照"的卷**不读全局** → 配置逐字节不变，
**据此产生的计分与抽题结果也不变**（`verify/lock.test.js` ① 深比较整个 `scoreExam` 结果，含 `per` 明细与 `level`）。
反向对照：同一份卷不锁定时改全局，计分结果**确实会变**（11 → 247.5），证明"不变"是真观察到的。

### 解锁：**必须丢掉旧快照**

`unlockConfig(exam)` 把 `config` 置 **null** 并复位 `configLocked`。
只把 `configLocked` 改回 false 而留着快照是**假解锁** —— 那份完整快照会以"单卷设置"的身份
继续覆盖全局，用户改了全局却发现这份卷没跟着变。
代价：快照**无法再从试卷里取回**（`Exam` 结构是冻结的，没地方放它）；
`ExamsCore.unlockExam` 会把丢掉的那份**回传给调用方留档**。

### 三处必须挡住的陷阱（都已实测 + 断言）

1. **"锁定但没有快照"是矛盾态**：这种卷 `configLocked=true` 却 `config=null`，
   `resolveConfig` 会退化成"按未锁定处理"→ **照样读全局**。用户以为锁住了，其实没有，且完全静默。
   → `setConfig` **拒绝**该组合并提示改用 `lockExam()`。
2. **对未锁定的卷调 `unlockExam` 不许清掉它的单卷配置**：早先的实现会清成 `null` 且 `discarded` 报 `null`
   —— 既丢数据又不告知。→ 现在**无操作**（`changed:false`，配置原样保留）。
3. **重复锁定不会把新全局盖进来**：已有快照时再锁，`resolveConfig(global, {...exam, configLocked:false})`
   里那份完整快照就是该卷的"单卷配置"，它会赢过全局 → 快照保持原值。
   要按新全局刷新，**先解锁再锁定**（快照一旦生成就没法区分"用户写的"与"当时从全局抄的"）。

### 落盘

`setConfig` 是**唯一**会改 `exam.config` / `exam.configLocked` 的入口 —— 集中在一处才能保证
"存进去的一定是深拷贝（不与调用方共享引用）、一定过整卷校验"。
`lockExam` / `unlockExam` 都在它之上，改完立刻写盘并刷新轻量 meta（`meta.configLocked` 一并更新）。

### 派生字段在文本里的地位

`answerLetters` / `judgeValue` **不导出**（由 `applyDerived` 重算，结果与原始一致）。
`review` **导出**：因为"用户手写的 review 条目"只能靠它带过去；
`applyDerived` 会先清掉自己派生的条目再重算，所以导出的派生提示不会造成重复或冲突。

---

## 十六、分值项建模（已冻结行为 · `core/quiz.js` 的 `CONFIG_FIELDS` + 校验/预览）

### 为什么要有"字段模型"这层

分值项不能只活在 `DEFAULT_CONFIG` 的字面量里 —— 设置界面要知道每一项的**中文标签、分组、
合法范围、可选值、单位**，校验要按**逐项规则**而不是"是不是数字"来拦，预览要能写出人话。
所以 `CONFIG_FIELDS` 是分值项的**唯一真相源**（29 项），`DEFAULT_CONFIG` 的值必须与它一一对应。

```js
CONFIG_FIELDS = [
  { path:'points.单选', label:'单选题每题分值', group:'基本分值', kind:'number', min:0, max:100, unit:'分' },
  { path:'multi.halfMode', label:'多选题半对计分方式', group:'多选题', kind:'enum',
    values:['half','all'], valueLabels:{ half:'按比例给分', all:'全对才给分' } },
  { path:'short.synonyms', label:'简答题同义词', group:'简答题', kind:'synonyms' },
  { path:'behavior.autoCheck', label:'选完自动判分', group:'答题行为', kind:'boolean' },
  …
]
```

### 逐项校验规则（`validateConfig`，错误码 `E_CFG_*`）

| kind | 拒绝什么 | 码 |
|---|---|---|
| `number` | 非数字 / NaN / Infinity | `E_CFG_NOT_NUMBER` |
| `number` | `< min`（负数单独给码） | `E_CFG_NEGATIVE` / `E_CFG_OUT_OF_RANGE` |
| `number` | `> max`（比例不在 0~1、分数超 100） | `E_CFG_OUT_OF_RANGE` |
| `number` | `int:true` 但不是整数（题数/种子） | `E_CFG_NOT_INTEGER` |
| `boolean` | 不是 true/false | `E_CFG_NOT_BOOLEAN` |
| `enum` | 不在 `values` 里 | `E_CFG_BAD_ENUM` |
| `synonyms` | 不是对象；某个键不是字符串数组 | `E_CFG_NOT_OBJECT` / `E_CFG_BAD_SYNONYMS` |
| `multiple:0.5` + `max:1000` | 分值不是 0.5 的整数倍（2.25、5e-324）/ 超过上界 1000 | `E_CFG_NOT_HALF_STEP` / `E_CFG_OUT_OF_RANGE` |
| 跨字段 | 区间上下限颠倒（下限 > 上限） | `E_CFG_RANGE_INVERTED` |
| 未知键 | **只警告**（向前兼容，不拦） | `W_CFG_UNKNOWN_KEY` |
| 分值为 0 | 警告"该题型不参与计分" | `W_CFG_ZERO_POINTS` |
| 字段模型有洞 | 警告（默认里有没登记的项，或反之） | `W_CFG_FIELD_MODEL_GAP` |

三处"必须校验**合并结果**而不是补丁本身"的理由：
1. **跨层颠倒**：补丁只写 `maxRatio=0.2` 单看合法，但下限来自全局（0.8）→ 合并后才颠倒；
2. **块级整体替换**：`{points:5}` 这种补丁不会逐键逐项校验，只有看合并结果才知道 `points.单选` 成了 5；
3. **要给出精确到子键的错误路径**：`short.synonyms.SYN` 这种错误若只报在父字段上，
   责任过滤会把它误判成"历史遗留"而放行 → 非法值被**静默写入**（这是实测抓出来的真 bug）。

### 全局补丁的责任边界（`applyGlobalPatch`）

> **补丁只为自己写到的字段负责。**

历史数据里可能躺着旧版本写下的非法值。若要求"整份合法才准改"，用户每改一项都会被
"另一半还没修好"的非法值挡住 —— 永远改不完。因此错误被分成两类：

- `errors` / **blocking**：错误路径**正好是**补丁写过的叶子、**在**补丁写过的路径**下面**、
  或是区间对的另一侧（`RANGE_MEMBER`）→ 拦下，返回 `ok:false` + `rejectedPatch`
- `preexisting`：本次没碰到的非法值 → 只报出来（看得见，但不拦）

存进磁盘的是 `config`（**部分覆盖**：当前全局 ⊕ 补丁，只含用户改过的项），
不是 `effective`（默认 ⊕ config）—— 这样将来改内置默认值仍能对未覆盖的项生效。

### 设置预览（`configPreview`）

答题开始前的"设置预览"直接渲染它，每行带中文标签 / 生效值 / 显示文本 / 单位 / 可选值 /
**来自哪一层**（`source` + `sourceLabel`：内置默认 / 全局设置 / 本卷设置）/ `locked`。
- 行数**恒等于**字段数（29，随字段增长），不许有字段漏出预览（`verify/scoring.test.js` ⑤-C 断言）
- `display` 说人话：`5 分` / `开` / `偏严（strict）` / `0 组同义写法`
- **两条不变式**（任一破掉都会让设置界面说谎）：
  1. `configPreview` 每行的 `value` 与 `resolveConfig` 逐路径一致（预览显示的 = 判分用的）
  2. 每个字段都能从 `configSources` 拿到来源标注 —— 不许静默回退 `builtin`

### 字段模型自检（`fieldModelGaps`）

`CONFIG_FIELDS` ↔ `DEFAULT_CONFIG` 必须一一对应。**未登记的默认项会同时逃过校验与预览**
（用户看不到、也改不了），所以 `validateConfig` 每次都会跑 `fieldModelGaps()` 并在有洞时告警。
`verify/scoring.test.js` ⑤ 用"临时加一项没登记的 → 自检必须立刻报出来"做双向核对。

---

## 十七、抽题策略（已冻结行为 · `core/quiz.js` 的 `pickQuestions`）

### 三种规则（`pick.mode`）

| 模式 | 停止规则 | 保证什么 | 不保证什么 |
|---|---|---|---|
| `byCount` | **逐题型**指定数量 `pick.byType.*` | **各题型数量精确等于配置**（要 0 就一题不出；不够就抽光并报缺口） | 总分是多少（由分值决定） |
| `byWeight` | **逐题型**目标分 `pick.byTypeScore.*` | **每个题型各自凑到自己的目标分**（分得动的题型按"目标分 ÷ 每题分值"出题）；单型不超预算 | 全局总分恰好等于某个数（各型余数可能凑不满） |
| `byWeight`（四型全 0 = 没分配过） | 目标总分 `pick.targetScore` | **均衡填充**（老行为）：总分**不超过**目标且**贴到紧界**，分数分散在多题型 | 逐题型目标分 |
| `random` | `pick.randomBasis`：`count` 按题量 `pick.count` / `score` 按目标总分 `pick.targetScore` | 题量/分数符合口径、**无重复**、结果随机 | 题型配比（随机本来就不管配比） |

⚠ **`pick.byTypeScore` 全 0 = "用户没分配过"**，落回"按 `targetScore` 均衡填充"（老行为）。
这条不是偷懒：旧卷的快照里没有这个字段，三层取值会让它落回内置默认（全 0），
若把"全 0"读成"每型都要 0 分"，**老卷会一道题都抽不出来**。
一旦有任何一型 > 0，就只按逐题型目标分抽，此时 `targetScore` 不参与 —— 并且要在 `warn` 里
**明说"配置里的目标总分这次不参与"**（不许悄悄忽略一个用户能看见的字段）。

`byWeight` 逐题型模式的算法：对每个**目标分 > 0** 的题型，把它自己的池子洗一遍后按序尽量装，
装不下（`每题分值 > 剩余目标分`）就跳过 —— 与 `random + score` 同一条规矩：**宁可少几分，也不超预算**。
缺口按 `byTypeScoreShortfall[t] = { want, got, gap, pool, unit }` 逐题型报出，`shortageScore = Σ gap`。
`每题 0 分`的题型即使分配了分也抽不到，要在 `warn` 里点名（不许假装凑满）。

`byWeight` 的自动配比（四型全 0）仍是**均衡填充**：每一轮把"一道题"加到"加进去之后累计分最小的那个题型"，
装不下（会超预算）就停；同分时优先每题分值更大的题型，让分布更匀、更快追平。
它给出的**可证紧界**是：`抽出总分 ≤ 目标分` 且 `目标分 − 抽出总分 < 最小可抽题型分值`
（能精确凑出时必须精确命中，例如分值 2/3/1/5、目标 20 → 恰好 20）。
迭代上界 = 题库总题数（每轮必然 +1 题、每型不超过自己池子大小）→ **结构上不可能死循环**，
不需要"护栏 + 静默截断"（旧实现用固定 20000 次护栏，目标分填大就悄悄少抽且不报告）。

`random + score` 是"洗一遍后按序尽量装，装不下就跳过继续看后面的"，紧界是
`目标分 − 抽出总分 < 最大题型分值`；`meta.poolExhausted` 标出"是题库抽完了还是分值凑不出"。

### 种子与可复现（`pick.seed`）

`mulberry32(seed)` + 自己实现的 Fisher–Yates 洗牌。同配置 + 同 seed → **逐题一致（含顺序）**；
不同 seed → 不同。**`seed = 0` 是合法种子**，不许写 `pick.seed || 1`（会把 0 吞成 1）。
同理 `pick.targetScore = 0` 不许被 `|| 100` 吞掉 —— 一律用 `!= null` / `typeof === 'number'` 判。

### 缺口口径（这是本层最容易说谎的地方）

- `meta.byTypeShortfall[t] = { want, got, gap, pool }` —— **只含真有缺口的题型**。
  够的题型不许出现（否则"永远报警"也能过测试）。
- `meta.byTypeScoreShortfall[t] = { want, got, gap, pool, unit }` —— 逐题型目标分模式下的同款（按**分**）。
- `meta.shortageCount = Σ gap`（+ random 题量口径的差）。
  ⚠ **不能**用"要求总数 vs 整库题数"比大小：整库 150 题、只要 8 题，但其中多选一题都没有时，
  旧口径算出 0 → **真有缺口却完全不提示**。
- `random` 模式里"某个题型一道没抽到"**不是缺口**（抽样本来就可能漏），不许写进 `byTypeShortfall`。
- 分数口径的缺口单列 `shortageScore`：自动配比模式 `= meta.unused`；
  逐题型模式 `= Σ(byTypeScoreShortfall.gap)` —— ⚠ 此时**不能**再拿 `targetScore` 算缺口
  （那个字段根本没参与抽取，报"未能凑满目标分 100"就是胡说）。
- 所有缺口都汇成一句可读的 `meta.warn`（带逐题型数字）；**干净情况下 `warn` 必须是 `null`**。

### 脏题库：丢题不许静默

`buildPool` 按 id 去重、并挡掉无效项（`null` / 无 id / 题型不在四类里），
`meta.ignoredDuplicates` / `ignoredInvalid` / `invalid` / `duplicates` 如实报出，`warn` 里点名。
**"不出现空白题"是硬要求**：`questions` 里每一个都是真题目对象。

### 缺项落回内置默认（与三层取值同一条语义）

`pickQuestions` 允许喂**部分配置**：没写的字段落回 `DEFAULT_CONFIG.pick`，
落过哪些项记在 `meta.defaulted[]` 里，`warn` 一并说明。
⚠ 旧实现把缺项当 0：只写 `{pick:{mode:'byWeight'}}` 会**静默抽 0 题**（用户只看到"没抽到题"）。
未知 `mode` / 未知 `randomBasis` 同理：落回内置默认并在 `meta.modeFallback` / `warn` 里点名，**不猜**。

### 非空转证明器

`verify/probe-picking-old.js`（按需手动跑，不在回归清单里）把上面 5 处新行为逐个**回退成旧写法**，
确认对应的断言会变红。它靠字符串替换定位代码 —— 那几行被重构时它会直接报「探针失效」提醒重新确认。

---

## 十八、展示时机 · 作答行为 · 分数线 · 快捷面板（已冻结行为 · `core/flow.js` + `ui/quick-panel.js`）

### 为什么要单独一层 `flow.js`

这三件事散进界面代码后，最容易出的错都是**静默且致命**的：
答题期间把答案漏出去、开关关掉了却还在自动跳、分数线改了某个页面还按老线定档。
所以全部做成**无副作用纯函数**，界面只问它"现在该做什么"，自己不判断。

### 展示时机（`reveal.answerTiming` / `reveal.explainTiming`）

**二选一**（不是布尔）：`each` = 答完一题即显示，`end` = 整卷结束后显示。
默认 **`end`** ——最不泄露的那一侧。

> 兼容性：这两个字段原先是一对布尔 `reveal.answerAfterEach` / `reveal.explainAfterEach`。
> 布尔只能显示成"开/关"，用户看不出"开"到底意味着什么时候给答案，所以换成枚举。
> **老数据里的旧键不会被认识**：它会以"不认识的配置项"（`W_CFG_UNKNOWN_KEY`）报警告并原样保留，
> 但不再起作用；`answerTiming` 缺失时落回默认 `end`（= 旧 `false` 的行为）。
> 这是本契约**唯一一处已知的不兼容**，且只可能影响"演示期自己写过的配置"。

三条硬规则（`revealAt`，验收就卡这三条）：

| # | 规则 | 理由 |
|---|---|---|
| ① | **未判分的题永远不显示答案** | 显示了等于送答案 |
| ② | 时机为 `end` 时，答题期间（未 `finished`）一律不显示，**哪怕已判分** | 这是"不泄露答案"的本体 |
| ③ | **解析不得早于答案** | 解析里往往直接写着答案；两者时机矛盾时，两个都不给 |

未知时机值一律落回 `end`（绝不猜成 `each`），并在 `policy.fallback` 里点名；
`null` 按"没写"处理（与 `configSources`/`deepMerge` 同口径），**不算非法值**。

### 作答行为（`behavior.autoCheck` / `behavior.autoNext` / `behavior.autoNextMs`）

`afterSubmit(cfg, ctx)` 是**整个答题流程的唯一真相源**（界面不许自己判断）：

```
wantCheck = answered && autoCheck && !checked          // 答完自动判分
wantNext  = answered && autoNext && !finished          // **答完就翻**（跳 ≠ 判，不等判分）
immediate = wantNext && waitMs === 0                   // 立刻翻 → 由核心 submitCurrent 推进题号
waitMs    = wantNext ? autoNextMs : 0                  // >0 → 核心不动题号，界面排定时器再 next()
actions   ⊂ ['check','needsManualSubmit','revealAnswer','revealExplain','next']（顺序固定）
```

（早先这里写的是 `wantNext = isChecked && autoNext` = "判分后才翻" ——
用户明确要求"点完自动翻，不必等判分"之后**已作废**，以本文件和 `core/flow.js` 为准。）

三条容易做错的地方：
- **`autoNext` 只管"要不要跳"，`autoNextMs` 只管"等多久"**：两个都不看 `autoCheck`，
  所以"自动判分关着也照翻"是合法组合（"跳 ≠ 判"）；
- **等待时间只对"要跳"有意义**：不跳时 `waitMs` 恒为 0（界面别拿着非零值空等）；
- **两个开关都关着 → 一个动作都不做**（只有 `needsManualSubmit` 等用户点）。
- **面板上的预设档位**（`core/flow.js` 的 `AUTO_NEXT_MS_PRESETS` / `_LABELS`，升序、面板照数组顺序画）：
  **`0 立刻` / `200 0.2 秒` / `500 0.5 秒` / `1000 1 秒` / `1500 1.5 秒` / `2000 2 秒`**。
  0.2 秒那一档是用户后来要求补的"比较小的时间"（「立刻」没有等待窗口、连翻页加载条都看不到，
  0.5 秒对想快点过题的人又偏慢）。⚠ 改这个数组就等于改面板：驱动 `verify/autonext-delay-gen.js`
  按下标点档位（「1 秒」是第 4 档），加档减档要同步改它和 `verify/flow.test.js` 的列表锚。

⚠ 等待时间配了之后，**核心 `submitCurrent` 不许自己推进题号**（`immediate` 才推）——
否则"等 1 秒"会在判分的那一刻被当场跳过，设了等于没设。真值表与这条都由
`verify/attempt.test.js` ⑧ 节（真定时器）钉住。

`verify/flow.test.js` 用 32 种 (开关 × 已答 × 已判 × 已结束) **真值表**逐格核对，
并断言表里"该判分/该跳"与"不该"两种取值都出现过（不是一张恒真表）。
**反向探针**（`verify/probe-flow-old.js` ③⑦ / `verify/probe-attempt-old.js` ③④）把
"翻页不看是否作答""等待时间不往外传""配了等待却立刻翻""手动翻页不取消待跳"这些旧/坏写法塞回去，
确认锚会红。

### 分数线与定档

`QuizCore.levelOf(percent, cfg)` 是**唯一真相源**（`scoreExam.level` 与 `FlowCore.gradeLevel` 都调它）：
`percent ≥ 优秀线 → 优秀`；`≥ 及格线 → 及格`；否则不及格（"60 分算及格"）。
`FlowCore.gradeBands(cfg)` 给出三档区间（左闭右开，最后一档含 100），
`verify/flow.test.js` 用 0~100 每 0.5 分逐点核对"区间表与判定完全一致"。
分数线非法（超 100、上下颠倒）由 `validateConfig` 的 `E_CFG_OUT_OF_RANGE` / `E_CFG_RANGE_INVERTED` 拦下。

### 底部快捷面板

- **大脑在 `flow.js`，界面层不做判断**（和校对面板一样的分层）：`quickModel()` 给出声明式行，
  `quickAction()` 接收 `{id, value}` 并返回新配置 —— 所以"点了没反应/点错东西"这类问题在 Node 里就能测。
- 四个分组：本轮题量 / 展示时机 / 作答行为 / 分数线。控件只有三种：`stepper`（加减 + 输入框）、
  `choice`（二选一/三选一）、`toggle`（开关）。触屏目标一律 **≥44px**。
- **题量口径**（`pick.randomBasis`）：`count` 按题量、`score` 按目标总分；
  分数线加减按 **5 分一档**（手打任意数字都合法，只是按钮对齐到 5 的倍数）。
- ⚠ 口径只在「**完全随机**」下真的决定本轮题量，所以 `setBasis` 在 `mode !== 'random'` 时
  **一并切到 random** 并回报 `switchedMode` + 可读说明 —— 否则 `randomBasis` 写了没人看，
  用户点一下就"没反应"（假功能比没功能更坏）。
- **题量与分数各管各的**：点"分数 +"绝不去改题量，反之亦然（内部用 `opts.basis` 强制口径）。
- 所有改动**一律经 `QuizCore.applyConfigPatch`**：非法值返回 `ok:false` + 错误明细，
  面板上就地显示"没有采用：…"，并且**不把非法配置回抛给调用方**。
  已知的码：`E_FLOW_BAD_MODE/BASIS/TIMING/REVEAL_KEY/BEHAVIOR_KEY/GRADE_KEY/VALUE/UNKNOWN_ACTION`
  + 来自 `validateConfig` 的 `E_CFG_*`。
- 面板自报 `stats() = {clicks, changes, errors}`，自检页 J 节用**确定性**的 7 次点击核对（7/6/1）。

### 真浏览器部分（Node 替代不了）

`浏览器自检.html` **J 节**：可点元素高度逐个 ≥44px、点"题量 +"→ 配置真的 +1 且切成完全随机、
切"按目标总分"→ 题量行置灰/分数行可用、非法改动被拦下并在面板上显示提示、7 次点击的计数与操作对得上。

---

## 二十、作答界面与触屏（已冻结行为 · `core/attempt.js` + `ui/attempt-view.js`）

### 分层：会话状态 → 渲染模型 → DOM

```
core/attempt.js   会话（用户答了什么 / 哪题提交过 / 现在第几题 / 配置是哪一个引用）
      ↓ view(session) 渲染模型（纯数据）
ui/attempt-view.js    只按模型画，把点击/输入转成 AttemptCore 调用
core/flow.js       "该不该揭示答案 / 要不要翻页" —— 唯一真相源，界面不许自己判断
```
**答案泄露只有一个出口**：`view()` 里的 `answerText/explain/detail` 只在 `FlowCore.revealAt`
说可以揭示时才非空。Node 侧用 **16 格遍历**（时机 × 已提交 × 已结束）钉死：
"有答案文本" ⟺ "FlowCore 说可以揭示"。

### 四型作答的判据（`isAnswered`）

| 题型 | 算"已作答" | 存进会话的形态 |
|---|---|---|
| 单选 | 有 A–H 字母 | 单个大写字母 |
| 多选 | 至少一个字母 | **排序后**的字母串（`BA` → `AB`，便于比对） |
| 判断 | 有字母，或认得出正误（√/×/对/错…） | 用户原文（归一在判分侧做） |
| 简答 | 去掉空白后非空 | **原样保留**（含换行与缩进 —— trim 掉就毁掉"按要点分行"） |

- **没作答不许提交**（`needAnswer`）、**提交后锁定**（`locked`），要改走 `reset()`（人工订正/重做的入口）。
- `submitCurrent` 的判分直接调 `QuizCore.scoreOne`、行为决策直接调 `FlowCore.afterSubmit`
  —— **相邻锚**已在测试里逐字段核对，本层不另写一套。

### 快捷面板"立即生效"的含义（验收原话：不需离开当前页）

`setConfig(session, nextCfg)` 只换掉会话里那**一个配置引用**：
- **当前这道已提交的题**也跟着按新设置显示（用户点了"答完一题即显示"，就该立刻看见）；
- **下一题**自然按新设置走（`beforeChange` / `afterChange` 跨题对照已在测试里钉死）；
- 改题量之类的参数**不会动正在答的题**（抽题发生在开考时）；
- 全程 `location.href` 不变（真浏览器 K 节断言）。

### 触屏硬标准（只有真浏览器能验，Node 边界如实标注）

- 主要可点元素 **≥44px 高**（选项按钮 48px、底部按钮 48px、文本框 ≥132px、快捷面板 44px）
- **窄屏无横向滚动**：全部用 flex/百分比布局、`max-width:100%`、`overflow-wrap:anywhere`；
  真浏览器 K 节在 **375px 宽容器**里逐个元素比对 `getBoundingClientRect().right`，
  并断言 `scrollWidth ≤ clientWidth`、整页 `scrollWidth ≤ innerWidth`。

### 产物

`答题页.html`（第 4 个成品）：内置样卷双击即答 + 底部快捷面板 + 题号索引。
（拖入 `.docx`/`.txt` 换卷这一条**后来搬到了导入 / 校对页** —— 见本文件末尾「拖入文件整合进导入页」那节，
所以答题页现在没有拖入区，换卷走「返回题库」→ 导入 / 校对。）
它内联的核心集合最小（解析链 + schema/data/quiz/flow + 快捷面板 + 作答界面），
`verify/inline-order.test.js` 已把它纳入"内联齐全 / 顺序正确 / 桌面副本逐字节一致"的检查。

### 题号导航与交卷门禁（本小类的两条硬规则）

- `navModel()` 给"一格一题"的索引：`answered/checked/current/state`，界面只管上色与绑定点击。
  - **高亮只有一格**（`current` 与 `answered` 是两个维度：当前题即使没答也是 `current`）。
  - **`correct` 受揭示口径门控**：时机=「整卷后」时，索引格里**不给 ✓/✗**
    （在索引里标对错等于把每道题的对错提前漏出去 —— 与"答题期间不泄露答案"是同一条规矩）。
  - 状态是**算出来的**（每次都读 `isAnswered`），所以清空一道题的作答，那一格会**立刻**退回"未答"。
- **交卷门禁**：`finish()` 在有未答题时**拒绝结算**，返回 `needConfirm` + 未答题号；
  界面画"还有 N 题没有作答（第 … 题）"，两个按钮：
  **返回继续作答** / **仍然交卷**（`confirmUnanswered:true`，结算并把 `forced:true`、`skipped:[题号]`
  如实记进 summary）。
  - **「返回继续作答」= 关掉提示 + 自动跳到第一道未作答的题**（用户要求：
    "未作答完点击交卷后的返回按钮应该自动跳转未作答的题目"）。
    目标下标直接取门禁返回的 `unanswered[0].index`（就是提示里那串题号的第 1 个），
    走的是与点题号格同一条 `leaveTo(...)` 路径（离开当前题该判分的照样判分），并回调 `onNavigate`；
    万一 `unanswered` 为空（门禁因别的原因拦下）就只关提示，行为退化成老样子。
  - 会话**原封不动**：不标记 `finished`、不结算、也不产生判分痕迹。
  > 这条改动的连带效应：`verify/attempt.test.js` 的 16 格泄露面遍历里"强制交卷"那一档
  > 必须显式传 `confirmUnanswered:true`（模拟用户已确认）—— 门禁一加就当场把那条老锚打红，
  > 这正是相邻锚该干的事。
  > 锚：`verify/attempt.test.js` ⑩（门禁 → 点返回 → `index` 必须等于第一道未答题的下标；
  > 含"四题都答完就不该再拦"的反向对照）、`probe-attempt-old.js` ⑦（把跳转拆掉 → 锚必红）、
  > 真浏览器 `verify/answer-library-gen.js`（交卷 → 门禁 → 点返回 → 实测跳到下标 1）、
  > `浏览器自检.html` K 节同款断言。

### 成绩结算与逐题回看（本小类的三条硬规则）

- **数字只有一个来源**：`resultModel()` 的 `score/full/percent/correctCount/total` 全部取自
  `session.summary`（= `scoreExam` + `FlowCore.gradeLevel`）；本层只做编排（加分、按题型汇总、补分数线）。
  测试用**手算的固定样本**（单选 2+2、判断 1、多选 3、简答 5；作答故意半对半错）核对
  **7.5 / 13 / 57.7% / 正确 2 题**，并与 `scoreExam` 逐字段对锚。
- **定档边界**：`percent ≥ 优秀线 → 优秀`、`≥ 及格线 → 及格`、否则不及格
  —— **等于分数线归入该档**（60 分算及格、85 分算优秀）。测试对 59.9/60/60.1/84.9/85/85.1 逐点核对，
  并用**同一份答卷**配四套分数线证明"等级确实由线决定"，再配"降线升档"的反向对照。
  非法分数线（超界、上下颠倒）仍走既有配置校验（`E_CFG_OUT_OF_RANGE` / `E_CFG_RANGE_INVERTED`），本层不重复实现。
- **逐题回看**：`reviewList()` 给每题 {用户作答、正确答案、得分/满分、命中明细、解析、作答与否}。
  - **未交卷时返回 `[]`**（`resultModel()` 返回 `null`）—— 否则答题期间就能回看答案，与"不泄露"冲突；
  - **未作答的题也在列表里**：`answered:false`、作答显示为空、得 0 分（"漏答了哪题"必须一眼看见）；
  - 多选题的"正确答案"用 `、` 分隔，与"用户作答"的显示口径一致
    （同一张卡片里一边 `A、B`、另一边 `AB` 会让人以为答案不一样）。
  - 交卷后 `paintNav` 的 ✓/✗ 才会出现（`correct` 受揭示口径门控），点题号即可逐题翻看。

### 进度暂存与恢复（本小类的三条硬规则）

- **键落在既有命名空间规则里**：`progressKey(examId) = DataCore.examSubKey(examId, 'progress')`
  → `exam::<id>::progress`，落库时 store 再套一层 `app::` 前缀。**不许手拼字符串**
  （手拼就丢掉了"卷 A 的前缀不匹配卷 A2"这条防串号保证，删卷时的 `purgeExam` 也清不到它）。
- **同一套卷可以有好几轮**（`roundTag`）：不带 tag → 老键 `…::progress`（独立单页/整卷默认走它）；
  带 tag → `…::progress-<tag>`（答题页对"抽一轮"用**这一批题 id 的指纹**当 tag）。
  为什么必须有：整卷与抽一轮的题目集合不同，共用一个键就会**互相判为"进度不适用"并覆盖掉对方**
  （实测：从题库答了整卷、再"抽一轮"，两边的进度键是 `progress-all` 与 `progress-p1rqlbjf-16`）。
  两者都在 `exam::<id>::` 前缀下 → 删卷按前缀一并清理（`scanOrphans` 也把 exam 子键整体排除）。
- **载荷只存用户产生的东西**：`{v, examId, title, index, answers, checked, config, questionIds, startedAt, savedAt}`。
  **不存题目本体**（题从试卷来，进度只是覆盖其上的状态）。
- **恢复前先体检**（`checkProgress`），任何一项不对就**明确拒绝**、绝不半信半疑地套用：
  - 版本不符 → `version`；缺作答 → `shape`；空 → `empty`；
  - **`questionIds` 与当前卷不一致 → `paper-changed`**（加题/删题/重导入后旧作答可能对不上，
    宁可全新一轮也不套错）；
  - 恢复时**只认这张卷子自己的题 id**，多出来的陌生键丢弃并计数（`restored.dropped`）；越界题号夹到最后一题。
- **交卷即清理**：`clear()` 同时清内存与后端；此后 `load()` 返回 `empty`，再次进入就是全新一轮；
  **只清这一套卷**（别的卷的进度原封不动）。
- **存储不可用就降级内存态并如实报告**：`createProgressStore(null)` 或后端 `set` 抛错
  （如 `QuotaExceededError`）→ `mode()==='memory'`、`isDegraded()===true`、`lastError()` 记下错误、
  `notice()` 给一句可读提示（界面据此提示"刷新后会丢失"）；**答题与判分完全不受影响**
  （测试用同一份卷在正常态与降级态各交一次卷，两项结果逐字段相同）。
- ⚠ 依赖：`attempt.js` 需要 `DataCore`（键规则住在 `core/data.js`，**不是** schema）——
  内联顺序里 `data.js` 在 `attempt.js` 之前，已由 `ORDER_MUST` 约束。
- **恢复的顺序是硬约束**（组级红队抓出的真 bug）：`restoreProgress` 必须
  **先落 `payload.config`，再重算每题 `results`**。反过来的话 `results` 会用"恢复前的出厂配置"算，
  而整卷总分用恢复后的配置算 —— 同一题卡片 2/2、总分 5/5，两条路分叉。
  同理 `reset()` 解锁某题时必须**连 `manual`/`auto` 一起删**，否则"改判过 → 解锁重做 → 重新提交"
  会留下"卡片 0 分、总分仍按旧人工分 5 分"的分叉。
- 判断题的 `isAnswered` **只认正误归一结果**（`normalizeJudge(value) !== null`）：
  早先还"先看有没有 A–H 字母"，于是 `'A'` 算已作答，而判分侧对它认不出正误 → 恒 0 分，
  还能躲过"未答"门禁（口径不一致）。
- 真浏览器部分：**L 节**（两阶段：写入真实 localStorage → 你按 F5 → 复核作答/题号/提交标记恢复、
  继续答并结算正确、交卷后键被清掉）。

### 简答人工订正（本大类收官小类）

- **两个受控入口**（都挂在 `scoreOne` 的 `opts` 上，**不另写一套算分**）：
  - `manualHits: ['关键词'…]` —— 把某些关键词标为命中；命中集合 = 自动判定 ∪ 人工标记，
    之后的算分仍走同一套公式（`hitRatio` / `range` / 半步取整全都复用）；
  - `manualScore: 数字` —— 直接给分（覆盖自动算分，**含"没有关键词"的题**：自动判不了，人能给）；
    仍受 `[0, 满分]` 与半步粒度约束。
- **整卷重算走同一条路**：`scoreExam(qs, answers, cfg, { manual })` → 每题的订正被带进同一次结算，
  `per[].manual` 标出哪些题被订正过。**已交卷后改判 → `refreshSummary()` 立刻重算**
  总分/百分比/等级（固定样本实测：57.7%/不及格 → **69.2%/及格**，等级真的换档）。
- **痕迹可见**：`session.manual[qid] = { hits, score, note, at }`；自动分留档在 `session.auto[qid]`，
  回看卡片同时给出 `autoScore` 与 `manualScore`（"自动 3.5 → 人工 4.5"），
  成绩单带 `manualCount` / `manualLabels`，题号索引与回看卡片都会标出被订正的题。
- **只动这一题**：其余题的 `per` 明细（含 `detail`）逐字段不变、满分不变；
  `q.keywords`、`session.config`、`session.answers` **深比较不变**（人工标记只活在订正记录里）。
- **同一题改判两次以最后一次为准**：记录**整体替换**、不做增量合并
  （界面每次把当前勾选一起提交，所以不会留下"上次标的词还在生效"的错觉）。
- **撤销**：`clearManual()` 删记录并把 `results` 重新按自动口径算一遍。
  ⚠ 这条的锚要看**回看卡片**：整卷总分由 `scoreExam` 从 `answers+config` 重算，撤销后本来就对；
  而卡片读的是 `session.results`，不恢复它就会继续显示人工分（这条是反向探针逼出来的）。
- 只有**简答题**能改判：客观题由规则判分，人工改会让"判分口径"失去意义（`applyManual` 明确拒绝）。
- **没作答的题不给订正**（组级红队抓出）：否则成绩单会同时说"第 2 题未答"又"第 2 题人工订正"
  并把它的分数算进总分（自相矛盾）。`applyManual` 返回 `needAnswer:true`，界面侧也隐藏订正入口。
- **取消最后一个"人工命中" = 撤销订正**：`hits: []`（明确给空数组）且没给分数 → 等价 `clearManual`，
  返回 `{ok:true, cleared:true}`；早先它被当成"空改判"直接拒绝，界面点了**静默无反应**（组级红队抓出）。
  区分"没给 hits"（`undefined`，非法）与"给了空数组"（合法，表示取消）。

---

## 十九、四型计分执行（已冻结行为 · `core/quiz.js` 的 `scoreOne` / `scoreExam`）

### 总规则

每题返回 `{ score, full, correct, detail }`；`scoreExam` 的 `per[].detail` 与 `scoreOne` **逐字段一致**
（只有一套算法，界面/成绩页/错题本都读它）。所有 `score` 与 `full` **一律落在 0.5 的整数倍**。

**粒度的双保险**（只靠上游会漏）：
1. 配置侧：`points.*` 声明 `multiple: 0.5` → 填 2.25 直接被 `E_CFG_NOT_HALF_STEP` 拦下；
2. 计分侧：`scoreOne` 里 `roundHalf(full)` + 各分支 `roundHalf(...)` —— 即便被硬喂进非法配置也不产脏分。

### 各题型口径

| 题型 | 规则 | 不给分的情形 |
|---|---|---|
| 单选 | 取作答里第一个 A–H 字母与答案键比（大小写/标点无关） | 答案键空；不作答；认不出 |
| 判断 | 用户作答与答案键**都**经 `SegmentCore.normalizeJudge`（含否定式：不正确=错、没错=对） | **答案键本身歧义（null）**；作答认不出；不作答 |
| 多选 | 全对满分；否则按配置：`halfCredit` 给不给部分分、`halfMode` 三选一（`fixedScore` 半对固定给分 / `fixed` 固定比例 / `hitRatio` 按命中比例）、`wrongChoiceZero` 错选即零 | **答案键为空**；不作答；关掉半对；错选且错选即零 |
| 简答 | 关键词逐条命中（`contains`/`exact` + 同义写法），`hitRatio` 或 `range` 映射 | **没有关键词**；一个都没中（range 模式给下限） |

- **多选题的半对规则（用户要求："多选规则应该半对给两分"）**：默认 `halfMode='fixedScore'` + `halfScore=2`
  —— **少选（命中了一部分、没全中，且按配置没有错选）固定给 2 分**，不看命中几个；
  封顶不超过该题满分（多选只值 1 分时不会给到 2 分），仍是半步粒度。
  `detail.mode='fixedScore'`、`detail.halfScore=2` 会写进明细，界面据此解释这个 2 分怎么来的。
  另外两种模式保留给不同考试口径：`fixed` → `full × halfRatio`（不看命中多少）；
  `hitRatio` → `full × (命中/应选) × halfRatio`（"命中一半"按比例给，`halfRatio=1` 时即"命中一半得一半分"）。
  三种模式都受"0 命中不是半对""错选即零（`wrongChoiceZero`）"的约束。
  ⚠ 字段标签与 `DEFAULT_CONFIG` 的注释曾写"只在 fixed 用"，与实现矛盾（组级红队抓出）——
  现在标签是「半对封顶比例」、注释写明 `fixed`/`hitRatio` 两种模式的分工，**行为未变**（这是明示的口径选择）；
  新增的 `fixedScore` 是**用户显式要求的那条规则**，旧卷（快照里写死了 `halfMode`）行为不变。
- **等级与显示的百分数同源**：`scoreExam` 先把 `percent` 四舍五入到 1 位，再用**它**去 `levelOf`
  ——早先 `percent` 四舍五入、`level` 用未四舍五入的 `pct`，在 84.95% 这类边界上出现
  "显示 85%、等级却写及格"，成绩页注脚又按 85 算成"超过优秀线 0 分"（组级红队抓出的两真相源）。
- **简答 range 模式**：`full × clamp(minRatio + (maxRatio − minRatio) × 命中率, 0, 1)`；
  0 命中会拿到 `minRatio × full`（那是配置给的**下限**，想要 0 就把 `minRatio` 设 0）。
- **简答 exact 模式**：作答必须与关键词**完全相等**才算命中（多带内容就不算）。

### 不可判分：`detail.unscorable`

`多选答案键为空` → `'noAnswerKey'`；`简答无关键词` → `'noKeywords'`。界面据此显示"需人工处理"。
> 红队实测抓出的真缺陷（已修）：多选答案键为空 + 不作答时，早先走 `setEq(∅,∅)=true`
> → **白送满分并计入正确题数**（一条没有答案键的题会抬高整卷得分）。

### 判断题正误归一：**只有一份实现**

`SegmentCore.normalizeJudge` 是唯一实现（认出 6 正 6 反 + 变体、处理否定式、问句式歧义、过长句不猜，并给出 reason）。
`SchemaCore.normalizeJudge` 与 `QuizCore.normalizeJudge` 都是**委托**它的薄壳。
> 红队实测抓出的真缺陷（已修）：早先三份实现不一致 —— 答案键侧认「不正确 = 错」，
> 而判用户作答的那份**认不出来** → 用户写「不正确」时**被冤判 0 分**。
> 加载顺序：`segment.js` 必须先于 `schema.js` 与 `quiz.js`（见第六章，`ORDER_MUST` 已约束）。

### 缺项落回内置默认（部分配置不崩）

`scoreOne` 用 `deepMerge(DEFAULT_CONFIG.<块>, cfg.<块>)` **逐键**合并：
只写 `{multi:{halfMode:'fixed'}}` 时 `halfCredit` 取默认 `true`，**不许被当成 false 把半对静默关掉**；
只写 `{}` / `{points:…}` 也不崩。`scoreExam` 的 `answers` 省略 → 按全 0 判。
> 红队实测抓出的真缺陷（已修）：早先直接 `cfg.multi.halfCredit` → 部分配置 **TypeError 崩掉**；
> `cfg.multi` 块存在但缺 `halfCredit` → 半对被静默关掉。

### 作答与答案键的归一（唯一实现在**解析层**）

`SegmentCore.normLetters / letterSet / firstLetter / toHalfWidth` 是**唯一实现**，
`schema.js`（校验答案键）与 `quiz.js`（判用户作答）都**委托**它。
- 接受字符串、数字、字母数组、Set；**拒绝对象/布尔/null** → 视为"没作答"
- **全角归一**（`ＡＢ` → `AB`，中文输入法常见）、大小写无关、只抽 A–H
- "答案字母必须在选项里"那条校验也用同一把尺子
> 红队两轮实测抓出的真缺陷（已修）：
> ① 早先 schema 与 quiz **各有一份**，出现"计分侧认全角 `ＡＣ`、校验侧不认"的两把尺子 → 合法数据被误报矛盾；
> ② `String({})` = `'[object Object]'` 会被抽出 `B/C/E` 三个字母，
>   于是"用户其实没作答"变成"选错了 B、C、E"，在放水配置下**还能拿到分**。

### 数值兜底：脏配置不许产出 NaN，且**不许让成绩虚高**

`points` 非有限 / 负数 / 超上界（>1e6）→ 落回**内置默认分值**；
`halfRatio/minRatio/maxRatio` 非有限 → 回落默认并 clamp。
> 红队两轮实测抓出的真缺陷（已修）：
> ① `points.单选='abc'` / `Infinity` → `full` 变 NaN → **整卷 score=NaN**；
> ② 有限但**溢出**的值（`9e307`：`v*2` 溢出）→ `full=Infinity`、整卷 `percent=NaN`；
> ③ **落 0 不是中性操作**：该题会从整卷分母里消失 → 实测"答对 1/2 却显示 100 分/优秀"。
>   所以落的是内置默认分值，并在结果**顶层**留 `cfgWarn:{badPoints, pointsUsed}`。
>   ⚠ 标记**不能塞进 `detail`**：各分支会整体替换 `detail`（那是"作答比对"的地方），
>   塞进去会被下一次赋值悄悄抹掉（早先真丢过这个标记）。
> 已知**入口侧缺口**（不在本小类范围，登记待办）：`exams.setConfig`（core/exams.js）只校验
> "config 是对象"，不跑 `validateConfig`；文本格式的 `config:` 块也照收 JSON。
> 计分侧现已兜住，但这两个入口将来应当补上值校验（属"容错与提示"那类小类的活）。

### 答案键自相矛盾：报错，不"挑一个信"

`answer` 与 `answerLetters` 指向不同选项时，`SchemaCore.validateQuestion` 报「答案自相矛盾：…」（error）。
- **单选**只比首字母：答案写 `AB` 是"多选转单选后的收窄结果"（既有约定，`applyDerived` 把
  `answerLetters` 收成 `[A]`），不算矛盾 —— 否则会把**文本导入整个卡死**（红队实测）。
- 写法差异一律放行：`'A、C'` / `'（A）'` / `'A C'` / `'答案：AC'` / `'ＡＣ'` / 小写 → 都算一致。
- **只在"答案文本里有字母"时才比**：文本型答案（`answer:'甲'`）、只给字母、两边都空 → 都不算矛盾。
- ⚠ **"显式空数组" ≠ "没写这个字段"**（红队终审 P6）：
  `answerLetters: []` + answer 有字母 → **error**（计分侧会恒判 `noAnswerKey`，学生看到 3 分题答对得 0）；
  而 `answerLetters: null` / 字段缺失 → 只给 warning「没写答案字母，判分按 answer 文本解析」、**不挡导入**。
  为什么必须区分：本应用自己的**分享导出**就是写这个形状（`core/data.js`：`answerLetters: q.answerLetters || null`），
  而计分侧对 null/缺失本来会**回落到 `answer` 解析**并正确判分 —— 一律报错会把自家导出的合法文件整批挡在门外。
> 红队实测抓出的真缺陷（已修）：`createQuestion` 优先用 `answerLetters`、`applyDerived` 一律从 `answer` 重算，
> 于是同一道题经两条路径得到**不同答案键** —— 用户答 `'A'` 在一处 0 分、在另一处满分，而校验完全静默。
> **连带真缺陷**：这条新校验立刻打红了既有相邻锚 `verify/review.test.js` ——
> 根因是 `review.setType('单选')` 只收窄了 `answerLetters`，`answer` 文本还留着 `'AB'`
> （一道单选写着 AB）。已在 `core/review.js` 里把答案文本一并收窄。

### 不判分的几种情形（`detail.unscorable`）

| 情形 | 表现 |
|---|---|
| 多选答案键为空 | `unscorable:'noAnswerKey'`，0 分且不计正确 |
| 简答无关键词（或关键词**全是**空文本） | `unscorable:'noKeywords'`（有词被丢时另报 `droppedKeywords`） |
| 判断题答案键本身歧义（null） | 答什么都 0 分、不计正确 |
| 题目对象非法（null/非对象） | `unscorable:'badQuestion'`，0 分；`scoreExam` 跳过并计入 `skippedInvalid` |

### 半对与取整的两条口径（易踩）

- **0 命中不是半对**：`hit.length === 0` → 0 分（`detail.noHit=true`）。
  > 红队实测抓出的真缺陷（已修）：固定比例模式下早先完全不看命中数 ——
  > 放水配置（`wrongChoiceZero:false`）里全选错项照给 `halfRatio`，`halfRatio=1` 时**直接满分**。
- **取整方向 = 半分向上进位**（`Math.round(v*2)/2`）：`0.75 → 1`、`0.125 → 0`。
  半对场景因此可能系统性偏高半分，这是**明示的口径**，不许"照抄实现当期望值"。
- **句中否定式**（自然写法）也算否定：`不正确/不对/不是/非正确/有误` → 错；
  `没错/没有错/不是错的/并不错误` → 对。
  > 红队实测抓出的真缺陷（已修）：早先只认**句首**否定词（`v.indexOf(p) === 0`），
  > 于是「这题不对」「我认为不正确」掉进子串兜底、被「对」字命中 → **判成"对"= 判反**
  > （答错给满分、答对给 0 分）。
  ⚠ **位置是硬约束**：这段结论必须夹在两道既有护栏（「正误并存→歧义」与「>8 字长句不猜」）**之后**，
  并用同一个长度阈值。红队二轮抓到我把放在护栏**之前**时"用一个更敢猜的规则盖掉了不猜的规则"：
  `并不错误但是也不完全正确`（自相矛盾）被判 true、16 字叙述句被判 false。
- **问句变体**一律不猜：`是否/与否/能否/可否/是不是/对不对/行不行/好不好/可不可以` → null
  （`是不是`/`对不对` 含「不是/不对」，不先拦住就会被否定式规则判成"错"）。
- **对冲/含糊说法**一律不猜：`不一定/未必/可能/也许/大概/一半/半对/部分/半数/差不多/有些` → null。
  > 红队 P8 指出词表粒度要一致：只收短语（`部分对`）会漏掉 `部分正确/半数正确/差不多对/有些正确`，
  > 它们因为含「正确/对」而被判成 true（键=对时白拿满分）。现在全按**词素**收。
- **程度副词不是否定**：`非常正确` → true、`非常错误` → false（`非` 开头但后面是「常」时豁免否定前缀）。
  `非常好` → null：**没有**把「好」收进 TRUE 表 —— 收进去会让句中的「这不好」被判成 true（更危险的判反）。
- **反问/商量语气结尾**（`吗/呢/吧`）→ null：`这不是对的吗` 里的正/误词是**反问**，
  按字面判必然出错（这句的意思其实是"对"）。
- **多重否定**（≥2 个 不/非/没，如 `不是不对`、`不是不正确`）→ null（嵌套否定猜不得，硬猜必有一半判反）。

---

## 二十一、误答本：自动收集与计数（已冻结行为 · `core/wrong.js`）

> **命名口径**（2026-09 统一）：数据层沿用老名字「误答本」（`wrongKey` / `WrongCore` / 存储键都别改，
> 那是冻结契约），但**凡是给用户看的文字一律叫「错题本」**（pane 名、按钮、报错 message 全都是）。
> 早期有几条 message 漏了「误答本」，那一轮措辞复查已全数改掉；新加文案请照「错题本」写。

### 规则（一次固定，界面与测试都按它）

| 情形 | 判定 | 动作 |
|---|---|---|
| 误答 | 交卷结算里该题 **`per[].correct === false`**（即"得分未达满分"） | 首次进本 `times=1, streak=1`；已有记录则 `times+1, streak+1` |
| 答对 | `per[].correct === true` | **保留记录**，只把 `streak` 清零、`rightTimes+1`、`lastRightAt` 记时 |

- **误答包括**：单选/判断答错、多选只对一半（半对）、简答没全命中、**根本没作答**。
- **绝不因为"答对"删除任何条目**（验收③）。要删只能走 `remove(book, qid, {reason, now})`
  —— 显式、带理由、并把 `{qid, at, reason}` 记进 `book.removed`（**删除留痕**）。
- 答对但本子里本来没有该题 → `ignored`（答对不是错题，不建记录）。

### 条目形状（基形来自 `SchemaCore.createWrongEntry`，其余是本层扩展）

```js
{ qid, times, lastWrongAt,                 // ← 冻结基形（L1#1 定的）
  examId, type, stem,                      // 归属与展示（归属自己写在本子里，不靠外部推断）
  streak, rightTimes, firstWrongAt, lastRightAt?,
  lastAnswer, lastScore, lastFull,
  history: [{ at, kind:'wrong'|'right', score, full }] }   // 完整时间线（错→对→错 一笔不丢）
```

### 键与归属

`wrongKey(examId) = DataCore.wrongKey(examId)` → `wrong::<examId>`（**按试卷分本，不手拼字符串**），
落库时 store 再套一层 `app::` 前缀 → `app::wrong::<examId>`。
`checkPayload` 还会核对 `payload.examId`：**别套卷的误答本一律拒绝**（`wrong-exam`），不串号。

### 幂等（防重复计数）

`collect(book, results, {sessionAt})`：`book.lastSessionAt === sessionAt` → `{skipped:true, reason:'duplicate'}`。
**同一轮交卷被重复收集（双击「交卷」/ 页面重放）不会把次数算两遍**。
（`applyManual` 之类的"改判后重算"走的是另一条路，不会触发收集。）

### 两层分工

- `applyResult / collect / remove / stats / checkPayload` 是**纯函数**（Node 里可穷举）；
- `loadBook / saveBook / collectToStore` 才碰存储；`collectToStore` 是**唯一**一处在交卷后写误答本的地方
  （答题页的 `onFinish` 调它：`results` 直接用 `session.summary.per` —— 那是"每题得分/是否满分"的真相源）。
- 没有存储 → 返回空本子 + `degraded:true`，**不崩、不谎报成功**。

### 统计口径（`stats`）

`{ total, timesSum, active, mastered, removed }`
—— `active` = `streak > 0`（还没纠正过来的），`mastered` = `streak === 0`（后来答对过的）。
> 这两个名字刻意不用"待复习/已掌握"这类说法：它们只是**计数状态**，
> "什么时候该复习"属后续小类（分卷归集与详情/复习计划）。

## 二十二、分卷归集与详情（已冻结行为 · `core/wrong.js` 视图模型 + `ui/wrong-view.js`）

### 一条硬规矩：原题一律从**试卷**现读

误答本里的 `stem` 只是**当时那道题的副本**（快照），方便没卷子时也能认出是哪条。
**详情里的原题 / 参考答案 / 解析一律从 `exam.questions` 里现读**（`detailOf(book, qid, {exam})`），
所以卷子被改过之后，看到的是**卷子里的最新版**，而不是错题本里的旧副本。

| 情形 | `stale` | `staleReason` | `jump` |
|---|---|---|---|
| 题干与快照一致 | `false` | `''` | `{examId, index}` |
| 题干被改过 | `true` | 试卷里的题干已经改过了（下面是卷子里的最新版） | `{examId, index}`（新下标） |
| 题已从卷里删掉 | `true` | 这道题已经不在试卷里了（快照仍留档） | `null` |

未被删的题，详情里 `question` 的五项（`stem/options/answerText/explanation/typeLabel`）**逐字等于**试卷里那一题；
被删的题 `question === null`，界面显示 `（原题已不在试卷里）快照：<快照题干>`，参考答案写「不可用」，
并把「跳到这道题」**禁用**（`jumpTarget` 也会以 `not-in-exam` 二次拒绝 —— 两道防线，按钮只是外面那道）。

### 分组模型（`groupOf` / `groups`）

- 一本 = 一套卷；`groupOf(book, exam)` 产出：
  `{ examId, title, examFound, total, timesSum, active, mastered, entries[], updatedAt }`
  —— `total` = **组内题目数 = 实际误答数**（`Object.keys(entries).length`，不是外部推算）。
- `title` 取**试卷标题**；卷不在册（`exam === null`）时退化成可读占位 `试卷 <examId>` 并置 `examFound:false`，
  **该组仍然显示**（数据不能因为卷没了就消失），界面附一句「这套卷已经不在了」。
- `groups(books)`：**空本子不出组**（`total > 0` 才留），组间按 `updatedAt` **倒序**；
  组内 `entries` 按 `times` 倒序、同次数按 `lastWrongAt` 倒序（错得多的排前面）。
- 全部 5 个视图模型函数（`groupOf/groups/detailOf/jumpTarget/loadAll`）都是**纯函数**，Node 里可穷举。

### 视图层（`ui/wrong-view.js`）

`mount({container, books:[{book, exam}], exams, onJump, doc})` → `{el, destroy, refresh(books, exams), groups(), select(examId, qid), selected(), stats()}`

- 该显示什么**全在** `core/wrong.js` 的视图模型里；这一层只画、只把点击转成回调（与其它面板同一分工）。
- `onJump(examId, index, t)` 只回传**目标卷 + 卷内下标**，怎么导航由上层决定（错题本.html 里是打开答题页并 `goto`）。
- 用户数据一律走 `textContent`（不拼 HTML）。
- ⚠ **`refresh()` 必须重建卷册映射**：`books` 里带的卷永远以**最新那份**为准。
  早先只换 `books`、不换 `examMap`，于是卷子改名/改题干之后刷新视图，详情里拿到的还是挂载那一刻的旧卷子
  ——"改过的题干"永远显示不出来（那条 stale 断言等于在测空气）。
  锚：`verify/wrongview-ui.test.js` ④；反空转：`verify/probe-wrongview-ui-old.js` ①。
- 原题那一行带 `data-wv="stem"` 钩子：验收断言"这里是**逐字**卷子里那一句"用**等值比较**，
  不用子串匹配（实测过：题干恰好是解析文本的前缀时，子串判断会假通过/假失败）。

### 第五个产物：`错题本.html`

内联链：解析核心 → schema/data/quiz/flow/**wrong** → exams/text-format → quick-panel/attempt/attempt-view/**wrong-view**。
打开即：从 `app` 命名空间列出所有卷 → `loadAll` 读回各卷误答本 → 按卷分组；
点一条看原题/答案/解析；点「跳到这道题」开一个**只读回看**的作答会话并 `goto` 到那一题（`mountPanel:false`）。
本地一条数据都没有时，用内置样卷**现造一本示例**（前两题故意答错），并明确标注「这是内置样卷的示例错题本」——
**示例不落盘**（不往用户存储里塞演示数据）。

### 命名空间修正（顺带修掉的跨页分家）

`校对面板.html` 早先把导入的卷子写进 `namespace:'quizdemo'`，而契约第十一章规定的全局空间是
`DataCore.NS_GLOBAL`（`'app'`）—— 于是校对面板导进来的卷子在「答题页 / 错题本」里**一份都看不见**。
现已改为 `DataCore.NS_GLOBAL`：**跨页共享的卷子只有 `app` 一个空间**，接收者隔离仍走 `recv_<examId>`。

## 二十三、删卷级联询问（已冻结行为 · `core/exams.js` 政策层 + `ui/delete-dialog.js`）

### 三条硬规矩

1. **不许悄悄删**：`deleteExam(store,id)` 不给政策 → `{ok:false, needPolicy:true, prompt}`，
   **存储一个字节都不写**。想删必须**显式**选 `cascade` 或 `keepRecords`
   （旧写法 `{keepRecords:true/false}` 仍兼容，等价于这两条）。
2. **选『是』(cascade)**：卷本体 + `meta`/子键 + `wrong::<id>` + `record::<id>` 一起删，
   并**抹掉旧墓碑**（先选"否"再选"是"不许留下空壳标识）→ 零残留、**不可恢复**。
3. **选『否』(keepRecords)**：只删卷本体，记录**保留**并写一枚**墓碑**（`index.deleted`），
   残留记录因此有明确归属标识「已删除试卷（原《原标题》）」—— 它是"有主"的，不是孤儿。

### 执行顺序（keepRecords 路径）：先写墓碑，再删卷

墓碑写不进去（配额满时索引可能写不动）时**绝不硬删**：返回 `{ok:false, needTombstone:true}`，
并保证"什么都没删"。反过来先删卷再写墓碑的话，一旦墓碑写不动，
就会留下"卷没了、记录还在、没有任何归属标识"的一堆真孤儿。
两种失败都是安全态：墓碑写失败 → 什么都没删；删卷失败 → 残留记录已有主。
（`cascade` 不需要墓碑，所以不受这条约束。）

### 询问模型（纯函数 `deletePlan`）

```js
deletePlan({examId, title, wrongCount, recordCount}) → {
  examId, title, wrongCount, recordCount, hasRecords,
  message,                  // "删除《甲卷》。这套卷还挂着 3 条错题、2 条作答记录，要一并删除吗？"
  note,                     // 不选会怎样 / 两个选项结果是否一样，都写在这里
  options: [
    { policy:'cascade',     answer:'yes', label:'一并删除（不可恢复）', detail:'删掉试卷本体 + N 条错题 + M 条作答记录' },
    { policy:'keepRecords', answer:'no',  label:'只删试卷，保留记录',   detail:'记录留在错题本里，归属标识改成「已删除试卷」' }
  ]
}
```
**文案只此一份**：界面不许自己拼"要一并删除吗"这类句子，否则两个选项的后果会各写一套、迟早对不上。
`deletePreview(store, id)` 负责把计数**真读出来**（错题本 `entries` 条数 + 作答记录条数；读不到就算 0），
再交给 `deletePlan`。

### 墓碑与归属查询（`index.deleted`）

```js
index.deleted: [{ id, title, at, wrongCount, recordCount }, …]
```
- `ownerOf(store, examId)` → `{kind:'alive'|'deleted'|'unknown'}`；
  `deleted` 时另带 `label = '已删除试卷（原《title》）'`、`deletedAt`、`wrongCount/recordCount`。
- `deletedExams(store)` → 已删除卷册列表（界面据此把记录显示出来）。
- **墓碑不是新键类型**：它住在既有的落点索引里，键空间不变（第十一章的前缀规则原样有效）。

### 巡检：孤儿 vs 有主（`scanOrphans`）

`scanOrphans(store)` → `{orphans[], identified[], missingBodies[], alive[], deleted[]}`

| 情形 | 归类 |
|---|---|
| `record::<id>` / `wrong::<id>` 指向**活着的卷** | 正常，不报 |
| 指向**已删卷且墓碑在** | `identified`（带 `label`/`title`/`deletedAt`）—— **有主，不是孤儿** |
| 指向**查无此卷** | `orphans`（真孤儿，要报出来） |

验收判据（两种路径都不留孤儿）：**级联路径** `exam::A*`/`wrong::A`/`record::A` 全部归零且
`orphans = identified = []`；**保留路径** `orphans = []` 且 `identified` 恰好列出那两条并带标签。
把两者混成一个数组报，就会得出"保留路径留了孤儿"的错误结论。

### 界面的两个必守点

1. **弹窗默认不选**：遮罩铺满视口、两个选项各 ≥44px、破坏性选项单独标红并写明**不可恢复**；
   点遮罩空白处 = **取消**（绝不等于同意）；取消 → **不写盘**；双击选项只认第一次。
   询问模型缺 `options` → `DeleteDialog.mount` **当场抛错**（不许画一个"没有选项"的假弹窗）。
2. **保留的记录要真的显示出来**：已删除卷的误答本**不在** `listExams` 里，
   所以界面必须走 `WrongCore.loadAllWithDeleted(store, aliveIds, deletedIds)`
   —— 只按"活着的卷"去读，用户选了"保留记录"回到错题本会**什么都看不到**
   （数据还在盘上、界面装作没有，最容易被当成"我记录丢了"）。
   `WrongCore.groups` 在 `exam === null` 时会用 `owner.label` 当分组标题并置 `deleted:true`，
   该组**不给**「删除这套卷」按钮，跳转按钮禁用。

## 二十四、密钥与供应商能力表（已冻结行为 · `core/ai.js` + `ui/ai-settings.js`）

### 密钥本地化的三条纪律

1. **独立命名空间**：密钥只写进 `AiCore.secretNamespace() = 'secret'`（与题库/记录的 `app`、
   接收者的 `recv_<examId>` 都分开）。`AiCore.openKeyStore(localStorage)` 是**唯一**开这个 store 的入口；
   页面不许自己拼命名空间，也不许手拼键名（键名只由 `AiCore.keysKey()` 给）。
2. **只在发起请求那一刻读原文**：界面一律只显示 `AiCore.maskKey(key)`（`sk-c…80zz`）；
   `saveKey` 的返回值**不含原文**（只回遮罩），保存后输入框立刻清空 —— DOM 里不留 Key。
3. **不进分享产物**：分享载荷由 `DataCore.sanitizeSharePayload` **白名单重建**（顶层键只有
   `kind/schemaVersion/exportedAt/exams`，`settings` 连键都不出现），另有 `AiCore.scanForSecrets(text, keys)`
   可对任意要发出去的文本做闸门扫描：**完整串与尾部 6 字符片段都算命中**。

```js
openKeyStore(localStorage) → Store|null      // namespace='secret'，拿不到就返回 null（调用方降级）
saveKey(store, provider, key, {now})         // → {ok, provider, masked, at, persisted}
readKey(store, provider)                     // → {ok, configured, apiKey, at}  ← 原文只给发请求用
hasKey(store, provider) / clearKey(store, provider)
keyModel(store)                              // → {rows[…], configuredCount, callableCount, blocked[]}
providerRows() / capabilityGaps()            // 能力表 + 「谁漏写了能力位」自检
callSaved(store, fetchImpl, provider, opt, hooks)   // 唯一调用入口：先用保存的 Key 组装请求
scanForSecrets(text, keys) / allKeys(store)  // 分享前闸门 / 取原文（只给扫描用）
```

- 保存校验：未知供应商 / 空串 / 含空白（多半是复制带换行）→ **明确拒绝且不写盘**；想删必须走 `clearKey`。
- 版本门禁 `KEYS_VERSION=1`：版本或形状不认识 → **一条都不认**（不猜、不部分读），降级为"没填"。
- `store === null` 时：`saveKey` 仍然 `ok` 但如实报 `persisted:false`，界面必须说"没写进本地存储（刷新后就没了）"
  —— **不许谎报"刷新后仍在"**。

### 能力表（`browserDirect` 必须显式写死）

| 家 | JSON 模式 | 浏览器直连 | 说明 |
|---|---|---|---|
| 阿里百炼 DashScope | ✅ | ✅ | `allow-origin: *` |
| DeepSeek | ✅ | ✅ | `allow-origin: null` |
| 智谱 GLM | ✅ | ✅ | `allow-origin: null` |
| Moonshot Kimi | ✅ | ✅ | `allow-origin: null` |
| 火山方舟（豆包） | ✅ | ✅ | 需先建接入点 |
| OpenAI | ✅ | **❌** | **实测无 CORS 头**；必须自建中转 |

- `jsonMode` / `browserDirect` **不许留 undefined**：`capabilityGaps()` 会把漏写的家逐条列出来
  （`directNote` 缺失也算缺口）；界面**不许**去解析 `cors` 文案猜能力。
- 不可直连的家：能力表红标 + 一句"为什么"（`directNote`），界面里**输入框与保存按钮直接禁用**
  （填了也用不了，别让用户白折腾）。
- `callSaved` 的两道前置闸门：**该家不可直连** → `{kind:'no_direct'}`；**没填 Key** → `{kind:'no_key'}`。
  两种都**不发请求**、都给出人话原因（而不是让用户对着 CORS 报错猜）。
- `providerRows()` 的文案（`jsonModeLabel/directLabel/directNote`）是**唯一真相源**，界面直接照行渲染。

### 界面纪律（`ui/ai-settings.js`）

- 输入框 `type=password`、`autocomplete=off`；已配置只显示遮罩 + 保存时刻。
- 结果提示挂在**重画之外的状态行**上（`data-as="status"`）：保存/清除后会 `refresh()` 重画列表，
  行内提示当场就会被抹掉（实测踩过）。
- 顶部常驻一句"只存在本机、不随分享文件导出"（北极星要求写在脸上，不只写在文档里）。

## 二十五、单题智能生成（已冻结行为 · `core/ai.js` 单题层 + `ui/ai-single.js`）

### 三类操作与各自的**结构要求**（这就是"结果合不合格"的判据）

| 操作 | 必需字段 | 附加闸门 | 落地方式 |
|---|---|---|---|
| `explain` 解析 | `explanation` **+ `pitfall`（易错点）** | 两者都必须非空（空白串也算缺） | 附加到原题：`patches.explanation` = 解析 + `\n易错点：…`（幂等，不会堆两遍） |
| `variant` 变式题 | `type/stem/answer` | **四件套齐全**：单选/多选要有 ≥2 选项且答案字母在选项内（单选恰好 1 个、多选 ≥2 个）；判断题答案可识别为对/错；简答题 ≥1 个采分关键词；**题干不得与原题一字不差** | 新题入库：`SchemaCore.createQuestion` 造题 → `validateQuestion` 复核 → 追加到草案 |
| `difficulty` 难度 | `level` | **必须是 1–5 的整数**（3.5 / 0 / 6 / "3" 全拒） | 附加到原题：`patches.difficulty` |

- 判据一律**先过 `validate`（字段与类型）再过各操作自己的闸门**；变式题不另写题型规则，
  统一委托 `SchemaCore.createQuestion + validateQuestion`（**避免第三份题型实现**）。
- `explain` 的 `pitfall` 是**结构的一部分**（L1「AI 辅助」L2 #2 起）：
  只给解析不给易错点 → `{ok:false, errors:['缺少字段 pitfall']}`。
  ⚠ 这条比早期严：`verify.js` 里 `validate('explain', {explanation:'x'})` 由"通过"改成"不通过"（并新增一条专门断言）。

### 三条硬规矩

1. **一次点击 = 一次请求**：`singleRequest()` 的 `retries` 默认为 **0**。
   脏 JSON/结构不合就是一次干净的失败（提示"可以再点一次"），**不偷偷重发**。
   `runSingle()` 每次返回都带 `requestCount`（成功/失败都恒为 1；被前置闸门拦下时为 0）。
2. **拒绝即不落库**：`checkResult` 不过 → 返回 `{ok:false, stage, errors, value}`，**没有** `patches`/`question`。
   `applyResult` 再校验一次（拿被拒的值去 apply 只会得到 `ok:false`）。界面此时**不画"采纳"按钮**。
   结果只改**草案**；真正落盘仍由「确认入库」的 `ReviewCore.commit` 把关（结构校验二次）。
3. **不弹消耗确认窗**：单题路径没有 `confirm`、不预估 token。整卷批量才需要消耗确认（属下一小类）。

### 接口

```js
briefQuestion(q)                      // 题 → 给模型看的简报（题干/选项/答案/既有解析）
singleRequest(kind, q, opt)           // → callAi 的 opt（task/system/user/jsonMode/retries:0）
checkResult(kind, value, origin)      // 结构闸门 → {ok} 或 {ok:false, stage:'schema'|'completeness', errors[]}
applyResult(origin, kind, value)      // → {ok, patches} 或 {ok, question, warnings}（纯函数，就地不改）
runSingle(store, fetch, provider, kind, q, opt, hooks)   // 唯一入口：1 次请求 → 闸门 → 落地计算
```

- `stage` 取值：`unknown`（任务名错）/ `no_question`（题干空）/ `provider`（未知家或不可直连）/
  `call`（网络/鉴权/限流等，带 `kind2`）/ `schema` / `completeness`。
  前置闸门（前三者）**零请求**，这点是验收③的一部分。
- `ReviewCore.setDifficulty(draft,i,level)`（只收 1–5 整数）与 `ReviewCore.appendQuestion(draft,q)`
  （先 `validateQuestion`，id 撞车自动换）是唯一的落库前写入口。

### 真调用证据（人工触发）

`node verify/real-ai.js [provider]`：读环境变量（`DASHSCOPE_API_KEY` 等，**绝不回显原文**，只打印遮罩），
三类操作各真发一次请求，跑通后把结果写进 `verify/real-ai-last.json`（含 `scanForSecrets` 自检：文件里不含 Key）。
环境里没 Key → 打印 `UNVERIFIED` 并以退出码 **3** 结束（不许当通过）。

## 二十六、整卷点评与举一反三（已冻结行为 · `core/ai.js` 场景层 + `ui/ai-scene.js`）

### ① 整卷总评（交卷后）

- **简报即事实来源**：`examBrief(summary, questions, {answers})` 产出给模型看的正文，同时抽出
  `facts`（强/弱证据）供反套话闸门判定。**`answers` 必须传**：交卷结算的 `per[]` 里没有"你答了什么"
  （那是回看层才拼的字段），不传就会把每一行都写成"（未作答）"。正确答案一律走 `QuizCore.answerText`。
- **必须先确认再发**：`runReview(..., {confirmed:true})` 才算数；不给就是
  `{ok:false, needConfirm:true, confirm}`，**零请求**。`confirm` 带 `promptTokens`（用 `estimateTokens` 同一口径）、
  `wrongCount/total` 与一句人话说明 —— 这就是"整卷操作要弹消耗确认窗"的落地。
- **反套话闸门** `checkReviewGrounding`：三处文本（总评/薄弱考点/建议）里必须命中**强证据**
  ——百分数、`得分/满分`、`答对/总题数`、`<非零得分>分`、或**错题题面前 6 个字**；
  只命中 `1`/`0` 这类弱整数**不算**（"每天复习 1 小时"这种通用建议必须被拦住）。
  命中不了 → `stage:'grounding'`，原因："读起来像通用套话，已拒绝"。
- 结构：`review` 任务要求 `summary`（非空字符串）+ `weakPoints`/`advice`（**非空数组**）。

### ② 举一反三（误答本里一键出同考点新题）

- `mistakeBrief(question, entry)` 把"原题 + 你当时的错答 + 错了多少次 + 最近得分"拼进提示词
  （`singleRequest('variant', q, {context})`），让新题**冲着那个误区**去。
- `runMistakeVariant` 复用单题路径（**1 次请求、不重试、四件套闸门**），不弹消耗确认。
- `appendVariant(store, examId, question)` 一键加入试卷：三道闸门（`validateQuestion` → 卷册层
  `appendQuestions` 校验 → 归一策略），返回 `{type, inGroup, groupCount, before, after}`。
  ⚠ **追加时会重新分配 id**，所以必须以 `appendQuestions` 返回的 `accepted[]` 为准 ——
  拿追加前的 id 去卷子里找永远找不到（实测踩过：`inGroup` 恒为 false）。
  ⚠ `groupQuestions` 的元素是 `{index, question}`，不是题目本身。
- **两个 store 不能混**：密钥在 `secret`、题库在 `app`。`AiScene.mountMistake({keyStore, examStore})`
  分别接；混成一个的话"生成"能成、"加入试卷"必然找不到那套卷。
- 失败一律可读：`stage` ∈ `provider`（不可直连/未知家，零请求）/ `call`（鉴权/限流/网络，带 `kind2`）/
  `schema` / `completeness` / `grounding` / `store` / `no_exam_store`。

### 两个面板的分野（别混）

| | 单题（ai-single） | 整卷总评（ai-scene.mountReview） | 举一反三（ai-scene.mountMistake） |
|---|---|---|---|
| 消耗确认窗 | **不弹** | **必弹**（token 更大） | **不弹**（单题） |
| 请求数/点击 | 1 | 确认后 1（未确认 0） | 1 |

## 二十七、容错与提示（已冻结行为 · `core/ai.js` 健壮性层）

### ① 脏输出容错：12 类，**不抛异常、不崩页**

`safeParseJson(raw)` 三级策略，**永不抛异常**（这是硬承诺，测试逐类断言）：

| # | 脏法 | 归谁管 |
|---|---|---|
| 1 | 代码围栏 ` ```json … ``` `（含只开没关的半截） | 去围栏 → 平衡块裁剪 |
| 2 | JSON **前面**有废话 | 平衡块裁剪 |
| 3 | JSON **后面**有解说 | 平衡块裁剪 |
| 4 | 中文引号 `“ ”` `‘ ’` | 全角→半角 |
| 5 | 单引号 `'a': 'v'` | 单引号→双引号 |
| 6 | 尾逗号（`{…,}` / `[…,]`） | 去尾逗号 |
| 7 | 无引号键 `{a:1}` / 全角冒号 | 补键名引号 + 冒号归一 |
| 8 | 截断（括号/字符串未闭合） | 补未闭合括号/引号，丢末尾残缺键值 |
| 9 | 字符串内含花括号 `"{a}"` | 平衡扫描**尊重字符串**（不误判） |
| 10 | 字符串里裸换行/制表符 | 转义成 `\n` / `\t` |
| 11 | JSON 里混 JS 注释 / `True`·`None`·`undefined` / BOM·零宽字符 | 去注释、字面量归一、去不可见字符 |
| 12 | 纯散文（压根没有 JSON） | **字段抽取降级**（`strategy:'fieldFallback'`） |

- 三级策略名可核对：`direct` / `repaired`（带 `fixes[]` 说明改了什么）/ `fieldFallback` / `failed` / `empty`。
- 彻底解析不了 → `{ok:false, strategy:'failed', raw: 原文前 400 字}`，**由调用方决定提示**，解析层不替它做决定。

### ② 错误分类：`classifyError(err, status, body)`

| 情形 | kind | 提示要点 |
|---|---|---|
| 断网/跨域 | `cors_or_network` | 确认没在用不支持 CORS 的家（如 OpenAI）；断网时 AI 本就不可用；查代理/VPN |
| 密钥无效 401/403 | `auth` | 到设置页重填 Key，别填错供应商 |
| **模型不支持 JSON 模式** | `json_unsupported` | **专用分类**（靠响应体里的 `response_format`/`json_object`/`json mode` 判）；建议关掉 JSON 模式——容错解析能兜 |
| 限流 429 | `rate_limit` | 等几秒，或把批量拆小 |
| 余额 402 / 模型名 404 / 5xx / 超时 | `billing` / `not_found` / `server` / `timeout` | 各自可操作 |
| 其它 400 | `bad_request` | 参数不支持（含"可能不支持 JSON 模式"的通用说法） |

⚠ `body` 必须一起传：只按状态码判不出"不支持 JSON 模式"（`callAi` 已把响应体交给分类器）。

### ③ 重试与批量确认

- **结构不符/脏 JSON → 自动重试**：`callAi(..., {retries})`（429 与 5xx 也重试；401/403 直接断，重试没意义）。
  重试用尽 → 失败信息带上缺了什么（`kind:'schema'`，`text:'字段不完整：…'`）。
- **批量**（`planBatch` / `runBatch`）：
  - `planBatch(kind, questions)` → `{requests, promptTokens, expectOutputTokens, totalTokens, perItem[], message}`；
    消息里写清"发几次请求 + 预计多少 token"，界面直接显示，**不许自己另算**。
  - 未确认 → `{ok:false, needConfirm:true, confirm}` 且**零请求**；确认后逐题跑，**单题失败只跳过那一题**。
  - 默认 `retries:1`（批量值得重试）；逐题结果含 `stage/errors/hint`，可用于展示与落库。
- **预期输出量按任务给**（真调用校准，见 `EXPECT_OUT`）：`explain 170 / variant 200 / difficulty 40 / review 220 / keywords 120`。
- **估算精度**：`estimateTokens` 沿用"中文 1 字≈1 token、英文 4 字符≈1 token"，prompt 侧实测偏差 ≤23%；
  真实用量由 `callAi` 从响应的 `usage` 原样带回（`{promptTokens, completionTokens,totalTokens}`），
  `runBatch` 汇总成 `actual` 与 `deviation`，`estimateReport(pairs)` 给出样本偏差与 `within60` 判据。
  **实测**（百炼 qwen-plus，`verify/real-ai-last.json`）：单题解析 **5.1%** / 整卷总评 **8.6%** / 批量 3 题 **21.9%**（阈值 <60%）。
- **界面分野**（别混）：单题面板**无**确认窗；批量面板与整卷总评**必弹**确认窗；单题模板 `retries:0`，
  批量默认 `retries:1`。

## 二十八、脱敏打包（已冻结行为 · `core/data.js` 分享段）

### 输入形状（**两种都收**）

`state.exams` 可能是数组（测试/临时构造），也可能是**映射** `{[id]: exam}`
（`SchemaCore.createAppState()` 就是这个形状，契约第二章）。`examsOfState(state)` 负责归一 ——
早先只认数组，导致唯一入口喂真实 AppState 直接 `TypeError`（红队 P1）。

### 字段白名单（唯一真相源）

- 顶层：`{kind, schemaVersion, exportedAt, exams}` —— `settings/records/wrongbook/progress/draft` **连键都不出现**。
- 卷层 `SHARE_EXAM_FIELDS`：`id/title/config/configLocked/questions`。
- 题层 `SHARE_QUESTION_FIELDS`：`id/type/stem/options/answer/answerLetters/judgeValue/keywords/explanation`。
- **容器类字段递归剔除敏感键**（`stripForbidden`）：`config`/`options`/`keywords` 里任何层级的
  `isForbiddenKey` 命中都整条删（`x-api-key`、`accessToken`、`secretKey`、`clientSecret` 这类
  **复合键名**按 camelCase/snake/kebab 切词后判定）。
  敏感词表含**裸 `key`** 与复数/凭证同义词（`key/token(s)/secret(s)/cookie(s)/privatekey/accesskey/secretkey/bearer`…），
  键名先做 **NFKC 归一**（全角 `ａｐｉＫｅｙ` 也认）。
  白名单例外只有业务上真要保留的四个：`keywords/keyword/keypoints/record`
  —— ⚠ `keys` 在第七轮**从例外里删掉**了（放行它没有业务理由，还会造成"剥离放过、扫描说命中"的自相矛盾）。
- **深度超限 fail-closed**（`STRIP_MAX_DEPTH = 32`）：超深子树**丢掉**，不原样带出。
- 容器一律**深拷贝**：改载荷不会穿回原卷（无别名）。

### 敏感扫描（三层判据）

`shareScan(payload, {secrets, minSecretLength})`：

1. **密钥形状**：`SECRET_SHAPES` 八种（`sk-` / `Bearer` / JWT / `ghp_` / `xoxb-` / `AKIA` / `AIza` / 私钥块）
   —— 只认 `sk-` 是实测过的漏网；
2. **敏感字段名**：`isForbiddenKey`（含复合键名切词），**值为 null 也报**（键名本身就是线索）；
3. **来源机密值级比对**：把 `secretsOfState(state)` 收集到的机密（`state.secrets`、`settings.apiKeys/keys/apiKey`、
   `records[].answer`…）与载荷逐串比对，**比对前归一空白与零宽字符**（长 key 折行/被复制夹零宽空格都拦得住）。

> ⚠ 第 1、3 层扫的是"载荷里所有的**文本**"，**包括对象键名**：`{'sk-…':['应用程序接口']}` 这种
> "把密钥写进同义词表键名"的写法，在"只扫值"的实现里完全隐形（红队第七轮 P3，现已钉住）。
> 只有第 2 层（字段名语义）在同义词表路径上被跳过 —— 见下文「用户数据 vs 配置字段名」。

> `findSecrets` 是**宽口径结构体检**（只认有值的敏感键），**不是闸门**；闸门是 `shareScan`。
> 两者语义不同是**有意**的，各有一条断言钉住（`share-payload.test.js` ①-A/①-F）；
> 键名形状扫描两边口径一致（都扫键名文本）。

### 内嵌与出厂入口

- `payloadBlock(payload)`：JSON 里 `<` → `\u003c`、U+2028/U+2029 → 转义，所以**载荷块内部不会有裸 `</script`**。
- `embedPayload(html, payload, {secrets, allowUnsafe})`：
  - **函数式替换**（`replace(re, () => tag)`）—— 直接传字符串会让 `$&`/`` $` ``/`$'`/`$$` 当**替换模式展开**，
    把题干里的 `$$x^2$$` 静默改成 `$x^2$`、甚至把模板原文塞进载荷（红队 P1）；
  - 已有块识别走**唯一**的定位器 `findPayloadBlocks`（注释掩码 → 按**解码后**的 id 找开标签 → 自行配对它的收尾标签），
    **内嵌/读回/计数/残留自检全都调它**；`payloadBlockRe`/`allPayloadBlocksRe` 那套"明文正则"已在第七轮删除
    （两套判据并存时实测"计数说 1 个、读回说没有载荷"）；
  - id 解码 `decodeCharRefs` 按 HTML 规范实现：`&#101;`、`&#x65;`，**以及无分号的 `&#100`**
    （仅当后面紧跟 `=` 或 ASCII 字母数字时**不解码**）—— 浏览器在 DOM 里就是按这个规则认 id 的；
  - 注释走唯一的 `commentRegions`：注释内的载荷痕迹 → 拒绝（否则注释里的开标签会和注释外的 `</script>` 配错对、
    把模板 JS 整段删掉）；**未闭合的注释开符 → 拒绝**（浏览器会把从那里到文件尾全当注释，载荷会被吞掉）；
  - **半截的 script 开标签**（到文件尾都没有 `>`）单独查（`unterminatedScriptTags`）：定位器看不见它，
    只要里面出现 payload id 就拒绝；属性值里的 `>` 不算收尾（不误判真实模板）；
  - ⚠ `core/data.js` 会被内联进成品的 `<script>`，所以源码里**不得出现注释开符的四个字符原始形态**
    （HTML 会切进 escaped → double-escaped，真正的 `</script>` 失效）：需要时一律用常量 `COMMENT_OPEN`
    （`'<\!--'`）。`verify/inline-order.test.js` 对五个成品有"全文件 0 个"的硬断言；
  - 插入点取**最后一个** `</body>`（模板 JS 字符串里出现 `"</body>"` 时不能插错位置）；
  - **缺 `secrets` 直接抛 `E_NEED_SECRETS`**：不许默默跳过第 3 层判据；要跳过必须显式 `allowUnsafe:true`；
  - 载荷不干净 → **抛错拒绝内嵌**。
- **`buildSharePackage(state)` / `buildShareHtml(state, html)`** 是唯一出厂入口：
  生成 → 体检（secrets 从 state 现算）→ 只有零命中才交出 `{ok:true}` / HTML；
  脏内容**不静默改写用户题面**，只报路径与原因。
  ⚠ 交付边界：**页面接线属下一小类「独立 HTML 生成」**，本小类只交付库与闸门（红队要求如实登记）。

### 内嵌的"清不干净就不写"（`embedPayload` 的三道防线）

1. **自闭合块** → `E_SELF_CLOSING_BLOCK`（HTML 不支持自闭合 script，正文边界不确定）；
2. **清得掉的拼法就清干净**：`<script/id=…>`（斜杠作分隔符）、`id="exam&#45;payload"`（实体编码）、
   `id="&#101;xam-payload"`、`id="exa&#109-payload"`（无分号数字引用）、属性换行 —— 一律**解码 id 后逐个配对删除**，
   连收尾标签一起、并吞掉紧跟的一个换行（逐字节幂等）；
3. 清完之后再扫一遍：只要还残留带 payload id 的 script 开标签（含**未闭合**的）→ `E_UNSAFE_PAYLOAD_BLOCK` 拒绝。
   反向保护：模板里只是**提到** id（例如内联的 `const PAYLOAD_ID = 'exam-payload'`）不会被误拒。
4. **半截开标签**：`unterminatedScriptTags` 单独查"到文件尾都没有 `>`"的 script 开标签 ——
   这种写法正则匹配不上、定位器**根本看不见它**（计数 0 个），只要它里面出现 payload id 就拒绝（尊重引号，
   属性值里的 `>` 不算收尾）。
- **清不掉就拒绝，不猜**：未闭合注释开符、注释内的载荷痕迹、自闭合块、半截开标签，全部 fail-closed。

### 用户数据 vs 配置字段名（同义词表）

`config.short.synonyms` 的**键是关键词文本**（`{'API':['应用程序接口'],'token':['令牌']}`），属于**用户数据**：
- 脱敏侧**原样保留**（只深拷贝，不按敏感词表剔键）；
- 扫描侧对这条路径**只跳过"键名语义"判据**（否则用户自己的同义词表会把整包卡死），
  但**键名文本照样过形状/串味两关** —— 在这条路径上写 `{'sk-…':[…]}` 一样会被拦（红队第七轮 P3）。
早先没做这个区分时，同义词表被静默剔空 → 同一份作答判分从 5/5 掉到 0/5，而扫描还报"零命中"（红队第五轮）。

### 已知边界（红队第七/八轮实测后如实登记）

- **id 的实体解码只覆盖数字引用 + 5 个命名实体**（`quot`/`apos`/`lt`/`gt`/`amp`），且**不做属性值空白折叠**：
  `id="&Tab;exam-payload"`、`id="&#9;exam-payload"` 这类"空白实体"写法，浏览器解出来的 id 是 `"\texam-payload"`，
  与字符串 `exam-payload` **并不相等**（`id` 属性不做空白归一）。
  所以它既**不是**我们的块（不会被误读、也不会产生第二个同 id 元素 —— 红队在真 Edge 实测
  `querySelectorAll('[id="exam-payload"]').length === 1`、`getElementById` 拿到的是新块），也**不会被清理**。
  ⚠ **残留风险（显式登记，不修）**：这种旧块的字节会留在重新导出的文件里（含它自己的旧内容）。
  要彻底清掉需要"解码后再归一空白"比对一次，会把误清面扩大（`\t`/`\n` 开头的普通 id 也会被当成我们的块），
  评估后**不做**；其余实体写法一律按"非同类"处理。

## 二十九、独立 HTML 生成（已冻结行为 · `core/data.js` 导出段 + 答题页接线）

一句话：**把当前这套卷连同整个答题页打成一个文件**，别人双击就能离线作答。

### 库层（`core/data.js`，三个新导出）

- `exportStandalone(state, shellHtml, opts)` —— **唯一入口**：`buildShareHtml`（脱敏 + 体检 + 内嵌）→
  `shareFileName` 命名 → `externalRefsIn` 外部引用自查。任一步不过 → `{ok:false, html:null}`，
  调用方拿不到可写出的东西。
  - ⚠ **壳由调用方给**：页面在**挂载前**抓一次 `document.documentElement.outerHTML`。库不去抓 DOM ——
    挂载之后的页面带着作答界面与运行时残留，抓它等于把"上一次的界面"一起打包。
- `shareFileName(exam, at)` —— `＜标题＞-＜YYYYMMDD-HHmm＞-＜卷id尾＞.html`。
  三段各有用途：标题=可辨识；时间戳=同一份卷反复导出不互相覆盖；卷 id=同一分钟的不同卷也不撞名。
  标题先过 `sanitizeFileName`（控制字符/`\/:*?"<>|` 换成 `_`、收掉首尾点与空格、截 40 字、空则 `未命名试卷`）。
- `downloadHtml(html, filename, env)` —— Blob（`text/html;charset=utf-8`）+ `URL.createObjectURL` +
  `a[download]` + `click()` + **`finally` 里 `revokeObjectURL`**；临时链用完就摘掉。
  - 依赖三件套（`Blob`/`createObjectURL`/`a[download]`），缺任何一件 → `{ok:false, reason}`+人话提示，
    **不抛异常也不静默失败**；`{document,url,Blob}` 可注入（Node 里能整条跑一遍）。
  - 注入语义：**键存在就以此为准**（`{url:null}` = 这个环境没有它），键不存在才回落全局。

### 外部引用自查（`externalRefsIn`，判据在**剥体后**的文本上）

- 只看**标签属性**：任何标签的 `src`、`<link>` 的 `href`、`<style>` 里的 `@import`、行内 `style` 里的 `url(http…)`。
- **不能直接搜 `http://`**：页面正文里的 AI 端点（`https://dashscope…`）是**数据**，一并算作违规会天天误报。
- **必须先剥掉 `<script>`/`<style>` 正文**（`maskRawBodies`，等长替换）：本文件会被内联进成品的 script 里，
  源码中的字符串字面量（`'<script src="' + x`）在整篇文本看来就像真标签 —— 实测会被自己的源码骗到
  （干净页面被判出 1 个 `<script src>` + 2 个 `<link>`）。真浏览器不这么解析（script 是 raw text）。
- 为什么非查不可：导出拿的是**运行时页面**，浏览器插件注入一条 `<script src=…>` 就能把
  "零外部引用、断网可用"破掉 → 发现就**拒绝交出**（附 `refs` 与人话提示：换干净窗口重导）。

### 页面接线（`answer-template.html`，静态锚见 `verify/wiring.test.js` ⑧）

- 顶栏按钮 `id="btnExport"`「导出为独立 HTML」。
- **挂载前**抓壳：`const SHELL = '<!doctype html>\n' + document.documentElement.outerHTML;`
- 启动顺序：**先读自带载荷**（`DataCore.extractPayloadDetailed(srcHtml)`）→
  有题目就用它 `boot`；没有才回落题库首页（内置样卷已改成首页那颗按钮，不再自动加载）。
  这就是"导出的文件双击即加载该试卷"。
  - ⚠⚠ **读载荷必须等 DOM 解析完**（`whenParsed`：`readyState==='loading'` → 挂 `DOMContentLoaded`，
    否则直接跑）。原因：载荷块被 `embedPayload` 插在**最后一个 `</body>` 之前**，也就是插在页面逻辑
    那段脚本的**后头**；脚本是边解析边执行的，跑在那里时 `documentElement.outerHTML` 里**还没有**载荷块
    → `extractPayload` 恒为 null → 收件人打开分享文件只看到空题库首页（出题者本机因为题库里本来就有那卷，
    完全看不出来）。这是"手机端导出带的试卷在别的浏览器打开看不了"的根因，别再改回去。
    真机闸门：`verify/open-share-gen.js` + `open-share-parse.js`（打开成品看那套卷有没有自己出来）。
  - ⚠ 载荷**读得出来但坏了**（JSON 坏 / 块被截断）→ 必须当面报原因（红字 + 让出题者重发），
    **不许**默默落回空题库（那等于"打开了但没试卷"，出题者拿不到任何线索）。
- ⚠ **取 `window.localStorage` 这个动作自己会抛**（隐私模式 / 有的浏览器 `file://` 下 `SecurityError`）：
  任何在页面初始化路径上碰它的地方都要自己 `try` 住。`storageHealth(window.localStorage)` 曾经没兜 →
  整个答题面板逻辑当场中断、连提示都没有 → 收件人那边是"一片空白"。拿不到后端就传 null 给
  `storageHealth`（它本来就有一条"没有存储"的人话告警）。

### 打开分享文件时的兜底（`app-template.html` 顶部那段「启动自检」+ `<noscript>`）

一句话：**收件人遇到任何"打不开"，都必须看到一句能转述给别人的中文**，禁止白屏。

- 自检脚本**必须排在整份文件最前面**，而且只能写 **ES5**（老引擎连它都跑不了就彻底没兜底了）：
  注册 `window.onerror`（捕获阶段）/ `unhandledrejection` → 收集错误；
  DOM 就绪 1.2 秒后若 `window.__quizBooted` 仍是 false → 铺开红条（文件名 / UA / 错误清单 +
  「复制诊断信息」按钮）；启动成功但报过错 → 只挂一条可关闭的细提示；之后每 0.5 秒复查、最多 20 秒。
- 启动成功的旗子 `__quizBooted = true` 由**壳**在 `showTab('answer')` **之后**插（切面板自己抛错也算没启动）。
- `__quizBooted` / `__quizDiag` **只能小写开头**：`build.js` 的占位符闸门把 `__[A-Z]+__` 当没填的占位符。
- `<noscript>` 里写清楚"要靠 JavaScript + 换 Chrome/Edge/Safari 打开"（手机自带的 HTML 查看器不跑脚本）。
- ⚠ 这条自检**当场抓到过一个自己写的回归**：把 `EMBEDDED` 包进 `startFromPayload` 之后成了函数局部变量，
  `paintLibrary` 里 `if (EMBEDDED && …)` → `ReferenceError`（异步：页面看着能用，只是那一段永远不出现）。
  载荷读出来的结果（`EMBEDDED`/`PAYLOAD_BAD`）**必须留在面板作用域**上。
- 点导出：从当前会话拼一个最小 state（`exams:[{id,title,config,configLocked,questions}]`）+
  把本机保存的 AI 密钥（`AiCore.allKeys`）当**来源机密**送进扫描 → `exportStandalone` → `downloadHtml`。
- ⚠ 交付边界：**收件人侧的数据隔离（`recv_` 前缀那套）属下一小类「接收者隔离」**，本小类用载荷里原来的卷 id。

### 从题库选题（`answer-template.html` · 「导入之后答不了题」的修复）

**报障**（用户实测）：导入 → 校对 → 确认入库之后，答题页**找不到那套卷** ——
答题页原先只认"自带载荷 / 内置样卷 / 拖进来的文件"，而入库的卷躺在题库（`exam::<id>`）里没人读。

三条链（缺一条就还是答不了）：

| 入口 | 做什么 | 落在哪 |
|---|---|---|
| 答题页「从题库选题（N）」 | 展开题库列表（标题 · 题数 · 逐题型构成 · 待校对 · 更新时间）→ 点「答题」把该卷挂成一轮 | `libpick-btn` / `.libpick-row` / `.libpick-go` |
| 入库回执旁的「去答题」 | 入库成功后就地转交：切到答题页 + 挂上刚入库的这套卷 | `review-template.html` 的 `.gopractice` → `window.__answerLoadExam(id)` |
| 切回答题页刷新 | 「从题库选题（N）」上的套数要立刻反映刚入库的卷 | `app-template.html` → `window.__answerRefresh()` |

- **题库面板是运行时动态创建的**（`document.createElement`，挂 `#host` 外面）：不写死 id → 不必进
  `RUN_PANE` 的 idMap，也不会与别的面板撞 id（合并版的 id 唯一性检查只扫静态标记）。
- 挂卷时用 `QuizCore.resolveConfig(null, exam)`：**判分口径跟着卷自己的配置（含锁定快照）走**；
  `allowResume=true` → 同一套卷接着上次答（进度键就是卷 id）。
- `window.__answerBoot(examId)` 是答题面板暴露的唯一入口，`__answerLoadExam`（合并版）只做
  "切页签 + 转交"，**不在 shell 里重复实现任何逻辑**；两个钩子在独立单页版里都不存在 → 按钮自然不出现。
- 空题库/存储不可用时给**人话**（"去「导入 / 校对」导一份并确认入库…"），不是一片空白。
- ⚠ 已知边界（如实登记）：挂「答整卷」时喂的是**整卷**（240 题就 240 题）；「抽一轮」按抽题设置抽一批。

### 抽题怎么用（`pickQuestions` 接进答题流程 · 这一条以前是"空转"）
**背景**：抽题引擎（`QuizCore.pickQuestions`）与面板设置早就做完并测过，但**零调用者** ——
面板上改「抽题规则 / 本轮题量 / 逐题型分配」不影响任何地方（用户实测问"抽题功能怎么使用"）。

现在两条路（都在答题面板，**点的时候才抽**）：

| 操作 | 抽什么 | 进度键 |
|---|---|---|
| 题库列表「答整卷」 | 卷里全部题 | `progress-all` |
| 题库列表「抽一轮」 | 按**卷自己的配置**（`resolveConfig(null, exam)`）抽一批 | `progress-<题集指纹>` |
| 题库面板「按当前设置重开一轮」 | 按**当前会话的配置**（= 底部快捷面板刚改的那份）重抽 | 同上（换了批次就换键） |
| 题库面板「换一批」 | 同上，且**种子 +1**（同一套卷换一批题） | 同上 |

- **"什么时候生效"必须在界面上说实话**：底部面板的抽题那一组现在带一句
  「这些设置决定「下一轮」抽哪些题：正在答的这一轮不换题；改完去「从题库选题」点「抽一轮 / 按当前设置重开一轮」才生效」。
- 抽完的提示语写明**怎么抽的、抽了多少、缺什么**：
  「本轮按设置抽了 9 题（单 3 · 多 2 · 判 4 · 简 2） · 提示：题库不够：简答要 2 只有 0（缺 2）…」——
  题库不够时**不静默少抽**（缺口由 `pickQuestions` 的 `warn` 一路带到界面）。
- ⚠ 换轮次后**不许**再冒"已自动保存"把新提示语盖回去（用轮次序号 `roundSeq` 判：属于上一轮的保存不报），
  并且换轮次前 `cancelFlash()`（实测踩过：标题写着"抽一轮 9 题"、提示语还停在"整卷 240 题"）。

### 答题面板的形态：题库首页 / 答题中（用户要求：工具不折叠、题库就是首页、能返回、不默认加载样卷）

```
[顶栏]  答题页（离线·单文件）   提示语
        [返回题库] [导出为独立 HTML] [拖入 .docx / .txt 换一套题]     ← 直接摆出来，**不再有 <details> 折叠**
[首页]  题库 · N 套
          上一轮：《X》16 题（按设置抽的一轮）  [继续这一轮] [按当前设置重开一轮] [换一批]
          《X》240 题（单100·多80·判60） · 时间                [答整卷] [抽一轮]
          不想用题库？也可以直接拖入 .docx/.txt，或载入内置样卷看看。  [载入内置样卷]
[作答]  #host 里是作答界面 + 底部快捷面板（首页收起）
```

- **首页就是默认视图**：启动时先看有没有自带载荷（分享文件仍然"双击即开答"）；没有 → `showHome()`。
  ⚠ **不再默认解析内置样卷**（用户明确要求）；样卷改成首页底部那个按钮（`loadSample()`）。
- **答题中能返回**：`goHome()` = 记下当前这一轮的设置（`roundCtx.cfg`）→ `flushSave()` 把未落盘的进度写掉 →
  `view.destroy()` + `window.__attempt = null` → `showHome()`。回来时「上一轮」那一行还在，可继续/重开/换一批。
  - ⚠ 那一步"记下设置"不能省：面板是作答界面的一部分，回了首页就没有面板了；
    不记的话"答题时改设置 → 回首页 → 重开一轮"会按**旧设置**重抽（真浏览器实测踩过）。
- **顶栏两个按钮只在该出现时出现**（`showHomeChrome`）：没在答题时 `导出` 无卷可导、`返回题库` 无处可回。
- ⚠ 首页/工具的样式由**页面逻辑自己注入**（`LIB_CSS`）而不是写在模板的 `<style>` 里：
  合并版只搬运"页面逻辑"这一段，模板的 `<style>` 不会跟着过去 —— 写在 `<style>` 里就会出现
  "独立页好看、合并版裸奔"（实测：合并版里题库首页一度完全没有样式）。
  `<style>` 插在 `#host` 之前（body 里的 `<style>` 是合法的），省得去够 `head`。

## 三十、接收者隔离（已冻结行为 · 答题页落盘空间切换）

**问题**：`file://` 下所有本地 HTML 共享同一份 localStorage。出题者与接收者若用同一个空间，
接收者的作答就会覆盖出题者的记录，两份分享文件之间也会互相串进度/错题。

**规则（唯一开关在答题页）**：

| 打开的是 | 落盘空间 | 依据 |
|---|---|---|
| 自己拖进来的 / 内置样卷 | `DataCore.NS_GLOBAL`（`app`） | 出题者自己的记录本来就住在 `app` |
| **别人分享来的文件**（自带载荷） | `DataCore.receiverNamespaceFor(载荷里的卷)` = `recv_<卷id>.<内容指纹>` | 空间名由**文件内容**决定，不依赖本机存储 |

- ⚠ **为什么还要内容指纹**（组级红队抓到的真漏洞）：卷 id 会撞名 —— 两个人都把题库文件叫 `题库.docx`
  （答题页正是拿文件名当卷 id），或者都用内置样卷 `sample.docx`。只按 id 建空间，**甲的文件能看到乙的错题**。
  指纹只看载荷内容（标题 + 题数 + 每题 id/题型/题干前 24 字/答案前 8 字，FNV-1a 32 位），于是：
  **同内容反复打开 → 同一个空间（续答不断）；内容不同（哪怕 id 一模一样）→ 不同空间（互不串）**。
  `receiverNamespaceFor` 是**唯一正确入口**（页面与测试都只调它）；`receiverNamespace(id)` 留给底层拼名字。

- `makeStore()` 读 `storeNs` 变量 → 进度（`AttemptCore.createProgressStore(makeStore(), {examId})`）
  与错题（`WrongCore.collectToStore(makeStore(), …)`）**共用同一个命名空间来源**，没有第二条写入口。
- **前缀边界靠 `::`**：`isInNamespace` 要求 `ns + '::'` 前缀，所以 `recv_A1x` 不会被 `recv_A1` 认领
  （朴素 `startsWith` 会认领 —— 这是隔离最典型的翻车方式）。
- **脏卷 id 挡板**：卷 id 会变成空间名，含命名空间分隔符 `::` 的 id 会让 `createStore` 抛错白屏
  → 页面**先挡**：`String(e0.id).indexOf(DataCore.NS_SEP) >= 0` 就拒绝载入并说明原因（fail-closed）。
- **判分口径跟着卷走**：接收者用 `QuizCore.resolveConfig(QuizCore.DEFAULT_CONFIG, 载荷里的卷)`，
  于是出题者锁定的分值/半对规则在接收者那边**一模一样**（不是按接收者本机的默认配置算）。
- 清空接收者空间的数据后重新打开分享文件：**试卷仍完好** —— 它来自文件内嵌载荷，本机存储只放记录。
- ⚠ 不在本小类范围：接收者的**卷册/索引/删卷**等管理面（`recv_` 空间里的 `exam::…` 条目、删卷级联）
  只用到"记录"这一半；管理面属后续工作，别把它当成已交付。

## 三十一、断网可用与内存态降级（已冻结行为）

**离线边界（唯一允许联网的地方是 AI）**：五个成品按内联模块切区后逐区扫
`fetch(` / `XMLHttpRequest` / `new WebSocket` / `sendBeacon` / `new EventSource` ——
**除 AI 模块（`core/ai.js`、`ui/ai-*.js`）外一处都没有**；页面自己的脚本里也没有。
导入 / 解析 / 答题 / 判分 / 错题本 / 导出全部只碰本机（`verify/offline-degrade.test.js` ①）。
⚠ `浏览器自检.html` 是**诊断页**：它提供一个"测一下 API 通不通"的按钮，点它才会联网 —— 故意如此，单独说明。

**存储体检 `DataCore.storageHealth(backend)`**：**真写一次 → 再读回来 → 删掉探测键**，才回答能不能存。
只看 `typeof localStorage` 是不够的（隐私模式/配额满时对象在、一写就抛）：

| reason | 触发 | 文案必须说清 |
|---|---|---|
| `ok` | 写进去、读回来一致 | 可用 |
| `no-backend` | 没有 localStorage 对象 | **不会被保存** + 换普通窗口（非隐私模式） |
| `quota` | `setItem` 抛（配额满/被策略禁） | **不会被保存** + 清存储/换窗口/先别刷新 |
| `unreliable` | 写进去读不回（被清理或被同步策略改写） | **不保证能保存** + 换窗口或先导出留档 |

- 探测键是 `app::__probe__`，**用完立刻删**（不给用户留垃圾）。
- 答题页在**抓壳之后、挂载之前**体检一次；`degraded` 就把 `message` 原样显示在顶部
  `#storeWarn`（红字）——**开页就说**，而不是等第一次自动保存失败。
- 降级不等于停摆：写入失败一律返回 `degraded:true` / `persisted:false` + 人话提示，
  答题与判分照常（进度、错题在**内存态**里继续，刷新后丢失）。**绝不假成功**。
- 错题本落盘失败的文案：`错题本写不进本机存储（<原始原因>）：这次只记在内存里，刷新后会丢失。`
  （原始异常名不再直接甩给用户，只作括号里的排查线索。）

**四类失败场景的可读提示**（原因 + 下一步动作，不允许只有错误码）：

| 场景 | 出口 | 形态 |
|---|---|---|
| 文件解析失败 | `QuizParser.parseDocx` | `{ok:false, code, message, hint}`，`hint` 是"另存为 .docx / docx 本质是 zip / 请选择有效文件"这类动作 |
| 格式错误 | `TextFormatCore.importExam` | `errors[]` 每条带 `line`（第几行）+ `code` + 中文 `message` + `hint`（该写成什么样） |
| AI 失败 | `AiCore.callSaved` | `{ok:false, kind, hint}`：`auth` / `json_unsupported` / `cors_or_network` 等分类，`hint` 指向设置页或"关掉 JSON 模式" |
| 存储不可用 | `DataCore.storageHealth` | 见上表（`no-backend` / `quota` / `unreliable` 各一句人话） |

## 三十二、窄屏与触屏布局（已冻结行为 · 体验模式）

**做法**：不靠"改完看着差不多"，而是拿**真浏览器**（headless Edge）渲染**内容宽 375px** 的画面，
把实测数字**画在页面顶部**一起截出来（截图 + 数字出自同一次渲染）。

- ⚠ `--window-size` **管不了 headless 的布局视口**（实测 492/511/526 全看它心情），
  而这三个页面是**纯流体布局、零媒体查询**（已 grep 核实），所以取证脚本直接把 `html/body` 的宽度钉成 375px
  ——对布局与"真的 375px 视口"等价。`position:fixed` 的元素按视口算，测量时剔除并单独标注。
- 复现：`node verify/narrow-evidence-gen.js` → Edge 出 `--screenshot` + `--dump-dom` → `node verify/narrow-evidence-parse.js`
  → `verify/narrow-numbers.json`；截图是 `docs/narrow-shot-{answer,review,wrong}.png`。

**冻结下来的事实**（`verify/narrow-layout.test.js` 是它的回归锚）：

| 页面 | 内容宽 | 右溢 | 触点<44px | 块级重叠 | 正文<13px |
|---|---|---|---|---|---|
| 答题页 | 375px | 0 | 0 | 0 | 0 |
| 校对面板 | 375px | 0 | 0 | 0 | 0 |
| 错题本 | 375px | 0 | 0 | 0 | 0 |

- **触控尺寸是一等公民**：八个交互模块共 26 条 `min-height` 规则，**最小的就是 44px**
  （作答选项/按钮 48px、快捷面板 44px、删卷弹窗 52/44px…）。本轮补掉两个漏网的：
  答题页拖入区 39px→44px、错题本「删除这套卷」38px→44px；错题本条目说明 12.5px→13px（手机上偏小）。
  （拖入区后来**整块搬到了导入 / 校对页**：同一条 44px 规则现在由 `review-template.html` 的 `.drop` 承担，
  `verify/narrow-layout.test.js` 的锚也跟着换页了。）
- **窄屏护栏**：答题页/错题本/校对面板统一 `html,body{max-width:100%;overflow-x:hidden}`；
  顶栏 `flex-wrap`；长文本容器 `min-width:0` + 换行兜底；没有任何 >375px 的固定 `width`。
- **安卓上的"选文件"与"下载"**：真 `<input type="file" accept=".docx,.txt,.md">` + 44px 的可见拖入区
  （安卓文件选择器按 accept 筛 Word 文档）；落盘走 `DataCore.downloadHtml`（Blob + `a[download]`），
  环境不支持时给"另存为"的替代路径。
- ⚠ **安卓真机没验**（本机无安卓设备/模拟器），如实登记；`解析器Demo.html` 不在本小类范围内。

## 三十六、界面优化（一轮交互改版 · 已冻结行为）

**行为变更（唯一一处）**：答题页**去掉「提交本题」按钮** —— 改成"点选即记录"。

| | 旧 | 新 |
|---|---|---|
| 记录答案 | 点选项 → 再点「提交本题」 | **点一下就记下**（单选/判断再点可改；多选点选/取消；简答输入即记） |
| 判分/揭示时机 | 每题提交时 | **交卷时统一结算**；配置成"答完一题即显示"时，**离开该题**的那一刻自动提交（否则永远等不到揭示） |
| 锁定 | 提交即锁定 | **交卷前随时能改**（刷题直觉） |
| 前进动作 | 提交 / 上一题 / 下一题 / 交卷 | 上一题 / 下一题 + **右下角常驻「交卷」**（带未答角标） |

其余优化（同批交付）：

- **常驻「交卷」**：`position:fixed` 右下角，未答题数做成角标；点它走原来的"未答确认"流程。
- **快捷面板默认收起**，且展开时**自动把常驻交卷收起来** —— 两者都在屏幕右下，实测会互相压住
  （`.qp-head` 预留 `padding-right:138px` 给常驻按钮，这条有断言钉住）。
- **题号索引可折叠**（`<details>`）：默认只留一行"第 X / Y 题 · 已答 N · 未答 M"，**交卷后默认展开**（那时正要看）。
- **顶栏瘦身**：导出 / 拖入换题收进「工具 ▾」（`<details>`），顶栏只留标题与状态。
- **选中标记不只靠颜色**：选中项出现 ✓ 角标（色弱/强光下也分得清）。
- **简答输入框自适应高度**（132→300px 之间，由 `scrollHeight` 驱动，超上限才滚动）。
- **成绩单可视化**：得分率圆环（`conic-gradient`，`--p` 变量）+ 及格/优秀**刻度条**（红色/绿色刻度 + 0/及格/优秀/100 标尺）。
- **保存轻提示**：自动保存成功后提示 1.6 秒"已自动保存（只在你本机）"；存不上仍由降级提示接管。
- **切到答题页签自动把题干带到眼前**（`scrollIntoView`，只在新文件带载荷或点页签时触发）。

⚠ 本次同时修掉两个**界面缺陷**（都是"看出来的"，静态断言当时全绿）：

1. **底部快捷设置面板从来没显示过**：`AttemptView` 把面板宿主挂在 `av-root` 里面，而 `paint()` 第一行是
   `rootEl.textContent = ''` —— 面板挂上就被下一次重绘整棵清掉。现在宿主挂在 `av-root` **外面**。
   （自检页 K/J 节是**自己**挂面板来测的，所以一直没暴露这条。）
2. **常驻交卷与快捷面板抢位置**：面板表头预留宽度不足时，「展开」按钮和常驻按钮会贴在一起；已加宽并加断言。

### ⚠ 自动判分 / 自动下一题的触发链（**去掉提交按钮时漏掉的，用户实测报障后补回**）

两个开关的语义（`FlowCore.afterSubmit` / `quickModel`，唯一真相源）：

| 开关 | 语义 | 触发点 |
|---|---|---|
| `behavior.autoCheck`（答完一题自动判分） | 答完就判 | **答题的那一刻**（单选/多选/判断）→ `submitCurrent` |
| `behavior.autoNext`（自动翻页） | **答完就翻**（`answered && !finished`，**不要求先判分**） | 答题的那一刻，由 `afterSubmit().willJump` 决定 |
| `behavior.autoNextMs`（翻页等待，毫秒 · 默认 0） | **翻之前等多久**（只管"等多久"，不管"要不要翻"） | 只对"要跳"生效 → `afterSubmit().waitMs`；0 = 核心当场推题号，>0 = 界面排定时器 |
| `reveal.answerTiming=each` + `autoCheck` 关 | 答完即看答案 | **离开该题**时补判一次（没有提交按钮了，这是唯一时机） |
| 简答题 | 判分 / 翻页 | **离开该题 / 交卷**（打字是一串 input 事件：中途判必然误判，中途翻页等于丢掉写了一半的答案） |
| **多选题** | 翻页 | **不自动翻**（要连点好几下，"点完"没有明确信号；点一下 A 就翻会丢 B/D）——刻意取舍 |

- 早先这三条都挂在「提交本题」按钮上；那一轮把按钮去掉时**漏了触发点** → 两个开关成了死开关（用户实测报障）。
- ⚠ **语义变更**（用户明确要求"点完自动翻，不必等判分"）：`willJump` 从 `checked && autoNext && !finished`
  改成 **`autoNext && answered && !finished`** —— "跳 ≠ 判"，两个开关彻底解耦。真相源在 `core/flow.js`，
  界面只问它、不自己判断（`ui/attempt-view.js` 已把 `FlowCore` 补成硬依赖）。
- ⚠ **等待时间的两条铁律**（都是"设了等于没设"级别的坑）：
  ① **核心不许抢跑**：`submitCurrent` 只在 `waitMs === 0` 时推进题号，否则界面刚排上定时器、题号已经被推走了；
  ② **待跳要么被取消、要么到点复核**：`leaveTo` / 换会话 / `destroy()` 都 `cancelJump()`，
     且定时器到点还会`session.index !== from` 复核一次（两道防线，防"一次点击翻两题"）。
- ⚠ 实现上踩过的坑：`kind` / `multi` / `answered` **只存在于渲染模型**（`AttemptCore.view()`），原始题对象上没有 ——
  读错对象会让"多选不翻""已作答才翻"这些守卫**静默失效**；`view()` 里也没有 `answered` 字段，
  要用 `canSubmit || submitted` 表达"这题已作答"。
- ⚠ 面板文案的两个坑：旧标签写的是"判分后自动翻页"、旧备注还写着"要手点「提交本题」才翻"（**陈旧文案**，
  改完语义没跟着改）；备注里 `**加粗**` 会**原样显示**给用户看（截图里真的漏出来过）→ 已去掉。
- 真浏览器实测（`docs/ui-autonext-delay.png`，13 条读数全 PASS）：`autoNext=true`（autoCheck 关）→ 点一下单选选项
  **题号直接 1→2**（**判分卡不出现**，证明"跳 ≠ 判"）；多选点一下**不翻**；简答打字**不翻**；
  配「1 秒」时点完**停在本题**、等够 1 秒才翻；改回「立刻」→ 点完同步翻。
- 非空跑证据：`verify/probe-flow-old.js` **7/7 全红**（③ 去掉 `answered` 守卫、⑦ `waitMs` 恒 0）、
  `verify/probe-attempt-old.js` **4/4 全红**（③ 配了等待却立刻翻、④ 手动翻页不取消待跳）。

### 显示细节（第二轮巡检）

真浏览器里把六个状态逐一量了一遍（`docs/ui-state-multichoice.png` 是多选态截图），修掉三处：

| 现象 | 实测 | 修法 |
|---|---|---|
| 底部白扔一屏 | 面板收起只占 **67px**，而 `.av-root` 固定留白 **210px** → 多出 ~143px 空白 | 留白分两档：收起 **84px** / 展开 **330px**（`.av-panel-open`，跟面板开合同步） |
| 判断题标签重复 | 圆标已是 √/×，文本又写"对（√）" | 文本改成"对 / 错"（实测文字变为 `√对✓ / ×错✓`） |
| 题号摘要重复 | 折叠行又写一遍"已答 N · 未答 M"（上面的徽章已经说了） | 摘要只说"题号（点开跳题）· 第 X / Y 题" |

其余量到的都是**正常**：面板展开时常驻按钮自动隐藏且零重叠（`纵向重叠=0px`）、面板内 24 个控件最大 50×44、
题号 10 格 55×48 两行铺满、多选选中 2 项时 ✓ 角标 2 个可见、题干 327×29 单行、操作行 327×48。

**目标结构**：`review_quiz.html`（约 626 KB）—— 一个文件、三个页签（**答题 / 导入·校对 / 错题本**）、零外部引用、
AI 设置面板在校对面板里、导出按钮在答题面板里。同一个 `app` 空间 → 校对入库的卷答题面板能答，答完交卷错题本面板能看。

**装配方式（关键设计：不复制页面逻辑）**：`build.js` 的 `assembleApp()` 从
`answer-template.html` / `review-template.html` / `wrong-template.html` 里抽出各自的**页面逻辑段**
（起点认 `const SAMPLE_B64 = ` 或"页面逻辑"注释，终点认最后一个 `</script>`），原样放进壳里的 `RUN_PANE(...)`：

- `RUN_PANE(paneKey, idMap, fn)` 给这段逻辑一个**作用域化的 document**：
  `getElementById('#x')` / `querySelector('#x')` 落回**本面板**，并把 `#x` 按 `idMap` 换成带前缀的全局唯一 id
  （`host→ansHost`、`stage→revStage`…）；`createElement` 仍用**真的** document（元素必须属于主文档）。
- 因此：**单一真相源**——三个面板跑的是同一份原页面逻辑，改一次三处都对，不会"复制三份后各自腐烂"。
- 陷阱（都有断言/自检钉住）：① 同一份文档里 **id 不能重复**（构建期 + `app-shell.test.js` 双查，只扫脚本之前的页面标记）；
  ② 样卷 base64 **只内联一次**（`SHARED_SAMPLE_B64`，三段共用，否则平白胖 ~150 KB）；
  ③ 切到错题本要**重新读盘**（`window.__wrongRefresh`），否则刚交卷收进来的错题看不见；
  ④ 这份文件自带分享载荷时，启动**直接切到答题面板**并走高亮的接收者空间。
- **合并版也能当分享壳**：`exportStandalone(state, review_quiz.html)` 导出的仍是"带全部三个面板的单文件"。
- ⚠ 交付边界：三个独立成品（`答题页/校对面板/错题本`）**保留不动**（各自仍可单独用，也仍有自己的验收）；
  合并版不是它们的替代品，而是"想只带一个文件"时的入口。行为面（真点三个页签/面板真挂载/答题→交卷→错题本）
  由真浏览器走查覆盖（`docs/ux-app-shell.png`），Node 侧只保证结构与接线不走样。

### 台账与窄屏取证工具自身的缺陷（本轮自查抓到的，都不是产品代码的错）

这一轮要"核实台账"，结果发现**证据工具本身**有两处会骗人 —— 都已在工具里修掉，并留下可复核的数字。

**① 台账是手抄的 → 抄错了，改成脚本产出。**

- 现象：`CONTRACT.md` 里那行"全绿：30 + 150 + …"是人工维护的。现场重跑发现**文件数对不上**、
  有几条数字与文件对不上号（"44 个文件"其实是 `test.js` + `verify.js` + 42 个 `*.test.js`，但文档里没这么说过）。
- 修法：新增 **`verify/run-all.js`**（零依赖）——把回归集合**固定**成
  `test.js` + `verify.js` + `verify/*.test.js`（按名排序），逐个 spawn，只认每个文件**最后一行**
  `PASS n  FAIL n` 汇总，末尾原样打出 `... = N 条断言 / M 个文件`；任何 FAIL / 非零退出 / 没有汇总行 → **非零退出**。
- 它第一次跑就见效：`narrow-layout.test.js` **26 PASS / 4 FAIL**（当时所有手工跑法都显示 30 PASS，见②）。
- 现在的台账（`node verify/run-all.js` 现场输出，可自行复核）：
  **4429 条断言 / 44 个文件 ALL GREEN**。

**② 窄屏测量脚本把"视口层"的子孙当成"内容列溢出" → 假阳性；顺手毁了一次数字快照。**

- 现象：`narrow-evidence-gen.js` 注在页面里的测量脚本，只把 `position:fixed` 的**根**剔除
  （FAB、快捷面板），却没剔除它们的**子孙**。子孙按**真实视口宽**（headless Edge 实测 526px）排，
  于是量出 `span.cnt「10」右溢 108`、`div.qp-head 右溢 139` —— 而"内容宽 375px"这一列其实干干净净。
  这个假阳性会让 `narrow-numbers.json` 里 `clipped.length` 变成 2 → `narrow-layout.test.js` 的
  "右溢 0" 断言失败。真机视口就是 375px，FAB/面板本来就在屏幕内 ⇒ **整棵子树剔除**才是等价口径。
- 修法：加 `inFixed(el)`（沿 `parentElement` 找 fixed 祖先），元素循环与重叠检查都用它。
- 顺手记一笔**我自己踩的坑**：诊断时我直接跑了 `node verify/narrow-evidence-parse.js`，
  而它在 `narrow-dump-*.html` 已不存在时会**写出 `{}`**（2 字节）→ 把原来的数字快照**覆盖成空**，
  于是 `narrow-layout.test.js` 从 30 PASS 掉到 26 PASS / 4 FAIL。
  ⇒ 取证工具"读不到输入就写出空结果"是危险默认；至少要在注释里写明**必须先跑 gen + Edge**（已补在文件头）。
  重新按 三步流水线（gen → headless Edge → parse）跑一遍后，三页全部回到
  **右溢 0 / 触点<44px 0 / 块级重叠 0 / 正文<13px 0**（`verify/narrow-numbers.json`、`docs/narrow-shot-answer.png`）。
- 防复发：`verify/narrow-{answer,review,wrong,demo}.html` 与 `verify/narrow-dump-*.html` 是**中间产物**，
  已进 `.gitignore`（只留结论件：数字快照 + 截图）。


## 答题页 = 题库首页 · 「开始作答」= 先过"答卷前设置页" · 删卷

### 「开始作答」的两段式：先设置、再开始（设置只有这一处）

- **默认抽题规则 = `all`（全部作答）**：不抽题、整套卷按**原顺序**都做（`pickQuestions` 的 all 分支）。
  这是"我就是要做这套卷"最直白的表达；原来那个「答整卷」入口已并进设置项，题库行上不再单占一个按钮。
- **点「开始作答」不许直接开答**：必须先给出设置页（`openPickSettings` → `paintPickSettings`），
  里面能看能改"这一轮怎么出卷"（全部作答 / 按题型数量 / 按题型总分 / 完全随机 + 分数线），
  并**预先算出这一轮会出多少题**；只有点设置页里的「开始作答」才真正建会话。
- **抽题与分数线只有一处能改**：设置页复用底部快捷面板那一套
  （`QuickPanel.mount({inline:true, groups:['抽题与题量','分数线']})` + `FlowCore.quickModel/quickAction`），
  而**答题时的底部面板把这两组排除掉**（`excludeGroups: ['抽题与题量','分数线']`）。
  理由：答到一半改抽题**不会**换掉正在答的题（换了就等于把已答的丢了），摆在答题界面上只会让人以为
  "改了就该立刻生效"；分数线同理 —— 那是出卷前定的事。
  改抽题规则时**只改 `core/flow.js` / `core/quiz.js`**，两处界面会自动跟着变。
- **预计数 = 空跑一次真出卷**（`drawRound(all, cfg)`，纯函数、同种子同结果），不是另写的估算规则
  ⇒ 预览里的 N 与真出卷的题数**同源**，题库不够时如实写缺（缺几题、哪一型）。
- **题库里没有的题型，题数/目标分自动置 0**（`QuizCore.adaptPickToBank`，设置页打开时执行）：
  只动**空题型**，有题的题型一律原值保留（用户填过的数不许被悄悄改掉），别的字段一概不碰；
  返回 `zeroed` 明细，界面据此显示一条黄底说明（"动了哪一型、为什么"）。返回值是深拷贝，不许污染入参/内置默认。
- **「记住这套设置」默认不勾**：不勾 ⇒ 改动只对这一轮生效（`remember:false`，绝不写本机全局设置）；
  勾上 ⇒ `writeGlobalConfig(store, {pick})` 写进 global 层，以后出卷默认用它。
  **不许把"改默认"做成默认行为**（否则下次出卷会莫名其妙换一套出法）。
- **两处断言方向都要有**：不勾时全局值不变 / 勾了才写（`verify/answer-library-gen.js`）。

### 删卷（答题页题库里那个「删除」）

- 与错题本**同一个** `DeleteDialog` + 同一对 `ExamsCore` 接口，不另写询问 UI。
- **先问后删**：先 `ExamsCore.deletePreview(store, id)` 算出后果（挂了多少错题 / 多少作答记录）再摆出两个选项
  —— 「一并删除（不可恢复）」`policy:'cascade'` / 「只删试卷，保留记录」`policy:'keepRecords'`；
  取消 = 什么都不做（连点两次也照样问）。
- 删完必须**墓碑 + 孤儿扫描**：`scanOrphans` 结果里 `orphans` 必须为空（记录仍有归属就不算孤儿）。
- 严禁 `window.confirm` 之类浏览器原生确认（不可测、不可样式化），一律走 `DeleteDialog`。

### 合并版里同名 CSS 类的铁律（踩过：`.qp-row` 撞车）

- 合并版把多个面板的 CSS 塞进**同一份文档**，因此**跨面板的类名必须全局唯一**。
  实况：`ui/quick-panel.js` 与 `ui/review-panel.js` 曾共用 `.qp-title/.qp-row/.qp-btn/.qp-opt`，
  校对面板的 `.qp-row{display:flex;flex-direction:column}` 把快捷面板每一行压成竖排（「− 数字 +」拆成三行）。
- **加前缀不是解药**：两条规则设的是**不同属性**（`flex-direction` vs 别的），特异性再高也不能"取消"对方那条。
  正解 = 撞名的类**改名**（快捷面板 → `.qk-title/.qk-row/.qk-btn/.qk-opt`），前缀（`.qp-root `）只作第二层保险。
- 锚：`verify/narrow-layout.test.js`（新类名在、旧类名一个不漏）+ 端到端实测
  `getComputedStyle(row).flexDirection === "row"` 且行高 ≤60px —— 类名改回去立刻变红。

### 取证脚本的自我约束（踩过的，别再犯）

- **不许把题集写死进断言**：同一脚本既要跑合成夹具（10 题）又要跑真卷（240 题），
  所以期望值要**从页面上读回来**再交叉核对（"预计抽 N 题" ⇒ 真抽出来必须正好 N 题），
  写死数字会让锚永远红/永远绿。
- **判定"设置改完生效"要看逐题型目标，不能只看总题数**：池子不足时目标被截断，
  改前改后总数可能相同（夹具里 10→3 都得到 9 题）⇒ 只比总数会误判。
- **动件的 `data-qp` 键格式也是接口**：`stepper/toggle` 是 `data-qp="<id>"`，
  但 `choice` 是 **`data-qp="<id>=<值>"`**（如 `mode=byCount`）。
  按 `[data-qp="mode"]` 去查会**一个都查不到**（表现为"规则切不过去"、随后一串断言连锁失败）。
- **"等预览出现"要等新内容，不能只等元素存在**：第二次导入时 `.qp-stat` 还是上一份的数字 →
  一满足就往下点"确认入库"，那套卷**根本没进库**（报告里看着像"题库没刷新"）。
  正确做法：等**新的、可区分的数字**（10 题砍掉简答 = 9 题）出现再动。
- **"横排/一行装得下"要挑对标本行**：`choice` 那一行装了四个选项、本来就会换行变高；
  拿它当"被压成竖排"的证据会误判。用真正的加减控件行（如分数线那一行）当标本。
- **卷的标题不带扩展名**（入库时去掉后缀）：按 `xxx.txt` 去找那一行会找不到，要用 `xxx`。
- **别断言"面板一定有滚动条"**：抽题那两组搬去设置页之后，底部面板常常装得下 —— 要断言的是
  "这一行在面板的**可视范围**里"（`getBoundingClientRect` 比一比），不是 `scrollHeight > clientHeight`。
- **别写死"初始所有题卡都折叠"**：有待校对项时面板会默认把它们展开（题集/解析规则一变就假红）。
  按页面上的 `待校对 N` 推期望，或断言"要么全开、要么全关"。
- **量触屏尺寸要量"可点区域的盒子"**：复选框本身 22px（视觉尺寸），真正接点击的是外面那层
  44px 的 `<label class="qp-tap">`；量裸 `input` 会把已经合规的实现误判成 FAIL。
- **注入脚本先过 `new Function(DRIVER)` 语法闸门**：拼出来的字符串里只要有一个中文引号套英文引号，
  页面就会"一片安静"（dump 里连报告都没有）。`import-bank-gen` / `answer-library-gen` 都已加这道闸门。

## 快捷设置的默认值（用户指定：全部开启 + 翻页等待 1.5 秒）

- **内置默认**：`behavior.autoCheck = true`（答完一题自动判分）、`autoNext = true`（答完自动翻页）、
  `autoNextMs = 1500`。**唯一真相源 = `core/quiz.js` 的 `DEFAULT_CONFIG.behavior`**；
  `flow.js` 的等待时间默认值从它读（不许各写一份）。
- **展示时机默认也是 `each`**（用户要求"答案和解析设置默认答完一题显示"）：
  `DEFAULT_CONFIG.reveal = { answerTiming: 'each', explainTiming: 'each' }`。
  ⚠ **默认值改了，"坏值兜底"这一侧不许跟着松**：未知值（如 `midway`）仍然落回 `end`（最不泄露的一侧），
  只有 `null`/没写（= 这一层没配）才取新默认。锚：`verify/flow.test.js` ①-A。
- **答案解析字号**：答案行 18px、解析正文 16.5px（用户要求"再大点"）；
  真浏览器窄屏取证仍要求"正文 ≥13px、无横向溢出"（`verify/narrow-layout.test.js`）。
- **等待时间的非法值落回"默认值"（1.5 秒）**并点名，而不是落回 0：坏字段不该把节奏改成另一种极端；
  1.5 秒短到不可能看起来像卡住。`null`/没写 = 没配，不算非法、不点名。
- **默认开 ≠ 写死开**：三层取值照旧（全局层/卷级写了以它为准），面板上随时能关掉与改档；
  自检页/测试里"点一下开关"的断言必须**按当前值推**（点一下 → 变成相反值），不许写死方向。
- **开关的可点区域 44px**：22px 的方框在触屏上点不准 → 外面包一层
  `<label class="qp-tap">`（min 44×44）。这条有锚：`verify/narrow-layout.test.js` +
  `probe-narrow-layout-old.js` ⑨（退回裸方框 → 锚必红）。

## 错题本：磁贴内联展开 / 双击直跳 / 只刷错题（用户要求）

- **单击条目 = 展开这道题的"磁贴"，位置在「本题与下一题之间」**（插在被点那条 `li` 的**下一个兄弟位**），
  **不是**收在分组底部（那是早先的实现），也不是弹层。锚：`verify/wrongview-ui.test.js` ②（children 下标逐个对）、
  `verify/wrongbook-gen.js`（真浏览器：`li.nextElementSibling.className === 'wv-tile-li'`）。
- **一次只开一个**：`sel` 只有一个 → 点开新的，旧的自动收回（`aria-expanded` 跟着翻）。再点同一条 = 收回（单点是开关）。
- **双击 = 直接「跳到这道题」**：真浏览器里 dblclick 之前还会来两次 click（先开再收），最终必须落在跳转上。
  ⚠ 这条只有真浏览器验得到（mini-dom 里单独 dispatch 一个 dblclick 证明不了那个事件序列）→ `verify/wrongbook-gen.js`。
- **「跳到这道题 / 举一反三」都在磁贴里**；举一反三按钮**紧跟**一行小字说明它的功能
  （`span.wv-hint`，13px，讲清"按考点生成新题 / 可加入本卷 / 要先配 AI Key"）。
- **跳过去之后只出这道卷的错题**：磁贴把这一组的 `qid` 列表一起交给页面
  （`onJump(examId, index, target, { qids, qid })`），页面按**卷内原顺序**过滤出这些题建会话
  ⇒ 题号索引/「下一题」里只有错题（用户要求"题目列表应该是错题本里的题"）。
  ⚠ 存储里读不到卷时**落回内存里那份 exam**（`booksNow`）：示例错题本故意不写存储，
  早先于是"跳到这道题"永远跳不动（真浏览器取证抓到的真缺陷）。
- **"跳到这道题"按钮**仍按 `WrongCore.jumpTarget().ok` 禁用（题被删了就不给跳），两道防线都在
  （禁用 + 点击回调里再校验一次）。

## 默认抽题 = 完全随机（用户要求）

- `DEFAULT_CONFIG.pick.mode = 'random'`（用户要求"给抽题改成随机的"），停止口径沿用
  `pick.randomBasis = 'count'` + `pick.count = 20` ⇒ 默认"随机抽 20 题"；题库不足时按缺口如实提示。
- `'all'`（全部作答）/`'byCount'`/`'byWeight'` 仍在选项里，设置页一点即换；**「全部作答」排在第一项**。
- ⚠ **未知 mode 仍落回内置默认**（现在是 `random`）并如实报告原值 —— 兜底口径跟着默认值走，
  这一点在 `picking.test.js` 里有锚（"未知 mode → random"）。
- 锚：`verify/flow.test.js` ④-F（默认 = random、这一组摆的是"题量口径 + 本轮题量/目标总分"、
  切到 all 之后只剩规则一行且备注说不抽题）、`verify/picking.test.js`（未知 mode / 整块缺省）、
  真浏览器 `verify/answer-library-gen.js`（设置页默认选中「完全随机」、题量 20、预计行"这一轮会抽 N 题"、
  再切「全部作答」预计行改口"做全部 N 题"）。

## 交卷页：试题回顾进右栏 + 「再考一张」（用户要求）

- **宽屏交卷页**：左栏 = 成绩单（圆环/等级/刻度/逐题型小计）；
  **右栏上半 = 题号跳题那栏**；**右栏下半 = 试题回顾**（`paintReview` 那张"你的作答 vs 正确答案 + 命中明细"）
  + 简答的人工订正入口（`paintManual` 跟回顾贴在一起）。
  - **题号栏的位置与答题时一致（都在右栏顶部）**：用户要求"作答完的页面按题号跳题那栏也放在右边上面一点的位置"。
    实现上就是交卷分支也把 nav 画进**同一个** `.av-navbox`（宽屏 `grid-area:n`），
    不再塞回左栏成绩单里。
  - ⚠ DOM 顺序固定为 `navBox → main → side`（宽屏靠 grid-area 布位）。
    窄屏（`.av-root:not(.av-wide).av-finished`）用 **flex order** 把**看得见的顺序**摆回
    「成绩单 → 题号栏 → 回顾 → 订正」—— 交卷后第一眼该看分数，不该先看题号网格。
    交卷状态由 `.av-finished` 类标出（`paint()` 里 `classList.toggle('av-finished', !!m.finished)`）。
- **「再考一张」**：交卷后动作条里出现一颗主按钮（`data-av="restart"`），
  **只有页面提供了 `onRestart` 才画**（错题本"跳过去"的只读回看视图就没有）。
  答题页把它接到 `redrawRound(1)` = 按**当前这一轮的设置**换一批题（种子 +1）再开一轮；
  完全随机/按题型规则都会换题，"全部作答"那种规则本来不抽题、等于原题重做。
  想换**另一张卷**就点顶栏那颗「返回题库」。
- 锚：`verify/attempt.test.js` ⑤-b（右栏里有回顾卡、左栏里有圆环；没给 onRestart 就不画按钮；
  给了则点了回调一次且 `stats().restarts = 1`）+ `verify/narrow-layout.test.js`
  （源码形态：交卷分支 `paintNav(m, navBox)`、不许 `paintNav(m, main)`、三条 order 规则、`.av-finished`）
  + 真浏览器 `verify/wide-layout-gen.js`（交卷页：题号栏在右栏且 **top 小于回顾卡**、
  回顾卡 left 比左栏大、成绩单圆环在左栏、**窄屏宿主里可见顺序 = 成绩单 → 题号栏 → 回顾**、
  按钮在视口内、点击回调一次）+ 反向探针 `probe-narrow-layout-old.js` ⑫⑬。
  截图 `docs/ui-result-desktop.png`。

## 顶栏收纳：答题动作搬进顶栏（用户要求）

- **「返回题库 / 导出为独立 HTML」两颗按钮由脚本搬进 `.top` 的 `.topacts` 槽**
  （`app-template.html` 末尾的 `moveAnswerActions()`），答题时不再另占 pane 的一行。
- **只搬节点**：`appendChild` 换爹，**不改 id、不重绑监听** —— 答题面板持有的还是同一对节点引用，
  它那边的 `hidden` 切换（`showHomeChrome`）与导出逻辑一个字不用改。
- 搬上去之后它们跟着 `.top`（`position:sticky;top:0`）**一起吸顶**，滚到哪儿都够得着；
  `.topacts{margin-left:auto}` 靠右，`.topacts:empty{display:none}` 保证没按钮时不留空档。
- ⚠ 拖入区（"换一套题"）当时**没搬**；**后来又整轮搬进了「导入 / 校对」页**（见后面那节
  「拖入文件整合进导入页」），答题 pane 里现在**既没有拖入区也没有文件框**。
- 独立单页版（`答题页.html`）本来就把这两颗放在自己的 `.top .wrap` 里，无需改动。
- ⚠ 产物里**不许出现 HTML 注释**（`<!--`）：`app-template` 里加注释会踩到"script 数据双转义"的
  内联顺序闸门（`inline-order.test.js` 会红）。解释一律写在脚本注释里。
- 锚：真浏览器 `verify/answer-library-gen.js`（答题中：两颗按钮 `closest('.top')` 为真、
  `#pane-answer .actions` 里 `.big` 数量为 0、`.topacts` 靠右对齐且里面正好 2 颗）。

## 电脑端布局：动作条**结构性**不可挤 + 左栏绝不被裁（用户要求）

### 摆位（宽容器 ≥820px 时）

```
┌───────────────────────────┬──────────────────────┐
│ 题干 + 选项（grid-area:q）│ 题号跳转（grid-area:n）│  ← 题号跳转"放一边"，不占题干上方
│ **不限高、不裁**          ├──────────────────────┤
│                           │ 答案 / 解析（area:a） │  ← 只有这一栏限高内滚
└───────────────────────────┴──────────────────────┘
            动作条（上一题 / 下一题 / 提交本题）—— 粘视口底，永不被解析顶走
```

- **DOM 顺序仍是 nav → main → reveal**（窄屏 `display:block` 顺序不变），宽屏用
  `grid-template-areas:"q n" "q a"` 重排 —— 不改结构、不重复渲染，窄屏行为一个字没变。
- **左栏（题干+选项）绝不许限高**：上一版把 `.av-main` 也 `max-height` 了，选项于是被裁在栏内
  （用户报障"A/B/C/D 又看不全了"）。现在只有 `.av-side` 带 `max-height:calc(100vh - 250px);overflow:auto`，
  `.av-navbox` 限 26vh ⇒ 题干长/选项多时整页会滚一点，这是**刻意的取舍**（看得全 > 一屏装下）；
  动作条粘着视口，滚了也够得着。
- **动作条粘视口**：`.av-actions{position:sticky;bottom:72px;z-index:6}`（底部留 72px 给收起的快捷面板，
  面板展开时 `.av-panel-open` 让它让到 340px）。
- ⚠ **前提是模板的 `html,body` 用 `overflow-x:clip` 而不是只有 `hidden`**：`overflow-x:hidden` 会让
  `overflow-y` 按规范被算成 `auto` → body 自己成了滚动容器 → sticky 相对 body 定位、**不粘视口**
  （真浏览器实测：按钮 bottom=1223 > 视口 762）。四个模板现在都是 `overflow-x:hidden;overflow-x:clip`
  （`clip` 不产生滚动容器；老浏览器忽略它、退回 `hidden`，横向护栏照旧）。
- ⚠ 还有一条：宽窄要量**宿主**宽度 —— 量 `.av-root` 自己会被它的 `max-width:760px` 卡住，永远判不出宽屏。
- 合并版的 `.pane` / 顶栏 / 页签在 ≥1100px 视口放宽到 1080px（否则 820px 的 pane 根本进不了宽屏模式）。
- 锚：`verify/narrow-layout.test.js`（`.av-wide` 规则 + grid-areas + **只有右栏限高** + 左栏不许有 max-height +
  `overflow-x` 护栏 + 量宿主）+ `probe-narrow-layout-old.js` ⑩⑪ + 真浏览器 `verify/wide-layout-gen.js`：
  1280×860、**838px 超长解析**下「下一题」仍在视口内、**四个选项全在视口里**、左栏 `max-height:none`
  且无内部滚动条、窄宿主（375px）滚到页底按钮也在。

## 电脑端布局（第一版，已被上一节取代 —— 留作"为什么不能只靠 sticky/百分比"的记录）

- **宽窄按"容器宽度"判，不按窗口**：`ui/attempt-view.js` 的 `syncWide()` 量的是**挂载宿主**
  （`o.container || rootEl.parentNode`），≥860px 给 `.av-root` 加 `av-wide`。
  ⚠ 两条都踩过：
  ① 不能量 `.av-root` 自己 —— 它带 `max-width:760px`，在 1160px 宽屏里也只有 760 → **永远判不出宽屏**；
  ② 不能用 `@media` —— 合并版/自检页会把作答界面塞进 375px 的窄宿主，而窗口是宽的，media 会误判。
- **宽屏布局**：`.av-body` 变两栏（题干 ｜ 答案解析），**两栏各自限高内滚**
  （`max-height:calc(100vh - 250px);overflow:auto`），动作条在下面照常可见。
  ⇒ 解析再长也不会把「上一题 / 下一题」挤出屏幕（用户报的正是这个）。
  ⚠ 限高必须**直接写在两栏上、用 vh 单位**：栅格子项上的 `max-height:100%` 在"行高由内容决定"时
  会解析成 `none`（百分比没有参照）→ 栏不滚、整页照样被撑高（实测：栏高 766 > 上限 547）。
- **不要指望 `position:sticky` 兜底**：本页 `body` 带 `overflow-x:hidden`，按规范 `overflow-y` 会被算成
  `auto` → body 自己成了滚动容器，sticky 相对它定位**不粘视口**（实测按钮 bottom=1223 > 视口 762）。
  动作条保留 `sticky` 只是锦上添花，真正的保证是上面那条"限高 + 分栏内滚"。
- 窄屏（<860px）**行为一个字没变**：单列、原来的滚动方式（窄屏取证三页仍 0 右溢 / 0 小触点 / 0 重叠）。
- 锚：`verify/narrow-layout.test.js`（`.av-wide` 规则在、量的是宿主、限高用 vh）+
  `probe-narrow-layout-old.js` ⑩（拿掉宽屏规则 → 锚红）⑪（改成量 `.av-root` 自己 → 锚红）+
  真浏览器 `verify/wide-layout-gen.js`（1280×860：两栏 grid / 右栏在右 / **超长解析下「下一题」仍在视口内**
  / 右栏自己有滚动条 / 页面无横向滚动；420 宽对照：不分栏）。


## 没得全分：**当场给出正确答案** + **不自动翻页**；多选/简答**不自动判分**（用户要求）

### 判分时机（谁判、什么时候判）

- **单选/判断 + `autoCheck` 开**：点选项那一刻就判（`ui/attempt-view.js` 的 `afterAnswer`）。
- **多选/简答：一律不自动判分**（用户要求）—— 点选项 / 打字都只是"作答"，
  必须点 **「提交本题」**（`submitThis`）才判。理由：多选要连点好几下、简答在打字，
  "点完/打完"没有明确信号，自动判会把没点完的答案当场锁死。
- **「提交本题」按钮的出现条件只有一句**：`AttemptCore.view().canSubmit`
  （= **这题答了但还没判分**）。所以：
  单选/判断 + 自动判分开着 → 判分是点选项时同步发生的，`canSubmit` 观察不到 → 按钮不出现；
  多选/简答 → 出现；`autoCheck` 关着时的单选/判断 → 也出现（比"只能靠离开该题"清楚得多）。
  判完就收起来（不常驻）。
- 交卷仍统一结算；配置成"答完一题即显示"时，**离开该题**那一刻也会自动补一次判分（多选/简答同样适用）。

### 翻页与揭示

- **`perfectOf(ctx)`（三态）**：`true` 得全分 / `false` 没得全分 / `null` 还不知道（没判分）。
  判据：调用方显式给的 `perfect` 优先 → 否则 `correct === true` → 否则 `score >= full`（`full > 0`）。
  只给了 `correct`（没有分数）时以它为准；两个都没有 → `null`。
- **`afterSubmit` 的跳页规则**：`willJump = autoNext && answered && !finished && !notPerfect`，
  `notPerfect = (perfectOf(ctx) === false)`。**没得全分 → 不跳，连等待定时器都不排**（`waitMs = 0`）。
  - 没判分时 `perfectOf` 给 `null` ⇒ **沿用老规矩"答完就翻"**（用户之前明确要求过"自动翻页不必等判分"）。
  - 多选/简答在**提交之前**绝不翻（`!(needsSubmit && !submitted)`）——否则点一下多选 A 就被翻走。
- **`revealAt` 的规则④（唯一例外）**：已判分且 `perfectOf === false` ⇒ `answer = true`。
  也就是**不管 `reveal.answerTiming` 选的是「整卷后」**，没得全分的题当场把正确答案给出来。
  理由：用户已经答错/没答全，此时正确答案对他没有任何可利用性。规则①（未判分不给答案）照样生效；
  解析仍按自己的时机走（答案强制给了，解析不跟着强制）。
- 判定依据必须**由调用方如实传入**：`core/attempt.js`（`submitCurrent` / `view` / `navModel`）与
  `ui/attempt-view.js`（`afterJudge`）都要传 `correct`/`score`/`full`，漏一处就会出现"核心说不跳、界面却跳了"。
- **面板文案**：答题时的快捷面板写明"答完「就」翻…；但没得全分就不翻 —— 停在这一题看正确答案"，
  以及"多选题与简答题不自动判分：答完点「提交本题」才判分"（面板文字里不许出现 markdown 记号）。
- 锚：`verify/flow.test.js` ②-A（把 `correct` 作为第三轴扩成 96 组真值表）+ ②-H（半对/0 分/满分/上限被压四种情形 + `perfectOf` 三态）；
  `verify/attempt.test.js` ⑤（按钮只在该出现时出现）与 ⑨（多选/简答不判分 → 提交才判 → 得全分才跳；含"没答全不跳"与"autoCheck 关着单选也出现按钮"）；
  `probe-flow-old.js` ⑫（没得全分也照翻 → 锚必红）⑬（不揭示 → 锚必红）⑭（半对也照翻 → 锚必红）；
  `probe-attempt-old.js` ⑤（多选又被自动判分 → 锚必红）⑥（按钮条件被砍 → 锚必红）；
  真浏览器：`verify/autonext-delay-gen.js`（答错等 1.4 秒也不翻 + 给出正确答案 + 同配置答对会翻）、
  `verify/answer-library-gen.js`（多选点选项不判分 → 出现「提交本题」→ 点它才判分 → 判完收起；简答打字不判分）。

## 拖入文件整合进导入页 + 「只看待校对」默认打开（用户要求）

- **拖入是「导入 / 校对」页的功能，不再有第二处入口**：`review-template.html` 里
  `<label class="drop" id="drop">` + `openFile(f)` + `wireDrop()`
  （`click` / `dragover`(加 `.on`) / `dragleave`(撤 `.on`) / `drop` → `openFile(e.dataTransfer.files[0])`）。
  合并版把它映射成 `#revDrop`（`app-template.html` 的 `RUN_PANE('review', { file:'revFile', drop:'revDrop' })`）。
- **答题页那边反过来要"没有"**：`answer-template.html` 的拖入/文件框标记已删（`#ansDrop`/`#ansFile` 不存在），
  脚本里那几行**留着但带守卫**（`if (fileInput)` / `if (drop && fileInput)`）——合并版里这两个 id 根本不存在，
  守卫让它们安静跳过，将来单页版想加回拖入区也不用重写逻辑。
- **「只看待校对」默认打开**（`ui/review-panel.js` 的 `mount`：
  `onlyReview: (o.onlyReview === undefined) ? true : !!o.onlyReview`）——导入后第一眼只看到"需要人工确认的那几题"；
  开关照旧双向可用，调用方显式传 `onlyReview:false` 时按它来（错题本/别的宿主想全看就传 false）。
  筛选后为空时给的是友好文案「没有待校对的题目 🎉（这份文件共 N 题，取消勾选「只看待校对」可以看全部）」，不是白屏。
- ⚠ **拖入区不是"换一套题"的唯一入口**：答题 pane 里点顶栏「返回题库」→ 导入 / 校对，或直接拖进导入页。
  两条路都进同一个 `openFile` → `parseTxtBytes/parseDocx` → `mountPanel` → 「确认入库」→ 「去答题」。
- 锚：`verify/review.test.js` ④-F（源码形态：默认值表达式 + 空态文案）；
  `verify/narrow-layout.test.js` ③（`accept` 带 `.docx/.txt/.md`、`#drop` 在**校对页**、答题页**没有**它）、
  `.drop{min-height:44px}`；真浏览器两条：`verify/import-bank-gen.js` ⑥
  （`#revDrop` 可见 / ≥44px / 文案写清"能拖也能点" / `#ansDrop === null` /
  `dragover` 加 `.on`、`drop` 撤 `.on` 且**面板节点换新**=真的重建 / 重建后默认仍勾上「只看待校对」）
  与 `verify/answer-library-gen.js`（答题页 `#ansDrop === null`）。
- 截图：`docs/ui-import-page.png`（安静版：拖入区在导入页）、`docs/ui-import-drop.png`（带实测条：默认筛选态）。

## 顶栏与手机端工具折叠（用户要求）

### 顶栏：**没有标题、没有简介**

用户要求："双端 ui 都删除顶部的答题全能版和简介小字"。

- `app-template.html` 的 `.top` 里删掉了 `<h1>答题全能版（离线 · 单文件）</h1>` 与
  `<span class="tip" id="appTip">一个文件，四件事：…</span>`（连 `.top h1` 的 CSS 一起）。
  现在顶栏只剩：**页签**（答题 / 导入 校对 / 错题本）+ 右侧 `.topacts`（答题时才出现的返回题库 / 导出）。
- ⚠ 连带改动：原来"这份文件自带试卷"那句话是写到 `#appTip` 的，元素没了会当场抛错 ——
  改成**只切页签**，那句话由答题面板自己写进 `#ansTip`（带卷名 / 题数 / 落盘空间，信息更全）。

### 手机端：工具栏可折叠（宽屏**不折**）

用户要求："手机端 ui 得让上面那部分按钮可以折叠"。

- 导入 / 校对页那一排（载入样卷 / 清空 / 选择文件 / 拖入区 / AI 密钥 / 单题智能 / 整卷批量）
  包进 `.toolsrow#revTools`，里面再分 `.tools-toggle#revToolsToggle` 与 `.tools-body#revToolsBody`。
- CSS：`.tools-toggle{display:none}`；`@media (max-width:819px)` 里才 `display:inline-flex`，
  并加 `.toolsrow:not(.open) .tools-body{display:none}` —— **窄屏默认折起**。
- 为什么用媒体查询而不是像作答界面那样量宿主宽：这一层是**页面外壳**，它只由窗口宽决定；
  作答界面才需要量宿主（它可能被塞进 375px 的窄宿主里，而窗口是宽的）。
- 宽屏**不折**（用户早先明确要求过"工具不折叠"）：宽屏那三行 CSS 都不生效，工具一直摆着。
- 折叠按钮 `min-height:44px`，文案在「工具 ▾ / 收起工具 ▴」之间切换，`aria-expanded` 跟着变。
- 锚：`verify/narrow-layout.test.js`（源码形态：顶栏无 h1/appTip/四件事、三个容器 id、
  `@media (max-width:819px)` 里那两条规则、`classList.toggle('open')` 接线）
  + `probe-narrow-layout-old.js` ⑭⑮⑯（加回标题 / 拆掉折叠 / 按钮不接线 → 锚全红）
  + 真浏览器 `verify/mobile-ui-gen.js`（**21 条 0 FAIL**，375px：顶栏无 h1 与简介、页签 3 个且 ≥44px、
  折叠按钮可见 80×44px、默认折起、点开 6 个入口全可见且 ≥44px、无横向溢出、能收回去、
  折叠后 `.out` top=186px 落在首屏内、工具块高度 0）
  + `verify/import-bank-gen.js`（**1280px**：折叠按钮高度 0 = 藏起来、`#revToolsBody` 仍 `display:flex` 可见）
  。截图 `docs/ui-mobile-tools.png`（手机端折叠态）。

## AI 入口：Key 必须**在每个 AI 面板里**都能填（用户报障修复）

**报障原文**：**"调用api没有输入api key的地方"**。

### 根因（不是"没做这个功能"，是**合并壳漏摆标记**）

合并版（`review_quiz.html`）**不复制标记**：`build.js` 只把三个独立页的**页面逻辑**段抽出来塞进壳里，
标记（按钮、输入框、宿主 div）由 `app-template.html` **自己摆**，逻辑里的 `$('#file')` 这类选择器
再按 `RUN_PANE` 的 **idMap** 换成带面板前缀的真实 id。
上一轮"拖入功能整合"时，独立版 `review-template.html` 顶部那三颗
「AI 密钥与供应商 / 单题智能 / 整卷批量」在壳里退化成了**三个空 div**：

- 点不动 → 用户在合并版里**根本打不开密钥设置**；
- AI 面板那句"Key：未填（去「AI 密钥与供应商」填）"指的按钮**不存在**；
- 页面不报错、功能测试也全绿 —— 只有用户点上去才会发现。

### 修法（两条一起，缺一条都还有人找不到）

1. **把标记补齐**（`app-template.html` 导入 / 校对面板）：
   `<button id="revAikey">AI 密钥与供应商</button>`、`#revAisingle`、`#revAibatch` 三颗**真按钮**，
   并删掉原来那三个同名空 div（重复 id 也会让 `getElementById` 抓错）。
2. **给每个 AI 面板配一块"就地入口"**：`ui/ai-settings.js` 新增 **`keyEntry({ doc, store, onChange })`**
   —— 一行状态（`API Key：未填 / 已配置 N 家可直连（sk-…abcd）`）+ 一颗「填 / 换 API Key」，
   点开在**原地**展开**同一个** `mount()` 出来的设置面板（不另写第二份表单），再点「收起密钥设置」收回去。
   `ui/ai-single.js`（单题 + 批量）与 `ui/ai-scene.js`（整卷总评 + 举一反三）四处都挂上；
   节点**只建一次**（`paint()` 反复重画时复用同一节点，展开状态不抖），宿主没内联 `ai-settings.js` 时安静降级。
3. `answer-template.html` / `wrong-template.html` 也内联 `__AI_SETTINGS__`（顺序在 `__AI_SCENE__` 之前），
   这样独立页与合并版的四处入口行为一致。
4. 顺手清掉答题页那段**永远不执行**的拖入接线（`load(file)` + `#file`/`#drop` 守卫）——
   标记已删、idMap 也撤了那两条映射，留着只会误导后来人。

### 防复发：**标记对照闸门**（`verify/shell-parity.test.js`，11 条）

- ① 壳里必须正好找到 `answer / review / wrong` 三个 `RUN_PANE` 的 idMap；
- ② 每个 idMap 目标 id 在**该面板的壳标记**里都必须存在；③ 而且**标签种类一致**
  （独立页是 `<button>`，壳里就不许是 `<div>` —— 这一条正是用户报障的直接判据）；
- ④ 独立页里那些"用户要点的控件"（button/input/label/select/textarea）被 idMap 映射进来后**一个都不许丢**。

### 锚与截图

- 真浏览器 `verify/ai-entry-gen.js` / `ai-entry-parse.js`（**27 条判定**）：
  三颗入口是真按钮（`tagName === 'BUTTON'`、有文字、≥44px）→ 点开就地出现 `type=password` 输入框 →
  真填一把假 Key → 出现**遮罩**且输入框被清空 → 单题智能面板里有就地入口且**不跳页**（重画后仍在）→
  整卷总评 / 举一反三面板同样有就地入口、能开能收 → 收尾点「清除」把假 Key 擦掉。
  **修复前同一套判定：21 条里 FAIL 11 条**（入口是 DIV、没有文字、没有就地入口…）。
- `verify/probe-shell-parity-old.js`（4 条"改坏必红"）：把按钮改回空 div / 少摆一个宿主 /
  删空 idMap / 少接一个面板 → 对应锚全部变红。
- 截图：`docs/ui-ai-key.png`（密钥面板：每家一个 password 框 + 保存）、
  `docs/ui-ai-entry.png`（AI 面板里那一行就地入口）。

## 文案尺度：**小字只留"删了会出事"的**（用户要求）

用户要求："把一些不必要的小字都删掉"。定下来的尺度（**新加文案请照此办理**）：

- **留**：安全与隐私（密钥只存本机 / 不上传 / 不随分享导出）、破坏性后果（删卷"不可恢复"）、
  存储不可用与配额告警（为什么 + 怎么办）、**非显然的行为事实**
  （答完就翻但"没得全分不翻"、多选简答要"提交本题"才判分、不可直连那家的 CORS 原因）、
  数据读数（题量 / 分值 / 遮罩 / 时间戳）。
- **删**：重复说同一件事的第二处、解释实现细节的自我说明（命名空间 / 内部术语）、
  调试与统计计数器（`stats()` 照样给测试用，不要画给人看）、供应商推介小字。
- **压缩**：一句能说清的不写成三句；`.qp-note`（12px）那一层只放"用户推不出来的事实"。
- **诊断页不算产品界面**：`浏览器自检.html` / `解析器Demo.html` 的说明文字不在本尺度的管辖内。

度量工具：`verify/smalltext-gen.js` + `smalltext-parse.js` —— 按 12 个状态把**字号 < 14px 的可见文本**
逐条列出来（带字号/类名/状态），并统计"解释性长句（≥20 字）"条数；带一个源 HTML 参数即可做前后对比：

```
node verify/smalltext-gen.js [源 HTML]      # 不带参数 = 用当前成品
msedge --headless=new ... --dump-dom file:///.../verify/smalltext.html > verify\smalltext-dump.html
node verify/smalltext-parse.js              # 分组打印 + 合计（含长句条数）
```

**这一轮的数字**（同口径 12 状态）：小字 **81 → 64 条**，其中解释性长句 **33 → 18 条**。




## 「导出分享」：进页签排 + 先选卷 + 结果文本框（用户要求）

- **入口**：页签那一排的 `#tab-share`「导出分享」（`.tab-act` 主色描出来，但**不是页签**：
  `role="tab"` 仍只有 3 个）。合并版**删掉了**旧的 `#ansExport`（导出只有一处入口）；
  独立版 `答题页.html` 仍保留它，`answer-template` 的导出逻辑带 `if (exportBtn)` 守卫。
- **选卷页**（`#sharePage`，整页浮层）：列题库里的卷（多选、**默认全选**）+ 全选 / 全不选 +
  「导出分享（N 套 / M 题）」+ 结果文本框 `#shareOut`。
- **手机端为什么"不好使"以及怎么修**（关键，别再改回去）：
  - 旧处理函数是 `async`，`await` 之后才触发下载 —— 手机浏览器认定**已非用户手势**，静默拦掉。
  - 现在：卷本体与 AI 密钥在**打开选卷页时**先异步取好缓存，**点击处理函数里一行 await 都没有**
    （真浏览器判据：派发 `click` 后**同帧内**结果框出现）。
  - 另给**兜底真链接**：`<a download href="blob:…">点这里保存文件</a>`（≥44px），
    自动下载被拦时用户点它就能存；`blob:` URL 在关页面 / 再导一次时才回收。
- **多选打包（核心侧）**：`sanitizeSharePayload` / `exportStandalone` 支持 `examIds`（**比 `examId` 优先**，
  空数组 = 没给 = 全都要）；`shareFileName(examOrList, at)` 多卷走「答题分享-N套-时间戳」，
  **单卷命名口径一个字没改**（既有测试逐字钉着）。载荷仍**一个**块，里面 N 套卷。
- **收件人侧**：文件里打包了多套卷时，题库首页顶部列出「这份文件里打包了 N 套卷」，
  每套一个「开始作答」，各自写自己的 `recv_<卷id>.<指纹>` 空间（互不串记录）。
- 锚：`verify/export-html.test.js` ③-E（多卷打包：文件名 / 载荷两套都在 / 一个块 / `examIds` 优先）、
  真浏览器 `verify/export-share-gen.js`（27 条）、静态 `verify/narrow-layout.test.js`（导出页四件套）。

## 手机端两排折叠 + 返回题库到底部 + 题号跳转放题目下面（用户要求）

- **两排折叠**（都**只在窄屏**生效，宽屏那几条规则不生效）：
  - 导入 / 校对页工具排：`.toolsrow#revTools` + `#revToolsToggle` + `#revToolsBody`；
  - 页签排：`#tabsRow` + `#tabsToggle` + `#tabsBar`，折叠时按钮上写着**当前页名**（如「答题 ▾」），
    点页签 / 点「导出分享」后自动收起。
  - 为什么用媒体查询而不是量宿主：这一层是**页面外壳**，只由窗口宽决定；作答界面才需要量宿主。
- **返回题库 → 底部栏**：搬进 `#ansBottomSlot`（`position:fixed;left:14px;bottom:14px;z-index:45`），
  与右下角的「交卷」FAB 一左一右、同一层；**顶栏不再有动作按钮**。
- **题号跳转 → 题目下面**：宽屏布位分状态 —— 答题中 `.av-wide:not(.av-finished)` 用
  `grid-template-areas:"q a" "n a"`（题号在题干下面、解析占右栏）；交卷页仍是 `"q n" "q a"`（右上）。
  DOM 顺序固定 `main → navBox → side` ⇒ 窄屏读作「题干 → 题号 → 解析」，交卷页由 `.av-finished` 的
  flex order 摆成「成绩单 → 题号 → 回顾」。
- 锚：`verify/narrow-layout.test.js`（两种 grid 布位、DOM 顺序、两组折叠容器与接线）、
  `probe-narrow-layout-old.js` ⑰⑱⑲、`verify/mobile-ui-gen.js`（页签折叠 31 条）、
  `verify/import-bank-gen.js`（宽屏不折 58 条）、`verify/wide-layout-gen.js`（题号位置 36 条）、
  `verify/answer-library-gen.js`（底部固定位 93 条）。

## 「再抽一次」按钮 + 抽题偏好「未作答优先」（用户要求）

### 抽题偏好：`pick.prefer`

- 取值两项：`'random'`（默认，完全随机）/ `'unansweredFirst'`（未作答优先）。不认识的值 → 落回
  `'random'` 并把原值记进 `meta.preferFallback` + `warn`（与 `pick.mode`、`pick.randomBasis`
  同一条"不静默"规矩）。**它和 `pick.mode` 正交**：`byCount` / `byWeight` / `random` 三种抽取规则
  都能配它；`mode='all'`（全部作答）**不抽题**，设置页因此不摆这一行。
- 抽题核心**不读错题本**：`pickQuestions(all, cfg, opts)` 的第三个参数是
  `{ priority: { qid: 档位 } }`，数字越大越先抽；同档位内仍然按 `seed` 洗牌。
  这样 core 保持纯函数 + 定种子可复现，"谁欠账"由调用方（页面）算。
  实现是 `tiered(list, n)`：按档位分组 → 从高到低依次取满。**没有 priority 时它就是原来的
  `shuffle+slice`**（档位全相同时结果与完全随机逐题一致 —— 这条有断言钉着，防止"优先级"偷改随机本身）。
- 页面侧（`answer-template.html`）的档位表：
  - 2 = 错题本里**还没答对**（`rightTimes===0`）或**连续错着**（`streak>0`）→ 最欠账；
  - 1 = **没进过本子**（没做过，或一次就答对、从没错过）；
  - 0 = 进过本子、后来已经答对了。
  只读**本机错题本**（`WrongCore.loadBook`），读不到 → 不传档位表、退化成完全随机并在 `warn` 里说明。
- 什么时候刷新档位：进"答卷前设置"页时（`openPickSettings`）读一次，"换一批 / 再抽一次"
  前（`redrawRound`）再读一次 —— 刚答错的题立刻算欠账。
- 锚：`verify/picking.test.js` ⑨（欠账题一道不落 / 已答对的一道不进 / 档位全同 == 完全随机 /
  同种子可复现 / `byCount` 同样生效 / 未知值落回随机）、`verify/flow.test.js` ④-G（面板两选一、
  正交、全部作答下不摆这行、未知值被拦）、`verify/config.test.js`（字段校验门）、
  `verify/wiring.test.js` ⑪（页面真的把档位传进 `pickQuestions`）+ `probe-wiring-old.js` ⑮⑯⑰、
  `probe-picking-old.js` ⑨⑩、真浏览器 `verify/prefer-redraw-gen.js`（17 条）。

### 「再抽一次」（答题中途）

- 位置：答题界面的**动作条**里（和「上一题 / 下一题」同一排，不是主按钮）。出现条件 =
  页面给了 `onRestart` **且**这一轮还没交卷；交卷之后同一个位置换成「再考一张（按当前设置换一批题）」，
  **两者不同时出现**。
- 点了做什么：走页面原有的"换一批"（种子 +1 → 重抽一批）。上一轮的作答进度按**各自轮次指纹**
  存在本机，不会被抹掉（同一个种子再抽一次就能回到那一批）。
- 锚：`verify/attempt.test.js` ⑤-c（给了才画 / 文案 / 在动作条里 / 不是主按钮 / 点了回调一次 +
  `stats().restarts` / 交卷后让位给「再考一张」）、`probe-attempt-old.js` ⑧、
  真浏览器 `verify/prefer-redraw-gen.js`（点一下真的换了一批 5 题、仍是同一份卷）。
- 已知边界：本地没有真机 iOS Safari，"换一批后回到上一批的进度"只做了同一浏览器内的验证；
  抽题偏好只认**本机错题本**，"没进过本子"里混着"一次就答对的题"（本机没有逐题作答历史），
  面板上的小字如实写明这一点。

## 「答错的题也自动翻页」+ 自动翻页的小加载条（用户要求）

### `behavior.autoNextWrong`（默认 false）

- 位置：快捷设置「作答行为」组里，紧跟在「答完自动翻页」后面 —— 它是**子选项**，
  自动翻页关着时**置灰**（`enabled:false`；toggle 行现在也认 `enabled`，与 choice / stepper 同语义）。
- 语义（`FlowCore.afterSubmit`）：`willJump = autoNext && answered && !finished && (!notPerfect || autoNextWrong)`。
  - 默认关 = 既有行为一个字不改：没得全分（答错 / 多选半对 / 简答没答全）⇒ 停在这一题看正确答案、**不排定时器**。
  - 开了 = 连错题也照翻，**等待时间照旧生效**（不是"立刻翻"）；返回值里多一个
    `jumpedDespiteWrong`，界面据此把话说清楚。
  - 边界不松动：没作答 → 不跳；整卷结束 → 不跳；多选 / 简答提交之前 → 不跳（这三条与开关无关）。
- 锚：`verify/flow.test.js` ②-C2（默认关 / 开了翻且带等待 / 半对也算"没得全分" / 措辞区分"答错"与"没得全分" /
  子开关被主开关按住 / 空题与交卷边界 / 动件真的写进配置 / 面板那一行置灰）、
  `probe-flow-old.js` ⑮⑯、真浏览器 `verify/autonext-delay-gen.js`（含"关掉开关后同一题答错就停住"的反向对照）。

### 自动翻页的小加载条（`.av-jumpbar`）

- 出现条件：**有一个"等一会儿就翻"的定时器在跑**（`jumpTimer !== null`）—— 与待跳同生共死：
  排上就出现、翻页 / 取消 / 自己翻走 / 销毁就消失，不另立一套状态。
- 位置：动作条里的**第一行**（`flex:1 1 100%` 独占一行），就在用户刚点完的地方；
  不去和右下角的「交卷」FAB、左下角的「返回题库」抢位置。
- 观感：一根 6px 的进度芯 + 「正在翻页…」；芯的宽度用 CSS 动画从 0 走到 100%，
  **`animation-duration` 内联写死 = 这一跳要等的毫秒数**（观感与行为同一个数，不各算一份）。
  `prefers-reduced-motion: reduce` 时不动画、直接铺满（尊重系统设置）。
- 边界（如实说清）：等待时间 = **0（立刻翻）时没有加载条** —— 没有等待窗口可提示；
  与其硬凑一根"闪一下"的条，不如让面板小字明说"等待时间是 0 → 立刻翻，也就看不到翻页加载条"。
- 锚：`verify/attempt.test.js` ⑥-c（出现 / 文案 / 动画时长 / 挂在动作条里 / 翻完消失 / 自己翻走立刻收起 /
  等待 0 时没有条）、`probe-attempt-old.js` ⑨、真浏览器 `verify/autonext-delay-gen.js`（33 条，
  含 `[data-av=jumpbar]` 的出现与 `animation-duration=1000ms`）+ 人眼截图 `docs/ui-jumpbar.png`
  （单独一份 `verify/jumpbar-shot-gen.js`：把等待设成 5 秒、虚拟时钟压到 2.6 秒，才抓得到"正在翻页…"那一刻）。

## 转发只带试卷本身（答题记录 / 成绩 / 错题本一律不进分享文件）

用户要求："确保转发的时候只转试卷本身，不包含答题记录。" 这一条**本来就是这样设计的**，
本轮把它从"约定"变成"**有断言与真浏览器证据钉住的边界**"：

- **入口只交试卷**：合并版点「导出分享」时传给核心的状态是 `{ exams: sel.map(r => r.exam) }` ——
  连本机的进度/错题/成绩都不在参数里（页面不是"交一份全量再让核心删"）。
- **核心按白名单重建载荷**：`sanitizeSharePayload` 只从 `examsOfState(state)` 取卷，卷按
  `SHARE_EXAM_FIELDS`、题按 `SHARE_QUESTION_FIELDS` 逐字段重建（容器字段深拷贝），
  `progress / records / wrongBook / settings / draft` 这些键**连名字都不出现**。
- **壳是挂载前抓的**：`APP_SHELL` / `SHELL` 取的是**面板挂载之前**的 `documentElement.outerHTML`，
  所以运行时的题库列表、作答界面、面板宿主都不会被一起打包（否则等于把"上一次的作答界面"发出去）。
- **第二层防线**：万一白名单被放宽，`shareScan` 的敏感字段名（如 `answers`）会当场拒绝导出
  （实测：把白名单改成整卷拷贝 → `ok:false`，根本不产出文件）。
- 锚：`verify/export-html.test.js` ③-F（把带哨兵的进度/成绩/错题本/脏字段喂进 state →
  载荷顶层只有四个键、卷上没有记录类字段、**成品 HTML 里搜不到任何一个哨兵**；
  且只扫**载荷块正文**、不扫整份 HTML —— 成品里内联的代码本来就含 `::progress` 这类字面量，那是假阳性）+
  `probe-export-html-old.js` ⑧ + 真浏览器 `verify/export-share-gen.js`：
  往本机写三条哨兵（我的作答 / 错题本 / 成绩单）→ 走真界面导出 → **把导出文件的正文读回来**
  扫哨兵（全无）+ 载荷顶层键 + 两套卷与题都在。

## 首页「清除答题记录」（用户要求）

- 位置：题库首页（首页）脚注里，按钮「清除答题记录」（`data-lib=wipe`），与「载入内置样卷」同排。
- 语义（`ExamsCore.clearAttemptRecords`）：只清**作答产生的东西** ——
  作答进度（含"整卷"与每一轮抽题各自那份）、成绩记录、**可选**的错题本；
  **卷本体、卷的 `meta`、本机设置、卷册索引一条都不动**。
- 先问后清：点按钮 → `attemptRecordPreview` 读出**真实数字**（进度几份 / 几套卷 / 答过多少题 /
  成绩几条 / 错题几套几条）→ 复用**同一个** `DeleteDialog`（标题与取消文案由询问模型给，
  默认值不变）→ 两个选项：「只清作答进度」（错题本留着）/「进度 + 错题本一起清」（不可恢复、危险色）。
- 硬保证（写死在实现里）：删除**只按枚举出来的精确键**（`purgeByScope({exact:[…]})`，`prefix` 留空）——
  绝不拿 `exam::` 这种大前缀去 purge（那会连题库一起清）。孤儿记录（卷从没入册、但进度/错题在盘上）
  也要一起清，否则"清过了却还在"。
- 读数口径：`cleared.wrong` 报的是**实际删掉了多少**，不是"选项开没开"——
  早先按选项门控的写法会让"没选却清了错题本"这种越权 bug 在读数上依然显示 0（探针 ⑧ 抓到的）。
- 清完把 `roundCtx` 放下：首页那行「继续这一轮」指的正是被清掉的那份进度，留着就是假承诺。
- 边界：只在本命名空间内生效 —— **接收者空间（分享文件那套 `recv_*`）里的进度不会被连带清掉**。
- 锚：`verify/exams.test.js` ⑱（读数 / 精确键删 / 题库与设置与索引完好 / 前缀兄弟卷 E10 不受影响 /
  错题本默认留着且**存储里真的还在** / 一起清 / 幂等 / 空库 / 无存储明确失败 / 跨命名空间不动）、
  `probe-delete-cascade-old.js` ⑦⑧、`verify/wiring.test.js`（按钮 + 先问后清 + roundCtx），
  真浏览器 `verify/export-share-gen.js`（按钮 ≥44px → 弹窗数字 → 选"一起清" → 记录归零、
  **题库还在**、首页仍列着两套卷、提示写明清了什么）。

## 手机端顶栏：不自动收起 + 收起态悬浮；答题小字提示下移；顶部不再重复题号（用户要求）

用户原话：

> 顶部栏点击跳转之后不要自动收起，收起之后做成悬浮形式不要占一排位置，答题时顶部小字提示移到至底部声明上边，
> 在进入答题后声明后面再空一行防止被底部栏挡住，去除顶部多余的一个题号显示

- **点页签跳转后不自动收起**：`#tabsBar` 的 click 处理里只 `appTabsSync()`（按钮文案跟着当前页名变），
  **删掉了原来的 `classList.remove('open')`**。收不收只由「收起 ▴」那颗按钮决定。
- **收起态 = 悬浮**：窄屏 `@media (max-width:819px)` 下 `.tabsrow:not(.open){position:fixed;top:8px;right:10px;z-index:55}`
  —— 脱离文档流，**不再占页面上那一排的位置**（展开时回到正常流：那一刻用户在挑页签，需要看得清、点得中）。
- **答题小字提示搬到底部声明上边**：`#ansTip`（合并版）/ `#srcTip`（单页版）从顶部那一行搬到
  **面板末尾**（正文之后、`.foot` 声明之前）。⚠ 它必须仍在**面板内部**（`RUN_PANE` 的 scopedDoc
  只在本面板里 `getElementById`，搬出面板就找不到了）；`#ansHome` 同理必须留在面板里
  （载入后被 `moveAnswerActions()` 搬进底部固定位，但引用是在面板里抓的）。
- **声明后面空一行**：`#ansFootSpace`（`.footspace`）+ 根元素上的 `.answering` 类
  （由 `showHomeChrome(true/false)` 挂/摘，合并版与单页版都生效）；
  `.answering .footspace{display:block;height:76px}` —— 只在答题时出现，把底部两条固定栏
  （左下「返回题库」、右下「交卷」）压住最后一行的问题堵上。首页态不显示，排版照旧紧凑。
- **顶部不再重复题号**：`.av-head` 里只留「已答 N/M」（那是进度读数，题号栏里没有），
  删掉原来那枚 `m.progressText`（「第 N / M 题」）—— 题号由下面那个「题号 · 第 N / M 题」的折叠栏说，
  点开就能跳题。`AttemptCore.view()` 仍照旧给 `progressText`（那是渲染模型，不许动）。
- 锚：`verify/narrow-layout.test.js`（收起态 position:fixed、点页签那段不许 remove('open')、
  提示的 DOM 顺序 ansHost→tip→声明、空行与 `.answering` 规则）、`probe-narrow-layout-old.js` ⑰-b～⑰-e、
  `verify/attempt.test.js`（顶部只剩一枚徽章、且不含"第 "）、`probe-attempt-old.js` ⑩、
  真浏览器 `verify/mobile-ui-gen.js`（39 条：收起态 fixed / 展开态 static / 点页签与点导出分享都**不**自动收起 /
  手动收起后按钮写着当前页名）+ `verify/prefer-redraw-gen.js`（27 条：提示在正文之后声明之前、
  空行在声明之后且 ≥60px、滚到底声明整行看得见、顶部无题号而题号栏有）。

## 底部快捷面板：去掉标题、按钮改「展开设置」；「返回题库」加二级确认（用户要求）

用户原话：

> 现在返回题库按钮把快捷设置的文字挡住了，把快捷设置文字去掉，按钮改为展开设置。返回题库按钮加一个二级确认弹窗

- **面板标题可缺省**：`QuickPanel.mount({ title })` —— `undefined` = 用缺省「快捷设置」，
  给**空串** = 一个标题字都不画（`if (title) head.appendChild(...)`）。
  答题界面那张底部面板就传 `title: ''`：文字本来被左下角固定的「返回题库」压住，去掉之后表头只剩一颗按钮。
  ⚠ 「出卷设置」（答卷前设置页的 inline 面板）照旧有标题 —— 那里没人挡它。
- **折叠按钮改为「展开设置 / 收起设置」**（原来只写「展开 / 收起」；没有标题之后这颗按钮就是那一排唯一的东西，
  得说清它干的是"展开设置"）。
- **「返回题库」加二级确认**（`askGoHome()`）：那颗按钮是**常驻浮动**的，误触一下就把作答界面收走。
  点它先弹**同一个 DeleteDialog**：标题「返回题库？」，正文写**这一轮的真实进度**
  （"这一轮已答 3 / 10 题（还有 7 题没答）"），并说清「卷子与你的作答都还在本机，什么都没删」；
  主选项「返回题库」，取消叫「继续作答」（点了留在这一轮）。
  只有选了「返回题库」才走原来的 `goHome()`（冲一次进度 → 销毁界面 → 回首页）。
- 锚：`verify/attempt.test.js`（面板没有 `.qk-title`、按钮文案「展开设置 / 收起设置」）、
  `verify/wiring.test.js`（面板传空标题、按钮文案、`homeBtn` → `askGoHome`、三处 DeleteDialog 共用、
  确认框写清进度与取消文案）+ `probe-wiring-old.js` ⑱⑲⑳、`probe-attempt-old.js` ⑪、
  真浏览器 `verify/answer-library-gen.js`（106 条：无标题 / 两种按钮文案 / 点「返回题库」先出确认框 /
  弹窗里的真实进度 / 取消后仍在答题 / 再点选「返回题库」才回首页）。
  ⚠ 同一条流水线顺手修了一个**真竞态**：驱动在"答题中"切回答题页时，`__answerRefresh` 只在
  **没有进行中的作答**时才重画题库（答题时重画会把作答界面顶掉）——所以脚本必须先走一次
  「返回题库」，再去断言"题库里现在两套卷"；另外入库回执要先清掉，否则"等已入库"会被上一条旧回执立刻满足。

## 多选题解析里的「命中 / 未命中」标签去掉（用户要求）

用户原话：

> 多选题解析下面那个命中不命中的那个给删掉

- 明细标签按**题型**取舍：`paintDetail(d, type)` 现在收第二个参数（`m.question.type`）。
  - **多选**：不画「命中：A」「未命中：C」——选项上已经有 ✓/✗（自己的选择）与上一行的「正确答案：AB」，
    再列一遍是重复信息；**保留「错选：X」**（它点的是"你选的哪个是错的"，别处没有）。
  - **简答**：「命中 / 未命中」是**采分关键词**，保留 —— 那是它唯一的得分依据，删了就没法自查。
  - 单选 / 判断本来就没有这排标签（明细里没有数组字段）→ 不受影响。
- 判分核心没动：`QuizCore.scoreOne` 照旧给出 `detail.hit/wrong/miss`（引擎的真相源不变），
  只是界面这一层决定"这一题型要不要摆出来"。
- 锚：`verify/attempt.test.js`（多选解析卡上 `命中：/未命中：` 一个都没有、判分结论与正确答案仍在、
  选了错选项时只剩「错选：C」、**简答的「未命中：关键词」照旧在**做反向对照）+
  `probe-attempt-old.js` ⑫（把 `if (!isMulti)` 拆掉 → 锚变红）+
  真浏览器 `verify/answer-library-gen.js`（多选解析卡上的标签数组为空、结论与正确答案仍在）。

## 「重新生成试卷」（原「再抽一次」）挪到「返回题库」旁边（用户要求）

用户原话：

> 你把再抽一次按钮放到返回题库旁边，然后名字改为重新生成试卷

- **归位**：答题中途那颗按钮**从动作条里搬走**，与「返回题库」并排放在左下角那条固定栏
  （`#ansBottomSlot`）里，文案改成「重新生成试卷」。
  - 外壳侧：`#pane-answer` 里加一颗 `<button id="ansRedraw" hidden>重新生成试卷</button>`
    （**必须留在面板里** —— 页面逻辑是通过作用域化的 document 按 id 找它的），
    `moveAnswerActions()` 把 `#ansHome` 与 `#ansRedraw` **一起**搬进固定栏（顺序就是它们在面板里的先后）；
    `RUN_PANE` 的 idMap 加 `btnRedraw: 'ansRedraw'`。
  - 页面侧：`redrawBtn.hidden` 与「返回题库」**同进同出**（`showHomeChrome`），
    点击就是 `redrawRound(1)`（= 按当前设置换一批题，和首页那颗「换一批」同一条路）。
  - 视图侧：`ui/attempt-view.js` **不再**在动作条里画「再抽一次」——
    动作条只剩 上一题 / 下一题（+ 按需的「提交本题」），交卷后仍是「再考一张」（那颗仍归视图）。
- **不被「交卷」FAB 压住**：`.bottomslot` 加 `display:flex;flex-wrap:wrap;gap:8px;max-width:calc(100vw - 132px)` ——
  两颗并排约 230px，窄屏靠"限宽 + 换行"往上长，绝不与右下角那颗 FAB 重叠。
- 锚：`verify/wiring.test.js`（外壳两颗按钮、idMap 登记、两颗一起搬、点击走 `redrawRound(1)`、
  同进同出、**视图里不再画** `mk('redraw'`；`audit()` 现在收第 4 个参数=合并版成品，
  好让探针能把"改坏的合并版"传进来）+ `probe-wiring-old.js` ㉑㉒、`probe-attempt-old.js` ⑧、
  `verify/attempt.test.js` ⑤-c（动作条里没有 redraw/restart 的锚）、
  真浏览器 `verify/prefer-redraw-gen.js`（30 条：两颗同在固定栏里、动作条里没有它、点了真的换一批、
  固定栏右缘不越过 FAB、320/375 靠限宽+换行兜底；**窄视口 420 再跑一遍同样 30 条全绿**）。

## 填 API Key **全应用只有一处**（用户要求：删除重复入口）

用户原话（先说要搬，随即改成删）：

> apikey 的导入功能从错题本页面…不移动了，直接删除，因为导入页面本来就能用，你让导入界面重复功能只保留一个

- **唯一入口**：「导入 / 校对」页顶部那颗「AI 密钥与供应商」（`#revAikey`）→ 挂完整的密钥面板
  （选供应商 / 粘贴 / 保存 / 遮罩显示 / 清除）。这是全应用**唯一**能填 Key 的地方。
- **删掉的重复入口**（以前四处各摆一套表单）：
  · 单题智能面板里的「填 / 换 API Key」（`ui/ai-single.js` mountSingle）
  · 整卷批量面板里的同一套（`ui/ai-single.js` mountBatch）
  · 错题本「举一反三」里的同一套（`ui/ai-scene.js` mountMistake）
  · 交卷页「整卷总评」里的同一套（`ui/ai-scene.js` mountReview）
- **保留只读状态行**（`AiSettings.keyStatus`，新）：这些面板按下去就要联网，用户得能一眼看出"到底填没填"，
  所以留一行「API Key：已配置 N 家（sk-…abcd）/ 未填」+ 一句指路（导入页自己说"用本页顶部那颗"，
  别处说"去「导入 / 校对」页"）。它**没有任何输入与保存能力**，不算重复入口。
- **独立单页版的退路**：`错题本.html` / `答题页.html` 里没有"导入 / 校对"页可去，
  所以那两页仍保留**就地展开**（不给 `keyHint` 即走老路）。合并版给 `keyHint` → 只报状态。
  ⚠ 判据必须用**真窗口文档**（`window.document.getElementById('tab-review')`）：合并版里这些面板拿到的是
  **作用域化的 `document`**，它的 `getElementById` 只在**本面板内部**查找，而页签在面板外 ——
  用它永远判成"独立单页版"，于是"删掉的入口"又会悄悄回来（这种静默退化最难发现）。
- 锚：`verify/ai-entry-gen.js`（27 → **40 条 0 FAIL**：唯一入口真按钮/真输入/假 Key 保存与遮罩/清除；
  单题智能与整卷点评与**真·错题本页面**（点错题条目 → 磁贴「举一反三」）都**没有填 Key 的入口、输入框数 0**，
  但有状态行与指路；**除导入页那份面板外，整页一个 Key 输入框都没有**；不传 `keyHint` 时仍保留就地入口的对照）+
  `verify/wiring.test.js`（keyStatus 导出与样式、导入页两处 keyHint、错题本/答题页指路文案、
  真窗口文档判据）+ `probe-wiring-old.js` ㉓㉔。

## 顶栏「须知」页：声明与警告集中一处 + 使用说明 + 作者小字（用户要求）

用户原话：

> 你在最上面的那一栏加一项须知按钮，把所有声明和警告都移到这里，再写一个简易的使用说明，
> 再在下面小字挂上我的GitHub主页还有项目仓库地址和邮箱 最下面写由北京理工大学2625李佳祎
> 使用deep seekv4.1flash和亲爱的一百块钱制作

- **入口**：页签那一排的第 5 颗按钮 `#tab-help`「须知」（`.tab-act` 主色描边，与「导出分享」同类：
  是**动作**不是页签，`role="tab"` 仍只有 3 个）。宽屏也一直摆着，窄屏跟着那一排折叠。
- **形态**：整页浮层 `#helpPage`（复用「导出分享」那套 `.sharepage` / `.share-card` 观感：
  手机能滚、按钮 ≥44px、点遮罩空白处关闭、`#helpClose` 关闭）。
  ⚠ 点开时**只在这一处替用户收起页签那排**（浮层上面不该再压一排按钮）——
  这与"点页签跳转之后不要自动收起"不冲突：那是跳转，这是开浮层。
- **内容三段**：① 怎么用（三步）+ 常用按钮；② **声明与警告**（九条：数据只存本机 / 只有 AI 需要联网 /
  AI 密钥只存本机 / 分享文件只带试卷 / 下载可能被拦 / 删除不可恢复 / 存储不可用或写满 / 判分口径 / 内容自负）；
  ③ 小字：GitHub 主页 + 项目仓库地址 + 邮箱，最下面一行制作署名。
- **旧的零散声明搬走了**：页面原来的页脚声明（"数据只存你本机（localStorage）；只有 AI 功能需要联网。"）
  从 `.foot` 里删掉，**只在须知里写一份**；页脚改成署名 + 一句"详细使用说明与全部声明在顶部「须知」里"。
  ⚠ 实时的存储告警（`#ansWarn` / `#storeWarn`）**仍然留在原地**：那是"此刻出事了"的警报，
  搬进须知等于让人看不见；须知里写的是它的**后果与建议**（同一条规矩的两种角色）。
- 锚：`verify/wiring.test.js`（按钮+浮层+关闭+`window.__help`、抠出须知正文、九条声明逐条点名、
  旧页脚声明确实搬走、两条链接、邮箱行、两处署名）+ `probe-wiring-old.js` ㉕㉖㉗ +
  真浏览器 `verify/mobile-ui-gen.js`（420 宽：按钮 ≥44px → 点开浮层 → 收起页签排 → 说明与九条声明都在 →
  两条 GitHub 链接在卡片内不溢出 → 邮箱行在 → 署名在 → 关闭可用 → 页脚署名在；31 → **52 条**）+
  `verify/import-bank-gen.js`（1280 宽：整排 5 个按钮一直摆着）。

## 「生成解析」一颗按钮（用户要求：不分开，整合成整卷解析）

用户原话：

> 不要分开，整合到一个生成解析按钮解析对应整卷

- **界面**：导入 / 校对页那一排原来有两颗 AI 任务按钮（「单题智能」`#revAisingle` /「整卷批量」`#revAibatch`），
  现在**合成一颗** `#revAibatch`「生成解析」（`#revAisingle` 按钮与 `#revSinghost` 宿主**一并删掉**，
  不留空壳；合并壳的 idMap 也去掉了 `aisingle` / `singlehost`）。
- **它干什么**：对**这份草案里还缺解析的题**（简答题、或没有 `explanation` 的题）逐题生成解析 ——
  先弹消耗确认窗（题数 + 估算 token + 发给哪家），确认后逐题跑、单题失败只跳过那一题，
  写回**同一份草案**（`panel.setDraft`），入库仍由「确认入库」把关。
- **单题那条路撤了**：`ui/ai-single.js` 的 `mount()`（单题：解析 / 变式题 / 难度）**页面不再用**，
  代码与配套测试（`verify/ai-single.test.js`、自检页 P 节）保留 —— 将来想放回来只是加一颗按钮的事。
- 文案跟着改：面板标题「生成解析（解析）」、按钮「开始生成解析」、确认窗「要开始生成解析吗？」；
  要「变式题」的去处仍在错题本磁贴里的「举一反三」（按误答考点出新题，可加入本卷）。
- 锚：`verify/wiring.test.js`（不再挂 `AiSingle.mount`、只挂 `mountBatch`、按钮文案、
  单题按钮与宿主都没了、解析对象来自 `panel.getDraft()`、写回 `panel.setDraft`、`kind:'explain'`）+
  `probe-wiring-old.js` ⑦㉓ + 真浏览器 `verify/ai-entry-gen.js`（40 → **48 条**：
  只有一颗「生成解析」且 ≥44px → 点它挂面板 → 标题/题数/token 估算都在 → 点「开始生成解析」**先弹确认窗**、
  取消后零请求）+ `verify/mobile-ui-gen.js`（窄屏工具排入口由 6 个变 5 个）。

## 答题计时（悬浮球 + 暂停）、分数线按比例、多选得分可调（用户要求）

用户原话：

> 增加答题计时功能选项，做成不占位置的悬浮球，计时器可暂停。分数线功能及格线和优秀线改成分数比例，
> 多选全队和半对得分都可以自己调整

### 答题计时：`behavior.timer`（默认 **false**）

- 开关在「作答行为」组（`答题计时（悬浮球）`），排在"答错的题也自动翻页"之后。
- 开了之后答题界面挂一颗 **`.av-timer` 悬浮球**：`position:fixed;right:14px;bottom:78px`（在右下角
  「交卷」FAB 之上）—— **不占任何排版位置**（不进 grid/flex、不挤栏）。快捷面板展开时它跟着抬到
  `bottom:340px`（与动作条同一个数），免得被面板压住 / 挡住面板里的控件。
- **点一下暂停 / 再点继续**：暂停时球变琥珀色、文字变「已暂停 ▶」，`aria-label` 与 `title` 同步。
- **状态住在 `session.timer = { ms, paused }`**（不是视图里的临时变量）：随进度一起存本机
  （`AttemptCore.serializeProgress` / `restoreProgress`），所以刷新或「继续这一轮」是**接着走表**。
  旧载荷没有 `timer` 字段 → 恢复成 0（不会把没计过时的轮次算成计过）。
- 走表用 500ms 的 `setInterval`，**只改球里那串数字**（不重画整页）；`destroy()` 里清掉定时器
  （否则看不见的页面还在走表 —— 探针第一版就因为没销毁把 Node 进程挂住了）。
- 交卷后球收起，成绩单里写一行「用时 mm:ss」。
- 锚：`verify/attempt.test.js` ⑪（关着不画 / 开着画且是 BUTTON / 只有一颗 / mm:ss / 1.2 秒真的在走 /
  点一下暂停且读数停住 / 球上写「已暂停」/ 再点继续 / 交卷后球收起 + 成绩单写用时 / 关掉立刻消失）+
  `probe-attempt-old.js` ⑬⑭ + `verify/wiring.test.js`（fixed 定位与 paused 样式、session.timer、恢复）+
  真浏览器 `verify/answer-library-gen.js`（默认关 → 打开出球 → `position:fixed` → mm:ss → 与「交卷」不重叠 →
  1.1 秒读数在走 → 暂停后读数不变 → 继续 → 面板展开时球抬到 340px；`docs/ui-timer-ball.png`）。

### 分数线改成分数比例

- 取值口径**没变**（0-100 的百分数，`levelOf` 就是拿 `percent` 比它），改的是**说法与单位**：
  `CONFIG_FIELDS` 里改叫「及格比例 / 优秀比例」、`unit: '%'`；面板备注写
  「及格 60% / 优秀 85%（都按卷面满分的百分比算）」；成绩单写「及格 60%（33 / 55 分）」——
  同时给等效分数，免得被读成"及格 60 分"。
- 锚：`verify/flow.test.js`（备注文案与单位）、`verify/attempt.test.js` ⑪（成绩单里的
  `及格 \d+%（\d+ / \d+ 分）`）、`verify/config.test.js`（字段模型照旧过校验）。

### 多选全对 / 半对得分可调（设置页「判分」组）

- 新增一组 **「判分」**（`points.多选` = 全对得分 / `multi.halfScore` = 半对得分），两行都是步长 **0.5** 的
  加减控件；半对那一行的 `max` **动态取当前全对得分**（面板上的「+」到顶就灰）。
- 两条硬约束在**动作层**兜住（不指望用户记）：都是 0.5 的整数倍；**半对 ≤ 全对** ——
  把全对压到 1.5 时半对**一起压下来**（`clampedHalf`），半对填超了**压回全对**（`clampedToFull`），
  两种都在绿字提示里如实说明。
- 非 `fixedScore` 的半对模式（`fixed` / `hitRatio`）不用 `halfScore` → 备注里明说「不用"半对得分"这一项」。
- 这三组（抽题与题量 / 分数线 / 判分）都**只在"答卷前设置页"**能改；答题时的底部面板把它们全部排除
  （改了也不会换正在答的题，避免"改了没反应"的错觉）。
- 锚：`verify/flow.test.js` ④-H（初值 / +0.5 / 直接给值 / 半对封顶 / 压下来 / 非数字被拦 / 两行与 step 与 max /
  模式备注）、`probe-flow-old.js` ⑰⑱⑲、`verify/app-shell.test.js`（三组都画 + 三组都排除）+
  真浏览器 `verify/answer-library-gen.js`（设置页里改叫比例、判分两行在、「+」真的加 0.5、半对不超过全对）。