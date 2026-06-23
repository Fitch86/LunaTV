/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { NextRequest, NextResponse } from 'next/server';
import { getRandomUserAgent } from '@/lib/user-agent';
import { fetchWithProxy, getActiveProxyUrl } from '@/lib/fetch-with-proxy';
import { getConfig } from '@/lib/config';

// 默认弹幕API配置 (LogVar Danmu API 兼容)
const DEFAULT_DANMU_API_URL = '';
const DEFAULT_DANMU_API_TOKEN = '';

interface PlatformUrl {
  platform: string;
  url: string;
}

interface DanmuApiResponse {
  code: number;
  name: string;
  danum: number;
  danmuku: any[];
}

interface DanmuItem {
  text: string;
  time: number;
  color?: string;
  mode?: number;
}

// 弹幕API配置接口
interface DanmuApiConfig {
  enabled: boolean;
  apiUrl: string;
  token: string;
  timeout: number;
}

// 获取弹幕API配置（从数据库配置和环境变量）
async function getDanmuApiConfig(): Promise<DanmuApiConfig> {
  try {
    const config = await getConfig();
    const apiUrl = config.SiteConfig?.DanmuApiUrl || process.env.DANMU_API_URL || DEFAULT_DANMU_API_URL;
    const token = config.SiteConfig?.DanmuApiToken || process.env.DANMU_API_TOKEN || DEFAULT_DANMU_API_TOKEN;
    return {
      enabled: !!apiUrl,
      apiUrl,
      token,
      timeout: 10,
    };
  } catch {
    // fallback到环境变量
    return {
      enabled: !!(process.env.DANMU_API_URL || DEFAULT_DANMU_API_URL),
      apiUrl: process.env.DANMU_API_URL || DEFAULT_DANMU_API_URL,
      token: process.env.DANMU_API_TOKEN || DEFAULT_DANMU_API_TOKEN,
      timeout: 10,
    };
  }
}

// 通用弹幕处理函数（分段 + 密度控制 + 质量过滤）
function processDanmuComments(comments: any[]): DanmuItem[] {
  const SEGMENT_DURATION = 300; // 5分钟分段
  const MAX_DANMU_PER_SEGMENT = 500;
  const maxAllowedDanmu = 20000;

  const timeSegments: { [key: number]: DanmuItem[] } = {};

  for (const item of comments) {
    try {
      const pParts = (item.p || '').split(',');
      const time = parseFloat(pParts[0]) || item.t || 0;
      const mode = parseInt(pParts[1]) || 0;
      const colorInt = parseInt(pParts[2]) || 16777215;
      const text = (item.m || '').trim();

      // 质量过滤
      if (text.length === 0 ||
        text.length > 50 ||
        text.length < 2 ||
        /^[^一-龥a-zA-Z0-9]+$/.test(text) ||
        text.includes('弹幕正在赶来') ||
        text.includes('观影愉快') ||
        text.includes('视频不错') ||
        text.includes('666') ||
        /^\d+$/.test(text) ||
        /^[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]+$/.test(text)) {
        continue;
      }

      if (time < 0 || time > 86400 || !Number.isFinite(time)) continue;

      const segmentIndex = Math.floor(time / SEGMENT_DURATION);
      if (!timeSegments[segmentIndex]) {
        timeSegments[segmentIndex] = [];
      }

      if (timeSegments[segmentIndex].length >= MAX_DANMU_PER_SEGMENT) {
        if (Math.random() < 0.1) {
          const randomIndex = Math.floor(Math.random() * timeSegments[segmentIndex].length);
          timeSegments[segmentIndex][randomIndex] = {
            text,
            time,
            color: '#' + colorInt.toString(16).padStart(6, '0').toUpperCase(),
            mode: mode === 4 ? 1 : mode === 5 ? 2 : 0,
          };
        }
        continue;
      }

      timeSegments[segmentIndex].push({
        text,
        time,
        color: '#' + colorInt.toString(16).padStart(6, '0').toUpperCase(),
        mode: mode === 4 ? 1 : mode === 5 ? 2 : 0,
      });
    } catch {
      // 跳过解析失败的弹幕
    }
  }

  // 按时间段重新整合为时间排序数组
  const danmuList: DanmuItem[] = [];
  for (const segmentIndex of Object.keys(timeSegments).sort((a, b) => parseInt(a) - parseInt(b))) {
    const segment = timeSegments[parseInt(segmentIndex)];
    segment.sort((a, b) => a.time - b.time);
    danmuList.push(...segment);
  }

  let finalDanmu = danmuList;
  if (danmuList.length > maxAllowedDanmu) {
    console.warn(`⚠️ [弹幕处理] 弹幕数量过多 (${danmuList.length})，采样至 ${maxAllowedDanmu}`);
    const sampleRate = maxAllowedDanmu / danmuList.length;
    finalDanmu = danmuList.filter((_, index) => {
      return index === 0 ||
        index === danmuList.length - 1 ||
        Math.random() < sampleRate ||
        index % Math.ceil(1 / sampleRate) === 0;
    }).slice(0, maxAllowedDanmu);
  }

  return finalDanmu;
}

