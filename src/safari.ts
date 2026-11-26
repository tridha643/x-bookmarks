import { randomUUID } from "node:crypto";
import type { CapturedBookmark } from "./db.ts";
import {
  buildInstallCollectorSnippet,
  CLICK_RETRY_SNIPPET,
  DRAIN_COLLECTOR_SNIPPET,
  getManualConsoleSnippet,
  SCROLL_NEXT_SNIPPET,
  type CaptureStopReason,
  type CollectorDrainResult,
} from "./dom-collector.ts";

export { getManualConsoleSnippet, type CaptureStopReason };

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
      tab = await findBookmarksTab(token);
      raw = await evalInSafariTab(tab, DRAIN_COLLECTOR_SNIPPET);
    }

    const state = parseJsonGuard<CollectorDrainResult & { missingCollector?: boolean }>(raw, "DOM drain");
    if (state.missingCollector) {
      await evalInSafariTab(tab, buildInstallCollectorSnippet(token));
      continue;
    }

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
