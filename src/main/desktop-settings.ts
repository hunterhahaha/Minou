/** 主进程保存的桌面关闭偏好。 */
import { randomUUID } from "node:crypto"
import { readFile, rename, unlink, writeFile } from "node:fs/promises"
import { isCloseBehavior, type CloseBehavior } from "../preload/window-api.ts"

/** 持有已生效的偏好，并串行持久化后续修改。 */
export class DesktopSettings {
  private savedBehavior: CloseBehavior = "tray"
  private pending: Promise<void> = Promise.resolve()

  /** @param filePath 桌面偏好文件，父目录由配置初始化创建。 */
  constructor(private readonly filePath: string) {}

  /** @returns 当前已生效的偏好，缺少有效磁盘配置时默认保留后台运行。 */
  get behavior(): CloseBehavior {
    return this.savedBehavior
  }

  /**
   * 读取偏好。首次启动使用默认值，其余读取错误记录后继续启动。
   * @returns 完成读取后的 Promise。
   */
  async load(): Promise<void> {
    try {
      const settings: unknown = JSON.parse(await readFile(this.filePath, "utf8"))
      if (settings === null || typeof settings !== "object" || !("closeBehavior" in settings)
        || !isCloseBehavior(settings.closeBehavior)) throw new Error("窗口关闭偏好无效")
      this.savedBehavior = settings.closeBehavior
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        console.error("无法读取 NiCode 桌面设置，使用默认关闭偏好。", error)
      }
    }
  }

  /**
   * 按请求顺序保存，替换文件成功后才应用新偏好。
   * @param behavior 待保存的合法关闭偏好。
   * @returns 成功落盘的偏好，写入或替换失败时 Promise 拒绝。
   */
  save(behavior: CloseBehavior): Promise<CloseBehavior> {
    const save = this.pending.then(async () => {
      const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
      try {
        await writeFile(temporaryPath, `${JSON.stringify({ closeBehavior: behavior }, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
        await rename(temporaryPath, this.filePath)
        this.savedBehavior = behavior
        return behavior
      } finally {
        await unlink(temporaryPath).catch(() => undefined)
      }
    })
    this.pending = save.then(() => undefined, () => undefined)
    return save
  }

  /** @returns 已接受的全部写入结束后的 Promise，供正常退出等待。 */
  whenIdle(): Promise<void> {
    return this.pending
  }
}
