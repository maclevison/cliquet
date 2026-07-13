import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findRepoRoot, dirChain } from '../../src/workspace.js'

let repo: string
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'cliquet-ws-'))
  repo = join(base, 'repo')
  mkdirSync(join(repo, 'apps', 'web'), { recursive: true })
  mkdirSync(join(repo, '.git'))
})

describe('findRepoRoot', () => {
  it('finds the git root from a nested workspace', () => {
    expect(findRepoRoot(join(repo, 'apps', 'web'))).toBe(repo)
  })

  it('returns the start itself when it contains .git', () => {
    expect(findRepoRoot(repo)).toBe(repo)
  })

  it('accepts .git as a FILE (worktrees/submodules)', () => {
    const base = mkdtempSync(join(tmpdir(), 'cliquet-ws-'))
    const wt = join(base, 'wt')
    mkdirSync(join(wt, 'pkg'), { recursive: true })
    writeFileSync(join(wt, '.git'), 'gitdir: /elsewhere\n')
    expect(findRepoRoot(join(wt, 'pkg'))).toBe(wt)
  })

  it('returns null when no .git exists up to the filesystem root', () => {
    // assumption: nothing above the OS tmpdir carries a .git
    const loose = mkdtempSync(join(tmpdir(), 'cliquet-ws-loose-'))
    expect(findRepoRoot(loose)).toBeNull()
  })
})

describe('dirChain', () => {
  it('lists start up to stopDir inclusive', () => {
    expect(dirChain(join(repo, 'apps', 'web'), repo)).toEqual([
      join(repo, 'apps', 'web'),
      join(repo, 'apps'),
      repo,
    ])
  })

  it('collapses to [start] when stopDir is null', () => {
    expect(dirChain(join(repo, 'apps', 'web'), null)).toEqual([join(repo, 'apps', 'web')])
  })

  it('start === stopDir yields a single-element chain', () => {
    expect(dirChain(repo, repo)).toEqual([repo])
  })

  it('collapses to [start] when stopDir is not an ancestor (defensive)', () => {
    expect(dirChain(repo, join(repo, 'apps'))).toEqual([repo])
  })
})
