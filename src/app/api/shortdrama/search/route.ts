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

// 从单个短剧源搜索数据
async function searchFromSource(
  api: string,
  query: string,
  page: number,
  size: number
) {
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

  const shortDramaCategory = categories.find(
    (cat: any) => cat.type_name && cat.type_name.includes('短剧')
  );

  if (!shortDramaCategory) {
    console.log(`该源没有短剧分类`);
    return { list: [], hasMore: false };
  }

  const categoryId = shortDramaCategory.type_id;

  // Step 2: 搜索该分类下的短剧
  const apiUrl = `${api}?ac=detail&wd=${encodeURIComponent(query)}&pg=${page}`;

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
    throw new Error('搜索API返回非JSON数据');
  }

  const items = data.list || [];

  const shortDramaItems = items.filter(
    (item: any) => item.type_id === categoryId
  );
  const limitedItems = shortDramaItems.slice(0, size);

  const list = limitedItems.map((item: any) => ({
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

  return {
    list,
    hasMore: data.page < data.pagecount,
  };
}

// 服务端专用函数，从所有短剧源聚合搜索
async function searchShortDramasInternal(query: string, page = 1, size = 20) {
  try {
    const config = await getConfig();

    const shortDramaSources = (config.SourceConfig || []).filter(
      (source: any) => source.type === 'shortdrama' && !source.disabled
    );

    if (shortDramaSources.length === 0) {
      const baseUrl = config.ShortDramaConfig?.primaryApiUrl || DEFAULT_SHORT_DRAMA_API;
      console.log(`🔍 [SEARCH] 使用短剧源：${baseUrl}，搜索词：${query}`);
      return await searchFromSource(baseUrl, query, page, size);
    }

    console.log(`🔍 [SEARCH] 从 ${shortDramaSources.length} 个短剧源聚合搜索`);
    const results = await Promise.allSettled(
      shortDramaSources.map((source: any) => searchFromSource(source.api, query, page, size))
    );

    const allItems: any[] = [];
    let hasMore = false;

    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        allItems.push(...result.value.list);
        hasMore = hasMore || result.value.hasMore;
      }
    });

    const uniqueItems = Array.from(
      new Map(allItems.map((item: any) => [item.name, item])).values()
    );

    uniqueItems.sort((a: any, b: any) =>
      new Date(b.update_time).getTime() - new Date(a.update_time).getTime()
    );

    return {
      list: uniqueItems.slice(0, size),
      hasMore,
    };
  } catch (error) {
    console.error('搜索短剧失败:', error);
    try {
      const config = await getConfig();
      return await searchFromSource(config.ShortDramaConfig?.primaryApiUrl || DEFAULT_SHORT_DRAMA_API, query, page, size);
    } catch (fallbackError) {
      console.error('默认源也失败:', fallbackError);
      return { list: [], hasMore: false };
    }
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const query = searchParams.get('query');
    const page = searchParams.get('page');
    const size = searchParams.get('size');

    if (!query) {
      return NextResponse.json(
        { error: '缺少必要参数: query' },
        { status: 400 }
      );
    }

    const pageNum = page ? parseInt(page) : 1;
    const pageSize = size ? parseInt(size) : 20;

    if (isNaN(pageNum) || isNaN(pageSize)) {
      return NextResponse.json({ error: '参数格式错误' }, { status: 400 });
    }

    const result = await searchShortDramasInternal(query, pageNum, pageSize);

    const cacheTime = 3600;
    const response = NextResponse.json(result);
    response.headers.set('Cache-Control', `public, max-age=${cacheTime}, s-maxage=${cacheTime}`);
    response.headers.set('CDN-Cache-Control', `public, s-maxage=${cacheTime}`);
    response.headers.set('Vercel-CDN-Cache-Control', `public, s-maxage=${cacheTime}`);
    response.headers.set('Vary', 'Accept-Encoding, User-Agent');

    return response;
  } catch (error) {
    console.error('搜索短剧失败:', error);
    // 返回空结果而非500错误，避免页面白屏
    return NextResponse.json({ list: [], hasMore: false });
  }
}
