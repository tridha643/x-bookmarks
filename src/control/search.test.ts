import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { TEST_DIMS, bid, deterministicVector, makeCaptured, makeHydrated, makeTestHarness } from "../../test/fakes.ts";
import { SearchIndex } from "../ports/search-index.ts";
import { BookmarkStore } from "../ports/store.ts";
import { searchBookmarks } from "./search.ts";

describe("control/search", () => {
  it("runs hybrid, fulltext, and vector search with limit/similarity clamping", async () => {
    const h = makeTestHarness();
    const layer = Layer.mergeAll(h.storeLayer, h.indexLayer, h.embedder.layer);

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* BookmarkStore;
          const index = yield* SearchIndex;
          const batch = Array.from({ length: 16 }, (_, i) =>
            makeCaptured(String(101 + i), { domText: `Common topic item ${i}` }),
          );
          yield* store.upsertCapturedBatch(batch);
          yield* store.saveHydrated({
            id: bid("101"),
            status: "ok",
            fields: makeHydrated({
              authorHandle: "alice",
              articleTitle: "Effect Architecture",
              text: "Building Effect v4 services with Orama hybrid search",
            }),
            errorMessage: null,
            retryAfterSeconds: null,
          });
          for (const doc of yield* store.listAllIndexable()) {
            yield* index.upsert({
              bookmark: doc,
              vector: doc.id === "101" ? [1, 0, 0, 0] : deterministicVector(doc.embeddingText),
            });
          }

          // Ghost index entry absent from SQLite is skipped
          yield* store.upsertCapturedBatch([makeCaptured("198", { domText: "Ghost only entry" })]);
          const ghostDoc = yield* store.getIndexableById(bid("198"));
          if (ghostDoc !== null) yield* index.upsert({ bookmark: ghostDoc, vector: [1, 0, 0, 0] });
          yield* store.prune(bid("198"), { hard: true, reason: null });

          const defaultLimit = yield* searchBookmarks({ query: "Common topic", mode: "fulltext" });
          expect(defaultLimit.hits.length).toBe(10);
          expect(defaultLimit.elapsedMs).toBeGreaterThanOrEqual(0);
          expect(defaultLimit.elapsedMs).toBeLessThan(60_000);
          expect((yield* searchBookmarks({ query: "Ghost only entry", mode: "fulltext" })).hits).toEqual([]);

          const hybrid = yield* searchBookmarks({ query: "Effect Orama", limit: 100, similarity: 0.0 });
          expect(hybrid.mode).toBe("hybrid");
          expect(hybrid.hits[0]?.bookmark.id).toBe("101");

          const beforeCalls = h.embedder.queryCalls.length;
          const ft = yield* searchBookmarks({ query: "Orama", mode: "fulltext", limit: 0 });
          expect(ft.mode).toBe("fulltext");
          expect(ft.hits.length).toBe(1);
          expect(h.embedder.queryCalls.length).toBe(beforeCalls);

          const emptyRes = yield* searchBookmarks({ query: "   ", limit: Number.NaN, similarity: Number.NaN });
          expect(emptyRes.mode).toBe("fulltext");
          expect(emptyRes.hits.length).toBe(10);

          expect(
            (yield* searchBookmarks({ query: "Effect Orama", mode: "vector", similarity: 2.0, limit: 5 })).hits.length,
          ).toBe(0);
          expect(
            (yield* searchBookmarks({ query: "Effect Orama", mode: "vector", similarity: -1, limit: 5 })).hits.length,
          ).toBeGreaterThan(0);
          expect((yield* searchBookmarks({ query: "Effect Orama", mode: "vector", limit: 50 })).mode).toBe("vector");
        }).pipe(Effect.provide(layer)),
      );
    } finally {
      h.close();
    }
  });

  it("builds exact snippets across article, text, domText, empty, and 220-char boundaries", async () => {
    const h = makeTestHarness();
    const layer = Layer.mergeAll(h.storeLayer, h.indexLayer, h.embedder.layer);

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* BookmarkStore;
          const index = yield* SearchIndex;
          const exact220 = "a".repeat(220);

          yield* store.upsertCapturedBatch([
            makeCaptured("201", { domText: null }),
            makeCaptured("202", { domText: null }),
            makeCaptured("203", { domText: null }),
            makeCaptured("204", { domText: null }),
            makeCaptured("205", { domText: "DOM snippet fallback" }),
            makeCaptured("206", { domText: null }),
          ]);

          yield* store.saveHydrated({
            id: bid("201"),
            status: "ok",
            fields: makeHydrated({ articleTitle: "Art", text: "Alpha text" }),
            errorMessage: null,
            retryAfterSeconds: null,
          });
          yield* store.saveHydrated({
            id: bid("202"),
            status: "ok",
            fields: makeHydrated({ text: null, articleTitle: null, articleText: "Only article body" }),
            errorMessage: null,
            retryAfterSeconds: null,
          });
          yield* store.saveHydrated({
            id: bid("203"),
            status: "ok",
            fields: makeHydrated({ text: exact220, articleTitle: null }),
            errorMessage: null,
            retryAfterSeconds: null,
          });
          yield* store.saveHydrated({
            id: bid("204"),
            status: "ok",
            fields: makeHydrated({ text: "b".repeat(221), articleTitle: null }),
            errorMessage: null,
            retryAfterSeconds: null,
          });
          yield* store.saveHydrated({
            id: bid("206"),
            status: "ok",
            fields: makeHydrated({ authorHandle: "emptyuser", text: null, articleTitle: null, articleText: null }),
            errorMessage: null,
            retryAfterSeconds: null,
          });

          for (const doc of yield* store.listAllIndexable()) {
            yield* index.upsert({ bookmark: doc, vector: deterministicVector(doc.embeddingText) });
          }

          h.db.prepare("UPDATE bookmarks SET text = NULL, article_text = NULL WHERE id = '205'").run();

          expect((yield* searchBookmarks({ query: "Alpha text", mode: "fulltext" })).hits[0]?.snippet).toBe(
            "[Article] Art — Alpha text",
          );
          expect((yield* searchBookmarks({ query: "Only article body", mode: "fulltext" })).hits[0]?.snippet).toBe(
            "Only article body",
          );
          expect((yield* searchBookmarks({ query: exact220, mode: "fulltext" })).hits[0]?.snippet).toBe(exact220);
          expect((yield* searchBookmarks({ query: "b".repeat(221), mode: "fulltext" })).hits[0]?.snippet).toBe(
            `${"b".repeat(220)}...`,
          );
          expect((yield* searchBookmarks({ query: "DOM snippet fallback", mode: "fulltext" })).hits[0]?.snippet).toBe(
            "DOM snippet fallback",
          );
          expect((yield* searchBookmarks({ query: "emptyuser", mode: "fulltext" })).hits[0]?.snippet).toBe("");
        }).pipe(Effect.provide(layer)),
      );
    } finally {
      h.close();
    }
  });

  it("degrades hybrid search to fulltext when embedder fails, while vector mode fails explicitly", async () => {
    const h = makeTestHarness(TEST_DIMS);
    h.embedder.failNext = true;
    const layer = Layer.mergeAll(h.storeLayer, h.indexLayer, h.embedder.layer);

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* BookmarkStore;
          const index = yield* SearchIndex;
          yield* store.upsertCapturedBatch([makeCaptured("301", { domText: "Resilient hybrid fallback" })]);
          const doc = yield* store.getIndexableById(bid("301"));
          if (doc !== null) yield* index.upsert({ bookmark: doc, vector: [0, 0, 0, 0] });

          const degraded = yield* searchBookmarks({ query: "Resilient" });
          expect(degraded.mode).toBe("fulltext");
          expect(degraded.hits.map((x) => x.bookmark.id)).toEqual(["301"]);

          const vectorFailure = yield* Effect.flip(searchBookmarks({ query: "Resilient", mode: "vector" }));
          expect(vectorFailure._tag).toBe("EmbedderError");
        }).pipe(Effect.provide(layer)),
      );
    } finally {
      h.close();
    }
  });
});
