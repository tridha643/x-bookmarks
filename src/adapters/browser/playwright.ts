import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { Effect, Layer, Option, Schema } from "effect";
import { decodeBookmarkId, type CapturedBookmark } from "../../domain/bookmark.ts";
import {
  CaptureError,
  CaptureSource,
  type CaptureOptions,
  type CaptureResult,
  type CaptureSourceShape,
} from "../../ports/capture.ts";
import {
  clickRetryInPage,
  drainCollectorInPage,
  installCollectorInPage,
  scrollNextInPage,
  type CaptureStopReason,
  type CollectorDrainResult,
  type DomExtractedItem,
} from "./dom-collector.ts";

const BOOKMARKS_URL = "https://x.com/i/bookmarks";
const LockFileSchema = Schema.Struct({ pid: Schema.Number, startedAt: Schema.String });

export interface CapturePage {
  url(): string;
  isClosed(): boolean;
  goto(
    url: string,
    options?: { readonly waitUntil?: "domcontentloaded"; readonly timeout?: number },
  ): ReturnType<Page["goto"]>;
  evaluate<R>(fn: () => R): Promise<R>;
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>;
}

export interface CaptureContext {
  pages(): ReadonlyArray<CapturePage>;
  newPage(): Promise<CapturePage>;
  close(): Promise<void>;
}

export interface BrowserRuntime {
  readonly launchProfile?: (profileDir: string, offscreen: boolean) => Promise<CaptureContext>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const isPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const acquireLock = (lockPath: string): (() => void) => {
  mkdirSync(resolve(lockPath, ".."), { recursive: true });
  if (existsSync(lockPath)) {
    const raw = Option.getOrNull(
      Schema.decodeUnknownOption(LockFileSchema)(JSON.parse(readFileSync(lockPath, "utf8"))),
    );
    if (raw !== null && isPidAlive(raw.pid)) {
      throw new CaptureError({ reason: "locked", detail: `sync already running (pid ${raw.pid})` });
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // Stale lock removed concurrently
    }
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
  return () => {
    try {
      unlinkSync(lockPath);
    } catch {
      // Ignore cleanup error
    }
  };
};

// X blocks headless Chromium, and headless shell cannot decrypt cookies written by headed Chromium.
const defaultLaunchProfile = (profileDir: string, offscreen: boolean): Promise<BrowserContext> => {
  mkdirSync(profileDir, { recursive: true });
  return chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    args: ["--disable-blink-features=AutomationControlled", ...(offscreen ? ["--window-position=-32000,-32000"] : [])],
  });
};

export const waitForBoot = async (
  page: CapturePage,
  rt?: Pick<BrowserRuntime, "sleep" | "now">,
): Promise<"ready" | "logged-out"> => {
  const sleepFn = rt?.sleep ?? defaultSleep;
  const nowFn = rt?.now ?? Date.now;
  const deadline = nowFn() + 20_000;
  while (nowFn() < deadline) {
    if (/\/login|\/i\/flow\/login|\/i\/jf\/onboarding/i.test(page.url())) return "logged-out";
    const ready = await page
      .evaluate(
        () =>
          document.querySelector('article[data-testid="tweet"]') !== null ||
          document.querySelector('[data-testid="emptyState"]') !== null ||
          /something went wrong/i.test(document.querySelector("main")?.textContent ?? ""),
      )
      .catch(() => false);
    if (ready) return "ready";
    await sleepFn(500);
  }
  return "ready";
};

export interface LoopTracker {
  readonly orderedIds: string[];
  readonly seen: Map<string, CapturedBookmark>;
  consecutiveKnown: number;
  stableBottomMs: number;
  idleSteps: number;
  retryAttempts: number;
  lastScrollHeight: number;
}

export const createLoopTracker = (): LoopTracker => ({
  orderedIds: [],
  seen: new Map(),
  consecutiveKnown: 0,
  stableBottomMs: 0,
  idleSteps: 0,
  retryAttempts: 0,
  lastScrollHeight: 0,
});

interface AbsorbResult {
  readonly added: number;
  readonly stop: CaptureStopReason | null;
}

export const classifyPathname = (pathname: string): CaptureStopReason | null => {
  if (/\/login|\/i\/flow\/login|\/i\/jf\/onboarding/.test(pathname)) return "logged-out";
  if (!/^\/i\/(?:bookmarks|history)/.test(pathname)) return "wrong-page";
  return null;
};

