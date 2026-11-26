import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import type { CapturedBookmark } from "./db.ts";
import {
  clickRetryInPage,
  drainCollectorInPage,
  installCollectorInPage,
  scrollNextInPage,
  type CaptureStopReason,
} from "./dom-collector.ts";

export const DEFAULT_PROFILE_DIR = resolve(import.meta.dir, "../data/browser-profile");
const DEFAULT_LOCK_FILE = resolve(import.meta.dir, "../data/sync.lock");
const BOOKMARKS_URL = "https://x.com/i/bookmarks";

export interface BrowserCaptureOptions {
  knownIds: Set<string>;
  profileDir?: string;
  targetUrl?: string;
  headless?: boolean;
  full?: boolean;
  allowFolder?: boolean;
  maxItems?: number;
  stopAfterKnown?: number;
  scrollDelayMs?: number;
  onProgress?: (stats: { seen: number; added: number; unparsed: number; scrollStep: number }) => void;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(lockPath = DEFAULT_LOCK_FILE): () => void {
  mkdirSync(resolve(lockPath, ".."), { recursive: true });
  if (existsSync(lockPath)) {
    try {
      const content = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number; startedAt?: string };
      if (content.pid && isPidAlive(content.pid)) {
        throw new Error(
          `Another x-bookmarks browser sync is already running (pid ${content.pid}, started ${content.startedAt || "unknown"}). Skipping overlapping run.`
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("already running")) throw err;
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // ignore stale lock removal error
    }
  }

  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
  return () => {
    try {
      unlinkSync(lockPath);
    } catch {
      // ignore
    }
  };
}

async function launchProfile(profileDir: string, headless: boolean): Promise<BrowserContext> {
  mkdirSync(profileDir, { recursive: true });
  // X blocks headless Chromium, and the headless shell can't decrypt (and then drops) cookies
  // written by headed Chromium. So always run headed; "headless" runs just park the window off-screen.
  return chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    args: [
      "--disable-blink-features=AutomationControlled",
      ...(headless ? ["--window-position=-32000,-32000"] : []),
    ],
  });
}

/**
 * Opens a headed Chromium window backed by the persistent profile so the user can
 * sign into X once. Cookies persist in `data/browser-profile` for future headless cron runs.
 */
