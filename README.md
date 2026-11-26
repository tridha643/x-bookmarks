# x-bookmarks

Local-first, $0/mo index for X bookmarks using a **Playwright persistent Chromium profile + macOS `launchd` cron + FxTwitter API v2 + SQLite FTS5**.

## Architecture

1. **Capture (Deterministic DOM)**: Runs headless Chromium against a dedicated persistent profile (`data/browser-profile`) where you sign into X once. Uses an in-page `MutationObserver` collector (`src/dom-collector.ts`), stops incrementally after hitting 15 already-known bookmark IDs, protects concurrent cron runs with a PID lockfile (`data/sync.lock`), and preserves bookmark recency order via `bookmark_seq`. (Safari AppleScript is available via `--engine safari`, a DevTools console snippet via `--print-js`, and an official X API pay-per-use `--engine x-api` adapter can plug straight into the same capture interface next.)
2. **Hydrate (FxTwitter API v2 + fallbacks)**: Calls `https://api.fxtwitter.com/2/status/{id}` (and `/2/thread/{id}` when `--threads` detects a thread) to archive full raw JSON, Draft.js X Articles rendered to Markdown (including fenced code blocks, links, and embedded tweets), quote tweets, polls, community notes, media alt text, and link domains. Falls back to `api.vxtwitter.com` and X syndication if FxTwitter errors, with source-quality ranking so truncated fallbacks never overwrite richer text.
3. **Search & MCP (SQLite FTS5)**: Stores everything in `data/bookmarks.db` with safe FTS5 query sanitization, weighted `bm25()`, tags/folders/links tables, and a zero-dependency read-only stdio MCP server (`bun run mcp`).

## Quickstart

```bash
# 1. Install dependencies & Chromium
bun install
bunx playwright install chromium

# 2. Sign into X once (saves cookies in data/browser-profile)
bun run login

# 3. Run initial full backfill + hydrate
bun run capture -- --full
bun run hydrate -- --limit 1000 --threads

# 4. Install deterministic macOS launchd cron (runs every hour in background, 0 LLM tokens)
bun run cron install -- --every 1h
bun run cron status
```

## Daily commands

```bash
# Manual incremental sync
bun run sync

# Search (punctuation like c++, state-of-the-art, @user is handled safely)
bun run search "c++ state-of-the-art"
bun run search "mcp" --author karpathy --domain github.com
bun run list --by bookmarked --limit 20
bun run tag add <tweet-id> ai systems
bun run stats

# Manage launchd cron
bun run cron status
bun run cron run
bun run cron uninstall

# Re-parse archived raw JSON and rebuild FTS5 locally (0 network calls)
bun run reindex

# Start local read-only MCP server (for Claude / Cursor / T3 agents)
bun run mcp
```
