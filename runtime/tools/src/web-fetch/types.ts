/** 网页抓取的模型输入与后端业务结果，不新增事件或 IPC 数据契约。 */

/** 模型提供的唯一业务参数。 */
export interface WebFetchInput {
  /** 待获取的绝对 HTTP/HTTPS URL。 */
  url: string
}

/** 完整读取并按响应类型处理后的成功结果。 */
export interface WebFetchResult {
  /** HTML 转换得到的 Markdown，或原样返回的文本/Markdown。 */
  text: string
}
