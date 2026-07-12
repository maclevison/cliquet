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
  it('prioriza o campo packageManager do package.json', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@9.0.0' }))
    writeFileSync(join(root, 'yarn.lock'), '')
    expect(detectPackageManager(root)).toBe('pnpm')
  })

  it('usa precedência de lockfiles: pnpm > yarn > npm', () => {
    writeFileSync(join(root, 'yarn.lock'), '')
    writeFileSync(join(root, 'package-lock.json'), '{}')
    expect(detectPackageManager(root)).toBe('yarn')
  })

  it('retorna null sem lockfile nem campo', () => {
    writeFileSync(join(root, 'package.json'), '{}')
    expect(detectPackageManager(root)).toBeNull()
  })

  it('retorna null com package.json malformado (sem lockfile)', () => {
    writeFileSync(join(root, 'package.json'), '{ invalid json')
    expect(detectPackageManager(root)).toBeNull()
  })
})

describe('createProjectContext', () => {
  it('monta o contexto com sourceDirs resolvidos e timeout', () => {
    mkdirSync(join(root, 'src'))
    const ctx = createProjectContext(root, DEFAULT_BASELINE, 300_000)
    expect(ctx.rootPath).toBe(root)
    expect(ctx.sourceDirs).toEqual([join(root, 'src')])
    expect(ctx.timeoutMs).toBe(300_000)
    expect(typeof ctx.resolveTool).toBe('function')
  })
})
