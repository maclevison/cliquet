import type { Action } from '../types.js'

/**
 * Spec §4 (semântica do ratchet): quando a métrica MELHOROU vs baseline o gate
 * continua pass, mas o relatório sugere atualizar o baseline como ação OPCIONAL.
 * Warn (não block) e priority 10: nunca afeta status/exit code e ordena por
 * último entre as ações.
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
