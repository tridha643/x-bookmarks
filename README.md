# x-bookmarks

Local-first, $0/mo X bookmarks indexer built with **Effect v4**, **SQLite (`node:sqlite`)**, **Orama hybrid BM25 + vector search**, **local Ollama `nomic-embed-text`** (with optional OpenAI-compatible embeddings), a **Playwright incremental DOM capture + 24h macOS `launchd` cron**, a **versioned HTTP v1 API**, and a **read-only stdio MCP server**.

## Architecture

Enforced by Fallow boundary zones (`.fallowrc.json`):

1. **`src/domain/`** — Pure domain models, Effect Schemas, Draft.js X Article Markdown parser, FxTwitter/VxTwitter/Syndication parsers, v1 API contract, and OpenAPI 3.1 generator. Zero imports from other internal zones.
2. **`src/ports/`** — Effect `Context.Service` ports (`BookmarkStore`, `SearchIndex`, `Embedder`, `Hydrator`, `CaptureSource`) and typed `Data.TaggedError` failures. Imports only `domain`.
3. **`src/control/`** — Pure Effect workflows (`searchBookmarks`, `ingestBookmarks`, `hydratePending`, `syncBookmarks`, `reindexAll`, `deleteBookmark`, `pruneBookmarks`, `updateTags`, `deleteTag`, `getHealth`, `getIndexStats`). Imports only `domain` and `ports`.
4. **`src/adapters/`** — Concrete Effect Layers and servers:
   - `sqlite/store.ts` — System of record (`data/bookmarks.db`), additive migrations, `pruned_bookmarks` tombstones, and `embeddings` cache keyed by `(bookmark_id, model)` with `content_hash`.
   - `orama/index.ts` — Hybrid BM25 + 768-dim cosine vector index persisted to `data/orama.msp` via `@orama/plugin-data-persistence`.
   - `embedder/live.ts` — Local Ollama (`nomic-embed-text` with `search_document:` / `search_query:` prefixes) and OpenAI-compatible HTTP embedders.
   - `fxtwitter/client.ts` — Rate-limited FxTwitter API v2 status/thread hydrator with VxTwitter and X syndication fallbacks.
   - `browser/` — Off-screen headed Chromium persistent profile capture with in-page `MutationObserver`, `/i/bookmarks` + `/i/history` support, and PID lockfile (`data/sync.lock`).
   - `http/server.ts` — Node HTTP v1 JSON API server.
   - `mcp/server.ts` — Read-only stdio JSON-RPC MCP server.
   - `cron/launchd.ts` — macOS `launchd` LaunchAgent (`com.xbookmarks.sync`, default 24h incremental sync).
5. **`src/main.ts`** — Composition root and CLI entrypoint.

## Quickstart

```bash
# 1. Install dependencies & Chromium
pnpm install
pnpm exec playwright install chromium

# 2. Ensure local Ollama + nomic-embed-text is running ($0/mo)
brew services start ollama
ollama pull nomic-embed-text

# 3. Sign into X once (saves cookies in data/browser-profile)
pnpm login

# 4. Run incremental sync (capture -> hydrate -> embed -> Orama persist)
pnpm sync -- --threads

# 5. Or rebuild & embed all existing SQLite rows into Orama
pnpm reindex

# 6. Install 24h incremental macOS launchd cron
pnpm run cron -- install --every 24h
pnpm run cron -- status
```

## HTTP v1 API Contract

Start the server with `pnpm serve` (defaults to `http://127.0.0.1:8787`; live OpenAPI 3.1 spec at `GET /v1/openapi.json`):

- `GET /health` — Service health, bookmark count, vector count, pruned count, and active embedding model/dims.
- `GET /v1/openapi.json` — OpenAPI 3.1 contract document.
- `GET /v1/stats` — Hydration, article, thread, pruned, embedding, author, and domain metrics.
- `POST /v1/search` — Hybrid (`hybrid`), BM25 (`fulltext`), or cosine (`vector`) search with author/domain/folder/tag/article/timestamp filters. Hybrid mode degrades gracefully to `fulltext` if Ollama is offline.
- `GET /v1/bookmarks` — Cursor-paginated list ordered by `bookmarked` or `created` with author/domain/folder/tag filters.
- `POST /v1/bookmarks` — Ingest tweet URLs or snowflake IDs with optional hydration and embedding.
- `GET /v1/bookmarks/:id` — Full bookmark detail including X Article Markdown, quotes, links, tags, and thread posts.
- `DELETE /v1/bookmarks/:id` — Prune one bookmark from SQLite and Orama. Records a tombstone in `pruned_bookmarks` by default so future syncs do not re-import it; pass `?hard=true` to allow re-import and optional `?reason=...`.
- `POST /v1/bookmarks/prune` — Batch prune `{ ids: string[], hard?: boolean, reason?: string }`.
- `PUT /v1/bookmarks/:id/tags` & `DELETE /v1/bookmarks/:id/tags/:tag` — Add/remove normalized tags and keep Orama synchronized.
- `POST /v1/sync` — Trigger incremental Playwright capture, hydration, embedding, and Orama upsert.
- `POST /v1/reindex` — Reparse archived raw JSON, compute any missing embeddings, and rebuild `data/orama.msp`.

## CLI Commands

```bash
pnpm run search -- "personal agent" --mode hybrid --limit 5
pnpm run list -- --by bookmarked --limit 20
pnpm run add -- https://x.com/user/status/1234567890 --folder Reading
pnpm run prune -- 1234567890 --reason "no longer needed"
pnpm run prune -- 1234567890 --hard
pnpm run tag -- add 1234567890 ai systems
pnpm run tag -- rm 1234567890 systems
pnpm stats
pnpm serve
pnpm mcp
```

## Verification Gates

```bash
# Typecheck (@effect/tsgo + TS 7), oxlint (strict + anti-slop + landmines), oxfmt, fallow dead-code/dupes/health, fallow architecture, Vitest, git diff --check
pnpm check

# Mutation testing (100% score gate on changed code with survivor typechecking)
pnpm mutate
```
