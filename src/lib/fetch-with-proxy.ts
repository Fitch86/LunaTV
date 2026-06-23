/* eslint-disable no-console */

/**
 * 服务器端 HTTP 代理 fetch 工具
 * 用于海外部署场景，通过 HTTP 代理访问国内服务（B站、Bangumi、弹幕API等）
 *
 * 使用方法:
 *   import { fetchWithProxy } from '@/lib/fetch-with-proxy';
 *   const res = await fetchWithProxy('https://api.bilibili.com/...', { headers: {...} });
 *
 * 代理优先级:
 *   1. 函数参数 proxyUrl
 *   2. 环境变量 SERVER_HTTP_PROXY 或 HTTP_PROXY 或 HTTPS_PROXY
 *   3. 无代理直连
 *
 * 管理后台配置的 ServerHttpProxy 会在配置加载时同步到 process.env.SERVER_HTTP_PROXY
 *
 * 实现方式：设置 undici 环境变量让 Node.js 内置 fetch 自动走代理
 * （Node.js 18.7+ 支持 undici 的 GLOBAL_AGENT 方式）
 */

/**
 * 从环境变量获取代理 URL
 */
export function getServerHttpProxyFromEnv(): string {
  return (
    process.env.SERVER_HTTP_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.https_proxy ||
    ''
  );
}

/**
 * 将数据库中的 ServerHttpProxy 同步到环境变量
 * 在配置加载时调用，使 fetchWithProxy 能读到数据库配置的代理
 * @param proxyUrl 从 AdminConfig.SiteConfig.ServerHttpProxy 获取的代理地址
 */
export function syncServerProxyFromConfig(proxyUrl: string): void {
  if (proxyUrl && !process.env.SERVER_HTTP_PROXY) {
    process.env.SERVER_HTTP_PROXY = proxyUrl;
    // 同时设置 HTTP_PROXY 和 HTTPS_PROXY，以便 Node.js 内置 fetch 自动走代理
    if (!process.env.HTTP_PROXY) process.env.HTTP_PROXY = proxyUrl;
    if (!process.env.HTTPS_PROXY) process.env.HTTPS_PROXY = proxyUrl;
    console.log(`🔄 [Proxy] 从数据库配置同步代理: ${proxyUrl}`);
  }
}

/**
 * 更新服务器 HTTP 代理（管理后台保存时调用）
 * @param proxyUrl 新的代理地址
 */
export function updateServerProxy(proxyUrl: string): void {
  const oldProxy = process.env.SERVER_HTTP_PROXY || '';
  process.env.SERVER_HTTP_PROXY = proxyUrl;
  // 同步到 HTTP_PROXY/HTTPS_PROXY，确保 Node.js 内置 fetch 自动走代理
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;

  if (oldProxy !== proxyUrl) {
    console.log(`🔄 [Proxy] 代理地址更新: ${proxyUrl || '(已清除)'}`);
  }
}

/**
 * 判断当前是否在服务器端运行
 */
function isServerSide(): boolean {
  return typeof window === 'undefined';
}

/**
 * 设置 Node.js undici 代理（仅服务器端，启动时调用一次）
 * 通过 undici 的 setGlobalDispatcher 让所有 fetch 自动走代理
 * 仅在检测到代理配置时调用
 */
let proxyInitialized = false;

export async function initProxyDispatcher(): Promise<void> {
  if (!isServerSide() || proxyInitialized) return;

  const proxyUrl = getServerHttpProxyFromEnv();
  if (!proxyUrl) return;

  try {
    // 动态导入 undici，仅在服务器端
    const undici = await import('undici');
    const dispatcher = new undici.ProxyAgent(proxyUrl);
    undici.setGlobalDispatcher(dispatcher);
    proxyInitialized = true;
    console.log(`✅ [Proxy] 全局代理已设置: ${proxyUrl}`);
  } catch (e) {
    console.error(`❌ [Proxy] 设置全局代理失败:`, (e as Error).message);
  }
}

/**
 * 带代理支持的 fetch 封装
 * 通过 initProxyDispatcher 设置全局代理后，所有 Node.js fetch 自动走代理
 * 客户端侧自动降级为普通 fetch
 *
 * @param url 请求 URL
 * @param options fetch 选项
 * @returns Response
 */
export async function fetchWithProxy(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  // 客户端侧不支持代理，直接使用原生 fetch
  if (!isServerSide()) {
    return fetch(url, options);
  }

  // 确保全局代理已初始化
  await initProxyDispatcher();

  // Node.js 内置 fetch 会自动使用 undici 的全局 dispatcher
  return fetch(url, options);
}

/**
 * 获取当前生效的代理 URL（用于日志/调试）
 */
export function getActiveProxyUrl(explicitProxy?: string): string {
  return explicitProxy || getServerHttpProxyFromEnv() || '(无代理)';
}
