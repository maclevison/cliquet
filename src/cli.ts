import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Command } from 'commander'
import {
  BASELINE_FILENAME,
  ConfigError,
  DEFAULT_BASELINE,
  baselineExists,
  loadBaseline,
  saveBaseline,
  type Baseline,
} from './baseline.js'
import { createProjectContext } from './context.js'
import { isAiAgent } from './agent-detector.js'
import { runCheck } from './runner.js'
import { formatJson } from './output/json.js'
import { formatHuman } from './output/human.js'
import { formatGithub } from './output/github.js'
import { createStyleFixer } from './fixers/style.js'
import { createLintFixer } from './fixers/lint.js'
import { createPerformanceFixer } from './fixers/performance.js'
import { findDistDir, measureBundle } from './gates/bundle-size.js'
import { parseCoverageSummary } from './gates/coverage.js'
import type { CheckResult } from './types.js'

export interface Io {
  stdout: (s: string) => void
  stderr: (s: string) => void
}

// Fonte única da versão: o package.json fica um nível acima tanto de src/ (dev,
// via vitest) quanto de dist/ (bin compilado), então '..' resolve nos dois casos.
const CLI_VERSION = (
  JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string }
).version

interface GlobalOpts {
  path: string
  format: 'human' | 'json' | 'json-pretty' | 'github'
  plain: boolean
  timeoutMs: number
}

function resolveGlobalOpts(cmd: Command, env: Record<string, string | undefined>): GlobalOpts {
  const opts = cmd.optsWithGlobals() as { path?: string; format?: string; plain?: boolean; timeout?: string }
  const path = resolve(opts.path ?? process.cwd())
  if (!existsSync(path)) throw new ConfigError(`--path não existe: ${path}`)
  const format = (opts.format ?? (isAiAgent(env) ? 'json' : 'human')) as GlobalOpts['format']
  if (!['human', 'json', 'json-pretty', 'github'].includes(format)) {
    throw new ConfigError(`--format inválido: ${format}`)
  }
  const timeoutSeconds = opts.timeout ? Number(opts.timeout) : 300
  if (timeoutSeconds <= 0 || Number.isNaN(timeoutSeconds)) throw new ConfigError(`--timeout inválido: ${opts.timeout}`)
  return { path, format, plain: opts.plain ?? false, timeoutMs: timeoutSeconds * 1000 }
}

function render(result: CheckResult, opts: GlobalOpts): string {
  switch (opts.format) {
    case 'json':
      return formatJson(result, { pretty: false })
    case 'json-pretty':
      return formatJson(result, { pretty: true })
    case 'github':
      return formatGithub(result)
    default:
      return formatHuman(result, { plain: opts.plain })
  }
}

/** init mede coverage/bundle se houver artefatos no disco (spec §4). */
function measuredBaseline(rootPath: string): Baseline {
  const baseline = structuredClone(DEFAULT_BASELINE)
  const summaryPath = join(rootPath, 'coverage', 'coverage-summary.json')
  if (existsSync(summaryPath)) {
    const pct = parseCoverageSummary(readFileSync(summaryPath, 'utf8'))
    if (pct !== null) baseline.coverage.percentage = pct
  }
  const distDir = findDistDir(rootPath, baseline.bundle_size.dist_dirs)
  if (distDir !== null) {
    const m = measureBundle(distDir)
    baseline.bundle_size.max_total_gzip_kb = Math.ceil(m.totalGzipKb)
  }
  return baseline
}

async function doCheck(opts: GlobalOpts, io: Io, runFixersFirst: boolean): Promise<number> {
  if (!baselineExists(opts.path)) {
    saveBaseline(opts.path, measuredBaseline(opts.path)) // auto-create (spec §4)
    io.stderr(`${BASELINE_FILENAME} criado com defaults\n`)
  }
  const baseline = loadBaseline(opts.path)
  const ctx = createProjectContext(opts.path, baseline, opts.timeoutMs)

  let result = await runCheck(ctx, baseline)
  if (result.result === 'fail' && runFixersFirst) {
    await runAllFixers(ctx, io)
    result = await runCheck(ctx, baseline) // exit code reflete o segundo check (spec §3)
  }
  io.stdout(render(result, opts))
  return result.result === 'pass' ? 0 : 1
}

