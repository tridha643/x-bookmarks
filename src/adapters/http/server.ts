import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Option, Schema } from "effect";
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
  type ApiErrorCode,
  type BookmarkApiHandlers,
} from "../../domain/api.ts";
import { decodeBookmarkId, type BookmarkId } from "../../domain/bookmark.ts";

export type HttpApiHandlers = BookmarkApiHandlers;

export type McpHttpDispatch = (payload: unknown) => Promise<Record<string, unknown> | null>;

export interface HttpServerOptions {
  readonly authToken?: string | null;
  readonly mcp?: McpHttpDispatch;
}

const MCP_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
} as const;

const sendJson = (
  res: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders?: Record<string, string>,
): void => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...extraHeaders,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
};

const sendError = (res: ServerResponse, code: ApiErrorCode, message: string): void => {
  sendJson(res, httpStatusForError(code), apiError(code, message));
};

const isAuthorized = (req: IncomingMessage, authToken: string | null): boolean => {
  if (authToken === null) return true;
  const header = req.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(authToken, "utf8");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
};

const readJsonBody = async (
  req: IncomingMessage,
): Promise<{ readonly ok: true; readonly data: unknown } | { readonly ok: false }> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text.length === 0) return { ok: true, data: {} };
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

const decodeJsonWith = async <A>(
  req: IncomingMessage,
  res: ServerResponse,
  decode: (input: unknown) => Option.Option<A>,
): Promise<A | null> => {
  const raw = await readJsonBody(req);
  if (!raw.ok) {
    sendError(res, "bad_request", "invalid JSON request body");
    return null;
  }
  const decoded = decode(raw.data);
  if (Option.isNone(decoded)) {
    sendError(res, "bad_request", "request body failed schema validation");
    return null;
  }
  return decoded.value;
};

const parseListQuery = (params: URLSearchParams): ListBookmarksQuery | null => {
  const raw: Record<string, unknown> = {};
  for (const key of ["by", "author", "domain", "folder", "tag"] as const) {
    const val = params.get(key);
    if (val !== null) raw[key] = val;
  }
  for (const key of ["limit", "cursor"] as const) {
    const val = params.get(key);
    if (val !== null) raw[key] = Number(val);
  }
  return Option.getOrNull(Schema.decodeUnknownOption(ListBookmarksQuery)(raw));
};

interface RouteCtx {
  readonly url: URL;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly handlers: HttpApiHandlers;
}
type StaticRouteFn = (ctx: RouteCtx) => Promise<void>;

const STATIC_ROUTES = new Map<string, StaticRouteFn>([
  ["GET /health", async ({ res, handlers }) => sendJson(res, 200, await handlers.health())],
  ["GET /v1/openapi.json", async ({ res }) => sendJson(res, 200, openApiDocument())],
  ["GET /v1/stats", async ({ res, handlers }) => sendJson(res, 200, await handlers.stats())],
  [
    "POST /v1/search",
    async ({ req, res, handlers }) => {
      const body = await decodeJsonWith(req, res, Schema.decodeUnknownOption(SearchRequest));
      if (body !== null) sendJson(res, 200, await handlers.search(body));
    },
  ],
  [
    "GET /v1/bookmarks",
    async ({ url, res, handlers }) => {
      const query = parseListQuery(url.searchParams);
      if (query === null) sendError(res, "bad_request", "invalid query parameters");
      else sendJson(res, 200, await handlers.list(query));
    },
  ],
  [
    "POST /v1/bookmarks",
    async ({ req, res, handlers }) => {
      const body = await decodeJsonWith(req, res, Schema.decodeUnknownOption(IngestBookmarksRequest));
      if (body !== null) sendJson(res, 201, await handlers.ingest(body));
    },
  ],
  [
    "POST /v1/bookmarks/prune",
    async ({ req, res, handlers }) => {
      const body = await decodeJsonWith(req, res, Schema.decodeUnknownOption(PruneBookmarksRequest));
      if (body !== null) sendJson(res, 200, await handlers.prune(body));
    },
  ],
  [
    "POST /v1/sync",
    async ({ req, res, handlers }) => {
      const body = await decodeJsonWith(req, res, Schema.decodeUnknownOption(SyncRequest));
      if (body !== null) sendJson(res, 200, await handlers.sync(body));
    },
  ],
  [
    "POST /v1/reindex",
    async ({ req, res, handlers }) => {
      const body = await decodeJsonWith(req, res, Schema.decodeUnknownOption(ReindexRequest));
      if (body !== null) sendJson(res, 200, await handlers.reindex(body));
    },
  ],
]);

const handleMcpPost = async (req: IncomingMessage, res: ServerResponse, mcp: McpHttpDispatch): Promise<void> => {
  const raw = await readJsonBody(req);
  if (!raw.ok) {
    sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, MCP_HEADERS);
    return;
  }
  if (Array.isArray(raw.data)) {
    const out: Array<Record<string, unknown>> = [];
    for (const item of raw.data) {
      const r = await mcp(item);
      if (r !== null) out.push(r);
    }
    if (out.length === 0) {
      res.writeHead(202, MCP_HEADERS);
      res.end();
      return;
    }
    sendJson(res, 200, out, MCP_HEADERS);
    return;
  }
  const resp = await mcp(raw.data);
  if (resp === null) {
    res.writeHead(202, MCP_HEADERS);
    res.end();
    return;
  }
  sendJson(res, 200, resp, MCP_HEADERS);
};

