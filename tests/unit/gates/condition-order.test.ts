import { describe, it, expect } from 'vitest'
import { analyzeConditionOrder } from '../../../src/gates/condition-order.js'

describe('analyzeConditionOrder', () => {
  it('detecta chamada cara antes de comparação barata em &&', () => {
    const findings = analyzeConditionOrder('a.ts', 'if (expensiveCheck(x) && flag === true) {}')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.line).toBe(1)
  })

  it('detecta await antes de operando barato em ||', () => {
    const code = 'async function f() { return (await fetchIt()) || cached }'
    expect(analyzeConditionOrder('a.ts', code)).toHaveLength(1)
  })

  it('não reporta ordem correta (barato primeiro)', () => {
    expect(analyzeConditionOrder('a.ts', 'if (flag === true && expensiveCheck(x)) {}')).toHaveLength(0)
  })

  it('não reporta dois operandos caros nem dois baratos', () => {
    expect(analyzeConditionOrder('a.ts', 'if (checkA(x) && checkB(y)) {}')).toHaveLength(0)
    expect(analyzeConditionOrder('a.ts', 'if (a > 1 && b < 2) {}')).toHaveLength(0)
  })
})
