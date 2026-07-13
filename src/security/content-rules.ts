export interface SecurityFinding {
  rule: string
  file: string
  line: number
  message: string
}

type ContentRule = (file: string, content: string) => SecurityFinding[]

/** Varre linha a linha; um finding por linha que casa o padrão. */
function scan(rule: string, message: string, patterns: RegExp[]): ContentRule {
  return (file, content) => {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (patterns.some((p) => p.test(line))) {
        findings.push({ rule, file, line: i + 1, message })
      }
    }
    return findings
  }
}

export const CONTENT_RULES: Record<string, ContentRule> = {
  hardcoded_secrets: scan('hardcoded_secrets', 'Possible hardcoded credential', [
    /AKIA[0-9A-Z]{16}/,
    /ghp_[A-Za-z0-9]{36}/,
    /gho_[A-Za-z0-9]{36}/,
    /eyJ[A-Za-z0-9_-]{10,}\.eyJ/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ]),

  client_exposed_secrets: scan(
    'client_exposed_secrets',
    'Sensitive name exposed in client-side env var',
    [/(?:VITE_|NEXT_PUBLIC_|REACT_APP_|NUXT_PUBLIC_)\w*(?:SECRET|PRIVATE|PASSWORD|TOKEN|_KEY)\w*/i],
  ),

  eval_usage: scan('eval_usage', 'Dynamic code evaluation', [
    /\beval\s*\(/,
    /new\s+Function\s*\(/,
    /set(?:Timeout|Interval)\s*\(\s*["'`]/,
  ]),

  command_injection: scan('command_injection', 'Shell command built from variables', [
    /\b(?:exec|execSync|spawn(?:Sync)?)\s*\(\s*`[^`]*\$\{/,
    /\b(?:exec|execSync)\s*\(\s*["'][^"']*["']\s*\+/,
  ]),

  sql_injection: scan('sql_injection', 'SQL built from interpolated variables', [
    /\.(?:query|raw)\s*\(\s*`[^`]*\$\{/,
    /\.(?:query|raw)\s*\(\s*["'][^"']*["']\s*\+/,
  ]),

  unsafe_html: scan('unsafe_html', 'Unsanitized HTML injection', [
    /dangerouslySetInnerHTML/,
    /v-html/,
    /\.(?:inner|outer)HTML\s*=\s*(?=\S)(?!["'`][^$])/,
  ]),

  path_traversal: scan('path_traversal', 'File path from request input', [
    /(?:readFile(?:Sync)?|createReadStream|sendFile|unlink(?:Sync)?)\s*\([^)]*req\.(?:params|query|body)/,
  ]),

  insecure_rng: (file, content) => {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')
    const sensitive = /token|secret|session|password|auth|nonce/i
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (line.includes('Math.random') && sensitive.test(line)) {
        findings.push({
          rule: 'insecure_rng',
          file,
          line: i + 1,
          message: 'Math.random() used in security-sensitive context — use crypto.randomBytes/randomUUID',
        })
      }
    }
    return findings
  },

  tls_verification: scan('tls_verification', 'TLS verification disabled', [
    /rejectUnauthorized\s*:\s*false/,
    /NODE_TLS_REJECT_UNAUTHORIZED\s*[=:]\s*["']?0/,
    /strictSSL\s*:\s*false/,
  ]),

  unsafe_target_blank: scan('unsafe_target_blank', 'target="_blank" without rel="noopener"', [
    /target=["']_blank["'](?![^>\n]*rel=["'][^"']*noopener)/,
  ]),
}