const recordDomItem = (tracker: LoopTracker, item: DomExtractedItem, state: CollectorDrainResult): boolean => {
  if (tracker.seen.has(item.id)) return false;
  const id = decodeBookmarkId(item.id);
  if (id === null) return false;
  tracker.seen.set(item.id, {
    id,
    url: item.url,
    authorHandle: item.authorHandle,
    authorName: item.authorName,
    createdAt: item.createdAt,
    domText: item.domText,
    captureSource: "playwright-dom",
    folderId: state.folderId,
    folderName: state.folderName,
  });
  tracker.orderedIds.push(item.id);
  return true;
};

const checkItemStop = (
  tracker: LoopTracker,
  itemId: string,
  opts: CaptureOptions,
  maxItems: number,
): CaptureStopReason | null => {
  tracker.consecutiveKnown = opts.knownIds.has(itemId) ? tracker.consecutiveKnown + 1 : 0;
  if (!opts.full && tracker.consecutiveKnown >= 15) return "reached-known-bookmarks";
  return tracker.seen.size >= maxItems ? "reached-max" : null;
};

export const absorbDrainItems = (
  tracker: LoopTracker,
  state: CollectorDrainResult,
  opts: CaptureOptions,
): AbsorbResult => {
  const maxItems = opts.maxItems ?? Number.POSITIVE_INFINITY;
  let added = 0;
  for (const item of state.items) {
    if (!recordDomItem(tracker, item, state)) continue;
    added++;
    const stop = checkItemStop(tracker, item.id, opts, maxItems);
    if (stop !== null) return { added, stop };
  }
  return { added, stop: null };
};

export const checkBottomTermination = (
  tracker: LoopTracker,
  added: number,
  atBottom: boolean,
  hasSpinner: boolean,
): CaptureStopReason | null => {
  tracker.idleSteps = added === 0 ? tracker.idleSteps + 1 : 0;
  if (tracker.idleSteps >= 40) return "end-of-feed";
  if (added > 0 || !atBottom) {
    tracker.stableBottomMs = 0;
    return null;
  }
  tracker.stableBottomMs += 1200;
  const limitMs = hasSpinner ? 25_000 : 12_000;
  if (tracker.stableBottomMs < limitMs) return null;
  return hasSpinner ? "stalled" : "end-of-feed";
};

export const collectTrackerOutput = (tracker: LoopTracker, stoppedReason: CaptureStopReason): CaptureResult => ({
  captured: tracker.orderedIds.map((k) => tracker.seen.get(k)).filter((x): x is CapturedBookmark => x !== undefined),
  stoppedReason,
});

const handleRetryBanner = async (
  page: CapturePage,
  tracker: LoopTracker,
  sleepFn: (ms: number) => Promise<void>,
): Promise<"continue" | "rate-limited"> => {
  if (tracker.retryAttempts >= 3) return "rate-limited";
  tracker.retryAttempts++;
  await page.evaluate(clickRetryInPage);
  await sleepFn(3000 * tracker.retryAttempts);
  return "continue";
};

const scrollAndCheckEnd = async (
  page: CapturePage,
  tracker: LoopTracker,
  added: number,
  hasSpinner: boolean,
  sleepFn: (ms: number) => Promise<void>,
): Promise<CaptureStopReason | null> => {
  tracker.retryAttempts = 0;
  const scrollInfo = await page.evaluate(scrollNextInPage);
  const atBottom = scrollInfo.after === scrollInfo.before && scrollInfo.scrollHeight === tracker.lastScrollHeight;
  tracker.lastScrollHeight = scrollInfo.scrollHeight;
  const endStop = checkBottomTermination(tracker, added, atBottom, hasSpinner);
  if (endStop !== null) return endStop;
  await sleepFn(1200);
  return null;
};

