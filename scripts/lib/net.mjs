/**
 * 网络层。
 *
 * 1) attachCapture —— 监听 context 上所有 JSON 响应，做结构化捕获。
 *    不依赖接口 URL 是否已知，接口改名/换版本照样工作。
 *
 * 2) pageFetch —— 在页面上下文里发请求，自动带真实 Cookie、__zp_stoken__ 与浏览器指纹。
 *    这是本项目「不逆向加密」的关键：签名由浏览器自己算。
 */

const isJsonResponse = (res) => {
  const ct = (res.headers()['content-type'] || '').toLowerCase();
  if (ct.includes('json')) return true;
  return false;
};

export function attachCapture(context, { maxEntries = 400 } = {}) {
  const bucket = [];
  let detached = false;

  const handler = (res) => {
    if (detached) return;
    if (!isJsonResponse(res)) return;
    res
      .json()
      .then((json) => {
        if (detached) return;
        if (bucket.length >= maxEntries) bucket.shift();
        bucket.push({ url: res.url(), at: Date.now(), json });
      })
      .catch(() => {
        /* body 不可读（重定向 / 已释放），忽略 */
      });
  };

  context.on('response', handler);

  return {
    drain() {
      return bucket.splice(0, bucket.length);
    },
    size() {
      return bucket.length;
    },
    detach() {
      detached = true;
      context.off('response', handler);
    },
  };
}

/** 在页面上下文里发请求，复用真实会话 */
export async function pageFetch(page, { url, method = 'GET', body, headers = {} } = {}) {
  if (!url) throw new Error('pageFetch 需要 url');
  const hdrs = { ...headers };
  if (method !== 'GET') hdrs['content-type'] = hdrs['content-type'] || 'application/json';

  return page.evaluate(
    async (opt) => {
      try {
        const r = await fetch(opt.url, {
          method: opt.method,
          headers: opt.headers,
          body: opt.body ?? undefined,
          credentials: 'include',
        });
        const text = await r.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not json */
        }
        return { ok: r.ok, status: r.status, json, text: text.slice(0, 4000) };
      } catch (e) {
        return { ok: false, status: 0, error: String((e && e.message) || e) };
      }
    },
    { url, method, headers: hdrs, body: body ?? null }
  );
}
