import { describe, it, expect, afterAll } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../../src/cli.js'
import { runCommand } from '../../src/process.js'

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'projects')
let out: string[]
let errOut: string[]

function capture() {
  out = []
  errOut = []
  return {
    stdout: (s: string) => out.push(s),
    stderr: (s: string) => errOut.push(s),
  }
}

const tmpDirs: string[] = []

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

function copyFixture(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `cliquet-e2e-${name}-`))
  tmpDirs.push(dir)
  cpSync(join(FIXTURES, name), dir, { recursive: true })
  return dir
}

async function run(args: string[], env: Record<string, string> = {}) {
  return main(['node', 'cliquet', ...args], env, capture())
}

describe('cliquet --version', () => {
  it('prints the package.json version and returns 0', async () => {
    const code = await run(['--version'])
    expect(code).toBe(0)
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { version: string }
    expect(out.join('')).toContain(pkg.version)
  })
})

describe('bin invoked via symlink (regression: npm creates node_modules/.bin as a symlink)', () => {
  it('runs main when argv[1] is a symlink to dist/cli.js', async () => {
    const root = join(import.meta.dirname, '..', '..')
    const build = await runCommand('npx', ['tsc', '-p', 'tsconfig.build.json'], {
      cwd: root,
      timeoutMs: 120_000,
    })
    expect(build.exitCode).toBe(0)

    const binDir = mkdtempSync(join(tmpdir(), 'cliquet-bin-'))
    tmpDirs.push(binDir)
    const link = join(binDir, 'cliquet')
    // npm chmods the bin target on install; mimic that so the shebang exec works
    chmodSync(join(root, 'dist', 'cli.js'), 0o755)
    symlinkSync(join(root, 'dist', 'cli.js'), link)

    const r = await runCommand(link, ['--version'], { cwd: binDir, timeoutMs: 30_000 })
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe(pkg.version)
  }, 180_000)
})

describe('cliquet init', () => {
  it('creates the baseline and returns 0 (--defaults: no measurement)', async () => {
    const dir = copyFixture('js-plain')
    const code = await run(['init', '--defaults', '--path', dir])
    expect(code).toBe(0)
    expect(existsSync(join(dir, 'cliquet.baseline.json'))).toBe(true)
    const baseline = JSON.parse(readFileSync(join(dir, 'cliquet.baseline.json'), 'utf8'))
    expect(baseline.schema).toBe('cliquet/v1')
  })

  it('measures the project by default: a condition-order issue lands in performance.violations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cliquet-e2e-measure-'))
    tmpDirs.push(dir)
    writeFileSync(join(dir, 'package.json'), '{"name":"m","version":"1.0.0"}')
    mkdirSync(join(dir, 'src'))
    // built-in condition-order (no external tools needed): expensive call before a cheap flag in a guard
    writeFileSync(join(dir, 'src', 'a.ts'), 'export function f(x: unknown) {\n  if (expensiveCheck(x) && ready) return 1\n  return 0\n}\n')
    const code = await run(['init', '--path', dir])
    expect(code).toBe(0)
    const baseline = JSON.parse(readFileSync(join(dir, 'cliquet.baseline.json'), 'utf8'))
    expect(baseline.performance.violations).toBe(1) // measured, not the default 0
  })

  it('with --force --defaults overwrites an existing baseline without asking', async () => {
    const dir = copyFixture('failing')
    const code = await run(['init', '--force', '--defaults', '--path', dir])
    expect(code).toBe(0)
    const baseline = JSON.parse(readFileSync(join(dir, 'cliquet.baseline.json'), 'utf8'))
    expect(baseline.file_size.max_lines).toBe(1000) // back to default
  })

  it('without --force on an existing baseline refuses with exit 2 (spec §4 behavior)', async () => {
    const dir = copyFixture('failing')
    const code = await run(['init', '--path', dir])
    expect(code).toBe(2)
    expect(errOut.join('')).toContain('--force')
  })
})

