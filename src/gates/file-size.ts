import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import type { Gate, GateResult } from '../types.js'
import { listSourceFiles } from '../source-files.js'

/** Counts lines without treating a trailing newline as an extra line; an empty file has 0 lines. */
export function countLines(content: string): number {
  if (content === '') return 0
  const segments = content.split('\n')
  if (segments[segments.length - 1] === '') segments.pop()
  return segments.length
}

export const fileSizeGate: Gate = {
  name: 'file_size',
  label: 'File Size',

  async run(ctx, baseline): Promise<GateResult> {
    const maxLines = baseline.file_size.max_lines
    const allow = baseline.file_size.allow
    const offenders: Array<{ file: string; lines: number }> = []
    for (const file of listSourceFiles(ctx.sourceDirs, ctx.isExcluded)) {
      const lines = countLines(readFileSync(file, 'utf8'))
      const rel = relative(ctx.rootPath, file)
      // A grandfathered file may hold or shrink below its allow entry, never grow past it.
      if (lines > Math.max(maxLines, allow[rel] ?? 0)) offenders.push({ file: rel, lines })
    }
    const base = { max_lines: maxLines }
    // `offenders` (structured) lets `init` grandfather each into file_size.allow.
    const current = { offending_files: offenders.length, offenders }
    if (offenders.length === 0) {
      return {
        status: 'pass',
        message: `0 files exceed ${maxLines} lines`,
        baseline: base,
        current,
        actions: [],
      }
    }
    return {
      status: 'fail',
      message: `${offenders.length} file(s) exceed ${maxLines} lines`,
      baseline: base,
      current,
      actions: [
        {
          gate: 'file_size',
          type: 'SPLIT FILE',
          severity: 'block',
          priority: 5,
          message: `Split ${offenders.length} file(s) over ${maxLines} lines`,
          files: offenders.map((o) => `${o.file} (${o.lines}L)`),
        },
      ],
    }
  },
}
