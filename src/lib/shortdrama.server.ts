/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { getConfig } from '@/lib/config';
import { DEFAULT_USER_AGENT } from '@/lib/user-agent';
import { safeJsonParse } from '@/lib/shortdrama-safe-fetch';
import { ShortDramaItem } from './types';

// 默认短剧源
const DEFAULT_SHORT_DRAMA_API = 'https://tyyszyapi.com/api.php/provide/vod';

// 🔥 智能学习 SeeTV：除了父分类"短剧"外，短剧相关的子分类也包含大量内容
// 例如："女频恋爱"、"反转爽剧"、"古装仙侠"等分类是真正存有短剧内容的分类
const SHORT_DRAMA_KEYWORDS = ['短剧', '女频恋爱', '反转爽剧', '古装仙侠', '年代穿越', '脑洞悬疑', '现代都市'];

// 从某个分类直接获取短剧列表
async function fetchFromCategory(
  api: string,
  categoryId: number,
  size: number
): Promise<ShortDramaItem[]> {
  const apiUrl = `${api}?ac=detail&t=${categoryId}&pg=1`;

  const response = await fetch(apiUrl, {
    headers: { 'User-Agent': DEFAULT_USER_AGENT, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000),
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

// 从单个短剧源获取数据（通过分类名称查找）
async function fetchFromShortDramaSource(
  api: string,
  size: number
): Promise<ShortDramaItem[]> {
  // Step 1: 获取分类列表，找到"短剧"分类的ID
  const listUrl = `${api}?ac=list`;

  const listResponse = await fetch(listUrl, {
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!listResponse.ok) {
    throw new Error(`HTTP error! status: ${listResponse.status}`);
  }

  const listData = await safeJsonParse(listResponse);
  if (!listData) {
    throw new Error('分类列表API返回非JSON数据');
  }

  const categories = listData.class || [];

  // 🔥 查找短剧相关分类（多个）
  const shortDramaCategories = categories.filter((cat: any) =>
    cat.type_name && SHORT_DRAMA_KEYWORDS.some((kw: string) => cat.type_name.includes(kw))
  );

  if (shortDramaCategories.length === 0) {
    console.log(`该源没有短剧分类`);
    return [];
  }

  // 优先用父分类"短剧"，没有则用第一个匹配的子分类
  const primaryCategory = shortDramaCategories.find((cat: any) => cat.type_name === '短剧')
    || shortDramaCategories[0];
  const primaryCategoryId = primaryCategory.type_id;
  console.log(`找到短剧分类ID: ${primaryCategoryId} (${primaryCategory.type_name})`);

  // Step 2: 先尝试主分类
  try {
    const items = await fetchFromCategory(api, primaryCategoryId, size);
    if (items.length > 0) return items;
  } catch (err) {
    console.warn(`主分类 ${primaryCategoryId} 失败:`, err);
  }

  // Step 3: 🔥 主分类返回空时，尝试其他短剧子分类（参考 SeeTV 的关键字匹配）
  console.log(`⚠️ 主分类 ${primaryCategoryId} 返回空，尝试其他短剧子分类`);
  for (const altCategory of shortDramaCategories) {
    if (altCategory.type_id === primaryCategoryId) continue;
    try {
      const items = await fetchFromCategory(api, altCategory.type_id, size);
      if (items.length > 0) {
        console.log(`✅ 子分类 ${altCategory.type_id} (${altCategory.type_name}) 返回 ${items.length} 条`);
        return items;
      }
    } catch (err) {
      console.warn(`子分类 ${altCategory.type_id} 失败:`, err);
    }
  }

  // Step 4: 🔥 全部子分类都为空，再硬编码尝试已知的 tyyszyapi 短剧分类 ID
  const FALLBACK_IDS = [54, 73, 64, 65, 66, 67, 68, 69];
  for (const fallbackId of FALLBACK_IDS) {
    try {
      const items = await fetchFromCategory(api, fallbackId, size);
      if (items.length > 0) {
        console.log(`✅ 硬编码分类 ${fallbackId} 返回 ${items.length} 条`);
        return items;
      }
    } catch (_) {
      // ignore
    }
  }

  console.log(`所有短剧分类都为空`);
  return [];
}

// 服务端专用函数，从所有短剧源聚合数据
export async function getRecommendedShortDramas(
  category?: number,
  size = 10
): Promise<ShortDramaItem[]> {
  try {
    const config = await getConfig();

    // 筛选出所有启用的短剧源
    const shortDramaSources = (config.SourceConfig || []).filter(
      (source: any) => source.type === 'shortdrama' && !source.disabled
    );

    console.log(`📺 找到 ${shortDramaSources.length} 个配置的短剧源`);

    // 如果没有配置短剧源，使用默认源
    if (shortDramaSources.length === 0) {
      console.log('📺 使用默认短剧源');
      return await fetchFromShortDramaSource(DEFAULT_SHORT_DRAMA_API, size);
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
    const allItems: ShortDramaItem[] = [];
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
      new Map(allItems.map(item => [item.name, item])).values()
    );

    // 按更新时间排序
    uniqueItems.sort((a, b) =>
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
      console.log('⚠️ 出错，fallback到默认源');
      return await fetchFromShortDramaSource(DEFAULT_SHORT_DRAMA_API, size);
    } catch (fallbackError) {
      console.error('默认源也失败:', fallbackError);
      return [];
    }
  }
}
