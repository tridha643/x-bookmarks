import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { count, create, insert, insertMultiple, remove, search, type AnyOrama } from "@orama/orama";
import { persistToFile, restoreFromFile } from "@orama/plugin-data-persistence/server";
import { Effect, Layer, Schema } from "effect";
import type { SearchFilters } from "../../domain/api.ts";
import { BookmarkId } from "../../domain/bookmark.ts";
import {
  SearchIndex,
  SearchIndexError,
  type SearchDocumentInput,
  type SearchIndexHit,
  type SearchIndexQuery,
  type SearchIndexShape,
} from "../../ports/search-index.ts";

const makeOramaSchema = (dims: number) =>
  ({
    id: "string",
    url: "string",
    bookmarkSeq: "number",
    authorHandle: "string",
    authorName: "string",
    createdTimestamp: "number",
    text: "string",
    articleTitle: "string",
    articleText: "string",
    quoteText: "string",
    cardText: "string",
    extraText: "string",
    domains: "string[]",
    tags: "string[]",
    folders: "string[]",
    hasArticle: "boolean",
    embedding: `vector[${dims}]`,
  }) as const;

const toOramaDoc = (input: SearchDocumentInput) => ({
  id: input.bookmark.id,
  url: input.bookmark.url,
  bookmarkSeq: input.bookmark.bookmarkSeq,
  authorHandle: input.bookmark.authorHandle.toLowerCase(),
  authorName: input.bookmark.authorName,
  createdTimestamp: input.bookmark.createdTimestamp,
  text: input.bookmark.text,
  articleTitle: input.bookmark.articleTitle,
  articleText: input.bookmark.articleText,
  quoteText: input.bookmark.quoteText,
  cardText: input.bookmark.cardText,
  extraText: input.bookmark.extraText,
  domains: [...input.bookmark.domains],
  tags: [...input.bookmark.tags],
  folders: [...input.bookmark.folders],
  hasArticle: input.bookmark.hasArticle,
  embedding: [...input.vector],
});

const timestampFilter = (since: number | undefined, until: number | undefined): Record<string, unknown> | null => {
  if (since !== undefined && until !== undefined) return { between: [since, until] };
  if (since !== undefined) return { gte: since };
  if (until !== undefined) return { lte: until };
  return null;
};

const buildWhere = (filters: SearchFilters | undefined): Record<string, unknown> | undefined => {
  if (filters === undefined) return undefined;
  const where: Record<string, unknown> = {};
  if (filters.author !== undefined) where.authorHandle = filters.author.replace(/^@/, "").toLowerCase();
  if (filters.domain !== undefined) where.domains = filters.domain.replace(/^www\./, "").toLowerCase();
  if (filters.folder !== undefined) where.folders = filters.folder;
  if (filters.tag !== undefined) where.tags = filters.tag.toLowerCase();
  if (filters.hasArticle !== undefined) where.hasArticle = filters.hasArticle;
  const ts = timestampFilter(filters.sinceTimestamp, filters.untilTimestamp);
  if (ts !== null) where.createdTimestamp = ts;
  return Object.keys(where).length > 0 ? where : undefined;
};

const BOOSTS = {
  articleTitle: 4,
  text: 3,
  authorHandle: 2,
  cardText: 2,
  quoteText: 1.5,
  extraText: 1.5,
  articleText: 1,
};

const tryOrama = <A>(operation: string, fn: () => Promise<A>): Effect.Effect<A, SearchIndexError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) => new SearchIndexError({ operation, cause }),
  });

const createFreshDb = (dims: number): AnyOrama => create({ schema: makeOramaSchema(dims) });

const loadOrCreateDb = async (snapshotPath: string | null, dims: number): Promise<AnyOrama> => {
  if (snapshotPath !== null && existsSync(snapshotPath)) {
    try {
      return await restoreFromFile("binary", snapshotPath);
    } catch {
      return createFreshDb(dims);
    }
  }
  return createFreshDb(dims);
};

const executeOramaSearch = (db: AnyOrama, query: SearchIndexQuery) => {
  const where = buildWhere(query.filters);
  const baseParams = { limit: query.limit, ...(where !== undefined ? { where } : {}) };
  if (query.mode === "vector" && query.vector !== null) {
    return search(db, {
      ...baseParams,
      mode: "vector",
      vector: { value: [...query.vector], property: "embedding" },
      similarity: query.similarity,
    });
  }
  if (query.mode === "hybrid" && query.vector !== null && query.term.length > 0) {
    return search(db, {
      ...baseParams,
      mode: "hybrid",
      term: query.term,
      vector: { value: [...query.vector], property: "embedding" },
      similarity: query.similarity,
      boost: BOOSTS,
    });
  }
  return search(db, { ...baseParams, mode: "fulltext", term: query.term, boost: BOOSTS });
};

const readMtimeMs = (path: string | null): number | null => {
  if (path === null || !existsSync(path)) return null;
  return statSync(path).mtimeMs;
};

export const makeOramaSearchIndex = (
  initialDb: AnyOrama,
  dims: number,
  snapshotPath: string | null,
): SearchIndexShape => {
  let db: AnyOrama = initialDb;
  let loadedMtimeMs = readMtimeMs(snapshotPath);

  const ensureFresh = async (): Promise<void> => {
    const diskMtime = readMtimeMs(snapshotPath);
    if (diskMtime !== null && diskMtime !== loadedMtimeMs) {
      db = await loadOrCreateDb(snapshotPath, dims);
      loadedMtimeMs = diskMtime;
    }
  };

  return {
    upsert: (doc) =>
      tryOrama("upsert", async () => {
        await ensureFresh();
        await Promise.resolve(remove(db, doc.bookmark.id)).catch(() => false);
        await insert(db, toOramaDoc(doc));
      }),

    remove: (id) =>
      tryOrama("remove", async () => {
        await ensureFresh();
        try {
          return await Promise.resolve(remove(db, id));
        } catch {
          return false;
        }
      }),

    search: (query) =>
      tryOrama("search", async () => {
        await ensureFresh();
        const raw = await executeOramaSearch(db, query);
        const hits: SearchIndexHit[] = raw.hits.map((h) => ({
          id: Schema.decodeSync(BookmarkId)(String(h.id)),
          score: h.score,
        }));
        return { total: raw.count, hits };
      }),

    rebuild: (docs) =>
      tryOrama("rebuild", async () => {
        const next = createFreshDb(dims);
        if (docs.length > 0) await insertMultiple(next, docs.map(toOramaDoc));
        db = next;
        return docs.length;
      }),

    persist: () =>
      tryOrama("persist", async () => {
        if (snapshotPath === null) return;
        mkdirSync(dirname(snapshotPath), { recursive: true });
        const tmpPath = `${snapshotPath}.${process.pid}.tmp`;
        await persistToFile(db, "binary", tmpPath);
        renameSync(tmpPath, snapshotPath);
        loadedMtimeMs = readMtimeMs(snapshotPath);
      }),

    count: () =>
      tryOrama("count", async () => {
        await ensureFresh();
        return count(db);
      }),
  };
};

export const OramaSearchIndexLive = (
  snapshotPath: string | null,
  dims: number,
): Layer.Layer<SearchIndex, SearchIndexError> =>
  Layer.effect(
    SearchIndex,
    tryOrama("open", () => loadOrCreateDb(snapshotPath, dims)).pipe(
      Effect.map((db) => makeOramaSearchIndex(db, dims, snapshotPath)),
    ),
  );
