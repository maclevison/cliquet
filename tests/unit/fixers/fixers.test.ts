import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStyleFixer } from '../../../src/fixers/style.js'
import { createLintFixer } from '../../../src/fixers/lint.js'
import { createPerformanceFixer } from '../../../src/fixers/performance.js'
import { DEFAULT_BASELINE } from '../../../src/baseline.js'
import { createProjectContext } from '../../../src/context.js'
import type { RunResult } from '../../../src/process.js'

let root: string
let calls: Array<{ bin: string; args: string[] }>
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cliquet-fix-'))
  calls = []
})

const fakeRun = async (bin: string, args: string[]): Promise<RunResult> => {
  calls.push({ bin, args })
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false }
}

function ctxWithTools(tools: string[]) {
  const ctx = createProjectContext(root, DEFAULT_BASELINE, 300_000)
  return { ...ctx, resolveTool: (bin: string) => (tools.includes(bin) ? `/fake/bin/${bin}` : null) }
}

describe('styleFixer', () => {
  it('roda biome antes e prettier por último (last writer wins — spec §8)', async () => {
    writeFileSync(join(root, '.prettierrc'), '{}')
    writeFileSync(join(root, 'biome.json'), '{}')
    const fixer = createStyleFixer({ run: fakeRun })
    const outcome = await fixer.run(ctxWithTools(['prettier', 'biome']))
    expect(outcome.applied).toBe(true)
    expect(calls.map((c) => c.bin)).toEqual(['/fake/bin/biome', '/fake/bin/prettier'])
    expect(calls[0]?.args).toContain('--write')
    expect(calls[1]?.args).toContain('--write')
  })

  it('não aplica nada sem formatador configurado', async () => {
    const fixer = createStyleFixer({ run: fakeRun })
    const outcome = await fixer.run(ctxWithTools(['prettier']))
    expect(outcome.applied).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

describe('lintFixer', () => {
  it('roda eslint --fix quando há config', async () => {
    writeFileSync(join(root, 'eslint.config.mjs'), '')
    const fixer = createLintFixer({ run: fakeRun })
    const outcome = await fixer.run(ctxWithTools(['eslint']))
    expect(outcome.applied).toBe(true)
    expect(calls[0]?.args).toContain('--fix')
  })
})

describe('performanceFixer', () => {
  it('roda eslint --fix com config interna quando eslint resolve', async () => {
    const fixer = createPerformanceFixer({ run: fakeRun })
    const outcome = await fixer.run(ctxWithTools(['eslint']))
    expect(outcome.applied).toBe(true)
    expect(calls[0]?.args).toContain('--no-config-lookup')
    expect(calls[0]?.args).toContain('--fix')
  })

  it('não aplica sem eslint', async () => {
    const fixer = createPerformanceFixer({ run: fakeRun })
    const outcome = await fixer.run(ctxWithTools([]))
    expect(outcome.applied).toBe(false)
  })
})
