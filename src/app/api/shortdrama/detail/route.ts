/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextRequest, NextResponse } from 'next/server';

import { getConfig, getCacheTime } from '@/lib/config';
import { DEFAULT_USER_AGENT } from '@/lib/user-agent';
import { safeJsonParse } from '@/lib/shortdrama-safe-fetch';

// 强制动态路由，禁用所有缓存
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

// 默认短剧源
const DEFAULT_SHORT_DRAMA_API = 'https://tyyszyapi.com/api.php/provide/vod';

function buildDetailResponse(item: any, cacheTime: number) {
  const playUrl = item.vod_play_url || '';
  const episodes: string[] = [];
  const episodeTitles: string[] = [];

  if (playUrl) {
    const parts = playUrl.split('#');
    parts.forEach((part: string, index: number) => {
      const match = part.match(/^(.+?)\$(.+)$/);
      if (match) {
        episodeTitles.push(match[1]);
        episodes.push(match[2]);
      } else {
        episodeTitles.push(`第${index + 1}集`);
        episodes.push(part);
      }
    });
  }

  if (episodes.length === 0) {
    return NextResponse.json({ error: '没有找到播放地址' }, { status: 404 });
  }

  const response_data = {
    id: item.vod_id.toString(),
    title: item.vod_name,
    poster: item.vod_pic || '',
    episodes: episodes,
    episodes_titles: episodeTitles,
    source: 'shortdrama',
    source_name: '短剧',
    year: new Date().getFullYear().toString(),
    desc: item.vod_content || item.vod_blurb || '',
    type_name: '短剧',
  };

  const finalResponse = NextResponse.json(response_data);
  finalResponse.headers.set('Cache-Control', `public, max-age=${cacheTime}, s-maxage=${cacheTime}`);
  finalResponse.headers.set('CDN-Cache-Control', `public, s-maxage=${cacheTime}`);
  finalResponse.headers.set('Vercel-CDN-Cache-Control', `public, s-maxage=${cacheTime}`);

  return finalResponse;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: '缺少必要参数：id' }, { status: 400 });
    }

    const videoId = parseInt(id);

    if (isNaN(videoId)) {
      return NextResponse.json({ error: '参数格式错误' }, { status: 400 });
    }

    // Step 1: 获取短剧详情
    const config = await getConfig();
    const baseUrl = config.ShortDramaConfig?.primaryApiUrl || DEFAULT_SHORT_DRAMA_API;
    const apiUrl = `${baseUrl}?ac=detail&ids=${videoId}`;

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
      return NextResponse.json({ error: '短剧详情API返回非JSON数据' }, { status: 502 });
    }

    const items = data.list || [];

    if (items.length === 0) {
      // Try alternative API if enabled
      if (config.ShortDramaConfig?.enableAlternative && config.ShortDramaConfig?.alternativeApiUrl) {
        const altUrl = `${config.ShortDramaConfig.alternativeApiUrl}?ac=detail&ids=${videoId}`;
        const altResponse = await fetch(altUrl, {
          headers: { 'User-Agent': DEFAULT_USER_AGENT, Accept: 'application/json' },
          signal: AbortSignal.timeout(15000),
        });
        if (altResponse.ok) {
          const altData = await safeJsonParse(altResponse);
          const altItems = altData?.list || [];
          if (altItems.length > 0) {
            return buildDetailResponse(altItems[0], await getCacheTime());
          }
        }
      }
      return NextResponse.json({ error: '未找到该短剧' }, { status: 404 });
    }

    return buildDetailResponse(items[0], await getCacheTime());
  } catch (error) {
    console.error('短剧详情获取失败:', error);
    return NextResponse.json({ error: '短剧详情获取失败' }, { status: 502 });
  }
}
