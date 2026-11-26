import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Effect, Layer, Option, Schema } from "effect";
import type { BookmarkPage, ListBookmarksQuery } from "../../domain/api.ts";
import {
  BookmarkId,
  HydrationSource,
  HydrationStatus,
  PARSER_VERSION,
  buildEmbeddingText,
  canOverwriteSource,
  computeContentHash,
  normalizeNonEmpty,
  type BookmarkDetail,
  type BookmarkSummary,
  type CapturedBookmark,
  type CountBucket,
  type FolderRef,
  type HydratedFields,
  type IndexStats,
  type IndexableBookmark,
  type ThreadPost,
} from "../../domain/bookmark.ts";
import {
  BookmarkStore,
  StoreError,
  type BookmarkStoreShape,
  type RawPayloadRecord,
  type StoredEmbedding,
  type UpsertBatchResult,
} from "../../ports/store.ts";

const RowSchema = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  bookmark_seq: Schema.Number,
  author_handle: Schema.NullOr(Schema.String),
  author_name: Schema.NullOr(Schema.String),
  created_at: Schema.NullOr(Schema.String),
  created_timestamp: Schema.NullOr(Schema.Number),
  replying_to_handle: Schema.NullOr(Schema.String),
  captured_at: Schema.String,
  capture_source: Schema.String,
  dom_text: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  article_title: Schema.NullOr(Schema.String),
  article_text: Schema.NullOr(Schema.String),
  quote_author: Schema.NullOr(Schema.String),
  quote_text: Schema.NullOr(Schema.String),
  card_title: Schema.NullOr(Schema.String),
  card_description: Schema.NullOr(Schema.String),
  card_url: Schema.NullOr(Schema.String),
  community_note: Schema.NullOr(Schema.String),
  extra_text: Schema.NullOr(Schema.String),
  urls_json: Schema.NullOr(Schema.String),
  domains: Schema.NullOr(Schema.String),
  likes: Schema.NullOr(Schema.Number),
  reposts: Schema.NullOr(Schema.Number),
  replies: Schema.NullOr(Schema.Number),
  bookmarks_count: Schema.NullOr(Schema.Number),
  views: Schema.NullOr(Schema.Number),
  lang: Schema.NullOr(Schema.String),
  hydration_status: Schema.String,
  hydration_source: Schema.NullOr(Schema.String),
  hydrated_at: Schema.NullOr(Schema.String),
});
type DbBookmarkRow = typeof RowSchema.Type;

const StringArraySchema = Schema.Array(Schema.String);
const NumberArraySchema = Schema.Array(Schema.Number);
const CountRowSchema = Schema.Struct({ c: Schema.Number });
const BucketRowSchema = Schema.Struct({ k: Schema.String, c: Schema.Number });
const IdRowSchema = Schema.Struct({ id: Schema.String });
const IdUrlRowSchema = Schema.Struct({ id: Schema.String, url: Schema.String });
const RawRowSchema = Schema.Struct({ id: Schema.String, raw_fx_json: Schema.String });
const TagRowSchema = Schema.Struct({ tag: Schema.String });
const FolderRowSchema = Schema.Struct({ folder_id: Schema.String, folder_name: Schema.NullOr(Schema.String) });
const ThreadRowSchema = Schema.Struct({
  post_id: Schema.String,
  position: Schema.Number,
  author_handle: Schema.NullOr(Schema.String),
  created_at: Schema.NullOr(Schema.String),
  text: Schema.String,
});
const EmbeddingRowSchema = Schema.Struct({
  model: Schema.String,
  dims: Schema.Number,
  content_hash: Schema.String,
  vector_json: Schema.String,
});
const ExistingMetaSchema = Schema.Struct({
  hydration_source: Schema.NullOr(Schema.String),
  dom_text: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  retry_count: Schema.Number,
});
const TableInfoRowSchema = Schema.Struct({ name: Schema.String });

const SELECT_ROW_COLS = `
  b.id, b.url, b.bookmark_seq, b.author_handle, b.author_name, b.created_at, b.created_timestamp,
  b.replying_to_handle, b.captured_at, b.capture_source, b.dom_text, b.text, b.article_title,
  b.article_text, b.quote_author, b.quote_text, b.card_title, b.card_description, b.card_url,
  b.community_note, b.extra_text, b.urls_json, b.domains, b.likes, b.reposts, b.replies,
  b.bookmarks_count, b.views, b.lang, b.hydration_status, b.hydration_source, b.hydrated_at
`;

const decodeStatus = (raw: string): HydrationStatus =>
  Option.getOrElse(Schema.decodeUnknownOption(HydrationStatus)(raw), () => "pending");

