import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  IngestBookmarksRequest,
  ListBookmarksQuery,
  PruneBookmarksRequest,
  ReindexRequest,
  SearchRequest,
  SyncRequest,
  UpdateTagsRequest,
  apiError,
  httpStatusForError,
  openApiDocument,
} from "./api.ts";

describe("domain/api", () => {
  it("builds standard error envelopes and maps all HTTP status codes", () => {
    expect(apiError("bad_request", "oops")).toEqual({ error: { code: "bad_request", message: "oops" } });
    expect(httpStatusForError("bad_request")).toBe(400);
    expect(httpStatusForError("not_found")).toBe(404);
    expect(httpStatusForError("conflict")).toBe(409);
    expect(httpStatusForError("unavailable")).toBe(503);
    expect(httpStatusForError("internal")).toBe(500);
  });

  it("exposes OpenAPI 3.1 contract with all v1 endpoints including delete and prune", () => {
    const doc = openApiDocument();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info).toEqual({ title: "x-bookmarks API", version: "1.0.0" });
    expect(Object.keys(doc.paths)).toEqual([
      "/health",
      "/v1/openapi.json",
      "/v1/stats",
      "/v1/search",
      "/v1/bookmarks",
      "/v1/bookmarks/prune",
      "/v1/bookmarks/{id}",
      "/v1/bookmarks/{id}/tags",
      "/v1/bookmarks/{id}/tags/{tag}",
      "/v1/sync",
      "/v1/reindex",
    ]);
    expect(doc.paths["/v1/bookmarks/{id}"]?.delete?.summary).toContain("Delete");
    expect(doc.paths["/v1/bookmarks/prune"]?.post?.summary).toContain("prune");
    for (const methods of Object.values(doc.paths)) {
      for (const op of Object.values(methods)) {
        expect(op.summary.length).toBeGreaterThan(5);
      }
    }
  });

  it("validates request schemas", () => {
    expect(Schema.decodeUnknownSync(SearchRequest)({ query: "orama", mode: "hybrid", limit: 5 })).toEqual({
      query: "orama",
      mode: "hybrid",
      limit: 5,
    });
    expect(Schema.decodeUnknownSync(SearchRequest)({ query: "orama", mode: "fulltext" }).mode).toBe("fulltext");
    expect(Schema.decodeUnknownSync(SearchRequest)({ query: "orama", mode: "vector" }).mode).toBe("vector");
    expect(Schema.decodeUnknownSync(ListBookmarksQuery)({ by: "created", limit: 10 })).toEqual({
      by: "created",
      limit: 10,
    });
    expect(Schema.decodeUnknownSync(IngestBookmarksRequest)({ refs: ["123"], hydrate: false })).toEqual({
      refs: ["123"],
      hydrate: false,
    });
    expect(Schema.decodeUnknownSync(PruneBookmarksRequest)({ ids: ["123"], hard: true, reason: "spam" })).toEqual({
      ids: ["123"],
      hard: true,
      reason: "spam",
    });
    expect(Schema.decodeUnknownSync(UpdateTagsRequest)({ tags: ["ai"] })).toEqual({ tags: ["ai"] });
    expect(Schema.decodeUnknownSync(SyncRequest)({ full: true, threads: true })).toEqual({
      full: true,
      threads: true,
    });
    expect(Schema.decodeUnknownSync(ReindexRequest)({ embedMissing: false })).toEqual({ embedMissing: false });
  });
});
