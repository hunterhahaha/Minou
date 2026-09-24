/** glob 在指定绝对目录中查找文件的业务参数。 */
export interface GlobInput {
  /** ripgrep 文件模式。 */
  pattern: string
  /** 必须存在的绝对目录路径。 */
  path: string
  /** 最多返回的文件数，允许 1–500。 */
  limit?: number
}
/** glob 返回的规范路径及上限状态。 */
export interface GlobResult {
  /** 与模式匹配的规范绝对路径。 */
  files: string[]
  /** 达到数量上限且仍有结果时为 true。 */
  truncated: boolean
}
/** grep 在指定绝对路径中搜索的业务参数。 */
export interface GrepInput {
  /** 正则表达式或字面搜索文本。 */
  pattern: string
  /** 绝对文件或目录路径。 */
  path: string
  /** 可选的文件 glob 筛选。 */
  include?: string
  /** 使用字面匹配。 */
  literal?: boolean
  /** 忽略大小写。 */
  ignoreCase?: boolean
  /** 匹配行前后各返回的行数，允许 0–20。 */
  context?: number
  /** 最多返回的匹配数，允许 1–500。 */
  limit?: number
}
/** grep 匹配前后的单行文本。 */
export interface GrepContextLine {
  /** 从 1 开始的行号。 */
  line: number
  /** 原始文本内容。 */
  text: string
}
/** grep 的一个文本匹配及可选上下文。 */
export interface GrepMatch {
  /** 匹配文件的规范绝对路径。 */
  path: string
  /** 从 1 开始的匹配行号。 */
  line: number
  /** 匹配行文本。 */
  text: string
  /** 匹配行之前的上下文。 */
  before?: GrepContextLine[]
  /** 匹配行之后的上下文。 */
  after?: GrepContextLine[]
}
/** grep 返回的匹配及上限状态。 */
export interface GrepResult {
  /** 按 ripgrep 输出顺序排列的匹配。 */
  matches: GrepMatch[]
  /** 达到数量上限且仍有匹配时为 true。 */
  truncated: boolean
}
/** read 的绝对文件路径与行范围。 */
export interface ReadInput {
  /** 绝对普通文件路径。 */
  path: string
  /** 从 1 开始的起始行号。 */
  offset?: number
  /** 最多返回的行数，允许 1–2000。 */
  limit?: number
}
/** read 返回的单行。 */
export interface ReadLine {
  /** 从 1 开始的行号。 */
  number: number
  /** 最多 2000 字符的文本。 */
  text: string
}
/** read 的规范路径、内容与续读位置。 */
export interface ReadResult {
  /** 已读取文件的规范绝对路径。 */
  path: string
  /** 本次请求的起始行号。 */
  offset: number
  /** 实际读取的行。 */
  lines: ReadLine[]
  /** 达到输出限制且仍有内容时为 true。 */
  truncated: boolean
  /** 截断后可继续读取的下一行号。 */
  nextOffset?: number
}
/** write 的完整文件内容。 */
export interface WriteInput {
  /** 待创建或覆盖的绝对路径。 */
  path: string
  /** 写入整个文件的 UTF-8 文本。 */
  content: string
}
/** write 成功后的路径和写入大小。 */
export interface WriteResult {
  /** 已写入文件的规范绝对路径。 */
  path: string
  /** 本次创建还是覆盖。 */
  operation: "created" | "overwritten"
  /** 写入的 UTF-8 字节数。 */
  bytesWritten: number
}
/** edit 在已有文件内唯一替换的文本。 */
export interface EditInput {
  /** 已有普通文件的绝对路径。 */
  path: string
  /** 必须唯一出现的非空原文。 */
  oldText: string
  /** 替换后的文本，可为空。 */
  newText: string
}
/** edit 成功后的替换次数和写入大小。 */
export interface EditResult {
  /** 已修改文件的规范绝对路径。 */
  path: string
  /** 成功时恒为 1。 */
  replacements: number
  /** 文件最终内容的 UTF-8 字节数。 */
  bytesWritten: number
}
