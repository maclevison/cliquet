import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStyleGate, parseBiomeDiagnostics } from '../../../src/gates/style.js'
import { DEFAULT_BASELINE } from '../../../src/baseline.js'
import { createProjectContext } from '../../../src/context.js'
import type { RunResult } from '../../../src/process.js'

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'outputs', name), 'utf8')

describe('parseBiomeDiagnostics', () => {
  it('extrai paths da saída real do biome 2.x (location.path é string)', () => {
    const files = parseBiomeDiagnostics(fixture('biome-format-diagnostics.json'))
    expect(files).toEqual(['bad.ts', 'bad2.ts', 'package.json'])
  })

  it('aceita o shape legado do biome 1.x (location.path.file)', () => {
    const out = JSON.stringify({ diagnostics: [{ location: { path: { file: './src/a.ts' } } }] })
    expect(parseBiomeDiagnostics(out)).toEqual(['./src/a.ts'])
  })

  it('retorna [] para JSON inválido', () => {
    expect(parseBiomeDiagnostics('boom')).toEqual([])
  })

  it('conta só severity error/fatal — warnings do biome lint não são erro (spec §5)', () => {
    const out = JSON.stringify({
      diagnostics: [
        { severity: 'error', location: { path: 'src/a.ts' } },
        { severity: 'warning', location: { path: 'src/b.ts' } },
        { severity: 'information', location: { path: 'src/c.ts' } },
        { severity: 'fatal', location: { path: 'src/d.ts' } },
      ],
    })
    expect(parseBiomeDiagnostics(out)).toEqual(['src/a.ts', 'src/d.ts'])
  })
})

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cliquet-style-'))
})

function ok(stdout = ''): RunResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false, failed: false }
}
function fail(stdout: string, exitCode = 1): RunResult {
  return { exitCode, stdout, stderr: '', timedOut: false, failed: false }
}

function ctxWithTools(tools: string[]) {
  const ctx = createProjectContext(root, DEFAULT_BASELINE, 300_000)
  return { ...ctx, resolveTool: (bin: string) => (tools.includes(bin) ? `/fake/bin/${bin}` : null) }
}

describe('styleGate', () => {
  it('skip quando não há config de formatador', async () => {
    const gate = createStyleGate({ run: async () => ok() })
    const r = await gate.run(ctxWithTools(['prettier']), DEFAULT_BASELINE)
    expect(r.status).toBe('skip')
  })

  it('passa com prettier limpo (empate com baseline 0 → sem sugestão de update)', async () => {
    writeFileSync(join(root, '.prettierrc'), '{}')
    const gate = createStyleGate({ run: async () => ok('') })
    const r = await gate.run(ctxWithTools(['prettier']), DEFAULT_BASELINE)
    expect(r.status).toBe('pass')
    expect(r.current).toEqual({ violations: 0 })
    expect(r.actions).toEqual([])
  })

  it('pass com MELHORA (violações abaixo do baseline) sugere UPDATE BASELINE (warn, spec §4)', async () => {
    writeFileSync(join(root, '.prettierrc'), '{}')
    const gate = createStyleGate({ run: async () => ok('') }) // 0 violações medidas
    const baseline = { ...DEFAULT_BASELINE, style: { violations: 2 } }
    const r = await gate.run(ctxWithTools(['prettier']), baseline)
    expect(r.status).toBe('pass')
    const suggest = r.actions.find((a) => a.type === 'UPDATE BASELINE')
    expect(suggest).toBeDefined()
    expect(suggest?.severity).toBe('warn')
    expect(suggest?.priority).toBe(10)
    expect(suggest?.message).toContain('improved to 0')
    expect(suggest?.message).toContain('cliquet.baseline.json')
  })

  it('falha contando arquivos do --list-different', async () => {
    writeFileSync(join(root, '.prettierrc'), '{}')
    const gate = createStyleGate({ run: async () => fail('src/a.ts\nsrc/b.ts\n') })
    const r = await gate.run(ctxWithTools(['prettier']), DEFAULT_BASELINE)
    expect(r.status).toBe('fail')
    expect(r.current).toEqual({ violations: 2 })
    expect(r.actions[0]?.files).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('soma prettier + biome quando ambos configurados', async () => {
    writeFileSync(join(root, '.prettierrc'), '{}')
    writeFileSync(join(root, 'biome.json'), '{}')
    const gate = createStyleGate({
      run: async (bin) =>
        bin.includes('prettier')
          ? fail('src/a.ts\n')
          : fail(JSON.stringify({ diagnostics: [{ location: { path: { file: 'src/c.ts' } } }] })),
    })
    const r = await gate.run(ctxWithTools(['prettier', 'biome']), DEFAULT_BASELINE)
    expect(r.status).toBe('fail')
    expect(r.current).toEqual({ violations: 2 })
  })

  it('error quando a ferramenta crasha (exit code inesperado, stdout vazio)', async () => {
    writeFileSync(join(root, '.prettierrc'), '{}')
    const gate = createStyleGate({
      run: async () => ({ exitCode: 2, stdout: '', stderr: 'crashed hard', timedOut: false, failed: true }),
    })
    const r = await gate.run(ctxWithTools(['prettier']), DEFAULT_BASELINE)
    expect(r.status).toBe('error')
    expect(r.message).toContain('crashed hard')
  })

  it('error quando prettier sai com 1 mas stdout vazio (parse failure não vira 0 violações)', async () => {
    writeFileSync(join(root, '.prettierrc'), '{}')
    const gate = createStyleGate({ run: async () => fail('') })
    const r = await gate.run(ctxWithTools(['prettier']), DEFAULT_BASELINE)
    expect(r.status).toBe('error')
  })

  it('skip quando config existe mas binário não resolve', async () => {
    writeFileSync(join(root, '.prettierrc'), '{}')
    const gate = createStyleGate({ run: async () => ok() })
    const r = await gate.run(ctxWithTools([]), DEFAULT_BASELINE)
    expect(r.status).toBe('skip')
  })
})
