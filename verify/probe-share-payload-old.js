/* 脱敏打包 · 反向探针（**非空转证明器**，按需手动跑）
 * 运行： node verify/probe-share-payload-old.js
 * 每行必须打印 "锚变红=true"；出现 false 说明那条断言在测空气。
 */
const fs = require('fs');
const path = require('path');
const HERE = path.join(__dirname, '..');
function loadFrom(rel, mutate, tmpRel) {
  const src = fs.readFileSync(path.join(HERE, rel), 'utf8');
  const out = mutate(src);
  if (out === src) throw new Error('探针失效：没替换到目标文本（' + rel + '）');
  const tmp = path.join(HERE, tmpRel);
  fs.writeFileSync(tmp, out);
  delete require.cache[require.resolve(tmp)];
  return require(tmp);
}
function rm(rel) { try { fs.unlinkSync(path.join(HERE, rel)); } catch (e) { /* ignore */ } }

const S = require('../core/schema.js');
const CANARY = 'sk-canary-9f3a7c1e5b2d4680zz';
const EXAM = S.createExam({ id: 'P1', title: '探针卷', questions: [
  S.createQuestion({ id: 'p1', type: '简答', stem: '题干含 </script> 结尾', answer: 'a', keywords: [{ text: 'k1', via: '加粗' }, { text: 'k2', via: '高亮' }] })
] }, { now: '2026-10-31T00:00:00.000Z' });

const results = [];
function probe(name, fn) {
  let red = false, note = '';
  try { const r = fn(); red = (r === true); if (typeof r === 'string') note = r; else if (r !== true) note = JSON.stringify(r); }
  catch (e) { red = '抛错:' + (e && e.message); }
  results.push([name, red]);
  console.log((red === true ? '  OK  ' : '  ??  ') + name + '   锚变红=' + red + (note ? '   ' + note : ''));
}

/* ---- 1. 白名单退化成"带上整个对象"（敏感字段跟着走） ---- */
probe('① 白名单不管用（整对象带走）→ ①-B「字段对齐」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace('        out.questions = qs.filter(function (q) { return q && typeof q === \'object\'; }).map(function (q) {',
                   '        out.apiKey = e.apiKey;\n        out.questions = qs.map(function (q) {'),
    'core/__probe_sh1.js');
  try {
    const p = D.sanitizeSharePayload({ exams: [Object.assign({}, EXAM, { apiKey: CANARY })] }, {});
    return (JSON.stringify(p).indexOf(CANARY) >= 0) ? true : '竟然没带出去';
  } finally { rm('core/__probe_sh1.js'); }
});

/* ---- 2. 敏感字段"置空"而不是"移除"（键名还在） ---- */
probe('② 敏感字段置空而非移除 → ①-A「连键都不出现」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace("      kind: 'quiz-share', schemaVersion: 1,", "      kind: 'quiz-share', schemaVersion: 1, settings: null, records: null, wrongBook: null,"),
    'core/__probe_sh2.js');
  try {
    const p = D.sanitizeSharePayload({ exams: [EXAM] }, {});
    const sc = D.shareScan(p, {});
    /* 键名出现即算泄漏（哪怕值是 null） */
    return sc.ok === false ? true : '居然还是零命中：' + JSON.stringify(Object.keys(p));
  } finally { rm('core/__probe_sh2.js'); }
});

/* ---- 3. shareScan 恒真（什么都不扫） ---- */
probe('③ shareScan 恒真 → ①-C「题干粘 Key 会报红」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace("    walk(payload, '$');", '    /* walk 被拆掉 */'),
    'core/__probe_sh3.js');
  try {
    const leaky = S.createExam({ id: 'L', title: 't', questions: [S.createQuestion({ id: 'l1', type: '简答', stem: '粘了 ' + CANARY, keywords: [{ text: 'x' }] })] }, {});
    const sc = D.shareScan(D.sanitizeSharePayload({ exams: [leaky] }, {}), { secrets: [CANARY] });
    return sc.ok === true ? true : '居然报红了';
  } finally { rm('core/__probe_sh3.js'); }
});

/* ---- 4. 只认 sk- 形状（别家密钥形状漏网） ---- */
probe('④ 只认 sk- 一种形状 → ①-C「八种形状都认得」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace("    { name: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ }\n  ];",
                   "    { name: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ }\n  ].slice(0, 1);"),
    'core/__probe_sh4.js');
  try {
    const shapes = D.SECRET_SHAPES.length;
    const hit = D.secretShapesIn('ghp_' + 'b'.repeat(24)).length;   // GitHub 令牌
    return (shapes === 1 && hit === 0) ? true : 'shapes=' + shapes + ' github命中=' + hit;
  } finally { rm('core/__probe_sh4.js'); }
});

