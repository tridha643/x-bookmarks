import { Option, Schema } from "effect";
import {
  emptyHydratedFields,
  normalizeNonEmpty,
  type ExtractedLink,
  type HydratedFields,
  type LinkSource,
  type ThreadPost,
} from "./bookmark.ts";

const EntityDataSchema = Schema.Struct({
  url: Schema.optional(Schema.NullOr(Schema.String)),
  markdown: Schema.optional(Schema.NullOr(Schema.String)),
  tweetId: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
});

const EntityValueSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  data: Schema.optional(Schema.NullOr(EntityDataSchema)),
});
type EntityValue = typeof EntityValueSchema.Type;

const EntityMapEntrySchema = Schema.Struct({
  key: Schema.Union([Schema.String, Schema.Number]),
  value: Schema.optional(EntityValueSchema),
  type: Schema.optional(Schema.String),
  data: Schema.optional(Schema.NullOr(EntityDataSchema)),
});

const EntityRangeSchema = Schema.Struct({
  key: Schema.Union([Schema.String, Schema.Number]),
  offset: Schema.optional(Schema.Number),
  length: Schema.optional(Schema.Number),
});

const ArticleBlockSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  entityRanges: Schema.optional(Schema.Array(EntityRangeSchema)),
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ urls: Schema.optional(Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }))) }),
    ),
  ),
});
type ArticleBlock = typeof ArticleBlockSchema.Type;

const ArticleSchema = Schema.Struct({
  title: Schema.optional(Schema.NullOr(Schema.String)),
  preview_text: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        blocks: Schema.optional(Schema.Array(ArticleBlockSchema)),
        entityMap: Schema.optional(
          Schema.NullOr(
            Schema.Union([Schema.Array(EntityMapEntrySchema), Schema.Record(Schema.String, EntityValueSchema)]),
          ),
        ),
      }),
    ),
  ),
});
type RawArticle = typeof ArticleSchema.Type;

const FacetSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  original: Schema.optional(Schema.NullOr(Schema.String)),
  replacement: Schema.optional(Schema.NullOr(Schema.String)),
});

const CardSchema = Schema.Struct({
  url: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  domain: Schema.optional(Schema.NullOr(Schema.String)),
  image: Schema.optional(Schema.NullOr(Schema.Struct({ alt: Schema.optional(Schema.NullOr(Schema.String)) }))),
});

