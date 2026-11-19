/**
 * 临时脚本：看清沟通列表的真实 DOM/文本结构。
 */
import { launch, close, readEndpoints } from './scripts/lib/browser.mjs';
import { sleep } from './scripts/lib/util.mjs';

const ep = readEndpoints();
const { context } = await launch({ headless: false });

async function openSitePage(url, tries = 4) {
  for (let i = 0; i < tries; i += 1) {
    const p = await context.newPage();
    try {
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    } catch {
      /* ignore */
    }
    await sleep(3000);
    const len = await p.evaluate(() => document.body?.innerText?.length || 0).catch(() => 0);
    if (len > 200) return p;
    await p.close().catch(() => {});
  }
  throw new Error('拿不到可用页面');
}

try {
  const page = await openSitePage(ep.pages.chat);
  await sleep(4000);

  const info = await page.evaluate(() => {
    const texts = [...document.querySelectorAll('*')]
      .filter((el) => el.children.length === 0 && (el.innerText || '').trim())
      .slice(0, 400)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { t: el.innerText.trim().slice(0, 24), cls: String(el.className || '').slice(0, 30), x: Math.round(r.x), y: Math.round(r.y) };
      })
      .filter((x) => x.x < window.innerWidth * 0.45 && x.y > 60);
    return { total: texts.length, sample: texts.slice(0, 40), w: window.innerWidth, h: window.innerHeight };
  });

  console.log(`视口 ${info.w}x${info.h} | 左侧文本节点 ${info.total} 个`);
  info.sample.forEach((x) => console.log(`  y=${String(x.y).padStart(4)} x=${String(x.x).padStart(3)} [${x.cls}] ${x.t}`));
} finally {
  await close(context);
}
