export class ClientCache {
  static async get(key: string): Promise<unknown | null> {
    try {
      const response = await fetch(`/api/cache?key=${encodeURIComponent(key)}`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const result = await response.json();
      return result.data;
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('获取缓存失败:', error);
      }
      return null;
    }
  }

  static async set(key: string, data: unknown, expireSeconds?: number): Promise<void> {
    try {
      const response = await fetch('/api/cache', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ key, data, expireSeconds }),
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('设置缓存失败:', error);
      }
      throw error;
    }
  }

  static async delete(key: string): Promise<void> {
    try {
      const response = await fetch(`/api/cache?key=${encodeURIComponent(key)}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('删除缓存失败:', error);
      }
      throw error;
    }
  }

  static async clearExpired(prefix?: string): Promise<void> {
    try {
      const url = prefix ? `/api/cache?prefix=${encodeURIComponent(prefix)}` : '/api/cache';
      const response = await fetch(url, {
        method: 'DELETE',
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('清理过期缓存失败:', error);
      }
      throw error;
    }
  }
}
