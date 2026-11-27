import { Context, Data, type Effect } from "effect";
import type { SearchFilters, SearchMode } from "../domain/api.ts";
import type { BookmarkId, IndexableBookmark } from "../domain/bookmark.ts";

export class SearchIndexError extends Data.TaggedError("SearchIndexError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `search index ${this.operation} failed`;
  }
}

export interface SearchDocumentInput {
  readonly bookmark: IndexableBookmark;
  readonly vector: ReadonlyArray<number>;
}

export interface SearchIndexHit {
  readonly id: BookmarkId;
  readonly score: number;
}

export interface SearchIndexQuery {
  readonly term: string;
  readonly mode: SearchMode;
  readonly vector: ReadonlyArray<number> | null;
  readonly filters: SearchFilters | undefined;
  readonly limit: number;
  readonly similarity: number;
}

export interface SearchIndexResult {
  readonly total: number;
  readonly hits: ReadonlyArray<SearchIndexHit>;
}

export interface SearchIndexShape {
  readonly upsert: (doc: SearchDocumentInput) => Effect.Effect<void, SearchIndexError>;
  readonly remove: (id: BookmarkId) => Effect.Effect<boolean, SearchIndexError>;
  readonly search: (query: SearchIndexQuery) => Effect.Effect<SearchIndexResult, SearchIndexError>;
  readonly rebuild: (docs: ReadonlyArray<SearchDocumentInput>) => Effect.Effect<number, SearchIndexError>;
  readonly persist: () => Effect.Effect<void, SearchIndexError>;
  readonly count: () => Effect.Effect<number, SearchIndexError>;
}

export class SearchIndex extends Context.Service<SearchIndex, SearchIndexShape>()(
  "x-bookmarks/ports/search-index/SearchIndex",
) {}
