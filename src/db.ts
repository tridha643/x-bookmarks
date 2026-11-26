import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const DEFAULT_DB_PATH = resolve(import.meta.dir, "../data/bookmarks.db");

export interface CapturedBookmark {
  id: string;
  url: string;
  author_handle?: string | null;
  author_name?: string | null;
  created_at?: string | null;
  dom_text?: string | null;
  capture_source: string;
}

export interface HydratedFields {
  url?: string | null;
  author_handle?: string | null;
  author_name?: string | null;
  created_at?: string | null;
  created_timestamp?: number | null;
  text?: string | null;
  article_title?: string | null;
  article_text?: string | null;
  quote_author?: string | null;
  quote_text?: string | null;
  card_title?: string | null;
  card_description?: string | null;
  card_url?: string | null;
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
}

export interface SearchOptions {
  query?: string;
  author?: string;
  domain?: string;
  limit?: number;
}

export interface BookmarkRow {
  id: string;
  url: string;
  author_handle: string | null;
  author_name: string | null;
  created_at: string | null;
  created_timestamp: number | null;
  captured_at: string;
  capture_source: string;
  dom_text: string | null;
  text: string | null;
  article_title: string | null;
  article_text: string | null;
  quote_author: string | null;
  quote_text: string | null;
  card_title: string | null;
  card_description: string | null;
  card_url: string | null;
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
  hydrated_at: string | null;
  hydration_error: string | null;
  raw_fx_json: string | null;
}

export function openDb(dbPath = process.env.X_BOOKMARKS_DB || DEFAULT_DB_PATH): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      author_handle TEXT,
      author_name TEXT,
      created_at TEXT,
      created_timestamp INTEGER,
      captured_at TEXT NOT NULL,
      capture_source TEXT NOT NULL,
      dom_text TEXT,
      text TEXT,
      article_title TEXT,
      article_text TEXT,
      quote_author TEXT,
      quote_text TEXT,
      card_title TEXT,
      card_description TEXT,
      card_url TEXT,
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
      hydrated_at TEXT,
      hydration_error TEXT,
      raw_fx_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_bookmarks_status ON bookmarks(hydration_status);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_author ON bookmarks(author_handle);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_created ON bookmarks(created_timestamp DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS bookmarks_fts USING fts5(
      author_handle,
      author_name,
      text,
      article_title,
      article_text,
      quote_text,
      card_title,
      card_description,
      domains,
      content='bookmarks',
      content_rowid='rowid',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS bookmarks_ai AFTER INSERT ON bookmarks BEGIN
      INSERT INTO bookmarks_fts(
        rowid, author_handle, author_name, text, article_title, article_text,
        quote_text, card_title, card_description, domains
      ) VALUES (
        new.rowid,
        COALESCE(new.author_handle, ''),
        COALESCE(new.author_name, ''),
        COALESCE(new.text, new.dom_text, ''),
        COALESCE(new.article_title, ''),
        COALESCE(new.article_text, ''),
        COALESCE(new.quote_text, ''),
        COALESCE(new.card_title, ''),
        COALESCE(new.card_description, ''),
        COALESCE(new.domains, '')
      );
    END;

    CREATE TRIGGER IF NOT EXISTS bookmarks_ad AFTER DELETE ON bookmarks BEGIN
      INSERT INTO bookmarks_fts(
        bookmarks_fts, rowid, author_handle, author_name, text, article_title,
        article_text, quote_text, card_title, card_description, domains
      ) VALUES (
        'delete',
        old.rowid,
        COALESCE(old.author_handle, ''),
        COALESCE(old.author_name, ''),
        COALESCE(old.text, old.dom_text, ''),
        COALESCE(old.article_title, ''),
        COALESCE(old.article_text, ''),
        COALESCE(old.quote_text, ''),
        COALESCE(old.card_title, ''),
        COALESCE(old.card_description, ''),
        COALESCE(old.domains, '')
      );
    END;

    CREATE TRIGGER IF NOT EXISTS bookmarks_au AFTER UPDATE ON bookmarks BEGIN
      INSERT INTO bookmarks_fts(
        bookmarks_fts, rowid, author_handle, author_name, text, article_title,
        article_text, quote_text, card_title, card_description, domains
      ) VALUES (
        'delete',
        old.rowid,
        COALESCE(old.author_handle, ''),
        COALESCE(old.author_name, ''),
        COALESCE(old.text, old.dom_text, ''),
        COALESCE(old.article_title, ''),
        COALESCE(old.article_text, ''),
        COALESCE(old.quote_text, ''),
        COALESCE(old.card_title, ''),
        COALESCE(old.card_description, ''),
        COALESCE(old.domains, '')
      );
      INSERT INTO bookmarks_fts(
        rowid, author_handle, author_name, text, article_title, article_text,
        quote_text, card_title, card_description, domains
      ) VALUES (
        new.rowid,
        COALESCE(new.author_handle, ''),
        COALESCE(new.author_name, ''),
        COALESCE(new.text, new.dom_text, ''),
        COALESCE(new.article_title, ''),
        COALESCE(new.article_text, ''),
        COALESCE(new.quote_text, ''),
        COALESCE(new.card_title, ''),
        COALESCE(new.card_description, ''),
        COALESCE(new.domains, '')
      );
    END;
  `);

  return db;
}

export function getKnownIds(db: Database): Set<string> {
  const rows = db.query("SELECT id FROM bookmarks").all() as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

export function upsertCaptured(db: Database, item: CapturedBookmark): boolean {
  const existing = db.query("SELECT id FROM bookmarks WHERE id = ?").get(item.id);
  const now = new Date().toISOString();

  if (!existing) {
    db.query(`
      INSERT INTO bookmarks (
        id, url, author_handle, author_name, created_at, captured_at,
        capture_source, dom_text, text, hydration_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      item.id,
      item.url,
      item.author_handle ?? null,
      item.author_name ?? null,
      item.created_at ?? null,
      now,
      item.capture_source,
      item.dom_text ?? null,
      item.dom_text ?? null
    );
    return true;
  }

  // Enrich missing fallback fields without overwriting hydrated content
  db.query(`
    UPDATE bookmarks
    SET
      author_handle = COALESCE(author_handle, ?),
      author_name = COALESCE(author_name, ?),
      created_at = COALESCE(created_at, ?),
      dom_text = COALESCE(dom_text, ?),
      text = COALESCE(text, ?)
    WHERE id = ?
  `).run(
    item.author_handle ?? null,
    item.author_name ?? null,
    item.created_at ?? null,
    item.dom_text ?? null,
    item.dom_text ?? null,
    item.id
  );
  return false;
}

