/* ============================================================
 *  verify/persistence.test.js —— 跨"重启"的持久化验收（真·两个进程）
 *
 *  运行： node verify/persistence.test.js
 *
 *  要验的组级标准：
 *    「重启浏览器后试卷、题目与设置仍在」——这是**双后端路由**那一组的标准。
 *
 *  为什么不是"新建一个 store 实例再读一遍"：
 *    那只证明"没有内存缓存"，**证明不了持久化** —— 同一份 Map 还在进程内存里。
 *    真正的判据是：**另一个进程**能不能读到上一个进程写下的东西。
 *
 *  本文件的做法：
 *    父进程 → 用**文件后端**（落盘到 verify/_persist/*.json）写入：
 *               一份试卷（走 ExamsCore）+ 一条大记录（应路由到异步后端）+ 全局设置
 *    子进程 → `node verify/persistence.test.js --child`
 *               一个全新的进程，只做读取与断言，把结论写进 result.json
 *    父进程 → 读 result.json，逐条回报子进程的断言
 *
 *  子进程为什么不走管道：本机策略禁止用命名管道捕获子进程输出（会 EPERM），
 *  所以子进程把结论**写文件**，父进程读文件 —— 不碰管道。
 *
 *  边界（如实说明）：
 *    这里验的是 store 的**持久化契约**（数据跨进程仍在、落点索引仍在、keys 能汇总），
 *    用的是文件后端；**浏览器真实的 localStorage / IndexedDB** 由
 *    `浏览器自检.html` 的 I 节（两阶段：写入 → 刷新页面 → 复核）覆盖。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const DIR = path.join(__dirname, '_persist');
const SMALL_F = path.join(DIR, 'small.json');
const LARGE_F = path.join(DIR, 'large.json');
const RESULT_F = path.join(DIR, 'result.json');
const NS = 'persist_ns';

const isChild = process.argv.indexOf('--child') >= 0;

/* ---------------- 文件后端（模拟"关掉再打开还在"） ---------------- */
function readMap(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } }
function writeMap(f, m) { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(m), 'utf8'); }

