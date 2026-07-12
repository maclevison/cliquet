import { describe, it, expect } from 'vitest'
import { isAiAgent } from '../../src/agent-detector.js'

describe('isAiAgent', () => {
  it('detecta Claude Code via CLAUDECODE', () => {
    expect(isAiAgent({ CLAUDECODE: '1' })).toBe(true)
  })

  it('detecta Cursor via CURSOR_TRACE_ID', () => {
    expect(isAiAgent({ CURSOR_TRACE_ID: 'abc' })).toBe(true)
  })

  it('ignora env var presente mas vazia', () => {
    expect(isAiAgent({ CLAUDECODE: '' })).toBe(false)
  })

  it('retorna false em ambiente comum', () => {
    expect(isAiAgent({ HOME: '/home/x', PATH: '/usr/bin' })).toBe(false)
  })
})
