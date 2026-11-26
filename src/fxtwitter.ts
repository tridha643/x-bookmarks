import type { ExtractedLink, HydratedFields, ThreadPostInput } from "./db.ts";

const USER_AGENT = "x-bookmarks-local-indexer/0.2 (+local-personal-archive)";
const FX_STATUS_BASE = "https://api.fxtwitter.com/2/status";
const FX_THREAD_BASE = "https://api.fxtwitter.com/2/thread";
const VX_STATUS_BASE = "https://api.vxtwitter.com/Twitter/status";
const SYNDICATION_BASE = "https://cdn.syndication.twimg.com/tweet-result";

// Client-side rate limit shared by every outbound request (status, thread, fallbacks), so one
// bookmark with a thread can't burst. Default ~1 request per 1.5-2s; override via env.
const MIN_REQUEST_INTERVAL_MS = Number(process.env.X_BOOKMARKS_MIN_REQUEST_MS ?? 1500);
const REQUEST_JITTER_MS = 500;
let nextRequestAt = 0;

async function throttledFetch(url: string, init?: RequestInit): Promise<Response> {
  const now = Date.now();
  const startAt = Math.max(now, nextRequestAt);
  nextRequestAt = startAt + MIN_REQUEST_INTERVAL_MS + Math.random() * REQUEST_JITTER_MS;
  if (startAt > now) await Bun.sleep(startAt - now);
  return fetch(url, init);
}

export interface FxFetchResult {
  status: "ok" | "unavailable" | "error";
  fields: HydratedFields;
  error?: string;
  rateLimited?: boolean;
  retryAfterSeconds?: number | null;
}

function normalizeUrl(raw: unknown): { url: string; domain: string } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return null;
  try {
    const parsed = new URL(trimmed);
    const domain = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (!domain || domain === "t.co") return null;
    return { url: trimmed, domain };
  } catch {
    return null;
  }
}

/**
 * Renders FxTwitter's Draft.js X Article payload into clean Markdown,
 * preserving headings, lists, blockquotes, fenced code blocks (MARKDOWN entities),
 * inline/entity links (LINK entities + block.data.urls), and embedded tweets (TWEET entities).
 */
export function renderArticleMarkdown(article: any): {
  title: string | null;
  markdown: string | null;
  urls: string[];
} {
  if (!article || typeof article !== "object") {
    return { title: null, markdown: null, urls: [] };
  }

  const title = typeof article.title === "string" && article.title.trim() ? article.title.trim() : null;
  const urls: string[] = [];

  // Build entity lookup keyed by String(key) (Draft.js entityRanges use numeric keys while entityMap uses string keys)
  const entityLookup = new Map<string, any>();
  const rawEntityMap = article?.content?.entityMap;
  if (Array.isArray(rawEntityMap)) {
    for (const entry of rawEntityMap) {
      if (entry && entry.key !== undefined) {
        entityLookup.set(String(entry.key), entry.value ?? entry);
      }
    }
  } else if (rawEntityMap && typeof rawEntityMap === "object") {
    for (const [k, v] of Object.entries(rawEntityMap)) {
      entityLookup.set(String(k), v);
    }
  }

  // Collect all LINK entity URLs up front
  for (const entity of entityLookup.values()) {
    if (entity?.type === "LINK" && typeof entity?.data?.url === "string") {
      urls.push(entity.data.url);
    }
  }

  const blocks = article?.content?.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    const preview =
      typeof article.preview_text === "string" && article.preview_text.trim()
        ? article.preview_text.trim()
        : null;
    return { title, markdown: preview, urls };
  }

  const lines: string[] = [];
  let orderedCounter = 0;

  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const blockType = String(block.type || "unstyled");
    if (blockType !== "ordered-list-item") orderedCounter = 0;

    // Collect URLs embedded in block.data.urls
    if (Array.isArray(block?.data?.urls)) {
      for (const u of block.data.urls) {
        if (typeof u?.text === "string" && u.text.startsWith("http")) {
          urls.push(u.text);
        }
      }
    }

    const ranges: any[] = Array.isArray(block.entityRanges) ? block.entityRanges : [];

    // Atomic blocks hold code blocks (MARKDOWN), embedded tweets (TWEET), or media (MEDIA)
    if (blockType === "atomic") {
      for (const range of ranges) {
        const entity = entityLookup.get(String(range?.key));
        if (!entity) continue;
        if (entity.type === "MARKDOWN" && typeof entity?.data?.markdown === "string") {
          lines.push(entity.data.markdown.trim());
        } else if (entity.type === "TWEET" && entity?.data?.tweetId) {
          const tweetUrl = `https://x.com/i/status/${entity.data.tweetId}`;
          urls.push(tweetUrl);
          lines.push(`[Embedded post: ${tweetUrl}]`);
        }
      }
      continue;
    }

    let text = typeof block.text === "string" ? block.text : "";
    // Apply inline LINK entity ranges from right to left so offsets stay valid
    const linkRanges = ranges
      .map((r) => ({
        offset: Number(r?.offset ?? 0),
        length: Number(r?.length ?? 0),
        entity: entityLookup.get(String(r?.key)),
      }))
      .filter((r) => r.entity?.type === "LINK" && typeof r.entity?.data?.url === "string" && r.length > 0)
      .sort((a, b) => b.offset - a.offset);

    for (const r of linkRanges) {
      const url = r.entity.data.url as string;
      const before = text.slice(0, r.offset);
      const label = text.slice(r.offset, r.offset + r.length);
      const after = text.slice(r.offset + r.length);
      text = `${before}[${label}](${url})${after}`;
    }

    text = text.trim();
    if (!text) continue;

    switch (blockType) {
      case "header-one":
        lines.push(`# ${text}`);
        break;
      case "header-two":
        lines.push(`## ${text}`);
        break;
      case "header-three":
        lines.push(`### ${text}`);
        break;
      case "blockquote":
        lines.push(`> ${text}`);
        break;
      case "unordered-list-item":
        lines.push(`- ${text}`);
        break;
      case "ordered-list-item":
        orderedCounter++;
        lines.push(`${orderedCounter}. ${text}`);
        break;
      default:
        lines.push(text);
        break;
    }
  }

  const markdown = lines.join("\n\n").trim() || (typeof article.preview_text === "string" ? article.preview_text.trim() : null);
  return { title, markdown, urls };
}

