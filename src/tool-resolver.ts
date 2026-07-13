import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { dirChain } from './workspace.js'

export type ToolResolver = (bin: string) => string | null

export function createToolResolver(
  rootPath: string,
  env: NodeJS.ProcessEnv = process.env,
  stopDir: string | null = null,
): ToolResolver {
  return (bin: string): string | null => {
    // Workspace .bin first, then ancestors up to the repo root (hoisted installs)
    for (const dir of dirChain(rootPath, stopDir)) {
      const local = join(dir, 'node_modules', '.bin', bin)
      if (existsSync(local)) return local
    }
    for (const dir of (env.PATH ?? '').split(delimiter)) {
      if (dir === '') continue
      const candidate = join(dir, bin)
      if (existsSync(candidate)) return candidate
    }
    return null
  }
}
