# x-bookmarks

Local-first, low-cost index for X bookmarks.

## Goals

- **Cheap**: $0/mo local storage (SQLite + FTS5 + optional local embeddings) and either $0 browser-based capture or pennies via X's pay-per-use API.
- **Sustainable**: Incremental sync (stop as soon as already-seen bookmark IDs are reached), raw JSON archival so re-indexing never requires re-fetching, and decoupled ingestion from search/UI.

## Planned Architecture

1. **Ingest**: Pluggable adapters (`browser-extension` / `export-json` / `x-api`) writing normalized records + raw payloads.
2. **Store**: Single local SQLite database with FTS5 full-text search, link/thread expansion cache, tags, and optional vector embeddings.
3. **Query**: Fast CLI and/or local web UI for keyword, author, domain, tag, and semantic search.
