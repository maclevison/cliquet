import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseJscpdReport, createDuplicationGate, buildJscpdArgs } from '../../../src/gates/duplication.js'
import { DEFAULT_BASELINE, type Baseline } from '../../../src/baseline.js'
import { createProjectContext } from '../../../src/context.js'

const fixture = readFileSync(
  join(import.meta.dirname, '..', '..', 'fixtures', 'outputs', 'jscpd-report.json'),
  'utf8',
)

describe('parseJscpdReport', () => {
  it('extracts percentage and clone pairs', () => {
    const r = parseJscpdReport(fixture)
    expect(r?.percentage).toBe(5.2)
    expect(r?.clones).toHaveLength(2)
    expect(r?.clones[0]).toBe('src/a.ts:10-50 <-> src/b.ts:100-140 (40L)')
  })
  it('returns null for invalid JSON', () => {
    expect(parseJscpdReport('nope')).toBeNull()
  })
})

describe('buildJscpdArgs', () => {
  it('passes the expanded exclude patterns to jscpd via --ignore', () => {
    expect(buildJscpdArgs(['src'], { minLines: 5, minTokens: 50, ignorePatterns: ['gen', 'gen/**'] }, '/tmp/out')).toEqual(
      expect.arrayContaining(['--ignore', 'gen,gen/**']),
    )
  })

  it('omits --ignore entirely when there are no patterns', () => {
    const args = buildJscpdArgs(['src'], { minLines: 5, minTokens: 50, ignorePatterns: [] }, '/tmp/out')
    expect(args).not.toEqual(expect.arrayContaining(['--ignore']))
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

  function baselineWithExclude(exclude: string[]): Baseline {
    return {
      ...DEFAULT_BASELINE,
      source_dirs: { ...DEFAULT_BASELINE.source_dirs, exclude },
      duplication: { percentage: 2.0, min_lines: 5, min_tokens: 50 },
    }
  }

  function ctxWithExclude(exclude: string[]) {
    return createProjectContext(root, baselineWithExclude(exclude), 300_000)
  }

  it('passes when duplication ≤ baseline (via a fake runner that writes the report)', async () => {
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

  it('fails above the baseline with clone pairs in the actions', async () => {
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

  it('errors when jscpd fails', async () => {
    const gate = createDuplicationGate({ runJscpd: async () => 'jscpd exploded' })
    const baseline = baselineWith(2.0)
    const r = await gate.run(createProjectContext(root, baseline, 300_000), baseline)
    expect(r.status).toBe('error')
  })

  describe('jscpd real (smoke)', () => {
    it('runs the bundled binary on a directory with obvious duplication', async () => {
      const dupBlock = Array.from({ length: 20 }, (_, i) => `export const v${i} = compute(${i}, "${i}")`).join('\n')
      writeFileSync(join(root, 'src', 'dup1.ts'), dupBlock)
      writeFileSync(join(root, 'src', 'dup2.ts'), dupBlock)
      const gate = createDuplicationGate() // no deps → uses the real jscpd
      const baseline = baselineWith(2.0)
      const r = await gate.run(createProjectContext(root, baseline, 300_000), baseline)
      expect(r.status).toBe('fail')
      expect((r.current.percentage as number) > 2).toBe(true)
    }, 60_000)

    it('passes with a synthesized 0% and a marker in the message when every file is below min_lines (jscpd writes no report)', async () => {
      writeFileSync(join(root, 'src', 'tiny.js'), 'export const x = 1\n')
      const gate = createDuplicationGate() // no deps → uses the real jscpd
      const baseline = baselineWith(2.0)
      const r = await gate.run(createProjectContext(root, baseline, 300_000), baseline)
      expect(r.status).toBe('pass')
      expect(r.current).toEqual({ percentage: 0, clones: 0 })
      // synthesized 0% (nothing measurable) needs to be distinguishable from a measured 0%
      expect(r.message).toContain('nothing measurable: all files below min_lines')
    }, 60_000)

    it('MEASURES duplication when the project path contains a dot-dir segment (git worktrees under .claude/)', async () => {
      // regression: fast-glob (inside jscpd) silently matches nothing when the
      // absolute input path has a dot-dir segment → exit 0, no report → the old
      // code synthesized a 0% PASS. A ratchet must never false-green.
      const base = mkdtempSync(join(tmpdir(), 'cliquet-dup-dot-'))
      const dotRoot = join(base, '.claude', 'worktrees', 'wt1')
      mkdirSync(join(dotRoot, 'src'), { recursive: true })
      const dupBlock = Array.from({ length: 20 }, (_, i) => `export const v${i} = compute(${i}, "${i}")`).join('\n')
      writeFileSync(join(dotRoot, 'src', 'dup1.ts'), dupBlock)
      writeFileSync(join(dotRoot, 'src', 'dup2.ts'), dupBlock)
      const gate = createDuplicationGate()
      const baseline = baselineWith(2.0)
      const r = await gate.run(createProjectContext(dotRoot, baseline, 300_000), baseline)
      expect(r.status).toBe('fail')
      expect((r.current.percentage as number) > 2).toBe(true)
    }, 60_000)

    it('guard over-approximation: duplication ONLY inside src/gen with exclude ["gen"] does not ERROR (real jscpd)', async () => {
      // jscpd scans "src" and joins the scanDir with each --ignore pattern, so
      // exclude ["gen"] (expanded to "gen","gen/**") ends up ignoring "src/gen/**"
      // too — broader than the plain ctx matcher, which only excludes top-level
      // "gen". jscpd finds nothing to scan under src → exit 0, no report. The
      // guard must recognize these files as excluded the same way, or it wrongly
      // reports a "glob mismatch" error instead of a synthesized 0% pass.
      const dupBlock = Array.from({ length: 20 }, (_, i) => `export const v${i} = compute(${i}, "${i}")`).join('\n')
      mkdirSync(join(root, 'src', 'gen'))
      writeFileSync(join(root, 'src', 'gen', 'dup1.ts'), dupBlock)
      writeFileSync(join(root, 'src', 'gen', 'dup2.ts'), dupBlock)
      const gate = createDuplicationGate()
      const r = await gate.run(ctxWithExclude(['gen']), baselineWithExclude(['gen']))
      expect(r.status).toBe('pass')
    }, 60_000)

    it('exclude ["gen"] with duplication OUTSIDE gen still measures (real jscpd)', async () => {
      const dupBlock = Array.from({ length: 20 }, (_, i) => `export const v${i} = compute(${i}, "${i}")`).join('\n')
      writeFileSync(join(root, 'src', 'dup1.ts'), dupBlock)
      writeFileSync(join(root, 'src', 'dup2.ts'), dupBlock)
      mkdirSync(join(root, 'src', 'gen'))
      const genDupBlock = Array.from({ length: 20 }, (_, i) => `export const g${i} = otherCompute(${i}, "${i}")`).join('\n')
      writeFileSync(join(root, 'src', 'gen', 'also-dup1.ts'), genDupBlock)
      writeFileSync(join(root, 'src', 'gen', 'also-dup2.ts'), genDupBlock)
      const gate = createDuplicationGate()
      const r = await gate.run(ctxWithExclude(['gen']), baselineWithExclude(['gen']))
      expect(r.status).toBe('fail')
      expect((r.current.percentage as number) > 2).toBe(true)
      // gen pair is excluded from measurement: only the src/dup1↔dup2 clone is reported
      expect(r.current.clones).toBe(1)
      expect(r.actions[0]?.files.some((f) => f.includes('gen'))).toBe(false)
    }, 60_000)
  })
})
