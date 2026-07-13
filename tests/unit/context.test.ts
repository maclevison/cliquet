import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectContext, detectPackageManager, findLockfileDir } from '../../src/context.js'
import { DEFAULT_BASELINE } from '../../src/baseline.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cliquet-ctx-'))
})

describe('detectPackageManager', () => {
  it('prioritizes the packageManager field from package.json', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@9.0.0' }))
    writeFileSync(join(root, 'yarn.lock'), '')
    expect(detectPackageManager(root)).toBe('pnpm')
  })

  it('uses lockfile precedence: pnpm > yarn > npm', () => {
    writeFileSync(join(root, 'yarn.lock'), '')
    writeFileSync(join(root, 'package-lock.json'), '{}')
    expect(detectPackageManager(root)).toBe('yarn')
  })

  it('returns null with no lockfile and no field', () => {
    writeFileSync(join(root, 'package.json'), '{}')
    expect(detectPackageManager(root)).toBeNull()
  })

  it('returns null with a malformed package.json (no lockfile)', () => {
    writeFileSync(join(root, 'package.json'), '{ invalid json')
    expect(detectPackageManager(root)).toBeNull()
  })
})

describe('createProjectContext', () => {
  it('builds the context with resolved sourceDirs and timeout', () => {
    mkdirSync(join(root, 'src'))
    const ctx = createProjectContext(root, DEFAULT_BASELINE, 300_000)
    expect(ctx.rootPath).toBe(root)
    expect(ctx.sourceDirs).toEqual([join(root, 'src')])
    expect(ctx.timeoutMs).toBe(300_000)
    expect(typeof ctx.resolveTool).toBe('function')
  })
})

function mkMonorepo() {
  const repo = join(mkdtempSync(join(tmpdir(), 'cliquet-mono-')), 'repo')
  mkdirSync(join(repo, 'apps', 'web'), { recursive: true })
  mkdirSync(join(repo, '.git'))
  return { repo, web: join(repo, 'apps', 'web') }
}

describe('detectPackageManager walk-up', () => {
  it('finds the root lockfile from a workspace', () => {
    const { repo, web } = mkMonorepo()
    writeFileSync(join(repo, 'pnpm-lock.yaml'), '')
    expect(detectPackageManager(web, repo)).toBe('pnpm')
  })

  it('closest dir wins over the root', () => {
    const { repo, web } = mkMonorepo()
    writeFileSync(join(repo, 'pnpm-lock.yaml'), '')
    writeFileSync(join(web, 'package-lock.json'), '{}')
    expect(detectPackageManager(web, repo)).toBe('npm')
  })

  it('without stopDir keeps local-only behavior', () => {
    const { repo, web } = mkMonorepo()
    writeFileSync(join(repo, 'pnpm-lock.yaml'), '')
    expect(detectPackageManager(web)).toBeNull()
  })
})

describe('findLockfileDir', () => {
  it('returns the dir that CONTAINS the lockfile', () => {
    const { repo, web } = mkMonorepo()
    writeFileSync(join(repo, 'pnpm-lock.yaml'), '')
    expect(findLockfileDir(web, repo)).toBe(repo)
  })

  it('ignores a field-only packageManager hit (no lockfile → null)', () => {
    const { repo, web } = mkMonorepo()
    writeFileSync(join(web, 'package.json'), JSON.stringify({ packageManager: 'pnpm@9.0.0' }))
    expect(findLockfileDir(web, repo)).toBeNull()
  })
})

describe('createProjectContext monorepo fields', () => {
  it('exposes repoRoot and lockfileDir', () => {
    const { repo, web } = mkMonorepo()
    writeFileSync(join(repo, 'pnpm-lock.yaml'), '')
    const ctx = createProjectContext(web, DEFAULT_BASELINE, 300_000)
    expect(ctx.repoRoot).toBe(repo)
    expect(ctx.lockfileDir).toBe(repo)
    expect(ctx.packageManager).toBe('pnpm')
  })

  it('outside a git repo: repoRoot and lockfileDir are null, behavior unchanged', () => {
    // reuses the plain tmpdir fixture `root` (no .git above the OS tmpdir)
    const ctx = createProjectContext(root, DEFAULT_BASELINE, 300_000)
    expect(ctx.repoRoot).toBeNull()
    expect(ctx.lockfileDir).toBeNull()
  })
})
