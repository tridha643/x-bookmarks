import { randomUUID } from "node:crypto";
import type { CapturedBookmark } from "./db.ts";

export type CaptureStopReason =
  | "end-of-feed"
  | "reached-known-bookmarks"
  | "reached-max"
  | "stalled"
  | "rate-limited"
  | "logged-out"
  | "wrong-page"
  | "hidden-tab";

export interface SafariCaptureOptions {
  knownIds: Set<string>;
  full?: boolean;
  allowFolder?: boolean;
  maxItems?: number;
  stopAfterKnown?: number;
  scrollDelayMs?: number;
  onProgress?: (stats: { seen: number; added: number; unparsed: number; scrollStep: number }) => void;
}

interface SafariTabRef {
  windowIndex: number;
  tabIndex: number;
  url: string;
}

interface DomExtractedItem {
  id: string;
  url: string;
  author_handle: string | null;
  author_name: string | null;
  created_at: string | null;
  dom_text: string | null;
}

interface CollectorDrainResult {
  href: string;
  pathname: string;
  visibilityState: string;
  folderId: string | null;
  folderName: string | null;
  articleCount: number;
  hasSpinner: boolean;
  hasRetry: boolean;
  hasEmptyState: boolean;
  scrollY: number;
  scrollHeight: number;
  innerHeight: number;
  unparsedCount: number;
  items: DomExtractedItem[];
}

/**
 * Installs a persistent MutationObserver collector in the page (`window.__xbm`)
 * so virtualized DOM recycling can never skip a rendered bookmark, stamps a
 * unique tab token so tab re-indexing never drifts, and extracts strictly from
 * the outer tweet's <time> permalink (never falling back to quoted-tweet links).
 */
export function buildInstallCollectorSnippet(token: string): string {
  return `(() => {
    const TOKEN = ${JSON.stringify(token)};
    window.__xbmToken = TOKEN;

    function extractArticle(article) {
      const timeEl = article.querySelector('time');
      if (!timeEl) return null;
      const statusLink = timeEl.closest('a[href*="/status/"]');
      if (!statusLink) return null;
      const href = statusLink.getAttribute('href') || '';
      const m = href.match(/^\\/([^/]+)\\/status\\/(\\d+)(?:\\/?$)/);
      if (!m) return null;

      const author_handle = m[1];
      const id = m[2];
      const url = 'https://x.com/' + author_handle + '/status/' + id;
      const created_at = timeEl.getAttribute('datetime') || null;
      const nameEl = article.querySelector('[data-testid="User-Name"] span');
      const author_name = nameEl ? nameEl.textContent.trim() : null;

      // Exclude tweetText nodes nested inside a quoted tweet card (div[role="link"])
      let dom_text = null;
      const textNodes = article.querySelectorAll('[data-testid="tweetText"]');
      for (const node of textNodes) {
        if (!node.closest('div[role="link"]')) {
          dom_text = node.innerText.trim() || null;
          break;
        }
      }
      return { id, url, author_handle, author_name, created_at, dom_text };
    }

    if (window.__xbm?.observer) {
      try { window.__xbm.observer.disconnect(); } catch {}
    }

    const state = {
      items: new Map(),
      unparsed: new WeakSet(),
      unparsedCount: 0,
      scan() {
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        for (const a of articles) {
          const parsed = extractArticle(a);
          if (parsed) {
            if (!state.items.has(parsed.id)) {
              state.items.set(parsed.id, parsed);
            }
          } else if (!state.unparsed.has(a)) {
            state.unparsed.add(a);
            state.unparsedCount++;
          }
        }
      },
      observer: null
    };

    state.scan();
    state.observer = new MutationObserver(() => state.scan());
    state.observer.observe(document.body, { childList: true, subtree: true });
    window.__xbm = state;
    return JSON.stringify({ ok: true, initialCount: state.items.size });
  })()`;
}

