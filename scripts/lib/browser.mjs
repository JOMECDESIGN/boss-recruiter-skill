/**
 * 真实 Chrome + 持久化用户目录（Playwright 驱动）。
 *
 * 为什么用 playwright-core + channel:'chrome'：
 * - 直接驱动你本机安装的 Chrome，不是下载的 Chromium，指纹与日常浏览一致；
 * - 登录态存在独立 profile 目录里，一次扫码长期复用；
 * - playwright-core 不下载浏览器，体积小。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { DIRS, FILES, ensureDirs, readJson, sleep } from './util.mjs';

export const CHROME_CHANNEL = process.env.BOSS_CHANNEL || 'chrome';

/**
 * 上一个 Chrome 没退干净时，profile 目录会被锁住。
 * 此时新的 launch 会把导航命令转发给那个「不受控」的旧实例，
 * 表现是 HTTP 200 但页面停在 about:blank —— 非常难排查。
 * 所以启动前先确认锁的持有者是否还活着，死了就清锁，活着就明确报错。
 */
function ensureProfileFree(dir) {
  const lockPath = path.join(dir, 'SingletonLock');
  if (!fs.existsSync(lockPath)) return { cleared: false };

  let target = '';
  try {
    target = fs.readlinkSync(lockPath);
  } catch {
    /* 非符号链接，按损坏处理 */
  }
  const pid = Number((/-(\d+)$/.exec(target) || [])[1] || 0);

  let alive = false;
  if (pid) {
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
  }

  if (alive) {
    throw new Error(
      `浏览器正在被另一个进程占用（PID ${pid}）。请先关闭那个 Chrome 窗口再重试；` +
        `若确认已关闭，可手动删除 ${dir}/Singleton* 后重试。`
    );
  }

  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      /* ignore */
    }
  }
  return { cleared: true, pid };
}

export async function launch({ headless = false, userDataDir = DIRS.profile } = {}) {
  ensureDirs();
  fs.mkdirSync(userDataDir, { recursive: true });
  ensureProfileFree(userDataDir);

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: CHROME_CHANNEL,
    headless,
    viewport: null,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--lang=zh-CN',
      '--window-size=1440,960',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  context.setDefaultTimeout(30_000);
  context.setDefaultNavigationTimeout(45_000);

  const page = context.pages()[0] || (await context.newPage());
  return { context, page, browser: context };
}

export async function close(context) {
  try {
    await context.close();
  } catch {
    /* ignore */
  }
}

const SESSION_COOKIE_HINTS = ['zp_at', '__zp_stoken__', 'wt2', 't'];

export async function getCookies(context) {
  try {
    return await context.cookies('https://www.zhipin.com');
  } catch {
    try {
      return await context.cookies();
    } catch {
      return [];
    }
  }
}

export async function getSessionState(context) {
  const cookies = await getCookies(context);
  const names = new Set(cookies.map((c) => c.name));
  const hints = SESSION_COOKIE_HINTS.filter((n) => names.has(n));
  return {
    loggedIn: hints.length >= 1,
    hints,
    cookieCount: cookies.length,
    cookieNames: [...names].sort(),
    profileDir: DIRS.profile,
    profileExists: fs.existsSync(path.join(DIRS.profile, 'Default')),
  };
}

/** 全站 Cookie 字符串，供你本地复用（不外传） */
export async function cookieHeader(context) {
  const cookies = await getCookies(context);
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

export function readEndpoints() {
  return readJson(FILES.endpoints, {}) || {};
}

/**
 * 企业端是 SPA，跳转过程中常自己新开页面、把旧页留在 about:blank。
 * 因此每次导航后都要重新定位「真正在 zhipin.com 上的那个页面」，
 * 否则后续 evaluate / 滚动都打在空白页上，表现为「抓不到数据」。
 */
export async function pickWorkPage(context, fallback, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let withContent = null;

  while (Date.now() < deadline) {
    const pages = context.pages().filter((p) => !p.isClosed());

    // 优先：URL 落在站点上
    const onSite = pages.filter((p) => /zhipin\.com/.test(p.url()));
    if (onSite.length) return onSite[onSite.length - 1];

    // 兜底：Chrome 157 上句柄的 url() 有时不更新（一直报 about:blank），
    // 但 DOM 是活的，所以改按正文长度判断哪个页面才是真正在工作的。
    for (const p of pages) {
      const len = await p.evaluate(() => document.body?.innerText?.length || 0).catch(() => 0);
      if (len > 200) withContent = p;
    }
    if (withContent) return withContent;

    await sleep(400);
  }

  const pages = context.pages().filter((p) => !p.isClosed());
  return withContent || fallback || pages[pages.length - 1];
}

/**
 * 导航 + 落点校验。
 *
 * 实测：persistent profile 恢复会话时，goto 可能返回 200 但页面停在 about:blank
 * （时序问题，非确定性）。因此每次导航后都要确认「当前页 URL 落在目标域名」，
 * 不满足就换一个干净标签页重试，而不是盲信 goto 的返回值。
 */
export async function navigate(context, page, url, { settleMs = 1500, attempts = 2 } = {}) {
  const wantHost = new URL(url).host.replace(/^www\./, '');
  let current = page;

  for (let i = 0; i < attempts; i += 1) {
    try {
      await current.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch {
      /* 失败也继续校验落点，有的情况下页面其实已经到了 */
    }
    await sleep(settleMs);

    const landed = await pickWorkPage(context, current, { timeoutMs: 4000 });
    const u = landed.url();
    const bodyLen = await landed.evaluate(() => document.body?.innerText?.length || 0).catch(() => 0);
    if (u.includes(wantHost) || bodyLen > 200) return landed;

    current = await context.newPage();
  }

  return pickWorkPage(context, current, { timeoutMs: 2000 });
}
