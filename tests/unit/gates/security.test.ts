import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseNpmAudit, parseYarnAudit, createSecurityGate, defaultRunAudit } from '../../../src/gates/security.js'
import { DEFAULT_BASELINE, type Baseline } from '../../../src/baseline.js'
import { createProjectContext } from '../../../src/context.js'

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'outputs', name), 'utf8')

describe('parseNpmAudit', () => {
  it('extracts critical+high from metadata', () => {
    expect(parseNpmAudit(fixture('npm-audit-with-vulns.json'))).toEqual({ criticalHigh: 2, total: 3 })
    expect(parseNpmAudit(fixture('npm-audit-clean.json'))).toEqual({ criticalHigh: 0, total: 0 })
  })

  it('returns null for invalid JSON', () => {
    expect(parseNpmAudit('not json')).toBeNull()
  })
})

describe('parseYarnAudit', () => {
  it('extracts critical+high from the auditSummary line (yarn classic NDJSON)', () => {
    const ndjson = [
      JSON.stringify({ type: 'info', data: 'x' }),
      JSON.stringify({ type: 'auditSummary', data: { vulnerabilities: { info: 0, low: 1, moderate: 0, high: 1, critical: 1 } } }),
    ].join('\n')
    expect(parseYarnAudit(ndjson)).toEqual({ criticalHigh: 2, total: 3 })
  })
  it('returns null without an auditSummary line', () => {
    expect(parseYarnAudit('not json\n{"type":"info"}')).toBeNull()
  })
})

