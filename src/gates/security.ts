import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import type { Action, Gate, GateResult, PackageManager, ProjectContext } from '../types.js'
import { listSourceFiles } from '../source-files.js'
import { CONTENT_RULES, runContentRules, type SecurityFinding } from '../security/content-rules.js'
import {
  checkGitignoreSensitive,
  checkPackageFreshness,
  defaultRegistryFetcher,
  type RegistryFetcher,
} from '../security/project-rules.js'
import { runCommand } from '../process.js'

export interface AuditCounts {
  criticalHigh: number
  total: number
}

export function parseNpmAudit(stdout: string): AuditCounts | null {
  try {
    const parsed = JSON.parse(stdout) as {
      metadata?: { vulnerabilities?: Record<string, number> }
    }
    const v = parsed.metadata?.vulnerabilities
    if (!v) return null
    return { criticalHigh: (v.critical ?? 0) + (v.high ?? 0), total: v.total ?? 0 }
  } catch {
    return null
  }
}

const AUDIT_COMMANDS: Record<string, string[]> = {
  npm: ['audit', '--json'],
  pnpm: ['audit', '--json'],
  yarn: ['audit', '--json'],
}

/** yarn classic emits NDJSON; the type=auditSummary line carries the totals. */
export function parseYarnAudit(stdout: string): AuditCounts | null {
  for (const line of stdout.split('\n')) {
    try {
      const parsed = JSON.parse(line) as { type?: string; data?: { vulnerabilities?: Record<string, number> } }
      if (parsed.type === 'auditSummary' && parsed.data?.vulnerabilities) {
        const v = parsed.data.vulnerabilities
        return {
          criticalHigh: (v.critical ?? 0) + (v.high ?? 0),
          total: Object.values(v).reduce((a, b) => a + b, 0),
        }
      }
    } catch {
      // non-JSON line: ignore
    }
  }
  return null
}

export function parseAudit(pm: PackageManager | null, stdout: string): AuditCounts | null {
  return pm === 'yarn' ? parseYarnAudit(stdout) : parseNpmAudit(stdout)
}

/** Runs the package manager's audit; null = not applicable (no lockfile/pm). */
export async function defaultRunAudit(ctx: ProjectContext, run = runCommand): Promise<string | null> {
  if (ctx.packageManager === null) return null
  const bin = ctx.resolveTool(ctx.packageManager) ?? ctx.packageManager
  const args = AUDIT_COMMANDS[ctx.packageManager]
  if (!args) return null
  // Audits must run where the lockfile lives (monorepo: the repo root)
  const result = await run(bin, args, { cwd: ctx.lockfileDir ?? ctx.rootPath, timeoutMs: ctx.timeoutMs })
  return result.stdout || null
}

export interface SecurityGateDeps {
  runAudit?: (ctx: ProjectContext) => Promise<string | null>
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
      if (enabledContentRules.length > 0) {
        for (const file of listSourceFiles(ctx.sourceDirs)) {
          const content = readFileSync(file, 'utf8')
          const rel = relative(ctx.rootPath, file)
          findings.push(...runContentRules(rel, content, enabledContentRules))
        }
      }

      // Project rules
      if (rules.gitignore_sensitive) findings.push(...checkGitignoreSensitive(ctx.rootPath, ctx.repoRoot))
      if (rules.package_freshness)
        findings.push(...(await checkPackageFreshness(ctx.rootPath, freshnessFetcher, undefined, ctx.repoRoot)))

      // Package manager audit
      const auditRaw = await runAudit(ctx)
      const audit = auditRaw === null ? null : parseAudit(ctx.packageManager, auditRaw)
      if (auditRaw !== null && audit === null) {
        // output present but unparseable is NOT a legitimate skip — masking advisories would be a false pass
        return {
          status: 'error',
          message: `${ctx.packageManager ?? 'npm'} audit output could not be parsed`,
          baseline: { advisories: baseline.security.advisories },
          current: {},
          actions: [],
        }
      }
      const criticalHigh = audit?.criticalHigh ?? 0
      const advisoriesFail = audit !== null && criticalHigh > baseline.security.advisories

      const actions: Action[] = []
      if (findings.length > 0) {
        actions.push({
          gate: 'security',
          type: 'FIX SEC',
          severity: 'block',
          priority: 0,
          message: `Fix ${findings.length} security finding(s)`,
          files: findings.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.message}`),
        })
      }
      if (advisoriesFail) {
        actions.push({
          gate: 'security',
          type: 'FIX SEC',
          severity: 'block',
          priority: 0,
          message: `Fix ${criticalHigh} critical/high advisories (baseline: ${baseline.security.advisories}) — run "${ctx.packageManager} audit" for details`,
          files: [],
        })
      }

      const failed = findings.length > 0 || advisoriesFail
      // A root lockfile means the advisories cover the WHOLE monorepo, not just this workspace
      const workspaceWide =
        ctx.lockfileDir !== null && ctx.lockfileDir !== ctx.rootPath ? ' (workspace-wide audit)' : ''
      const auditNote =
        audit === null ? 'audit skipped (no lockfile)' : `${criticalHigh} critical/high advisories${workspaceWide}`
      // Audit didn't run → advisories was NOT measured: omit the key instead of
      // reporting 0 as if it were a clean measurement.
      const current =
        audit === null
          ? { findings: findings.length }
          : { advisories: criticalHigh, findings: findings.length }
      return {
        status: failed ? 'fail' : 'pass',
        message: `${auditNote}, ${findings.length} findings`,
        baseline: { advisories: baseline.security.advisories },
        current,
        actions,
      }
    },
  }
}

export const securityGate: Gate = createSecurityGate()
