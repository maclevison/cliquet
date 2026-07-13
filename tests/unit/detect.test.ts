import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hasPrettierConfig,
  hasBiomeConfig,
  hasEslintConfig,
  hasTsconfig,
  detectTestRunner,
} from '../../src/detect.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cliquet-detect-'))
})

describe('hasPrettierConfig', () => {
  it('detects .prettierrc and prettier.config.js', () => {
    expect(hasPrettierConfig(root)).toBe(false)
    writeFileSync(join(root, '.prettierrc'), '{}')
    expect(hasPrettierConfig(root)).toBe(true)
  })

  it('detects the prettier key in package.json', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ prettier: {} }))
    expect(hasPrettierConfig(root)).toBe(true)
  })

  it('detects prettier.config.mjs', () => {
    writeFileSync(join(root, 'prettier.config.mjs'), '')
    expect(hasPrettierConfig(root)).toBe(true)
  })
})

describe('hasBiomeConfig', () => {
  it('detects biome.json and biome.jsonc', () => {
    expect(hasBiomeConfig(root)).toBe(false)
    writeFileSync(join(root, 'biome.jsonc'), '{}')
    expect(hasBiomeConfig(root)).toBe(true)
  })

  it('detects biome.json', () => {
    writeFileSync(join(root, 'biome.json'), '{}')
    expect(hasBiomeConfig(root)).toBe(true)
  })
})

describe('hasEslintConfig', () => {
  it('detects flat config and legacy config (spec §5 gate 3)', () => {
    expect(hasEslintConfig(root)).toBe(false)
    writeFileSync(join(root, 'eslint.config.mjs'), '')
    expect(hasEslintConfig(root)).toBe(true)
  })

  it('detects .eslintrc.json (legacy config)', () => {
    writeFileSync(join(root, '.eslintrc.json'), '{}')
    expect(hasEslintConfig(root)).toBe(true)
  })

  it('detects eslintConfig in package.json', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ eslintConfig: {} }))
    expect(hasEslintConfig(root)).toBe(true)
  })
})

describe('hasTsconfig', () => {
  it('detects tsconfig.json', () => {
    expect(hasTsconfig(root)).toBe(false)
    writeFileSync(join(root, 'tsconfig.json'), '{}')
    expect(hasTsconfig(root)).toBe(true)
  })
})

describe('detectTestRunner', () => {
  it('detects vitest and jest via devDependencies; vitest takes precedence (spec §5 gate 4)', () => {
    expect(detectTestRunner(root)).toBeNull()
    writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { jest: '^29.0.0' } }))
    expect(detectTestRunner(root)).toBe('jest')
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ devDependencies: { jest: '^29.0.0', vitest: '^3.0.0' } }),
    )
    expect(detectTestRunner(root)).toBe('vitest')
  })
})
