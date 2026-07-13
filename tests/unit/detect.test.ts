import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

function mkMonorepo() {
  const repo = join(mkdtempSync(join(tmpdir(), 'cliquet-mono-')), 'repo')
  mkdirSync(join(repo, 'apps', 'web'), { recursive: true })
  mkdirSync(join(repo, '.git'))
  return { repo, web: join(repo, 'apps', 'web') }
}

describe('config walk-up', () => {
  it.each([
    ['hasPrettierConfig', '.prettierrc', hasPrettierConfig],
    ['hasEslintConfig', 'eslint.config.js', hasEslintConfig],
    ['hasBiomeConfig', 'biome.json', hasBiomeConfig],
  ] as const)('%s finds a root-level config from a workspace', (_n, file, fn) => {
    const { repo, web } = mkMonorepo()
    writeFileSync(join(repo, file), '{}')
    expect(fn(web, repo)).toBe(true)
    expect(fn(web)).toBe(false) // without stopDir: local-only preserved
  })

  it('detects a package.json key (prettier) at the root level', () => {
    const { repo, web } = mkMonorepo()
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ prettier: {} }))
    expect(hasPrettierConfig(web, repo)).toBe(true)
  })

  it('does not look ABOVE the stopDir', () => {
    const { repo, web } = mkMonorepo()
    writeFileSync(join(dirname(repo), '.prettierrc'), '{}') // above the git root
    expect(hasPrettierConfig(web, repo)).toBe(false)
  })
})