/* ---- 5. 内嵌不转义 `<`（题面里的 </script> 会截断文件） ---- */
probe('⑤ 内嵌不转义 `<` → ②-A/②-B 锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace("    const json = JSON.stringify(payload)\n      .replace(/</g, '\\\\u003c')\n      .replace(/\\u2028/g, '\\\\u2028')\n      .replace(/\\u2029/g, '\\\\u2029');",
                   '    const json = JSON.stringify(payload);'),
    'core/__probe_sh5.js');
  try {
    const p = D.sanitizeSharePayload({ exams: [EXAM] }, {});       // EXAM 的题面里就有 </script>
    const file = D.embedPayload('<html><body>\n</body></html>', p, { allowUnsafe: true });
    const back = D.extractPayload(file);
    const stemOk = !!(back && back.exams[0].questions[0].stem === EXAM.questions[0].stem);
    /* 转义没了 → 题面里的 `</script>` 会**多出一个闭合标签**并截断载荷块 */
    const closes = (file.match(/<\/script/gi) || []).length;
    return (!stemOk || closes !== 1) ? true : '转义没了却还读得回来';
  } finally { rm('core/__probe_sh5.js'); }
});

/* ---- 6. 重复内嵌叠加（结构被破坏：两个 payload 块） ---- */
probe('⑥ 不清旧块就插入 → ②-A「幂等替换」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace('    for (let guard = 0; guard < 64; guard++) {\n      const hit = findPayloadBlocks(src2)[0];',
                   '    for (let guard = 0; guard < 0; guard++) {\n      const hit = findPayloadBlocks(src2)[0];'),
    'core/__probe_sh6.js');
  try {
    const p = D.sanitizeSharePayload({ exams: [EXAM] }, {});
    const once = D.embedPayload('<html><body>\n</body></html>', p, { allowUnsafe: true });
    let twice = null, threw = false;
    try { twice = D.embedPayload(once, p, { allowUnsafe: true }); } catch (e) { threw = true; }
    return (threw || (twice && D.payloadBlockCount(twice).blocks > 1)) ? true : '仍然只有 1 个块且没报错';
  } finally { rm('core/__probe_sh6.js'); }
});

/* ---- 7. 丢掉简答关键词（判分就没依据了） ---- */
probe('⑦ 白名单漏掉 keywords → ③-A「关键词数一致」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace("            if (k === 'keywords') { oq.keywords = q.keywords ? stripForbidden(deepClone(q.keywords)) : null; return; }",
                   "            if (k === 'keywords') { oq.keywords = null; return; }"),
    'core/__probe_sh7.js');
  try {
    const p = D.sanitizeSharePayload({ exams: [EXAM] }, {});
    const kw = p.exams[0].questions[0].keywords;
    return (!kw || kw.length !== 2) ? true : '关键词竟然还在：' + JSON.stringify(kw);
  } finally { rm('core/__probe_sh7.js'); }
});

/* ---- 8. 来源机密不做值级比对（换个键名照样带走） ----
 * ⚠ 这条探针原先写成了**恒真**（红队抓的）：表达式 `(sc.ok === false || sc2.ok === true)` 里
 *   `sc` 用的是 sk- 形状的 Key，**形状扫描**本来就会命中，跟"值级比对"无关 → 删掉它照样 true。
 *   现在只认 sc2：一个**不是任何已知形状**的明文机密，只有值级比对才能抓到。 */
probe('⑧ 不做来源机密比对 → ①-A「来源机密值级比对」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace('    const secrets = (o.secrets || []).map(function (s, i) { return { s: normalizeSecret(s), i: i }; });',
                   '    const secrets = [];'),
    'core/__probe_sh8.js');
  try {
    const secret = 'plain-secret-0123456789';      // 不是 sk-/ghp_/JWT…任何已知形状
    const exam = S.createExam({ id: 'L3', title: 't',
      questions: [S.createQuestion({ id: 'l3', type: '简答', stem: '题干里粘了 ' + secret, keywords: [{ text: 'x' }] })] }, {});
    const sc2 = D.shareScan(D.sanitizeSharePayload({ exams: [exam] }, {}), { secrets: [secret] });
    return sc2.ok === true ? true : '竟然还是报红了：' + JSON.stringify(sc2.hits);
  } finally { rm('core/__probe_sh8.js'); }
});