function collectMedia(media: any): { summaryJson: string | null; altTexts: string[] } {
  if (!media || typeof media !== "object" || Array.isArray(media)) {
    return { summaryJson: null, altTexts: [] };
  }
  const items: { type: string; url: string; alt?: string | null }[] = [];
  const altTexts: string[] = [];

  if (Array.isArray(media.photos)) {
    for (const p of media.photos) {
      if (p?.url) {
        const alt = typeof p.altText === "string" && p.altText.trim() ? p.altText.trim() : null;
        items.push({ type: p.type || "photo", url: p.url, alt });
        if (alt) altTexts.push(alt);
      }
    }
  }
  if (Array.isArray(media.videos)) {
    for (const v of media.videos) {
      if (v?.url || v?.thumbnail_url) {
        items.push({ type: v.type || "video", url: v.url || v.thumbnail_url, alt: null });
      }
    }
  }
  if (media.external?.url) {
    items.push({ type: media.external.type || "external", url: media.external.url, alt: null });
  }

  return {
    summaryJson: items.length > 0 ? JSON.stringify(items) : null,
    altTexts,
  };
}

export function looksLikeThread(tweet: any): boolean {
  if (!tweet) return false;
  const author = tweet?.author?.screen_name?.toLowerCase();
  const replyTo = tweet?.replying_to?.screen_name?.toLowerCase();
  if (author && replyTo && author === replyTo) return true;
  const text = typeof tweet.text === "string" ? tweet.text : "";
  return /🧵|\b1\/\d*|\(1\/|\bthread\b|👇/i.test(text);
}

export function parseFxPayload(payload: any): HydratedFields {
  const tweet = payload?.status ?? payload?.tweet;
  if (!tweet || tweet.type === "tombstone") {
    return { raw_fx_json: JSON.stringify(payload), hydration_source: "fxtwitter" };
  }

  const links: ExtractedLink[] = [];
  const seenLinkKey = new Set<string>();
  const domainSet = new Set<string>();
  const urlSet = new Set<string>();
  const urlPathsForSearch: string[] = [];

  const pushLink = (raw: unknown, source: ExtractedLink["source"]) => {
    const norm = normalizeUrl(raw);
    if (!norm) return;
    const key = `${source}|${norm.url}`;
    if (seenLinkKey.has(key)) return;
    seenLinkKey.add(key);
    urlSet.add(norm.url);
    if (norm.domain !== "x.com" && norm.domain !== "twitter.com") {
      domainSet.add(norm.domain);
      links.push({ url: norm.url, domain: norm.domain, source });
      try {
        const u = new URL(norm.url);
        if (u.pathname && u.pathname !== "/") {
          urlPathsForSearch.push(`${norm.domain}${u.pathname}`);
        }
      } catch {
        // ignore
      }
    }
  };

  // Tweet URL facets
  if (Array.isArray(tweet?.raw_text?.facets)) {
    for (const f of tweet.raw_text.facets) {
      if (f?.type === "url") pushLink(f.replacement || f.original, "tweet");
    }
  }

  // Card links
  if (tweet?.card?.url) pushLink(tweet.card.url, "card");
  if (typeof tweet?.card?.domain === "string" && tweet.card.domain.trim()) {
    const dom = tweet.card.domain.replace(/^www\./, "").toLowerCase();
    if (dom !== "x.com" && dom !== "twitter.com") domainSet.add(dom);
  }

  // X Article rendering + URLs
  const article = renderArticleMarkdown(tweet.article);
  for (const u of article.urls) pushLink(u, "article");

  // Quoted post (including quote's own card / article / facets)
  const quote = tweet?.quote && tweet.quote.type !== "tombstone" ? tweet.quote : null;
  const quoteAuthor = quote?.author?.screen_name ?? null;
  const quoteArticle = renderArticleMarkdown(quote?.article);
  for (const u of quoteArticle.urls) pushLink(u, "quote");
  if (quote?.card?.url) pushLink(quote.card.url, "quote");
  if (Array.isArray(quote?.raw_text?.facets)) {
    for (const f of quote.raw_text.facets) {
      if (f?.type === "url") pushLink(f.replacement || f.original, "quote");
    }
  }

  const quoteParts: string[] = [];
  if (typeof quote?.text === "string" && quote.text.trim()) quoteParts.push(quote.text.trim());
  if (quoteArticle.title) quoteParts.push(`[Article] ${quoteArticle.title}`);
  if (quote?.card?.title) quoteParts.push(quote.card.title);
  const quoteText = quoteParts.length > 0 ? quoteParts.join("\n") : null;

  // Media + alt text
  const { summaryJson: mediaJson, altTexts } = collectMedia(tweet.media);
  const extraParts: string[] = [...altTexts];

  if (typeof tweet?.card?.image?.alt === "string" && tweet.card.image.alt.trim()) {
    extraParts.push(tweet.card.image.alt.trim());
  }

  // Polls
  let pollJson: string | null = null;
  if (tweet?.poll && Array.isArray(tweet.poll.choices)) {
    pollJson = JSON.stringify(tweet.poll);
    const labels = tweet.poll.choices
      .map((c: any) => (typeof c?.label === "string" ? c.label.trim() : ""))
      .filter(Boolean);
    if (labels.length > 0) extraParts.push(`Poll: ${labels.join(" | ")}`);
  }

  // Community notes
  const communityNote =
    typeof tweet?.community_note?.text === "string" && tweet.community_note.text.trim()
      ? tweet.community_note.text.trim()
      : null;
  if (communityNote) extraParts.push(`Community Note: ${communityNote}`);

  // Thread continuation posts (if fetched via /2/thread/{id})
  const threadPosts: ThreadPostInput[] = [];
  if (Array.isArray(payload?.thread) && payload.thread.length > 1) {
    for (let i = 0; i < payload.thread.length; i++) {
      const p = payload.thread[i];
      if (!p || p.type === "tombstone" || !p.id) continue;
      const t = typeof p.text === "string" ? p.text.trim() : "";
      if (!t) continue;
      threadPosts.push({
        post_id: String(p.id),
        position: i,
        author_handle: p?.author?.screen_name ?? null,
        created_at: typeof p.created_at === "string" ? p.created_at : null,
        text: t,
      });
      if (String(p.id) !== String(tweet.id)) {
        extraParts.push(t);
      }
    }
  }

  if (urlPathsForSearch.length > 0) {
    extraParts.push(urlPathsForSearch.join(" "));
  }

  const normalizedTweetText = typeof tweet.text === "string" && tweet.text.trim() ? tweet.text.trim() : null;

  return {
    url: typeof tweet.url === "string" ? tweet.url : null,
    author_handle: tweet?.author?.screen_name ?? null,
    author_name: tweet?.author?.name ?? null,
    created_at: typeof tweet.created_at === "string" ? tweet.created_at : null,
    created_timestamp: typeof tweet.created_timestamp === "number" ? tweet.created_timestamp : null,
    replying_to_handle: tweet?.replying_to?.screen_name ?? null,
    text: normalizedTweetText,
    article_title: article.title,
    article_text: article.markdown,
    quote_author: quoteAuthor,
    quote_text: quoteText,
    card_title: typeof tweet?.card?.title === "string" ? tweet.card.title : null,
    card_description: typeof tweet?.card?.description === "string" ? tweet.card.description : null,
    card_url: typeof tweet?.card?.url === "string" ? tweet.card.url : null,
    poll_json: pollJson,
    community_note: communityNote,
    extra_text: extraParts.length > 0 ? extraParts.join("\n") : null,
    urls_json: urlSet.size > 0 ? JSON.stringify([...urlSet]) : null,
    domains: domainSet.size > 0 ? [...domainSet].join(" ") : null,
    media_json: mediaJson,
    likes: typeof tweet.likes === "number" ? tweet.likes : null,
    reposts: typeof tweet.reposts === "number" ? tweet.reposts : null,
    replies: typeof tweet.replies === "number" ? tweet.replies : null,
    bookmarks_count: typeof tweet.bookmarks === "number" ? tweet.bookmarks : null,
    views: typeof tweet.views === "number" ? tweet.views : null,
    lang: typeof tweet.lang === "string" ? tweet.lang : null,
    raw_fx_json: JSON.stringify(payload),
    hydration_source: "fxtwitter",
    links,
    thread_posts: threadPosts.length > 0 ? threadPosts : undefined,
  };
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs > 0) return Math.ceil(secs);
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    const diff = Math.ceil((dateMs - Date.now()) / 1000);
    return diff > 0 ? diff : null;
  }
  return null;
}

