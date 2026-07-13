import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Action, Gate, GateResult, ProjectContext } from '../types.js'
import { hasBiomeConfig, hasPrettierConfig } from '../detect.js'
import { runCommand, tailLines, type RunOptions, type RunResult } from '../process.js'
import { dirChain } from '../workspace.js'
import { suggestBaselineUpdate } from './improvement.js'

export interface ToolRunnerDeps {
  run?: (bin: string, args: string[], opts: RunOptions) => Promise<RunResult>
}

/**
 * Prettier only reads .prettierignore/.gitignore from its cwd — a root-level
 * ignore file (e.g. dist/) is invisible when the check runs in a workspace,
 * so it formats minified bundles. Collect every ignore file up to the repo
 * root as explicit --ignore-path flags (repeatable in prettier 3). Empty when
 * none exist, preserving prettier's defaults.
 */
export function prettierIgnoreArgs(ctx: ProjectContext): string[] {
  const args: string[] = []
  for (const dir of dirChain(ctx.rootPath, ctx.repoRoot)) {
    for (const name of ['.prettierignore', '.gitignore']) {
      const path = join(dir, name)
      if (existsSync(path)) args.push('--ignore-path', path)
    }
  }
  return args
}

/** Parser: prettier --list-different prints one path per line. */
export function parsePrettierListDifferent(stdout: string): string[] {
  return stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
}

/**
 * Parser: biome --reporter=json → diagnostics[].location.path.
 * Shape validated against real output (fixture biome-format-diagnostics.json):
 * biome 2.x uses `location.path` as a string; biome 1.x used `location.path.file`.
 * Only severity `error`/`fatal` counts (spec §5: biome lint warnings are NOT
 * errors); a diagnostic with no severity (legacy 1.x shape) counts as an error.
 */
export function parseBiomeDiagnostics(stdout: string): string[] {
  try {
    const parsed = JSON.parse(stdout) as {
      diagnostics?: Array<{ severity?: string; location?: { path?: string | { file?: string } } }>
    }
    return (parsed.diagnostics ?? [])
      .filter((d) => d.severity === undefined || d.severity === 'error' || d.severity === 'fatal')
      .map((d) => {
        const path = d.location?.path
        if (typeof path === 'string') return path
        return path?.file ?? '<unknown>'
      })
  } catch {
    return []
  }
}

interface ToolOutcome {
  files: string[]
  error: string | null
}

export function createStyleGate(deps: ToolRunnerDeps = {}): Gate {
  const run = deps.run ?? runCommand

  async function runPrettier(ctx: ProjectContext, bin: string): Promise<ToolOutcome> {
    const r = await run(bin, ['--list-different', ...prettierIgnoreArgs(ctx), '.'], {
      cwd: ctx.rootPath,
      timeoutMs: ctx.timeoutMs,
    })
    if (r.timedOut) return { files: [], error: 'prettier timed out' }
    // exit 0 = clean; exit 1 = differences (stdout has the files); other = crash
    if (r.exitCode === 0) return { files: [], error: null }
    const files = parsePrettierListDifferent(r.stdout)
    if (r.exitCode === 1 && files.length > 0) return { files, error: null }
    return { files: [], error: tailLines(r.stderr || r.stdout || 'prettier failed') }
  }

  async function runBiome(ctx: ProjectContext, bin: string): Promise<ToolOutcome> {
    const r = await run(bin, ['format', '--reporter=json', '.'], { cwd: ctx.rootPath, timeoutMs: ctx.timeoutMs })
    if (r.timedOut) return { files: [], error: 'biome timed out' }
    if (r.exitCode === 0) return { files: [], error: null }
    const files = parseBiomeDiagnostics(r.stdout)
    if (files.length > 0) return { files, error: null }
    return { files: [], error: tailLines(r.stderr || r.stdout || 'biome failed') }
  }

  return {
    name: 'style',
    label: 'Code Style',

    async run(ctx, baseline): Promise<GateResult> {
      const tools: Array<{ name: string; exec: (bin: string) => Promise<ToolOutcome>; bin: string | null }> = []
      if (hasPrettierConfig(ctx.rootPath, ctx.repoRoot)) {
        tools.push({ name: 'prettier', exec: (b) => runPrettier(ctx, b), bin: ctx.resolveTool('prettier') })
      }
      if (hasBiomeConfig(ctx.rootPath, ctx.repoRoot)) {
        tools.push({ name: 'biome', exec: (b) => runBiome(ctx, b), bin: ctx.resolveTool('biome') })
      }
      const runnable = tools.filter((t) => t.bin !== null)
      if (runnable.length === 0) {
        return {
          status: 'skip',
          message: tools.length === 0 ? 'no formatter configured' : 'formatter configured but binary not found',
          baseline: { violations: baseline.style.violations },
          current: {},
          actions: [],
        }
      }

      const files: string[] = []
      for (const tool of runnable) {
        const outcome = await tool.exec(tool.bin as string)
        if (outcome.error !== null) {
          return {
            status: 'error',
            message: `${tool.name}: ${outcome.error}`,
            baseline: { violations: baseline.style.violations },
            current: {},
            actions: [],
          }
        }
        files.push(...outcome.files)
      }

      const violations = files.length
      const base = { violations: baseline.style.violations }
      const current = { violations }
      if (violations <= baseline.style.violations) {
        const passActions =
          violations < baseline.style.violations
            ? [suggestBaselineUpdate('style', `style violations improved to ${violations} (baseline ${base.violations})`)]
            : []
        return { status: 'pass', message: `${violations} violations (baseline: ${base.violations})`, baseline: base, current, actions: passActions }
      }
      const actions: Action[] = [
        {
          gate: 'style',
          type: 'FIX STYLE',
          severity: 'block',
          priority: 2,
          message: `Fix ${violations} style violation(s) — run \`cliquet fix\``,
          files,
        },
      ]
      return { status: 'fail', message: `${violations} violations (baseline: ${base.violations})`, baseline: base, current, actions }
    },
  }
}

export const styleGate: Gate = createStyleGate()
