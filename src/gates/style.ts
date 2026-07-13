import type { Action, Gate, GateResult, ProjectContext } from '../types.js'
import { hasBiomeConfig, hasPrettierConfig } from '../detect.js'
import { runCommand, tailLines, type RunResult } from '../process.js'

export interface ToolRunnerDeps {
  run?: (bin: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<RunResult>
}

/** Parser: prettier --list-different imprime um path por linha. */
export function parsePrettierListDifferent(stdout: string): string[] {
  return stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
}

/** Parser: biome --reporter=json → diagnostics[].location.path.file. */
export function parseBiomeDiagnostics(stdout: string): string[] {
  try {
    const parsed = JSON.parse(stdout) as { diagnostics?: Array<{ location?: { path?: { file?: string } } }> }
    return (parsed.diagnostics ?? []).map((d) => d.location?.path?.file ?? '<unknown>')
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
    const r = await run(bin, ['--list-different', '.'], { cwd: ctx.rootPath, timeoutMs: ctx.timeoutMs })
    if (r.timedOut) return { files: [], error: 'prettier timed out' }
    // exit 0 = limpo; exit 1 = diferenças (stdout tem os arquivos); outros = crash
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
      if (hasPrettierConfig(ctx.rootPath)) {
        tools.push({ name: 'prettier', exec: (b) => runPrettier(ctx, b), bin: ctx.resolveTool('prettier') })
      }
      if (hasBiomeConfig(ctx.rootPath)) {
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
        return { status: 'pass', message: `${violations} violations (baseline: ${base.violations})`, baseline: base, current, actions: [] }
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
