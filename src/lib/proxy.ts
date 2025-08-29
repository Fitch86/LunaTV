/**
 * TVCors代理服务工具函数
 * 用于构建外部tvcors-proxy服务的URL
 */

/**
 * 代理服务类型枚举
 */
export enum ProxyType {
  M3U8 = 'm3u8',
  M3U = 'm3u',
  SEGMENT = 'segment',
  KEY = 'key',
  LOGO = 'logo',
  XTREAM = 'xtream',
  STALKER = 'stalker',
}

/**
 * 代理请求参数接口
 */
export interface ProxyParams {
  url: string;
  [key: string]: string | number | boolean | undefined;
}

/**
 * 获取TVCors代理服务的基础URL
 * @returns 代理服务基础URL
 */
export function getTVCorsProxyBaseURL(): string {
  // 从环境变量获取，优先使用NEXT_PUBLIC_前缀的变量（客户端可用）
  const proxyUrl =
    process.env.NEXT_PUBLIC_TVCORS_PROXY_URL ||
    process.env.TVCORS_PROXY_URL ||
    'http://localhost:3001';

  // 确保URL不以斜杠结尾
  return proxyUrl.endsWith('/') ? proxyUrl.slice(0, -1) : proxyUrl;
}

/**
 * 构建代理URL
 * @param type 代理类型
 * @param params 代理参数
 * @returns 完整的代理URL
 */
export function buildProxyURL(type: ProxyType, params: ProxyParams): string {
  const baseURL = getTVCorsProxyBaseURL();
  const url = new URL(`${baseURL}/api/proxy/${type}`);

  // 添加查询参数
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      // URL参数需要编码
      if (key === 'url') {
        url.searchParams.set(key, encodeURIComponent(value.toString()));
      } else {
        url.searchParams.set(key, value.toString());
      }
    }
  });

  return url.toString();
}

/**
 * 构建M3U8代理URL
 * @param videoUrl 视频流URL
 * @param source 直播源标识（可选）
 * @param allowCORS 是否允许CORS（可选）
 * @returns M3U8代理URL
 */
export function buildM3U8ProxyURL(
  videoUrl: string,
  source?: string,
  allowCORS?: boolean
): string {
  const params: ProxyParams = { url: videoUrl };

  if (source) {
    params['moontv-source'] = source;
  }

  if (allowCORS !== undefined) {
    params.allowCORS = allowCORS;
  }

  return buildProxyURL(ProxyType.M3U8, params);
}

/**
 * 构建M3U代理URL（用于直播源列表）
 * @param m3uUrl M3U文件URL
 * @param source 直播源标识（可选）
 * @returns M3U代理URL
 */
export function buildM3UProxyURL(m3uUrl: string, source?: string): string {
  const params: ProxyParams = { url: m3uUrl };

  if (source) {
    params['moontv-source'] = source;
  }

  return buildProxyURL(ProxyType.M3U, params);
}

/**
 * 构建视频片段代理URL
 * @param segmentUrl 视频片段URL
 * @param source 直播源标识（可选）
 * @returns 视频片段代理URL
 */
export function buildSegmentProxyURL(
  segmentUrl: string,
  source?: string
): string {
  const params: ProxyParams = { url: segmentUrl };

  if (source) {
    params['moontv-source'] = source;
  }

  return buildProxyURL(ProxyType.SEGMENT, params);
}

/**
 * 构建密钥代理URL
 * @param keyUrl 密钥文件URL
 * @param source 直播源标识（可选）
 * @returns 密钥代理URL
 */
export function buildKeyProxyURL(keyUrl: string, source?: string): string {
  const params: ProxyParams = { url: keyUrl };

  if (source) {
    params['moontv-source'] = source;
  }

  return buildProxyURL(ProxyType.KEY, params);
}

/**
 * 构建Logo图片代理URL
 * @param logoUrl 图片URL
 * @param source 直播源标识（可选）
 * @returns Logo代理URL
 */
export function buildLogoProxyURL(logoUrl: string, source?: string): string {
  const params: ProxyParams = { url: logoUrl };

  if (source) {
    params['moontv-source'] = source;
  }

  return buildProxyURL(ProxyType.LOGO, params);
}

/**
 * 构建Xtream代理URL
 * @param apiUrl Xtream API URL
 * @param username 用户名（可选）
 * @param password 密码（可选）
 * @param action 操作类型（可选）
 * @param additionalParams 额外参数（可选）
 * @returns Xtream代理URL
 */
export function buildXtreamProxyURL(
  apiUrl: string,
  username?: string,
  password?: string,
  action?: string,
  additionalParams?: Record<string, string | number | boolean>
): string {
  const params: ProxyParams = { url: apiUrl };

  if (username) params.username = username;
  if (password) params.password = password;
  if (action) params.action = action;

  // 添加额外参数
  if (additionalParams) {
    Object.assign(params, additionalParams);
  }

  return buildProxyURL(ProxyType.XTREAM, params);
}

/**
 * 构建Stalker代理URL
 * @param portalUrl Stalker Portal URL
 * @param macAddress MAC地址（可选）
 * @param additionalParams 额外参数（可选）
 * @returns Stalker代理URL
 */
export function buildStalkerProxyURL(
  portalUrl: string,
  macAddress?: string,
  additionalParams?: Record<string, string | number | boolean>
): string {
  const params: ProxyParams = { url: portalUrl };

  if (macAddress) params.macAddress = macAddress;

  // 添加额外参数
  if (additionalParams) {
    Object.assign(params, additionalParams);
  }

  return buildProxyURL(ProxyType.STALKER, params);
}

/**
 * 检查TVCors代理服务是否可用
 * @returns Promise<boolean> 服务是否可用
 */
export async function checkTVCorsProxyHealth(): Promise<boolean> {
  try {
    const baseURL = getTVCorsProxyBaseURL();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5秒超时

    const response = await fetch(`${baseURL}/`, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('TVCors代理服务健康检查失败:', error);
    return false;
  }
}

/**
 * 获取代理服务配置信息（用于调试）
 * @returns 配置信息对象
 */
export function getProxyDebugInfo() {
  return {
    baseURL: getTVCorsProxyBaseURL(),
    publicEnvVar: process.env.NEXT_PUBLIC_TVCORS_PROXY_URL,
    serverEnvVar: process.env.TVCORS_PROXY_URL,
    isProduction: process.env.NODE_ENV === 'production',
  };
}
