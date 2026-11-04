/** 网页抓取的模型输入与后端业务结果，不新增事件或 IPC 数据契约。 */

/** 模型提供的唯一业务参数。 */
export interface WebFetchInput {
  /** 待获取的绝对 HTTP/HTTPS URL。 */
  url: string
}

/** 完整读取并处理的文本；超限结果携带已成功保存的全文元数据。 */
export type WebFetchResult = {
  /** HTML 转换或原始文本的完整内容，超限时为 UTF-8 至多 32 KiB 的开头。 */
  text: string
} & ({
  /** 小文本未发生截断。 */
  truncated?: false
} | {
  /** 正文已截断，完整内容已落盘。 */
  truncated: true
  /** 完整处理文本的 UTF-8 字节数。 */
  totalBytes: number
  /** 当前会话或 CLI 运行 tool_output 下的全文绝对路径。 */
  fullOutputPath: string
})
