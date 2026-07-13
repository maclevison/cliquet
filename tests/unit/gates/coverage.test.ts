import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCoverageSummary, createCoverageGate } from '../../../src/gates/coverage.js'
import { DEFAULT_BASELINE, type Baseline } from '../../../src/baseline.js'
import { createProjectContext } from '../../../src/context.js'

const fixturePath = join(import.meta.dirname, '..', '..', 'fixtures', 'outputs', 'coverage-summary.json')

describe('parseCoverageSummary', () => {
  it('extracts total.lines.pct', () => {
    expect(parseCoverageSummary(readFileSync(fixturePath, 'utf8'))).toBe(87.0)
  })
  it('returns null for invalid JSON or missing total', () => {
    expect(parseCoverageSummary('nope')).toBeNull()
    expect(parseCoverageSummary('{}')).toBeNull()
  })
})

describe('coverageGate', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cliquet-cov-'))
  })

  function withVitest() {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^3.0.0' } }))
  }

  function baselineWith(pct: number): Baseline {
    return { ...DEFAULT_BASELINE, coverage: { percentage: pct } }
  }

  function ctxWithTools(tools: string[]) {
    const ctx = createProjectContext(root, DEFAULT_BASELINE, 300_000)
    return { ...ctx, resolveTool: (bin: string) => (tools.includes(bin) ? `/fake/bin/${bin}` : null) }
  }

  it('skips when no runner is detected', async () => {
    const gate = createCoverageGate({ run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false }) })
    const r = await gate.run(ctxWithTools(['vitest']), DEFAULT_BASELINE)
    expect(r.status).toBe('skip')
  })

  it('passes when coverage ≥ baseline', async () => {
    withVitest()
    const gate = createCoverageGate({
      run: async () => {
        // simulates the runner writing the report
        mkdirSync(join(root, 'coverage'), { recursive: true })
        cpSync(fixturePath, join(root, 'coverage', 'coverage-summary.json'))
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false }
      },
    })
    const r = await gate.run(ctxWithTools(['vitest']), baselineWith(85))
    expect(r.status).toBe('pass')
    expect(r.current).toEqual({ percentage: 87.0 })
    expect(r.message).toContain('vitest') // reports which runner was used (spec §5 gate 4)
  })

  it('pass with an IMPROVEMENT suggests UPDATE BASELINE as an optional action (warn, spec §4)', async () => {
    withVitest()
    const gate = createCoverageGate({
      run: async () => {
        mkdirSync(join(root, 'coverage'), { recursive: true })
        cpSync(fixturePath, join(root, 'coverage', 'coverage-summary.json')) // 87%
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false }
      },
    })
    const r = await gate.run(ctxWithTools(['vitest']), baselineWith(85))
    expect(r.status).toBe('pass') // warn does not change status or exit code
    const suggest = r.actions.find((a) => a.type === 'UPDATE BASELINE')
    expect(suggest).toBeDefined()
    expect(suggest?.severity).toBe('warn')
    expect(suggest?.priority).toBe(10)
    expect(suggest?.message).toContain('improved to 87.00%')
    expect(suggest?.message).toContain('cliquet.baseline.json')
  })

  it('pass TIED with the baseline does not suggest an update', async () => {
    withVitest()
    const gate = createCoverageGate({
      run: async () => {
        mkdirSync(join(root, 'coverage'), { recursive: true })
        cpSync(fixturePath, join(root, 'coverage', 'coverage-summary.json')) // 87%
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false }
      },
    })
    const r = await gate.run(ctxWithTools(['vitest']), baselineWith(87))
    expect(r.status).toBe('pass')
    expect(r.actions).toEqual([])
  })

  it('fails when coverage < baseline', async () => {
    withVitest()
    const gate = createCoverageGate({
      run: async () => {
        mkdirSync(join(root, 'coverage'), { recursive: true })
        cpSync(fixturePath, join(root, 'coverage', 'coverage-summary.json'))
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false }
      },
    })
    const r = await gate.run(ctxWithTools(['vitest']), baselineWith(90))
    expect(r.status).toBe('fail')
    expect(r.actions[0]?.severity).toBe('block')
  })

  it('uses the summary even with exit != 0 and stderr mentioning provider (failing tests still measure coverage)', async () => {
    withVitest()
    const gate = createCoverageGate({
      run: async () => {
        mkdirSync(join(root, 'coverage'), { recursive: true })
        cpSync(fixturePath, join(root, 'coverage', 'coverage-summary.json'))
        return {
          exitCode: 1,
          stdout: '',
          // failing test dump that happens to contain the string "coverage provider"
          stderr: 'FAIL tests/x.test.ts > expect(r.message).toContain("coverage provider")',
          timedOut: false,
          failed: true,
        }
      },
    })
    const r = await gate.run(ctxWithTools(['vitest']), baselineWith(85))
    expect(r.status).toBe('pass')
    expect(r.current).toEqual({ percentage: 87.0 })
  })

  it('strips VITEST* from the env passed to the runner (vitest-inside-vitest reentrancy)', async () => {
    withVitest()
    let seenEnv: Record<string, string | undefined> | undefined
    const gate = createCoverageGate({
      run: async (_bin, _args, opts) => {
        seenEnv = opts.env
        mkdirSync(join(root, 'coverage'), { recursive: true })
        cpSync(fixturePath, join(root, 'coverage', 'coverage-summary.json'))
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false }
      },
    })
    await gate.run(ctxWithTools(['vitest']), baselineWith(85))
    expect(seenEnv).toBeDefined()
    // execa (default extendEnv) removes keys with an undefined value from the child env
    for (const key of ['VITEST', 'VITEST_WORKER_ID', 'VITEST_POOL_ID']) {
      expect(key in seenEnv!, `${key} should be present as undefined`).toBe(true)
      expect(seenEnv![key]).toBeUndefined()
    }
  })

  it('does not trust a STALE summary: deletes the previous one before running the runner', async () => {
    withVitest()
    // summary from a PREVIOUS run already on disk
    mkdirSync(join(root, 'coverage'), { recursive: true })
    cpSync(fixturePath, join(root, 'coverage', 'coverage-summary.json'))
    const gate = createCoverageGate({
      // current run fails and does NOT write a new summary
      run: async () => ({ exitCode: 1, stdout: '', stderr: 'boom', timedOut: false, failed: true }),
    })
    const r = await gate.run(ctxWithTools(['vitest']), baselineWith(85))
    expect(r.status).toBe('error')
  })

  it('errors with guidance when the coverage provider is missing', async () => {
    withVitest()
    const gate = createCoverageGate({
      run: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'Error: Cannot find dependency @vitest/coverage-v8',
        timedOut: false,
        failed: true,
      }),
    })
    const r = await gate.run(ctxWithTools(['vitest']), baselineWith(85))
    expect(r.status).toBe('error')
    expect(r.message).toContain('coverage provider')
  })

  it('errors with guidance when jest lacks babel-plugin-istanbul', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { jest: '^29.0.0' } }))
    const gate = createCoverageGate({
      run: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: "Cannot find module 'babel-plugin-istanbul'",
        timedOut: false,
        failed: true,
      }),
    })
    const r = await gate.run(ctxWithTools(['jest']), baselineWith(85))
    expect(r.status).toBe('error')
    expect(r.message).toContain('coverage provider')
  })

  it('no-summary message lists failing tests as a likely cause instead of asserting reportsDirectory', async () => {
    withVitest()
    const gate = createCoverageGate({
      run: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'FAIL tests/planFormHelpers.test.ts > builds the plan form',
        timedOut: false,
        failed: true,
      }),
    })
    const r = await gate.run(ctxWithTools(['vitest']), baselineWith(85))
    expect(r.status).toBe('error')
    expect(r.message).toContain('likely causes')
    expect(r.message).toContain('tests failed')
    expect(r.message).toContain('planFormHelpers') // the real failure surfaces
  })

  it('injects the json-summary reporter so projects need no coverage reporter config (regression lock)', async () => {
    withVitest()
    let seenArgs: string[] = []
    const gate = createCoverageGate({
      run: async (_bin, args) => {
        seenArgs = args
        mkdirSync(join(root, 'coverage'), { recursive: true })
        cpSync(fixturePath, join(root, 'coverage', 'coverage-summary.json'))
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false }
      },
    })
    await gate.run(ctxWithTools(['vitest']), baselineWith(85))
    expect(seenArgs).toContain('--coverage.reporter=json-summary')
  })

  it('does NOT claim provider missing when tests merely crash under --coverage (provider only in stack trace paths)', async () => {
    withVitest()
    const gate = createCoverageGate({
      run: async () => ({
        exitCode: 1,
        stdout: '',
        // real-world shape: broken tests under --coverage; the provider package
        // shows up only as a module path inside the stack trace
        stderr: [
          'FAIL tests/useAuthStore.test.ts > clears session',
          "TypeError: Cannot read properties of undefined (reading 'clear')",
          ' ❯ node_modules/@vitest/coverage-v8/dist/index.js:5:3',
        ].join('\n'),
        timedOut: false,
        failed: true,
      }),
    })
    const r = await gate.run(ctxWithTools(['vitest']), baselineWith(85))
    expect(r.status).toBe('error')
    expect(r.message).not.toContain('coverage provider missing')
    expect(r.message).toContain('was not produced')
    // the real failure must surface for the user to act on
    expect(r.message).toContain('useAuthStore')
  })
})
