import { Effect, Layer, Option, Schema } from "effect";
import { looksLikeThread, parseFxPayload, parseSyndicationPayload, parseVxPayload } from "../../domain/article.ts";
import { emptyHydratedFields, type BookmarkId, type HydratedFields } from "../../domain/bookmark.ts";
import { Hydrator, type HydrateResult, type HydratorShape } from "../../ports/hydrator.ts";

const USER_AGENT = "x-bookmarks-local-indexer/1.0 (+local-personal-archive)";
const FX_STATUS_BASE = "https://api.fxtwitter.com/2/status";
const FX_THREAD_BASE = "https://api.fxtwitter.com/2/thread";
const VX_STATUS_BASE = "https://api.vxtwitter.com/Twitter/status";
const SYNDICATION_BASE = "https://cdn.syndication.twimg.com/tweet-result";

const EnvelopeCodeSchema = Schema.Struct({
  code: Schema.optional(Schema.Number),
  status: Schema.optional(
    Schema.NullOr(Schema.Struct({ type: Schema.optional(Schema.String), reason: Schema.optional(Schema.String) })),
  ),
});

export const parseRetryAfter = (header: string | null, nowMs: number): number | null => {
  if (header === null) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs > 0) return Math.ceil(secs);
  const dateMs = Date.parse(header);
  if (Number.isNaN(dateMs)) return null;
  const diff = Math.ceil((dateMs - nowMs) / 1000);
  return diff > 0 ? diff : null;
};

export const syndicationToken = (id: string): string =>
  ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");

interface EndpointOutcome {
  readonly httpStatus: number;
  readonly retryAfterSeconds: number | null;
  readonly payload: unknown;
  readonly networkError: string | null;
}

const makeLimiter = (minIntervalMs: number, sleepFn: (ms: number) => Promise<void>) => {
  let nextAt = 0;
  return async <A>(fn: () => Promise<A>): Promise<A> => {
    const now = Date.now();
    const startAt = Math.max(now, nextAt);
    nextAt = startAt + minIntervalMs;
    if (startAt > now) await sleepFn(startAt - now);
    return fn();
  };
};

const retryWaitMs = (attempt: number, retryAfterSeconds: number | null): number =>
  retryAfterSeconds !== null ? Math.min(retryAfterSeconds * 1000, 120_000) : 5000 * attempt * attempt;

const fetchOnce = async (
  url: string,
  doFetch: typeof fetch,
  throttle: <A>(fn: () => Promise<A>) => Promise<A>,
): Promise<EndpointOutcome> => {
  try {
    const res = await throttle(() =>
      doFetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } }),
    );
    const retryAfterSeconds = parseRetryAfter(res.headers.get("retry-after"), Date.now());
    const payload: unknown = res.status === 429 || res.status >= 500 ? null : await res.json().catch(() => null);
    return { httpStatus: res.status, retryAfterSeconds, payload, networkError: null };
  } catch (err) {
    return {
      httpStatus: 0,
      retryAfterSeconds: null,
      payload: null,
      networkError: err instanceof Error ? err.message : String(err),
    };
  }
};

const isRetryable = (out: EndpointOutcome): boolean =>
  out.networkError !== null || out.httpStatus === 429 || out.httpStatus >= 500;

const fetchJsonEndpoint = async (
  url: string,
  doFetch: typeof fetch,
  throttle: <A>(fn: () => Promise<A>) => Promise<A>,
  sleepFn: (ms: number) => Promise<void>,
): Promise<EndpointOutcome> => {
  let last = await fetchOnce(url, doFetch, throttle);
  for (let attempt = 1; attempt < 3 && isRetryable(last); attempt++) {
    const waitMs = last.networkError !== null ? 1000 * attempt : retryWaitMs(attempt, last.retryAfterSeconds);
    await sleepFn(waitMs);
    last = await fetchOnce(url, doFetch, throttle);
  }
  return last;
};

const fetchFallbackProvider = async (
  url: string,
  parser: (raw: unknown) => HydratedFields | null,
  doFetch: typeof fetch,
  throttle: <A>(fn: () => Promise<A>) => Promise<A>,
): Promise<HydrateResult | null> => {
  try {
    const res = await throttle(() =>
      doFetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } }),
    );
    if (!res.ok) return null;
    const fields = parser(await res.json().catch(() => null));
    return fields === null ? null : { status: "ok", fields, error: null, rateLimited: false, retryAfterSeconds: null };
  } catch {
    return null;
  }
};

