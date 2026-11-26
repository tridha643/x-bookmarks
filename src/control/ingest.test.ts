import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  TEST_DIMS,
  bid,
  makeCaptured,
  makeFakeCapture,
  makeFakeHydrator,
  makeHydrated,
  makeTestHarness,
} from "../../test/fakes.ts";
import { emptyHydratedFields } from "../domain/bookmark.ts";
import { BookmarkStore } from "../ports/store.ts";
import { hydratePending, ingestBookmarks, reindexAll, syncBookmarks } from "./ingest.ts";
import { deleteBookmark } from "./manage.ts";

describe("control/ingest", () => {
  it("ingests refs with folder slugging, captureSource, default threads=false, skips invalid/pruned, and persists only on index", async () => {
    const h = makeTestHarness(TEST_DIMS);
    const hydrator = makeFakeHydrator((id) => ({
      status: "ok",
      fields: makeHydrated({
        url: `https://x.com/alice/status/${id}`,
        text: `Hydrated content for ${id}`,
        rawJson: JSON.stringify({ code: 200, status: { id, text: `Reparsed content for ${id}` } }),
      }),
      error: null,
      rateLimited: false,
      retryAfterSeconds: null,
    }));
    const layer = Layer.mergeAll(h.storeLayer, h.indexLayer, h.embedder.layer, hydrator.layer);

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* BookmarkStore;
          yield* store.upsertCapturedBatch([makeCaptured("402")]);
          yield* deleteBookmark(bid("402"), { hard: false, reason: "no-thanks" });

          // Ingesting ONLY invalid/pruned refs does NOT persist
          const p0 = h.getPersistCount();
          const noop = yield* ingestBookmarks({ refs: ["bad-ref", "402"] });
          expect(noop.indexed).toBe(0);
          expect(h.getPersistCount()).toBe(p0);

          const res = yield* ingestBookmarks({
            refs: ["https://x.com/alice/status/401", "402", "not-valid-ref"],
            folderName: "  Reading   List  ",
          });
          expect(res).toEqual({
            added: 1,
            existing: 0,
            skippedPruned: 1,
            skippedInvalid: 1,
            hydrated: 1,
            indexed: 1,
            ids: ["401", "402"],
          });
          expect(h.getPersistCount()).toBe(p0 + 1);
          expect(hydrator.calls[0]?.fetchThreadIfHint).toBe(false);
          const d401 = yield* store.getById(bid("401"));
          expect(d401?.captureSource).toBe("api-ingest");
          expect(d401?.folders).toEqual([{ folderId: "reading-list", folderName: "Reading   List" }]);
          expect(h.embedder.docCalls.length).toBe(1);

          // Re-ingesting 401 reuses cached embedding and does not re-hydrate
          const res2 = yield* ingestBookmarks({ refs: ["401"], hydrate: true, embed: true });
          expect(res2.existing).toBe(1);
          expect(res2.hydrated).toBe(0);
          expect(res2.indexed).toBe(1);
          expect(h.embedder.docCalls.length).toBe(1);

          // Ingesting with hydrate:false and embed:false indexes with zero vector
          const res3 = yield* ingestBookmarks({ refs: ["403"], hydrate: false, embed: false });
          expect(res3.added).toBe(1);
          expect(res3.hydrated).toBe(0);
          expect(res3.indexed).toBe(1);
          expect(h.embedder.docCalls.length).toBe(1);

          // Add a row with corrupt raw_fx_json so reindex skips unparseable raw JSON
          h.db.prepare("UPDATE bookmarks SET raw_fx_json = '{bad' WHERE id = '403'").run();

          // Reindex with omitted embedMissing (defaults to true) reparses 401 and embeds
          const re = yield* reindexAll({});
          expect(re.reparsed).toBe(1);
          expect(re.indexed).toBe(2);
          expect(re.embedded).toBe(1);

          const beforeEmbeds = h.embedder.docCalls.length;
          const reNoEmbed = yield* reindexAll({ embedMissing: false });
          expect(reNoEmbed.embedded).toBe(0);
          expect(h.embedder.docCalls.length).toBe(beforeEmbeds);
        }).pipe(Effect.provide(layer)),
      );
    } finally {
      h.close();
    }
  });

  it("handles hydration circuit breaker (only rateLimited errors count toward 5) and syncBookmarks defaults", async () => {
    const h = makeTestHarness(TEST_DIMS);
    const ids = ["501", "502", "503", "504", "505", "506", "507", "508", "509"];
    const hydrator = makeFakeHydrator((id) => {
      if (id === "501") {
        return {
          status: "ok",
          fields: makeHydrated({ text: "Good 501" }),
          error: null,
          rateLimited: false,
          retryAfterSeconds: null,
        };
      }
      if (id === "502") {
        return {
          status: "unavailable",
          fields: emptyHydratedFields("{}"),
          error: "404",
          rateLimited: false,
          retryAfterSeconds: null,
        };
      }
      // 503 is a non-rate-limited error: should NOT increment consecutiveRateErrors
      if (id === "503") {
        return {
          status: "error",
          fields: emptyHydratedFields(null),
          error: "FxTwitter code 418",
          rateLimited: false,
          retryAfterSeconds: null,
        };
      }
      // 504..508 are 5 consecutive rate-limited errors -> trip breaker after 508, leaving 509 untouched!
      return {
        status: "error",
        fields: emptyHydratedFields(null),
        error: "HTTP 429",
        rateLimited: true,
        retryAfterSeconds: 60,
      };
    });
    const capture = makeFakeCapture({
      captured: ids.map((id) => makeCaptured(id)),
      stoppedReason: "end-of-feed",
    });
    const layer = Layer.mergeAll(h.storeLayer, h.indexLayer, h.embedder.layer, hydrator.layer, capture.layer);

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          // Seed an existing error row with past next_retry_at so syncBookmarks default includeErrors:true is tested
          const store = yield* BookmarkStore;
          yield* store.upsertCapturedBatch([makeCaptured("500")]);
          h.db
            .prepare(
              "UPDATE bookmarks SET hydration_status = 'error', next_retry_at = '2000-01-01T00:00:00.000Z' WHERE id = '500'",
            )
            .run();

          // Call syncBookmarks with empty request to verify all defaults (full:false, threads:true, embed:true, includeErrors:true)
          const report = yield* syncBookmarks({});
          expect(capture.calls[0]).toEqual({ full: false, maxItems: undefined });
          expect(report.captured).toBe(9);
          expect(report.added).toBe(9);
          expect(report.stoppedReason).toBe("end-of-feed");
          // Order: 501 (ok), 502 (unavail), 503 (err, non-rl), 504..508 (5 rl errs -> trip!). 509 and 500 not reached yet.
          expect(report.hydratedOk).toBe(1);
          expect(report.hydratedUnavailable).toBe(1);
          expect(report.hydratedErrors).toBe(6);
          expect(report.embedded).toBe(8);
          expect(report.indexed).toBe(8);
          expect(hydrator.calls.every((c) => c.fetchThreadIfHint)).toBe(true);

          // Drain 509 (pending) and 500 (error with past next_retry_at)
          const drain = yield* hydratePending({ limit: 10, includeErrors: true, fetchThreads: false, embed: true });
          expect(drain.errors).toBe(2);
          expect(drain.indexed).toBe(2);

          // Empty pending does NOT call persist
          const pBeforeEmpty = h.getPersistCount();
          const trulyNone = yield* hydratePending({
            limit: 10,
            includeErrors: false,
            fetchThreads: false,
            embed: true,
          });
          expect(trulyNone).toEqual({ ok: 0, unavailable: 0, errors: 0, embedded: 0, indexed: 0 });
          expect(h.getPersistCount()).toBe(pBeforeEmpty);

          // Test hydratePending with embed:false returns embedded:0 and syncBookmarks({}) retries past-due errors
          yield* store.upsertCapturedBatch([makeCaptured("601")]);
          const pBeforeNoEmbed = h.getPersistCount();
          const noEmb = yield* hydratePending({ limit: 10, includeErrors: false, fetchThreads: false, embed: false });
          expect(noEmb.embedded).toBe(0);
          expect(noEmb.indexed).toBe(1);
          expect(h.getPersistCount()).toBe(pBeforeNoEmbed + 1);

          h.db
            .prepare(
              "UPDATE bookmarks SET hydration_status = 'error', next_retry_at = '2000-01-01T00:00:00.000Z' WHERE id = '601'",
            )
            .run();
          const emptyCap = makeFakeCapture({ captured: [], stoppedReason: "reached-known-bookmarks" });
          const retryRep = yield* syncBookmarks({}).pipe(Effect.provide(emptyCap.layer));
          expect(retryRep.hydratedErrors).toBe(1);
          expect(retryRep.indexed).toBe(1);
        }).pipe(Effect.provide(layer)),
      );
    } finally {
      h.close();
    }
  });
});
