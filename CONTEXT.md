# Domain Glossary

- **Bookmark**: A saved X post identified by a branded snowflake `BookmarkId`, ordered in reverse bookmark recency via `bookmark_seq` and archived in SQLite (`bookmarks`).
- **Capture**: Deterministic browser ingestion of bookmark IDs and DOM metadata from X (`/i/bookmarks` or `/i/history`) via Playwright persistent profile (`data/browser-profile`).
- **Hydration**: Enriching a captured bookmark via FxTwitter API v2 (`/2/status/:id`, `/2/thread/:id`) with VxTwitter and X syndication fallbacks, preserving source-quality precedence (`fxtwitter > vxtwitter > syndication > dom > manual`).
- **X Article**: Long-form Draft.js article attached to a post, rendered deterministically into Markdown (`article_title`, `article_text`).
- **Embedding**: A fixed-dimension dense vector (default 768 dims from local Ollama `nomic-embed-text`) cached in SQLite (`embeddings`) keyed by `(bookmark_id, model)` and invalidated when `content_hash` changes.
- **Orama Snapshot**: Binary persisted hybrid search index (`data/orama.msp`) combining BM25 full-text and cosine vector search over indexed bookmarks, persisted atomically via temp file rename and auto-reloaded on disk `mtimeMs` changes so the persistent HTTP/MCP server stays fresh after external CLI or cron updates.
- **Streamable HTTP MCP**: JSON-RPC endpoint (`POST /mcp`, protocol `2025-03-26`) hosted alongside the v1 HTTP API and exposed privately over Tailscale Serve, publishing all 12 v1 bookmark API operations as MCP tools.
- **Prune (Soft / Hard)**: Removing a bookmark from both SQLite and Orama. Soft prune (default) writes a tombstone to `pruned_bookmarks` so future syncs skip re-importing the ID; hard prune (`hard=true`) deletes both the bookmark and any tombstone.
- **Reindex**: Offline rebuild that reparses archived `raw_fx_json`, computes missing or stale embeddings, and atomically rebuilds `data/orama.msp` from SQLite.
