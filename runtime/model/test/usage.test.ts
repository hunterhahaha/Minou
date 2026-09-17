/**
 * Usage 转换测试：三个协议的厂商字段 → 统一 Usage（Usage 设计文档第 2、3、4、5、9 节）。
 *
 * 不依赖测试框架；直接运行：
 *   node --experimental-strip-types runtime/model/test/usage.test.ts
 *
 * 重点验证三条容易出错的规则：
 *   - 三个输入桶互不重叠（Chat Completions / Responses 必须减去缓存桶）；
 *   - 可选缓存字段缺失表示"未报告"，不是 0；
 *   - reasoningTokens 是 outputTokens 的子集，不重复相加。
 */

import assert from "node:assert/strict"

import { promptTokens, resolveTotalTokens } from "../src/types.ts"
import {
  convertAnthropicUsage,
  convertChatCompletionsUsage,
  convertResponsesUsage,
} from "../src/usage.ts"

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. Anthropic Messages（设计文档第 2 节）
  // -------------------------------------------------------------------------

  {
    const usage = convertAnthropicUsage({
      input_tokens: 100,
      output_tokens: 40,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 50,
      output_tokens_details: { thinking_tokens: 25 },
    })

    // 该协议的四个字段本身互不重叠，input_tokens 直接就是未缓存输入。
    assert.equal(usage.inputTokens, 100)
    assert.equal(usage.outputTokens, 40)
    assert.equal(usage.cacheReadTokens, 900)
    assert.equal(usage.cacheWriteTokens, 50)
    assert.equal(usage.reasoningTokens, 25)

    // 完整 Prompt = 三个输入桶之和（第 6.1 节）。
    assert.equal(promptTokens(usage), 1050)
    // 该协议不返回 total_tokens，由 Prompt + Output 派生。
    assert.equal(usage.totalTokens, undefined)
    assert.equal(resolveTotalTokens(usage), 1090)
  }

  // 缺缓存字段 → 未报告（undefined），不是 0。
  {
    const usage = convertAnthropicUsage({ input_tokens: 100, output_tokens: 10 })
    assert.equal(usage.cacheReadTokens, undefined, "缺失的缓存字段必须是 undefined")
    assert.equal(usage.cacheWriteTokens, undefined)
    assert.equal(usage.reasoningTokens, undefined)
    assert.equal(promptTokens(usage), undefined, "缓存桶未知时无法确定完整 Prompt")
  }

  // 明确为 0 与缺失要保留区别。
  {
    const usage = convertAnthropicUsage({
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
    assert.equal(usage.cacheReadTokens, 0, "明确的 0 必须保留")
    assert.equal(usage.cacheWriteTokens, 0)
    assert.equal(promptTokens(usage), 100)
  }

  // null 与缺字段同样按未报告处理（SDK 把可缺省字段标成 null）。
  {
    const usage = convertAnthropicUsage({
      input_tokens: 7,
      output_tokens: 3,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    })
    assert.equal(usage.cacheReadTokens, undefined)
    assert.equal(usage.cacheWriteTokens, undefined)
  }

  // -------------------------------------------------------------------------
  // 2. Chat Completions（设计文档第 3 节）
  // -------------------------------------------------------------------------

  {
    const usage = convertChatCompletionsUsage({
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 },
      completion_tokens_details: { reasoning_tokens: 64 },
    })

    // prompt_tokens 是完整输入，必须减去缓存读取与缓存写入。
    assert.equal(usage.inputTokens, 100, "inputTokens 必须是未缓存输入")
    assert.equal(usage.outputTokens, 200)
    assert.equal(usage.cacheReadTokens, 800)
    assert.equal(usage.cacheWriteTokens, 100)
    assert.equal(usage.reasoningTokens, 64)
    assert.equal(usage.totalTokens, 1200)

    // 不变式：未缓存 + 缓存读取 + 缓存写入 = 完整 Prompt。
    assert.equal(usage.inputTokens + 800 + 100, 1000)
    assert.equal(promptTokens(usage), 1000)
  }

  // 兼容厂商把命中数放在 prompt_cache_hit_tokens（第 3.1 节）。
  {
    const usage = convertChatCompletionsUsage({
      prompt_tokens: 500,
      completion_tokens: 50,
      prompt_cache_hit_tokens: 300,
    })
    assert.equal(usage.cacheReadTokens, 300)
    assert.equal(usage.inputTokens, 200)
  }

  // 兼容厂商把命中数放在顶层 cached_tokens。
  {
    const usage = convertChatCompletionsUsage({
      prompt_tokens: 500,
      completion_tokens: 50,
      cached_tokens: 200,
    })
    assert.equal(usage.cacheReadTokens, 200)
    assert.equal(usage.inputTokens, 300)
  }

  // 标准字段优先于兼容字段。
  {
    const usage = convertChatCompletionsUsage({
      prompt_tokens: 500,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 400 },
      prompt_cache_hit_tokens: 100,
      cached_tokens: 100,
    })
    assert.equal(usage.cacheReadTokens, 400, "prompt_tokens_details.cached_tokens 优先")
  }

  // 没有缓存写入字段时不推算（第 3.2 节），只减缓存读取部分。
  {
    const usage = convertChatCompletionsUsage({
      prompt_tokens: 500,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 300 },
    })
    assert.equal(usage.cacheWriteTokens, undefined, "不得自行推算缓存写入")
    assert.equal(usage.inputTokens, 200)
    assert.equal(resolveTotalTokens(usage), 550, "缺 total_tokens 时由 Prompt + Output 派生")
  }

  // 缺 total_tokens 且缺 prompt_tokens → 不构造总量。
  {
    const usage = convertChatCompletionsUsage({ completion_tokens: 5 })
    assert.equal(usage.totalTokens, undefined)
    assert.equal(usage.inputTokens, 0)
  }

  // -------------------------------------------------------------------------
  // 3. Responses（设计文档第 4 节）
  // -------------------------------------------------------------------------

  {
    const usage = convertResponsesUsage({
      input_tokens: 900,
      output_tokens: 150,
      total_tokens: 1050,
      input_tokens_details: { cached_tokens: 700, cache_write_tokens: 100 },
      output_tokens_details: { reasoning_tokens: 50 },
    })

    assert.equal(usage.inputTokens, 100)
    assert.equal(usage.outputTokens, 150)
    assert.equal(usage.cacheReadTokens, 700)
    assert.equal(usage.cacheWriteTokens, 100)
    assert.equal(usage.reasoningTokens, 50)
    assert.equal(usage.totalTokens, 1050)
    assert.equal(promptTokens(usage), 900)
  }

  // 缺缓存写入字段：只减缓存读取，且不推算。
  {
    const usage = convertResponsesUsage({
      input_tokens: 900,
      output_tokens: 150,
      total_tokens: 1050,
      input_tokens_details: { cached_tokens: 700 },
    })
    assert.equal(usage.cacheWriteTokens, undefined)
    assert.equal(usage.inputTokens, 200)
    // totalTokens 可信时仍能推出完整 Prompt（第 6.1 节第 2 条）。
    assert.equal(promptTokens(usage), 900)
  }

  // 厂商数字自相矛盾（缓存大于完整输入）时未缓存输入按 0 处理，不出现负数。
  {
    const usage = convertResponsesUsage({
      input_tokens: 100,
      output_tokens: 10,
      input_tokens_details: { cached_tokens: 500 },
    })
    assert.equal(usage.inputTokens, 0)
  }

  console.log("usage.test.ts: Usage 转换断言通过")
}

// 不用顶层 await：测试运行时被 Node 当作 ESM，但 tsc 按 CommonJS 检查。
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
