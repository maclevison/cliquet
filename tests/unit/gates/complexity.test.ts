import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { complexityGate } from '../../../src/gates/complexity.js'
import { DEFAULT_BASELINE, type Baseline } from '../../../src/baseline.js'
import { createProjectContext } from '../../../src/context.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cliquet-ccn-'))
  mkdirSync(join(root, 'src'))
})

// function with CCN = 1 + n (n chained ifs)
function fnWithCcn(n: number): string {
  const ifs = Array.from({ length: n - 1 }, (_, i) => `if (x === ${i}) {}`).join('\n')
  return `function f(x) {\n${ifs}\nreturn x\n}`
}

function baselineWith(warn: number, block: number, allow: Record<string, number> = {}): Baseline {
  return { ...DEFAULT_BASELINE, complexity: { warn_ccn: warn, block_ccn: block, allow } }
}

describe('complexityGate', () => {
  it('passes with no warnings when everything is below warn_ccn', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), fnWithCcn(3))
    const baseline = baselineWith(5, 10)
    const r = await complexityGate.run(createProjectContext(root, baseline, 300_000), baseline)
    expect(r.status).toBe('pass')
    expect(r.actions).toHaveLength(0)
  })

  it('passes with a warn action between warn_ccn and block_ccn', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), fnWithCcn(7))
    const baseline = baselineWith(5, 10)
    const r = await complexityGate.run(createProjectContext(root, baseline, 300_000), baseline)
    expect(r.status).toBe('pass')
    expect(r.actions).toHaveLength(1)
    expect(r.actions[0]?.severity).toBe('warn')
  })

  it('fails with a block action above block_ccn', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), fnWithCcn(12))
    const baseline = baselineWith(5, 10)
    const r = await complexityGate.run(createProjectContext(root, baseline, 300_000), baseline)
    expect(r.status).toBe('fail')
    expect(r.actions.some((a) => a.severity === 'block')).toBe(true)
  })

  it('ignores .vue files (SFC requires <script> extraction — post-MVP) without throwing', async () => {
    const sfc = `<template>\n  <div>{{ x }}</div>\n</template>\n<script>\n${fnWithCcn(12)}\n</script>\n`
    writeFileSync(join(root, 'src', 'App.vue'), sfc)
    const baseline = baselineWith(5, 10)
    const r = await complexityGate.run(createProjectContext(root, baseline, 300_000), baseline)
    expect(r.status).toBe('pass')
    expect(r.actions).toHaveLength(0)
    expect(r.current).toEqual({ max_ccn: 0, violations: 0, warnings: 0, over_block: [] })
  })

  it('exposes over_block for init, and grandfathers a function in complexity.allow', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), fnWithCcn(11)) // CCN 11, block 10
    const plain = baselineWith(5, 10)
    const before = await complexityGate.run(createProjectContext(root, plain, 300_000), plain)
    expect(before.status).toBe('fail')
    expect(before.current.over_block).toEqual([{ id: 'src/a.ts f', ccn: 11 }])

    const held = baselineWith(5, 10, { 'src/a.ts f': 11 })
    const grandfathered = await complexityGate.run(createProjectContext(root, held, 300_000), held)
    expect(grandfathered.status).toBe('pass') // held
    expect(grandfathered.current.over_block).toEqual([])

    writeFileSync(join(root, 'src', 'a.ts'), fnWithCcn(12)) // grew past the entry
    const grown = await complexityGate.run(createProjectContext(root, held, 300_000), held)
    expect(grown.status).toBe('fail')
  })
})
