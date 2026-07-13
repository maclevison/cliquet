import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStyleGate, parseBiomeDiagnostics } from '../../../src/gates/style.js'
import { DEFAULT_BASELINE } from '../../../src/baseline.js'
import { createProjectContext } from '../../../src/context.js'
import type { RunResult } from '../../../src/process.js'

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'outputs', name), 'utf8')

describe('parseBiomeDiagnostics', () => {
  it('extracts paths from real biome 2.x output (location.path is a string)', () => {
    const files = parseBiomeDiagnostics(fixture('biome-format-diagnostics.json'))
    expect(files).toEqual(['bad.ts', 'bad2.ts', 'package.json'])
  })

  it('accepts the legacy biome 1.x shape (location.path.file)', () => {
    const out = JSON.stringify({ diagnostics: [{ location: { path: { file: './src/a.ts' } } }] })
    expect(parseBiomeDiagnostics(out)).toEqual(['./src/a.ts'])
  })

  it('returns [] for invalid JSON', () => {
    expect(parseBiomeDiagnostics('boom')).toEqual([])
  })

  it('counts only error/fatal severity — biome lint warnings are not errors (spec §5)', () => {
    const out = JSON.stringify({
      diagnostics: [
        { severity: 'error', location: { path: 'src/a.ts' } },
        { severity: 'warning', location: { path: 'src/b.ts' } },
        { severity: 'information', location: { path: 'src/c.ts' } },
        { severity: 'fatal', location: { path: 'src/d.ts' } },
      ],
    })
    expect(parseBiomeDiagnostics(out)).toEqual(['src/a.ts', 'src/d.ts'])
  })
})

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cliquet-style-'))
})

function ok(stdout = ''): RunResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false, failed: false }
}
function fail(stdout: string, exitCode = 1): RunResult {
  return { exitCode, stdout, stderr: '', timedOut: false, failed: false }
}

function ctxWithTools(tools: string[]) {
  const ctx = createProjectContext(root, DEFAULT_BASELINE, 300_000)
  return { ...ctx, resolveTool: (bin: string) => (tools.includes(bin) ? `/fake/bin/${bin}` : null) }
}

