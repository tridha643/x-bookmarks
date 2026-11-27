import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import { TEST_DIMS, makeFakeCapture, makeFakeHydrator, makeHydrated, makeTestHarness } from "../test/fakes.ts";
import type { HttpApiHandlers } from "./adapters/http/server.ts";
import { decodeAppEnv } from "./domain/env.ts";
import { Embedder } from "./ports/embedder.ts";
import {
  buildEmbedderLayer,
  buildSearchFilters,
  dispatchCommand,
  parseCliArgs,
  runCronCommand,
  runDaemonCommand,
  start,
} from "./main.ts";

describe("main CLI", () => {
  it("parses positional args, key-value flags, boolean flags, bare -- separator, and search filters", () => {
    const cli = parseCliArgs(["--", "query", "terms", "--mode", "hybrid", "--limit", "15", "--full", "--no-embed"]);
    expect(cli.pos).toEqual(["query", "terms"]);
    expect(cli.values.get("mode")).toBe("hybrid");
    expect(cli.values.get("limit")).toBe("15");
    expect(cli.booleans.has("full")).toBe(true);
    expect(cli.booleans.has("no-embed")).toBe(true);
    expect(buildSearchFilters(cli)).toBeUndefined();

    const filtered = parseCliArgs(["--author", "alice", "--domain", "orama.com", "--folder", "ai", "--tag", "effect"]);
    expect(buildSearchFilters(filtered)).toEqual({
      author: "alice",
      domain: "orama.com",
      folder: "ai",
      tag: "effect",
    });
  });

  it("selects Ollama or OpenAI embedder layer based on AppEnv", async () => {
    const ollamaEnv = decodeAppEnv({}, "/srv");
    const ollama = await Effect.runPromise(Effect.provide(Embedder, buildEmbedderLayer(ollamaEnv)));
    expect(ollama.model).toBe("nomic-embed-text");
    expect(ollama.dimensions).toBe(768);

    const openaiEnv = decodeAppEnv(
      {
        XBM_EMBED_PROVIDER: "openai",
        XBM_OPENAI_API_KEY: "sk-1",
        XBM_EMBED_MODEL: "text-embedding-3-small",
        XBM_EMBED_DIMS: "1536",
      },
      "/srv",
    );
    const openai = await Effect.runPromise(Effect.provide(Embedder, buildEmbedderLayer(openaiEnv)));
    expect(openai.model).toBe("text-embedding-3-small");
    expect(openai.dimensions).toBe(1536);

    // OpenAI provider without API key falls back to Ollama
    const noKeyEnv = decodeAppEnv({ XBM_EMBED_PROVIDER: "openai" }, "/srv");
    const fallback = await Effect.runPromise(Effect.provide(Embedder, buildEmbedderLayer(noKeyEnv)));
    expect(fallback.model).toBe("nomic-embed-text");
  });

  it("dispatches cron subcommands (install, uninstall, status)", () => {
    const calls: string[] = [];
    const fns = {
      install: (opts: { every?: string; runAtLoad?: boolean; threads?: boolean }) => {
        calls.push(`install:${opts.every ?? "def"}:${String(opts.runAtLoad)}:${String(opts.threads)}`);
        return "installed";
      },
      uninstall: () => {
        calls.push("uninstall");
        return "uninstalled";
      },
      status: () => {
        calls.push("status");
        return "status";
      },
    };
    expect(runCronCommand(parseCliArgs(["install", "--every", "12h", "--run-at-load", "--no-threads"]), fns)).toBe(0);
    expect(runCronCommand(parseCliArgs(["install"]), fns)).toBe(0);
    expect(runCronCommand(parseCliArgs(["uninstall"]), fns)).toBe(0);
    expect(runCronCommand(parseCliArgs([]), fns)).toBe(0);
    expect(calls).toEqual(["install:12h:true:false", "install:def:false:true", "uninstall", "status"]);

    const daemonCalls: string[] = [];
    const daemonFns = {
      install: (opts: { host?: string; port?: number; authToken?: string | null }) => {
        daemonCalls.push(`install:${opts.host ?? ""}:${String(opts.port)}:${opts.authToken ?? "none"}`);
        return "installed";
      },
      uninstall: () => {
        daemonCalls.push("uninstall");
        return "uninstalled";
      },
      status: () => {
        daemonCalls.push("status");
        return "status";
      },
    };
    const env = decodeAppEnv({ XBM_AUTH_TOKEN: "tok" }, "/srv");
    expect(runDaemonCommand(parseCliArgs(["install", "--host", "0.0.0.0", "--port", "9000"]), env, daemonFns)).toBe(0);
    expect(runDaemonCommand(parseCliArgs(["install"]), env, daemonFns)).toBe(0);
    expect(runDaemonCommand(parseCliArgs(["uninstall"]), env, daemonFns)).toBe(0);
    expect(runDaemonCommand(parseCliArgs([]), env, daemonFns)).toBe(0);
    expect(daemonCalls).toEqual(["install:0.0.0.0:9000:tok", "install:127.0.0.1:8787:tok", "uninstall", "status"]);
  });

  it("dispatches all CLI commands through dispatchCommand", async () => {
    const h = makeTestHarness(TEST_DIMS);
    const hydrator = makeFakeHydrator(() => ({
      status: "ok",
      fields: makeHydrated(),
      error: null,
      rateLimited: false,
      retryAfterSeconds: null,
    }));
    const capture = makeFakeCapture({ captured: [], stoppedReason: "end-of-feed" });
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(h.storeLayer, h.indexLayer, h.embedder.layer, hydrator.layer, capture.layer),
    );
    const recorded: Array<[string, unknown]> = [];
    const handlers: HttpApiHandlers = {
      health: async () => ({
        status: "ok",
        totalBookmarks: 0,
        indexedVectors: 0,
        prunedCount: 0,
        embeddingModel: "nomic-embed-text",
        embeddingDims: TEST_DIMS,
      }),
      stats: async () => {
        recorded.push(["stats", null]);
        return {
          total: 0,
          articles: 0,
          threads: 0,
          pruned: 0,
          embedded: 0,
          indexedVectors: 0,
          byStatus: [],
          bySource: [],
          topAuthors: [],
          topDomains: [],
        };
      },
      search: async (req) => {
        recorded.push(["search", req]);
        return { mode: req.mode ?? "hybrid", total: 0, elapsedMs: 0, hits: [] };
      },
      list: async (q) => {
        recorded.push(["list", q]);
        return { items: [], nextCursor: null };
      },
      getById: async () => null,
      ingest: async (req) => {
        recorded.push(["ingest", req]);
        return { added: 0, existing: 0, skippedPruned: 0, skippedInvalid: 0, hydrated: 0, indexed: 0, ids: [] };
      },
      remove: async (id) => ({ id, deleted: false, tombstoned: false, removedFromIndex: false }),
      prune: async (req) => {
        recorded.push(["prune", req]);
        return { requested: req.ids.length, deletedIds: [], notFoundIds: [], tombstoned: !req.hard };
      },
      updateTags: async (id, req) => {
        recorded.push(["updateTags", { id, req }]);
        return { id, tags: req.tags };
      },
      deleteTag: async (id, tag) => {
        recorded.push(["deleteTag", { id, tag }]);
        return { id, tags: [] };
      },
      sync: async (req) => {
        recorded.push(["sync", req]);
        return {
          captured: 0,
          added: 0,
          skippedPruned: 0,
          stoppedReason: "end-of-feed",
          hydratedOk: 0,
          hydratedUnavailable: 0,
          hydratedErrors: 0,
          embedded: 0,
          indexed: 0,
        };
      },
      reindex: async (req) => {
        recorded.push(["reindex", req]);
        return { reparsed: 0, embedded: 0, indexed: 0 };
      },
    };
    const env = decodeAppEnv({}, "/srv");

    try {
      expect(await dispatchCommand("unknown", { cli: parseCliArgs([]), env, runtime, handlers })).toBeNull();
      expect(await dispatchCommand("sync", { cli: parseCliArgs([]), env, runtime, handlers })).toBe(0);
      expect(
        await dispatchCommand("sync", {
          cli: parseCliArgs(["--full", "--threads", "--no-embed", "--max", "5", "--limit", "10"]),
          env,
          runtime,
          handlers,
        }),
      ).toBe(0);
      expect(await dispatchCommand("hydrate", { cli: parseCliArgs([]), env, runtime, handlers })).toBe(0);
      expect(
        await dispatchCommand("hydrate", {
          cli: parseCliArgs(["--limit", "5", "--retry-errors", "--threads", "--no-embed"]),
          env,
          runtime,
          handlers,
        }),
      ).toBe(0);
      expect(await dispatchCommand("reindex", { cli: parseCliArgs(["--no-embed"]), env, runtime, handlers })).toBe(0);
      expect(await dispatchCommand("reindex", { cli: parseCliArgs([]), env, runtime, handlers })).toBe(0);
      expect(await dispatchCommand("embed", { cli: parseCliArgs([]), env, runtime, handlers })).toBe(0);
      expect(await dispatchCommand("add", { cli: parseCliArgs(["123"]), env, runtime, handlers })).toBe(0);
      expect(
        await dispatchCommand("add", {
          cli: parseCliArgs(["123", "--folder", "AI", "--no-hydrate", "--no-embed", "--threads"]),
          env,
          runtime,
          handlers,
        }),
      ).toBe(0);
      expect(await dispatchCommand("prune", { cli: parseCliArgs(["123"]), env, runtime, handlers })).toBe(0);
      expect(
        await dispatchCommand("prune", {
          cli: parseCliArgs(["123", "--hard", "--reason", "spam"]),
          env,
          runtime,
          handlers,
        }),
      ).toBe(0);
      expect(
        await dispatchCommand("search", {
          cli: parseCliArgs(["effect", "--mode", "vector", "--limit", "3", "--author", "alice"]),
          env,
          runtime,
          handlers,
        }),
      ).toBe(0);
      expect(
        await dispatchCommand("search", {
          cli: parseCliArgs(["effect", "--mode", "fulltext", "--limit", "nan"]),
          env,
          runtime,
          handlers,
        }),
      ).toBe(0);
      expect(
        await dispatchCommand("search", {
          cli: parseCliArgs(["effect", "--mode", "hybrid"]),
          env,
          runtime,
          handlers,
        }),
      ).toBe(0);
      expect(
        await dispatchCommand("list", {
          cli: parseCliArgs(["--by", "bookmarked", "--limit", "5"]),
          env,
          runtime,
          handlers,
        }),
      ).toBe(0);
      expect(await dispatchCommand("list", { cli: parseCliArgs(["--by", "created"]), env, runtime, handlers })).toBe(0);
      expect(
        await dispatchCommand("tag", { cli: parseCliArgs(["add", "123", "ai", "dev"]), env, runtime, handlers }),
      ).toBe(0);
      expect(await dispatchCommand("tag", { cli: parseCliArgs(["rm", "123", "ai"]), env, runtime, handlers })).toBe(0);
      expect(await dispatchCommand("tag", { cli: parseCliArgs(["rm", "123"]), env, runtime, handlers })).toBe(0);
      expect(await dispatchCommand("tag", { cli: parseCliArgs(["add", "bad"]), env, runtime, handlers })).toBe(1);
      expect(await dispatchCommand("stats", { cli: parseCliArgs([]), env, runtime, handlers })).toBe(0);

      expect(recorded.filter(([k]) => k === "sync").map(([, v]) => v)).toStrictEqual([
        { full: false, threads: false, embed: true },
        { full: true, threads: true, embed: false, maxItems: 5, hydrateLimit: 10 },
      ]);
      expect(recorded.filter(([k]) => k === "ingest").map(([, v]) => v)).toStrictEqual([
        { refs: ["123"], hydrate: true, embed: true, threads: false },
        { refs: ["123"], hydrate: false, embed: false, threads: true, folderName: "AI" },
      ]);
      expect(recorded.filter(([k]) => k === "prune").map(([, v]) => v)).toStrictEqual([
        { ids: ["123"], hard: false },
        { ids: ["123"], hard: true, reason: "spam" },
      ]);
      expect(recorded.filter(([k]) => k === "search").map(([, v]) => v)).toStrictEqual([
        { query: "effect", mode: "vector", limit: 3, filters: { author: "alice" } },
        { query: "effect", mode: "fulltext" },
        { query: "effect", mode: "hybrid" },
      ]);
      expect(recorded.filter(([k]) => k === "list").map(([, v]) => v)).toStrictEqual([
        { by: "bookmarked", limit: 5 },
        { by: "created" },
      ]);
      expect(recorded.filter(([k]) => k === "reindex").map(([, v]) => v)).toStrictEqual([
        { embedMissing: false },
        { embedMissing: true },
        { embedMissing: true },
      ]);
      expect(recorded.find(([k]) => k === "updateTags")?.[1]).toStrictEqual({
        id: "123",
        req: { tags: ["ai", "dev"] },
      });
      expect(recorded.filter(([k]) => k === "deleteTag").map(([, v]) => v)).toStrictEqual([
        { id: "123", tag: "ai" },
        { id: "123", tag: "" },
      ]);
    } finally {
      await runtime.dispose();
      h.close();
    }
  });

  it("handles start() help, daemon status, and stats against a temporary DB", async () => {
    const out: string[] = [];
    const log = (line: string) => {
      out.push(line);
    };
    expect(await start([], log)).toBe(0);
    expect(await start(["help"], log)).toBe(0);
    expect(out[0]).toContain("Commands:");
    expect(out[1]).toContain("Commands:");

    out.length = 0;
    expect(
      await start(["daemon", "status"], log, {
        install: () => "installed",
        uninstall: () => "uninstalled",
        status: () => "daemon-status-ok",
      }),
    ).toBe(0);
    expect(out[0]).toBe("daemon-status-ok");

    const dir = mkdtempSync(join(tmpdir(), "xbm-cli-test-"));
    const base = join(dir, "xbm");
    const prevDb = process.env.XBM_DB_PATH;
    const prevOrama = process.env.XBM_ORAMA_PATH;
    process.env.XBM_DB_PATH = `${base}.db`;
    process.env.XBM_ORAMA_PATH = `${base}.msp`;
    try {
      expect(await start(["stats"])).toBe(0);
      expect(await start(["list", "--by", "created", "--limit", "5"])).toBe(0);
    } finally {
      if (prevDb === undefined) delete process.env.XBM_DB_PATH;
      else process.env.XBM_DB_PATH = prevDb;
      if (prevOrama === undefined) delete process.env.XBM_ORAMA_PATH;
      else process.env.XBM_ORAMA_PATH = prevOrama;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