// 从自定义弹幕API获取弹幕（主用 - Dandanplay 兼容 API，优先使用 /v2/match 自动匹配）
async function fetchDanmuFromCustomAPI(
  title: string,
  episode?: string | null,
  year?: string | null
): Promise<{ danmu: DanmuItem[]; source: string } | null> {
  const config = await getDanmuApiConfig();

  if (!config.enabled || !config.apiUrl) {
    console.log('🔇 弹幕API未启用或未配置');
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout * 1000);

  try {
    // ===== 优先使用 /v2/match 自动匹配接口 =====
    // 构造 fileName 参数：支持 S01E01 格式
    let fileName = title;
    if (episode) {
      const epNum = parseInt(episode);
      if (epNum > 0) {
        const seasonNum = 1; // 默认第一季
        fileName = `${title} S${String(seasonNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')}`;
      }
    }

    const matchUrl = `${config.apiUrl}/${config.token}/api/v2/match`;
    console.log(`🎯 [弹幕API] 尝试自动匹配: ${matchUrl}, fileName: ${fileName}`);

    const matchResponse = await fetchWithProxy(matchUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fileName }),
    });

    if (matchResponse.ok) {
      const matchData = await matchResponse.json();

      if (matchData.success && matchData.isMatched && matchData.matches?.length > 0) {
        const bestMatch = matchData.matches[0];
        console.log(`✅ [弹幕API] 自动匹配成功: "${bestMatch.animeTitle}" episodeId=${bestMatch.episodeId}`);

        // 直接通过 episodeId 获取弹幕
        const commentUrl = `${config.apiUrl}/${config.token}/api/v2/comment/${bestMatch.episodeId}?format=json`;
        console.log(`💬 [弹幕API] 获取弹幕: ${commentUrl}`);

        const commentResponse = await fetchWithProxy(commentUrl, {
          signal: controller.signal,
          headers: { 'User-Agent': getRandomUserAgent() },
        });

        clearTimeout(timeoutId);

        if (commentResponse.ok) {
          const commentData = await commentResponse.json();
          if (commentData.comments && Array.isArray(commentData.comments) && commentData.comments.length > 0) {
            const processed = processDanmuComments(commentData.comments);
            console.log(`🎉 [弹幕API/match] 获取到 ${processed.length} 条弹幕`);
            if (processed.length >= 10) {
              return {
                danmu: processed,
                source: `弹幕API/match (${bestMatch.animeTitle})`,
              };
            }
            console.log(`⚠️ [弹幕API/match] 弹幕过少(${processed.length}条)，回退到搜索模式`);
          }
        }
      } else {
        console.log(`📭 [弹幕API] 自动匹配无结果，回退到搜索模式`);
      }
    }

    // ===== 搜索模式回退 =====
    // 第一步：搜索动漫/视频
    const searchUrl = `${config.apiUrl}/${config.token}/api/v2/search/anime?keyword=${encodeURIComponent(title)}`;
    console.log(`🔍 [弹幕API] 搜索: ${searchUrl}`);

    const searchResponse = await fetchWithProxy(searchUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': getRandomUserAgent() },
    });

    if (!searchResponse.ok) {
      console.log(`❌ [弹幕API] 搜索失败: ${searchResponse.status}`);
      clearTimeout(timeoutId);
      return null;
    }

    const searchData = await searchResponse.json();

    if (!searchData.success || !searchData.animes || searchData.animes.length === 0) {
      console.log(`📭 [弹幕API] 未找到匹配: "${title}"`);
      clearTimeout(timeoutId);
      return null;
    }

    console.log(`🎬 [弹幕API] 找到 ${searchData.animes.length} 个匹配结果`);

    // 选择最佳匹配（优先年份匹配，再匹配标题）
    let bestMatch = searchData.animes[0];
    for (const anime of searchData.animes) {
      const animeTitle = anime.animeTitle?.toLowerCase() || '';
      const searchTitle = title.toLowerCase();
      const titleMatches = animeTitle.includes(searchTitle) || searchTitle.includes(animeTitle.split('(')[0].trim());

      // 如果有年份参数，优先选择年份匹配的结果
      if (year && animeTitle.includes(year) && titleMatches) {
        bestMatch = anime;
        break;
      }
      if (titleMatches) {
        bestMatch = anime;
        if (!year) break; // 没有年份参数时，找到标题匹配就停止
      }
    }

    console.log(`✅ [弹幕API] 选择: "${bestMatch.animeTitle}" (ID: ${bestMatch.animeId})`);

    // 第二步：获取剧集列表
    const bangumiUrl = `${config.apiUrl}/${config.token}/api/v2/bangumi/${bestMatch.animeId}`;
    console.log(`📺 [弹幕API] 获取剧集: ${bangumiUrl}`);

    const bangumiResponse = await fetchWithProxy(bangumiUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': getRandomUserAgent() },
    });

    if (!bangumiResponse.ok) {
      console.log(`❌ [弹幕API] 获取剧集失败: ${bangumiResponse.status}`);
      clearTimeout(timeoutId);
      return null;
    }

    const bangumiData = await bangumiResponse.json();

    if (!bangumiData.bangumi?.episodes || bangumiData.bangumi.episodes.length === 0) {
      console.log(`📭 [弹幕API] 无剧集数据`);
      clearTimeout(timeoutId);
      return null;
    }

    const episodes = bangumiData.bangumi.episodes;
    console.log(`📋 [弹幕API] 共 ${episodes.length} 集`);

    // 选择对应集数
    let targetEpisode = episodes[0];
    if (episode) {
      const episodeNum = parseInt(episode);
      if (episodeNum > 0 && episodeNum <= episodes.length) {
        targetEpisode = episodes[episodeNum - 1];
        console.log(`🎯 [弹幕API] 选择第${episode}集: ${targetEpisode.episodeTitle}`);
      }
    }

    // 第三步：获取弹幕
    const commentUrl = `${config.apiUrl}/${config.token}/api/v2/comment/${targetEpisode.episodeId}?format=json`;
    console.log(`💬 [弹幕API] 获取弹幕: ${commentUrl}`);

    const commentResponse = await fetchWithProxy(commentUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': getRandomUserAgent() },
    });

    clearTimeout(timeoutId);

    if (!commentResponse.ok) {
      console.log(`❌ [弹幕API] 获取弹幕失败: ${commentResponse.status}`);
      return null;
    }

    const commentData = await commentResponse.json();

    // 检测有效弹幕的逻辑：有 comments 数组且不为空
    if (!commentData.comments || !Array.isArray(commentData.comments) || commentData.comments.length === 0) {
      console.log(`📭 [弹幕API] 无弹幕数据 (count: ${commentData.count || 0})`);
      return null;
    }

    console.log(`🎉 [弹幕API] 获取到 ${commentData.comments.length} 条弹幕`);

    const finalDanmu = processDanmuComments(commentData.comments);

    console.log(`✅ [弹幕API] 处理后 ${finalDanmu.length} 条优质弹幕`);

    // 如果弹幕太少，返回null让备用方案接管
    if (finalDanmu.length < 10) {
      console.log(`⚠️ [弹幕API] 弹幕数量过少 (${finalDanmu.length}条)，尝试备用方案`);
      return null;
    }

    return {
      danmu: finalDanmu,
      source: `弹幕API (${bestMatch.animeTitle})`,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof DOMException && error.name === 'AbortError') {
      console.log(`❌ [弹幕API] 请求超时 (${config.timeout}秒)`);
    } else {
      console.error(`❌ [弹幕API] 请求失败:`, error);
    }
    return null;
  }
}

