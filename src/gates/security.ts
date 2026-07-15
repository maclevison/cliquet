import { readFileSync, readdirSync, type Dirent } from 'node:fs'
import { join, relative } from 'node:path'
import picomatch from 'picomatch'
import type { Action, Gate, GateResult, ProjectContext } from '../types.js'
import { expandExcludePatterns, toPosix } from '../context.js'
import { listSourceFiles } from '../source-files.js'
import { CONTENT_RULES, runContentRules, type DirectiveUse, type SecurityFinding } from '../security/content-rules.js'
import {
  checkGitignoreSensitive,
  checkPackageFreshness,
  defaultRegistryFetcher,
  type RegistryFetcher,
} from '../security/project-rules.js'

export interface AuditCounts {
  criticalHigh: number
  total: number
  /** Names of packages with ≥1 critical/high advisory — surfaced in the fail action. */
  packages?: string[]
}

interface Advisory {
  severity?: string
}

/**
 * Queries the npm bulk advisory endpoint directly (npm's own audit backend) instead of shelling out
 * to `<pm> audit`. The retired GET audits endpoint (410 as of 2026-07-15) broke `pnpm audit --json`
 * project-wide; the bulk endpoint pre-filters advisories to the versions we send, so we count what it
 * returns. `installed` is `{ pkg: [versions] }`; the response is `{ pkg: [advisory] }` (only vulnerable
 * packages appear). Returns null on any transport/endpoint failure — audit becomes UNMEASURABLE (skip),
 * never a gate ERROR.
 */
export type AdvisoryFetcher = (installed: Record<string, string[]>) => Promise<Record<string, Advisory[]> | null>

const BULK_ADVISORY_URL = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk'

export async function defaultBulkFetcher(installed: Record<string, string[]>): Promise<Record<string, Advisory[]>> {
  const res = await fetch(BULK_ADVISORY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(installed),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`bulk advisory endpoint returned ${res.status}`)
  return (await res.json()) as Record<string, Advisory[]>
}

const addVersion = (out: Map<string, Set<string>>, name: string, version: string): void => {
  let s = out.get(name)
  if (!s) {
    s = new Set()
    out.set(name, s)
  }
  s.add(version)
}

function recordPackage(pkgDir: string, out: Map<string, Set<string>>): void {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
    if (typeof pkg.name === 'string' && typeof pkg.version === 'string') addVersion(out, pkg.name, pkg.version)
  } catch {
    // no/invalid package.json here — not a package dir
  }
  scanNodeModules(join(pkgDir, 'node_modules'), out) // npm/yarn nesting
}

const dirsIn = (dir: string): Dirent[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()) // isDirectory() is false for symlinks → no cycles
  } catch {
    return []
  }
}

function scanNodeModules(nmDir: string, out: Map<string, Set<string>>): void {
  for (const e of dirsIn(nmDir)) {
    if (e.name === '.bin') continue
    const full = join(nmDir, e.name)
    if (e.name === '.pnpm') {
      // pnpm store: .pnpm/<pkg>@<ver>/node_modules/<pkg> holds the REAL copies (top-level are symlinks)
      for (const store of dirsIn(full)) scanNodeModules(join(full, store.name, 'node_modules'), out)
    } else if (e.name.startsWith('@')) {
      for (const scoped of dirsIn(full)) recordPackage(join(full, scoped.name), out)
    } else {
      recordPackage(full, out)
    }
  }
}

/** Every package installed under `dir/node_modules` (name → versions). Walks real dirs only, so pnpm's
 *  symlink farm can't cycle while its `.pnpm` real copies are still reached. PM-agnostic, dep-free. */
export function collectInstalledPackages(dir: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  scanNodeModules(join(dir, 'node_modules'), out)
  return out
}

/** Audits the installed tree against the bulk advisory endpoint. null = UNMEASURABLE (no lockfile, deps
 *  not installed, or registry unreachable) → the gate skips advisories; it never errors on that. */
export async function defaultRunAudit(ctx: ProjectContext, fetcher: AdvisoryFetcher = defaultBulkFetcher): Promise<AuditCounts | null> {
  if (ctx.packageManager === null) return null // no lockfile → nothing to audit (unchanged contract)
  const installed = collectInstalledPackages(ctx.lockfileDir ?? ctx.rootPath)
  if (installed.size === 0) return null // deps not installed → cannot measure
  const body: Record<string, string[]> = {}
  for (const [name, versions] of installed) body[name] = [...versions]
  let advisories: Record<string, Advisory[]> | null
  try {
    advisories = await fetcher(body)
  } catch {
    return null // endpoint/transport failure → unmeasurable, NEVER a gate error
  }
  if (!advisories) return null
  let criticalHigh = 0
  let total = 0
  const packages: string[] = []
  for (const [name, list] of Object.entries(advisories)) {
    if (!Array.isArray(list)) continue
    let hit = false
    for (const a of list) {
      total++
      if (a?.severity === 'critical' || a?.severity === 'high') {
        criticalHigh++
        hit = true
      }
    }
    if (hit) packages.push(name)
  }
  return { criticalHigh, total, packages }
}

export interface SecurityGateDeps {
  runAudit?: (ctx: ProjectContext) => Promise<AuditCounts | null>
  freshnessFetcher?: RegistryFetcher
}

