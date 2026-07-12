import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export type ToolResolver = (bin: string) => string | null

export function createToolResolver(rootPath: string, env: NodeJS.ProcessEnv = process.env): ToolResolver {
  return (bin: string): string | null => {
    const local = join(rootPath, 'node_modules', '.bin', bin)
    if (existsSync(local)) return local
    for (const dir of (env.PATH ?? '').split(delimiter)) {
      if (dir === '') continue
      const candidate = join(dir, bin)
      if (existsSync(candidate)) return candidate
    }
    return null
  }
}
