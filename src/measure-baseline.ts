import { DEFAULT_BASELINE, type Baseline } from './baseline.js'
import type { CheckResult, GateReport } from './types.js'

export interface MeasuredBaseline {
  baseline: Baseline
  /** Informational (e.g. coverage floored to 0) — shown, but does not fail init. */
  notes: string[]
  /** Count gates that ERRORED during measurement — the baseline is partial and must not be trusted
   *  silently (caller warns loudly AND exits non-zero). */
  errored: string[]
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
const firstLine = (s: string): string => (s.split('\n')[0] ?? '').slice(0, 120)

/** Count/ratio gates whose measured `current` becomes the ratchet floor. Coverage is handled
 *  separately (unmeasurable → floor 0). bundle_size is NOT here — it skips at the default 0, so the
 *  caller direct-measures it. */
const COUNT_GATES: Array<{ name: string; read: (c: Record<string, unknown>) => number | undefined; set: (b: Baseline, v: number) => void }> = [
  { name: 'security', read: (c) => num(c.advisories), set: (b, v) => (b.security.advisories = v) },
  { name: 'style', read: (c) => num(c.violations), set: (b, v) => (b.style.violations = v) },
  { name: 'static_analysis', read: (c) => num(c.errors), set: (b, v) => (b.static_analysis.errors = v) },
  { name: 'duplication', read: (c) => num(c.percentage), set: (b, v) => (b.duplication.percentage = v) },
  { name: 'performance', read: (c) => num(c.violations), set: (b, v) => (b.performance.violations = v) },
]

/**
 * Maps a measured `check` run onto a baseline: each count/ratio gate's `current` becomes its floor,
 * so the next `check` ties its own measurement (the ratchet starts from where the code is). Pure —
 * the caller runs the gates and direct-measures bundle. Rules (spec §A/§C/§D):
 * - count gate pass/fail → record the measured number; SKIP → keep default (the gate is inert);
 *   ERROR → keep default AND flag it (partial baseline, caller must be loud + non-zero).
 * - security advisories absent (audit skipped, no lockfile) → keep default, NOT an error.
 * - coverage unmeasurable (error/skip) → floor 0 + note (base 0 always passes, so legacy adopts).
 * - security content FINDINGS are never snapshotted (fix / disable / suppress).
 */
export function applyMeasuredBaseline(result: CheckResult): MeasuredBaseline {
  const baseline = structuredClone(DEFAULT_BASELINE)
  const notes: string[] = []
  const errored: string[] = []
  const gate = (name: string): GateReport | undefined => result.gates.find((g) => g.name === name)

  for (const spec of COUNT_GATES) {
    const g = gate(spec.name)
    if (!g || g.status === 'skip') continue // keep default
    if (g.status === 'error') {
      errored.push(`${spec.name}: ${firstLine(g.message)} — left at default; fix and re-run init`)
      continue
    }
    const v = spec.read(g.current)
    if (v !== undefined) spec.set(baseline, v)
  }

  // Threshold gates: grandfather each measured offender into its `allow` map; the THRESHOLD stays at
  // the default (a NEW oversized file/function is still caught — only the existing ones are held).
  const fs = gate('file_size')
  if (fs && (fs.status === 'pass' || fs.status === 'fail')) {
    const offenders = fs.current.offenders
    if (Array.isArray(offenders)) {
      for (const o of offenders as Array<{ file: string; lines: number }>) baseline.file_size.allow[o.file] = o.lines
    }
  }
  const cx = gate('complexity')
  if (cx && (cx.status === 'pass' || cx.status === 'fail')) {
    const over = cx.current.over_block
    if (Array.isArray(over)) {
      for (const o of over as Array<{ id: string; ccn: number }>) baseline.complexity.allow[o.id] = o.ccn
    }
  }

  // Security content findings are zero-tolerance and NOT snapshotted as a floor — so a measured
  // baseline can still make the first `check` red. Warn explicitly so the user knows why.
  const sec = gate('security')
  const findings = sec ? num(sec.current.findings) : undefined
  if (findings !== undefined && findings > 0) {
    notes.push(
      `${findings} security finding(s) are zero-tolerance (not baselined) and will still fail \`check\` — fix them, disable the rule in security.rules, or suppress (security.suppress / // cliquet-ignore)`,
    )
  }

  const cov = gate('coverage')
  if (cov) {
    const pct = cov.status === 'pass' || cov.status === 'fail' ? num(cov.current.percentage) : undefined
    if (pct !== undefined) {
      baseline.coverage.percentage = pct
    } else {
      baseline.coverage.percentage = 0
      notes.push(`coverage: not measurable (${firstLine(cov.message) || cov.status}) — floor set to 0; raise it once tests run`)
    }
  }

  return { baseline, notes, errored }
}
