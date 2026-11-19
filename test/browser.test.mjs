/**
 * 浏览器层集成测试：验证「真实 Chrome + 响应捕获 + 页面内 fetch + 抽取」整条链。
 * 用本地 HTTP 服务模拟 BOSS 的 JSON 接口，不访问任何真实站点。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { launch, close } from '../scripts/lib/browser.mjs';
import { attachCapture, pageFetch } from '../scripts/lib/net.mjs';
import { collectCandidates, findResumeObject, mapResume } from '../scripts/lib/extract.mjs';

const fixture = JSON.parse(
  fs.readFileSync(new URL('./fixtures/captured.sample.json', import.meta.url), 'utf8')
);

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/list.json')) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(fixture.listResponse));
      return;
    }
    if (req.url.startsWith('/resume.json')) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(fixture.resumeResponse));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><body><h1>mock</h1></body></html>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const isEnvError = (e) =>
  /Connection closed|Protocol error|Target closed|Session closed|spawn|ENOENT|browserType\.launch/i.test(
    String(e && e.message)
  );

test('浏览器层：捕获页面内 fetch 的 JSON 并抽取候选人', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-profile-'));
  const { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;

  let context;
  try {
    ({ context } = await launch({ headless: true, userDataDir }));
  } catch (e) {
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    t.skip(`无法启动 Chrome：${e.message}`);
    return;
  }

  try {
    const page = context.pages()[0] || (await context.newPage());
    const capture = attachCapture(context);

    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });

    const r1 = await pageFetch(page, { url: `${base}/list.json` });
    assert.equal(r1.status, 200, '页面内 fetch 应成功');
    assert.equal(r1.json.zpData.geekList.length, 2);

    // 再走一次浏览器原生 fetch 与 XHR，验证响应监听能覆盖两条通道
    await page.evaluate(async (url) => {
      await fetch(url);
    }, `${base}/resume.json`);

    await page.evaluate(
      (url) =>
        new Promise((resolve) => {
          const x = new XMLHttpRequest();
          x.open('GET', url);
          x.onload = () => resolve();
          x.send();
        }),
      `${base}/list.json`
    );
    await page.waitForTimeout(400);

    const captured = capture.drain();
    assert.ok(captured.length >= 3, `应捕获到响应，实际 ${captured.length}`);

    const candidates = collectCandidates(captured, { at: '2026-01-01T00:00:00Z' });
    assert.equal(candidates.length, 2);
    assert.ok(candidates.some((c) => c.name === '张三'));

    const resume = findResumeObject(captured);
    assert.ok(resume, '应能从捕获池里识别出简历对象');
    assert.equal(mapResume(resume.obj).workExperiences.length, 2);

    assert.equal(capture.drain().length, 0, 'drain 后捕获池应为空');
    capture.detach();
  } catch (e) {
    if (isEnvError(e)) {
      t.skip(`浏览器环境不可用：${e.message}`);
      return;
    }
    throw e;
  } finally {
    await close(context);
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
