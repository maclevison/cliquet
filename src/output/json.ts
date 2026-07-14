import type { CheckResult } from '../types.js'
import { SCHEMA_VERSION } from '../baseline.js'

export function formatJson(result: CheckResult, opts: { pretty: boolean }): string {
  // Schema spec §9: each gates[] entry carries {name,label,status,message,
  // baseline,current}; actions appear ONLY in the top-level aggregated actions[].
  const gates = result.gates.map(({ actions: _actions, ...gate }) => gate)
  // `locations` is internal (github annotations only) — strip it so the cliquet/v1 action shape
  // {gate,type,severity,priority,message,files} stays byte-compatible.
  const actions = result.actions.map(({ locations: _locations, ...action }) => action)
  const payload = { schema: SCHEMA_VERSION, ...result, gates, actions }
  return JSON.stringify(payload, null, opts.pretty ? 2 : undefined)
}