export function saveHydrated(
  db: Database,
  id: string,
  status: "ok" | "unavailable" | "error",
  fields: HydratedFields,
  errorMessage?: string | null
): void {
  const now = new Date().toISOString();
  db.query(`
    UPDATE bookmarks
    SET
      url = COALESCE(?, url),
      author_handle = COALESCE(?, author_handle),
      author_name = COALESCE(?, author_name),
      created_at = COALESCE(?, created_at),
      created_timestamp = COALESCE(?, created_timestamp),
      text = COALESCE(?, text, dom_text),
      article_title = COALESCE(?, article_title),
      article_text = COALESCE(?, article_text),
      quote_author = COALESCE(?, quote_author),
      quote_text = COALESCE(?, quote_text),
      card_title = COALESCE(?, card_title),
      card_description = COALESCE(?, card_description),
      card_url = COALESCE(?, card_url),
      urls_json = COALESCE(?, urls_json),
      domains = COALESCE(?, domains),
      media_json = COALESCE(?, media_json),
      likes = COALESCE(?, likes),
      reposts = COALESCE(?, reposts),
      replies = COALESCE(?, replies),
      bookmarks_count = COALESCE(?, bookmarks_count),
      views = COALESCE(?, views),
      lang = COALESCE(?, lang),
      raw_fx_json = COALESCE(?, raw_fx_json),
      hydration_status = ?,
      hydrated_at = ?,
      hydration_error = ?
    WHERE id = ?
  `).run(
    fields.url ?? null,
    fields.author_handle ?? null,
    fields.author_name ?? null,
    fields.created_at ?? null,
    fields.created_timestamp ?? null,
    fields.text ?? null,
    fields.article_title ?? null,
    fields.article_text ?? null,
    fields.quote_author ?? null,
    fields.quote_text ?? null,
    fields.card_title ?? null,
    fields.card_description ?? null,
    fields.card_url ?? null,
    fields.urls_json ?? null,
    fields.domains ?? null,
    fields.media_json ?? null,
    fields.likes ?? null,
    fields.reposts ?? null,
    fields.replies ?? null,
    fields.bookmarks_count ?? null,
    fields.views ?? null,
    fields.lang ?? null,
    fields.raw_fx_json ?? null,
    status,
    now,
    errorMessage ?? null,
    id
  );
}

export function getPendingHydration(
  db: Database,
  limit = 100,
  includeErrors = false
): { id: string; url: string }[] {
  const statuses = includeErrors ? `('pending', 'error')` : `('pending')`;
  return db
    .query(`SELECT id, url FROM bookmarks WHERE hydration_status IN ${statuses} ORDER BY captured_at DESC LIMIT ?`)
    .all(limit) as { id: string; url: string }[];
}

export function searchBookmarks(db: Database, opts: SearchOptions): BookmarkRow[] {
  const limit = opts.limit ?? 20;
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (opts.author) {
    where.push("LOWER(b.author_handle) = LOWER(?)");
    params.push(opts.author.replace(/^@/, ""));
  }
  if (opts.domain) {
    where.push("LOWER(COALESCE(b.domains, '')) LIKE LOWER(?)");
    params.push(`%${opts.domain}%`);
  }

  if (opts.query && opts.query.trim().length > 0) {
    const ftsQuery = opts.query.trim();
    const extraWhere = where.length > 0 ? `AND ${where.join(" AND ")}` : "";
    const sql = `
      SELECT b.*
      FROM bookmarks_fts f
      JOIN bookmarks b ON b.rowid = f.rowid
      WHERE bookmarks_fts MATCH ?
      ${extraWhere}
      ORDER BY bm25(bookmarks_fts), COALESCE(b.created_timestamp, 0) DESC
      LIMIT ?
    `;
    return db.query(sql).all(ftsQuery, ...params, limit) as BookmarkRow[];
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `
    SELECT b.*
    FROM bookmarks b
    ${whereClause}
    ORDER BY COALESCE(b.created_timestamp, 0) DESC, b.captured_at DESC
    LIMIT ?
  `;
  return db.query(sql).all(...params, limit) as BookmarkRow[];
}

export function getStats(db: Database) {
  const total = (db.query("SELECT COUNT(*) as c FROM bookmarks").get() as { c: number }).c;
  const byStatus = db
    .query("SELECT hydration_status, COUNT(*) as count FROM bookmarks GROUP BY hydration_status")
    .all() as { hydration_status: string; count: number }[];
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
  return { total, byStatus, topAuthors };
}

export function rebuildFts(db: Database): void {
  db.exec(`INSERT INTO bookmarks_fts(bookmarks_fts) VALUES('rebuild');`);
}
