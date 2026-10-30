/**
 * Provider 凭据的运行期内存快照与只读查找接口。
 *
 * 模型装配层从 Provider 数据库读取凭据后创建 CredentialStore，
 * 按 Provider ID 取出 API Key，再将其传给模型 Adapter 的客户端参数。
 * 本模块不访问数据库、环境变量或网络，也不负责持久化与访问权限控制。
 */

/** 供 Store 构造时装载的单个 Provider 凭据；两个字段均须为非空白字符串。 */
export interface ProviderCredential {
  /** Provider 的稳定标识；按原始字符串作为查找键，不裁剪首尾空白。 */
  providerId: string
  /** 对应 Provider 的 API Key；校验后保留原始字符串，不裁剪首尾空白。 */
  apiKey: string
}

/**
 * 在进程内按 Provider 保存 API Key 的只读 Store。
 *
 * 构造时复制全部字符串到内部 Map；调用方之后修改原数组或条目不会改变已装载凭据。
 * Store 不提供枚举、修改或持久化的公开接口；查找仅按 Provider ID 精确匹配，
 * 不检查调用方身份或执行授权。空数组可构造为空 Store。
 */
export class CredentialStore {
  /** 构造时装载的 Provider ID 到 API Key 映射，不保留调用方的条目或数组引用。 */
  private readonly apiKeys = new Map<string, string>()

  /**
   * 校验凭据并将其原始字符串复制到实例内存；不修改输入或写入持久化存储。
   *
   * @param credentials 符合 ProviderCredential 类型的凭据数组；允许为空，每个 Provider ID 只能出现一次。
   * @throws Error providerId 或 apiKey 为空白，或原始 Provider ID 重复时抛出；
   * 校验错误不输出 API Key，调用方应中止使用本次构造结果并处理配置错误。
   */
  constructor(credentials: readonly ProviderCredential[]) {
    for (const credential of credentials) {
      if (credential.providerId.trim() === "") {
        throw new Error("CredentialStore 的 providerId 不能为空。")
      }
      if (credential.apiKey.trim() === "") {
        throw new Error(`CredentialStore 的 API Key 不能为空：${credential.providerId}`)
      }
      if (this.apiKeys.has(credential.providerId)) {
        throw new Error(`CredentialStore 的 providerId 重复：${credential.providerId}`)
      }
      this.apiKeys.set(credential.providerId, credential.apiKey)
    }
  }

  /**
   * 从已装载的内存快照中读取 API Key，不重新加载数据库或规范化查询键。
   *
   * @param providerId 构造时提供的 Provider ID，必须与原始字符串精确匹配。
   * @returns 匹配条目的原始 API Key；当前 Store 未装载该 Provider 时返回 undefined。
   */
  getApiKey(providerId: string): string | undefined {
    return this.apiKeys.get(providerId)
  }
}