const MediaObjectSchema = Schema.Struct({
  photos: Schema.optional(
    Schema.Array(
      Schema.Struct({
        type: Schema.optional(Schema.String),
        url: Schema.optional(Schema.String),
        altText: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  videos: Schema.optional(
    Schema.Array(
      Schema.Struct({
        type: Schema.optional(Schema.String),
        url: Schema.optional(Schema.String),
        thumbnail_url: Schema.optional(Schema.String),
      }),
    ),
  ),
  external: Schema.optional(
    Schema.NullOr(Schema.Struct({ type: Schema.optional(Schema.String), url: Schema.optional(Schema.String) })),
  ),
});
type MediaObject = typeof MediaObjectSchema.Type;

const AuthorSchema = Schema.Struct({
  screen_name: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
});

const PollSchema = Schema.Struct({
  choices: Schema.optional(
    Schema.Array(Schema.Struct({ label: Schema.optional(Schema.String), count: Schema.optional(Schema.Number) })),
  ),
  total_votes: Schema.optional(Schema.Number),
});

const BaseTweetFields = {
  type: Schema.optional(Schema.String),
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  text: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  created_timestamp: Schema.optional(Schema.NullOr(Schema.Number)),
  author: Schema.optional(Schema.NullOr(AuthorSchema)),
  replying_to: Schema.optional(
    Schema.NullOr(Schema.Struct({ screen_name: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
  raw_text: Schema.optional(Schema.NullOr(Schema.Struct({ facets: Schema.optional(Schema.Array(FacetSchema)) }))),
  card: Schema.optional(Schema.NullOr(CardSchema)),
  article: Schema.optional(Schema.NullOr(ArticleSchema)),
  media: Schema.optional(Schema.Unknown),
  poll: Schema.optional(Schema.NullOr(PollSchema)),
  community_note: Schema.optional(
    Schema.NullOr(Schema.Struct({ text: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
  likes: Schema.optional(Schema.NullOr(Schema.Number)),
  reposts: Schema.optional(Schema.NullOr(Schema.Number)),
  replies: Schema.optional(Schema.NullOr(Schema.Number)),
  bookmarks: Schema.optional(Schema.NullOr(Schema.Number)),
  views: Schema.optional(Schema.NullOr(Schema.Number)),
  lang: Schema.optional(Schema.NullOr(Schema.String)),
};

const QuotedTweetSchema = Schema.Struct(BaseTweetFields);
type RawQuotedTweet = typeof QuotedTweetSchema.Type;

const FxTweetSchema = Schema.Struct({ ...BaseTweetFields, quote: Schema.optional(Schema.NullOr(QuotedTweetSchema)) });
type RawFxTweet = typeof FxTweetSchema.Type;

const FxEnvelopeSchema = Schema.Struct({
  code: Schema.optional(Schema.Number),
  status: Schema.optional(Schema.NullOr(FxTweetSchema)),
  tweet: Schema.optional(Schema.NullOr(FxTweetSchema)),
  thread: Schema.optional(Schema.NullOr(Schema.Array(QuotedTweetSchema))),
});

const VxPayloadSchema = Schema.Struct({
  tweetID: Schema.String,
  tweetURL: Schema.optional(Schema.NullOr(Schema.String)),
  user_screen_name: Schema.optional(Schema.NullOr(Schema.String)),
  user_name: Schema.optional(Schema.NullOr(Schema.String)),
  date: Schema.optional(Schema.NullOr(Schema.String)),
  date_epoch: Schema.optional(Schema.NullOr(Schema.Number)),
  text: Schema.optional(Schema.NullOr(Schema.String)),
  article: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        title: Schema.optional(Schema.NullOr(Schema.String)),
        preview_text: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  qrt: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        user_screen_name: Schema.optional(Schema.NullOr(Schema.String)),
        text: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  likes: Schema.optional(Schema.NullOr(Schema.Number)),
  retweets: Schema.optional(Schema.NullOr(Schema.Number)),
  replies: Schema.optional(Schema.NullOr(Schema.Number)),
  lang: Schema.optional(Schema.NullOr(Schema.String)),
});

const SyndicationPayloadSchema = Schema.Struct({
  id_str: Schema.String,
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  text: Schema.optional(Schema.NullOr(Schema.String)),
  favorite_count: Schema.optional(Schema.NullOr(Schema.Number)),
  lang: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(AuthorSchema)),
  quoted_tweet: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        user: Schema.optional(Schema.NullOr(AuthorSchema)),
        text: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  mediaDetails: Schema.optional(
    Schema.Array(Schema.Struct({ ext_alt_text: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});

interface NormalizedUrl {
  readonly url: string;
  readonly domain: string;
}

const normalizeUrl = (raw: string | null | undefined): NormalizedUrl | null => {
  const trimmed = normalizeNonEmpty(raw);
  if (trimmed === null || (!trimmed.startsWith("http://") && !trimmed.startsWith("https://"))) return null;
  try {
    const parsed = new URL(trimmed);
    const domain = parsed.hostname.replace(/^www\./, "").toLowerCase();
    return domain.length === 0 || domain === "t.co" ? null : { url: trimmed, domain };
  } catch {
    return null;
  }
};

const buildEntityLookup = (rawMap: NonNullable<RawArticle["content"]>["entityMap"]): Map<string, EntityValue> => {
  const lookup = new Map<string, EntityValue>();
  if (rawMap === null || rawMap === undefined) return lookup;
  if (Array.isArray(rawMap)) {
    for (const entry of rawMap) lookup.set(String(entry.key), entry.value ?? { type: entry.type, data: entry.data });
    return lookup;
  }
  for (const [k, v] of Object.entries(rawMap)) lookup.set(k, v);
  return lookup;
};

const renderAtomicEntity = (entity: EntityValue, urls: string[]): string | null => {
  const md = normalizeNonEmpty(entity.data?.markdown);
  if (entity.type === "MARKDOWN" && md !== null) return md;
  const tweetId = entity.data?.tweetId;
  if (entity.type === "TWEET" && tweetId !== undefined && tweetId !== null) {
    const tweetUrl = `https://x.com/i/status/${String(tweetId)}`;
    urls.push(tweetUrl);
    return `[Embedded post: ${tweetUrl}]`;
  }
  return null;
};

const renderAtomicBlock = (block: ArticleBlock, lookup: Map<string, EntityValue>, urls: string[]): string[] => {
  const out: string[] = [];
  for (const range of block.entityRanges ?? []) {
    const entity = lookup.get(String(range.key));
    const rendered = entity === undefined ? null : renderAtomicEntity(entity, urls);
    if (rendered !== null) out.push(rendered);
  }
  return out;
};

const applyInlineLinks = (block: ArticleBlock, lookup: Map<string, EntityValue>): string => {
  let text = block.text ?? "";
  const ranges = (block.entityRanges ?? [])
    .map((r) => {
      const ent = lookup.get(String(r.key));
      return {
        offset: r.offset ?? 0,
        length: r.length ?? 0,
        url: normalizeNonEmpty(ent?.data?.url),
        isLink: ent?.type === "LINK",
      };
    })
    .filter((r) => r.isLink && r.url !== null && r.length > 0)
    .sort((a, b) => b.offset - a.offset);

  for (const r of ranges) {
    if (r.url === null) continue;
    text = `${text.slice(0, r.offset)}[${text.slice(r.offset, r.offset + r.length)}](${r.url})${text.slice(r.offset + r.length)}`;
  }
  return text.trim();
};

const BLOCK_PREFIX = new Map<string, string>([
  ["header-one", "# "],
  ["header-two", "## "],
  ["header-three", "### "],
  ["blockquote", "> "],
  ["unordered-list-item", "- "],
]);

const formatBlockLine = (blockType: string, text: string, orderedIndex: number): string => {
  if (blockType === "ordered-list-item") return `${orderedIndex}. ${text}`;
  const prefix = BLOCK_PREFIX.get(blockType);
  return prefix === undefined ? text : `${prefix}${text}`;
};

const collectBlockUrls = (block: ArticleBlock, urls: string[]): void => {
  for (const u of block.data?.urls ?? []) {
    const candidate = normalizeNonEmpty(u.text);
    if (candidate !== null && candidate.startsWith("http")) urls.push(candidate);
  }
};

const collectEntityLinkUrls = (lookup: Map<string, EntityValue>, urls: string[]): void => {
  for (const entity of lookup.values()) {
    const url = normalizeNonEmpty(entity.data?.url);
    if (entity.type === "LINK" && url !== null) urls.push(url);
  }
};

const renderBlocks = (
  blocks: ReadonlyArray<ArticleBlock>,
  lookup: Map<string, EntityValue>,
  urls: string[],
): string[] => {
  const lines: string[] = [];
  let orderedCounter = 0;
  for (const block of blocks) {
    const blockType = block.type ?? "unstyled";
    orderedCounter = blockType === "ordered-list-item" ? orderedCounter + 1 : 0;
    collectBlockUrls(block, urls);
    if (blockType === "atomic") {
      lines.push(...renderAtomicBlock(block, lookup, urls));
      continue;
    }
    const text = applyInlineLinks(block, lookup);
    if (text.length > 0) lines.push(formatBlockLine(blockType, text, orderedCounter));
  }
  return lines;
};

interface RenderedArticle {
  readonly title: string | null;
  readonly markdown: string | null;
  readonly urls: ReadonlyArray<string>;
}

export const renderArticleMarkdown = (articleInput: unknown): RenderedArticle => {
  const decoded = Schema.decodeUnknownOption(ArticleSchema)(articleInput);
  if (Option.isNone(decoded)) return { title: null, markdown: null, urls: [] };
  const article = decoded.value;
  const title = normalizeNonEmpty(article.title);
  const urls: string[] = [];
  const lookup = buildEntityLookup(article.content?.entityMap);
  collectEntityLinkUrls(lookup, urls);

  const blocks = article.content?.blocks ?? [];
  if (blocks.length === 0) return { title, markdown: normalizeNonEmpty(article.preview_text), urls };
  const lines = renderBlocks(blocks, lookup, urls);
  return { title, markdown: normalizeNonEmpty(lines.join("\n\n")) ?? normalizeNonEmpty(article.preview_text), urls };
};

const THREAD_HINT_RE = /🧵|\b1\/\d+|\(1\/|\bthread\b|👇/i;

export const looksLikeThread = (
  authorHandle: string | null,
  replyingToHandle: string | null,
  text: string | null,
): boolean => {
  if (
    authorHandle !== null &&
    replyingToHandle !== null &&
    authorHandle.toLowerCase() === replyingToHandle.toLowerCase()
  ) {
    return true;
  }
  return text !== null && THREAD_HINT_RE.test(text);
};

interface LinkBag {
  readonly links: ExtractedLink[];
  readonly urls: Set<string>;
  readonly domains: Set<string>;
  readonly paths: string[];
  readonly seen: Set<string>;
}

const createLinkBag = (): LinkBag => ({ links: [], urls: new Set(), domains: new Set(), paths: [], seen: new Set() });

const addLinkToBag = (bag: LinkBag, raw: string | null | undefined, source: LinkSource): void => {
  const norm = normalizeUrl(raw);
  if (norm === null) return;
  const key = `${source}|${norm.url}`;
  if (bag.seen.has(key)) return;
  bag.seen.add(key);
  bag.urls.add(norm.url);
  if (norm.domain === "x.com" || norm.domain === "twitter.com") return;
  bag.domains.add(norm.domain);
  bag.links.push({ url: norm.url, domain: norm.domain, source });
  const parsed = new URL(norm.url);
  if (parsed.pathname.length > 1) bag.paths.push(`${norm.domain}${parsed.pathname}`);
};

const addFacetLinks = (
  bag: LinkBag,
  facets: ReadonlyArray<typeof FacetSchema.Type> | undefined,
  source: LinkSource,
): void => {
  for (const f of facets ?? []) {
    if (f.type === "url") addLinkToBag(bag, f.replacement ?? f.original, source);
  }
};

interface MediaItem {
  readonly type: string;
  readonly url: string;
  readonly alt: string | null;
}

interface MediaSummary {
  readonly mediaJson: string | null;
  readonly altTexts: ReadonlyArray<string>;
}

const collectPhotoItems = (photos: MediaObject["photos"], items: MediaItem[], altTexts: string[]): void => {
  for (const p of photos ?? []) {
    if (p.url === undefined) continue;
    const alt = normalizeNonEmpty(p.altText);
    items.push({ type: p.type ?? "photo", url: p.url, alt });
    if (alt !== null) altTexts.push(alt);
  }
};

const collectVideoItems = (media: MediaObject, items: MediaItem[]): void => {
  for (const v of media.videos ?? []) {
    const url = v.url ?? v.thumbnail_url;
    if (url !== undefined) items.push({ type: v.type ?? "video", url, alt: null });
  }
  if (media.external?.url !== undefined) {
    items.push({ type: media.external.type ?? "external", url: media.external.url, alt: null });
  }
};

const collectMediaSummary = (mediaRaw: unknown): MediaSummary => {
  const dec = Schema.decodeUnknownOption(MediaObjectSchema)(mediaRaw);
  if (Option.isNone(dec)) return { mediaJson: null, altTexts: [] };
  const items: MediaItem[] = [];
  const altTexts: string[] = [];
  collectPhotoItems(dec.value.photos, items, altTexts);
  collectVideoItems(dec.value, items);
  return { mediaJson: items.length > 0 ? JSON.stringify(items) : null, altTexts };
};

interface QuoteDetails {
  readonly quoteAuthor: string | null;
  readonly quoteText: string | null;
}

const collectQuoteParts = (quote: RawQuotedTweet, quoteArticleTitle: string | null): ReadonlyArray<string> =>
  [
    normalizeNonEmpty(quote.text),
    quoteArticleTitle === null ? null : `[Article] ${quoteArticleTitle}`,
    normalizeNonEmpty(quote.card?.title),
  ].filter((p): p is string => p !== null);

const extractQuoteDetails = (quote: RawQuotedTweet | null | undefined, bag: LinkBag): QuoteDetails => {
  if (quote === null || quote === undefined || quote.type === "tombstone")
    return { quoteAuthor: null, quoteText: null };
  const quoteArticle = renderArticleMarkdown(quote.article);
  for (const u of quoteArticle.urls) addLinkToBag(bag, u, "quote");
  addLinkToBag(bag, quote.card?.url, "quote");
  addFacetLinks(bag, quote.raw_text?.facets, "quote");
  const parts = collectQuoteParts(quote, quoteArticle.title);
  return {
    quoteAuthor: normalizeNonEmpty(quote.author?.screen_name),
    quoteText: parts.length > 0 ? parts.join("\n") : null,
  };
};

interface ThreadExtract {
  readonly posts: ReadonlyArray<ThreadPost>;
  readonly continuationTexts: ReadonlyArray<string>;
}

const parseThreadItem = (p: RawQuotedTweet | undefined, position: number): ThreadPost | null => {
  if (p === undefined || p.type === "tombstone" || p.id === undefined) return null;
  const text = normalizeNonEmpty(p.text);
  if (text === null) return null;
  return {
    postId: String(p.id),
    position,
    authorHandle: normalizeNonEmpty(p.author?.screen_name),
    createdAt: normalizeNonEmpty(p.created_at),
    text,
  };
};

const extractThreadPosts = (
  thread: ReadonlyArray<RawQuotedTweet> | null | undefined,
  focalId: string | undefined,
): ThreadExtract => {
  if (thread === null || thread === undefined || thread.length <= 1) return { posts: [], continuationTexts: [] };
  const posts: ThreadPost[] = [];
  const continuationTexts: string[] = [];
  for (let i = 0; i < thread.length; i++) {
    const item = parseThreadItem(thread[i], i);
    if (item === null) continue;
    posts.push(item);
    if (item.postId !== focalId) continuationTexts.push(item.text);
  }
  return { posts, continuationTexts };
};

interface PollInfo {
  readonly pollJson: string | null;
  readonly pollLine: string | null;
}

const extractPollInfo = (poll: RawFxTweet["poll"]): PollInfo => {
  const choices = (poll?.choices ?? []).map((c) => normalizeNonEmpty(c.label)).filter((x): x is string => x !== null);
  return choices.length === 0
    ? { pollJson: null, pollLine: null }
    : { pollJson: JSON.stringify(poll), pollLine: `Poll: ${choices.join(" | ")}` };
};

const addCardDomain = (bag: LinkBag, domainRaw: string | null | undefined): void => {
  const dom = normalizeNonEmpty(domainRaw)
    ?.replace(/^www\./, "")
    .toLowerCase();
  if (dom !== undefined && dom !== "x.com" && dom !== "twitter.com") bag.domains.add(dom);
};

const buildMetrics = (tweet: RawFxTweet) => ({
  likes: tweet.likes ?? null,
  reposts: tweet.reposts ?? null,
  replies: tweet.replies ?? null,
  bookmarksCount: tweet.bookmarks ?? null,
  views: tweet.views ?? null,
  lang: normalizeNonEmpty(tweet.lang),
});

const buildCardFields = (tweet: RawFxTweet) => ({
  cardTitle: normalizeNonEmpty(tweet.card?.title),
  cardDescription: normalizeNonEmpty(tweet.card?.description),
  cardUrl: normalizeNonEmpty(tweet.card?.url),
});

const buildFxIdentity = (tweet: RawFxTweet) => ({
  url: normalizeNonEmpty(tweet.url),
  authorHandle: normalizeNonEmpty(tweet.author?.screen_name),
  authorName: normalizeNonEmpty(tweet.author?.name),
  createdAt: normalizeNonEmpty(tweet.created_at),
  createdTimestamp: tweet.created_timestamp ?? null,
  replyingToHandle: normalizeNonEmpty(tweet.replying_to?.screen_name),
  text: normalizeNonEmpty(tweet.text),
});

const buildFxExtraText = (
  tweet: RawFxTweet,
  media: MediaSummary,
  poll: PollInfo,
  communityNote: string | null,
  thread: ThreadExtract,
  bag: LinkBag,
): string | null => {
  const parts = [
    ...media.altTexts,
    normalizeNonEmpty(tweet.card?.image?.alt),
    poll.pollLine,
    communityNote === null ? null : `Community Note: ${communityNote}`,
    ...thread.continuationTexts,
    bag.paths.length > 0 ? bag.paths.join(" ") : null,
  ].filter((x): x is string => x !== null);
  return parts.length > 0 ? parts.join("\n") : null;
};

const buildFxCore = (tweet: RawFxTweet, rawPayload: unknown) => ({
  ...buildFxIdentity(tweet),
  ...buildCardFields(tweet),
  ...buildMetrics(tweet),
  rawJson: JSON.stringify(rawPayload),
  hydrationSource: "fxtwitter" as const,
});

const collectFxLinks = (tweet: RawFxTweet, articleUrls: ReadonlyArray<string>): LinkBag => {
  const bag = createLinkBag();
  addFacetLinks(bag, tweet.raw_text?.facets, "tweet");
  addLinkToBag(bag, tweet.card?.url, "card");
  addCardDomain(bag, tweet.card?.domain);
  for (const u of articleUrls) addLinkToBag(bag, u, "article");
  return bag;
};

interface ExtractedFxTweet {
  readonly tweet: RawFxTweet;
  readonly thread: ReadonlyArray<RawQuotedTweet> | null | undefined;
}

const extractFxTweet = (rawPayload: unknown): ExtractedFxTweet | null => {
  const decoded = Schema.decodeUnknownOption(FxEnvelopeSchema)(rawPayload);
  if (Option.isNone(decoded)) return null;
  const tweet = decoded.value.status ?? decoded.value.tweet;
  if (tweet === null || tweet === undefined || tweet.type === "tombstone") return null;
  return { tweet, thread: decoded.value.thread };
};

export const parseFxPayload = (rawPayload: unknown): HydratedFields | null => {
  const extracted = extractFxTweet(rawPayload);
  if (extracted === null) return null;
  const { tweet } = extracted;
  const article = renderArticleMarkdown(tweet.article);
  const bag = collectFxLinks(tweet, article.urls);
  const quote = extractQuoteDetails(tweet.quote, bag);
  const media = collectMediaSummary(tweet.media);
  const poll = extractPollInfo(tweet.poll);
  const communityNote = normalizeNonEmpty(tweet.community_note?.text);
  const thread = extractThreadPosts(extracted.thread, tweet.id === undefined ? undefined : String(tweet.id));

  return {
    ...buildFxCore(tweet, rawPayload),
    articleTitle: article.title,
    articleText: article.markdown,
    quoteAuthor: quote.quoteAuthor,
    quoteText: quote.quoteText,
    pollJson: poll.pollJson,
    communityNote,
    extraText: buildFxExtraText(tweet, media, poll, communityNote, thread, bag),
    urls: [...bag.urls],
    domains: [...bag.domains],
    mediaJson: media.mediaJson,
    links: bag.links,
    threadPosts: thread.posts,
  };
};

export const parseFxPayloadFromJson = (rawJson: string): HydratedFields | null => {
  try {
    return parseFxPayload(JSON.parse(rawJson));
  } catch {
    return null;
  }
};

export const parseVxPayload = (rawPayload: unknown): HydratedFields | null => {
  const decoded = Schema.decodeUnknownOption(VxPayloadSchema)(rawPayload);
  if (Option.isNone(decoded)) return null;
  const d = decoded.value;
  return {
    ...emptyHydratedFields(JSON.stringify({ fallback_provider: "vxtwitter", data: d })),
    url: normalizeNonEmpty(d.tweetURL),
    authorHandle: normalizeNonEmpty(d.user_screen_name),
    authorName: normalizeNonEmpty(d.user_name),
    createdAt: normalizeNonEmpty(d.date),
    createdTimestamp: d.date_epoch ?? null,
    text: normalizeNonEmpty(d.text),
    articleTitle: normalizeNonEmpty(d.article?.title),
    articleText: normalizeNonEmpty(d.article?.preview_text),
    quoteAuthor: normalizeNonEmpty(d.qrt?.user_screen_name),
    quoteText: normalizeNonEmpty(d.qrt?.text),
    likes: d.likes ?? null,
    reposts: d.retweets ?? null,
    replies: d.replies ?? null,
    lang: normalizeNonEmpty(d.lang),
    hydrationSource: "vxtwitter",
  };
};

const parseEpochSeconds = (dateStr: string | null | undefined): number | null => {
  const clean = normalizeNonEmpty(dateStr);
  if (clean === null) return null;
  const ms = Date.parse(clean);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
};

export const parseSyndicationPayload = (rawPayload: unknown): HydratedFields | null => {
  const decoded = Schema.decodeUnknownOption(SyndicationPayloadSchema)(rawPayload);
  if (Option.isNone(decoded)) return null;
  const d = decoded.value;
  const altTexts = (d.mediaDetails ?? [])
    .map((m) => normalizeNonEmpty(m.ext_alt_text))
    .filter((x): x is string => x !== null);
  const handle = normalizeNonEmpty(d.user?.screen_name);
  return {
    ...emptyHydratedFields(JSON.stringify({ fallback_provider: "syndication", data: d })),
    url: handle === null ? null : `https://x.com/${handle}/status/${d.id_str}`,
    authorHandle: handle,
    authorName: normalizeNonEmpty(d.user?.name),
    createdAt: normalizeNonEmpty(d.created_at),
    createdTimestamp: parseEpochSeconds(d.created_at),
    text: normalizeNonEmpty(d.text),
    quoteAuthor: normalizeNonEmpty(d.quoted_tweet?.user?.screen_name),
    quoteText: normalizeNonEmpty(d.quoted_tweet?.text),
    extraText: altTexts.length > 0 ? altTexts.join("\n") : null,
    likes: d.favorite_count ?? null,
    lang: normalizeNonEmpty(d.lang),
    hydrationSource: "syndication",
  };
};
