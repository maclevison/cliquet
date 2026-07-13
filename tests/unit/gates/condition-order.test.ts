import { describe, it, expect } from 'vitest'
import { analyzeConditionOrder } from '../../../src/gates/condition-order.js'

describe('analyzeConditionOrder', () => {
  it('detects an expensive call before a cheap comparison in &&', () => {
    const findings = analyzeConditionOrder('a.ts', 'if (expensiveCheck(x) && flag === true) {}')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.line).toBe(1)
  })

  it('detects await before a cheap operand in ||', () => {
    const code = 'async function f() { return (await fetchIt()) || cached }'
    expect(analyzeConditionOrder('a.ts', code)).toHaveLength(1)
  })

  it('does not report correct order (cheap first)', () => {
    expect(analyzeConditionOrder('a.ts', 'if (flag === true && expensiveCheck(x)) {}')).toHaveLength(0)
  })

  it('does not report two expensive operands or two cheap operands', () => {
    expect(analyzeConditionOrder('a.ts', 'if (checkA(x) && checkB(y)) {}')).toHaveLength(0)
    expect(analyzeConditionOrder('a.ts', 'if (a > 1 && b < 2) {}')).toHaveLength(0)
  })
})
