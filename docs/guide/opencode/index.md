# OpenCode CLI Overview (Beta)

> The OpenCode companion CLI is experimental. Expect breaking changes while both ccusage and [OpenCode](https://github.com/sst/opencode) continue to evolve.

The `@ccusage/opencode` package reuses ccusage's responsive tables, pricing cache, and token accounting to analyze [OpenCode](https://github.com/sst/opencode) session logs. OpenCode is a terminal-based AI coding assistant that supports multiple AI providers.

## Installation & Launch

::: code-group

```bash [bunx (Recommended)]
bunx @ccusage/opencode@latest --help
```

```bash [npx]
npx @ccusage/opencode@latest --help
```

```bash [pnpm]
pnpm dlx @ccusage/opencode --help
```

```bash [opencode x]
BUN_BE_BUN=1 opencode x @ccusage/opencode@latest --help
```

:::

::: tip opencode x option
The `opencode x` option requires the native version of OpenCode. If you installed OpenCode via npm, use the `bunx` or `npx` options instead.
:::

### Recommended: Shell Alias

```bash
# bash/zsh
alias ccusage-opencode='bunx @ccusage/opencode@latest'

# fish
alias ccusage-opencode 'bunx @ccusage/opencode@latest'
```

## Data Source

The CLI reads OpenCode SQLite storage at:

```txt
~/.local/share/opencode/opencode.db
```

Set `OPENCODE_DATA_DIR` to point to a different OpenCode data root.

## Available Commands

| Command   | Description                                          | See also                                  |
| --------- | ---------------------------------------------------- | ----------------------------------------- |
| `daily`   | Aggregate usage by date (YYYY-MM-DD)                 | [Daily Reports](/guide/daily-reports)     |
| `weekly`  | Aggregate usage by ISO week (YYYY-Www)               | [Weekly Reports](/guide/weekly-reports)   |
| `monthly` | Aggregate usage by month (YYYY-MM)                   | [Monthly Reports](/guide/monthly-reports) |
| `session` | Per-session breakdown with parent/subagent hierarchy | [Session Reports](/guide/session-reports) |
| `model`   | Aggregate usage by model across filtered history     | —                                         |

All commands support `--json` for structured output and `--compact` for narrow terminals.

## Report Layout

- Summary rows are shown by default.
- Per-model breakdown rows are hidden by default.
- Use `--full` to include per-model breakdown rows.

### Token and Cost Columns

- **Input** shows total input-side tokens (`input + cache create + cache read`).
- **Output** shows output tokens.
- **Cache** shows cache-read tokens and cache ratio.
- In per-model rows (`--full`), input/output can include effective `$ / M` rates.

## Session Hierarchy

OpenCode supports subagent sessions. The session report displays:

- **Bold titles** for parent sessions with subagents
- **Indented rows** (`↳`) for subagent sessions
- **Subtotal rows** combining parent + subagents
- **Project/directory label** on the second line under each session title

### Scope filters

All report commands support:

- `--id, -i <sessionID>`: include only entries from one session
- `--project, -p <name>`: filter by project name/path

## Date & Time Filters

All report commands support:

- `--since <value>`
- `--until <value>`
- `--last <duration>`

Supported absolute formats for `--since/--until`:

- `YYYYMMDD` (example: `20260216`)
- `YYYYMMDDHHMM` (example: `202602161530`)
- `YYYY-MM-DD`
- `YYYY-MM-DD HH:MM`
- `YYYY-MM-DDTHH:MM`
- ISO datetime strings

Supported duration formats for `--last`:

- `15m`, `2h`, `3d`, `1w`

Notes:

- `--last` cannot be combined with `--since` or `--until`.
- Filters follow local-time boundaries by default.

### Examples

```bash
# Last 24 hours
ccusage-opencode daily --last 24h

# Local day range
ccusage-opencode session --since 20260216 --until 20260218

# One specific session
ccusage-opencode session --id ses_abc123

# Filter by project name/path
ccusage-opencode session --project my-repo

# Precise local time window
ccusage-opencode model --since 202602161200 --until 202602161800

# Include per-model breakdown rows
ccusage-opencode daily --last 3d --full
```

## Environment Variables

| Variable            | Description                                          |
| ------------------- | ---------------------------------------------------- |
| `OPENCODE_DATA_DIR` | Override the root directory containing OpenCode data |
| `LOG_LEVEL`         | Adjust verbosity (0 silent ... 5 trace)              |

## Cost Calculation

OpenCode stores `cost: 0` in message files. Costs are calculated from token counts using LiteLLM pricing. Model aliases (e.g., `gemini-3-pro-high` → `gemini-3-pro-preview`) are handled automatically.

## Troubleshooting

::: details No OpenCode usage data found
Ensure the data directory contains `opencode.db` under `~/.local/share/opencode/`. Set `OPENCODE_DATA_DIR` for custom paths.
:::

::: details Costs showing as $0.00
If a model is not in LiteLLM's database, the cost will be $0.00. [Open an issue](https://github.com/ryoppippi/ccusage/issues/new) to request alias support.
:::
