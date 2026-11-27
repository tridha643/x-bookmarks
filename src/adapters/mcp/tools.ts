import { type JsonSchema, Result, Schema } from "effect";
import type {
  BookmarkApiHandlers,
  BookmarkPage,
  DeleteBookmarkResponse,
  IngestBookmarksResponse,
  PruneBookmarksResponse,
  ReindexReport,
  SearchResponse,
  SyncReport,
  TagUpdateResponse,
} from "../../domain/api.ts";
import { parseTweetRef, type BookmarkDetail, type BookmarkId, type IndexStats } from "../../domain/bookmark.ts";

/** A tool failure the calling model can act on; its message is returned verbatim with `isError: true`. */
export class ToolError extends Error {}

interface ToolAnnotations {
  readonly title: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

interface BookmarkStatsResult extends IndexStats {
  readonly embeddingModel: string;
  readonly embeddingDims: number;
}

type StructuredResult =
  | SearchResponse
  | BookmarkDetail
  | BookmarkPage
  | IngestBookmarksResponse
  | DeleteBookmarkResponse
  | PruneBookmarksResponse
  | TagUpdateResponse
  | SyncReport
  | ReindexReport
  | BookmarkStatsResult;

export interface ToolOutput {
  readonly text: string;
  readonly structured: StructuredResult;
}

export interface McpTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema.JsonSchema;
  readonly annotations: ToolAnnotations;
  readonly call: (rawArgs: unknown, handlers: BookmarkApiHandlers) => Promise<ToolOutput>;
}

interface ToolSpec<A> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly hints: Omit<ToolAnnotations, "title">;
  readonly input: Schema.Decoder<A>;
  readonly run: (args: A, handlers: BookmarkApiHandlers) => Promise<ToolOutput>;
}

const defineTool = <A>(spec: ToolSpec<A>): McpTool => {
  const decode = Schema.decodeUnknownResult(spec.input);
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: Schema.toJsonSchemaDocument(spec.input).schema,
    annotations: { title: spec.title, ...spec.hints },
    call: async (rawArgs, handlers) => {
      const decoded = decode(rawArgs, { errors: "all", onExcessProperty: "error" });
      if (Result.isFailure(decoded)) {
        throw new ToolError(`Invalid arguments for ${spec.name}: ${decoded.failure.message}`);
      }
      return spec.run(decoded.success, handlers);
    },
  };
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const LOCAL_UPDATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const jsonResult = (value: StructuredResult): ToolOutput => ({ text: JSON.stringify(value), structured: value });

const notFound = (id: BookmarkId): ToolError =>
  new ToolError(`Bookmark ${id} not found. Use search_bookmarks or list_bookmarks to find a valid bookmark id.`);

const requireFound = <A>(id: BookmarkId, value: A | null): A => {
  if (value === null) throw notFound(id);
  return value;
};

const bookmarkIdOf = (ref: string): BookmarkId => {
  const parsed = parseTweetRef(ref);
  if (parsed === null) {
    throw new ToolError(
      `"${ref}" is not a bookmark id. Pass a numeric tweet id like "1880000000000000000" or a status URL like "https://x.com/user/status/1880000000000000000".`,
    );
  }
  return parsed.id;
};

const toEpochSeconds = (field: string, iso: string): number => {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new ToolError(`${field} must be an ISO 8601 date such as "2026-01-15" or "2026-01-15T10:00:00Z".`);
  }
  return Math.floor(ms / 1000);
};

const optionalEpoch = (field: string, iso: string | undefined): number | undefined =>
  iso === undefined ? undefined : toEpochSeconds(field, iso);

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));

const integerBetween = (minimum: number, maximum: number) =>
  Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum, maximum }));

const BookmarkRef = NonEmptyString.annotate({
  description: "Bookmark tweet id, or the post's x.com / twitter.com status URL.",
  examples: ["1880000000000000000", "https://x.com/alice/status/1880000000000000000"],
});

const AuthorFilter = NonEmptyString.annotate({
  description: "Only bookmarks posted by this X handle; a leading @ is ignored and matching is case-insensitive.",
  examples: ["alice"],
});
const DomainFilter = NonEmptyString.annotate({
  description: "Only bookmarks linking to this domain; a leading www. is ignored.",
  examples: ["github.com"],
});
const FolderFilter = NonEmptyString.annotate({
  description: "Only bookmarks in this X bookmark folder, by folder name or folder id.",
  examples: ["AI"],
});
const TagFilter = NonEmptyString.annotate({
  description: "Only bookmarks carrying this tag (see add_bookmark_tags).",
  examples: ["agents"],
});

