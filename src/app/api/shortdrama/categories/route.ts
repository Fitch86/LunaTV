/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { DEFAULT_USER_AGENT } from '@/lib/user-agent';
import { safeJsonParse } from '@/lib/shortdrama-safe-fetch';

// 强制动态路由，禁用所有缓存
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

// 默认短剧源
const DEFAULT_SHORT_DRAMA_API = 'https://wwzy.tv/api.php/provide/vod';

// 从单个源获取短剧分类
async function getCategoriesFromSource(
  api: string
): Promise<{ type_id: number; type_name: string }[]> {
  const response = await fetch(`${api}?ac=list`, {
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = await safeJsonParse(response);
  if (!data) {
    throw new Error('分类API返回非JSON数据');
  }

  const categories = data.class || [];

  // 筛选包含"短剧"的分类
  const shortDramaCategories = categories.filter(
    (cat: any) => cat.type_name && cat.type_name.includes('短剧')
  );

  if (shortDramaCategories.length > 0) {
    return shortDramaCategories.map((cat: any) => ({
      type_id: cat.type_id,
      type_name: cat.type_name,
    }));
  }

  return categories.map((cat: any) => ({
    type_id: cat.type_id,
    type_name: cat.type_name,
  }));
}

// 服务端专用函数，从所有短剧源聚合分类
async function getShortDramaCategoriesInternal() {
  try {
    const config = await getConfig();

    const shortDramaSources = (config.SourceConfig || []).filter(
      (source: any) => source.type === 'shortdrama' && !source.disabled
    );

    if (shortDramaSources.length === 0) {
      console.log(`📋 [CATEGORIES] 使用默认短剧源：${DEFAULT_SHORT_DRAMA_API}`);
      return await getCategoriesFromSource(DEFAULT_SHORT_DRAMA_API);
    }

    console.log(`📋 [CATEGORIES] 从 ${shortDramaSources.length} 个短剧源聚合分类`);
    const results = await Promise.allSettled(
      shortDramaSources.map((source: any) => getCategoriesFromSource(source.api))
    );

    const allCategories: { type_id: number; type_name: string }[] = [];
    const seenNames = new Set<string>();

    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        for (const cat of result.value) {
          if (!seenNames.has(cat.type_name)) {
            seenNames.add(cat.type_name);
            allCategories.push(cat);
          }
        }
      }
    });

    return allCategories;
  } catch (error) {
    console.error('获取短剧分类失败:', error);
    try {
      return await getCategoriesFromSource(DEFAULT_SHORT_DRAMA_API);
    } catch (fallbackError) {
      console.error('默认源也失败:', fallbackError);
      return [];
    }
  }
}

export async function GET() {
  try {
    const categories = await getShortDramaCategoriesInternal();

    const cacheTime = 14400;
    const response = NextResponse.json(categories);
    response.headers.set('Cache-Control', `public, max-age=${cacheTime}, s-maxage=${cacheTime}`);
    response.headers.set('CDN-Cache-Control', `public, s-maxage=${cacheTime}`);
    response.headers.set('Vercel-CDN-Cache-Control', `public, s-maxage=${cacheTime}`);
    response.headers.set('Vary', 'Accept-Encoding, User-Agent');

    return response;
  } catch (error) {
    console.error('获取短剧分类失败:', error);
    // 返回空数组而非500错误，避免页面白屏
    return NextResponse.json([]);
  }
}
