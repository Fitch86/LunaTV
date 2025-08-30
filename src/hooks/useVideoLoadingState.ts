import { useEffect, useRef, useState } from 'react';

export type VideoLoadingState = 
  | 'idle' 
  | 'connecting' 
  | 'proxyConnecting'
  | 'proxyResponding'
  | 'loading' 
  | 'buffering' 
  | 'playing' 
  | 'error' 
  | 'success'
  | 'timeout'
  | 'noResponse';

export interface VideoLoadingProgress {
  state: VideoLoadingState;
  message: string;
  timeElapsed: number;
  proxyResponseReceived: boolean;
  segmentRequestCount: number;
  lastSegmentTime: number;
}

export interface ProxyStatus {
  isResponding: boolean;
  lastResponseTime: number;
  segmentRequestCount: number;
  errorCount: number;
}

export const useVideoLoadingState = () => {
  const [loadingState, setLoadingState] = useState<VideoLoadingState>('idle');
  const [loadingMessage, setLoadingMessage] = useState('准备播放...');
  const [loadingTime, setLoadingTime] = useState(0);
  const [proxyStatus, setProxyStatus] = useState<ProxyStatus>({
    isResponding: false,
    lastResponseTime: 0,
    segmentRequestCount: 0,
    errorCount: 0
  });
  
  const loadingStartTime = useRef<number>(0);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const proxyTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const noResponseTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // 开始加载计时
  const startLoadingTimer = () => {
    loadingStartTime.current = Date.now();
    
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    
    intervalRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - loadingStartTime.current) / 1000);
      setLoadingTime(elapsed);
      
      // 根据时长动态调整消息
      if (elapsed > 30 && loadingState !== 'error' && loadingState !== 'success') {
        if (!proxyStatus.isResponding) {
          updateLoadingState('noResponse', '代理服务器无响应，请检查网络连接或切换源');
        } else if (proxyStatus.segmentRequestCount === 0) {
          updateLoadingState('timeout', '加载时间过长，视频源可能不可用');
        }
      }
    }, 1000);
  };
  
  // 停止加载计时
  const stopLoadingTimer = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (proxyTimeoutRef.current) {
      clearTimeout(proxyTimeoutRef.current);
      proxyTimeoutRef.current = null;
    }
    if (noResponseTimeoutRef.current) {
      clearTimeout(noResponseTimeoutRef.current);
      noResponseTimeoutRef.current = null;
    }
  };
  
  // 更新代理状态
  const updateProxyStatus = (status: Partial<ProxyStatus>) => {
    setProxyStatus(prev => ({
      ...prev,
      ...status,
      lastResponseTime: status.isResponding !== undefined && status.isResponding 
        ? Date.now() 
        : prev.lastResponseTime
    }));
  };
  
  // 记录代理响应
  const recordProxyResponse = () => {
    updateProxyStatus({
      isResponding: true,
      lastResponseTime: Date.now()
    });
    
    // 清除无响应超时
    if (noResponseTimeoutRef.current) {
      clearTimeout(noResponseTimeoutRef.current);
      noResponseTimeoutRef.current = null;
    }
    
    // 如果当前状态是连接中，更新为代理响应中
    if (loadingState === 'proxyConnecting') {
      updateLoadingState('proxyResponding', '代理服务器已响应，正在努力加载中...');
    }
  };
  
  // 记录segment请求
  const recordSegmentRequest = () => {
    updateProxyStatus({
      segmentRequestCount: proxyStatus.segmentRequestCount + 1
    });
    recordProxyResponse();
  };
  
  // 记录错误
  const recordError = () => {
    updateProxyStatus({
      errorCount: proxyStatus.errorCount + 1
    });
  };
  
  // 更新加载状态
  const updateLoadingState = (state: VideoLoadingState, message: string) => {
    setLoadingState(state);
    setLoadingMessage(message);
    
    // 根据状态自动处理计时器
    if (state === 'idle' || state === 'error' || state === 'success' || state === 'timeout' || state === 'noResponse') {
      stopLoadingTimer();
    } else if (loadingStartTime.current === 0) {
      startLoadingTimer();
    }
    
    // 设置代理连接超时检测
    if (state === 'proxyConnecting' || state === 'connecting') {
      // 10秒内没有代理响应则判断为无响应
      noResponseTimeoutRef.current = setTimeout(() => {
        if (!proxyStatus.isResponding) {
          updateLoadingState('noResponse', '代理服务器无响应，源连接不上');
        }
      }, 10000);
    }
  };
  
  // 智能状态判断 - 增强版
  const smartUpdateState = (baseState: VideoLoadingState, baseMessage: string) => {
    const elapsed = Math.floor((Date.now() - loadingStartTime.current) / 1000);
    
    if (baseState === 'connecting') {
      updateLoadingState('proxyConnecting', '正在连接代理服务器...');
    } else if (baseState === 'loading') {
      if (proxyStatus.isResponding) {
        if (proxyStatus.segmentRequestCount > 0) {
          // 有segment请求，说明视频流正在传输
          updateLoadingState('loading', '正在加载视频数据，播放器准备中...');
        } else if (elapsed > 8) {
          // 代理响应但长时间没有segment，可能源有问题
          updateLoadingState('proxyResponding', '代理已连接，但视频流获取缓慢，请耐心等待...');
        } else {
          updateLoadingState('proxyResponding', '代理已响应，正在努力获取视频流...');
        }
      } else {
        if (elapsed > 5) {
          // 连接时间过长且代理无响应
          updateLoadingState('proxyConnecting', '代理连接缓慢，正在尝试建立连接...');
        } else {
          updateLoadingState('loading', baseMessage);
        }
      }
    } else {
      updateLoadingState(baseState, baseMessage);
    }
  };
  
  // 判断视频源是否可能无法播放
  const isSourceLikelyFailed = () => {
    const elapsed = Math.floor((Date.now() - loadingStartTime.current) / 1000);
    
    // 情况1：长时间无代理响应
    if (elapsed > 15 && !proxyStatus.isResponding) {
      return { failed: true, reason: '代理服务器无响应，源连接不上' };
    }
    
    // 情况2：代理响应但长时间无segment请求
    if (elapsed > 25 && proxyStatus.isResponding && proxyStatus.segmentRequestCount === 0) {
      return { failed: true, reason: '代理已连接但无法获取视频流，源可能不可用' };
    }
    
    // 情况3：错误过多
    if (proxyStatus.errorCount > 5) {
      return { failed: true, reason: '连接错误过多，源可能存在问题' };
    }
    
    return { failed: false, reason: '' };
  };
  
  // 判断是否有希望成功加载
  const hasLoadingHope = () => {
    const elapsed = Math.floor((Date.now() - loadingStartTime.current) / 1000);
    
    // 有segment请求说明有希望
    if (proxyStatus.segmentRequestCount > 0) {
      return { hopeful: true, reason: '正在接收视频数据' };
    }
    
    // 代理响应且时间不长说明有希望
    if (proxyStatus.isResponding && elapsed < 20) {
      return { hopeful: true, reason: '代理已连接，正在获取视频流' };
    }
    
    // 刚开始连接时有希望
    if (elapsed < 10) {
      return { hopeful: true, reason: '正在建立连接' };
    }
    
    return { hopeful: false, reason: '连接状态不佳' };
  };
  
  // 重置加载状态
  const resetLoadingState = () => {
    setLoadingState('idle');
    setLoadingMessage('准备播放...');
    setLoadingTime(0);
    loadingStartTime.current = 0;
    setProxyStatus({
      isResponding: false,
      lastResponseTime: 0,
      segmentRequestCount: 0,
      errorCount: 0
    });
    stopLoadingTimer();
  };
  
  // 清理函数
  useEffect(() => {
    return () => {
      stopLoadingTimer();
    };
  }, []);
  
  return {
    loadingState,
    loadingMessage,
    loadingTime,
    proxyStatus,
    updateLoadingState,
    smartUpdateState,
    resetLoadingState,
    startLoadingTimer,
    stopLoadingTimer,
    recordProxyResponse,
    recordSegmentRequest,
    recordError,
    updateProxyStatus,
    isSourceLikelyFailed,
    hasLoadingHope
  };
};