describe('cliquet check', () => {
  it('passes (exit 0) on a clean project with no tools — skipped gates do not fail', async () => {
    const dir = copyFixture('js-plain')
    const code = await run(['check', '--path', dir, '--format', 'json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(out.join(''))
    expect(parsed.result).toBe('pass')
    expect(parsed.schema).toBe('cliquet/v1')
  })

  it('creates the baseline automatically when missing (spec §4)', async () => {
    const dir = copyFixture('js-plain')
    await run(['check', '--path', dir, '--format', 'json'])
    expect(existsSync(join(dir, 'cliquet.baseline.json'))).toBe(true)
  })

  it('the auto-created baseline is MEASURED (consistent with init), not defaults', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cliquet-e2e-autocreate-'))
    tmpDirs.push(dir)
    writeFileSync(join(dir, 'package.json'), '{"name":"a","version":"1.0.0"}')
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'export function f(x: unknown) {\n  if (heavy(x) && ready) return 1\n  return 0\n}\n')
    await run(['check', '--path', dir, '--format', 'json']) // no baseline → auto-create
    const baseline = JSON.parse(readFileSync(join(dir, 'cliquet.baseline.json'), 'utf8'))
    expect(baseline.performance.violations).toBe(1) // measured; the old cheap path would leave the default 0
  })

  it('fails (exit 1) when a gate regresses', async () => {
    const dir = copyFixture('failing')
    const code = await run(['check', '--path', dir, '--format', 'json'])
    expect(code).toBe(1)
    const parsed = JSON.parse(out.join(''))
    expect(parsed.result).toBe('fail')
    expect(parsed.actions.some((a: { gate: string }) => a.gate === 'file_size')).toBe(true)
  })

  it('check --fix re-runs the check and the exit reflects the second run (fixers do not resolve file_size)', async () => {
    const dir = copyFixture('failing')
    const code = await run(['check', '--fix', '--path', dir, '--format', 'json'])
    expect(code).toBe(1)
  })

  it('exit 2 for an invalid baseline', async () => {
    const dir = copyFixture('js-plain')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'cliquet.baseline.json'), '{ broken')
    const code = await run(['check', '--path', dir])
    expect(code).toBe(2)
    expect(errOut.join('')).toContain('Invalid baseline')
  })

  it('exit 2 for a nonexistent --path', async () => {
    const code = await run(['check', '--path', '/nope/nada'])
    expect(code).toBe(2)
  })

  it('unexpected exception (non-ConfigError, e.g. EACCES writing the baseline) exits 2 with a stack trace on stderr', async () => {
    const dir = copyFixture('js-plain')
    chmodSync(dir, 0o555) // read-only directory → saveBaseline throws EACCES (not a ConfigError)
    try {
      const code = await run(['init', '--defaults', '--path', dir])
      expect(code).toBe(2)
      const stderr = errOut.join('')
      expect(stderr).toContain('EACCES')
      expect(stderr).toContain('    at ') // full stack trace for CI diagnostics
    } finally {
      chmodSync(dir, 0o755) // restore so afterAll's rmSync works
    }
  })

  it('default format becomes json under an AI agent (spec §3)', async () => {
    const dir = copyFixture('js-plain')
    await run(['check', '--path', dir], { CLAUDECODE: '1' })
    expect(() => JSON.parse(out.join(''))).not.toThrow()
  })

  it('explicit --format wins over agent detection', async () => {
    const dir = copyFixture('js-plain')
    await run(['check', '--path', dir, '--format', 'human', '--plain'], { CLAUDECODE: '1' })
    expect(out.join('')).toContain('CLIQUET')
  })
})

describe('cliquet fix', () => {
  it('runs fixers then the check; --no-check skips the check', async () => {
    const dir = copyFixture('js-plain')
    const code = await run(['fix', '--no-check', '--path', dir, '--format', 'json'])
    expect(code).toBe(0)
    const withCheck = await run(['fix', '--path', dir, '--format', 'json'])
    expect(withCheck).toBe(0)
  })
})

describe('cliquet check on a monorepo workspace (walk-up acceptance)', () => {
  it('sees the root .gitignore and root eslint config from apps/web', async () => {
    const dir = copyFixture('monorepo')
    // created here, not committed in the fixture: git cannot track a nested .git
    mkdirSync(join(dir, '.git'))
    // "install" eslint at the monorepo ROOT (hoisted .bin), like a real devDep:
    // the resolver's PATH fallback deliberately rejects foreign node_modules/.bin,
    // so the binary must be reachable through the fixture's own chain.
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
    symlinkSync(
      join(import.meta.dirname, '..', '..', 'node_modules', '.bin', 'eslint'),
      join(dir, 'node_modules', '.bin', 'eslint'),
    )
    const code = await run(['check', '--path', join(dir, 'apps', 'web'), '--format', 'json'])
    const parsed = JSON.parse(out.join('')) as {
      result: string
      gates: Array<{ name: string; status: string }>
    }
    // root .gitignore (.env/*.pem/*.key) satisfies the rule via walk-up
    expect(out.join('')).not.toContain('gitignore_sensitive')
    // root eslint.config.mjs is detected from the workspace (was: skip)
    const staticAnalysis = parsed.gates.find((g) => g.name === 'static_analysis')
    expect(staticAnalysis?.status).not.toBe('skip')
    expect(parsed.result).toBe('pass')
    expect(code).toBe(0)
  })
})

