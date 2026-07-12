import { describe, it, expect } from 'vitest'
import { runCommand, tailLines } from '../../src/process.js'

describe('runCommand', () => {
  it('captura stdout e exit code 0', async () => {
    const r = await runCommand('node', ['-e', 'console.log("ok")'], { cwd: process.cwd(), timeoutMs: 5000 })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('ok')
    expect(r.timedOut).toBe(false)
  })

  it('não lança em exit code != 0 e captura stderr', async () => {
    const r = await runCommand('node', ['-e', 'console.error("boom"); process.exit(3)'], {
      cwd: process.cwd(),
      timeoutMs: 5000,
    })
    expect(r.exitCode).toBe(3)
    expect(r.stderr.trim()).toBe('boom')
  })

  it('marca timedOut quando estoura o timeout', async () => {
    const r = await runCommand('node', ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd: process.cwd(),
      timeoutMs: 500,
    })
    expect(r.timedOut).toBe(true)
  })

  it('não lança quando o binário não existe', async () => {
    const r = await runCommand('cliquet-binario-inexistente-xyz', [], { cwd: process.cwd(), timeoutMs: 5000 })
    expect(r.exitCode).toBeNull()
    expect(r.failed).toBe(true)
  })
})

describe('tailLines', () => {
  it('retorna as últimas N linhas (default 20)', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n')
    const tail = tailLines(text)
    expect(tail.split('\n')).toHaveLength(20)
    expect(tail.startsWith('line10')).toBe(true)
  })
})