export function createSecurityGate(deps: SecurityGateDeps = {}): Gate {
  const runAudit = deps.runAudit ?? defaultRunAudit
  const freshnessFetcher = deps.freshnessFetcher ?? defaultRegistryFetcher

  return {
    name: 'security',
    label: 'Security Audit',

    async run(ctx, baseline): Promise<GateResult> {
      const rules = baseline.security.rules
      const findings: SecurityFinding[] = []

      // Enabled content rules — single split per file in runContentRules
      const enabledContentRules = Object.keys(CONTENT_RULES).filter((name) => rules[name as keyof typeof rules])
      const unusedDirectives: DirectiveUse[] = []
      if (enabledContentRules.length > 0) {
        for (const file of listSourceFiles(ctx.sourceDirs, ctx.isExcluded)) {
          const content = readFileSync(file, 'utf8')
          const rel = relative(ctx.rootPath, file)
          findings.push(...runContentRules(rel, content, enabledContentRules, unusedDirectives))
        }
      }

      // Project rules
      if (rules.gitignore_sensitive) findings.push(...checkGitignoreSensitive(ctx.rootPath, ctx.repoRoot))
      if (rules.package_freshness)
        findings.push(...(await checkPackageFreshness(ctx.rootPath, freshnessFetcher, undefined, ctx.repoRoot)))

      // Drop findings matched by security.suppress (glob → content-rule names). Per-entry picomatch,
      // bare paths expand like source_dirs.exclude. suppress values are validated to be content-rule
      // names, so project findings (gitignore/freshness) can never match. Suppression removes a false
      // positive (it does NOT become a grandfathered ratchet number) and is surfaced as a visible warn.
      const suppressors = Object.entries(baseline.security.suppress).map(([glob, ruleNames]) => ({
        isMatch: picomatch(expandExcludePatterns([glob]), { dot: true }),
        ruleNames: new Set(ruleNames),
      }))
      const kept: SecurityFinding[] = []
      const suppressed: SecurityFinding[] = []
      for (const f of findings) {
        const hit = suppressors.some((s) => s.ruleNames.has(f.rule) && s.isMatch(toPosix(f.file)))
        ;(hit ? suppressed : kept).push(f)
      }

      // Advisory audit via the bulk endpoint — skipped entirely when the advisory ratchet is off (no
      // network round trip). null = unmeasurable (no lockfile / deps not installed / registry down):
      // advisories are simply not scored, never an ERROR — a broken endpoint must not fail every check.
      const ratchetOff = baseline.security.advisory_ratchet === false
      const audit = ratchetOff ? null : await runAudit(ctx)
      const criticalHigh = audit?.criticalHigh ?? 0
      const advisoriesFail = audit !== null && criticalHigh > baseline.security.advisories

      const actions: Action[] = []
      if (kept.length > 0) {
        actions.push({
          gate: 'security',
          type: 'FIX SEC',
          severity: 'block',
          priority: 0,
          message: `Fix ${kept.length} security finding(s)`,
          files: kept.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.message}`),
          locations: kept.map((f) => ({ file: f.file, line: f.line, message: `[${f.rule}] ${f.message}` })),
        })
      }
      if (suppressed.length > 0) {
        actions.push({
          gate: 'security',
          type: 'SUPPRESSED',
          severity: 'warn',
          priority: 10,
          message: `Suppressed ${suppressed.length} security finding(s) via security.suppress`,
          files: suppressed.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.message}`),
        })
      }
      if (unusedDirectives.length > 0) {
        // Build the directive token via concatenation so these very message strings don't self-trip
        // the unused-directive scan when the security gate reads cliquet's own source (dogfooding).
        const token = 'cliquet-' + 'ignore'
        actions.push({
          gate: 'security',
          type: 'UNUSED DIRECTIVE',
          severity: 'warn',
          priority: 10,
          message: `${unusedDirectives.length} unused ${token} directive(s) — the named rule isn't triggered in scope (misplaced, or a typo'd/disabled rule)`,
          files: unusedDirectives.map((d) => `${d.file}:${d.line} [${d.rule}]`),
          locations: unusedDirectives.map((d) => ({ file: d.file, line: d.line, message: `unused ${token} [${d.rule}]` })),
        })
      }
      if (advisoriesFail) {
        actions.push({
          gate: 'security',
          type: 'FIX SEC',
          severity: 'block',
          priority: 0,
          message: `Fix ${criticalHigh} critical/high advisories (baseline: ${baseline.security.advisories})`,
          files: audit?.packages ?? [],
        })
      }

      const failed = kept.length > 0 || advisoriesFail
      // A root lockfile means the advisories cover the WHOLE monorepo, not just this workspace
      const workspaceWide =
        ctx.lockfileDir !== null && ctx.lockfileDir !== ctx.rootPath ? ' (workspace-wide audit)' : ''
      const auditNote = ratchetOff
        ? 'advisory ratchet off (security.advisory_ratchet=false)'
        : audit === null
          ? 'advisory audit unavailable (advisories not measured)'
          : `${criticalHigh} critical/high advisories${workspaceWide}`
      // Audit didn't run → advisories was NOT measured: omit the key instead of
      // reporting 0 as if it were a clean measurement.
      const current =
        audit === null
          ? { findings: kept.length }
          : { advisories: criticalHigh, findings: kept.length }
      return {
        status: failed ? 'fail' : 'pass',
        message: `${auditNote}, ${kept.length} findings`,
        baseline: { advisories: baseline.security.advisories },
        current,
        actions,
      }
    },
  }
}

export const securityGate: Gate = createSecurityGate()