const decodeSource = (raw: string | null): HydrationSource | null =>
  raw === null ? null : Option.getOrNull(Schema.decodeUnknownOption(HydrationSource)(raw));

const parseStringListJson = (raw: string | null): string[] => {
  if (raw === null) return [];
  try {
    return [...Option.getOrElse(Schema.decodeUnknownOption(StringArraySchema)(JSON.parse(raw)), () => [])];
  } catch {
    return [];
  }
};

const parseDomains = (raw: string | null): string[] =>
  raw === null
    ? []
    : raw
        .split(/\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

const trySync = <A>(operation: string, fn: () => A): Effect.Effect<A, StoreError> =>
  Effect.try({ try: fn, catch: (cause) => new StoreError({ operation, cause }) });

const ensureColumn = (db: DatabaseSync, table: string, column: string, ddl: string): void => {
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((r) => Schema.decodeUnknownOption(TableInfoRowSchema)(r))
    .filter(Option.isSome)
    .map((o) => o.value.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl};`);
};

const initTables = (db: DatabaseSync): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY, url TEXT NOT NULL, bookmark_seq INTEGER NOT NULL DEFAULT 0,
      author_handle TEXT, author_name TEXT, created_at TEXT, created_timestamp INTEGER,
      replying_to_handle TEXT, captured_at TEXT NOT NULL, capture_source TEXT NOT NULL,
      dom_text TEXT, text TEXT, search_text TEXT, article_title TEXT, article_text TEXT,
      quote_author TEXT, quote_text TEXT, card_title TEXT, card_description TEXT, card_url TEXT,
      poll_json TEXT, community_note TEXT, extra_text TEXT, urls_json TEXT, domains TEXT,
      media_json TEXT, likes INTEGER, reposts INTEGER, replies INTEGER, bookmarks_count INTEGER,
      views INTEGER, lang TEXT, hydration_status TEXT NOT NULL DEFAULT 'pending',
      hydration_source TEXT, parser_version INTEGER NOT NULL DEFAULT 0, hydrated_at TEXT,
      next_retry_at TEXT, retry_count INTEGER NOT NULL DEFAULT 0, hydration_error TEXT, raw_fx_json TEXT
    );
    CREATE TABLE IF NOT EXISTS links (
      bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
      url TEXT NOT NULL, domain TEXT NOT NULL, source TEXT NOT NULL,
      PRIMARY KEY (bookmark_id, url, source)
    );
    CREATE TABLE IF NOT EXISTS bookmark_folders (
      bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
      folder_id TEXT NOT NULL, folder_name TEXT,
      PRIMARY KEY (bookmark_id, folder_id)
    );
    CREATE TABLE IF NOT EXISTS tags (
      bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
      tag TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (bookmark_id, tag)
    );
    CREATE TABLE IF NOT EXISTS thread_posts (
      bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
      post_id TEXT NOT NULL, position INTEGER NOT NULL, author_handle TEXT,
      created_at TEXT, text TEXT NOT NULL,
      PRIMARY KEY (bookmark_id, post_id)
    );
    CREATE TABLE IF NOT EXISTS pruned_bookmarks (
      id TEXT PRIMARY KEY, pruned_at TEXT NOT NULL, reason TEXT
    );
    CREATE TABLE IF NOT EXISTS embeddings (
      bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
      model TEXT NOT NULL, dims INTEGER NOT NULL, content_hash TEXT NOT NULL,
      vector_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (bookmark_id, model)
    );
  `);
};

