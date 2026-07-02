/* eslint-disable no-console */
import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';
import { fetchWithProxy } from '@/lib/fetch-with-proxy';
import { getRandomUserAgent } from '@/lib/user-agent';

export const runtime = 'nodejs';

const DEFAULT_DANMU_API_URL = 'https://smonedanmu.vercel.app';
const DEFAULT_DANMU_API_TOKEN = 'smonetv';

interface SearchEpisodeItem {
  episodeId: number;
  episodeTitle: string;
}

interface SearchAnimeItem {
  animeId: number;
  animeTitle: string;
  type: string;
  typeDescription?: string;
  imageUrl?: string;
  episodes: SearchEpisodeItem[];
}

async function getDanmuSearchConfig() {
  try {
    const adminConfig = await getConfig();
    const config = adminConfig.DanmuApiConfig;

    if (config?.enabled === false) {
      return { enabled: false, apiUrl: '', token: '', timeout: 30 };
    }

    if (config?.useCustomApi && config.customApiUrl) {
      return {
        enabled: true,
        apiUrl: config.customApiUrl.replace(/\/$/, ''),
        token: config.customToken || '',
        timeout: config.timeout || 30,
      };
    }

    return {
      enabled: true,
      apiUrl: DEFAULT_DANMU_API_URL,
      token: DEFAULT_DANMU_API_TOKEN,
      timeout: config?.timeout || 30,
    };
  } catch {
    return {
      enabled: true,
      apiUrl: process.env.DANMU_API_URL || DEFAULT_DANMU_API_URL,
      token: process.env.DANMU_API_TOKEN || DEFAULT_DANMU_API_TOKEN,
      timeout: 30,
    };
  }
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function readString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  return undefined;
}

function normalizeAnimes(data: any): SearchAnimeItem[] {
  const animes = data?.animes;
  if (!Array.isArray(animes)) return [];

  const result: SearchAnimeItem[] = [];
  for (const item of animes) {
    if (!item || typeof item !== 'object') continue;

    const animeId = parsePositiveInt(item.animeId);
    if (!animeId) continue;

    const episodes: SearchEpisodeItem[] = [];
    if (Array.isArray(item.episodes)) {
      for (const ep of item.episodes) {
        if (!ep || typeof ep !== 'object') continue;
        const episodeId = parsePositiveInt(ep.episodeId);
        if (!episodeId) continue;
        episodes.push({
          episodeId,
          episodeTitle: readString(ep.episodeTitle) || `episodeId:${episodeId}`,
        });
      }
    }

    result.push({
      animeId,
      animeTitle: readString(item.animeTitle) || `animeId:${animeId}`,
      type: readString(item.type) || 'unknown',
      typeDescription: readString(item.typeDescription),
      imageUrl: readString(item.imageUrl),
      episodes,
    });
  }

  return result;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const keyword = (searchParams.get('keyword') || '').trim();

  if (!keyword) {
    return NextResponse.json(
      { code: 400, message: '缺少必要参数: keyword', animes: [] },
      { status: 400 },
    );
  }

  const config = await getDanmuSearchConfig();

  if (!config.enabled || !config.apiUrl) {
    return NextResponse.json(
      { code: 503, message: '弹幕API未启用', animes: [] },
      { status: 503 },
    );
  }

  try {
    const searchUrl = `${config.apiUrl}/${config.token}/api/v2/search/anime?keyword=${encodeURIComponent(keyword)}`;
    console.log(`[danmu-search] Searching: ${searchUrl}`);

    const response = await fetchWithProxy(searchUrl, {
      headers: { 'User-Agent': getRandomUserAgent() },
      signal: AbortSignal.timeout(config.timeout * 1000),
    });

    if (!response.ok) {
      return NextResponse.json(
        { code: 502, message: `弹幕搜索失败: HTTP ${response.status}`, animes: [] },
        { status: 502 },
      );
    }

    const data = await response.json();
    const animes = normalizeAnimes(data);

    // If an anime has no episodes, try fetching from bangumi detail
    const animesWithEpisodes: SearchAnimeItem[] = [];
    for (const anime of animes) {
      if (anime.episodes.length > 0) {
        animesWithEpisodes.push(anime);
        continue;
      }

      try {
        const bangumiUrl = `${config.apiUrl}/${config.token}/api/v2/bangumi/${anime.animeId}`;
        const bangumiResp = await fetchWithProxy(bangumiUrl, {
          headers: { 'User-Agent': getRandomUserAgent() },
          signal: AbortSignal.timeout(10000),
        });
        if (bangumiResp.ok) {
          const bangumiData = await bangumiResp.json();
          const eps = bangumiData?.bangumi?.episodes;
          if (Array.isArray(eps) && eps.length > 0) {
            anime.episodes = eps
              .map((ep: any) => {
                const eid = parsePositiveInt(ep.episodeId);
                if (!eid) return null;
                return { episodeId: eid, episodeTitle: readString(ep.episodeTitle) || `episodeId:${eid}` };
              })
              .filter((ep: any): ep is SearchEpisodeItem => ep !== null);
          }
        }
      } catch {
        // ignore individual bangumi fetch errors
      }

      if (anime.episodes.length > 0) {
        animesWithEpisodes.push(anime);
      }
    }

    console.log(`[danmu-search] Found ${animesWithEpisodes.length} animes for "${keyword}"`);

    return NextResponse.json(
      {
        code: 200,
        message: '获取成功',
        keyword,
        animes: animesWithEpisodes,
        count: animesWithEpisodes.length,
      },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (err) {
    console.error('[danmu-search] Error:', err);
    return NextResponse.json(
      {
        code: 502,
        message: `弹幕搜索异常: ${err instanceof Error ? err.message : String(err)}`,
        animes: [],
      },
      { status: 502 },
    );
  }
}
