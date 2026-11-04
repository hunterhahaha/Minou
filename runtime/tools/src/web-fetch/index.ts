/** 网页抓取工具的公开入口与成对登记。 */
import { renderWebFetch } from "../render/web-fetch.ts"
import { isPlainRecord, registerTool } from "../tool-registry.ts"
import type { RenderRegistry, ToolArgumentValidation, ToolRegistry } from "../tool-registry.ts"
import { executeWebFetch } from "./fetch.ts"
import type { WebFetchInput } from "./types.ts"

export * from "./types.ts"
export { executeWebFetch, WEB_FETCH_TIMEOUT_MS, WEB_FETCH_MAX_BYTES } from "./fetch.ts"

/**
 * 登记只接收 URL 的抓取工具和结果整理器，不在登记时发起网络请求。
 * @param tools 宿主共享工具注册表。
 * @param renders 同名结果整理器注册表。
 * @throws Error 名称冲突或工具定义登记失败。
 */
export function registerWebFetchTool(tools: ToolRegistry, renders: RenderRegistry): void {
  registerTool(tools, renders, {
    kind: "builtin",
    definition: {
      name: "web_fetch",
      description: "Fetch an HTTP/HTTPS URL. Converts HTML to Markdown and returns plain text or Markdown unchanged. Fails after 30 seconds or when the decoded response body exceeds 5 MiB; partial content is discarded.",
      inputSchema: { type: "object", properties: { url: { type: "string", minLength: 1 } }, required: ["url"], additionalProperties: false },
    },
    validateArguments: validateInput,
    execute: (input, context) => executeWebFetch(input, context.signal),
    render: renderWebFetch,
  })
}

/**
 * 检查唯一参数为绝对 HTTP/HTTPS URL；不从模型接收请求选项。
 * @param input 模型提供的未知参数。
 * @returns 原始 URL 的业务输入，或参数错误。
 */
function validateInput(input: unknown): ToolArgumentValidation<WebFetchInput> {
  if (isPlainRecord(input) && Object.keys(input).every((key) => key === "url") && typeof input.url === "string" && input.url.trim() !== "") {
    try {
      const url = new URL(input.url)
      if (url.protocol === "http:" || url.protocol === "https:") return { success: true, data: { url: input.url } }
    } catch { /* 无效 URL 统一作为工具参数错误返回。 */ }
  }
  return { success: false, error: { source: "tool", code: "INVALID_TOOL_ARGUMENTS", message: "web_fetch 只接受一个有效的绝对 HTTP/HTTPS URL 字符串 url。" } }
}
