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
import { DIRS, ensureDirs, readJson } from './util.mjs';

export const CHROME_CHANNEL = process.env.BOSS_CHANNEL || 'chrome';

export async function launch({ headless = false, userDataDir = DIRS.profile } = {}) {
  ensureDirs();
  fs.mkdirSync(userDataDir, { recursive: true });

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
  return readJson(DIRS.endpoints, {}) || {};
}
