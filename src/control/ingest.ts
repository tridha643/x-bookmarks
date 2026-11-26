import { Effect } from "effect";
import type {
  IngestBookmarksRequest,
  IngestBookmarksResponse,
  ReindexReport,
  ReindexRequest,
  SyncReport,
  SyncRequest,
} from "../domain/api.ts";
import { parseFxPayloadFromJson } from "../domain/article.ts";
import {
  normalizeNonEmpty,
  parseTweetRef,
  type BookmarkId,
  type CapturedBookmark,
  type IndexableBookmark,
} from "../domain/bookmark.ts";
import { CaptureSource, type CaptureError } from "../ports/capture.ts";
import { Embedder, type EmbedderError } from "../ports/embedder.ts";
import { Hydrator, type HydrateResult } from "../ports/hydrator.ts";
import { SearchIndex, type SearchDocumentInput, type SearchIndexError } from "../ports/search-index.ts";
import { BookmarkStore, type StoreError } from "../ports/store.ts";

const zeroVector = (dims: number): ReadonlyArray<number> => Array.from({ length: dims }, () => 0);

const resolveBookmarkVector = (
  doc: IndexableBookmark,
  computeMissing: boolean,
): Effect.Effect<
  { readonly vector: ReadonlyArray<number>; readonly computed: boolean },
  StoreError | EmbedderError,
  BookmarkStore | Embedder
> =>
  Effect.gen(function* () {
    const store = yield* BookmarkStore;
    const embedder = yield* Embedder;
    const cached = yield* store.getEmbedding(doc.id, embedder.model);
    if (cached !== null && cached.contentHash === doc.contentHash && cached.dims === embedder.dimensions) {
      return { vector: cached.vector, computed: false };
    }
    if (!computeMissing || doc.embeddingText.trim().length === 0) {
      return { vector: zeroVector(embedder.dimensions), computed: false };
    }
    const vector = yield* embedder.embedDocument(doc.embeddingText);
    yield* store.saveEmbedding(doc.id, {
      model: embedder.model,
      dims: embedder.dimensions,
      contentHash: doc.contentHash,
      vector,
    });
    return { vector, computed: true };
  });

const embedAndIndexOne = (
  id: BookmarkId,
  computeMissing: boolean,
): Effect.Effect<
  { readonly embedded: boolean; readonly indexed: boolean },
  StoreError | SearchIndexError | EmbedderError,
  BookmarkStore | SearchIndex | Embedder
> =>
  Effect.gen(function* () {
    const store = yield* BookmarkStore;
    const index = yield* SearchIndex;
    const doc = yield* store.getIndexableById(id);
    if (doc === null) return { embedded: false, indexed: false };
    const { vector, computed } = yield* resolveBookmarkVector(doc, computeMissing);
    yield* index.upsert({ bookmark: doc, vector });
    return { embedded: computed, indexed: true };
  });

interface HydrateCounters {
  ok: number;
  unavailable: number;
  errors: number;
  consecutiveRateErrors: number;
}

const recordHydrateOutcome = (counters: HydrateCounters, res: HydrateResult): boolean => {
  if (res.status === "ok") {
    counters.ok++;
    counters.consecutiveRateErrors = 0;
    return false;
  }
  if (res.status === "unavailable") {
    counters.unavailable++;
    counters.consecutiveRateErrors = 0;
    return false;
  }
  counters.errors++;
  if (res.rateLimited) counters.consecutiveRateErrors++;
  return counters.consecutiveRateErrors === 5;
};

export interface HydrateBatchSummary {
  readonly ok: number;
  readonly unavailable: number;
  readonly errors: number;
  readonly embedded: number;
  readonly indexed: number;
}

export const hydratePending = (opts: {
  readonly limit: number;
  readonly includeErrors: boolean;
  readonly fetchThreads: boolean;
  readonly embed: boolean;
}): Effect.Effect<
  HydrateBatchSummary,
  StoreError | SearchIndexError | EmbedderError,
  BookmarkStore | Hydrator | SearchIndex | Embedder
> =>
  Effect.gen(function* () {
    const store = yield* BookmarkStore;
    const hydrator = yield* Hydrator;
    const index = yield* SearchIndex;
    const pending = yield* store.getPendingHydration(opts.limit, opts.includeErrors);

    const counters: HydrateCounters = { ok: 0, unavailable: 0, errors: 0, consecutiveRateErrors: 0 };
    let embedded = 0;
    let indexed = 0;

    for (const item of pending) {
      const res = yield* hydrator.hydrate(item.id, { fetchThreadIfHint: opts.fetchThreads });
      yield* store.saveHydrated({
        id: item.id,
        status: res.status,
        fields: res.fields,
        errorMessage: res.error,
        retryAfterSeconds: res.retryAfterSeconds,
      });
      const tripped = recordHydrateOutcome(counters, res);
      const idxRes = yield* embedAndIndexOne(item.id, opts.embed);
      if (idxRes.embedded) embedded++;
      if (idxRes.indexed) indexed++;
      if (tripped) break;
    }

    if (indexed !== 0) yield* index.persist();
    return { ok: counters.ok, unavailable: counters.unavailable, errors: counters.errors, embedded, indexed };
  });

interface ParsedIngestBatch {
  readonly batch: ReadonlyArray<CapturedBookmark>;
  readonly skippedInvalid: number;
}

