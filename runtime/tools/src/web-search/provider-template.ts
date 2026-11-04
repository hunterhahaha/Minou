/** 浏览器和主进程共用的参数绑定；不访问数据库或网络。 */
import type { WebSearchProviderDefinition, WebSearchProviderParameter, WebSearchProviderParameterValues, WebSearchProviderSaveInput } from "./types.ts"

/**
 * 找到已有对象路径的末级字段，不创建路径，不允许原型属性。
 * @param value 已解析 JSON。
 * @param path 预置定义提供的字段路径。
 * @returns 可读写的末级对象和字段名。
 * @throws Error 路径不存在或不是普通对象字段。
 */
function targetAt(value: unknown, path: string[]): { object: Record<string, unknown>; key: string } {
  if (!path.length) throw new Error("搜索参数路径无效。")
  let current = value
  for (const [index, key] of path.entries()) {
    if (current === null || typeof current !== "object" || Array.isArray(current) ||
        ["__proto__", "prototype", "constructor"].includes(key) || !Object.hasOwn(current, key)) throw new Error("搜索参数路径无效。")
    if (index === path.length - 1) return { object: current as Record<string, unknown>, key }
    current = (current as Record<string, unknown>)[key]
  }
  throw new Error("搜索参数路径无效。")
}

/**
 * 校验参数，表单整数文本在此转换为数字；错误不包含参数值。
 * @param field 参数约束。
 * @param raw 表单或已保存请求中的值。
 * @returns 有效参数值；无默认值的可选空参数为 undefined。
 * @throws Error 必填参数、类型或数值范围无效。
 */
function parameterValue(field: WebSearchProviderParameter, raw: unknown): string | number | undefined {
  const empty = raw === undefined || (typeof raw === "string" && raw.trim() === "")
  const value = empty && !field.required ? field.defaultValue : raw
  if (value === undefined && !field.required) return undefined
  if (field.type === "string" && typeof value === "string" && (!field.required || value.trim() !== "")) return value
  if (field.type === "positiveInteger") {
    const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value
    if (typeof number === "number" && Number.isSafeInteger(number) && number > 0 && (field.max === undefined || number <= field.max)) return number
  }
  throw new Error(`${field.label} ${field.type === "string" ? "必须填写。" : `必须为正整数${field.max === undefined ? "" : `，且不超过 ${field.max}`}。`}`)
}

/**
 * 从最终请求读取参数，校验并移除固定前缀；仅返回声明的参数，不泄露原文到异常。
 * @param definition 所属服务商定义。
 * @param requestJson 已保存的完整请求。
 * @returns 用于编辑的独立参数值。
 * @throws Error 请求 JSON、字段路径或参数无效。
 */
export function readWebSearchProviderParameters(definition: WebSearchProviderDefinition, requestJson: string): WebSearchProviderParameterValues {
  let request: unknown
  try { request = JSON.parse(requestJson) } catch { throw new Error("搜索请求配置必须是合法 JSON。") }
  const values: WebSearchProviderParameterValues = {}
  for (const field of definition.parameters) {
    const outer = targetAt(request, field.target.path)
    let value = outer.object[outer.key]
    if (field.target.jsonPath) {
      try { value = JSON.parse(value as string) } catch { throw new Error("搜索请求内层 JSON 无效。") }
      const inner = targetAt(value, field.target.jsonPath)
      value = inner.object[inner.key]
    }
    if (field.target.prefix !== undefined) {
      if (field.type !== "string" || typeof value !== "string" || !value.startsWith(field.target.prefix)) throw new Error("搜索参数固定前缀无效。")
      value = value.slice(field.target.prefix.length)
    }
    if (field.type === "positiveInteger" && typeof value !== "number") throw new Error(`${field.label} 必须保存为数值。`)
    const checked = parameterValue(field, value)
    if (checked !== undefined) values[field.key] = checked
  }
  return values
}

/**
 * 将表单参数按位置填入模板，字符串按定义添加固定前缀，内层 JSON 单独编码，保留查询占位符。
 * @param definition 所选预置定义。
 * @param values 表单参数；可选项留空使用定义中的默认值。
 * @returns 可直接提交 IPC 的最终配置，不包含身份或启用状态。
 * @throws Error 参数或预置模板无效；错误不包含凭据。
 */
export function buildWebSearchProviderInput(definition: WebSearchProviderDefinition, values: WebSearchProviderParameterValues): WebSearchProviderSaveInput {
  let request: unknown
  try { request = JSON.parse(definition.requestJsonTemplate) } catch { throw new Error("搜索服务商模板 JSON 无效。") }
  for (const field of definition.parameters) {
    let value = parameterValue(field, values[field.key])
    if (field.target.prefix !== undefined) {
      if (field.type !== "string") throw new Error("搜索参数固定前缀仅适用于字符串。")
      if (value !== undefined) value = field.target.prefix + value
    }
    const outer = targetAt(request, field.target.path)
    if (field.target.jsonPath) {
      let body: unknown
      try { body = JSON.parse(outer.object[outer.key] as string) } catch { throw new Error("搜索服务商模板内层 JSON 无效。") }
      const inner = targetAt(body, field.target.jsonPath)
      if (value === undefined) delete inner.object[inner.key]
      else inner.object[inner.key] = value
      outer.object[outer.key] = JSON.stringify(body)
    } else if (value === undefined) delete outer.object[outer.key]
    else outer.object[outer.key] = value
  }
  return { name: definition.name, requestJson: JSON.stringify(request), responseJmespath: definition.responseJmespath }
}
