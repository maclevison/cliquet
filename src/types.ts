import type { Baseline } from './baseline.js'

export type GateStatus = 'pass' | 'fail' | 'skip' | 'error'
export type ActionSeverity = 'block' | 'warn'
export type PackageManager = 'npm' | 'pnpm' | 'yarn'

/** Structured location for a finding, used by the github formatter to emit inline PR annotations.
 *  Additive/internal — NOT part of the frozen cliquet/v1 JSON (formatJson strips it). */
export interface ActionLocation {
  file: string
  line?: number
  message?: string
}

export interface Action {
  gate: string
  type: string
  severity: ActionSeverity
  priority: number
  message: string
  files: string[]
  /** Optional per-finding {file,line,message} for github annotations; absent → summary annotation. */
  locations?: ActionLocation[]
}

export interface GateResult {
  status: GateStatus
  message: string
  baseline: Record<string, unknown>
  current: Record<string, unknown>
  actions: Action[]
}

export interface ProjectContext {
  rootPath: string
  /** Git root at or above rootPath (walk-up boundary); null = not in a git repo. */
  repoRoot: string | null
  /** Dir between rootPath and repoRoot that CONTAINS a lockfile; audit cwd. Null = none. */
  lockfileDir: string | null
  /** source_dirs directories that exist on disk (absolute). */
  sourceDirs: string[]
  packageManager: PackageManager | null
  /** node_modules/.bin → PATH → null */
  resolveTool(bin: string): string | null
  timeoutMs: number
  /** Expanded `source_dirs.exclude` patterns (bare paths → [p, p/**]); feeds tool flags (jscpd --ignore, eslint --ignore-pattern). */
  excludePatterns: string[]
  /** Compiled once from excludePatterns with picomatch({ dot: true }); () => false when excludePatterns is empty. */
  isExcluded(absPath: string): boolean
}

export interface Gate {
  name: string
  label: string
  run(ctx: ProjectContext, baseline: Baseline): Promise<GateResult>
}

export interface GateReport extends GateResult {
  name: string
  label: string
}

export interface CheckResult {
  result: 'pass' | 'fail'
  timestamp: string
  summary: {
    total: number
    passed: number
    failed: number
    skipped: number
    errored: number
  }
  gates: GateReport[]
  actions: Action[]
}
