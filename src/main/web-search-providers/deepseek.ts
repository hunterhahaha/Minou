/** DeepSeek Search 创建资料；接口契约见 https://api-docs.deepseek.com/api/search/ 。 */
import type { WebSearchProviderDefinition } from "../../../runtime/tools/src/web-search/types.ts"

/** DeepSeek 独立搜索接口；用户只填写 Key，参数绑定自动添加 Bearer 前缀。 */
export const DEEPSEEK_PROVIDER: WebSearchProviderDefinition = {
  name: "DeepSeek Search",
  parameters: [
    { key: "APIKEY", label: "APIKEY", type: "string", required: true, secret: true,
      target: { path: ["headers", "Authorization"], prefix: "Bearer " } },
    { key: "count", label: "count", type: "positiveInteger", required: false, secret: false,
      defaultValue: 5, max: 50, target: { path: ["body"], jsonPath: ["count"] } },
  ],
  requestJsonTemplate: JSON.stringify({
    url: "https://api.deepseek.com/v1/tools/search", method: "POST",
    headers: { Authorization: "Bearer APIKEY", "Content-Type": "application/json" },
    body: JSON.stringify({ query: "${query}", count: "${count}", need_content: false }),
  }),
  responseJmespath: "results[].{title: title, url: url, snippet: summary || snippet, publishedAt: date}",
}
