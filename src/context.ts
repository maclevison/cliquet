import { existsSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import picomatch from 'picomatch'
import type { Baseline } from './baseline.js'
import type { PackageManager, ProjectContext } from './types.js'
import { createToolResolver } from './tool-resolver.js'
import { resolveSourceDirs } from './source-files.js'
import { dirChain, findRepoRoot } from './workspace.js'

const LOCKFILES: Array<[string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
]

function detectInDir(dir: string): PackageManager | null {
  const pkgPath = join(dir, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { packageManager?: string }
      const field = pkg.packageManager?.split('@')[0]
      if (field === 'npm' || field === 'pnpm' || field === 'yarn') return field
    } catch {
      // invalid package.json isn't fatal here; falls through to lockfiles
    }
  }
  for (const [file, pm] of LOCKFILES) {
    if (existsSync(join(dir, file))) return pm
  }
  return null
}

/** Closest dir wins walking up to stopDir; per-dir priority: packageManager field → lockfiles. */
export function detectPackageManager(rootPath: string, stopDir: string | null = null): PackageManager | null {
  for (const dir of dirChain(rootPath, stopDir)) {
    const pm = detectInDir(dir)
    if (pm !== null) return pm
  }
  return null
}

/**
 * First dir in the chain that actually CONTAINS a lockfile; null if none. Kept
 * independent from detectPackageManager: a field-only hit has no lockfile, and
 * pointing the audit there would fail on "no lockfile" again.
 */
export function findLockfileDir(rootPath: string, stopDir: string | null = null): string | null {
  for (const dir of dirChain(rootPath, stopDir)) {
    if (LOCKFILES.some(([file]) => existsSync(join(dir, file)))) return dir
  }
  return null
}

/** Normalizes a path to `/`-separated segments (portable unit for the win32 branch). */
export function toPosix(p: string): string {
  return p.split(sep).join('/')
}

/**
 * Bare-path ergonomics: a pattern that isn't a real glob (picomatch.scan().isGlob is the
 * NORMATIVE check, not a char regex — so a literal dir like `lib(v2)` still expands correctly)
 * is treated as a subtree and expanded into `p` AND `p/**`. Real globs pass through untouched.
 * Empty-string entries are skipped (baseline validation permits them; expanding `''` would
 * produce `''`/`'/**'` patterns picomatch could misinterpret).
 */
export function expandExcludePatterns(exclude: string[]): string[] {
  const expanded: string[] = []
  for (const pattern of exclude) {
    if (pattern === '') continue
    if (picomatch.scan(pattern).isGlob) {
      expanded.push(pattern)
    } else {
      expanded.push(pattern, `${pattern}/**`)
    }
  }
  return expanded
}

/** Compiled once with `{ dot: true }` so patterns like `.astro/**` reach dot segments; empty → `() => false` fast path. */
function compileIsExcluded(rootPath: string, excludePatterns: string[]): (absPath: string) => boolean {
  if (excludePatterns.length === 0) return () => false
  const isMatch = picomatch(excludePatterns, { dot: true })
  return (absPath: string) => isMatch(toPosix(relative(rootPath, absPath)))
}

export function createProjectContext(rootPath: string, baseline: Baseline, timeoutMs: number): ProjectContext {
  const repoRoot = findRepoRoot(rootPath)
  const excludePatterns = expandExcludePatterns(baseline.source_dirs.exclude)
  return {
    rootPath,
    repoRoot,
    lockfileDir: findLockfileDir(rootPath, repoRoot),
    sourceDirs: resolveSourceDirs(rootPath, baseline.source_dirs.paths),
    packageManager: detectPackageManager(rootPath, repoRoot),
    resolveTool: createToolResolver(rootPath, process.env, repoRoot),
    timeoutMs,
    excludePatterns,
    isExcluded: compileIsExcluded(rootPath, excludePatterns),
  }
}