export const DRAIN_COLLECTOR_SNIPPET = `(() => {
  if (!window.__xbm) return JSON.stringify({ missingCollector: true });
  window.__xbm.scan();

  const pathname = location.pathname || '';
  const folderMatch = pathname.match(/^\\/i\\/bookmarks\\/(\\d+)/);
  const folderId = folderMatch ? folderMatch[1] : null;
  let folderName = null;
  if (folderId) {
    const h2 = document.querySelector('main h2[role="heading"]');
    folderName = h2 ? h2.textContent.trim() : null;
  }

  const hasSpinner = Boolean(document.querySelector('main [role="progressbar"]'));
  const retryBtn = Array.from(document.querySelectorAll('main button, main [role="button"]'))
    .find(el => /^retry$/i.test((el.textContent || '').trim()));
  const bodyText = (document.querySelector('main')?.innerText || '');
  const hasRetry = Boolean(retryBtn) || /something went wrong/i.test(bodyText);
  const hasEmptyState = Boolean(document.querySelector('[data-testid="emptyState"]'));

  const items = Array.from(window.__xbm.items.values());
  return JSON.stringify({
    href: location.href,
    pathname,
    visibilityState: document.visibilityState,
    folderId,
    folderName,
    articleCount: document.querySelectorAll('article[data-testid="tweet"]').length,
    hasSpinner,
    hasRetry,
    hasEmptyState,
    scrollY: window.scrollY,
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
    unparsedCount: window.__xbm.unparsedCount,
    items
  });
})()`;

const SCROLL_NEXT_SNIPPET = `(() => {
  const before = window.scrollY;
  const cells = document.querySelectorAll('main [data-testid="cellInnerDiv"]');
  const lastCell = cells.length > 0 ? cells[cells.length - 1] : null;
  if (lastCell) {
    lastCell.scrollIntoView({ behavior: 'instant', block: 'end' });
  }
  if (window.scrollY === before) {
    window.scrollBy(0, Math.max(window.innerHeight * 0.85, 700));
  }
  return JSON.stringify({
    before,
    after: window.scrollY,
    scrollHeight: document.documentElement.scrollHeight
  });
})()`;

const CLICK_RETRY_SNIPPET = `(() => {
  const btn = Array.from(document.querySelectorAll('main button, main [role="button"]'))
    .find(el => /^retry$/i.test((el.textContent || '').trim()));
  if (btn) { btn.click(); return "clicked"; }
  return "none";
})()`;

async function runAppleScript(script: string, args: string[] = [], timeoutMs = 25000): Promise<string> {
  const proc = Bun.spawn(["osascript", "-e", script, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // ignore
    }
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timer));

  if (exitCode !== 0) {
    const msg = stderr.trim();
    if (msg.includes("-1743") || msg.toLowerCase().includes("not authorized")) {
      throw new Error(
        "macOS blocked Automation access to Safari (-1743). Allow your terminal/T3 app under System Settings -> Privacy & Security -> Automation -> Safari, then retry. (Note: updating T3 or your terminal can reset this grant.)"
      );
    }
    if (msg.toLowerCase().includes("javascript") && msg.toLowerCase().includes("apple events")) {
      throw new Error(
        "Safari blocked JavaScript from Apple Events. Enable Safari -> Settings -> Advanced -> 'Show features for web developers', then Safari -> Settings -> Developer -> 'Allow JavaScript from Apple Events'."
      );
    }
    if (exitCode === 143 || exitCode === 137) {
      throw new Error("Safari AppleScript timed out (check if Safari has a modal dialog or permission prompt open).");
    }
    throw new Error(`Safari AppleScript failed (exit ${exitCode}): ${msg || "unknown error"}`);
  }

  return stdout.trim();
}