async function fetchFxEndpoint(endpointUrl: string): Promise<{
  httpStatus: number;
  retryAfterSeconds: number | null;
  payload: any | null;
  networkError?: string;
}> {
  let attempt = 0;
  while (attempt < 3) {
    attempt++;
    try {
      const res = await throttledFetch(endpointUrl, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
      const retryAfterSeconds = parseRetryAfter(res.headers.get("retry-after"));

      if (res.status === 429 || res.status >= 500) {
        if (attempt < 3) {
          const waitMs = retryAfterSeconds ? Math.min(retryAfterSeconds * 1000, 120000) : 5000 * attempt * attempt;
          await Bun.sleep(waitMs);
          continue;
        }
        return { httpStatus: res.status, retryAfterSeconds, payload: null };
      }

      const payload = await res.json().catch(() => null);
      return { httpStatus: res.status, retryAfterSeconds, payload };
    } catch (err) {
      if (attempt < 3) {
        await Bun.sleep(1000 * attempt);
        continue;
      }
      return {
        httpStatus: 0,
        retryAfterSeconds: null,
        payload: null,
        networkError: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return { httpStatus: 0, retryAfterSeconds: null, payload: null, networkError: "Exhausted retries" };
}

async function fetchFromVxTwitter(id: string): Promise<FxFetchResult | null> {
  try {
    const res = await throttledFetch(`${VX_STATUS_BASE}/${encodeURIComponent(id)}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    if (!data || !data.tweetID) return null;

    const quoteAuthor = data?.qrt?.user_screen_name ?? null;
    const quoteText = typeof data?.qrt?.text === "string" ? data.qrt.text : null;

    return {
      status: "ok",
      fields: {
        url: data.tweetURL ?? null,
        author_handle: data.user_screen_name ?? null,
        author_name: data.user_name ?? null,
        created_at: data.date ?? null,
        created_timestamp: typeof data.date_epoch === "number" ? data.date_epoch : null,
        text: typeof data.text === "string" && data.text.trim() ? data.text.trim() : null,
        article_title: data?.article?.title ?? null,
        article_text: data?.article?.preview_text ?? null,
        quote_author: quoteAuthor,
        quote_text: quoteText,
        likes: typeof data.likes === "number" ? data.likes : null,
        reposts: typeof data.retweets === "number" ? data.retweets : null,
        replies: typeof data.replies === "number" ? data.replies : null,
        lang: data.lang ?? null,
        raw_fx_json: JSON.stringify({ fallback_provider: "vxtwitter", data }),
        hydration_source: "vxtwitter",
      },
    };
  } catch {
    return null;
  }
}

function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

async function fetchFromSyndication(id: string): Promise<FxFetchResult | null> {
  try {
    const token = syndicationToken(id);
    const res = await throttledFetch(`${SYNDICATION_BASE}?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    if (!data || !data.id_str) return null;

    const altTexts: string[] = [];
    if (Array.isArray(data.mediaDetails)) {
      for (const m of data.mediaDetails) {
        if (typeof m?.ext_alt_text === "string" && m.ext_alt_text.trim()) {
          altTexts.push(m.ext_alt_text.trim());
        }
      }
    }

    return {
      status: "ok",
      fields: {
        url: data?.user?.screen_name ? `https://x.com/${data.user.screen_name}/status/${data.id_str}` : null,
        author_handle: data?.user?.screen_name ?? null,
        author_name: data?.user?.name ?? null,
        created_at: data.created_at ?? null,
        created_timestamp: data.created_at ? Math.floor(Date.parse(data.created_at) / 1000) || null : null,
        text: typeof data.text === "string" && data.text.trim() ? data.text.trim() : null,
        quote_author: data?.quoted_tweet?.user?.screen_name ?? null,
        quote_text: data?.quoted_tweet?.text ?? null,
        extra_text: altTexts.length > 0 ? altTexts.join("\n") : null,
        likes: typeof data.favorite_count === "number" ? data.favorite_count : null,
        lang: data.lang ?? null,
        raw_fx_json: JSON.stringify({ fallback_provider: "syndication", data }),
        hydration_source: "syndication",
      },
    };
  } catch {
    return null;
  }
}

export async function fetchFromFxTwitter(
  id: string,
  opts: { fetchThreadIfHint?: boolean; forceThread?: boolean; allowFallbacks?: boolean } = {}
): Promise<FxFetchResult> {
  const allowFallbacks = opts.allowFallbacks ?? true;
  const endpoint = opts.forceThread
    ? `${FX_THREAD_BASE}/${encodeURIComponent(id)}`
    : `${FX_STATUS_BASE}/${encodeURIComponent(id)}`;

  const res = await fetchFxEndpoint(endpoint);

  if (res.networkError || res.httpStatus === 429 || res.httpStatus >= 500 || !res.payload) {
    if (allowFallbacks) {
      const vx = await fetchFromVxTwitter(id);
      if (vx) return vx;
      const syn = await fetchFromSyndication(id);
      if (syn) return syn;
    }
    return {
      status: "error",
      fields: {},
      error: res.networkError || `HTTP ${res.httpStatus}`,
      rateLimited: res.httpStatus === 429 || res.httpStatus >= 500,
      retryAfterSeconds: res.retryAfterSeconds,
    };
  }

  let payload = res.payload;
  const code = payload?.code ?? res.httpStatus;

  if (code === 404 || code === 401 || code === 400 || !payload?.status || payload?.status?.type === "tombstone") {
    const reason = payload?.status?.reason ? `: ${payload.status.reason}` : "";
    return {
      status: "unavailable",
      fields: { raw_fx_json: JSON.stringify(payload) },
      error: `Unavailable (code ${code}${reason})`,
    };
  }

  if (code !== 200) {
    return {
      status: "error",
      fields: { raw_fx_json: JSON.stringify(payload) },
      error: `FxTwitter code ${code}`,
    };
  }

  // Upgrade to /2/thread/{id} only when it looks like a self-reply or thread
  if (!opts.forceThread && opts.fetchThreadIfHint && looksLikeThread(payload.status)) {
    const threadRes = await fetchFxEndpoint(`${FX_THREAD_BASE}/${encodeURIComponent(id)}`);
    if (threadRes.payload && (threadRes.payload.code ?? threadRes.httpStatus) === 200 && threadRes.payload.status) {
      payload = threadRes.payload;
    }
  }

  return {
    status: "ok",
    fields: parseFxPayload(payload),
  };
}
