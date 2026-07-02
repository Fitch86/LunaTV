/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { DEFAULT_USER_AGENT } from '@/lib/user-agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const DEFAULT_SHORT_DRAMA_API = 'https://tyyszyapi.com/api.php/provide/vod';

// 从单个短剧源获取数据（直接按 categoryId 查询，与 SeeTV 一致）
async function fetchListFromSource(
  api: string,
  categoryId: number,
  page: number,
  size: number
) {
  const apiUrl = `${api}?ac=detail&t=${categoryId}&pg=${page}`;
  console.log(`📡 请求: ${apiUrl}`);

  const response = await fetch(apiUrl, {
    headers: { 'User-Agent': DEFAULT_USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = await response.json();
  const items = data.list || [];
  const limitedItems = items.slice(0, size);

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

  return { list, hasMore: data.page < data.pagecount };
}

async function getShortDramaListInternal(category: number, page = 1, size = 20) {
  try {
    const config = await getConfig();

    const shortDramaSources = (config.SourceConfig || []).filter(
      (source: any) => source.type === 'shortdrama' && !source.disabled
    );

    if (shortDramaSources.length === 0) {
      const baseUrl = config.ShortDramaConfig?.primaryApiUrl || DEFAULT_SHORT_DRAMA_API;
      console.log(`📺 [LIST] 使用短剧源：${baseUrl}`);
      return await fetchListFromSource(baseUrl, category, page, size);
    }

    const results = await Promise.allSettled(
      shortDramaSources.map(source => fetchListFromSource(source.api, category, page, size))
    );

    const allItems: any[] = [];
    let hasMore = false;
    results.forEach((r) => {
      if (r.status === 'fulfilled') {
        allItems.push(...r.value.list);
        hasMore = hasMore || r.value.hasMore;
      }
    });

    const uniqueItems = Array.from(
      new Map(allItems.map((item: any) => [item.name, item])).values()
    );
    uniqueItems.sort((a: any, b: any) =>
      new Date(b.update_time).getTime() - new Date(a.update_time).getTime()
    );

    return { list: uniqueItems.slice(0, size), hasMore };
  } catch (error) {
    console.error('获取短剧列表失败:', error);
    try {
      const config = await getConfig();
      return await fetchListFromSource(config.ShortDramaConfig?.primaryApiUrl || DEFAULT_SHORT_DRAMA_API, category, page, size);
    } catch (fallbackError) {
      console.error('默认源也失败:', fallbackError);
      return { list: [], hasMore: false };
    }
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const categoryId = parseInt(searchParams.get('categoryId') || '0');
    const page = parseInt(searchParams.get('page') || '1');
    const size = Math.min(parseInt(searchParams.get('size') || '20'), 50);

    if (!categoryId) {
      return NextResponse.json({ error: '缺少参数 categoryId' }, { status: 400 });
    }

    const { list, hasMore } = await getShortDramaListInternal(categoryId, page, size);

    const response = NextResponse.json({ list, hasMore });
    response.headers.set('Cache-Control', 'public, max-age=7200, s-maxage=7200');
    return response;
  } catch (error) {
    console.error('短剧列表接口失败:', error);
    return NextResponse.json({ list: [], hasMore: false });
  }
}