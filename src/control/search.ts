import { Clock, Effect } from "effect";
import type { SearchHit, SearchMode, SearchRequest, SearchResponse } from "../domain/api.ts";
import type { BookmarkDetail, BookmarkSummary } from "../domain/bookmark.ts";
import { Embedder, type EmbedderError } from "../ports/embedder.ts";
import { SearchIndex, type SearchIndexError } from "../ports/search-index.ts";
import { BookmarkStore, type StoreError } from "../ports/store.ts";

const clampLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) return 10;
  return Math.min(Math.max(Math.trunc(limit), 1), 50);
};

const clampSimilarity = (similarity: number | undefined): number => {
  if (similarity === undefined || !Number.isFinite(similarity)) return 0.45;
  return Math.min(Math.max(similarity, 0), 1);
};

const toSummary = (detail: BookmarkDetail): BookmarkSummary => ({
  id: detail.id,
  url: detail.url,
  bookmarkSeq: detail.bookmarkSeq,
  authorHandle: detail.authorHandle,
  authorName: detail.authorName,
  createdAt: detail.createdAt,
  createdTimestamp: detail.createdTimestamp,
  capturedAt: detail.capturedAt,
  text: detail.text,
  articleTitle: detail.articleTitle,
  domains: detail.domains,
  tags: detail.tags,
  folders: detail.folders,
  hydrationStatus: detail.hydrationStatus,
  hydrationSource: detail.hydrationSource,
});

const buildSnippet = (detail: BookmarkDetail): string => {
  const prefix = detail.articleTitle !== null ? `[Article] ${detail.articleTitle} — ` : "";
  const body = detail.text ?? detail.articleText ?? detail.domText ?? "";
  const flat = `${prefix}${body}`.replace(/\s+/g, " ").trim();
  return flat.length > 220 ? `${flat.slice(0, 220)}...` : flat;
};

const resolveVector = (
  query: string,
  requestedMode: SearchMode,
): Effect.Effect<
  { readonly mode: SearchMode; readonly vector: ReadonlyArray<number> | null },
  EmbedderError,
  Embedder
> =>
  Effect.gen(function* () {
    if (requestedMode === "fulltext") {
      return { mode: "fulltext", vector: null };
    }
    const embedder = yield* Embedder;
    if (requestedMode === "vector") {
      const vector = yield* embedder.embedQuery(query);
      return { mode: "vector", vector };
    }
    // Hybrid mode gracefully degrades to fulltext when the local embedder is offline.
    const vector = yield* embedder.embedQuery(query).pipe(Effect.orElseSucceed(() => null));
    return vector === null ? { mode: "fulltext", vector: null } : { mode: "hybrid", vector };
  });

export const searchBookmarks = (
  req: SearchRequest,
): Effect.Effect<
  SearchResponse,
  StoreError | SearchIndexError | EmbedderError,
  BookmarkStore | SearchIndex | Embedder
> =>
  Effect.gen(function* () {
    const startedMs = yield* Clock.currentTimeMillis;
    const store = yield* BookmarkStore;
    const index = yield* SearchIndex;
    const trimmed = req.query.trim();
    const requestedMode: SearchMode = req.mode ?? (trimmed !== "" ? "hybrid" : "fulltext");
    const limit = clampLimit(req.limit);
    const similarity = clampSimilarity(req.similarity);

    const { mode, vector } = yield* resolveVector(trimmed, requestedMode);
    const raw = yield* index.search({
      term: trimmed,
      mode,
      vector,
      filters: req.filters,
      limit,
      similarity,
    });

    const hits: SearchHit[] = [];
    for (const hit of raw.hits) {
      const detail = yield* store.getById(hit.id);
      if (detail === null) continue;
      hits.push({
        score: hit.score,
        bookmark: toSummary(detail),
        snippet: buildSnippet(detail),
      });
    }

    const finishedMs = yield* Clock.currentTimeMillis;
    return {
      mode,
      total: raw.total,
      elapsedMs: Math.max(0, finishedMs - startedMs),
      hits,
    };
  });
