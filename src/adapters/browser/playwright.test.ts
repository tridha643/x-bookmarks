import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { CaptureSource } from "../../ports/capture.ts";
import {
  clickRetryInPage,
  drainCollectorInPage,
  installCollectorInPage,
  scrollNextInPage,
  type CollectorDrainResult,
  type DomExtractedItem,
  type ScrollInfo,
} from "./dom-collector.ts";
import {
  PlaywrightCaptureLive,
  absorbDrainItems,
  acquireLock,
  checkBottomTermination,
  classifyPathname,
  collectTrackerOutput,
  createLoopTracker,
  loginToX,
  makePlaywrightCapture,
  runScrollLoop,
  waitForBoot,
  type CaptureContext,
  type CapturePage,
} from "./playwright.ts";

const makeDrain = (
  items: ReadonlyArray<DomExtractedItem>,
  overrides: Partial<CollectorDrainResult> = {},
): CollectorDrainResult => ({
  pathname: "/i/bookmarks",
  folderId: "f1",
  folderName: "Saved",
  hasSpinner: false,
  hasRetry: false,
  hasEmptyState: false,
  items,
  missingCollector: false,
  ...overrides,
});

const domItem = (id: string): DomExtractedItem => ({
  id,
  url: `https://x.com/alice/status/${id}`,
  authorHandle: "alice",
  authorName: "Alice",
  createdAt: "2026-01-15T10:00:00.000Z",
  domText: `Post ${id}`,
});

const makeFakePage = (opts: {
  url?: string;
  closed?: boolean;
  drains?: CollectorDrainResult[];
  scrolls?: ScrollInfo[];
  bootReady?: boolean;
  loginHasContent?: boolean;
}) => {
  let drainIdx = 0;
  let scrollIdx = 0;
  const evalCalls: string[] = [];
  const gotoUrls: string[] = [];

  const page: CapturePage = {
    url: () => opts.url ?? "https://x.com/i/bookmarks",
    isClosed: () => opts.closed ?? false,
    goto: async (u) => {
      gotoUrls.push(u);
      return null;
    },
    evaluate: async (fn: (...args: unknown[]) => unknown) => {
      if (fn === installCollectorInPage) {
        evalCalls.push("install");
        return true;
      }
      if (fn === drainCollectorInPage) {
        evalCalls.push("drain");
        const arr = opts.drains ?? [makeDrain([], { hasEmptyState: true })];
        const next = arr[Math.min(drainIdx, arr.length - 1)];
        drainIdx++;
        return next;
      }
      if (fn === scrollNextInPage) {
        evalCalls.push("scroll");
        const arr = opts.scrolls ?? [{ before: 0, after: 0, scrollHeight: 1000 }];
        const next = arr[Math.min(scrollIdx, arr.length - 1)];
        scrollIdx++;
        return next;
      }
      if (fn === clickRetryInPage) {
        evalCalls.push("retry");
        return true;
      }
      evalCalls.push("probe");
      return opts.bootReady ?? opts.loginHasContent ?? true;
    },
  };
  return { page, evalCalls, gotoUrls };
};

const makeFakeContext = (page: CapturePage, reuseExisting = true) => {
  let closed = 0;
  let newPageCalls = 0;
  const ctx: CaptureContext = {
    pages: () => (reuseExisting ? [page] : []),
    newPage: async () => {
      newPageCalls++;
      return page;
    },
    close: async () => {
      closed++;
    },
  };
  return { ctx, getClosed: () => closed, getNewPageCalls: () => newPageCalls };
};

