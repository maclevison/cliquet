import { describe, it, expect } from 'vitest'
import { measureFileComplexity } from '../../../src/gates/ccn.js'

describe('measureFileComplexity', () => {
  it('função sem branches tem CCN 1', () => {
    const [fn] = measureFileComplexity('a.ts', 'function simple() { return 1 }')
    expect(fn?.name).toBe('simple')
    expect(fn?.ccn).toBe(1)
  })

  it('conta if, loops, case, catch, ternário e operadores lógicos', () => {
    const code = `
      function busy(x: number) {
        if (x > 0) {}                      // +1
        for (let i = 0; i < x; i++) {}     // +1
        while (x < 0) { x++ }              // +1
        switch (x) { case 1: break; case 2: break } // +2
        try {} catch {}                    // +1
        const y = x > 1 ? 1 : 2            // +1
        return x > 0 && y > 0 || x === 5   // +2
      }
    `
    const [fn] = measureFileComplexity('a.ts', code)
    expect(fn?.ccn).toBe(10) // 1 base + 9
  })

  it('não soma a complexidade de funções aninhadas na função externa', () => {
    const code = `
      function outer() {
        const inner = (x: number) => (x > 0 ? 1 : 2)
        return inner(1)
      }
    `
    const results = measureFileComplexity('a.ts', code)
    const outer = results.find((r) => r.name === 'outer')
    const inner = results.find((r) => r.name !== 'outer')
    expect(outer?.ccn).toBe(1)
    expect(inner?.ccn).toBe(2)
  })

  it('mede arrow functions, métodos e funções JS', () => {
    const code = `
      class A { method(x) { return x ? 1 : 2 } }
      const arrow = (x) => x ? 1 : 2
    `
    const results = measureFileComplexity('a.js', code)
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.ccn === 2)).toBe(true)
  })

  it('não lança em arquivo com sintaxe inválida (createSourceFile degrada silenciosamente)', () => {
    expect(() => measureFileComplexity('a.ts', 'function {{{ ??? <<>> !!')).not.toThrow()
  })
})
