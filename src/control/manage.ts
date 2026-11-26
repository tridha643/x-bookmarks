import { Effect } from "effect";
import type {
  BookmarkPage,
  DeleteBookmarkResponse,
  HealthStatus,
  ListBookmarksQuery,
  PruneBookmarksRequest,
  PruneBookmarksResponse,
  TagUpdateResponse,
} from "../domain/api.ts";
import {
  decodeBookmarkId,
  normalizeTag,
  type BookmarkDetail,
  type BookmarkId,
  type IndexStats,
} from "../domain/bookmark.ts";
import { Embedder } from "../ports/embedder.ts";
import { SearchIndex, type SearchIndexError } from "../ports/search-index.ts";
import { BookmarkStore, type StoreError } from "../ports/store.ts";

export const getBookmark = (id: BookmarkId): Effect.Effect<BookmarkDetail | null, StoreError, BookmarkStore> =>
  Effect.flatMap(BookmarkStore, (store) => store.getById(id));

export const listBookmarks = (query: ListBookmarksQuery): Effect.Effect<BookmarkPage, StoreError, BookmarkStore> =>
  Effect.flatMap(BookmarkStore, (store) => store.list(query));

export const deleteBookmark = (
  id: BookmarkId,
  opts: { readonly hard: boolean; readonly reason: string | null },
): Effect.Effect<DeleteBookmarkResponse, StoreError | SearchIndexError, BookmarkStore | SearchIndex> =>
  Effect.gen(function* () {
    const store = yield* BookmarkStore;
    const index = yield* SearchIndex;
    const deleted = yield* store.prune(id, opts);
    const removedFromIndex = yield* index.remove(id);
    if (removedFromIndex) yield* index.persist();
    return { id, deleted, tombstoned: deleted && !opts.hard, removedFromIndex };
  });

const pruneSingleRaw = (
  rawId: string,
  opts: { readonly hard: boolean; readonly reason: string | null },
): Effect.Effect<
  { readonly id: BookmarkId | null; readonly deleted: boolean; readonly removed: boolean },
  StoreError | SearchIndexError,
  BookmarkStore | SearchIndex
> =>
  Effect.gen(function* () {
    const id = decodeBookmarkId(rawId);
    if (id === null) return { id: null, deleted: false, removed: false };
    const store = yield* BookmarkStore;
    const index = yield* SearchIndex;
    const deleted = yield* store.prune(id, opts);
    const removed = yield* index.remove(id);
    return { id, deleted, removed };
  });

export const pruneBookmarks = (
  req: PruneBookmarksRequest,
): Effect.Effect<PruneBookmarksResponse, StoreError | SearchIndexError, BookmarkStore | SearchIndex> =>
  Effect.gen(function* () {
    const index = yield* SearchIndex;
    const hard = req.hard ?? false;
    const opts = { hard, reason: req.reason ?? null };
    const deletedIds: BookmarkId[] = [];
    const notFoundIds: string[] = [];
    let indexChanged = false;

    for (const rawId of req.ids) {
      const outcome = yield* pruneSingleRaw(rawId, opts);
      if (outcome.removed) indexChanged = true;
      if (outcome.id !== null && outcome.deleted) deletedIds.push(outcome.id);
      else notFoundIds.push(rawId);
    }

    if (indexChanged) yield* index.persist();
    return { requested: req.ids.length, deletedIds, notFoundIds, tombstoned: !hard };
  });

const syncTagsToIndex = (
  id: BookmarkId,
): Effect.Effect<void, StoreError | SearchIndexError, BookmarkStore | SearchIndex | Embedder> =>
  Effect.gen(function* () {
    const store = yield* BookmarkStore;
    const index = yield* SearchIndex;
    const embedder = yield* Embedder;
    const indexable = yield* store.getIndexableById(id);
    if (indexable === null) return;
    const cached = yield* store.getEmbedding(id, embedder.model);
    const vector =
      cached !== null && cached.dims === embedder.dimensions
        ? cached.vector
        : Array.from({ length: embedder.dimensions }, () => 0);
    yield* index.upsert({ bookmark: indexable, vector });
    yield* index.persist();
  });

export const updateTags = (
  id: BookmarkId,
  rawTags: ReadonlyArray<string>,
): Effect.Effect<TagUpdateResponse | null, StoreError | SearchIndexError, BookmarkStore | SearchIndex | Embedder> =>
  Effect.gen(function* () {
    const store = yield* BookmarkStore;
    const normalized = rawTags.map(normalizeTag).filter((t): t is string => t !== null);
    const updated = yield* store.addTags(id, normalized);
    if (updated === null) return null;
    yield* syncTagsToIndex(id);
    return { id, tags: updated };
  });

export const deleteTag = (
  id: BookmarkId,
  rawTag: string,
): Effect.Effect<TagUpdateResponse | null, StoreError | SearchIndexError, BookmarkStore | SearchIndex | Embedder> =>
  Effect.gen(function* () {
    const store = yield* BookmarkStore;
    const normalized = normalizeTag(rawTag);
    const updated = yield* store.removeTag(id, normalized ?? rawTag);
    if (updated === null) return null;
    yield* syncTagsToIndex(id);
    return { id, tags: updated };
  });

export const getIndexStats = (): Effect.Effect<
  IndexStats,
  StoreError | SearchIndexError,
  BookmarkStore | SearchIndex
> =>
  Effect.gen(function* () {
    const store = yield* BookmarkStore;
    const index = yield* SearchIndex;
    const indexedVectors = yield* index.count();
    return yield* store.stats(indexedVectors);
  });

export const getHealth = (): Effect.Effect<
  HealthStatus,
  StoreError | SearchIndexError,
  BookmarkStore | SearchIndex | Embedder
> =>
  Effect.gen(function* () {
    const embedder = yield* Embedder;
    const stats = yield* getIndexStats();
    return {
      status: "ok",
      totalBookmarks: stats.total,
      indexedVectors: stats.indexedVectors,
      prunedCount: stats.pruned,
      embeddingModel: embedder.model,
      embeddingDims: embedder.dimensions,
    };
  });
