import { Schema } from "effect";
import type { BookmarkId, BookmarkSummary } from "./bookmark.ts";

const SearchModeSchema = Schema.Literals(["hybrid", "fulltext", "vector"]);
export type SearchMode = typeof SearchModeSchema.Type;

const SortBySchema = Schema.Literals(["bookmarked", "created"]);

const SearchFiltersSchema = Schema.Struct({
  author: Schema.optional(Schema.String),
  domain: Schema.optional(Schema.String),
  folder: Schema.optional(Schema.String),
  tag: Schema.optional(Schema.String),
  hasArticle: Schema.optional(Schema.Boolean),
  sinceTimestamp: Schema.optional(Schema.Number),
  untilTimestamp: Schema.optional(Schema.Number),
});
export type SearchFilters = typeof SearchFiltersSchema.Type;

export const SearchRequest = Schema.Struct({
  query: Schema.String,
  mode: Schema.optional(SearchModeSchema),
  filters: Schema.optional(SearchFiltersSchema),
  limit: Schema.optional(Schema.Number),
  similarity: Schema.optional(Schema.Number),
});
export type SearchRequest = typeof SearchRequest.Type;

export interface SearchHit {
  readonly score: number;
  readonly bookmark: BookmarkSummary;
  readonly snippet: string;
}

export interface SearchResponse {
  readonly mode: SearchMode;
  readonly total: number;
  readonly elapsedMs: number;
  readonly hits: ReadonlyArray<SearchHit>;
}

export const ListBookmarksQuery = Schema.Struct({
  by: Schema.optional(SortBySchema),
  author: Schema.optional(Schema.String),
  domain: Schema.optional(Schema.String),
  folder: Schema.optional(Schema.String),
  tag: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
  cursor: Schema.optional(Schema.Number),
});
export type ListBookmarksQuery = typeof ListBookmarksQuery.Type;

export interface BookmarkPage {
  readonly items: ReadonlyArray<BookmarkSummary>;
  readonly nextCursor: number | null;
}

export const IngestBookmarksRequest = Schema.Struct({
  refs: Schema.Array(Schema.String),
  hydrate: Schema.optional(Schema.Boolean),
  embed: Schema.optional(Schema.Boolean),
  threads: Schema.optional(Schema.Boolean),
  folderName: Schema.optional(Schema.String),
});
export type IngestBookmarksRequest = typeof IngestBookmarksRequest.Type;

export interface IngestBookmarksResponse {
  readonly added: number;
  readonly existing: number;
  readonly skippedPruned: number;
  readonly skippedInvalid: number;
  readonly hydrated: number;
  readonly indexed: number;
  readonly ids: ReadonlyArray<BookmarkId>;
}

export interface DeleteBookmarkResponse {
  readonly id: BookmarkId;
  readonly deleted: boolean;
  readonly tombstoned: boolean;
  readonly removedFromIndex: boolean;
}

export const PruneBookmarksRequest = Schema.Struct({
  ids: Schema.Array(Schema.String),
  hard: Schema.optional(Schema.Boolean),
  reason: Schema.optional(Schema.String),
});
export type PruneBookmarksRequest = typeof PruneBookmarksRequest.Type;

export interface PruneBookmarksResponse {
  readonly requested: number;
  readonly deletedIds: ReadonlyArray<BookmarkId>;
  readonly notFoundIds: ReadonlyArray<string>;
  readonly tombstoned: boolean;
}

export const UpdateTagsRequest = Schema.Struct({
  tags: Schema.Array(Schema.String),
});
export type UpdateTagsRequest = typeof UpdateTagsRequest.Type;

export interface TagUpdateResponse {
  readonly id: BookmarkId;
  readonly tags: ReadonlyArray<string>;
}

export const SyncRequest = Schema.Struct({
  full: Schema.optional(Schema.Boolean),
  threads: Schema.optional(Schema.Boolean),
  embed: Schema.optional(Schema.Boolean),
  maxItems: Schema.optional(Schema.Number),
  hydrateLimit: Schema.optional(Schema.Number),
});
export type SyncRequest = typeof SyncRequest.Type;

export interface SyncReport {
  readonly captured: number;
  readonly added: number;
  readonly skippedPruned: number;
  readonly stoppedReason: string;
  readonly hydratedOk: number;
  readonly hydratedUnavailable: number;
  readonly hydratedErrors: number;
  readonly embedded: number;
  readonly indexed: number;
}

export const ReindexRequest = Schema.Struct({
  embedMissing: Schema.optional(Schema.Boolean),
});
export type ReindexRequest = typeof ReindexRequest.Type;

export interface ReindexReport {
  readonly reparsed: number;
  readonly embedded: number;
  readonly indexed: number;
}

export interface HealthStatus {
  readonly status: "ok";
  readonly totalBookmarks: number;
  readonly indexedVectors: number;
  readonly prunedCount: number;
  readonly embeddingModel: string;
  readonly embeddingDims: number;
}

export type ApiErrorCode = "bad_request" | "not_found" | "conflict" | "unavailable" | "internal";

export interface ApiErrorEnvelope {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
  };
}

export const apiError = (code: ApiErrorCode, message: string): ApiErrorEnvelope => ({
  error: { code, message },
});

const ERROR_STATUS = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
  internal: 500,
} satisfies Record<ApiErrorCode, number>;

export const httpStatusForError = (code: ApiErrorCode): number => ERROR_STATUS[code];

export interface OpenApiSpec {
  readonly openapi: "3.1.0";
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Record<string, Record<string, { readonly summary: string }>>;
}

export const openApiDocument = (): OpenApiSpec => ({
  openapi: "3.1.0",
  info: { title: "x-bookmarks API", version: "1.0.0" },
  paths: {
    "/health": { get: { summary: "Service health and vector index status" } },
    "/v1/openapi.json": { get: { summary: "OpenAPI 3.1 contract document" } },
    "/v1/stats": { get: { summary: "Bookmark, hydration, domain, and vector statistics" } },
    "/v1/search": { post: { summary: "Hybrid, fulltext, or vector search via Orama" } },
    "/v1/bookmarks": {
      get: { summary: "List bookmarks ordered by bookmarked recency or creation date" },
      post: { summary: "Ingest bookmark URLs or IDs with optional hydration and embedding" },
    },
    "/v1/bookmarks/prune": { post: { summary: "Batch prune bookmarks from SQLite and Orama (tombstoned by default)" } },
    "/v1/bookmarks/{id}": {
      get: { summary: "Fetch full bookmark detail including X Article Markdown and thread posts" },
      delete: { summary: "Delete and prune one bookmark from SQLite and Orama (?hard=true skips tombstone)" },
    },
    "/v1/bookmarks/{id}/tags": { put: { summary: "Add normalized tags on a bookmark" } },
    "/v1/bookmarks/{id}/tags/{tag}": { delete: { summary: "Remove a single tag from a bookmark" } },
    "/v1/sync": { post: { summary: "Run incremental capture, hydration, embedding, and Orama upsert" } },
    "/v1/reindex": { post: { summary: "Reparse archived raw JSON and rebuild Orama snapshot from SQLite" } },
  },
});
