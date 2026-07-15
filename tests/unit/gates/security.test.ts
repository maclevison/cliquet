import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSecurityGate,
  defaultRunAudit,
  collectInstalledPackages,
  type AuditCounts,
} from '../../../src/gates/security.js'
import { DEFAULT_BASELINE, type Baseline } from '../../../src/baseline.js'
import { createProjectContext } from '../../../src/context.js'

const CLEAN: AuditCounts = { criticalHigh: 0, total: 0 }
const VULNS: AuditCounts = { criticalHigh: 2, total: 3, packages: ['left-pad', 'minimist'] }

/** Writes node_modules/<name>/package.json under `base` (name may be scoped or a nested path). */
function installPkg(base: string, dirParts: string[], name: string, version: string): void {
  const dir = join(base, ...dirParts)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
}

describe('collectInstalledPackages', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cliquet-nm-'))
  })

  it('returns empty when there is no node_modules', () => {
    expect(collectInstalledPackages(root).size).toBe(0)
  })

  it('reads flat, scoped, and nested (npm/yarn) packages', () => {
    installPkg(root, ['node_modules', 'foo'], 'foo', '1.0.0')
    installPkg(root, ['node_modules', '@scope', 'bar'], '@scope/bar', '2.1.0')
    installPkg(root, ['node_modules', 'foo', 'node_modules', 'nested'], 'nested', '3.0.0')
    const got = collectInstalledPackages(root)
    expect(got.get('foo')).toEqual(new Set(['1.0.0']))
    expect(got.get('@scope/bar')).toEqual(new Set(['2.1.0']))
    expect(got.get('nested')).toEqual(new Set(['3.0.0']))
  })

  it('reaches pnpm real copies under .pnpm and does not cycle on the top-level symlink', () => {
    installPkg(root, ['node_modules', '.pnpm', 'minimist@1.2.0', 'node_modules', 'minimist'], 'minimist', '1.2.0')
    // pnpm's top-level entry is a symlink into .pnpm — the walk must skip it (isDirectory() === false)
    symlinkSync(
      join(root, 'node_modules', '.pnpm', 'minimist@1.2.0', 'node_modules', 'minimist'),
      join(root, 'node_modules', 'minimist'),
    )
    const got = collectInstalledPackages(root)
    expect(got.get('minimist')).toEqual(new Set(['1.2.0']))
    expect(got.size).toBe(1) // the symlink was not followed into a second entry
  })

  it('collapses multiple installed versions of one package into a set', () => {
    installPkg(root, ['node_modules', 'dup'], 'dup', '1.0.0')
    installPkg(root, ['node_modules', 'other', 'node_modules', 'dup'], 'dup', '2.0.0')
    expect(collectInstalledPackages(root).get('dup')).toEqual(new Set(['1.0.0', '2.0.0']))
  })
})

describe('defaultRunAudit (bulk advisory endpoint)', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cliquet-audit-'))
  })

  const ctxWith = (over: Partial<ReturnType<typeof createProjectContext>>) => ({
    ...createProjectContext(root, DEFAULT_BASELINE, 300_000),
    ...over,
  })

  it('returns null (skip) when there is no lockfile / package manager', async () => {
    expect(await defaultRunAudit(ctxWith({ packageManager: null }))).toBeNull()
  })

  it('returns null (skip) when deps are not installed (no node_modules)', async () => {
    expect(await defaultRunAudit(ctxWith({ packageManager: 'npm', lockfileDir: root }))).toBeNull()
  })

  it('returns null (skip) — NOT an error — when the endpoint/transport fails', async () => {
    installPkg(root, ['node_modules', 'foo'], 'foo', '1.0.0')
    const throwing = async () => {
      throw new Error('bulk advisory endpoint returned 500')
    }
    expect(await defaultRunAudit(ctxWith({ packageManager: 'pnpm', lockfileDir: root }), throwing)).toBeNull()
  })

  it('counts critical/high advisories from the bulk response and lists the affected packages', async () => {
    installPkg(root, ['node_modules', 'minimist'], 'minimist', '1.2.0')
    installPkg(root, ['node_modules', 'lodash'], 'lodash', '4.17.11')
    installPkg(root, ['node_modules', 'safe'], 'safe', '1.0.0')
    let received: Record<string, string[]> | undefined
    const fetcher = async (installed: Record<string, string[]>) => {
      received = installed
      return {
        minimist: [{ severity: 'critical' }, { severity: 'moderate' }],
        lodash: [{ severity: 'high' }],
      }
    }
    const counts = await defaultRunAudit(ctxWith({ packageManager: 'npm', lockfileDir: root }), fetcher)
    expect(counts).toEqual({ criticalHigh: 2, total: 3, packages: ['minimist', 'lodash'] })
    // it sent every installed package (including the one with no advisory)
    expect(received).toEqual({ minimist: ['1.2.0'], lodash: ['4.17.11'], safe: ['1.0.0'] })
  })

  it('walks node_modules under lockfileDir, not rootPath (monorepo)', async () => {
    installPkg(root, ['node_modules', 'foo'], 'foo', '1.0.0')
    let received: Record<string, string[]> | undefined
    const fetcher = async (installed: Record<string, string[]>) => {
      received = installed
      return {}
    }
    await defaultRunAudit(
      ctxWith({ packageManager: 'pnpm', rootPath: join(root, 'apps', 'web'), lockfileDir: root }),
      fetcher,
    )
    expect(received).toEqual({ foo: ['1.0.0'] })
  })
})

