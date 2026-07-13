import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolResolver } from '../../src/tool-resolver.js'

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cliquet-resolver-'))
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
  return dir
}

describe('createToolResolver', () => {
  it('prefers the project node_modules/.bin', () => {
    const dir = makeProject()
    const local = join(dir, 'node_modules', '.bin', 'fake-tool')
    writeFileSync(local, '#!/bin/sh\n')
    chmodSync(local, 0o755)
    const resolve = createToolResolver(dir)
    expect(resolve('fake-tool')).toBe(local)
  })

  it('falls back to PATH when there is no local binary', () => {
    const dir = makeProject()
    const resolve = createToolResolver(dir)
    // `node` always exists on the test environment's PATH
    expect(resolve('node')).not.toBeNull()
  })

  it('returns null when it finds nothing anywhere', () => {
    const dir = makeProject()
    const resolve = createToolResolver(dir)
    expect(resolve('cliquet-tool-inexistente-xyz')).toBeNull()
  })

  it('finds a binary hoisted to the monorepo root .bin', () => {
    const repo = join(mkdtempSync(join(tmpdir(), 'cliquet-resolver-mono-')), 'repo')
    mkdirSync(join(repo, 'apps', 'web'), { recursive: true })
    mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true })
    const hoisted = join(repo, 'node_modules', '.bin', 'fake-hoisted')
    writeFileSync(hoisted, '#!/bin/sh\n')
    chmodSync(hoisted, 0o755)
    const resolve = createToolResolver(join(repo, 'apps', 'web'), process.env, repo)
    expect(resolve('fake-hoisted')).toBe(hoisted)
  })
})
