import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const BASELINE_FILENAME = 'cliquet.baseline.json'
export const SCHEMA_VERSION = 'cliquet/v1'

/** Usage/configuration error → exit code 2 (spec §3). */
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
  source_dirs: { paths: string[]; exclude: string[] }
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
  source_dirs: { paths: ['src', 'app', 'lib'], exclude: [] },
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
  // tolerance 0.5%: identical dist gzips differently across node/zlib versions — zero tolerance flaps dev vs CI
  bundle_size: { max_total_gzip_kb: 0, tolerance_percent: 0.5, dist_dirs: ['dist', 'build', '.output'] },
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
    throw new ConfigError(`Invalid baseline at ${path}: ${(err as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ConfigError(`Invalid baseline at ${path}: expected a JSON object`)
  }
  const raw = parsed as Record<string, unknown>
  if (raw.schema !== undefined && raw.schema !== SCHEMA_VERSION) {
    throw new ConfigError(`Unknown schema "${String(raw.schema)}" — expected "${SCHEMA_VERSION}"`)
  }
  return mergeWithDefaults(raw)
}

export function saveBaseline(rootPath: string, baseline: Baseline): void {
  const path = join(rootPath, BASELINE_FILENAME)
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`)
}

/** Merge per section (1 level deep): missing section → full default; present → missing keys come from the default.
 *  Validates the shape against the default: object section requires an object, array requires an array, scalar requires the same typeof. */
function mergeWithDefaults(raw: Record<string, unknown>): Baseline {
  const out = structuredClone(DEFAULT_BASELINE) as unknown as Record<string, unknown>
  for (const key of Object.keys(DEFAULT_BASELINE)) {
    const value = raw[key]
    if (value === undefined) continue
    const defaultValue = (DEFAULT_BASELINE as unknown as Record<string, unknown>)[key]
    if (isPlainObject(defaultValue)) {
      if (!isPlainObject(value)) {
        throw new ConfigError(`Invalid baseline: "${key}" must be an object`)
      }
      out[key] = mergeSection(key, defaultValue, value)
    } else {
      validateLeaf(key, defaultValue, value)
      out[key] = value
    }
  }
  return out as unknown as Baseline
}

/** Merges a single section, validating each key against the default (recursive for security.rules). */
function mergeSection(
  path: string,
  defaults: Record<string, unknown>,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...defaults }
  for (const key of Object.keys(defaults)) {
    const value = raw[key]
    if (value === undefined) continue
    const defaultValue = defaults[key]
    if (isPlainObject(defaultValue)) {
      if (!isPlainObject(value)) {
        throw new ConfigError(`Invalid baseline: "${path}.${key}" must be an object`)
      }
      out[key] = mergeSection(`${path}.${key}`, defaultValue, value)
    } else {
      validateLeaf(`${path}.${key}`, defaultValue, value)
      out[key] = value
    }
  }
  return out
}

/** Paths whose array elements get element-level string/pattern validation (source_dirs only — see spec). */
const STRING_ARRAY_PATHS_WITH_ELEMENT_CHECKS = new Set(['source_dirs.paths', 'source_dirs.exclude'])

function validateLeaf(path: string, defaultValue: unknown, value: unknown): void {
  if (Array.isArray(defaultValue)) {
    if (!Array.isArray(value)) {
      throw new ConfigError(`Invalid baseline: "${path}" must be an array`)
    }
    if (STRING_ARRAY_PATHS_WITH_ELEMENT_CHECKS.has(path)) {
      validateStringArrayElements(path, value)
    }
    return
  }
  if (typeof value !== typeof defaultValue || Array.isArray(value) || isPlainObject(value)) {
    throw new ConfigError(`Invalid baseline: "${path}" must be a ${typeof defaultValue}`)
  }
}

/** Element-level checks for source_dirs.paths / source_dirs.exclude (spec: "Pattern semantics").
 *  exclude entries are picomatch globs consumed downstream by jscpd's comma-split --ignore flag,
 *  so "," would be silently garbled there; braces are pure sugar (list patterns separately);
 *  leading "!" (negation) has surprising picomatch-array semantics and is unsupported. */
function validateStringArrayElements(path: string, value: unknown[]): void {
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new ConfigError(`Invalid baseline: "${path}" entries must be strings, got ${JSON.stringify(entry)}`)
    }
    if (path !== 'source_dirs.exclude') continue
    if (entry.includes(',')) {
      throw new ConfigError(
        `Invalid baseline: "${path}" entry "${entry}" must not contain "," (jscpd's --ignore is comma-split; it would be silently garbled)`,
      )
    }
    if (entry.includes('{') || entry.includes('}')) {
      throw new ConfigError(
        `Invalid baseline: "${path}" entry "${entry}" must not contain "{" or "}" (brace expansion is unsupported; list the patterns separately)`,
      )
    }
    if (entry.startsWith('!')) {
      throw new ConfigError(
        `Invalid baseline: "${path}" entry "${entry}" must not start with "!" (negation is unsupported)`,
      )
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
