import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseJscpdReport, createDuplicationGate } from '../../../src/gates/duplication.js'
import { DEFAULT_BASELINE, type Baseline } from '../../../src/baseline.js'
import { createProjectContext } from '../../../src/context.js'

const fixture = readFileSync(
  join(import.meta.dirname, '..', '..', 'fixtures', 'outputs', 'jscpd-report.json'),
  'utf8',
)

describe('parseJscpdReport', () => {
  it('extrai percentage e pares de clones', () => {
    const r = parseJscpdReport(fixture)
    expect(r?.percentage).toBe(5.2)
    expect(r?.clones).toHaveLength(2)
    expect(r?.clones[0]).toBe('src/a.ts:10-50 <-> src/b.ts:100-140 (40L)')
  })
  it('retorna null para JSON inválido', () => {
    expect(parseJscpdReport('nope')).toBeNull()
  })
})

describe('duplicationGate', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cliquet-dup-'))
    mkdirSync(join(root, 'src'))
  })

  function baselineWith(pct: number): Baseline {
    return { ...DEFAULT_BASELINE, duplication: { percentage: pct, min_lines: 5, min_tokens: 50 } }
  }

  it('passa quando duplicação ≤ baseline (via runner fake que grava o report)', async () => {
    const gate = createDuplicationGate({
      runJscpd: async (_dirs, _opts, outputDir) => {
        writeFileSync(
          join(outputDir, 'jscpd-report.json'),
          JSON.stringify({ statistics: { total: { percentage: 1.1, clones: 0 } }, duplicates: [] }),
        )
        return null
      },
    })
    const baseline = baselineWith(2.0)
    const r = await gate.run(createProjectContext(root, baseline, 300_000), baseline)
    expect(r.status).toBe('pass')
    expect(r.current).toEqual({ percentage: 1.1, clones: 0 })
  })

  it('falha acima do baseline com pares de clones nas actions', async () => {
    const gate = createDuplicationGate({
      runJscpd: async (_dirs, _opts, outputDir) => {
        writeFileSync(join(outputDir, 'jscpd-report.json'), fixture)
        return null
      },
    })
    const baseline = baselineWith(2.0)
    const r = await gate.run(createProjectContext(root, baseline, 300_000), baseline)
    expect(r.status).toBe('fail')
    expect(r.actions[0]?.files).toHaveLength(2)
  })

  it('error quando o jscpd falha', async () => {
    const gate = createDuplicationGate({ runJscpd: async () => 'jscpd exploded' })
    const baseline = baselineWith(2.0)
    const r = await gate.run(createProjectContext(root, baseline, 300_000), baseline)
    expect(r.status).toBe('error')
  })

  describe('jscpd real (smoke)', () => {
    it('roda o binário embutido num diretório com duplicação óbvia', async () => {
      const dupBlock = Array.from({ length: 20 }, (_, i) => `export const v${i} = compute(${i}, "${i}")`).join('\n')
      writeFileSync(join(root, 'src', 'dup1.ts'), dupBlock)
      writeFileSync(join(root, 'src', 'dup2.ts'), dupBlock)
      const gate = createDuplicationGate() // sem deps → usa o jscpd real
      const baseline = baselineWith(2.0)
      const r = await gate.run(createProjectContext(root, baseline, 300_000), baseline)
      expect(r.status).toBe('fail')
      expect((r.current.percentage as number) > 2).toBe(true)
    }, 60_000)
  })
})
