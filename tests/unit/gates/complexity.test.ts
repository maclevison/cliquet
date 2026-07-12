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

// função com CCN = 1 + n (n ifs encadeados)
function fnWithCcn(n: number): string {
  const ifs = Array.from({ length: n - 1 }, (_, i) => `if (x === ${i}) {}`).join('\n')
  return `function f(x) {\n${ifs}\nreturn x\n}`
}

function baselineWith(warn: number, block: number): Baseline {
  return { ...DEFAULT_BASELINE, complexity: { warn_ccn: warn, block_ccn: block } }
}

describe('complexityGate', () => {
  it('passa sem warnings quando tudo está abaixo de warn_ccn', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), fnWithCcn(3))
    const baseline = baselineWith(5, 10)
    const r = await complexityGate.run(createProjectContext(root, baseline, 300_000), baseline)
    expect(r.status).toBe('pass')
    expect(r.actions).toHaveLength(0)
  })

  it('passa com ação warn entre warn_ccn e block_ccn', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), fnWithCcn(7))
    const baseline = baselineWith(5, 10)
    const r = await complexityGate.run(createProjectContext(root, baseline, 300_000), baseline)
    expect(r.status).toBe('pass')
    expect(r.actions).toHaveLength(1)
    expect(r.actions[0]?.severity).toBe('warn')
  })

  it('falha com ação block acima de block_ccn', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), fnWithCcn(12))
    const baseline = baselineWith(5, 10)
    const r = await complexityGate.run(createProjectContext(root, baseline, 300_000), baseline)
    expect(r.status).toBe('fail')
    expect(r.actions.some((a) => a.severity === 'block')).toBe(true)
  })
})
