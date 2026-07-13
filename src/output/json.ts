import type { CheckResult } from '../types.js'
import { SCHEMA_VERSION } from '../baseline.js'

export function formatJson(result: CheckResult, opts: { pretty: boolean }): string {
  const payload = { schema: SCHEMA_VERSION, ...result }
  return JSON.stringify(payload, null, opts.pretty ? 2 : undefined)
}
