/** Exa 创建资料；接口契约见 https://exa.ai/docs/reference/search 。 */
import type { WebSearchProviderDefinition } from "../../../runtime/tools/src/web-search/types.ts"

/** Exa 自动搜索并返回网页摘录；结果数量留空时使用 5，最多 100。 */
export const EXA_PROVIDER: WebSearchProviderDefinition = {
  name: "Exa",
  parameters: [
    { key: "APIKEY", label: "APIKEY", type: "string", required: true, secret: true,
      target: { path: ["headers", "x-api-key"] } },
    { key: "numResults", label: "numResults", type: "positiveInteger", required: false, secret: false,
      defaultValue: 5, max: 100, target: { path: ["body"], jsonPath: ["numResults"] } },
  ],
  requestJsonTemplate: JSON.stringify({
    url: "https://api.exa.ai/search", method: "POST",
    headers: { "x-api-key": "APIKEY", "Content-Type": "application/json" },
    body: JSON.stringify({ query: "${query}", type: "auto", numResults: "${numResults}", contents: { highlights: true } }),
  }),
  responseJmespath: "results[].{title: title, url: url, snippet: join('\n', highlights || `[]`), publishedAt: publishedDate}",
}