export async function findBookmarksTab(token?: string): Promise<SafariTabRef> {
  if (token) {
    const byTokenScript = `
      on run argv
        set tok to item 1 of argv
        with timeout of 20 seconds
          tell application "Safari"
            if (count of windows) is 0 then return ""
            repeat with w from 1 to count of windows
              set tCount to count of tabs of window w
              repeat with t from 1 to tCount
                set u to URL of tab t of window w
                if u contains "x.com/" or u contains "twitter.com/" then
                  try
                    set hit to do JavaScript "window.__xbmToken === " & quoted form of tok in tab t of window w
                    if hit is true or hit is "true" then
                      return (w as text) & "|" & (t as text) & "|" & u
                    end if
                  end try
                end if
              end repeat
            end repeat
          end tell
        end timeout
        return ""
      end run
    `;
    const found = await runAppleScript(byTokenScript, [token]);
    if (found) {
      const [w, t, ...rest] = found.split("|");
      return { windowIndex: Number(w), tabIndex: Number(t), url: rest.join("|") };
    }
  }

  const script = `
    with timeout of 20 seconds
      tell application "Safari"
        if (count of windows) is 0 then return ""
        repeat with w from 1 to count of windows
          set tCount to count of tabs of window w
          repeat with t from 1 to tCount
            set u to URL of tab t of window w
            if u contains "x.com/i/bookmarks" or u contains "twitter.com/i/bookmarks" then
              return (w as text) & "|" & (t as text) & "|" & u
            end if
          end repeat
        end repeat
        return ""
      end tell
    end timeout
  `;

  const out = await runAppleScript(script);
  if (!out) {
    throw new Error(
      "No Safari tab is open at x.com/i/bookmarks. Open https://x.com/i/bookmarks in Safari (logged in) and run again."
    );
  }

  const [w, t, ...rest] = out.split("|");
  return {
    windowIndex: Number(w),
    tabIndex: Number(t),
    url: rest.join("|"),
  };
}

async function evalInSafariTab(tab: SafariTabRef, jsCode: string): Promise<string> {
  const script = `
    on run argv
      set wIdx to (item 1 of argv) as integer
      set tIdx to (item 2 of argv) as integer
      set jsCode to item 3 of argv
      with timeout of 20 seconds
        tell application "Safari"
          return do JavaScript jsCode in tab tIdx of window wIdx
        end tell
      end timeout
    end run
  `;
  return runAppleScript(script, [String(tab.windowIndex), String(tab.tabIndex), jsCode]);
}

