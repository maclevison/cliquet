import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webcrypto as crypto } from 'node:crypto'
import { bundleSizeGate, measureBundle } from '../../../src/gates/bundle-size.js'
import { DEFAULT_BASELINE, type Baseline } from '../../../src/baseline.js'
import { createProjectContext } from '../../../src/context.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cliquet-bundle-'))
})

function baselineWith(maxKb: number, tolerance = 0): Baseline {
  return {
    ...DEFAULT_BASELINE,
    bundle_size: { max_total_gzip_kb: maxKb, tolerance_percent: tolerance, dist_dirs: ['dist', 'build'] },
  }
}

describe('measureBundle', () => {
  it('soma gzip de js/css e ignora sourcemaps', () => {
    mkdirSync(join(root, 'dist'))
    writeFileSync(join(root, 'dist', 'app.js'), 'x'.repeat(10_000))
    writeFileSync(join(root, 'dist', 'app.css'), 'y'.repeat(5_000))
    writeFileSync(join(root, 'dist', 'app.js.map'), 'z'.repeat(50_000))
    const m = measureBundle(join(root, 'dist'))
    expect(m.files).toHaveLength(2)
    expect(m.totalGzipKb).toBeGreaterThan(0)
    expect(m.totalGzipKb).toBeLessThan(1) // strings repetidas comprimem muito
  })
})

describe('bundleSizeGate', () => {
  it('skip quando nenhum dist_dir existe', async () => {
    const baseline = baselineWith(100)
    const r = await bundleSizeGate.run(createProjectContext(root, baseline, 300_000), baseline)
    expect(r.status).toBe('skip')
  })

  it('skip com orientação quando max é 0 (não medido)', async () => {
    mkdirSync(join(root, 'dist'))
    writeFileSync(join(root, 'dist', 'app.js'), 'code')
    const baseline = baselineWith(0)
    const r = await bundleSizeGate.run(createProjectContext(root, baseline, 300_000), baseline)
    expect(r.status).toBe('skip')
    expect(r.message).toContain('init')
  })

  it('passa dentro do limite + tolerância e falha acima, listando top 5', async () => {
    mkdirSync(join(root, 'dist'))
    for (let i = 0; i < 7; i++) {
      // conteúdo aleatório comprime mal → tamanho previsível o bastante para o teste
      writeFileSync(join(root, 'dist', `chunk${i}.js`), crypto.getRandomValues(new Uint8Array(20_000)))
    }
    const big = baselineWith(1000)
    const pass = await bundleSizeGate.run(createProjectContext(root, big, 300_000), big)
    expect(pass.status).toBe('pass')

    const tiny = baselineWith(1)
    const fail = await bundleSizeGate.run(createProjectContext(root, tiny, 300_000), tiny)
    expect(fail.status).toBe('fail')
    expect(fail.actions[0]?.files).toHaveLength(5) // top 5
  })
})
