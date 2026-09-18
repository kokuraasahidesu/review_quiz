/* ============================================================
 *  verify/share-payload.test.js —— 「脱敏打包」小类验收（verify=redteam）
 *
 *  运行： node verify/share-payload.test.js
 *
 *  三条盘档验收标准，逐条对应：
 *    ① 脱敏载荷通过敏感扫描**零命中**（密钥形状与敏感字段名均无）；
 *    ② 题干含 `</script>` 等特殊字符时，生成的文件**只有一对 script 标签**、结构完整，
 *       且往返读回题干内容**无损**；
 *    ③ 脱敏后**题目与采分关键词完整保留**（简答关键词数与原卷一致）。
 *
 *  每条都配**反向对照**（把闸门拆掉必须变红），见 verify/probe-share-payload-old.js。
 * ============================================================ */
const D = require('../core/data.js');
const S = require('../core/schema.js');
const Q = require('../core/quiz.js');
const fsMod = require('fs'), pathMod = require('path');

let pass = 0, fail = 0; const failures = [];
function brief(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return String(s);
  return s.length > 190 ? s.slice(0, 190) + '…(' + s.length + ' 字符)' : s;
}
function ok(c, t, d) { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + brief(d) : '')))
                         : (fail++, failures.push(t), console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + brief(d) : ''))); }
function eq(a, e, t) { const A1 = JSON.stringify(a), B = JSON.stringify(e); ok(A1 === B, t + '   期望=' + brief(B), A1); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }

const CANARY = 'sk-canary-9f3a7c1e5b2d4680zz';
/* 一套"真实形状"的卷：四类题都有，简答带 4 个关键词（含 via） */
function makeExam(id) {
  return S.createExam({
    id: id, title: '脱敏测试卷',
    config: Q.resolveConfig({ points: { '单选': 3, '简答': 8 } }, null),
    configLocked: true,
    questions: [
      S.createQuestion({ id: id + '-q1', type: '单选', stem: 'HTTP 默认端口？', options: [{ label: 'A', text: '21' }, { label: 'B', text: '80' }], answerLetters: ['B'], answer: 'B', explanation: '80 是明文默认端口。' }),
      S.createQuestion({ id: id + '-q2', type: '多选', stem: '哪些是传输层协议？', options: [{ label: 'A', text: 'TCP' }, { label: 'B', text: 'UDP' }, { label: 'C', text: 'HTTP' }], answerLetters: ['A', 'B'], answer: 'AB' }),
      S.createQuestion({ id: id + '-q3', type: '判断', stem: 'TCP 面向连接。', judgeValue: true, answer: '对' }),
      S.createQuestion({ id: id + '-q4', type: '简答', stem: '简述三次握手。', answer: 'SYN/ACK',
        keywords: [{ text: '三次握手', via: '加粗' }, { text: 'SYN', via: '加粗' }, { text: 'ACK', via: '高亮' }, { text: 'ESTABLISHED', via: '自动(需校对)' }] })
    ]
  }, { now: '2026-10-30T09:00:00.000Z' });
}
/* 一个"脏 state"：除了卷子，还塞满敏感东西（密钥、记录、误答本、进度、草稿） */
function dirtyState(exam) {
  return {
    exams: [exam],
    settings: { config: { points: { '单选': 3 } }, apiKeys: { dashscope: { key: CANARY, at: 't' } }, apiKey: CANARY },
    records: [{ at: 't', examId: exam.id, score: 1, answer: 'A', correctAnswer: 'B' }],
    wrongBook: { [exam.id]: { entries: { [exam.id + '-q1']: { qid: exam.id + '-q1', times: 3, lastAnswer: 'A' } } } },
    progress: { sessionId: 's1', answers: { [exam.id + '-q1']: 'A' } },
    draft: { id: 'draft-1', questions: [] }
  };
}
const EXAM = makeExam('SH1');
const STATE = dirtyState(EXAM);
const PAYLOAD = D.sanitizeSharePayload(STATE, { examId: 'SH1' });

head('①-A 零命中：密钥形状与敏感字段名都不出现');

const scan = D.shareScan(PAYLOAD, { secrets: D.secretsOfState(STATE) });
eq([scan.ok, scan.hits], [true, []], '**脱敏载荷零命中**（shareScan.ok=true 且没有任何 hit）');
eq(scan.checked.topKeys, ['exams', 'exportedAt', 'kind', 'schemaVersion'], '载荷顶层键就这 4 个：' + scan.checked.topKeys.join('/'));
eq(scan.checked.secrets, 1, '来源机密集合里有 1 条 —— **同一把 Key 出现两处会去重**，1 字符的作答被过滤（<8 字符不进集合）');
const txt = JSON.stringify(PAYLOAD);
ok(txt.indexOf(CANARY) < 0, '**载荷里搜不到 Key 原文**', txt.length + ' 字节的载荷');
ok(txt.indexOf('apiKeys') < 0 && txt.indexOf('apiKey') < 0, '  也没有 apiKeys/apiKey 这些键名');
ok(txt.indexOf('"records"') < 0 && txt.indexOf('"wrongBook"') < 0 && txt.indexOf('"progress"') < 0 && txt.indexOf('"draft"') < 0,
   '  记录/误答本/进度/草稿**连键都不出现**（不是置空）');
eq(D.findSecrets(PAYLOAD), [], 'findSecrets（结构白名单）同样零命中');
['apikey', 'token', 'secret', 'records', 'wrongbook', 'password', 'authorization'].forEach(function (k) {
  const lower = k.toLowerCase().replace(/[^a-z_]/g, '');
  ok(D.FORBIDDEN_KEYS.indexOf(lower) >= 0, '  「' + k + '」在敏感字段名清单里（清单本身可核对）');
});
ok(D.FORBIDDEN_KEYS.indexOf('answer') < 0, '  **但「answer」不在清单里**：参考答案是判分要用的，必须带走（清单要精确，不能一刀切）');

head('①-B 白名单是**唯一真相源**：载荷字段与常量逐字段对齐');

const ex0 = PAYLOAD.exams[0];
eq(Object.keys(ex0).sort(), D.SHARE_EXAM_FIELDS.slice().sort(), '试卷层的键 = SHARE_EXAM_FIELDS（一个不多一个不少）');
eq(Object.keys(ex0.questions[0]).sort(), D.SHARE_QUESTION_FIELDS.slice().sort(), '题目层的键 = SHARE_QUESTION_FIELDS');
const extra = S.createQuestion({ id: 'x1', type: '单选', stem: 's', options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], answerLetters: ['A'], answer: 'A' });
const dirtyExam = Object.assign({}, EXAM, { apiKey: CANARY, password: 'p', records: [{ answer: 'A' }] });
const dirtyQ = Object.assign({}, extra, { apiKey: CANARY, token: 't', records: [{ answer: 'A' }] });
const p2 = D.sanitizeSharePayload({ exams: [Object.assign({}, dirtyExam, { questions: [dirtyQ] })], settings: STATE.settings }, {});
const t2 = JSON.stringify(p2);
ok(t2.indexOf(CANARY) < 0 && t2.indexOf('"apiKey"') < 0 && t2.indexOf('"password"') < 0 && t2.indexOf('"token"') < 0,
   '**往试卷/题目上硬塞敏感字段 → 载荷里一个字都不出现**（白名单重建，注入字段被整个丢掉）');
eq(D.shareScan(p2, { secrets: [CANARY] }).ok, true, '  这一份同样零命中');
ok(D.findSecrets({ apiKey: CANARY }).length === 2, '反向对照：findSecrets 本身真会抓（字段名 + 密钥形状各一条）',
   JSON.stringify(D.findSecrets({ apiKey: CANARY }).map(function (h) { return h.why; })));

head('①-C 密钥形状不止 sk-：八种常见形状都认得，且不误伤题面');

