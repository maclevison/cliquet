export interface SecurityFinding {
  rule: string
  file: string
  line: number
  message: string
}

/** Regra de conteúdo avaliada linha a linha — o split do arquivo acontece UMA vez em runContentRules. */
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

export const CONTENT_RULES: Record<string, LineRule> = {
  hardcoded_secrets: patternRule('Possible hardcoded credential', [
    /AKIA[0-9A-Z]{16}/,
    /ghp_[A-Za-z0-9]{36}/,
    /gho_[A-Za-z0-9]{36}/,
    /eyJ[A-Za-z0-9_-]{10,}\.eyJ/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ]),

  client_exposed_secrets: patternRule('Sensitive name exposed in client-side env var', [
    /(?:VITE_|NEXT_PUBLIC_|REACT_APP_|NUXT_PUBLIC_)\w*(?:SECRET|PRIVATE|PASSWORD|TOKEN|_KEY)\w*/i,
  ]),

  eval_usage: patternRule('Dynamic code evaluation', [
    /\beval\s*\(/,
    /new\s+Function\s*\(/,
    /set(?:Timeout|Interval)\s*\(\s*["'`]/,
  ]),

  command_injection: patternRule('Shell command built from variables', [
    /\b(?:exec|execSync|spawn(?:Sync)?)\s*\(\s*`[^`]*\$\{/,
    /\b(?:exec|execSync)\s*\(\s*["'][^"']*["']\s*\+/,
  ]),

  sql_injection: patternRule('SQL built from interpolated variables', [
    /\.(?:query|raw)\s*\(\s*`[^`]*\$\{/,
    /\.(?:query|raw)\s*\(\s*["'][^"']*["']\s*\+/,
  ]),

  // Padrões dos atributos HTML inseguros (React/Vue) construídos por concatenação
  // (em vez de literal) para que este próprio arquivo — que precisa CONTER esses
  // nomes para defini-los — não se autodetecte quando o security gate escaneia o
  // código-fonte do cliquet (spec §6, dogfooding).
  unsafe_html: patternRule('Unsanitized HTML injection', [
    new RegExp('dangerously' + 'SetInnerHTML'),
    new RegExp('v-' + 'html'),
    /\.(?:inner|outer)HTML\s*=\s*(?=\S)(?!["'`][^$])/,
  ]),

  path_traversal: patternRule('File path from request input', [
    /(?:readFile(?:Sync)?|createReadStream|sendFile|unlink(?:Sync)?)\s*\([^)]*req\.(?:params|query|body)/,
  ]),

  // Substring e regex de segurança quebrados em duas funções/linhas: a checagem
  // completa (usa Math.random + termo sensível na MESMA linha) não pode viver numa
  // linha só, senão esta própria definição se autodetectaria ao escanear o código
  // do cliquet (spec §6, dogfooding).
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

/** Divide o conteúdo UMA vez e avalia as regras habilitadas linha a linha. */
export function runContentRules(file: string, content: string, enabled: string[]): SecurityFinding[] {
  const rules: Array<[string, LineRule]> = []
  for (const name of enabled) {
    const rule = CONTENT_RULES[name]
    if (rule) rules.push([name, rule])
  }
  if (rules.length === 0) return []
  const findings: SecurityFinding[] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    for (const [name, rule] of rules) {
      if (rule.matches(line)) {
        findings.push({ rule: name, file, line: i + 1, message: rule.message })
      }
    }
  }
  return findings
}
