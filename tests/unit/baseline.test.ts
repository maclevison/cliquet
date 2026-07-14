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
  it('follows the spec §4 defaults', () => {
    expect(DEFAULT_BASELINE.schema).toBe('cliquet/v1')
    expect(DEFAULT_BASELINE.source_dirs.paths).toEqual(['src', 'app', 'lib'])
    expect(DEFAULT_BASELINE.coverage.percentage).toBe(85.0)
    expect(DEFAULT_BASELINE.duplication).toEqual({ percentage: 2.0, min_lines: 5, min_tokens: 50 })
    expect(DEFAULT_BASELINE.file_size.max_lines).toBe(1000)
    expect(DEFAULT_BASELINE.complexity).toEqual({ warn_ccn: 20, block_ccn: 50 })
    expect(DEFAULT_BASELINE.bundle_size).toEqual({
      max_total_gzip_kb: 0,
      // 0.5%: same dist gzips differently across node/zlib versions (389.88 vs
      // 390.15 KB observed) — zero tolerance flaps between dev and CI.
      tolerance_percent: 0.5,
      dist_dirs: ['dist', 'build', '.output'],
    })
    expect(Object.keys(DEFAULT_BASELINE.security.rules)).toHaveLength(12)
    expect(DEFAULT_BASELINE.security.advisories).toBe(0)
  })

  it('defaults source_dirs.exclude to []', () => {
    expect(DEFAULT_BASELINE.source_dirs).toEqual({ paths: ['src', 'app', 'lib'], exclude: [] })
  })
})

describe('source_dirs.exclude validation', () => {
  it('accepts a valid exclude list', () => {
    writeFileSync(
      join(dir, BASELINE_FILENAME),
      JSON.stringify({ schema: 'cliquet/v1', source_dirs: { exclude: ['app/api/gen'] } }),
    )
    expect(loadBaseline(dir).source_dirs.exclude).toEqual(['app/api/gen'])
  })

  it.each([
    ['non-string entry', ['gen', 42], /entries must be strings, got 42/],
    ['comma pattern', ['a,b'], /entry "a,b" must not contain ","/],
    [
      'brace pattern',
      ['**/*.{gen,mock}.ts'],
      /entry "\*\*\/\*\.\{gen,mock\}\.ts" must not contain "\{" or "\}"/,
    ],
    ['negation pattern', ['!keep'], /entry "!keep" must not start with "!"/],
  ] as const)('rejects %s with ConfigError', (_name, exclude, messageFragment) => {
    writeFileSync(
      join(dir, BASELINE_FILENAME),
      JSON.stringify({ schema: 'cliquet/v1', source_dirs: { exclude } }),
    )
    expect(() => loadBaseline(dir)).toThrow(ConfigError)
    expect(() => loadBaseline(dir)).toThrow(messageFragment)
  })

  it('rejects a non-string source_dirs.paths entry (same element-level check)', () => {
    writeFileSync(
      join(dir, BASELINE_FILENAME),
      JSON.stringify({ schema: 'cliquet/v1', source_dirs: { paths: ['src', 7] } }),
    )
    expect(() => loadBaseline(dir)).toThrow(ConfigError)
  })

  it('rejects a non-array source_dirs.exclude (e.g. a plain string)', () => {
    writeFileSync(
      join(dir, BASELINE_FILENAME),
      JSON.stringify({ schema: 'cliquet/v1', source_dirs: { exclude: 'gen' } }),
    )
    expect(() => loadBaseline(dir)).toThrow(ConfigError)
  })
})

