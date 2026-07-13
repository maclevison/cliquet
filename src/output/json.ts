import type { CheckResult } from '../types.js'
import { SCHEMA_VERSION } from '../baseline.js'

export function formatJson(result: CheckResult, opts: { pretty: boolean }): string {
  // Schema spec §9: cada entrada de gates[] carrega {name,label,status,message,
  // baseline,current}; as actions aparecem SÓ no agregado top-level actions[].
  const gates = result.gates.map(({ actions: _actions, ...gate }) => gate)
  const payload = { schema: SCHEMA_VERSION, ...result, gates }
  return JSON.stringify(payload, null, opts.pretty ? 2 : undefined)
}