async function runAllFixers(ctx: ReturnType<typeof createProjectContext>, io: Io): Promise<void> {
  for (const fixer of [createStyleFixer(), createLintFixer(), createPerformanceFixer()]) {
    const outcome = await fixer.run(ctx)
    io.stderr(`fixer ${fixer.name}: ${outcome.applied ? outcome.message : `skipped (${outcome.message})`}\n`)
  }
}

export async function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  io: Io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) },
): Promise<number> {
  const program = new Command()
  let exitCode = 0

  program
    .name('cliquet')
    .description('Quality gate CLI — metrics can only improve, never regress')
    .version(CLI_VERSION)
    .option('--path <dir>', 'project root (default: cwd)')
    .option('--format <format>', 'human | json | json-pretty | github')
    .option('--plain', 'disable ANSI colors')
    .option('--timeout <seconds>', 'per-gate timeout (default: 300)')
    .exitOverride() // não deixa o commander chamar process.exit
    // Roteia help/version/erros de parsing do commander pelo io (testável e
    // consistente com o resto da saída). Configurado ANTES dos .command() abaixo,
    // que copiam a configuração de output do pai na criação.
    .configureOutput({
      writeOut: (s) => io.stdout(s),
      writeErr: (s) => io.stderr(s),
    })

  program
    .command('init')
    .description('create cliquet.baseline.json with default thresholds')
    .option('--force', 'overwrite existing baseline without asking')
    .action(async (cmdOpts: { force?: boolean }, cmd: Command) => {
      const opts = resolveGlobalOpts(cmd, env)
      if (!cmdOpts.force && baselineExists(opts.path)) {
        io.stderr(`${BASELINE_FILENAME} já existe — use --force para sobrescrever\n`)
        exitCode = 2
        return
      }
      saveBaseline(opts.path, measuredBaseline(opts.path))
      io.stdout(`${BASELINE_FILENAME} criado\n`)
    })

  program
    .command('check')
    .description('run all gates and compare against the baseline')
    .option('--fix', 'run fixers if any gate fails, then re-check')
    .action(async (cmdOpts: { fix?: boolean }, cmd: Command) => {
      const opts = resolveGlobalOpts(cmd, env)
      exitCode = await doCheck(opts, io, cmdOpts.fix ?? false)
    })

  program
    .command('fix')
    .description('run auto-fixers (style, lint, performance), then check')
    .option('--no-check', 'skip the automatic check after fixing')
    .action(async (cmdOpts: { check: boolean }, cmd: Command) => {
      const opts = resolveGlobalOpts(cmd, env)
      const baseline = baselineExists(opts.path) ? loadBaseline(opts.path) : DEFAULT_BASELINE
      const ctx = createProjectContext(opts.path, baseline, opts.timeoutMs)
      await runAllFixers(ctx, io)
      if (cmdOpts.check) exitCode = await doCheck(opts, io, false)
    })

  try {
    await program.parseAsync(argv)
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'commander.helpDisplayed' || code === 'commander.help' || code === 'commander.version') {
      return 0 // --help/--version não são erro
    }
    if (err instanceof ConfigError) {
      // uso/configuração incorretos (baseline inválido, --path inexistente…): só a mensagem
      io.stderr(`${err.message}\n`)
      return 2
    }
    if (typeof code === 'string' && code.startsWith('commander.')) {
      // erro de parsing do commander (flag inválida etc.) — a mensagem já foi
      // escrita pelo próprio commander via configureOutput/writeErr acima
      return 2
    }
    // exceção INESPERADA (bug, EACCES/ENOSPC…): stack completo no stderr para
    // diagnóstico em CI — distinguível dos erros de uso acima, que só têm message
    const unexpected = err as Error
    io.stderr(`${unexpected.stack ?? unexpected.message}\n`)
    return 2
  }
  return exitCode
}

// Entry point do bin (dist/cli.js) — pathToFileURL lida com espaços no path
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv))
}
