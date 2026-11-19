#!/usr/bin/env node
/**
 * BOSS 直聘 · 招聘方（企业）助手 CLI
 *
 * 前提：你本人拥有一个已认证的企业招聘账号。
 * 本工具只复用你本机 Chrome 里的登录态，不接收账号密码，不破解风控，不绕过验证码。
 */
import fs from 'node:fs';
import path from 'node:path';
import { launch, close, getSessionState, readEndpoints, navigate } from './lib/browser.mjs';
import { attachCapture, pageFetch } from './lib/net.mjs';
import {
  collectCandidates,
  findResumeObject,
  mapResume,
  extractResumeTextFromDom,
  findJobArrays,
  mapJob,
} from './lib/extract.mjs';
import { upsertByKey, writeCsv } from './lib/store.mjs';
import {
  assertAllowed,
  audit,
  throttle,
  consumeBudget,
  detectRiskControl,
  RiskControlError,
  loadSettings,
  budgetSnapshot,
  PolicyError,
} from './lib/policy.mjs';
import {
  FILES,
  DIRS,
  ensureDirs,
  nowIso,
  stamp,
  maskPhone,
  maskEmail,
  maskName,
  readJson,
  writeJson,
  readJsonl,
  sleep,
} from './lib/util.mjs';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq > -1) {
        args[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        args[body] = argv[i + 1];
        i += 1;
      } else {
        args[body] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

const log = (msg) => process.stdout.write(`${msg}\n`);

function strWidth(s) {
  const str = String(s ?? '');
  let n = 0;
  for (const ch of str) n += /[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1;
  return n;
}

function table(rows, columns) {
  if (!rows.length) {
    log(C.dim('  （无数据）'));
    return;
  }
  const cols = columns || Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.min(30, Math.max(strWidth(c), ...rows.map((r) => strWidth(r[c]))))
  );
  const cut = (s, w) => {
    let out = '';
    let acc = 0;
    for (const ch of String(s ?? '')) {
      const cw = /[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1;
      if (acc + cw > w) return out + '…';
      acc += cw;
      out += ch;
    }
    return out;
  };
  const pad = (s, w) => String(s ?? '') + ' '.repeat(Math.max(0, w - strWidth(s)));
  log(C.dim(cols.map((c, i) => pad(c, widths[i])).join('  ')));
  for (const r of rows) log(cols.map((c, i) => pad(cut(r[c], widths[i]), widths[i])).join('  '));
}

function checkRisk(captured) {
  for (const entry of captured) {
    const hit = detectRiskControl(entry.json);
    if (hit) return hit;
  }
  return null;
}

async function scrollAndCapture(page, capture, { rounds = 4, gapMs = 1800 } = {}) {
  const all = [];
  for (let i = 0; i < rounds; i += 1) {
    await page
      .evaluate(() => window.scrollBy({ top: Math.round(window.innerHeight * 0.85), behavior: 'smooth' }))
      .catch(() => {});
    await sleep(gapMs);
    const entries = capture.drain();
    const hit = checkRisk(entries);
    if (hit) throw new RiskControlError(hit);
    all.push(...entries);
  }
  return all;
}

function persistProbe(captured, tag) {
  if (!captured.length) return null;
  ensureDirs();
  const file = path.join(DIRS.probe, `probe-${tag}-${stamp()}.jsonl`);
  for (const e of captured) {
    fs.appendFileSync(file, JSON.stringify({ url: e.url, at: e.at, json: e.json }) + '\n', 'utf8');
  }
  return file;
}

function shortUrl(u) {
  try {
    const x = new URL(u, 'https://www.zhipin.com');
    return x.pathname + (x.search ? '?' + x.search.slice(1, 40) : '');
  } catch {
    return String(u).slice(0, 60);
  }
}

function describeShapes(json) {
  const out = [];
  const walk = (node, d = 0) => {
    if (!node || d > 3) return;
    if (Array.isArray(node)) {
      if (node.length && node[0] && typeof node[0] === 'object') {
        out.push(`[${Object.keys(node[0]).slice(0, 8).join(',')}]`);
      }
      node.slice(0, 2).forEach((n) => walk(n, d + 1));
      return;
    }
    if (typeof node === 'object') {
      const keys = Object.keys(node);
      if (keys.length && keys.length < 40) out.push(`{${keys.slice(0, 8).join(',')}}`);
      keys.forEach((k) => walk(node[k], d + 1));
    }
  };
  walk(json);
  return [...new Set(out)].slice(0, 6);
}

function guessIdentity(captured) {
  let best = null;
  const KEYS = ['brandName', 'companyName', 'companyFullName', 'bossName', 'userName', 'roleName', 'isBoss', 'identity'];
  const walk = (node, depth = 0) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      node.forEach((n) => walk(n, depth + 1));
      return;
    }
    if (typeof node === 'object') {
      let score = 0;
      const out = {};
      for (const k of KEYS) {
        const v = node[k];
        if (v !== undefined && v !== null && v !== '' && typeof v !== 'object') {
          score += 1;
          out[k] = v;
        }
      }
      if (score >= 2 && (!best || score > best.score)) {
        best = {
          score,
          company: out.companyName || out.brandName || out.companyFullName,
          name: out.userName || out.bossName,
          role: out.roleName || (out.isBoss ? '企业招聘者' : ''),
        };
      }
      for (const k of Object.keys(node)) walk(node[k], depth + 1);
    }
  };
  captured.forEach((e) => walk(e.json));
  return best;
}

/* ------------------------------------------------------------------ */
/* 命令                                                                */
/* ------------------------------------------------------------------ */

async function cmdLogin(args) {
  const ep = readEndpoints();
  const target = args.url || ep.pages?.login || 'https://www.zhipin.com/web/boss/index';
  const waitSec = Number(args.wait || 180);

  let { context, page } = await launch({ headless: false });
  const capture = attachCapture(context);
  try {
    log(C.bold('打开企业端登录页：') + target);
    page = await navigate(context, page, target);
    log(C.dim('未登录的话，请在浏览器窗口里选择「我要招人」并扫码登录（企业账号）。'));
    log(C.dim(`等待登录态出现，最多 ${waitSec} 秒…`));

    const deadline = Date.now() + waitSec * 1000;
    let state = await getSessionState(context);
    while (!state.loggedIn && Date.now() < deadline) {
      await sleep(2500);
      state = await getSessionState(context);
    }

    if (!state.loggedIn) {
      log(C.yellow('仍未检测到登录态。可以再跑一次 `boss login`，或加 --wait 300 多等一会。'));
      return 1;
    }

    await sleep(2500);
    const cap = capture.drain();
    persistProbe(cap, 'login');
    const identity = guessIdentity(cap);

    log(C.green('登录态已就绪。'));
    log(`  Cookie 数量：${state.cookieCount}`);
    log(`  关键 Cookie：${state.hints.join(', ') || '—'}`);
    if (identity?.company) log(`  企业：${identity.company}`);
    if (identity?.role) log(`  角色：${identity.role}`);
    log(C.dim('登录态保存在 .browser-profile/（已在 .gitignore 中排除）。'));
    return 0;
  } finally {
    capture.detach();
    await close(context);
  }
}

async function cmdWhoami() {
  const ep = readEndpoints();
  let { context, page } = await launch({ headless: false });
  const capture = attachCapture(context);
  try {
    page = await navigate(
      context,
      page,
      ep.pages?.login || 'https://www.zhipin.com/web/boss/index'
    );
    await sleep(6000);
    const state = await getSessionState(context);
    const cap = capture.drain();
    const identity = guessIdentity(cap);

    log(`${C.bold('登录状态')}：${state.loggedIn ? C.green('已登录') : C.red('未登录')}`);
    log(`${C.bold('关键 Cookie')}：${state.hints.join(', ') || '—'}`);
    if (identity) {
      log(`${C.bold('企业')}：${identity.company || '—'}`);
      log(`${C.bold('身份')}：${identity.role || '—'}${identity.name ? C.dim('  (' + identity.name + ')') : ''}`);
    } else {
      log(C.yellow('没识别出企业身份。可能未登录企业端，或页面接口有变化 —— 用 `boss probe --page login` 看原始响应。'));
    }
    log(`${C.bold('今日用量')}：${JSON.stringify(budgetSnapshot())}`);
    return state.loggedIn ? 0 : 2;
  } finally {
    capture.detach();
    await close(context);
  }
}

async function cmdProbe(args) {
  const ep = readEndpoints();
  const pageKey = args.page || 'recommend';
  const url = args.url || ep.pages?.[pageKey];
  if (!url) throw new Error(`config/endpoints.json 里没有 pages.${pageKey}，请用 --url 指定`);

  const seconds = Number(args.seconds || 60);
  let { context, page } = await launch({ headless: false });
  const capture = attachCapture(context, { maxEntries: 800 });
  try {
    log(C.bold('采集探测模式') + C.dim(`  目标页：${url}`));
    log(C.dim(`请在打开的窗口里正常操作（翻页、点开候选人、切换标签），持续 ${seconds} 秒。`));

    page = await navigate(context, page, url);

    const all = [];
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      await sleep(2000);
      const entries = capture.drain();
      if (entries.length) all.push(...entries);
      process.stdout.write(`\r${C.dim(`已捕获 ${all.length} 个 JSON 响应…`)}`);
    }
    process.stdout.write('\r');

    const file = persistProbe(all, pageKey);
    log(`\n${C.green('捕获完成')}：${all.length} 个响应`);
    if (file) log(`原始数据：${file}`);

    const summary = new Map();
    for (const e of all) {
      const shapes = describeShapes(e.json);
      if (!shapes.length) continue;
      const key = shortUrl(e.url);
      const prev = summary.get(key) || { url: e.url, count: 0, shapes: new Set() };
      prev.count += 1;
      shapes.forEach((s) => prev.shapes.add(s));
      summary.set(key, prev);
    }
    const rows = [...summary.values()]
      .sort((a, b) => b.count - a.count)
      .map((v) => ({ 接口: shortUrl(v.url), 次数: v.count, 结构: [...v.shapes].join(' ; ') }));
    log('');
    table(rows.slice(0, 30), ['接口', '次数', '结构']);
    log(C.dim('\n确认哪些是「候选人列表 / 简历详情 / 职位列表」后，填进 config/endpoints.json 的 apis 段即可走直连。'));
    return 0;
  } finally {
    capture.detach();
    await close(context);
  }
}