function parseJsonGuard<T>(raw: string, context: string): T {
  if (!raw) {
    throw new Error(
      `Safari returned an empty response during ${context}. The tab may still be loading, discarded, or navigated away.`
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Unexpected non-JSON response from Safari during ${context}: ${raw.slice(0, 120)}`);
  }
}

export async function captureFromSafari(opts: SafariCaptureOptions): Promise<{
  captured: CapturedBookmark[];
  stoppedReason: CaptureStopReason;
  unparsedCount: number;
  folderId: string | null;
  folderName: string | null;
}> {
  const token = randomUUID();
  let tab = await findBookmarksTab();
  const stopAfterKnown = opts.stopAfterKnown ?? 15;
  const scrollDelayMs = opts.scrollDelayMs ?? 1200;
  const maxItems = opts.maxItems ?? Infinity;

  await evalInSafariTab(tab, buildInstallCollectorSnippet(token));

  const orderedIds: string[] = [];
  const seenThisRun = new Map<string, CapturedBookmark>();
  let consecutiveKnown = 0;
  let scrollStep = 0;
  let stableBottomMs = 0;
  let retryAttempts = 0;
  let lastScrollHeight = 0;
  let unparsedCount = 0;
  let folderId: string | null = null;
  let folderName: string | null = null;
  let stoppedReason: CaptureStopReason = "end-of-feed";

  while (true) {
    let raw: string;
    try {
      raw = await evalInSafariTab(tab, DRAIN_COLLECTOR_SNIPPET);
    } catch {
      // Tab indices may have drifted if user moved/closed tabs; re-resolve by token
      tab = await findBookmarksTab(token);
      raw = await evalInSafariTab(tab, DRAIN_COLLECTOR_SNIPPET);
    }

    const state = parseJsonGuard<CollectorDrainResult & { missingCollector?: boolean }>(raw, "DOM drain");
    if (state.missingCollector) {
      await evalInSafariTab(tab, buildInstallCollectorSnippet(token));
      continue;
    }

    // Validate page and visibility state
    if (state.pathname.includes("/login") || state.pathname.includes("/i/flow/login")) {
      stoppedReason = "logged-out";
      break;
    }
    if (!state.pathname.startsWith("/i/bookmarks")) {
      stoppedReason = "wrong-page";
      break;
    }
    if (state.visibilityState !== "visible") {
      stoppedReason = "hidden-tab";
      break;
    }

    folderId = state.folderId;
    folderName = state.folderName;
    if (folderId && opts.full && !opts.allowFolder) {
      throw new Error(
        `Safari tab is on bookmark folder ${folderId} (${folderName || "unnamed"}), not the main /i/bookmarks feed. Switch to /i/bookmarks for --full, or pass --allow-folder to capture this folder.`
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
        capture_source: "safari-dom",
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

    // Handle X "Something went wrong / Retry" rate limit banner
    if (state.hasRetry) {
      if (retryAttempts >= 3) {
        stoppedReason = "rate-limited";
        break;
      }
      retryAttempts++;
      await evalInSafariTab(tab, CLICK_RETRY_SNIPPET);
      await Bun.sleep(3000 * retryAttempts);
      continue;
    }
    retryAttempts = 0;

    const scrollRaw = await evalInSafariTab(tab, SCROLL_NEXT_SNIPPET);
    const scrollInfo = parseJsonGuard<{ before: number; after: number; scrollHeight: number }>(
      scrollRaw,
      "scroll"
    );
    scrollStep++;

    const atBottom = scrollInfo.after === scrollInfo.before && scrollInfo.scrollHeight === lastScrollHeight;
    lastScrollHeight = scrollInfo.scrollHeight;

    if (addedThisStep === 0 && atBottom) {
      stableBottomMs += scrollDelayMs;
      // Require 12s of stable bottom with no spinner before declaring true end-of-feed
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
}

/**
 * Browser-agnostic self-contained DOM collector (works in Safari DevTools Console,
 * Chrome DevTools, or T3 Code's preview_evaluate).
 */
export function getManualConsoleSnippet(): string {
  return `// Paste into DevTools Console on https://x.com/i/bookmarks (downloads JSON for 'bun run import')
(async () => {
  const seen = new Map();
  const scan = () => {
    for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
      const t = a.querySelector('time');
      const link = t?.closest('a[href*="/status/"]');
      const m = link?.getAttribute('href')?.match(/^\\/([^/]+)\\/status\\/(\\d+)(?:\\/?$)/);
      if (!m || seen.has(m[2])) continue;
      let dom_text = null;
      for (const n of a.querySelectorAll('[data-testid="tweetText"]')) {
        if (!n.closest('div[role="link"]')) { dom_text = n.innerText.trim() || null; break; }
      }
      seen.set(m[2], {
        id: m[2],
        url: 'https://x.com/' + m[1] + '/status/' + m[2],
        author_handle: m[1],
        author_name: a.querySelector('[data-testid="User-Name"] span')?.textContent?.trim() || null,
        created_at: t.getAttribute('datetime') || null,
        dom_text
      });
    }
  };
  const obs = new MutationObserver(scan);
  obs.observe(document.body, { childList: true, subtree: true });
  scan();

  let stableMs = 0, lastH = 0;
  while (stableMs < 12000) {
    const beforeCount = seen.size, beforeY = window.scrollY;
    const cells = document.querySelectorAll('main [data-testid="cellInnerDiv"]');
    if (cells.length) cells[cells.length - 1].scrollIntoView({ behavior: 'instant', block: 'end' });
    if (window.scrollY === beforeY) window.scrollBy(0, Math.max(window.innerHeight * 0.85, 700));
    await new Promise(r => setTimeout(r, 1200));
    scan();
    const h = document.documentElement.scrollHeight;
    const hasSpinner = Boolean(document.querySelector('main [role="progressbar"]'));
    if (seen.size === beforeCount && window.scrollY === beforeY && h === lastH && !hasSpinner) {
      stableMs += 1200;
    } else {
      stableMs = 0;
    }
    lastH = h;
    console.log('Captured', seen.size, 'bookmarks...');
  }
  obs.disconnect();
  const blob = new Blob([JSON.stringify([...seen.values()], null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'x-bookmarks-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  console.log('Done! Saved', seen.size, 'bookmarks.');
})();`;
}
