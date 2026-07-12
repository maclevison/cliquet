import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const BASELINE_FILENAME = 'cliquet.baseline.json'
export const SCHEMA_VERSION = 'cliquet/v1'

/** Erro de uso/configuração → exit code 2 (spec §3). */
export class ConfigError extends Error {}

export interface SecurityRules {
  hardcoded_secrets: boolean
  client_exposed_secrets: boolean
  eval_usage: boolean
  command_injection: boolean
  sql_injection: boolean
  unsafe_html: boolean
  path_traversal: boolean
  insecure_rng: boolean
  tls_verification: boolean
  unsafe_target_blank: boolean
  gitignore_sensitive: boolean
  package_freshness: boolean
}

export interface Baseline {
  schema: string
  source_dirs: { paths: string[] }
  security: { advisories: number; rules: SecurityRules }
  style: { violations: number }
  static_analysis: { errors: number }
  coverage: { percentage: number }
  duplication: { percentage: number; min_lines: number; min_tokens: number }
  file_size: { max_lines: number }
  complexity: { warn_ccn: number; block_ccn: number }
  performance: { violations: number }
  bundle_size: { max_total_gzip_kb: number; tolerance_percent: number; dist_dirs: string[] }
}

export const DEFAULT_BASELINE: Baseline = {
  schema: SCHEMA_VERSION,
  source_dirs: { paths: ['src', 'app', 'lib'] },
  security: {
    advisories: 0,
    rules: {
      hardcoded_secrets: true,
      client_exposed_secrets: true,
      eval_usage: true,
      command_injection: true,
      sql_injection: true,
      unsafe_html: true,
      path_traversal: true,
      insecure_rng: true,
      tls_verification: true,
      unsafe_target_blank: true,
      gitignore_sensitive: true,
      package_freshness: true,
    },
  },
  style: { violations: 0 },
  static_analysis: { errors: 0 },
  coverage: { percentage: 85.0 },
  duplication: { percentage: 2.0, min_lines: 5, min_tokens: 50 },
  file_size: { max_lines: 1000 },
  complexity: { warn_ccn: 20, block_ccn: 50 },
  performance: { violations: 0 },
  bundle_size: { max_total_gzip_kb: 0, tolerance_percent: 0, dist_dirs: ['dist', 'build', '.output'] },
}

export function baselineExists(rootPath: string): boolean {
  return existsSync(join(rootPath, BASELINE_FILENAME))
}

export function loadBaseline(rootPath: string): Baseline {
  const path = join(rootPath, BASELINE_FILENAME)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new ConfigError(`Baseline inválido em ${path}: ${(err as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ConfigError(`Baseline inválido em ${path}: esperado um objeto JSON`)
  }
  const raw = parsed as Record<string, unknown>
  if (raw.schema !== undefined && raw.schema !== SCHEMA_VERSION) {
    throw new ConfigError(`Schema desconhecido "${String(raw.schema)}" — esperado "${SCHEMA_VERSION}"`)
  }
  return mergeWithDefaults(raw)
}

export function saveBaseline(rootPath: string, baseline: Baseline): void {
  const path = join(rootPath, BASELINE_FILENAME)
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`)
}

/** Merge por seção (1 nível): seção ausente → default inteiro; presente → chaves faltantes vêm do default. */
function mergeWithDefaults(raw: Record<string, unknown>): Baseline {
  const out = structuredClone(DEFAULT_BASELINE) as unknown as Record<string, unknown>
  for (const key of Object.keys(DEFAULT_BASELINE)) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      out[key] = { ...(out[key] as object), ...(value as object) }
      // security.rules é aninhado um nível a mais
      if (key === 'security' && typeof (value as Record<string, unknown>).rules === 'object') {
        ;(out[key] as { rules: object }).rules = {
          ...DEFAULT_BASELINE.security.rules,
          ...((value as { rules: object }).rules),
        }
      }
    } else {
      out[key] = value
    }
  }
  return out as unknown as Baseline
}
