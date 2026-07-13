import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectContext, detectPackageManager } from '../../src/context.js'
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
