'use client';

export interface BangumiCalendarData {
  weekday: {
    en: string;
  };
  items: {
    id: number;
    name: string;
    name_cn: string;
    rating: {
      score: number;
    };
    air_date: string;
    images: {
      large: string;
      common: string;
      medium: string;
      small: string;
      grid: string;
    };
  }[];
}

/**
 * 获取番剧数据代理配置
 * 优先使用独立的番剧代理设置，如未设置则回退到豆瓣代理设置
 */
function getBangumiProxyConfig(): {
  proxy: string;
  proxyUrl: string;
} {
  // 优先使用番剧专用设置
  let proxyType =
    localStorage.getItem('bangumiDataSource') ||
    (window as any).RUNTIME_CONFIG?.BANGUMI_PROXY_TYPE ||
    '';

  let proxyUrl =
    localStorage.getItem('bangumiProxyUrl') ||
    (window as any).RUNTIME_CONFIG?.BANGUMI_PROXY ||
    '';

  // 如果没有番剧专用设置，回退到豆瓣数据源代理
  if (!proxyType) {
    proxyType =
      localStorage.getItem('doubanDataSource') ||
      (window as any).RUNTIME_CONFIG?.DOUBAN_PROXY_TYPE ||
      'direct';

    proxyUrl =
      localStorage.getItem('doubanProxyUrl') ||
      (window as any).RUNTIME_CONFIG?.DOUBAN_PROXY ||
      '';

    // cmliussss-cdn 仅适用于豆瓣 API，番剧不可用，回退到直连
    if (proxyType === 'cmliussss-cdn-tencent' || proxyType === 'cmliussss-cdn-ali') {
      proxyType = 'direct';
      proxyUrl = '';
    }
  }

  // cmliussss-cdn 仅适用于豆瓣 API（作为番剧数据源代理回退时跳过）
  // 但番剧专用设置中 cmliussss-cdn 可用（通过反代）
  if (proxyType === 'cmliussss-cdn-tencent' || proxyType === 'cmliussss-cdn-ali') {
    // 判断是否来自番剧专用设置（有值）还是回退自豆瓣设置
    const fromBangumiSetting =
      localStorage.getItem('bangumiDataSource') ||
      (window as any).RUNTIME_CONFIG?.BANGUMI_PROXY_TYPE;
    if (!fromBangumiSetting) {
      proxyType = 'direct';
      proxyUrl = '';
    }
  }

  // 可用于番剧的代理类型
  if (['cors-proxy-zwei', 'cors-anywhere', 'custom'].includes(proxyType)) {
    return { proxy: proxyType, proxyUrl };
  }

  // direct 或未知类型
  return { proxy: '', proxyUrl: '' };
}

/**
 * 通过服务器代理获取番剧数据
 * 服务器端支持直连和 CORS 代理两种模式
 */
async function fetchBangumiViaServer(path: string): Promise<BangumiCalendarData[]> {
  const { proxy, proxyUrl } = getBangumiProxyConfig();

  let url = `/api/proxy/bangumi?path=${path}`;
  // 将客户端的代理配置传递给服务端
  if (proxy) {
    url += `&proxy=${encodeURIComponent(proxy)}`;
  }
  if (proxyUrl) {
    url += `&proxyUrl=${encodeURIComponent(proxyUrl)}`;
  }

  const response = await fetch(url);

  if (!response.ok) {
    console.error('番剧数据请求失败:', response.status);
    return [];
  }

  const data = await response.json();

  if (!Array.isArray(data)) {
    console.error('番剧数据格式异常');
    return [];
  }

  return data;
}

export async function GetBangumiCalendarData(): Promise<BangumiCalendarData[]> {
  try {
    return await fetchBangumiViaServer('calendar');
  } catch (error) {
    console.error('获取番剧数据失败:', error);
    return [];
  }
}
