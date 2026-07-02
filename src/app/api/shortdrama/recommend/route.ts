/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { DEFAULT_USER_AGENT } from '@/lib/user-agent';
import { safeJsonParse } from '@/lib/shortdrama-safe-fetch';

// 强制动态路由，禁用所有缓存
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

// 默认短剧源
const DEFAULT_SHORT_DRAMA_API = 'https://tyyszyapi.com/api.php/provide/vod';

// 从单个短剧源获取推荐数据（通过分类名称查找）
async function fetchFromShortDramaSource(api: string, size: number) {
  // Step 1: 获取分类列表，找到"短剧"分类的 ID
  const listUrl = `${api}?ac=list`;

  const listResponse = await fetch(listUrl, {
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!listResponse.ok) {
    throw new Error(`HTTP error! status: ${listResponse.status}`);
  }

  const listData = await safeJsonParse(listResponse);
  if (!listData) {
    throw new Error('分类列表API返回非JSON数据');
  }

  const categories = listData.class || [];

  // 查找"短剧"分类（只要包含"短剧"两个字即可）
  const shortDramaCategory = categories.find(
    (cat: any) => cat.type_name && cat.type_name.includes('短剧')
  );

  if (!shortDramaCategory) {
    console.log(`该源没有短剧分类`);
    return [];
  }

  const categoryId = shortDramaCategory.type_id;
  console.log(`找到短剧分类 ID: ${categoryId}`);

  // Step 2: 获取该分类的短剧列表
  const apiUrl = `${api}?ac=detail&t=${categoryId}&pg=1`;

  const response = await fetch(apiUrl, {
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = await safeJsonParse(response);
  if (!data) {
    throw new Error('短剧列表API返回非JSON数据');
  }

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

// 服务端专用函数，从所有短剧源聚合数据
async function getRecommendedShortDramasInternal(
  category?: number,
  size = 10
) {
  try {
    // 获取配置
    const config = await getConfig();

    // 筛选出所有启用的短剧源
    const shortDramaSources = (config.SourceConfig || []).filter(
      (source: any) => source.type === 'shortdrama' && !source.disabled
    );

    console.log(`📺 找到 ${shortDramaSources.length} 个配置的短剧源`);

    // 如果没有配置短剧源，使用默认源
    if (shortDramaSources.length === 0) {
      const baseUrl = config.ShortDramaConfig?.primaryApiUrl || DEFAULT_SHORT_DRAMA_API;
      console.log('📺 使用短剧源：', baseUrl);
      return await fetchFromShortDramaSource(baseUrl, size);
    }

    // 有配置短剧源，聚合所有源的数据
    console.log('📺 聚合多个短剧源的数据');
    const results = await Promise.allSettled(
      shortDramaSources.map((source: any) => {
        console.log(`🔄 请求短剧源: ${source.name}`);
        return fetchFromShortDramaSource(source.api, size);
      })
    );

    // 合并所有成功的结果
    const allItems: any[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        console.log(`✅ ${shortDramaSources[index].name}: 获取到 ${result.value.length} 条数据`);
        allItems.push(...result.value);
      } else {
        console.error(`❌ ${shortDramaSources[index].name}: 请求失败`, result.reason);
      }
    });

    // 去重（根据名称）
    const uniqueItems = Array.from(
      new Map(allItems.map((item: any) => [item.name, item])).values()
    );

    // 按更新时间排序
    uniqueItems.sort((a: any, b: any) =>
      new Date(b.update_time).getTime() - new Date(a.update_time).getTime()
    );

    // 返回指定数量
    const finalItems = uniqueItems.slice(0, size);
    console.log(`📊 最终返回 ${finalItems.length} 条短剧数据`);

    return finalItems;
  } catch (error) {
    console.error('获取短剧推荐失败:', error);
    // 出错时fallback到默认源
    try {
      console.log('⚠️ 出错，fallback到配置短剧源');
      const config = await getConfig();
      return await fetchFromShortDramaSource(config.ShortDramaConfig?.primaryApiUrl || DEFAULT_SHORT_DRAMA_API, size);
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

    // 2小时 HTTP 缓存
    const cacheTime = 7200;
    response.headers.set('Cache-Control', `public, max-age=${cacheTime}, s-maxage=${cacheTime}`);
    response.headers.set('CDN-Cache-Control', `public, s-maxage=${cacheTime}`);
    response.headers.set('Vercel-CDN-Cache-Control', `public, s-maxage=${cacheTime}`);

    // Vary头确保不同设备有不同缓存
    response.headers.set('Vary', 'Accept-Encoding, User-Agent');

    return response;
  } catch (error) {
    console.error('获取推荐短剧失败:', error);
    // 返回空数组而非500错误，避免页面白屏
    return NextResponse.json([]);
  }
}
