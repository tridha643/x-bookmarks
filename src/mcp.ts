import { getBookmarkById, getStats, listRecentBookmarks, openDb, searchBookmarks, type BookmarkRow } from "./db.ts";

/**
 * Zero-dependency read-only MCP stdio server for x-bookmarks.
 * Opens SQLite in readonly mode so concurrent WAL sync writes never conflict.
 */

const SERVER_INFO = {
  name: "x-bookmarks",
  version: "0.2.0",
};

const TOOLS = [
  {
    name: "search_bookmarks",
    description:
      "Search indexed X bookmarks using weighted BM25 full-text search across post text, X Articles, quotes, link cards, alt text, and domains.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (handles punctuation safely by default)." },
        author: { type: "string", description: "Filter by X handle (with or without @)." },
        domain: { type: "string", description: "Filter by linked domain, e.g. github.com." },
        folder: { type: "string", description: "Filter by bookmark folder id or name." },
        tag: { type: "string", description: "Filter by user tag." },
        raw: { type: "boolean", description: "Pass raw FTS5 syntax without automatic quoting." },
        limit: { type: "number", description: "Max results (default 10, max 30)." },
      },
    },
  },
  {
    name: "get_bookmark",
    description: "Fetch the full stored content of a bookmark by tweet ID, including X Article Markdown, quote, links, and thread posts.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Numeric tweet ID." },
      },
      required: ["id"],
    },
  },
  {
    name: "list_recent",
    description: "List the most recent bookmarks ordered by when they were bookmarked or when they were tweeted.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default 15, max 50)." },
        by: { type: "string", enum: ["bookmarked", "created"], description: "Sort order (default bookmarked)." },
      },
    },
  },
  {
    name: "stats",
    description: "Return total bookmark counts, hydration status breakdown, top authors, and top linked domains.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

function formatCompactList(rows: BookmarkRow[]): string {
  if (rows.length === 0) return "No matching bookmarks found.";
  const lines = rows.map((r, i) => {
    const date = r.created_timestamp
      ? new Date(r.created_timestamp * 1000).toISOString().slice(0, 10)
      : (r.created_at || "n/a").slice(0, 10);
    const title = r.article_title ? `**[Article] ${r.article_title}** — ` : "";
    const body = (r.text || r.article_text || r.dom_text || "(no text)").replace(/\s+/g, " ").slice(0, 240);
    const meta = [r.domains ? `domains: ${r.domains}` : null, `id: ${r.id}`].filter(Boolean).join(" | ");
    return `${i + 1}. @${r.author_handle || "unknown"} (${date}) — ${r.url}\n   ${title}${body}\n   _${meta}_`;
  });
  return lines.join("\n\n").slice(0, 24000);
}

function handleToolCall(name: string, args: Record<string, any>): string {
  const db = openDb(undefined, { readonly: true });
  try {
    switch (name) {
      case "search_bookmarks": {
        const limit = Math.min(Math.max(Number(args.limit || 10), 1), 30);
        const rows = searchBookmarks(db, {
          query: typeof args.query === "string" ? args.query : undefined,
          author: typeof args.author === "string" ? args.author : undefined,
          domain: typeof args.domain === "string" ? args.domain : undefined,
          folder: typeof args.folder === "string" ? args.folder : undefined,
          tag: typeof args.tag === "string" ? args.tag : undefined,
          raw: Boolean(args.raw),
          limit,
        });
        return formatCompactList(rows);
      }
      case "get_bookmark": {
        const id = String(args.id || "").trim();
        const { bookmark: b, thread, tags, folders } = getBookmarkById(db, id);
        if (!b) return `Bookmark ${id} not found.`;
        const parts: string[] = [
          `# @${b.author_handle || "unknown"} — ${b.url}`,
          `Created: ${b.created_at || "n/a"} | Source: ${b.hydration_source || b.capture_source} | Status: ${b.hydration_status}`,
        ];
        if (tags.length) parts.push(`Tags: ${tags.join(", ")}`);
        if (folders.length) parts.push(`Folders: ${folders.map((f) => f.folder_name || f.folder_id).join(", ")}`);
        if (b.text || b.dom_text) parts.push(`\n${b.text || b.dom_text}`);
        if (b.article_title || b.article_text) {
          parts.push(`\n## Article: ${b.article_title || "(untitled)"}\n\n${b.article_text || ""}`);
        }
        if (b.quote_text) {
          parts.push(`\n## Quoted (@${b.quote_author || "unknown"})\n\n${b.quote_text}`);
        }
        if (b.card_title || b.card_url) {
          parts.push(`\n## Card\n${b.card_title || ""} ${b.card_url || ""}\n${b.card_description || ""}`.trim());
        }
        if (b.urls_json) {
          try {
            const urls = JSON.parse(b.urls_json) as string[];
            if (urls.length) parts.push(`\n## Links\n${urls.map((u) => `- ${u}`).join("\n")}`);
          } catch {}
        }
        if (thread.length > 1) {
          parts.push(`\n## Thread (${thread.length} posts)\n${thread.map((p, idx) => `${idx + 1}. ${p.text}`).join("\n\n")}`);
        }
        return parts.join("\n").slice(0, 28000);
      }
      case "list_recent": {
        const limit = Math.min(Math.max(Number(args.limit || 15), 1), 50);
        const by = args.by === "created" ? "created" : "bookmarked";
        return formatCompactList(listRecentBookmarks(db, limit, by));
      }
      case "stats": {
        return JSON.stringify(getStats(db), null, 2);
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } finally {
    db.close();
  }
}

function send(msg: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newlineIdx: number;
  while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (!line) continue;

    let req: any;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }

    const { id, method, params } = req;
    if (method === "notifications/initialized") continue;

    try {
      if (method === "initialize") {
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: params?.protocolVersion || "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          },
        });
      } else if (method === "tools/list") {
        send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      } else if (method === "tools/call") {
        const text = handleToolCall(String(params?.name || ""), (params?.arguments ?? {}) as Record<string, any>);
        send({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text }] },
        });
      } else if (id !== undefined) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
      }
    } catch (err) {
      if (id !== undefined) {
        send({
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          },
        });
      }
    }
  }
});
