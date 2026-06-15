/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

/**
 * 安全解析 JSON 响应，防止 API 返回 HTML 等非JSON内容时崩溃
 * 短剧源API经常会返回HTML错误页面（如 Cloudflare 拦截、服务器维护等）
 */
export async function safeJsonParse(response: Response): Promise<any> {
  try {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return await response.json();
    }
    // 非 JSON 响应，读取文本判断
    const text = await response.text();
    if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
      return JSON.parse(text);
    }
    console.log(`⚠️ API返回非JSON响应 (content-type: ${contentType}): ${text.substring(0, 200)}`);
    return null;
  } catch (error) {
    console.error('❌ JSON解析失败:', error);
    return null;
  }
}