describe('securityGate', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cliquet-sec-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, '.gitignore'), '.env\n*.pem\n*.key\n')
  })

  function gateWith(auditJson: string | null) {
    // injects a fake audit runner and disables package_freshness (network)
    return createSecurityGate({
      runAudit: async () => auditJson,
      freshnessFetcher: async () => ({ time: {} }),
    })
  }

  function baselineNoFreshness(): Baseline {
    const b = structuredClone(DEFAULT_BASELINE)
    b.security.rules.package_freshness = false
    return b
  }

  it('passes on a clean project', async () => {
    writeFileSync(join(root, 'src', 'ok.ts'), 'export const x = 1')
    const baseline = baselineNoFreshness()
    const r = await gateWith(fixture('npm-audit-clean.json')).run(
      createProjectContext(root, baseline, 300_000),
      baseline,
    )
    expect(r.status).toBe('pass')
  })

  it('fails with a finding from an enabled rule (zero tolerance)', async () => {
    writeFileSync(join(root, 'src', 'bad.ts'), 'eval(input)')
    const baseline = baselineNoFreshness()
    const r = await gateWith(fixture('npm-audit-clean.json')).run(
      createProjectContext(root, baseline, 300_000),
      baseline,
    )
    expect(r.status).toBe('fail')
    expect(r.actions[0]?.files[0]).toContain('bad.ts:1')
  })

  it('does not run a rule disabled in the baseline', async () => {
    writeFileSync(join(root, 'src', 'bad.ts'), 'eval(input)')
    const baseline = baselineNoFreshness()
    baseline.security.rules.eval_usage = false
    const r = await gateWith(fixture('npm-audit-clean.json')).run(
      createProjectContext(root, baseline, 300_000),
      baseline,
    )
    expect(r.status).toBe('pass')
  })

  describe('security.suppress', () => {
    async function runWithSuppress(suppress: Record<string, string[]>, src: string) {
      writeFileSync(join(root, 'src', 'bad.ts'), src)
      const baseline = baselineNoFreshness()
      baseline.security.suppress = suppress
      return gateWith(fixture('npm-audit-clean.json')).run(createProjectContext(root, baseline, 300_000), baseline)
    }

    it('suppresses a matching glob + rule and reports it as a visible warn (passes)', async () => {
      const r = await runWithSuppress({ 'src/bad.ts': ['eval_usage'] }, 'eval(input)')
      expect(r.status).toBe('pass')
      const warn = r.actions.find((a) => a.severity === 'warn')
      expect(warn?.message).toMatch(/suppress/i)
      expect(warn?.files.some((f) => f.includes('bad.ts') && f.includes('eval_usage'))).toBe(true)
    })

    it('suppresses only the named rule — a different rule on the same file still fails (block)', async () => {
      const r = await runWithSuppress(
        { 'src/bad.ts': ['eval_usage'] },
        'eval(input)\nconst q = db.query(`SELECT * FROM t WHERE id=${id}`)',
      )
      expect(r.status).toBe('fail')
      const block = r.actions.find((a) => a.severity === 'block')
      expect(block?.files.some((f) => f.includes('sql_injection'))).toBe(true)
      expect(block?.files.some((f) => f.includes('eval_usage'))).toBe(false)
    })

    it('does not suppress when the glob does not match the file', async () => {
      const r = await runWithSuppress({ 'src/other.ts': ['eval_usage'] }, 'eval(input)')
      expect(r.status).toBe('fail')
    })

    it('a bare-path glob suppresses the whole subtree', async () => {
      const r = await runWithSuppress({ src: ['eval_usage'] }, 'eval(input)')
      expect(r.status).toBe('pass')
    })
  })

  it('fails when critical/high advisories exceed the baseline', async () => {
    writeFileSync(join(root, 'src', 'ok.ts'), 'export const x = 1')
    const baseline = baselineNoFreshness()
    const r = await gateWith(fixture('npm-audit-with-vulns.json')).run(
      createProjectContext(root, baseline, 300_000),
      baseline,
    )
    expect(r.status).toBe('fail')
    expect(r.message).toContain('advisories')
  })

  it('missing audit (no lockfile) does not fail the gate and does not report advisories as measured', async () => {
    writeFileSync(join(root, 'src', 'ok.ts'), 'export const x = 1')
    const baseline = baselineNoFreshness()
    const r = await gateWith(null).run(createProjectContext(root, baseline, 300_000), baseline)
    expect(r.status).toBe('pass')
    expect(r.message).toContain('audit skipped')
    // advisories was not measured — reporting 0 would be a false "measured clean"
    expect(r.current).toEqual({ findings: 0 })
    expect('advisories' in r.current).toBe(false)
  })

  it('present audit reports measured advisories in current', async () => {
    writeFileSync(join(root, 'src', 'ok.ts'), 'export const x = 1')
    const baseline = baselineNoFreshness()
    const r = await gateWith(fixture('npm-audit-clean.json')).run(
      createProjectContext(root, baseline, 300_000),
      baseline,
    )
    expect(r.current).toEqual({ advisories: 0, findings: 0 })
  })

  it('present but unparseable audit becomes error — not a silent pass', async () => {
    writeFileSync(join(root, 'src', 'ok.ts'), 'export const x = 1')
    writeFileSync(join(root, 'package-lock.json'), '{}')
    const baseline = baselineNoFreshness()
    const r = await gateWith('garbage output').run(createProjectContext(root, baseline, 300_000), baseline)
    expect(r.status).toBe('error')
  })

  it('runs the audit from lockfileDir when it differs from rootPath', async () => {
    let seenCwd: string | undefined
    const fakeRun = async (_bin: string, _args: string[], opts: { cwd: string; timeoutMs: number }) => {
      seenCwd = opts.cwd
      return { exitCode: 0, stdout: fixture('npm-audit-clean.json'), stderr: '', timedOut: false, failed: false }
    }
    const baseline = baselineNoFreshness()
    const ctx = {
      ...createProjectContext(root, baseline, 300_000),
      rootPath: join(root, 'apps', 'web'),
      lockfileDir: root,
      packageManager: 'pnpm' as const,
    }
    await defaultRunAudit(ctx, fakeRun)
    expect(seenCwd).toBe(root)
  })

  it('marks the result as workspace-wide when lockfileDir differs from rootPath', async () => {
    writeFileSync(join(root, 'src', 'ok.ts'), 'export const x = 1')
    const baseline = baselineNoFreshness()
    const ctx = { ...createProjectContext(root, baseline, 300_000), lockfileDir: '/other/repo' }
    const r = await gateWith(fixture('npm-audit-clean.json')).run(ctx, baseline)
    expect(r.message).toContain('(workspace-wide audit)')
  })

  it('does NOT mark when lockfileDir equals rootPath or is null', async () => {
    writeFileSync(join(root, 'src', 'ok.ts'), 'export const x = 1')
    const baseline = baselineNoFreshness()
    const base = createProjectContext(root, baseline, 300_000)
    for (const lockfileDir of [root, null]) {
      const r = await gateWith(fixture('npm-audit-clean.json')).run({ ...base, lockfileDir }, baseline)
      expect(r.message).not.toContain('workspace-wide')
    }
  })
})
