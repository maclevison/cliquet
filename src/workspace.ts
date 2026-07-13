import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Directory containing .git (dir or file — worktrees) at or above start; null = not in a git repo. */
export function findRepoRoot(start: string): string | null {
  let dir = start
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** [start, parent, ..., stopDir]. stopDir null or not an ancestor-or-self of start → [start]. */
export function dirChain(start: string, stopDir: string | null): string[] {
  if (stopDir === null) return [start]
  const chain: string[] = []
  let dir = start
  while (true) {
    chain.push(dir)
    if (dir === stopDir) return chain
    const parent = dirname(dir)
    if (parent === dir) return [start] // hit fs root without meeting stopDir: not an ancestor
    dir = parent
  }
}
