import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSourceFiles, resolveSourceDirs } from '../../src/source-files.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cliquet-walker-'))
})

function touch(path: string, content = '') {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), content)
}

describe('resolveSourceDirs', () => {
  it('keeps only existing directories', () => {
    mkdirSync(join(root, 'src'))
    const dirs = resolveSourceDirs(root, ['src', 'app', 'lib'])
    expect(dirs).toEqual([join(root, 'src')])
  })

  it('falls back to the root when none exist (spec §4)', () => {
    const dirs = resolveSourceDirs(root, ['src', 'app'])
    expect(dirs).toEqual([root])
  })

  it('ignores a file (not a directory) named like a source_dir without throwing', () => {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'lib'), 'I am not a directory')
    const dirs = resolveSourceDirs(root, ['src', 'lib'])
    expect(dirs).toEqual([join(root, 'src')])
  })
})

describe('listSourceFiles', () => {
  it('lists source extensions recursively', () => {
    mkdirSync(join(root, 'src', 'deep'), { recursive: true })
    touch('src/a.ts')
    touch('src/deep/b.jsx')
    touch('src/styles.css') // not a source file
    const files = listSourceFiles([join(root, 'src')])
    expect(files).toHaveLength(2)
    expect(files.some((f) => f.endsWith('a.ts'))).toBe(true)
    expect(files.some((f) => f.endsWith('b.jsx'))).toBe(true)
  })

  it('ignores node_modules, dist, coverage and .git', () => {
    for (const ignored of ['node_modules', 'dist', 'coverage', '.git']) {
      mkdirSync(join(root, 'src', ignored), { recursive: true })
      touch(`src/${ignored}/x.ts`)
    }
    touch('src/ok.ts')
    const files = listSourceFiles([join(root, 'src')])
    expect(files).toHaveLength(1)
  })
})
