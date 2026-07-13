import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
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
  function installDep(name: string, version: string) {
    const dir = join(root, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
  }

  it('reports a dependency whose INSTALLED version was published less than 3 days ago', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'left-pad': '^1.0.0' } }))
    installDep('left-pad', '1.3.0')
    const now = new Date('2026-07-13T00:00:00Z')
    const fetcher = vi.fn().mockResolvedValue({
      time: { modified: '2026-01-01T00:00:00Z', '1.3.0': '2026-07-12T00:00:00Z' },
    })
    const findings = await checkPackageFreshness(root, fetcher, now)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('left-pad@1.3.0')
  })

  it('does NOT report when the installed version is old, even if the package published recently (daily canaries)', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { react: '^18.0.0' } }))
    installDep('react', '18.2.0')
    const now = new Date('2026-07-13T00:00:00Z')
    // time.modified is fresh (a canary published yesterday) but the installed 18.2.0 is a year old
    const fetcher = vi.fn().mockResolvedValue({
      time: { modified: '2026-07-12T00:00:00Z', '18.2.0': '2025-06-14T00:00:00Z' },
    })
    expect(await checkPackageFreshness(root, fetcher, now)).toHaveLength(0)
  })

  it('does not report an old installed version', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'left-pad': '^1.0.0' } }))
    installDep('left-pad', '1.3.0')
    const now = new Date('2026-07-13T00:00:00Z')
    const fetcher = vi.fn().mockResolvedValue({ time: { '1.3.0': '2026-01-01T00:00:00Z' } })
    expect(await checkPackageFreshness(root, fetcher, now)).toHaveLength(0)
  })

  it('silently skips a dependency that is not installed (no node_modules entry) without fetching', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'left-pad': '^1.0.0' } }))
    const fetcher = vi.fn().mockResolvedValue({ time: { modified: '2026-07-12T00:00:00Z' } })
    expect(await checkPackageFreshness(root, fetcher, new Date('2026-07-13T00:00:00Z'))).toHaveLength(0)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('silently skips when the registry has no timestamp for the installed version', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'left-pad': '^1.0.0' } }))
    installDep('left-pad', '1.3.0')
    const fetcher = vi.fn().mockResolvedValue({ time: { modified: '2026-07-12T00:00:00Z' } })
    expect(await checkPackageFreshness(root, fetcher, new Date('2026-07-13T00:00:00Z'))).toHaveLength(0)
  })

  it('resolves the installed version of scoped packages', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@prisma/client': '^5.0.0' } }))
    installDep('@prisma/client', '5.1.0')
    const now = new Date('2026-07-13T00:00:00Z')
    const fetcher = vi.fn().mockResolvedValue({ time: { '5.1.0': '2026-07-12T00:00:00Z' } })
    const findings = await checkPackageFreshness(root, fetcher, now)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('@prisma/client@5.1.0')
  })

  it('silent skip when the network fails (spec §6)', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'left-pad': '^1.0.0' } }))
    installDep('left-pad', '1.3.0')
    const fetcher = vi.fn().mockRejectedValue(new Error('ENOTFOUND'))
    expect(await checkPackageFreshness(root, fetcher, new Date())).toHaveLength(0)
  })

  it('queries all installed deps (parallelized in batches)', async () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        dependencies: { a: '^1.0.0', b: '^1.0.0', c: '^1.0.0' },
        devDependencies: { d: '^1.0.0' },
      }),
    )
    for (const dep of ['a', 'b', 'c', 'd']) installDep(dep, '1.0.0')
    const now = new Date('2026-07-13T00:00:00Z')
    const fetcher = vi.fn().mockResolvedValue({ time: { '1.0.0': '2026-07-12T00:00:00Z' } })
    const findings = await checkPackageFreshness(root, fetcher, now)
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(fetcher.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(findings).toHaveLength(4)
  })
})
