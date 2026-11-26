import { createHash } from "node:crypto";
import { Schema } from "effect";

export const PARSER_VERSION = 3;

export const BookmarkId = Schema.String.pipe(Schema.brand("BookmarkId"));
export type BookmarkId = typeof BookmarkId.Type;

export const HydrationStatus = Schema.Literals(["pending", "ok", "unavailable", "error"]);
export type HydrationStatus = typeof HydrationStatus.Type;

export const HydrationSource = Schema.Literals(["fxtwitter", "vxtwitter", "syndication", "dom", "manual"]);
export type HydrationSource = typeof HydrationSource.Type;

export type LinkSource = "tweet" | "card" | "article" | "quote";

export interface ExtractedLink {
  readonly url: string;
  readonly domain: string;
  readonly source: LinkSource;
}

export interface ThreadPost {
  readonly postId: string;
  readonly position: number;
  readonly authorHandle: string | null;
  readonly createdAt: string | null;
  readonly text: string;
}

export interface FolderRef {
  readonly folderId: string;
  readonly folderName: string | null;
}

export interface CapturedBookmark {
  readonly id: BookmarkId;
  readonly url: string;
  readonly authorHandle: string | null;
  readonly authorName: string | null;
  readonly createdAt: string | null;
  readonly domText: string | null;
  readonly captureSource: string;
  readonly folderId: string | null;
  readonly folderName: string | null;
}

export interface HydratedFields {
  readonly url: string | null;
  readonly authorHandle: string | null;
  readonly authorName: string | null;
  readonly createdAt: string | null;
  readonly createdTimestamp: number | null;
  readonly replyingToHandle: string | null;
  readonly text: string | null;
  readonly articleTitle: string | null;
  readonly articleText: string | null;
  readonly quoteAuthor: string | null;
  readonly quoteText: string | null;
  readonly cardTitle: string | null;
  readonly cardDescription: string | null;
  readonly cardUrl: string | null;
  readonly pollJson: string | null;
  readonly communityNote: string | null;
  readonly extraText: string | null;
  readonly urls: ReadonlyArray<string>;
  readonly domains: ReadonlyArray<string>;
  readonly mediaJson: string | null;
  readonly likes: number | null;
  readonly reposts: number | null;
  readonly replies: number | null;
  readonly bookmarksCount: number | null;
  readonly views: number | null;
  readonly lang: string | null;
  readonly rawJson: string | null;
  readonly hydrationSource: HydrationSource | null;
  readonly links: ReadonlyArray<ExtractedLink>;
  readonly threadPosts: ReadonlyArray<ThreadPost>;
}

export interface BookmarkSummary {
  readonly id: BookmarkId;
  readonly url: string;
  readonly bookmarkSeq: number;
  readonly authorHandle: string | null;
  readonly authorName: string | null;
  readonly createdAt: string | null;
  readonly createdTimestamp: number | null;
  readonly capturedAt: string;
  readonly text: string | null;
  readonly articleTitle: string | null;
  readonly domains: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<string>;
  readonly folders: ReadonlyArray<FolderRef>;
  readonly hydrationStatus: HydrationStatus;
  readonly hydrationSource: HydrationSource | null;
}

export interface BookmarkDetail extends BookmarkSummary {
  readonly replyingToHandle: string | null;
  readonly captureSource: string;
  readonly domText: string | null;
  readonly articleText: string | null;
  readonly quoteAuthor: string | null;
  readonly quoteText: string | null;
  readonly cardTitle: string | null;
  readonly cardDescription: string | null;
  readonly cardUrl: string | null;
  readonly communityNote: string | null;
  readonly extraText: string | null;
  readonly urls: ReadonlyArray<string>;
  readonly likes: number | null;
  readonly reposts: number | null;
  readonly replies: number | null;
  readonly bookmarksCount: number | null;
  readonly views: number | null;
  readonly lang: string | null;
  readonly hydratedAt: string | null;
  readonly threadPosts: ReadonlyArray<ThreadPost>;
}

export interface IndexableBookmark {
  readonly id: BookmarkId;
  readonly url: string;
  readonly bookmarkSeq: number;
  readonly authorHandle: string;
  readonly authorName: string;
  readonly createdTimestamp: number;
  readonly text: string;
  readonly articleTitle: string;
  readonly articleText: string;
  readonly quoteText: string;
  readonly cardText: string;
  readonly extraText: string;
  readonly domains: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<string>;
  readonly folders: ReadonlyArray<string>;
  readonly hasArticle: boolean;
  readonly contentHash: string;
  readonly embeddingText: string;
}

