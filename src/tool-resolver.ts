import { existsSync } from 'node:fs'
import { delimiter, join, normalize, sep } from 'node:path'
import { dirChain } from './workspace.js'

export type ToolResolver = (bin: string) => string | null

export function createToolResolver(
  rootPath: string,
  env: NodeJS.ProcessEnv = process.env,
  stopDir: string | null = null,
): ToolResolver {
  const chain = dirChain(rootPath, stopDir)
  const ownBinDirs = new Set(chain.map((dir) => normalize(join(dir, 'node_modules', '.bin'))))

  /**
   * npm/npx prepend to PATH the node_modules/.bin of EVERY ancestor of the
   * shell's cwd plus the npx cache (which carries embedded copies of tools like
   * tsc). Accepting those resolves binaries from unrelated projects — the exact
   * cross-worktree leak the dirChain boundary exists to prevent. Only this
   * project's own .bin dirs (already covered by the chain) and plain PATH
   * entries (global installs) are eligible.
   */
  const isForeignProjectBin = (dir: string): boolean => {
    const normalized = normalize(dir)
    if (normalized.split(sep).includes('_npx')) return true
    return normalized.endsWith(join('node_modules', '.bin')) && !ownBinDirs.has(normalized)
  }

  return (bin: string): string | null => {
    // Workspace .bin first, then ancestors up to the repo root (hoisted installs)
    for (const dir of chain) {
      const local = join(dir, 'node_modules', '.bin', bin)
      if (existsSync(local)) return local
    }
    for (const dir of (env.PATH ?? '').split(delimiter)) {
      if (dir === '' || isForeignProjectBin(dir)) continue
      const candidate = join(dir, bin)
      if (existsSync(candidate)) return candidate
    }
    return null
  }
}
