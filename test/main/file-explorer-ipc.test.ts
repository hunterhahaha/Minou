/** 验证只读文件查看器授权、路径与读取预算。 */
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, mkdir, realpath, rm, symlink, truncate, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { registerFileExplorerIpc, validateMessageFileReferences } from "../../src/main/file-explorer-ipc.ts"
import { initializeWorkspaceDatabase, insertProjectWorkspace, readProjectWorkspace, saveProjectWorkspace } from "../../src/main/workspace-store.ts"
import { FILE_EXPLORER_CHANNELS as channels, type FileExplorerRoot } from "../../src/preload/browser-api.ts"

/** 使用真实临时目录及数据库，模拟两个窗口的请求与项目关联变更。 */
async function main(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), "minou-file-explorer-"))
  try {
    const workspace = join(temp, "workspace")
    const folder = join(workspace, "空 格")
    const outside = join(temp, "workspace-outside")
    const second = join(temp, "second")
    await mkdir(folder, { recursive: true })
    await mkdir(outside)
    await mkdir(second)
    await writeFile(join(outside, "secret.txt"), "outside")
    await symlink(outside, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir")
    await symlink(folder, join(workspace, "alias"), process.platform === "win32" ? "junction" : "dir")
    await writeFile(join(folder, "read.txt"), "Minou 文件")
    await writeFile(join(workspace, "binary.dat"), new Uint8Array([0, 255]))
    await writeFile(join(workspace, "icon.PNG"), new Uint8Array([1, 2, 3]))
    const limits = [["large.txt", 1], ["large.png", 16], ["large.pdf", 32]] as const
    for (const [name, limit] of limits) {
      const path = join(workspace, name)
      await writeFile(path, "")
      await truncate(path, limit * 1024 * 1024 + 1)
    }

    const database = join(temp, "workspace.sqlite")
    initializeWorkspaceDatabase(database)
    const projectId = "9d5544a0-2ecb-45c0-9f55-998cc6a7563d"
    insertProjectWorkspace(database, {
      version: 1, id: projectId, name: "Test", updatedAt: new Date().toISOString(), directories: [workspace, second], sessions: [],
    })

    const sender = new EventEmitter()
    const other = new EventEmitter()
    const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>()
    registerFileExplorerIpc({ handle: (channel, listener) => { handlers.set(channel, listener) } }, database)

    /** 调用指定窗口的 handler。 @param channel 测试通道。 @param args 请求参数。 @returns handler 结果。 */
    const invoke = async (channel: string, ...args: unknown[]) =>
      handlers.get(channel)!({ sender } as unknown as IpcMainInvokeEvent, ...args)
    await assert.rejects(invoke(channels.open), /请提供项目及关联目录/)
    const root: FileExplorerRoot = await invoke(channels.open, { projectId, directoryPath: workspace })
    assert.equal(root.path, await realpath(workspace))
    assert.deepEqual((await invoke(channels.list, root.handle, "")).map((entry: { name: string }) => entry.name).sort(),
      ["binary.dat", "icon.PNG", "large.pdf", "large.png", "large.txt", "空 格"])
    assert.deepEqual(await invoke(channels.list, root.handle, "空 格/"), [{ name: "read.txt", kind: "file" }])
    assert.deepEqual(await invoke(channels.read, root.handle, "空 格/read.txt"),
      { size: Buffer.byteLength("Minou 文件"), kind: "text", text: "Minou 文件" })
    const [found] = await invoke(channels.search, projectId, "READ.TXT")
    assert.deepEqual(found, { projectId, directoryPath: workspace, relativePath: "空 格/read.txt", absolutePath: await realpath(join(folder, "read.txt")), name: "read.txt" })
    assert.deepEqual(await invoke(channels.search, projectId, "secret.txt"), [], "搜索不跟随越界链接")
    assert.deepEqual(await invoke(channels.search, "default", "read"), [])
    await assert.rejects(invoke(channels.read, root.handle, found.relativePath, join(outside, "secret.txt")), /绝对路径已更改/)
    const prefix = "📁 检查 "
    const message = prefix + found.absolutePath
    const reference = { ...found, offset: prefix.length }
    assert.deepEqual(await validateMessageFileReferences(database, projectId, message, [reference]), [reference])
    await assert.rejects(validateMessageFileReferences(database, projectId, message, [{ ...reference, offset: 0 }]), /正文不符/)
    await assert.rejects(validateMessageFileReferences(database, projectId, message, [reference, reference]), /正文不符/)
    await assert.rejects(validateMessageFileReferences(database, projectId, message, [{ ...reference, directoryPath: outside }]), /不属于当前项目/)
    await assert.rejects(validateMessageFileReferences(database, projectId, message, [{ ...reference, relativePath: "escape/secret.txt" }]), /链接|超出根目录/)
    assert.deepEqual(await invoke(channels.read, root.handle, "icon.PNG"),
      { size: 3, kind: "image", mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) })
    assert.deepEqual(await invoke(channels.read, root.handle, "binary.dat"),
      { size: 2, kind: "unsupported", reason: "binary" })
    for (const [name, limit] of limits) {
      assert.deepEqual(await invoke(channels.read, root.handle, name),
        { size: limit * 1024 * 1024 + 1, kind: "unsupported", reason: "size" })
    }

    for (const path of ["../workspace-outside/secret.txt", join(outside, "secret.txt"), "空 格\\read.txt", "空 格//read.txt"]) {
      await assert.rejects(invoke(channels.read, root.handle, path), /无效的文件资源路径/)
    }
    await assert.rejects(invoke(channels.read, root.handle, "escape/secret.txt"), /链接|超出根目录/)
    await assert.rejects(invoke(channels.read, root.handle, "alias/read.txt"), /链接/)
    await assert.rejects(invoke(channels.list, root.handle, "escape/"), /已更改/)
    for (const directoryPath of [outside, folder, join(workspace, "escape"), join(workspace, "alias")]) {
      await assert.rejects(invoke(channels.open, { projectId, directoryPath }), /只能打开项目关联目录/)
    }
    const secondRoot: FileExplorerRoot = await invoke(channels.open, { projectId, directoryPath: second })
    assert.equal(secondRoot.path, await realpath(second))
    await assert.rejects(async () => handlers.get(channels.list)!({ sender: other } as unknown as IpcMainInvokeEvent, root.handle, ""), /目录访问已失效/)

    await unlink(join(folder, "read.txt"))
    await assert.rejects(invoke(channels.read, root.handle, "空 格/read.txt"), /ENOENT/)
    await assert.rejects(validateMessageFileReferences(database, projectId, message, [reference]), /ENOENT/)
    const project = readProjectWorkspace(database, projectId)
    saveProjectWorkspace(database, { ...project, directories: [workspace] })
    await assert.rejects(invoke(channels.list, secondRoot.handle, ""), /取消项目关联/)
    await assert.rejects(invoke(channels.list, secondRoot.handle, ""), /目录访问已失效/)
    await invoke(channels.close, secondRoot.handle)
    sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true })
    assert.ok(await invoke(channels.list, root.handle, ""))
    sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
    await assert.rejects(invoke(channels.list, root.handle, ""), /目录访问已失效/)
    console.log("file-explorer-ipc.test.ts: grants, path boundaries, metadata and read limits passed")
  } finally {
    assert.ok(resolve(temp).startsWith(resolve(tmpdir()) + sep))
    await rm(temp, { recursive: true, force: true })
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1 })
