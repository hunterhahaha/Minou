/** 博查创建资料；官方接口参考见 https://github.com/bocha-ai/dsh-web-search-bocha 。 */
import type { WebSearchProviderDefinition } from "../../../runtime/tools/src/web-search/types.ts"

/** 博查网页搜索及长摘要；用户只填写 Key，参数绑定自动添加 Bearer 前缀。 */
export const BOCHA_PROVIDER: WebSearchProviderDefinition = {
  name: "Bocha",
  parameters: [
    { key: "APIKEY", label: "APIKEY", type: "string", required: true, secret: true,
      target: { path: ["headers", "Authorization"], prefix: "Bearer " } },
    { key: "count", label: "count", type: "positiveInteger", required: false, secret: false,
      defaultValue: 5, max: 50, target: { path: ["body"], jsonPath: ["count"] } },
  ],
  requestJsonTemplate: JSON.stringify({
    url: "https://api.bocha.cn/v1/web-search", method: "POST",
    headers: { Authorization: "Bearer APIKEY", "Content-Type": "application/json" },
    body: JSON.stringify({ query: "${query}", freshness: "noLimit", summary: true, count: "${count}" }),
  }),
  responseJmespath: "data.webPages.value[].{title: name, url: url, snippet: summary || snippet, publishedAt: datePublished}",
}