async function cmdCandidates(args) {
  const settings = loadSettings();
  assertAllowed(`candidates ${args.job || ''}`);
  const ep = readEndpoints();
  const limit = Number(args.limit || settings.limits.maxCandidatesPerRun);
  const scrolls = Number(args.scroll || settings.limits.maxPagesPerQuery);
  const pageKey = args.page || (args.job ? 'search' : 'chat');
  let url = args.url || ep.pages?.[pageKey];
  if (!url) throw new Error('缺少目标页地址');
  if (args.job) url += (url.includes('?') ? '&' : '?') + `jobId=${encodeURIComponent(args.job)}`;

  consumeBudget('candidates', 1, 20);

  let { context, page } = await launch({ headless: false });
  const capture = attachCapture(context);
  try {
    log(C.bold('拉取候选人') + C.dim(`  ${shortUrl(url)}  最多 ${limit} 条`));
    page = await navigate(context, page, url);
    await sleep(3500);

    let captured = capture.drain();
    const hit = checkRisk(captured);
    if (hit) throw new RiskControlError(hit);

    if (scrolls > 0) {
      log(C.dim(`滚动加载 ${scrolls} 屏…`));
      captured = captured.concat(await scrollAndCapture(page, capture, { rounds: scrolls }));
    }

    const candidates = collectCandidates(captured, {
      sourcePage: pageKey,
      jobId: args.job || '',
      at: nowIso(),
    }).slice(0, limit);

    if (!candidates.length) {
      persistProbe(captured, 'candidates');
      log(C.yellow('没抽到候选人。可能列表未加载、未登录企业端，或页面结构有变化。'));
      log(C.dim('建议：boss probe --page recommend --seconds 60，看真实接口字段。'));
      return 1;
    }

    const needMask = settings.maskPiiByDefault && !args['no-mask'];
    const shown = needMask ? candidates.map((c) => ({ ...c, name: maskName(c.name) })) : candidates;

    const res = upsertByKey(FILES.candidates, 'candidateKey', candidates);
    writeCsv(path.join(DIRS.clean, 'candidates.csv'), readJsonl(FILES.candidates));

    audit('candidates', { count: candidates.length, page: pageKey, jobId: args.job || '' });
    table(shown.slice(0, 25), ['name', 'age', 'gender', 'appliedJob', 'degree', 'experience', 'expectCity', 'expectSalary']);
    log(
      `\n${C.green('已入库')}  新增 ${res.added} / 更新 ${res.updated} / 累计 ${res.total}` +
        C.dim('  → data/raw/candidates.jsonl, data/clean/candidates.csv')
    );
    await throttle(settings);
    return 0;
  } finally {
    capture.detach();
    await close(context);
  }
}

