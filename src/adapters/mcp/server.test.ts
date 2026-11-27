import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { bid } from "../../../test/fakes.ts";
import type { BookmarkDetail, IndexStats } from "../../domain/bookmark.ts";
import {
  MCP_PROTOCOL_VERSION,
  handleMcpMessage,
  handleMcpPayload,
  runStdioMcpServer,
  type McpHandlers,
} from "./server.ts";

const sampleDetail: BookmarkDetail = {
  id: bid("12345"),
  url: "https://x.com/alice/status/12345",
  bookmarkSeq: 1,
  authorHandle: "alice",
  authorName: "Alice",
  createdAt: "2026-01-15T10:00:00Z",
  createdTimestamp: 1_768_471_200,
  capturedAt: "2026-01-15T10:05:00Z",
  text: "Main tweet text",
  articleTitle: "Deep Dive",
  articleText: "Full article markdown",
  domains: ["effect.website"],
  tags: ["effect"],
  folders: [],
  hydrationStatus: "ok",
  hydrationSource: "fxtwitter",
  replyingToHandle: null,
  captureSource: "playwright-dom",
  domText: null,
  quoteAuthor: "bob",
  quoteText: "Quoted text",
  cardTitle: null,
  cardDescription: null,
  cardUrl: null,
  communityNote: null,
  extraText: null,
  urls: ["https://effect.website", "https://orama.com"],
  likes: 10,
  reposts: 2,
  replies: 1,
  bookmarksCount: 5,
  views: 100,
  lang: "en",
  hydratedAt: "2026-01-15T10:06:00Z",
  threadPosts: [
    { postId: "12345", position: 0, authorHandle: "alice", createdAt: null, text: "First" },
    { postId: "12346", position: 1, authorHandle: "alice", createdAt: null, text: "Second" },
  ],
};

const minimalDetail: BookmarkDetail = {
  ...sampleDetail,
  id: bid("12346"),
  authorHandle: null,
  articleTitle: null,
  articleText: "Untitled article body",
  quoteAuthor: null,
  quoteText: "Anon quote",
  urls: [],
  threadPosts: [],
};

const titleOnlyDetail: BookmarkDetail = {
  ...sampleDetail,
  id: bid("12347"),
  articleTitle: "Title Only",
  articleText: null,
  quoteText: null,
  urls: [],
  threadPosts: [{ postId: "12347", position: 0, authorHandle: "alice", createdAt: null, text: "Single" }],
};

const noArticleDetail: BookmarkDetail = {
  ...sampleDetail,
  id: bid("12348"),
  articleTitle: null,
  articleText: null,
  quoteText: null,
  urls: [],
  threadPosts: [],
};

const sampleStats: IndexStats = {
  total: 1,
  articles: 1,
  threads: 1,
  pruned: 0,
  embedded: 1,
  indexedVectors: 1,
  byStatus: [{ key: "ok", count: 1 }],
  bySource: [{ key: "fxtwitter", count: 1 }],
  topAuthors: [{ key: "alice", count: 1 }],
  topDomains: [{ key: "effect.website", count: 1 }],
};

const makeHandlers = (calls: Array<[string, Record<string, unknown>]> = []): McpHandlers => ({
  health: async () => ({
    status: "ok",
    totalBookmarks: 1,
    indexedVectors: 1,
    prunedCount: 0,
    embeddingModel: "nomic-embed-text",
    embeddingDims: 768,
  }),
  stats: async () => sampleStats,
  search: async (req) => {
    calls.push(["search", req as Record<string, unknown>]);
    return { mode: req.mode ?? "hybrid", total: 0, elapsedMs: 1, hits: [] };
  },
  getById: async (id) => {
    if (id === "12345") return sampleDetail;
    if (id === "12346") return minimalDetail;
    if (id === "12347") return titleOnlyDetail;
    if (id === "12348") return noArticleDetail;
    if (id === "12349") throw "string-failure";
    return null;
  },
  list: async (q) => {
    calls.push(["list", q as Record<string, unknown>]);
    return { items: [], nextCursor: null };
  },
  ingest: async (req) => {
    calls.push(["ingest", req as Record<string, unknown>]);
    return {
      added: req.refs.length,
      existing: 0,
      skippedPruned: 0,
      skippedInvalid: 0,
      hydrated: 1,
      indexed: 1,
      ids: [bid("12345")],
    };
  },
  remove: async (id, opts) => {
    calls.push(["remove", { id, ...opts }]);
    return { id, deleted: id === "12345", tombstoned: !opts.hard, removedFromIndex: id === "12345" };
  },
  prune: async (req) => {
    calls.push(["prune", req as Record<string, unknown>]);
    return { requested: req.ids.length, deletedIds: [bid("12345")], notFoundIds: [], tombstoned: !req.hard };
  },
  updateTags: async (id, req) => {
    calls.push(["updateTags", { id, tags: req.tags }]);
    return id === "12345" ? { id, tags: req.tags } : null;
  },
  deleteTag: async (id, tag) => {
    calls.push(["deleteTag", { id, tag }]);
    return id === "12345" ? { id, tags: [] } : null;
  },
  sync: async (req) => {
    calls.push(["sync", req as Record<string, unknown>]);
    return {
      captured: 2,
      added: 1,
      skippedPruned: 0,
      stoppedReason: "reached-known-bookmarks",
      hydratedOk: 1,
      hydratedUnavailable: 0,
      hydratedErrors: 0,
      embedded: 1,
      indexed: 1,
    };
  },
  reindex: async (req) => {
    calls.push(["reindex", req as Record<string, unknown>]);
    return { reparsed: 1, embedded: 1, indexed: 1 };
  },
});

