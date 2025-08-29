#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * LunaTV与TVCors-Proxy集成测试脚本
 * 验证LunaTV能否正确使用外部tvcors-proxy服务
 */

console.log('🧪 LunaTV与TVCors-Proxy集成测试');
console.log('='.repeat(50));

// 测试环境变量读取
console.log('\n📋 测试环境变量配置：');
const envVars = {
  TVCORS_PROXY_URL: process.env.TVCORS_PROXY_URL,
  NEXT_PUBLIC_TVCORS_PROXY_URL: process.env.NEXT_PUBLIC_TVCORS_PROXY_URL,
  NODE_ENV: process.env.NODE_ENV,
};

Object.entries(envVars).forEach(([key, value]) => {
  console.log(`   ${key}: ${value || '(未设置)'}`);
});

// 模拟导入代理工具函数（无法直接在Node环境中导入Next.js模块）
console.log('\n🔧 测试代理URL构建逻辑：');

// 模拟代理工具函数
function getTVCorsProxyBaseURL() {
  const proxyUrl =
    process.env.TVCORS_PROXY_URL ||
    process.env.NEXT_PUBLIC_TVCORS_PROXY_URL ||
    'http://localhost:3001';
  return proxyUrl.endsWith('/') ? proxyUrl.slice(0, -1) : proxyUrl;
}

function buildProxyURL(type, params) {
  const baseURL = getTVCorsProxyBaseURL();
  const url = new URL(`${baseURL}/api/proxy/${type}`);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
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
  if (source) params['moontv-source'] = source;
  if (allowCORS !== undefined) params.allowCORS = allowCORS;
  return buildProxyURL('m3u8', params);
}

function buildLogoProxyURL(logoUrl, source) {
  const params = { url: logoUrl };
  if (source) params['moontv-source'] = source;
  return buildProxyURL('logo', params);
}

// 测试URL构建
const testCases = [
  {
    name: 'M3U8代理URL',
    url: buildM3U8ProxyURL('https://example.com/stream.m3u8', 'test-source'),
    expected: '包含m3u8代理路径和参数',
  },
  {
    name: 'Logo代理URL',
    url: buildLogoProxyURL('https://example.com/logo.png', 'test-source'),
    expected: '包含logo代理路径和参数',
  },
  {
    name: 'M3U8代理URL (带CORS)',
    url: buildM3U8ProxyURL(
      'https://example.com/stream.m3u8',
      'test-source',
      true
    ),
    expected: '包含allowCORS参数',
  },
];

testCases.forEach((testCase, index) => {
  console.log(`\n   测试 ${index + 1}: ${testCase.name}`);
  console.log(`   生成URL: ${testCase.url}`);
  console.log(`   预期: ${testCase.expected}`);

  // 验证URL格式
  try {
    new URL(testCase.url);
    console.log(`   ✅ URL格式正确`);
  } catch (e) {
    console.log(`   ❌ URL格式错误: ${e.message}`);
  }
});

// 测试tvcors-proxy服务连通性
console.log('\n🌐 测试TVCors-Proxy服务连通性：');

async function testProxyService() {
  const baseURL = getTVCorsProxyBaseURL();
  console.log(`   代理服务地址: ${baseURL}`);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    console.log('   正在连接代理服务...');
    const response = await fetch(baseURL, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      console.log('   ✅ 代理服务连接成功');
      console.log(`   状态码: ${response.status}`);
      console.log(
        `   响应头: ${response.headers.get('content-type') || '未知'}`
      );

      // 测试代理功能
      console.log('\n🧪 测试代理功能：');
      await testProxyEndpoints(baseURL);
    } else {
      console.log(
        `   ❌ 代理服务响应错误: ${response.status} ${response.statusText}`
      );
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log('   ❌ 连接超时 - 请确保tvcors-proxy服务正在运行');
    } else if (error.code === 'ECONNREFUSED') {
      console.log('   ❌ 连接被拒绝 - 请启动tvcors-proxy服务');
      console.log('   💡 启动命令: cd tvcors-proxy && npm run dev');
    } else {
      console.log(`   ❌ 连接失败: ${error.message}`);
    }
  }
}

async function testProxyEndpoints(baseURL) {
  const endpoints = [
    {
      name: 'M3U8代理',
      path: '/api/proxy/m3u8',
      params: '?url=' + encodeURIComponent('https://httpbin.org/get'),
    },
    {
      name: 'Logo代理',
      path: '/api/proxy/logo',
      params: '?url=' + encodeURIComponent('https://httpbin.org/image/png'),
    },
  ];

  for (const endpoint of endpoints) {
    try {
      console.log(`   测试 ${endpoint.name}...`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(
        `${baseURL}${endpoint.path}${endpoint.params}`,
        {
          method: 'GET',
          signal: controller.signal,
        }
      );

      clearTimeout(timeoutId);

      if (response.ok) {
        console.log(`   ✅ ${endpoint.name} 工作正常 (${response.status})`);

        // 检查CORS头
        const corsHeaders = [
          'access-control-allow-origin',
          'access-control-allow-methods',
          'access-control-allow-headers',
        ];

        const hasCors = corsHeaders.some((header) =>
          response.headers.has(header)
        );
        if (hasCors) {
          console.log(`   ✅ CORS头设置正确`);
        } else {
          console.log(`   ⚠️  未检测到CORS头`);
        }
      } else {
        console.log(`   ❌ ${endpoint.name} 响应错误: ${response.status}`);
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log(`   ⏰ ${endpoint.name} 测试超时`);
      } else {
        console.log(`   ❌ ${endpoint.name} 测试失败: ${error.message}`);
      }
    }
  }
}

// 运行测试
console.log('\n🚀 开始集成测试...');
testProxyService()
  .then(() => {
    console.log('\n📋 集成测试完成!');
    console.log('\n📝 使用说明:');
    console.log(
      '   1. 确保tvcors-proxy服务正在运行: cd tvcors-proxy && npm run dev'
    );
    console.log('   2. 在LunaTV项目中创建.env.local文件');
    console.log(
      '   3. 在.env.local中设置: TVCORS_PROXY_URL=http://localhost:3001'
    );
    console.log('   4. 启动LunaTV: npm run dev');
    console.log('   5. 访问直播页面测试代理功能');
  })
  .catch((error) => {
    console.error('\n💥 集成测试出现错误:', error);
  });