// 通过 episodeId 直接获取弹幕（手动匹配模式）
async function fetchDanmuByEpisodeId(
  episodeId: number,
): Promise<{ danmu: DanmuItem[]; source: string } | null> {
  const config = await getDanmuApiConfig();

  if (!config.enabled || !config.apiUrl) {
    console.log('[手动匹配] 弹幕API未启用');
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout * 1000);

  try {
    const commentUrl = `${config.apiUrl}/${config.token}/api/v2/comment/${episodeId}?format=json`;
    console.log(`[手动匹配] 获取弹幕: ${commentUrl}`);

    const response = await fetchWithProxy(commentUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': getRandomUserAgent() },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.log(`[手动匹配] 请求失败: ${response.status}`);
      return null;
    }

    const commentData = await response.json();

    if (!commentData.comments || !Array.isArray(commentData.comments) || commentData.comments.length === 0) {
      console.log(`[手动匹配] 无弹幕数据`);
      return { danmu: [], source: '手动匹配' };
    }

    console.log(`[手动匹配] 获取到 ${commentData.comments.length} 条弹幕`);

    const finalDanmu = processDanmuComments(commentData.comments);

    console.log(`[手动匹配] 处理后 ${finalDanmu.length} 条弹幕`);

    return {
      danmu: finalDanmu,
      source: `手动匹配 (episodeId:${episodeId})`,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    console.error(`[手动匹配] 请求失败:`, error);
    return null;
  }
}

// ============================================================
// B站直接弹幕获取（无需第三方代理，最稳定的弹幕源）
// 流程：搜索B站视频 → 获取cid → 获取protobuf弹幕分段 → 解析
// ============================================================

// B站公共API请求的公共Cookie（通过首次访问www.bilibili.com获取buvid3）
let biliBuvid3 = '';

async function ensureBiliCookie(): Promise<void> {
  if (biliBuvid3) return;
  try {
    const res = await fetchWithProxy('https://www.bilibili.com/', {
      headers: { 'User-Agent': getRandomUserAgent() },
      signal: AbortSignal.timeout(8000),
      redirect: 'manual',
    });
    // 兼容方式获取 Set-Cookie
    const cookieHeader = res.headers.get('set-cookie') || '';
    const m = cookieHeader.match(/buvid3=([^;]+)/);
    if (m) biliBuvid3 = m[1];
  } catch {
    // ignore cookie fetch failures
  }
  if (!biliBuvid3) biliBuvid3 = 'unknown'; // 标记已尝试
}

function biliHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com',
    'Accept': 'application/json',
  };
  if (biliBuvid3 && biliBuvid3 !== 'unknown') {
    h['Cookie'] = `buvid3=${biliBuvid3}`;
  }
  return h;
}

// 轻量级 protobuf varint 解码器
function readVarint(buf: Buffer, offset: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  while (offset < buf.length) {
    const b = buf[offset];
    offset++;
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value, offset };
}

// 解析B站protobuf弹幕数据（DmSegMobileReply）
function parseBiliDanmuProto(buf: Buffer): DanmuItem[] {
  const danmuList: DanmuItem[] = [];
  let offset = 0;

  while (offset < buf.length) {
    const tag = readVarint(buf, offset);
    const fieldNum = tag.value >>> 3;
    const wireType = tag.value & 0x7;
    offset = tag.offset;

    if (wireType === 2 && fieldNum === 1) {
      // elems 字段 - 包含一个 DanmakuElem
      const len = readVarint(buf, offset);
      offset = len.offset;
      const elemData = buf.subarray(offset, offset + len.value);
      offset += len.value;

      // 解析 DanmakuElem 内部字段
      let innerOffset = 0;
      let text = '';
      let progress = 0;
      let mode = 0;
      let colorInt = 16777215; // #FFFFFF

      while (innerOffset < elemData.length) {
        const innerTag = readVarint(elemData, innerOffset);
        const innerFieldNum = innerTag.value >>> 3;
        const innerWireType = innerTag.value & 0x7;
        innerOffset = innerTag.offset;

        if (innerWireType === 0) { // varint
          const v = readVarint(elemData, innerOffset);
          innerOffset = v.offset;
          if (innerFieldNum === 2) progress = v.value;       // progress (毫秒)
          else if (innerFieldNum === 3) mode = v.value;       // mode
          else if (innerFieldNum === 5) colorInt = v.value;   // color
        } else if (innerWireType === 2) { // length-delimited
          const v = readVarint(elemData, innerOffset);
          innerOffset = v.offset;
          const strBuf = elemData.subarray(innerOffset, innerOffset + v.value);
          innerOffset += v.value;
          if (innerFieldNum === 7) { // content
            text = strBuf.toString('utf-8');
          }
        } else {
          break; // 遇到未知 wire type，跳过
        }
      }

      if (text && text.length >= 2 && text.length <= 50) {
        const time = progress / 1000; // 转换为秒
        if (time >= 0 && time <= 86400) {
          danmuList.push({
            text,
            time,
            color: '#' + colorInt.toString(16).padStart(6, '0').toUpperCase(),
            mode: mode === 4 ? 1 : mode === 5 ? 2 : 0,
          });
        }
      }
    } else if (wireType === 0) { // varint
      const v = readVarint(buf, offset);
      offset = v.offset;
    } else if (wireType === 2) { // 其他 length-delimited 字段，跳过
      const len = readVarint(buf, offset);
      offset = len.offset + len.value;
    } else {
      break;
    }
  }

  return danmuList;
}

