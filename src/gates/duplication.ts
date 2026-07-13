import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import picomatch from 'picomatch'
import type { Gate, GateResult } from '../types.js'
import { runCommand, tailLines } from '../process.js'
import { listSourceFiles } from '../source-files.js'
import { toPosix } from '../context.js'
import { suggestBaselineUpdate } from './improvement.js'

export interface DuplicationReport {
  percentage: number
  clones: string[]
  /** true when the 0% was SYNTHESIZED (jscpd exited 0 without writing a report: nothing measurable), not measured. */
  synthesized: boolean
}

/** Marker written into the synthesized report so the 0% doesn't pass for a real measurement. */
export const SYNTHESIZED_REPORT_MARKER = '_cliquet_synthesized'

export function parseJscpdReport(raw: string): DuplicationReport | null {
  try {
    const parsed = JSON.parse(raw) as {
      statistics?: { total?: { percentage?: number } }
      duplicates?: Array<{
        lines: number
        firstFile: { name: string; start: number; end: number }
        secondFile: { name: string; start: number; end: number }
      }>
      [SYNTHESIZED_REPORT_MARKER]?: boolean
    }
    const percentage = parsed.statistics?.total?.percentage
    if (typeof percentage !== 'number') return null
    const clones = (parsed.duplicates ?? []).map(
      (d) =>
        `${d.firstFile.name}:${d.firstFile.start}-${d.firstFile.end} <-> ${d.secondFile.name}:${d.secondFile.start}-${d.secondFile.end} (${d.lines}L)`,
    )
    return { percentage, clones, synthesized: parsed[SYNTHESIZED_REPORT_MARKER] === true }
  } catch {
    return null
  }
}

interface JscpdOptions {
  minLines: number
  minTokens: number
  timeoutMs: number
  /** project root — report paths come out relative to it */
  cwd: string
  /** expanded `source_dirs.exclude` patterns (bare paths → [p, p/**]); fed to jscpd's --ignore. */
  ignorePatterns: string[]
  /** compiled ctx matcher (by reference — never recompiled here); absent = no ctx-level exclusion. */
  isExcluded?: (absPath: string) => boolean
}

/**
 * `jscpd`'s package.json declares an `exports` map without a `./bin/jscpd`
 * (or `./package.json`) subpath, so `require.resolve('jscpd/bin/jscpd')`
 * throws ERR_PACKAGE_PATH_NOT_EXPORTED. Resolve the package's main entry
 * instead (which IS exported) and walk up to the package root — a stable
 * bin/jscpd script lives there regardless of the internal dist/ layout.
 */
