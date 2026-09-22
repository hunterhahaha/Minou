/** 把 TypeScript 编译不会处理的固定 Renderer 资源复制到 dist。 */

import { cp, mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const source = resolve(repositoryRoot, "src", "renderer", "index.html")
const destination = resolve(repositoryRoot, "dist", "src", "renderer", "index.html")

await mkdir(dirname(destination), { recursive: true })
await cp(source, destination)
