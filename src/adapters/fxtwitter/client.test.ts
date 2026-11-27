import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { bid, makeJsonResponse } from "../../../test/fakes.ts";
import { Hydrator } from "../../ports/hydrator.ts";
import { FxTwitterHydratorLive, makeFxTwitterHydrator, parseRetryAfter, syndicationToken } from "./client.ts";

describe("adapters/fxtwitter/client", () => {
  it("parses numeric and HTTP-date Retry-After headers", () => {
    const now = Date.parse("2026-01-15T12:00:00.000Z");
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter("0", now)).toBeNull();
    expect(parseRetryAfter("-5", now)).toBeNull();
    expect(parseRetryAfter("12.2", now)).toBe(13);
    expect(parseRetryAfter("Thu, 15 Jan 2026 12:01:00 GMT", now)).toBe(60);
    expect(parseRetryAfter("Thu, 15 Jan 2026 12:00:00 GMT", now)).toBeNull();
    expect(parseRetryAfter("Thu, 15 Jan 2026 11:59:00 GMT", now)).toBeNull();
    expect(parseRetryAfter("garbage-date", now)).toBeNull();
  });

  it("computes exact deterministic syndication tokens", () => {
    const expected = ((1_900_000_000_000_000_000 / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
    expect(syndicationToken("1900000000000000000")).toBe(expected);
  });

  it("hydrates FxTwitter status, sends headers, throttles, and upgrades to thread only when requested", async () => {
    const urls: string[] = [];
    const seenHeaders: Array<Record<string, string>> = [];
    const sleeps: number[] = [];
    const hydrator = makeFxTwitterHydrator({
      minRequestMs: 500,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      fetchFn: async (input, init) => {
        const u = String(input);
        urls.push(u);
        seenHeaders.push((init?.headers as Record<string, string>) ?? {});
        if (u.includes("/2/status/")) {
          return makeJsonResponse({
            code: 200,
            status: { id: "100", text: "A great thread 🧵", author: { screen_name: "alice" } },
          });
        }
        return makeJsonResponse({
          code: 200,
          status: { id: "100", text: "A great thread 🧵", author: { screen_name: "alice" } },
          thread: [
            { id: "100", text: "A great thread 🧵", author: { screen_name: "alice" } },
            { id: "101", text: "Second post", author: { screen_name: "alice" } },
          ],
        });
      },
    });

    const res = await Effect.runPromise(hydrator.hydrate(bid("100"), { fetchThreadIfHint: true }));
    expect(res.status).toBe("ok");
    expect(res.rateLimited).toBe(false);
    expect(res.fields.threadPosts.length).toBe(2);
    expect(urls).toEqual(["https://api.fxtwitter.com/2/status/100", "https://api.fxtwitter.com/2/thread/100"]);
    expect(seenHeaders[0]?.["User-Agent"]).toContain("x-bookmarks-local-indexer");
    expect(seenHeaders[0]?.Accept).toBe("application/json");
    // Second request inside 500ms window must sleep > 0 and <= 500
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[0]).toBeLessThanOrEqual(500);

    // With fetchThreadIfHint: false, thread endpoint is NOT called
    urls.length = 0;
    await Effect.runPromise(hydrator.hydrate(bid("100"), { fetchThreadIfHint: false }));
    expect(urls).toEqual(["https://api.fxtwitter.com/2/status/100"]);

    // Thread fetch returning null/unparseable keeps original status fields
    const keepOrig = makeFxTwitterHydrator({
      minRequestMs: 0,
      sleepFn: async () => {},
      fetchFn: async (input) => {
        if (String(input).includes("/2/thread/")) return new Response("bad", { status: 200 });
        return makeJsonResponse({ code: 200, status: { id: "100", text: "Thread 🧵" } });
      },
    });
    const kept = await Effect.runPromise(keepOrig.hydrate(bid("100"), { fetchThreadIfHint: true }));
    expect(kept.status).toBe("ok");
    expect(kept.fields.text).toBe("Thread 🧵");
  });

  it("classifies tombstones, 400/401/404, non-200 codes, and unparseable statuses accurately", async () => {
    const run = (body: unknown, status = 200) =>
      Effect.runPromise(
        makeFxTwitterHydrator({
          minRequestMs: 0,
          sleepFn: async () => {},
          fetchFn: async () => makeJsonResponse(body, status),
        }).hydrate(bid("200"), { fetchThreadIfHint: false }),
      );

    const notFound = await run({ code: 404, status: null }, 404);
    expect(notFound.status).toBe("unavailable");
    expect(notFound.rateLimited).toBe(false);
    expect(notFound.error).toBe("Unavailable (code 404)");

    // HTTP 404 without body.code falls back to httpStatus
    const raw404 = await run({ nope: true }, 404);
    expect(raw404.status).toBe("unavailable");
    expect(raw404.error).toBe("Unavailable (code 404)");

    // status: null even with code 200 -> unavailable
    const nullStatus = await run({ code: 200, status: null }, 200);
    expect(nullStatus.status).toBe("unavailable");
    expect(nullStatus.error).toBe("Unavailable (code 200)");

    const tombstone = await run({ code: 200, status: { type: "tombstone", reason: "deleted" } }, 200);
    expect(tombstone.status).toBe("unavailable");
    expect(tombstone.error).toBe("Unavailable (code 200: deleted)");

    const tombstoneNoReason = await run({ code: 200, status: { type: "tombstone" } }, 200);
    expect(tombstoneNoReason.status).toBe("unavailable");
    expect(tombstoneNoReason.error).toBe("Unavailable (code 200)");

    const oddCode = await run({ code: 418, status: { text: "teapot" } }, 418);
    expect(oddCode.status).toBe("error");
    expect(oddCode.rateLimited).toBe(false);
    expect(oddCode.error).toBe("FxTwitter code 418");

    const badPayload = await run({ code: 200, status: { author: 123 } }, 200);
    expect(badPayload.status).toBe("unavailable");
    expect(badPayload.error).toBe("Unparseable FxTwitter status");

    // Non-object payload (env = null) falls back to httpStatus
    const scalar404 = await run(123, 404);
    expect(scalar404.status).toBe("unavailable");
    expect(scalar404.error).toBe("Unavailable (code 404)");
  });

  it("retries 429/500/network with exact backoff and falls back to VxTwitter and Syndication", async () => {
    const sleeps: number[] = [];
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const vxFallback = makeFxTwitterHydrator({
      minRequestMs: 0,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      fetchFn: async (input, init) => {
        const u = String(input);
        seen.push({ url: u, headers: (init?.headers as Record<string, string>) ?? {} });
        if (u.includes("fxtwitter")) return makeJsonResponse({}, 429, { "retry-after": "3" });
        if (u.includes("vxtwitter")) return makeJsonResponse({ tweetID: "300", text: "From VxTwitter" });
        return makeJsonResponse({}, 404);
      },
    });
    const vxRes = await Effect.runPromise(vxFallback.hydrate(bid("300"), { fetchThreadIfHint: false }));
    expect(vxRes.status).toBe("ok");
    expect(vxRes.rateLimited).toBe(false);
    expect(vxRes.fields.hydrationSource).toBe("vxtwitter");
    expect(sleeps).toEqual([3000, 3000]);
    expect(seen.filter((s) => s.url.includes("fxtwitter")).length).toBe(3);
    expect(seen.find((s) => s.url.includes("vxtwitter"))?.headers.Accept).toBe("application/json");

    // 500 without Retry-After uses quadratic backoff (5000, 20000) and reports rateLimited:true on failure
    const sleeps500: number[] = [];
    const http500 = makeFxTwitterHydrator({
      minRequestMs: 0,
      sleepFn: async (ms) => {
        sleeps500.push(ms);
      },
      fetchFn: async (input) => {
        if (String(input).includes("fxtwitter")) return makeJsonResponse({}, 500);
        return makeJsonResponse({}, 404);
      },
    });
    const r500 = await Effect.runPromise(http500.hydrate(bid("305"), { fetchThreadIfHint: false }));
    expect(r500.status).toBe("error");
    expect(r500.rateLimited).toBe(true);
    expect(r500.error).toBe("HTTP 500");
    expect(sleeps500).toEqual([5000, 20_000]);

    // Network string throw retries with linear backoff (1000, 2000), reports rateLimited:false if all fail
    const sleepsNet: number[] = [];
    const netString = makeFxTwitterHydrator({
      minRequestMs: 0,
      sleepFn: async (ms) => {
        sleepsNet.push(ms);
      },
      fetchFn: async () => {
        throw "raw-network-err";
      },
    });
    const rNet = await Effect.runPromise(netString.hydrate(bid("306"), { fetchThreadIfHint: false }));
    expect(rNet.status).toBe("error");
    expect(rNet.rateLimited).toBe(false);
    expect(rNet.error).toBe("raw-network-err");
    expect(sleepsNet).toEqual([1000, 2000]);

    // 502 (strictly > 500) and 429 all-fail both retry and report rateLimited:true; Error throw captures .message
    const http502 = makeFxTwitterHydrator({
      minRequestMs: 0,
      sleepFn: async () => {},
      fetchFn: async (input) => {
        if (String(input).includes("fxtwitter")) return makeJsonResponse({}, 502);
        return makeJsonResponse({ tweetID: "307", text: "ignored non-ok" }, 500);
      },
    });
    const r502 = await Effect.runPromise(http502.hydrate(bid("307"), { fetchThreadIfHint: false }));
    expect(r502.status).toBe("error");
    expect(r502.rateLimited).toBe(true);
    expect(r502.error).toBe("HTTP 502");

    const http429Fail = makeFxTwitterHydrator({
      minRequestMs: 0,
      sleepFn: async () => {},
      fetchFn: async (input) => {
        if (String(input).includes("fxtwitter")) return makeJsonResponse({}, 429);
        return makeJsonResponse({}, 404);
      },
    });
    const r429 = await Effect.runPromise(http429Fail.hydrate(bid("308"), { fetchThreadIfHint: false }));
    expect(r429.status).toBe("error");
    expect(r429.rateLimited).toBe(true);

    const errObj = makeFxTwitterHydrator({
      minRequestMs: 0,
      sleepFn: async () => {},
      fetchFn: async () => {
        throw new Error("socket hangup");
      },
    });
    const rErrObj = await Effect.runPromise(errObj.hydrate(bid("309"), { fetchThreadIfHint: false }));
    expect(rErrObj.error).toBe("socket hangup");

    // Syndication fallback when FxTwitter returns unparseable non-JSON 200 and VxTwitter returns invalid schema
    const synUrls: string[] = [];
    const synFallback = makeFxTwitterHydrator({
      minRequestMs: 0,
      sleepFn: async () => {},
      fetchFn: async (input) => {
        const u = String(input);
        synUrls.push(u);
        if (u.includes("fxtwitter")) return new Response("not-json", { status: 200 });
        if (u.includes("vxtwitter")) return makeJsonResponse({ bad: true }, 200);
        return makeJsonResponse({ id_str: "301", text: "From Syndication" });
      },
    });
    const synRes = await Effect.runPromise(synFallback.hydrate(bid("301"), { fetchThreadIfHint: false }));
    expect(synRes.status).toBe("ok");
    expect(synRes.fields.hydrationSource).toBe("syndication");
    expect(synUrls.some((u) => u.startsWith("https://cdn.syndication.twimg.com/tweet-result?id=301&token="))).toBe(
      true,
    );
  });

  it("constructs FxTwitterHydratorLive layer", async () => {
    const h = await Effect.runPromise(Effect.provide(Hydrator, FxTwitterHydratorLive(1500)));
    expect(typeof h.hydrate).toBe("function");
  });
});
