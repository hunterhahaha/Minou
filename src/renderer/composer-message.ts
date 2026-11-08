import type { JSONContent } from "@tiptap/core"
import type { FileReference, MessageFileReference, UserMessageContent } from "../../runtime/session/src/events.ts"

/** 空草稿的 Tiptap 文档。 */
export const emptyComposerDocument: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }

/**
 * 按文档顺序展开段落、换行与文件节点，记录每个文件路径在正文中的位置。
 * @param document 当前 Composer 的 Tiptap JSON，缺省表示空草稿。
 * @returns 单个模型文本块及可选的引用位置；普通文本中的 @ 原样保留。
 */
export function serializeComposerMessage(document: JSONContent = emptyComposerDocument): UserMessageContent {
  const fileReferences: MessageFileReference[] = []
  let text = ""
  for (const [index, paragraph] of (document.content ?? []).entries()) {
    if (index > 0) text += "\n"
    for (const node of paragraph.content ?? []) {
      if (node.type === "text") text += node.text ?? ""
      else if (node.type === "hardBreak") text += "\n"
      else if (node.type === "fileReference") {
        const reference = node.attrs as FileReference
        fileReferences.push({ ...reference, offset: text.length })
        text += reference.absolutePath
      }
    }
  }
  return { content: [{ type: "text", text }], ...(fileReferences.length && { fileReferences }) }
}
