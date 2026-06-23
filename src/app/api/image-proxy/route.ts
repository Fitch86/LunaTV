import { NextResponse } from 'next/server';

import { fetchWithProxy } from '@/lib/fetch-with-proxy';

export const runtime = 'nodejs';

/**
 * 图片代理路由
 * 解决豆瓣/Bangumi 等图片在客户端直接加载时的 CORS 和 ISP 封锁问题
 *
 * 用法: GET /api/image-proxy?url=<encoded_image_url>
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const imageUrl = searchParams.get('url');

  if (!imageUrl) {
    return NextResponse.json({ error: 'Missing image URL' }, { status: 400 });
  }

  // 根据图片来源设置不同的 Referer
  const isBangumiImage = imageUrl.includes('bgm.tv');
  const isDoubanImage = imageUrl.includes('doubanio.com') || imageUrl.includes('douban.com');

  const referer = isBangumiImage
    ? 'https://bgm.tv/'
    : isDoubanImage
      ? 'https://movie.douban.com/'
      : '';

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15秒超时

    let imageResponse: Response;
    try {
      imageResponse = await fetchWithProxy(imageUrl, {
        signal: controller.signal,
        headers: {
          Referer: referer,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        },
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!imageResponse.ok) {
      console.error(`Image proxy: upstream returned ${imageResponse.status} for ${imageUrl}`);
      // 返回 1x1 透明 PNG 而非错误，避免前端图片加载失败导致 UI 问题
      return new Response(
        Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
        {
          status: 200,
          headers: {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=300, s-maxage=300', // 5分钟短缓存（失败时）
            'X-Image-Proxy-Error': `upstream_${imageResponse.status}`,
          },
        }
      );
    }

    const contentType = imageResponse.headers.get('content-type');

    if (!imageResponse.body) {
      return new Response(
        Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
        {
          status: 200,
          headers: {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=300, s-maxage=300',
          },
        }
      );
    }

    // 创建响应头
    const headers = new Headers();
    if (contentType) {
      headers.set('Content-Type', contentType);
    }

    // 设置缓存头
    headers.set('Cache-Control', 'public, max-age=86400, s-maxage=86400'); // 缓存1天
    headers.set('CDN-Cache-Control', 'public, s-maxage=86400');
    headers.set('Vercel-CDN-Cache-Control', 'public, s-maxage=86400');
    headers.set('Netlify-Vary', 'query');

    // 直接返回图片流
    return new Response(imageResponse.body, {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error('Image proxy error:', error);
    // 上游不可达时返回 1x1 透明 PNG，避免前端报错
    return new Response(
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
      {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=300, s-maxage=300',
          'X-Image-Proxy-Error': 'upstream_unreachable',
        },
      }
    );
  }
}
