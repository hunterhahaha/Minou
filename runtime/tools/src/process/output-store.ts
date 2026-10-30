import { closeSync, linkSync, lstatSync, openSync, unlinkSync, writeSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { isAbsolute, join } from "node:path"
import type { ProcessOutputResult } from "./types.ts"

/** 原始字节上限，不按 JavaScript 字符数计算。 */
export const PROCESS_OUTPUT_LIMIT = 64 * 1024

/**
 * 一个命令或 PTY 未读输出批次。超限后增量写入内部临时日志，成功时独占发布。
 * 同步写入避免积累无界异步写队列；后续批次使用新实例。
 */
export class ToolOutputStore {
  private readonly directory: string
  private tail: Buffer = Buffer.alloc(0)
  private bytes = 0
  private fd: number | undefined
  private pendingPath: string | undefined
  private closed = false

  /**
   * 绑定已存在的工具输出目录，不创建目录或日志文件。
   * @param directory - Session 初始化时创建的 tool_output 绝对目录。
   * @throws Error - 路径不是绝对目录、目录不存在或目录检查失败；调用方负责转换为工具错误。
   */
  constructor(directory: string) {
    if (!isAbsolute(directory) || !lstatSync(directory).isDirectory()) throw new Error("工具输出目录不可用：" + directory)
    this.directory = directory
  }
  /**
   * 读取本批次已成功收集的数据总量，不按截断尾部的大小计算。
   *
   * @returns 已收集输出的原始字节数。
   */
  get totalBytes(): number { return this.bytes }

  /**
   * 按接收顺序收集输出块。首次超过 64 KB 时写出之前的完整缓冲并开始增量落盘，内存只保留最后 64 KB。
   * @param data - 当前收到的原始字节或按 UTF-8 编码的字符串。
   * @throws Error - 批次已结束或磁盘操作失败；调用方必须返回工具错误并处理批次资源。
   */
  append(data: Buffer | string): void {
    if (this.closed) throw new Error("输出批次已经结束")
    const chunk = typeof data === "string" ? Buffer.from(data, "utf8") : data
    if (chunk.length === 0) return
    if (this.fd === undefined && this.bytes + chunk.length > PROCESS_OUTPUT_LIMIT) {
      this.pendingPath = join(this.directory, `.pending_${randomUUID()}.log`)
      this.fd = openSync(this.pendingPath, "wx", 0o600)
      this.write(this.tail)
    }
    if (this.fd !== undefined) this.write(chunk)
    this.bytes += chunk.length
    this.tail = chunk.length >= PROCESS_OUTPUT_LIMIT ? Buffer.from(chunk.subarray(chunk.length - PROCESS_OUTPUT_LIMIT))
      : Buffer.from(Buffer.concat([this.tail, chunk]).subarray(-PROCESS_OUTPUT_LIMIT))
  }

  /**
   * 结束输出批次，将大输出临时文件发布为本次调用日志，不覆盖既有日志。对完整 UTF-8 文本，跳过截断起点的续字节以避免从字符中间开始解码。
   * @param toolCallId - 日志文件名使用的工具调用 ID，不得为空或包含路径分隔符、Windows 非法字符。
   * @returns 完整小输出，或尾部、原始总字节数和完整日志绝对路径；成功后不能继续追加。
   * @throws Error - 批次已结束、调用 ID 无效、日志重名或磁盘操作失败；调用方负责返回工具错误并清理资源。
   */
  finish(toolCallId: string): ProcessOutputResult {
    if (this.closed) throw new Error("输出批次已经结束")
    if (!toolCallId || /[<>:"/\\|?*\x00-\x1f]/.test(toolCallId)) throw new Error("工具调用 ID 不能用于输出日志文件名")
    let fullOutputPath: string | undefined
    if (this.fd !== undefined) { closeSync(this.fd); this.fd = undefined }
    if (this.pendingPath !== undefined) {
      fullOutputPath = join(this.directory, `call_${toolCallId}.log`)
      linkSync(this.pendingPath, fullOutputPath)
      unlinkSync(this.pendingPath)
      this.pendingPath = undefined
    }
    this.closed = true
    let offset = 0
    if (this.bytes > PROCESS_OUTPUT_LIMIT) while (offset < this.tail.length && (this.tail[offset] & 0xc0) === 0x80) offset++
    return { output: this.tail.subarray(offset).toString("utf8"), truncated: this.bytes > PROCESS_OUTPUT_LIMIT, totalBytes: this.bytes,
      ...(fullOutputPath === undefined ? {} : { fullOutputPath }) }
  }

  /**
   * 关闭未交付批次的文件句柄，删除内部临时日志并释放内存缓冲；已发布的正式日志不会被删除。
   * @throws Error - 文件句柄关闭或临时日志删除失败；调用方负责报告清理异常。
   */
  discard(): void {
    if (this.fd !== undefined) { closeSync(this.fd); this.fd = undefined }
    if (this.pendingPath !== undefined) { unlinkSync(this.pendingPath); this.pendingPath = undefined }
    this.closed = true
    this.tail = Buffer.alloc(0)
  }
  /**
   * 将一块字节完整写入当前日志句柄，处理单次写入未覆盖整块数据的情况。
   * @param data - 需要写入日志的原始字节。
   * @throws Error - 写入失败或返回零字节而无法继续；上层收集操作负责处理异常。
   */
  private write(data: Buffer): void {
    let offset = 0
    while (offset < data.length) {
      const written = writeSync(this.fd!, data, offset, data.length - offset)
      if (written === 0) throw new Error("工具输出写入没有进展")
      offset += written
    }
  }
}