const buildIngestBatch = (refs: ReadonlyArray<string>, folderNameRaw: string | undefined): ParsedIngestBatch => {
  const folderName = normalizeNonEmpty(folderNameRaw);
  const folderId = folderName === null ? null : folderName.toLowerCase().replace(/\s+/g, "-");
  const batch: CapturedBookmark[] = [];
  let skippedInvalid = 0;
  for (const raw of refs) {
    const parsed = parseTweetRef(raw);
    if (parsed === null) {
      skippedInvalid++;
      continue;
    }
    batch.push({
      id: parsed.id,
      url: parsed.url,
      authorHandle: parsed.authorHandle,
      authorName: null,
      createdAt: null,
      domText: null,
      captureSource: "api-ingest",
      folderId,
      folderName,
    });
  }
  return { batch, skippedInvalid };
};

const hydrateAndIndexIngestedItem = (
  id: BookmarkId,
  opts: { readonly doHydrate: boolean; readonly doEmbed: boolean; readonly doThreads: boolean },
): Effect.Effect<
  { readonly hydrated: boolean; readonly indexed: boolean },
  StoreError | SearchIndexError | EmbedderError,
  BookmarkStore | Hydrator | SearchIndex | Embedder
> =>
  Effect.gen(function* () {
    const store = yield* BookmarkStore;
    const hydrator = yield* Hydrator;
    const detail = yield* store.getById(id);
    if (detail === null) return { hydrated: false, indexed: false };

    let hydrated = false;
    if (opts.doHydrate && detail.hydrationStatus !== "ok") {
      const res = yield* hydrator.hydrate(id, { fetchThreadIfHint: opts.doThreads });
      yield* store.saveHydrated({
        id,
        status: res.status,
        fields: res.fields,
        errorMessage: res.error,
        retryAfterSeconds: res.retryAfterSeconds,
      });
      hydrated = res.status === "ok";
    }
    const idxRes = yield* embedAndIndexOne(id, opts.doEmbed);
    return { hydrated, indexed: idxRes.indexed };
  });

export const ingestBookmarks = (
  req: IngestBookmarksRequest,
): Effect.Effect<
  IngestBookmarksResponse,
  StoreError | SearchIndexError | EmbedderError,
  BookmarkStore | Hydrator | SearchIndex | Embedder
> =>
  Effect.gen(function* () {
    const store = yield* BookmarkStore;
    const index = yield* SearchIndex;
    const { batch, skippedInvalid } = buildIngestBatch(req.refs, req.folderName);
    const upsertRes = yield* store.upsertCapturedBatch(batch);

    const itemOpts = {
      doHydrate: req.hydrate ?? true,
      doEmbed: req.embed ?? true,
      doThreads: req.threads ?? false,
    };

    let hydrated = 0;
    let indexed = 0;
    for (const item of batch) {
      const outcome = yield* hydrateAndIndexIngestedItem(item.id, itemOpts);
      if (outcome.hydrated) hydrated++;
      if (outcome.indexed) indexed++;
    }

    if (indexed !== 0) yield* index.persist();
    return {
      added: upsertRes.added,
      existing: upsertRes.existing,
      skippedPruned: upsertRes.skippedPruned,
      skippedInvalid,
      hydrated,
      indexed,
      ids: batch.map((b) => b.id),
    };
  });

export const syncBookmarks = (
  req: SyncRequest,
): Effect.Effect<
  SyncReport,
  CaptureError | StoreError | SearchIndexError | EmbedderError,
  CaptureSource | BookmarkStore | Hydrator | SearchIndex | Embedder
> =>
  Effect.gen(function* () {
    const captureSource = yield* CaptureSource;
    const store = yield* BookmarkStore;
    const knownIds = yield* store.getKnownAndPrunedIds();
    const captureRes = yield* captureSource.capture({
      knownIds,
      full: req.full ?? false,
      maxItems: req.maxItems,
    });
    const upsertRes = yield* store.upsertCapturedBatch(captureRes.captured);
    const hyd = yield* hydratePending({
      limit: req.hydrateLimit ?? 200,
      includeErrors: true,
      fetchThreads: req.threads ?? true,
      embed: req.embed ?? true,
    });

    return {
      captured: captureRes.captured.length,
      added: upsertRes.added,
      skippedPruned: upsertRes.skippedPruned,
      stoppedReason: captureRes.stoppedReason,
      hydratedOk: hyd.ok,
      hydratedUnavailable: hyd.unavailable,
      hydratedErrors: hyd.errors,
      embedded: hyd.embedded,
      indexed: hyd.indexed,
    };
  });

export const reindexAll = (
  req: ReindexRequest,
): Effect.Effect<
  ReindexReport,
  StoreError | SearchIndexError | EmbedderError,
  BookmarkStore | SearchIndex | Embedder
> =>
  Effect.gen(function* () {
    const store = yield* BookmarkStore;
    const index = yield* SearchIndex;
    const embedMissing = req.embedMissing ?? true;

    const rawRows = yield* store.listRawPayloads();
    let reparsed = 0;
    for (const row of rawRows) {
      const fields = parseFxPayloadFromJson(row.rawJson);
      if (fields === null) continue;
      yield* store.saveHydrated({ id: row.id, status: "ok", fields, errorMessage: null, retryAfterSeconds: null });
      reparsed++;
    }

    const allDocs = yield* store.listAllIndexable();
    const searchDocs: SearchDocumentInput[] = [];
    let embedded = 0;
    for (const doc of allDocs) {
      const { vector, computed } = yield* resolveBookmarkVector(doc, embedMissing);
      if (computed) embedded++;
      searchDocs.push({ bookmark: doc, vector });
    }

    const indexed = yield* index.rebuild(searchDocs);
    yield* index.persist();
    return { reparsed, embedded, indexed };
  });