// B站搜索视频并获取弹幕
async function fetchDanmuFromBilibili(
  searchTitle: string,
  episode?: string | null,
): Promise<{ danmu: DanmuItem[]; source: string } | null> {
  try {
    await ensureBiliCookie();
    const headers = biliHeaders();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    // 第一步：搜索B站视频
    const searchUrl = `https://api.bilibili.com/x/web-interface/search/type?keyword=${encodeURIComponent(searchTitle)}&search_type=video&page=1`;
    console.log(`🔍 [B站] 搜索: "${searchTitle}"`);

    const searchRes = await fetchWithProxy(searchUrl, {
      signal: controller.signal,
      headers,
    });

    if (!searchRes.ok) {
      console.log(`❌ [B站] 搜索失败: ${searchRes.status}`);
      clearTimeout(timeoutId);
      return null;
    }

    const searchData = await searchRes.json();
    const results = searchData?.data?.result || [];
    if (results.length === 0) {
      console.log(`📭 [B站] 搜索无结果`);
      clearTimeout(timeoutId);
      return null;
    }

    console.log(`🎬 [B站] 找到 ${results.length} 个视频结果`);

    // 选择匹配度最高的结果（取第一个，因为搜索排序已按相关度）
    const topResult = results[0];
    const bvid = topResult.bvid;
    const aid = topResult.aid;

    if (!bvid && !aid) {
      console.log(`❌ [B站] 无bvid/aid`);
      clearTimeout(timeoutId);
      return null;
    }

    // 第二步：获取视频详情（含cid）
    const detailUrl = bvid
      ? `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`
      : `https://api.bilibili.com/x/web-interface/view?aid=${aid}`;
    console.log(`📺 [B站] 获取视频详情: ${bvid || aid}`);

    const detailRes = await fetchWithProxy(detailUrl, {
      signal: controller.signal,
      headers,
    });

    if (!detailRes.ok) {
      console.log(`❌ [B站] 获取详情失败: ${detailRes.status}`);
      clearTimeout(timeoutId);
      return null;
    }

    const detailData = await detailRes.json();
    if (!detailData?.data) {
      console.log(`❌ [B站] 详情数据为空`);
      clearTimeout(timeoutId);
      return null;
    }

    const videoInfo = detailData.data;
    const videoTitle = videoInfo.title || '';
    const pages = videoInfo.pages || [];

    // 确定目标页（对应集数）
    let targetCid = videoInfo.cid; // 默认第一P
    const targetAid = videoInfo.aid;
    let targetTitle = videoTitle;

    if (episode && pages.length > 1) {
      const epNum = parseInt(episode);
      if (epNum > 0 && epNum <= pages.length) {
        const targetPage = pages[epNum - 1];
        targetCid = targetPage.cid;
        targetTitle = targetPage.part || videoTitle;
        console.log(`🎯 [B站] 选择第${epNum}P: cid=${targetCid}, title=${targetTitle}`);
      }
    }

    // 第三步：获取protobuf弹幕（分6分钟一段）
    const SEGMENT_DURATION = 360; // 6分钟
    const duration = videoInfo.duration || 0;
    const segmentCount = Math.max(1, Math.ceil(duration / SEGMENT_DURATION));

    console.log(`💬 [B站] 获取弹幕: cid=${targetCid}, aid=${targetAid}, duration=${duration}s, segments=${segmentCount}`);

    const allDanmu: DanmuItem[] = [];

    for (let seg = 1; seg <= segmentCount && seg <= 20; seg++) {
      const danmuUrl = `https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=${targetCid}&pid=${targetAid}&segment_index=${seg}`;

      try {
        const danmuRes = await fetchWithProxy(danmuUrl, {
          signal: controller.signal,
          headers: {
            ...headers,
            'Accept': '*/*',
          },
        });

        if (!danmuRes.ok) {
          console.warn(`⚠️ [B站] 弹幕分段${seg}失败: ${danmuRes.status}`);
          continue;
        }

        const protoBuf = Buffer.from(await danmuRes.arrayBuffer());
        const segDanmu = parseBiliDanmuProto(protoBuf);
        allDanmu.push(...segDanmu);

        if (seg % 3 === 0) {
          console.log(`📊 [B站] 已获取 ${seg}/${segmentCount} 段, 共 ${allDanmu.length} 条弹幕`);
        }
      } catch (segError) {
        console.warn(`⚠️ [B站] 弹幕分段${seg}错误:`, (segError as Error).message);
      }
    }

    clearTimeout(timeoutId);

    if (allDanmu.length === 0) {
      console.log(`📭 [B站] 无弹幕数据`);
      return null;
    }

    // 排序 + 去重 + 密度控制
    allDanmu.sort((a, b) => a.time - b.time);
    const uniqueDanmu = deduplicateDanmu(allDanmu);

    // 过滤质量的弹幕
    const filteredDanmu = uniqueDanmu.filter(d =>
      d.text.length >= 2 &&
      d.text.length <= 50 &&
      !/^[^a-zA-Z0-9一-鿿]+$/.test(d.text) &&
      !d.text.includes('弹幕正在赶来') &&
      !d.text.includes('观影愉快') &&
      !d.text.includes('视频不错') &&
      !/^\d+$/.test(d.text)
    );

    console.log(`✅ [B站] 获取到 ${filteredDanmu.length} 条弹幕 (video: ${videoTitle})`);

    if (filteredDanmu.length < 5) {
      console.log(`⚠️ [B站] 弹幕数量过少 (${filteredDanmu.length}条)`);
      return null;
    }

    return {
      danmu: filteredDanmu,
      source: `B站 (${videoTitle})`,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      console.log(`❌ [B站] 请求超时`);
    } else {
      console.error(`❌ [B站] 获取弹幕失败:`, error);
    }
    return null;
  }
}

// 弹幕去重函数
function deduplicateDanmu(danmuList: DanmuItem[]): DanmuItem[] {
  const seenMap = new Map<string, boolean>();
  const uniqueDanmu: DanmuItem[] = [];

  for (const danmu of danmuList) {
    const normalizedText = danmu.text.trim().toLowerCase();
    const timeKey = Math.round(danmu.time * 100) / 100;
    const uniqueKey = `${timeKey}_${normalizedText}_${danmu.color || 'default'}`;

    if (!seenMap.has(uniqueKey)) {
      seenMap.set(uniqueKey, true);
      uniqueDanmu.push(danmu);
    }
  }

  uniqueDanmu.sort((a, b) => a.time - b.time);

  console.log(`🎯 弹幕去重: ${danmuList.length} -> ${uniqueDanmu.length} 条`);
  return uniqueDanmu;
}

// 从caiji.cyou API搜索视频链接
async function searchFromCaijiAPI(title: string, episode?: string | null): Promise<PlatformUrl[]> {
  try {
    console.log(`🔎 在caiji.cyou搜索: "${title}", 集数: ${episode || '未指定'}`);

    const searchTitles = [
      title,
      title.replace(/·/g, ''),
      title.replace(/·/g, ' '),
      title.replace(/·/g, '-'),
    ];

    const uniqueTitles = Array.from(new Set(searchTitles));
    console.log(`🔍 尝试搜索标题变体: ${uniqueTitles.map(t => `"${t}"`).join(', ')}`);

    for (const searchTitle of uniqueTitles) {
      console.log(`🔎 搜索标题: "${searchTitle}"`);
      const searchUrl = `https://www.caiji.cyou/api.php/provide/vod/?wd=${encodeURIComponent(searchTitle)}`;
      const response = await fetchWithProxy(searchUrl, {
        headers: {
          'User-Agent': getRandomUserAgent(),
        },
      });

      if (!response.ok) {
        console.log(`❌ 搜索"${searchTitle}"失败:`, response.status);
        continue;
      }

      const data: any = await response.json();
      if (!data.list || data.list.length === 0) {
        console.log(`📭 搜索"${searchTitle}"未找到内容`);
        continue;
      }

      console.log(`🎬 搜索"${searchTitle}"找到 ${data.list.length} 个匹配结果`);

      let bestMatch: any = null;
      let exactMatch: any = null;

      for (const result of data.list) {
        console.log(`📋 候选: "${result.vod_name}" (类型: ${result.type_name})`);

        if (result.vod_name === searchTitle || result.vod_name === title) {
          console.log(`🎯 找到完全匹配: "${result.vod_name}"`);
          exactMatch = result;
          break;
        }

        const isUnwanted = result.vod_name.includes('解说') ||
          result.vod_name.includes('预告') ||
          result.vod_name.includes('花絮') ||
          result.vod_name.includes('动态漫') ||
          result.vod_name.includes('之精彩');

        if (isUnwanted) {
          console.log(`❌ 跳过不合适内容: "${result.vod_name}"`);
          continue;
        }

        if (!bestMatch) {
          bestMatch = result;
          console.log(`✅ 选择为候选: "${result.vod_name}"`);
        }
      }

      const selectedResult = exactMatch || bestMatch;

      if (selectedResult) {
        console.log(`✅ 使用搜索结果"${searchTitle}": "${selectedResult.vod_name}"`);
        return await processSelectedResult(selectedResult, episode);
      }
    }

    console.log('📭 所有标题变体都未找到匹配内容');
    return [];
  } catch (error) {
    console.error('❌ Caiji API搜索失败:', error);
    return [];
  }
}

