import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { TEST_DIMS, bid, makeMemoryOramaDb } from "../../../test/fakes.ts";
import type { IndexableBookmark } from "../../domain/bookmark.ts";
import { SearchIndex } from "../../ports/search-index.ts";
import { OramaSearchIndexLive, makeOramaSearchIndex } from "./index.ts";

const makeDoc = (id: string, overrides: Partial<IndexableBookmark> = {}): IndexableBookmark => ({
  id: bid(id),
  url: `https://x.com/alice/status/${id}`,
  bookmarkSeq: Number(id),
  authorHandle: "Alice",
  authorName: "Alice Dev",
  createdTimestamp: 1_700_000_000,
  text: "Effect TypeScript architecture with Orama vector index",
  articleTitle: "Effect + Orama",
  articleText: "Deep guide to hybrid BM25 and cosine similarity",
  quoteText: "Local search is fast",
  cardText: "Orama Docs",
  extraText: "github.com/orama/orama",
  domains: ["orama.com"],
  tags: ["effect", "search"],
  folders: ["ai"],
  hasArticle: true,
  contentHash: `hash-${id}`,
  embeddingText: "Effect TypeScript architecture with Orama vector index",
  ...overrides,
});

describe("adapters/orama/index", () => {
  it("supports upsert, fulltext, vector, hybrid, all facet filters, remove, rebuild, and count", async () => {
    const idx = makeOramaSearchIndex(makeMemoryOramaDb(TEST_DIMS), TEST_DIMS, null);

    await Effect.runPromise(idx.upsert({ bookmark: makeDoc("10"), vector: [1, 0, 0, 0] }));
    await Effect.runPromise(
      idx.upsert({
        bookmark: makeDoc("20", {
          authorHandle: "bob",
          createdTimestamp: 1_800_000_000,
          text: "SQLite WAL checkpoints and backup discipline",
          articleTitle: "",
          articleText: "",
          domains: ["sqlite.org"],
          tags: ["db"],
          folders: ["infra"],
          hasArticle: false,
        }),
        vector: [0, 1, 0, 0],
      }),
    );

    expect(await Effect.runPromise(idx.count())).toBe(2);

    // Fulltext search with author, domain, tag, folder, hasArticle, and timestamp range filters
    const ft = await Effect.runPromise(
      idx.search({
        term: "Orama",
        mode: "fulltext",
        vector: null,
        filters: {
          author: "@Alice",
          domain: "www.orama.com",
          folder: "ai",
          tag: "EFFECT",
          hasArticle: true,
          sinceTimestamp: 1_600_000_000,
          untilTimestamp: 1_750_000_000,
        },
        limit: 10,
        similarity: 0.4,
      }),
    );
    expect(ft.hits.map((h) => h.id)).toEqual(["10"]);

    // Timestamp since-only and until-only filters
    const sinceOnly = await Effect.runPromise(
      idx.search({
        term: "",
        mode: "fulltext",
        vector: null,
        filters: { sinceTimestamp: 1_750_000_000 },
        limit: 10,
        similarity: 0.4,
      }),
    );
    expect(sinceOnly.hits.map((h) => h.id)).toEqual(["20"]);

    const untilOnly = await Effect.runPromise(
      idx.search({
        term: "",
        mode: "fulltext",
        vector: null,
        filters: { untilTimestamp: 1_750_000_000 },
        limit: 10,
        similarity: 0.4,
      }),
    );
    expect(untilOnly.hits.map((h) => h.id)).toEqual(["10"]);

    // Empty filters object should behave like unfiltered
    const emptyFilter = await Effect.runPromise(
      idx.search({ term: "SQLite", mode: "fulltext", vector: null, filters: {}, limit: 10, similarity: 0.4 }),
    );
    expect(emptyFilter.hits.map((h) => h.id)).toEqual(["20"]);

    // Author with mid-string @ and domain with mid-string www. are NOT stripped mid-string
    const midAt = await Effect.runPromise(
      idx.search({
        term: "",
        mode: "fulltext",
        vector: null,
        filters: { author: "a@lice" },
        limit: 10,
        similarity: 0.4,
      }),
    );
    expect(midAt.hits).toEqual([]);
    await Effect.runPromise(
      idx.upsert({ bookmark: makeDoc("25", { domains: ["sub.www.example.dev"] }), vector: [0, 0, 1, 0] }),
    );
    const exactMidWww = await Effect.runPromise(
      idx.search({
        term: "",
        mode: "fulltext",
        vector: null,
        filters: { domain: "sub.www.example.dev" },
        limit: 10,
        similarity: 0.4,
      }),
    );
    expect(exactMidWww.hits.map((h) => h.id)).toEqual(["25"]);
    await Effect.runPromise(idx.remove(bid("25")));

    // Hybrid with empty term or null vector falls back to fulltext; vector with null vector falls back to fulltext
    const hybEmptyTerm = await Effect.runPromise(
      idx.search({ term: "", mode: "hybrid", vector: [1, 0, 0, 0], filters: undefined, limit: 5, similarity: 0.99 }),
    );
    expect(hybEmptyTerm.hits.length).toBe(2);

    const hybNullVec = await Effect.runPromise(
      idx.search({ term: "cosine", mode: "hybrid", vector: null, filters: undefined, limit: 5, similarity: 0.99 }),
    );
    expect(hybNullVec.hits.map((h) => h.id)).toEqual(["10"]);

    const vecNull = await Effect.runPromise(
      idx.search({ term: "SQLite", mode: "vector", vector: null, filters: undefined, limit: 5, similarity: 0.99 }),
    );
    expect(vecNull.hits.map((h) => h.id)).toEqual(["20"]);

    // Vector search
    const vec = await Effect.runPromise(
      idx.search({ term: "", mode: "vector", vector: [1, 0, 0, 0], filters: undefined, limit: 5, similarity: 0.8 }),
    );
    expect(vec.hits.map((h) => h.id)).toEqual(["10"]);

    // Hybrid search
    const hyb = await Effect.runPromise(
      idx.search({
        term: "SQLite",
        mode: "hybrid",
        vector: [0, 1, 0, 0],
        filters: undefined,
        limit: 5,
        similarity: 0.5,
      }),
    );
    expect(hyb.hits[0]?.id).toBe("20");

    // Re-upsert replaces existing doc cleanly
    await Effect.runPromise(
      idx.upsert({ bookmark: makeDoc("10", { text: "Updated Orama text" }), vector: [1, 0, 0, 0] }),
    );
    expect(await Effect.runPromise(idx.count())).toBe(2);

    // Remove existing & missing
    expect(await Effect.runPromise(idx.remove(bid("10")))).toBe(true);
    expect(await Effect.runPromise(idx.remove(bid("999")))).toBe(false);
    expect(await Effect.runPromise(idx.count())).toBe(1);

    // Rebuild replaces all docs (and supports empty rebuild)
    expect(await Effect.runPromise(idx.rebuild([{ bookmark: makeDoc("30"), vector: [0, 0, 1, 0] }]))).toBe(1);
    expect(await Effect.runPromise(idx.count())).toBe(1);
    expect(await Effect.runPromise(idx.rebuild([]))).toBe(0);
    expect(await Effect.runPromise(idx.count())).toBe(0);

    // Null snapshot persist is a no-op
    await Effect.runPromise(idx.persist());
  });

  it("persists and restores snapshots via OramaSearchIndexLive and recovers from corrupt snapshots", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xbm-orama-test-"));
    const snap = join(dir, "nested", "deep", "index.msp");
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const idx = yield* SearchIndex;
          yield* idx.upsert({ bookmark: makeDoc("42"), vector: [1, 0, 0, 0] });
          yield* idx.persist();
        }).pipe(Effect.provide(OramaSearchIndexLive(snap, TEST_DIMS))),
      );

      const restoredCount = await Effect.runPromise(
        Effect.gen(function* () {
          const idx = yield* SearchIndex;
          return yield* idx.count();
        }).pipe(Effect.provide(OramaSearchIndexLive(snap, TEST_DIMS))),
      );
      expect(restoredCount).toBe(1);

      // Corrupt file falls back cleanly to a fresh empty index
      writeFileSync(snap, "corrupted-binary-payload", "utf8");
      const freshCount = await Effect.runPromise(
        Effect.gen(function* () {
          const idx = yield* SearchIndex;
          return yield* idx.count();
        }).pipe(Effect.provide(OramaSearchIndexLive(snap, TEST_DIMS))),
      );
      expect(freshCount).toBe(0);

      // In-memory live layer (snapshotPath = null) starts clean
      const memCount = await Effect.runPromise(
        Effect.gen(function* () {
          const idx = yield* SearchIndex;
          return yield* idx.count();
        }).pipe(Effect.provide(OramaSearchIndexLive(null, TEST_DIMS))),
      );
      expect(memCount).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
