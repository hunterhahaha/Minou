/**
 * Provider 凭据的只读运行期存储。
 *
 * API Key 与普通 Provider / Protocol / Model 配置分离保存；启动装配在持久化结构通过
 * V1 检查后创建本 Store，Protocol Adapter 只能按 providerId 取得自己的 API Key。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 3、4、30 节
 */

/** 一个 Provider 对应的 API Key。 */
export interface ProviderCredential {
  /** Provider 配置中的稳定标识。 */
  providerId: string
  /** 只提供给对应 Protocol Adapter 的 API Key。 */
  apiKey: string
}

/**
 * 在进程内按 Provider 保存 API Key 的只读 Store。
 *
 * 构造时复制全部字符串到内部 Map；调用方之后修改原数组或条目不会改变已装载凭据。
 * Store 不暴露枚举、修改或持久化入口，避免把凭据带回普通配置数据流。
 */
export class CredentialStore {
  private readonly apiKeys = new Map<string, string>()

  /**
   * 创建只读凭据 Store。
   *
   * @param credentials 已通过持久化结构检查的 Provider 凭据。
   * @throws Error 当 providerId、apiKey 为空，或同一 Provider 重复出现时抛出；错误不包含 API Key。
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
   * 读取一个 Provider 的 API Key。
   *
   * @param providerId Provider 配置中的稳定标识。
   * @returns 已配置的 API Key；该 Provider 尚未配置凭据时返回 undefined。
   */
  getApiKey(providerId: string): string | undefined {
    return this.apiKeys.get(providerId)
  }
}