const callTool = async (
  h: McpHandlers,
  name: string,
  args?: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> => {
  const resp = await handleMcpPayload(
    {
      id: 1,
      method: "tools/call",
      params: { name, ...(args !== undefined ? { arguments: args } : {}) },
    },
    h,
  );
  expect(resp).not.toBeNull();
  expect((resp as Record<string, unknown>).jsonrpc).toBe("2.0");
  const result = (resp as Record<string, unknown>).result as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  expect(result.content[0]?.type).toBe("text");
  return { isError: result.isError ?? false, text: result.content[0]?.text ?? "" };
};

describe("adapters/mcp/server", () => {
  it("handles protocol handshake, version negotiation, ping, notifications, and tools/list", async () => {
    const h = makeHandlers();
    expect(await handleMcpMessage("{bad", h)).toBeNull();
    expect(await handleMcpMessage(JSON.stringify({ nope: 1 }), h)).toBeNull();
    expect(await handleMcpPayload({ method: "notifications/initialized" }, h)).toBeNull();
    expect(await handleMcpPayload({ id: 99, method: "notifications/initialized" }, h)).toBeNull();
    expect(await handleMcpPayload({ method: "unknown/notification" }, h)).toBeNull();

    const initModern = await handleMcpPayload(
      { id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION } },
      h,
    );
    expect(initModern).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "x-bookmarks", version: "1.0.0" },
      },
    });

    const initLegacy = await handleMcpPayload(
      { id: 2, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      h,
    );
    expect((initLegacy as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2024-11-05");

    const initDefault = await handleMcpPayload({ id: 3, method: "initialize" }, h);
    expect((initDefault as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-03-26");

    expect(await handleMcpPayload({ id: 4, method: "ping" }, h)).toEqual({
      jsonrpc: "2.0",
      id: 4,
      result: {},
    });

    const list = await handleMcpPayload({ id: 5, method: "tools/list" }, h);
    expect(list).not.toBeNull();
    expect((list as Record<string, unknown>).jsonrpc).toBe("2.0");
    const tools = ((list as Record<string, unknown>).result as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools).toEqual([
      {
        name: "search_bookmarks",
        description:
          "Search indexed X bookmarks with Orama hybrid (BM25 + nomic-embed-text vector), fulltext, or vector search.",
        annotations: { readOnlyHint: true, idempotentHint: true },
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query text" },
            mode: { type: "string", enum: ["hybrid", "fulltext", "vector"] },
            limit: { type: "number" },
            similarity: { type: "number" },
            filters: {
              type: "object",
              properties: {
                author: { type: "string" },
                domain: { type: "string" },
                folder: { type: "string" },
                tag: { type: "string" },
                hasArticle: { type: "boolean" },
                sinceTimestamp: { type: "number" },
                untilTimestamp: { type: "number" },
              },
            },
          },
          required: ["query"],
        },
      },
      {
        name: "get_bookmark",
        description: "Fetch full bookmark detail including X Article Markdown, quotes, links, tags, and thread posts.",
        annotations: { readOnlyHint: true, idempotentHint: true },
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
      {
        name: "list_bookmarks",
        description:
          "List bookmarks ordered by bookmarked recency or post creation time with optional filters and cursor.",
        annotations: { readOnlyHint: true, idempotentHint: true },
        inputSchema: {
          type: "object",
          properties: {
            by: { type: "string", enum: ["bookmarked", "created"] },
            author: { type: "string" },
            domain: { type: "string" },
            folder: { type: "string" },
            tag: { type: "string" },
            limit: { type: "number" },
            cursor: { type: "number" },
          },
        },
      },
      {
        name: "add_bookmarks",
        description:
          "Ingest bookmark tweet URLs or numeric IDs with optional FxTwitter hydration and vector embedding.",
        annotations: { readOnlyHint: false },
        inputSchema: {
          type: "object",
          properties: {
            refs: { type: "array", items: { type: "string" } },
            hydrate: { type: "boolean" },
            embed: { type: "boolean" },
            threads: { type: "boolean" },
            folderName: { type: "string" },
          },
          required: ["refs"],
        },
      },
      {
        name: "delete_bookmark",
        description:
          "Delete one bookmark from SQLite and Orama. Records a tombstone by default so future syncs skip re-importing it; set hard=true to skip tombstoning.",
        annotations: { readOnlyHint: false, destructiveHint: true },
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            hard: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["id"],
        },
      },
      {
        name: "prune_bookmarks",
        description: "Batch delete bookmarks by ID from SQLite and Orama, tombstoned by default to prevent re-sync.",
        annotations: { readOnlyHint: false, destructiveHint: true },
        inputSchema: {
          type: "object",
          properties: {
            ids: { type: "array", items: { type: "string" } },
            hard: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["ids"],
        },
      },
      {
        name: "add_tags",
        description: "Add normalized tags to a bookmark and update the Orama index.",
        annotations: { readOnlyHint: false, idempotentHint: true },
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["id", "tags"],
        },
      },
      {
        name: "remove_tag",
        description: "Remove a single tag from a bookmark and update the Orama index.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            tag: { type: "string" },
          },
          required: ["id", "tag"],
        },
      },
      {
        name: "sync_bookmarks",
        description: "Run incremental (or full) Playwright bookmark capture, hydration, embedding, and Orama upsert.",
        annotations: { readOnlyHint: false },
        inputSchema: {
          type: "object",
          properties: {
            full: { type: "boolean" },
            threads: { type: "boolean" },
            embed: { type: "boolean" },
            maxItems: { type: "number" },
            hydrateLimit: { type: "number" },
          },
        },
      },
      {
        name: "reindex_bookmarks",
        description: "Reparse archived raw JSON, embed missing vectors, and rebuild the Orama snapshot from SQLite.",
        annotations: { readOnlyHint: false, idempotentHint: true },
        inputSchema: {
          type: "object",
          properties: {
            embedMissing: { type: "boolean" },
          },
        },
      },
      {
        name: "get_stats",
        description: "Return bookmark, article, thread, pruned, author, domain, and vector index counts.",
        annotations: { readOnlyHint: true, idempotentHint: true },
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_health",
        description:
          "Return service readiness, bookmark count, indexed vector count, and embedding model configuration.",
        annotations: { readOnlyHint: true, idempotentHint: true },
        inputSchema: { type: "object", properties: {} },
      },
    ]);
  });

  it("executes read-only MCP tools and formats all bookmark detail variants", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const h = makeHandlers(calls);

    const searchRes = await callTool(h, "search_bookmarks", {
      query: "orama",
      mode: "hybrid",
      limit: 5,
      filters: { author: "alice", hasArticle: true },
    });
    expect(searchRes.isError).toBe(false);
    expect(searchRes.text).toContain('"mode": "hybrid"');

    const md = (await callTool(h, "get_bookmark", { id: "12345" })).text;
    expect(md).toBe(
      [
        "# @alice — https://x.com/alice/status/12345",
        "Main tweet text",
        "## Article: Deep Dive\n\nFull article markdown",
        "## Quoted (@bob)\n\nQuoted text",
        "## Links\n- https://effect.website\n- https://orama.com",
        "## Thread\n1. First\n\n2. Second",
      ].join("\n\n"),
    );

    const minMd = (await callTool(h, "get_bookmark", { id: "12346" })).text;
    expect(minMd).toContain("# @unknown — ");
    expect(minMd).toContain("## Article: (untitled)\n\nUntitled article body");
    expect(minMd).toContain("## Quoted (@unknown)\n\nAnon quote");
    expect(minMd).not.toContain("## Links");
    expect(minMd).not.toContain("## Thread");

    const titleOnlyMd = (await callTool(h, "get_bookmark", { id: "12347" })).text;
    expect(titleOnlyMd).toBe(
      "# @alice — https://x.com/alice/status/12345\n\nMain tweet text\n\n## Article: Title Only\n\n",
    );

    const plainMd = (await callTool(h, "get_bookmark", { id: "12348" })).text;
    expect(plainMd).toBe("# @alice — https://x.com/alice/status/12345\n\nMain tweet text");

    expect((await callTool(h, "get_bookmark", { id: "99999" })).text).toBe("Bookmark 99999 not found.");
    expect(await callTool(h, "get_bookmark", { id: "abc" })).toEqual({ isError: true, text: "Invalid bookmark id." });

    await callTool(h, "list_bookmarks", { limit: 5, by: "created", author: "alice" });
    await callTool(h, "list_bookmarks", {});
    expect(calls.filter(([k]) => k === "list").map(([, v]) => v)).toStrictEqual([
      { limit: 5, by: "created", author: "alice" },
      {},
    ]);

    expect((await callTool(h, "get_stats")).text).toContain('"total": 1');
    expect((await callTool(h, "get_health")).text).toContain('"embeddingModel": "nomic-embed-text"');
  });

  it("executes mutating v1 API MCP tools (add, delete, prune, tags, sync, reindex)", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const h = makeHandlers(calls);

    expect(
      (await callTool(h, "add_bookmarks", { refs: ["https://x.com/alice/status/12345"], folderName: "AI" })).text,
    ).toContain('"added": 1');

    expect((await callTool(h, "delete_bookmark", { id: "12345" })).text).toContain('"tombstoned": true');
    expect((await callTool(h, "delete_bookmark", { id: "12345", hard: true, reason: "dup" })).text).toContain(
      '"tombstoned": false',
    );
    expect(await callTool(h, "delete_bookmark", { id: "bad" })).toEqual({
      isError: true,
      text: "Invalid bookmark id.",
    });

    expect((await callTool(h, "prune_bookmarks", { ids: ["12345"], reason: "cleanup" })).text).toContain(
      '"requested": 1',
    );

    expect((await callTool(h, "add_tags", { id: "12345", tags: ["ai", "effect"] })).text).toContain('"ai"');
    expect((await callTool(h, "add_tags", { id: "99999", tags: ["ai"] })).text).toBe("Bookmark 99999 not found.");
    expect((await callTool(h, "add_tags", { id: "bad", tags: ["ai"] })).isError).toBe(true);

    expect((await callTool(h, "remove_tag", { id: "12345", tag: "ai" })).text).toContain('"tags": []');
    expect((await callTool(h, "remove_tag", { id: "99999", tag: "ai" })).text).toBe("Bookmark 99999 not found.");
    expect((await callTool(h, "remove_tag", { id: "bad", tag: "ai" })).isError).toBe(true);

    expect((await callTool(h, "sync_bookmarks", { full: false, threads: true })).text).toContain('"captured": 2');
    expect((await callTool(h, "reindex_bookmarks", { embedMissing: true })).text).toContain('"reparsed": 1');

    expect(calls.filter(([k]) => k === "remove").map(([, v]) => v)).toStrictEqual([
      { id: "12345", hard: false, reason: null },
      { id: "12345", hard: true, reason: "dup" },
    ]);
  });

  it("returns structured MCP/JSON-RPC errors and streams framed lines via runStdioMcpServer", async () => {
    const h = makeHandlers();

    const badParams = await handleMcpPayload({ id: 9, method: "tools/call", params: 123 }, h);
    expect(badParams).toEqual({
      jsonrpc: "2.0",
      id: 9,
      result: { isError: true, content: [{ type: "text", text: "invalid tool call" }] },
    });

    expect(await callTool(h, "nope")).toEqual({ isError: true, text: "Unknown tool: nope" });
    expect((await callTool(h, "search_bookmarks", {})).isError).toBe(true);
    expect(await callTool(h, "get_bookmark", { id: "12349" })).toEqual({ isError: true, text: "string-failure" });

    const unknownMethod = await handleMcpPayload({ id: 12, method: "resources/list" }, h);
    expect(unknownMethod).toEqual({
      jsonrpc: "2.0",
      id: 12,
      error: { code: -32601, message: "Method not found: resources/list" },
    });

    // Test runStdioMcpServer framing across split chunks, blank lines, and notifications
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));

    runStdioMcpServer(h, input, output);
    input.write('\n  \n{"id":1,"meth');
    input.write('od":"initialize"}\n{"method":"notifications/initialized"}\n{"id":2,"method":"tools/list"}\n');

    await new Promise<void>((resolve) => {
      const check = () => {
        if (chunks.join("").split("\n").filter(Boolean).length >= 2) resolve();
        else setImmediate(check);
      };
      check();
    });

    const lines = chunks.join("").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0] ?? "{}").id).toBe(1);
    expect(JSON.parse(lines[1] ?? "{}").id).toBe(2);
  });
});
