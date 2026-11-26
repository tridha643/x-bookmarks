import { describe, expect, it } from "vitest";
import {
  looksLikeThread,
  parseFxPayload,
  parseFxPayloadFromJson,
  parseSyndicationPayload,
  parseVxPayload,
  renderArticleMarkdown,
} from "./article.ts";

describe("domain/article", () => {
  describe("renderArticleMarkdown", () => {
    it("returns null fields for non-object or invalid article input", () => {
      expect(renderArticleMarkdown(null)).toEqual({ title: null, markdown: null, urls: [] });
      expect(renderArticleMarkdown("bad")).toEqual({ title: null, markdown: null, urls: [] });
    });

    it("falls back to preview_text when blocks are empty or render empty", () => {
      expect(renderArticleMarkdown({ title: "  My Essay  ", preview_text: "Preview copy" })).toEqual({
        title: "My Essay",
        markdown: "Preview copy",
        urls: [],
      });
      expect(
        renderArticleMarkdown({
          title: "Empty Blocks",
          preview_text: "Fallback preview",
          content: { blocks: [{ type: "unstyled", text: "   " }], entityMap: null },
        }),
      ).toEqual({ title: "Empty Blocks", markdown: "Fallback preview", urls: [] });
    });

    it("renders Draft.js blocks, inline links, ordered lists, atomic markdown/tweet, and array entityMap", () => {
      const rendered = renderArticleMarkdown({
        title: "Architecture Notes",
        content: {
          blocks: [
            { type: "header-one", text: "Top Heading" },
            { type: "header-two", text: "Sub Heading" },
            { type: "header-three", text: "Minor Heading" },
            { type: "blockquote", text: "A sharp quote" },
            { type: "unordered-list-item", text: "Bullet item" },
            { type: "ordered-list-item", text: "Step A" },
            { type: "ordered-list-item", text: "Step B" },
            {
              text: "Check Docs and Repo now",
              entityRanges: [
                { key: 0, offset: 6, length: 4 },
                { key: "1", offset: 15, length: 4 },
                { key: "missing", offset: 0, length: 2 },
                { key: "zeroLen", offset: 0, length: 0 },
              ],
              data: { urls: [{ text: "https://example.org/spec" }, { text: "not-a-url" }] },
            },
            { type: "ordered-list-item", text: "Reset counter" },
            { type: "atomic", entityRanges: [{ key: "2" }, { key: 3 }, { key: "unknown" }, { key: "other" }] },
          ],
          entityMap: [
            { key: 0, value: { type: "LINK", data: { url: "https://effect.website/docs" } } },
            { key: "1", type: "LINK", data: { url: "https://github.com/tridha643/x-bookmarks" } },
            { key: "2", value: { type: "MARKDOWN", data: { markdown: "```ts\nconst x = 1;\n```" } } },
            { key: 3, value: { type: "TWEET", data: { tweetId: 999888 } } },
            { key: "zeroLen", value: { type: "LINK", data: { url: "https://ignored.example" } } },
            { key: "other", value: { type: "IMAGE", data: {} } },
          ],
        },
      });

      expect(rendered.title).toBe("Architecture Notes");
      expect(rendered.markdown).toBe(
        [
          "# Top Heading",
          "## Sub Heading",
          "### Minor Heading",
          "> A sharp quote",
          "- Bullet item",
          "1. Step A",
          "2. Step B",
          "Check [Docs](https://effect.website/docs) and [Repo](https://github.com/tridha643/x-bookmarks) now",
          "1. Reset counter",
          "```ts\nconst x = 1;\n```",
          "[Embedded post: https://x.com/i/status/999888]",
        ].join("\n\n"),
      );
      expect(rendered.urls).toEqual([
        "https://effect.website/docs",
        "https://github.com/tridha643/x-bookmarks",
        "https://ignored.example",
        "https://example.org/spec",
        "https://x.com/i/status/999888",
      ]);

      // Edge cases: block without text, entities with null data / missing markdown / missing tweetId
      const edgeArticle = renderArticleMarkdown({
        title: "Edges",
        content: {
          blocks: [{ type: "unstyled" }, { type: "atomic", entityRanges: [{ key: "mNull" }, { key: "tNull" }] }],
          entityMap: [
            { key: "lNull", value: { type: "LINK", data: null } },
            { key: "mNull", value: { type: "MARKDOWN", data: { markdown: "   " } } },
            { key: "tNull", value: { type: "TWEET", data: { tweetId: null } } },
          ],
        },
      });
      expect(edgeArticle).toEqual({ title: "Edges", markdown: null, urls: [] });
    });

    it("supports object-shaped entityMap", () => {
      const rendered = renderArticleMarkdown({
        title: "Obj Map",
        content: {
          blocks: [{ type: "unstyled", text: "Visit site", entityRanges: [{ key: "k0", offset: 6, length: 4 }] }],
          entityMap: { k0: { type: "LINK", data: { url: "https://orama.com" } } },
        },
      });
      expect(rendered.markdown).toBe("Visit [site](https://orama.com)");
      expect(rendered.urls).toEqual(["https://orama.com"]);
    });
  });

  describe("looksLikeThread", () => {
    it("detects self-reply regardless of case and thread hints in text", () => {
      expect(looksLikeThread("Alice", "alice", "just a reply")).toBe(true);
      expect(looksLikeThread("alice", "bob", "just a reply")).toBe(false);
      expect(looksLikeThread(null, "bob", "A thread 🧵")).toBe(true);
      expect(looksLikeThread(null, null, "1/5 starting")).toBe(true);
      expect(looksLikeThread(null, null, "ratio 1/a plain post")).toBe(false);
      expect(looksLikeThread(null, null, "Notes (1/4)")).toBe(true);
      expect(looksLikeThread(null, null, "Here is a THREAD on SQLite")).toBe(true);
      expect(looksLikeThread(null, null, "Read below 👇")).toBe(true);
      expect(looksLikeThread("alice", null, "Plain single post")).toBe(false);
      expect(looksLikeThread(null, null, null)).toBe(false);
    });
  });

  describe("parseFxPayload & parseFxPayloadFromJson", () => {
    it("rejects invalid payloads, missing tweets, and tombstones", () => {
      expect(parseFxPayload(null)).toBeNull();
      expect(parseFxPayload({ code: 200 })).toBeNull();
      expect(parseFxPayload({ code: 200, status: { type: "tombstone" } })).toBeNull();
      expect(parseFxPayloadFromJson("{not-json")).toBeNull();
    });

    it("extracts full FxTwitter status with article, quote, media, poll, card, community note, and thread", () => {
      const payload = {
        code: 200,
        status: {
          id: "1001",
          url: "https://x.com/alice/status/1001",
          text: "Root post about Effect",
          created_at: "2026-01-15T10:00:00Z",
          created_timestamp: 1_768_471_200,
          author: { screen_name: "alice", name: "Alice" },
          replying_to: { screen_name: "alice" },
          raw_text: {
            facets: [
              { type: "url", replacement: "https://www.GitHub.com/effect-ts/effect", original: "https://t.co/abc" },
              { type: "url", replacement: "https://www.GitHub.com/effect-ts/effect" },
              { type: "url", original: "https://t.co/only" },
              { type: "url", original: "https://x.com/other/status/2" },
              { type: "url", original: "ftp://ignored.example" },
              { type: "url", original: "https://not a valid url" },
              { type: "mention", original: "@bob" },
            ],
          },
          card: {
            url: "https://effect.website/docs/intro",
            title: "Effect Docs",
            description: "Structured concurrency",
            domain: "www.Effect.website",
            image: { alt: "Card alt" },
          },
          article: {
            title: "Effect Guide",
            content: {
              blocks: [{ type: "unstyled", text: "Body paragraph" }],
              entityMap: [{ key: 0, value: { type: "LINK", data: { url: "https://orama.com/guide" } } }],
            },
          },
          quote: {
            author: { screen_name: "bob" },
            text: "Quoted thought",
            card: { url: "https://sqlite.org/fts5.html", title: "SQLite FTS5" },
            article: { title: "Quoted Essay", preview_text: "Preview" },
            raw_text: { facets: [{ type: "url", original: "https://twitter.com/ignored/status/3" }] },
          },
          media: {
            photos: [
              { url: "https://pbs.twimg.com/a.jpg", altText: "Diagram A" },
              { type: "photo", url: "https://pbs.twimg.com/b.jpg", altText: "   " },
              { altText: "Missing URL" },
            ],
            videos: [
              { url: "https://video.twimg.com/v.mp4" },
              { thumbnail_url: "https://pbs.twimg.com/thumb.jpg" },
              {},
            ],
            external: { url: "https://youtube.com/watch?v=1" },
          },
          poll: {
            choices: [{ label: "Orama", count: 80 }, { label: "SQLite", count: 20 }, { label: "   " }],
            total_votes: 100,
          },
          community_note: { text: "Helpful context" },
          likes: 50,
          reposts: 12,
          replies: 4,
          bookmarks: 99,
          views: 12_000,
          lang: "en",
        },
        thread: [
          {
            id: "1001",
            author: { screen_name: "alice" },
            created_at: "2026-01-15T10:00:00Z",
            text: "Root post about Effect",
          },
          { id: "1002", author: { screen_name: "alice" }, created_at: "2026-01-15T10:01:00Z", text: "Follow-up post" },
          { id: "1003", type: "tombstone", text: "Deleted" },
          { id: "1004", text: "   " },
        ],
      };

      const fields = parseFxPayloadFromJson(JSON.stringify(payload));
      expect(fields).not.toBeNull();
      if (fields === null) return;

      expect(fields.hydrationSource).toBe("fxtwitter");
      expect(fields.authorHandle).toBe("alice");
      expect(fields.authorName).toBe("Alice");
      expect(fields.replyingToHandle).toBe("alice");
      expect(fields.articleTitle).toBe("Effect Guide");
      expect(fields.articleText).toBe("Body paragraph");
      expect(fields.quoteAuthor).toBe("bob");
      expect(fields.quoteText).toBe("Quoted thought\n[Article] Quoted Essay\nSQLite FTS5");
      expect(fields.cardTitle).toBe("Effect Docs");
      expect(fields.cardDescription).toBe("Structured concurrency");
      expect(fields.cardUrl).toBe("https://effect.website/docs/intro");
      expect(fields.communityNote).toBe("Helpful context");
      expect(fields.pollJson).toContain("Orama");
      expect(fields.likes).toBe(50);
      expect(fields.reposts).toBe(12);
      expect(fields.replies).toBe(4);
      expect(fields.bookmarksCount).toBe(99);
      expect(fields.views).toBe(12_000);
      expect(fields.lang).toBe("en");
      expect(fields.domains).toEqual(["github.com", "effect.website", "orama.com", "sqlite.org"]);
      expect(fields.links.map((l) => `${l.source}:${l.domain}`)).toEqual([
        "tweet:github.com",
        "card:effect.website",
        "article:orama.com",
        "quote:sqlite.org",
      ]);
      expect(fields.threadPosts).toEqual([
        {
          postId: "1001",
          position: 0,
          authorHandle: "alice",
          createdAt: "2026-01-15T10:00:00Z",
          text: "Root post about Effect",
        },
        {
          postId: "1002",
          position: 1,
          authorHandle: "alice",
          createdAt: "2026-01-15T10:01:00Z",
          text: "Follow-up post",
        },
      ]);
      expect(fields.extraText).toBe(
        [
          "Diagram A",
          "Card alt",
          "Poll: Orama | SQLite",
          "Community Note: Helpful context",
          "Follow-up post",
          "github.com/effect-ts/effect effect.website/docs/intro orama.com/guide sqlite.org/fts5.html",
        ].join("\n"),
      );
      expect(fields.extraText).not.toContain("Root post about Effect");
      expect(fields.mediaJson).not.toBeNull();
      const parsedMedia = JSON.parse(fields.mediaJson ?? "[]") as Array<{
        type: string;
        url: string;
        alt: string | null;
      }>;
      expect(parsedMedia).toEqual([
        { type: "photo", url: "https://pbs.twimg.com/a.jpg", alt: "Diagram A" },
        { type: "photo", url: "https://pbs.twimg.com/b.jpg", alt: null },
        { type: "video", url: "https://video.twimg.com/v.mp4", alt: null },
        { type: "video", url: "https://pbs.twimg.com/thumb.jpg", alt: null },
        { type: "external", url: "https://youtube.com/watch?v=1", alt: null },
      ]);
      expect(fields.urls).toContain("https://www.GitHub.com/effect-ts/effect");
    });

    it("supports legacy tweet envelope, twitter.com card domain, quote article/facet links, and sub.www domains", () => {
      const fields = parseFxPayload({
        tweet: {
          text: "Minimal tweet",
          card: { domain: "twitter.com" },
          quote: {
            author: null,
            text: null,
            card: null,
            article: {
              title: null,
              content: {
                blocks: [{ type: "unstyled", text: "q" }],
                entityMap: [{ key: 0, value: { type: "LINK", data: { url: "https://quote-art.example/sub" } } }],
              },
            },
            raw_text: { facets: [{ type: "url", replacement: "https://sub.www.quote.org/" }] },
          },
          media: "not-an-object",
          poll: { choices: [] },
        },
        thread: [{ id: "1", text: "Single item thread" }],
      });
      expect(fields).not.toBeNull();
      if (fields === null) return;
      expect(fields.text).toBe("Minimal tweet");
      expect(fields.quoteAuthor).toBeNull();
      expect(fields.quoteText).toBeNull();
      expect(fields.mediaJson).toBeNull();
      expect(fields.pollJson).toBeNull();
      expect(fields.domains).toEqual(["quote-art.example", "sub.www.quote.org"]);
      expect(fields.links.map((l) => `${l.source}:${l.domain}`)).toEqual([
        "quote:quote-art.example",
        "quote:sub.www.quote.org",
      ]);
      expect(fields.threadPosts).toEqual([]);
      // Root path ("/") does NOT get added to extraText paths, while "/sub" does
      expect(fields.extraText).toBe("quote-art.example/sub");

      const tombQuote = parseFxPayload({
        tweet: { text: "t", card: { domain: "x.com" }, quote: { type: "tombstone", text: "gone" } },
      });
      expect(tombQuote?.quoteText).toBeNull();
      expect(tombQuote?.domains).toEqual([]);

      const cardOnlyDomain = parseFxPayload({
        tweet: { text: "c", card: { domain: "sub.www.valid.dev" } },
        thread: [{ id: "1", text: "t1" }, { text: "missing id" }, { id: "2", author: null, text: "t2" }],
      });
      expect(cardOnlyDomain?.domains).toEqual(["sub.www.valid.dev"]);
      expect(cardOnlyDomain?.threadPosts.map((p) => p.postId)).toEqual(["1", "2"]);
    });
  });

  describe("parseVxPayload & parseSyndicationPayload", () => {
    it("parses VxTwitter payloads and rejects invalid ones", () => {
      expect(parseVxPayload({})).toBeNull();
      const vx = parseVxPayload({
        tweetID: "555",
        tweetURL: "https://x.com/carol/status/555",
        user_screen_name: "carol",
        user_name: "Carol",
        date: "Wed Jan 01 2026",
        date_epoch: 1_767_225_600,
        text: "Hello from Vx",
        article: { title: "Vx Art", preview_text: "Vx Preview" },
        qrt: { user_screen_name: "dave", text: "Quoted by Vx" },
        likes: 10,
        retweets: 2,
        replies: 1,
        lang: "en",
      });
      expect(vx).not.toBeNull();
      if (vx === null) return;
      expect(vx.hydrationSource).toBe("vxtwitter");
      expect(vx.authorHandle).toBe("carol");
      expect(vx.createdTimestamp).toBe(1_767_225_600);
      expect(vx.articleTitle).toBe("Vx Art");
      expect(vx.articleText).toBe("Vx Preview");
      expect(vx.quoteAuthor).toBe("dave");
      expect(vx.quoteText).toBe("Quoted by Vx");
      expect(vx.likes).toBe(10);
      expect(vx.reposts).toBe(2);
      expect(vx.replies).toBe(1);
      expect(vx.rawJson).toContain('"fallback_provider":"vxtwitter"');
    });

    it("parses Syndication payloads with valid/invalid dates and alt texts", () => {
      expect(parseSyndicationPayload({})).toBeNull();
      const syn = parseSyndicationPayload({
        id_str: "777",
        created_at: "2026-01-15T10:00:00.000Z",
        text: "Syndication text",
        favorite_count: 33,
        lang: "en",
        user: { screen_name: "erin", name: "Erin" },
        quoted_tweet: { user: { screen_name: "frank" }, text: "Quoted syn" },
        mediaDetails: [{ ext_alt_text: "First alt" }, { ext_alt_text: "Second alt" }, { ext_alt_text: "   " }],
      });
      expect(syn).not.toBeNull();
      if (syn === null) return;
      expect(syn.hydrationSource).toBe("syndication");
      expect(syn.url).toBe("https://x.com/erin/status/777");
      expect(syn.createdTimestamp).toBe(1_768_471_200);
      expect(syn.likes).toBe(33);
      expect(syn.quoteAuthor).toBe("frank");
      expect(syn.quoteText).toBe("Quoted syn");
      expect(syn.extraText).toBe("First alt\nSecond alt");
      expect(syn.rawJson).toContain('"fallback_provider":"syndication"');

      const noUserBadDate = parseSyndicationPayload({
        id_str: "778",
        created_at: "not-a-date",
        text: "Fallback url",
      });
      expect(noUserBadDate?.url).toBeNull();
      expect(noUserBadDate?.createdTimestamp).toBeNull();
      expect(noUserBadDate?.extraText).toBeNull();
    });
  });
});
