import type { BlackboardPostInput } from "../../../session/src/team-store.ts"

/** 已完成结构校验的通信操作；调用者身份始终由 Runtime 注入。 */
export type CommunicationInput =
  | { event: "create_session"; session_info?: string }
  | { event: "close_session"; session_id: string }
  | { event: "send_message"; session_id: string; message: string }
  | { event: "report_completion" | "request_authorization"; message: string }

/** 已完成结构校验的黑板操作。 */
export type BlackboardInput =
  | { mode: "publish"; post: BlackboardPostInput }
  | { mode: "read"; postId: number }
  | { mode: "unread" }

/** 模型结果的结构化数据，或黑板未读摘要。 */
export type TeamToolOutput = { data: object } | {
  summaries: {
    mentioned: { id: string; name: string; description: string }[]
    unread: { id: string; name: string; description: string }[]
  }
}
