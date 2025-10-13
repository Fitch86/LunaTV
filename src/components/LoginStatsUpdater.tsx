'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

export default function LoginStatsUpdater() {
  const pathname = usePathname();

  useEffect(() => {
    // 只在客户端执行
    const updateLoginStats = async () => {
      // 使用 sessionStorage 防止重复更新
      const sessionKey = 'loginStatsUpdated';
      if (sessionStorage.getItem(sessionKey)) {
        return; // 如果已经更新过，直接返回
      }

      try {
        const loginTime = Date.now();
        const response = await fetch('/api/user/my-stats', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify({
            loginTime
          })
        });

        if (response.ok) {
          // 标记为已更新
          sessionStorage.setItem(sessionKey, 'true');
          
          // 清除 cookie 标记
          document.cookie = 'needsLoginStatsUpdate=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
        }
      } catch (error) {
        // 静默失败，不显示错误给用户
      }
    };

    // 检查是否需要更新登录统计
    const shouldUpdate = document.cookie
      .split('; ')
      .some((row) => row.startsWith('needsLoginStatsUpdate='));

    if (shouldUpdate) {
      updateLoginStats();
    }
  }, [pathname]);

  return null; // 这个组件不渲染任何内容
}
