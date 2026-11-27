import { Option, Schema } from "effect";
import { SearchRequest, type BookmarkPage, type ListBookmarksQuery, type SearchResponse } from "../../domain/api.ts";
import { decodeBookmarkId, type BookmarkDetail, type BookmarkId, type IndexStats } from "../../domain/bookmark.ts";

export interface McpHandlers {
  readonly search: (req: SearchRequest) => Promise<SearchResponse>;
  readonly getById: (id: BookmarkId) => Promise<BookmarkDetail | null>;
  readonly list: (query: ListBookmarksQuery) => Promise<BookmarkPage>;
  readonly stats: () => Promise<IndexStats>;
}

const JsonRpcRequestSchema = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});

const ToolCallParamsSchema = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const GetBookmarkArgsSchema = Schema.Struct({ id: Schema.String });

const ListRecentArgsSchema = Schema.Struct({
  limit: Schema.optional(Schema.Number),
  by: Schema.optional(Schema.Literals(["bookmarked", "created"])),
});

const TOOLS = [
  {
    name: "search_bookmarks",
    description:
      "Search indexed X bookmarks with Orama hybrid (BM25 + nomic-embed-text vector), fulltext, or vector search.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        mode: { type: "string", enum: ["hybrid", "fulltext", "vector"] },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_bookmark",
    description: "Fetch full bookmark detail including X Article Markdown, quotes, links, tags, and thread posts.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "list_recent",
    description: "List recent bookmarks ordered by bookmarked recency or post creation time.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" }, by: { type: "string", enum: ["bookmarked", "created"] } },
    },
  },
  {
    name: "stats",
    description: "Return bookmark, article, thread, pruned, and vector index counts.",
    inputSchema: { type: "object", properties: {} },
  },
];

const formatArticleSection = (b: BookmarkDetail): string | null =>
  b.articleTitle !== null || b.articleText !== null
    ? `## Article: ${b.articleTitle ?? "(untitled)"}\n\n${b.articleText ?? ""}`
    : null;

const formatDetail = (b: BookmarkDetail): string => {
  const quoteSection = b.quoteText !== null ? `## Quoted (@${b.quoteAuthor ?? "unknown"})\n\n${b.quoteText}` : null;
  const linksSection = b.urls.length > 0 ? `## Links\n${b.urls.map((u) => `- ${u}`).join("\n")}` : null;
  const threadSection =
    b.threadPosts.length > 1 ? `## Thread\n${b.threadPosts.map((p, i) => `${i + 1}. ${p.text}`).join("\n\n")}` : null;

  return [
    `# @${b.authorHandle ?? "unknown"} — ${b.url}`,
    b.text,
    formatArticleSection(b),
    quoteSection,
    linksSection,
    threadSection,
  ]
    .filter((s): s is string => s !== null)
    .join("\n\n")
    .slice(0, 28_000);
};

type ToolFn = (args: Record<string, unknown>, handlers: McpHandlers) => Promise<string>;

const TOOL_DISPATCH = new Map<string, ToolFn>([
  [
    "search_bookmarks",
    async (args, handlers) =>
      JSON.stringify(await handlers.search(Schema.decodeUnknownSync(SearchRequest)(args)), null, 2),
  ],
  [
    "get_bookmark",
    async (args, handlers) => {
      const parsed = Schema.decodeUnknownSync(GetBookmarkArgsSchema)(args);
      const id = decodeBookmarkId(parsed.id);
      if (id === null) return "Invalid bookmark id.";
      const detail = await handlers.getById(id);
      return detail === null ? `Bookmark ${id} not found.` : formatDetail(detail);
    },
  ],
  [
    "list_recent",
    async (args, handlers) => {
      const parsed = Schema.decodeUnknownSync(ListRecentArgsSchema)(args);
      const page = await handlers.list({
        ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
        ...(parsed.by !== undefined ? { by: parsed.by } : {}),
      });
      return JSON.stringify(page, null, 2);
    },
  ],
  ["stats", async (_args, handlers) => JSON.stringify(await handlers.stats(), null, 2)],
]);

const handleToolCall = async (
  id: string | number | null | undefined,
  params: unknown,
  handlers: McpHandlers,
): Promise<Record<string, unknown>> => {
  const callOpt = Schema.decodeUnknownOption(ToolCallParamsSchema)(params);
  if (Option.isNone(callOpt)) {
    return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "invalid tool call" }] } };
  }
  const fn = TOOL_DISPATCH.get(callOpt.value.name);
  if (fn === undefined) {
    return {
      jsonrpc: "2.0",
      id,
      result: { isError: true, content: [{ type: "text", text: `Unknown tool: ${callOpt.value.name}` }] },
    };
  }
  try {
    const text = await fn(callOpt.value.arguments ?? {}, handlers);
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      result: { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] },
    };
  }
};

export const handleMcpMessage = async (
  rawLine: string,
  handlers: McpHandlers,
): Promise<Record<string, unknown> | null> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return null;
  }
  const reqOpt = Schema.decodeUnknownOption(JsonRpcRequestSchema)(parsed);
  if (Option.isNone(reqOpt)) return null;
  const { id, method, params } = reqOpt.value;
  if (method === "notifications/initialized") return null;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "x-bookmarks", version: "1.0.0" },
      },
    };
  }
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (method === "tools/call") return handleToolCall(id, params, handlers);
  return id === undefined
    ? null
    : { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
};

export const runStdioMcpServer = (
  handlers: McpHandlers,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): void => {
  let buffer = "";
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line !== "") {
        void handleMcpMessage(line, handlers).then((resp) => {
          if (resp !== null) output.write(`${JSON.stringify(resp)}\n`);
        });
      }
      idx = buffer.indexOf("\n");
    }
  });
};
