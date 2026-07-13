import { describe, it, expect } from 'vitest'
import { runCommand, tailLines } from '../../src/process.js'

describe('runCommand', () => {
  it('captures stdout and exit code 0', async () => {
    const r = await runCommand('node', ['-e', 'console.log("ok")'], { cwd: process.cwd(), timeoutMs: 5000 })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('ok')
    expect(r.timedOut).toBe(false)
  })

  it('does not throw on exit code != 0 and captures stderr', async () => {
    const r = await runCommand('node', ['-e', 'console.error("boom"); process.exit(3)'], {
      cwd: process.cwd(),
      timeoutMs: 5000,
    })
    expect(r.exitCode).toBe(3)
    expect(r.stderr.trim()).toBe('boom')
  })

  it('marks timedOut when the timeout is exceeded', async () => {
    const r = await runCommand('node', ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd: process.cwd(),
      timeoutMs: 500,
    })
    expect(r.timedOut).toBe(true)
  })

  it('does not throw when the binary does not exist', async () => {
    const r = await runCommand('cliquet-binario-inexistente-xyz', [], { cwd: process.cwd(), timeoutMs: 5000 })
    expect(r.exitCode).toBeNull()
    expect(r.failed).toBe(true)
  })
})

describe('tailLines', () => {
  it('returns the last N lines (default 20)', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n')
    const tail = tailLines(text)
    expect(tail.split('\n')).toHaveLength(20)
    expect(tail.startsWith('line10')).toBe(true)
  })

  it('strips \\r from CRLF line endings', () => {
    const tail = tailLines('a\r\nb\r\nc\r\n')
    expect(tail).toBe('a\nb\nc')
  })
})
