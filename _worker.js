/**
 * Cloudflare Worker — GitHub 通用 URL 代理
 *
 * 路由规则：
 *   OPTIONS *                  → CORS 预检
 *   /https://... /http://...   → 通用 URL 代理（git clone / Release / Raw / Archive）
 *   其他路径                     → Pages 静态资源
 */

// ============================================================
// 配置
// ============================================================

const ALLOWED_HOSTS = [
  'github.com', 'api.github.com', 'raw.githubusercontent.com',
  'gist.github.com', 'gist.githubusercontent.com',
  'objects.githubusercontent.com', 'codeload.github.com',
];

const STRIP_REQ_HEADERS = new Set([
  'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
  'cf-ew-via', 'x-forwarded-proto', 'x-real-ip', 'cdn-loop',
]);

const STRIP_RES_HEADERS = new Set([
  'content-security-policy', 'content-security-policy-report-only',
  'x-content-security-policy', 'x-webkit-csp',
]);

const MAX_REDIRECTS = 5;

// ============================================================
// 工具函数
// ============================================================

/** 构建代理请求头：去掉 CF 私有头，替换 Host */
function buildReqHeaders(request, targetUrl) {
  const targetHost = new URL(targetUrl).host;
  const h = new Headers();

  for (const [k, v] of request.headers) {
    if (STRIP_REQ_HEADERS.has(k.toLowerCase())) continue;
    if (k.toLowerCase() === 'host') { h.set('host', targetHost); continue; }
    h.set(k, v);
  }
  if (!h.has('host')) h.set('host', targetHost);

  return h;
}

/** CORS 预检 */
function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    },
  });
}

/** 包装上游响应：加 CORS + 去敏感头 */
function wrapResponse(upstream) {
  const h = new Headers(upstream.headers);
  for (const name of STRIP_RES_HEADERS) h.delete(name);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
  h.set('Access-Control-Allow-Headers', '*');
  h.set('Access-Control-Expose-Headers', '*');
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: h,
  });
}

// ============================================================
// 核心代理（手动处理重定向，避免客户端跳到被封的 CDN）
// ============================================================

async function proxyWithAuth(targetUrl, request, redirectCount = 0) {
  if (redirectCount > MAX_REDIRECTS) {
    return new Response('Too many redirects', { status: 508 });
  }

  const headers = buildReqHeaders(request, targetUrl);

  const upstream = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: request.body,
    redirect: 'manual', // 关键：手动处理重定向
  });

  // ===== CDN / S3 重定向 → 重新代理 =====
  if (upstream.status === 302 || upstream.status === 307 || upstream.status === 301 || upstream.status === 308) {
    const location = upstream.headers.get('Location');
    if (location) {
      // 若目标不在白名单，直接返回原重定向，交给客户端
      let locationUrl;
      try {
        locationUrl = new URL(location, targetUrl).toString();
      } catch {
        return wrapResponse(upstream);
      }

      const redirResp = await proxyWithAuth(locationUrl, request, redirectCount + 1);
      return redirResp;
    }
  }

  return wrapResponse(upstream);
}

// ============================================================
// 主入口
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, search } = url;

    if (request.method === 'OPTIONS') return corsPreflight();

    // —— 通用 URL 代理 (/https://github.com/...) ——
    if (/^\/https?:\/\//.test(pathname)) {
      const targetUrl = pathname.slice(1) + (search || '');
      // 目标域名不在白名单里就拒绝
      try {
        const targetHost = new URL(targetUrl).hostname;
        if (!ALLOWED_HOSTS.includes(targetHost)) {
          return new Response(`Error: domain "${targetHost}" not allowed.\n`, { status: 400 });
        }
      } catch {
        return new Response('Error: invalid target URL.\n', { status: 400 });
      }
      return proxyWithAuth(targetUrl, request, 0);
    }

    // —— 静态资源 ——
    try {
      const assetsResp = await env.ASSETS.fetch(request);
      // 如果路径不含扩展名，且 ASSETS 返回了 404，尝试追加 .html
      if (assetsResp.status === 404 && !pathname.includes('.')) {
        const htmlUrl = new URL(request.url);
        htmlUrl.pathname = pathname + '.html';
        const htmlResp = await env.ASSETS.fetch(new Request(htmlUrl, request));
        if (htmlResp.status !== 404) return htmlResp;
      }
      return assetsResp;
    } catch (_) {
      return new Response('Not Found', { status: 404 });
    }
  },
};
