#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs'
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
import { hasBiomeConfig, hasPrettierConfig } from './detect.js'
import { runCommand } from './process.js'
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

// Single source of truth for the version: package.json sits one level above both
// src/ (dev, via vitest) and dist/ (compiled bin), so '..' resolves in both cases.
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
  if (!existsSync(path)) throw new ConfigError(`--path does not exist: ${path}`)
  const format = (opts.format ?? (isAiAgent(env) ? 'json' : 'human')) as GlobalOpts['format']
  if (!['human', 'json', 'json-pretty', 'github'].includes(format)) {
    throw new ConfigError(`invalid --format: ${format}`)
  }
  const timeoutSeconds = opts.timeout ? Number(opts.timeout) : 300
  if (timeoutSeconds <= 0 || Number.isNaN(timeoutSeconds)) throw new ConfigError(`invalid --timeout: ${opts.timeout}`)
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

/** init measures coverage/bundle if artifacts exist on disk (spec §4). */
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

/**
 * Best-effort: reformat the freshly generated baseline with the project's own
 * formatter, so the file cliquet just created doesn't fail cliquet's style gate
 * (custom prettier/biome configs disagree with plain 2-space JSON). Silent
 * no-op when no formatter is configured/resolvable; runCommand never throws.
 */
export async function formatGeneratedBaseline(
  rootPath: string,
  baseline: Baseline,
  timeoutMs: number,
  run = runCommand,
): Promise<void> {
  const ctx = createProjectContext(rootPath, baseline, timeoutMs)
  const target = join(rootPath, BASELINE_FILENAME)
  if (hasBiomeConfig(rootPath, ctx.repoRoot)) {
    const bin = ctx.resolveTool('biome')
    if (bin !== null) {
      await run(bin, ['format', '--write', target], { cwd: rootPath, timeoutMs })
      return
    }
  }
  if (hasPrettierConfig(rootPath, ctx.repoRoot)) {
    const bin = ctx.resolveTool('prettier')
    if (bin !== null) await run(bin, ['--write', target], { cwd: rootPath, timeoutMs })
  }
}

async function doCheck(opts: GlobalOpts, io: Io, runFixersFirst: boolean): Promise<number> {
  if (!baselineExists(opts.path)) {
    // Guard: without a package.json this is almost certainly the wrong cwd
    // (a subdir, $HOME…) — silently seeding a baseline there helps no one.
    if (!existsSync(join(opts.path, 'package.json'))) {
      throw new ConfigError(
        `no package.json in ${opts.path} — refusing to auto-create ${BASELINE_FILENAME}; run from the project root or pass --path`,
      )
    }
    const baseline = measuredBaseline(opts.path)
    saveBaseline(opts.path, baseline) // auto-create (spec §4)
    await formatGeneratedBaseline(opts.path, baseline, opts.timeoutMs)
    io.stderr(`${BASELINE_FILENAME} created with defaults\n`)
  }
  const baseline = loadBaseline(opts.path)
  const ctx = createProjectContext(opts.path, baseline, opts.timeoutMs)

  let result = await runCheck(ctx, baseline)
  if (result.result === 'fail' && runFixersFirst) {
    await runAllFixers(ctx, io)
    result = await runCheck(ctx, baseline) // exit code reflects the second check (spec §3)
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
    .exitOverride() // prevents commander from calling process.exit
    // Routes commander's help/version/parsing errors through io (testable and
    // consistent with the rest of the output). Configured BEFORE the .command() calls
    // below, which copy the parent's output configuration at creation time.
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
        io.stderr(`${BASELINE_FILENAME} already exists — use --force to overwrite\n`)
        exitCode = 2
        return
      }
      // Same guard as check's auto-create: a dirty cwd deep in a subdir must
      // not silently seed a baseline. --force is the non-npm-project escape hatch.
      if (!cmdOpts.force && !existsSync(join(opts.path, 'package.json'))) {
        throw new ConfigError(
          `no package.json in ${opts.path} — run from the project root, pass --path, or use --force for a non-npm project`,
        )
      }
      const baseline = measuredBaseline(opts.path)
      saveBaseline(opts.path, baseline)
      await formatGeneratedBaseline(opts.path, baseline, opts.timeoutMs)
      io.stdout(`${BASELINE_FILENAME} created\n`)
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
      return 0 // --help/--version aren't errors
    }
    if (err instanceof ConfigError) {
      // incorrect usage/configuration (invalid baseline, nonexistent --path…): message only
      io.stderr(`${err.message}\n`)
      return 2
    }
    if (typeof code === 'string' && code.startsWith('commander.')) {
      // commander parsing error (invalid flag, etc.) — the message was already
      // written by commander itself via configureOutput/writeErr above
      return 2
    }
    // UNEXPECTED exception (bug, EACCES/ENOSPC…): full stack to stderr for
    // diagnosis in CI — distinguishable from the usage errors above, which only have a message
    const unexpected = err as Error
    io.stderr(`${unexpected.stack ?? unexpected.message}\n`)
    return 2
  }
  return exitCode
}

// Bin entry point (dist/cli.js) — pathToFileURL handles spaces in the path.
// realpathSync resolves the symlink npm creates in node_modules/.bin, without which
// argv[1] (symlink) would never equal import.meta.url (real file) and the bin would silently do nothing.
function isDirectInvocation(): boolean {
  const invoked = process.argv[1]
  if (!invoked) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href
  } catch {
    return false
  }
}

if (isDirectInvocation()) {
  process.exit(await main(process.argv))
}
