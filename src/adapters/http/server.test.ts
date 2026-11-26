import type { AddressInfo } from "node:net";
import { Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TEST_DIMS,
  makeFakeCapture,
  makeFakeHydrator,
  makeHydrated,
  makeTestHarness,
  type TestHarness,
} from "../../../test/fakes.ts";
import { ingestBookmarks, reindexAll, syncBookmarks } from "../../control/ingest.ts";
import {
  deleteBookmark,
  deleteTag,
  getBookmark,
  getHealth,
  getIndexStats,
  listBookmarks,
  pruneBookmarks,
  updateTags,
} from "../../control/manage.ts";
import { searchBookmarks } from "../../control/search.ts";
import { createHttpServer, type HttpApiHandlers } from "./server.ts";

describe("adapters/http/server", () => {
  let harness: TestHarness;
  let baseUrl = "";
  let closeServer: () => Promise<void>;

  beforeAll(async () => {
    harness = makeTestHarness(TEST_DIMS);
    const hydrator = makeFakeHydrator((id) => ({
      status: "ok",
      fields: makeHydrated({
        url: `https://x.com/alice/status/${id}`,
        text: `HTTP API test bookmark ${id} about Effect and Orama`,
        rawJson: JSON.stringify({ code: 200, status: { id, text: `HTTP API test bookmark ${id}` } }),
      }),
      error: null,
      rateLimited: false,
      retryAfterSeconds: null,
    }));
    const capture = makeFakeCapture({ captured: [], stoppedReason: "reached-known-bookmarks" });
    const appLayer = Layer.mergeAll(
      harness.storeLayer,
      harness.indexLayer,
      harness.embedder.layer,
      hydrator.layer,
      capture.layer,
    );
    const runtime = ManagedRuntime.make(appLayer);

    const handlers: HttpApiHandlers = {
      health: () => runtime.runPromise(getHealth()),
      stats: () => runtime.runPromise(getIndexStats()),
      search: (req) => runtime.runPromise(searchBookmarks(req)),
      list: (query) => runtime.runPromise(listBookmarks(query)),
      getById: (id) => runtime.runPromise(getBookmark(id)),
      ingest: (req) => runtime.runPromise(ingestBookmarks(req)),
      remove: (id, opts) => runtime.runPromise(deleteBookmark(id, opts)),
      prune: (req) => runtime.runPromise(pruneBookmarks(req)),
      updateTags: (id, req) => runtime.runPromise(updateTags(id, req.tags)),
      deleteTag: (id, tag) => runtime.runPromise(deleteTag(id, tag)),
      sync: (req) => runtime.runPromise(syncBookmarks(req)),
      reindex: (req) => runtime.runPromise(reindexAll(req)),
    };

    const server = createHttpServer(handlers);
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    closeServer = async () => {
      await new Promise<void>((res) => server.close(() => res()));
      await runtime.dispose();
      harness.close();
    };
  });

  afterAll(async () => {
    await closeServer();
  });

  const reqJson = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${baseUrl}${path}`, init);
    const body = (await res.json()) as Record<string, unknown>;
    return { status: res.status, body };
  };

  it("serves health, openapi, stats, ingest, list, get, search, tags, delete, prune, sync, reindex, and errors", async () => {
    // Health & OpenAPI (including trailing slash normalization and Content-Type header)
    const healthRaw = await fetch(`${baseUrl}/health/`);
    expect(healthRaw.status).toBe(200);
    expect(healthRaw.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const healthBody = (await healthRaw.json()) as Record<string, unknown>;
    expect(healthBody.status).toBe("ok");

    const openapi = await reqJson("/v1/openapi.json");
    expect(openapi.status).toBe(200);
    expect(openapi.body.openapi).toBe("3.1.0");

    // Ingest 3 bookmarks
    const ing = await reqJson("/v1/bookmarks", {
      method: "POST",
      body: JSON.stringify({
        refs: ["https://x.com/alice/status/801", "802", "803"],
        folderName: "API Tests",
      }),
    });
    expect(ing.status).toBe(201);
    expect(ing.body.added).toBe(3);

    // Get by id (found, missing, invalid)
    expect((await reqJson("/v1/bookmarks/801")).status).toBe(200);
    expect(await reqJson("/v1/bookmarks/99999")).toEqual({
      status: 404,
      body: { error: { code: "not_found", message: "bookmark not found" } },
    });
    expect(await reqJson("/v1/bookmarks/not-a-number")).toEqual({
      status: 400,
      body: { error: { code: "bad_request", message: "invalid bookmark id" } },
    });

    // List with all query params (by, author, domain, folder, tag, limit, cursor) & invalid query
    const listed = await reqJson("/v1/bookmarks?by=bookmarked&author=alice&limit=2");
    expect(listed.status).toBe(200);
    expect((listed.body.items as unknown[]).length).toBe(2);
    expect((await reqJson("/v1/bookmarks?author=nobody")).body.items).toEqual([]);
    expect((await reqJson("/v1/bookmarks?domain=nonexistent.dev")).body.items).toEqual([]);
    expect((await reqJson("/v1/bookmarks?folder=NoSuchFolder")).body.items).toEqual([]);
    expect((await reqJson("/v1/bookmarks?cursor=1")).body.items).toEqual([]);
    const byFolder = await reqJson("/v1/bookmarks?folder=API%20Tests&cursor=999");
    expect(byFolder.status).toBe(200);
    expect((byFolder.body.items as unknown[]).length).toBe(3);
    expect(await reqJson("/v1/bookmarks?by=invalid-sort")).toEqual({
      status: 400,
      body: { error: { code: "bad_request", message: "invalid query parameters" } },
    });

    // Tags PUT & DELETE (including URL-decoded tag and non-matching routes/methods)
    const putTags = await reqJson("/v1/bookmarks/801/tags", {
      method: "PUT",
      body: JSON.stringify({ tags: ["AI Agents", "Effect"] }),
    });
    expect(putTags.status).toBe(200);
    expect(putTags.body.tags).toEqual(["ai-agents", "effect"]);
    expect((await reqJson("/v1/bookmarks?tag=effect")).body.items).toHaveLength(1);
    expect(await reqJson("/v1/bookmarks/bad-id/tags", { method: "PUT", body: '{"tags":["a"]}' })).toEqual({
      status: 400,
      body: { error: { code: "bad_request", message: "invalid bookmark id" } },
    });
    expect(await reqJson("/v1/bookmarks/801/tags", { method: "PUT", body: '{"tags":"not-array"}' })).toEqual({
      status: 400,
      body: { error: { code: "bad_request", message: "request body failed schema validation" } },
    });
    expect(await reqJson("/v1/bookmarks/99999/tags", { method: "PUT", body: '{"tags":["a"]}' })).toEqual({
      status: 404,
      body: { error: { code: "not_found", message: "bookmark not found" } },
    });
    expect((await reqJson("/v1/bookmarks/801/tags", { method: "GET" })).status).toBe(404);
    expect((await reqJson("/prefix/v1/bookmarks/801/tags", { method: "PUT", body: '{"tags":["a"]}' })).status).toBe(
      404,
    );
    expect((await reqJson("/v1/bookmarks/801/tags/extra", { method: "PUT", body: '{"tags":["a"]}' })).status).toBe(404);
    expect((await reqJson("/prefix/v1/bookmarks/801/tags/effect", { method: "DELETE" })).status).toBe(404);
    expect((await reqJson("/v1/bookmarks/801/tags/extra/more", { method: "DELETE" })).status).toBe(404);

    const delTag = await reqJson("/v1/bookmarks/801/tags/ai%20agents", { method: "DELETE" });
    expect(delTag.status).toBe(200);
    expect(delTag.body.tags).toEqual(["effect"]);
    expect((await reqJson("/v1/bookmarks/801/tags/effect", { method: "POST" })).status).toBe(404);
    expect(await reqJson("/v1/bookmarks/bad-id/tags/effect", { method: "DELETE" })).toEqual({
      status: 400,
      body: { error: { code: "bad_request", message: "invalid bookmark id" } },
    });
    expect(await reqJson("/v1/bookmarks/99999/tags/effect", { method: "DELETE" })).toEqual({
      status: 404,
      body: { error: { code: "not_found", message: "bookmark not found" } },
    });

    // Search
    const searched = await reqJson("/v1/search", {
      method: "POST",
      body: JSON.stringify({ query: "Effect Orama", mode: "hybrid", limit: 5 }),
    });
    expect(searched.status).toBe(200);
    expect((searched.body.hits as unknown[]).length).toBeGreaterThan(0);

    // DELETE single bookmark (soft tombstone) + verify reason persisted
    const delOne = await reqJson("/v1/bookmarks/801?reason=cleanup", { method: "DELETE" });
    expect(delOne.status).toBe(200);
    expect(delOne.body).toEqual({ id: "801", deleted: true, tombstoned: true, removedFromIndex: true });
    const prunedRow = harness.db.prepare("SELECT reason FROM pruned_bookmarks WHERE id = '801'").get() as {
      reason: string | null;
    };
    expect(prunedRow.reason).toBe("cleanup");
    expect(await reqJson("/v1/bookmarks/801", { method: "DELETE" })).toEqual({
      status: 404,
      body: { error: { code: "not_found", message: "bookmark not found" } },
    });

    // DELETE single bookmark with ?hard=true
    const delHard = await reqJson("/v1/bookmarks/802?hard=true", { method: "DELETE" });
    expect(delHard.status).toBe(200);
    expect(delHard.body).toEqual({ id: "802", deleted: true, tombstoned: false, removedFromIndex: true });

    // Batch POST /v1/bookmarks/prune
    const pruned = await reqJson("/v1/bookmarks/prune", {
      method: "POST",
      body: JSON.stringify({ ids: ["803", "9999"], reason: "batch" }),
    });
    expect(pruned.status).toBe(200);
    expect(pruned.body).toEqual({ requested: 2, deletedIds: ["803"], notFoundIds: ["9999"], tombstoned: true });

    // Sync, Reindex, Stats (also tests empty POST body defaulting to {})
    expect((await reqJson("/v1/sync", { method: "POST" })).status).toBe(200);
    expect((await reqJson("/v1/reindex", { method: "POST", body: "{}" })).status).toBe(200);
    expect((await reqJson("/v1/stats")).status).toBe(200);

    // Invalid JSON, invalid schema across POST routes, unknown route, wrong method on single bookmark
    expect(await reqJson("/v1/search", { method: "POST", body: "{bad-json" })).toEqual({
      status: 400,
      body: { error: { code: "bad_request", message: "invalid JSON request body" } },
    });
    expect(await reqJson("/v1/search", { method: "POST", body: JSON.stringify({ mode: "bogus" }) })).toEqual({
      status: 400,
      body: { error: { code: "bad_request", message: "request body failed schema validation" } },
    });
    expect((await reqJson("/v1/bookmarks", { method: "POST", body: JSON.stringify({ refs: "bad" }) })).status).toBe(
      400,
    );
    expect(
      (await reqJson("/v1/bookmarks/prune", { method: "POST", body: JSON.stringify({ ids: "bad" }) })).status,
    ).toBe(400);
    expect((await reqJson("/v1/sync", { method: "POST", body: JSON.stringify({ full: "bad" }) })).status).toBe(400);
    expect(
      (await reqJson("/v1/reindex", { method: "POST", body: JSON.stringify({ embedMissing: "bad" }) })).status,
    ).toBe(400);
    expect((await reqJson("/v1/unknown-route")).status).toBe(404);
    expect((await reqJson("/prefix/v1/bookmarks/801")).status).toBe(404);
    expect((await reqJson("/v1/bookmarks/801", { method: "PATCH" })).status).toBe(404);
  });

  it("maps unhandled handler rejections to 500 internal error envelope", async () => {
    const failingServer = createHttpServer({
      health: async () => {
        throw new Error("boom-db");
      },
      stats: async () => {
        throw "string-err";
      },
      search: async () => ({ mode: "fulltext", total: 0, elapsedMs: 0, hits: [] }),
      list: async () => ({ items: [], nextCursor: null }),
      getById: async () => null,
      ingest: async () => ({
        added: 0,
        existing: 0,
        skippedPruned: 0,
        skippedInvalid: 0,
        hydrated: 0,
        indexed: 0,
        ids: [],
      }),
      remove: async (id) => ({ id, deleted: false, tombstoned: false, removedFromIndex: false }),
      prune: async () => ({ requested: 0, deletedIds: [], notFoundIds: [], tombstoned: true }),
      updateTags: async () => null,
      deleteTag: async () => null,
      sync: async () => ({
        captured: 0,
        added: 0,
        skippedPruned: 0,
        stoppedReason: "end-of-feed",
        hydratedOk: 0,
        hydratedUnavailable: 0,
        hydratedErrors: 0,
        embedded: 0,
        indexed: 0,
      }),
      reindex: async () => ({ reparsed: 0, embedded: 0, indexed: 0 }),
    });
    await new Promise<void>((res) => failingServer.listen(0, "127.0.0.1", () => res()));
    const addr = failingServer.address() as AddressInfo;
    try {
      const r1 = await fetch(`http://127.0.0.1:${addr.port}/health`);
      expect(r1.status).toBe(500);
      expect(await r1.json()).toEqual({ error: { code: "internal", message: "boom-db" } });

      const r2 = await fetch(`http://127.0.0.1:${addr.port}/v1/stats`);
      expect(r2.status).toBe(500);
      expect(await r2.json()).toEqual({ error: { code: "internal", message: "string-err" } });
    } finally {
      await new Promise<void>((res) => failingServer.close(() => res()));
    }
  });
});