function buildResumeUrl(ep, candidateKey) {
  const tpl = ep.apis?.resumeUrlTemplate;
  if (!tpl) return null;
  return tpl.replace('{id}', encodeURIComponent(candidateKey));
}

async function cmdResume(args) {
  const settings = loadSettings();
  assertAllowed('resume');
  const ep = readEndpoints();
  const url = args.url || (args.candidate ? buildResumeUrl(ep, args.candidate) : null);
  if (!url) {
    throw new Error('需要 --url <候选人详情页地址>，或 --candidate <ID>（需在 endpoints.json 配 resumeUrlTemplate）');
  }

  consumeBudget('resumes', 1, 30);

  let { context, page } = await launch({ headless: false });
  const capture = attachCapture(context);
  try {
    log(C.bold('打开候选人详情') + C.dim(`  ${shortUrl(url)}`));
    page = await navigate(context, page, url);
    await sleep(4000);
    await page.evaluate(() => window.scrollBy({ top: 1200, behavior: 'smooth' })).catch(() => {});
    await sleep(2500);

    const captured = capture.drain();
    const hit = checkRisk(captured);
    if (hit) throw new RiskControlError(hit);

    const found = findResumeObject(captured);
    let resume;
    if (found) {
      resume = mapResume(found.obj, { sourceUrl: found.url, at: nowIso(), candidateKey: args.candidate });
    } else {
      const dom = await extractResumeTextFromDom(page);
      persistProbe(captured, 'resume');
      log(C.yellow('未捕获到结构化简历 JSON，已退回 DOM 文本抽取。'));
      resume = {
        candidateKey: args.candidate || shortUrl(url),
        name: '',
        rawText: dom.text,
        domSelector: dom.selector,
        sourceUrl: url,
        capturedAt: nowIso(),
      };
    }

    const needMask = settings.maskPiiByDefault && !args['no-mask'];
    const stored = needMask
      ? {
          ...resume,
          name: maskName(resume.name),
          phone: maskPhone(resume.phone),
          email: maskEmail(resume.email),
          wechat: resume.wechat ? maskPhone(resume.wechat) : '',
        }
      : resume;

    if (!stored.candidateKey) stored.candidateKey = shortUrl(url);
    const res = upsertByKey(FILES.resumes, 'candidateKey', [stored]);
    writeCsv(path.join(DIRS.clean, 'resumes.csv'), readJsonl(FILES.resumes));
    audit('resume', { candidateKey: stored.candidateKey, masked: needMask });

    log(`\n${C.bold(stored.name || '(未识别姓名)')}  ${C.dim(stored.candidateKey)}`);
    if (stored.expectPosition) log(`  期望：${stored.expectPosition} / ${stored.expectCity} / ${stored.expectSalary}`);
    if (stored.educations?.length) {
      log(`  教育：${stored.educations.map((e) => `${e.school} ${e.major} ${e.degree}`).join('；')}`);
    }
    if (stored.workExperiences?.length) {
      log('  经历：');
      for (const w of stored.workExperiences.slice(0, 6)) log(`    - ${w.start}~${w.end} ${w.company} ${w.title}`);
    }
    if (stored.rawText) log(C.dim(`  正文 ${stored.rawText.length} 字已保存`));
    log(`\n${C.green('已入库')}  新增 ${res.added} / 更新 ${res.updated} / 累计 ${res.total}`);
    log(C.dim(needMask ? '（个人信息已掩码，加 --no-mask 可存明文）' : '（明文存储，注意保管）'));
    await throttle(settings);
    return 0;
  } finally {
    capture.detach();
    await close(context);
  }
}

