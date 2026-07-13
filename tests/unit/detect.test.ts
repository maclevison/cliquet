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
  it('detecta .prettierrc e prettier.config.js', () => {
    expect(hasPrettierConfig(root)).toBe(false)
    writeFileSync(join(root, '.prettierrc'), '{}')
    expect(hasPrettierConfig(root)).toBe(true)
  })

  it('detecta chave prettier no package.json', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ prettier: {} }))
    expect(hasPrettierConfig(root)).toBe(true)
  })

  it('detecta prettier.config.mjs', () => {
    writeFileSync(join(root, 'prettier.config.mjs'), '')
    expect(hasPrettierConfig(root)).toBe(true)
  })
})

describe('hasBiomeConfig', () => {
  it('detecta biome.json e biome.jsonc', () => {
    expect(hasBiomeConfig(root)).toBe(false)
    writeFileSync(join(root, 'biome.jsonc'), '{}')
    expect(hasBiomeConfig(root)).toBe(true)
  })

  it('detecta biome.json', () => {
    writeFileSync(join(root, 'biome.json'), '{}')
    expect(hasBiomeConfig(root)).toBe(true)
  })
})

describe('hasEslintConfig', () => {
  it('detecta flat config e config legada (spec §5 gate 3)', () => {
    expect(hasEslintConfig(root)).toBe(false)
    writeFileSync(join(root, 'eslint.config.mjs'), '')
    expect(hasEslintConfig(root)).toBe(true)
  })

  it('detecta .eslintrc.json (config legada)', () => {
    writeFileSync(join(root, '.eslintrc.json'), '{}')
    expect(hasEslintConfig(root)).toBe(true)
  })

  it('detecta eslintConfig no package.json', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ eslintConfig: {} }))
    expect(hasEslintConfig(root)).toBe(true)
  })
})

describe('hasTsconfig', () => {
  it('detecta tsconfig.json', () => {
    expect(hasTsconfig(root)).toBe(false)
    writeFileSync(join(root, 'tsconfig.json'), '{}')
    expect(hasTsconfig(root)).toBe(true)
  })
})

describe('detectTestRunner', () => {
  it('detecta vitest e jest por devDependencies; vitest tem precedência (spec §5 gate 4)', () => {
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
