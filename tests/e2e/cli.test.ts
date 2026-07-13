import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, cpSync, existsSync, readFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs'
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
  it('imprime a versão do package.json e retorna 0', async () => {
    const code = await run(['--version'])
    expect(code).toBe(0)
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { version: string }
    expect(out.join('')).toContain(pkg.version)
  })
})

describe('bin invocado via symlink (regressão: npm cria node_modules/.bin como symlink)', () => {
  it('executa main quando argv[1] é um symlink para dist/cli.js', async () => {
    const root = join(import.meta.dirname, '..', '..')
    const build = await runCommand('npx', ['tsc', '-p', 'tsconfig.build.json'], {
      cwd: root,
      timeoutMs: 120_000,
    })
    expect(build.exitCode).toBe(0)

    const binDir = mkdtempSync(join(tmpdir(), 'cliquet-bin-'))
    tmpDirs.push(binDir)
    const link = join(binDir, 'cliquet')
    // npm chmoda o alvo do bin na instalação; imita isso para o exec via shebang funcionar
    chmodSync(join(root, 'dist', 'cli.js'), 0o755)
    symlinkSync(join(root, 'dist', 'cli.js'), link)

    const r = await runCommand(link, ['--version'], { cwd: binDir, timeoutMs: 30_000 })
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe(pkg.version)
  }, 180_000)
})

describe('cliquet init', () => {
  it('cria o baseline e retorna 0', async () => {
    const dir = copyFixture('js-plain')
    const code = await run(['init', '--path', dir])
    expect(code).toBe(0)
    expect(existsSync(join(dir, 'cliquet.baseline.json'))).toBe(true)
    const baseline = JSON.parse(readFileSync(join(dir, 'cliquet.baseline.json'), 'utf8'))
    expect(baseline.schema).toBe('cliquet/v1')
  })

  it('com --force sobrescreve baseline existente sem perguntar', async () => {
    const dir = copyFixture('failing')
    const code = await run(['init', '--force', '--path', dir])
    expect(code).toBe(0)
    const baseline = JSON.parse(readFileSync(join(dir, 'cliquet.baseline.json'), 'utf8'))
    expect(baseline.file_size.max_lines).toBe(1000) // voltou ao default
  })

  it('sem --force sobre baseline existente recusa com exit 2 (comportamento da spec §4)', async () => {
    const dir = copyFixture('failing')
    const code = await run(['init', '--path', dir])
    expect(code).toBe(2)
    expect(errOut.join('')).toContain('--force')
  })
})

describe('cliquet check', () => {
  it('passa (exit 0) num projeto limpo sem ferramentas — gates skip não falham', async () => {
    const dir = copyFixture('js-plain')
    const code = await run(['check', '--path', dir, '--format', 'json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(out.join(''))
    expect(parsed.result).toBe('pass')
    expect(parsed.schema).toBe('cliquet/v1')
  })

  it('cria o baseline automaticamente se ausente (spec §4)', async () => {
    const dir = copyFixture('js-plain')
    await run(['check', '--path', dir, '--format', 'json'])
    expect(existsSync(join(dir, 'cliquet.baseline.json'))).toBe(true)
  })

  it('falha (exit 1) quando uma gate regride', async () => {
    const dir = copyFixture('failing')
    const code = await run(['check', '--path', dir, '--format', 'json'])
    expect(code).toBe(1)
    const parsed = JSON.parse(out.join(''))
    expect(parsed.result).toBe('fail')
    expect(parsed.actions.some((a: { gate: string }) => a.gate === 'file_size')).toBe(true)
  })

  it('check --fix re-executa o check e o exit reflete o segundo run (fixers não resolvem file_size)', async () => {
    const dir = copyFixture('failing')
    const code = await run(['check', '--fix', '--path', dir, '--format', 'json'])
    expect(code).toBe(1)
  })

  it('exit 2 para baseline inválido', async () => {
    const dir = copyFixture('js-plain')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'cliquet.baseline.json'), '{ broken')
    const code = await run(['check', '--path', dir])
    expect(code).toBe(2)
    expect(errOut.join('')).toContain('Invalid baseline')
  })

  it('exit 2 para --path inexistente', async () => {
    const code = await run(['check', '--path', '/nope/nada'])
    expect(code).toBe(2)
  })

  it('exceção inesperada (não-ConfigError, ex. EACCES ao gravar o baseline) sai 2 com stack no stderr', async () => {
    const dir = copyFixture('js-plain')
    chmodSync(dir, 0o555) // diretório read-only → saveBaseline lança EACCES (não é ConfigError)
    try {
      const code = await run(['init', '--path', dir])
      expect(code).toBe(2)
      const stderr = errOut.join('')
      expect(stderr).toContain('EACCES')
      expect(stderr).toContain('    at ') // stack trace completo para diagnóstico em CI
    } finally {
      chmodSync(dir, 0o755) // restaura para o rmSync do afterAll funcionar
    }
  })

  it('formato padrão vira json sob agente de IA (spec §3)', async () => {
    const dir = copyFixture('js-plain')
    await run(['check', '--path', dir], { CLAUDECODE: '1' })
    expect(() => JSON.parse(out.join(''))).not.toThrow()
  })

  it('--format explícito vence a detecção de agente', async () => {
    const dir = copyFixture('js-plain')
    await run(['check', '--path', dir, '--format', 'human', '--plain'], { CLAUDECODE: '1' })
    expect(out.join('')).toContain('CLIQUET')
  })
})

describe('cliquet fix', () => {
  it('roda fixers e o check em seguida; --no-check pula o check', async () => {
    const dir = copyFixture('js-plain')
    const code = await run(['fix', '--no-check', '--path', dir, '--format', 'json'])
    expect(code).toBe(0)
    const withCheck = await run(['fix', '--path', dir, '--format', 'json'])
    expect(withCheck).toBe(0)
  })
})
