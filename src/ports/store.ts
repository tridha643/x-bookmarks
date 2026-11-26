import { Context, Data, type Effect } from "effect";
import type { BookmarkPage, ListBookmarksQuery } from "../domain/api.ts";
import type {
  BookmarkDetail,
  BookmarkId,
  CapturedBookmark,
  HydratedFields,
  IndexStats,
  IndexableBookmark,
} from "../domain/bookmark.ts";

export class StoreError extends Data.TaggedError("StoreError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `store ${this.operation} failed`;
  }
}

export interface UpsertBatchResult {
  readonly added: number;
  readonly existing: number;
  readonly skippedPruned: number;
}

export interface StoredEmbedding {
  readonly model: string;
  readonly dims: number;
  readonly contentHash: string;
  readonly vector: ReadonlyArray<number>;
}

export interface RawPayloadRecord {
  readonly id: BookmarkId;
  readonly rawJson: string;
}

export interface BookmarkStoreShape {
  readonly getKnownAndPrunedIds: () => Effect.Effect<ReadonlySet<string>, StoreError>;
  readonly upsertCapturedBatch: (
    items: ReadonlyArray<CapturedBookmark>,
  ) => Effect.Effect<UpsertBatchResult, StoreError>;
  readonly saveHydrated: (input: {
    readonly id: BookmarkId;
    readonly status: "ok" | "unavailable" | "error";
    readonly fields: HydratedFields;
    readonly errorMessage: string | null;
    readonly retryAfterSeconds: number | null;
  }) => Effect.Effect<void, StoreError>;
  readonly getById: (id: BookmarkId) => Effect.Effect<BookmarkDetail | null, StoreError>;
  readonly list: (query: ListBookmarksQuery) => Effect.Effect<BookmarkPage, StoreError>;
  readonly getPendingHydration: (
    limit: number,
    includeErrors: boolean,
  ) => Effect.Effect<ReadonlyArray<{ readonly id: BookmarkId; readonly url: string }>, StoreError>;
  readonly prune: (
    id: BookmarkId,
    opts: { readonly hard: boolean; readonly reason: string | null },
  ) => Effect.Effect<boolean, StoreError>;
  readonly addTags: (
    id: BookmarkId,
    tags: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string> | null, StoreError>;
  readonly removeTag: (id: BookmarkId, tag: string) => Effect.Effect<ReadonlyArray<string> | null, StoreError>;
  readonly getEmbedding: (id: BookmarkId, model: string) => Effect.Effect<StoredEmbedding | null, StoreError>;
  readonly saveEmbedding: (id: BookmarkId, embedding: StoredEmbedding) => Effect.Effect<void, StoreError>;
  readonly getIndexableById: (id: BookmarkId) => Effect.Effect<IndexableBookmark | null, StoreError>;
  readonly listAllIndexable: () => Effect.Effect<ReadonlyArray<IndexableBookmark>, StoreError>;
  readonly listRawPayloads: () => Effect.Effect<ReadonlyArray<RawPayloadRecord>, StoreError>;
  readonly stats: (indexedVectors: number) => Effect.Effect<IndexStats, StoreError>;
}

export class BookmarkStore extends Context.Service<BookmarkStore, BookmarkStoreShape>()(
  "x-bookmarks/ports/store/BookmarkStore",
) {}