function resolveJscpdBin(): string | null {
  const require = createRequire(import.meta.url)
  let entry: string
  try {
    entry = require.resolve('jscpd')
  } catch {
    return null
  }
  let dir = dirname(entry)
  while (true) {
    const pkgJsonPath = join(dir, 'package.json')
    if (existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name?: string }
        if (pkg.name === 'jscpd') {
          const bin = join(dir, 'bin', 'jscpd')
          return existsSync(bin) ? bin : null
        }
      } catch {
        // malformed package.json — keep walking up
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Runs the bundled jscpd; returns null on success or the error message. */
type JscpdRunner = (dirs: string[], opts: JscpdOptions, outputDir: string) => Promise<string | null>

/**
 * Builds the full jscpd arg list after the bin path. `relativeDirs` must already be
 * relative to the invocation cwd (dot-dir segments break jscpd's fast-glob — see
 * `defaultRunJscpd`). `--ignore` is a single comma-joined flag (jscpd's format) and is
 * omitted entirely when there are no patterns.
 */
export function buildJscpdArgs(
  relativeDirs: string[],
  opts: Pick<JscpdOptions, 'minLines' | 'minTokens' | 'ignorePatterns'>,
  outputDir: string,
): string[] {
  const args = [
    ...relativeDirs,
    '--reporters', 'json',
    '--output', outputDir,
    '--min-lines', String(opts.minLines),
    '--min-tokens', String(opts.minTokens),
    '--silent',
  ]
  if (opts.ignorePatterns.length > 0) {
    args.push('--ignore', opts.ignorePatterns.join(','))
  }
  return args
}

/**
 * Mirrors jscpd's own over-broad ignore matching (verified in `@jscpd/finder@4.2.5`):
 * each `--ignore` pattern is additionally joined with every scanned dir (`join(scanDir,
 * pattern)`), so excluding `gen` also ignores `src/gen/**` when `src` is a scanned dir —
 * broader than the plain ctx matcher, which only matches from `rootPath`. Both `d/p` and
 * `d/p/**` are added per (scanDir, pattern) pair regardless of whether `p` already ends in
 * `/**` — harmless over-approximation, never a false green (see `hasMeasurableSource`).
 */
function jscpdVariantExcluded(
  cwd: string,
  relativeDirs: string[],
  ignorePatterns: string[],
): (absPath: string) => boolean {
  if (ignorePatterns.length === 0 || relativeDirs.length === 0) return () => false
  const variants = relativeDirs.flatMap((dir) =>
    ignorePatterns.flatMap((pattern) => [`${dir}/${pattern}`, `${dir}/${pattern}/**`]),
  )
  const isMatch = picomatch(variants, { dot: true })
  return (absPath: string) => isMatch(toPosix(relative(cwd, absPath)))
}

/**
 * true when at least one non-excluded source file has >= minLines lines (a clone could
 * exist). The sole caller composes `isExcluded` to OVER-approximate jscpd's exclusion
 * (ctx predicate OR jscpd's broader per-scanDir variant expansion). Direction matters:
 * over-approximating can only ever synthesize MORE 0% passes for files jscpd genuinely
 * ignored — it can never produce a false green for a file jscpd actually scanned (if
 * jscpd scanned anything measurable, a report exists and this guard never runs).
 */
function hasMeasurableSource(
  dirs: string[],
  minLines: number,
  isExcluded: (absPath: string) => boolean,
): boolean {
  return listSourceFiles(dirs, isExcluded).some(
    (file) => readFileSync(file, 'utf8').split('\n').length >= minLines,
  )
}

const defaultRunJscpd: JscpdRunner = async (dirs, opts, outputDir) => {
  const jscpdBin = resolveJscpdBin()
  if (jscpdBin === null) {
    return 'bundled jscpd binary not found'
  }
  // Paths RELATIVE to cwd: jscpd's fast-glob silently matches nothing when an
  // absolute input path contains a dot-dir segment (e.g. a git worktree under
  // .claude/worktrees/) — same class of problem as ESLint 9's absolute paths.
  const relativeDirs = dirs.map((dir) => {
    const rel = relative(opts.cwd, dir)
    return rel || '.'
  })
  const result = await runCommand(
    process.execPath,
    [jscpdBin, ...buildJscpdArgs(relativeDirs, opts, outputDir)],
    { cwd: opts.cwd, timeoutMs: opts.timeoutMs },
  )
  if (result.timedOut) return 'jscpd timed out'
  if (!existsSync(join(outputDir, 'jscpd-report.json'))) {
    // jscpd exits 0 but skips writing a report when every source file is
    // shorter than --min-lines (nothing could ever qualify as a clone) —
    // not a tool failure, just "0% duplication, nothing measurable". The
    // marker keeps this synthesized 0% distinguishable from a measured one.
    // GUARD: only synthesize when nothing is measurable. If measurable files
    // exist and jscpd still saw none, its glob missed them — a ratchet must
    // surface that as an ERROR, never as a silent 0% pass.
    // Compose the guard predicate to over-approximate jscpd (see hasMeasurableSource):
    // a file counts as measurable only when excluded by NEITHER the ctx matcher NOR
    // jscpd's broader per-scanDir variant expansion.
    const ctxExcluded = opts.isExcluded ?? (() => false)
    const jscpdExcluded = jscpdVariantExcluded(opts.cwd, relativeDirs, opts.ignorePatterns)
    if (
      result.exitCode === 0 &&
      hasMeasurableSource(dirs, opts.minLines, (f) => ctxExcluded(f) || jscpdExcluded(f))
    ) {
      return `jscpd matched no files although measurable sources exist (glob mismatch). ${tailLines(result.stderr || result.stdout || '', 3)}`.trim()
    }
    if (result.exitCode === 0) {
      writeFileSync(
        join(outputDir, 'jscpd-report.json'),
        JSON.stringify({
          statistics: { total: { percentage: 0 } },
          duplicates: [],
          [SYNTHESIZED_REPORT_MARKER]: true,
        }),
      )
      return null
    }
    return tailLines(result.stderr || result.stdout || 'jscpd produced no report')
  }
  return null
}

export interface DuplicationGateDeps {
  runJscpd?: JscpdRunner
}

export function createDuplicationGate(deps: DuplicationGateDeps = {}): Gate {
  const runJscpd = deps.runJscpd ?? defaultRunJscpd

  return {
    name: 'duplication',
    label: 'Duplication',

    async run(ctx, baseline): Promise<GateResult> {
      const { percentage: maxPct, min_lines, min_tokens } = baseline.duplication
      const base = { percentage: maxPct }
      const outputDir = mkdtempSync(join(tmpdir(), 'cliquet-jscpd-'))
      let report: DuplicationReport | null
      try {
        const error = await runJscpd(
          ctx.sourceDirs,
          {
            minLines: min_lines,
            minTokens: min_tokens,
            timeoutMs: ctx.timeoutMs,
            cwd: ctx.rootPath,
            ignorePatterns: ctx.excludePatterns,
            isExcluded: ctx.isExcluded,
          },
          outputDir,
        )
        if (error !== null) {
          return { status: 'error', message: `jscpd: ${error}`, baseline: base, current: {}, actions: [] }
        }
        report = parseJscpdReport(readFileSync(join(outputDir, 'jscpd-report.json'), 'utf8'))
      } finally {
        rmSync(outputDir, { recursive: true, force: true })
      }
      if (report === null) {
        return { status: 'error', message: 'jscpd report is malformed', baseline: base, current: {}, actions: [] }
      }
      const current = { percentage: report.percentage, clones: report.clones.length }
      if (report.percentage <= maxPct) {
        // Suggest an update only with a real MEASUREMENT below the baseline — the
        // synthesized 0% didn't measure anything and shouldn't induce a ratchet to 0.
        const passActions =
          !report.synthesized && report.percentage < maxPct
            ? [suggestBaselineUpdate('duplication', `duplication improved to ${report.percentage.toFixed(2)}% (baseline ${maxPct.toFixed(2)}%)`)]
            : []
        return {
          status: 'pass',
          message: report.synthesized
            ? '0.00% (nothing measurable: all files below min_lines)'
            : `${report.percentage.toFixed(2)}% (baseline: ${maxPct.toFixed(2)}%, ${report.clones.length} clones)`,
          baseline: base,
          current,
          actions: passActions,
        }
      }
      return {
        status: 'fail',
        message: `${report.percentage.toFixed(2)}% (baseline: ${maxPct.toFixed(2)}%, ${report.clones.length} clones)`,
        baseline: base,
        current,
        actions: [
          {
            gate: 'duplication',
            type: 'REFACTOR DUP',
            severity: 'block',
            priority: 3,
            message: `Duplication increased to ${report.percentage.toFixed(2)}% (baseline ${maxPct.toFixed(2)}%)`,
            files: report.clones,
          },
        ],
      }
    },
  }
}

export const duplicationGate: Gate = createDuplicationGate()