describe('securityGate', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cliquet-sec-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, '.gitignore'), '.env\n*.pem\n*.key\n')
  })

  function gateWith(audit: AuditCounts | null) {
    // injects a fake audit runner and disables package_freshness (network)
    return createSecurityGate({
      runAudit: async () => audit,
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
    const r = await gateWith(CLEAN).run(createProjectContext(root, baseline, 300_000), baseline)
    expect(r.status).toBe('pass')
  })

  it('fails with a finding from an enabled rule (zero tolerance)', async () => {
    writeFileSync(join(root, 'src', 'bad.ts'), 'eval(input)')
    const baseline = baselineNoFreshness()
    const r = await gateWith(CLEAN).run(createProjectContext(root, baseline, 300_000), baseline)
    expect(r.status).toBe('fail')
    expect(r.actions[0]?.files[0]).toContain('bad.ts:1')
  })

  it('does not run a rule disabled in the baseline', async () => {
    writeFileSync(join(root, 'src', 'bad.ts'), 'eval(input)')
    const baseline = baselineNoFreshness()
    baseline.security.rules.eval_usage = false
    const r = await gateWith(CLEAN).run(createProjectContext(root, baseline, 300_000), baseline)
    expect(r.status).toBe('pass')
  })

  it('emits a warn for a misplaced (unused) cliquet-ignore directive', async () => {
    writeFileSync(join(root, 'src', 'bad.ts'), 'eval(x) // cliquet-ignore-next-line eval_usage')
    const baseline = baselineNoFreshness()
    const r = await gateWith(CLEAN).run(createProjectContext(root, baseline, 300_000), baseline)
    const warn = r.actions.find((a) => a.type === 'UNUSED DIRECTIVE')
    expect(warn?.severity).toBe('warn')
    expect(warn?.files.some((f) => f.includes('eval_usage'))).toBe(true)
  })

  describe('security.suppress', () => {
    async function runWithSuppress(suppress: Record<string, string[]>, src: string) {
      writeFileSync(join(root, 'src', 'bad.ts'), src)
      const baseline = baselineNoFreshness()
      baseline.security.suppress = suppress
      return gateWith(CLEAN).run(createProjectContext(root, baseline, 300_000), baseline)
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
    const r = await gateWith(VULNS).run(createProjectContext(root, baseline, 300_000), baseline)
    expect(r.status).toBe('fail')
    expect(r.message).toContain('advisories')
    const block = r.actions.find((a) => a.type === 'FIX SEC' && a.message.includes('advisories'))
    expect(block?.files).toEqual(['left-pad', 'minimist']) // the affected packages, from the bulk response
  })

  it('advisory_ratchet=false: advisories never fail the gate and runAudit is not called', async () => {
    writeFileSync(join(root, 'src', 'ok.ts'), 'export const x = 1')
    let auditCalled = false
    const gate = createSecurityGate({
      runAudit: async () => {
        auditCalled = true
        return VULNS // 2 critical/high — would fail if ratcheted
      },
      freshnessFetcher: async () => ({ time: {} }),
    })
    const baseline = baselineNoFreshness()
    baseline.security.advisory_ratchet = false
    const r = await gate.run(createProjectContext(root, baseline, 300_000), baseline)
    expect(r.status).toBe('pass')
    expect(auditCalled).toBe(false)
    expect(r.message).toMatch(/advisory ratchet off/i)
    expect(r.message).not.toMatch(/unavailable/i)
  })

  it('unavailable audit (null) does not fail — advisories are not reported as measured', async () => {
    writeFileSync(join(root, 'src', 'ok.ts'), 'export const x = 1')
    const baseline = baselineNoFreshness()
    const r = await gateWith(null).run(createProjectContext(root, baseline, 300_000), baseline)
    expect(r.status).toBe('pass') // a broken/unavailable endpoint must never fail the check
    expect(r.message).toContain('advisory audit unavailable')
    // advisories was not measured — reporting 0 would be a false "measured clean"
    expect(r.current).toEqual({ findings: 0 })
    expect('advisories' in r.current).toBe(false)
  })

  it('present audit reports measured advisories in current', async () => {
    writeFileSync(join(root, 'src', 'ok.ts'), 'export const x = 1')
    const baseline = baselineNoFreshness()
    const r = await gateWith(CLEAN).run(createProjectContext(root, baseline, 300_000), baseline)
    expect(r.current).toEqual({ advisories: 0, findings: 0 })
  })

  it('marks the result as workspace-wide when lockfileDir differs from rootPath', async () => {
    writeFileSync(join(root, 'src', 'ok.ts'), 'export const x = 1')
    const baseline = baselineNoFreshness()
    const ctx = { ...createProjectContext(root, baseline, 300_000), lockfileDir: '/other/repo' }
    const r = await gateWith(CLEAN).run(ctx, baseline)
    expect(r.message).toContain('(workspace-wide audit)')
  })

  it('does NOT mark when lockfileDir equals rootPath or is null', async () => {
    writeFileSync(join(root, 'src', 'ok.ts'), 'export const x = 1')
    const baseline = baselineNoFreshness()
    const base = createProjectContext(root, baseline, 300_000)
    for (const lockfileDir of [root, null]) {
      const r = await gateWith(CLEAN).run({ ...base, lockfileDir }, baseline)
      expect(r.message).not.toContain('workspace-wide')
    }
  })
})
