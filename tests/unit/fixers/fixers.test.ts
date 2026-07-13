import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStyleFixer } from '../../../src/fixers/style.js'
import { createLintFixer } from '../../../src/fixers/lint.js'
import { createPerformanceFixer } from '../../../src/fixers/performance.js'
import { DEFAULT_BASELINE, type Baseline } from '../../../src/baseline.js'
import { createProjectContext } from '../../../src/context.js'
import type { RunResult } from '../../../src/process.js'
import type { ToolRunnerDeps } from '../../../src/gates/style.js'

function baselineWithExclude(exclude: string[]): Baseline {
  return { ...DEFAULT_BASELINE, source_dirs: { ...DEFAULT_BASELINE.source_dirs, exclude } }
}

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

/** Runner that simulates a broken tool (crash, timeout, missing binary). */
function brokenRun(partial: Partial<RunResult>): NonNullable<ToolRunnerDeps['run']> {
  return async (bin, args) => {
    calls.push({ bin, args })
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false, ...partial }
  }
}

function ctxWithTools(tools: string[], baseline: Baseline = DEFAULT_BASELINE) {
  const ctx = createProjectContext(root, baseline, 300_000)
  return { ...ctx, resolveTool: (bin: string) => (tools.includes(bin) ? `/fake/bin/${bin}` : null) }
}

