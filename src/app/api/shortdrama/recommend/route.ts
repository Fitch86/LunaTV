/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { DEFAULT_USER_AGENT } from '@/lib/user-agent';

// 强制动态路由，禁用所有缓存
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

// 默认短剧源
const DEFAULT_SHORT_DRAMA_API = 'https://tyyszyapi.com/api.php/provide/vod';

// 🔥 短剧关键词（学习 SeeTV）：除了父分类"短剧"，子分类也包含短剧内容
const SHORT_DRAMA_KEYWORDS = ['短剧', '女频恋爱', '反转爽剧', '古装仙侠', '年代穿越', '脑洞悬疑', '现代都市'];
const FALLBACK_CATEGORY_IDS = [54, 73, 64, 65, 66, 67, 68, 69];

// 从某个分类下取数据
async function fetchFromCategory(api: string, categoryId: number, size: number): Promise<any[]> {
  const apiUrl = `${api}?ac=detail&t=${categoryId}&pg=1`;

  const response = await fetch(apiUrl, {
    headers: { 'User-Agent': DEFAULT_USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = await response.json();
  const items = data.list || [];

  return items.slice(0, size).map((item: any) => ({
    id: item.vod_id,
    name: item.vod_name,
    cover: item.vod_pic || '',
    update_time: item.vod_time || new Date().toISOString(),
    score: parseFloat(item.vod_score) || 0,
    episode_count: parseInt(item.vod_remarks?.replace(/[^\d]/g, '') || '1'),
    description: item.vod_content || item.vod_blurb || '',
    author: item.vod_actor || '',
    backdrop: item.vod_pic_slide || item.vod_pic || '',
    vote_average: parseFloat(item.vod_score) || 0,
  }));
}

// 🔥 智能获取推荐短剧：多级兜底（学习 SeeTV）
async function fetchRecommendsForApi(api: string, size: number): Promise<any[]> {
  // Step 1: 获取分类列表找到短剧相关分类
  let listData: any = null;
  try {
    const listResponse = await fetch(`${api}?ac=list`, {
      headers: { 'User-Agent': DEFAULT_USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (listResponse.ok) {
      listData = await listResponse.json().catch(() => null);
    }
  } catch {
    // ignore
  }

  const categories: any[] = listData?.class || [];
  const matchedCategories = categories.filter((cat: any) =>
    cat.type_name && SHORT_DRAMA_KEYWORDS.some((kw: string) => cat.type_name.includes(kw))
  );

  // Step 2: 优先"短剧"父分类
  const primary = matchedCategories.find((cat: any) => cat.type_name === '短剧') || matchedCategories[0];

  if (primary) {
    console.log(`📡 [RECOMMEND] 尝试主分类 ${primary.type_id} (${primary.type_name})`);
    try {
      const items = await fetchFromCategory(api, primary.type_id, size);
      if (items.length > 0) return items;
    } catch (err) {
      console.warn(`主分类失败:`, err);
    }
  }

  // Step 3: 尝试其他子分类
  for (const alt of matchedCategories) {
    if (primary && alt.type_id === primary.type_id) continue;
    console.log(`📡 [RECOMMEND] 尝试子分类 ${alt.type_id} (${alt.type_name})`);
    try {
      const items = await fetchFromCategory(api, alt.type_id, size);
      if (items.length > 0) return items;
    } catch {
      // ignore
    }
  }

  // Step 4: 硬编码兜底分类 ID
  for (const fid of FALLBACK_CATEGORY_IDS) {
    if (primary && fid === primary.type_id) continue;
    console.log(`📡 [RECOMMEND] 硬编码兜底分类 ${fid}`);
    try {
      const items = await fetchFromCategory(api, fid, size);
      if (items.length > 0) return items;
    } catch {
      // ignore
    }
  }

  return [];
}

// 服务端专用函数，从所有短剧源聚合数据
async function getRecommendedShortDramasInternal(
  category?: number,
  size = 10
) {
  try {
    const config = await getConfig();

    const shortDramaSources = (config.SourceConfig || []).filter(
      (source: any) => source.type === 'shortdrama' && !source.disabled
    );

    console.log(`📺 找到 ${shortDramaSources.length} 个配置的短剧源`);

    if (shortDramaSources.length === 0) {
      const baseUrl = config.ShortDramaConfig?.primaryApiUrl || DEFAULT_SHORT_DRAMA_API;
      console.log('📺 使用短剧源：', baseUrl);
      return await fetchRecommendsForApi(baseUrl, size);
    }

    console.log('📺 聚合多个短剧源的数据');
    const results = await Promise.allSettled(
      shortDramaSources.map((source: any) => {
        console.log(`🔄 请求短剧源: ${source.name}`);
        return fetchRecommendsForApi(source.api, size);
      })
    );

    const allItems: any[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        console.log(`✅ ${shortDramaSources[index].name}: 获取到 ${result.value.length} 条数据`);
        allItems.push(...result.value);
      } else {
        console.error(`❌ ${shortDramaSources[index].name}: 请求失败`, result.reason);
      }
    });

    const uniqueItems = Array.from(
      new Map(allItems.map((item: any) => [item.name, item])).values()
    );
    uniqueItems.sort((a: any, b: any) =>
      new Date(b.update_time).getTime() - new Date(a.update_time).getTime()
    );

    const finalItems = uniqueItems.slice(0, size);
    console.log(`📊 最终返回 ${finalItems.length} 条短剧数据`);
    return finalItems;
  } catch (error) {
    console.error('获取短剧推荐失败:', error);
    try {
      console.log('⚠️ 出错，fallback到默认源');
      const config = await getConfig();
      return await fetchRecommendsForApi(config.ShortDramaConfig?.primaryApiUrl || DEFAULT_SHORT_DRAMA_API, size);
    } catch (fallbackError) {
      console.error('默认源也失败:', fallbackError);
      return [];
    }
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const category = searchParams.get('category');
    const size = searchParams.get('size');

    const categoryNum = category ? parseInt(category) : undefined;
    const pageSize = size ? parseInt(size) : 10;

    if ((category && isNaN(categoryNum!)) || isNaN(pageSize)) {
      return NextResponse.json({ error: '参数格式错误' }, { status: 400 });
    }

    const result = await getRecommendedShortDramasInternal(categoryNum, pageSize);

    const response = NextResponse.json(result);
    const cacheTime = 7200;
    response.headers.set('Cache-Control', `public, max-age=${cacheTime}, s-maxage=${cacheTime}`);
    response.headers.set('CDN-Cache-Control', `public, s-maxage=${cacheTime}`);
    response.headers.set('Vercel-CDN-Cache-Control', `public, s-maxage=${cacheTime}`);
    response.headers.set('Vary', 'Accept-Encoding, User-Agent');
    return response;
  } catch (error) {
    console.error('获取推荐短剧失败:', error);
    return NextResponse.json([]);
  }
}
