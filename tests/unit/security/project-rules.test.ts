import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkGitignoreSensitive, checkPackageFreshness } from '../../../src/security/project-rules.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cliquet-projrules-'))
})

describe('checkGitignoreSensitive', () => {
  it('reports missing sensitive entries', () => {
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n')
    const findings = checkGitignoreSensitive(root)
    expect(findings.map((f) => f.message).join(' ')).toContain('.env')
    expect(findings).toHaveLength(3) // .env, *.pem, *.key
  })

  it('passes when .gitignore covers everything', () => {
    writeFileSync(join(root, '.gitignore'), '.env\n*.pem\n*.key\n')
    expect(checkGitignoreSensitive(root)).toHaveLength(0)
  })

  it('with no .gitignore, reports the 3 entries', () => {
    expect(checkGitignoreSensitive(root)).toHaveLength(3)
  })
})

describe('checkPackageFreshness', () => {
  it('reports a dependency published less than 3 days ago', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'left-pad': '^1.0.0' } }))
    const now = new Date('2026-07-13T00:00:00Z')
    const fetcher = vi.fn().mockResolvedValue({ time: { modified: '2026-07-12T00:00:00Z' } })
    const findings = await checkPackageFreshness(root, fetcher, now)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('left-pad')
  })

  it('does not report an old package', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'left-pad': '^1.0.0' } }))
    const now = new Date('2026-07-13T00:00:00Z')
    const fetcher = vi.fn().mockResolvedValue({ time: { modified: '2026-01-01T00:00:00Z' } })
    expect(await checkPackageFreshness(root, fetcher, now)).toHaveLength(0)
  })

  it('silent skip when the network fails (spec §6)', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'left-pad': '^1.0.0' } }))
    const fetcher = vi.fn().mockRejectedValue(new Error('ENOTFOUND'))
    expect(await checkPackageFreshness(root, fetcher, new Date())).toHaveLength(0)
  })

  it('queries all deps (parallelized in batches)', async () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        dependencies: { a: '^1.0.0', b: '^1.0.0', c: '^1.0.0' },
        devDependencies: { d: '^1.0.0' },
      }),
    )
    const now = new Date('2026-07-13T00:00:00Z')
    const fetcher = vi.fn().mockResolvedValue({ time: { modified: '2026-07-12T00:00:00Z' } })
    const findings = await checkPackageFreshness(root, fetcher, now)
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(fetcher.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(findings).toHaveLength(4)
  })
})
