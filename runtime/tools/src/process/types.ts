/** Shell 与 PTY 共用的单次输出结果。 */
export interface ProcessOutputResult {
  /** 完整输出或不超过 64 KB 的 UTF-8 尾部。 */
  output: string
  /** 是否已将完整大输出保存到文件。 */
  truncated: boolean
  /** 未截断的原始 UTF-8 字节数。 */
  totalBytes: number
  /** 大输出日志的绝对路径；小输出不创建文件。 */
  fullOutputPath?: string
}