const TagList = Schema.NonEmptyArray(NonEmptyString.check(Schema.isMaxLength(64)))
  .check(Schema.isMaxLength(20))
  .annotate({
    description:
      "Tags to apply. Each is normalized to a lowercase slug: spaces and punctuation become '-', so 'AI Agents' is stored as 'ai-agents'.",
    examples: [["ai-agents", "effect"]],
  });

const SearchArgs = Schema.Struct({
  query: NonEmptyString.annotate({
    description: "Natural-language question or keywords to match against post text, X Articles, quotes, and cards.",
    examples: ["durable workflow engines in TypeScript"],
  }),
  mode: Schema.optionalKey(
    Schema.Literals(["hybrid", "fulltext", "vector"]).annotate({
      description:
        "'hybrid' blends keyword (BM25) and semantic ranking, 'fulltext' matches keywords only, 'vector' ranks by meaning only. Hybrid falls back to fulltext when the embedder is offline.",
      default: "hybrid",
    }),
  ),
  limit: Schema.optionalKey(integerBetween(1, 50).annotate({ description: "Maximum hits to return.", default: 10 })),
  minSimilarity: Schema.optionalKey(
    Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })).annotate({
      description: "Minimum cosine similarity for semantic matches in 'hybrid' and 'vector' modes; lower returns more.",
      default: 0.45,
    }),
  ),
  author: Schema.optionalKey(AuthorFilter),
  domain: Schema.optionalKey(DomainFilter),
  folder: Schema.optionalKey(FolderFilter),
  tag: Schema.optionalKey(TagFilter),
  hasArticle: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "true keeps only long-form X Articles; false excludes them." }),
  ),
  createdAfter: Schema.optionalKey(
    NonEmptyString.annotate({
      description: "Only posts created at or after this ISO 8601 date or date-time.",
      examples: ["2026-01-01"],
    }),
  ),
  createdBefore: Schema.optionalKey(
    NonEmptyString.annotate({
      description: "Only posts created at or before this ISO 8601 date or date-time.",
      examples: ["2026-06-30T23:59:59Z"],
    }),
  ),
});

const searchTool = defineTool({
  name: "search_bookmarks",
  title: "Search bookmarks",
  description:
    "Find saved X bookmarks relevant to a topic or question, ranked by keyword and semantic similarity. Use this first when the user asks what they bookmarked about something; use list_bookmarks to browse without a query. Returns hits ({ score, snippet, bookmark summary }), the mode actually used, and the total match count. Call get_bookmark with a hit's bookmark.id for full text.",
  hints: READ_ONLY,
  input: SearchArgs,
  run: async (a, h) =>
    jsonResult(
      await h.search({
        query: a.query,
        mode: a.mode,
        limit: a.limit,
        similarity: a.minSimilarity,
        filters: {
          author: a.author,
          domain: a.domain,
          folder: a.folder,
          tag: a.tag,
          hasArticle: a.hasArticle,
          sinceTimestamp: optionalEpoch("createdAfter", a.createdAfter),
          untilTimestamp: optionalEpoch("createdBefore", a.createdBefore),
        },
      }),
    ),
});

const formatArticleSection = (b: BookmarkDetail): string | null =>
  b.articleTitle !== null || b.articleText !== null
    ? `## Article: ${b.articleTitle ?? "(untitled)"}\n\n${b.articleText ?? ""}`
    : null;

