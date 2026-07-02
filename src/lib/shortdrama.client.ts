/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import {
  getCache,
  getCacheKey,
  setCache,
  SHORTDRAMA_CACHE_EXPIRE,
} from './shortdrama-cache';
import {
  ShortDramaCategory,
  ShortDramaItem,
  ShortDramaParseResult,
} from './types';

const SHORTDRAMA_API_BASE = 'https://tyyszyapi.com/api.php/provide/vod';

// 检测是否为移动端环境
const isMobile = () => {
  if (typeof window === 'undefined') return false;
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  );
};

// 获取 API 基础 URL - 所有环境都使用内部 API 路由
const getApiBase = (endpoint: string) => {
  return `/api/shortdrama${endpoint}`;
};

// 获取短剧分类列表
export async function getShortDramaCategories(): Promise<ShortDramaCategory[]> {
  const cacheKey = getCacheKey('categories', {});

  try {
    // 临时禁用缓存进行测试 - 移动端强制刷新
    if (!isMobile()) {
      const cached = await getCache(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const apiUrl = getApiBase('/categories');

    // 统一使用内部 API 路由
    const fetchOptions: RequestInit = {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
      },
    };

    const response = await fetch(apiUrl, fetchOptions);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    // 内部 API 直接返回数组
    const result: ShortDramaCategory[] = data;

    // 缓存结果
    await setCache(cacheKey, result, SHORTDRAMA_CACHE_EXPIRE.categories);
    return result;
  } catch (error) {
    console.error('获取短剧分类失败:', error);
    return [];
  }
}

// 获取推荐短剧列表
export async function getRecommendedShortDramas(
  category?: number,
  size = 10
): Promise<ShortDramaItem[]> {
  const cacheKey = getCacheKey('recommends', { category, size });

  try {
    // 临时禁用缓存进行测试 - 移动端强制刷新
    if (!isMobile()) {
      const cached = await getCache(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const apiUrl = getApiBase(
      `/recommend?${category ? `category=${category}&` : ''}size=${size}`
    );

    // 统一使用内部 API 路由
    const fetchOptions: RequestInit = {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
      },
    };

    const response = await fetch(apiUrl, fetchOptions);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    // 内部 API 直接返回数组
    const result: ShortDramaItem[] = Array.isArray(data) ? data : [];

    // 缓存结果
    await setCache(cacheKey, result, SHORTDRAMA_CACHE_EXPIRE.recommends);
    return result;
  } catch (error) {
    console.error('获取推荐短剧失败:', error);
    return [];
  }
}

// 获取分类短剧列表（分页）
export async function getShortDramaList(
  category: number,
  page = 1,
  size = 20
): Promise<{ list: ShortDramaItem[]; hasMore: boolean }> {
  const cacheKey = getCacheKey('lists', { category, page, size });

  try {
    // 临时禁用缓存进行测试 - 移动端强制刷新
    if (!isMobile()) {
      const cached = await getCache(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const apiUrl = getApiBase(
      `/list?categoryId=${category}&page=${page}&size=${size}`
    );

    // 统一使用内部 API 路由
    const fetchOptions: RequestInit = {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
      },
    };

    const response = await fetch(apiUrl, fetchOptions);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    // 内部 API 直接返回结果
    const result: { list: ShortDramaItem[]; hasMore: boolean } = data;

    // 缓存结果 - 第一页缓存时间更长
    const cacheTime =
      page === 1
        ? SHORTDRAMA_CACHE_EXPIRE.lists * 2
        : SHORTDRAMA_CACHE_EXPIRE.lists;
    await setCache(cacheKey, result, cacheTime);
    return result;
  } catch (error) {
    console.error('获取短剧列表失败:', error);
    return { list: [], hasMore: false };
  }
}

// 搜索短剧
export async function searchShortDramas(
  query: string,
  page = 1,
  size = 20
): Promise<{ list: ShortDramaItem[]; hasMore: boolean }> {
  try {
    const apiUrl = getApiBase(
      `/search?query=${encodeURIComponent(query)}&page=${page}&size=${size}`
    );

    // 统一使用内部 API 路由
    const fetchOptions: RequestInit = {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
      },
    };

    const response = await fetch(apiUrl, fetchOptions);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    // 内部 API 直接返回结果
    const result: { list: ShortDramaItem[]; hasMore: boolean } = data;

    return result;
  } catch (error) {
    console.error('搜索短剧失败:', error);
    return { list: [], hasMore: false };
  }
}

// 解析单集视频（支持跨域代理）
export async function parseShortDramaEpisode(
  id: number,
  episode: number,
  useProxy = true,
  alternativeApiUrl?: string
): Promise<ShortDramaParseResult> {
  try {
    const params = new URLSearchParams({
      id: id.toString(), // API需要string类型的id
      episode: episode.toString(), // episode从1开始
    });

    if (useProxy) {
      params.append('proxy', 'true');
    }
    if (alternativeApiUrl) {
      params.append('altApi', alternativeApiUrl);
    }

    const timestamp = Date.now();
    const apiUrl = isMobile()
      ? `/api/shortdrama/parse?${params.toString()}&_t=${timestamp}`
      : `${SHORTDRAMA_API_BASE}/vod/parse/single?${params.toString()}`;

    const fetchOptions: RequestInit = isMobile()
      ? {
          cache: 'no-store',
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            Pragma: 'no-cache',
            Expires: '0',
          },
        }
      : {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            Accept: 'application/json',
          },
          mode: 'cors',
        };

    const response = await fetch(apiUrl, fetchOptions);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    // API可能返回错误信息
    if (data.code === 1) {
      return {
        code: data.code,
        msg: data.msg || '解析失败',
      };
    }

    // API成功时直接返回数据对象，根据实际结构解析
    return {
      code: 0,
      data: {
        videoId: data.videoId || id,
        videoName: data.videoName || '',
        currentEpisode: data.episode?.index || episode,
        totalEpisodes: data.totalEpisodes || 1,
        parsedUrl: data.episode?.parsedUrl || data.parsedUrl || '',
        proxyUrl: data.episode?.proxyUrl || '', // proxyUrl在episode对象内
        cover: data.cover || '',
        description: data.description || '',
        episode: data.episode || null, // 保留原始episode对象
      },
    };
  } catch (error) {
    console.error('解析短剧集数失败:', error);
    return {
      code: -1,
      msg: '网络请求失败',
    };
  }
}

