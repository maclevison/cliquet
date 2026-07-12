import { execa } from 'execa'

export interface RunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** true quando o processo nem pôde ser executado (binário ausente) ou falhou fora do exit code. */
  failed: boolean
}

export interface RunOptions {
  cwd: string
  timeoutMs: number
  env?: Record<string, string>
}

export async function runCommand(file: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const result = await execa(file, args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    env: opts.env,
    reject: false,
    stripFinalNewline: false,
  })
  return {
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut: result.timedOut ?? false,
    failed: result.failed ?? false,
  }
}

/** Últimas N linhas de stderr para mensagens de gate `error` (spec §9: ~20 linhas). */
export function tailLines(text: string, n = 20): string {
  const lines = text.trimEnd().split('\n')
  return lines.slice(-n).join('\n')
}
