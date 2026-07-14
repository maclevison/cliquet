import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONTENT_RULES, runContentRules } from '../../../src/security/content-rules.js'

function run(rule: string, content: string, file = 'src/a.ts') {
  if (!CONTENT_RULES[rule]) throw new Error(`regra desconhecida: ${rule}`)
  return runContentRules(file, content, [rule])
}

describe('hardcoded_secrets', () => {
  it('detects AWS key, GitHub token and private key', () => {
    expect(run('hardcoded_secrets', 'const k = "AKIAIOSFODNN7EXAMPLE"')).toHaveLength(1)
    expect(run('hardcoded_secrets', 'const t = "ghp_0123456789abcdefghijklmnopqrstuvwxyz"')).toHaveLength(1)
    expect(run('hardcoded_secrets', '-----BEGIN RSA PRIVATE KEY-----')).toHaveLength(1)
  })
  it('ignores common code', () => {
    expect(run('hardcoded_secrets', 'const apiUrl = process.env.API_URL')).toHaveLength(0)
  })
})

describe('client_exposed_secrets', () => {
  it('detects a secret in a bundler public var', () => {
    expect(run('client_exposed_secrets', 'const k = import.meta.env.VITE_API_SECRET')).toHaveLength(1)
    expect(run('client_exposed_secrets', 'process.env.NEXT_PUBLIC_STRIPE_PRIVATE_KEY')).toHaveLength(1)
    expect(run('client_exposed_secrets', 'process.env.NEXT_PUBLIC_AUTH_TOKEN')).toHaveLength(1)
  })
  it('ignores legitimate public vars', () => {
    expect(run('client_exposed_secrets', 'process.env.NEXT_PUBLIC_APP_NAME')).toHaveLength(0)
  })
  it('ignores key names that are public by design (site/publishable/public keys)', () => {
    expect(run('client_exposed_secrets', 'import.meta.env.VITE_TURNSTILE_SITE_KEY')).toHaveLength(0)
    expect(run('client_exposed_secrets', 'process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY')).toHaveLength(0)
    expect(run('client_exposed_secrets', 'import.meta.env.VITE_STRIPE_PUBLIC_KEY')).toHaveLength(0)
  })
  it('still flags a sensitive var on the same line as an allowlisted one', () => {
    const line = 'const a = env.VITE_TURNSTILE_SITE_KEY, b = env.VITE_API_SECRET'
    expect(run('client_exposed_secrets', line)).toHaveLength(1)
  })
})

describe('eval_usage', () => {
  it('detects eval, new Function and setTimeout with a string', () => {
    expect(run('eval_usage', 'eval(userInput)')).toHaveLength(1)
    expect(run('eval_usage', 'const f = new Function(body)')).toHaveLength(1)
    expect(run('eval_usage', 'setTimeout("doIt()", 100)')).toHaveLength(1)
  })
  it('ignores setTimeout with a callback', () => {
    expect(run('eval_usage', 'setTimeout(() => doIt(), 100)')).toHaveLength(0)
  })
})

describe('command_injection', () => {
  it('detects exec with interpolation', () => {
    expect(run('command_injection', 'exec(`ls ${dir}`)')).toHaveLength(1)
    expect(run('command_injection', 'execSync("rm -rf " + path)')).toHaveLength(1)
  })
  it('ignores exec with a fixed string', () => {
    expect(run('command_injection', 'exec("ls -la")')).toHaveLength(0)
  })
})

describe('sql_injection', () => {
  it('detects a query with an interpolated template', () => {
    expect(run('sql_injection', 'db.query(`SELECT * FROM users WHERE id = ${id}`)')).toHaveLength(1)
    expect(run('sql_injection', 'knex.raw("select " + col)')).toHaveLength(1)
  })
  it('ignores a parameterized query', () => {
    expect(run('sql_injection', 'db.query("SELECT * FROM users WHERE id = $1", [id])')).toHaveLength(0)
  })
  it('ignores an HTTP client .raw()/.query() with a URL template (no SQL keyword)', () => {
    // ofetch/ky: `.raw()` returns the raw Response — a REST URL path, not SQL.
    expect(run('sql_injection', '$fetch.raw(`/projects/${id}/report`)')).toHaveLength(0)
    expect(run('sql_injection', "api.raw('/users/' + id)")).toHaveLength(0)
  })
  it('still flags a dynamic ORDER BY / GROUP BY fragment (textbook column injection)', () => {
    expect(run('sql_injection', 'db.raw(`ORDER BY ${col}`)')).toHaveLength(1)
    expect(run('sql_injection', 'db.raw(`GROUP BY ${col}`)')).toHaveLength(1)
    // but a URL segment named "order" is not ORDER BY
    expect(run('sql_injection', '$fetch.raw(`/order/${id}`)')).toHaveLength(0)
  })
})