eq(D.SECRET_SHAPES.length, 8, 'SECRET_SHAPES 有 8 种形状');
const shapes = [
  ['sk- 型', 'sk-' + 'A'.repeat(24)],
  ['Bearer', 'Authorization: Bearer ' + 'a'.repeat(24)],
  ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop'],
  ['GitHub', 'ghp_' + 'b'.repeat(24)],
  ['Slack', 'xoxb-' + '1234567890-abcdef'],
  ['AWS', 'AKIA' + 'C'.repeat(16)],
  ['Google', 'AIza' + 'd'.repeat(30)],
  ['私钥块', '-----BEGIN RSA PRIVATE KEY-----']
];
shapes.forEach(function (s) {
  const names = D.secretShapesIn('前缀 ' + s[1] + ' 后缀');
  ok(names.length >= 1, '认得「' + s[0] + '」形状', names.join('、'));
});
eq(D.secretShapesIn('这道题问的是 HTTP 默认端口，答案是 80。'), [], '普通题面**不误伤**（零形状命中）');
eq(D.secretShapesIn('Bearer 令牌这种东西要单独说'), [], '只写"Bearer"、后面没跟 token → 不误伤');
const leaky = Object.assign({}, EXAM, { questions: [S.createQuestion({ id: 'L1', type: '简答', stem: '题干里粘了 ' + CANARY + ' 这串', keywords: [{ text: 'x' }] })] });
const leakyScan = D.shareScan(D.sanitizeSharePayload({ exams: [leaky] }, {}), { secrets: [CANARY] });
eq(leakyScan.ok, false, '**题干里粘了 Key → 扫描立刻报红**（说明①不是恒真）', JSON.stringify(leakyScan.hits));
ok(/密钥形状|来源机密/.test(leakyScan.hits[0].why), '  并说清是哪一类问题：' + leakyScan.hits[0].why);

head('①-D 容器内部的敏感键也要剔除（红队 P2：顶层白名单拦不住塞进 config/options/keywords 的）');

const nested = S.createExam({
  id: 'NEST', title: '容器污染卷',
  config: Object.assign({ points: { '单选': 3 } }, { apiKey: CANARY, password: 'p', token: 't', records: null }),
  questions: [
    S.createQuestion({ id: 'nest1', type: '单选', stem: '题干干净', options: [{ label: 'A', text: '甲', token: CANARY }, { label: 'B', text: '乙', secret: CANARY }], answerLetters: ['A'], answer: 'A' }),
    S.createQuestion({ id: 'nest2', type: '简答', stem: '题干干净', answer: 'a', keywords: [{ text: 'k1', secret: CANARY }, { text: 'k2', apiKey: null }] })
  ]
}, { now: '2026-10-30T09:00:00.000Z' });
const nestPayload = D.sanitizeSharePayload({ exams: [nested] }, {});
const nestTxt = JSON.stringify(nestPayload);
ok(nestTxt.indexOf(CANARY) < 0, '**塞进 config/options/keywords 里的密钥也被剔掉了**（不再是"整对象透传"）');
['"apiKey"', '"password"', '"token"', '"secret"', '"records"'].forEach(function (k) {
  ok(nestTxt.indexOf(k) < 0, '  嵌套层里的 ' + k + ' 键名也不出现');
});
eq(D.shareScan(nestPayload, { secrets: [CANARY] }).ok, true, '  这一份同样零命中');
eq(Object.keys(nestPayload.exams[0].config).indexOf('points') >= 0, true, '  该留的配置（points）还在');
eq(nestPayload.exams[0].questions[0].options.length, 2, '  选项数量没被误删（只剔敏感子键）');
eq(nestPayload.exams[0].questions[1].keywords.map(function (k) { return k.text; }), ['k1', 'k2'], '  关键词文本也没被误删');

head('①-E 载荷与原 state **不共享引用**（红队 P3：改载荷会穿回原卷）');

const cfgBefore = JSON.stringify(nested.config);
const optBefore = JSON.stringify(nested.questions[0].options);
nestPayload.exams[0].config.points['单选'] = 999;
nestPayload.exams[0].questions[0].options[0].text = '被改过了';
nestPayload.exams[0].questions[1].keywords[0].text = '被改过了';
eq(JSON.stringify(nested.config), cfgBefore, '改载荷的 config → **原卷配置不受影响**');
eq(JSON.stringify(nested.questions[0].options), optBefore, '改载荷的选项 → 原卷选项不受影响');
eq(nested.questions[1].keywords[0].text, 'k1', '改载荷的关键词 → 原卷关键词不受影响');

head('②-A 特殊字符：文件里只有一对 payload script 标签');

const NASTY = [
  '题干含结束标签 </script> 结尾',
  '大小写混写 </SCRIPT > 也要挡',
  '只有开头 <script 没有斜杠',
  '注释开始 <!-- 与 --> 结束',
  '行分隔符\u2028与段分隔符\u2029',
  '引号 " 与反斜杠 \\ 与制表\t符',
  '双写 </script></script> 连击',
  '实体 &lt;/script&gt; 形式',
  /* ⚠ 下面 5 条是红队抓出来的**真缺陷类**：`String.replace` 的替换模式会把它们当 `$` 语法展开，
   *   于是 `$$x^2$$` 静默变成 `$x^2$`、`$&` 变成整个匹配（甚至把模板原文塞进载荷）。 */
  '替换模式 $& 表示整个匹配',
  '替换模式 $` 表示匹配之前的文本',
  "替换模式 $' 表示匹配之后的文本",
  '替换模式 $$ 表示一个字面美元符',
  '数学公式 $$x^2 + y^2 = z^2$$ 的几何意义'
];
const nastyExam = S.createExam({
  id: 'NASTY', title: '特殊字符卷',
  questions: NASTY.map(function (s, i) {
    return S.createQuestion({ id: 'n' + i, type: '简答', stem: s, answer: '答案 ' + i, keywords: [{ text: 'k' + i, via: '手动' }] });
  })
}, { now: '2026-10-30T09:00:00.000Z' });
const nastyPayload = D.sanitizeSharePayload({ exams: [nastyExam] }, {});
eq(D.shareScan(nastyPayload, {}).ok, true, '这份"全是特殊字符"的载荷本身也零命中（扫的是密钥形状，不是尖括号）');
const template = '<!doctype html><html><body><div id="app"></div>\n</body></html>';
const file = D.embedPayload(template, nastyPayload, { secrets: [] });
const counts = D.payloadBlockCount(file);
eq(counts.blocks, 1, '**payload 块只有 1 个**（没有因为题面里的 </script> 被切碎或多插）');
eq(D.rawCloseInPayload(file), 0, '载荷块内部**没有裸 `</script`**（`<` 已全部转义）');
eq(counts.scriptCloses, 1, '整个文件里 `</script>` 只有 1 个（模板本来没有 script，注入 1 个）');
const withOwnScript = '<html><body><script>var a=1;</script>\n</body></html>';
const file2 = D.embedPayload(withOwnScript, nastyPayload, { secrets: [] });
eq(D.payloadBlockCount(file2).scriptCloses, 2, '模板本来有一个 script 时 → 文件里 `</script>` 数 = 模板数 + 1');
eq(D.payloadBlockCount(file2).blocks, 1, '  payload 块仍然只有 1 个');
const again = D.embedPayload(file, nastyPayload, { secrets: [] });
eq(D.payloadBlockCount(again).blocks, 1, '**重复内嵌还是 1 个**（幂等替换，不是叠加）',
   D.payloadBlockCount(again).blocks + ' 个');