// 批量解析多集视频
export async function parseShortDramaBatch(
  id: number,
  episodes: number[],
  useProxy = true
): Promise<ShortDramaParseResult[]> {
  try {
    const params = new URLSearchParams({
      id: id.toString(),
      episodes: episodes.join(','),
    });

    if (useProxy) {
      params.append('proxy', 'true');
    }

    const timestamp = Date.now();
    const apiUrl = isMobile()
      ? `/api/shortdrama/parse?${params.toString()}&_t=${timestamp}`
      : `${SHORTDRAMA_API_BASE}/vod/parse/batch?${params.toString()}`;

    const fetchOptions: RequestInit = isMobile()
      ? {
          cache: 'no-store',
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            Pragma: 'no-cache',
            Expires: '0',
          },
        }
      : {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            Accept: 'application/json',
          },
          mode: 'cors',
        };

    const response = await fetch(apiUrl, fetchOptions);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return data.results || [];
  } catch (error) {
    console.error('批量解析短剧失败:', error);
    return [];
  }
}

// 解析整部短剧所有集数
export async function parseShortDramaAll(
  id: number,
  useProxy = true
): Promise<ShortDramaParseResult[]> {
  try {
    const params = new URLSearchParams({
      id: id.toString(),
    });

    if (useProxy) {
      params.append('proxy', 'true');
    }

    const timestamp = Date.now();
    const apiUrl = isMobile()
      ? `/api/shortdrama/parse?${params.toString()}&_t=${timestamp}`
      : `${SHORTDRAMA_API_BASE}/vod/parse/all?${params.toString()}`;

    const fetchOptions: RequestInit = isMobile()
      ? {
          cache: 'no-store',
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            Pragma: 'no-cache',
            Expires: '0',
          },
        }
      : {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            Accept: 'application/json',
          },
          mode: 'cors',
        };

    const response = await fetch(apiUrl, fetchOptions);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return data.results || [];
  } catch (error) {
    console.error('解析完整短剧失败:', error);
    return [];
  }
}
