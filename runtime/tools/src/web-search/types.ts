/** 搜索服务商配置、模型输入和 JMESPath 输出的数据契约。 */

/** 仅供后端使用的搜索服务商配置；请求字符串可能包含凭据。 */
export interface WebSearchProviderConfig {
  /** 服务商唯一字符串 ID。 */
  id: string
  /** 当前是否启用；全库最多一个启用项。 */
  enabled: boolean
  /** 带 ${query} 占位符的完整 fetch 请求配置字符串。 */
  requestJson: string
  /** 输出 WebSearchItem[] 的 JMESPath 表达式。 */
  responseJmespath: string
}

/** 保存配置不修改启用状态；新配置默认禁用。 */
export type WebSearchProviderInput = Omit<WebSearchProviderConfig, "enabled">

/** 模型提供的唯一业务参数。 */
export interface WebSearchInput {
  /** 非空白查询文本，执行时按原文替换占位符。 */
  query: string
}

/** 由服务商的 JMESPath 配置保证结构的搜索条目。 */
export interface WebSearchItem {
  /** 结果标题。 */
  title: string
  /** 结果地址。 */
  url: string
  /** 摘要。 */
  snippet: string | null
  /** 可选发布时间，工具不转换格式。 */
  publishedAt?: string | null
}

/** 搜索业务成功结果，不改变 JMESPath 返回的条目。 */
export interface WebSearchResult {
  /** JMESPath 返回的原始条目数组。 */
  results: WebSearchItem[]
}
