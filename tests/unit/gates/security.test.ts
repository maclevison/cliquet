import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseNpmAudit, parseYarnAudit, createSecurityGate } from '../../../src/gates/security.js'
import { DEFAULT_BASELINE, type Baseline } from '../../../src/baseline.js'
import { createProjectContext } from '../../../src/context.js'

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'outputs', name), 'utf8')

describe('parseNpmAudit', () => {
  it('extrai critical+high do metadata', () => {
    expect(parseNpmAudit(fixture('npm-audit-with-vulns.json'))).toEqual({ criticalHigh: 2, total: 3 })
    expect(parseNpmAudit(fixture('npm-audit-clean.json'))).toEqual({ criticalHigh: 0, total: 0 })
  })

  it('retorna null para JSON inválido', () => {
    expect(parseNpmAudit('not json')).toBeNull()
  })
})

describe('parseYarnAudit', () => {
  it('extrai critical+high da linha auditSummary (NDJSON do yarn classic)', () => {
    const ndjson = [
      JSON.stringify({ type: 'info', data: 'x' }),
      JSON.stringify({ type: 'auditSummary', data: { vulnerabilities: { info: 0, low: 1, moderate: 0, high: 1, critical: 1 } } }),
    ].join('\n')
    expect(parseYarnAudit(ndjson)).toEqual({ criticalHigh: 2, total: 3 })
  })
  it('retorna null sem linha auditSummary', () => {
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
    // injeta um runner de audit fake e desabilita package_freshness (rede)
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

  it('passa em projeto limpo', async () => {
    writeFileSync(join(root, 'src', 'ok.ts'), 'export const x = 1')
    const baseline = baselineNoFreshness()
    const r = await gateWith(fixture('npm-audit-clean.json')).run(
      createProjectContext(root, baseline, 300_000),
      baseline,
    )
    expect(r.status).toBe('pass')
  })

  it('falha com finding de regra habilitada (tolerância zero)', async () => {
    writeFileSync(join(root, 'src', 'bad.ts'), 'eval(input)')
    const baseline = baselineNoFreshness()
    const r = await gateWith(fixture('npm-audit-clean.json')).run(
      createProjectContext(root, baseline, 300_000),
      baseline,
    )
    expect(r.status).toBe('fail')
    expect(r.actions[0]?.files[0]).toContain('bad.ts:1')
  })

  it('não roda regra desabilitada no baseline', async () => {
    writeFileSync(join(root, 'src', 'bad.ts'), 'eval(input)')
    const baseline = baselineNoFreshness()
    baseline.security.rules.eval_usage = false
    const r = await gateWith(fixture('npm-audit-clean.json')).run(
      createProjectContext(root, baseline, 300_000),
      baseline,
    )
    expect(r.status).toBe('pass')
  })

  it('falha quando advisories critical/high excedem o baseline', async () => {
    writeFileSync(join(root, 'src', 'ok.ts'), 'export const x = 1')
    const baseline = baselineNoFreshness()
    const r = await gateWith(fixture('npm-audit-with-vulns.json')).run(
      createProjectContext(root, baseline, 300_000),
      baseline,
    )
    expect(r.status).toBe('fail')
    expect(r.message).toContain('advisories')
  })

  it('audit ausente (sem lockfile) não falha a gate', async () => {
    writeFileSync(join(root, 'src', 'ok.ts'), 'export const x = 1')
    const baseline = baselineNoFreshness()
    const r = await gateWith(null).run(createProjectContext(root, baseline, 300_000), baseline)
    expect(r.status).toBe('pass')
    expect(r.message).toContain('audit skipped')
  })

  it('audit presente mas imparseável vira error — não pass silencioso', async () => {
    writeFileSync(join(root, 'src', 'ok.ts'), 'export const x = 1')
    writeFileSync(join(root, 'package-lock.json'), '{}')
    const baseline = baselineNoFreshness()
    const r = await gateWith('garbage output').run(createProjectContext(root, baseline, 300_000), baseline)
    expect(r.status).toBe('error')
  })
})
