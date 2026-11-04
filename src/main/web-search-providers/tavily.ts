/** Tavily 创建资料；只描述表单和请求模板，不发送请求。 */
import type { WebSearchProviderDefinition } from "../../../runtime/tools/src/web-search/types.ts"

/** Tavily 预置定义；结果数量留空时使用 5，最多 8。 */
export const TAVILY_PROVIDER: WebSearchProviderDefinition = {
  name: "Tavily",
  parameters: [
    { key: "APIKEY", label: "APIKEY", type: "string", required: true, secret: true,
      target: { path: ["headers", "Authorization"], prefix: "Bearer " } },
    { key: "max_results", label: "max_results", type: "positiveInteger", required: false, secret: false,
      defaultValue: 5, max: 8, target: { path: ["body"], jsonPath: ["max_results"] } },
  ],
  requestJsonTemplate: JSON.stringify({
    url: "https://api.tavily.com/search", method: "POST",
    headers: { Authorization: "Bearer APIKEY", "Content-Type": "application/json" },
    body: JSON.stringify({ query: "${query}", search_depth: "basic", max_results: "${max_results}",
      include_answer: false, include_raw_content: false, include_images: false }),
  }),
  responseJmespath: "results[].{title: title, url: url, snippet: content, publishedAt: published_date}",
}
