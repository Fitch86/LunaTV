'use client';

import { useEffect, useState } from 'react';

interface LiveLoadingIndicatorProps {
  loadingState: 'idle' | 'connecting' | 'proxyConnecting' | 'proxyResponding' | 'loading' | 'buffering' | 'playing' | 'success' | 'error' | 'timeout' | 'noResponse';
  loadingMessage: string;
  loadingTime: number;
  proxyStatus?: {
    isResponding: boolean;
    segmentRequestCount: number;
    errorCount: number;
  };
  isSourceLikelyFailed?: () => { failed: boolean; reason: string };
  hasLoadingHope?: () => { hopeful: boolean; reason: string };
  onRetry?: () => void;
  onSwitchSource?: () => void;
}

export default function LiveLoadingIndicator({
  loadingState,
  loadingMessage,
  loadingTime,
  proxyStatus,
  isSourceLikelyFailed,
  hasLoadingHope,
  onRetry,
  onSwitchSource
}: LiveLoadingIndicatorProps) {
  const [showExtendedMessage, setShowExtendedMessage] = useState(false);
  const [showTimeoutWarning, setShowTimeoutWarning] = useState(false);
  const [showSmartSuggestion, setShowSmartSuggestion] = useState(false);

  useEffect(() => {
    let timer: NodeJS.Timeout;
    let timeoutWarning: NodeJS.Timeout;
    let smartSuggestionTimer: NodeJS.Timeout;
    
    if (
      loadingState === 'loading' || 
      loadingState === 'connecting' || 
      loadingState === 'proxyConnecting' ||
      loadingState === 'proxyResponding' ||
      loadingState === 'buffering'
    ) {
      timer = setTimeout(() => {
        setShowExtendedMessage(true);
      }, 3000); // 3秒后显示扩展消息
      
      // 根据代理状态和segment请求调整超时警告时间
      let timeoutDelay = 15000; // 默认15秒
      if (proxyStatus?.isResponding) {
        timeoutDelay = proxyStatus.segmentRequestCount > 0 ? 25000 : 18000;
      }
      
      timeoutWarning = setTimeout(() => {
        setShowTimeoutWarning(true);
      }, timeoutDelay);
      
      // 智能建议显示时机
      smartSuggestionTimer = setTimeout(() => {
        if (isSourceLikelyFailed && isSourceLikelyFailed().failed) {
          setShowSmartSuggestion(true);
        }
      }, 12000);
    } else {
      setShowExtendedMessage(false);
      setShowTimeoutWarning(false);
      setShowSmartSuggestion(false);
    }
    
    return () => {
      if (timer) clearTimeout(timer);
      if (timeoutWarning) clearTimeout(timeoutWarning);
      if (smartSuggestionTimer) clearTimeout(smartSuggestionTimer);
    };
  }, [loadingState, proxyStatus?.isResponding, proxyStatus?.segmentRequestCount, isSourceLikelyFailed]);

  const getIcon = () => {
    switch (loadingState) {
      case 'connecting':
      case 'proxyConnecting':
        return (
          <div className="relative">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white"></div>
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-3 h-3 bg-white rounded-full animate-pulse"></div>
            </div>
          </div>
        );
      case 'proxyResponding':
        return (
          <div className="relative">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-green-400 border-opacity-75"></div>
            <div className="absolute inset-0 flex items-center justify-center">
              <svg className="w-6 h-6 text-green-400 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
              </svg>
            </div>
          </div>
        );
      case 'loading':
      case 'buffering':
        return (
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-white border-opacity-50"></div>
        );
      case 'success':
      case 'playing':
        return (
          <div className="text-green-500">
            <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path>
            </svg>
          </div>
        );
      case 'error':
      case 'timeout':
      case 'noResponse':
        return (
          <div className="text-red-500">
            <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
          </div>
        );
      default:
        return (
          <div className="animate-pulse rounded-full h-12 w-12 bg-gray-400"></div>
        );
    }
  };

  const getProgressIndicator = () => {
    if (
      loadingState === 'connecting' || 
      loadingState === 'proxyConnecting' ||
      loadingState === 'proxyResponding' ||
      loadingState === 'loading' || 
      loadingState === 'buffering'
    ) {
      // 根据加载时间和状态计算进度
      let progress = 0;
      
      if (loadingState === 'connecting' || loadingState === 'proxyConnecting') {
        progress = Math.min(25, loadingTime * 2); // 连接阶段最多25%
      } else if (loadingState === 'proxyResponding') {
        progress = Math.min(45, 25 + loadingTime); // 代理响应阶段从25%到45%
      } else if (loadingState === 'loading') {
        if (proxyStatus?.segmentRequestCount && proxyStatus.segmentRequestCount > 0) {
          progress = Math.min(70, 45 + (proxyStatus.segmentRequestCount * 5)); // 基于segment请求数
        } else {
          progress = Math.min(60, 45 + loadingTime); // 加载阶段从45%到60%
        }
      } else if (loadingState === 'buffering') {
        progress = Math.min(90, 60 + loadingTime); // 缓冲阶段从60%到90%
      }
      
      // 根据代理状态调整进度条颜色
      const progressColorClass = proxyStatus?.isResponding 
        ? "bg-gradient-to-r from-green-500 to-emerald-500"
        : "bg-gradient-to-r from-blue-500 to-cyan-500";
      
      return (
        <div className="w-48 h-2 bg-gray-700 rounded-full overflow-hidden mt-4">
          <div 
            className={`h-full ${progressColorClass} rounded-full transition-all duration-300`}
            style={{ width: `${progress}%` }}
          ></div>
        </div>
      );
    }
    return null;
  };

  const getStatusIndicator = () => {
    if (!proxyStatus) return null;
    
    return (
      <div className="mt-2 text-xs text-gray-500 flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${
          proxyStatus.segmentRequestCount > 0 
            ? 'bg-green-400 animate-pulse' 
            : proxyStatus.isResponding 
              ? 'bg-yellow-400 animate-pulse' 
              : 'bg-gray-400'
        }`}></div>
        <span>
          {proxyStatus.segmentRequestCount > 0 
            ? `正在播放 (片段: ${proxyStatus.segmentRequestCount})`
            : proxyStatus.isResponding 
              ? '代理已连接，等待视频流'
              : '连接中'
          }
        </span>
      </div>
    );
  };

  const getExtendedMessage = () => {
    if (!showExtendedMessage) return null;
    
    // 优先显示智能判断的希望状态
    if (hasLoadingHope) {
      const hope = hasLoadingHope();
      if (hope.hopeful) {
        return `${hope.reason}，请稍候...`;
      }
    }
    
    switch (loadingState) {
      case 'connecting':
      case 'proxyConnecting':
        return '正在建立与代理服务器的连接...';
      case 'proxyResponding':
        if (proxyStatus?.segmentRequestCount && proxyStatus.segmentRequestCount > 0) {
          return '代理已连接，正在接收视频数据...';
        }
        return '代理服务器已响应，正在获取视频流数据...';
      case 'loading':
        if (proxyStatus?.segmentRequestCount && proxyStatus.segmentRequestCount > 0) {
          return '正在加载视频片段，播放器准备中...';
        }
        return '正在加载视频数据，请稍候...';
      case 'buffering':
        return '正在缓冲视频内容，请耐心等待...';
      default:
        return null;
    }
  };

  const getTimeoutWarningMessage = () => {
    if (!showTimeoutWarning && !showSmartSuggestion) return null;
    
    // 优先显示智能判断结果
    if (showSmartSuggestion && isSourceLikelyFailed) {
      const failureInfo = isSourceLikelyFailed();
      if (failureInfo.failed) {
        return failureInfo.reason;
      }
    }
    
    if (loadingState === 'noResponse') {
      return '代理服务器无响应，视频源可能无法访问';
    } else if (loadingState === 'timeout') {
      return '加载时间过长，视频源可能存在问题';
    } else if (!proxyStatus?.isResponding) {
      return '代理连接超时，建议检查网络或切换源';
    } else if (proxyStatus?.segmentRequestCount === 0) {
      return '代理已连接但未收到视频数据，建议切换源';
    } else {
      return '加载时间较长，您可以选择切换源或稍后再试';
    }
  };

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black bg-opacity-90 z-50 backdrop-blur-sm">
      <div className="flex flex-col items-center max-w-md px-4">
        {getIcon()}
        
        <div className="mt-4 text-center">
          <p className="text-white text-lg font-medium">{loadingMessage}</p>
          {loadingTime > 0 && (
            <p className="text-gray-400 text-sm mt-1">
              已等待 {Math.floor(loadingTime / 60)}:{(loadingTime % 60).toString().padStart(2, '0')}
            </p>
          )}
        </div>
        
        {getProgressIndicator()}
        {getStatusIndicator()}
        
        {showExtendedMessage && (
          <div className="mt-4 text-center">
            <p className="text-gray-400 text-sm">
              {getExtendedMessage()}
            </p>
          </div>
        )}
        
        {(showTimeoutWarning || showSmartSuggestion) && (
          <div className="mt-4 text-center">
            <p className={`text-sm flex items-center justify-center gap-1 ${
              showSmartSuggestion && isSourceLikelyFailed?.().failed 
                ? 'text-red-400' 
                : 'text-amber-400'
            }`}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                {showSmartSuggestion && isSourceLikelyFailed?.().failed ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path>
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
                )}
              </svg>
              {getTimeoutWarningMessage()}
            </p>
          </div>
        )}
        
        {((loadingState === 'error' || loadingState === 'timeout' || loadingState === 'noResponse') || 
          (showSmartSuggestion && isSourceLikelyFailed?.().failed)) && (
          <div className="flex gap-3 mt-6">
            {onRetry && (
              <button
                onClick={onRetry}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors flex items-center gap-1"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                </svg>
                重试
              </button>
            )}
            {onSwitchSource && (
              <button
                onClick={onSwitchSource}
                className={`px-4 py-2 rounded-lg transition-colors flex items-center gap-1 ${
                  showSmartSuggestion && isSourceLikelyFailed?.().failed
                    ? 'bg-red-600 hover:bg-red-700 text-white'
                    : 'bg-gray-600 hover:bg-gray-700 text-white'
                }`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"></path>
                </svg>
                切换源
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}