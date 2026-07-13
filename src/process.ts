import { execa } from 'execa'

export interface RunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** true when the process couldn't even be executed (missing binary) or failed outside the exit code. */
  failed: boolean
}

export interface RunOptions {
  cwd: string
  timeoutMs: number
  /** With execa's default extendEnv, a key with value `undefined` is REMOVED from the child's env. */
  env?: Record<string, string | undefined>
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

/** Last N lines of stderr for gate `error` messages (spec §9: ~20 lines). */
export function tailLines(text: string, n = 20): string {
  const lines = text.trimEnd().split(/\r?\n/)
  return lines.slice(-n).join('\n')
}