/* ---- 9. 用 `String.replace(needle, tag)` 直接插 tag（`$&`/`$\`` 会被当替换模式展开） ---- */
probe('⑨ 内嵌改回字符串式替换 → ②-B「美元替换模式往返无损」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace("    const at = src2.lastIndexOf('</body>');\n    if (at >= 0) return src2.slice(0, at) + tag + '\\n' + src2.slice(at);",
                   "    if (src2.indexOf('</body>') >= 0) return src2.replace('</body>', tag + '\\n</body>');"),
    'core/__probe_sh9.js');
  try {
    const exam = S.createExam({ id: 'D9', title: 't', questions: [S.createQuestion({ id: 'd9', type: '简答', stem: '求 $$x^2$$ 的导数', keywords: [{ text: 'k' }] })] }, {});
    const f = D.embedPayload('<html><body>\n</body></html>', D.sanitizeSharePayload({ exams: [exam] }, {}), { allowUnsafe: true });
    const back = D.extractPayload(f);
    return (back && back.exams[0].questions[0].stem !== '求 $$x^2$$ 的导数') ? true : '居然还是无损的：' + (back && back.exams[0].questions[0].stem);
  } finally { rm('core/__probe_sh9.js'); }
});

/* ---- 10. 容器不递归剔除（塞进 config/options 的敏感键被整对象带走） ---- */
probe('⑩ 容器不递归剔除 → ①-D「嵌套敏感键」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace("            const cloned = (v && typeof v === 'object') ? deepClone(v) : null;\n            const cfg = cloned ? stripForbidden(cloned) : null;",
                   "            const cloned = (v && typeof v === 'object') ? deepClone(v) : null;\n            const cfg = cloned;")
          .replace("            if (k === 'options') { oq.options = q.options ? stripForbidden(deepClone(q.options)) : null; return; }",
                   "            if (k === 'options') { oq.options = q.options ? deepClone(q.options) : null; return; }")
          .replace("            if (k === 'keywords') { oq.keywords = q.keywords ? stripForbidden(deepClone(q.keywords)) : null; return; }",
                   "            if (k === 'keywords') { oq.keywords = q.keywords ? deepClone(q.keywords) : null; return; }"),
    'core/__probe_sh10.js');
  try {
    const exam = S.createExam({ id: 'D10', title: 't', config: { points: { '单选': 3 }, apiKey: CANARY },
      questions: [S.createQuestion({ id: 'd10', type: '单选', stem: 's', options: [{ label: 'A', text: 'a', token: CANARY }, { label: 'B', text: 'b' }], answerLetters: ['A'], answer: 'A' })] }, {});
    const p = D.sanitizeSharePayload({ exams: [exam] }, {});
    return JSON.stringify(p).indexOf(CANARY) >= 0 ? true : '居然还是干净的';
  } finally { rm('core/__probe_sh10.js'); }
});

/* ---- 11. 已有块识别依赖属性顺序（会插出第二个块、读回旧数据） ---- */
probe('⑪ 已有块识别退回"只看字面拼写" → ②-A「属性顺序」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace("    const m = String(tagText).match(/\\bid\\s*=\\s*([\"\\']?)([^\"\\'>\\s]*)\\1/i);\n    return m ? decodeCharRefs(m[2]) : '';",
                   "    return /<script id=\"exam-payload\"/i.test(String(tagText)) ? PAYLOAD_ID : '';"),
    'core/__probe_sh11.js');
  try {
    const exam = S.createExam({ id: 'D11', title: 't', questions: [S.createQuestion({ id: 'd11', type: '简答', stem: 's', keywords: [{ text: 'k' }] })] }, {});
    const p = D.sanitizeSharePayload({ exams: [exam] }, {});
    const alt = '<html><body><script type="application/json" id="exam-payload">{"old":1}<\/script>\n</body></html>';
    let out = null, threw = false;
    try { out = D.embedPayload(alt, p, { allowUnsafe: true }); } catch (e) { threw = true; }
    /* 退回"只看字面拼写"后：属性顺序不同的旧块识别不了 → 要么插出两块，要么被残留自检拦下 */
    return (threw || !out || D.payloadBlockCount(out).blocks > 1 || out.indexOf('"old"') >= 0) ? true
      : '居然还是 1 个块且没报错';
  } finally { rm('core/__probe_sh11.js'); }
});

/* ---- 12. 出厂闸门被拆（不干净的载荷照样内嵌） ---- */
probe('⑫ embedPayload 不做出厂扫描 → ②-A「拒绝内嵌」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace('    if (o.allowUnsafe !== true) {\n      const sc = shareScan', '    if (false) {\n      const sc = shareScan'),
    'core/__probe_sh12.js');
  try {
    const exam = S.createExam({ id: 'D12', title: 't', questions: [S.createQuestion({ id: 'd12', type: '简答', stem: '粘了 ' + CANARY, keywords: [{ text: 'k' }] })] }, {});
    const out = D.embedPayload('<html></html>', D.sanitizeSharePayload({ exams: [exam] }, {}), { secrets: [CANARY] });
    return (typeof out === 'string' && out.indexOf('exam-payload') >= 0) ? true : '居然还是拒了';
  } finally { rm('core/__probe_sh12.js'); }
});

