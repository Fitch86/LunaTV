import { NextRequest, NextResponse } from 'next/server';

// 内存缓存存储
const cache = new Map<string, { data: any; expireAt: number }>();

// 清理过期缓存的定时器
let cleanupTimer: NodeJS.Timeout | null = null;

// 启动定期清理
function startCleanup() {
  if (cleanupTimer) return;
  
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, item] of cache.entries()) {
      if (item.expireAt <= now) {
        cache.delete(key);
      }
    }
  }, 60000); // 每分钟清理一次
}

// GET - 获取缓存
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key');

  if (!key) {
    return NextResponse.json({ error: 'Missing key parameter' }, { status: 400 });
  }

  const item = cache.get(key);
  if (!item) {
    return NextResponse.json({ data: null });
  }

  // 检查是否过期
  if (item.expireAt <= Date.now()) {
    cache.delete(key);
    return NextResponse.json({ data: null });
  }

  return NextResponse.json({ data: item.data });
}

// POST - 设置缓存
export async function POST(request: NextRequest) {
  try {
    const { key, data, expireSeconds = 3600 } = await request.json();

    if (!key) {
      return NextResponse.json({ error: 'Missing key parameter' }, { status: 400 });
    }

    const expireAt = Date.now() + (expireSeconds * 1000);
    cache.set(key, { data, expireAt });

    // 启动清理定时器
    startCleanup();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('设置缓存失败:', error);
    return NextResponse.json({ error: 'Failed to set cache' }, { status: 500 });
  }
}

// DELETE - 删除缓存
export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key');
  const prefix = searchParams.get('prefix');

  if (key) {
    // 删除单个缓存项
    cache.delete(key);
    return NextResponse.json({ success: true });
  } else if (prefix) {
    // 删除指定前缀的所有缓存项
    for (const cacheKey of cache.keys()) {
      if (cacheKey.startsWith(prefix)) {
        cache.delete(cacheKey);
      }
    }
    return NextResponse.json({ success: true });
  } else {
    // 清理所有过期缓存
    const now = Date.now();
    for (const [cacheKey, item] of cache.entries()) {
      if (item.expireAt <= now) {
        cache.delete(cacheKey);
      }
    }
    return NextResponse.json({ success: true });
  }
}
