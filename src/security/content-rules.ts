export interface SecurityFinding {
  rule: string
  file: string
  line: number
  message: string
}

/** Content rule evaluated line by line — the file split happens ONCE in runContentRules. */
interface LineRule {
  message: string
  matches(line: string): boolean
}

function patternRule(message: string, patterns: RegExp[]): LineRule {
  return { message, matches: (line) => patterns.some((p) => p.test(line)) }
}

function usesMathRandom(line: string): boolean {
  return line.includes('Math' + '.random')
}

function looksSecuritySensitive(line: string): boolean {
  return /token|secret|session|password|auth(?!or)|nonce/i.test(line)
}

const CLIENT_ENV_VAR = /(?:VITE_|NEXT_PUBLIC_|REACT_APP_|NUXT_PUBLIC_)\w+/gi
const SENSITIVE_ENV_NAME = /SECRET|PRIVATE|PASSWORD|TOKEN|_KEY/i
// Key names that are public by design: Turnstile/hCaptcha site keys, Stripe
// publishable keys, generic "public keys" — exposing them is the whole point.
const PUBLIC_BY_DESIGN_KEY = /(?:SITE|PUBLISHABLE|PUBLIC)_KEY/i
// A SQL statement contains SQL keywords; a URL/path passed to an HTTP client's .raw()/.query()
// does not. Bare ORDER/GROUP/LIMIT are URL-FP-prone (/order/, /rate-limit/), so the sort/group
// clause is matched only in its two-word form.
const SQL_KEYWORD =
  /\b(?:SELECT|INSERT|UPDATE|DELETE|REPLACE|MERGE|FROM|WHERE|VALUES|JOIN|UNION|INTO|DROP|TRUNCATE|ALTER)\b|\b(?:ORDER|GROUP)\s+BY\b/i