/* ---- 13. 载荷与原 state 共享引用（改载荷穿回原卷） ----
 * ⚠ 只拆 deepClone 是**不够**的：`stripForbidden` 本身就是逐层重建新对象，
 *   天然不会共享引用。真正会引入别名的是"没剔到东西就把原对象返回"这种**优化**写法 ——
 *   探针要模拟的就是它。 */
probe('⑬ 容器复用原对象（"没剔到就返回原对象"式优化）→ ①-E「不共享引用」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace('      out[k] = stripForbidden(v[k], d + 1);\n    });\n    return out;',
                   '      out[k] = stripForbidden(v[k], d + 1);\n    });\n    return (Object.keys(out).length === Object.keys(v).length) ? v : out;')
          .replace("            const cloned = (v && typeof v === 'object') ? deepClone(v) : null;\n            const cfg = cloned ? stripForbidden(cloned) : null;",
                   "            const cloned = (v && typeof v === 'object') ? v : null;\n            const cfg = cloned ? stripForbidden(cloned) : null;"),
    'core/__probe_sh13.js');
  try {
    const exam = S.createExam({ id: 'D13', title: 't', config: { points: { '单选': 3 } }, questions: [] }, {});
    const p = D.sanitizeSharePayload({ exams: [exam] }, {});
    p.exams[0].config.points['单选'] = 999;
    return exam.config.points['单选'] === 999 ? true : '居然没串回原卷';
  } finally { rm('core/__probe_sh13.js'); }
});

/* ---- 14. 只认数组形状的 exams（喂契约里的映射就崩） ---- */
probe('⑭ exams 只认数组 → ①-F「AppState 映射形状」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace('    if (Array.isArray(e)) return e.filter(function (x) { return x && typeof x === \'object\'; });\n    if (e && typeof e === \'object\') {\n      return Object.keys(e).map(function (k) { return e[k]; }).filter(function (x) { return x && typeof x === \'object\'; });\n    }\n    return [];',
                   '    return Array.isArray(e) ? e.filter(function (x) { return x && typeof x === \'object\'; }) : [];'),
    'core/__probe_sh14.js');
  try {
    const st = S.createAppState();
    st.exams['M1'] = S.createExam({ id: 'M1', title: '映射卷', questions: [] }, {});
    const p = D.sanitizeSharePayload(st, {});
    return p.exams.length === 0 ? true : '映射形状居然读到了 ' + p.exams.length + ' 套卷';
  } finally { rm('core/__probe_sh14.js'); }
});

/* ---- 15. 复合敏感键名（切词判定被拆掉） ---- */
probe('⑮ 不做切词判定 → ①-F「复合键名」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace('    const toks = keyTokens(k);\n    return toks.some(function (t) { return FORBIDDEN_WORDS.indexOf(t) >= 0; });', '    return false;'),
    'core/__probe_sh15.js');
  try {
    const exam = S.createExam({ id: 'C1', title: 't', config: { points: { '单选': 3 }, 'x-api-key': 'Zx9Pl33r-NotShape-0001' }, questions: [] }, {});
    const p = D.sanitizeSharePayload({ exams: [exam] }, {});
    return JSON.stringify(p).indexOf('x-api-key') >= 0 ? true : '居然还是剔掉了';
  } finally { rm('core/__probe_sh15.js'); }
});

/* ---- 16. 缺 secrets 不再 fail-closed（两参流水线绕过来源机密比对） ---- */
probe('⑯ 缺 secrets 也放行 → ②-A「E_NEED_SECRETS」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace("    if (o.allowUnsafe !== true && o.secrets === undefined) {", '    if (false) {'),
    'core/__probe_sh16.js');
  try {
    const p = D.sanitizeSharePayload({ exams: [EXAM] }, {});
    const out = D.embedPayload('<html></html>', p);      // 不给 secrets
    return (typeof out === 'string') ? true : '居然还是拒了';
  } finally { rm('core/__probe_sh16.js'); }
});