async function cmdJobs(args) {
  const settings = loadSettings();
  const ep = readEndpoints();
  const url = args.url || ep.pages?.jobs;
  if (!url) throw new Error('config/endpoints.json 缺少 pages.jobs');

  let { context, page } = await launch({ headless: false });
  const capture = attachCapture(context);
  try {
    page = await navigate(context, page, url);
    await sleep(3500);

    let captured = capture.drain();

    // 职位页不一定能直接打开；沟通页会顺带拉「已沟通职位」接口，作为兜底
    if (!findJobArrays(captured).length && ep.pages?.chat) {
      page = await navigate(context, page, ep.pages.chat);
      await sleep(3000);
      captured = captured.concat(capture.drain());
    }

    captured = captured.concat(await scrollAndCapture(page, capture, { rounds: Number(args.scroll || 2) }));

    const arrays = findJobArrays(captured);
    const byKey = new Map();
    for (const arr of arrays) {
      for (const item of arr.items) {
        const job = mapJob(item, { sourceUrl: arr.url, at: nowIso() });
        const key = job.jobKey || `${job.jobName}|${job.city}`;
        if (!byKey.has(key)) byKey.set(key, job);
      }
    }
    const jobs = [...byKey.values()];
    if (!jobs.length) {
      persistProbe(captured, 'jobs');
      log(C.yellow('没抽到职位列表，建议跑 `boss probe --page jobs` 看接口。'));
      return 1;
    }
    const res = upsertByKey(FILES.jobs, 'jobKey', jobs);
    writeCsv(path.join(DIRS.clean, 'jobs.csv'), readJsonl(FILES.jobs));
    table(jobs, ['jobName', 'status', 'salary', 'city', 'degree', 'experience']);
    log(`\n${C.green('已入库')}  新增 ${res.added} / 更新 ${res.updated} / 累计 ${res.total}`);
    await throttle(settings);
    return 0;
  } finally {
    capture.detach();
    await close(context);
  }
}

