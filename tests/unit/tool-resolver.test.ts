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
  it('prefere node_modules/.bin do projeto', () => {
    const dir = makeProject()
    const local = join(dir, 'node_modules', '.bin', 'fake-tool')
    writeFileSync(local, '#!/bin/sh\n')
    chmodSync(local, 0o755)
    const resolve = createToolResolver(dir)
    expect(resolve('fake-tool')).toBe(local)
  })

  it('cai para o PATH quando não há binário local', () => {
    const dir = makeProject()
    const resolve = createToolResolver(dir)
    // `node` sempre existe no PATH do ambiente de teste
    expect(resolve('node')).not.toBeNull()
  })

  it('retorna null quando não encontra em lugar nenhum', () => {
    const dir = makeProject()
    const resolve = createToolResolver(dir)
    expect(resolve('cliquet-tool-inexistente-xyz')).toBeNull()
  })
})
