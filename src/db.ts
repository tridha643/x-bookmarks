import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const DEFAULT_DB_PATH = resolve(import.meta.dir, "../data/bookmarks.db");
export const PARSER_VERSION = 2;

export type HydrationSource = "fxtwitter" | "vxtwitter" | "syndication" | "dom" | "manual";

export const SOURCE_QUALITY: Record<string, number> = {
  fxtwitter: 40,
  vxtwitter: 30,
  syndication: 20,
  dom: 10,
  manual: 5,
};

export interface CapturedBookmark {
  id: string;
  url: string;
  author_handle?: string | null;
  author_name?: string | null;
  created_at?: string | null;
  dom_text?: string | null;
  capture_source: string;
  folder_id?: string | null;
  folder_name?: string | null;
}

export interface ExtractedLink {
  url: string;
  domain: string;
  source: "tweet" | "card" | "article" | "quote";
}

export interface ThreadPostInput {
  post_id: string;
  position: number;
  author_handle: string | null;
  created_at: string | null;
  text: string;
}

export interface HydratedFields {
  url?: string | null;
  author_handle?: string | null;
  author_name?: string | null;
  created_at?: string | null;
  created_timestamp?: number | null;
  replying_to_handle?: string | null;
  text?: string | null;
  article_title?: string | null;
  article_text?: string | null;
  quote_author?: string | null;
  quote_text?: string | null;
  card_title?: string | null;
  card_description?: string | null;
  card_url?: string | null;
  poll_json?: string | null;
  community_note?: string | null;
  extra_text?: string | null;
  urls_json?: string | null;
  domains?: string | null;
  media_json?: string | null;
  likes?: number | null;
  reposts?: number | null;
  replies?: number | null;
  bookmarks_count?: number | null;
  views?: number | null;
  lang?: string | null;
  raw_fx_json?: string | null;
  hydration_source?: HydrationSource | null;
  links?: ExtractedLink[];
  thread_posts?: ThreadPostInput[];
}

export interface SearchOptions {
  query?: string;
  raw?: boolean;
  author?: string;
  domain?: string;
  folder?: string;
  tag?: string;
  limit?: number;
}

export interface BookmarkRow {
  id: string;
  url: string;
  bookmark_seq: number;
  author_handle: string | null;
  author_name: string | null;
  created_at: string | null;
  created_timestamp: number | null;
  replying_to_handle: string | null;
  captured_at: string;
  capture_source: string;
  dom_text: string | null;
  text: string | null;
  search_text: string | null;
  article_title: string | null;
  article_text: string | null;
  quote_author: string | null;
  quote_text: string | null;
  card_title: string | null;
  card_description: string | null;
  card_url: string | null;
  poll_json: string | null;
  community_note: string | null;
  extra_text: string | null;
  urls_json: string | null;
  domains: string | null;
  media_json: string | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  bookmarks_count: number | null;
  views: number | null;
  lang: string | null;
  hydration_status: string;
  hydration_source: string | null;
  parser_version: number;
  hydrated_at: string | null;
  next_retry_at: string | null;
  retry_count: number;
  hydration_error: string | null;
  raw_fx_json: string | null;
}

