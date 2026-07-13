import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { Gate, GateResult } from '../types.js'
import { suggestBaselineUpdate } from './improvement.js'

const BUNDLE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.css'])

export interface BundleMeasurement {
  files: Array<{ file: string; gzipKb: number }>
  totalGzipKb: number
}

export function measureBundle(distDir: string): BundleMeasurement {
  const files: Array<{ file: string; gzipKb: number }> = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && BUNDLE_EXTENSIONS.has(extname(entry.name))) {
        files.push({ file: full, gzipKb: gzipSync(readFileSync(full)).length / 1024 })
      }
    }
  }
  walk(distDir)
  const totalGzipKb = files.reduce((sum, f) => sum + f.gzipKb, 0)
  return { files, totalGzipKb }
}

export function findDistDir(rootPath: string, distDirs: string[]): string | null {
  for (const dir of distDirs) {
    const full = join(rootPath, dir)
    if (existsSync(full)) return full
  }
  return null
}

export const bundleSizeGate: Gate = {
  name: 'bundle_size',
  label: 'Bundle Size',

  async run(ctx, baseline): Promise<GateResult> {
    const { max_total_gzip_kb, tolerance_percent, dist_dirs } = baseline.bundle_size
    const base = { max_total_gzip_kb, tolerance_percent }
    const distDir = findDistDir(ctx.rootPath, dist_dirs)
    if (distDir === null) {
      return { status: 'skip', message: `no build dir found (${dist_dirs.join(', ')})`, baseline: base, current: {}, actions: [] }
    }
    if (max_total_gzip_kb === 0) {
      return {
        status: 'skip',
        message: 'baseline not measured yet — run a build then `cliquet init` to record it',
        baseline: base,
        current: {},
        actions: [],
      }
    }
    const m = measureBundle(distDir)
    if (m.files.length === 0) {
      // build quebrado/vazio não pode virar pass silencioso
      return {
        status: 'skip',
        message: 'build dir exists but contains no bundle artifacts (.js/.mjs/.cjs/.css) — artifact measurement skipped',
        baseline: base,
        current: {},
        actions: [],
      }
    }
    const limit = max_total_gzip_kb * (1 + tolerance_percent / 100)
    const totalRounded = Math.round(m.totalGzipKb * 100) / 100
    const current = { total_gzip_kb: totalRounded }
    if (m.totalGzipKb <= limit) {
      // Melhora = medido abaixo do PISO do baseline (não do limite com tolerância)
      const passActions =
        m.totalGzipKb < max_total_gzip_kb
          ? [suggestBaselineUpdate('bundle_size', `bundle size improved to ${totalRounded} KB gzip (baseline ${max_total_gzip_kb} KB)`)]
          : []
      return {
        status: 'pass',
        message: `${totalRounded} KB gzip (baseline: ${max_total_gzip_kb} KB)`,
        baseline: base,
        current,
        actions: passActions,
      }
    }
    const top5 = [...m.files].sort((a, b) => b.gzipKb - a.gzipKb).slice(0, 5)
    return {
      status: 'fail',
      message: `${totalRounded} KB gzip exceeds baseline ${max_total_gzip_kb} KB (+${tolerance_percent}%)`,
      baseline: base,
      current,
      actions: [
        {
          gate: 'bundle_size',
          type: 'REDUCE BUNDLE',
          severity: 'block',
          priority: 4,
          message: `Bundle grew to ${totalRounded} KB gzip (limit ${limit.toFixed(2)} KB)`,
          files: top5.map((f) => `${relative(ctx.rootPath, f.file)} (${f.gzipKb.toFixed(2)} KB)`),
        },
      ],
    }
  },
}
