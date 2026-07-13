import { describe, it, expect } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatGeneratedBaseline } from '../../src/cli.js'
import { DEFAULT_BASELINE } from '../../src/baseline.js'

function mkProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cliquet-fmtbase-'))
  writeFileSync(join(dir, 'package.json'), '{}')
  writeFileSync(join(dir, 'cliquet.baseline.json'), '{}')
  return dir
}

function fakeBin(root: string, name: string): string {
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
  const bin = join(root, 'node_modules', '.bin', name)
  writeFileSync(bin, '#!/bin/sh\n')
  chmodSync(bin, 0o755)
  return bin
}

describe('formatGeneratedBaseline', () => {
  it('runs the detected prettier with --write on the baseline file', async () => {
    const dir = mkProject()
    writeFileSync(join(dir, '.prettierrc'), '{ "useTabs": true }')
    const bin = fakeBin(dir, 'prettier')
    const calls: Array<{ bin: string; args: string[] }> = []
    await formatGeneratedBaseline(dir, DEFAULT_BASELINE, 300_000, async (b, a) => {
      calls.push({ bin: b, args: a })
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false }
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.bin).toBe(bin)
    expect(calls[0]?.args).toEqual(['--write', join(dir, 'cliquet.baseline.json')])
  })

  it('is a silent no-op when no formatter is configured', async () => {
    const dir = mkProject()
    const calls: string[] = []
    await formatGeneratedBaseline(dir, DEFAULT_BASELINE, 300_000, async (b) => {
      calls.push(b)
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false }
    })
    expect(calls).toHaveLength(0)
  })

  it('prefers biome when both are configured (biome format --write)', async () => {
    const dir = mkProject()
    writeFileSync(join(dir, '.prettierrc'), '{}')
    writeFileSync(join(dir, 'biome.json'), '{}')
    fakeBin(dir, 'prettier')
    const biome = fakeBin(dir, 'biome')
    const calls: Array<{ bin: string; args: string[] }> = []
    await formatGeneratedBaseline(dir, DEFAULT_BASELINE, 300_000, async (b, a) => {
      calls.push({ bin: b, args: a })
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false }
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.bin).toBe(biome)
    expect(calls[0]?.args).toEqual(['format', '--write', join(dir, 'cliquet.baseline.json')])
  })
})