describe("adapters/browser/playwright", () => {
  it("classifies bookmarks, history, login, and unexpected pathnames", () => {
    expect(classifyPathname("/i/bookmarks")).toBeNull();
    expect(classifyPathname("/i/bookmarks/12345")).toBeNull();
    expect(classifyPathname("/i/history")).toBeNull();
    expect(classifyPathname("/login")).toBe("logged-out");
    expect(classifyPathname("/i/flow/login")).toBe("logged-out");
    expect(classifyPathname("/i/jf/onboarding")).toBe("logged-out");
    expect(classifyPathname("/home")).toBe("wrong-page");
    expect(classifyPathname("/foo/i/bookmarks")).toBe("wrong-page");
  });

  it("absorbs items, deduplicates, stops at maxItems or 15 consecutive known items in incremental mode", () => {
    const tracker = createLoopTracker();
    const knownIds = new Set<string>(Array.from({ length: 16 }, (_, i) => String(100 + i)));

    const maxRes = absorbDrainItems(tracker, makeDrain([domItem("bad"), domItem("1"), domItem("1"), domItem("2")]), {
      knownIds,
      full: false,
      maxItems: 2,
    });
    expect(maxRes).toEqual({ added: 2, stop: "reached-max" });
    const collected = collectTrackerOutput(tracker, "reached-max");
    expect(collected.captured.map((c) => c.id)).toEqual(["1", "2"]);
    expect(collected.captured[0]?.captureSource).toBe("playwright-dom");

    // Unknown item resets consecutiveKnown counter so 14 known + 1 unknown + 1 known does NOT stop
    const tReset = createLoopTracker();
    const mixed = [...Array.from({ length: 14 }, (_, i) => domItem(String(100 + i))), domItem("999"), domItem("114")];
    expect(absorbDrainItems(tReset, makeDrain(mixed), { knownIds, full: false, maxItems: undefined })).toEqual({
      added: 16,
      stop: null,
    });

    const tInc = createLoopTracker();
    const knownItems = Array.from({ length: 16 }, (_, i) => domItem(String(100 + i)));
    expect(absorbDrainItems(tInc, makeDrain(knownItems), { knownIds, full: false, maxItems: undefined })).toEqual({
      added: 15,
      stop: "reached-known-bookmarks",
    });

    const tFull = createLoopTracker();
    expect(absorbDrainItems(tFull, makeDrain(knownItems), { knownIds, full: true, maxItems: undefined })).toEqual({
      added: 16,
      stop: null,
    });
  });

  it("terminates scroll loop on bottom stability, stalled spinner, or 40 idle steps", () => {
    const t1 = createLoopTracker();
    expect(checkBottomTermination(t1, 1, true, false)).toBeNull();
    expect(checkBottomTermination(t1, 0, false, false)).toBeNull();
    for (let i = 0; i < 9; i++) expect(checkBottomTermination(t1, 0, true, false)).toBeNull();
    expect(checkBottomTermination(t1, 0, true, false)).toBe("end-of-feed");

    const t2 = createLoopTracker();
    for (let i = 0; i < 20; i++) expect(checkBottomTermination(t2, 0, true, true)).toBeNull();
    expect(checkBottomTermination(t2, 0, true, true)).toBe("stalled");

    const t3 = createLoopTracker();
    for (let i = 0; i < 39; i++) expect(checkBottomTermination(t3, 0, false, false)).toBeNull();
    expect(checkBottomTermination(t3, 0, false, false)).toBe("end-of-feed");
  });

  it("runs waitForBoot and runScrollLoop across reinstall, retry banner, rate-limit, and empty-state paths", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };

    // waitForBoot: ready, logged-out, timeout
    const readyPage = makeFakePage({ url: "https://x.com/i/bookmarks", bootReady: true });
    expect(await waitForBoot(readyPage.page, { sleep })).toBe("ready");

    const loginPage = makeFakePage({ url: "https://x.com/i/flow/login" });
    expect(await waitForBoot(loginPage.page, { sleep })).toBe("logged-out");

    let clock = 0;
    const slowPage = makeFakePage({ url: "https://x.com/i/bookmarks", bootReady: false });
    expect(
      await waitForBoot(slowPage.page, {
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += 10_000;
        },
        now: () => clock,
      }),
    ).toBe("ready");

    // runScrollLoop: missingCollector -> reinstall, then 3 retries -> 4th triggers rate-limited
    sleeps.length = 0;
    const retryPage = makeFakePage({
      drains: [
        makeDrain([], { missingCollector: true }),
        makeDrain([domItem("10")], { hasRetry: true }),
        makeDrain([], { hasRetry: true }),
        makeDrain([], { hasRetry: true }),
        makeDrain([], { hasRetry: true }),
      ],
    });
    const retryRes = await runScrollLoop(
      retryPage.page,
      { knownIds: new Set(), full: false, maxItems: undefined },
      sleep,
    );
    expect(retryRes.stoppedReason).toBe("rate-limited");
    expect(retryRes.captured.map((c) => c.id)).toEqual(["10"]);
    expect(retryPage.evalCalls.filter((c) => c === "install").length).toBe(2);
    expect(retryPage.evalCalls.filter((c) => c === "retry").length).toBe(3);
    expect(sleeps).toEqual([3000, 6000, 9000]);

    // runScrollLoop: scrolling advances then hits bottom end-of-feed (also checks sleep(1200) and emptyState ignored when seen > 0)
    const scrollSleeps: number[] = [];
    const scrollPage = makeFakePage({
      drains: [makeDrain([domItem("20")]), makeDrain([], { hasEmptyState: true })],
      scrolls: [
        { before: 0, after: 800, scrollHeight: 2000 },
        { before: 800, after: 800, scrollHeight: 2000 },
      ],
    });
    const scrollRes = await runScrollLoop(
      scrollPage.page,
      { knownIds: new Set(), full: false, maxItems: undefined },
      async (ms) => {
        scrollSleeps.push(ms);
      },
    );
    expect(scrollRes.stoppedReason).toBe("end-of-feed");
    expect(scrollRes.captured.map((c) => c.id)).toEqual(["20"]);
    expect(scrollSleeps.length).toBeGreaterThanOrEqual(9);
    expect(scrollSleeps[0]).toBe(1200);
  });

  it("handles locks, loginToX, and makePlaywrightCapture happy/error paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "xbm-pw-test-"));
    const profileDir = join(root, "browser-profile");
    const lockPath = join(root, "sync.lock");
    mkdirSync(profileDir, { recursive: true });

    try {
      // Stale lock (dead PID, 0, -1, non-integer) cleared; missing parent dir created; live lock rejected
      const nestedLock = join(root, "nested-lock", "sync.lock");
      const relNested = acquireLock(nestedLock);
      expect(existsSync(nestedLock)).toBe(true);
      relNested();

      for (const stalePid of [999_999_999, 0, -1, 1.5]) {
        writeFileSync(lockPath, JSON.stringify({ pid: stalePid, startedAt: new Date().toISOString() }), "utf8");
        const rel = acquireLock(lockPath);
        expect(existsSync(lockPath)).toBe(true);
        rel();
      }
      const release = acquireLock(lockPath);
      expect(() => acquireLock(lockPath)).toThrow();
      release();
      expect(existsSync(lockPath)).toBe(false);

      // loginToX confirmed vs closed page vs timeout
      const loginOkPage = makeFakePage({ url: "https://x.com/i/history", loginHasContent: true });
      const loginOkCtx = makeFakeContext(loginOkPage.page, false);
      const loginSleeps: number[] = [];
      let launchOffscreen: boolean | undefined;
      expect(
        await loginToX(profileDir, {
          launchProfile: async (_dir, off) => {
            launchOffscreen = off;
            return loginOkCtx.ctx;
          },
          sleep: async (ms) => {
            loginSleeps.push(ms);
          },
        }),
      ).toBe(true);
      expect(launchOffscreen).toBe(false);
      expect(loginOkPage.gotoUrls).toEqual(["https://x.com/i/bookmarks"]);
      expect(loginSleeps).toEqual([2500]);
      expect(loginOkCtx.getNewPageCalls()).toBe(1);
      expect(loginOkCtx.getClosed()).toBe(1);

      const closedPage = makeFakePage({ url: "https://x.com/login", closed: true });
      const closedCtx = makeFakeContext(closedPage.page, true);
      expect(
        await loginToX(profileDir, {
          launchProfile: async () => closedCtx.ctx,
          sleep: async () => {},
        }),
      ).toBe(false);

      // loginToX times out after 10 minutes even when on bookmarks URL without content
      let loginClock = 0;
      const loginTimeoutSleeps: number[] = [];
      const stuckPage = makeFakePage({ url: "https://x.com/i/bookmarks", closed: false, loginHasContent: false });
      expect(
        await loginToX(profileDir, {
          launchProfile: async () => makeFakeContext(stuckPage.page).ctx,
          sleep: async (ms) => {
            loginTimeoutSleeps.push(ms);
            loginClock += 400_000;
          },
          now: () => loginClock,
        }),
      ).toBe(false);
      expect(loginTimeoutSleeps).toEqual([1000, 1000]);

      // loginToX ignores DOM content while still on a non-bookmarks login URL
      let nonBookmarkClock = 0;
      const loginUrlPage = makeFakePage({ url: "https://x.com/login", closed: false, loginHasContent: true });
      expect(
        await loginToX(profileDir, {
          launchProfile: async () => makeFakeContext(loginUrlPage.page).ctx,
          sleep: async () => {
            nonBookmarkClock += 700_000;
          },
          now: () => nonBookmarkClock,
        }),
      ).toBe(false);

      // Non-Error browser throw wraps string message
      const errString = await Effect.runPromise(
        Effect.flip(
          makePlaywrightCapture(profileDir, false, {
            launchProfile: async () => {
              throw "raw-browser-err";
            },
            sleep: async () => {},
          }).capture({ knownIds: new Set(), full: false, maxItems: undefined }),
        ),
      );
      expect(errString.reason).toBe("browser");
      expect(errString.detail).toBe("raw-browser-err");

      // makePlaywrightCapture happy path
      const okPage = makeFakePage({ drains: [makeDrain([], { hasEmptyState: true })] });
      const okCtx = makeFakeContext(okPage.page, true);
      const cap = makePlaywrightCapture(profileDir, true, {
        launchProfile: async () => okCtx.ctx,
        sleep: async () => {},
      });
      const res = await Effect.runPromise(cap.capture({ knownIds: new Set(), full: false, maxItems: undefined }));
      expect(res.stoppedReason).toBe("end-of-feed");
      expect(okCtx.getClosed()).toBe(1);

      // makePlaywrightCapture logged-out on boot and on scroll
      const bootOut = makeFakePage({ url: "https://x.com/login" });
      const errBoot = await Effect.runPromise(
        Effect.flip(
          makePlaywrightCapture(profileDir, true, {
            launchProfile: async () => makeFakeContext(bootOut.page).ctx,
            sleep: async () => {},
          }).capture({ knownIds: new Set(), full: false, maxItems: undefined }),
        ),
      );
      expect(errBoot.reason).toBe("logged-out");
      expect(errBoot.detail).toBe("X session expired; run login");

      const scrollOut = makeFakePage({ drains: [makeDrain([], { pathname: "/login" })] });
      const errScroll = await Effect.runPromise(
        Effect.flip(
          makePlaywrightCapture(profileDir, true, {
            launchProfile: async () => makeFakeContext(scrollOut.page).ctx,
            sleep: async () => {},
          }).capture({ knownIds: new Set(), full: false, maxItems: undefined }),
        ),
      );
      expect(errScroll.reason).toBe("logged-out");
      expect(errScroll.detail).toBe("X session redirected to login");

      // Browser throw wraps into CaptureError(browser)
      const errBrowser = await Effect.runPromise(
        Effect.flip(
          makePlaywrightCapture(profileDir, true, {
            launchProfile: async () => {
              throw new Error("chromium crashed");
            },
            sleep: async () => {},
          }).capture({ knownIds: new Set(), full: false, maxItems: undefined }),
        ),
      );
      expect(errBrowser.reason).toBe("browser");
      expect(errBrowser.detail).toBe("chromium crashed");

      // Missing profile via live layer
      const missingErr = await Effect.runPromise(
        Effect.flip(
          Effect.flatMap(CaptureSource, (c) =>
            c.capture({ knownIds: new Set(), full: false, maxItems: undefined }),
          ).pipe(Effect.provide(PlaywrightCaptureLive(join(root, "does-not-exist")))),
        ),
      );
      expect(missingErr.reason).toBe("missing-profile");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
