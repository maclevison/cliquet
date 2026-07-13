import type { Action } from '../types.js'

/**
 * Spec §4 (ratchet semantics): when the metric IMPROVED vs. the baseline, the gate
 * still passes, but the report suggests updating the baseline as an OPTIONAL action.
 * Warn (not block) and priority 10: never affects status/exit code and sorts
 * last among the actions.
 */
export function suggestBaselineUpdate(gate: string, summary: string): Action {
  return {
    gate,
    type: 'UPDATE BASELINE',
    severity: 'warn',
    priority: 10,
    message: `${summary} — consider updating cliquet.baseline.json`,
    files: [],
  }
}