/* ---- 17. 插入点取第一个 </body>（模板 JS 里有 "</body>" 字符串就插错位置、打断页面 JS） ---- */
probe('⑰ 插入点取第一个 </body> → ②-A「模板 JS 仍能编译」锚变红', function () {
  const vm = require('vm');
  const D = loadFrom('core/data.js',
    s => s.replace("    const at = src2.lastIndexOf('</body>');", "    const at = src2.indexOf('</body>');"),
    'core/__probe_sh17.js');
  try {
    const tpl = '<html><body><script>var tail = "</body>";</script>\n</body></html>';
    const p = D.sanitizeSharePayload({ exams: [EXAM] }, {});
    const out = D.embedPayload(tpl, p, { allowUnsafe: true });
    /* 与验收里那条同口径：模板自己的第一个 script 块必须仍能编译 */
    const m = String(out).match(/<script(?![^>]*exam-payload)[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return '模板 script 段找不到了';
    try { new vm.Script(m[1]); return '模板 JS 居然还能编译'; }
    catch (e) { return true; }        // 编译不过 → 锚红
  } finally { rm('core/__probe_sh17.js'); }
});

/* ---- 18. 深度超限 fail-open（把整棵子树原样带出） ---- */
probe('⑱ 超深子树原样带出 → ①-F「40 层」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace('    if (d >= STRIP_MAX_DEPTH) return null;                       // fail-closed：超深直接丢', '    if (d >= STRIP_MAX_DEPTH) return v;'),
    'core/__probe_sh18.js');
  try {
    let deep = { apiKey: CANARY };
    for (let i = 0; i < 40; i++) deep = { nest: deep };
    const exam = S.createExam({ id: 'D18', title: 't', config: deep, questions: [] }, {});
    const p = D.sanitizeSharePayload({ exams: [exam] }, {});
    return JSON.stringify(p).indexOf(CANARY) >= 0 ? true : '居然还是丢掉了';
  } finally { rm('core/__probe_sh18.js'); }
});

/* ---- 19. 来源机密比对不做归一（中间插换行就绕过） ---- */
probe('⑲ 值级比对不做归一 → ①-F「分隔符绕过」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace("      const nv = normalizeSecret(tv);", '      const nv = String(tv);'),
    'core/__probe_sh19.js');
  try {
    const secret = 'plain-secret-0123456789';
    const exam = S.createExam({ id: 'D19', title: 't', questions: [S.createQuestion({ id: 'x1', type: '简答', stem: '题干里 plain-secret-\n0123456789', keywords: [{ text: 'k' }] })] }, {});
    const sc = D.shareScan(D.sanitizeSharePayload({ exams: [exam] }, {}), { secrets: [secret] });
    return sc.ok === true ? true : '居然还是报红了';
  } finally { rm('core/__probe_sh19.js'); }
});

/* ---- 20. 只替换第一个旧块（输入含两个同 id 块时）
 *   红队第三轮的真反例：旧块里的密钥形状串会跟着文件一起发出去。 ---- */
probe('⑳ 只清第一个旧块 → ②-A「输入含两块 → 输出只剩 1 个」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace('    for (let guard = 0; guard < 64; guard++) {\n      const hit = findPayloadBlocks(src2)[0];',
                   '    for (let guard = 0; guard < 1; guard++) {\n      const hit = findPayloadBlocks(src2)[0];'),
    'core/__probe_sh20.js');
  try {
    const leak = 'sk-' + 'A'.repeat(20);
    const two = '<html><body><script id="exam-payload">{"old":1,"leak":"' + leak + '"}<\/script>'
      + '<script id="exam-payload">{"old":2}<\/script>\n</body></html>';
    const p = D.sanitizeSharePayload({ exams: [EXAM] }, {});
    let out = null, threw = false;
    try { out = D.embedPayload(two, p, { allowUnsafe: true }); } catch (e) { threw = true; }
    return (threw || (out && D.payloadBlockCount(out).blocks > 1) || (out && out.indexOf(leak) >= 0)) ? true
      : '居然只剩 1 个块且无残留';
  } finally { rm('core/__probe_sh20.js'); }
});

/* ---- 21. 扫描用宽例外表（键名还在载荷里、扫描却说零命中）
 *   ⚠ 第七轮后 `keys` 两边都抓，这条探针得改用 `record`：它才是"剥离侧放行、扫描必须抓"的那一个。 ---- */
probe('㉑ 扫描用宽例外表 → ①-F/⑦-D「严格口径 record」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace("    const exceptions = strict ? STRICT_KEY_EXCEPTIONS : KEY_NAME_EXCEPTIONS;", '    const exceptions = KEY_NAME_EXCEPTIONS;'),
    'core/__probe_sh21.js');
  try {
    const sc = D.shareScan({ config: { record: 'x' } }, {});
    return sc.ok === true ? true : '居然还是报出来了：' + JSON.stringify(sc.hits);
  } finally { rm('core/__probe_sh21.js'); }
});

/* ---- 22. 清块正则要求"必须有收尾标签"（自闭合/残缺块清不掉） ----
 *   红队第四轮 P1：`<script id="exam-payload" … />` 谁都管不着，旧载荷（含密钥形状串）随文件发出。 */
