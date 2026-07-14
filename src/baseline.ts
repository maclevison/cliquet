import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONTENT_RULES } from './security/content-rules.js'

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
  // `suppress`: glob → content-rule names whose findings under that path are dropped (visible warn,
  // never affects exit). An OPEN map — see OPEN_MAP_PATHS and the mergeSection passthrough.
  security: { advisories: number; rules: SecurityRules; suppress: Record<string, string[]> }
  style: { violations: number }
  static_analysis: { errors: number }
  coverage: { percentage: number }
  duplication: { percentage: number; min_lines: number; min_tokens: number }
  // `allow`: grandfather map (path → line count / `"file name"` → CCN). Unlike security.suppress
  // (which removes a false positive), an allow entry IS a ratchet high-water mark — the file/function
  // may hold or shrink below it, never grow past it. Open maps — see OPEN_MAP_VALIDATORS.
  file_size: { max_lines: number; allow: Record<string, number> }
  complexity: { warn_ccn: number; block_ccn: number; allow: Record<string, number> }
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
    suppress: {},
  },
  style: { violations: 0 },
  static_analysis: { errors: 0 },
  coverage: { percentage: 85.0 },
  duplication: { percentage: 2.0, min_lines: 5, min_tokens: 50 },
  file_size: { max_lines: 1000, allow: {} },
  complexity: { warn_ccn: 20, block_ccn: 50, allow: {} },
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

/** Content-rule names are the only valid `security.suppress` values (project rules — gitignore/
 *  freshness — are repo-level, toggled via security.rules, not suppressible per-file). */
const CONTENT_RULE_NAMES = new Set(Object.keys(CONTENT_RULES))

/** Sections that hold an OPEN map (arbitrary user keys) rather than a fixed default shape.
 *  mergeSection's default-key whitelist would erase these on load, so each gets a validated
 *  passthrough instead, keyed by its dotted path. */
const OPEN_MAP_VALIDATORS: Record<string, (path: string, value: unknown) => Record<string, unknown>> = {
  'security.suppress': validateSuppressMap,
  'file_size.allow': validateAllowMap,
  'complexity.allow': validateAllowMap,
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
    // Open map: pass the user's entries through (validated), never key-filter against the
    // empty default — that would silently drop every entry.
    const openMapValidator = OPEN_MAP_VALIDATORS[`${path}.${key}`]
    if (openMapValidator !== undefined) {
      out[key] = openMapValidator(`${path}.${key}`, value)
      continue
    }
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
    // Brace check first: a brace glob usually contains a comma too ("{gen,mock}"), and the
    // brace reason carries the actionable fix ("list the patterns separately").
    if (entry.includes('{') || entry.includes('}')) {
      throw new ConfigError(
        `Invalid baseline: "${path}" entry "${entry}" must not contain "{" or "}" (brace expansion is unsupported; list the patterns separately)`,
      )
    }
    if (entry.includes(',')) {
      throw new ConfigError(
        `Invalid baseline: "${path}" entry "${entry}" must not contain "," (jscpd's --ignore is comma-split; it would be silently garbled)`,
      )
    }
    if (entry.startsWith('!')) {
      throw new ConfigError(
        `Invalid baseline: "${path}" entry "${entry}" must not start with "!" (negation is unsupported)`,
      )
    }
  }
}

/** Validates `security.suppress`: an open glob → content-rule-names map. Glob keys take the same
 *  picomatch-array constraints as source_dirs.exclude MINUS the jscpd comma reason (suppress is
 *  never passed to jscpd); brace/negation still break picomatch arrays. Values must be arrays of
 *  KNOWN content-rule names — an unknown/typo'd name is a ConfigError (it would silently protect
 *  nothing). */
function validateSuppressMap(path: string, value: unknown): Record<string, string[]> {
  if (!isPlainObject(value)) {
    throw new ConfigError(`Invalid baseline: "${path}" must be an object (glob → content-rule names)`)
  }
  const out: Record<string, string[]> = {}
  for (const [glob, rules] of Object.entries(value)) {
    if (glob.includes('{') || glob.includes('}')) {
      throw new ConfigError(
        `Invalid baseline: "${path}" glob "${glob}" must not contain "{" or "}" (brace expansion is unsupported; list the patterns separately)`,
      )
    }
    if (glob.startsWith('!')) {
      throw new ConfigError(`Invalid baseline: "${path}" glob "${glob}" must not start with "!" (negation is unsupported)`)
    }
    if (!Array.isArray(rules)) {
      throw new ConfigError(`Invalid baseline: "${path}"."${glob}" must be an array of content-rule names`)
    }
    for (const rule of rules) {
      if (typeof rule !== 'string' || !CONTENT_RULE_NAMES.has(rule)) {
        throw new ConfigError(
          `Invalid baseline: "${path}"."${glob}" has an unknown content rule ${JSON.stringify(rule)} (valid: ${[...CONTENT_RULE_NAMES].join(', ')})`,
        )
      }
    }
    out[glob] = rules as string[]
  }
  return out
}

/** Validates an `allow` grandfather map: an open path/id → positive-integer map (a line count or a
 *  CCN). Values must be positive integers — a float/negative/zero/non-number is a ConfigError (it
 *  would be a nonsensical high-water mark). Keys are opaque (a file path or `"file name"`). */
function validateAllowMap(path: string, value: unknown): Record<string, number> {
  if (!isPlainObject(value)) {
    throw new ConfigError(`Invalid baseline: "${path}" must be an object (path → grandfathered number)`)
  }
  const out: Record<string, number> = {}
  for (const [key, n] of Object.entries(value)) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
      throw new ConfigError(`Invalid baseline: "${path}"."${key}" must be a positive integer, got ${JSON.stringify(n)}`)
    }
    out[key] = n
  }
  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
