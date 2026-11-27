import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { bid, makeCaptured, makeHydrated } from "../../../test/fakes.ts";
import { emptyHydratedFields } from "../../domain/bookmark.ts";
import { BookmarkStore } from "../../ports/store.ts";
import { SqliteBookmarkStoreLive, makeSqliteBookmarkStore, openSqliteDatabase } from "./store.ts";

describe("adapters/sqlite/store", () => {
  it("handles upsert batching, bookmark_seq order, source-quality rules, and hydration retries", async () => {
    const db = openSqliteDatabase(":memory:");
    const store = makeSqliteBookmarkStore(db);

    try {
      expect(await Effect.runPromise(store.upsertCapturedBatch([]))).toEqual({
        added: 0,
        existing: 0,
        skippedPruned: 0,
      });
      expect(
        await Effect.runPromise(
          store.upsertCapturedBatch([
            makeCaptured("1003", { authorHandle: "alice", folderId: "ai", folderName: "AI Research" }),
            makeCaptured("1002", { authorHandle: "bob", folderId: "dev", folderName: "Dev Tools" }),
            makeCaptured("1001", { authorHandle: "alice", domText: "DOM fallback text" }),
          ]),
        ),
      ).toEqual({ added: 3, existing: 0, skippedPruned: 0 });

      expect(
        await Effect.runPromise(
          store.upsertCapturedBatch([makeCaptured("1001", { folderId: "ai", folderName: "AI Research" })]),
        ),
      ).toEqual({ added: 0, existing: 1, skippedPruned: 0 });

      await Effect.runPromise(
        store.saveHydrated({
          id: bid("1003"),
          status: "ok",
          fields: makeHydrated({
            url: "https://x.com/alice/status/1003",
            authorHandle: "alice",
            createdTimestamp: 3000,
            text: "FxTwitter primary text",
            articleTitle: "Vector Search",
            articleText: "Detailed markdown",
            domains: ["orama.com"],
            urls: ["https://orama.com/docs"],
            links: [{ url: "https://orama.com/docs", domain: "orama.com", source: "tweet" }],
            threadPosts: [
              { postId: "1003", position: 0, authorHandle: "alice", createdAt: null, text: "Part 1" },
              { postId: "1004", position: 1, authorHandle: "alice", createdAt: null, text: "Part 2" },
            ],
            rawJson: '{"code":200}',
            hydrationSource: "fxtwitter",
          }),
          errorMessage: null,
          retryAfterSeconds: null,
        }),
      );

      // Lower quality source (vxtwitter) must not overwrite fxtwitter text/article
      await Effect.runPromise(
        store.saveHydrated({
          id: bid("1003"),
          status: "ok",
          fields: makeHydrated({ text: "Worse vx text", articleTitle: "Worse title", hydrationSource: "vxtwitter" }),
          errorMessage: null,
          retryAfterSeconds: null,
        }),
      );

      const d1003 = await Effect.runPromise(store.getById(bid("1003")));
      expect(d1003).toMatchObject({
        text: "FxTwitter primary text",
        articleTitle: "Vector Search",
        hydrationSource: "fxtwitter",
        urls: ["https://orama.com/docs"],
        domains: ["orama.com"],
        folders: [{ folderId: "ai", folderName: "AI Research" }],
      });
      expect(d1003?.threadPosts).toHaveLength(2);

      // Re-hydrating with same quality (fxtwitter) replaces links & supports multiple domains + default source
      await Effect.runPromise(
        store.saveHydrated({
          id: bid("1003"),
          status: "ok",
          fields: makeHydrated({
            text: "FxTwitter primary text",
            articleTitle: "Vector Search",
            cardTitle: "Card Title",
            cardDescription: "Card Desc",
            domains: ["orama.com", "effect.website"],
            urls: ["https://effect.website"],
            links: [{ url: "https://effect.website", domain: "effect.website", source: "card" }],
            hydrationSource: null,
          }),
          errorMessage: null,
          retryAfterSeconds: null,
        }),
      );
      expect(await Effect.runPromise(store.getById(bid("1003")))).toMatchObject({
        domains: ["orama.com", "effect.website"],
        hydrationSource: "fxtwitter",
      });
      const linkRows = db.prepare("SELECT domain FROM links WHERE bookmark_id = '1003'").all() as Array<{
        domain: string;
      }>;
      expect(linkRows.map((l) => l.domain)).toEqual(["effect.website"]);

      expect(await Effect.runPromise(store.getIndexableById(bid("1003")))).toMatchObject({
        cardText: "Card Title Card Desc",
        hasArticle: true,
        domains: ["orama.com", "effect.website"],
      });

      // Corrupt urls_json & invalid hydration_status decode safely to [] and "pending"
      db.prepare("UPDATE bookmarks SET urls_json = '{bad', hydration_status = 'bogus' WHERE id = '1001'").run();
      expect(await Effect.runPromise(store.getById(bid("1001")))).toMatchObject({
        urls: [],
        hydrationStatus: "pending",
      });

      // Null domText initializes empty search_text ("", not "fallow"); null article_title -> hasArticle:false & emptyStr authorName
      await Effect.runPromise(store.upsertCapturedBatch([makeCaptured("1009", { domText: null, authorName: null })]));
      expect(
        db.prepare("SELECT search_text, parser_version FROM bookmarks WHERE id = '1009'").get() as {
          search_text: string;
          parser_version: number;
        },
      ).toEqual({
        search_text: "",
        parser_version: 0,
      });
      expect(await Effect.runPromise(store.getIndexableById(bid("1009")))).toMatchObject({
        authorName: "",
        hasArticle: false,
      });
      // Re-upserting 1009 with null domText keeps search_text ""
      await Effect.runPromise(store.upsertCapturedBatch([makeCaptured("1009", { domText: null })]));
      expect(
        (db.prepare("SELECT search_text FROM bookmarks WHERE id = '1009'").get() as { search_text: string })
          .search_text,
      ).toBe("");
      // Hydrating 1009 with status=ok sets parser_version=3 and null urls_json/domains when empty
      await Effect.runPromise(
        store.saveHydrated({
          id: bid("1009"),
          status: "ok",
          fields: emptyHydratedFields(null),
          errorMessage: null,
          retryAfterSeconds: null,
        }),
      );
      expect(
        db.prepare("SELECT parser_version, search_text, urls_json, domains FROM bookmarks WHERE id = '1009'").get(),
      ).toEqual({ parser_version: 3, search_text: "", urls_json: null, domains: null });
      // Hydrating 1003 with status=error does NOT overwrite existing article_title
      await Effect.runPromise(
        store.saveHydrated({
          id: bid("1003"),
          status: "error",
          fields: makeHydrated({ articleTitle: "Clobbered" }),
          errorMessage: "err",
          retryAfterSeconds: 30,
        }),
      );
      expect((await Effect.runPromise(store.getById(bid("1003"))))?.articleTitle).toBe("Vector Search");
    } finally {
      db.close();
    }
  });

  it("computes retry backoff, Retry-After delays, and clears retry state on unavailable", async () => {
    const db = openSqliteDatabase(":memory:");
    const store = makeSqliteBookmarkStore(db);

    try {
      await Effect.runPromise(store.upsertCapturedBatch([makeCaptured("1002"), makeCaptured("1001")]));

      const beforeErrMs = Date.now();
      await Effect.runPromise(
        store.saveHydrated({
          id: bid("1002"),
          status: "error",
          fields: emptyHydratedFields(null),
          errorMessage: "HTTP 429",
          retryAfterSeconds: 120,
        }),
      );
      const r1002 = db.prepare("SELECT retry_count, next_retry_at FROM bookmarks WHERE id = '1002'").get() as {
        retry_count: number;
        next_retry_at: string;
      };
      expect(r1002.retry_count).toBe(1);
      const wait1002Sec = (Date.parse(r1002.next_retry_at) - beforeErrMs) / 1000;
      expect(wait1002Sec).toBeGreaterThan(100);
      expect(wait1002Sec).toBeLessThan(140);

      await Effect.runPromise(
        store.saveHydrated({
          id: bid("1001"),
          status: "error",
          fields: emptyHydratedFields(null),
          errorMessage: "Network timeout",
          retryAfterSeconds: null,
        }),
      );
      await Effect.runPromise(
        store.saveHydrated({
          id: bid("1001"),
          status: "error",
          fields: emptyHydratedFields(null),
          errorMessage: "Network timeout 2",
          retryAfterSeconds: null,
        }),
      );
      const r1001 = db.prepare("SELECT retry_count, next_retry_at FROM bookmarks WHERE id = '1001'").get() as {
        retry_count: number;
        next_retry_at: string;
      };
      expect(r1001.retry_count).toBe(2);
      const wait1001Sec = (Date.parse(r1001.next_retry_at) - beforeErrMs) / 1000;
      expect(wait1001Sec).toBeGreaterThan(100);
      expect(wait1001Sec).toBeLessThan(140);

      await Effect.runPromise(
        store.saveHydrated({
          id: bid("1002"),
          status: "unavailable",
          fields: emptyHydratedFields("{}"),
          errorMessage: "404",
          retryAfterSeconds: null,
        }),
      );
      const r1002Unav = db.prepare("SELECT retry_count, next_retry_at FROM bookmarks WHERE id = '1002'").get() as {
        retry_count: number;
        next_retry_at: string | null;
      };
      expect(r1002Unav).toEqual({ retry_count: 0, next_retry_at: null });

      expect(await Effect.runPromise(store.getPendingHydration(10, false))).toEqual([]);
      expect(await Effect.runPromise(store.getPendingHydration(10, true))).toEqual([]);

      // Past-due error row is excluded when includeErrors=false and included when includeErrors=true
      db.prepare("UPDATE bookmarks SET next_retry_at = '2000-01-01T00:00:00.000Z' WHERE id = '1001'").run();
      expect(await Effect.runPromise(store.getPendingHydration(10, false))).toEqual([]);
      expect((await Effect.runPromise(store.getPendingHydration(10, true))).map((r) => r.id)).toEqual(["1001"]);
    } finally {
      db.close();
    }
  });

  it("supports tags, filtered listing, cursor pagination, embeddings, pruning, and stats", async () => {
    const db = openSqliteDatabase(":memory:");
    const store = makeSqliteBookmarkStore(db);

    try {
      await Effect.runPromise(
        store.upsertCapturedBatch([
          makeCaptured("2003", { authorHandle: "alice", folderId: "ai", folderName: "AI Research" }),
          makeCaptured("2002", { authorHandle: "bob", folderId: "dev", folderName: "Dev Tools" }),
          makeCaptured("2001", { authorHandle: "alice", folderId: "ai", folderName: "AI Research" }),
        ]),
      );
      await Effect.runPromise(
        store.saveHydrated({
          id: bid("2003"),
          status: "ok",
          fields: makeHydrated({
            authorHandle: "alice",
            createdTimestamp: 3000,
            articleTitle: "Search",
            domains: ["orama.com"],
            links: [{ url: "https://orama.com/docs", domain: "orama.com", source: "tweet" }],
            rawJson: '{"code":200}',
          }),
          errorMessage: null,
          retryAfterSeconds: null,
        }),
      );

      expect(await Effect.runPromise(store.addTags(bid("2003"), ["effect", "search"]))).toEqual(["effect", "search"]);
      expect(await Effect.runPromise(store.removeTag(bid("2003"), "EFFECT"))).toEqual(["search"]);
      expect(await Effect.runPromise(store.addTags(bid("9999"), ["x"]))).toBeNull();
      expect(await Effect.runPromise(store.removeTag(bid("9999"), "x"))).toBeNull();

      expect((await Effect.runPromise(store.list({ author: "@alice" }))).items.map((x) => x.id)).toEqual([
        "2003",
        "2001",
      ]);
      expect((await Effect.runPromise(store.list({ author: "a@lice" }))).items).toEqual([]);
      expect((await Effect.runPromise(store.list({ domain: "www.orama.com" }))).items.map((x) => x.id)).toEqual([
        "2003",
      ]);
      expect((await Effect.runPromise(store.list({ domain: "sub.www.orama.com" }))).items).toEqual([]);
      expect((await Effect.runPromise(store.list({ folder: "AI Research" }))).items.map((x) => x.id)).toEqual([
        "2003",
        "2001",
      ]);
      expect((await Effect.runPromise(store.list({ tag: "search" }))).items.map((x) => x.id)).toEqual(["2003"]);
      expect((await Effect.runPromise(store.list({ limit: 3 }))).nextCursor).toBeNull();

      const p1 = await Effect.runPromise(store.list({ by: "bookmarked", limit: 2 }));
      expect(p1.items.map((x) => x.id)).toEqual(["2003", "2002"]);
      const p2 = await Effect.runPromise(store.list({ by: "bookmarked", limit: 2, cursor: p1.nextCursor ?? 0 }));
      expect(p2.items.map((x) => x.id)).toEqual(["2001"]);
      expect(p2.nextCursor).toBeNull();

      // Give 2001 a NEWER createdTimestamp than 2003 so by=created and by=bookmarked disagree
      await Effect.runPromise(
        store.saveHydrated({
          id: bid("2001"),
          status: "ok",
          fields: makeHydrated({ authorHandle: "alice", createdTimestamp: 9000 }),
          errorMessage: null,
          retryAfterSeconds: null,
        }),
      );

      const byCreated = await Effect.runPromise(store.list({ by: "created", limit: 2 }));
      expect(byCreated.items.map((x) => x.id)).toEqual(["2001", "2003"]);
      const byCreatedNext = await Effect.runPromise(
        store.list({ by: "created", limit: 5, cursor: byCreated.nextCursor ?? 0 }),
      );
      expect(byCreatedNext.items.map((x) => x.id)).toEqual(["2002"]);

      // Embeddings & corrupt JSON handling
      await Effect.runPromise(
        store.saveEmbedding(bid("2003"), {
          model: "nomic-embed-text",
          dims: 3,
          contentHash: "h1",
          vector: [0.1, 0.2, 0.3],
        }),
      );
      expect((await Effect.runPromise(store.getEmbedding(bid("2003"), "nomic-embed-text")))?.vector).toEqual([
        0.1, 0.2, 0.3,
      ]);
      expect(await Effect.runPromise(store.getEmbedding(bid("2003"), "other"))).toBeNull();
      db.prepare("UPDATE embeddings SET vector_json = 'not-json' WHERE bookmark_id = ?").run("2003");
      expect(await Effect.runPromise(store.getEmbedding(bid("2003"), "nomic-embed-text"))).toBeNull();

      // Indexable & raw payloads
      expect((await Effect.runPromise(store.listAllIndexable())).length).toBe(3);
      expect(await Effect.runPromise(store.getIndexableById(bid("9999")))).toBeNull();
      expect((await Effect.runPromise(store.listRawPayloads())).map((r) => r.id)).toEqual(["2003"]);

      // Soft prune tombstones and blocks re-upsert; hard prune clears tombstone
      expect(await Effect.runPromise(store.prune(bid("2002"), { hard: false, reason: "spam" }))).toBe(true);
      expect(await Effect.runPromise(store.prune(bid("2002"), { hard: false, reason: "spam" }))).toBe(false);
      expect((await Effect.runPromise(store.getKnownAndPrunedIds())).has("2002")).toBe(true);
      expect(await Effect.runPromise(store.upsertCapturedBatch([makeCaptured("2002")]))).toEqual({
        added: 0,
        existing: 0,
        skippedPruned: 1,
      });
      expect(await Effect.runPromise(store.prune(bid("2002"), { hard: true, reason: null }))).toBe(false);
      expect(await Effect.runPromise(store.upsertCapturedBatch([makeCaptured("2002")]))).toEqual({
        added: 1,
        existing: 0,
        skippedPruned: 0,
      });

      const stats = await Effect.runPromise(store.stats(2));
      expect(stats.total).toBe(3);
      expect(stats.articles).toBe(1);
      expect(stats.indexedVectors).toBe(2);
      expect(stats.topAuthors[0]?.key).toBe("alice");
      expect(stats.topDomains[0]?.key).toBe("orama.com");
    } finally {
      db.close();
    }
  });

  it("opens a file-backed SQLite database via SqliteBookmarkStoreLive and migrates legacy v1 schema", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xbm-store-test-"));
    const tmpPath = join(dir, "nested", "bookmarks.db");
    try {
      const count = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* BookmarkStore;
          yield* store.upsertCapturedBatch([makeCaptured("7001")]);
          return (yield* store.stats(0)).total;
        }).pipe(Effect.provide(SqliteBookmarkStoreLive(tmpPath))),
      );
      expect(count).toBe(1);

      // Verify additive migration works when a legacy bookmarks table lacks v2/v3 columns
      const legacyPath = join(dir, "legacy.db");
      const raw = openSqliteDatabase(legacyPath);
      raw.exec(
        "DROP TABLE bookmarks; CREATE TABLE bookmarks (id TEXT PRIMARY KEY, url TEXT NOT NULL, author_handle TEXT, created_timestamp INTEGER, captured_at TEXT NOT NULL, capture_source TEXT NOT NULL, hydration_status TEXT NOT NULL DEFAULT 'pending');",
      );
      raw.close();

      const migrated = openSqliteDatabase(legacyPath);
      const fk = migrated.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
      expect(fk.foreign_keys).toBe(1);
      const idxs = (
        migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").all() as Array<{
          name: string;
        }>
      ).map((r) => r.name);
      expect(idxs).toContain("idx_bookmarks_status");
      expect(idxs).toContain("idx_bookmarks_seq");
      const cols = new Set(
        (migrated.prepare("PRAGMA table_info(bookmarks)").all() as Array<{ name: string }>).map((c) => c.name),
      );
      for (const col of [
        "bookmark_seq",
        "replying_to_handle",
        "search_text",
        "poll_json",
        "community_note",
        "extra_text",
        "hydration_source",
        "parser_version",
        "next_retry_at",
        "retry_count",
      ]) {
        expect(cols.has(col)).toBe(true);
      }
      migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports StoreError operation names when database operations fail", async () => {
    const db = openSqliteDatabase(":memory:");
    const store = makeSqliteBookmarkStore(db);
    db.close();

    const ops: Array<[string, Effect.Effect<unknown, { readonly operation: string }>]> = [
      ["getKnownAndPrunedIds", store.getKnownAndPrunedIds()],
      ["upsertCapturedBatch", store.upsertCapturedBatch([makeCaptured("1")])],
      [
        "saveHydrated",
        store.saveHydrated({
          id: bid("1"),
          status: "ok",
          fields: emptyHydratedFields(null),
          errorMessage: null,
          retryAfterSeconds: null,
        }),
      ],
      ["getById", store.getById(bid("1"))],
      ["list", store.list({})],
      ["getPendingHydration", store.getPendingHydration(5, false)],
      ["prune", store.prune(bid("1"), { hard: false, reason: null })],
      ["addTags", store.addTags(bid("1"), ["a"])],
      ["removeTag", store.removeTag(bid("1"), "a")],
      ["getEmbedding", store.getEmbedding(bid("1"), "m")],
      ["saveEmbedding", store.saveEmbedding(bid("1"), { model: "m", dims: 1, contentHash: "h", vector: [1] })],
      ["getIndexableById", store.getIndexableById(bid("1"))],
      ["listAllIndexable", store.listAllIndexable()],
      ["listRawPayloads", store.listRawPayloads()],
      ["stats", store.stats(0)],
    ];

    for (const [name, eff] of ops) {
      const err = await Effect.runPromise(Effect.flip(eff));
      expect(err.operation).toBe(name);
    }

    const openErr = await Effect.runPromise(
      Effect.flip(
        Effect.flatMap(BookmarkStore, (s) => s.stats(0)).pipe(
          Effect.provide(SqliteBookmarkStoreLive("/dev/null/impossible.db")),
        ),
      ),
    );
    expect(openErr.operation).toBe("open");
  });
});
