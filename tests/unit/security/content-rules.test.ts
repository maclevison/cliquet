import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONTENT_RULES, runContentRules } from '../../../src/security/content-rules.js'

function run(rule: string, content: string, file = 'src/a.ts') {
  if (!CONTENT_RULES[rule]) throw new Error(`regra desconhecida: ${rule}`)
  return runContentRules(file, content, [rule])
}

describe('hardcoded_secrets', () => {
  it('detecta AWS key, GitHub token e private key', () => {
    expect(run('hardcoded_secrets', 'const k = "AKIAIOSFODNN7EXAMPLE"')).toHaveLength(1)
    expect(run('hardcoded_secrets', 'const t = "ghp_0123456789abcdefghijklmnopqrstuvwxyz"')).toHaveLength(1)
    expect(run('hardcoded_secrets', '-----BEGIN RSA PRIVATE KEY-----')).toHaveLength(1)
  })
  it('ignora código comum', () => {
    expect(run('hardcoded_secrets', 'const apiUrl = process.env.API_URL')).toHaveLength(0)
  })
})

describe('client_exposed_secrets', () => {
  it('detecta segredo em var pública de bundler', () => {
    expect(run('client_exposed_secrets', 'const k = import.meta.env.VITE_API_SECRET')).toHaveLength(1)
    expect(run('client_exposed_secrets', 'process.env.NEXT_PUBLIC_STRIPE_PRIVATE_KEY')).toHaveLength(1)
    expect(run('client_exposed_secrets', 'process.env.NEXT_PUBLIC_AUTH_TOKEN')).toHaveLength(1)
  })
  it('ignora vars públicas legítimas', () => {
    expect(run('client_exposed_secrets', 'process.env.NEXT_PUBLIC_APP_NAME')).toHaveLength(0)
  })
})

describe('eval_usage', () => {
  it('detecta eval, new Function e setTimeout com string', () => {
    expect(run('eval_usage', 'eval(userInput)')).toHaveLength(1)
    expect(run('eval_usage', 'const f = new Function(body)')).toHaveLength(1)
    expect(run('eval_usage', 'setTimeout("doIt()", 100)')).toHaveLength(1)
  })
  it('ignora setTimeout com callback', () => {
    expect(run('eval_usage', 'setTimeout(() => doIt(), 100)')).toHaveLength(0)
  })
})

describe('command_injection', () => {
  it('detecta exec com interpolação', () => {
    expect(run('command_injection', 'exec(`ls ${dir}`)')).toHaveLength(1)
    expect(run('command_injection', 'execSync("rm -rf " + path)')).toHaveLength(1)
  })
  it('ignora exec com string fixa', () => {
    expect(run('command_injection', 'exec("ls -la")')).toHaveLength(0)
  })
})

describe('sql_injection', () => {
  it('detecta query com template interpolado', () => {
    expect(run('sql_injection', 'db.query(`SELECT * FROM users WHERE id = ${id}`)')).toHaveLength(1)
    expect(run('sql_injection', 'knex.raw("select " + col)')).toHaveLength(1)
  })
  it('ignora query parametrizada', () => {
    expect(run('sql_injection', 'db.query("SELECT * FROM users WHERE id = $1", [id])')).toHaveLength(0)
  })
})

describe('unsafe_html', () => {
  it('detecta dangerouslySetInnerHTML, v-html e innerHTML dinâmico', () => {
    expect(run('unsafe_html', '<div dangerouslySetInnerHTML={{ __html: raw }} />', 'src/a.tsx')).toHaveLength(1)
    expect(run('unsafe_html', '<div v-html="raw"></div>', 'src/a.vue')).toHaveLength(1)
    expect(run('unsafe_html', 'el.innerHTML = userContent')).toHaveLength(1)
  })
  it('ignora innerHTML com literal fixo', () => {
    expect(run('unsafe_html', 'el.innerHTML = "<b>ok</b>"')).toHaveLength(0)
  })
})

describe('path_traversal', () => {
  it('detecta fs com input de request', () => {
    expect(run('path_traversal', 'fs.readFileSync(req.params.name)')).toHaveLength(1)
    expect(run('path_traversal', 'res.sendFile(base + req.query.f)')).toHaveLength(1)
  })
  it('ignora path fixo', () => {
    expect(run('path_traversal', 'fs.readFileSync("./config.json")')).toHaveLength(0)
  })
})

describe('insecure_rng', () => {
  it('detecta Math.random em contexto de segurança', () => {
    expect(run('insecure_rng', 'const token = Math.random().toString(36)')).toHaveLength(1)
    expect(run('insecure_rng', 'const sessionId = `s-${Math.random()}`')).toHaveLength(1)
  })
  it('ignora Math.random fora de contexto sensível', () => {
    expect(run('insecure_rng', 'const jitter = Math.random() * 100')).toHaveLength(0)
  })
})

describe('tls_verification', () => {
  it('detecta TLS desabilitado', () => {
    expect(run('tls_verification', '{ rejectUnauthorized: false }')).toHaveLength(1)
    expect(run('tls_verification', 'process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"')).toHaveLength(1)
    expect(run('tls_verification', '{ strictSSL: false }')).toHaveLength(1)
  })
  it('ignora TLS habilitado', () => {
    expect(run('tls_verification', '{ rejectUnauthorized: true }')).toHaveLength(0)
  })
})

describe('unsafe_target_blank', () => {
  it('detecta _blank sem noopener', () => {
    expect(run('unsafe_target_blank', '<a href="x" target="_blank">y</a>')).toHaveLength(1)
  })
  it('ignora _blank com rel noopener', () => {
    expect(run('unsafe_target_blank', '<a href="x" target="_blank" rel="noopener noreferrer">y</a>')).toHaveLength(0)
  })
})

describe('todas as regras', () => {
  it('reportam a linha correta do finding', () => {
    const findings = run('eval_usage', 'const a = 1\nconst b = 2\neval(x)')
    expect(findings[0]?.line).toBe(3)
  })
  it('o registro tem exatamente as 10 regras de conteúdo', () => {
    expect(Object.keys(CONTENT_RULES)).toHaveLength(10)
  })

  it('não se autodetectam: escanear o próprio content-rules.ts com todas as regras → 0 findings (dogfooding)', () => {
    // Pina a proteção anti-autodetecção: unsafe_html e insecure_rng são definidos
    // por concatenação/funções separadas justamente para que as linhas que DEFINEM
    // os padrões não os acionem. Se alguém "simplificar" de volta para literais
    // (ex.: regex com o nome do atributo React inline), este teste quebra.
    const selfSource = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'src', 'security', 'content-rules.ts'),
      'utf8',
    )
    const findings = runContentRules('src/security/content-rules.ts', selfSource, Object.keys(CONTENT_RULES))
    expect(findings).toEqual([])
  })
})
