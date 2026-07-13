# Cliquet

> **Cliquet** (French for "ratchet", pronounced /kli.kɛ/ — "clee-KEH", silent *t*) — like a ratchet, quality only moves forward.

Quality gate CLI for TypeScript/JavaScript projects that enforces the **ratchet principle**: quality metrics can only improve or stay the same — never regress.

Cliquet orchestrates the quality tools your project already uses (ESLint, Prettier, Biome, tsc, Vitest, Jest), adds its own built-in checks (security, file size, complexity, bundle size), compares everything against a versioned baseline, and fails your CI when any metric gets worse.

## Install

```bash
npm install --save-dev @craverlab/cliquet
```

Requires Node.js ≥ 20.11.

## Quick start

```bash
# Create the baseline with default thresholds
npx cliquet init

# Run all gates and compare against the baseline
npx cliquet check

# Auto-fix what can be fixed (style, lint, performance), then re-check
npx cliquet fix
```

## Quality gates

Gates run in parallel. A regression in any gate blocks with exit code 1.

| # | Gate | Tool | Default threshold |
|---|------|------|-------------------|
| 1 | Security Audit | `npm`/`pnpm`/`yarn audit` + 12 built-in checks | 0 critical/high advisories, 0 findings |
| 2 | Code Style | Prettier and/or Biome | 0 violations |
| 3 | Static Analysis | ESLint, Biome, `tsc --noEmit` | 0 errors |
| 4 | Test Coverage | Vitest or Jest | 85% minimum |
| 5 | Duplication | jscpd (bundled) | 2% maximum |
| 6 | File Size | built-in | 1000 lines per file |
| 7 | Cyclomatic Complexity | built-in (TS compiler API) | Block at CCN 50, warn at 20 |
| 8 | Performance | ESLint (internal ruleset) + built-in condition-order analyzer | 0 violations |
| 9 | Bundle Size | built-in (gzip of your build dir) | Ratchet on measured size |

Tools are detected by their config files (`.prettierrc`, `biome.json`, `eslint.config.*`, `.eslintrc*`, `tsconfig.json`) and resolved from `node_modules/.bin`, then `$PATH`. **A tool that isn't installed or configured makes its gate skip — it never fails.** A tool that crashes turns its gate into `error`, which fails the run: broken tooling can't pass silently.

## The baseline — `cliquet.baseline.json`

`cliquet init` creates a baseline at your project root. Commit it — it is the quality floor:

- **Regressed vs baseline → fail** with prioritized actions pointing at files.
- **Equal → pass.**
- **Improved → pass**, and the report suggests updating the baseline so the ratchet tightens.

**Adopting on a legacy codebase:** defaults are aspirational, so the first `check` may fail. Edit the baseline thresholds to the values `check` reports (never looser than measured) — from there the ratchet holds that line. Security findings are zero-tolerance and have no threshold: fix the code, or disable the specific rule under `security.rules`.

## Output formats

```bash
cliquet check                    # human-readable (default)
cliquet check --plain            # no ANSI colors
cliquet check --format json      # structured output for CI and AI agents
cliquet check --format github    # ::error::/::warning:: annotations
```

When Cliquet detects it is running inside an AI coding agent (Claude Code, Cursor, and others), it automatically switches to JSON output. An explicit `--format` always wins.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | All gates passed (skipped gates don't fail) |
| 1 | At least one gate failed or errored |
| 2 | Usage/config error (invalid baseline, bad flag, missing path) |

## Security checks

Beyond the package-manager audit, 12 built-in rules scan your sources: hardcoded secrets, secrets in client-exposed env vars (`VITE_`, `NEXT_PUBLIC_`, …), `eval`/`new Function`, command injection, SQL injection, unsanitized HTML (`dangerouslySetInnerHTML`, `v-html`, `innerHTML`), path traversal from request input, insecure RNG in security contexts, disabled TLS verification, `target="_blank"` without `rel="noopener"`, missing sensitive entries in `.gitignore`, and freshly-published dependencies (< 3 days). Every rule can be toggled in the baseline.

## Bundle size

The bundle gate measures the gzip size of `.js`/`.mjs`/`.cjs`/`.css` files in your build directory (`dist`, `build`, or `.output`). It doesn't run your build — run it first, then `cliquet init` records the current size and the ratchet holds it. When the gate fails it lists the 5 largest files.

## CI example (GitHub Actions)

```yaml
name: Quality Gate
on:
  pull_request:
    branches: [main]
jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm run build --if-present   # so the bundle gate can measure
      - run: npx cliquet check --format github --plain
```

## CLI reference

```
cliquet init [--force]                  create the baseline (--force overwrites)
cliquet check [--fix]                   run gates; --fix runs fixers on failure and re-checks
cliquet fix [--no-check]                run auto-fixers, then check

Global flags:
  --path <dir>          project root (default: cwd)
  --format <fmt>        human | json | json-pretty | github
  --plain               disable ANSI colors
  --timeout <seconds>   per-gate timeout (default: 300)
```

## License

MIT

## Credits

Cliquet is inspired by [Catraca](https://github.com/b7s/catraca) by [b7s](https://github.com/b7s) — the original PHP quality guardian that coined the turnstile/ratchet approach this project brings to the TypeScript/JavaScript ecosystem ("catraca" is Portuguese for turnstile/ratchet, just as "cliquet" is French for ratchet). If you work with PHP, go use it.