// 处理选中的结果
async function processSelectedResult(selectedResult: any, episode?: string | null): Promise<PlatformUrl[]> {
  try {
    console.log(`🔄 处理选中的结果: "${selectedResult.vod_name}"`);
    const firstResult: any = selectedResult;
    const detailUrl = `https://www.caiji.cyou/api.php/provide/vod/?ac=detail&ids=${firstResult.vod_id}`;

    const detailResponse = await fetchWithProxy(detailUrl, {
      headers: {
        'User-Agent': getRandomUserAgent(),
      },
    });

    if (!detailResponse.ok) return [];

    const detailData: any = await detailResponse.json();
    if (!detailData.list || detailData.list.length === 0) return [];

    const videoInfo: any = detailData.list[0];
    console.log(`🎭 视频详情: "${videoInfo.vod_name}" (${videoInfo.vod_year})`);

    const urls: PlatformUrl[] = [];

    if (videoInfo.vod_play_url) {
      const playUrls = videoInfo.vod_play_url.split('#');
      console.log(`📺 找到 ${playUrls.length} 集`);

      let targetUrl = '';
      if (episode && parseInt(episode) > 0) {
        const episodeNum = parseInt(episode);
        const targetEpisode = playUrls.find((url: string) => {
          return url.startsWith(`${episodeNum}$`) ||
            url.startsWith(`第${episodeNum}集$`) ||
            url.startsWith(`E${episodeNum}$`) ||
            url.startsWith(`EP${episodeNum}$`);
        });
        if (targetEpisode) {
          targetUrl = targetEpisode.split('$')[1];
          console.log(`🎯 找到第${episode}集: ${targetUrl}`);
        } else {
          console.log(`❌ 未找到第${episode}集的链接`);
        }
      }

      if (!targetUrl && playUrls.length > 0) {
        targetUrl = playUrls[0].split('$')[1];
        console.log(`📺 使用第1集: ${targetUrl}`);
      }

      if (targetUrl) {
        let platform = 'unknown';
        if (targetUrl.includes('bilibili.com')) {
          platform = 'bilibili_caiji';
        } else if (targetUrl.includes('v.qq.com') || targetUrl.includes('qq.com')) {
          platform = 'tencent_caiji';
        } else if (targetUrl.includes('iqiyi.com')) {
          platform = 'iqiyi_caiji';
        } else if (targetUrl.includes('youku.com') || targetUrl.includes('v.youku.com')) {
          platform = 'youku_caiji';
        } else if (targetUrl.includes('mgtv.com') || targetUrl.includes('w.mgtv.com')) {
          platform = 'mgtv_caiji';
        }

        if (targetUrl.endsWith('.htm')) {
          targetUrl = targetUrl.replace(/\.htm$/, '.html');
          console.log(`🔧 修复${platform}链接格式: ${targetUrl}`);
        }

        console.log(`🎯 识别平台: ${platform}, URL: ${targetUrl}`);

        urls.push({
          platform: platform,
          url: targetUrl,
        });
      }
    }

    console.log(`✅ Caiji API返回 ${urls.length} 个播放链接`);
    return urls;
  } catch (error) {
    console.error('❌ Caiji API搜索失败:', error);
    return [];
  }
}

// 请求限制器 - 防止被封IP
let lastDoubanRequestTime = 0;
const MIN_DOUBAN_REQUEST_INTERVAL = 1000;

function randomDelay(min = 500, max = 1500): Promise<void> {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, delay));
}