function cmdExport(args) {
  const what = args.what || 'candidates';
  const map = {
    candidates: { src: FILES.candidates, out: path.join(DIRS.clean, 'candidates.csv') },
    resumes: { src: FILES.resumes, out: path.join(DIRS.clean, 'resumes.csv') },
    jobs: { src: FILES.jobs, out: path.join(DIRS.clean, 'jobs.csv') },
  };
  const target = map[what];
  if (!target) throw new Error(`未知 --what: ${what}（可选 candidates / resumes / jobs）`);
  const rows = readJsonl(target.src);
  if (!rows.length) {
    log(C.yellow(`没有数据：${target.src}`));
    return 1;
  }
  const out = args.out || target.out;
  const res = writeCsv(out, rows);
  log(`${C.green('已导出')}  ${res.rows} 行 / ${res.columns} 列 → ${out}`);
  return 0;
}

function cmdStats() {
  const candidates = readJsonl(FILES.candidates);
  const jobs = readJsonl(FILES.jobs);
  const resumes = readJsonl(FILES.resumes);
  if (!candidates.length && !jobs.length && !resumes.length) {
    log(C.yellow('暂无数据，先跑 `boss candidates` 或 `boss jobs`。'));
    return 1;
  }

  const count = (rows, field) => {
    const m = new Map();
    for (const r of rows) {
      const v = r[field];
      if (!v) continue;
      m.set(v, (m.get(v) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  const stats = {
    generatedAt: nowIso(),
    totals: { candidates: candidates.length, jobs: jobs.length, resumes: resumes.length },
    byCity: count(candidates, 'expectCity'),
    byDegree: count(candidates, 'degree'),
    byExperience: count(candidates, 'experience'),
    byPosition: count(candidates, 'expectPosition'),
    topSkills: (() => {
      const m = new Map();
      for (const c of candidates) for (const s of c.skills || []) m.set(s, (m.get(s) || 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    })(),
    jobStatus: count(jobs, 'status'),
  };

  const file = path.join(DIRS.clean, 'stats.json');
  writeJson(file, stats);

  log(C.bold('累计'));
  log(`  候选人 ${stats.totals.candidates} / 职位 ${stats.totals.jobs} / 简历 ${stats.totals.resumes}`);
  const show = (title, pairs) => {
    if (!pairs.length) return;
    log(`\n${C.bold(title)}`);
    for (const [k, v] of pairs.slice(0, 8)) log(`  ${k}  ${C.dim(v + ' 人')}`);
  };
  show('城市分布', stats.byCity);
  show('学历分布', stats.byDegree);
  show('经验分布', stats.byExperience);
  show('期望岗位', stats.byPosition);
  if (stats.topSkills.length) {
    log(`\n${C.bold('高频技能')}`);
    log('  ' + stats.topSkills.slice(0, 12).map(([k, v]) => `${k}(${v})`).join('  '));
  }
  log(`\n${C.green('已写入')} ${file}`);
  return 0;
}

async function cmdDoctor() {
  const out = [`${C.bold('环境自检')}`, `  Node ${process.version}`];
  const ok = (s) => out.push(`${C.green('✓')} ${s}`);
  const bad = (s) => out.push(`${C.red('✗')} ${s}`);
  const warn = (s) => out.push(`${C.yellow('!')} ${s}`);

  try {
    await import('playwright-core');
    ok('playwright-core 已安装');
  } catch {
    bad('playwright-core 未安装，请先 npm install');
  }
  if (fs.existsSync(path.join(DIRS.profile, 'Default'))) {
    ok('已存在浏览器 profile（会话可能可复用）');
  } else {
    warn('尚无浏览器 profile，首次请跑 boss login');
  }

  const settings = loadSettings();
  out.push(`  频控：${settings.throttle.minDelayMs}-${settings.throttle.maxDelayMs}ms  单次上限：${settings.limits.maxCandidatesPerRun} 位候选人`);
  out.push(`  今日用量：${JSON.stringify(budgetSnapshot())}`);

  const endpoints = readEndpoints();
  const configured = Object.entries(endpoints.apis || {})
    .filter(([, v]) => v && typeof v === 'object' && v.url)
    .map(([k]) => k);
  out.push(`  已配置直连接口：${configured.length ? configured.join(', ') : C.dim('无（走页面内捕获，功能完整）')}`);

  log(out.join('\n'));
  return 0;
}

function usage() {
  log(`${C.bold('boss')} — BOSS 直聘招聘方助手

${C.bold('用法')}
  boss <命令> [选项]

${C.bold('命令')}
  login        打开企业端，等待你扫码登录并保存会话
  whoami       查看当前登录身份（企业名 / 角色）
  doctor       环境自检
  probe        操作一遍页面，记录所有 JSON 接口，生成接口映射
  jobs         拉取在招职位列表
  candidates   拉取候选人（默认沟通列表；--job 按职位搜索）
  resume       打开候选人详情，抽取结构化简历
  export       把本地数据导出为 CSV
  stats        汇总统计

${C.bold('常用选项')}
  --url <地址>        指定目标页
  --page <名字>       probe 用：recommend|chat|jobs|search|login
  --job <jobId>       按职位筛选候选人
  --candidate <id>    指定候选人
  --limit <n>         本次最多取多少条
  --scroll <n>        滚动加载屏数
  --seconds <n>       probe 采集时长
  --no-mask           简历个人信息存明文（默认掩码）

${C.bold('快速开始')}
  1. npm install && npm link
  2. boss doctor
  3. boss login                 # 扫码登录企业账号
  4. boss probe --page recommend --seconds 60
  5. boss candidates --limit 20
  6. boss stats
`);
  return 0;
}

/* ------------------------------------------------------------------ */

const COMMANDS = {
  login: cmdLogin,
  whoami: cmdWhoami,
  doctor: cmdDoctor,
  probe: cmdProbe,
  jobs: cmdJobs,
  candidates: cmdCandidates,
  resume: cmdResume,
  export: cmdExport,
  stats: cmdStats,
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (!cmd || cmd === 'help' || args.help) return usage();
  const fn = COMMANDS[cmd];
  if (!fn) {
    log(C.red(`未知命令: ${cmd}`));
    usage();
    return 1;
  }

  ensureDirs();
  try {
    return await fn(args);
  } catch (e) {
    if (e instanceof RiskControlError) {
      log('\n' + C.red(e.message));
      audit('risk-control-stop', { command: cmd, message: e.message });
      return 3;
    }
    if (e instanceof PolicyError) {
      log('\n' + C.yellow(e.message));
      audit('policy-denied', { command: cmd, message: e.message, code: e.code });
      return 4;
    }
    log('\n' + C.red('执行失败: ' + (e && e.message ? e.message : String(e))));
    if (process.env.DEBUG) log(e.stack);
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code || 0;
});