export async function loginToX(
  profileDir = process.env.X_BOOKMARKS_PROFILE || DEFAULT_PROFILE_DIR
): Promise<void> {
  const release = acquireLock();
  let context: BrowserContext | null = null;
  try {
    console.log(`Opening Chromium with persistent profile: ${profileDir}`);
    console.log("Sign in to X in the browser window. Once your bookmarks appear, this will detect it and save your session.");

    context = await launchProfile(profileDir, false);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(BOOKMARKS_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    const deadline = Date.now() + 10 * 60 * 1000;
    let loggedIn = false;

    while (Date.now() < deadline) {
      if (page.isClosed()) break;
      const url = page.url();
      const onBookmarks = /https:\/\/(?:x|twitter)\.com\/i\/(?:bookmarks|history)/i.test(url);
      if (onBookmarks) {
        const hasContent = await page
          .evaluate(() =>
            Boolean(
              document.querySelector('article[data-testid="tweet"]') ||
                document.querySelector('[data-testid="emptyState"]')
            )
          )
          .catch(() => false);
        if (hasContent) {
          loggedIn = true;
          // Give Chromium a moment to flush cookies & IndexedDB to disk
          await Bun.sleep(2500);
          break;
        }
      }
      await Bun.sleep(1000);
    }

    if (loggedIn) {
      console.log("Login confirmed on x.com/i/bookmarks. Session saved cleanly to persistent profile.");
    } else {
      console.log("Browser closed before bookmarks loaded. If you finished signing in, test with 'bun run capture -- --max 5'.");
    }
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    release();
  }
}

export async function captureFromBrowser(opts: BrowserCaptureOptions): Promise<{
  captured: CapturedBookmark[];
  stoppedReason: CaptureStopReason;
  unparsedCount: number;
  folderId: string | null;
  folderName: string | null;
}> {
  const profileDir = opts.profileDir || process.env.X_BOOKMARKS_PROFILE || DEFAULT_PROFILE_DIR;
  const targetUrl = opts.targetUrl || BOOKMARKS_URL;
  const headless = opts.headless ?? true;
  const stopAfterKnown = opts.stopAfterKnown ?? 15;
  const scrollDelayMs = opts.scrollDelayMs ?? 1200;
  const maxItems = opts.maxItems ?? Infinity;

  if (!existsSync(profileDir)) {
    throw new Error(
      `Persistent browser profile not found at ${profileDir}. Run 'bun run login' once to sign in to X.`
    );
  }

  const release = acquireLock();
  let context: BrowserContext | null = null;

  try {
    context = await launchProfile(profileDir, headless);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Wait up to 20s for either tweets, empty state, or login redirect
    const bootDeadline = Date.now() + 20000;
    while (Date.now() < bootDeadline) {
      const currentUrl = page.url();
      if (/\/login|\/i\/flow\/login/i.test(currentUrl)) {
        return {
          captured: [],
          stoppedReason: "logged-out",
          unparsedCount: 0,
          folderId: null,
          folderName: null,
        };
      }
      const ready = await page
        .evaluate(() =>
          Boolean(
            document.querySelector('article[data-testid="tweet"]') ||
              document.querySelector('[data-testid="emptyState"]') ||
              /something went wrong/i.test(document.querySelector("main")?.innerText || "")
          )
        )
        .catch(() => false);
      if (ready) break;
      await Bun.sleep(500);
    }

    const token = randomUUID();
    await page.evaluate(installCollectorInPage, token);

    const orderedIds: string[] = [];
    const seenThisRun = new Map<string, CapturedBookmark>();
    let consecutiveKnown = 0;
    let scrollStep = 0;
    let stableBottomMs = 0;
    let idleSteps = 0;
    let retryAttempts = 0;
    let lastScrollHeight = 0;
    let unparsedCount = 0;
    let folderId: string | null = null;
    let folderName: string | null = null;
    let stoppedReason: CaptureStopReason = "end-of-feed";

    while (true) {
      const state = await page.evaluate(drainCollectorInPage);
      if (state.missingCollector) {
        await page.evaluate(installCollectorInPage, token);
        continue;
      }

      if (/\/login|\/i\/flow\/login|\/i\/jf\/onboarding/.test(state.pathname)) {
        stoppedReason = "logged-out";
        break;
      }
      if (!/^\/i\/(?:bookmarks|history)/.test(state.pathname)) {
        stoppedReason = "wrong-page";
        break;
      }

      folderId = state.folderId;
      folderName = state.folderName;
      if (folderId && opts.full && !opts.allowFolder) {
        throw new Error(
          `Browser navigated to folder ${folderId} (${folderName || "unnamed"}) instead of /i/bookmarks. Pass --allow-folder to capture a folder.`
        );
      }

      unparsedCount = state.unparsedCount;
      let addedThisStep = 0;

      for (const item of state.items) {
        if (seenThisRun.has(item.id)) continue;

        const record: CapturedBookmark = {
          id: item.id,
          url: item.url,
          author_handle: item.author_handle,
          author_name: item.author_name,
          created_at: item.created_at,
          dom_text: item.dom_text,
          capture_source: "playwright-dom",
          folder_id: folderId,
          folder_name: folderName,
        };
        seenThisRun.set(item.id, record);
        orderedIds.push(item.id);
        addedThisStep++;

        if (opts.knownIds.has(item.id)) {
          consecutiveKnown++;
        } else {
          consecutiveKnown = 0;
        }

        if (!opts.full && consecutiveKnown >= stopAfterKnown) {
          stoppedReason = "reached-known-bookmarks";
          return {
            captured: orderedIds.map((id) => seenThisRun.get(id)!),
            stoppedReason,
            unparsedCount,
            folderId,
            folderName,
          };
        }

        if (seenThisRun.size >= maxItems) {
          stoppedReason = "reached-max";
          return {
            captured: orderedIds.map((id) => seenThisRun.get(id)!),
            stoppedReason,
            unparsedCount,
            folderId,
            folderName,
          };
        }
      }

      opts.onProgress?.({
        seen: seenThisRun.size,
        added: orderedIds.filter((id) => !opts.knownIds.has(id)).length,
        unparsed: unparsedCount,
        scrollStep,
      });

      if (state.hasEmptyState && seenThisRun.size === 0) {
        stoppedReason = "end-of-feed";
        break;
      }

      if (state.hasRetry) {
        if (retryAttempts >= 3) {
          stoppedReason = "rate-limited";
          break;
        }
        retryAttempts++;
        await page.evaluate(clickRetryInPage);
        await Bun.sleep(3000 * retryAttempts);
        continue;
      }
      retryAttempts = 0;

      const scrollInfo = await page.evaluate(scrollNextInPage);
      scrollStep++;

      const atBottom = scrollInfo.after === scrollInfo.before && scrollInfo.scrollHeight === lastScrollHeight;
      lastScrollHeight = scrollInfo.scrollHeight;

      // X's /i/history page keeps shifting scrollHeight at the end, so atBottom may never settle.
      idleSteps = addedThisStep === 0 ? idleSteps + 1 : 0;
      if (idleSteps >= 40) {
        stoppedReason = "end-of-feed";
        break;
      }

      if (addedThisStep === 0 && atBottom) {
        stableBottomMs += scrollDelayMs;
        if (!state.hasSpinner && stableBottomMs >= 12000) {
          stoppedReason = "end-of-feed";
          break;
        }
        if (state.hasSpinner && stableBottomMs >= 25000) {
          stoppedReason = "stalled";
          break;
        }
      } else {
        stableBottomMs = 0;
      }

      await Bun.sleep(scrollDelayMs);
    }

    return {
      captured: orderedIds.map((id) => seenThisRun.get(id)!),
      stoppedReason,
      unparsedCount,
      folderId,
      folderName,
    };
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    release();
  }
}
