import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  HydrationSource,
  HydrationStatus,
  PARSER_VERSION,
  buildEmbeddingText,
  canOverwriteSource,
  computeContentHash,
  decodeBookmarkId,
  emptyHydratedFields,
  normalizeNonEmpty,
  normalizeTag,
  parseTweetRef,
} from "./bookmark.ts";

describe("domain/bookmark", () => {
  it("exposes parser version 3 and decodes hydration status and source literals", () => {
    expect(PARSER_VERSION).toBe(3);
    for (const st of ["pending", "ok", "unavailable", "error"] as const) {
      expect(Schema.decodeUnknownSync(HydrationStatus)(st)).toBe(st);
    }
    for (const src of ["fxtwitter", "vxtwitter", "syndication", "dom", "manual"] as const) {
      expect(Schema.decodeUnknownSync(HydrationSource)(src)).toBe(src);
    }
  });

  it("enforces source quality hierarchy when overwriting", () => {
    expect(canOverwriteSource(null, null)).toBe(true);
    expect(canOverwriteSource(null, "manual")).toBe(true);
    expect(canOverwriteSource("manual", null)).toBe(false);
    expect(canOverwriteSource("manual", "dom")).toBe(true);
    expect(canOverwriteSource("dom", "syndication")).toBe(true);
    expect(canOverwriteSource("syndication", "vxtwitter")).toBe(true);
    expect(canOverwriteSource("vxtwitter", "fxtwitter")).toBe(true);
    expect(canOverwriteSource("fxtwitter", "fxtwitter")).toBe(true);
    expect(canOverwriteSource("fxtwitter", "vxtwitter")).toBe(false);
    expect(canOverwriteSource("vxtwitter", "syndication")).toBe(false);
    expect(canOverwriteSource("syndication", "dom")).toBe(false);
    expect(canOverwriteSource("dom", "manual")).toBe(false);
  });

  it("normalizes non-empty strings", () => {
    expect(normalizeNonEmpty(null)).toBeNull();
    expect(normalizeNonEmpty(undefined)).toBeNull();
    expect(normalizeNonEmpty("   \n\t  ")).toBeNull();
    expect(normalizeNonEmpty("  hello world  ")).toBe("hello world");
  });

  it("normalizes tag slugs cleanly", () => {
    expect(normalizeTag("  AI Agents!  ")).toBe("ai-agents");
    expect(normalizeTag("effect_v4-rc")).toBe("effect_v4-rc");
    expect(normalizeTag("---foo---")).toBe("foo");
    expect(normalizeTag("!!!")).toBeNull();
    expect(normalizeTag("   ")).toBeNull();
  });

  it("decodes valid snowflake bookmark IDs and rejects invalid ones", () => {
    expect(decodeBookmarkId(" 1234567890123456789 ")).toBe("1234567890123456789");
    expect(decodeBookmarkId("1")).toBe("1");
    expect(decodeBookmarkId("1234567890123456789012345")).toBe("1234567890123456789012345");
    expect(decodeBookmarkId("12345678901234567890123456")).toBeNull();
    expect(decodeBookmarkId("")).toBeNull();
    expect(decodeBookmarkId("abc")).toBeNull();
    expect(decodeBookmarkId("123abc")).toBeNull();
  });

  it("parses x.com, twitter.com, and raw numeric tweet references", () => {
    expect(parseTweetRef("  https://x.com/AliceDev/status/1900000000000000001?s=20  ")).toEqual({
      id: "1900000000000000001",
      url: "https://x.com/AliceDev/status/1900000000000000001",
      authorHandle: "AliceDev",
    });
    expect(parseTweetRef("https://TWITTER.COM/bob/status/42")).toEqual({
      id: "42",
      url: "https://x.com/bob/status/42",
      authorHandle: "bob",
    });
    expect(parseTweetRef(" 99887766 ")).toEqual({
      id: "99887766",
      url: "https://x.com/i/status/99887766",
      authorHandle: null,
    });
    expect(parseTweetRef("https://x.com/alice/status/123456789012345678901234567890")).toBeNull();
    expect(parseTweetRef("https://example.com/not-a-tweet")).toBeNull();
  });

  it("computes deterministic 32-hex-char SHA-256 content hashes", () => {
    const h1 = computeContentHash("hello");
    const h2 = computeContentHash("hello");
    const h3 = computeContentHash("world");
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toMatch(/^[0-9a-f]{32}$/);
  });

  it("builds labeled embedding text and truncates at 24000 chars", () => {
    const text = buildEmbeddingText({
      authorHandle: "alice",
      text: "Main post",
      articleTitle: "Deep Dive",
      articleText: "Article body",
      quoteText: "Quoted claim",
      cardTitle: "Card Title",
      cardDescription: "Card Desc",
      extraText: "Alt text",
      domains: ["github.com", "effect.website"],
      tags: ["effect", "search"],
    });
    expect(text).toBe(
      [
        "Author: @alice",
        "Article: Deep Dive",
        "Main post",
        "Article body",
        "Quoted: Quoted claim",
        "Card Title",
        "Card Desc",
        "Alt text",
        "Domains: github.com effect.website",
        "Tags: effect search",
      ].join("\n\n"),
    );

    const minimal = buildEmbeddingText({
      authorHandle: null,
      text: null,
      articleTitle: null,
      articleText: null,
      quoteText: null,
      cardTitle: null,
      cardDescription: null,
      extraText: null,
      domains: [],
      tags: [],
    });
    expect(minimal).toBe("");

    const huge = buildEmbeddingText({
      authorHandle: null,
      text: "x".repeat(30_000),
      articleTitle: null,
      articleText: null,
      quoteText: null,
      cardTitle: null,
      cardDescription: null,
      extraText: null,
      domains: [],
      tags: [],
    });
    expect(huge.length).toBe(24_000);
  });

  it("constructs empty hydrated fields with optional rawJson", () => {
    const def = emptyHydratedFields();
    expect(def.rawJson).toBeNull();
    expect(def.urls).toEqual([]);
    expect(def.domains).toEqual([]);
    expect(def.links).toEqual([]);
    expect(def.threadPosts).toEqual([]);
    expect(def.hydrationSource).toBeNull();

    const withRaw = emptyHydratedFields('{"code":404}');
    expect(withRaw.rawJson).toBe('{"code":404}');
  });
});
