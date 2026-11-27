import { resolve } from "node:path";
import { Layer, Logger, ManagedRuntime } from "effect";
import { PlaywrightCaptureLive, loginToX } from "./adapters/browser/playwright.ts";
import { cronStatus, installCron, uninstallCron } from "./adapters/cron/launchd.ts";
import { OllamaEmbedderLive, OpenAiEmbedderLive } from "./adapters/embedder/live.ts";
import { FxTwitterHydratorLive } from "./adapters/fxtwitter/client.ts";
import { createHttpServer, type HttpApiHandlers } from "./adapters/http/server.ts";
import { runStdioMcpServer } from "./adapters/mcp/server.ts";
import { OramaSearchIndexLive } from "./adapters/orama/index.ts";
import { SqliteBookmarkStoreLive } from "./adapters/sqlite/store.ts";
import { hydratePending, ingestBookmarks, reindexAll, syncBookmarks } from "./control/ingest.ts";
import {
  deleteBookmark,
  deleteTag,
  getBookmark,
  getHealth,
  getIndexStats,
  listBookmarks,
  pruneBookmarks,
  updateTags,
} from "./control/manage.ts";
import { searchBookmarks } from "./control/search.ts";
import type { SearchFilters, SearchMode } from "./domain/api.ts";
import { decodeBookmarkId } from "./domain/bookmark.ts";
import { decodeAppEnv, type AppEnv } from "./domain/env.ts";
import type { CaptureSource } from "./ports/capture.ts";
import type { Embedder } from "./ports/embedder.ts";
import type { Hydrator } from "./ports/hydrator.ts";
import type { SearchIndex } from "./ports/search-index.ts";
import type { BookmarkStore } from "./ports/store.ts";

type AppServices = BookmarkStore | SearchIndex | Embedder | Hydrator | CaptureSource;

const PROJECT_ROOT = resolve(import.meta.dirname, "..");

export const buildEmbedderLayer = (env: AppEnv): Layer.Layer<Embedder> =>
  env.embedProvider === "openai" && env.openaiApiKey !== null
    ? OpenAiEmbedderLive({
        baseUrl: env.openaiBaseUrl,
        apiKey: env.openaiApiKey,
        model: env.embedModel,
        dimensions: env.embedDims,
      })
    : OllamaEmbedderLive({ baseUrl: env.ollamaUrl, model: env.embedModel, dimensions: env.embedDims });

const buildAppLayer = (env: AppEnv) =>
  Layer.mergeAll(
    SqliteBookmarkStoreLive(env.dbPath),
    OramaSearchIndexLive(env.oramaPath, env.embedDims),
    buildEmbedderLayer(env),
    FxTwitterHydratorLive(env.minRequestMs),
    PlaywrightCaptureLive(env.profileDir, true),
    Logger.layer([Logger.consoleJson]),
  );

interface ParsedCli {
  readonly values: Map<string, string>;
  readonly booleans: Set<string>;
  readonly pos: ReadonlyArray<string>;
}

export const parseCliArgs = (argv: ReadonlyArray<string>): ParsedCli => {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const pos: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i] ?? "";
    if (tok === "--") {
      i++;
      continue;
    }
    if (!tok.startsWith("--")) {
      pos.push(tok);
      i++;
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key, next);
      i += 2;
    } else {
      booleans.add(key);
      i++;
    }
  }
  return { values, booleans, pos };
};

const numFlag = (cli: ParsedCli, key: string): number | undefined => {
  const val = cli.values.get(key);
  if (val === undefined) return undefined;
  const n = Number(val);
  return Number.isFinite(n) ? n : undefined;
};

const makeHandlers = (runtime: ManagedRuntime.ManagedRuntime<AppServices, unknown>): HttpApiHandlers => ({
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
});

const runServe = async (env: AppEnv, handlers: HttpApiHandlers): Promise<number> => {
  const server = createHttpServer(handlers);
  await new Promise<void>((res) => server.listen(env.httpPort, env.httpHost, () => res()));
  console.error(`x-bookmarks API listening on http://${env.httpHost}:${env.httpPort}`);
  await new Promise<void>((res) => {
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.once(sig, () => server.close(() => res()));
    }
  });
  return 0;
};

const parseMode = (raw: string | undefined): SearchMode | undefined =>
  raw === "hybrid" || raw === "fulltext" || raw === "vector" ? raw : undefined;

export const buildSearchFilters = (cli: ParsedCli): SearchFilters | undefined => {
  const author = cli.values.get("author");
  const domain = cli.values.get("domain");
  const folder = cli.values.get("folder");
  const tag = cli.values.get("tag");
  const filters: SearchFilters = {
    ...(author !== undefined ? { author } : {}),
    ...(domain !== undefined ? { domain } : {}),
    ...(folder !== undefined ? { folder } : {}),
    ...(tag !== undefined ? { tag } : {}),
  };
  return Object.keys(filters).length > 0 ? filters : undefined;
};

interface CommandCtx {
  readonly cli: ParsedCli;
  readonly env: AppEnv;
  readonly runtime: ManagedRuntime.ManagedRuntime<AppServices, unknown>;
  readonly handlers: HttpApiHandlers;
}

const printJson = (value: unknown): number => {
  console.log(JSON.stringify(value, null, 2));
  return 0;
};

type CommandFn = (ctx: CommandCtx) => Promise<number>;