const runScrollStep = async (
  page: CapturePage,
  token: string,
  tracker: LoopTracker,
  opts: CaptureOptions,
  sleepFn: (ms: number) => Promise<void>,
): Promise<CaptureStopReason | null> => {
  const state = await page.evaluate(drainCollectorInPage);
  if (state.missingCollector) {
    await page.evaluate(installCollectorInPage, token);
    return null;
  }
  const pathStop = classifyPathname(state.pathname);
  if (pathStop !== null) return pathStop;
  const { added, stop } = absorbDrainItems(tracker, state, opts);
  if (stop !== null) return stop;
  if (state.hasEmptyState && tracker.seen.size === 0) return "end-of-feed";
  if (state.hasRetry)
    return (await handleRetryBanner(page, tracker, sleepFn)) === "rate-limited" ? "rate-limited" : null;
  return scrollAndCheckEnd(page, tracker, added, state.hasSpinner, sleepFn);
};

export const runScrollLoop = async (
  page: CapturePage,
  opts: CaptureOptions,
  sleepFn: (ms: number) => Promise<void> = defaultSleep,
): Promise<CaptureResult> => {
  const token = String(Date.now());
  await page.evaluate(installCollectorInPage, token);
  const tracker = createLoopTracker();
  while (true) {
    const stop = await runScrollStep(page, token, tracker, opts, sleepFn);
    if (stop !== null) return collectTrackerOutput(tracker, stop);
  }
};

const waitForLoginContent = async (
  page: CapturePage,
  sleepFn: (ms: number) => Promise<void>,
  nowFn: () => number,
): Promise<boolean> => {
  const deadline = nowFn() + 10 * 60 * 1000;
  while (nowFn() < deadline && !page.isClosed()) {
    if (/https:\/\/(?:x|twitter)\.com\/i\/(?:bookmarks|history)/i.test(page.url())) {
      const hasContent = await page
        .evaluate(
          () =>
            document.querySelector('article[data-testid="tweet"]') !== null ||
            document.querySelector('[data-testid="emptyState"]') !== null,
        )
        .catch(() => false);
      if (hasContent) {
        await sleepFn(2500);
        return true;
      }
    }
    await sleepFn(1000);
  }
  return false;
};

export const loginToX = async (profileDir: string, rt?: BrowserRuntime): Promise<boolean> => {
  const launchFn = rt?.launchProfile ?? defaultLaunchProfile;
  const sleepFn = rt?.sleep ?? defaultSleep;
  const nowFn = rt?.now ?? Date.now;
  const release = acquireLock(resolve(profileDir, "../sync.lock"));
  let context: CaptureContext | null = null;
  try {
    context = await launchFn(profileDir, false);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(BOOKMARKS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return await waitForLoginContent(page, sleepFn, nowFn);
  } finally {
    if (context !== null) await context.close().catch(() => undefined);
    release();
  }
};

export const makePlaywrightCapture = (
  profileDir: string,
  offscreen = true,
  rt?: BrowserRuntime,
): CaptureSourceShape => {
  const launchFn = rt?.launchProfile ?? defaultLaunchProfile;
  const sleepFn = rt?.sleep ?? defaultSleep;
  return {
    capture: (opts) =>
      Effect.tryPromise({
        try: async (): Promise<CaptureResult> => {
          if (!existsSync(profileDir)) {
            throw new CaptureError({ reason: "missing-profile", detail: `profile not found at ${profileDir}` });
          }
          const release = acquireLock(resolve(profileDir, "../sync.lock"));
          let context: CaptureContext | null = null;
          try {
            context = await launchFn(profileDir, offscreen);
            const page = context.pages()[0] ?? (await context.newPage());
            await page.goto(BOOKMARKS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
            const boot = await waitForBoot(page, rt);
            if (boot === "logged-out")
              throw new CaptureError({ reason: "logged-out", detail: "X session expired; run login" });
            const result = await runScrollLoop(page, opts, sleepFn);
            if (result.stoppedReason === "logged-out") {
              throw new CaptureError({ reason: "logged-out", detail: "X session redirected to login" });
            }
            return result;
          } finally {
            if (context !== null) await context.close().catch(() => undefined);
            release();
          }
        },
        catch: (err) =>
          err instanceof CaptureError
            ? err
            : new CaptureError({ reason: "browser", detail: err instanceof Error ? err.message : String(err) }),
      }),
  };
};

export const PlaywrightCaptureLive = (profileDir: string, offscreen = true): Layer.Layer<CaptureSource> =>
  Layer.succeed(CaptureSource, makePlaywrightCapture(profileDir, offscreen));