probe('㉒ 自闭合块不拦 → ②-A「E_SELF_CLOSING_BLOCK」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace('               complete: closeEnd > 0, selfClosing: isSelfClosingTag(t.text) };',
                   '               complete: true, selfClosing: false };'),
    'core/__probe_sh22.js');
  try {
    const leak = 'sk-' + 'K'.repeat(20);
    const input = '<html><body><script id="exam-payload" type="application/json"/>{"old":1,"leak":"' + leak + '"}\n</body></html>';
    const p = D.sanitizeSharePayload({ exams: [EXAM] }, {});
    let out = null, code = null;
    try { out = D.embedPayload(input, p, { allowUnsafe: true }); } catch (e) { code = e.code; }
    /* 自闭合不拦 → 既不抛 E_SELF_CLOSING_BLOCK，又会按"正文到文件尾"把后面的内容整段切掉（结构被毁） */
    const mangled = !out || out.indexOf('</body>') < 0 || out.indexOf(leak) >= 0;
    return (code !== 'E_SELF_CLOSING_BLOCK' && mangled) ? true
      : ('code=' + code + ' mangled=' + mangled);
  } finally { rm('core/__probe_sh22.js'); }
});

/* ---- 23. 诱饵 id 摘除把标签拼坏（`<div">`）并吞掉后面的 script（红队第四轮 P2 的原样写法） ---- */
probe('㉓ 诱饵用"拼回引号"的旧写法 → ②-A「诱饵标签没被拼坏」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace("      const stripped = t.text.replace(new RegExp('\\\\s+id\\\\s*=\\\\s*([\"\\']?)\\\\s*' + PAYLOAD_ID + '\\\\s*\\\\1', 'i'), '');",
                   "      const stripped = t.text.replace(new RegExp('\\\\s+id\\\\s*=\\\\s*([\"\\']?)' + PAYLOAD_ID, 'i'), '');"),
    'core/__probe_sh23.js');
  try {
    const p = D.sanitizeSharePayload({ exams: [EXAM] }, {});
    const out = D.embedPayload('<html><body><div id="exam-payload" class="mount"></div>\n</body></html>', p, { allowUnsafe: true });
    return /<div["']/.test(out) ? true : '标签居然还是好的：' + out.slice(0, 80);
  } finally { rm('core/__probe_sh23.js'); }
});

/* ---- 24. 键名不归一（全角 ａｐｉＫｅｙ 放行） ---- */
probe('㉔ 键名不做 NFKC 归一 → ①-F「全角键名」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace("  function lowerKey(k) { return String(k).normalize ? String(k).normalize('NFKC').toLowerCase().replace(/[^a-z_]/g, '') : String(k).toLowerCase().replace(/[^a-z_]/g, ''); }",
                   "  function lowerKey(k) { return String(k).toLowerCase().replace(/[^a-z_]/g, ''); }")
          .replace("    const s = String(k).normalize ? String(k).normalize('NFKC') : String(k);", '    const s = String(k);'),
    'core/__probe_sh24.js');
  try {
    return D.isForbiddenKey('\uff41\uff50\uff49\uff2b\uff45\uff59', { strict: true }) === false ? true : '居然还是命中了';
  } finally { rm('core/__probe_sh24.js'); }
});

/* ---- 25. 逐字节幂等（第二次多一个换行） ---- */
probe('㉕ 清块不吞换行 → ②-A「逐字节幂等」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace("      if (src2.charAt(cutEnd) === '\\n') cutEnd++;                 // 吞换行 → 幂等", '      '),
    'core/__probe_sh25.js');
  try {
    const p = D.sanitizeSharePayload({ exams: [EXAM] }, {});
    const once = D.embedPayload('<html><body>\n</body></html>', p, { allowUnsafe: true });
    const twice = D.embedPayload(once, p, { allowUnsafe: true });
    return twice !== once ? true : '居然字节相同';
  } finally { rm('core/__probe_sh25.js'); }
});

/* ---- 26. id 不做字符引用解码（`&#101;xam-payload` 就清不掉也不拒绝） ----
 *   红队第六轮的真反例：他们在真浏览器里验证过 DOM 里会出现两个同 id 的 script 块。 */
probe('㉖ id 不解码 → ②-A「实体编码 id 也清得掉」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace('    return m ? decodeCharRefs(m[2]) : \'\';', '    return m ? m[2] : \'\';'),
    'core/__probe_sh26.js');
  try {
    const leak = 'sk-' + 'Z'.repeat(20);
    const input = '<html><body><script id="&#101;xam-payload">{"old":1,"leak":"' + leak + '"}<\/script>\n</body></html>';
    const p = D.sanitizeSharePayload({ exams: [EXAM] }, {});
    let out = null, threw = false;
    try { out = D.embedPayload(input, p, { allowUnsafe: true }); } catch (e) { threw = true; }
    return (threw || (out && out.indexOf(leak) >= 0)) ? true : '居然还是干净的';
  } finally { rm('core/__probe_sh26.js'); }
});