describe('security.suppress validation (open-map passthrough)', () => {
  function writeSuppress(suppress: unknown) {
    writeFileSync(
      join(dir, BASELINE_FILENAME),
      JSON.stringify({ schema: 'cliquet/v1', security: { suppress } }),
    )
  }

  it('defaults suppress to {}', () => {
    expect(DEFAULT_BASELINE.security.suppress).toEqual({})
  })

  it('PRESERVES entries through load (mergeSection must not key-filter the open map)', () => {
    writeSuppress({ '**/*.test.ts': ['hardcoded_secrets'], 'src/zod-config.ts': ['eval_usage'] })
    expect(loadBaseline(dir).security.suppress).toEqual({
      '**/*.test.ts': ['hardcoded_secrets'],
      'src/zod-config.ts': ['eval_usage'],
    })
  })

  it('keeps the other security keys when suppress is present', () => {
    writeSuppress({ 'src/a.ts': ['eval_usage'] })
    const b = loadBaseline(dir)
    expect(b.security.advisories).toBe(0)
    expect(Object.keys(b.security.rules)).toHaveLength(12)
  })

  it.each([
    ['unknown rule', { 'src/a.ts': ['not_a_rule'] }, /not_a_rule/],
    ['project rule (content-only)', { '.gitignore': ['gitignore_sensitive'] }, /gitignore_sensitive/],
    ['brace glob key', { '**/*.{a,b}.ts': ['eval_usage'] }, /must not contain "\{"/],
    ['negation glob key', { '!keep.ts': ['eval_usage'] }, /must not start with "!"/],
    ['non-array value', { 'src/a.ts': 'eval_usage' }, /must be an array/],
    ['non-object suppress', ['eval_usage'], /must be an object/],
  ] as const)('rejects %s with ConfigError', (_name, suppress, messageFragment) => {
    writeSuppress(suppress)
    expect(() => loadBaseline(dir)).toThrow(ConfigError)
    expect(() => loadBaseline(dir)).toThrow(messageFragment)
  })
})

describe('saveBaseline / loadBaseline', () => {
  it('round-trip preserves the content', () => {
    saveBaseline(dir, DEFAULT_BASELINE)
    const loaded = loadBaseline(dir)
    expect(loaded).toEqual(DEFAULT_BASELINE)
    expect(baselineExists(dir)).toBe(true)
  })

  it('merges missing sections with the defaults', () => {
    writeFileSync(
      join(dir, BASELINE_FILENAME),
      JSON.stringify({ schema: 'cliquet/v1', coverage: { percentage: 70 } }),
    )
    const loaded = loadBaseline(dir)
    expect(loaded.coverage.percentage).toBe(70)
    expect(loaded.file_size.max_lines).toBe(1000) // default preserved
  })

  it('merges security.rules 2 levels deep while preserving defaults', () => {
    writeFileSync(
      join(dir, BASELINE_FILENAME),
      JSON.stringify({ schema: 'cliquet/v1', security: { rules: { eval_usage: false } } }),
    )
    const loaded = loadBaseline(dir)
    expect(loaded.security.rules.eval_usage).toBe(false)
    expect(loaded.security.rules.hardcoded_secrets).toBe(true) // default preserved
    expect(loaded.security.advisories).toBe(0) // default preserved
  })

  it('throws ConfigError when an object section is given as a scalar', () => {
    writeFileSync(join(dir, BASELINE_FILENAME), JSON.stringify({ security: 'oops' }))
    expect(() => loadBaseline(dir)).toThrow(ConfigError)
  })

  it('throws ConfigError when a scalar has the wrong type', () => {
    writeFileSync(join(dir, BASELINE_FILENAME), JSON.stringify({ coverage: { percentage: '70' } }))
    expect(() => loadBaseline(dir)).toThrow(ConfigError)
  })

  it('throws ConfigError when security.rules is given as an array', () => {
    writeFileSync(join(dir, BASELINE_FILENAME), JSON.stringify({ security: { rules: ['x'] } }))
    expect(() => loadBaseline(dir)).toThrow(ConfigError)
  })

  it('throws ConfigError for invalid JSON', () => {
    writeFileSync(join(dir, BASELINE_FILENAME), '{ invalid')
    expect(() => loadBaseline(dir)).toThrow(ConfigError)
  })

  it('throws ConfigError for an unknown schema', () => {
    writeFileSync(join(dir, BASELINE_FILENAME), JSON.stringify({ schema: 'cliquet/v99' }))
    expect(() => loadBaseline(dir)).toThrow(ConfigError)
  })

  it('saves with 2-space indentation and a trailing newline', () => {
    saveBaseline(dir, DEFAULT_BASELINE)
    const raw = readFileSync(join(dir, BASELINE_FILENAME), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw).toContain('  "schema"')
  })
})
