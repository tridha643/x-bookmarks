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

type Call = readonly [string, unknown];

const makeHandlers = (calls: Array<Call> = []): McpHandlers => ({
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
    calls.push(["search", req]);
    return { mode: req.mode ?? "hybrid", total: 0, elapsedMs: 1, hits: [] };
  },
  getById: async (id) => {
    if (id === "12345") return sampleDetail;
    if (id === "12346") return minimalDetail;
    if (id === "12347") return titleOnlyDetail;
    if (id === "12348") return noArticleDetail;
    if (id === "12349") throw "string-failure";
    if (id === "12350") throw new Error("store offline");
    if (id === "12351") return { ...noArticleDetail, text: "x".repeat(30_000) };
    return null;
  },
  list: async (q) => {
    calls.push(["list", q]);
    return { items: [], nextCursor: 7 };
  },
  ingest: async (req) => {
    calls.push(["ingest", req]);
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
  remove: async (id) => ({ id, deleted: true, tombstoned: true, removedFromIndex: true }),
  prune: async (req) => {
    calls.push(["prune", req]);
    return { requested: req.ids.length, deletedIds: [bid("12345")], notFoundIds: ["99999"], tombstoned: !req.hard };
  },
  updateTags: async (id, req) => {
    calls.push(["updateTags", { id, tags: req.tags }]);
    return id === "12345" ? { id, tags: req.tags } : null;
  },
  deleteTag: async (id, tag) => {
    calls.push(["deleteTag", { id, tag }]);
    if (tag === "gone") return null;
    return id === "12345" ? { id, tags: [`without-${tag}`] } : null;
  },
  sync: async (req) => {
    calls.push(["sync", req]);
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
    calls.push(["reindex", req]);
    return { reparsed: 1, embedded: 1, indexed: 1 };
  },
});

interface ToolCallResult {
  readonly isError: boolean;
  readonly text: string;
  readonly structured: unknown;
}

const callTool = async (h: McpHandlers, name: string, args?: unknown): Promise<ToolCallResult> => {
  const resp = await handleMcpPayload(
    { id: 1, method: "tools/call", params: { name, ...(args !== undefined ? { arguments: args } : {}) } },
    h,
  );
  const result = (
    resp as {
      result: { isError?: boolean; content: Array<{ type: string; text: string }>; structuredContent?: unknown };
    }
  ).result;
  expect(result.content).toHaveLength(1);
  expect(result.content[0]?.type).toBe("text");
  return {
    isError: result.isError ?? false,
    text: result.content[0]?.text ?? "",
    structured: result.structuredContent,
  };
};

const expectToolError = async (h: McpHandlers, name: string, args: unknown, text: string): Promise<void> => {
  expect(await callTool(h, name, args)).toStrictEqual({ isError: true, text, structured: undefined });
};

const callsOf = (calls: ReadonlyArray<Call>, kind: string): ReadonlyArray<unknown> =>
  calls.filter(([k]) => k === kind).map(([, v]) => v);

const NOT_FOUND_99999 = "Bookmark 99999 not found. Use search_bookmarks or list_bookmarks to find a valid bookmark id.";
const BAD_ID =
  '"bad" is not a bookmark id. Pass a numeric tweet id like "1880000000000000000" or a status URL like "https://x.com/user/status/1880000000000000000".';