export interface CountBucket {
  readonly key: string;
  readonly count: number;
}

export interface IndexStats {
  readonly total: number;
  readonly articles: number;
  readonly threads: number;
  readonly pruned: number;
  readonly embedded: number;
  readonly indexedVectors: number;
  readonly byStatus: ReadonlyArray<CountBucket>;
  readonly bySource: ReadonlyArray<CountBucket>;
  readonly topAuthors: ReadonlyArray<CountBucket>;
  readonly topDomains: ReadonlyArray<CountBucket>;
}

const SOURCE_QUALITY = {
  fxtwitter: 40,
  vxtwitter: 30,
  syndication: 20,
  dom: 10,
  manual: 5,
} satisfies Record<HydrationSource, number>;

export const canOverwriteSource = (existing: HydrationSource | null, incoming: HydrationSource | null): boolean => {
  const existingRank = existing === null ? 0 : SOURCE_QUALITY[existing];
  const incomingRank = incoming === null ? 0 : SOURCE_QUALITY[incoming];
  return incomingRank >= existingRank;
};

export const normalizeNonEmpty = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed !== "" ? trimmed : null;
};

export const normalizeTag = (raw: string): string | null => {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug !== "" ? slug : null;
};

const TWEET_URL_RE = /(?:x\.com|twitter\.com)\/([^/]+)\/status\/(\d+)/i;
const SNOWFLAKE_RE = /^\d{1,25}$/;

export interface ParsedTweetRef {
  readonly id: BookmarkId;
  readonly url: string;
  readonly authorHandle: string | null;
}

export const decodeBookmarkId = (raw: string): BookmarkId | null => {
  const trimmed = raw.trim();
  if (!SNOWFLAKE_RE.test(trimmed)) return null;
  return Schema.decodeSync(BookmarkId)(trimmed);
};

export const parseTweetRef = (input: string): ParsedTweetRef | null => {
  const trimmed = input.trim();
  const match = TWEET_URL_RE.exec(trimmed);
  if (match?.[1] !== undefined && match[2] !== undefined) {
    const id = decodeBookmarkId(match[2]);
    if (id !== null) return { id, url: `https://x.com/${match[1]}/status/${id}`, authorHandle: match[1] };
  }
  const id = decodeBookmarkId(trimmed);
  return id === null ? null : { id, url: `https://x.com/i/status/${id}`, authorHandle: null };
};

export const computeContentHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 32);

const MAX_EMBEDDING_CHARS = 24_000;

interface EmbeddingParts {
  readonly authorHandle: string | null;
  readonly text: string | null;
  readonly articleTitle: string | null;
  readonly articleText: string | null;
  readonly quoteText: string | null;
  readonly cardTitle: string | null;
  readonly cardDescription: string | null;
  readonly extraText: string | null;
  readonly domains: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<string>;
}

const labeled = (prefix: string, val: string | null): string | null => (val === null ? null : `${prefix}${val}`);

const joinedList = (prefix: string, list: ReadonlyArray<string>): string | null =>
  list.length > 0 ? `${prefix}${list.join(" ")}` : null;

export const buildEmbeddingText = (parts: EmbeddingParts): string => {
  const segments = [
    labeled("Author: @", parts.authorHandle),
    labeled("Article: ", parts.articleTitle),
    parts.text,
    parts.articleText,
    labeled("Quoted: ", parts.quoteText),
    parts.cardTitle,
    parts.cardDescription,
    parts.extraText,
    joinedList("Domains: ", parts.domains),
    joinedList("Tags: ", parts.tags),
  ].filter((s): s is string => s !== null);
  return segments.join("\n\n").slice(0, MAX_EMBEDDING_CHARS);
};

export const emptyHydratedFields = (rawJson: string | null = null): HydratedFields => ({
  url: null,
  authorHandle: null,
  authorName: null,
  createdAt: null,
  createdTimestamp: null,
  replyingToHandle: null,
  text: null,
  articleTitle: null,
  articleText: null,
  quoteAuthor: null,
  quoteText: null,
  cardTitle: null,
  cardDescription: null,
  cardUrl: null,
  pollJson: null,
  communityNote: null,
  extraText: null,
  urls: [],
  domains: [],
  mediaJson: null,
  likes: null,
  reposts: null,
  replies: null,
  bookmarksCount: null,
  views: null,
  lang: null,
  rawJson,
  hydrationSource: null,
  links: [],
  threadPosts: [],
});
