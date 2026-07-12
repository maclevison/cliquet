import type { Baseline } from './baseline.js'

export type GateStatus = 'pass' | 'fail' | 'skip' | 'error'
export type ActionSeverity = 'block' | 'warn'
export type PackageManager = 'npm' | 'pnpm' | 'yarn'

export interface Action {
  gate: string
  type: string
  severity: ActionSeverity
  priority: number
  message: string
  files: string[]
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
  /** Diretórios de source_dirs que existem no disco (absolutos). */
  sourceDirs: string[]
  packageManager: PackageManager | null
  /** node_modules/.bin → PATH → null */
  resolveTool(bin: string): string | null
  timeoutMs: number
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
