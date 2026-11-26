# x-bookmarks

Local-first, $0/mo index for X bookmarks using **DOM capture + FxTwitter API v2 + SQLite FTS5** (zero external npm dependencies, runs on Bun).

## Architecture

1. **Capture (DOM)**: Collects canonical tweet URLs + lightweight DOM fallback text on `https://x.com/i/bookmarks` via an in-page `MutationObserver` (works via Safari AppleScript, DevTools console export, or a future headless persistent-profile runner). Stops incrementally once it reaches already-indexed IDs and preserves bookmark recency order via `bookmark_seq`.
2. **Hydrate (FxTwitter API v2 + fallbacks)**: Calls `https://api.fxtwitter.com/2/status/{id}` (and `/2/thread/{id}` when `--threads` detects a thread) to archive full raw JSON, Draft.js X Articles rendered to Markdown (including code blocks, links, and embedded tweets), quote tweets, polls, community notes, media alt text, and link domains. Falls back to `api.vxtwitter.com` and X syndication if FxTwitter errors, with source-quality ranking so truncated fallbacks never overwrite richer text.
3. **Search & MCP (SQLite FTS5)**: Stores everything in `data/bookmarks.db` with safe FTS5 query sanitization, weighted `bm25()`, tags/folders/links tables, and a read-only stdio MCP server (`bun run mcp`).

## One-time Safari setup

1. In Safari, open **Settings → Advanced** and enable **Show features for web developers**.
2. Open **Settings → Developer** and enable **Allow JavaScript from Apple Events**.
3. Open `https://x.com/i/bookmarks` in a visible Safari tab while logged in.
4. Click **Allow** when macOS prompts for Automation permission (updating your terminal or T3 Code can reset this grant).

*(Prefer manual capture? Run `bun run capture -- --print-js` to copy a console script that downloads a JSON file you can load with `bun run import <file.json>`.)*

## Usage

```bash
# Incremental sync from Safari + FxTwitter hydration
bun run sync

# First-time full backfill (keep Safari tab visible)
bun run capture -- --full
bun run hydrate -- --limit 1000 --threads

# Search (handles punctuation like c++, state-of-the-art, @user safely)
bun run search "c++ state-of-the-art"
bun run search "mcp" --author karpathy --domain github.com
bun run list --by bookmarked --limit 20
bun run tag add <tweet-id> ai systems
bun run stats

# Re-parse archived raw JSON and rebuild FTS5 locally (0 network calls)
bun run reindex

# Start local read-only MCP server (for Claude / Cursor / T3 agents)
bun run mcp
```
