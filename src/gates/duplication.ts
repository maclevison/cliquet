import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Gate, GateResult } from '../types.js'
import { runCommand, tailLines } from '../process.js'

export interface DuplicationReport {
  percentage: number
  clones: string[]
}

export function parseJscpdReport(raw: string): DuplicationReport | null {
  try {
    const parsed = JSON.parse(raw) as {
      statistics?: { total?: { percentage?: number } }
      duplicates?: Array<{
        lines: number
        firstFile: { name: string; start: number; end: number }
        secondFile: { name: string; start: number; end: number }
      }>
    }
    const percentage = parsed.statistics?.total?.percentage
    if (typeof percentage !== 'number') return null
    const clones = (parsed.duplicates ?? []).map(
      (d) =>
        `${d.firstFile.name}:${d.firstFile.start}-${d.firstFile.end} <-> ${d.secondFile.name}:${d.secondFile.start}-${d.secondFile.end} (${d.lines}L)`,
    )
    return { percentage, clones }
  } catch {
    return null
  }
}

interface JscpdOptions {
  minLines: number
  minTokens: number
  timeoutMs: number
  /** raiz do projeto — os paths do relatório saem relativos a ela */
  cwd: string
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
        // package.json malformado — segue subindo
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Executa o jscpd embutido; retorna null em sucesso ou a mensagem de erro. */
type JscpdRunner = (dirs: string[], opts: JscpdOptions, outputDir: string) => Promise<string | null>

const defaultRunJscpd: JscpdRunner = async (dirs, opts, outputDir) => {
  const jscpdBin = resolveJscpdBin()
  if (jscpdBin === null) {
    return 'bundled jscpd binary not found'
  }
  const result = await runCommand(
    process.execPath,
    [
      jscpdBin,
      ...dirs,
      '--reporters', 'json',
      '--output', outputDir,
      '--min-lines', String(opts.minLines),
      '--min-tokens', String(opts.minTokens),
      '--silent',
    ],
    { cwd: opts.cwd, timeoutMs: opts.timeoutMs },
  )
  if (result.timedOut) return 'jscpd timed out'
  if (!existsSync(join(outputDir, 'jscpd-report.json'))) {
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
      const error = await runJscpd(
        ctx.sourceDirs,
        { minLines: min_lines, minTokens: min_tokens, timeoutMs: ctx.timeoutMs, cwd: ctx.rootPath },
        outputDir,
      )
      if (error !== null) {
        return { status: 'error', message: `jscpd: ${error}`, baseline: base, current: {}, actions: [] }
      }
      const report = parseJscpdReport(readFileSync(join(outputDir, 'jscpd-report.json'), 'utf8'))
      if (report === null) {
        return { status: 'error', message: 'jscpd report is malformed', baseline: base, current: {}, actions: [] }
      }
      const current = { percentage: report.percentage, clones: report.clones.length }
      if (report.percentage <= maxPct) {
        return {
          status: 'pass',
          message: `${report.percentage.toFixed(2)}% (baseline: ${maxPct.toFixed(2)}%, ${report.clones.length} clones)`,
          baseline: base,
          current,
          actions: [],
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
