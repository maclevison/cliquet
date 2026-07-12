import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Baseline } from './baseline.js'
import type { PackageManager, ProjectContext } from './types.js'
import { createToolResolver } from './tool-resolver.js'
import { resolveSourceDirs } from './source-files.js'

export function detectPackageManager(rootPath: string): PackageManager | null {
  const pkgPath = join(rootPath, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { packageManager?: string }
      const field = pkg.packageManager?.split('@')[0]
      if (field === 'npm' || field === 'pnpm' || field === 'yarn') return field
    } catch {
      // package.json inválido não é fatal aqui; segue para lockfiles
    }
  }
  if (existsSync(join(rootPath, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(rootPath, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(rootPath, 'package-lock.json'))) return 'npm'
  return null
}

export function createProjectContext(rootPath: string, baseline: Baseline, timeoutMs: number): ProjectContext {
  return {
    rootPath,
    sourceDirs: resolveSourceDirs(rootPath, baseline.source_dirs.paths),
    packageManager: detectPackageManager(rootPath),
    resolveTool: createToolResolver(rootPath),
    timeoutMs,
  }
}