/* ---- 27. 同义词表的键被当字段名剔掉（采分能力丢失，扫描还报零命中） ---- */
probe('㉗ 同义词表键也被剔 → ①-G「判分等价」锚变红', function () {
  const Q = require('../core/quiz.js');
  const D = loadFrom('core/data.js',
    s => s.replace("            if (cloned && cloned.short && cloned.short.synonyms && typeof cloned.short.synonyms === 'object') {", '            if (false) {'),
    'core/__probe_sh27.js');
  try {
    const exam = S.createExam({ id: 'S27', title: 't',
      config: { short: { synonyms: { API: ['应用程序接口'] }, matchMode: 'contains' }, points: { '简答': 5 } },
      questions: [S.createQuestion({ id: 's27', type: '简答', stem: 'x', answer: 'API', keywords: [{ text: 'API', via: '加粗' }] })] }, {});
    const pkg = D.buildSharePackage({ exams: [exam] }, {});
    const cfg1 = Q.resolveConfig(null, exam);
    const cfg2 = Q.resolveConfig(null, pkg.payload.exams[0]);
    const a = Q.scoreExam(exam.questions, { s27: '应用程序接口' }, cfg1);
    const b = Q.scoreExam(pkg.payload.exams[0].questions.map(function (q) { return S.createQuestion(q); }), { s27: '应用程序接口' }, cfg2);
    return (b.score !== a.score) ? true : '分数居然一样：' + JSON.stringify([a.score, b.score]);
  } finally { rm('core/__probe_sh27.js'); }
});

/* ---- 28. 无分号数字引用不解码（红队第七轮 P1：`id="exa&#109-payload"` 在 DOM 里就是我们的 id） ---- */
probe('㉘ 无分号数字引用不解码 → ⑦-A「解码后认得出」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace("    out = out.replace(/&#(\\d+)(;?)/g, function (m, d, semi, off) {\n      if (!semi && blocked(src.charAt(off + m.length))) return m;",
                   '    out = out.replace(/&#(\\d+)(;?)/g, function (m, d, semi, off) {\n      if (!semi) return m;'),
    'core/__probe_sh28.js');
  try {
    const input = '<html><body><script id="exa&#109-payload" type="application/json">{"old":1}<\/script>\n</body></html>';
    return D.payloadBlockCount(input).blocks === 0 ? true : '居然还是认出来了';
  } finally { rm('core/__probe_sh28.js'); }
});

/* ---- 29. 注释不掩码、注释痕迹不检查（红队第七轮 P2：删掉模板 JS、把载荷写进注释） ---- */
probe('㉙ 注释不掩码 → ⑦-B「注释痕迹拒绝内嵌」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace("  function commentRegions(src) {\n    const s = String(src == null ? '' : src);\n    const out = [];",
                   "  function commentRegions(src) {\n    const s = String(src == null ? '' : src);\n    const out = [];\n    return out;"),
    'core/__probe_sh29.js');
  try {
    const p = D.sanitizeSharePayload({ exams: [EXAM] }, {});
    const trap = '<html><body><script>var keepJS = 1;<\/script>\n<!-- <script id="exam-payload"> -->\n<script>var other = 2;<\/script>\n</body></html>';
    let out = null, threw = false;
    try { out = D.embedPayload(trap, p, { allowUnsafe: true }); } catch (e) { threw = true; }
    const damaged = !out || out.indexOf('var other = 2;') < 0;
    let uThrew = false;
    try { D.embedPayload('<html><body><!-- 忘了收尾\n<div id="app"></div>\n</body></html>', p, { allowUnsafe: true }); } catch (e) { uThrew = true; }
    return (damaged && !uThrew) ? true : ('模板没被破坏/' + threw + '/未闭合注释仍被拒=' + uThrew);
  } finally { rm('core/__probe_sh29.js'); }
});

/* ---- 30. 对象键名不当文本扫（红队第七轮 P3：密钥写进同义词表的键名就隐形） ---- */
probe('㉚ 键名不当文本扫 → ⑦-C「键名里的密钥」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace("        scanText(k, p + '.' + k, '载荷里的键名');", '        /* 键名不扫 */'),
    'core/__probe_sh30.js');
  try {
    const leak = 'sk-' + 'Q'.repeat(20);
    const sc = D.shareScan({ exams: [{ config: { short: { synonyms: { [leak]: ['x'] } } } }] }, {});
    return sc.ok === true ? true : '居然还是报出来了：' + JSON.stringify(sc.hits);
  } finally { rm('core/__probe_sh30.js'); }
});

