import { DatabaseSync } from "node:sqlite";
import { create } from "@orama/orama";
import { Effect, Layer, Schema } from "effect";
import { makeOramaSearchIndex } from "../src/adapters/orama/index.ts";
import { makeSqliteBookmarkStore, openSqliteDatabase } from "../src/adapters/sqlite/store.ts";
import { BookmarkId, emptyHydratedFields, type CapturedBookmark, type HydratedFields } from "../src/domain/bookmark.ts";
import { CaptureSource, type CaptureResult, type CaptureSourceShape } from "../src/ports/capture.ts";
import { Embedder, EmbedderError, type EmbedderShape } from "../src/ports/embedder.ts";
import { Hydrator, type HydrateResult, type HydratorShape } from "../src/ports/hydrator.ts";
import { SearchIndex } from "../src/ports/search-index.ts";
import { BookmarkStore } from "../src/ports/store.ts";

export const TEST_DIMS = 4;

export const bid = (raw: string): BookmarkId => Schema.decodeSync(BookmarkId)(raw);

export const makeCaptured = (id: string, overrides: Partial<Omit<CapturedBookmark, "id">> = {}): CapturedBookmark => ({
  id: bid(id),
  url: `https://x.com/alice/status/${id}`,
  authorHandle: "alice",
  authorName: "Alice",
  createdAt: "2026-01-15T10:00:00.000Z",
  domText: `Captured tweet ${id}`,
  captureSource: "playwright-dom",
  folderId: null,
  folderName: null,
  ...overrides,
});

export const makeHydrated = (overrides: Partial<HydratedFields> = {}): HydratedFields => ({
  ...emptyHydratedFields(null),
  url: "https://x.com/alice/status/100",
  authorHandle: "alice",
  authorName: "Alice",
  createdAt: "2026-01-15T10:00:00.000Z",
  createdTimestamp: 1_768_471_200,
  text: "Full hydrated tweet text about Effect and Orama vector search",
  hydrationSource: "fxtwitter",
  ...overrides,
});

export const deterministicVector = (text: string, dims: number = TEST_DIMS): ReadonlyArray<number> => {
  const vec = Array.from({ length: dims }, () => 0);
  const lower = text.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    vec[i % dims] = (vec[i % dims] ?? 0) + (lower.charCodeAt(i) % 31) / 31;
  }
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
};

export interface FakeEmbedderController {
  readonly layer: Layer.Layer<Embedder>;
  readonly docCalls: string[];
  readonly queryCalls: string[];
  failNext: boolean;
}

const makeFakeEmbedder = (
  opts: { readonly dims?: number; readonly model?: string; readonly failAll?: boolean } = {},
): FakeEmbedderController => {
  const dims = opts.dims ?? TEST_DIMS;
  const model = opts.model ?? "nomic-embed-text";
  const docCalls: string[] = [];
  const queryCalls: string[] = [];
  const state = { failNext: opts.failAll ?? false };

  const shape: EmbedderShape = {
    model,
    dimensions: dims,
    embedDocument: (text) => {
      docCalls.push(text);
      if (state.failNext) return Effect.fail(new EmbedderError({ reason: "network", detail: "offline" }));
      return Effect.succeed(deterministicVector(text, dims));
    },
    embedQuery: (query) => {
      queryCalls.push(query);
      if (state.failNext) return Effect.fail(new EmbedderError({ reason: "network", detail: "offline" }));
      return Effect.succeed(deterministicVector(query, dims));
    },
  };

  return {
    layer: Layer.succeed(Embedder, shape),
    docCalls,
    queryCalls,
    get failNext() {
      return state.failNext;
    },
    set failNext(v: boolean) {
      state.failNext = v;
    },
  };
};

export const makeFakeHydrator = (
  responder: (id: BookmarkId, fetchThreadIfHint: boolean) => HydrateResult,
): { readonly layer: Layer.Layer<Hydrator>; readonly calls: Array<{ id: BookmarkId; fetchThreadIfHint: boolean }> } => {
  const calls: Array<{ id: BookmarkId; fetchThreadIfHint: boolean }> = [];
  const shape: HydratorShape = {
    hydrate: (id, { fetchThreadIfHint }) => {
      calls.push({ id, fetchThreadIfHint });
      return Effect.succeed(responder(id, fetchThreadIfHint));
    },
  };
  return { layer: Layer.succeed(Hydrator, shape), calls };
};

export const makeFakeCapture = (
  result: CaptureResult,
): {
  readonly layer: Layer.Layer<CaptureSource>;
  readonly lastKnownIds: Set<string>;
  readonly calls: Array<{ readonly full: boolean; readonly maxItems: number | undefined }>;
} => {
  const lastKnownIds = new Set<string>();
  const calls: Array<{ readonly full: boolean; readonly maxItems: number | undefined }> = [];
  const shape: CaptureSourceShape = {
    capture: (opts) => {
      lastKnownIds.clear();
      for (const id of opts.knownIds) lastKnownIds.add(id);
      calls.push({ full: opts.full, maxItems: opts.maxItems });
      return Effect.succeed(result);
    },
  };
  return { layer: Layer.succeed(CaptureSource, shape), lastKnownIds, calls };
};

export const makeMemoryOramaDb = (dims: number = TEST_DIMS) =>
  create({
    schema: {
      id: "string",
      url: "string",
      bookmarkSeq: "number",
      authorHandle: "string",
      authorName: "string",
      createdTimestamp: "number",
      text: "string",
      articleTitle: "string",
      articleText: "string",
      quoteText: "string",
      cardText: "string",
      extraText: "string",
      domains: "string[]",
      tags: "string[]",
      folders: "string[]",
      hasArticle: "boolean",
      embedding: `vector[${dims}]`,
    } as const,
  });

export interface TestHarness {
  readonly db: DatabaseSync;
  readonly storeLayer: Layer.Layer<BookmarkStore>;
  readonly indexLayer: Layer.Layer<SearchIndex>;
  readonly embedder: FakeEmbedderController;
  readonly getPersistCount: () => number;
  readonly close: () => void;
}

export const makeTestHarness = (dims: number = TEST_DIMS): TestHarness => {
  const db = openSqliteDatabase(":memory:");
  const storeLayer = Layer.succeed(BookmarkStore, makeSqliteBookmarkStore(db));
  const rawIndex = makeOramaSearchIndex(makeMemoryOramaDb(dims), dims, null);
  let persistCount = 0;
  const indexLayer = Layer.succeed(SearchIndex, {
    ...rawIndex,
    persist: () => {
      persistCount++;
      return rawIndex.persist();
    },
  });
  const embedder = makeFakeEmbedder({ dims });
  return { db, storeLayer, indexLayer, embedder, getPersistCount: () => persistCount, close: () => db.close() };
};

export const makeJsonResponse = (body: unknown, status: number = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
