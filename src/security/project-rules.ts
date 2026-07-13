import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SecurityFinding } from './content-rules.js'
import { dirChain } from '../workspace.js'

const REQUIRED_IGNORES = ['.env', '*.pem', '*.key']

export function checkGitignoreSensitive(rootPath: string, stopDir: string | null = null): SecurityFinding[] {
  // Union over every .gitignore up to the repo root — git semantics: a root
  // entry covers all subdirectories, so a workspace must not be flagged for it.
  const entries = new Set<string>()
  for (const dir of dirChain(rootPath, stopDir)) {
    const path = join(dir, '.gitignore')
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, 'utf8').split('\n')) entries.add(line.trim())
  }
  return REQUIRED_IGNORES.filter((e) => !entries.has(e)).map((entry) => ({
    rule: 'gitignore_sensitive',
    file: '.gitignore',
    line: 1,
    message: `Missing "${entry}" entry in .gitignore`,
  }))
}

export type RegistryFetcher = (pkg: string) => Promise<{ time?: Record<string, string> }>

export async function defaultRegistryFetcher(pkg: string): Promise<{ time?: Record<string, string> }> {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`, {
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`registry returned ${res.status}`)
  return (await res.json()) as { time?: Record<string, string> }
}

const FRESHNESS_WINDOW_MS = 3 * 24 * 60 * 60 * 1000
/** Concurrency cap: prevents N deps × 5s timeout from eating the gate's budget serially. */
const FRESHNESS_CONCURRENCY = 8

/** Version actually installed (node_modules/<dep>/package.json, walking up for hoisted installs); null = not installed. */
function installedVersion(rootPath: string, dep: string, stopDir: string | null = null): string | null {
  for (const dir of dirChain(rootPath, stopDir)) {
    const path = join(dir, 'node_modules', dep, 'package.json')
    if (!existsSync(path)) continue
    try {
      const pkg = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
      return typeof pkg.version === 'string' ? pkg.version : null
    } catch {
      return null
    }
  }
  return null
}

export async function checkPackageFreshness(
  rootPath: string,
  fetcher: RegistryFetcher = defaultRegistryFetcher,
  now: Date = new Date(),
  stopDir: string | null = null,
): Promise<SecurityFinding[]> {
  const pkgPath = join(rootPath, 'package.json')
  if (!existsSync(pkgPath)) return []
  let deps: string[] = []
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]
  } catch {
    return []
  }
  // Freshness is a property of the INSTALLED version, not of the package:
  // time.modified moves on EVERY publish (react canaries ship daily), so it
  // would flag deps whose resolved version is years old. Not installed →
  // version unknown → silent skip, without wasting a registry call.
  const installed = deps
    .map((dep) => ({ dep, version: installedVersion(rootPath, dep, stopDir) }))
    .filter((d): d is { dep: string; version: string } => d.version !== null)
  const findings: SecurityFinding[] = []
  for (let i = 0; i < installed.length; i += FRESHNESS_CONCURRENCY) {
    const batch = installed.slice(i, i + FRESHNESS_CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(async ({ dep, version }): Promise<SecurityFinding | null> => {
        const meta = await fetcher(dep)
        const published = meta.time?.[version]
        if (published && now.getTime() - new Date(published).getTime() < FRESHNESS_WINDOW_MS) {
          return {
            rule: 'package_freshness',
            file: 'package.json',
            line: 1,
            message: `Package "${dep}@${version}" was published less than 3 days ago (untested by the ecosystem)`,
          }
        }
        return null
      }),
    )
    for (const result of results) {
      // rejection = no network / registry down: silent per-dep skip (spec §6)
      if (result.status === 'fulfilled' && result.value !== null) findings.push(result.value)
    }
  }
  return findings
}
