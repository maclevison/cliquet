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
import type { ToolRunnerDeps } from '../../../src/gates/style.js'

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

/** Runner que simula ferramenta quebrada (crash, timeout, binário ausente). */
function brokenRun(partial: Partial<RunResult>): NonNullable<ToolRunnerDeps['run']> {
  return async (bin, args) => {
    calls.push({ bin, args })
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false, ...partial }
  }
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

  it('ferramenta que crasha (exit 2) → applied: false com mensagem de erro', async () => {
    writeFileSync(join(root, '.prettierrc'), '{}')
    const fixer = createStyleFixer({ run: brokenRun({ exitCode: 2, failed: true, stderr: 'SyntaxError: broken file' }) })
    const outcome = await fixer.run(ctxWithTools(['prettier']))
    expect(outcome.applied).toBe(false)
    expect(outcome.message).toContain('prettier')
    expect(outcome.message).toContain('SyntaxError: broken file')
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

  it('eslint --fix com exit 1 (erros não-corrigíveis restantes) ainda conta como aplicado', async () => {
    writeFileSync(join(root, 'eslint.config.mjs'), '')
    // shape REAL do runCommand: execa marca failed: true para QUALQUER exit != 0
    const fixer = createLintFixer({ run: brokenRun({ exitCode: 1, failed: true }) })
    const outcome = await fixer.run(ctxWithTools(['eslint']))
    expect(outcome.applied).toBe(true)
  })

  it('processo que nem executa (failed) → applied: false com mensagem de erro', async () => {
    writeFileSync(join(root, 'eslint.config.mjs'), '')
    const fixer = createLintFixer({ run: brokenRun({ exitCode: null, failed: true, stderr: 'ENOENT' }) })
    const outcome = await fixer.run(ctxWithTools(['eslint']))
    expect(outcome.applied).toBe(false)
    expect(outcome.message).toContain('eslint')
    expect(outcome.message).toContain('ENOENT')
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

  it('eslint que estoura timeout → applied: false com mensagem de erro', async () => {
    const fixer = createPerformanceFixer({ run: brokenRun({ exitCode: null, timedOut: true }) })
    const outcome = await fixer.run(ctxWithTools(['eslint']))
    expect(outcome.applied).toBe(false)
    expect(outcome.message).toContain('eslint')
  })
})
