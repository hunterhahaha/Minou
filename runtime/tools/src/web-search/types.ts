/** 搜索服务商配置、模型输入和 JMESPath 输出的数据契约。 */

/** 搜索执行及按需编辑的完整配置；可能包含凭据，不得进入页面列表缓存。 */
export interface WebSearchProviderConfig {
  /** 服务商唯一字符串 ID。 */
  id: string
  /** 预置服务商名称；不唯一，记录身份由 id 决定。 */
  name: string
  /** 当前是否启用；全库最多一个启用项。 */
  enabled: boolean
  /** 带 ${query} 占位符的完整 fetch 请求配置字符串。 */
  requestJson: string
  /** 输出 WebSearchItem[] 的 JMESPath 表达式。 */
  responseJmespath: string
}

/** 保存配置不修改启用状态；新配置默认禁用。 */
export type WebSearchProviderInput = Omit<WebSearchProviderConfig, "enabled">

/** 参数在外层请求或其中 JSON 字符串内的位置。 */
export interface WebSearchParameterTarget {
  /** 外层请求字段路径。 */
  path: string[]
  /** 字段为 JSON 字符串时的内部路径。 */
  jsonPath?: string[]
  /** 字符串字段的固定前缀；保存时添加，编辑读取时校验并移除。 */
  prefix?: string
}

/** 一个预置服务商参数的表单、校验和绑定资料。 */
export interface WebSearchProviderParameter {
  /** 表单参数身份。 */
  key: string
  /** 可访问的字段名称。 */
  label: string
  /** 字符串或正安全整数。 */
  type: "string" | "positiveInteger"
  /** 是否必须填写。 */
  required: boolean
  /** 是否使用密码输入框。 */
  secret: boolean
  /** 可选参数留空时的实际保存值。 */
  defaultValue?: string | number
  /** 整数参数的包含式上限。 */
  max?: number
  /** 参数在请求中的位置。 */
  target: WebSearchParameterTarget
}

/** 随程序提供的可序列化服务商定义，不包含用户凭据。 */
export interface WebSearchProviderDefinition {
  /** 固定服务商名称，也是目录查找键。 */
  name: string
  /** 按显示顺序排列的参数。 */
  parameters: WebSearchProviderParameter[]
  /** 合法 JSON 模板，运行时查询占位符保持原样。 */
  requestJsonTemplate: string
  /** 对应响应的 JMESPath。 */
  responseJmespath: string
}

/** 页面列表唯一缓存结构，不包含请求或凭据。 */
export type WebSearchProviderSummary = Pick<WebSearchProviderConfig, "id" | "name" | "enabled">
/** 页面保存内容；主进程管理身份，启停由独立接口处理。 */
export type WebSearchProviderSaveInput = Omit<WebSearchProviderConfig, "id" | "enabled">
/** 经参数校验的表单值；可选项缺省时可以省略。 */
export type WebSearchProviderParameterValues = Record<string, string | number>

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
  /** 摘要；执行后字符串粗估不超过 800 token，超限尾部为省略号。 */
  snippet: string | null
  /** 可选发布时间，工具不转换格式。 */
  publishedAt?: string | null
}

/** 搜索业务成功结果，仅对 JMESPath 返回条目的字符串摘要限制长度。 */
export interface WebSearchResult {
  /** 保持 JMESPath 顺序及其它字段的条目数组。 */
  results: WebSearchItem[]
}