describe('styleGate', () => {
  it('skip when there is no formatter config', async () => {
    const gate = createStyleGate({ run: async () => ok() })
    const r = await gate.run(ctxWithTools(['prettier']), DEFAULT_BASELINE)
    expect(r.status).toBe('skip')
  })

  it('passes with clean prettier (tied with baseline 0 → no update suggestion)', async () => {
    writeFileSync(join(root, '.prettierrc'), '{}')
    const gate = createStyleGate({ run: async () => ok('') })
    const r = await gate.run(ctxWithTools(['prettier']), DEFAULT_BASELINE)
    expect(r.status).toBe('pass')
    expect(r.current).toEqual({ violations: 0 })
    expect(r.actions).toEqual([])
  })

  it('pass with IMPROVEMENT (violations below baseline) suggests UPDATE BASELINE (warn, spec §4)', async () => {
    writeFileSync(join(root, '.prettierrc'), '{}')
    const gate = createStyleGate({ run: async () => ok('') }) // 0 measured violations
    const baseline = { ...DEFAULT_BASELINE, style: { violations: 2 } }
    const r = await gate.run(ctxWithTools(['prettier']), baseline)
    expect(r.status).toBe('pass')
    const suggest = r.actions.find((a) => a.type === 'UPDATE BASELINE')
    expect(suggest).toBeDefined()
    expect(suggest?.severity).toBe('warn')
    expect(suggest?.priority).toBe(10)
    expect(suggest?.message).toContain('improved to 0')
    expect(suggest?.message).toContain('cliquet.baseline.json')
  })

  it('fails counting files from --list-different', async () => {
    writeFileSync(join(root, '.prettierrc'), '{}')
    const gate = createStyleGate({ run: async () => fail('src/a.ts\nsrc/b.ts\n') })
    const r = await gate.run(ctxWithTools(['prettier']), DEFAULT_BASELINE)
    expect(r.status).toBe('fail')
    expect(r.current).toEqual({ violations: 2 })
    expect(r.actions[0]?.files).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('sums prettier + biome when both are configured', async () => {
    writeFileSync(join(root, '.prettierrc'), '{}')
    writeFileSync(join(root, 'biome.json'), '{}')
    const gate = createStyleGate({
      run: async (bin) =>
        bin.includes('prettier')
          ? fail('src/a.ts\n')
          : fail(JSON.stringify({ diagnostics: [{ location: { path: { file: 'src/c.ts' } } }] })),
    })
    const r = await gate.run(ctxWithTools(['prettier', 'biome']), DEFAULT_BASELINE)
    expect(r.status).toBe('fail')
    expect(r.current).toEqual({ violations: 2 })
  })

  it('error when the tool crashes (unexpected exit code, empty stdout)', async () => {
    writeFileSync(join(root, '.prettierrc'), '{}')
    const gate = createStyleGate({
      run: async () => ({ exitCode: 2, stdout: '', stderr: 'crashed hard', timedOut: false, failed: true }),
    })
    const r = await gate.run(ctxWithTools(['prettier']), DEFAULT_BASELINE)
    expect(r.status).toBe('error')
    expect(r.message).toContain('crashed hard')
  })

  it('error when prettier exits with 1 but stdout is empty (parse failure does not become 0 violations)', async () => {
    writeFileSync(join(root, '.prettierrc'), '{}')
    const gate = createStyleGate({ run: async () => fail('') })
    const r = await gate.run(ctxWithTools(['prettier']), DEFAULT_BASELINE)
    expect(r.status).toBe('error')
  })

  it('skip when config exists but the binary does not resolve', async () => {
    writeFileSync(join(root, '.prettierrc'), '{}')
    const gate = createStyleGate({ run: async () => ok() })
    const r = await gate.run(ctxWithTools([]), DEFAULT_BASELINE)
    expect(r.status).toBe('skip')
  })
})

describe('prettier ignore-path chain (monorepo)', () => {
  function mkMonorepo() {
    const repo = join(mkdtempSync(join(tmpdir(), 'cliquet-mono-')), 'repo')
    mkdirSync(join(repo, 'apps', 'web'), { recursive: true })
    mkdirSync(join(repo, '.git'))
    return { repo, web: join(repo, 'apps', 'web') }
  }

  it('passes every .prettierignore/.gitignore found up to the repo root via --ignore-path', async () => {
    const { repo, web } = mkMonorepo()
    writeFileSync(join(repo, '.prettierrc'), '{}')
    writeFileSync(join(repo, '.prettierignore'), 'dist/\n')
    writeFileSync(join(repo, '.gitignore'), 'coverage/\n')
    writeFileSync(join(web, '.prettierignore'), 'generated/\n')
    let seenArgs: string[] = []
    const gate = createStyleGate({
      run: async (_bin, args) => {
        seenArgs = args
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false }
      },
    })
    const ctx = { ...createProjectContext(web, DEFAULT_BASELINE, 300_000), resolveTool: () => '/fake/bin/prettier' }
    await gate.run(ctx, DEFAULT_BASELINE)
    const ignorePaths = seenArgs.flatMap((a, i) => (a === '--ignore-path' ? [seenArgs[i + 1]] : []))
    expect(ignorePaths).toContain(join(web, '.prettierignore'))
    expect(ignorePaths).toContain(join(repo, '.prettierignore'))
    expect(ignorePaths).toContain(join(repo, '.gitignore'))
  })

  it('passes NO --ignore-path when no ignore file exists (prettier defaults preserved)', async () => {
    const { repo, web } = mkMonorepo()
    writeFileSync(join(repo, '.prettierrc'), '{}')
    let seenArgs: string[] = []
    const gate = createStyleGate({
      run: async (_bin, args) => {
        seenArgs = args
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false }
      },
    })
    const ctx = { ...createProjectContext(web, DEFAULT_BASELINE, 300_000), resolveTool: () => '/fake/bin/prettier' }
    await gate.run(ctx, DEFAULT_BASELINE)
    expect(seenArgs).not.toContain('--ignore-path')
  })
})
