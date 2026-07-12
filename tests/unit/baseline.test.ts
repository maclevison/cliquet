import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_BASELINE,
  BASELINE_FILENAME,
  ConfigError,
  loadBaseline,
  saveBaseline,
  baselineExists,
} from '../../src/baseline.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cliquet-test-'))
})

describe('DEFAULT_BASELINE', () => {
  it('segue os defaults da spec §4', () => {
    expect(DEFAULT_BASELINE.schema).toBe('cliquet/v1')
    expect(DEFAULT_BASELINE.source_dirs.paths).toEqual(['src', 'app', 'lib'])
    expect(DEFAULT_BASELINE.coverage.percentage).toBe(85.0)
    expect(DEFAULT_BASELINE.duplication).toEqual({ percentage: 2.0, min_lines: 5, min_tokens: 50 })
    expect(DEFAULT_BASELINE.file_size.max_lines).toBe(1000)
    expect(DEFAULT_BASELINE.complexity).toEqual({ warn_ccn: 20, block_ccn: 50 })
    expect(DEFAULT_BASELINE.bundle_size).toEqual({
      max_total_gzip_kb: 0,
      tolerance_percent: 0,
      dist_dirs: ['dist', 'build', '.output'],
    })
    expect(Object.keys(DEFAULT_BASELINE.security.rules)).toHaveLength(12)
    expect(DEFAULT_BASELINE.security.advisories).toBe(0)
  })
})

describe('saveBaseline / loadBaseline', () => {
  it('round-trip preserva o conteúdo', () => {
    saveBaseline(dir, DEFAULT_BASELINE)
    const loaded = loadBaseline(dir)
    expect(loaded).toEqual(DEFAULT_BASELINE)
    expect(baselineExists(dir)).toBe(true)
  })

  it('mescla seções ausentes com os defaults', () => {
    writeFileSync(
      join(dir, BASELINE_FILENAME),
      JSON.stringify({ schema: 'cliquet/v1', coverage: { percentage: 70 } }),
    )
    const loaded = loadBaseline(dir)
    expect(loaded.coverage.percentage).toBe(70)
    expect(loaded.file_size.max_lines).toBe(1000) // default preservado
  })

  it('lança ConfigError para JSON inválido', () => {
    writeFileSync(join(dir, BASELINE_FILENAME), '{ invalid')
    expect(() => loadBaseline(dir)).toThrow(ConfigError)
  })

  it('lança ConfigError para schema desconhecido', () => {
    writeFileSync(join(dir, BASELINE_FILENAME), JSON.stringify({ schema: 'cliquet/v99' }))
    expect(() => loadBaseline(dir)).toThrow(ConfigError)
  })

  it('salva com identação de 2 espaços e newline final', () => {
    saveBaseline(dir, DEFAULT_BASELINE)
    const raw = readFileSync(join(dir, BASELINE_FILENAME), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw).toContain('  "schema"')
  })
})
