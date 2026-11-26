# x-bookmarks

Local-first, $0/mo index for X bookmarks using **Safari DOM capture + FxTwitter API v2 + SQLite FTS5** (zero external npm dependencies, runs on Bun).

## How it works

1. **Capture (Safari DOM)**: Attaches to your logged-in Safari tab on `https://x.com/i/bookmarks` via AppleScript (`do JavaScript`), scrolls incrementally, grabs canonical status URLs plus lightweight DOM fallback text, and stops automatically once it hits already-indexed IDs.
2. **Hydrate (FxTwitter API v2)**: Calls `https://api.fxtwitter.com/2/status/{id}` politely (throttled, no API key) to pull full note-tweet text, X Articles, quoted posts, expanded links/domains, media alt text, and engagement counts, archiving the raw JSON permanently.
3. **Search (SQLite FTS5)**: Everything lives in `data/bookmarks.db` with Porter-stemmed full-text search across post text, articles, quotes, link cards, authors, and domains.

## One-time Safari setup

1. In Safari, open **Settings → Advanced** and enable **Show features for web developers**.
2. Open **Settings → Developer** and enable **Allow JavaScript from Apple Events**.
3. Open `https://x.com/i/bookmarks` in Safari while logged in.
4. On first run, click **Allow** when macOS asks for Automation permission to control Safari.

*(No Apple Events? Run `bun run capture -- --print-js` to get a pasteable Safari DevTools console script that downloads a JSON file you can load with `bun run import <file.json>`.)*

## Usage

```bash
# Incremental sync (captures new bookmarks from Safari + hydrates via FxTwitter)
bun run sync

# First-time full backfill (scrolls to the bottom of your bookmarks)
bun run capture -- --full
bun run hydrate -- --limit 1000

# Search
bun run search "sqlite embeddings"
bun run search "mcp" --author karpathy --domain github.com
bun run stats

# Re-parse archived raw JSON and rebuild FTS5 locally (0 network calls)
bun run reindex
```