const COMMANDS = new Map<string, CommandFn>([
  ["serve", ({ env, handlers }) => runServe(env, handlers)],
  [
    "mcp",
    async ({ handlers }) => {
      runStdioMcpServer(handlers);
      await new Promise<void>((res) => process.stdin.once("end", () => res()));
      return 0;
    },
  ],
  [
    "sync",
    async ({ cli, handlers }) => {
      const maxItems = numFlag(cli, "max");
      const hydrateLimit = numFlag(cli, "limit");
      return printJson(
        await handlers.sync({
          full: cli.booleans.has("full"),
          threads: cli.booleans.has("threads"),
          embed: !cli.booleans.has("no-embed"),
          ...(maxItems !== undefined ? { maxItems } : {}),
          ...(hydrateLimit !== undefined ? { hydrateLimit } : {}),
        }),
      );
    },
  ],
  [
    "hydrate",
    async ({ cli, runtime }) =>
      printJson(
        await runtime.runPromise(
          hydratePending({
            limit: numFlag(cli, "limit") ?? 200,
            includeErrors: cli.booleans.has("retry-errors"),
            fetchThreads: cli.booleans.has("threads"),
            embed: !cli.booleans.has("no-embed"),
          }),
        ),
      ),
  ],
  [
    "reindex",
    async ({ cli, handlers }) => printJson(await handlers.reindex({ embedMissing: !cli.booleans.has("no-embed") })),
  ],
  [
    "embed",
    async ({ cli, handlers }) => printJson(await handlers.reindex({ embedMissing: !cli.booleans.has("no-embed") })),
  ],
  [
    "add",
    async ({ cli, handlers }) => {
      const folderName = cli.values.get("folder");
      return printJson(
        await handlers.ingest({
          refs: [...cli.pos],
          hydrate: !cli.booleans.has("no-hydrate"),
          embed: !cli.booleans.has("no-embed"),
          threads: cli.booleans.has("threads"),
          ...(folderName !== undefined ? { folderName } : {}),
        }),
      );
    },
  ],
  [
    "prune",
    async ({ cli, handlers }) => {
      const reason = cli.values.get("reason");
      return printJson(
        await handlers.prune({
          ids: [...cli.pos],
          hard: cli.booleans.has("hard"),
          ...(reason !== undefined ? { reason } : {}),
        }),
      );
    },
  ],
  [
    "search",
    async ({ cli, handlers }) => {
      const mode = parseMode(cli.values.get("mode"));
      const limit = numFlag(cli, "limit");
      const filters = buildSearchFilters(cli);
      return printJson(
        await handlers.search({
          query: cli.pos.join(" "),
          ...(mode !== undefined ? { mode } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(filters !== undefined ? { filters } : {}),
        }),
      );
    },
  ],
  [
    "list",
    async ({ cli, handlers }) => {
      const by = cli.values.get("by") === "created" ? "created" : "bookmarked";
      const limit = numFlag(cli, "limit");
      return printJson(await handlers.list({ by, ...(limit !== undefined ? { limit } : {}) }));
    },
  ],
  [
    "tag",
    async ({ cli, handlers }) => {
      const [action, rawId, ...tags] = cli.pos;
      const id = rawId === undefined ? null : decodeBookmarkId(rawId);
      if (id === null) {
        console.error("Usage: pnpm tag <add|rm> <bookmark-id> <tags...>");
        return 1;
      }
      const res =
        action === "rm" ? await handlers.deleteTag(id, tags[0] ?? "") : await handlers.updateTags(id, { tags });
      return printJson(res);
    },
  ],
  ["stats", async ({ handlers }) => printJson(await handlers.stats())],
]);

export const runCronCommand = (
  cli: ParsedCli,
  fns: {
    readonly install: typeof installCron;
    readonly uninstall: typeof uninstallCron;
    readonly status: typeof cronStatus;
  } = { install: installCron, uninstall: uninstallCron, status: cronStatus },
): number => {
  const sub = cli.pos[0] ?? "status";
  if (sub === "install") {
    const every = cli.values.get("every");
    console.log(
      fns.install({
        projectRoot: PROJECT_ROOT,
        ...(every !== undefined ? { every } : {}),
        runAtLoad: cli.booleans.has("run-at-load"),
        threads: !cli.booleans.has("no-threads"),
      }),
    );
    return 0;
  }
  console.log(sub === "uninstall" ? fns.uninstall() : fns.status(PROJECT_ROOT));
  return 0;
};

export const dispatchCommand = async (cmd: string, ctx: CommandCtx): Promise<number | null> => {
  const fn = COMMANDS.get(cmd);
  if (fn === undefined) return null;
  return fn(ctx);
};

export const start = async (argv: ReadonlyArray<string>): Promise<number> => {
  const [cmd = "help", ...rest] = argv;
  const cli = parseCliArgs(rest);
  const env = decodeAppEnv(process.env, PROJECT_ROOT);

  if (cmd === "login") {
    const ok = await loginToX(env.profileDir);
    console.log(ok ? "Login confirmed." : "Browser closed before bookmarks loaded.");
    return ok ? 0 : 1;
  }
  if (cmd === "cron") return runCronCommand(cli);

  if (!COMMANDS.has(cmd)) {
    console.log(
      "Commands: login | sync | hydrate | reindex | embed | search | list | add | prune | tag | stats | serve | mcp | cron",
    );
    return 0;
  }

  const runtime = ManagedRuntime.make(buildAppLayer(env));
  try {
    return (await dispatchCommand(cmd, { cli, env, runtime, handlers: makeHandlers(runtime) })) ?? 0;
  } finally {
    await runtime.dispose();
  }
};

if (import.meta.main) {
  const code = await start(process.argv.slice(2));
  process.exit(code);
}
