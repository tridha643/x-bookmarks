import type { HydratedFields } from "./db.ts";

const USER_AGENT = "x-bookmarks-local-indexer/0.1 (+local-personal-archive)";
const FX_API_BASE = "https://api.fxtwitter.com/2/status";

export interface FxFetchResult {
  status: "ok" | "unavailable" | "error";
  fields: HydratedFields;
  error?: string;
}

function extractArticleText(article: any): string | null {
  if (!article) return null;
  const parts: string[] = [];
  if (typeof article.preview_text === "string" && article.preview_text.trim()) {
    parts.push(article.preview_text.trim());
  }
  const blocks = article?.content?.blocks;
  if (Array.isArray(blocks) && blocks.length > 0) {
    const body = blocks
      .map((b: any) => (typeof b?.text === "string" ? b.text.trim() : ""))
      .filter(Boolean)
      .join("\n\n");
    if (body) return body;
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function extractUrlsAndDomains(tweet: any): { urls: string[]; domains: string[] } {
  const urlSet = new Set<string>();
  const domainSet = new Set<string>();

  const addUrl = (raw: unknown) => {
    if (typeof raw !== "string" || !raw.startsWith("http")) return;
    try {
      const parsed = new URL(raw);
      const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
      if (host === "t.co") return;
      urlSet.add(raw);
      if (host && host !== "x.com" && host !== "twitter.com") {
        domainSet.add(host);
      }
    } catch {
      // ignore malformed URLs
    }
  };

  const facets = tweet?.raw_text?.facets;
  if (Array.isArray(facets)) {
    for (const f of facets) {
      if (f?.type === "url") {
        addUrl(f.replacement || f.original);
      }
    }
  }
  if (tweet?.card?.url) addUrl(tweet.card.url);
  if (tweet?.card?.domain && typeof tweet.card.domain === "string") {
    domainSet.add(tweet.card.domain.replace(/^www\./, "").toLowerCase());
  }
  if (tweet?.quote?.card?.url) addUrl(tweet.quote.card.url);

  return {
    urls: [...urlSet],
    domains: [...domainSet],
  };
}

function extractMediaSummary(media: any): string | null {
  if (!media || typeof media !== "object") return null;
  const items: { type: string; url: string; alt?: string | null }[] = [];

  if (Array.isArray(media.photos)) {
    for (const p of media.photos) {
      if (p?.url) items.push({ type: p.type || "photo", url: p.url, alt: p.altText ?? null });
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

  return items.length > 0 ? JSON.stringify(items) : null;
}

export function parseFxPayload(payload: any): HydratedFields {
  const tweet = payload?.status ?? payload?.tweet;
  if (!tweet || tweet.type === "tombstone") {
    return { raw_fx_json: JSON.stringify(payload) };
  }

  const { urls, domains } = extractUrlsAndDomains(tweet);
  const articleTitle = typeof tweet?.article?.title === "string" ? tweet.article.title : null;
  const articleText = extractArticleText(tweet?.article);

  const quote = tweet?.quote;
  const quoteAuthor = quote?.author?.screen_name ?? null;
  const quoteText = typeof quote?.text === "string" ? quote.text : null;

  return {
    url: typeof tweet.url === "string" ? tweet.url : null,
    author_handle: tweet?.author?.screen_name ?? null,
    author_name: tweet?.author?.name ?? null,
    created_at: typeof tweet.created_at === "string" ? tweet.created_at : null,
    created_timestamp: typeof tweet.created_timestamp === "number" ? tweet.created_timestamp : null,
    text: typeof tweet.text === "string" ? tweet.text : null,
    article_title: articleTitle,
    article_text: articleText,
    quote_author: quoteAuthor,
    quote_text: quoteText,
    card_title: typeof tweet?.card?.title === "string" ? tweet.card.title : null,
    card_description: typeof tweet?.card?.description === "string" ? tweet.card.description : null,
    card_url: typeof tweet?.card?.url === "string" ? tweet.card.url : null,
    urls_json: urls.length > 0 ? JSON.stringify(urls) : null,
    domains: domains.length > 0 ? domains.join(" ") : null,
    media_json: extractMediaSummary(tweet.media),
    likes: typeof tweet.likes === "number" ? tweet.likes : null,
    reposts: typeof tweet.reposts === "number" ? tweet.reposts : null,
    replies: typeof tweet.replies === "number" ? tweet.replies : null,
    bookmarks_count: typeof tweet.bookmarks === "number" ? tweet.bookmarks : null,
    views: typeof tweet.views === "number" ? tweet.views : null,
    lang: typeof tweet.lang === "string" ? tweet.lang : null,
    raw_fx_json: JSON.stringify(payload),
  };
}

export async function fetchFromFxTwitter(id: string): Promise<FxFetchResult> {
  const url = `${FX_API_BASE}/${encodeURIComponent(id)}`;
  let attempt = 0;

  while (attempt < 3) {
    attempt++;
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
      });

      if (res.status === 429 || res.status >= 500) {
        const waitMs = 1500 * attempt * attempt;
        if (attempt < 3) {
          await Bun.sleep(waitMs);
          continue;
        }
        return {
          status: "error",
          fields: {},
          error: `HTTP ${res.status}`,
        };
      }

      const payload = (await res.json()) as any;
      const code = payload?.code ?? res.status;

      if (code === 404 || code === 401 || !payload?.status || payload?.status?.type === "tombstone") {
        return {
          status: "unavailable",
          fields: { raw_fx_json: JSON.stringify(payload) },
          error: `Unavailable (code ${code})`,
        };
      }

      if (code !== 200) {
        return {
          status: "error",
          fields: { raw_fx_json: JSON.stringify(payload) },
          error: `FxTwitter code ${code}`,
        };
      }

      return {
        status: "ok",
        fields: parseFxPayload(payload),
      };
    } catch (err) {
      if (attempt < 3) {
        await Bun.sleep(1000 * attempt);
        continue;
      }
      return {
        status: "error",
        fields: {},
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { status: "error", fields: {}, error: "Exhausted retries" };
}