const initSchema = (db: DatabaseSync): void => {
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  initTables(db);
  for (const [col, ddl] of [
    ["bookmark_seq", "INTEGER NOT NULL DEFAULT 0"],
    ["replying_to_handle", "TEXT"],
    ["search_text", "TEXT"],
    ["poll_json", "TEXT"],
    ["community_note", "TEXT"],
    ["extra_text", "TEXT"],
    ["hydration_source", "TEXT"],
    ["parser_version", "INTEGER NOT NULL DEFAULT 0"],
    ["next_retry_at", "TEXT"],
    ["retry_count", "INTEGER NOT NULL DEFAULT 0"],
  ] as const) {
    ensureColumn(db, "bookmarks", col, ddl);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_bookmarks_status ON bookmarks(hydration_status, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_author ON bookmarks(author_handle);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_created ON bookmarks(created_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_seq ON bookmarks(bookmark_seq DESC);
    CREATE INDEX IF NOT EXISTS idx_links_domain ON links(domain);
    CREATE INDEX IF NOT EXISTS idx_folders_folder ON bookmark_folders(folder_id);
    CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
  `);
};

const readTags = (db: DatabaseSync, id: string): string[] =>
  db
    .prepare("SELECT tag FROM tags WHERE bookmark_id = ? ORDER BY tag ASC")
    .all(id)
    .map((r) => Schema.decodeUnknownOption(TagRowSchema)(r))
    .filter(Option.isSome)
    .map((o) => o.value.tag);

const readFolders = (db: DatabaseSync, id: string): FolderRef[] =>
  db
    .prepare("SELECT folder_id, folder_name FROM bookmark_folders WHERE bookmark_id = ?")
    .all(id)
    .map((r) => Schema.decodeUnknownOption(FolderRowSchema)(r))
    .filter(Option.isSome)
    .map((o) => ({ folderId: o.value.folder_id, folderName: o.value.folder_name }));

const readThread = (db: DatabaseSync, id: string): ThreadPost[] =>
  db
    .prepare(
      "SELECT post_id, position, author_handle, created_at, text FROM thread_posts WHERE bookmark_id = ? ORDER BY position ASC",
    )
    .all(id)
    .map((r) => Schema.decodeUnknownOption(ThreadRowSchema)(r))
    .filter(Option.isSome)
    .map((o) => ({
      postId: o.value.post_id,
      position: o.value.position,
      authorHandle: o.value.author_handle,
      createdAt: o.value.created_at,
      text: o.value.text,
    }));

const rowToSummary = (db: DatabaseSync, r: DbBookmarkRow): BookmarkSummary => ({
  id: Schema.decodeSync(BookmarkId)(r.id),
  url: r.url,
  bookmarkSeq: r.bookmark_seq,
  authorHandle: r.author_handle,
  authorName: r.author_name,
  createdAt: r.created_at,
  createdTimestamp: r.created_timestamp,
  capturedAt: r.captured_at,
  text: r.text ?? r.dom_text,
  articleTitle: r.article_title,
  domains: parseDomains(r.domains),
  tags: readTags(db, r.id),
  folders: readFolders(db, r.id),
  hydrationStatus: decodeStatus(r.hydration_status),
  hydrationSource: decodeSource(r.hydration_source),
});

const rowToDetail = (db: DatabaseSync, r: DbBookmarkRow): BookmarkDetail => ({
  ...rowToSummary(db, r),
  replyingToHandle: r.replying_to_handle,
  captureSource: r.capture_source,
  domText: r.dom_text,
  articleText: r.article_text,
  quoteAuthor: r.quote_author,
  quoteText: r.quote_text,
  cardTitle: r.card_title,
  cardDescription: r.card_description,
  cardUrl: r.card_url,
  communityNote: r.community_note,
  extraText: r.extra_text,
  urls: parseStringListJson(r.urls_json),
  likes: r.likes,
  reposts: r.reposts,
  replies: r.replies,
  bookmarksCount: r.bookmarks_count,
  views: r.views,
  lang: r.lang,
  hydratedAt: r.hydrated_at,
  threadPosts: readThread(db, r.id),
});

const emptyStr = (val: string | null): string => val ?? "";

const buildCardText = (r: DbBookmarkRow): string =>
  [r.card_title, r.card_description].filter((s): s is string => s !== null && s.length > 0).join(" ");

const rowToIndexable = (db: DatabaseSync, r: DbBookmarkRow): IndexableBookmark => {
  const domains = parseDomains(r.domains);
  const tags = readTags(db, r.id);
  const folders = readFolders(db, r.id).map((f) => f.folderName ?? f.folderId);
  const text = r.text ?? r.dom_text ?? "";
  const embeddingText = buildEmbeddingText({
    authorHandle: r.author_handle,
    text: normalizeNonEmpty(text),
    articleTitle: r.article_title,
    articleText: r.article_text,
    quoteText: r.quote_text,
    cardTitle: r.card_title,
    cardDescription: r.card_description,
    extraText: r.extra_text,
    domains,
    tags,
  });

  return {
    id: Schema.decodeSync(BookmarkId)(r.id),
    url: r.url,
    bookmarkSeq: r.bookmark_seq,
    authorHandle: emptyStr(r.author_handle),
    authorName: emptyStr(r.author_name),
    createdTimestamp: r.created_timestamp ?? 0,
    text,
    articleTitle: emptyStr(r.article_title),
    articleText: emptyStr(r.article_text),
    quoteText: emptyStr(r.quote_text),
    cardText: buildCardText(r),
    extraText: emptyStr(r.extra_text),
    domains,
    tags,
    folders,
    hasArticle: normalizeNonEmpty(r.article_title) !== null,
    contentHash: computeContentHash(embeddingText),
    embeddingText,
  };
};

const decodeCount = (raw: unknown): number => {
  const opt = Schema.decodeUnknownOption(CountRowSchema)(raw);
  return Option.isSome(opt) ? opt.value.c : 0;
};

const decodeBuckets = (rows: ReadonlyArray<unknown>): CountBucket[] =>
  rows
    .map((r) => Schema.decodeUnknownOption(BucketRowSchema)(r))
    .filter(Option.isSome)
    .map((o) => ({ key: o.value.k, count: o.value.c }));

const runInTransaction = <A>(db: DatabaseSync, fn: () => A): A => {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
};

const upsertOneCaptured = (
  db: DatabaseSync,
  item: CapturedBookmark,
  seq: number,
  now: string,
): "added" | "existing" | "pruned" => {
  if (db.prepare("SELECT id FROM pruned_bookmarks WHERE id = ?").get(item.id) !== undefined) return "pruned";
  const domText = normalizeNonEmpty(item.domText);
  const exists = db.prepare("SELECT id FROM bookmarks WHERE id = ?").get(item.id) !== undefined;
  if (!exists) {
    db.prepare(`
      INSERT INTO bookmarks (
        id, url, bookmark_seq, author_handle, author_name, created_at, captured_at,
        capture_source, dom_text, text, search_text, hydration_status, hydration_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'dom')
    `).run(
      item.id,
      item.url,
      seq,
      normalizeNonEmpty(item.authorHandle),
      normalizeNonEmpty(item.authorName),
      normalizeNonEmpty(item.createdAt),
      now,
      item.captureSource,
      domText,
      domText,
      domText ?? "",
    );
  } else {
    db.prepare(`
      UPDATE bookmarks
      SET author_handle = COALESCE(author_handle, ?), author_name = COALESCE(author_name, ?),
          created_at = COALESCE(created_at, ?), dom_text = COALESCE(dom_text, ?),
          search_text = COALESCE(NULLIF(TRIM(text), ''), NULLIF(TRIM(dom_text), ''), ?)
      WHERE id = ?
    `).run(
      normalizeNonEmpty(item.authorHandle),
      normalizeNonEmpty(item.authorName),
      normalizeNonEmpty(item.createdAt),
      domText,
      domText ?? "",
      item.id,
    );
  }
  if (item.folderId !== null) {
    db.prepare(`
      INSERT INTO bookmark_folders (bookmark_id, folder_id, folder_name) VALUES (?, ?, ?)
      ON CONFLICT(bookmark_id, folder_id) DO UPDATE SET folder_name = COALESCE(excluded.folder_name, bookmark_folders.folder_name)
    `).run(item.id, item.folderId, normalizeNonEmpty(item.folderName));
  }
  return exists ? "existing" : "added";
};

const computeRetryAt = (status: string, retryCount: number, retryAfterSeconds: number | null): string | null => {
  if (status !== "error") return null;
  const backoffSec =
    retryAfterSeconds !== null && retryAfterSeconds > 0
      ? retryAfterSeconds
      : Math.min(86_400, 60 * 2 ** Math.max(0, retryCount - 1));
  return new Date(Date.now() + backoffSec * 1000).toISOString();
};

const writeHydratedChildren = (
  db: DatabaseSync,
  id: BookmarkId,
  allowOverwrite: boolean,
  fields: HydratedFields,
): void => {
  if (allowOverwrite && fields.links.length > 0) {
    db.prepare("DELETE FROM links WHERE bookmark_id = ?").run(id);
    const ins = db.prepare("INSERT OR IGNORE INTO links (bookmark_id, url, domain, source) VALUES (?, ?, ?, ?)");
    for (const l of fields.links) ins.run(id, l.url, l.domain, l.source);
  }
  if (fields.threadPosts.length > 0) {
    const ins = db.prepare(
      "INSERT OR REPLACE INTO thread_posts (bookmark_id, post_id, position, author_handle, created_at, text) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const p of fields.threadPosts) ins.run(id, p.postId, p.position, p.authorHandle, p.createdAt, p.text);
  }
};

interface HydrationPlan {
  readonly incomingSource: HydrationSource | null;
  readonly allowOverwrite: boolean;
  readonly nextRetryCount: number;
  readonly nextRetryAt: string | null;
  readonly finalText: string | null;
  readonly searchText: string;
  readonly urlsJson: string | null;
  readonly domainsStr: string | null;
}

const resolveFinalText = (
  allowOverwrite: boolean,
  incoming: string | null,
  existing: string | null,
  dom: string | null,
): string | null => (allowOverwrite ? (incoming ?? existing ?? dom) : (existing ?? incoming ?? dom));

const resolveAllowOverwrite = (
  meta: Schema.Schema.Type<typeof ExistingMetaSchema> | null,
  status: "ok" | "unavailable" | "error",
  incomingSource: HydrationSource | null,
): boolean => {
  if (status !== "ok") return false;
  const existingSource = meta === null ? null : decodeSource(meta.hydration_source);
  return canOverwriteSource(existingSource, incomingSource);
};

const resolveIncomingSource = (
  status: "ok" | "unavailable" | "error",
  fields: HydratedFields,
): HydrationSource | null => fields.hydrationSource ?? (status === "ok" ? "fxtwitter" : null);

const nextRetryCountFor = (
  status: "ok" | "unavailable" | "error",
  meta: Schema.Schema.Type<typeof ExistingMetaSchema> | null,
): number => (status === "error" ? (meta?.retry_count ?? 0) + 1 : 0);

const computeHydrationPlan = (
  meta: Schema.Schema.Type<typeof ExistingMetaSchema> | null,
  status: "ok" | "unavailable" | "error",
  fields: HydratedFields,
  retryAfterSeconds: number | null,
): HydrationPlan => {
  const incomingSource = resolveIncomingSource(status, fields);
  const allowOverwrite = resolveAllowOverwrite(meta, status, incomingSource);
  const nextRetryCount = nextRetryCountFor(status, meta);
  const existingDom = normalizeNonEmpty(meta?.dom_text);
  const finalText = resolveFinalText(
    allowOverwrite,
    normalizeNonEmpty(fields.text),
    normalizeNonEmpty(meta?.text),
    existingDom,
  );
  return {
    incomingSource,
    allowOverwrite,
    nextRetryCount,
    nextRetryAt: computeRetryAt(status, nextRetryCount, retryAfterSeconds),
    finalText,
    searchText: finalText ?? existingDom ?? "",
    urlsJson: fields.urls.length > 0 ? JSON.stringify(fields.urls) : null,
    domainsStr: fields.domains.length > 0 ? fields.domains.join(" ") : null,
  };
};

const writeHydratedRow = (
  db: DatabaseSync,
  input: {
    readonly id: BookmarkId;
    readonly status: "ok" | "unavailable" | "error";
    readonly fields: HydratedFields;
    readonly errorMessage: string | null;
    readonly retryAfterSeconds: number | null;
  },
): void => {
  const { id, status, fields, errorMessage, retryAfterSeconds } = input;
  const rawMeta = db
    .prepare("SELECT hydration_source, dom_text, text, retry_count FROM bookmarks WHERE id = ?")
    .get(id);
  const meta = Option.getOrNull(Schema.decodeUnknownOption(ExistingMetaSchema)(rawMeta));
  const plan = computeHydrationPlan(meta, status, fields, retryAfterSeconds);
  const ow = plan.allowOverwrite ? 1 : 0;

  runInTransaction(db, () => {
    db.prepare(`
      UPDATE bookmarks SET
        url = COALESCE(?, url), author_handle = COALESCE(?, author_handle), author_name = COALESCE(?, author_name),
        created_at = COALESCE(?, created_at), created_timestamp = COALESCE(?, created_timestamp),
        replying_to_handle = COALESCE(?, replying_to_handle), text = ?, search_text = ?,
        article_title = CASE WHEN ? THEN COALESCE(?, article_title) ELSE COALESCE(article_title, ?) END,
        article_text = CASE WHEN ? THEN COALESCE(?, article_text) ELSE COALESCE(article_text, ?) END,
        quote_author = CASE WHEN ? THEN COALESCE(?, quote_author) ELSE COALESCE(quote_author, ?) END,
        quote_text = CASE WHEN ? THEN COALESCE(?, quote_text) ELSE COALESCE(quote_text, ?) END,
        card_title = CASE WHEN ? THEN COALESCE(?, card_title) ELSE COALESCE(card_title, ?) END,
        card_description = CASE WHEN ? THEN COALESCE(?, card_description) ELSE COALESCE(card_description, ?) END,
        card_url = CASE WHEN ? THEN COALESCE(?, card_url) ELSE COALESCE(card_url, ?) END,
        poll_json = CASE WHEN ? THEN COALESCE(?, poll_json) ELSE COALESCE(poll_json, ?) END,
        community_note = CASE WHEN ? THEN COALESCE(?, community_note) ELSE COALESCE(community_note, ?) END,
        extra_text = CASE WHEN ? THEN COALESCE(?, extra_text) ELSE COALESCE(extra_text, ?) END,
        urls_json = CASE WHEN ? THEN COALESCE(?, urls_json) ELSE COALESCE(urls_json, ?) END,
        domains = CASE WHEN ? THEN COALESCE(?, domains) ELSE COALESCE(domains, ?) END,
        media_json = CASE WHEN ? THEN COALESCE(?, media_json) ELSE COALESCE(media_json, ?) END,
        likes = COALESCE(?, likes), reposts = COALESCE(?, reposts), replies = COALESCE(?, replies),
        bookmarks_count = COALESCE(?, bookmarks_count), views = COALESCE(?, views), lang = COALESCE(?, lang),
        raw_fx_json = CASE WHEN ? THEN COALESCE(?, raw_fx_json) ELSE COALESCE(raw_fx_json, ?) END,
        hydration_status = ?,
        hydration_source = CASE WHEN ? THEN COALESCE(?, hydration_source) ELSE COALESCE(hydration_source, ?) END,
        parser_version = CASE WHEN ? THEN ? ELSE parser_version END,
        hydrated_at = ?, next_retry_at = ?, retry_count = ?, hydration_error = ?
      WHERE id = ?
    `).run(
      fields.url,
      fields.authorHandle,
      fields.authorName,
      fields.createdAt,
      fields.createdTimestamp,
      fields.replyingToHandle,
      plan.finalText,
      plan.searchText,
      ow,
      fields.articleTitle,
      fields.articleTitle,
      ow,
      fields.articleText,
      fields.articleText,
      ow,
      fields.quoteAuthor,
      fields.quoteAuthor,
      ow,
      fields.quoteText,
      fields.quoteText,
      ow,
      fields.cardTitle,
      fields.cardTitle,
      ow,
      fields.cardDescription,
      fields.cardDescription,
      ow,
      fields.cardUrl,
      fields.cardUrl,
      ow,
      fields.pollJson,
      fields.pollJson,
      ow,
      fields.communityNote,
      fields.communityNote,
      ow,
      fields.extraText,
      fields.extraText,
      ow,
      plan.urlsJson,
      plan.urlsJson,
      ow,
      plan.domainsStr,
      plan.domainsStr,
      ow,
      fields.mediaJson,
      fields.mediaJson,
      fields.likes,
      fields.reposts,
      fields.replies,
      fields.bookmarksCount,
      fields.views,
      fields.lang,
      ow,
      fields.rawJson,
      fields.rawJson,
      status,
      ow,
      plan.incomingSource,
      plan.incomingSource,
      status === "ok" ? 1 : 0,
      PARSER_VERSION,
      new Date().toISOString(),
      plan.nextRetryAt,
      plan.nextRetryCount,
      normalizeNonEmpty(errorMessage),
      id,
    );
    writeHydratedChildren(db, id, plan.allowOverwrite, fields);
  });
};

interface ListFilterSql {
  readonly joins: string;
  readonly where: string;
  readonly params: SQLInputValue[];
}

const buildListFilterSql = (query: ListBookmarksQuery): ListFilterSql => {
  const joins: string[] = [];
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (query.author !== undefined) {
    where.push("LOWER(b.author_handle) = LOWER(?)");
    params.push(query.author.replace(/^@/, ""));
  }
  if (query.domain !== undefined) {
    const d = `%${query.domain.replace(/^www\./, "").toLowerCase()}%`;
    where.push(
      "(EXISTS (SELECT 1 FROM links l WHERE l.bookmark_id = b.id AND LOWER(l.domain) LIKE ?) OR LOWER(COALESCE(b.domains, '')) LIKE ?)",
    );
    params.push(d, d);
  }
  if (query.folder !== undefined) {
    joins.push("JOIN bookmark_folders bf ON bf.bookmark_id = b.id");
    where.push("(bf.folder_id = ? OR LOWER(COALESCE(bf.folder_name, '')) LIKE LOWER(?))");
    params.push(query.folder, `%${query.folder}%`);
  }
  if (query.tag !== undefined) {
    joins.push("JOIN tags t ON t.bookmark_id = b.id");
    where.push("LOWER(t.tag) = LOWER(?)");
    params.push(query.tag);
  }
  if (query.cursor !== undefined) {
    where.push(query.by === "created" ? "COALESCE(b.created_timestamp, 0) < ?" : "b.bookmark_seq < ?");
    params.push(query.cursor);
  }
  return { joins: joins.join(" "), where: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "", params };
};

const queryBookmarkPage = (db: DatabaseSync, query: ListBookmarksQuery): BookmarkPage => {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 20), 1), 100);
  const { joins, where, params } = buildListFilterSql(query);
  const sortByCreated = query.by === "created";
  const orderSql = sortByCreated
    ? "ORDER BY COALESCE(b.created_timestamp, 0) DESC, b.bookmark_seq DESC"
    : "ORDER BY b.bookmark_seq DESC, b.captured_at DESC";
  const rows = db
    .prepare(`SELECT ${SELECT_ROW_COLS} FROM bookmarks b ${joins} ${where} ${orderSql} LIMIT ?`)
    .all(...params, limit + 1)
    .map((r) => Schema.decodeUnknownOption(RowSchema)(r))
    .filter(Option.isSome)
    .map((o) => o.value);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last !== undefined ? (sortByCreated ? (last.created_timestamp ?? 0) : last.bookmark_seq) : null;
  return { items: pageRows.map((r) => rowToSummary(db, r)), nextCursor };
};

export const makeSqliteBookmarkStore = (db: DatabaseSync): BookmarkStoreShape => ({
  getKnownAndPrunedIds: () =>
    trySync("getKnownAndPrunedIds", () => {
      const ids = new Set<string>();
      for (const r of db.prepare("SELECT id FROM bookmarks UNION SELECT id FROM pruned_bookmarks").all()) {
        const dec = Schema.decodeUnknownOption(IdRowSchema)(r);
        if (Option.isSome(dec)) ids.add(dec.value.id);
      }
      return ids;
    }),

  upsertCapturedBatch: (items) =>
    trySync("upsertCapturedBatch", (): UpsertBatchResult => {
      if (items.length === 0) return { added: 0, existing: 0, skippedPruned: 0 };
      const now = new Date().toISOString();
      const baseSeq = decodeCount(db.prepare("SELECT COALESCE(MAX(bookmark_seq), 0) AS c FROM bookmarks").get());
      return runInTransaction(db, () => {
        let added = 0;
        let existing = 0;
        let skippedPruned = 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item === undefined) continue;
          const res = upsertOneCaptured(db, item, baseSeq + (items.length - i), now);
          if (res === "added") added++;
          else if (res === "existing") existing++;
          else skippedPruned++;
        }
        return { added, existing, skippedPruned };
      });
    }),

  saveHydrated: (input) => trySync("saveHydrated", () => writeHydratedRow(db, input)),

  getById: (id) =>
    trySync("getById", () => {
      const dec = Schema.decodeUnknownOption(RowSchema)(
        db.prepare(`SELECT ${SELECT_ROW_COLS} FROM bookmarks b WHERE b.id = ?`).get(id),
      );
      return Option.isSome(dec) ? rowToDetail(db, dec.value) : null;
    }),

  list: (query) => trySync("list", () => queryBookmarkPage(db, query)),

  getPendingHydration: (limit, includeErrors) =>
    trySync("getPendingHydration", () => {
      const rawRows = includeErrors
        ? db
            .prepare(
              `SELECT id, url FROM bookmarks
               WHERE hydration_status = 'pending' OR (hydration_status = 'error' AND (next_retry_at IS NULL OR next_retry_at <= ?))
               ORDER BY bookmark_seq DESC, captured_at DESC LIMIT ?`,
            )
            .all(new Date().toISOString(), limit)
        : db
            .prepare(
              "SELECT id, url FROM bookmarks WHERE hydration_status = 'pending' ORDER BY bookmark_seq DESC, captured_at DESC LIMIT ?",
            )
            .all(limit);
      return rawRows
        .map((r) => Schema.decodeUnknownOption(IdUrlRowSchema)(r))
        .filter(Option.isSome)
        .map((o) => ({ id: Schema.decodeSync(BookmarkId)(o.value.id), url: o.value.url }));
    }),

  prune: (id, { hard, reason }) =>
    trySync("prune", () =>
      runInTransaction(db, () => {
        const existed = Number(db.prepare("DELETE FROM bookmarks WHERE id = ?").run(id).changes) > 0;
        if (hard) db.prepare("DELETE FROM pruned_bookmarks WHERE id = ?").run(id);
        else if (existed) {
          db.prepare("INSERT OR REPLACE INTO pruned_bookmarks (id, pruned_at, reason) VALUES (?, ?, ?)").run(
            id,
            new Date().toISOString(),
            normalizeNonEmpty(reason),
          );
        }
        return existed;
      }),
    ),

  addTags: (id, tags) =>
    trySync("addTags", () => {
      if (db.prepare("SELECT id FROM bookmarks WHERE id = ?").get(id) === undefined) return null;
      const now = new Date().toISOString();
      runInTransaction(db, () => {
        const stmt = db.prepare("INSERT OR IGNORE INTO tags (bookmark_id, tag, created_at) VALUES (?, ?, ?)");
        for (const t of tags) stmt.run(id, t, now);
      });
      return readTags(db, id);
    }),

  removeTag: (id, tag) =>
    trySync("removeTag", () => {
      if (db.prepare("SELECT id FROM bookmarks WHERE id = ?").get(id) === undefined) return null;
      db.prepare("DELETE FROM tags WHERE bookmark_id = ? AND LOWER(tag) = LOWER(?)").run(id, tag);
      return readTags(db, id);
    }),

  getEmbedding: (id, model) =>
    trySync("getEmbedding", (): StoredEmbedding | null => {
      const dec = Schema.decodeUnknownOption(EmbeddingRowSchema)(
        db
          .prepare("SELECT model, dims, content_hash, vector_json FROM embeddings WHERE bookmark_id = ? AND model = ?")
          .get(id, model),
      );
      if (Option.isNone(dec)) return null;
      try {
        const vec = Schema.decodeUnknownOption(NumberArraySchema)(JSON.parse(dec.value.vector_json));
        return Option.isNone(vec)
          ? null
          : { model: dec.value.model, dims: dec.value.dims, contentHash: dec.value.content_hash, vector: vec.value };
      } catch {
        return null;
      }
    }),

  saveEmbedding: (id, emb) =>
    trySync("saveEmbedding", () => {
      db.prepare(
        "INSERT OR REPLACE INTO embeddings (bookmark_id, model, dims, content_hash, vector_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(id, emb.model, emb.dims, emb.contentHash, JSON.stringify(emb.vector), new Date().toISOString());
    }),

  getIndexableById: (id) =>
    trySync("getIndexableById", () => {
      const dec = Schema.decodeUnknownOption(RowSchema)(
        db.prepare(`SELECT ${SELECT_ROW_COLS} FROM bookmarks b WHERE b.id = ?`).get(id),
      );
      return Option.isSome(dec) ? rowToIndexable(db, dec.value) : null;
    }),

  listAllIndexable: () =>
    trySync("listAllIndexable", () =>
      db
        .prepare(`SELECT ${SELECT_ROW_COLS} FROM bookmarks b ORDER BY b.bookmark_seq DESC, b.captured_at DESC`)
        .all()
        .map((r) => Schema.decodeUnknownOption(RowSchema)(r))
        .filter(Option.isSome)
        .map((o) => rowToIndexable(db, o.value)),
    ),

  listRawPayloads: () =>
    trySync("listRawPayloads", (): ReadonlyArray<RawPayloadRecord> =>
      db
        .prepare("SELECT id, raw_fx_json FROM bookmarks WHERE raw_fx_json IS NOT NULL")
        .all()
        .map((r) => Schema.decodeUnknownOption(RawRowSchema)(r))
        .filter(Option.isSome)
        .map((o) => ({ id: Schema.decodeSync(BookmarkId)(o.value.id), rawJson: o.value.raw_fx_json })),
    ),

  stats: (indexedVectors) =>
    trySync("stats", (): IndexStats => ({
      total: decodeCount(db.prepare("SELECT COUNT(*) AS c FROM bookmarks").get()),
      articles: decodeCount(db.prepare("SELECT COUNT(*) AS c FROM bookmarks WHERE article_title IS NOT NULL").get()),
      threads: decodeCount(db.prepare("SELECT COUNT(DISTINCT bookmark_id) AS c FROM thread_posts").get()),
      pruned: decodeCount(db.prepare("SELECT COUNT(*) AS c FROM pruned_bookmarks").get()),
      embedded: decodeCount(db.prepare("SELECT COUNT(DISTINCT bookmark_id) AS c FROM embeddings").get()),
      indexedVectors,
      byStatus: decodeBuckets(
        db.prepare("SELECT hydration_status AS k, COUNT(*) AS c FROM bookmarks GROUP BY hydration_status").all(),
      ),
      bySource: decodeBuckets(
        db
          .prepare(
            "SELECT COALESCE(hydration_source, 'none') AS k, COUNT(*) AS c FROM bookmarks GROUP BY hydration_source",
          )
          .all(),
      ),
      topAuthors: decodeBuckets(
        db
          .prepare(
            "SELECT author_handle AS k, COUNT(*) AS c FROM bookmarks WHERE author_handle IS NOT NULL AND author_handle != '' GROUP BY author_handle ORDER BY c DESC LIMIT 10",
          )
          .all(),
      ),
      topDomains: decodeBuckets(
        db
          .prepare(
            "SELECT domain AS k, COUNT(DISTINCT bookmark_id) AS c FROM links GROUP BY domain ORDER BY c DESC LIMIT 10",
          )
          .all(),
      ),
    })),
});

export const openSqliteDatabase = (dbPath: string): DatabaseSync => {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  initSchema(db);
  return db;
};

export const SqliteBookmarkStoreLive = (dbPath: string): Layer.Layer<BookmarkStore, StoreError> =>
  Layer.effect(
    BookmarkStore,
    Effect.acquireRelease(
      trySync("open", () => openSqliteDatabase(dbPath)),
      (db) => Effect.sync(() => db.close()),
    ).pipe(Effect.map(makeSqliteBookmarkStore)),
  );
