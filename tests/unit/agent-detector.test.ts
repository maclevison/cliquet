import { describe, it, expect } from 'vitest'
import { isAiAgent } from '../../src/agent-detector.js'

describe('isAiAgent', () => {
  it('detects Claude Code via CLAUDECODE', () => {
    expect(isAiAgent({ CLAUDECODE: '1' })).toBe(true)
  })

  it('detects Cursor via CURSOR_TRACE_ID', () => {
    expect(isAiAgent({ CURSOR_TRACE_ID: 'abc' })).toBe(true)
  })

  it('ignores an env var that is present but empty', () => {
    expect(isAiAgent({ CLAUDECODE: '' })).toBe(false)
  })

  it('returns false in a plain environment', () => {
    expect(isAiAgent({ HOME: '/home/x', PATH: '/usr/bin' })).toBe(false)
  })
})