describe("adapters/mcp/server", () => {
  it("negotiates protocol versions and advertises server info and instructions", async () => {
    const h = makeHandlers();
    expect(await handleMcpMessage("{bad", h)).toBeNull();
    expect(await handleMcpMessage(JSON.stringify({ nope: 1 }), h)).toBeNull();
    expect(await handleMcpPayload({ method: "notifications/initialized" }, h)).toBeNull();
    expect(await handleMcpPayload({ id: 99, method: "notifications/initialized" }, h)).toBeNull();
    expect(await handleMcpPayload({ method: "unknown/notification" }, h)).toBeNull();

    expect(
      await handleMcpPayload({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, h),
    ).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "x-bookmarks", title: "X Bookmarks", version: "1.0.0" },
        instructions:
          "Personal library of X (Twitter) bookmarks. Start with search_bookmarks for topic questions or list_bookmarks to browse recent saves, then get_bookmark for full text. Bookmark ids are numeric tweet ids; status URLs are accepted anywhere an id is.",
      },
    });

    const versionFor = async (params?: unknown): Promise<string> => {
      const resp = await handleMcpPayload(
        { id: 2, method: "initialize", ...(params !== undefined ? { params } : {}) },
        h,
      );
      return (resp as { result: { protocolVersion: string } }).result.protocolVersion;
    };
    expect(MCP_PROTOCOL_VERSION).toBe("2025-06-18");
    expect(await versionFor({ protocolVersion: "2025-06-18" })).toBe("2025-06-18");
    expect(await versionFor({ protocolVersion: "2024-11-05" })).toBe("2024-11-05");
    expect(await versionFor({ protocolVersion: "2099-01-01" })).toBe("2025-06-18");
    expect(await versionFor(42)).toBe("2025-06-18");
    expect(await versionFor()).toBe("2025-06-18");

    expect(await handleMcpPayload({ id: 4, method: "ping" }, h)).toEqual({ jsonrpc: "2.0", id: 4, result: {} });
    expect(await handleMcpPayload({ id: 12, method: "resources/list" }, h)).toEqual({
      jsonrpc: "2.0",
      id: 12,
      error: { code: -32601, message: "Method not found: resources/list" },
    });
  });

  it("lists every tool with its published input schema and annotations", async () => {
    const list = await handleMcpPayload({ id: 5, method: "tools/list" }, makeHandlers());
    expect((list as { jsonrpc: string }).jsonrpc).toBe("2.0");
    const tools = (list as { result: { tools: ReadonlyArray<Record<string, unknown>> } }).result.tools;
    expect(tools.map((t) => Object.keys(t))).toStrictEqual(
      tools.map(() => ["name", "title", "description", "inputSchema", "annotations"]),
    );
    await expect(`${JSON.stringify(tools, null, 2)}\n`).toMatchFileSnapshot("./__snapshots__/tools-list.snap");
  });

  it("searches with flattened filters, ISO date bounds, and structured results", async () => {
    const calls: Array<Call> = [];
    const h = makeHandlers(calls);

    const res = await callTool(h, "search_bookmarks", {
      query: "orama",
      mode: "vector",
      limit: 5,
      minSimilarity: 0.3,
      author: "@alice",
      domain: "effect.website",
      folder: "AI",
      tag: "effect",
      hasArticle: true,
      createdAfter: "2026-01-15T10:00:00.900Z",
      createdBefore: "2026-01-16",
    });
    const expected = { mode: "vector", total: 0, elapsedMs: 1, hits: [] };
    expect(res).toStrictEqual({ isError: false, text: JSON.stringify(expected), structured: expected });

    await callTool(h, "search_bookmarks", { query: "minimal" });
    expect(callsOf(calls, "search")).toStrictEqual([
      {
        query: "orama",
        mode: "vector",
        limit: 5,
        similarity: 0.3,
        filters: {
          author: "@alice",
          domain: "effect.website",
          folder: "AI",
          tag: "effect",
          hasArticle: true,
          sinceTimestamp: 1_768_471_200,
          untilTimestamp: 1_768_521_600,
        },
      },
      {
        query: "minimal",
        mode: undefined,
        limit: undefined,
        similarity: undefined,
        filters: {
          author: undefined,
          domain: undefined,
          folder: undefined,
          tag: undefined,
          hasArticle: undefined,
          sinceTimestamp: undefined,
          untilTimestamp: undefined,
        },
      },
    ]);

    const badDate = 'must be an ISO 8601 date such as "2026-01-15" or "2026-01-15T10:00:00Z".';
    await expectToolError(h, "search_bookmarks", { query: "q", createdAfter: "soon" }, `createdAfter ${badDate}`);
    await expectToolError(h, "search_bookmarks", { query: "q", createdBefore: "later" }, `createdBefore ${badDate}`);
    await expectToolError(
      h,
      "search_bookmarks",
      { query: "", limit: 51, filters: {} },
      'Invalid arguments for search_bookmarks: Expected no excess property\n  at ["filters"]\nExpected a value with a length of at least 1\n  at ["query"]\nExpected a value between 1 and 50\n  at ["limit"]',
    );
  });

  it("reads bookmarks by id or URL as Markdown plus structured detail", async () => {
    const h = makeHandlers();

    const full = await callTool(h, "get_bookmark", { id: " https://x.com/alice/status/12345 " });
    expect(full.isError).toBe(false);
    expect(full.structured).toStrictEqual(sampleDetail);
    expect(full.text).toBe(
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

    expect((await callTool(h, "get_bookmark", { id: "12347" })).text).toBe(
      "# @alice — https://x.com/alice/status/12345\n\nMain tweet text\n\n## Article: Title Only\n\n",
    );
    expect((await callTool(h, "get_bookmark", { id: "12348" })).text).toBe(
      "# @alice — https://x.com/alice/status/12345\n\nMain tweet text",
    );
    expect((await callTool(h, "get_bookmark", { id: "12351" })).text).toHaveLength(28_000);

    await expectToolError(h, "get_bookmark", { id: "99999" }, NOT_FOUND_99999);
    await expectToolError(h, "get_bookmark", { id: "bad" }, BAD_ID);
    await expectToolError(h, "get_bookmark", { id: "12349" }, "get_bookmark failed: string-failure");
    await expectToolError(h, "get_bookmark", { id: "12350" }, "get_bookmark failed: store offline");
    await expectToolError(h, "get_bookmark", {}, 'Invalid arguments for get_bookmark: Missing key\n  at ["id"]');
  });

  it("lists bookmarks with renamed sort and cursor parameters", async () => {
    const calls: Array<Call> = [];
    const h = makeHandlers(calls);

    const page = await callTool(h, "list_bookmarks", {
      sortBy: "created",
      author: "alice",
      domain: "github.com",
      folder: "AI",
      tag: "effect",
      limit: 100,
      cursor: 0,
    });
    expect(page.structured).toStrictEqual({ items: [], nextCursor: 7 });
    await callTool(h, "list_bookmarks", {});
    expect(callsOf(calls, "list")).toStrictEqual([
      { by: "created", author: "alice", domain: "github.com", folder: "AI", tag: "effect", limit: 100, cursor: 0 },
      {
        by: undefined,
        author: undefined,
        domain: undefined,
        folder: undefined,
        tag: undefined,
        limit: undefined,
        cursor: undefined,
      },
    ]);
    expect((await callTool(h, "list_bookmarks", { cursor: -1 })).isError).toBe(true);
    expect((await callTool(h, "list_bookmarks", { limit: 2.5 })).isError).toBe(true);
  });

  it("adds, deletes, and tags bookmarks through the v1 handlers", async () => {
    const calls: Array<Call> = [];
    const h = makeHandlers(calls);

    const added = await callTool(h, "add_bookmarks", {
      refs: ["https://x.com/alice/status/12345"],
      hydrate: false,
      embed: false,
      includeThreads: true,
      folder: "AI",
    });
    expect(added.structured).toMatchObject({ added: 1, ids: ["12345"] });
    await callTool(h, "add_bookmarks", { refs: ["12345"] });
    expect(callsOf(calls, "ingest")).toStrictEqual([
      { refs: ["https://x.com/alice/status/12345"], hydrate: false, embed: false, threads: true, folderName: "AI" },
      { refs: ["12345"], hydrate: undefined, embed: undefined, threads: undefined, folderName: undefined },
    ]);
    expect((await callTool(h, "add_bookmarks", { refs: [] })).isError).toBe(true);

    const deleted = await callTool(h, "delete_bookmarks", {
      ids: ["https://x.com/alice/status/12345", "99999"],
      allowResync: true,
      reason: "dup",
    });
    expect(deleted.structured).toStrictEqual({
      requested: 2,
      deletedIds: ["12345"],
      notFoundIds: ["99999"],
      tombstoned: false,
    });
    await callTool(h, "delete_bookmarks", { ids: ["12345"] });
    expect(callsOf(calls, "prune")).toStrictEqual([
      { ids: ["12345", "99999"], hard: true, reason: "dup" },
      { ids: ["12345"], hard: undefined, reason: undefined },
    ]);
    await expectToolError(h, "delete_bookmarks", { ids: ["12345", "bad"] }, BAD_ID);

    expect((await callTool(h, "add_bookmark_tags", { id: "12345", tags: ["ai", "effect"] })).structured).toStrictEqual({
      id: "12345",
      tags: ["ai", "effect"],
    });
    await expectToolError(h, "add_bookmark_tags", { id: "99999", tags: ["ai"] }, NOT_FOUND_99999);
    await expectToolError(h, "add_bookmark_tags", { id: "bad", tags: ["ai"] }, BAD_ID);

    expect(
      (await callTool(h, "remove_bookmark_tags", { id: "12345", tags: ["ai", "effect"] })).structured,
    ).toStrictEqual({
      id: "12345",
      tags: ["without-effect"],
    });
    await expectToolError(h, "remove_bookmark_tags", { id: "99999", tags: ["ai"] }, NOT_FOUND_99999);
    expect((await callTool(h, "remove_bookmark_tags", { id: "12345", tags: ["ai", "gone"] })).text).toBe(
      "Bookmark 12345 not found. Use search_bookmarks or list_bookmarks to find a valid bookmark id.",
    );
    expect(callsOf(calls, "deleteTag")).toStrictEqual([
      { id: "12345", tag: "ai" },
      { id: "12345", tag: "effect" },
      { id: "99999", tag: "ai" },
      { id: "12345", tag: "ai" },
      { id: "12345", tag: "gone" },
    ]);
  });

  it("syncs, reindexes, and reports stats merged with embedding config", async () => {
    const calls: Array<Call> = [];
    const h = makeHandlers(calls);

    expect((await callTool(h, "sync_bookmarks", {})).structured).toMatchObject({ captured: 2 });
    await callTool(h, "sync_bookmarks", {
      full: true,
      includeThreads: false,
      embed: false,
      maxItems: 5,
      hydrateLimit: 0,
    });
    expect(callsOf(calls, "sync")).toStrictEqual([
      { full: undefined, threads: undefined, embed: undefined, maxItems: undefined, hydrateLimit: undefined },
      { full: true, threads: false, embed: false, maxItems: 5, hydrateLimit: 0 },
    ]);

    expect((await callTool(h, "reindex_bookmarks", { embedMissing: false })).structured).toStrictEqual({
      reparsed: 1,
      embedded: 1,
      indexed: 1,
    });
    expect(callsOf(calls, "reindex")).toStrictEqual([{ embedMissing: false }]);

    const stats = await callTool(h, "get_bookmark_stats");
    expect(stats.structured).toStrictEqual({ ...sampleStats, embeddingModel: "nomic-embed-text", embeddingDims: 768 });
    expect(JSON.parse(stats.text)).toStrictEqual(stats.structured);
    expect((await callTool(h, "get_bookmark_stats", { verbose: true })).isError).toBe(true);
  });

  it("returns JSON-RPC invalid-params errors for malformed calls and unknown tools", async () => {
    const h = makeHandlers();
    expect(await handleMcpPayload({ id: 9, method: "tools/call", params: 123 }, h)).toEqual({
      jsonrpc: "2.0",
      id: 9,
      error: { code: -32602, message: "tools/call params must include a string tool name." },
    });
    expect(await handleMcpPayload({ id: 10, method: "tools/call", params: { name: "get_health" } }, h)).toEqual({
      jsonrpc: "2.0",
      id: 10,
      error: {
        code: -32602,
        message:
          'Unknown tool "get_health". Available tools: search_bookmarks, get_bookmark, list_bookmarks, add_bookmarks, delete_bookmarks, add_bookmark_tags, remove_bookmark_tags, sync_bookmarks, reindex_bookmarks, get_bookmark_stats.',
      },
    });
  });

  it("streams newline-framed JSON-RPC over stdio", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));

    runStdioMcpServer(makeHandlers(), input, output);
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