describe('unsafe_html', () => {
  it('detects dangerouslySetInnerHTML, v-html and dynamic innerHTML', () => {
    expect(run('unsafe_html', '<div dangerouslySetInnerHTML={{ __html: raw }} />', 'src/a.tsx')).toHaveLength(1)
    expect(run('unsafe_html', '<div v-html="raw"></div>', 'src/a.vue')).toHaveLength(1)
    expect(run('unsafe_html', 'el.innerHTML = userContent')).toHaveLength(1)
  })
  it('ignores innerHTML with a fixed literal', () => {
    expect(run('unsafe_html', 'el.innerHTML = "<b>ok</b>"')).toHaveLength(0)
  })
})

describe('path_traversal', () => {
  it('detects fs with request input', () => {
    expect(run('path_traversal', 'fs.readFileSync(req.params.name)')).toHaveLength(1)
    expect(run('path_traversal', 'res.sendFile(base + req.query.f)')).toHaveLength(1)
  })
  it('ignores a fixed path', () => {
    expect(run('path_traversal', 'fs.readFileSync("./config.json")')).toHaveLength(0)
  })
})

describe('insecure_rng', () => {
  it('detects Math.random in a security context', () => {
    expect(run('insecure_rng', 'const token = Math.random().toString(36)')).toHaveLength(1)
    expect(run('insecure_rng', 'const sessionId = `s-${Math.random()}`')).toHaveLength(1)
  })
  it('ignores Math.random outside a sensitive context', () => {
    expect(run('insecure_rng', 'const jitter = Math.random() * 100')).toHaveLength(0)
  })
})

describe('tls_verification', () => {
  it('detects TLS disabled', () => {
    expect(run('tls_verification', '{ rejectUnauthorized: false }')).toHaveLength(1)
    expect(run('tls_verification', 'process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"')).toHaveLength(1)
    expect(run('tls_verification', '{ strictSSL: false }')).toHaveLength(1)
  })
  it('ignores TLS enabled', () => {
    expect(run('tls_verification', '{ rejectUnauthorized: true }')).toHaveLength(0)
  })
})

describe('unsafe_target_blank', () => {
  it('detects _blank without noopener', () => {
    expect(run('unsafe_target_blank', '<a href="x" target="_blank">y</a>')).toHaveLength(1)
  })
  it('ignores _blank with rel noopener', () => {
    expect(run('unsafe_target_blank', '<a href="x" target="_blank" rel="noopener noreferrer">y</a>')).toHaveLength(0)
  })
})

describe('inline suppression (cliquet-ignore)', () => {
  it('same-line directive suppresses the named rule', () => {
    expect(run('eval_usage', 'eval(input) // cliquet-ignore eval_usage')).toHaveLength(0)
  })

  it('next-line directive suppresses the rule on the following line', () => {
    expect(run('eval_usage', '// cliquet-ignore-next-line eval_usage\neval(input)')).toHaveLength(0)
  })

  it('a bare directive (no rule named) does NOT suppress', () => {
    expect(run('eval_usage', 'eval(input) // cliquet-ignore')).toHaveLength(1)
  })

  it('naming a different rule does not suppress', () => {
    expect(run('eval_usage', 'eval(input) // cliquet-ignore sql_injection')).toHaveLength(1)
  })

  it('a next-line directive on the SAME line as the finding does not suppress it', () => {
    expect(run('eval_usage', 'eval(input) // cliquet-ignore-next-line eval_usage')).toHaveLength(1)
  })

  it('the free-text reason after an em-dash does not over-suppress another rule named in it', () => {
    // Line trips BOTH eval_usage and sql_injection; the directive suppresses only eval_usage,
    // and the reason mentioning sql_injection must NOT silence it.
    const code = 'eval(input); const q = db.query(`SELECT ${x} FROM t`) // cliquet-ignore eval_usage — see sql_injection note'
    const findings = runContentRules('a.ts', code, ['eval_usage', 'sql_injection'])
    expect(findings).toHaveLength(1)
    expect(findings[0]?.rule).toBe('sql_injection')
  })

  it('a comma list suppresses each named rule', () => {
    const code = 'eval(input); const q = db.query(`SELECT ${x} FROM t`) // cliquet-ignore eval_usage, sql_injection'
    expect(runContentRules('a.ts', code, ['eval_usage', 'sql_injection'])).toHaveLength(0)
  })
})

describe('all rules', () => {
  it('report the correct finding line', () => {
    const findings = run('eval_usage', 'const a = 1\nconst b = 2\neval(x)')
    expect(findings[0]?.line).toBe(3)
  })
  it('the registry has exactly the 10 content rules', () => {
    expect(Object.keys(CONTENT_RULES)).toHaveLength(10)
  })

  it('do not self-detect: scanning content-rules.ts itself with all rules → 0 findings (dogfooding)', () => {
    // Pins the anti-self-detection safeguard: unsafe_html and insecure_rng are defined
    // via concatenation/separate functions specifically so that the lines that DEFINE
    // the patterns don't trigger them. If someone "simplifies" this back to literals
    // (e.g. a regex with the React attribute name inline), this test breaks.
    const selfSource = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'src', 'security', 'content-rules.ts'),
      'utf8',
    )
    const findings = runContentRules('src/security/content-rules.ts', selfSource, Object.keys(CONTENT_RULES))
    expect(findings).toEqual([])
  })
})
