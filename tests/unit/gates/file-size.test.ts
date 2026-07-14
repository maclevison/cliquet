import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileSizeGate } from '../../../src/gates/file-size.js'
import { DEFAULT_BASELINE } from '../../../src/baseline.js'
import { createProjectContext } from '../../../src/context.js'
import type { Baseline } from '../../../src/baseline.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cliquet-fsize-'))
  mkdirSync(join(root, 'src'))
})

function baselineWith(maxLines: number, allow: Record<string, number> = {}): Baseline {
  return { ...DEFAULT_BASELINE, file_size: { max_lines: maxLines, allow } }
}

function ctx(baseline: Baseline) {
  return createProjectContext(root, baseline, 300_000)
}

describe('fileSizeGate', () => {
  it('passes when no file exceeds the limit', async () => {
    writeFileSync(join(root, 'src', 'ok.ts'), 'a\nb\nc\n')
    const baseline = baselineWith(10)
    const r = await fileSizeGate.run(ctx(baseline), baseline)
    expect(r.status).toBe('pass')
    expect(r.current).toEqual({ offending_files: 0, offenders: [] })
  })

  it('does not count the trailing newline as an extra line', async () => {
    // exactly 3 lines terminated by \n — does not exceed max_lines=3
    writeFileSync(join(root, 'src', 'exact.ts'), 'a\nb\nc\n')
    const baseline = baselineWith(3)
    const r = await fileSizeGate.run(ctx(baseline), baseline)
    expect(r.status).toBe('pass')
    expect(r.current).toEqual({ offending_files: 0, offenders: [] })
  })

  it('empty file counts 0 lines', async () => {
    writeFileSync(join(root, 'src', 'empty.ts'), '')
    const baseline = baselineWith(0)
    const r = await fileSizeGate.run(ctx(baseline), baseline)
    expect(r.status).toBe('pass')
    expect(r.current).toEqual({ offending_files: 0, offenders: [] })
  })

  it('fails listing the files that exceed the limit', async () => {
    writeFileSync(join(root, 'src', 'big.ts'), Array(12).fill('x').join('\n'))
    const baseline = baselineWith(10)
    const r = await fileSizeGate.run(ctx(baseline), baseline)
    expect(r.status).toBe('fail')
    expect(r.actions).toHaveLength(1)
    expect(r.actions[0]?.severity).toBe('block')
    expect(r.actions[0]?.gate).toBe('file_size')
    expect(r.actions[0]?.files[0]).toContain('big.ts')
  })

  it('exposes structured offenders for init to grandfather', async () => {
    writeFileSync(join(root, 'src', 'big.ts'), Array(12).fill('x').join('\n'))
    const baseline = baselineWith(10)
    const r = await fileSizeGate.run(ctx(baseline), baseline)
    expect(r.current).toEqual({ offending_files: 1, offenders: [{ file: 'src/big.ts', lines: 12 }] })
  })

  it('grandfathers a file in file_size.allow: holds, fails only if it grows past the entry; new files still caught', async () => {
    writeFileSync(join(root, 'src', 'big.ts'), Array(12).fill('x').join('\n')) // 12 lines, threshold 10
    const held = baselineWith(10, { 'src/big.ts': 12 })
    expect((await fileSizeGate.run(ctx(held), held)).status).toBe('pass') // grandfathered

    writeFileSync(join(root, 'src', 'big.ts'), Array(13).fill('x').join('\n')) // grew past the entry
    expect((await fileSizeGate.run(ctx(held), held)).status).toBe('fail')

    writeFileSync(join(root, 'src', 'big.ts'), Array(12).fill('x').join('\n'))
    writeFileSync(join(root, 'src', 'new.ts'), Array(12).fill('x').join('\n')) // new, not grandfathered
    expect((await fileSizeGate.run(ctx(held), held)).status).toBe('fail')
  })
})