describe('baseline auto-creation guard', () => {
  it('refuses to auto-create a baseline where there is no package.json (exit 2, nothing written)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cliquet-e2e-nopkg-'))
    tmpDirs.push(dir)
    const code = await run(['check', '--path', dir])
    expect(code).toBe(2)
    expect(errOut.join('')).toContain('package.json')
    expect(existsSync(join(dir, 'cliquet.baseline.json'))).toBe(false)
  })
})

describe('init guard (no package.json)', () => {
  it('refuses with exit 2 and writes nothing (a dirty cwd in a deep subdir must not seed a baseline)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cliquet-e2e-init-nopkg-'))
    tmpDirs.push(dir)
    const code = await run(['init', '--path', dir])
    expect(code).toBe(2)
    expect(errOut.join('')).toContain('package.json')
    expect(existsSync(join(dir, 'cliquet.baseline.json'))).toBe(false)
  })

  it('--force overrides the guard (intentional non-npm project)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cliquet-e2e-init-force-'))
    tmpDirs.push(dir)
    const code = await run(['init', '--force', '--defaults', '--path', dir])
    expect(code).toBe(0)
    expect(existsSync(join(dir, 'cliquet.baseline.json'))).toBe(true)
  })
})

interface ParsedCheck {
  result: string
  actions: Array<{ gate: string; message: string; files: string[] }>
  gates: Array<{ name: string; status: string }>
}

describe('cliquet check on the codegen fixture (exclude acceptance)', () => {
  it('passes as shipped: gen/ is excluded, so file_size/duplication/security/complexity/performance all pass', async () => {
    const dir = copyFixture('codegen')
    const code = await run(['check', '--path', dir, '--format', 'json'])
    const parsed = JSON.parse(out.join('')) as ParsedCheck
    expect(parsed.result).toBe('pass')
    expect(code).toBe(0)
    const gates = new Map(parsed.gates.map((g) => [g.name, g.status]))
    for (const name of ['file_size', 'duplication', 'security', 'complexity', 'performance']) {
      expect(gates.get(name)).toBe('pass')
    }
  })

  it('fails every walker-consuming gate once exclude is emptied — proving exclude is what saves each one', async () => {
    const dir = copyFixture('codegen')
    const baselinePath = join(dir, 'cliquet.baseline.json')
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
      source_dirs: { paths: string[]; exclude: string[] }
    }
    baseline.source_dirs.exclude = []
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`)

    const code = await run(['check', '--path', dir, '--format', 'json'])
    const parsed = JSON.parse(out.join('')) as ParsedCheck
    expect(parsed.result).toBe('fail')
    expect(code).toBe(1)

    const gates = new Map(parsed.gates.map((g) => [g.name, g.status]))
    expect(gates.get('file_size')).toBe('fail')
    expect(gates.get('duplication')).toBe('fail')
    expect(gates.get('security')).toBe('fail')
    expect(gates.get('complexity')).toBe('fail')
    expect(gates.get('performance')).toBe('fail')

    const fileSizeAction = parsed.actions.find((a) => a.gate === 'file_size')
    expect(fileSizeAction?.files.some((f) => f.includes('gen/generated.ts'))).toBe(true)

    const duplicationAction = parsed.actions.find((a) => a.gate === 'duplication')
    expect(duplicationAction?.files.some((f) => f.includes('gen/dup1.ts') || f.includes('gen/dup2.ts'))).toBe(true)

    const securityAction = parsed.actions.find((a) => a.gate === 'security')
    expect(securityAction?.files.some((f) => f.includes('gen/generated.ts:4') && f.includes('hardcoded_secrets'))).toBe(
      true,
    )

    const complexityAction = parsed.actions.find((a) => a.gate === 'complexity')
    expect(complexityAction?.files.some((f) => /CCN 52/.test(f))).toBe(true)

    const performanceAction = parsed.actions.find((a) => a.gate === 'performance')
    expect(
      performanceAction?.files.some((f) => f.includes('gen/generated.ts:15') && /Expensive condition/.test(f)),
    ).toBe(true)
  })
})
