import { NextRequest, NextResponse } from 'next/server';

import { DEFAULT_USER_AGENT } from '@/lib/user-agent';

// 强制动态路由，禁用所有缓存
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

// 默认短剧源
const DEFAULT_SHORT_DRAMA_API = 'https://wwzy.tv/api.php/provide/vod';

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
    signal: AbortSignal.timeout(10000),
  });

  if (!listResponse.ok) {
    throw new Error(`HTTP error! status: ${listResponse.status}`);
  }

  const listData = await listResponse.json();
  const categories = listData.class || [];

  // 查找"短剧"分类（只要包含"短剧"两个字即可）
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
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = await response.json();
  const items = data.list || [];

  // 过滤出短剧分类的结果
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

// 服务端专用函数，直接调用外部 API
async function searchShortDramasInternal(query: string, page = 1, size = 20) {
  console.log(
    `🔍 [SEARCH] 使用默认短剧源：${DEFAULT_SHORT_DRAMA_API}, 搜索词：${query}`
  );
  return await searchFromSource(DEFAULT_SHORT_DRAMA_API, query, page, size);
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

    // 设置与网页端一致的缓存策略（搜索结果: 1小时）
    const response = NextResponse.json(result);

    console.log('🕐 [SEARCH] 设置1小时HTTP缓存 - 与网页端搜索缓存一致');

    // 1小时 = 3600秒（搜索结果更新频繁，短期缓存）
    const cacheTime = 3600;
    response.headers.set(
      'Cache-Control',
      `public, max-age=${cacheTime}, s-maxage=${cacheTime}`
    );
    response.headers.set('CDN-Cache-Control', `public, s-maxage=${cacheTime}`);
    response.headers.set(
      'Vercel-CDN-Cache-Control',
      `public, s-maxage=${cacheTime}`
    );

    // 调试信息
    response.headers.set('X-Cache-Duration', '1hour');
    response.headers.set(
      'X-Cache-Expires-At',
      new Date(Date.now() + cacheTime * 1000).toISOString()
    );
    response.headers.set('X-Debug-Timestamp', new Date().toISOString());

    // Vary头确保不同设备有不同缓存
    response.headers.set('Vary', 'Accept-Encoding, User-Agent');

    return response;
  } catch (error) {
    console.error('搜索短剧失败:', error);
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 });
  }
}