export const CONTENT_RULES: Record<string, LineRule> = {
  hardcoded_secrets: patternRule('Possible hardcoded credential', [
    /AKIA[0-9A-Z]{16}/,
    /ghp_[A-Za-z0-9]{36}/,
    /gho_[A-Za-z0-9]{36}/,
    /eyJ[A-Za-z0-9_-]{10,}\.eyJ/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ]),

  // Evaluated per VARIABLE NAME (not per line): a line-level allowlist would
  // also silence a genuinely sensitive var sharing the line with a public one.
  client_exposed_secrets: {
    message: 'Sensitive name exposed in client-side env var',
    matches: (line) =>
      [...line.matchAll(CLIENT_ENV_VAR)].some(
        (m) => SENSITIVE_ENV_NAME.test(m[0]) && !PUBLIC_BY_DESIGN_KEY.test(m[0]),
      ),
  },

  eval_usage: patternRule('Dynamic code evaluation', [
    /\beval\s*\(/,
    /new\s+Function\s*\(/,
    /set(?:Timeout|Interval)\s*\(\s*["'`]/,
  ]),

  command_injection: patternRule('Shell command built from variables', [
    /\b(?:exec|execSync|spawn(?:Sync)?)\s*\(\s*`[^`]*\$\{/,
    /\b(?:exec|execSync)\s*\(\s*["'][^"']*["']\s*\+/,
  ]),

  // `.query(`/`.raw(` interpolation ANDed with a SQL keyword on the same line. Without the
  // keyword this over-matched HTTP clients whose `.raw()`/`.query()` take a URL template
  // (ofetch `$fetch.raw(`/users/${id}`)`) — a URL path has no SQL keyword, real SQL does. The
  // multi-word `ORDER BY`/`GROUP BY` keeps the textbook dynamic-column injection (which can't
  // be parameterized) without matching URL segments like `/order/${id}`.
  sql_injection: {
    message: 'SQL built from interpolated variables',
    matches: (line) =>
      (/\.(?:query|raw)\s*\(\s*`[^`]*\$\{/.test(line) || /\.(?:query|raw)\s*\(\s*["'][^"']*["']\s*\+/.test(line)) &&
      SQL_KEYWORD.test(line),
  },

  // Patterns for the unsafe HTML attributes (React/Vue), built via concatenation
  // (rather than as literals) so that this very file — which must CONTAIN those
  // names to define them — doesn't self-detect when the security gate scans
  // cliquet's own source (spec §6, dogfooding).
  unsafe_html: patternRule('Unsanitized HTML injection', [
    new RegExp('dangerously' + 'SetInnerHTML'),
    new RegExp('v-' + 'html'),
    /\.(?:inner|outer)HTML\s*=\s*(?=\S)(?!["'`][^$])/,
  ]),

  path_traversal: patternRule('File path from request input', [
    /(?:readFile(?:Sync)?|createReadStream|sendFile|unlink(?:Sync)?)\s*\([^)]*req\.(?:params|query|body)/,
  ]),

  // Security substring and regex split across two functions/lines: the full
  // check (uses Math.random plus a sensitive term on the SAME line) can't live
  // on a single line, or this very definition would self-detect when scanning
  // cliquet's own source (spec §6, dogfooding).
  insecure_rng: {
    message: 'Math.random() used in security-sensitive context — use crypto.randomBytes/randomUUID',
    matches: (line) => usesMathRandom(line) && looksSecuritySensitive(line),
  },

  tls_verification: patternRule('TLS verification disabled', [
    /rejectUnauthorized\s*:\s*false/,
    /NODE_TLS_REJECT_UNAUTHORIZED\s*[=:]\s*["']?0/,
    /strictSSL\s*:\s*false/,
  ]),

  unsafe_target_blank: patternRule('target="_blank" without rel="noopener"', [
    /target=["']_blank["'](?![^>\n]*rel=["'][^"']*noopener)/,
  ]),
}

// Inline suppression directives. A rule name is REQUIRED (no bare form). The names are read
// TOKENIZED — comma-separated, up to an em-dash reason delimiter — so a rule name appearing in the
// free-text reason never over-suppresses. The same-line pattern excludes the "-next-line" variant so
// the two never collide. (These literals match no content rule, so the self-scan stays at 0.)
// The three forms never collide: the required whitespace after each token forces its exact boundary
// (e.g. `cliquet-ignore\s+` can't match `cliquet-ignore-file`, where a "-" follows, not whitespace).
const IGNORE_SAME_LINE = /cliquet-ignore(?!-next-line|-file)\s+([^\n]*)/i
const IGNORE_NEXT_LINE = /cliquet-ignore-next-line\s+([^\n]*)/i
const IGNORE_FILE = /cliquet-ignore-file\s+([^\n]*)/i
const NO_RULES: ReadonlySet<string> = new Set()

function directiveRules(text: string, re: RegExp): ReadonlySet<string> {
  const m = re.exec(text)
  if (m === null) return NO_RULES
  const beforeReason = (m[1] ?? '').split('—')[0] ?? ''
  return new Set(beforeReason.split(',').map((s) => s.trim()).filter(Boolean))
}

/** Splits the content ONCE and evaluates the enabled rules line by line. */
export function runContentRules(file: string, content: string, enabled: string[]): SecurityFinding[] {
  const rules: Array<[string, LineRule]> = []
  for (const name of enabled) {
    const rule = CONTENT_RULES[name]
    if (rule) rules.push([name, rule])
  }
  if (rules.length === 0) return []
  const findings: SecurityFinding[] = []
  const lines = content.split('\n')
  // File-level directives (`// cliquet-ignore-file <rule>…`) suppress a rule across the whole file.
  // Cheap substring guard so the common no-directive case skips the per-line scan.
  const fileSuppressed = new Set<string>()
  if (content.includes('cliquet-ignore-file')) {
    for (const line of lines) for (const r of directiveRules(line, IGNORE_FILE)) fileSuppressed.add(r)
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const prev = i > 0 ? (lines[i - 1] ?? '') : ''
    for (const [name, rule] of rules) {
      if (!rule.matches(line)) continue
      if (fileSuppressed.has(name)) continue
      // Inline suppression check runs only on already-matched lines (the common case is no match).
      if (directiveRules(line, IGNORE_SAME_LINE).has(name) || directiveRules(prev, IGNORE_NEXT_LINE).has(name)) {
        continue
      }
      findings.push({ rule: name, file, line: i + 1, message: rule.message })
    }
  }
  return findings
}