function cleanStr(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Safely converts user input into an FTS5 MATCH expression so punctuation
 * (c++, state-of-the-art, node.js, what's new, @user, #tag, foo:bar)
 * never throws SQLite syntax errors.
 */
export function sanitizeFtsQuery(raw: string): string | null {
  const input = raw.trim();
  if (!input) return null;

  const tokens: string[] = [];
  // Split preserving quoted phrases and individual non-whitespace terms
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const val = (m[1] ?? m[2] ?? "").trim();
    if (val) tokens.push(val);
  }

  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if ((tok === "OR" || tok === "NOT") && out.length > 0 && i < tokens.length - 1) {
      const prev = out[out.length - 1];
      if (prev !== "OR" && prev !== "NOT") {
        out.push(tok);
      }
      continue;
    }
    if (tok === "AND" || tok === "OR" || tok === "NOT" || tok === "NEAR") {
      // Bare operator at edge -> treat as literal quoted word
      out.push(`"${tok}"`);
      continue;
    }

    const isPrefix = tok.length > 1 && tok.endsWith("*") && !tok.slice(0, -1).includes('"');
    const body = isPrefix ? tok.slice(0, -1) : tok;
    // Strip pure-punctuation tokens that have no alphanumeric chars
    if (!/[\p{L}\p{N}]/u.test(body)) continue;
    const escaped = body.replace(/"/g, '""');
    out.push(isPrefix ? `"${escaped}"*` : `"${escaped}"`);
  }

  // Drop dangling trailing boolean operators
  while (out.length > 0 && (out[out.length - 1] === "OR" || out[out.length - 1] === "NOT")) {
    out.pop();
  }

  return out.length > 0 ? out.join(" ") : null;
}

function ensureColumn(db: Database, table: string, column: string, ddl: string): void {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl};`);
  }
}

export function openDb(
  dbPath = process.env.X_BOOKMARKS_DB || DEFAULT_DB_PATH,
  opts: { readonly?: boolean } = {}
): Database {
  if (opts.readonly) {
    const db = new Database(dbPath, { readonly: true });
    db.exec("PRAGMA busy_timeout = 3000;");
    return db;
  }

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      bookmark_seq INTEGER NOT NULL DEFAULT 0,
      author_handle TEXT,
      author_name TEXT,
      created_at TEXT,
      created_timestamp INTEGER,
      replying_to_handle TEXT,
      captured_at TEXT NOT NULL,
      capture_source TEXT NOT NULL,
      dom_text TEXT,
      text TEXT,
      search_text TEXT,
      article_title TEXT,
      article_text TEXT,
      quote_author TEXT,
      quote_text TEXT,
      card_title TEXT,
      card_description TEXT,
      card_url TEXT,
      poll_json TEXT,
      community_note TEXT,
      extra_text TEXT,
      urls_json TEXT,
      domains TEXT,
      media_json TEXT,
      likes INTEGER,
      reposts INTEGER,
      replies INTEGER,
      bookmarks_count INTEGER,
      views INTEGER,
      lang TEXT,
      hydration_status TEXT NOT NULL DEFAULT 'pending',
      hydration_source TEXT,
      parser_version INTEGER NOT NULL DEFAULT 0,
      hydrated_at TEXT,
      next_retry_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      hydration_error TEXT,
      raw_fx_json TEXT
    );

    CREATE TABLE IF NOT EXISTS links (
      bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      domain TEXT NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY (bookmark_id, url, source)
    );

    CREATE TABLE IF NOT EXISTS bookmark_folders (
      bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
      folder_id TEXT NOT NULL,
      folder_name TEXT,
      PRIMARY KEY (bookmark_id, folder_id)
    );

    CREATE TABLE IF NOT EXISTS tags (
      bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (bookmark_id, tag)
    );

    CREATE TABLE IF NOT EXISTS thread_posts (
      bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
      post_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      author_handle TEXT,
      created_at TEXT,
      text TEXT NOT NULL,
      PRIMARY KEY (bookmark_id, post_id)
    );
  `);

  // Safe migrations if upgrading an older v1 database
  ensureColumn(db, "bookmarks", "bookmark_seq", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "bookmarks", "replying_to_handle", "TEXT");
  ensureColumn(db, "bookmarks", "search_text", "TEXT");
  ensureColumn(db, "bookmarks", "poll_json", "TEXT");
  ensureColumn(db, "bookmarks", "community_note", "TEXT");
  ensureColumn(db, "bookmarks", "extra_text", "TEXT");
  ensureColumn(db, "bookmarks", "hydration_source", "TEXT");
  ensureColumn(db, "bookmarks", "parser_version", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "bookmarks", "next_retry_at", "TEXT");
  ensureColumn(db, "bookmarks", "retry_count", "INTEGER NOT NULL DEFAULT 0");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_bookmarks_status ON bookmarks(hydration_status, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_author ON bookmarks(author_handle);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_created ON bookmarks(created_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_seq ON bookmarks(bookmark_seq DESC);
    CREATE INDEX IF NOT EXISTS idx_links_domain ON links(domain);
    CREATE INDEX IF NOT EXISTS idx_folders_folder ON bookmark_folders(folder_id);
    CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
  `);

  // Ensure FTS5 table matches current v2 schema (rebuild cleanly if upgrading from v1)
  const ftsCols = db.query("PRAGMA table_info(bookmarks_fts)").all() as { name: string }[];
  const needsFtsRecreate =
    ftsCols.length === 0 ||
    !ftsCols.some((c) => c.name === "search_text") ||
    !ftsCols.some((c) => c.name === "extra_text");

  if (needsFtsRecreate) {
    db.exec(`
      DROP TRIGGER IF EXISTS bookmarks_ai;
      DROP TRIGGER IF EXISTS bookmarks_ad;
      DROP TRIGGER IF EXISTS bookmarks_au;
      DROP TABLE IF EXISTS bookmarks_fts;

      UPDATE bookmarks SET search_text = COALESCE(NULLIF(TRIM(text), ''), NULLIF(TRIM(dom_text), ''), '')
      WHERE search_text IS NULL;

      CREATE VIRTUAL TABLE bookmarks_fts USING fts5(
        author_handle,
        author_name,
        search_text,
        article_title,
        article_text,
        quote_text,
        card_title,
        card_description,
        domains,
        extra_text,
        content='bookmarks',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER bookmarks_ai AFTER INSERT ON bookmarks BEGIN
        INSERT INTO bookmarks_fts(
          rowid, author_handle, author_name, search_text, article_title, article_text,
          quote_text, card_title, card_description, domains, extra_text
        ) VALUES (
          new.rowid,
          COALESCE(new.author_handle, ''),
          COALESCE(new.author_name, ''),
          COALESCE(new.search_text, ''),
          COALESCE(new.article_title, ''),
          COALESCE(new.article_text, ''),
          COALESCE(new.quote_text, ''),
          COALESCE(new.card_title, ''),
          COALESCE(new.card_description, ''),
          COALESCE(new.domains, ''),
          COALESCE(new.extra_text, '')
        );
      END;

      CREATE TRIGGER bookmarks_ad AFTER DELETE ON bookmarks BEGIN
        INSERT INTO bookmarks_fts(
          bookmarks_fts, rowid, author_handle, author_name, search_text, article_title,
          article_text, quote_text, card_title, card_description, domains, extra_text
        ) VALUES (
          'delete',
          old.rowid,
          COALESCE(old.author_handle, ''),
          COALESCE(old.author_name, ''),
          COALESCE(old.search_text, ''),
          COALESCE(old.article_title, ''),
          COALESCE(old.article_text, ''),
          COALESCE(old.quote_text, ''),
          COALESCE(old.card_title, ''),
          COALESCE(old.card_description, ''),
          COALESCE(old.domains, ''),
          COALESCE(old.extra_text, '')
        );
      END;

      CREATE TRIGGER bookmarks_au AFTER UPDATE OF
        author_handle, author_name, search_text, article_title, article_text,
        quote_text, card_title, card_description, domains, extra_text
      ON bookmarks BEGIN
        INSERT INTO bookmarks_fts(
          bookmarks_fts, rowid, author_handle, author_name, search_text, article_title,
          article_text, quote_text, card_title, card_description, domains, extra_text
        ) VALUES (
          'delete',
          old.rowid,
          COALESCE(old.author_handle, ''),
          COALESCE(old.author_name, ''),
          COALESCE(old.search_text, ''),
          COALESCE(old.article_title, ''),
          COALESCE(old.article_text, ''),
          COALESCE(old.quote_text, ''),
          COALESCE(old.card_title, ''),
          COALESCE(old.card_description, ''),
          COALESCE(old.domains, ''),
          COALESCE(old.extra_text, '')
        );
        INSERT INTO bookmarks_fts(
          rowid, author_handle, author_name, search_text, article_title, article_text,
          quote_text, card_title, card_description, domains, extra_text
        ) VALUES (
          new.rowid,
          COALESCE(new.author_handle, ''),
          COALESCE(new.author_name, ''),
          COALESCE(new.search_text, ''),
          COALESCE(new.article_title, ''),
          COALESCE(new.article_text, ''),
          COALESCE(new.quote_text, ''),
          COALESCE(new.card_title, ''),
          COALESCE(new.card_description, ''),
          COALESCE(new.domains, ''),
          COALESCE(new.extra_text, '')
        );
      END;

      INSERT INTO bookmarks_fts(bookmarks_fts) VALUES('rebuild');
    `);
  }

  return db;
}

export function getKnownIds(db: Database): Set<string> {
  const rows = db.query("SELECT id FROM bookmarks").all() as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

export function getMaxBookmarkSeq(db: Database): number {
  const row = db.query("SELECT COALESCE(MAX(bookmark_seq), 0) as m FROM bookmarks").get() as {
    m: number;
  };
  return row.m;
}

/**
 * Inserts a batch of captured bookmarks in DOM order (index 0 = most recently bookmarked),
 * assigning monotonically increasing `bookmark_seq` values above all previously stored rows.
 */
export function upsertCapturedBatch(db: Database, items: CapturedBookmark[]): number {
  if (items.length === 0) return 0;
  const baseSeq = getMaxBookmarkSeq(db);
  const now = new Date().toISOString();
  let inserted = 0;

  const selectExisting = db.query("SELECT id, dom_text, text FROM bookmarks WHERE id = ?");
  const insertStmt = db.query(`
    INSERT INTO bookmarks (
      id, url, bookmark_seq, author_handle, author_name, created_at, captured_at,
      capture_source, dom_text, text, search_text, hydration_status, hydration_source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'dom')
  `);
  const updateFallbackStmt = db.query(`
    UPDATE bookmarks
    SET
      author_handle = COALESCE(author_handle, ?),
      author_name = COALESCE(author_name, ?),
      created_at = COALESCE(created_at, ?),
      dom_text = COALESCE(dom_text, ?),
      search_text = COALESCE(NULLIF(TRIM(text), ''), NULLIF(TRIM(dom_text), ''), ?)
    WHERE id = ?
  `);
  const upsertFolderStmt = db.query(`
    INSERT INTO bookmark_folders (bookmark_id, folder_id, folder_name)
    VALUES (?, ?, ?)
    ON CONFLICT(bookmark_id, folder_id) DO UPDATE SET
      folder_name = COALESCE(excluded.folder_name, bookmark_folders.folder_name)
  `);

  const tx = db.transaction(() => {
    // Assign highest bookmark_seq to index 0 (newest in DOM)
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const seq = baseSeq + (items.length - i);
      const domText = cleanStr(item.dom_text);
      const existing = selectExisting.get(item.id) as { id: string } | null;

      if (!existing) {
        insertStmt.run(
          item.id,
          item.url,
          seq,
          cleanStr(item.author_handle),
          cleanStr(item.author_name),
          cleanStr(item.created_at),
          now,
          item.capture_source,
          domText,
          domText,
          domText ?? ""
        );
        inserted++;
      } else {
        updateFallbackStmt.run(
          cleanStr(item.author_handle),
          cleanStr(item.author_name),
          cleanStr(item.created_at),
          domText,
          domText ?? "",
          item.id
        );
      }

      if (item.folder_id) {
        upsertFolderStmt.run(item.id, item.folder_id, cleanStr(item.folder_name));
      }
    }
  });

  tx();
  return inserted;
}

export function upsertCaptured(db: Database, item: CapturedBookmark): boolean {
  return upsertCapturedBatch(db, [item]) > 0;
}

export function saveHydrated(
  db: Database,
  id: string,
  status: "ok" | "unavailable" | "error",
  fields: HydratedFields,
  errorMessage?: string | null,
  retryAfterSeconds?: number | null
): void {
  const now = new Date().toISOString();
  const existing = db
    .query("SELECT hydration_source, dom_text, text, retry_count FROM bookmarks WHERE id = ?")
    .get(id) as {
    hydration_source: string | null;
    dom_text: string | null;
    text: string | null;
    retry_count: number;
  } | null;

  const existingQuality = SOURCE_QUALITY[existing?.hydration_source ?? ""] ?? 0;
  const incomingSource = fields.hydration_source ?? (status === "ok" ? "fxtwitter" : null);
  const incomingQuality = SOURCE_QUALITY[incomingSource ?? ""] ?? 0;
  const allowContentOverwrite = status === "ok" && incomingQuality >= existingQuality;

  const nextRetryCount = status === "error" ? (existing?.retry_count ?? 0) + 1 : 0;
  let nextRetryAt: string | null = null;
  if (status === "error") {
    const backoffSec =
      retryAfterSeconds && retryAfterSeconds > 0
        ? retryAfterSeconds
        : Math.min(86400, 60 * Math.pow(2, nextRetryCount - 1));
    nextRetryAt = new Date(Date.now() + backoffSec * 1000).toISOString();
  }

  const incomingText = cleanStr(fields.text);
  const finalText = allowContentOverwrite
    ? incomingText ?? cleanStr(existing?.text) ?? cleanStr(existing?.dom_text)
    : cleanStr(existing?.text) ?? incomingText ?? cleanStr(existing?.dom_text);
  const finalSearchText = finalText ?? cleanStr(existing?.dom_text) ?? "";

  const tx = db.transaction(() => {
    db.query(`
      UPDATE bookmarks
      SET
        url = COALESCE(?, url),
        author_handle = COALESCE(?, author_handle),
        author_name = COALESCE(?, author_name),
        created_at = COALESCE(?, created_at),
        created_timestamp = COALESCE(?, created_timestamp),
        replying_to_handle = COALESCE(?, replying_to_handle),
        text = ?,
        search_text = ?,
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
        likes = COALESCE(?, likes),
        reposts = COALESCE(?, reposts),
        replies = COALESCE(?, replies),
        bookmarks_count = COALESCE(?, bookmarks_count),
        views = COALESCE(?, views),
        lang = COALESCE(?, lang),
        raw_fx_json = CASE WHEN ? THEN COALESCE(?, raw_fx_json) ELSE COALESCE(raw_fx_json, ?) END,
        hydration_status = ?,
        hydration_source = CASE WHEN ? THEN COALESCE(?, hydration_source) ELSE COALESCE(hydration_source, ?) END,
        parser_version = CASE WHEN ? THEN ? ELSE parser_version END,
        hydrated_at = ?,
        next_retry_at = ?,
        retry_count = ?,
        hydration_error = ?
      WHERE id = ?
    `).run(
      cleanStr(fields.url),
      cleanStr(fields.author_handle),
      cleanStr(fields.author_name),
      cleanStr(fields.created_at),
      fields.created_timestamp ?? null,
      cleanStr(fields.replying_to_handle),
      finalText,
      finalSearchText,
      allowContentOverwrite ? 1 : 0,
      cleanStr(fields.article_title),
      cleanStr(fields.article_title),
      allowContentOverwrite ? 1 : 0,
      cleanStr(fields.article_text),
      cleanStr(fields.article_text),
      allowContentOverwrite ? 1 : 0,
      cleanStr(fields.quote_author),
      cleanStr(fields.quote_author),
      allowContentOverwrite ? 1 : 0,
      cleanStr(fields.quote_text),
      cleanStr(fields.quote_text),
      allowContentOverwrite ? 1 : 0,
      cleanStr(fields.card_title),
      cleanStr(fields.card_title),
      allowContentOverwrite ? 1 : 0,
      cleanStr(fields.card_description),
      cleanStr(fields.card_description),
      allowContentOverwrite ? 1 : 0,
      cleanStr(fields.card_url),
      cleanStr(fields.card_url),
      allowContentOverwrite ? 1 : 0,
      cleanStr(fields.poll_json),
      cleanStr(fields.poll_json),
      allowContentOverwrite ? 1 : 0,
      cleanStr(fields.community_note),
      cleanStr(fields.community_note),
      allowContentOverwrite ? 1 : 0,
      cleanStr(fields.extra_text),
      cleanStr(fields.extra_text),
      allowContentOverwrite ? 1 : 0,
      cleanStr(fields.urls_json),
      cleanStr(fields.urls_json),
      allowContentOverwrite ? 1 : 0,
      cleanStr(fields.domains),
      cleanStr(fields.domains),
      allowContentOverwrite ? 1 : 0,
      cleanStr(fields.media_json),
      cleanStr(fields.media_json),
      fields.likes ?? null,
      fields.reposts ?? null,
      fields.replies ?? null,
      fields.bookmarks_count ?? null,
      fields.views ?? null,
      cleanStr(fields.lang),
      allowContentOverwrite ? 1 : 0,
      cleanStr(fields.raw_fx_json),
      cleanStr(fields.raw_fx_json),
      status,
      allowContentOverwrite ? 1 : 0,
      incomingSource,
      incomingSource,
      status === "ok" ? 1 : 0,
      PARSER_VERSION,
      now,
      nextRetryAt,
      nextRetryCount,
      cleanStr(errorMessage),
      id
    );

    if (allowContentOverwrite && fields.links && fields.links.length > 0) {
      db.query("DELETE FROM links WHERE bookmark_id = ?").run(id);
      const insLink = db.query(
        "INSERT OR IGNORE INTO links (bookmark_id, url, domain, source) VALUES (?, ?, ?, ?)"
      );
      for (const l of fields.links) {
        insLink.run(id, l.url, l.domain, l.source);
      }
    }

    if (fields.thread_posts && fields.thread_posts.length > 0) {
      const insThread = db.query(`
        INSERT OR REPLACE INTO thread_posts (bookmark_id, post_id, position, author_handle, created_at, text)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const tp of fields.thread_posts) {
        insThread.run(id, tp.post_id, tp.position, tp.author_handle, tp.created_at, tp.text);
      }
    }
  });

  tx();
}

