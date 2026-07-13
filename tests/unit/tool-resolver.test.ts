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

  it('ignores a FOREIGN project node_modules/.bin present on PATH (npm/npx prepends ancestors of the shell cwd)', () => {
    const foreign = mkdtempSync(join(tmpdir(), 'cliquet-resolver-foreign-'))
    mkdirSync(join(foreign, 'node_modules', '.bin'), { recursive: true })
    const leaked = join(foreign, 'node_modules', '.bin', 'fake-leaked')
    writeFileSync(leaked, '#!/bin/sh\n')
    chmodSync(leaked, 0o755)
    const dir = makeProject()
    const resolve = createToolResolver(dir, { PATH: join(foreign, 'node_modules', '.bin') })
    expect(resolve('fake-leaked')).toBeNull()
  })

  it('ignores npx cache directories on PATH (embedded tool copies)', () => {
    const cache = mkdtempSync(join(tmpdir(), 'cliquet-resolver-npxcache-'))
    const npxBin = join(cache, '_npx', 'abc123', 'node_modules', '.bin')
    mkdirSync(npxBin, { recursive: true })
    const embedded = join(npxBin, 'fake-embedded')
    writeFileSync(embedded, '#!/bin/sh\n')
    chmodSync(embedded, 0o755)
    const dir = makeProject()
    const resolve = createToolResolver(dir, { PATH: npxBin })
    expect(resolve('fake-embedded')).toBeNull()
  })

  it('still accepts the OWN project .bin when it arrives via PATH (npm run prepends it)', () => {
    const dir = makeProject()
    const own = join(dir, 'node_modules', '.bin', 'fake-own')
    writeFileSync(own, '#!/bin/sh\n')
    chmodSync(own, 0o755)
    // resolver rooted elsewhere would reject it; rooted at the project it must accept
    const resolve = createToolResolver(dir, { PATH: join(dir, 'node_modules', '.bin') })
    expect(resolve('fake-own')).toBe(own)
  })

  it('still accepts plain (non-node_modules) PATH dirs — global installs', () => {
    const globalBin = mkdtempSync(join(tmpdir(), 'cliquet-resolver-global-'))
    const tool = join(globalBin, 'fake-global')
    writeFileSync(tool, '#!/bin/sh\n')
    chmodSync(tool, 0o755)
    const resolve = createToolResolver(makeProject(), { PATH: globalBin })
    expect(resolve('fake-global')).toBe(tool)
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
