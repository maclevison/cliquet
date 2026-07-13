import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dirChain } from './workspace.js'

/** Checks every dir from rootPath up to stopDir (monorepo roots keep shared configs). */
function anyExists(rootPath: string, names: string[], stopDir: string | null = null): boolean {
  return dirChain(rootPath, stopDir).some((dir) => names.some((n) => existsSync(join(dir, n))))
}

function packageJsonHasKey(rootPath: string, key: string, stopDir: string | null = null): boolean {
  return dirChain(rootPath, stopDir).some((dir) => {
    const path = join(dir, 'package.json')
    if (!existsSync(path)) return false
    try {
      const pkg = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      return pkg[key] !== undefined
    } catch {
      return false
    }
  })
}

const PRETTIER_CONFIGS = [
  '.prettierrc', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml',
  '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs',
  'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs',
]

export function hasPrettierConfig(rootPath: string, stopDir: string | null = null): boolean {
  return anyExists(rootPath, PRETTIER_CONFIGS, stopDir) || packageJsonHasKey(rootPath, 'prettier', stopDir)
}

export function hasBiomeConfig(rootPath: string, stopDir: string | null = null): boolean {
  return anyExists(rootPath, ['biome.json', 'biome.jsonc'], stopDir)
}

const ESLINT_CONFIGS = [
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts',
  '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yml', '.eslintrc.yaml',
]

export function hasEslintConfig(rootPath: string, stopDir: string | null = null): boolean {
  return anyExists(rootPath, ESLINT_CONFIGS, stopDir) || packageJsonHasKey(rootPath, 'eslintConfig', stopDir)
}

export function hasTsconfig(rootPath: string): boolean {
  return existsSync(join(rootPath, 'tsconfig.json'))
}

export type TestRunner = 'vitest' | 'jest'

/** Detection by presence in dependencies/devDependencies; Vitest takes precedence over Jest (spec §5 gate 4). */
export function detectTestRunner(rootPath: string): TestRunner | null {
  const path = join(rootPath, 'package.json')
  if (!existsSync(path)) return null
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    if (deps.vitest) return 'vitest'
    if (deps.jest) return 'jest'
    return null
  } catch {
    return null
  }
}