const formatDetail = (b: BookmarkDetail): string => {
  const quoteSection = b.quoteText !== null ? `## Quoted (@${b.quoteAuthor ?? "unknown"})\n\n${b.quoteText}` : null;
  const linksSection = b.urls.length === 0 ? null : `## Links\n${b.urls.map((u) => `- ${u}`).join("\n")}`;
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

const getTool = defineTool({
  name: "get_bookmark",
  title: "Get bookmark",
  description:
    "Read one bookmark in full: post text, X Article body as Markdown, quoted post, outbound links, tags, folders, engagement counts, and thread posts. Use after search_bookmarks or list_bookmarks returns an id. The text content is readable Markdown capped at 28,000 characters; structured content holds every field.",
  hints: READ_ONLY,
  input: Schema.Struct({ id: BookmarkRef }),
  run: async (a, h) => {
    const id = bookmarkIdOf(a.id);
    const detail = requireFound(id, await h.getById(id));
    return { text: formatDetail(detail), structured: detail };
  },
});

const listTool = defineTool({
  name: "list_bookmarks",
  title: "List bookmarks",
  description:
    "Browse bookmarks newest first, optionally narrowed by author, linked domain, folder, or tag. Use for 'what did I save recently' or exhaustive walks; use search_bookmarks to rank by relevance. Returns items (bookmark summaries) and nextCursor; pass nextCursor back as cursor for the next page, and stop when it is null.",
  hints: READ_ONLY,
  input: Schema.Struct({
    sortBy: Schema.optionalKey(
      Schema.Literals(["bookmarked", "created"]).annotate({
        description: "'bookmarked' orders by when you saved the post; 'created' orders by when the post was published.",
        default: "bookmarked",
      }),
    ),
    author: Schema.optionalKey(AuthorFilter),
    domain: Schema.optionalKey(DomainFilter),
    folder: Schema.optionalKey(FolderFilter),
    tag: Schema.optionalKey(TagFilter),
    limit: Schema.optionalKey(integerBetween(1, 100).annotate({ description: "Page size.", default: 20 })),
    cursor: Schema.optionalKey(
      Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)).annotate({
        description:
          "Opaque paging cursor: the nextCursor value from the previous list_bookmarks call with the same sortBy and filters. Omit for the first page.",
      }),
    ),
  }),
  run: async (a, h) =>
    jsonResult(
      await h.list({
        by: a.sortBy,
        author: a.author,
        domain: a.domain,
        folder: a.folder,
        tag: a.tag,
        limit: a.limit,
        cursor: a.cursor,
      }),
    ),
});

const addTool = defineTool({
  name: "add_bookmarks",
  title: "Add bookmarks",
  description:
    "Save X posts into the local bookmark library by URL or id, fetch their full content from FxTwitter, and index them for search. Does not bookmark anything on X itself. Posts already saved are counted as existing; posts previously deleted with delete_bookmarks are skipped unless they were deleted with allowResync. Returns added, existing, skipped, hydrated, and indexed counts plus the saved ids.",
  hints: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: Schema.Struct({
    refs: Schema.NonEmptyArray(BookmarkRef)
      .check(Schema.isMaxLength(100))
      .annotate({ description: "Posts to save, as status URLs or numeric tweet ids." }),
    hydrate: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: "Fetch full post, article, and quote content from FxTwitter after saving.",
        default: true,
      }),
    ),
    embed: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: "Compute semantic embeddings so the posts appear in vector search.",
        default: true,
      }),
    ),
    includeThreads: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: "Also fetch the author's self-reply thread for each post.",
        default: false,
      }),
    ),
    folder: Schema.optionalKey(
      NonEmptyString.annotate({ description: "Folder name to file the saved posts under.", examples: ["AI"] }),
    ),
  }),
  run: async (a, h) =>
    jsonResult(
      await h.ingest({
        refs: a.refs,
        hydrate: a.hydrate,
        embed: a.embed,
        threads: a.includeThreads,
        folderName: a.folder,
      }),
    ),
});

const deleteTool = defineTool({
  name: "delete_bookmarks",
  title: "Delete bookmarks",
  description:
    "Permanently remove bookmarks from the local library and search index. Does not unbookmark them on X. By default each id is remembered so later syncs do not re-import it; set allowResync to let a future sync bring it back. Returns deletedIds and notFoundIds.",
  hints: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  input: Schema.Struct({
    ids: Schema.NonEmptyArray(BookmarkRef)
      .check(Schema.isMaxLength(500))
      .annotate({ description: "Bookmarks to delete, as tweet ids or status URLs." }),
    allowResync: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: "true skips the do-not-reimport record, so a later sync_bookmarks may restore these posts.",
        default: false,
      }),
    ),
    reason: Schema.optionalKey(
      NonEmptyString.check(Schema.isMaxLength(500)).annotate({
        description: "Why the bookmarks were removed, kept with the do-not-reimport record.",
        examples: ["duplicate"],
      }),
    ),
  }),
  run: async (a, h) =>
    jsonResult(await h.prune({ ids: a.ids.map(bookmarkIdOf), hard: a.allowResync, reason: a.reason })),
});