/* ---- 31. 敏感词表退回旧版（裸 key 与复数/凭证同义词都不认） ---- */
probe('㉛ 敏感词表退回旧版 → ⑦-D「myKey/cookie 都抓」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace("  const FORBIDDEN_KEYS = ['apikey', 'api_key', 'key', 'keys', 'token', 'tokens', 'secret', 'secrets',\n                          'records', 'record', 'answers', 'history', 'wrongbook', 'wrong', 'progress', 'draft',",
                   "  const FORBIDDEN_KEYS = ['apikey', 'api_key', 'key', 'keys', 'token', 'secret', 'records', 'record',\n                          'answers', 'history', 'wrongbook', 'wrong', 'progress', 'draft',")
          .replace("                          'password', 'passwd', 'pwd', 'credential', 'credentials', 'authorization', 'auth',\n                          /* 红队第七轮补的：复数形/凭证类同义词漏了一整排，`cookie` 更是典型的会话凭证 */\n                          'cookie', 'cookies', 'privatekey', 'accesskey', 'secretkey'];",
                   "                          'password', 'passwd', 'pwd', 'credential', 'credentials', 'authorization', 'auth'];")
          .replace("  const FORBIDDEN_WORDS = ['apikey', 'api', 'key', 'token', 'tokens', 'secret', 'secrets', 'keys', 'keybag',\n                           'password', 'passwd', 'pwd',\n                           'credential', 'credentials', 'authorization', 'auth', 'bearer',\n                           'cookie', 'cookies', 'privatekey', 'accesskey', 'secretkey'];",
                   "  const FORBIDDEN_WORDS = ['apikey', 'api', 'token', 'secret', 'keys', 'keybag', 'password', 'passwd', 'pwd',\n                           'credential', 'credentials', 'authorization', 'auth', 'bearer'];"),
    'core/__probe_sh31.js');
  try {
    const misses = ['myKey', 'tokens', 'secrets', 'cookie', 'privatekey', 'accesskey']
      .filter(function (k) { return D.isForbiddenKey(k) === false; });
    return misses.length === 6 ? true : '还有几个没退回去：' + JSON.stringify(misses.length ? misses : '全都没退');
  } finally { rm('core/__probe_sh31.js'); }
});

/* ---- 32. 剥离侧例外表退回旧版（`keys` 又变成"扫描说命中、剥离却放过"） ---- */
probe('㉜ 例外表把 `keys` 放回去 → ⑦-D「keys 两边都抓」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace("  const KEY_NAME_EXCEPTIONS = ['keywords', 'keyword', 'keypoints', 'record'];",
                   "  const KEY_NAME_EXCEPTIONS = ['keywords', 'keyword', 'keys', 'keypoints', 'record'];"),
    'core/__probe_sh32.js');
  try {
    return D.isForbiddenKey('keys') === false ? true : '居然还是命中了';
  } finally { rm('core/__probe_sh32.js'); }
});

/* ---- 33. 读回退回"明文正则"（第二套判据复活：计数说 1 个、读回说没有载荷） ---- */
probe('㉝ 读回退回明文正则 → ⑦-E「只有一套判据」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace('    const b = findPayloadBlocks(src).filter(function (x) { return x.complete; })[0];\n    if (!b) return { ok: false, reason: \'no-payload\'',
                   '    const mm = /<script id="exam-payload"[^>]*>([\\s\\S]*?)<\\/script>/i.exec(src);\n    const b = mm ? { endOpen: mm.index + mm[0].indexOf(\'>\') + 1, closeStart: mm.index + mm[0].lastIndexOf(\'</script\') } : null;\n    if (!b) return { ok: false, reason: \'no-payload\''),
    'core/__probe_sh33.js');
  try {
    const input = '<html><body><script id="&#101;xam-payl&#111;ad" type="application/json">{"old":"丁"}<\/script>\n</body></html>';
    const back = D.extractPayload(input);
    return (back == null && D.payloadBlockCount(input).blocks === 1) ? true : '居然还是读回来了：' + JSON.stringify(back);
  } finally { rm('core/__probe_sh33.js'); }
});

/* ---- 34. 不查"断在半截的开标签"（到文件尾都没有 `>`，定位器看不见它） ---- */
probe('㉞ 半截开标签不查 → ⑦-F「EOF 断标签也拒绝」锚变红', function () {
  const D = loadFrom('core/data.js',
    s => s.replace('  function unterminatedScriptTags(src) {\n    const s = maskComments(src);',
                   '  function unterminatedScriptTags(src) {\n    return [];\n    const s = maskComments(src);'),
    'core/__probe_sh34.js');
  try {
    const p = D.sanitizeSharePayload({ exams: [EXAM] }, {});
    const eof = '<html><body><script id="exam-payload" type="application/json"';
    let code = null, out = null;
    try { out = D.embedPayload(eof, p, { allowUnsafe: true }); } catch (e) { code = e.code; }
    return (code === null && typeof out === 'string') ? true : ('居然还是拒了：' + code);
  } finally { rm('core/__probe_sh34.js'); }
});

const bad = results.filter(r => r[1] !== true);
console.log('\n探针汇总：' + results.length + ' 条  全部能让锚变红=' + (bad.length === 0));
if (bad.length) { bad.forEach(b => console.log('  未变红：' + b[0] + ' → ' + b[1])); process.exitCode = 1; }