eq(D.payloadBlockCount(again).scriptCloses, 1, '  闭合标签数也没有涨');
/* 红队 P2：已有块的识别不能对**属性顺序/引号/空白/大小写**敏感（否则会插出第二个块） */
const altOrder = '<html><body><script type="application/json" id="exam-payload">{"old":1}<\/script>\n</body></html>';
const replaced = D.embedPayload(altOrder, nastyPayload, { secrets: [] });
eq(D.payloadBlockCount(replaced).blocks, 1, '**属性顺序不同的已有块也被替换**（不会插出第二个）');
eq(D.extractPayload(replaced).kind, 'quiz-share', '  读回来是新那份（不是旧的 {"old":1}）');
eq((replaced.match(/"old":1/g) || []).length, 0, '  旧内容已经被替换掉');
['<script id = "exam-payload" type="application/json">{"old":2}<\/script>',
 '<script ID="exam-payload" type="application/json">{"old":3}<\/script>',
 "<script type='application/json' id='exam-payload'>{\"old\":4}<\/script>"].forEach(function (variant, i) {
  const out = D.embedPayload('<html><body>' + variant + '\n</body></html>', nastyPayload, { secrets: [] });
  eq(D.payloadBlockCount(out).blocks, 1, '  变体 ' + (i + 1) + '（空格/大写/单引号写法）也被识别并替换');
  eq((out.match(/"old":/g) || []).length, 0, '    旧块内容被替换干净');
});
/* 红队 P3：插入点必须取**最后一个** `</body>`（模板 JS 字符串里出现 "</body>" 时不能插错位置） */
const vm = require('vm');
/* 模板自己的第一个 script 块必须仍然能编译 —— 载荷若被插进脚本字符串里，这段 JS 会被切断 */
function firstTemplateScriptParses(html) {
  const m = String(html).match(/<script(?![^>]*exam-payload)[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return true;
  try { new vm.Script(m[1]); return true; } catch (e) { return false; }
}
const trickyTpl = '<html><body><script>var tail = "</body>";</script>\n</body></html>';
const trickyFile = D.embedPayload(trickyTpl, nastyPayload, { secrets: [] });
eq(D.payloadBlockCount(trickyFile).scriptCloses, 2, '模板 JS 里有 "</body>" 字符串 → 闭合标签仍是 模板 1 + 载荷 1');
eq(firstTemplateScriptParses(trickyFile), true, '  **模板那段 JS 仍能编译**（载荷没被插进脚本字符串里打断页面）');
ok(D.extractPayload(trickyFile).kind === 'quiz-share', '  而且能正常读回');
/* 出厂闸门：载荷不干净时 embedPayload **拒绝内嵌** */
const leakyExam = S.createExam({ id: 'LK', title: 't', questions: [S.createQuestion({ id: 'lk1', type: '简答', stem: '题干粘了 ' + CANARY, keywords: [{ text: 'k' }] })] }, {});
const leakyPayload = D.sanitizeSharePayload({ exams: [leakyExam] }, {});
let gateErr = null;
try { D.embedPayload('<html></html>', leakyPayload, { secrets: [] }); } catch (e) { gateErr = e; }
ok(!!gateErr && /敏感扫描/.test(gateErr.message), '**embedPayload 自带出厂闸门**：不干净的载荷直接拒绝内嵌',
   gateErr ? gateErr.message : '（居然没抛错）');
eq(gateErr && gateErr.hits.length, 1, '  抛出的错误里带上命中清单（可定位）');
ok(D.embedPayload('<html></html>', leakyPayload, { allowUnsafe: true }).indexOf('exam-payload') >= 0,
   '  显式 allowUnsafe:true 时才放行（留一条"我知道我在干什么"的口子）');
/* 红队 P2：**缺 secrets 要 fail-closed**（两参流水线曾能绕过来源机密比对） */
let needSecrets = null;
try { D.embedPayload('<html></html>', nastyPayload); } catch (e) { needSecrets = e; }
eq(needSecrets && needSecrets.code, 'E_NEED_SECRETS', '缺 secrets 参数 → 明确报 E_NEED_SECRETS（不再默默跳过最强那道比对）');
ok(/buildSharePackage/.test(needSecrets.message), '  错误信息指路：用 buildSharePackage 或显式传 secrets', needSecrets.message);

head('②-B 往返无损：题干逐字节一致');

const back = D.extractPayload(file);
ok(!!back, '能从生成的文件里读回载荷');            // 先钉住"读得回来"，后面逐条比较才有意义
eq(back && back.exams[0].questions.length, NASTY.length, '题目数一致');
NASTY.forEach(function (s, i) {
  const got = back && back.exams[0].questions[i] ? back.exams[0].questions[i].stem : null;
  if (got !== s) { ok(false, '第 ' + (i + 1) + ' 条题干往返不等', JSON.stringify({ want: s, got: got })); return; }
});
eq(NASTY.map(function (s, i) { return !!(back && back.exams[0].questions[i] && back.exams[0].questions[i].stem === s); }), NASTY.map(function () { return true; }),
   '**13 条特殊字符题干逐字节往返无损**（script 结束标签 / HTML 注释 / U+2028 / 美元替换模式 / 公式定界符）');
ok(NASTY.every(function (s, i) { return back && back.exams[0].questions[i] && back.exams[0].questions[i].stem === s; }),
   '  逐条布尔复核（防"整体比较恰好通过"）');
/* 单独把 `$` 这一类的往返再钉一遍（红队抓的正是它） */
['$$x^2$$', '$&', '$`', "$'", '$$', '$1$2'].forEach(function (s) {
  const one = S.createExam({ id: 'D', title: 't', questions: [S.createQuestion({ id: 'd1', type: '简答', stem: '内容 ' + s + ' 结束', keywords: [{ text: 'k' }] })] }, {});
  const f2 = D.embedPayload('<html><body>\n</body></html>', D.sanitizeSharePayload({ exams: [one] }, {}), { secrets: [] });
  const b2 = D.extractPayload(f2);
  eq(b2.exams[0].questions[0].stem, '内容 ' + s + ' 结束', '「' + s + '」原样往返（不被替换模式展开）');
});
/* 带自有 script 的模板 + `$\`` 这种会"塞进前文"的替换模式：结构必须仍然完整 */
const tplWithScript = '<html><body><script>var tpl="X";</script>\n</body></html>';
const trap = S.createExam({ id: 'TRAP', title: 't', questions: [S.createQuestion({ id: 't1', type: '简答', stem: '结尾 $` 与 $&', keywords: [{ text: 'k' }] })] }, {});
const trapFile = D.embedPayload(tplWithScript, D.sanitizeSharePayload({ exams: [trap] }, {}), { secrets: [] });
eq(D.payloadBlockCount(trapFile).scriptCloses, 2, '带自有 script 的模板：闭合标签数 = 模板 1 + 载荷 1');
eq((trapFile.match(/var tpl="X";/g) || []).length, 1, '  模板原文**没有被复制进载荷**（"匹配之前/之后"那两个替换模式不再生效）');
eq(D.extractPayload(trapFile).exams[0].questions[0].stem, '结尾 $` 与 $&', '  载荷仍然读得回且内容无损');
const det = D.extractPayloadDetailed(file);
eq([det.ok, typeof det.raw], [true, 'string'], 'extractPayloadDetailed 也能用（带原因版）');
eq(D.extractPayloadDetailed('<html>没有载荷</html>'), { ok: false, reason: 'no-payload', message: '这个文件里没有分享载荷块' },
   '没有载荷块 → 明确原因（不是 null 了事）');
const broken = '<script id="exam-payload" type="application/json">{oops</script>';
eq(D.extractPayloadDetailed(broken).reason, 'bad-json', '载荷块里 JSON 坏了 → 明确报 bad-json');
eq(D.extractPayload('<html></html>'), null, 'extractPayload 旧接口保持兼容（读不到就是 null）');

head('③-A 完整性：题目与采分关键词一个不少');

const pExam = PAYLOAD.exams[0];
eq(pExam.questions.length, EXAM.questions.length, '题目数与原卷一致（4 题）');
eq(pExam.questions.map(function (q) { return q.type; }), ['单选', '多选', '判断', '简答'], '四类题型都在，顺序不变');
const q4 = pExam.questions[3], o4 = EXAM.questions[3];
eq(q4.keywords.length, o4.keywords.length, '**简答关键词数与原卷一致**（' + o4.keywords.length + ' 个）');
eq(q4.keywords.map(function (k) { return k.text; }), o4.keywords.map(function (k) { return k.text; }), '  关键词文本逐个一致');
eq(q4.keywords.map(function (k) { return k.via; }), o4.keywords.map(function (k) { return k.via; }), '  via（来源标记）也保住了');
eq(pExam.questions[0].options, EXAM.questions[0].options, '选项原样保留（内容与标签）');
eq(pExam.questions[0].answerLetters, EXAM.questions[0].answerLetters, '答案字母原样保留');
eq(pExam.questions[2].judgeValue, true, '判断题的 judgeValue 原样保留');
eq(pExam.questions[0].explanation, EXAM.questions[0].explanation, '解析原样保留');
eq([pExam.id, pExam.title, pExam.configLocked], ['SH1', '脱敏测试卷', true], '卷 id / 标题 / 锁定标记都保留');
eq(pExam.config.points['单选'], 3, '配置里的分值保留（判分要用）');
eq(Object.keys(pExam.config), Object.keys(EXAM.config), '配置的键集合与原卷一致');

head('③-B 完整性到"判分可用"：脱敏后的载荷能真的判出一模一样的分数');

const answers = { 'SH1-q1': 'B', 'SH1-q2': 'AB', 'SH1-q3': '对', 'SH1-q4': '三次握手 SYN ACK' };
const cfgShared = Q.resolveConfig(null, PAYLOAD.exams[0]);
const scoreOriginal = Q.scoreExam(EXAM.questions, answers, Q.resolveConfig(null, EXAM));
const scoreShared = Q.scoreExam(PAYLOAD.exams[0].questions.map(function (q) { return S.createQuestion(q); }), answers, cfgShared);
eq([scoreShared.score, scoreShared.full, scoreShared.percent, scoreShared.correctCount],
   [scoreOriginal.score, scoreOriginal.full, scoreOriginal.percent, scoreOriginal.correctCount],
   '**脱敏前后判分结果完全相同**（分数/满分/百分数/正确题数）',
   JSON.stringify({ shared: [scoreShared.score, scoreShared.full], original: [scoreOriginal.score, scoreOriginal.full] }));
eq(scoreShared.per.map(function (p) { return p.correct; }), scoreOriginal.per.map(function (p) { return p.correct; }),
   '  逐题对错也一致（简答按关键词采分照样能判）');

head('③-C 相邻锚：脱敏只影响分享载荷，不动原 state；出厂入口一步到位');

const stateBefore = JSON.stringify(STATE);
D.sanitizeSharePayload(STATE, { examId: 'SH1' });
eq(JSON.stringify(STATE), stateBefore, '生成载荷**不改动原 state**（纯函数）');
eq(EXAM.questions.length, 4, '原卷题目数不变');
eq(STATE.settings.apiKeys.dashscope.key, CANARY, '原 state 里的密钥还在（脱敏只是"不带走"，不是"删掉"）');
const onlyOne = D.sanitizeSharePayload({ exams: [EXAM, makeExam('SH2')] }, { examId: 'SH2' });
eq(onlyOne.exams.map(function (e) { return e.id; }), ['SH2'], '按 examId 过滤只带那一卷');
eq(D.sanitizeSharePayload({ exams: [] }, {}).exams, [], '没有卷子时也给一份合法空载荷（不抛异常）');

/* 出厂入口：`buildSharePackage` 把"生成 + 体检"焊在一起（红队 P2：以前 shareScan 全仓零调用点） */
const pkg = D.buildSharePackage(STATE, {});
eq([pkg.ok, pkg.scan.ok], [true, true], 'buildSharePackage：干净 state → ok 且内部体检通过');
eq(pkg.scan.checked, { exams: 1, questions: 4, secrets: D.secretsOfState(STATE).length, topKeys: ['exams', 'exportedAt', 'kind', 'schemaVersion'] },
   '  体检给出可核对的计数（卷数/题数/比对的机密数=' + D.secretsOfState(STATE).length + '/顶层键）');
ok(/零命中/.test(pkg.message), '  一句话结论：' + pkg.message);
const badPkg = D.buildSharePackage({ exams: [leakyExam] }, {});
eq([badPkg.ok, badPkg.scan.hits.length > 0], [false, true], 'buildSharePackage：脏内容 → **ok:false**（不许写文件）');
ok(/不要发出去/.test(badPkg.message), '  并明确劝阻：' + badPkg.message);
eq(D.buildSharePackage({ exams: [leakyExam] }, {}).payload.exams[0].questions[0].stem.indexOf(CANARY) >= 0, true,
   '  **不去静默改写用户题面**（只报路径，由人决定怎么处理）');

head('①-F 契约形状与复合键名（红队第二轮抓的两类"漏网"）');

/* 契约里 AppState 的 exams 是**映射** `{[id]:exam}`（schema.createAppState 就是这个形状），
 * 而测试一直只喂数组 —— 唯一入口喂真实 AppState 会直接 TypeError（红队 P1）。 */
const appState = S.createAppState();
appState.exams['CH1'] = makeExam('CH1');
appState.secrets = { apiKey: CANARY, provider: 'dashscope' };
const pkgApp = D.buildSharePackage(appState, {});
eq([pkgApp.ok, pkgApp.scan.checked.exams, pkgApp.scan.checked.questions], [true, 1, 4],
   '**喂契约形状的 AppState（exams 是映射）也能跑通**：1 套卷 / 4 题 / 零命中');
eq(D.sanitizeSharePayload(appState, {}).exams[0].id, 'CH1', '  脱敏入口同时支持数组与映射两种形状');
eq(D.examsOfState(appState).length, 1, '  examsOfState 把映射取成数组');
eq(D.examsOfState({ exams: [EXAM, null, 'x'] }).length, 1, '  数组里混 null/非对象也会被过滤（不再抛裸 TypeError）');
eq(D.sanitizeSharePayload({ exams: [null, undefined] }, {}).exams, [], '全 null 的输入给出合法空载荷（不崩）');
eq(D.sanitizeSharePayload({ exams: [{ id: 'X', title: 't', questions: '不是数组' }] }, {}).exams[0].questions, [],
   'questions 不是数组 → 当空处理（不再 `map is not a function`）');
eq(D.buildSharePackage({}, {}).ok, true, '空 state 也能出一份合法空包');

head('①-G 同义词表的键是**用户数据**（红队第五轮：曾整表被剔空、判分从 5/5 掉到 0/5）');

const synExam = S.createExam({
  id: 'SYN', title: '同义词卷',
  config: { short: { synonyms: { API: ['应用程序接口'], token: ['令牌'] }, matchMode: 'contains' }, points: { '简答': 5 } },
  questions: [S.createQuestion({ id: 'syn1', type: '简答', stem: '什么是 API 令牌？', answer: 'API token',
    keywords: [{ text: 'API', via: '加粗' }, { text: 'token', via: '加粗' }] })]
}, { now: '2026-10-30T09:00:00.000Z' });
const synPkg = D.buildSharePackage({ exams: [synExam] }, {});
eq([synPkg.ok, synPkg.scan.hits.length], [true, 0],
   '同义词表里含 API/token 这类词 → **包仍然合格**（那里的键是数据，不是字段名）');
eq(synPkg.payload.exams[0].config.short.synonyms, { API: ['应用程序接口'], token: ['令牌'] }, '  同义词表**逐字段保留**');
const synAnswers = { syn1: '应用程序接口 令牌' };
const synCfgOrig = Q.resolveConfig(null, synExam);
const synCfgShared = Q.resolveConfig(null, synPkg.payload.exams[0]);
const sOrig = Q.scoreExam(synExam.questions, synAnswers, synCfgOrig);
const sShared = Q.scoreExam(synPkg.payload.exams[0].questions.map(function (q) { return S.createQuestion(q); }), synAnswers, synCfgShared);
eq([sShared.score, sOrig.score], [sOrig.score, sOrig.score], '**脱敏前后同义词照样能采分**（分数一致，不是掉到 0）',
   JSON.stringify({ shared: sShared.score, original: sOrig.score, full: sOrig.full }));
eq(sShared.score > 0, true, '  而且确实拿到了分（这条不是"两边都为 0"的假等价）', String(sShared.score));

/* 复合键名：`x-api-key` / `accessToken` / `secretKey` / `clientSecret` 用整名精确匹配一条都拦不住 */
const compound = S.createExam({
  id: 'CP', title: 't',
  config: { points: { '单选': 3 }, 'x-api-key': 'Zx9Pl33r-NotShape-0001', accessToken: 'Zx9Pl33r-NotShape-0002',
            secretKey: 'Zx9Pl33r-NotShape-0003', clientSecret: 'Zx9Pl33r-NotShape-0004', authToken: 'Zx9Pl33r-NotShape-0005' },
  questions: []
}, { now: '2026-10-30T09:00:00.000Z' });
const compoundPayload = D.sanitizeSharePayload({ exams: [compound] }, {});
const compoundTxt = JSON.stringify(compoundPayload);
['x-api-key', 'accessToken', 'secretKey', 'clientSecret', 'authToken'].forEach(function (k) {
  ok(compoundTxt.indexOf(k) < 0, '复合键名「' + k + '」被剔除（切词后按敏感词命中）');
});
eq(compoundTxt.indexOf('Zx9Pl33r-NotShape') < 0, true, '  这些键的**值**也一起没了');
eq(compoundPayload.exams[0].config.points['单选'], 3, '  该留的配置还在（只剔敏感词键）');
eq(D.isForbiddenKey('keywords'), false, '例外：`keywords` 含 "key" 一词但必须保留（判分要用）');
eq(D.isForbiddenKey('record'), false, '例外：`record` 在白名单例外里（README 语义：做题记录单数键名）');
['apiKey', 'API_KEY', 'api-key', 'x-api-key', 'accessToken', 'secretKey', 'clientSecret', 'authorization', 'password']
  .forEach(function (k) { eq(D.isForbiddenKey(k), true, '  isForbiddenKey("' + k + '") = true'); });
eq(D.keyTokens('x-api-key'), ['x', 'api', 'key'], 'keyTokens 能把 kebab-case 切开');
/* 红队第四轮 P3：全角/Unicode 形近键名要能归一（不然宽严两口径都放行） */
eq(D.isForbiddenKey('\uff41\uff50\uff49\uff2b\uff45\uff59', { strict: true }), true,
   '全角 `ａｐｉＫｅｙ` 经 NFKC 归一后命中（不再靠 ASCII 硬匹配）');
const fwExam = S.createExam({ id: 'FW', title: 't', config: { '\uff41\uff50\uff49\uff2b\uff45\uff59': 'Zx9Pl33r-Short-0001' }, questions: [] }, { now: '2026-10-30T09:00:00.000Z' });
eq(JSON.stringify(D.sanitizeSharePayload({ exams: [fwExam] }, {})).indexOf('Zx9Pl33r') < 0, true,
   '  全角键名下的值也被剔掉（连键一起）');

/* 深度超限必须 fail-closed（早先是 `return v`，把整棵子树原样带出 = 反向泄漏） */
let deep = { apiKey: CANARY };
for (let i = 0; i < 40; i++) deep = { nest: deep };
const deepExam = S.createExam({ id: 'DP', title: 't', config: deep, questions: [] }, { now: '2026-10-30T09:00:00.000Z' });
const deepPayload = D.sanitizeSharePayload({ exams: [deepExam] }, {});
eq(JSON.stringify(deepPayload).indexOf(CANARY) < 0, true, '**40 层深的敏感子树被丢弃**（不再 fail-open 带出去）');
eq(D.shareScan(deepPayload, { secrets: [CANARY] }).ok, true, '  深度超限的载荷仍然零命中');
ok(D.STRIP_MAX_DEPTH >= 16, '深度上限本身不低（' + D.STRIP_MAX_DEPTH + ' 层），只为兜住异常输入');

/* 来源机密比对要能抗"分隔符绕过"（长 key 折行是现实场景） */
const srcSecret = 'plain-secret-0123456789';
const obfuscated = 'plain-secret-\n0123456789';
const obExam = S.createExam({ id: 'OB', title: 't', questions: [S.createQuestion({ id: 'ob1', type: '简答', stem: '题干里 ' + obfuscated, keywords: [{ text: 'k' }] })] }, {});
const obScan = D.shareScan(D.sanitizeSharePayload({ exams: [obExam] }, {}), { secrets: [srcSecret] });
eq(obScan.ok, false, '**机密被换行拆成两半也认得出**（比对前先归一空白/零宽字符）', JSON.stringify(obScan.hits));
const zwExam = S.createExam({ id: 'ZW', title: 't', questions: [S.createQuestion({ id: 'zw1', type: '简答', stem: '题干里 plain-secret-\u200B0123456789', keywords: [{ text: 'k' }] })] }, {});
eq(D.shareScan(D.sanitizeSharePayload({ exams: [zwExam] }, {}), { secrets: [srcSecret] }).ok, false, '  零宽空格夹在中间同样认得出');

/* 红队第三轮 P2：输入**已有两个同 id 块**时，必须清掉所有旧块只留一个 ——
 * 只换第一个会把旧载荷（可能含密钥形状）留在文件里，违反"只有一对 script 标签"。 */
const leakStr = 'sk-' + 'A'.repeat(20);
const twoBlocks = '<html><body>'
  + '<script id="exam-payload">{"old":"甲","leak":"' + leakStr + '"}<\/script>'
  + '<script type="application/json" id="exam-payload">{"old":"乙"}<\/script>'
  + '<div id="exam-payload">占位</div>'
  + '\n</body></html>';
const cleaned = D.embedPayload(twoBlocks, nastyPayload, { secrets: [] });
eq(D.payloadBlockCount(cleaned).blocks, 1, '**输入含两个同 id 载荷块 → 输出只剩 1 个**（清掉所有旧块，不是只换第一个）');
eq(D.payloadBlockCount(cleaned).scriptCloses, 1, '  闭合标签也只有 1 个');
ok(cleaned.indexOf('"old"') < 0, '  旧块内容一份都不残留');
ok(cleaned.indexOf(leakStr) < 0, '  旧块里的密钥形状串也没有跟着文件走');
eq((cleaned.match(/exam-payload/g) || []).length, 1, '  全文里 id 只出现一次（不会留下重复 id 的诱饵元素）');
ok(cleaned.indexOf('<div') >= 0, '  非 script 的同 id 诱饵元素**内容保留**（只摘掉它的 id，不毁用户的 DOM）');
eq(D.extractPayload(cleaned).exams.length, 1, '  读回来是新载荷');
eq(D.payloadBlockCount(D.embedPayload(cleaned, nastyPayload, { secrets: [] })).blocks, 1, '  再嵌一次仍然是 1 个（幂等）');
/* 红队第四轮：诱饵在**旧块之前**、诱饵带别的属性、属性值里含 `>` —— 都要照样干净 */
const decoyVariants = [
  ['诱饵在旧块之前', '<html><body><div id="exam-payload">占位</div><script id="exam-payload">{"old":"丙","leak":"' + leakStr + '"}<\/script>\n</body></html>'],
  ['诱饵带 class', '<html><body><div id="exam-payload" class="mount"></div>\n</body></html>'],
  ['属性值里含 >', '<html><body><div data-x="a>b" id="exam-payload">占位</div>\n</body></html>'],
  ['id 无引号', '<html><body><div id=exam-payload>占位</div>\n</body></html>'],
  ['大写 ID 与全角空格', '<html><body><div ID = "EXAM-PAYLOAD">占位</div>\n</body></html>']
];
decoyVariants.forEach(function (v) {
  const out = D.embedPayload(v[1], nastyPayload, { secrets: [] });
  eq(D.payloadBlockCount(out).blocks, 1, '「' + v[0] + '」：输出只有 1 个载荷块');
  eq((out.match(/exam-payload/gi) || []).length, 1, '  全文里 payload id 只出现一次');
  ok(out.indexOf('"old"') < 0 && out.indexOf(leakStr) < 0, '  旧块内容与密钥形状串都没残留');
  ok(!/<div["']/.test(out), '  **诱饵标签没有被拼坏**（早前会变成 `<div">`）');
  eq(D.extractPayload(out).exams.length, 1, '  能正常读回新载荷');
});
/* 逐字节幂等：连续两次内嵌必须**完全相同**（不只是"功能等价"） */
const idemOnce = D.embedPayload('<html><body>\n</body></html>', nastyPayload, { secrets: [] });
const idemTwice = D.embedPayload(idemOnce, nastyPayload, { secrets: [] });
eq(idemTwice === idemOnce, true, '**内嵌是逐字节幂等的**（第二次不多一个换行、内容完全一致）');
/* 自闭合块：HTML 不支持自闭合 script，清不干净就 fail-closed 拒绝 */
let selfClosed = null;
try {
  D.embedPayload('<html><body><script id="exam-payload" type="application/json"/>{"old":1,"leak":"' + leakStr + '"}\n</body></html>',
    nastyPayload, { secrets: [] });
} catch (e) { selfClosed = e; }
eq(selfClosed && selfClosed.code, 'E_SELF_CLOSING_BLOCK',
   '自闭合载荷块 → **拒绝内嵌**（HTML 里它的正文边界不确定，宁可不写也不留下旧内容）');
ok(selfClosed && /手工删掉/.test(selfClosed.message), '  错误信息告诉用户怎么办：' + (selfClosed || {}).message);
/* 红队第五/六轮：清块曾靠"拼写白名单/只补连字符实体"，凡不落进那几种写法的开标签就清不掉也不拒绝。
 * 现在改成**解码 id 后配对删除**：能清掉的（斜杠分隔、实体编码）就清干净，清不掉的（自闭合/未闭合）才拒绝。 */
const unsafeInputs = [
  ['斜杠当分隔符', '<html><body><script/id="exam-payload">{"old":1,"leak":"' + leakStr + '"}<\/script>\n</body></html>'],
  ['实体编码的 id（连字符）', '<html><body><script id="exam&#45;payload">{"old":1,"leak":"' + leakStr + '"}<\/script>\n</body></html>'],
  ['实体编码的 id（字母）', '<html><body><script id="&#101;xam-payload">{"old":1,"leak":"' + leakStr + '"}<\/script>\n</body></html>'],
  ['实体编码的 id（十六进制字母）', '<html><body><script id="&#x65;xam-payload">{"old":1,"leak":"' + leakStr + '"}<\/script>\n</body></html>']
];
unsafeInputs.forEach(function (v) {
  let out = null, err = null;
  try { out = D.embedPayload(v[1], nastyPayload, { secrets: [] }); } catch (e) { err = e; }
  ok(!err && out && D.payloadBlockCount(out).blocks === 1 && out.indexOf(leakStr) < 0,
     '「' + v[0] + '」→ **解码后照样能清干净**（1 个块、旧内容与密钥串零残留）',
     err ? ('被拒 ' + err.code) : ('blocks=' + D.payloadBlockCount(out).blocks));
});
/* 真正清不掉的才拒绝：未闭合、斜杠后有空格（自闭合语义） */
['<html><body><script id="exam-payload">{"old":1,"leak":"' + leakStr + '"}\n</body></html>',
 '<html><body><script id="exam-payload" / >{"old":1,"leak":"' + leakStr + '"}\n</body></html>'].forEach(function (bad) {
  let err = null;
  try { D.embedPayload(bad, nastyPayload, { secrets: [] }); } catch (e) { err = e; }
  ok(!!err && /^E_(UNSAFE_PAYLOAD_BLOCK|SELF_CLOSING_BLOCK)$/.test(err.code),
     '清不掉的写法 → **拒绝内嵌**（' + (err ? err.code : '居然通过了') + '）');
});
/* 反向：正常模板里**提到** payload id（我们自己内联的 data.js 就有 `const PAYLOAD_ID = 'exam-payload'`）
 * 不能被误拒，否则真实页面一个都发不出去。 */
const withIdMention = '<html><body><script>const PAYLOAD_ID = "exam-payload";</script>\n</body></html>';
const okMention = D.embedPayload(withIdMention, nastyPayload, { secrets: [] });
eq(D.payloadBlockCount(okMention).blocks, 1, '模板里只是**提到** id（不是块）→ 正常内嵌，不误拒');

/* 红队第三轮 P3 + 第七轮：`keys` 这种"剥离侧放行、扫描必须抓"的键名，现在**两边都抓** */
eq(D.isForbiddenKey('keys', { strict: true }), true, '严格口径下 `keys` 命中');
eq(D.isForbiddenKey('keys'), true, '**剥离侧也命中**（第七轮把 `keys` 从例外表删掉：放行它没有任何业务理由）');
eq(D.isForbiddenKey('keywords', { strict: true }), false, '  但 `keywords` 在严格口径下也放行（它是载荷自己的字段）');
eq(D.shareScan({ config: { keys: 'x' } }, {}).hits.length, 1, '严格扫描报出 `keys` 键名（两边一致，不再自相矛盾）');
eq(D.shareScan({ config: { record: 'y' } }, {}).hits.length, 1, '  `record` 同样被报出（不再是"扫描说零命中"）');
ok(D.shareScan(D.sanitizeSharePayload({ exams: [EXAM] }, {}), {}).ok, '  而正常载荷（含 keywords）不会被误报');
/* 唯一出厂入口：buildShareHtml 把"生成 + 体检 + 内嵌"焊成一步 */
const oneShot = D.buildShareHtml(appState, '<html><body><div id="app"></div>\n</body></html>', {});
eq([oneShot.ok, typeof oneShot.html], [true, 'string'], 'buildShareHtml：干净 state → 一步拿到可发的 HTML');
eq(D.extractPayload(oneShot.html).exams.length, 1, '  生成的文件里读得回载荷');
eq(D.payloadBlockCount(oneShot.html).blocks, 1, '  而且只有 1 个载荷块');
const oneShotBad = D.buildShareHtml({ exams: [leakyExam] }, '<html></html>', {});
eq([oneShotBad.ok, oneShotBad.html], [false, null], '**脏内容 → ok:false 且 html 为 null**（调用方拿不到可写出的东西）');

/* secretsOfState 的来源覆盖（红队 P3：漏了 schema 定义的 state.secrets） */
const stSec = { exams: [EXAM], secrets: { apiKey: 'plain-secret-0123456789' } };
ok(D.secretsOfState(stSec).indexOf('plain-secret-0123456789') >= 0, 'state.secrets（createAppState 的官方形状）也被收进机密集合');
eq(D.secretsOfState({ secrets: { apiKey: 'short' } }), [], '过短的串不进集合（<8 字符，误报远多于收益；已知缺口已注明）');

/* ============================================================
 *  红队第七轮（五处判据漏洞）逐条钉住 —— 每条都配 probe-share-payload-old.js 的反向对照
 * ============================================================ */

head('⑦-A 无分号的数字引用：**浏览器照样解码**，解析器必须跟着（红队第七轮 P1）');

/* 真浏览器实测：`id="exa&#109-payload"` 在 DOM 里就是 `exam-payload`（`-` 不阻止解码）。
 * 第一版解码器要求分号 → 旧块清不掉、扫描认为文件里"没有载荷块"，于是同 id 元素变两个。 */
const noSemiBlock = '<html><body><script id="exa&#109-payload" type="application/json">{"old":"乙","leak":"' + leakStr + '"}<\/script>\n</body></html>';
eq(D.payloadBlockCount(noSemiBlock).blocks, 1, '无分号数字引用的 id 也算**自己的块**（解码后认得出）');
const cleanedNoSemi = D.embedPayload(noSemiBlock, nastyPayload, { secrets: [] });
eq(D.payloadBlockCount(cleanedNoSemi).blocks, 1, '  内嵌后仍然只有 1 个块（不是"旧块+新块"两个）');
eq(D.payloadBlockCount(cleanedNoSemi).scriptCloses, 1, '  闭合标签也只有 1 个');
ok(cleanedNoSemi.indexOf('"乙"') < 0 && cleanedNoSemi.indexOf(leakStr) < 0, '  旧块内容与密钥串零残留');
/* 反向锚：按 HTML 规范，无分号数字引用**后面紧跟 ASCII 字母数字或 `=` 时不解码** —— 这种情况不认作我们的块 */
const notDecoded = '<html><body><script id="exa&#109x-payload">var keepJS = 1;<\/script>\n</body></html>';
eq(D.payloadBlockCount(notDecoded).blocks, 0, '`&#109x`（后面紧跟字母）按规范**不解码** → 不认作我们的块（不误清）');
const keptNotDecoded = D.embedPayload(notDecoded, nastyPayload, { secrets: [] });
ok(keptNotDecoded.indexOf('var keepJS = 1;') >= 0, '  那段脚本原样保留（没有把别人的脚本当旧载荷删掉）');
eq(D.payloadBlockCount(keptNotDecoded).blocks, 1, '  我们自己的块正常插入');

head('⑦-B 注释里的"载荷块痕迹"：**拒绝内嵌**，不许拿它去配对外面的 `</script>`（红队第七轮 P2）');

/* 反例原形：注释里一个"只有开标签"的载荷块，会跟注释**外面**的 `</script>` 配成对，
 * 于是把模板自己的 JS 整段删掉、还把新载荷写进注释里（旧实现的真实后果）。 */
const commentTrap = '<html><body><script>var keepJS = 1;<\/script>\n<!-- <script id="' + D.PAYLOAD_ID + '"> -->\n</body></html>';
eq(D.payloadBlockCount(commentTrap).blocks, 0, '注释内的开标签**不参与配对**（注释被等长掩码）→ 定位器认为 0 个块');
let cErr = null;
try { D.embedPayload(commentTrap, nastyPayload, { secrets: [] }); } catch (e) { cErr = e; }
eq(cErr && cErr.code, 'E_UNSAFE_PAYLOAD_BLOCK', '  → **拒绝内嵌**（宁可不写，也不删用户模板的 JS）');
ok(cErr && /注释内/.test(cErr.message), '  错误信息点明是"注释内"：' + String(cErr && cErr.message).slice(0, 80));
const commentFull = '<html><body><!-- <script id="' + D.PAYLOAD_ID + '">{"old":1}<\/script> --><script>var a=1;<\/script>\n</body></html>';
let cErr2 = null;
try { D.embedPayload(commentFull, nastyPayload, { secrets: [] }); } catch (e) { cErr2 = e; }
eq(cErr2 && cErr2.code, 'E_UNSAFE_PAYLOAD_BLOCK', '  注释里是**完整**载荷块也一样拒绝（清不干净就不落盘）');
/* 反向锚：没有注释痕迹时，模板自己的脚本必须**一个字节都不动** */
const noCommentTrap = '<html><body><script>var keepJS = 1;<\/script>\n</body></html>';
const noCommentOut = D.embedPayload(noCommentTrap, nastyPayload, { secrets: [] });
ok(noCommentOut.indexOf('var keepJS = 1;') >= 0, '  没有注释痕迹时，模板 JS 原样保留（不是"一律拒绝/一律删"）');
eq(D.payloadBlockCount(noCommentOut).blocks, 1, '  并且载荷只有 1 个块');
/* 未闭合注释：浏览器把后面**全部**当注释 → 载荷会被吞掉，边界不可信 */
const unclosedTrap = '<html><body><!-- 忘了收尾\n<script id="' + D.PAYLOAD_ID + '">{"old":1}<\/script>\n</body></html>';
let uErr = null;
try { D.embedPayload(unclosedTrap, nastyPayload, { secrets: [] }); } catch (e) { uErr = e; }
eq(uErr && uErr.code, 'E_UNSAFE_PAYLOAD_BLOCK', '未闭合注释（`<!--` 没有 `-->`）→ **也拒绝**（浏览器会把后面全当注释）');
ok(uErr && /未闭合/.test(String(uErr.message)), '  错误信息点明"未闭合"：' + String(uErr && uErr.message).slice(0, 60));
let uErr2 = null;
try { D.embedPayload('<html><body><!-- 忘了收尾\n<div id="app"></div>\n</body></html>', nastyPayload, { secrets: [] }); } catch (e) { uErr2 = e; }
eq(uErr2 && uErr2.code, 'E_UNSAFE_PAYLOAD_BLOCK', '  注释里**没有**载荷痕迹也拒绝（否则载荷会被注释吞掉、浏览器读不到）');
/* 相邻锚：5 个真实模板是内嵌的目标，必须逐字节经得起"嵌入 → 计数 → 再嵌入" */
const ARTIFACTS = ['解析器Demo.html', '浏览器自检.html', '校对面板.html', '答题页.html', '错题本.html'];
ARTIFACTS.forEach(function (name) {
  const htmlPath = pathMod.join(__dirname, '..', name);
  if (!fsMod.existsSync(htmlPath)) { ok(false, '  模板存在：' + name); return; }
  const raw = fsMod.readFileSync(htmlPath, 'utf8');
  eq(D.payloadBlockCount(raw).blocks, 0, '「' + name + '」干净模板里**本来没有**载荷块');
  const once = D.embedPayload(raw, nastyPayload, { secrets: [] });
  eq(D.payloadBlockCount(once).blocks, 1, '  嵌入后恰好 1 个块（真实模板里的 $ 序列/脚本不会把块拆坏）');
  eq(D.embedPayload(once, nastyPayload, { secrets: [] }) === once, true, '  再嵌一次**逐字节相同**（幂等）');
  eq(D.extractPayload(once).exams.length, nastyPayload.exams.length, '  从真实模板里读得回完整载荷');
  const mentions = (raw.match(/exam-payload/g) || []).length;
  eq((once.match(/exam-payload/g) || []).length, mentions + 1,
     '  全文里 payload id 的出现次数 = 模板里原有的提及次数(' + mentions + ') + 1（只多出一个块，不多不少）');
});

head('⑦-C 对象**键名**也是文本：写进同义词表的键名一样要抓（红队第七轮 P3）');

/* 旧实现只扫"值"，于是把密钥写进**键名**（同义词表的键是用户写的关键词文本）完全隐形，扫描还报零命中。 */
const keyLeakExam = S.createExam({
  id: 'KL', title: 't',
  config: { short: { synonyms: { [leakStr]: ['应用程序接口'] }, matchMode: 'contains' }, points: { '简答': 5 } }, questions: []
}, { now: '2026-10-30T09:00:00.000Z' });
const keyLeakScan = D.shareScan(D.sanitizeSharePayload({ exams: [keyLeakExam] }, {}), {});
eq(keyLeakScan.ok, false, '密钥串写进**同义词表的键名** → 扫描报命中（旧实现报零命中）', JSON.stringify(keyLeakScan.hits));
ok(keyLeakScan.hits.some(function (h) { return /键名/.test(h.why); }), '  命中原因明确写着"键名"（不是含糊的"出现密钥"）');
const keyLeakPkg = D.buildSharePackage({ exams: [keyLeakExam] }, {});
eq([keyLeakPkg.ok, keyLeakPkg.scan.hits.length > 0], [false, true], '  出厂入口同样拦住（ok:false，调用方拿不到可写出的东西）');
const srcKeyScan = D.shareScan({ exams: [{ config: { short: { synonyms: { 'plain-secret-0123456789': ['x'] } } } }] }, { secrets: [srcSecret] });
eq(srcKeyScan.ok, false, '  来源机密（靠**串味比对**、不是靠形状）写进键名同样抓得到', JSON.stringify(srcKeyScan.hits));
/* 相邻锚：键名扫描不能把"用户写的普通关键词"判成敏感（否则第 ①-G 节的同义词表会被误杀） */
const plainKeyScan = D.shareScan({ exams: [{ config: { short: { synonyms: { API: ['应用程序接口'], token: ['令牌'] } }, points: { '简答': 5 } } }] }, { secrets: [CANARY] });
eq([plainKeyScan.ok, plainKeyScan.hits.length], [true, 0], '  普通关键词当键名 → **零命中**（只有形状/串味才报，不按词表判"键名语义"）');

head('⑦-D 敏感词表补齐：裸 `key` 与复数/凭证同义词（红队第七轮 P4）');

['myKey', 'some_key_thing', 'key1', 'tokens', 'secrets', 'cookie', 'cookies', 'privatekey', 'privateKey', 'accesskey', 'accessKey', 'secretKey']
  .forEach(function (k) { eq(D.isForbiddenKey(k), true, '  isForbiddenKey("' + k + '") = true'); });
eq(D.isForbiddenKey('keys'), true, '**`keys` 两边都抓**（第七轮从剥离侧例外表里删掉）');
eq(D.isForbiddenKey('keywords'), false, '  例外仍在：`keywords`（载荷自己的字段，判分要用）');
eq(D.isForbiddenKey('keywords', { strict: true }), false, '  例外仍在：`keywords` 严格口径也放行');
eq(D.isForbiddenKey('keypoints'), false, '  例外仍在：`keypoints`（业务键名）');
eq(D.isForbiddenKey('keyPoints'), false, '  `keyPoints`（驼峰变体）靠例外表兜住，不被裸 `key` 误杀');
const keysExam = S.createExam({ id: 'KS', title: 't', config: { points: { '单选': 3 }, keys: 'Zx9Pl33r-KeyBag-0001' }, questions: [] }, { now: '2026-10-30T09:00:00.000Z' });
const keysTxt = JSON.stringify(D.sanitizeSharePayload({ exams: [keysExam] }, {}));
ok(keysTxt.indexOf('"keys"') < 0 && keysTxt.indexOf('Zx9Pl33r') < 0, '  剥离侧**连键带值**一起剔（不再"键名还在、扫描却说零命中"）');
eq(JSON.parse(keysTxt).exams[0].config.points['单选'], 3, '  该留的配置还在（剔的是敏感词键，不是整个 config）');

head('⑦-E 只有**一套**载荷块判据（红队第七轮 P5：删掉第二套与历史包袱）');

const dataSrc = fsMod.readFileSync(pathMod.join(__dirname, '..', 'core', 'data.js'), 'utf8');
[['function allPayloadBlocksRe', /function\s+allPayloadBlocksRe\s*\(/],
 ['function payloadBlockRe', /function\s+payloadBlockRe\s*\(/],
 ['const KEY_PATTERN', /(?:const|let|var)\s+KEY_PATTERN\b/],
 ['const CONTENT_GROUP', /(?:const|let|var)\s+CONTENT_GROUP\b/],
 ['const ID_ATTR', /(?:const|let|var)\s+ID_ATTR\b/]]
  .forEach(function (p) { ok(!p[1].test(dataSrc), '  源码里不再有 `' + p[0] + '`（第二套判据/历史包袱已清）'); });
ok(/function\s+findPayloadBlocks\s*\(/.test(dataSrc), '  只有 `findPayloadBlocks` 这一个定位器（清理/读回/计数/残留自检都调它）');
/* data.js 会被内联进成品的 `<script>`：源码里出现注释开符的原始四字符形态，浏览器会切进 escaped →
 * 再遇到字符串里的 `<script` 就 double-escaped，真正的 `</script>` 失效、整页散架（inline-order 也钉这条）。 */
ok(dataSrc.indexOf('<' + '!--') < 0, '  源码里没有注释开符的四字符原始形态（会被内联进 script，触发 double-escaped 陷阱）');

head('⑦-F 断在半截的开标签：定位器看不见它 → 单独 fail-closed（自查补的同一类口子）');

/* 「清不掉就拒绝」这条原则要覆盖**所有**写法。断在半截的开标签有两种：
 *   ① 后面还有 `>`（被正则贪婪吞掉）→ 定位器看得见，走 `complete=false` 那条拒绝；
 *   ② 一直到**文件尾**都没有 `>` → 正则匹配不上，定位器**根本看不见它**（计数说 0 个）→ 必须单独查。 */
const midTrunc = '<html><body><script id="exam-payload" type="application/json"{"old":1,"leak":"' + leakStr + '"}<\/script>\n</body></html>';
eq(D.payloadBlockCount(midTrunc).blocks, 1, '「后面还有 >」的断标签：定位器看得见（blocks=1，但 complete=0）');
eq(D.payloadBlockCount(midTrunc).complete, 0, '  它被标成"没有收尾标签"');
let mErr = null;
try { D.embedPayload(midTrunc, nastyPayload, { secrets: [] }); } catch (e) { mErr = e; }
eq(mErr && mErr.code, 'E_UNSAFE_PAYLOAD_BLOCK', '  → 走"没有收尾标签"那条拒绝（旧行为，没变）');
const eofTrunc = '<html><body><script id="exam-payload" type="application/json"';
eq(D.payloadBlockCount(eofTrunc).blocks, 0, '**到文件尾都没有 `>`** 的断标签：定位器看不见它（blocks=0）');
let eErr = null;
try { D.embedPayload(eofTrunc, nastyPayload, { secrets: [] }); } catch (e) { eErr = e; }
eq(eErr && eErr.code, 'E_UNSAFE_PAYLOAD_BLOCK', '  → 单独那道检查拦下（不给"半截标签 + 新块"的文件）');
ok(eErr && /没有收尾/.test(String(eErr.message)), '  报错点名"没有收尾 `>`"：' + String(eErr && eErr.message).slice(0, 46));
/* 反向锚：无关标签、属性值里的 `>` 都不能被误判成"未闭合"（否则真实模板会被误拒） */
eq(D.payloadBlockCount(D.embedPayload('<html><body><br><div id="app"></div>\n</body></html>', nastyPayload, { secrets: [] })).blocks, 1,
   '  无关标签不受影响（不误拒）');
eq(D.payloadBlockCount(D.embedPayload('<html><body><script data-note="a>b"></script>\n</body></html>', nastyPayload, { secrets: [] })).blocks, 1,
   '  属性值里的 `>` 不算标签收尾（`data-note="a>b"` 不误判成未闭合）');
/* 判据一致性的行为锚：计数、读回、清理三者对**同一个刁钻输入**必须说同一种话 */
const trickyId = '<html><body><script id="&#101;xam-payl&#111;ad" type="application/json">{"old":"丁"}</script>\n</body></html>';
eq([D.payloadBlockCount(trickyId).blocks, D.extractPayload(trickyId) ? D.extractPayload(trickyId).old : null], [1, '丁'],
   '计数=1 且读回拿到旧内容（两套判据并存时会"计数说 1 个、读回说没有载荷"）');

console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
console.log('  PASS ' + pass + '    FAIL ' + fail);
if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
console.log('  \x1b[90m注：本小类 verify=redteam —— 独立红队裁决记录见 docs/verification-log.md 第二十八章\x1b[0m');
process.exitCode = fail ? 1 : 0;