const addTagsTool = defineTool({
  name: "add_bookmark_tags",
  title: "Add bookmark tags",
  description:
    "Attach one or more tags to a bookmark so it can be filtered by tag in search_bookmarks and list_bookmarks. Existing tags are kept and re-adding a tag is a no-op. Returns the bookmark's full tag list.",
  hints: LOCAL_UPDATE,
  input: Schema.Struct({ id: BookmarkRef, tags: TagList }),
  run: async (a, h) => {
    const id = bookmarkIdOf(a.id);
    return jsonResult(requireFound(id, await h.updateTags(id, { tags: a.tags })));
  },
});

const removeTagsTool = defineTool({
  name: "remove_bookmark_tags",
  title: "Remove bookmark tags",
  description:
    "Detach tags from a bookmark; the bookmark itself is kept. Tags it does not carry are ignored. Returns the bookmark's remaining tag list.",
  hints: LOCAL_UPDATE,
  input: Schema.Struct({ id: BookmarkRef, tags: TagList }),
  run: async (a, h) => {
    const id = bookmarkIdOf(a.id);
    const [first, ...rest] = a.tags;
    let out = requireFound(id, await h.deleteTag(id, first));
    for (const tag of rest) out = requireFound(id, await h.deleteTag(id, tag));
    return jsonResult(out);
  },
});

const syncTool = defineTool({
  name: "sync_bookmarks",
  title: "Sync bookmarks from X",
  description:
    "Pull new bookmarks from the signed-in X account with a headless browser, then fetch content, embed, and index them. Can take several minutes and needs a prior `pnpm login`. A daily sync already runs on a schedule, so call this only when the user wants the latest bookmarks right now. Returns captured, added, hydration, embedding, and indexing counts and why capture stopped.",
  hints: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  input: Schema.Struct({
    full: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: "Scroll the entire bookmark timeline instead of stopping at already-saved posts.",
        default: false,
      }),
    ),
    includeThreads: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "Also fetch each author's self-reply thread.", default: true }),
    ),
    embed: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "Compute semantic embeddings for newly fetched posts.", default: true }),
    ),
    maxItems: Schema.optionalKey(
      integerBetween(1, 10_000).annotate({ description: "Stop capturing after this many bookmarks. Omit for no cap." }),
    ),
    hydrateLimit: Schema.optionalKey(
      integerBetween(0, 1000).annotate({
        description: "Maximum posts whose content is fetched in this run; 0 only captures.",
        default: 200,
      }),
    ),
  }),
  run: async (a, h) =>
    jsonResult(
      await h.sync({
        full: a.full,
        threads: a.includeThreads,
        embed: a.embed,
        maxItems: a.maxItems,
        hydrateLimit: a.hydrateLimit,
      }),
    ),
});

const reindexTool = defineTool({
  name: "reindex_bookmarks",
  title: "Rebuild search index",
  description:
    "Re-parse every stored post payload and rebuild the search index from the local database. Use when search results look stale or incomplete; normal adds, deletes, and syncs keep the index current. Returns reparsed, embedded, and indexed counts.",
  hints: LOCAL_UPDATE,
  input: Schema.Struct({
    embedMissing: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "Compute embeddings for posts that have none yet.", default: true }),
    ),
  }),
  run: async (a, h) => jsonResult(await h.reindex({ embedMissing: a.embedMissing })),
});

const statsTool = defineTool({
  name: "get_bookmark_stats",
  title: "Get bookmark stats",
  description:
    "Summarize the bookmark library: totals for bookmarks, X Articles, threads, deleted posts, and embedded vectors; counts by hydration status and source; top authors and domains; and the embedding model in use.",
  hints: READ_ONLY,
  input: Schema.Record(Schema.String, Schema.Never),
  run: async (_a, h) => {
    const [stats, health] = await Promise.all([h.stats(), h.health()]);
    return jsonResult({ ...stats, embeddingModel: health.embeddingModel, embeddingDims: health.embeddingDims });
  },
});

export const TOOLS: ReadonlyArray<McpTool> = [
  searchTool,
  getTool,
  listTool,
  addTool,
  deleteTool,
  addTagsTool,
  removeTagsTool,
  syncTool,
  reindexTool,
  statsTool,
];