// 从豆瓣页面提取平台视频链接
async function extractPlatformUrls(doubanId: string, episode?: string | null): Promise<PlatformUrl[]> {
  if (!doubanId) return [];

  const controller = new AbortController();
  let timeoutId: NodeJS.Timeout | undefined;

  try {
    const now = Date.now();
    const timeSinceLastRequest = now - lastDoubanRequestTime;
    if (timeSinceLastRequest < MIN_DOUBAN_REQUEST_INTERVAL) {
      await new Promise(resolve =>
        setTimeout(resolve, MIN_DOUBAN_REQUEST_INTERVAL - timeSinceLastRequest)
      );
    }
    lastDoubanRequestTime = Date.now();

    await randomDelay(300, 1000);

    timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetchWithProxy(`https://movie.douban.com/subject/${doubanId}/`, {
      signal: controller.signal,
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
        ...(Math.random() > 0.5 ? { 'Referer': 'https://www.douban.com/' } : {}),
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.log(`❌ 豆瓣页面请求失败: ${response.status}`);
      return [];
    }

    const html = await response.text();
    console.log(`📄 豆瓣页面HTML长度: ${html.length}`);
    const urls: PlatformUrl[] = [];

    // 腾讯视频
    const doubanLinkMatches = html.match(/play_link:\s*"[^"]*v\.qq\.com[^"]*"/g);
    if (doubanLinkMatches && doubanLinkMatches.length > 0) {
      console.log(`🎬 找到 ${doubanLinkMatches.length} 个腾讯视频链接`);
      let selectedMatch = doubanLinkMatches[0];
      if (episode && doubanLinkMatches.length > 1) {
        const episodeNum = parseInt(episode);
        if (episodeNum > 0 && episodeNum <= doubanLinkMatches.length) {
          selectedMatch = doubanLinkMatches[episodeNum - 1];
        }
      }
      const urlMatch = selectedMatch.match(/https%3A%2F%2Fv\.qq\.com[^"&]*/);
      if (urlMatch) {
        const decodedUrl = decodeURIComponent(urlMatch[0]).split('?')[0];
        urls.push({ platform: 'tencent', url: decodedUrl });
      }
    }

    // 爱奇艺
    const iqiyiMatches = html.match(/play_link:\s*"[^"]*iqiyi\.com[^"]*"/g);
    if (iqiyiMatches && iqiyiMatches.length > 0) {
      let selectedMatch = iqiyiMatches[0];
      if (episode && iqiyiMatches.length > 1) {
        const episodeNum = parseInt(episode);
        if (episodeNum > 0 && episodeNum <= iqiyiMatches.length) {
          selectedMatch = iqiyiMatches[episodeNum - 1];
        }
      }
      const urlMatch = selectedMatch.match(/https?%3A%2F%2F[^"&]*iqiyi\.com[^"&]*/);
      if (urlMatch) {
        const decodedUrl = decodeURIComponent(urlMatch[0]).split('?')[0];
        urls.push({ platform: 'iqiyi', url: decodedUrl });
      }
    }

    // 优酷
    const youkuMatches = html.match(/play_link:\s*"[^"]*youku\.com[^"]*"/g);
    if (youkuMatches && youkuMatches.length > 0) {
      let selectedMatch = youkuMatches[0];
      if (episode && youkuMatches.length > 1) {
        const episodeNum = parseInt(episode);
        if (episodeNum > 0 && episodeNum <= youkuMatches.length) {
          selectedMatch = youkuMatches[episodeNum - 1];
        }
      }
      const urlMatch = selectedMatch.match(/https?%3A%2F%2F[^"&]*youku\.com[^"&]*/);
      if (urlMatch) {
        const decodedUrl = decodeURIComponent(urlMatch[0]).split('?')[0];
        urls.push({ platform: 'youku', url: decodedUrl });
      }
    }

    // 直接提取腾讯视频链接
    const qqMatches = html.match(/https:\/\/v\.qq\.com\/x\/cover\/[^"'\s]+/g);
    if (qqMatches && qqMatches.length > 0) {
      urls.push({
        platform: 'tencent_direct',
        url: qqMatches[0].split('?')[0],
      });
    }

    // B站链接提取（直接链接）
    const biliMatches = html.match(/https:\/\/www\.bilibili\.com\/video\/[^"'\s]+/g);
    if (biliMatches && biliMatches.length > 0) {
      urls.push({
        platform: 'bilibili',
        url: biliMatches[0].split('?')[0],
      });
    }

    // B站链接提取（豆瓣跳转链接）
    const biliDoubanMatches = html.match(/play_link:\s*"[^"]*bilibili\.com[^"]*"/g);
    if (biliDoubanMatches && biliDoubanMatches.length > 0) {
      let selectedMatch = biliDoubanMatches[0];
      if (episode && biliDoubanMatches.length > 1) {
        const episodeNum = parseInt(episode);
        if (episodeNum > 0 && episodeNum <= biliDoubanMatches.length) {
          selectedMatch = biliDoubanMatches[episodeNum - 1];
        }
      }
      const urlMatch = selectedMatch.match(/https?%3A%2F%2F[^"&]*bilibili\.com[^"&]*/);
      if (urlMatch) {
        const decodedUrl = decodeURIComponent(urlMatch[0]).split('?')[0];
        urls.push({ platform: 'bilibili_douban', url: decodedUrl });
      }
    }

    // 转换移动版链接为PC版链接（弹幕库API需要PC版）
    const convertedUrls = urls.map(urlObj => {
      let convertedUrl = urlObj.url;

      if (convertedUrl.includes('m.youku.com/alipay_video/id_')) {
        convertedUrl = convertedUrl.replace(
          /https:\/\/m\.youku\.com\/alipay_video\/id_([^.]+)\.html/,
          'https://v.youku.com/v_show/id_$1.html'
        );
      }

      if (convertedUrl.includes('m.iqiyi.com/')) {
        convertedUrl = convertedUrl.replace('m.iqiyi.com', 'www.iqiyi.com');
      }

      if (convertedUrl.includes('m.v.qq.com/')) {
        convertedUrl = convertedUrl.replace('m.v.qq.com', 'v.qq.com');
      }

      if (convertedUrl.includes('m.bilibili.com/')) {
        convertedUrl = convertedUrl.replace('m.bilibili.com', 'www.bilibili.com');
        convertedUrl = convertedUrl.split('?')[0];
      }

      return { ...urlObj, url: convertedUrl };
    });

    console.log(`✅ 总共提取到 ${convertedUrls.length} 个平台链接`);
    return convertedUrls;
  } catch (error) {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (error instanceof DOMException && error.name === 'AbortError') {
      console.error('❌ 豆瓣请求超时 (10秒):', doubanId);
    } else {
      console.error('❌ 提取平台链接失败:', error);
    }
    return [];
  }
}

// 从XML API获取弹幕数据（支持多个备用URL）
async function fetchDanmuFromXMLAPI(videoUrl: string): Promise<DanmuItem[]> {
  const xmlApiUrls = [
    'https://fc.lyz05.cn',
    'https://danmu.smone.us'
  ];

  for (let i = 0; i < xmlApiUrls.length; i++) {
    const baseUrl = xmlApiUrls[i];
    const apiName = i === 0 ? '主用XML API' : `备用XML API ${i}`;
    const controller = new AbortController();
    const timeout = 15000;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const apiUrl = `${baseUrl}/?url=${encodeURIComponent(videoUrl)}`;
      console.log(`🌐 正在请求${apiName}:`, apiUrl);

      const response = await fetchWithProxy(apiUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Accept': 'application/xml, text/xml, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      });

      clearTimeout(timeoutId);
      console.log(`📡 ${apiName}响应状态:`, response.status);

      if (!response.ok) {
        console.log(`❌ ${apiName}响应失败:`, response.status);
        continue;
      }

      const responseText = await response.text();
      console.log(`📄 ${apiName}原始响应长度:`, responseText.length);

      const danmakuRegex = /<d p="([^"]*)"[^>]*>([^<]*)<\/d>/g;
      const danmuList: DanmuItem[] = [];
      let match;

      const SEGMENT_DURATION = 300;
      const MAX_DANMU_PER_SEGMENT = 500;
      const BATCH_SIZE = 200;

      const timeSegments: { [key: number]: DanmuItem[] } = {};
      let totalProcessed = 0;
      let batchCount = 0;

      while ((match = danmakuRegex.exec(responseText)) !== null) {
        try {
          const pAttr = match[1];
          const text = match[2];

          if (!pAttr || !text) continue;

          const trimmedText = text.trim();
          if (trimmedText.length === 0 ||
            trimmedText.length > 50 ||
            trimmedText.length < 2 ||
            /^[^一-龥a-zA-Z0-9]+$/.test(trimmedText) ||
            trimmedText.includes('弹幕正在赶来') ||
            trimmedText.includes('视频不错') ||
            trimmedText.includes('666') ||
            /^\d+$/.test(trimmedText) ||
            /^[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]+$/.test(trimmedText)) {
            continue;
          }

          const params = pAttr.split(',');
          if (params.length < 4) continue;

          const time = parseFloat(params[0]) || 0;
          const mode = parseInt(params[1]) || 0;
          const colorInt = parseInt(params[3]) || 16777215;

          if (time < 0 || time > 86400 || !Number.isFinite(time)) continue;

          const segmentIndex = Math.floor(time / SEGMENT_DURATION);
          if (!timeSegments[segmentIndex]) {
            timeSegments[segmentIndex] = [];
          }

          if (timeSegments[segmentIndex].length >= MAX_DANMU_PER_SEGMENT) {
            if (Math.random() < 0.1) {
              const randomIndex = Math.floor(Math.random() * timeSegments[segmentIndex].length);
              timeSegments[segmentIndex][randomIndex] = {
                text: trimmedText,
                time: time,
                color: '#' + colorInt.toString(16).padStart(6, '0').toUpperCase(),
                mode: mode === 4 ? 1 : mode === 5 ? 2 : 0,
              };
            }
            continue;
          }

          timeSegments[segmentIndex].push({
            text: trimmedText,
            time: time,
            color: '#' + colorInt.toString(16).padStart(6, '0').toUpperCase(),
            mode: mode === 4 ? 1 : mode === 5 ? 2 : 0,
          });

          totalProcessed++;
          batchCount++;

          if (batchCount >= BATCH_SIZE) {
            await new Promise(resolve => setTimeout(resolve, 0));
            batchCount = 0;
          }
        } catch (error) {
          console.error(`❌ 解析第${totalProcessed}条XML弹幕失败:`, error);
        }
      }

      for (const segmentIndex of Object.keys(timeSegments).sort((a, b) => parseInt(a) - parseInt(b))) {
        const segment = timeSegments[parseInt(segmentIndex)];
        segment.sort((a, b) => a.time - b.time);
        danmuList.push(...segment);
      }

      console.log(`📊 ${apiName}找到 ${danmuList.length} 条弹幕数据`);

      if (danmuList.length === 0) {
        console.log(`📭 ${apiName}未返回弹幕数据`);
        continue;
      }

      const filteredDanmu = danmuList.filter(item =>
        !item.text.includes('官方弹幕库') &&
        !item.text.includes('哔哩哔哩')
      );

      const maxAllowedDanmu = 20000;
      let finalDanmu = filteredDanmu;

      if (filteredDanmu.length > maxAllowedDanmu) {
        console.warn(`⚠️ 弹幕数量过多 (${filteredDanmu.length})，采用智能采样至 ${maxAllowedDanmu} 条`);
        const sampleRate = maxAllowedDanmu / filteredDanmu.length;
        finalDanmu = filteredDanmu.filter((_, index) => {
          return index === 0 ||
            index === filteredDanmu.length - 1 ||
            Math.random() < sampleRate ||
            index % Math.ceil(1 / sampleRate) === 0;
        }).slice(0, maxAllowedDanmu);
      }

      console.log(`✅ ${apiName}优化处理完成: ${finalDanmu.length} 条优质弹幕`);

      if (finalDanmu.length > 0) {
        const firstTime = finalDanmu[0].time;
        const lastTime = finalDanmu[finalDanmu.length - 1].time;
        console.log(`📊 ${apiName}弹幕概览: ${Math.floor(firstTime/60)}:${String(Math.floor(firstTime%60)).padStart(2,'0')} - ${Math.floor(lastTime/60)}:${String(Math.floor(lastTime%60)).padStart(2,'0')}`);
      }

      return finalDanmu;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof DOMException && error.name === 'AbortError') {
        console.error(`❌ ${apiName}请求超时 (${timeout/1000}秒):`, videoUrl);
      } else {
        console.error(`❌ ${apiName}请求失败:`, error);
      }
    }
  }

  console.log('❌ 所有XML API都无法获取弹幕数据');
  return [];
}

// 从danmu.icu获取弹幕数据
async function fetchDanmuFromAPI(videoUrl: string): Promise<DanmuItem[]> {
  const controller = new AbortController();

  let timeout = 20000;
  if (videoUrl.includes('iqiyi.com')) timeout = 30000;
  else if (videoUrl.includes('youku.com')) timeout = 25000;
  else if (videoUrl.includes('mgtv.com') || videoUrl.includes('w.mgtv.com')) timeout = 25000;

  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const apiUrl = `https://api.danmu.icu/?url=${encodeURIComponent(videoUrl)}`;
    console.log('🌐 正在请求弹幕API:', apiUrl);

    const response = await fetchWithProxy(apiUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': 'https://danmu.icu/',
      },
    });

    clearTimeout(timeoutId);
    console.log('📡 API响应状态:', response.status);

    if (!response.ok) {
      console.log('❌ API响应失败:', response.status);
      return [];
    }

    const responseText = await response.text();

    let data: DanmuApiResponse;
    try {
      data = JSON.parse(responseText);
    } catch (parseError) {
      console.error('❌ JSON解析失败:', parseError);
      return [];
    }

    if (!data.danmuku || !Array.isArray(data.danmuku)) return [];

    console.log(`获取到 ${data.danmuku.length} 条原始弹幕数据`);

    const danmuList = data.danmuku.map((item: any[]) => {
      const time = parseFloat(item[0]) || 0;
      const text = (item[4] || '').toString().trim();
      const color = item[2] || '#FFFFFF';

      let mode = 0;
      if (item[1] === 'top') mode = 1;
      else if (item[1] === 'bottom') mode = 2;
      else mode = 0;

      return {
        text: text,
        time: time,
        color: color,
        mode: mode,
      };
    }).filter(item => {
      const valid = item.text.length > 0 &&
        !item.text.includes('弹幕正在赶来') &&
        !item.text.includes('官方弹幕库') &&
        item.time >= 0;
      return valid;
    }).sort((a, b) => a.time - b.time);

    return danmuList;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof DOMException && error.name === 'AbortError') {
      console.error(`❌ 弹幕API请求超时 (${timeout/1000}秒):`, videoUrl);
    } else {
      console.error('❌ 获取弹幕失败:', error);
    }
    return [];
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const doubanId = searchParams.get('douban_id');
  const title = searchParams.get('title');
  const year = searchParams.get('year');
  const episode = searchParams.get('episode');
  const manualEpisodeId = searchParams.get('episode_id');

  console.log('=== 弹幕API请求参数 ===');
  console.log('豆瓣ID:', doubanId);
  console.log('标题:', title);
  console.log('年份:', year);
  console.log('集数:', episode);
  console.log('服务器HTTP代理:', getActiveProxyUrl());
  if (manualEpisodeId) console.log('手动匹配episodeId:', manualEpisodeId);

  // 手动匹配模式：直接通过 episodeId 获取弹幕
  if (manualEpisodeId) {
    const episodeIdNum = parseInt(manualEpisodeId, 10);
    if (!Number.isFinite(episodeIdNum) || episodeIdNum <= 0) {
      return NextResponse.json(
        { error: 'episode_id 无效', danmu: [], total: 0 },
        { status: 400 },
      );
    }

    try {
      const result = await fetchDanmuByEpisodeId(episodeIdNum);
      const danmu = result?.danmu || [];
      const uniqueDanmu = deduplicateDanmu(danmu);

      return NextResponse.json({
        danmu: uniqueDanmu,
        platforms: [{ platform: 'manual_match', source: result?.source || '手动匹配', count: uniqueDanmu.length }],
        total: uniqueDanmu.length,
      });
    } catch (error) {
      console.error('[手动匹配] 获取弹幕失败:', error);
      return NextResponse.json(
        { error: '手动匹配弹幕获取失败', danmu: [], total: 0 },
        { status: 500 },
      );
    }
  }

  if (!doubanId && !title) {
    return NextResponse.json({
      error: 'Missing required parameters: douban_id or title'
    }, { status: 400 });
  }

  try {
    // 🚀 并行启动所有弹幕源，使用 "首批有效结果" 策略
    // 优先级：弹幕API(match快速路径) > B站 > 豆瓣/Caiji
    // 弹幕API先单独快速尝试 match 路径（<3秒），若失败则所有源并发启动
    const startTime = Date.now();

    // ===== 第一阶段：弹幕API快速 match 路径（单独，优先返回） =====
    let customResult: { danmu: DanmuItem[]; source: string } | null = null;
    if (title) {
      console.log('🚀 [快速路径] 尝试弹幕API match...');
      const config = await getDanmuApiConfig();
      if (config.enabled && config.apiUrl) {
        // 只使用 match 接口（快速路径），如果匹配成功就直接返回
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        try {
          let fileName = title;
          if (episode) {
            const epNum = parseInt(episode);
            if (epNum > 0) {
              fileName = `${title} S01E${String(epNum).padStart(2, '0')}`;
            }
          }
          const matchUrl = `${config.apiUrl}/${config.token}/api/v2/match`;
          const matchResponse = await fetchWithProxy(matchUrl, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'User-Agent': getRandomUserAgent(),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ fileName }),
          });
          clearTimeout(timeoutId);

          if (matchResponse.ok) {
            const matchData = await matchResponse.json();
            if (matchData.success && matchData.isMatched && matchData.matches?.length > 0) {
              const bestMatch = matchData.matches[0];
              const commentUrl = `${config.apiUrl}/${config.token}/api/v2/comment/${bestMatch.episodeId}?format=json`;
              const commentResponse = await fetchWithProxy(commentUrl, {
                signal: AbortSignal.timeout(8000),
                headers: { 'User-Agent': getRandomUserAgent() },
              });
              if (commentResponse.ok) {
                const commentData = await commentResponse.json();
                if (commentData.comments && Array.isArray(commentData.comments) && commentData.comments.length >= 10) {
                  const processed = processDanmuComments(commentData.comments);
                  if (processed.length >= 10) {
                    customResult = { danmu: processed, source: `弹幕API/match (${bestMatch.animeTitle})` };
                    console.log(`✅ [快速路径] match成功 ${processed.length} 条弹幕 (${Date.now() - startTime}ms)`);
                  }
                }
              }
            }
          }
        } catch {
          clearTimeout(timeoutId);
          console.log('⏭️ [快速路径] match未命中，启动全源并行搜索...');
        }
      }
    }

    // match 成功则立即返回
    if (customResult && customResult.danmu.length > 0) {
      const uniqueDanmu = deduplicateDanmu(customResult.danmu);
      return NextResponse.json({
        danmu: uniqueDanmu,
        platforms: [{ platform: 'danmu_api', source: customResult.source, count: uniqueDanmu.length }],
        total: uniqueDanmu.length,
      });
    }

    // ===== 第二阶段：所有源并行启动 =====
    console.log(`🚀 [并行搜索] 启动所有弹幕源并行搜索 (${Date.now() - startTime}ms)...`);

    // 弹幕API完整搜索（match失败后走search→bangumi→comment）
    const customPromise = title
      ? fetchDanmuFromCustomAPI(title, episode, year).catch(() => null)
      : Promise.resolve(null);

    // B站直接弹幕
    const biliPromise = title
      ? fetchDanmuFromBilibili(title, episode).catch(() => null)
      : Promise.resolve(null);

    // 豆瓣/Caiji 备用
    const fallbackPromise = (async (): Promise<PlatformUrl[]> => {
      let urls: PlatformUrl[] = [];
      if (doubanId) {
        console.log('🔍 [备用] 从豆瓣页面提取链接...');
        urls = await extractPlatformUrls(doubanId, episode);
      }
      if (urls.length === 0 && title) {
        console.log('🔍 [备用] 使用Caiji API搜索...');
        const caijiUrls = await searchFromCaijiAPI(title, episode);
        if (caijiUrls.length > 0) urls = caijiUrls;
      }
      return urls;
    })().catch(() => []);

    // 等待弹幕API或B站任一成功，同时让fallback在后台准备
    const [customApiResult, biliResult, platformUrls] = await Promise.all([
      customPromise,
      biliPromise,
      fallbackPromise,
    ]);

    console.log(`📊 [并行结果] 弹幕API: ${customApiResult?.danmu?.length || 0}条, B站: ${biliResult?.danmu?.length || 0}条, 备用平台: ${platformUrls?.length || 0}个 (${Date.now() - startTime}ms)`);

    // 优先使用弹幕API结果
    if (customApiResult && customApiResult.danmu.length > 0) {
      const uniqueDanmu = deduplicateDanmu(customApiResult.danmu);
      return NextResponse.json({
        danmu: uniqueDanmu,
        platforms: [{ platform: 'danmu_api', source: customApiResult.source, count: uniqueDanmu.length }],
        total: uniqueDanmu.length,
      });
    }

    // 其次使用B站结果
    if (biliResult && biliResult.danmu.length > 0) {
      const uniqueDanmu = deduplicateDanmu(biliResult.danmu);
      return NextResponse.json({
        danmu: uniqueDanmu,
        platforms: [{ platform: 'bilibili', source: biliResult.source, count: uniqueDanmu.length }],
        total: uniqueDanmu.length,
      });
    }

    // 最后使用豆瓣/Caiji备用方案
    if (!platformUrls || platformUrls.length === 0) {
      console.log('❌ 未找到任何视频平台链接，返回空弹幕结果');
      return NextResponse.json({
        danmu: [],
        platforms: [],
        total: 0,
        message: `未找到"${title}"的视频平台链接，无法获取弹幕数据`
      });
    }

    // 并发获取多个平台的弹幕（使用XML API + JSON API备用）
    const danmuPromises = platformUrls.map(async ({ platform, url }) => {
      console.log(`🔄 处理平台: ${platform}, URL: ${url}`);

      let danmu = await fetchDanmuFromXMLAPI(url);
      console.log(`📊 ${platform} XML API获取到 ${danmu.length} 条弹幕`);

      if (danmu.length === 0) {
        console.log(`🔄 ${platform} XML API无结果，尝试JSON API备用...`);
        const jsonDanmu = await fetchDanmuFromAPI(url);
        console.log(`📊 ${platform} JSON API获取到 ${jsonDanmu.length} 条弹幕`);

        if (jsonDanmu.length > 0) {
          danmu = jsonDanmu;
        }
      }

      return { platform, danmu, url };
    });

    const results = await Promise.allSettled(danmuPromises);

    let allDanmu: DanmuItem[] = [];
    const platformInfo: any[] = [];

    results.forEach((result) => {
      if (result.status === 'fulfilled' && result.value.danmu.length > 0) {
        allDanmu = allDanmu.concat(result.value.danmu);
        platformInfo.push({
          platform: result.value.platform,
          url: result.value.url,
          count: result.value.danmu.length,
        });
      }
    });

    allDanmu.sort((a, b) => a.time - b.time);

    const uniqueDanmu = deduplicateDanmu(allDanmu);

    return NextResponse.json({
      danmu: uniqueDanmu,
      platforms: platformInfo,
      total: uniqueDanmu.length,
    });
  } catch (error) {
    console.error('外部弹幕获取失败:', error);
    return NextResponse.json({
      error: '获取外部弹幕失败',
      danmu: []
    }, { status: 500 });
  }
}
