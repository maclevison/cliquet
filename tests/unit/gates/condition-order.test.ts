import { describe, it, expect } from 'vitest'
import { analyzeConditionOrder } from '../../../src/gates/condition-order.js'

describe('analyzeConditionOrder', () => {
  it('detects an expensive call before a cheap comparison in &&', () => {
    const findings = analyzeConditionOrder('a.ts', 'if (expensiveCheck(x) && flag === true) {}')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.line).toBe(1)
  })

  it('does not report correct order (cheap first)', () => {
    expect(analyzeConditionOrder('a.ts', 'if (flag === true && expensiveCheck(x)) {}')).toHaveLength(0)
  })

  it('does not report two expensive operands or two cheap operands', () => {
    expect(analyzeConditionOrder('a.ts', 'if (checkA(x) && checkB(y)) {}')).toHaveLength(0)
    expect(analyzeConditionOrder('a.ts', 'if (a > 1 && b < 2) {}')).toHaveLength(0)
  })

  describe('boolean context only', () => {
    it('flags an expensive || cheap used as an if condition', () => {
      const code = 'async function f() { if ((await fetchIt()) || cached) {} }'
      expect(analyzeConditionOrder('a.ts', code)).toHaveLength(1)
    })

    it('flags inside while / for / ternary condition / prefix !', () => {
      expect(analyzeConditionOrder('a.ts', 'while (getIt() || cached) {}')).toHaveLength(1)
      expect(analyzeConditionOrder('a.ts', 'for (; getIt() || cached; ) {}')).toHaveLength(1)
      expect(analyzeConditionOrder('a.ts', 'const y = (getIt() || cached) ? 1 : 2')).toHaveLength(1)
      expect(analyzeConditionOrder('a.ts', 'const z = !(getIt() || cached)')).toHaveLength(1)
    })

    it('flags a nested logical whose outer expression is a boolean context', () => {
      // outer `a && (...)` is not flagged (cheap left); inner `expensive() || cheap` is, in boolean context
      expect(analyzeConditionOrder('a.ts', 'if (a && (getIt() || cached)) {}')).toHaveLength(1)
    })

    it('does NOT flag the value-selection idiom `call() || default`', () => {
      expect(analyzeConditionOrder('a.ts', 'const base = getName() || projectId')).toHaveLength(0)
      expect(analyzeConditionOrder('a.ts', 'function f() { return getIt() || cached }')).toHaveLength(0)
      expect(
        analyzeConditionOrder('a.ts', 'async function f() { return (await fetchIt()) || cached }'),
      ).toHaveLength(0)
    })

    it('does NOT flag a nested logical in a value context', () => {
      expect(analyzeConditionOrder('a.ts', 'const x = a && (getIt() || cached)')).toHaveLength(0)
    })

    it('does NOT flag a bare expression-statement guard (order is behavior)', () => {
      expect(analyzeConditionOrder('a.ts', 'getIt() && cached')).toHaveLength(0)
    })
  })
})
