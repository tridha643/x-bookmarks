import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { TEST_DIMS, bid, deterministicVector, makeCaptured, makeTestHarness } from "../../test/fakes.ts";
import { SearchIndex } from "../ports/search-index.ts";
import { BookmarkStore } from "../ports/store.ts";
import {
  deleteBookmark,
  deleteTag,
  getBookmark,
  getHealth,
  getIndexStats,
  listBookmarks,
  pruneBookmarks,
  updateTags,
} from "./manage.ts";

describe("control/manage", () => {
  it("gets, lists, tags (updating Orama vectors & tags), soft/hard deletes, batch-prunes, and persists only on change", async () => {
    const h = makeTestHarness(TEST_DIMS);
    const layer = Layer.mergeAll(h.storeLayer, h.indexLayer, h.embedder.layer);

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* BookmarkStore;
          const index = yield* SearchIndex;
          yield* store.upsertCapturedBatch([makeCaptured("301"), makeCaptured("302"), makeCaptured("303")]);
          // 301 has valid cached embedding; 302 has wrong-dims cached embedding -> falls back to zero vector
          yield* store.saveEmbedding(bid("301"), {
            model: "nomic-embed-text",
            dims: TEST_DIMS,
            contentHash: "abc",
            vector: [1, 0, 0, 0],
          });
          yield* store.saveEmbedding(bid("302"), {
            model: "nomic-embed-text",
            dims: TEST_DIMS + 2,
            contentHash: "abc",
            vector: [1, 0, 0, 0, 0, 0],
          });

          for (const id of [bid("301"), bid("302"), bid("303")]) {
            const doc = yield* store.getIndexableById(id);
            if (doc !== null) yield* index.upsert({ bookmark: doc, vector: deterministicVector(id) });
          }

          expect((yield* getBookmark(bid("301")))?.id).toBe("301");
          expect(yield* getBookmark(bid("999"))).toBeNull();
          expect((yield* listBookmarks({ limit: 2 })).items.length).toBe(2);

          // updateTags updates SQLite AND Orama index (with cached vector for 301, zero vector for 302)
          const p0 = h.getPersistCount();
          expect(yield* updateTags(bid("301"), ["  AI Agents ", "!!!", "Effect"])).toEqual({
            id: "301",
            tags: ["ai-agents", "effect"],
          });
          expect(h.getPersistCount()).toBe(p0 + 1);
          const vec301 = yield* index.search({
            term: "",
            mode: "vector",
            vector: [1, 0, 0, 0],
            filters: { tag: "ai-agents" },
            limit: 5,
            similarity: 0.99,
          });
          expect(vec301.hits.map((x) => x.id)).toEqual(["301"]);

          expect(yield* updateTags(bid("302"), ["notes"])).toEqual({ id: "302", tags: ["notes"] });
          expect(yield* updateTags(bid("303"), ["uncached"])).toEqual({ id: "303", tags: ["uncached"] });
          expect(yield* updateTags(bid("999"), ["missing"])).toBeNull();

          expect(yield* deleteTag(bid("301"), "AI Agents")).toEqual({ id: "301", tags: ["effect"] });
          expect(yield* deleteTag(bid("301"), "!!!")).toEqual({ id: "301", tags: ["effect"] });
          expect(yield* deleteTag(bid("999"), "effect")).toBeNull();

          // Soft deleteBookmark -> persists because removedFromIndex = true
          const pBeforeDel = h.getPersistCount();
          expect(yield* deleteBookmark(bid("301"), { hard: false, reason: "outdated" })).toEqual({
            id: "301",
            deleted: true,
            tombstoned: true,
            removedFromIndex: true,
          });
          expect(h.getPersistCount()).toBe(pBeforeDel + 1);

          // Deleting already-deleted id does NOT persist
          const pAfterDel = h.getPersistCount();
          expect(yield* deleteBookmark(bid("301"), { hard: false, reason: null })).toEqual({
            id: "301",
            deleted: false,
            tombstoned: false,
            removedFromIndex: false,
          });
          expect(h.getPersistCount()).toBe(pAfterDel);

          // Batch pruneBookmarks with ONLY invalid/missing ids does NOT persist
          const pBeforeNoopPrune = h.getPersistCount();
          expect(yield* pruneBookmarks({ ids: ["not-an-id", "888"] })).toEqual({
            requested: 2,
            deletedIds: [],
            notFoundIds: ["not-an-id", "888"],
            tombstoned: true,
          });
          expect(h.getPersistCount()).toBe(pBeforeNoopPrune);

          // Batch pruneBookmarks with existing 302 and explicit reason -> persists & stores reason
          expect(yield* pruneBookmarks({ ids: ["302", "888", "not-an-id"], reason: "batch-reason" })).toEqual({
            requested: 3,
            deletedIds: ["302"],
            notFoundIds: ["888", "not-an-id"],
            tombstoned: true,
          });
          expect(h.getPersistCount()).toBe(pBeforeNoopPrune + 1);
          const row302 = h.db.prepare("SELECT reason FROM pruned_bookmarks WHERE id = '302'").get() as {
            reason: string | null;
          };
          expect(row302.reason).toBe("batch-reason");

          // Hard pruneBookmarks on 303
          expect(yield* pruneBookmarks({ ids: ["303"], hard: true, reason: "ignored" })).toEqual({
            requested: 1,
            deletedIds: ["303"],
            notFoundIds: [],
            tombstoned: false,
          });

          const stats = yield* getIndexStats();
          expect(stats.total).toBe(0);
          expect(stats.indexedVectors).toBe(0);
          expect(stats.pruned).toBe(2);

          expect(yield* getHealth()).toEqual({
            status: "ok",
            totalBookmarks: 0,
            indexedVectors: 0,
            prunedCount: 2,
            embeddingModel: "nomic-embed-text",
            embeddingDims: TEST_DIMS,
          });
        }).pipe(Effect.provide(layer)),
      );
    } finally {
      h.close();
    }
  });
});
