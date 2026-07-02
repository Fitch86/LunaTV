/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, no-console, @next/next/no-img-element */

'use client';

import Artplayer from 'artplayer';
import Hls from 'hls.js';
import { ChevronUp,Heart } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

import { ClientCache } from '@/lib/client-cache';
import {
  deleteFavorite,
  deletePlayRecord,
  deleteSkipConfig,
  EpisodeSkipConfig,
  generateStorageKey,
  getAllPlayRecords,
  getSkipConfig,
  getVideoSkipConfigKey,
  isFavorited,
  saveFavorite,
  savePlayRecord,
  saveSkipConfig,
  subscribeToDataUpdates,
} from '@/lib/db.client';
import { getDoubanDetails } from '@/lib/douban.client';
import { SearchResult } from '@/lib/types';
import { getVideoResolutionFromM3u8, processImageUrl } from '@/lib/utils';

import EpisodeSelector from '@/components/EpisodeSelector';
import LiveLoadingIndicator from '@/components/LiveLoadingIndicator';
import PageLayout from '@/components/PageLayout';
import DanmuManualMatchModal, { DanmuManualSelection } from '@/components/DanmuManualMatchModal';
import SkipController from '@/components/SkipController';

// 扩展 HTMLVideoElement 类型以支持 hls 属性
declare global {
  interface HTMLVideoElement {
    hls?: any;
  }
}

// Wake Lock API 类型声明
interface WakeLockSentinel {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
  removeEventListener(type: 'release', listener: () => void): void;
}
import { useVideoLoadingState } from '@/hooks/useVideoLoadingState';

function PlayPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // -----------------------------------------------------------------------------
  // 状态变量（State）
  // -----------------------------------------------------------------------------
  const [loading, setLoading] = useState(true);
  const [loadingStage, setLoadingStage] = useState<
    'searching' | 'preferring' | 'fetching' | 'ready'
  >('searching');
  const [loadingMessage, setLoadingMessage] = useState('正在搜索播放源...');
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<SearchResult | null>(null);

  // 豆瓣详情状态
  const [movieDetails, setMovieDetails] = useState<any>(null);
  const [loadingMovieDetails, setLoadingMovieDetails] = useState(false);

  // 返回顶部按钮显示状态
  const [showBackToTop, setShowBackToTop] = useState(false);

  // bangumi详情状态
  const [bangumiDetails, setBangumiDetails] = useState<any>(null);
  const [loadingBangumiDetails, setLoadingBangumiDetails] = useState(false);

  // 换源加载状态
  const [playVideoLoading, setPlayVideoLoading] = useState(true);
  const [_playVideoLoadingStage] = useState<
    'idle' | 'connecting' | 'buffering' | 'ready'
  >('idle');
  
  // 使用新的加载状态Hook
  const {
    loadingState: videoLoadingState,
    loadingMessage: videoLoadingMessage,
    loadingTime: videoLoadingTime,
    proxyStatus,
    updateLoadingState,
    resetLoadingState,
  } = useVideoLoadingState();

  // 收藏状态
  const [favorited, setFavorited] = useState(false);

  // 跳过片头片尾配置（UI state，用于artplayer settings面板）
  const [skipConfig, setSkipConfig] = useState<{
    enable: boolean;
    intro_time: number;
    outro_time: number;
  }>({
    enable: false,
    intro_time: 0,
    outro_time: 0,
  });
  const skipConfigRef = useRef(skipConfig);
  useEffect(() => {
    skipConfigRef.current = skipConfig;
  }, [
    skipConfig,
    skipConfig.enable,
    skipConfig.intro_time,
    skipConfig.outro_time,
  ]);

  // 跳过检查的时间间隔控制
  const lastSkipCheckRef = useRef(0);

  // 去广告开关（从 localStorage 继承，默认 true）
  const [blockAdEnabled, setBlockAdEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const v = localStorage.getItem('enable_blockad');
      if (v !== null) return v === 'true';
    }
    return true;
  });
  const blockAdEnabledRef = useRef(blockAdEnabled);
  useEffect(() => {
    blockAdEnabledRef.current = blockAdEnabled;
  }, [blockAdEnabled]);

  // 外部弹幕开关（从 localStorage 继承，默认 true）
  const [externalDanmuEnabled, setExternalDanmuEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const v = localStorage.getItem('enable_external_danmu');
      if (v !== null) return v === 'true';
    }
    return true;
  });
  const [isDanmuManualModalOpen, setIsDanmuManualModalOpen] = useState(false);
  const [isSkipSettingMode, setIsSkipSettingMode] = useState(false);
  const [currentPlayTime, setCurrentPlayTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const manualDanmuOverrideRef = useRef<{ episodeId: number } | null>(null);
const externalDanmuEnabledRef = useRef(externalDanmuEnabled);
const danmakuObserverRef = useRef<MutationObserver | null>(null);
useEffect(() => {
    externalDanmuEnabledRef.current = externalDanmuEnabled;
    enforceDanmakuVisibility();
}, [externalDanmuEnabled]);

// 弹幕可见性强制控制：通过MutationObserver + inline !important
// 无论插件内部如何调用show()/load()/reset()，都能保持弹幕关闭
const enforceDanmakuVisibility = () => {
    const $danmuku = document.querySelector('.art-danmuku') as HTMLElement | null;
    if (!$danmuku) return;
    if (!externalDanmuEnabledRef.current) {
        $danmuku.style.setProperty('opacity', '0', 'important');
        $danmuku.style.setProperty('pointer-events', 'none', 'important');
    } else {
        $danmuku.style.removeProperty('opacity');
        $danmuku.style.removeProperty('pointer-events');
    }
};

const startDanmakuObserver = () => {
    if (danmakuObserverRef.current) danmakuObserverRef.current.disconnect();
    const $danmuku = document.querySelector('.art-danmuku');
    if (!$danmuku) return;
    const observer = new MutationObserver(() => {
        if (!externalDanmuEnabledRef.current) {
            const el = $danmuku as HTMLElement;
            if (el.style.opacity !== '0') {
                el.style.setProperty('opacity', '0', 'important');
            }
        }
    });
    observer.observe($danmuku, { attributes: true, attributeFilter: ['style'] });
    danmakuObserverRef.current = observer;
};

  // 视频基本信息
  const [videoTitle, setVideoTitle] = useState(searchParams.get('title') || '');
  const [videoYear, setVideoYear] = useState(searchParams.get('year') || '');
  const [videoCover, setVideoCover] = useState('');

  // bangumi ID检测（3-6位数字，仅作为fallback）
  const isBangumiId = (id: number): boolean => {
    const length = id.toString().length;
    return id > 0 && length >= 3 && length <= 6;
  };
  
  // 优先读取 bangumi_id URL 参数（由 VideoCard 的 isBangumi 传入）
  const explicitBangumiId = parseInt(searchParams.get('bangumi_id') || '0') || 0;
  const idFromUrl = parseInt(searchParams.get('douban_id') || '0') || 0;
  // 如果有显式 bangumi_id 参数，直接使用；否则对 douban_id 做启发式检测
  const isInitialIdBangumi = explicitBangumiId > 0 || isBangumiId(idFromUrl);

  const [bangumiSubjectId] = useState(
    explicitBangumiId > 0 ? explicitBangumiId : (isInitialIdBangumi ? idFromUrl : 0)
  );
  const [videoDoubanId, setVideoDoubanId] = useState(
    explicitBangumiId > 0 ? 0 : (isInitialIdBangumi ? 0 : idFromUrl)
  );

  // 当前源和ID
  const [currentSource, setCurrentSource] = useState(
    searchParams.get('source') || ''
  );
  const [currentId, setCurrentId] = useState(searchParams.get('id') || '');

  // 搜索所需信息
  const [searchTitle] = useState(searchParams.get('stitle') || '');
  const [searchType] = useState(searchParams.get('stype') || '');

  // 是否需要优选
  const [needPrefer, setNeedPrefer] = useState(
    searchParams.get('prefer') === 'true'
  );
  const needPreferRef = useRef(needPrefer);
  useEffect(() => {
    needPreferRef.current = needPrefer;
  }, [needPrefer]);
  // 集数相关
  const [currentEpisodeIndex, setCurrentEpisodeIndex] = useState(0);

  const currentSourceRef = useRef(currentSource);
  const currentIdRef = useRef(currentId);
  const videoTitleRef = useRef(videoTitle);
  const videoYearRef = useRef(videoYear);
  const detailRef = useRef<SearchResult | null>(detail);
  const currentEpisodeIndexRef = useRef(currentEpisodeIndex);
  const videoDoubanIdRef = useRef(videoDoubanId);
  
  // 同步最新值到 refs
  useEffect(() => {
    currentSourceRef.current = currentSource;
    currentIdRef.current = currentId;
    detailRef.current = detail;
    currentEpisodeIndexRef.current = currentEpisodeIndex;
    videoTitleRef.current = videoTitle;
    videoYearRef.current = videoYear;
    videoDoubanIdRef.current = videoDoubanId;
  }, [
    currentSource,
    currentId,
    detail,
    currentEpisodeIndex,
    videoTitle,
    videoYear,
    videoDoubanId,
  ]);

  // 加载详情（豆瓣或bangumi）
  // First useEffect: Handles loading Bangumi details
  useEffect(() => {
    if (!bangumiSubjectId) return; // Only run if there is a Bangumi ID

    setLoadingBangumiDetails(true);
    fetchBangumiDetails(bangumiSubjectId)
      .then(data => {
        if (data) setBangumiDetails(data);
      })
      .catch(error => console.error('Failed to load bangumi details:', error))
    .finally(() => setLoadingBangumiDetails(false));
  }, [bangumiSubjectId]); // This effect only re-runs if bangumiSubjectId changes

  // Second useEffect: Handles loading Douban details
  useEffect(() => {
    if (!videoDoubanId) return; // Only run if there is a Douban ID

    setLoadingMovieDetails(true);
    getDoubanDetails(videoDoubanId.toString())
      .then(response => {
        if (response.code === 200 && response.data) {
          setMovieDetails(response.data);
        }
      })
      .catch(error => console.error('Failed to load movie details:', error))
      .finally(() => setLoadingMovieDetails(false));
  }, [videoDoubanId]); // This effect only re-runs if videoDoubanId changes

  // 视频播放地址
  const [videoUrl, setVideoUrl] = useState('');

  // 总集数
  const totalEpisodes = detail?.episodes?.length || 0;

  // 用于记录是否需要在播放器 ready 后跳转到指定进度
  const resumeTimeRef = useRef<number | null>(null);
  // 上次使用的音量，默认 0.7
  const lastVolumeRef = useRef<number>(0.7);
  // 上次使用的播放速率，默认 1.0
  const lastPlaybackRateRef = useRef<number>(1.0);

  // 换源相关状态
  const [availableSources, setAvailableSources] = useState<SearchResult[]>([]);
  const [sourceSearchLoading, setSourceSearchLoading] = useState(false);
  const [sourceSearchError, setSourceSearchError] = useState<string | null>(
    null
  );

  // 优选和测速开关
  const [optimizationEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('enableOptimization');
      if (saved !== null) {
        try {
          return JSON.parse(saved);
        } catch {
          /* ignore */
        }
      }
    }
    return true;
  });

  // 保存优选时的测速结果，避免EpisodeSelector重复测速
  const [precomputedVideoInfo, setPrecomputedVideoInfo] = useState<
    Map<string, { quality: string; loadSpeed: string; pingTime: number }>
  >(new Map());

  // 弹幕缓存：避免重复请求相同的弹幕数据，支持页面刷新持久化（统一存储）
  const DANMU_CACHE_DURATION = 30 * 60; // 30分钟缓存（秒）
  const DANMU_CACHE_KEY_PREFIX = 'danmu-cache';
  
  // 获取单个弹幕缓存
  const getDanmuCacheItem = async (key: string): Promise<{ data: any[]; timestamp: number } | null> => {
    try {
      const cacheKey = `${DANMU_CACHE_KEY_PREFIX}-${key}`;
      // 优先从统一存储获取
      const cached = await ClientCache.get(cacheKey);
      if (cached) return cached as { data: any[]; timestamp: number };
      
      // 兜底：从localStorage获取（兼容性）
      if (typeof localStorage !== 'undefined') {
        const oldCacheKey = 'lunatv_danmu_cache';
        const localCached = localStorage.getItem(oldCacheKey);
        if (localCached) {
          const parsed = JSON.parse(localCached);
          const cacheMap = new Map(Object.entries(parsed));
          const item = cacheMap.get(key) as { data: any[]; timestamp: number } | undefined;
          if (item && typeof item.timestamp === 'number' && Date.now() - item.timestamp < DANMU_CACHE_DURATION * 1000) {
            return item;
          }
        }
      }
      
      return null;
    } catch (error) {
      console.warn('读取弹幕缓存失败:', error);
      return null;
    }
  };
  
  // 保存单个弹幕缓存
  const setDanmuCacheItem = async (key: string, data: any[]): Promise<void> => {
    try {
      const cacheKey = `${DANMU_CACHE_KEY_PREFIX}-${key}`;
      const cacheData = { data, timestamp: Date.now() };
      
      // 主要存储：统一存储
      await ClientCache.set(cacheKey, cacheData, DANMU_CACHE_DURATION);
      
      // 兜底存储：localStorage（兼容性，但只存储最近几个）
      if (typeof localStorage !== 'undefined') {
        try {
          const oldCacheKey = 'lunatv_danmu_cache';
          let localCache: Map<string, { data: any[]; timestamp: number }> = new Map();
          
          const existing = localStorage.getItem(oldCacheKey);
          if (existing) {
            const parsed = JSON.parse(existing);
            localCache = new Map(Object.entries(parsed)) as Map<string, { data: any[]; timestamp: number }>;
          }
          
          // 清理过期项并限制数量（最多保留10个）
          const now = Date.now();
          const validEntries = Array.from(localCache.entries())
            .filter(([, item]) => typeof item.timestamp === 'number' && now - item.timestamp < DANMU_CACHE_DURATION * 1000)
            .slice(-9); // 保留9个，加上新的共10个
            
          validEntries.push([key, cacheData]);
          
          const obj = Object.fromEntries(validEntries);
          localStorage.setItem(oldCacheKey, JSON.stringify(obj));
        } catch (e) {
          // localStorage可能满了，忽略错误
        }
      }
    } catch (error) {
      console.warn('保存弹幕缓存失败:', error);
    }
  };

  // 折叠状态（仅在 lg 及以上屏幕有效）
  const [isEpisodeSelectorCollapsed, setIsEpisodeSelectorCollapsed] =
    useState(false);

  // 播放进度保存相关
  const saveIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastSaveTimeRef = useRef<number>(0);

  // 🚀 新增：弹幕操作防抖和性能优化
  const danmuOperationTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const episodeSwitchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const danmuPluginStateRef = useRef<any>(null); // 保存弹幕插件状态
  const isSourceChangingRef = useRef<boolean>(false); // 标记是否正在换源
  const isEpisodeChangingRef = useRef<boolean>(false); // 标记是否正在切换集数
  const danmuLoadingRef = useRef<any>(false); // 弹幕加载状态
  const lastDanmuLoadKeyRef = useRef<string>(''); // 上次弹幕加载的键

  // 🚀 新增：连续切换源防抖和资源管理
  const sourceSwitchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingSwitchRef = useRef<any>(null); // 保存待处理的切换请求
  const switchPromiseRef = useRef<Promise<void> | null>(null); // 当前切换的Promise

  const artPlayerRef = useRef<any>(null);
  const artRef = useRef<HTMLDivElement | null>(null);
  // 弹幕插件模块（仅在客户端动态加载，避免 SSR 报错）
  const danmakuPluginRef = useRef<any>(null);

  // Wake Lock 相关
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // -----------------------------------------------------------------------------
  // 工具函数（Utils）
  // -----------------------------------------------------------------------------

  /**
   * 生成中文标点符号的搜索变体
   * @param query 原始查询
   * @returns 标点符号变体数组
   */
  const generateChinesePunctuationVariants = (query: string): string[] => {
    const variants: string[] = [];
    
    // 中文标点符号映射
    const punctuationMap: { [key: string]: string[] } = {
      '：': [':'],
      ':': ['：'],
      '，': [','],
      ',': ['，'],
      '。': ['.'],
      '.': ['。'],
      '！': ['!'],
      '!': ['！'],
      '？': ['?'],
      '?': ['？'],
      '（': ['('],
      '(': ['（'],
      '）': [')'],
      ')': ['）'],
      '「': ['“'],
      '“': ['「'],
      '」': ['”'],
      '”': ['」'],
    };
    
    const currentVariant = query;
    for (const [chinese, alternatives] of Object.entries(punctuationMap)) {
      if (currentVariant.includes(chinese)) {
        for (const alt of alternatives) {
          const newVariant = currentVariant.replace(new RegExp(chinese, 'g'), alt);
          if (newVariant !== query && !variants.includes(newVariant)) {
            variants.push(newVariant);
          }
        }
      }
    }
    
    return variants;
  };

  /**
   * 生成搜索查询的多种变体，提高搜索命中率
   * @param originalQuery 原始查询
   * @returns 按优先级排序的搜索变体数组
   */
  const generateSearchVariants = (originalQuery: string): string[] => {
    const variants: string[] = [];
    const trimmed = originalQuery.trim();

    // 1. 原始查询（最高优先级）
    variants.push(trimmed);

    // 2. 处理中文标点符号变体
    const chinesePunctuationVariants = generateChinesePunctuationVariants(trimmed);
    chinesePunctuationVariants.forEach(variant => {
      if (!variants.includes(variant)) {
        variants.push(variant);
      }
    });

    // 3. 去除季数后缀变体（如" 第二季"、"第2季"、"S2"等）
    // 视频源可能以不同方式标注季数，也可能只列基础标题
    const seasonPatterns = [
      /\s*第[一二三四五六七八九十\d]+季\s*$/,   // "第二季", "第2季"
      /\s*Season\s*\d+\s*$/i,                    // "Season 2"
      /\s*S\d+\s*$/i,                             // "S2"
      /\s*[Ss]\d+\s*$/,                           // "s2"
    ];
    for (const pattern of seasonPatterns) {
      const withoutSeason = trimmed.replace(pattern, '').trim();
      if (withoutSeason && withoutSeason !== trimmed && !variants.includes(withoutSeason)) {
        variants.push(withoutSeason);
        break; // 只取第一个匹配的变体，避免重复
      }
    }

    // 4. 提取中文主标题（剥离英文副标题）
    // 如 "北斗神拳 -FIST OF THE NORTH STAR-" → "北斗神拳"
    const chineseMainTitle = trimmed.match(/^([\u4e00-\u9fff]+)/);
    if (chineseMainTitle && chineseMainTitle[1].length >= 2) {
      const mainTitle = chineseMainTitle[1].trim();
      if (mainTitle !== trimmed && !variants.includes(mainTitle)) {
        variants.push(mainTitle);
      }
    }

    // 如果包含空格，生成额外变体
    if (trimmed.includes(' ')) {
      // 5. 去除所有空格
      const noSpaces = trimmed.replace(/\s+/g, '');
      if (noSpaces !== trimmed) {
        variants.push(noSpaces);
      }

      // 6. 标准化空格（多个空格合并为一个）
      const normalizedSpaces = trimmed.replace(/\s+/g, ' ');
      if (normalizedSpaces !== trimmed && !variants.includes(normalizedSpaces)) {
        variants.push(normalizedSpaces);
      }

      // 7. 提取关键词组合
      const keywords = trimmed.split(/\s+/);
      if (keywords.length >= 2) {
        const mainKeyword = keywords[0];
        const lastKeyword = keywords[keywords.length - 1];

        if (/第|季|集|部|篇|章/.test(lastKeyword)) {
          const combined = mainKeyword + lastKeyword;
          if (!variants.includes(combined)) {
            variants.push(combined);
          }
        }
      }
    }

    console.log('🔍 搜索变体:', variants);
    return variants;
  };

  // 获取bangumi详情（通过服务器代理，避免ISP封锁）
  const fetchBangumiDetails = async (bangumiId: number) => {

    try {
      // 优先使用服务器代理路由，与 bangumi.client.ts 保持一致
      const proxyConfig = typeof window !== 'undefined' ? {
        type: localStorage.getItem('bangumiDataSource') || (window as any).RUNTIME_CONFIG?.BANGUMI_PROXY_TYPE || '',
        url: localStorage.getItem('bangumiProxyUrl') || (window as any).RUNTIME_CONFIG?.BANGUMI_PROXY || '',
      } : { type: '', url: '' };

      let fetchUrl = `/api/proxy/bangumi?path=v0/subjects/${bangumiId}`;
      if (proxyConfig.type) {
        fetchUrl += `&proxy=${encodeURIComponent(proxyConfig.type)}`;
      }
      if (proxyConfig.url) {
        fetchUrl += `&proxyUrl=${encodeURIComponent(proxyConfig.url)}`;
      }

      const response = await fetch(fetchUrl);
      if (response.ok) {
        const bangumiData = await response.json();
        return bangumiData;
      }
    } catch (error) {
      console.log('Failed to fetch bangumi details via proxy:', error);
      // 回退到直连
      try {
        const response = await fetch(`https://api.bgm.tv/v0/subjects/${bangumiId}`);
        if (response.ok) {
          const bangumiData = await response.json();
          return bangumiData;
        }
      } catch (fallbackError) {
        console.log('Failed to fetch bangumi details directly:', fallbackError);
      }
    }
    return null;
  };

  // 播放源优选函数
  const preferBestSource = async (
    sources: SearchResult[]
  ): Promise<SearchResult> => {
    if (sources.length === 1) return sources[0];

    // 将播放源均分为两批，并发测速各批，避免一次性过多请求
    const batchSize = Math.ceil(sources.length / 2);
    const allResults: Array<{
      source: SearchResult;
      testResult: { quality: string; loadSpeed: string; pingTime: number };
    } | null> = [];

    for (let start = 0; start < sources.length; start += batchSize) {
      const batchSources = sources.slice(start, start + batchSize);
      const batchResults = await Promise.all(
        batchSources.map(async (source) => {
          try {
            // 检查是否有第一集的播放地址
            if (!source.episodes || (source.episodes?.length ?? 0) === 0) {
              console.warn(`播放源 ${source.source_name} 没有可用的播放地址`);
              return null;
            }

            const eps = source.episodes ?? [];
            const episodeUrl = eps[(eps.length > 1) ? 1 : 0];
            const testResult = await getVideoResolutionFromM3u8(episodeUrl);

            return {
              source,
              testResult,
            };
          } catch (error) {
            return null;
          }
        })
      );
      allResults.push(...batchResults);
    }

    // 等待所有测速完成，包含成功和失败的结果
    // 保存所有测速结果到 precomputedVideoInfo，供 EpisodeSelector 使用（包含错误结果）
    const newVideoInfoMap = new Map<
      string,
      {
        quality: string;
        loadSpeed: string;
        pingTime: number;
        hasError?: boolean;
      }
    >();
    allResults.forEach((result, index) => {
      const source = sources[index];
      const sourceKey = `${source.source}-${source.id}`;

      if (result) {
        // 成功的结果
        newVideoInfoMap.set(sourceKey, result.testResult);
      }
    });

    // 过滤出成功的结果用于优选计算
    const successfulResults = allResults.filter(Boolean) as Array<{
      source: SearchResult;
      testResult: { quality: string; loadSpeed: string; pingTime: number };
    }>;

    setPrecomputedVideoInfo(newVideoInfoMap);

    if (successfulResults.length === 0) {
      console.warn('所有播放源测速都失败，使用第一个播放源');
      return sources[0];
    }

    // 找出所有有效速度的最大值，用于线性映射
    const validSpeeds = successfulResults
      .map((result) => {
        const speedStr = result.testResult.loadSpeed;
        if (speedStr === '未知' || speedStr === '测量中...') return 0;

        const match = speedStr.match(/^([\d.]+)\s*(KB\/s|MB\/s)$/);
        if (!match) return 0;

        const value = parseFloat(match[1]);
        const unit = match[2];
        return unit === 'MB/s' ? value * 1024 : value; // 统一转换为 KB/s
      })
      .filter((speed) => speed > 0);

    const maxSpeed = validSpeeds.length > 0 ? Math.max(...validSpeeds) : 1024; // 默认1MB/s作为基准

    // 找出所有有效延迟的最小值和最大值，用于线性映射
    const validPings = successfulResults
      .map((result) => result.testResult.pingTime)
      .filter((ping) => ping > 0);

    const minPing = validPings.length > 0 ? Math.min(...validPings) : 50;
    const maxPing = validPings.length > 0 ? Math.max(...validPings) : 1000;

    // 计算每个结果的评分
    const resultsWithScore = successfulResults.map((result) => ({
      ...result,
      score: calculateSourceScore(
        result.testResult,
        maxSpeed,
        minPing,
        maxPing
      ),
    }));

    // 按综合评分排序，选择最佳播放源
    resultsWithScore.sort((a, b) => b.score - a.score);

    console.log('播放源评分排序结果:');
    resultsWithScore.forEach((result, index) => {
      console.log(
        `${index + 1}. ${result.source.source_name
        } - 评分: ${result.score.toFixed(2)} (${result.testResult.quality}, ${result.testResult.loadSpeed
        }, ${result.testResult.pingTime}ms)`
      );
    });

    return resultsWithScore[0].source;
  };

  // 计算播放源综合评分
  const calculateSourceScore = (
    testResult: {
      quality: string;
      loadSpeed: string;
      pingTime: number;
    },
    maxSpeed: number,
    minPing: number,
    maxPing: number
  ): number => {
    let score = 0;

    // 分辨率评分 (40% 权重)
    const qualityScore = (() => {
      switch (testResult.quality) {
        case '4K':
          return 100;
        case '2K':
          return 85;
        case '1080p':
          return 75;
        case '720p':
          return 60;
        case '480p':
          return 40;
        case 'SD':
          return 20;
        default:
          return 0;
      }
    })();
    score += qualityScore * 0.4;

    // 下载速度评分 (40% 权重) - 基于最大速度线性映射
    const speedScore = (() => {
      const speedStr = testResult.loadSpeed;
      if (speedStr === '未知' || speedStr === '测量中...') return 30;

      // 解析速度值
      const match = speedStr.match(/^([\d.]+)\s*(KB\/s|MB\/s)$/);
      if (!match) return 30;

      const value = parseFloat(match[1]);
      const unit = match[2];
      const speedKBps = unit === 'MB/s' ? value * 1024 : value;

      // 基于最大速度线性映射，最高100分
      const speedRatio = speedKBps / maxSpeed;
      return Math.min(100, Math.max(0, speedRatio * 100));
    })();
    score += speedScore * 0.4;

    // 网络延迟评分 (20% 权重) - 基于延迟范围线性映射
    const pingScore = (() => {
      const ping = testResult.pingTime;
      if (ping <= 0) return 0; // 无效延迟给默认分

      // 如果所有延迟都相同，给满分
      if (maxPing === minPing) return 100;

      // 线性映射：最低延迟=100分，最高延迟=0分
      const pingRatio = (maxPing - ping) / (maxPing - minPing);
      return Math.min(100, Math.max(0, pingRatio * 100));
    })();
    score += pingScore * 0.2;

    return Math.round(score * 100) / 100; // 保留两位小数
  };

  // 更新视频地址
  const updateVideoUrl = async (
    detailData: SearchResult | null,
    episodeIndex: number
  ) => {
    if (
      !detailData ||
      !detailData.episodes ||
      episodeIndex >= (detailData.episodes?.length ?? 0)
    ) {
      setVideoUrl('');
      return;
    }

    const episodeData = detailData.episodes[episodeIndex];

    // 检查是否为短剧格式
    if (episodeData && episodeData.startsWith('shortdrama:')) {
      try {
        const [, videoId, episode] = episodeData.split(':');
        const response = await fetch(
          `/api/shortdrama/parse?id=${videoId}&episode=${episode}`
        );

        if (response.ok) {
          const result = await response.json();
          const newUrl = result.url || '';
          if (newUrl !== videoUrl) {
            setVideoUrl(newUrl);
          }
        } else {
          setError('短剧解析失败');
          setVideoUrl('');
        }
      } catch (err) {
        console.error('短剧URL解析失败:', err);
        setError('短剧解析失败');
        setVideoUrl('');
      }
    } else {
      // 普通视频格式
      const newUrl = episodeData || '';
      if (newUrl !== videoUrl) {
        setVideoUrl(newUrl);
      }
    }
  };

  const ensureVideoSource = (video: HTMLVideoElement | null, url: string) => {
    if (!video || !url) return;
    const sources = Array.from(video.getElementsByTagName('source'));
    const existed = sources.some((s) => s.src === url);
    if (!existed) {
      // 移除旧的 source，保持唯一
      sources.forEach((s) => s.remove());
      const sourceEl = document.createElement('source');
      sourceEl.src = url;
      video.appendChild(sourceEl);
    }

    // 始终允许远程播放（AirPlay / Cast）
    video.disableRemotePlayback = false;
    // 如果曾经有禁用属性，移除之
    if (video.hasAttribute('disableRemotePlayback')) {
      video.removeAttribute('disableRemotePlayback');
    }
  };

  // Wake Lock 相关函数
  const requestWakeLock = async () => {
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await (navigator as any).wakeLock.request(
          'screen'
        );
        console.log('Wake Lock 已启用');
      }
    } catch (err) {
      console.warn('Wake Lock 请求失败:', err);
    }
  };

  const releaseWakeLock = async () => {
    try {
      if (wakeLockRef.current) {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
        console.log('Wake Lock 已释放');
      }
    } catch (err) {
      console.warn('Wake Lock 释放失败:', err);
    }
  };

  // 清理播放器资源的统一函数
  const cleanupPlayer = () => {
    // 清理弹幕观察者
    if (danmakuObserverRef.current) {
        danmakuObserverRef.current.disconnect();
        danmakuObserverRef.current = null;
    }
    // 🚀 新增：清理弹幕优化相关的定时器
    if (danmuOperationTimeoutRef.current) {
      clearTimeout(danmuOperationTimeoutRef.current);
      danmuOperationTimeoutRef.current = null;
    }
    
    if (episodeSwitchTimeoutRef.current) {
      clearTimeout(episodeSwitchTimeoutRef.current);
      episodeSwitchTimeoutRef.current = null;
    }
    
    // 清理弹幕状态引用
    danmuPluginStateRef.current = null;

    if (artPlayerRef.current) {
      try {
        // 1. 清理弹幕插件的WebWorker
        if (artPlayerRef.current.plugins?.artplayerPluginDanmuku) {
          const danmukuPlugin = artPlayerRef.current.plugins.artplayerPluginDanmuku;
          
          // 尝试获取并清理WebWorker
          if (danmukuPlugin.worker && typeof danmukuPlugin.worker.terminate === 'function') {
            danmukuPlugin.worker.terminate();
            console.log('弹幕WebWorker已清理');
          }
          
          // 清空弹幕数据
          if (typeof danmukuPlugin.reset === 'function') {
            danmukuPlugin.reset();
          }
        }

        // 销毁 HLS 实例
        if (artPlayerRef.current.video && artPlayerRef.current.video.hls) {
          artPlayerRef.current.video.hls.destroy();
        }

        // 销毁 ArtPlayer 实例
        artPlayerRef.current.destroy();
        artPlayerRef.current = null;

        console.log('播放器资源已清理');
        updateLoadingState('idle', '播放器已清理');
      } catch (err) {
        console.warn('清理播放器资源时出错:', err);
        artPlayerRef.current = null;
        updateLoadingState('error', '清理播放器资源时出错');
      }
    }
  };

  // 去广告相关函数
  function filterAdsFromM3U8(m3u8Content: string): string {
    if (!m3u8Content) return '';

    // 按行分割M3U8内容
    const lines = m3u8Content.split('\n');
    const filteredLines = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 只过滤#EXT-X-DISCONTINUITY标识
      if (!line.includes('#EXT-X-DISCONTINUITY')) {
        filteredLines.push(line);
      }
    }

    return filteredLines.join('\n');
  }

  // 跳过片头片尾配置相关函数
  const handleSkipConfigChange = async (newConfig: {
    enable: boolean;
    intro_time: number;
    outro_time: number;
  }) => {
    if (!currentSourceRef.current || !currentIdRef.current) return;

    try {
      setSkipConfig(newConfig);
      if (!newConfig.enable && !newConfig.intro_time && !newConfig.outro_time) {
        await deleteSkipConfig(currentSourceRef.current, currentIdRef.current);
        artPlayerRef.current.setting.update({
          name: '跳过片头片尾',
          html: '跳过片头片尾',
          switch: skipConfigRef.current.enable,
          onSwitch: function (item: any) {
            const newConfig = {
              ...skipConfigRef.current,
              enable: !item.switch,
            };
            handleSkipConfigChange(newConfig);
            return !item.switch;
          },
        });
        artPlayerRef.current.setting.update({
          name: '设置片头',
          html: '设置片头',
          icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="12" r="2" fill="#ffffff"/><path d="M9 12L17 12" stroke="#ffffff" stroke-width="2"/><path d="M17 6L17 18" stroke="#ffffff" stroke-width="2"/></svg>',
          tooltip:
            skipConfigRef.current.intro_time === 0
              ? '设置片头时间'
              : `${formatTime(skipConfigRef.current.intro_time)}`,
          onClick: function () {
            const currentTime = artPlayerRef.current?.currentTime || 0;
            if (currentTime > 0) {
              const newConfig = {
                ...skipConfigRef.current,
                intro_time: currentTime,
              };
              handleSkipConfigChange(newConfig);
              return `${formatTime(currentTime)}`;
            }
          },
        });
        artPlayerRef.current.setting.update({
          name: '设置片尾',
          html: '设置片尾',
          icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 6L7 18" stroke="#ffffff" stroke-width="2"/><path d="M7 12L15 12" stroke="#ffffff" stroke-width="2"/><circle cx="19" cy="12" r="2" fill="#ffffff"/></svg>',
          tooltip:
            skipConfigRef.current.outro_time >= 0
              ? '设置片尾时间'
              : `-${formatTime(-skipConfigRef.current.outro_time)}`,
          onClick: function () {
            const outroTime =
              -(
                artPlayerRef.current?.duration -
                artPlayerRef.current?.currentTime
              ) || 0;
            if (outroTime < 0) {
              const newConfig = {
                ...skipConfigRef.current,
                outro_time: outroTime,
              };
              handleSkipConfigChange(newConfig);
              return `-${formatTime(-outroTime)}`;
            }
          },
        });
      } else {
        // Convert legacy SkipConfig to EpisodeSkipConfig for saving
        const segments: import('@/lib/types').SkipSegment[] = [];
        if (newConfig.intro_time > 0) {
          segments.push({ start: 0, end: newConfig.intro_time, type: 'opening', autoSkip: newConfig.enable });
        }
        if (newConfig.outro_time < 0) {
          segments.push({ start: 0, end: -newConfig.outro_time, type: 'ending', mode: 'remaining', remainingTime: -newConfig.outro_time, autoSkip: newConfig.enable, autoNextEpisode: newConfig.enable });
        }
        const episodeConfig: EpisodeSkipConfig = {
          source: currentSourceRef.current,
          id: currentIdRef.current,
          title: '',
          segments,
          updated_time: Date.now(),
        };
        await saveSkipConfig(
          currentSourceRef.current,
          currentIdRef.current,
          episodeConfig
        );
      }
      console.log('跳过片头片尾配置已保存:', newConfig);
    } catch (err) {
      console.error('保存跳过片头片尾配置失败:', err);
    }
  };

  const formatTime = (seconds: number): string => {
    if (seconds === 0) return '00:00';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = Math.round(seconds % 60);

    if (hours === 0) {
      // 不到一小时，格式为 00:00
      return `${minutes.toString().padStart(2, '0')}:${remainingSeconds
        .toString()
        .padStart(2, '0')}`;
    } else {
      // 超过一小时，格式为 00:00:00
      return `${hours.toString().padStart(2, '0')}:${minutes
        .toString()
        .padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
    }
  };

  class CustomHlsJsLoader extends Hls.DefaultConfig.loader {
    constructor(config: any) {
      super(config);
      const load = this.load.bind(this);
      this.load = function (context: any, config: any, callbacks: any) {
        // 拦截manifest和level请求
        if (
          (context as any).type === 'manifest' ||
          (context as any).type === 'level'
        ) {
          const onSuccess = callbacks.onSuccess;
          callbacks.onSuccess = function (
            response: any,
            stats: any,
            context: any
          ) {
            // 如果是m3u8文件，处理内容以移除广告分段
            if (response.data && typeof response.data === 'string') {
              // 过滤掉广告段 - 实现更精确的广告过滤逻辑
              response.data = filterAdsFromM3U8(response.data);
            }
            return onSuccess(response, stats, context, null);
          };
        }
        // 执行原始load方法
        load(context, config, callbacks);
      };
    }
  }

  // 🚀 优化的弹幕操作处理函数（防抖 + 性能优化）
  const _handleDanmuOperationOptimized = (nextState: boolean) => {
    // 清除之前的防抖定时器
    if (danmuOperationTimeoutRef.current) {
      clearTimeout(danmuOperationTimeoutRef.current);
    }
    
    // 立即更新UI状态（确保响应性）
    externalDanmuEnabledRef.current = nextState;
    setExternalDanmuEnabled(nextState);
    
    // 同步保存到localStorage（快速操作）
    try {
      localStorage.setItem('enable_external_danmu', String(nextState));
    } catch (e) {
      console.warn('localStorage设置失败:', e);
    }
    
    // 防抖处理弹幕数据操作（避免频繁切换时的性能问题）
    danmuOperationTimeoutRef.current = setTimeout(async () => {
      try {
        if (artPlayerRef.current?.plugins?.artplayerPluginDanmuku) {
          const plugin = artPlayerRef.current.plugins.artplayerPluginDanmuku;
          
          if (nextState) {
            // 开启弹幕：使用更温和的加载方式
            console.log('🚀 优化后开启外部弹幕...');
            
            // 使用requestIdleCallback优化性能（如果可用）
            const loadDanmu = async () => {
              const externalDanmu = await loadExternalDanmu();
              // 二次确认状态，防止快速切换导致的状态不一致
              if (externalDanmuEnabledRef.current && artPlayerRef.current?.plugins?.artplayerPluginDanmuku) {
                plugin.load(externalDanmu);
                plugin.show();
      enforceDanmakuVisibility();
                console.log('✅ 外部弹幕已优化加载:', externalDanmu.length, '条');
                
                if (artPlayerRef.current && externalDanmu.length > 0) {
                  artPlayerRef.current.notice.show = `已加载 ${externalDanmu.length} 条弹幕`;
                }
              }
            };
            
            // 使用 requestIdleCallback 或 setTimeout 来确保不阻塞主线程
            if (typeof requestIdleCallback !== 'undefined') {
              requestIdleCallback(loadDanmu, { timeout: 1000 });
            } else {
              setTimeout(loadDanmu, 50);
            }
          } else {
            // 关闭弹幕：立即处理
            console.log('🚀 优化后关闭外部弹幕...');
            plugin.load(); // 不传参数，真正清空弹幕
            plugin.hide();
            console.log('✅ 外部弹幕已关闭');
            
            if (artPlayerRef.current) {
              artPlayerRef.current.notice.show = '外部弹幕已关闭';
            }
          }
        }
      } catch (error) {
        console.error('优化后弹幕操作失败:', error);
      }
    }, 300); // 300ms防抖延迟
  };

  // 加载外部弹幕数据（带缓存和防重复）
  const loadExternalDanmu = async (): Promise<any[]> => {
    if (!externalDanmuEnabledRef.current) {
      console.log('外部弹幕开关已关闭');
      return [];
    }
    
    // 生成当前请求的唯一标识
    const currentVideoTitle = videoTitle;
    const currentVideoYear = videoYear; 
    const currentVideoDoubanId = videoDoubanId;
    const currentEpisodeNum = currentEpisodeIndex + 1;
    const requestKey = `${currentVideoTitle}_${currentVideoYear}_${currentVideoDoubanId}_${currentEpisodeNum}`;
    
    // 🚀 优化加载状态检测：更智能的卡住检测
    const now = Date.now();
    const loadingState = danmuLoadingRef.current as any;
    const lastLoadTime = loadingState?.timestamp || 0;
    const lastRequestKey = loadingState?.requestKey || '';
    const isStuckLoad = now - lastLoadTime > 15000; // 降低到15秒超时
    const isSameRequest = lastRequestKey === requestKey;

    // 智能重复检测：区分真正的重复和卡住的请求
    if (loadingState?.loading && isSameRequest && !isStuckLoad) {
      console.log('⏳ 弹幕正在加载中，跳过重复请求');
      return [];
    }

    // 强制重置卡住的加载状态
    if (isStuckLoad && loadingState?.loading) {
      console.warn('🔧 检测到弹幕加载超时，强制重置 (15秒)');
      danmuLoadingRef.current = false;
    }

    // 设置新的加载状态，包含更多上下文信息
    danmuLoadingRef.current = {
      loading: true,
      timestamp: now,
      requestKey,
      source: currentSource,
      episode: currentEpisodeNum
    } as any;
    lastDanmuLoadKeyRef.current = requestKey;
    
    try {
      const params = new URLSearchParams();
      
      // 使用当前最新的state值而不是ref值
      const currentVideoTitle = videoTitle;
      const currentVideoYear = videoYear; 
      const currentVideoDoubanId = videoDoubanId;
      const currentEpisodeNum = currentEpisodeIndex + 1;
      
      if (currentVideoDoubanId && currentVideoDoubanId > 0) {
        params.append('douban_id', currentVideoDoubanId.toString());
      }
      if (bangumiSubjectId && bangumiSubjectId > 0) {
        params.append('bangumi_id', bangumiSubjectId.toString());
      }
      if (currentVideoTitle) {
        params.append('title', currentVideoTitle);
      }
      if (currentVideoYear) {
        params.append('year', currentVideoYear);
      }
      if (currentEpisodeIndex !== null && currentEpisodeIndex >= 0) {
        params.append('episode', currentEpisodeNum.toString());
      }

      // 手动匹配覆盖：使用 episode_id 直接获取指定弹幕
      if (manualDanmuOverrideRef.current?.episodeId) {
        params.set('episode_id', manualDanmuOverrideRef.current.episodeId.toString());
      }

      if (!params.toString()) {
        console.log('没有可用的参数获取弹幕');
        return [];
      }

      // 生成缓存键（使用state值确保准确性）
      const cacheKey = `${currentVideoTitle}_${currentVideoYear}_${currentVideoDoubanId}_${currentEpisodeNum}`;
      const now = Date.now();
      
      console.log('🔑 弹幕缓存调试信息:');
      console.log('- 缓存键:', cacheKey);
      console.log('- 当前时间:', now);
      console.log('- 视频标题:', currentVideoTitle);
      console.log('- 视频年份:', currentVideoYear);
      console.log('- 豆瓣ID:', currentVideoDoubanId);
      console.log('- 集数:', currentEpisodeNum);
      
      // 检查缓存
      console.log('🔍 检查弹幕缓存:', cacheKey);
      const cached = await getDanmuCacheItem(cacheKey);
      if (cached) {
        console.log('📦 找到缓存数据:');
        console.log('- 缓存时间:', cached.timestamp);
        console.log('- 时间差:', now - cached.timestamp, 'ms');
        console.log('- 缓存有效期:', DANMU_CACHE_DURATION * 1000, 'ms');
        console.log('- 是否过期:', (now - cached.timestamp) >= (DANMU_CACHE_DURATION * 1000));
        
        if ((now - cached.timestamp) < (DANMU_CACHE_DURATION * 1000)) {
          console.log('✅ 使用弹幕缓存数据，缓存键:', cacheKey);
          console.log('📊 缓存弹幕数量:', cached.data.length);
          return cached.data;
        }
      } else {
        console.log('❌ 未找到缓存数据');
      }

      console.log('开始获取外部弹幕，参数:', params.toString());
      const response = await fetch(`/api/danmu-external?${params}`);
      console.log('弹幕API响应状态:', response.status, response.statusText);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('弹幕API请求失败:', response.status, errorText);
        return [];
      }

      const data = await response.json();
      console.log('外部弹幕API返回数据:', data);
      console.log('外部弹幕加载成功:', data.total || 0, '条');
      
      const finalDanmu = data.danmu || [];
      console.log('最终弹幕数据:', finalDanmu.length, '条');
      
      // 缓存结果
      console.log('💾 保存弹幕到统一存储:');
      console.log('- 缓存键:', cacheKey);
      console.log('- 弹幕数量:', finalDanmu.length);
      console.log('- 保存时间:', now);
      
      // 保存到统一存储
      await setDanmuCacheItem(cacheKey, finalDanmu);
      
      return finalDanmu;
    } catch (error) {
      console.error('加载外部弹幕失败:', error);
      console.log('弹幕加载失败，返回空结果');
      return [];
    } finally {
      // 重置加载状态
      danmuLoadingRef.current = false;
    }
  };

  // 手动匹配弹幕应用
  const handleDanmuManualApply = async (selection: DanmuManualSelection) => {
    manualDanmuOverrideRef.current = { episodeId: selection.episodeId };
    setIsDanmuManualModalOpen(false);

    // 清除缓存以强制重新加载弹幕
    const cacheKey = `${videoTitle}_${videoYear}_${videoDoubanId}_${currentEpisodeIndex + 1}`;
    try { localStorage.removeItem(`danmu-cache_${cacheKey}`); } catch {/* ignore */}

    // 重新加载弹幕
    try {
      const danmuData = await loadExternalDanmu();
      if (danmuData && danmuData.length > 0 && artPlayerRef.current?.plugins?.artplayerPluginDanmuku) {
        const plugin = artPlayerRef.current.plugins.artplayerPluginDanmuku;
        plugin.config({ danmuku: danmuData });
        plugin.load(danmuData);
        if (artPlayerRef.current.notice) {
          artPlayerRef.current.notice.show = `已加载手动匹配弹幕: ${selection.animeTitle} - ${selection.episodeTitle}`;
        }
      } else if (artPlayerRef.current?.notice) {
        artPlayerRef.current.notice.show = '手动匹配弹幕: 未找到弹幕数据';
      }
    } catch (e) {
      console.error('手动匹配弹幕加载失败:', e);
    } finally {
      manualDanmuOverrideRef.current = null;
    }
  };

  // 🚀 优化的集数变化处理（防抖 + 状态保护）
  useEffect(() => {
    // 🔥 标记正在切换集数（只在非换源时）
    if (!isSourceChangingRef.current) {
      isEpisodeChangingRef.current = true;
      console.log('🔄 开始切换集数，标记为集数变化');
    }

    updateVideoUrl(detail, currentEpisodeIndex);

    // 🚀 如果正在换源，跳过弹幕处理（换源会在完成后手动处理）
    if (isSourceChangingRef.current) {
      console.log('⏭️ 正在换源，跳过弹幕处理');
      return;
    }

    // 🔥 关键修复：重置弹幕加载标识，确保新集数能正确加载弹幕
    lastDanmuLoadKeyRef.current = '';
    danmuLoadingRef.current = false; // 重置加载状态


    // 清除之前的集数切换定时器，防止重复执行
    if (episodeSwitchTimeoutRef.current) {
      clearTimeout(episodeSwitchTimeoutRef.current);
    }

    // 如果播放器已经存在且弹幕插件已加载，重新加载弹幕
    if (artPlayerRef.current && artPlayerRef.current.plugins?.artplayerPluginDanmuku) {
      console.log('🚀 集数变化，优化后重新加载弹幕');

      // 🔥 关键修复：立即清空当前弹幕，避免旧弹幕残留
      const plugin = artPlayerRef.current.plugins.artplayerPluginDanmuku;
      plugin.reset(); // 立即回收所有正在显示的弹幕DOM
      plugin.load(); // 不传参数，完全清空弹幕队列
      console.log('🧹 已清空旧弹幕数据');

      // 保存当前弹幕插件状态
      danmuPluginStateRef.current = {
        isHide: artPlayerRef.current.plugins.artplayerPluginDanmuku.isHide,
        isStop: artPlayerRef.current.plugins.artplayerPluginDanmuku.isStop,
        option: artPlayerRef.current.plugins.artplayerPluginDanmuku.option
      };
      
      // 使用防抖处理弹幕重新加载
      episodeSwitchTimeoutRef.current = setTimeout(async () => {
        try {
          // 确保播放器和插件仍然存在（防止快速切换时的状态不一致）
          if (!artPlayerRef.current?.plugins?.artplayerPluginDanmuku) {
            console.warn('⚠️ 集数切换后弹幕插件不存在，跳过弹幕加载');
            return;
          }
          
          const externalDanmu = await loadExternalDanmu(); // 这里会检查开关状态
          console.log('🔄 集数变化后外部弹幕加载结果:', externalDanmu);
          
          // 再次确认插件状态
          if (artPlayerRef.current?.plugins?.artplayerPluginDanmuku) {
            const plugin = artPlayerRef.current.plugins.artplayerPluginDanmuku;
            
            if (externalDanmu.length > 0) {
              console.log('✅ 向播放器插件重新加载弹幕数据:', externalDanmu.length, '条');
              plugin.load(externalDanmu);
              // load() internally calls show(), re-sync plugin state with user preference
              if (!externalDanmuEnabledRef.current) {
                plugin.hide();
              }
      enforceDanmakuVisibility();
              
              if (artPlayerRef.current) {
                artPlayerRef.current.notice.show = `已加载 ${externalDanmu.length} 条弹幕`;
              }
            } else {
              console.log('📭 集数变化后没有弹幕数据可加载');
              plugin.load(); // 不传参数，确保清空弹幕

              if (artPlayerRef.current) {
                artPlayerRef.current.notice.show = '暂无弹幕数据';
              }
            }
          }
        } catch (error) {
          console.error('❌ 集数变化后加载外部弹幕失败:', error);
        } finally {
          // 清理定时器引用
          episodeSwitchTimeoutRef.current = null;
        }
      }, 800); // 缩短延迟时间，提高响应性
    }
  }, [detail, currentEpisodeIndex]);

  // 进入页面时直接获取全部源信息
  useEffect(() => {
    const fetchSourceDetail = async (
      source: string,
      id: string
    ): Promise<SearchResult[]> => {
      try {
        let detailResponse;

        // 判断是否为短剧源
        if (source === 'shortdrama') {
          detailResponse = await fetch(
            `/api/shortdrama/detail?id=${id}&episode=1`
          );
        } else {
          detailResponse = await fetch(
            `/api/detail?source=${source}&id=${id}`
          );
        }
        if (!detailResponse.ok) {
          throw new Error('获取视频详情失败');
        }
        const detailData = (await detailResponse.json()) as SearchResult;
        setAvailableSources([detailData]);
        return [detailData];
      } catch (err) {
        console.error('获取视频详情失败:', err);
        return [];
      } finally {
        setSourceSearchLoading(false);
      }
    };
    const fetchSourcesData = async (query: string): Promise<SearchResult[]> => {
      // 根据搜索词获取全部源信息
      try {
        // 检查是否需要清理缓存
        const clearCache = searchParams.get('clear_cache') === 'true';
        const searchUrl = `/api/search?q=${encodeURIComponent(query.trim())}${clearCache ? '&clear_cache=true' : ''}`;

        const response = await fetch(searchUrl);
        if (!response.ok) {
          throw new Error('搜索失败');
        }
        const data = await response.json();

        // 处理搜索结果，根据规则过滤
        const currentTitle = videoTitleRef.current.replaceAll(' ', '').toLowerCase();
        const normalizedQuery = query.replaceAll(' ', '').toLowerCase();
        const results = data.results.filter(
          (result: SearchResult) => {
            const resultTitle = result.title.replaceAll(' ', '').toLowerCase();

            // 双重匹配：与原始标题和搜索查询都进行匹配
            // 当搜索变体（如去掉季数后缀）时，搜索变体本身也作为匹配依据
            const matchesOriginal = resultTitle.includes(currentTitle) || currentTitle.includes(resultTitle);
            const matchesQuery = resultTitle.includes(normalizedQuery) || normalizedQuery.includes(resultTitle);
            const titleMatches = matchesOriginal || matchesQuery;

            return titleMatches &&
              (videoYearRef.current
                ? (result.year.toLowerCase().includes(videoYearRef.current.toLowerCase()) || videoYearRef.current.toLowerCase().includes(result.year.toLowerCase()))
                : true) &&
              (searchType
                ? (searchType === 'tv' && (result.episodes?.length ?? 0) > 1) ||
                  (searchType === 'movie' && (result.episodes?.length ?? 0) === 1)
                : true);
          }
        );


        setAvailableSources(results);
        return results;
      } catch (err) {
        setSourceSearchError(err instanceof Error ? err.message : '搜索失败');
        setAvailableSources([]);
        return [];
      } finally {
        setSourceSearchLoading(false);
      }
    };

    const initAll = async () => {
      // 检查是否有 bangumi ID
      const hasBangumiId = bangumiSubjectId || (videoDoubanId && isBangumiId(videoDoubanId));
      
      if (!currentSource && !currentId && !videoTitle && !searchTitle && !hasBangumiId) {
        setError('缺少必要参数');
        setLoading(false);
        return;
      }
      setLoading(true);
      setLoadingStage(currentSource && currentId ? 'fetching' : 'searching');
      setLoadingMessage(
        currentSource && currentId
          ? '🎬 正在获取视频详情...'
          : '🔍 正在搜索播放源...'
      );

     /*  let sourcesInfo = await fetchSourcesData(searchTitle || videoTitle);
      if (
        currentSource &&
        currentId &&
        !sourcesInfo.some(
          (source) => source.source === currentSource && source.id === currentId
        )
      ) {
        sourcesInfo = await fetchSourceDetail(currentSource, currentId);
      }
      if (sourcesInfo.length === 0) {
        setError('未找到匹配结果');
        setLoading(false);
        return;
      } */

      let sourcesInfo: SearchResult[] = [];

      // 对于短剧，直接获取详情，跳过搜索
      if (currentSource === 'shortdrama' && currentId) {
          sourcesInfo = await fetchSourceDetail(currentSource, currentId);
      } else {
        // 检查是否为 bangumi ID
        let searchTitleToUse = searchTitle || videoTitle;
        const currentBangumiId = bangumiSubjectId || (videoDoubanId && isBangumiId(videoDoubanId) ? videoDoubanId : 0);
        
        if (currentBangumiId && !searchTitleToUse) {
          // 获取 bangumi 详情获得标题
          const bangumiData = await fetchBangumiDetails(currentBangumiId);
          if (bangumiData) {
            // 使用中文名称或英文名称
            const title = bangumiData.name_cn || bangumiData.name || '';
            if (title) {
              setVideoTitle(title);
              searchTitleToUse = title;
            }
          }
        }
        
        // 使用智能搜索变体获取全部源信息
        const searchVariants = generateSearchVariants(searchTitleToUse);
        const allResults: SearchResult[] = [];
        
        // 依次尝试每个搜索变体
        for (const variant of searchVariants) {
          try {
            const variantResults = await fetchSourcesData(variant);
            if (variantResults && variantResults.length > 0) {
              allResults.push(...variantResults);
            }
          } catch (error) {
            console.warn(`搜索变体 "${variant}" 失败:`, error);
          }
        }
        
        // 如果是 bangumi 且没有结果，尝试获取 bangumi 详情获取更多标题变体
        if (currentBangumiId && allResults.length === 0) {
          console.log('🔍 番剧搜索无结果，尝试从 bangumi 获取更多标题信息...');
          const bangumiData = await fetchBangumiDetails(currentBangumiId);
          if (bangumiData) {
            // 尝试英文名、中文短名等
            const altTitles: string[] = [];
            if (bangumiData.name && bangumiData.name !== searchTitleToUse) {
              altTitles.push(bangumiData.name);
            }
            if (bangumiData.name_cn && bangumiData.name_cn !== searchTitleToUse) {
              altTitles.push(bangumiData.name_cn);
            }
            // 如有 infobox 中的别名
            if (bangumiData.infobox) {
              for (const item of bangumiData.infobox) {
                if (item.key === '别名' || item.key === '中文名' || item.key === '英文名' || item.key === '简中别名' || item.key === '繁中别名') {
                  const values = Array.isArray(item.value) ? item.value.map((v: any) => v.v || v) : [item.value];
                  for (const val of values) {
                    const title = typeof val === 'string' ? val : (val as any)?.v || String(val);
                    if (title && title !== searchTitleToUse && !altTitles.includes(title)) {
                      altTitles.push(title);
                    }
                  }
                }
              }
            }
            for (const altTitle of altTitles) {
              if (!searchVariants.includes(altTitle)) {
                try {
                  const altVariants = generateSearchVariants(altTitle);
                  for (const v of altVariants) {
                    console.log(`🔍 尝试替代标题变体: "${v}"`);
                    const altResults = await fetchSourcesData(v);
                    if (altResults && altResults.length > 0) {
                      allResults.push(...altResults);
                    }
                  }
                  if (allResults.length > 0) break;
                } catch (error) {
                  console.warn(`替代标题 "${altTitle}" 搜索失败:`, error);
                }
              }
            }
          }
        }
        
        // 去重并设置结果
        const uniqueResults = allResults.filter((result, index, self) => 
          index === self.findIndex(r => r.source === result.source && r.id === result.id)
        );
        
        sourcesInfo = uniqueResults;
        if (
          currentSource &&
          currentId &&
          !sourcesInfo.some(
            (source) => source.source === currentSource && source.id === currentId
          )
        ) {
          sourcesInfo = await fetchSourceDetail(currentSource, currentId);
        }
      }
      if (sourcesInfo.length === 0) {
        setError('未找到匹配结果');
        setLoading(false);
        return;
      }
  
      let detailData: SearchResult = sourcesInfo[0];
      // 指定源和id且无需优选
      if (currentSource && currentId && !needPreferRef.current) {
        const target = sourcesInfo.find(
          (source) => source.source === currentSource && source.id === currentId
        );
        if (target) {
          detailData = target;
        } else {
          setError('未找到匹配结果');
          setLoading(false);
          return;
        }
      }

      // 未指定源和 id 或需要优选，且开启优选开关
      if (
        (!currentSource || !currentId || needPreferRef.current) &&
        optimizationEnabled
      ) {
        setLoadingStage('preferring');
        setLoadingMessage('⚡ 正在优选最佳播放源...');

        detailData = await preferBestSource(sourcesInfo);
      }

      console.log(detailData.source, detailData.id);

      setNeedPrefer(false);
      setCurrentSource(detailData.source);
      setCurrentId(detailData.id);
      setVideoYear(detailData.year);
      setVideoTitle(detailData.title || videoTitleRef.current);
      setVideoCover(detailData.poster);
      setVideoDoubanId(detailData.douban_id || 0);
      setDetail(detailData);
      if (currentEpisodeIndex >= (detailData.episodes?.length ?? 0)) {
        setCurrentEpisodeIndex(0);
      }

      // 规范URL参数
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.set('source', detailData.source);
      newUrl.searchParams.set('id', detailData.id);
      newUrl.searchParams.set('year', detailData.year);
      newUrl.searchParams.set('title', detailData.title);
      newUrl.searchParams.delete('prefer');
      window.history.replaceState({}, '', newUrl.toString());

      setLoadingStage('ready');
      setLoadingMessage('✨ 准备就绪，即将开始播放...');

      // 短暂延迟让用户看到完成状态
      setTimeout(() => {
        setLoading(false);
      }, 1000);
    };

    initAll();
  }, []);

  // 播放记录处理
  useEffect(() => {
    // 仅在初次挂载时检查播放记录
    const initFromHistory = async () => {
      if (!currentSource || !currentId) return;

      try {
        const allRecords = await getAllPlayRecords();
        const key = generateStorageKey(currentSource, currentId);
        const record = allRecords[key];

        if (record) {
          const targetIndex = record.index - 1;
          const targetTime = record.play_time;

          // 更新当前选集索引
          if (targetIndex !== currentEpisodeIndex) {
            setCurrentEpisodeIndex(targetIndex);
          }

          // 保存待恢复的播放进度，待播放器就绪后跳转
          resumeTimeRef.current = targetTime;
        }
      } catch (err) {
        console.error('读取播放记录失败:', err);
      }
    };

    initFromHistory();
  }, []);

  // 跳过片头片尾配置处理
  useEffect(() => {
    // 仅在初次挂载时检查跳过片头片尾配置
    const initSkipConfig = async () => {
      if (!currentSource || !currentId) return;

      try {
        const config = await getSkipConfig(currentSource, currentId);
        if (config && config.segments) {
          // Convert EpisodeSkipConfig back to legacy format for UI
          const opening = config.segments.find(s => s.type === 'opening');
          const ending = config.segments.find(s => s.type === 'ending');
          setSkipConfig({
            enable: !!(opening?.autoSkip || ending?.autoSkip),
            intro_time: opening?.end || 0,
            outro_time: ending?.mode === 'remaining' ? -(ending.remainingTime || ending.end) : (ending ? -(ending.end) : 0),
          });
        }
      } catch (err) {
        console.error('读取跳过片头片尾配置失败:', err);
      }
    };

    initSkipConfig();
  }, []);

  // 处理换源
  const handleSourceChange = async (
    newSource: string,
    newId: string,
    newTitle: string
  ) => {
    try {
      // 防止连续点击换源
      if (isSourceChangingRef.current) {
        console.log('⏸️ 正在换源中，忽略重复点击');
        return;
      }

      // 🚀 设置换源标识，防止useEffect重复处理弹幕
      isSourceChangingRef.current = true;

      // 显示换源加载状态
      setPlayVideoLoading(true);
      updateLoadingState('loading', '正在切换播放源...');

      // 🚀 立即重置弹幕相关状态，避免残留
      lastDanmuLoadKeyRef.current = '';
      danmuLoadingRef.current = false;

      // 清除弹幕操作定时器
      if (danmuOperationTimeoutRef.current) {
        clearTimeout(danmuOperationTimeoutRef.current);
        danmuOperationTimeoutRef.current = null;
      }
      if (episodeSwitchTimeoutRef.current) {
        clearTimeout(episodeSwitchTimeoutRef.current);
        episodeSwitchTimeoutRef.current = null;
      }

      // 🚀 正确地清空弹幕状态（基于ArtPlayer插件API）
      if (artPlayerRef.current?.plugins?.artplayerPluginDanmuku) {
        const plugin = artPlayerRef.current.plugins.artplayerPluginDanmuku;

        try {
          // 🚀 正确清空弹幕：先reset回收DOM，再load清空队列
          if (typeof plugin.reset === 'function') {
            plugin.reset(); // 立即回收所有正在显示的弹幕DOM
          }

          if (typeof plugin.load === 'function') {
            // 关键：load()不传参数会触发清空逻辑（danmuku === undefined）
            plugin.load();
            console.log('✅ 已完全清空弹幕队列');
          }

          // 然后隐藏弹幕层
          if (typeof plugin.hide === 'function') {
            plugin.hide();
          }

          console.log('🧹 换源时已清空旧弹幕数据');
        } catch (error) {
          console.warn('清空弹幕时出错，但继续换源:', error);
        }
      }

      // 记录当前播放进度（仅在同一集数切换时恢复）
      const currentPlayTime = artPlayerRef.current?.currentTime || 0;
      console.log('换源前当前播放时间:', currentPlayTime);

      // 清除前一个历史记录
      if (currentSourceRef.current && currentIdRef.current) {
        try {
          await deletePlayRecord(
            currentSourceRef.current,
            currentIdRef.current
          );
          console.log('已清除前一个播放记录');
        } catch (err) {
          console.error('清除播放记录失败:', err);
        }
      }

      // 清除并设置下一个跳过片头片尾配置
      if (currentSourceRef.current && currentIdRef.current) {
        try {
          await deleteSkipConfig(
            currentSourceRef.current,
            currentIdRef.current
          );
          await saveSkipConfig(newSource, newId, {
            source: newSource,
            id: newId,
            title: '',
            segments: [
              ...(skipConfigRef.current.intro_time > 0 ? [{ start: 0, end: skipConfigRef.current.intro_time, type: 'opening' as const, autoSkip: skipConfigRef.current.enable }] : []),
              ...(skipConfigRef.current.outro_time < 0 ? [{ start: 0, end: -skipConfigRef.current.outro_time, type: 'ending' as const, mode: 'remaining' as const, remainingTime: -skipConfigRef.current.outro_time, autoSkip: skipConfigRef.current.enable, autoNextEpisode: skipConfigRef.current.enable }] : []),
            ],
            updated_time: Date.now(),
          });
        } catch (err) {
          console.error('清除跳过片头片尾配置失败:', err);
        }
      }

      const newDetail = availableSources.find(
        (source) => source.source === newSource && source.id === newId
      );
      if (!newDetail) {
        setError('未找到匹配结果');
        updateLoadingState('error', '未找到匹配结果');
        return;
      }

      // 尝试跳转到当前正在播放的集数
      let targetIndex = currentEpisodeIndex;

      // 如果当前集数超出新源的范围，则跳转到第一集
      if (!newDetail.episodes || targetIndex >= (newDetail.episodes?.length ?? 0)) {
        targetIndex = 0;
      }

      // 如果仍然是同一集数且播放进度有效，则在播放器就绪后恢复到原始进度
      if (targetIndex !== currentEpisodeIndex) {
        resumeTimeRef.current = 0;
      } else if (
        (!resumeTimeRef.current || resumeTimeRef.current === 0) &&
        currentPlayTime > 1
      ) {
        resumeTimeRef.current = currentPlayTime;
      }

      // 更新URL参数（不刷新页面）
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.set('source', newSource);
      newUrl.searchParams.set('id', newId);
      newUrl.searchParams.set('year', newDetail.year);
      window.history.replaceState({}, '', newUrl.toString());

      setVideoTitle(newDetail.title || newTitle);
      setVideoYear(newDetail.year);
      setVideoCover(newDetail.poster);
      // 优先保留URL参数中的豆瓣ID，如果URL中没有则使用详情数据中的
      setVideoDoubanId(videoDoubanIdRef.current || newDetail.douban_id || 0);
      setCurrentSource(newSource);
      setCurrentId(newId);
      setDetail(newDetail);
      setCurrentEpisodeIndex(targetIndex);
      
      // 🚀 换源完成后，优化弹幕加载流程
      setTimeout(async () => {
        isSourceChangingRef.current = false; // 重置换源标识

        if (artPlayerRef.current?.plugins?.artplayerPluginDanmuku && externalDanmuEnabledRef.current) {
          console.log('🔄 换源完成，开始优化弹幕加载...');

          // 确保状态完全重置
          lastDanmuLoadKeyRef.current = '';
          danmuLoadingRef.current = false;

          try {
            const startTime = performance.now();
            const danmuData = await loadExternalDanmu();

            if (danmuData.length > 0 && artPlayerRef.current?.plugins?.artplayerPluginDanmuku) {
              const plugin = artPlayerRef.current.plugins.artplayerPluginDanmuku;

              // 🚀 确保在加载新弹幕前完全清空旧弹幕
              plugin.reset(); // 立即回收所有正在显示的弹幕DOM
              plugin.load(); // 不传参数，完全清空队列
              console.log('🧹 换源后已清空旧弹幕，准备加载新弹幕');

              // 🚀 优化大量弹幕的加载：分批处理，减少阻塞
              if (danmuData.length > 1000) {
                console.log(`📊 检测到大量弹幕 (${danmuData.length}条)，启用分批加载`);

                // 先加载前500条，快速显示
                const firstBatch = danmuData.slice(0, 500);
                plugin.load(firstBatch);
                if (!externalDanmuEnabledRef.current) plugin.hide();
      enforceDanmakuVisibility();

                // 剩余弹幕分批异步加载，避免阻塞
                const remainingBatches = [];
                for (let i = 500; i < danmuData.length; i += 300) {
                  remainingBatches.push(danmuData.slice(i, i + 300));
                }

                // 使用requestIdleCallback分批加载剩余弹幕
                remainingBatches.forEach((batch, index) => {
                  setTimeout(() => {
                    if (artPlayerRef.current?.plugins?.artplayerPluginDanmuku) {
                      // 将批次弹幕追加到现有队列
                      batch.forEach(danmu => {
                        plugin.emit(danmu).catch(console.warn);
                      });
                    }
                  }, (index + 1) * 100); // 每100ms加载一批
                });

                console.log(`⚡ 分批加载完成: 首批${firstBatch.length}条 + ${remainingBatches.length}个后续批次`);
              } else {
                // 弹幕数量较少，正常加载
                plugin.load(danmuData);
                if (!externalDanmuEnabledRef.current) plugin.hide();
            enforceDanmakuVisibility();
                console.log(`✅ 换源后弹幕加载完成: ${danmuData.length} 条`);
              }

              const loadTime = performance.now() - startTime;
              console.log(`⏱️ 弹幕加载耗时: ${loadTime.toFixed(2)}ms`);
            } else {
              console.log('📭 换源后没有弹幕数据');
            }
          } catch (error) {
            console.error('❌ 换源后弹幕加载失败:', error);
          }
        }
      }, 1000); // 减少到1秒延迟，加快响应

    } catch (err) {
      // 重置换源标识
      isSourceChangingRef.current = false;

      // 隐藏换源加载状态
      setPlayVideoLoading(false);
      updateLoadingState('error', '换源失败');
      setError(err instanceof Error ? err.message : '换源失败');
    }
  }

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // 🚀 组件卸载时清理所有定时器和状态
  useEffect(() => {
    return () => {
      // 清理所有定时器
      if (danmuOperationTimeoutRef.current) {
        clearTimeout(danmuOperationTimeoutRef.current);
      }
      if (episodeSwitchTimeoutRef.current) {
        clearTimeout(episodeSwitchTimeoutRef.current);
      }
      if (sourceSwitchTimeoutRef.current) {
        clearTimeout(sourceSwitchTimeoutRef.current);
      }

      // 重置状态
      isSourceChangingRef.current = false;
      switchPromiseRef.current = null;
      pendingSwitchRef.current = null;
    };
  }, []);

  // ---------------------------------------------------------------------------
  // 集数切换
  // ---------------------------------------------------------------------------
  // 处理集数切换
  const handleEpisodeChange = (episodeNumber: number) => {
    if (episodeNumber >= 0 && episodeNumber < totalEpisodes) {
      // 在更换集数前保存当前播放进度
      if (artPlayerRef.current && artPlayerRef.current.paused) {
        saveCurrentPlayProgress();
      }
      setCurrentEpisodeIndex(episodeNumber);
      // 显示加载状态
      setPlayVideoLoading(true);
      updateLoadingState('loading', '正在切换到第' + (episodeNumber + 1) + '集...');
    }
  };

  const handlePreviousEpisode = () => {
    const d = detailRef.current;
    const idx = currentEpisodeIndexRef.current;
    if (d && d.episodes && idx > 0) {
      if (artPlayerRef.current && !artPlayerRef.current.paused) {
        saveCurrentPlayProgress();
      }
      setCurrentEpisodeIndex(idx - 1);
      // 显示加载状态
      setPlayVideoLoading(true);
      updateLoadingState('loading', '正在切换到第' + idx + '集...');
    }
  };

  const handleNextEpisode = () => {
    const d = detailRef.current;
    const idx = currentEpisodeIndexRef.current;
    if (d && d.episodes && idx < (d.episodes?.length ?? 0) - 1) {
      if (artPlayerRef.current && !artPlayerRef.current.paused) {
        saveCurrentPlayProgress();
      }
      setCurrentEpisodeIndex(idx + 1);
      // 显示加载状态
      setPlayVideoLoading(true);
      updateLoadingState('loading', '正在切换到第' + (idx + 2) + '集...');
    }
  };

  // 键盘快捷键处理
  const handleKeyDown = (e: KeyboardEvent) => {
    // Alt + 右箭头 = 下一集
    if (e.altKey && e.key === 'ArrowRight') {
      if (
        detailRef.current?.episodes &&
        currentEpisodeIndexRef.current < (detailRef.current.episodes?.length ?? 0) - 1
      ) {
        handleNextEpisode();
        e.preventDefault();
      }
    }

    // Alt + 左箭头 = 上一集
    if (e.altKey && e.key === 'ArrowLeft') {
      if (currentEpisodeIndexRef.current > 0) {
        handlePreviousEpisode();
        e.preventDefault();
      }
    }

    // 左箭头 = 快退
    if (!e.altKey && e.key === 'ArrowLeft') {
      if (artPlayerRef.current && artPlayerRef.current.currentTime > 5) {
        artPlayerRef.current.currentTime -= 10;
        e.preventDefault();
      }
    }

    // 右箭头 = 快进
    if (!e.altKey && e.key === 'ArrowRight') {
      if (
        artPlayerRef.current &&
        artPlayerRef.current.currentTime < artPlayerRef.current.duration - 5
      ) {
        artPlayerRef.current.currentTime += 10;
        e.preventDefault();
      }
    }

    // 上箭头 = 音量+
    if (e.key === 'ArrowUp') {
      if (artPlayerRef.current && artPlayerRef.current.volume < 1) {
        artPlayerRef.current.volume =
          Math.round((artPlayerRef.current.volume + 0.1) * 10) / 10;
        artPlayerRef.current.notice.show = `音量: ${Math.round(
          artPlayerRef.current.volume * 100
        )}`;
        e.preventDefault();
      }
    }

    // 下箭头 = 音量-
    if (e.key === 'ArrowDown') {
      if (artPlayerRef.current && artPlayerRef.current.volume > 0) {
        artPlayerRef.current.volume =
          Math.round((artPlayerRef.current.volume - 0.1) * 10) / 10;
        artPlayerRef.current.notice.show = `音量: ${Math.round(
          artPlayerRef.current.volume * 100
        )}`;
        e.preventDefault();
      }
    }

    // 空格 = 播放/暂停
    if (e.key === ' ') {
      if (artPlayerRef.current) {
        artPlayerRef.current.toggle();
        e.preventDefault();
      }
    }

    // f 键 = 切换全屏
    if (e.key === 'f' || e.key === 'F') {
      if (artPlayerRef.current) {
        artPlayerRef.current.fullscreen = !artPlayerRef.current.fullscreen;
        e.preventDefault();
      }
    }
  };

  // ---------------------------------------------------------------------------
  // 播放记录相关
  // ---------------------------------------------------------------------------
  // 保存播放进度
  const saveCurrentPlayProgress = async () => {
    if (
      !artPlayerRef.current ||
      !currentSourceRef.current ||
      !currentIdRef.current ||
      !videoTitleRef.current ||
      !detailRef.current?.source_name
    ) {
      return;
    }

    const player = artPlayerRef.current;
    const currentTime = player.currentTime || 0;
    const duration = player.duration || 0;

    // 如果播放时间太短（少于5秒）或者视频时长无效，不保存
    if (currentTime < 1 || !duration) {
      return;
    }

    try {
      await savePlayRecord(currentSourceRef.current, currentIdRef.current, {
        title: videoTitleRef.current,
        source_name: detailRef.current?.source_name || '',
        year: detailRef.current?.year,
        cover: detailRef.current?.poster || '',
        index: currentEpisodeIndexRef.current + 1, // 转换为1基索引
        total_episodes: (detailRef.current?.episodes?.length ?? 1),
        play_time: Math.floor(currentTime),
        total_time: Math.floor(duration),
        save_time: Date.now(),
        search_title: searchTitle,
        douban_id: bangumiSubjectId || videoDoubanId || 0, 
      });

      lastSaveTimeRef.current = Date.now();
      console.log('播放进度已保存:', {
        title: videoTitleRef.current,
        episode: currentEpisodeIndexRef.current + 1,
        year: detailRef.current?.year,
        progress: `${Math.floor(currentTime)}/${Math.floor(duration)}`,
      });
    } catch (err) {
      console.error('保存播放进度失败:', err);
    }
  };

  useEffect(() => {
    // 页面即将卸载时保存播放进度和清理资源
    const handleBeforeUnload = () => {
      saveCurrentPlayProgress();
      releaseWakeLock();
      cleanupPlayer();
    };

    // 页面可见性变化时保存播放进度和释放 Wake Lock
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        saveCurrentPlayProgress();
        releaseWakeLock();
      } else if (document.visibilityState === 'visible') {
        // 页面重新可见时，如果正在播放则重新请求 Wake Lock
        if (artPlayerRef.current && !artPlayerRef.current.paused) {
          requestWakeLock();
        }
      }
    };

    // 添加事件监听器
    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      // 清理事件监听器
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [currentEpisodeIndex, detail, artPlayerRef.current]);

  // 清理定时器
  useEffect(() => {
    return () => {
      if (saveIntervalRef.current) {
        clearInterval(saveIntervalRef.current);
      }
    };
  }, []);

  // ---------------------------------------------------------------------------
  // 收藏相关
  // ---------------------------------------------------------------------------
  // 每当 source 或 id 变化时检查收藏状态
  useEffect(() => {
    if (!currentSource || !currentId) return;
    (async () => {
      try {
        const fav = await isFavorited(currentSource, currentId);
        setFavorited(fav);
      } catch (err) {
        console.error('检查收藏状态失败:', err);
      }
    })();
  }, [currentSource, currentId]);

  // 监听收藏数据更新事件
  useEffect(() => {
    if (!currentSource || !currentId) return;

    const unsubscribe = subscribeToDataUpdates(
      'favoritesUpdated',
      (favorites: Record<string, any>) => {
        const key = generateStorageKey(currentSource, currentId);
        const isFav = !!favorites[key];
        setFavorited(isFav);
      }
    );

    return unsubscribe;
  }, [currentSource, currentId]);

  // 切换收藏
  const handleToggleFavorite = async () => {
    if (
      !videoTitleRef.current ||
      !detailRef.current ||
      !currentSourceRef.current ||
      !currentIdRef.current
    )
      return;

    try {
      if (favorited) {
        // 如果已收藏，删除收藏
        await deleteFavorite(currentSourceRef.current, currentIdRef.current);
        setFavorited(false);
      } else {
        // 如果未收藏，添加收藏
        await saveFavorite(currentSourceRef.current, currentIdRef.current, {
          title: videoTitleRef.current,
          source_name: detailRef.current?.source_name || '',
          year: detailRef.current?.year,
          cover: detailRef.current?.poster || '',
          total_episodes: (detailRef.current?.episodes?.length ?? 1),
          save_time: Date.now(),
          search_title: searchTitle,
        });
        setFavorited(true);
      }
    } catch (err) {
      console.error('切换收藏失败:', err);
    }
  };

  useEffect(() => {
    (async () => {
    if (
      !Artplayer ||
      !Hls ||
      !videoUrl ||
      loading ||
      currentEpisodeIndex === null ||
      !artRef.current
    ) {
      return;
    }

    // 确保选集索引有效
    if (
      !detail ||
      !detail.episodes ||
      currentEpisodeIndex >= (detail.episodes?.length ?? 0) ||
      currentEpisodeIndex < 0
    ) {
      setError(`选集索引无效，当前共 ${totalEpisodes} 集`);
      updateLoadingState('error', `选集索引无效，当前共 ${totalEpisodes} 集`);
      return;
    }

    if (!videoUrl) {
      setError('视频地址无效');
      updateLoadingState('error', '视频地址无效');
      return;
    }
    console.log(videoUrl);

    // 检测是否为WebKit浏览器
    const isWebkit =
      typeof window !== 'undefined' &&
      typeof (window as any).webkitConvertPointFromNodeToPage === 'function';

    // 非WebKit浏览器且播放器已存在，使用switch方法切换
    if (!isWebkit && artPlayerRef.current) {
      artPlayerRef.current.switch = videoUrl;
      artPlayerRef.current.title = `${videoTitle} - 第${currentEpisodeIndex + 1
        }集`;
      artPlayerRef.current.poster = videoCover;
      if (artPlayerRef.current?.video) {
        ensureVideoSource(
          artPlayerRef.current.video as HTMLVideoElement,
          videoUrl
        );
      }
      // 更新加载状态
      updateLoadingState('success', '视频切换成功');
      return;
    }

    // WebKit浏览器或首次创建：销毁之前的播放器实例并创建新的
    if (artPlayerRef.current) {
      cleanupPlayer();
    }

    // 显示加载状态
    setPlayVideoLoading(true);
    updateLoadingState('loading', '正在初始化播放器...');
    try {
      // 在创建实例前，按需动态加载弹幕插件（仅客户端）
      if (typeof window !== 'undefined' && !danmakuPluginRef.current) {
        try {
          const mod = await import('artplayer-plugin-danmuku');
          danmakuPluginRef.current = (mod as any)?.default || mod;
        } catch (e) {
          console.warn('加载弹幕插件失败（忽略并继续）:', e);
        }
      }

      // 创建新的播放器实例
      Artplayer.PLAYBACK_RATE = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
      Artplayer.USE_RAF = true;

      artPlayerRef.current = new Artplayer({
        container: artRef.current as HTMLDivElement,
        url: videoUrl,
        poster: videoCover,
        volume: 0.7,
        isLive: false,
        muted: false,
        autoplay: true,
        pip: true,
        autoSize: false,
        autoMini: false,
        screenshot: false,
        setting: true,
        loop: false,
        flip: false,
        playbackRate: true,
        aspectRatio: false,
        fullscreen: true,
        fullscreenWeb: true,
        subtitleOffset: false,
        miniProgressBar: false,
        mutex: true,
        playsInline: true,
        autoPlayback: false,
        airplay: true,
        theme: '#22c55e',
        lang: 'zh-cn',
        hotkey: false,
        fastForward: true,
        autoOrientation: true,
        lock: true,
        moreVideoAttr: {
          crossOrigin: 'anonymous',
        },
        // 弹幕插件（可选）
        plugins: danmakuPluginRef.current
          ? [
              danmakuPluginRef.current({
                danmuku: [],
                // 配置：速度=7.5，不透明度=0.8，同步播放
                margin: [10, '75%'], 
                antiOverlap: true,
                speed: 7.5,
                opacity: 0.8,
                fontSize: 24,
                synchronousPlayback: true,
                // 保守的显示策略
                filter: (dm: any) => (dm?.text?.length ?? 0) < 50,
                beforeVisible: (dm: any) => {
                  dm.border = false;
                  dm.backgroundColor = 'transparent';
                  return dm;
                },
              }),
            ]
          : [],

        // HLS 支持配置
        customType: {
          m3u8: function (video: HTMLVideoElement, url: string) {
            if (!Hls) {
              console.error('HLS.js 未加载');
              updateLoadingState('error', 'HLS.js 未加载');
              return;
            }

            // 重置加载状态
            resetLoadingState();
            updateLoadingState('connecting', '正在连接视频源...');

            if (video.hls) {
              video.hls.destroy();
            }
            const hls = new Hls({
              debug: false, // 关闭日志
              enableWorker: true, // WebWorker 解码，降低主线程压力
              lowLatencyMode: true, // 开启低延迟 LL-HLS

              /* 缓冲/内存相关 */
              maxBufferLength: 30, // 前向缓冲最大 30s，过大容易导致高延迟
              backBufferLength: 30, // 仅保留 30s 已播放内容，避免内存占用
              maxBufferSize: 60 * 1000 * 1000, // 约 60MB，超出后触发清理

              /* 自定义loader */
              loader: blockAdEnabledRef.current
                ? CustomHlsJsLoader
                : Hls.DefaultConfig.loader,
            });

            hls.loadSource(url);
            hls.attachMedia(video);
            video.hls = hls;

            ensureVideoSource(video, url);

            // 监听HLS事件以更新加载状态
            let hasLoadedFirstFragment = false;
            let errorCount = 0;

            // 当开始加载M3U8清单时
            hls.on(Hls.Events.MANIFEST_LOADING, () => {
              setPlayVideoLoading(true);
              updateLoadingState('loading', '正在连接视频源...');
            });

            // 当M3U8清单加载完成时
            hls.on(Hls.Events.MANIFEST_LOADED, () => {
              updateLoadingState('loading', '正在解析播放列表...');
            });

            // 当开始加载片段时
            hls.on(Hls.Events.FRAG_LOADING, (_event, _data) => {
              if (!hasLoadedFirstFragment) {
                updateLoadingState('loading', '正在加载首个视频片段...');
              } else {
                updateLoadingState('buffering', '正在缓冲视频片段...');
              }
            });

            // 当片段加载完成时
            hls.on(Hls.Events.FRAG_LOADED, (_event, _data) => {
              if (!hasLoadedFirstFragment) {
                hasLoadedFirstFragment = true;
                updateLoadingState('success', '视频加载成功');
                setPlayVideoLoading(false);
              }
            });

            // 当发生错误时
            hls.on(Hls.Events.ERROR, function (event: any, data: any) {
              console.error('HLS Error:', event, data);
              errorCount++;

              // 如果是网络错误，显示特定消息
              if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                updateLoadingState('error', '网络连接失败，请检查网络设置');
              } 
              // 如果是媒体错误，显示特定消息
              else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                updateLoadingState('error', '视频格式不支持或文件损坏');
              }
              // 其他错误
              else {
                updateLoadingState('error', '视频加载失败，请检查网络或切换源');
              }

              // 如果错误次数过多，停止加载
              if (errorCount > 3) {
                setPlayVideoLoading(false);
              }

              if (data.fatal) {
                switch (data.type) {
                  case Hls.ErrorTypes.NETWORK_ERROR:
                    console.log('网络错误，尝试恢复...');
                    hls.startLoad();
                    break;
                  case Hls.ErrorTypes.MEDIA_ERROR:
                    console.log('媒体错误，尝试恢复...');
                    hls.recoverMediaError();
                    break;
                  default:
                    console.log('无法恢复的错误');
                    hls.destroy();
                    break;
                }
              }
            });
          },
        },
        icons: {
          loading:
            '<img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1MCIgaGVpZ2h0PSI1MCIgdmlld0JveD0iMCAwIDUwIDUwIj48cGF0aCBkPSJNMjUuMjUxIDYuNDYxYy0xMC4zMTggMC0xOC42ODMgOC4zNjUtMTguNjgzIDE4LjY4M2g0LjA2OGMwLTguMDcgNi41NDUtMTQuNjE1IDE0LjYxNS0xNC42MTVWNi40NjF6IiBmaWxsPSIjMDA5Njg4Ij48YW5pbWF0ZVRyYW5zZm9ybSBhdHRyaWJ1dGVOYW1lPSJ0cmFuc2Zvcm0iIGF0dHJpYnV0ZVR5cGU9IlhNTCIgZHVyPSIxcyIgZnJvbT0iMCAyNSAyNSIgcmVwZWF0Q291bnQ9ImluZGVmaW5pdGUiIHRvPSIzNjAgMjUgMjUiIHR5cGU9InJvdGF0ZSIvPjwvcGF0aD48L3N2Zz4=">',
        },
        settings: [
          {
            html: '去广告',
            icon: '<text x="50%" y="50%" font-size="20" font-weight="bold" text-anchor="middle" dominant-baseline="middle" fill="#ffffff">AD</text>',
            tooltip: blockAdEnabled ? '已开启' : '已关闭',
            onClick() {
              const newVal = !blockAdEnabled;
              try {
                localStorage.setItem('enable_blockad', String(newVal));
                if (artPlayerRef.current) {
                  resumeTimeRef.current = artPlayerRef.current.currentTime;
                  if (
                    artPlayerRef.current.video &&
                    artPlayerRef.current.video.hls
                  ) {
                    artPlayerRef.current.video.hls.destroy();
                  }
                  artPlayerRef.current.destroy();
                  artPlayerRef.current = null;
                }
                setBlockAdEnabled(newVal);
              } catch (_) {
                // ignore
              }
              return newVal ? '当前开启' : '当前关闭';
            },
          },
          {
            name: '跳过片头片尾',
            html: '跳过片头片尾',
            switch: skipConfigRef.current.enable,
            onSwitch: function (item) {
              const newConfig = {
                ...skipConfigRef.current,
                enable: !item.switch,
              };
              handleSkipConfigChange(newConfig);
              return !item.switch;
            },
          },
          {
            html: '删除跳过配置',
            onClick: function () {
              handleSkipConfigChange({
                enable: false,
                intro_time: 0,
                outro_time: 0,
              });

// 启动弹幕可见性观察器，防止插件内部自动打开弹幕
startDanmakuObserver();
enforceDanmakuVisibility();
              return '';
            },
          },
          {
            html: '手动匹配弹幕',
            icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
            onClick: function () {
              setIsDanmuManualModalOpen(true);
            },
          },
          {
            html: '跳过设置面板',
            icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
            onClick: function () {
              setIsSkipSettingMode((prev: boolean) => !prev);
            },
          },
          {
            name: '设置片头',
            html: '设置片头',
            icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="12" r="2" fill="#ffffff"/><path d="M9 12L17 12" stroke="#ffffff" stroke-width="2"/><path d="M17 6L17 18" stroke="#ffffff" stroke-width="2"/></svg>',
            tooltip:
              skipConfigRef.current.intro_time === 0
                ? '设置片头时间'
                : `${formatTime(skipConfigRef.current.intro_time)}`,
            onClick: function () {
              const currentTime = artPlayerRef.current?.currentTime || 0;
              if (currentTime > 0) {
                const newConfig = {
                  ...skipConfigRef.current,
                  intro_time: currentTime,
                };
                handleSkipConfigChange(newConfig);
                return `${formatTime(currentTime)}`;
              }
            },
          },
          {
            name: '设置片尾',
            html: '设置片尾',
            icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 6L7 18" stroke="#ffffff" stroke-width="2"/><path d="M7 12L15 12" stroke="#ffffff" stroke-width="2"/><circle cx="19" cy="12" r="2" fill="#ffffff"/></svg>',
            tooltip:
              skipConfigRef.current.outro_time >= 0
                ? '设置片尾时间'
                : `-${formatTime(-skipConfigRef.current.outro_time)}`,
            onClick: function () {
              const outroTime =
                -(
                  artPlayerRef.current?.duration -
                  artPlayerRef.current?.currentTime
                ) || 0;
              if (outroTime < 0) {
                const newConfig = {
                  ...skipConfigRef.current,
                  outro_time: outroTime,
                };
                handleSkipConfigChange(newConfig);
                return `-${formatTime(-outroTime)}`;
              }
            },
          },
        ],
        // 控制栏配置
        controls: [
          {
            position: 'left',
            index: 13,
            html: '<i class="art-icon flex"><svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" fill="currentColor"/></svg></i>',
            tooltip: '播放下一集',
            click: function () {
              handleNextEpisode();
            },
          },
        ],
      });

      // 监听播放器事件
      artPlayerRef.current.on('ready', () => {
    // 启动弹幕可见性监控，防止插件内部show()自动打开弹幕
    startDanmakuObserver();
    enforceDanmakuVisibility();
        setError(null);

        // 播放器就绪后，如果正在播放则请求 Wake Lock
        if (artPlayerRef.current && !artPlayerRef.current.paused) {
          requestWakeLock();
        }
        
        // 更新加载状态
        updateLoadingState('success', '视频播放已准备就绪');
      });

      // 监听播放状态变化，控制 Wake Lock
      artPlayerRef.current.on('play', () => {
        requestWakeLock();
        updateLoadingState('playing', '正在播放视频');
      });

      artPlayerRef.current.on('pause', () => {
        releaseWakeLock();
        saveCurrentPlayProgress();
        updateLoadingState('buffering', '视频已暂停');
      });

      artPlayerRef.current.on('video:ended', () => {
        releaseWakeLock();
        updateLoadingState('success', '视频播放结束');
      });

      // 如果播放器初始化时已经在播放状态，则请求 Wake Lock
      if (artPlayerRef.current && !artPlayerRef.current.paused) {
        requestWakeLock();
      }

      artPlayerRef.current.on('video:volumechange', () => {
        lastVolumeRef.current = artPlayerRef.current.volume;
      });
      artPlayerRef.current.on('video:ratechange', () => {
        lastPlaybackRateRef.current = artPlayerRef.current.playbackRate;
      });

      // 监听视频可播放事件，这时恢复播放进度更可靠
      artPlayerRef.current.on('video:canplay', () => {
        // 若存在需要恢复的播放进度，则跳转
        if (resumeTimeRef.current && resumeTimeRef.current > 0) {
          try {
            const duration = artPlayerRef.current.duration || 0;
            let target = resumeTimeRef.current;
            if (duration && target >= duration - 2) {
              target = Math.max(0, duration - 5);
            }
            artPlayerRef.current.currentTime = target;
            console.log('成功恢复播放进度到:', resumeTimeRef.current);
          } catch (err) {
            console.warn('恢复播放进度失败:', err);
          }
        }
        resumeTimeRef.current = null;

        setTimeout(() => {
          if (
            Math.abs(artPlayerRef.current.volume - lastVolumeRef.current) > 0.01
          ) {
            artPlayerRef.current.volume = lastVolumeRef.current;
          }
          if (
            Math.abs(
              artPlayerRef.current.playbackRate - lastPlaybackRateRef.current
            ) > 0.01 &&
            isWebkit
          ) {
            artPlayerRef.current.playbackRate = lastPlaybackRateRef.current;
          }
          artPlayerRef.current.notice.show = '';
        }, 0);

        // 隐藏换源加载状态
        setPlayVideoLoading(false);
        updateLoadingState('success', '视频可以播放');

        // 🚀 播放器准备就绪后加载弹幕
      const danmuLoadKey = `${videoTitle}_${videoYear}_${videoDoubanId}_${currentEpisodeIndex + 1}`;
      if (artPlayerRef.current?.plugins?.artplayerPluginDanmuku && externalDanmuEnabledRef.current && lastDanmuLoadKeyRef.current !== danmuLoadKey) {
          console.log('🎬 播放器就绪，开始加载弹幕...');
          
          setTimeout(async () => {
            try {
              const startTime = performance.now();
              const danmuData = await loadExternalDanmu();

              if (danmuData.length > 0 && artPlayerRef.current?.plugins?.artplayerPluginDanmuku) {
                const plugin = artPlayerRef.current.plugins.artplayerPluginDanmuku;
                plugin.load(danmuData);
                // load() internally calls show(), so re-sync plugin state with user preference
                if (!externalDanmuEnabledRef.current) plugin.hide();
    enforceDanmakuVisibility();
                
                const loadTime = Math.round(performance.now() - startTime);
                console.log(`✅ 弹幕加载完成: ${danmuData.length} 条，耗时 ${loadTime}ms`);
                
                if (artPlayerRef.current) {
                  artPlayerRef.current.notice.show = `已加载 ${danmuData.length} 条弹幕`;
                }
              } else {
                console.log('📭 未获取到弹幕数据');
                if (artPlayerRef.current) {
                  artPlayerRef.current.notice.show = '暂无弹幕数据';
                }
              }
            } catch (error) {
              console.error('❌ 弹幕加载失败:', error);
            }
          }, 1000); // 延迟1秒加载，确保播放器完全就绪
        }
      });

      // 监听视频时间更新事件，实现跳过片头片尾
      artPlayerRef.current.on('video:timeupdate', () => {
        if (!skipConfigRef.current.enable) return;

        const currentTime = artPlayerRef.current.currentTime || 0;
        const duration = artPlayerRef.current.duration || 0;
        setCurrentPlayTime(currentTime);
        setVideoDuration(duration);
        const now = Date.now();

        // 限制跳过检查频率为1.5秒一次
        if (now - lastSkipCheckRef.current < 1500) return;
        lastSkipCheckRef.current = now;

        // 跳过片头
        if (
          skipConfigRef.current.intro_time > 0 &&
          currentTime < skipConfigRef.current.intro_time
        ) {
          artPlayerRef.current.currentTime = skipConfigRef.current.intro_time;
          artPlayerRef.current.notice.show = `已跳过片头 (${formatTime(
            skipConfigRef.current.intro_time
          )})`;
        }

        // 跳过片尾
        if (
          skipConfigRef.current.outro_time < 0 &&
          duration > 0 &&
          currentTime >
          artPlayerRef.current.duration + skipConfigRef.current.outro_time
        ) {
          if (
            currentEpisodeIndexRef.current <
            ((detailRef.current?.episodes?.length ?? 1) - 1)
          ) {
            handleNextEpisode();
          } else {
            artPlayerRef.current.pause();
          }
          artPlayerRef.current.notice.show = `已跳过片尾 (${formatTime(
            skipConfigRef.current.outro_time
          )})`;
        }
      });

      artPlayerRef.current.on('error', (err: any) => {
        console.error('播放器错误:', err);
        if (artPlayerRef.current.currentTime > 0) {
          return;
        }
        updateLoadingState('error', '播放器发生错误，请重试或切换源');
      });

      // 监听视频播放结束事件，自动播放下一集
      artPlayerRef.current.on('video:ended', () => {
        const d = detailRef.current;
        const idx = currentEpisodeIndexRef.current;
        if (d && d.episodes && idx < (d.episodes?.length ?? 0) - 1) {
          setTimeout(() => {
            setCurrentEpisodeIndex(idx + 1);
          }, 1000);
        }
        updateLoadingState('success', '视频播放结束');
      });

      artPlayerRef.current.on('video:timeupdate', () => {
        const now = Date.now();
        let interval = 5000;
        if (process.env.NEXT_PUBLIC_STORAGE_TYPE === 'upstash') {
          interval = 20000;
        }
        if (now - lastSaveTimeRef.current > interval) {
          saveCurrentPlayProgress();
          lastSaveTimeRef.current = now;
        }
      });

      artPlayerRef.current.on('pause', () => {
        saveCurrentPlayProgress();
        updateLoadingState('buffering', '视频已暂停');
      });

      if (artPlayerRef.current?.video) {
        ensureVideoSource(
          artPlayerRef.current.video as HTMLVideoElement,
          videoUrl
        );
      }
    } catch (err) {
      console.error('创建播放器失败:', err);
      setError('播放器初始化失败');
    }
    })();
  }, [Artplayer, Hls, videoUrl, loading, blockAdEnabled]);

  // 当组件卸载时清理定时器、Wake Lock 和播放器资源
  useEffect(() => {
    return () => {
      // 清理定时器
      if (saveIntervalRef.current) {
        clearInterval(saveIntervalRef.current);
      }

      // 释放 Wake Lock
      releaseWakeLock();

      // 销毁播放器实例
      cleanupPlayer();
    };
  }, []);

  // 返回顶部功能相关
  useEffect(() => {
    // 获取滚动位置的函数 - 专门针对 body 滚动
    const getScrollTop = () => {
      return document.body.scrollTop || 0;
    };

    // 使用 requestAnimationFrame 持续检测滚动位置
    let isRunning = false;
    const checkScrollPosition = () => {
      if (!isRunning) return;

      const scrollTop = getScrollTop();
      const shouldShow = scrollTop > 300;
      setShowBackToTop(shouldShow);

      requestAnimationFrame(checkScrollPosition);
    };

    // 启动持续检测
    isRunning = true;
    checkScrollPosition();

    // 监听 body 元素的滚动事件
    const handleScroll = () => {
      const scrollTop = getScrollTop();
      setShowBackToTop(scrollTop > 300);
    };

    document.body.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      isRunning = false; // 停止 requestAnimationFrame 循环
      // 移除 body 滚动事件监听器
      document.body.removeEventListener('scroll', handleScroll);
    };
  }, []);

  // 返回顶部功能
  const scrollToTop = () => {
    try {
      // 根据调试结果，真正的滚动容器是 document.body
      document.body.scrollTo({
        top: 0,
        behavior: 'smooth',
      });
    } catch (error) {
      // 如果平滑滚动完全失败，使用立即滚动
      document.body.scrollTop = 0;
    }
  };

  if (loading) {
    return (
      <PageLayout activePath='/play'>
        <div className='flex items-center justify-center min-h-screen bg-transparent'>
          <div className='text-center max-w-md mx-auto px-6'>
            {/* 动画影院图标 */}
            <div className='relative mb-8'>
              <div className='relative mx-auto w-24 h-24 bg-gradient-to-r from-green-500 to-emerald-600 rounded-2xl shadow-2xl flex items-center justify-center transform hover:scale-105 transition-transform duration-300'>
                <div className='text-white text-4xl'>
                  {loadingStage === 'searching' && '🔍'}
                  {loadingStage === 'preferring' && '⚡'}
                  {loadingStage === 'fetching' && '🎬'}
                  {loadingStage === 'ready' && '✨'}
                </div>
                {/* 旋转光环 */}
                <div className='absolute -inset-2 bg-gradient-to-r from-green-500 to-emerald-600 rounded-2xl opacity-20 animate-spin'></div>
              </div>

              {/* 浮动粒子效果 */}
              <div className='absolute top-0 left-0 w-full h-full pointer-events-none'>
                <div className='absolute top-2 left-2 w-2 h-2 bg-green-400 rounded-full animate-bounce'></div>
                <div
                  className='absolute top-4 right-4 w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce'
                  style={{ animationDelay: '0.5s' }}
                ></div>
                <div
                  className='absolute bottom-3 left-6 w-1 h-1 bg-lime-400 rounded-full animate-bounce'
                  style={{ animationDelay: '1s' }}
                ></div>
              </div>
            </div>

            {/* 进度指示器 */}
            <div className='mb-6 w-80 mx-auto'>
              <div className='flex justify-center space-x-2 mb-4'>
                <div
                  className={`w-3 h-3 rounded-full transition-all duration-500 ${loadingStage === 'searching' || loadingStage === 'fetching'
                    ? 'bg-green-500 scale-125'
                    : loadingStage === 'preferring' ||
                      loadingStage === 'ready'
                      ? 'bg-green-500'
                      : 'bg-gray-300'
                    }`}
                ></div>
                <div
                  className={`w-3 h-3 rounded-full transition-all duration-500 ${loadingStage === 'preferring'
                    ? 'bg-green-500 scale-125'
                    : loadingStage === 'ready'
                      ? 'bg-green-500'
                      : 'bg-gray-300'
                    }`}
                ></div>
                <div
                  className={`w-3 h-3 rounded-full transition-all duration-500 ${loadingStage === 'ready'
                    ? 'bg-green-500 scale-125'
                    : 'bg-gray-300'
                    }`}
                ></div>
              </div>

              {/* 进度条 */}
              <div className='w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden'>
                <div
                  className='h-full bg-gradient-to-r from-green-500 to-emerald-600 rounded-full transition-all duration-1000 ease-out'
                  style={{
                    width:
                      loadingStage === 'searching' ||
                        loadingStage === 'fetching'
                        ? '33%'
                        : loadingStage === 'preferring'
                          ? '66%'
                          : '100%',
                  }}
                ></div>
              </div>
            </div>

            {/* 加载消息 */}
            <div className='space-y-2'>
              <p className='text-xl font-semibold text-gray-800 dark:text-gray-200 animate-pulse'>
                {loadingMessage}
              </p>
            </div>
          </div>
        </div>
      </PageLayout>
    );
  }

  if (error) {
    return (
      <PageLayout activePath='/play'>
        <div className='flex items-center justify-center min-h-screen bg-transparent'>
          <div className='text-center max-w-md mx-auto px-6'>
            {/* 错误图标 */}
            <div className='relative mb-8'>
              <div className='relative mx-auto w-24 h-24 bg-gradient-to-r from-red-500 to-orange-500 rounded-2xl shadow-2xl flex items-center justify-center transform hover:scale-105 transition-transform duration-300'>
                <div className='text-white text-4xl'>😵</div>
                {/* 脉冲效果 */}
                <div className='absolute -inset-2 bg-gradient-to-r from-red-500 to-orange-500 rounded-2xl opacity-20 animate-pulse'></div>
              </div>

              {/* 浮动错误粒子 */}
              <div className='absolute top-0 left-0 w-full h-full pointer-events-none'>
                <div className='absolute top-2 left-2 w-2 h-2 bg-red-400 rounded-full animate-bounce'></div>
                <div
                  className='absolute top-4 right-4 w-1.5 h-1.5 bg-orange-400 rounded-full animate-bounce'
                  style={{ animationDelay: '0.5s' }}
                ></div>
                <div
                  className='absolute bottom-3 left-6 w-1 h-1 bg-yellow-400 rounded-full animate-bounce'
                  style={{ animationDelay: '1s' }}
                ></div>
              </div>
            </div>

            {/* 错误信息 */}
            <div className='space-y-4 mb-8'>
              <h2 className='text-2xl font-bold text-gray-800 dark:text-gray-200'>
                哎呀，出现了一些问题
              </h2>
              <div className='bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4'>
                <p className='text-red-600 dark:text-red-400 font-medium'>
                  {error}
                </p>
              </div>
              <p className='text-sm text-gray-500 dark:text-gray-400'>
                请检查网络连接或尝试刷新页面
              </p>
            </div>

            {/* 操作按钮 */}
            <div className='space-y-3'>
              <button
                onClick={() =>
                  videoTitle
                    ? router.push(`/search?q=${encodeURIComponent(videoTitle)}`)
                    : router.back()
                }
                className='w-full px-6 py-3 bg-gradient-to-r from-green-500 to-emerald-600 text-white rounded-xl font-medium hover:from-green-600 hover:to-emerald-700 transform hover:scale-105 transition-all duration-200 shadow-lg hover:shadow-xl'
              >
                {videoTitle ? '🔍 返回搜索' : '← 返回上页'}
              </button>

              <button
                onClick={() => window.location.reload()}
                className='w-full px-6 py-3 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-xl font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors duration-200'
              >
                🔄 重新尝试
              </button>
            </div>
          </div>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout activePath='/play'>
      <div className='flex flex-col gap-3 py-4 px-5 lg:px-[3rem] 2xl:px-20'>
        {/* 第一行：影片标题 */}
        <div className='py-1'>
          <h1 className='text-xl font-semibold text-gray-900 dark:text-gray-100'>
            {videoTitle || '影片标题'}
            {totalEpisodes > 1 && (
              <span className='text-gray-500 dark:text-gray-400'>
                {` > ${detail?.episodes_titles?.[currentEpisodeIndex] || `第 ${currentEpisodeIndex + 1} 集`}`}
              </span>
            )}
          </h1>
        </div>
        {/* 第二行：播放器和选集 */}
        <div className='space-y-2'>
          {/* 折叠控制 - 仅在 lg 及以上屏幕显示 */}
          <div className='hidden lg:flex justify-end'>
            <button
              onClick={() =>
                setIsEpisodeSelectorCollapsed(!isEpisodeSelectorCollapsed)
              }
              className='group relative flex items-center space-x-1.5 px-3 py-1.5 rounded-full bg-white/80 hover:bg-white dark:bg-gray-800/80 dark:hover:bg-gray-800 backdrop-blur-sm border border-gray-200/50 dark:border-gray-700/50 shadow-sm hover:shadow-md transition-all duration-200'
              title={
                isEpisodeSelectorCollapsed ? '显示选集面板' : '隐藏选集面板'
              }
            >
              <svg
                className={`w-3.5 h-3.5 text-gray-500 dark:text-gray-400 transition-transform duration-200 ${isEpisodeSelectorCollapsed ? 'rotate-180' : 'rotate-0'
                  }`}
                fill='none'
                stroke='currentColor'
                viewBox='0 0 24 24'
              >
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth='2'
                  d='M9 5l7 7-7 7'
                />
              </svg>
              <span className='text-xs font-medium text-gray-600 dark:text-gray-300'>
                {isEpisodeSelectorCollapsed ? '显示' : '隐藏'}
              </span>

              {/* 精致的状态指示点 */}
              <div
                className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full transition-all duration-200 ${isEpisodeSelectorCollapsed
                  ? 'bg-orange-400 animate-pulse'
                  : 'bg-green-400'
                  }`}
              ></div>
            </button>
          </div>

          <div
            className={`grid gap-4 lg:h-[500px] xl:h-[650px] 2xl:h-[750px] transition-all duration-300 ease-in-out ${isEpisodeSelectorCollapsed
              ? 'grid-cols-1'
              : 'grid-cols-1 md:grid-cols-4'
              }`}
          >
            {/* 播放器 */}
            <div
              className={`h-full transition-all duration-300 ease-in-out rounded-xl border border-white/0 dark:border-white/30 ${isEpisodeSelectorCollapsed ? 'col-span-1' : 'md:col-span-3'
                }`}
            >
              <div className='relative w-full h-[300px] lg:h-full'>
                <div
                  ref={artRef}
                  className='bg-black w-full h-full rounded-xl overflow-hidden shadow-lg'
                ></div>

                {/* 换源加载蒙层 */}
                {playVideoLoading && (
                  <LiveLoadingIndicator
                    loadingState={videoLoadingState}
                    loadingMessage={videoLoadingMessage}
                    loadingTime={videoLoadingTime}
                    proxyStatus={proxyStatus}
                    onRetry={() => {
                      if (videoUrl) {
                        // 重新加载当前视频
                        if (artPlayerRef.current) {
                          artPlayerRef.current.switch = videoUrl;
                        }
                      }
                    }}
                    onSwitchSource={() => {
                      // 切换到换源面板
                      setIsEpisodeSelectorCollapsed(false);
                    }}
                  />
                )}
              </div>
            </div>

            {/* 选集和换源 - 在移动端始终显示，在 lg 及以上可折叠 */}
            <div
              className={`h-[300px] lg:h-full md:overflow-hidden transition-all duration-300 ease-in-out ${isEpisodeSelectorCollapsed
                ? 'md:col-span-1 lg:hidden lg:opacity-0 lg:scale-95'
                : 'md:col-span-1 lg:opacity-100 lg:scale-100'
                }`}
            >
              <EpisodeSelector
                totalEpisodes={totalEpisodes}
                episodes_titles={detail?.episodes_titles || []}
                value={currentEpisodeIndex + 1}
                onChange={handleEpisodeChange}
                onSourceChange={handleSourceChange}
                currentSource={currentSource}
                currentId={currentId}
                videoTitle={searchTitle || videoTitle}
                availableSources={availableSources}
                sourceSearchLoading={sourceSearchLoading}
                sourceSearchError={sourceSearchError}
                precomputedVideoInfo={precomputedVideoInfo}
              />
            </div>
          </div>
        </div>

        {/* 详情展示 */}
        <div className='grid grid-cols-1 md:grid-cols-4 gap-4'>
          {/* 文字区 */}
          <div className='md:col-span-3'>
            <div className='p-6 flex flex-col min-h-0'>
              {/* 标题 */}
              <h1 className='text-3xl font-bold mb-2 tracking-wide flex items-center flex-shrink-0 text-center md:text-left w-full'>
                {videoTitle || '影片标题'}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggleFavorite();
                  }}
                  className='ml-3 flex-shrink-0 hover:opacity-80 transition-opacity'
                >
                  <FavoriteIcon filled={favorited} />
                </button>
              </h1>

              {/* 关键信息行 */}
              <div className='flex flex-wrap items-center gap-3 text-base mb-4 opacity-80 flex-shrink-0'>
                {detail?.class && (
                  <span className='text-green-600 font-semibold'>
                    {detail.class}
                  </span>
                )}
                {(detail?.year || videoYear) && (
                  <span>{detail?.year || videoYear}</span>
                )}
                {detail?.source_name && (
                  <span className='border border-gray-500/60 px-2 py-[1px] rounded'>
                    {detail.source_name}
                  </span>
                )}
                {detail?.type_name && <span>{detail.type_name}</span>}
              </div>

              {/* 详细信息（豆瓣或bangumi） */}
              {currentSource !== 'shortdrama' && videoDoubanId && videoDoubanId !== 0 && detail && detail.source !== 'shortdrama' && (
                <div className='mb-4 flex-shrink-0'>
                  {/* 加载状态 */}
                  {(loadingMovieDetails || loadingBangumiDetails) && !movieDetails && !bangumiDetails && (
                    <div className='animate-pulse'>
                      <div className='h-4 bg-gray-300 rounded w-64 mb-2'></div>
                      <div className='h-4 bg-gray-300 rounded w-48'></div>
                    </div>
                  )}
                  
                  {/* Bangumi详情 */}
                  {bangumiDetails && (
                    <div className='space-y-2 text-sm'>
                      {/* Bangumi评分 */}
                      {bangumiDetails.rating?.score && parseFloat(bangumiDetails.rating.score) > 0 && (
                        <div className='flex items-center gap-2'>
                          <span className='font-semibold text-gray-700 dark:text-gray-300'>Bangumi评分: </span>
                          <div className='flex items-center'>
                            <span className='text-yellow-600 dark:text-yellow-400 font-bold text-base'>
                              {bangumiDetails.rating.score}
                            </span>
                            <div className='flex ml-1'>
                              {[...Array(5)].map((_, i) => (
                                <svg
                                  key={i}
                                  className={`w-3 h-3 ${
                                    i < Math.floor(parseFloat(bangumiDetails.rating.score) / 2)
                                      ? 'text-yellow-500'
                                      : 'text-gray-300 dark:text-gray-600'
                                  }`}
                                  fill='currentColor'
                                  viewBox='0 0 20 20'
                                >
                                  <path d='M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z' />
                                </svg>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* 制作信息从infobox提取 */}
                      {bangumiDetails.infobox && bangumiDetails.infobox.map((info: any, index: number) => {
                        if (info.key === '导演' && info.value) {
                          const directors = Array.isArray(info.value) ? info.value.map((v: any) => v.v || v).join('、') : info.value;
                          return (
                            <div key={index}>
                              <span className='font-semibold text-gray-700 dark:text-gray-300'>导演: </span>
                              <span className='text-gray-600 dark:text-gray-400'>{directors}</span>
                            </div>
                          );
                        }
                        if (info.key === '制作' && info.value) {
                          const studios = Array.isArray(info.value) ? info.value.map((v: any) => v.v || v).join('、') : info.value;
                          return (
                            <div key={index}>
                              <span className='font-semibold text-gray-700 dark:text-gray-300'>制作: </span>
                              <span className='text-gray-600 dark:text-gray-400'>{studios}</span>
                            </div>
                          );
                        }
                        return null;
                      })}
                      
                      {/* 播出日期 */}
                      {bangumiDetails.date && (
                        <div>
                          <span className='font-semibold text-gray-700 dark:text-gray-300'>播出日期: </span>
                          <span className='text-gray-600 dark:text-gray-400'>{bangumiDetails.date}</span>
                        </div>
                      )}
                      
                      {/* 标签信息 */}
                      <div className='flex flex-wrap gap-2 mt-3'>
                        {bangumiDetails.tags && bangumiDetails.tags.slice(0, 4).map((tag: any, index: number) => (
                          <span key={index} className='bg-blue-200 dark:bg-blue-800 text-blue-800 dark:text-blue-200 px-2 py-1 rounded-full text-xs'>
                            {tag.name}
                          </span>
                        ))}
                        {bangumiDetails.total_episodes && (
                          <span className='bg-green-200 dark:bg-green-800 text-green-800 dark:text-green-200 px-2 py-1 rounded-full text-xs'>
                            共{bangumiDetails.total_episodes}话
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* 豆瓣详情 */}
                  {movieDetails && !bangumiDetails && (
                    <div className='space-y-2 text-sm'>
                      {/* 豆瓣评分 */}
                      {movieDetails.rate && movieDetails.rate !== "0" && parseFloat(movieDetails.rate) > 0 && (
                        <div className='flex items-center gap-2'>
                          <span className='font-semibold text-gray-700 dark:text-gray-300'>豆瓣评分: </span>
                          <div className='flex items-center'>
                            <span className='text-yellow-600 dark:text-yellow-400 font-bold text-base'>
                              {movieDetails.rate}
                            </span>
                            <div className='flex ml-1'>
                              {[...Array(5)].map((_, i) => (
                                <svg
                                  key={i}
                                  className={`w-3 h-3 ${
                                    i < Math.floor(parseFloat(movieDetails.rate) / 2)
                                      ? 'text-yellow-500'
                                      : 'text-gray-300 dark:text-gray-600'
                                  }`}
                                  fill='currentColor'
                                  viewBox='0 0 20 20'
                                >
                                  <path d='M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z' />
                                </svg>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* 导演 */}
                      {movieDetails.directors && movieDetails.directors.length > 0 && (
                        <div>
                          <span className='font-semibold text-gray-700 dark:text-gray-300'>导演: </span>
                          <span className='text-gray-600 dark:text-gray-400'>
                            {movieDetails.directors.join('、')}
                          </span>
                        </div>
                      )}
                      
                      {/* 编剧 */}
                      {movieDetails.screenwriters && movieDetails.screenwriters.length > 0 && (
                        <div>
                          <span className='font-semibold text-gray-700 dark:text-gray-300'>编剧: </span>
                          <span className='text-gray-600 dark:text-gray-400'>
                            {movieDetails.screenwriters.join('、')}
                          </span>
                        </div>
                      )}
                      
                      {/* 主演 */}
                      {movieDetails.cast && movieDetails.cast.length > 0 && (
                        <div>
                          <span className='font-semibold text-gray-700 dark:text-gray-300'>主演: </span>
                          <span className='text-gray-600 dark:text-gray-400'>
                            {movieDetails.cast.join('、')}
                          </span>
                        </div>
                      )}
                      
                      {/* 首播日期 */}
                      {movieDetails.first_aired && (
                        <div>
                          <span className='font-semibold text-gray-700 dark:text-gray-300'>
                            {movieDetails.episodes ? '首播' : '上映'}: 
                          </span>
                          <span className='text-gray-600 dark:text-gray-400'>
                            {movieDetails.first_aired}
                          </span>
                        </div>
                      )}
                      
                      {/* 标签信息 */}
                      <div className='flex flex-wrap gap-2 mt-3'>
                        {movieDetails.countries && movieDetails.countries.slice(0, 2).map((country: string, index: number) => (
                          <span key={index} className='bg-blue-200 dark:bg-blue-800 text-blue-800 dark:text-blue-200 px-2 py-1 rounded-full text-xs'>
                            {country}
                          </span>
                        ))}
                        {movieDetails.languages && movieDetails.languages.slice(0, 2).map((language: string, index: number) => (
                          <span key={index} className='bg-purple-200 dark:bg-purple-800 text-purple-800 dark:text-purple-200 px-2 py-1 rounded-full text-xs'>
                            {language}
                          </span>
                        ))}
                        {movieDetails.episodes && (
                          <span className='bg-green-200 dark:bg-green-800 text-green-800 dark:text-green-200 px-2 py-1 rounded-full text-xs'>
                            共{movieDetails.episodes}集
                          </span>
                        )}
                        {movieDetails.episode_length && (
                          <span className='bg-orange-200 dark:bg-orange-800 text-orange-800 dark:text-orange-200 px-2 py-1 rounded-full text-xs'>
                            单集{movieDetails.episode_length}分钟
                          </span>
                        )}
                        {movieDetails.movie_duration && (
                          <span className='bg-red-200 dark:bg-red-800 text-red-800 dark:text-red-200 px-2 py-1 rounded-full text-xs'>
                            {movieDetails.movie_duration}分钟
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* 短剧详细信息 */}
              {detail?.source === 'shortdrama' && (
                <div className='mb-4 flex-shrink-0'>
                  <div className='space-y-2 text-sm'>
                    {/* 集数信息 */}
                    {detail?.episodes && detail.episodes.length > 0 && (
                      <div className='flex flex-wrap gap-2'>
                        <span className='bg-blue-200 dark:bg-blue-800 text-blue-800 dark:text-blue-200 px-2 py-1 rounded-full text-xs'>
                          共{detail.episodes.length}集
                        </span>
                        <span className='bg-green-200 dark:bg-green-800 text-green-800 dark:text-green-200 px-2 py-1 rounded-full text-xs'>
                          短剧
                        </span>
                        <span className='bg-purple-200 dark:bg-purple-800 text-purple-800 dark:text-purple-200 px-2 py-1 rounded-full text-xs'>
                          {detail.year}年
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 剧情简介 */}
              {(detail?.desc || bangumiDetails?.summary) && (
                <div
                  className='mt-0 text-base leading-relaxed opacity-90 overflow-y-auto pr-2 flex-1 min-h-0 scrollbar-hide'
                  style={{ whiteSpace: 'pre-line' }}
                >
                  {bangumiDetails?.summary || detail?.desc}
                </div>
              )}
            </div>
          </div>

          {/* 封面展示 */}
          <div className='hidden md:block md:col-span-1 md:order-first'>
            <div className='pl-0 py-4 pr-6'>
              <div className='relative bg-gray-300 dark:bg-gray-700 aspect-[2/3] flex items-center justify-center rounded-xl overflow-hidden'>
                {(videoCover || bangumiDetails?.images?.large) ? (
                  <>
                    <img
                      src={processImageUrl(bangumiDetails?.images?.large || videoCover)}
                      alt={videoTitle}
                      className='w-full h-full object-cover'
                    />

                    {/* 链接按钮（bangumi或豆瓣） */}
                    {videoDoubanId !== 0 && (
                      <a
                        href={
                          bangumiDetails 
                            ? `https://bgm.tv/subject/${bangumiSubjectId.toString()}`
                            : `https://movie.douban.com/subject/${videoDoubanId.toString()}`
                        }
                        target='_blank'
                        rel='noopener noreferrer'
                        className='absolute top-3 left-3'
                      >
                        <div className={`${bangumiDetails ? 'bg-pink-500 hover:bg-pink-600' : 'bg-green-500 hover:bg-green-600'} text-white text-xs font-bold w-8 h-8 rounded-full flex items-center justify-center shadow-md hover:scale-[1.1] transition-all duration-300 ease-out`}>
                          <svg
                            width='16'
                            height='16'
                            viewBox='0 0 24 24'
                            fill='none'
                            stroke='currentColor'
                            strokeWidth='2'
                            strokeLinecap='round'
                            strokeLinejoin='round'
                          >
                            <path d='M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'></path>
                            <path d='M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'></path>
                          </svg>
                        </div>
                      </a>
                    )}
                  </>
                ) : (
                  <span className='text-gray-600 dark:text-gray-400'>
                    封面图片
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 返回顶部悬浮按钮 */}
      <button
        onClick={scrollToTop}
        className={`fixed bottom-20 md:bottom-6 right-6 z-[500] w-12 h-12 bg-green-500/90 hover:bg-green-500 text-white rounded-full shadow-lg backdrop-blur-sm transition-all duration-300 ease-in-out flex items-center justify-center group ${
          showBackToTop
            ? 'opacity-100 translate-y-0 pointer-events-auto'
            : 'opacity-0 translate-y-4 pointer-events-none'
        }`}
        aria-label='返回顶部'
      >
        <ChevronUp className='w-6 h-6 transition-transform group-hover:scale-110' />
      </button>

      {/* 手动匹配弹幕弹窗 */}
      <DanmuManualMatchModal
        isOpen={isDanmuManualModalOpen}
        defaultKeyword={videoTitle || ''}
        currentEpisode={currentEpisodeIndex + 1}
        onClose={() => setIsDanmuManualModalOpen(false)}
        onApply={handleDanmuManualApply}
      />

      {/* 跳过片头片尾设置面板 */}
      {isSkipSettingMode && (
        <SkipController
          source={currentSource || ''}
          id={currentId || ''}
          title={videoTitle || ''}
          doubanId={videoDoubanId}
          year={videoYear}
          episodeIndex={currentEpisodeIndex}
          artPlayerRef={artPlayerRef}
          isSettingMode={isSkipSettingMode}
          onSettingModeChange={setIsSkipSettingMode}
          onNextEpisode={handleNextEpisode}
          currentTime={currentPlayTime}
          duration={videoDuration}
        />
      )}
    </PageLayout>
  );
}

// FavoriteIcon 组件
const FavoriteIcon = ({ filled }: { filled: boolean }) => {
  if (filled) {
    return (
      <svg
        className='h-7 w-7'
        viewBox='0 0 24 24'
        xmlns='http://www.w3.org/2000/svg'
      >
        <path
          d='M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'
          fill='#ef4444' /* Tailwind red-500 */
          stroke='#ef4444'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
        />
      </svg>
    );
  }
  return (
    <Heart className='h-7 w-7 stroke-[1] text-gray-600 dark:text-gray-300' />
  );
};

export default function PlayPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <PlayPageClient />
    </Suspense>
  );
}
