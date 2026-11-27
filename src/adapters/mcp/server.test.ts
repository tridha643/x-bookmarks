import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { bid } from "../../../test/fakes.ts";
import type { BookmarkDetail, IndexStats } from "../../domain/bookmark.ts";
import { handleMcpMessage, runStdioMcpServer, type McpHandlers } from "./server.ts";

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

const makeHandlers = (listCalls?: Array<Record<string, unknown>>): McpHandlers => ({
  search: async (req) => ({ mode: req.mode ?? "hybrid", total: 0, elapsedMs: 1, hits: [] }),
  getById: async (id) => {
    if (id === "12345") return sampleDetail;
    if (id === "12346") return minimalDetail;
    if (id === "12347") return titleOnlyDetail;
    if (id === "12348") return noArticleDetail;
    if (id === "12349") throw "string-failure";
    return null;
  },
  list: async (q) => {
    listCalls?.push(q as Record<string, unknown>);
    return { items: [], nextCursor: null };
  },
  stats: async () => sampleStats,
});

const callTool = async (
  h: McpHandlers,
  name: string,
  args?: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> => {
  const resp = await handleMcpMessage(
    JSON.stringify({
      id: 1,
      method: "tools/call",
      params: { name, ...(args !== undefined ? { arguments: args } : {}) },
    }),
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
  it("handles handshake, notifications, and full tools/list schemas", async () => {
    const h = makeHandlers();
    expect(await handleMcpMessage("{bad", h)).toBeNull();
    expect(await handleMcpMessage(JSON.stringify({ nope: 1 }), h)).toBeNull();
    expect(await handleMcpMessage(JSON.stringify({ method: "notifications/initialized" }), h)).toBeNull();
    expect(await handleMcpMessage(JSON.stringify({ method: "unknown/notification" }), h)).toBeNull();

    const init = await handleMcpMessage(JSON.stringify({ id: 1, method: "initialize" }), h);
    expect(init).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "x-bookmarks", version: "1.0.0" },
      },
    });

    const list = await handleMcpMessage(JSON.stringify({ id: 2, method: "tools/list" }), h);
    expect(list).not.toBeNull();
    expect((list as Record<string, unknown>).jsonrpc).toBe("2.0");
    expect(await handleMcpMessage(JSON.stringify({ id: 99, method: "notifications/initialized" }), h)).toBeNull();
    const tools = ((list as Record<string, unknown>).result as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools.map((t) => t.name)).toEqual(["search_bookmarks", "get_bookmark", "list_recent", "stats"]);
    for (const t of tools) {
      expect(String(t.description).length).toBeGreaterThan(10);
      expect((t.inputSchema as { type: string }).type).toBe("object");
    }
    const searchSchema = tools[0]?.inputSchema as {
      properties: { query: { type: string }; mode: { type: string; enum: string[] }; limit: { type: string } };
      required: string[];
    };
    expect(searchSchema).toEqual({
      type: "object",
      properties: {
        query: { type: "string" },
        mode: { type: "string", enum: ["hybrid", "fulltext", "vector"] },
        limit: { type: "number" },
      },
      required: ["query"],
    });
    expect(tools[1]?.inputSchema).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    });
    expect(tools[2]?.inputSchema).toEqual({
      type: "object",
      properties: { limit: { type: "number" }, by: { type: "string", enum: ["bookmarked", "created"] } },
    });
  });

  it("executes all 4 read-only MCP tools and formats all detail variants", async () => {
    const listCalls: Array<Record<string, unknown>> = [];
    const h = makeHandlers(listCalls);

    expect((await callTool(h, "search_bookmarks", { query: "orama" })).text).toContain('"mode": "hybrid"');

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
    expect((await callTool(h, "get_bookmark", { id: "abc" })).text).toBe("Invalid bookmark id.");

    await callTool(h, "list_recent", { limit: 5, by: "created" });
    await callTool(h, "list_recent", { by: "bookmarked" });
    await callTool(h, "list_recent", {});
    expect(listCalls).toStrictEqual([{ limit: 5, by: "created" }, { by: "bookmarked" }, {}]);

    expect((await callTool(h, "stats")).text).toContain('"total": 1');
  });

  it("returns structured MCP/JSON-RPC errors and streams framed lines via runStdioMcpServer", async () => {
    const h = makeHandlers();

    const badParams = await handleMcpMessage(JSON.stringify({ id: 9, method: "tools/call", params: 123 }), h);
    expect(badParams).toEqual({
      jsonrpc: "2.0",
      id: 9,
      result: { isError: true, content: [{ type: "text", text: "invalid tool call" }] },
    });

    expect(await callTool(h, "nope")).toEqual({ isError: true, text: "Unknown tool: nope" });
    expect((await callTool(h, "search_bookmarks", {})).isError).toBe(true);
    expect(await callTool(h, "get_bookmark", { id: "12349" })).toEqual({ isError: true, text: "string-failure" });

    const unknownMethod = await handleMcpMessage(JSON.stringify({ id: 12, method: "ping" }), h);
    expect(unknownMethod).toEqual({
      jsonrpc: "2.0",
      id: 12,
      error: { code: -32601, message: "Method not found: ping" },
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
