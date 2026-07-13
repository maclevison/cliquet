import { readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'])
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.output'])

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

export function listSourceFiles(sourceDirs: string[]): string[] {
  const files: string[] = []
  for (const dir of sourceDirs) walk(dir, files)
  return files.sort()
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) walk(join(dir, entry.name), out)
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      out.push(join(dir, entry.name))
    }
  }
}
