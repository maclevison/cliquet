import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SecurityFinding } from './content-rules.js'

const REQUIRED_IGNORES = ['.env', '*.pem', '*.key']

export function checkGitignoreSensitive(rootPath: string): SecurityFinding[] {
  const path = join(rootPath, '.gitignore')
  const content = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const entries = new Set(content.split('\n').map((l) => l.trim()))
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
/** Cap de concorrência: evita que N deps × timeout de 5s consumam o budget da gate em série. */
const FRESHNESS_CONCURRENCY = 8

export async function checkPackageFreshness(
  rootPath: string,
  fetcher: RegistryFetcher = defaultRegistryFetcher,
  now: Date = new Date(),
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
  const findings: SecurityFinding[] = []
  for (let i = 0; i < deps.length; i += FRESHNESS_CONCURRENCY) {
    const batch = deps.slice(i, i + FRESHNESS_CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(async (dep): Promise<SecurityFinding | null> => {
        const meta = await fetcher(dep)
        const modified = meta.time?.modified
        if (modified && now.getTime() - new Date(modified).getTime() < FRESHNESS_WINDOW_MS) {
          return {
            rule: 'package_freshness',
            file: 'package.json',
            line: 1,
            message: `Package "${dep}" was published less than 3 days ago (untested by the ecosystem)`,
          }
        }
        return null
      }),
    )
    for (const result of results) {
      // rejeição = sem rede / registry fora: skip silencioso por dep (spec §6)
      if (result.status === 'fulfilled' && result.value !== null) findings.push(result.value)
    }
  }
  return findings
}