const tryFallbacks = async (
  id: BookmarkId,
  doFetch: typeof fetch,
  throttle: <A>(fn: () => Promise<A>) => Promise<A>,
): Promise<HydrateResult | null> => {
  const vx = await fetchFallbackProvider(
    `${VX_STATUS_BASE}/${encodeURIComponent(id)}`,
    parseVxPayload,
    doFetch,
    throttle,
  );
  if (vx !== null) return vx;
  const synUrl = `${SYNDICATION_BASE}?id=${encodeURIComponent(id)}&token=${encodeURIComponent(syndicationToken(id))}`;
  return fetchFallbackProvider(synUrl, parseSyndicationPayload, doFetch, throttle);
};

const UNAVAILABLE_CODES = new Set([400, 401, 404]);

const isUnavailableEnvelope = (code: number, env: typeof EnvelopeCodeSchema.Type | null): boolean =>
  UNAVAILABLE_CODES.has(code) || env?.status === null || env?.status?.type === "tombstone";

const unavailableResult = (payload: unknown, error: string): HydrateResult => ({
  status: "unavailable",
  fields: emptyHydratedFields(JSON.stringify(payload)),
  error,
  rateLimited: false,
  retryAfterSeconds: null,
});

const classifyFxPayload = (
  payload: unknown,
  httpStatus: number,
): HydrateResult | { readonly fields: HydratedFields } => {
  const env = Option.getOrNull(Schema.decodeUnknownOption(EnvelopeCodeSchema)(payload));
  const code = env?.code ?? httpStatus;
  if (isUnavailableEnvelope(code, env)) {
    const reason = env?.status?.reason ? `: ${env.status.reason}` : "";
    return unavailableResult(payload, `Unavailable (code ${code}${reason})`);
  }
  if (code !== 200) {
    return {
      status: "error",
      fields: emptyHydratedFields(JSON.stringify(payload)),
      error: `FxTwitter code ${code}`,
      rateLimited: false,
      retryAfterSeconds: null,
    };
  }
  const fields = parseFxPayload(payload);
  return fields === null ? unavailableResult(payload, "Unparseable FxTwitter status") : { fields };
};

const handlePrimaryFailure = async (
  id: BookmarkId,
  res: EndpointOutcome,
  doFetch: typeof fetch,
  throttle: <A>(fn: () => Promise<A>) => Promise<A>,
): Promise<HydrateResult> => {
  const fallback = await tryFallbacks(id, doFetch, throttle);
  if (fallback !== null) return fallback;
  return {
    status: "error",
    fields: emptyHydratedFields(null),
    error: res.networkError ?? `HTTP ${res.httpStatus}`,
    rateLimited: res.httpStatus === 429 || res.httpStatus >= 500,
    retryAfterSeconds: res.retryAfterSeconds,
  };
};

export const makeFxTwitterHydrator = (opts: {
  readonly minRequestMs: number;
  readonly fetchFn?: typeof fetch;
  readonly sleepFn?: (ms: number) => Promise<void>;
}): HydratorShape => {
  const doFetch = opts.fetchFn ?? fetch;
  const sleepFn = opts.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const throttle = makeLimiter(opts.minRequestMs, sleepFn);

  const hydrateAsync = async (id: BookmarkId, fetchThreadIfHint: boolean): Promise<HydrateResult> => {
    const res = await fetchJsonEndpoint(`${FX_STATUS_BASE}/${encodeURIComponent(id)}`, doFetch, throttle, sleepFn);
    if (isRetryable(res) || res.payload === null) return handlePrimaryFailure(id, res, doFetch, throttle);

    const classified = classifyFxPayload(res.payload, res.httpStatus);
    if ("status" in classified) return classified;

    let { fields } = classified;
    if (fetchThreadIfHint && looksLikeThread(fields.authorHandle, fields.replyingToHandle, fields.text)) {
      const threadRes = await fetchJsonEndpoint(
        `${FX_THREAD_BASE}/${encodeURIComponent(id)}`,
        doFetch,
        throttle,
        sleepFn,
      );
      const threadFields = threadRes.payload === null ? null : parseFxPayload(threadRes.payload);
      if (threadFields !== null) fields = threadFields;
    }
    return { status: "ok", fields, error: null, rateLimited: false, retryAfterSeconds: null };
  };

  return {
    hydrate: (id, { fetchThreadIfHint }) => Effect.promise(() => hydrateAsync(id, fetchThreadIfHint)),
  };
};

export const FxTwitterHydratorLive = (minRequestMs: number): Layer.Layer<Hydrator> =>
  Layer.succeed(Hydrator, makeFxTwitterHydrator({ minRequestMs }));