function fileSmall() {
  return {
    getItem: k => { const m = readMap(SMALL_F); return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem: (k, v) => { const m = readMap(SMALL_F); m[k] = String(v); writeMap(SMALL_F, m); },
    removeItem: k => { const m = readMap(SMALL_F); delete m[k]; writeMap(SMALL_F, m); },
    key: i => { const a = Object.keys(readMap(SMALL_F)); return i < a.length ? a[i] : null; },
    get length() { return Object.keys(readMap(SMALL_F)).length; }
  };
}
function fileLarge() {
  return {
    get: async k => { const m = readMap(LARGE_F); return Object.prototype.hasOwnProperty.call(m, k) ? JSON.parse(m[k]) : null; },
    set: async (k, v) => { const m = readMap(LARGE_F); m[k] = JSON.stringify(v); writeMap(LARGE_F, m); },
    del: async k => { const m = readMap(LARGE_F); delete m[k]; writeMap(LARGE_F, m); },
    keys: async () => Object.keys(readMap(LARGE_F))
  };
}

const D = require('../core/data.js');
const E = require('../core/exams.js');
const S = require('../core/schema.js');
const P = require('../parser-core.js');
const TF = require('../core/text-format.js');

function newStore() {
  // threshold 故意调小：让试卷本体走异步后端，两个后端都被真实使用
  return D.createStore({ small: fileSmall(), large: fileLarge(), threshold: 512, namespace: NS });
}

/* ============================================================
 *  子进程模式：只读 + 断言 + 把结论写文件
 * ============================================================ */
async function runChild() {
  const checks = [];
  const add = (name, pass, detail) => { checks.push({ name: name, pass: !!pass, detail: detail === undefined ? '' : String(detail) }); };

  const store = newStore();

  // 1) 落盘文件确实在（证明是"另一个进程读磁盘"，不是共享内存）
  add('数据文件存在于磁盘上', fs.existsSync(SMALL_F) && fs.existsSync(LARGE_F),
      'small.json=' + (fs.existsSync(SMALL_F) ? fs.statSync(SMALL_F).size : -1) + 'B, large.json=' +
      (fs.existsSync(LARGE_F) ? fs.statSync(LARGE_F).size : -1) + 'B');

  // 2) 全局设置（同步后端）
  const st = await store.get('settings');
  add('同步后端：全局设置读回来了', st && st.theme === 'dark' && st.points && st.points['单选'] === 2,
      JSON.stringify(st));

  // 3) 大记录（异步后端）
  const big = await store.get('bigRecord');
  add('异步后端：2000 字符的大记录原样读回', big && big.pad && big.pad.length === 2000,
      big && big.pad ? big.pad.length + ' 字符' : 'null');

  // 4) 落点索引也持久
  add('落点索引持久：settings → small', store.placement('settings') === 'small', String(store.placement('settings')));
  add('落点索引持久：bigRecord → large', store.placement('bigRecord') === 'large', String(store.placement('bigRecord')));

  // 5) 试卷本体（走卷册模块）
  //    注意：这里**不假设**一定读得到 —— 数据没了也要如实报出每一条，而不是崩掉。
  //    （反向对照会故意清空磁盘再来跑一遍，那时这里必须优雅地报失败。）
  const list = await E.listExams(store);
  add('卷册能列出上一进程创建的试卷', list.total === 1, 'total=' + list.total);
  const meta = list.exams[0] || null;
  add('试卷标题持久', !!(meta && meta.title === '跨进程持久化卷'), meta ? meta.title : '读不到试卷');
  add('题目数与题型分布持久',
      !!(meta && meta.counts.total === 4 && meta.counts['单选'] === 2 && meta.counts['判断'] === 1 && meta.counts['简答'] === 1),
      meta ? JSON.stringify(meta.counts) : '读不到试卷');
  add('轻量 meta 走的是快路径（不是自愈出来的）', list.healed === false, 'healed=' + list.healed);

  const got = meta ? await E.getExam(store, meta.id) : { ok: false, error: '没有试卷可读' };
  add('题目内容持久：题干/选项/答案都在',
      !!(got.ok && got.exam.questions.length === 4 &&
         got.exam.questions[0].options.length === 2 &&
         got.exam.questions[0].answerLetters.length === 1),
      got.ok ? got.exam.questions.length + ' 题' : got.error);
  const q3 = got.ok ? got.exam.questions[3] : null;
  add('简答关键词（含来源 via）持久',
      !!(q3 && q3.keywords && q3.keywords.length > 0 && q3.keywords.every(k => !!k.via)),
      q3 && q3.keywords ? JSON.stringify(q3.keywords) : '读不到');

  // 6) keys() 跨两个后端汇总
  const ks = (await store.keys()).slice().sort();
  add('keys() 跨两个后端汇总', ks.indexOf('settings') >= 0 && ks.indexOf('bigRecord') >= 0 && ks.length >= 3,
      JSON.stringify(ks));

  // 7) 无孤儿数据
  const orph = await E.scanOrphans(store);
  add('没有孤儿数据', orph.orphans.length === 0 && orph.missingBodies.length === 0,
      JSON.stringify({ orphans: orph.orphans.length, missingBodies: orph.missingBodies.length }));

  // 8) 结构化文本导出仍然可用（跨进程后整条链都通）
  let rtOk = false, rtDetail = '读不到试卷';
  if (got.ok) {
    const text = TF.exportExam(got.exam);
    const back = TF.importExam(text);
    rtOk = !!(back.ok && JSON.stringify(back.exam) === JSON.stringify(got.exam));
    rtDetail = back.ok ? '' : JSON.stringify(back.errors).slice(0, 120);
  }
  add('导出→导入仍逐字段无差异', rtOk, rtDetail);

  const ok = checks.every(c => c.pass);
  // 目录可能被父进程清掉了（反向对照就是故意清空的），所以写结论前先确保目录在
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(RESULT_F, JSON.stringify({ ok: ok, checks: checks, pid: process.pid }, null, 1), 'utf8');
  process.exitCode = ok ? 0 : 1;
}

/* ============================================================
 *  父进程模式：写 → 起一个全新进程读 → 核对它的结论
 * ============================================================ */
let pass = 0, fail = 0; const failures = [];
function ok(c, t, d) { c ? (pass++, console.log('  \x1b[32mPASS\x1b[0m  ' + t + (d ? '   ' + d : '')))
                         : (fail++, failures.push(t), console.log('  \x1b[31mFAIL\x1b[0m  ' + t + (d !== undefined ? '   实际=' + d : ''))); }
function head(t) { console.log('\n\x1b[36m==== ' + t + ' ====\x1b[0m'); }

async function runParent() {
  head('① 父进程：写入（阈值 512，逼试卷走异步后端）');

  // 从干净状态开始
  if (fs.existsSync(DIR)) fs.rmSync(DIR, { recursive: true, force: true });
  ok(!fs.existsSync(SMALL_F) && !fs.existsSync(LARGE_F), '起始：磁盘上没有数据文件');

  const store = newStore();

  await store.set('settings', { theme: 'dark', points: { '单选': 2 } });
  const wBig = await store.set('bigRecord', { pad: 'x'.repeat(2000), note: '这条必须落在异步后端' });
  ok(wBig.where === 'large', '大记录按阈值路由到异步后端', wBig.where + ' / ' + wBig.bytes + ' 字节');

  const created = await E.createExam(store, { title: '跨进程持久化卷', now: '2026-09-17T22:00:00.000Z' });
  ok(created.ok, '创建工作：' + created.exam.id);
  const parsed = P.parseText([
    '【单选】A？（　）', 'A. 甲', 'B. 乙', '答案：B',
    '【单选】B？（　）', 'A. 甲', 'B. 乙', '答案：A',
    '【判断】C？（　）', '答案：对',
    '【简答】D？', '答案：甲甲；乙乙'
  ].join('\n'));
  const app = await E.appendQuestions(store, created.exam.id, parsed.questions, { now: '2026-09-17T22:01:00.000Z' });
  ok(app.ok, '追加 4 题', app.ok ? JSON.stringify(app.meta.counts) : (app.error || ''));
  ok(app.placement === 'large', '试卷本体超阈值 → 落异步后端（两后端都被用到）', String(app.placement));

  ok(fs.existsSync(SMALL_F) && fs.statSync(SMALL_F).size > 0, '同步后端文件已落盘',
     fs.statSync(SMALL_F).size + ' B');
  ok(fs.existsSync(LARGE_F) && fs.statSync(LARGE_F).size > 2000, '异步后端文件已落盘（含那 2000+ 字节）',
     fs.statSync(LARGE_F).size + ' B');

  head('② 起一个**全新进程**去读（这才是"重启"的判据）');

  const kid = cp.spawnSync(process.execPath, [__filename, '--child'], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'inherit', 'inherit']     // 不走管道：子进程把结论写文件
  });
  ok(kid.error === undefined, '子进程能起来（没有踩到管道/权限限制）', kid.error ? String(kid.error) : 'pid 正常退出');
  ok(fs.existsSync(RESULT_F), '子进程把结论写进了 result.json');

  head('③ 核对子进程的断言（它只读，不写业务数据）');

  if (!fs.existsSync(RESULT_F)) {
    ok(false, '没有 result.json，后面的核对无法进行');
  } else {
    const res = JSON.parse(fs.readFileSync(RESULT_F, 'utf8'));
    console.log('    （子进程 pid=' + res.pid + '，以下 ' + res.checks.length + ' 条是**它**跑出来的）');
    res.checks.forEach(function (c) {
      ok(c.pass, '子进程：' + c.name, c.detail);
    });
    ok(kid.status === 0, '子进程退出码为 0', 'status=' + kid.status);
    ok(res.ok === true, '子进程自评：全部通过', String(res.ok));
  }

  head('④ 反向对照：把磁盘数据删掉后，同一个子进程必须报失败');

  fs.rmSync(DIR, { recursive: true, force: true });
  const kid2 = cp.spawnSync(process.execPath, [__filename, '--child'], {
    cwd: path.join(__dirname, '..'), stdio: ['ignore', 'inherit', 'inherit']
  });
  if (fs.existsSync(RESULT_F)) {
    const res2 = JSON.parse(fs.readFileSync(RESULT_F, 'utf8'));
    ok(res2.ok === false, '清空磁盘后子进程确实报失败（证明上面那组不是空转）',
       res2.checks.filter(c => !c.pass).length + ' 条失败');
    ok(res2.checks.some(c => !c.pass && c.name.indexOf('同步后端') >= 0), '  失败项里包含"设置读不回来"');
  } else {
    ok(false, '清空后子进程没有产出 result.json');
  }

  // 收尾：把测试目录删干净
  fs.rmSync(DIR, { recursive: true, force: true });
  ok(!fs.existsSync(DIR), '收尾：测试目录已清理');

  console.log('\n\x1b[36m================ 汇总 ================\x1b[0m');
  console.log('  PASS ' + pass + '    FAIL ' + fail);
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('    - ' + f)); }
  process.exitCode = fail ? 1 : 0;
}

(isChild ? runChild() : runParent()).catch(function (e) {
  console.error('崩了: ' + (e && e.stack || e));
  if (isChild) { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(RESULT_F, JSON.stringify({ ok: false, checks: [{ name: '子进程崩溃', pass: false, detail: String(e && e.message || e) }], pid: process.pid })); } catch (x) {} }
  process.exit(2);
});
