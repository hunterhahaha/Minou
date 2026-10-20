/** Skill preload 的固定 channel、参数及返回快照校验。 */
import assert from "node:assert/strict"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createSessionApi, SKILL_IPC_CHANNELS } from "../../src/preload/session-api.ts"
import type { SkillTarget } from "../../src/preload/session-api.ts"

/** @returns 两个接口的传输契约与错误数据拒绝验证完成。 @throws AssertionError 行为不符。 */
async function main(): Promise<void> {
  const target: SkillTarget = { scope: "global" }
  const entry = { name: "review", path: join(tmpdir(), "review"), scope: "global", enabled: false }
  let response: unknown = [{ ...entry, description: "完整描述" }]
  const calls: unknown[][] = []
  const api = createSessionApi({ invoke: async (...args) => { calls.push(args); return response } })
  assert.ok(Object.isFrozen(api))
  assert.deepEqual(await api.listSkills(target), response)
  response = entry
  assert.deepEqual(await api.setSkillEnabled(target, "review", false), entry)
  assert.deepEqual(calls, [[SKILL_IPC_CHANNELS.listSkills, target], [SKILL_IPC_CHANNELS.setSkillEnabled, target, "review", false]])
  for (const invalid of [null, {}, [null], [entry], [{ ...entry, description: 1 }],
    [{ ...entry, description: "x", descriptionError: "error" }], [{ ...entry, descriptionError: "" }],
    [{ ...entry, description: "x", scope: "project" }], [{ ...entry, description: "x", path: "relative" }],
    [{ ...entry, description: "x", enabled: "false" }], [{ ...entry, description: "x", name: "../review" }],
    [{ ...entry, description: "x" }, { ...entry, description: "y" }]]) {
    response = invalid
    await assert.rejects(api.listSkills(target), TypeError)
  }
  response = [{ ...entry, descriptionError: "SKILL.md 无法读取" }]
  assert.equal((await api.listSkills(target))[0].descriptionError, "SKILL.md 无法读取")
  response = []
  assert.deepEqual(await api.listSkills(target), [])
  for (const invalid of [null, { ...entry, name: "other" }, { ...entry, enabled: true }, { ...entry, scope: "project" }]) {
    response = invalid
    await assert.rejects(api.setSkillEnabled(target, "review", false), TypeError)
  }
  console.log("skill-api: 固定 channel、参数、空列表、描述错误与非法返回值拒绝通过")
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
