/**
 * 对只用于本地 Skill / MCP 预算的文本执行稳定粗估。
 *
 * 权威模型 Usage 仍只来自 Provider 响应；本函数不会参与 Agent 请求的 Usage 记账或压缩触发。
 */

/**
 * 按平均四个 JavaScript 字符约一个 Token 估算文本开销。
 *
 * @param text 需要参与本地预算的文本。
 * @returns 非负安全整数；空文本返回 0。
 */
export function estimateLocalTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