export function getPendingHydration(
  db: Database,
  limit = 100,
  includeErrors = false
): { id: string; url: string }[] {
  const now = new Date().toISOString();
  if (includeErrors) {
    return db
      .query(`
        SELECT id, url FROM bookmarks
        WHERE hydration_status = 'pending'
           OR (hydration_status = 'error' AND (next_retry_at IS NULL OR next_retry_at <= ?))
        ORDER BY bookmark_seq DESC, captured_at DESC
        LIMIT ?
      `)
      .all(now, limit) as { id: string; url: string }[];
  }
  return db
    .query(`
      SELECT id, url FROM bookmarks
      WHERE hydration_status = 'pending'
      ORDER BY bookmark_seq DESC, captured_at DESC
      LIMIT ?
    `)
    .all(limit) as { id: string; url: string }[];
}

export function searchBookmarks(db: Database, opts: SearchOptions): BookmarkRow[] {
  const limit = opts.limit ?? 20;
  const joins: string[] = [];
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (opts.author) {
    where.push("LOWER(b.author_handle) = LOWER(?)");
    params.push(opts.author.replace(/^@/, ""));
  }
  if (opts.domain) {
    const dom = opts.domain.replace(/^www\./, "").toLowerCase();
    where.push(
      "(EXISTS (SELECT 1 FROM links l WHERE l.bookmark_id = b.id AND LOWER(l.domain) LIKE ?) OR LOWER(COALESCE(b.domains, '')) LIKE ?)"
    );
    params.push(`%${dom}%`, `%${dom}%`);
  }
  if (opts.folder) {
    joins.push("JOIN bookmark_folders bf ON bf.bookmark_id = b.id");
    where.push("(bf.folder_id = ? OR LOWER(COALESCE(bf.folder_name, '')) LIKE LOWER(?))");
    params.push(opts.folder, `%${opts.folder}%`);
  }
  if (opts.tag) {
    joins.push("JOIN tags t ON t.bookmark_id = b.id");
    where.push("LOWER(t.tag) = LOWER(?)");
    params.push(opts.tag);
  }

  const rawQuery = opts.query?.trim() ?? "";
  if (rawQuery.length > 0) {
    const ftsQuery = opts.raw ? rawQuery : sanitizeFtsQuery(rawQuery);
    if (ftsQuery) {
      const extraWhere = where.length > 0 ? `AND ${where.join(" AND ")}` : "";
      // bm25 weights: handle(3), name(2), search_text(4), article_title(6),
      // article_text(1), quote_text(1.5), card_title(2.5), card_desc(1), domains(1), extra(1.5)
      const sql = `
        SELECT b.*
        FROM bookmarks_fts f
        JOIN bookmarks b ON b.rowid = f.rowid
        ${joins.join(" ")}
        WHERE bookmarks_fts MATCH ?
        ${extraWhere}
        ORDER BY
          bm25(bookmarks_fts, 3.0, 2.0, 4.0, 6.0, 1.0, 1.5, 2.5, 1.0, 1.0, 1.5),
          b.bookmark_seq DESC,
          COALESCE(b.created_timestamp, 0) DESC
        LIMIT ?
      `;
      return db.query(sql).all(ftsQuery, ...params, limit) as BookmarkRow[];
    }

    // Punctuation-only fallback via LIKE
    where.push(
      "(COALESCE(b.search_text, '') LIKE ? OR COALESCE(b.article_text, '') LIKE ? OR COALESCE(b.urls_json, '') LIKE ?)"
    );
    const pat = `%${rawQuery}%`;
    params.push(pat, pat, pat);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `
    SELECT b.*
    FROM bookmarks b
    ${joins.join(" ")}
    ${whereClause}
    ORDER BY b.bookmark_seq DESC, COALESCE(b.created_timestamp, 0) DESC, b.captured_at DESC
    LIMIT ?
  `;
  return db.query(sql).all(...params, limit) as BookmarkRow[];
}

export function listRecentBookmarks(
  db: Database,
  limit = 20,
  by: "bookmarked" | "created" = "bookmarked"
): BookmarkRow[] {
  const order =
    by === "created"
      ? "COALESCE(created_timestamp, 0) DESC, bookmark_seq DESC"
      : "bookmark_seq DESC, captured_at DESC";
  return db.query(`SELECT * FROM bookmarks ORDER BY ${order} LIMIT ?`).all(limit) as BookmarkRow[];
}

export function getBookmarkById(
  db: Database,
  id: string
): { bookmark: BookmarkRow | null; thread: ThreadPostInput[]; tags: string[]; folders: { folder_id: string; folder_name: string | null }[] } {
  const bookmark = db.query("SELECT * FROM bookmarks WHERE id = ?").get(id) as BookmarkRow | null;
  if (!bookmark) return { bookmark: null, thread: [], tags: [], folders: [] };

  const thread = db
    .query("SELECT post_id, position, author_handle, created_at, text FROM thread_posts WHERE bookmark_id = ? ORDER BY position ASC")
    .all(id) as ThreadPostInput[];
  const tags = (db.query("SELECT tag FROM tags WHERE bookmark_id = ? ORDER BY tag ASC").all(id) as { tag: string }[]).map((r) => r.tag);
  const folders = db
    .query("SELECT folder_id, folder_name FROM bookmark_folders WHERE bookmark_id = ?")
    .all(id) as { folder_id: string; folder_name: string | null }[];

  return { bookmark, thread, tags, folders };
}

export function addTag(db: Database, bookmarkId: string, tag: string): void {
  const clean = tag.trim().toLowerCase();
  if (!clean) return;
  db.query("INSERT OR IGNORE INTO tags (bookmark_id, tag, created_at) VALUES (?, ?, ?)").run(
    bookmarkId,
    clean,
    new Date().toISOString()
  );
}

export function removeTag(db: Database, bookmarkId: string, tag: string): void {
  db.query("DELETE FROM tags WHERE bookmark_id = ? AND LOWER(tag) = LOWER(?)").run(bookmarkId, tag.trim());
}

export function getStats(db: Database) {
  const total = (db.query("SELECT COUNT(*) as c FROM bookmarks").get() as { c: number }).c;
  const byStatus = db
    .query("SELECT hydration_status, COUNT(*) as count FROM bookmarks GROUP BY hydration_status")
    .all() as { hydration_status: string; count: number }[];
  const bySource = db
    .query("SELECT COALESCE(hydration_source, 'none') as source, COUNT(*) as count FROM bookmarks GROUP BY hydration_source")
    .all() as { source: string; count: number }[];
  const articles = (
    db.query("SELECT COUNT(*) as c FROM bookmarks WHERE article_title IS NOT NULL").get() as { c: number }
  ).c;
  const threads = (
    db.query("SELECT COUNT(DISTINCT bookmark_id) as c FROM thread_posts").get() as { c: number }
  ).c;
  const topAuthors = db
    .query(`
      SELECT author_handle, COUNT(*) as count
      FROM bookmarks
      WHERE author_handle IS NOT NULL AND author_handle != ''
      GROUP BY author_handle
      ORDER BY count DESC
      LIMIT 10
    `)
    .all() as { author_handle: string; count: number }[];
  const topDomains = db
    .query(`
      SELECT domain, COUNT(DISTINCT bookmark_id) as count
      FROM links
      GROUP BY domain
      ORDER BY count DESC
      LIMIT 10
    `)
    .all() as { domain: string; count: number }[];

  return { total, articles, threads, byStatus, bySource, topAuthors, topDomains };
}

export function rebuildFts(db: Database): void {
  db.exec(`INSERT INTO bookmarks_fts(bookmarks_fts) VALUES('rebuild');`);
}
