import { Option, Schema } from "effect";
import {
  IngestBookmarksRequest,
  ListBookmarksQuery,
  PruneBookmarksRequest,
  ReindexRequest,
  SearchRequest,
  SyncRequest,
  type BookmarkApiHandlers,
} from "../../domain/api.ts";
import { decodeBookmarkId, type BookmarkDetail, type BookmarkId } from "../../domain/bookmark.ts";

export const MCP_PROTOCOL_VERSION = "2025-03-26";
const LEGACY_PROTOCOL_VERSION = "2024-11-05";

export type McpHandlers = BookmarkApiHandlers;

const JsonRpcRequestSchema = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});

const InitializeParamsSchema = Schema.Struct({
  protocolVersion: Schema.optional(Schema.String),
});

const ToolCallParamsSchema = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const GetBookmarkArgsSchema = Schema.Struct({ id: Schema.String });

const DeleteBookmarkArgsSchema = Schema.Struct({
  id: Schema.String,
  hard: Schema.optional(Schema.Boolean),
  reason: Schema.optional(Schema.String),
});

const AddTagsArgsSchema = Schema.Struct({
  id: Schema.String,
  tags: Schema.Array(Schema.String),
});

const RemoveTagArgsSchema = Schema.Struct({
  id: Schema.String,
  tag: Schema.String,
});

const TOOLS = [
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
    description: "List bookmarks ordered by bookmarked recency or post creation time with optional filters and cursor.",
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
    description: "Ingest bookmark tweet URLs or numeric IDs with optional FxTwitter hydration and vector embedding.",
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
    description: "Return service readiness, bookmark count, indexed vector count, and embedding model configuration.",
    annotations: { readOnlyHint: true, idempotentHint: true },
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

const jsonText = (value: unknown): string => JSON.stringify(value, null, 2);

const requireBookmarkId = (rawId: string): BookmarkId => {
  const id = decodeBookmarkId(rawId);
  if (id === null) throw new Error("Invalid bookmark id.");
  return id;
};

type ToolFn = (args: Record<string, unknown>, handlers: McpHandlers) => Promise<string>;

const TOOL_DISPATCH = new Map<string, ToolFn>([
  ["search_bookmarks", async (args, h) => jsonText(await h.search(Schema.decodeUnknownSync(SearchRequest)(args)))],
  [
    "get_bookmark",
    async (args, h) => {
      const id = requireBookmarkId(Schema.decodeUnknownSync(GetBookmarkArgsSchema)(args).id);
      const detail = await h.getById(id);
      return detail === null ? `Bookmark ${id} not found.` : formatDetail(detail);
    },
  ],
  ["list_bookmarks", async (args, h) => jsonText(await h.list(Schema.decodeUnknownSync(ListBookmarksQuery)(args)))],
  [
    "add_bookmarks",
    async (args, h) => jsonText(await h.ingest(Schema.decodeUnknownSync(IngestBookmarksRequest)(args))),
  ],
  [
    "delete_bookmark",
    async (args, h) => {
      const parsed = Schema.decodeUnknownSync(DeleteBookmarkArgsSchema)(args);
      const id = requireBookmarkId(parsed.id);
      return jsonText(await h.remove(id, { hard: parsed.hard ?? false, reason: parsed.reason ?? null }));
    },
  ],
  [
    "prune_bookmarks",
    async (args, h) => jsonText(await h.prune(Schema.decodeUnknownSync(PruneBookmarksRequest)(args))),
  ],
  [
    "add_tags",
    async (args, h) => {
      const parsed = Schema.decodeUnknownSync(AddTagsArgsSchema)(args);
      const id = requireBookmarkId(parsed.id);
      const out = await h.updateTags(id, { tags: parsed.tags });
      return out === null ? `Bookmark ${id} not found.` : jsonText(out);
    },
  ],
  [
    "remove_tag",
    async (args, h) => {
      const parsed = Schema.decodeUnknownSync(RemoveTagArgsSchema)(args);
      const id = requireBookmarkId(parsed.id);
      const out = await h.deleteTag(id, parsed.tag);
      return out === null ? `Bookmark ${id} not found.` : jsonText(out);
    },
  ],
  ["sync_bookmarks", async (args, h) => jsonText(await h.sync(Schema.decodeUnknownSync(SyncRequest)(args)))],
  ["reindex_bookmarks", async (args, h) => jsonText(await h.reindex(Schema.decodeUnknownSync(ReindexRequest)(args)))],
  ["get_stats", async (_args, h) => jsonText(await h.stats())],
  ["get_health", async (_args, h) => jsonText(await h.health())],
]);

const negotiateVersion = (params: unknown): string => {
  const initOpt = Schema.decodeUnknownOption(InitializeParamsSchema)(params);
  if (Option.isSome(initOpt) && initOpt.value.protocolVersion === LEGACY_PROTOCOL_VERSION) {
    return LEGACY_PROTOCOL_VERSION;
  }
  return MCP_PROTOCOL_VERSION;
};

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

export const handleMcpPayload = async (
  payload: unknown,
  handlers: McpHandlers,
): Promise<Record<string, unknown> | null> => {
  const reqOpt = Schema.decodeUnknownOption(JsonRpcRequestSchema)(payload);
  if (Option.isNone(reqOpt)) return null;
  const { id, method, params } = reqOpt.value;
  if (method === "notifications/initialized") return null;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: negotiateVersion(params),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "x-bookmarks", version: "1.0.0" },
      },
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (method === "tools/call") return handleToolCall(id, params, handlers);
  return id === undefined
    ? null
    : { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
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
  return handleMcpPayload(parsed, handlers);
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