const routeMcp = async (
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  mcp: McpHttpDispatch | undefined,
): Promise<void> => {
  if (method === "OPTIONS" || method === "DELETE") {
    res.writeHead(204, MCP_HEADERS);
    res.end();
    return;
  }
  if (method !== "POST") {
    sendJson(res, 405, apiError("bad_request", "use POST /mcp for Streamable HTTP MCP requests"), {
      ...MCP_HEADERS,
      Allow: "POST, DELETE, OPTIONS",
    });
    return;
  }
  if (mcp === undefined) {
    sendError(res, "unavailable", "MCP endpoint is not enabled");
    return;
  }
  await handleMcpPost(req, res, mcp);
};

const handleBookmarkSingle = async (method: string, id: BookmarkId, ctx: RouteCtx): Promise<boolean> => {
  if (method === "GET") {
    const detail = await ctx.handlers.getById(id);
    if (detail === null) sendError(ctx.res, "not_found", "bookmark not found");
    else sendJson(ctx.res, 200, detail);
    return true;
  }
  if (method === "DELETE") {
    const hard = ctx.url.searchParams.get("hard") === "true";
    const reason = ctx.url.searchParams.get("reason");
    const out = await ctx.handlers.remove(id, { hard, reason });
    if (!out.deleted) sendError(ctx.res, "not_found", "bookmark not found");
    else sendJson(ctx.res, 200, out);
    return true;
  }
  return false;
};

const handlePutTags = async (rawId: string, ctx: RouteCtx): Promise<void> => {
  const id = decodeBookmarkId(rawId);
  if (id === null) {
    sendError(ctx.res, "bad_request", "invalid bookmark id");
    return;
  }
  const body = await decodeJsonWith(ctx.req, ctx.res, Schema.decodeUnknownOption(UpdateTagsRequest));
  if (body === null) return;
  const out = await ctx.handlers.updateTags(id, body);
  if (out === null) sendError(ctx.res, "not_found", "bookmark not found");
  else sendJson(ctx.res, 200, out);
};

const handleDeleteTag = async (rawId: string, rawTag: string, ctx: RouteCtx): Promise<void> => {
  const id = decodeBookmarkId(rawId);
  if (id === null) {
    sendError(ctx.res, "bad_request", "invalid bookmark id");
    return;
  }
  const out = await ctx.handlers.deleteTag(id, decodeURIComponent(rawTag));
  if (out === null) sendError(ctx.res, "not_found", "bookmark not found");
  else sendJson(ctx.res, 200, out);
};

const routeSingleBookmark = async (method: string, pathname: string, ctx: RouteCtx): Promise<boolean> => {
  const itemMatch = /^\/v1\/bookmarks\/([^/]+)$/.exec(pathname);
  if (itemMatch?.[1] === undefined) return false;
  const id = decodeBookmarkId(itemMatch[1]);
  if (id === null) {
    sendError(ctx.res, "bad_request", "invalid bookmark id");
    return true;
  }
  return handleBookmarkSingle(method, id, ctx);
};

const routeBookmarkTag = async (method: string, pathname: string, ctx: RouteCtx): Promise<boolean> => {
  const tagsMatch = /^\/v1\/bookmarks\/([^/]+)\/tags$/.exec(pathname);
  if (method === "PUT" && tagsMatch?.[1] !== undefined) {
    await handlePutTags(tagsMatch[1], ctx);
    return true;
  }
  const tagItemMatch = /^\/v1\/bookmarks\/([^/]+)\/tags\/([^/]+)$/.exec(pathname);
  if (method === "DELETE" && tagItemMatch?.[1] !== undefined && tagItemMatch[2] !== undefined) {
    await handleDeleteTag(tagItemMatch[1], tagItemMatch[2], ctx);
    return true;
  }
  return false;
};

const routeDynamic = async (method: string, pathname: string, ctx: RouteCtx): Promise<boolean> => {
  if (await routeSingleBookmark(method, pathname, ctx)) return true;
  return routeBookmarkTag(method, pathname, ctx);
};

const requiresAuth = (method: string, pathname: string): boolean => method !== "OPTIONS" && pathname !== "/health";

const parseRequestMeta = (req: IncomingMessage) => {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  return { method, url, pathname };
};

const dispatchRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
  handlers: HttpApiHandlers,
  options: HttpServerOptions,
): Promise<void> => {
  const { method, url, pathname } = parseRequestMeta(req);
  if (requiresAuth(method, pathname) && !isAuthorized(req, options.authToken ?? null)) {
    sendError(res, "unauthorized", "missing or invalid bearer token");
    return;
  }
  if (pathname === "/mcp") {
    await routeMcp(method, req, res, options.mcp);
    return;
  }

  const ctx: RouteCtx = { url, req, res, handlers };
  const staticFn = STATIC_ROUTES.get(`${method} ${pathname}`);
  if (staticFn !== undefined) {
    await staticFn(ctx);
    return;
  }
  if (await routeDynamic(method, pathname, ctx)) return;
  sendError(res, "not_found", `route not found: ${method} ${pathname}`);
};

export const createHttpServer = (handlers: HttpApiHandlers, options: HttpServerOptions = {}): Server =>
  createServer((req, res) => {
    void dispatchRequest(req, res, handlers, options).catch((err: unknown) => {
      sendError(res, "internal", err instanceof Error ? err.message : String(err));
    });
  });