describe('styleFixer', () => {
  it('runs biome first and prettier last (last writer wins — spec §8)', async () => {
    writeFileSync(join(root, '.prettierrc'), '{}')
    writeFileSync(join(root, 'biome.json'), '{}')
    const fixer = createStyleFixer({ run: fakeRun })
    const outcome = await fixer.run(ctxWithTools(['prettier', 'biome']))
    expect(outcome.applied).toBe(true)
    expect(calls.map((c) => c.bin)).toEqual(['/fake/bin/biome', '/fake/bin/prettier'])
    expect(calls[0]?.args).toContain('--write')
    expect(calls[1]?.args).toContain('--write')
  })

  it('detects a formatter at the monorepo root (walk-up)', async () => {
    const repo = join(mkdtempSync(join(tmpdir(), 'cliquet-fix-mono-')), 'repo')
    mkdirSync(join(repo, 'apps', 'web'), { recursive: true })
    mkdirSync(join(repo, '.git'))
    writeFileSync(join(repo, '.prettierrc'), '{}')
    const ctx = createProjectContext(join(repo, 'apps', 'web'), DEFAULT_BASELINE, 300_000)
    const fixer = createStyleFixer({ run: fakeRun })
    const outcome = await fixer.run({ ...ctx, resolveTool: (bin: string) => (bin === 'prettier' ? '/fake/bin/prettier' : null) })
    expect(outcome.applied).toBe(true)
    expect(calls.map((c) => c.bin)).toEqual(['/fake/bin/prettier'])
  })

  it('applies nothing when no formatter is configured', async () => {
    const fixer = createStyleFixer({ run: fakeRun })
    const outcome = await fixer.run(ctxWithTools(['prettier']))
    expect(outcome.applied).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('tool that crashes (exit 2) → applied: false with an error message', async () => {
    writeFileSync(join(root, '.prettierrc'), '{}')
    const fixer = createStyleFixer({ run: brokenRun({ exitCode: 2, failed: true, stderr: 'SyntaxError: broken file' }) })
    const outcome = await fixer.run(ctxWithTools(['prettier']))
    expect(outcome.applied).toBe(false)
    expect(outcome.message).toContain('prettier')
    expect(outcome.message).toContain('SyntaxError: broken file')
  })
})

describe('lintFixer', () => {
  it('runs eslint --fix when config is present', async () => {
    writeFileSync(join(root, 'eslint.config.mjs'), '')
    const fixer = createLintFixer({ run: fakeRun })
    const outcome = await fixer.run(ctxWithTools(['eslint']))
    expect(outcome.applied).toBe(true)
    expect(calls[0]?.args).toContain('--fix')
  })

  it('eslint --fix with exit 1 (remaining non-fixable errors) still counts as applied', async () => {
    writeFileSync(join(root, 'eslint.config.mjs'), '')
    // REAL shape of runCommand: execa marks failed: true for ANY exit != 0
    const fixer = createLintFixer({ run: brokenRun({ exitCode: 1, failed: true }) })
    const outcome = await fixer.run(ctxWithTools(['eslint']))
    expect(outcome.applied).toBe(true)
  })

  it('process that does not even run (failed) → applied: false with an error message', async () => {
    writeFileSync(join(root, 'eslint.config.mjs'), '')
    const fixer = createLintFixer({ run: brokenRun({ exitCode: null, failed: true, stderr: 'ENOENT' }) })
    const outcome = await fixer.run(ctxWithTools(['eslint']))
    expect(outcome.applied).toBe(false)
    expect(outcome.message).toContain('eslint')
    expect(outcome.message).toContain('ENOENT')
  })

  it('passes exclude patterns as --ignore-pattern to the eslint --fix invocation', async () => {
    writeFileSync(join(root, 'eslint.config.mjs'), '')
    const fixer = createLintFixer({ run: fakeRun })
    const baseline = baselineWithExclude(['gen'])
    await fixer.run(ctxWithTools(['eslint'], baseline))
    const args = calls[0]?.args ?? []
    const pairs = args.flatMap((a, i) => (a === '--ignore-pattern' ? [args[i + 1]] : []))
    expect(pairs).toEqual(['gen', 'gen/**'])
  })

  it('does not pass --ignore-pattern when source_dirs.exclude is empty', async () => {
    writeFileSync(join(root, 'eslint.config.mjs'), '')
    const fixer = createLintFixer({ run: fakeRun })
    await fixer.run(ctxWithTools(['eslint']))
    expect(calls[0]?.args).not.toContain('--ignore-pattern')
  })
})

describe('performanceFixer', () => {
  it('runs eslint --fix with internal config when eslint resolves', async () => {
    const fixer = createPerformanceFixer({ run: fakeRun })
    const outcome = await fixer.run(ctxWithTools(['eslint']))
    expect(outcome.applied).toBe(true)
    expect(calls[0]?.args).toContain('--no-config-lookup')
    expect(calls[0]?.args).toContain('--fix')
  })

  it('applies nothing without eslint', async () => {
    const fixer = createPerformanceFixer({ run: fakeRun })
    const outcome = await fixer.run(ctxWithTools([]))
    expect(outcome.applied).toBe(false)
  })

  it('eslint that times out → applied: false with an error message', async () => {
    const fixer = createPerformanceFixer({ run: brokenRun({ exitCode: null, timedOut: true }) })
    const outcome = await fixer.run(ctxWithTools(['eslint']))
    expect(outcome.applied).toBe(false)
    expect(outcome.message).toContain('eslint')
  })

  it('passes exclude patterns as --ignore-pattern to the internal-config eslint --fix invocation', async () => {
    const fixer = createPerformanceFixer({ run: fakeRun })
    const baseline = baselineWithExclude(['gen'])
    await fixer.run(ctxWithTools(['eslint'], baseline))
    const args = calls[0]?.args ?? []
    const pairs = args.flatMap((a, i) => (a === '--ignore-pattern' ? [args[i + 1]] : []))
    expect(pairs).toEqual(['gen', 'gen/**'])
  })

  it('does not pass --ignore-pattern when source_dirs.exclude is empty', async () => {
    const fixer = createPerformanceFixer({ run: fakeRun })
    await fixer.run(ctxWithTools(['eslint']))
    expect(calls[0]?.args).not.toContain('--ignore-pattern')
  })

  it('benign "all files ignored" (internal JS rules vs a .vue/.ts tree) → quiet skip, not a failure dump', async () => {
    // eslint 9 exits 2 here, same benign case the performance GATE degrades on — the fixer
    // must not surface the scary "Oops! Something went wrong! ESLint" help text as a failure.
    const fixer = createPerformanceFixer({
      run: brokenRun({
        exitCode: 2,
        stderr: 'You are linting "app", but all of the files matching the glob pattern "app" are ignored.',
      }),
    })
    const outcome = await fixer.run(ctxWithTools(['eslint']))
    expect(outcome.applied).toBe(false)
    expect(outcome.message).not.toContain('failed')
    expect(outcome.message).not.toContain('Oops')
  })

  it('a genuine eslint crash (exit 2, unrelated stderr) still reports a failure', async () => {
    const fixer = createPerformanceFixer({ run: brokenRun({ exitCode: 2, stderr: 'Cannot find module "eslint-plugin-x"' }) })
    const outcome = await fixer.run(ctxWithTools(['eslint']))
    expect(outcome.applied).toBe(false)
    expect(outcome.message).toContain('failed')
  })
})
