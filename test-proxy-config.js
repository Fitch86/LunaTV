/* eslint-disable no-console */
// 测试LunaTV中代理URL构建是否正确
// 在浏览器控制台中运行此脚本

console.log('🔧 测试代理URL构建逻辑：');

// 检查环境变量
console.log('\n📋 环境变量检查：');
console.log(
  '   NEXT_PUBLIC_TVCORS_PROXY_URL:',
  process.env.NEXT_PUBLIC_TVCORS_PROXY_URL
);
console.log('   TVCORS_PROXY_URL:', process.env.TVCORS_PROXY_URL);

// 模拟代理工具函数（与实际代码一致）
function getTVCorsProxyBaseURL() {
  // 从环境变量获取，优先使用NEXT_PUBLIC_前缀的变量（客户端可用）
  const proxyUrl =
    process.env.NEXT_PUBLIC_TVCORS_PROXY_URL ||
    process.env.TVCORS_PROXY_URL ||
    'http://localhost:3001';

  // 确保URL不以斜杠结尾
  return proxyUrl.endsWith('/') ? proxyUrl.slice(0, -1) : proxyUrl;
}

function buildProxyURL(type, params) {
  const baseURL = getTVCorsProxyBaseURL();
  const url = new URL(`${baseURL}/api/proxy/${type}`);

  // 添加查询参数
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      // URL参数需要编码
      if (key === 'url') {
        url.searchParams.set(key, encodeURIComponent(value.toString()));
      } else {
        url.searchParams.set(key, value.toString());
      }
    }
  });

  return url.toString();
}

function buildM3U8ProxyURL(videoUrl, source, allowCORS) {
  const params = { url: videoUrl };

  if (source) {
    params['moontv-source'] = source;
  }

  if (allowCORS !== undefined) {
    params.allowCORS = allowCORS;
  }

  return buildProxyURL('m3u8', params);
}

function buildLogoProxyURL(logoUrl, source) {
  const params = { url: logoUrl };

  if (source) {
    params['moontv-source'] = source;
  }

  return buildProxyURL('logo', params);
}

// 测试URL构建
console.log('\n🧪 代理URL构建测试：');

const testCases = [
  {
    name: 'M3U8代理URL',
    fn: () =>
      buildM3U8ProxyURL('https://example.com/stream.m3u8', 'test-source'),
    expected:
      'http://localhost:3001/api/proxy/m3u8?url=...&moontv-source=test-source',
  },
  {
    name: 'Logo代理URL',
    fn: () => buildLogoProxyURL('https://example.com/logo.png', 'test-source'),
    expected:
      'http://localhost:3001/api/proxy/logo?url=...&moontv-source=test-source',
  },
];

testCases.forEach((testCase, index) => {
  console.log(`\n   测试 ${index + 1}: ${testCase.name}`);
  try {
    const result = testCase.fn();
    console.log(`   构建结果: ${result}`);

    // 检查是否包含localhost:3001
    const isCorrect = result.includes('localhost:3001');
    console.log(`   ✅ 使用本地代理: ${isCorrect ? '是' : '否'}`);

    if (!isCorrect) {
      console.log(`   ❌ 错误：应该包含 localhost:3001`);
    }
  } catch (error) {
    console.log(`   ❌ 错误: ${error.message}`);
  }
});

console.log('\n📊 调试信息：');
console.log(`   基础URL: ${getTVCorsProxyBaseURL()}`);
console.log(`   环境: ${typeof window !== 'undefined' ? '客户端' : '服务端'}`);

console.log('\n💡 使用说明：');
console.log('1. 在LunaTV页面打开浏览器开发者工具');
console.log('2. 在控制台粘贴并运行此脚本');
console.log('3. 检查输出结果是否正确使用 localhost:3001');
