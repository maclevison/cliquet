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
  it('mantém apenas diretórios existentes', () => {
    mkdirSync(join(root, 'src'))
    const dirs = resolveSourceDirs(root, ['src', 'app', 'lib'])
    expect(dirs).toEqual([join(root, 'src')])
  })

  it('cai para a raiz quando nenhum existe (spec §4)', () => {
    const dirs = resolveSourceDirs(root, ['src', 'app'])
    expect(dirs).toEqual([root])
  })

  it('ignora arquivo (não diretório) com nome de source_dir sem lançar', () => {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'lib'), 'não sou um diretório')
    const dirs = resolveSourceDirs(root, ['src', 'lib'])
    expect(dirs).toEqual([join(root, 'src')])
  })
})

describe('listSourceFiles', () => {
  it('lista extensões de fonte recursivamente', () => {
    mkdirSync(join(root, 'src', 'deep'), { recursive: true })
    touch('src/a.ts')
    touch('src/deep/b.jsx')
    touch('src/styles.css') // não é fonte
    const files = listSourceFiles([join(root, 'src')])
    expect(files).toHaveLength(2)
    expect(files.some((f) => f.endsWith('a.ts'))).toBe(true)
    expect(files.some((f) => f.endsWith('b.jsx'))).toBe(true)
  })

  it('ignora node_modules, dist, coverage e .git', () => {
    for (const ignored of ['node_modules', 'dist', 'coverage', '.git']) {
      mkdirSync(join(root, 'src', ignored), { recursive: true })
      touch(`src/${ignored}/x.ts`)
    }
    touch('src/ok.ts')
    const files = listSourceFiles([join(root, 'src')])
    expect(files).toHaveLength(1)
  })
})
