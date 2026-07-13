import { readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'])
// Dot-directories are ALL skipped by the walk (tool caches, .nuxt, nested git
// worktrees under .claude/worktrees/ — walking those doubles every count).
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage'])

/** Existing source_dirs directories (absolute); fallback: project root (spec §4). */
export function resolveSourceDirs(rootPath: string, paths: string[]): string[] {
  const existing = paths.map((p) => join(rootPath, p)).filter((p) => isDirectory(p))
  return existing.length > 0 ? existing : [rootPath]
}

/** true only for actual directories — a FILE named `lib` must not enter the walk (ENOTDIR). */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** isExcluded defaults to none (current behavior) — every built-in gate wires ctx.isExcluded. */
export function listSourceFiles(sourceDirs: string[], isExcluded: (absPath: string) => boolean = () => false): string[] {
  const files: string[] = []
  for (const dir of sourceDirs) walk(dir, files, isExcluded)
  return files.sort()
}

function walk(dir: string, out: string[], isExcluded: (absPath: string) => boolean): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !IGNORED_DIRS.has(entry.name)) walk(join(dir, entry.name), out, isExcluded)
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      const path = join(dir, entry.name)
      if (!isExcluded(path)) out.push(path)
    }
  }
}
