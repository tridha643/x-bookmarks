import type { CapturedBookmark } from "./db.ts";

export interface SafariCaptureOptions {
  knownIds: Set<string>;
  full?: boolean;
  maxItems?: number;
  stopAfterKnown?: number;
  scrollDelayMs?: number;
  maxIdleScrolls?: number;
  onProgress?: (stats: { seen: number; added: number; scrollStep: number }) => void;
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

/**
 * Pure DOM extractor that reads visible <article data-testid="tweet"> nodes
 * on x.com/i/bookmarks and extracts canonical tweet URLs + fallback text.
 */
export const DOM_EXTRACT_SNIPPET = `(() => {
  const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  const items = [];
  for (const article of articles) {
    const timeEl = article.querySelector('time');
    const statusLink = timeEl ? timeEl.closest('a[href*="/status/"]') : article.querySelector('a[href*="/status/"]');
    if (!statusLink) continue;
    const href = statusLink.getAttribute('href') || '';
    const m = href.match(/^\\/([^/]+)\\/status\\/(\\d+)/);
    if (!m) continue;
    const author_handle = m[1];
    const id = m[2];
    const url = 'https://x.com/' + author_handle + '/status/' + id;
    const created_at = timeEl ? timeEl.getAttribute('datetime') : null;
    const nameEl = article.querySelector('[data-testid="User-Name"] span');
    const author_name = nameEl ? nameEl.textContent.trim() : null;
    const textEl = article.querySelector('[data-testid="tweetText"]');
    const dom_text = textEl ? textEl.innerText.trim() : null;
    items.push({ id, url, author_handle, author_name, created_at, dom_text });
  }
  return JSON.stringify({
    url: location.href,
    scrollY: window.scrollY,
    scrollHeight: document.documentElement.scrollHeight,
    items
  });
})()`;

const SCROLL_SNIPPET = `(() => {
  const before = window.scrollY;
  window.scrollBy(0, Math.max(window.innerHeight * 0.85, 700));
  return JSON.stringify({
    before,
    after: window.scrollY,
    scrollHeight: document.documentElement.scrollHeight
  });
})()`;

async function runAppleScript(script: string, args: string[] = []): Promise<string> {
  const proc = Bun.spawn(["osascript", "-e", script, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const msg = stderr.trim();
    if (msg.includes("-1743") || msg.toLowerCase().includes("not authorized")) {
      throw new Error(
        "macOS blocked Automation access to Safari (-1743). Allow your terminal/T3 app under System Settings -> Privacy & Security -> Automation -> Safari, then retry."
      );
    }
    if (msg.toLowerCase().includes("javascript") && msg.toLowerCase().includes("apple events")) {
      throw new Error(
        "Safari blocked JavaScript from Apple Events. Enable Safari -> Settings -> Advanced -> 'Show features for web developers', then Safari -> Settings -> Developer -> 'Allow JavaScript from Apple Events'."
      );
    }
    throw new Error(`Safari AppleScript failed (exit ${exitCode}): ${msg || "unknown error"}`);
  }

  return stdout.trim();
}

export async function findBookmarksTab(): Promise<SafariTabRef> {
  const script = `
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
      tell application "Safari"
        return do JavaScript jsCode in tab tIdx of window wIdx
      end tell
    end run
  `;
  return runAppleScript(script, [String(tab.windowIndex), String(tab.tabIndex), jsCode]);
}

export async function captureFromSafari(
  opts: SafariCaptureOptions
): Promise<{ captured: CapturedBookmark[]; stoppedReason: string }> {
  const tab = await findBookmarksTab();
  const stopAfterKnown = opts.stopAfterKnown ?? 15;
  const scrollDelayMs = opts.scrollDelayMs ?? 1200;
  const maxIdleScrolls = opts.maxIdleScrolls ?? 5;
  const maxItems = opts.maxItems ?? Infinity;

  const seenThisRun = new Map<string, CapturedBookmark>();
  let consecutiveKnown = 0;
  let idleScrolls = 0;
  let scrollStep = 0;
  let stoppedReason = "end-of-feed";

  while (true) {
    const raw = await evalInSafariTab(tab, DOM_EXTRACT_SNIPPET);
    const parsed = JSON.parse(raw) as {
      url: string;
      scrollY: number;
      scrollHeight: number;
      items: DomExtractedItem[];
    };

    let newInThisView = 0;
    for (const item of parsed.items) {
      if (seenThisRun.has(item.id)) continue;

      const record: CapturedBookmark = {
        id: item.id,
        url: item.url,
        author_handle: item.author_handle,
        author_name: item.author_name,
        created_at: item.created_at,
        dom_text: item.dom_text,
        capture_source: "safari-dom",
      };
      seenThisRun.set(item.id, record);
      newInThisView++;

      if (opts.knownIds.has(item.id)) {
        consecutiveKnown++;
      } else {
        consecutiveKnown = 0;
      }

      if (!opts.full && consecutiveKnown >= stopAfterKnown) {
        stoppedReason = `reached-${stopAfterKnown}-known-bookmarks`;
        return { captured: [...seenThisRun.values()], stoppedReason };
      }

      if (seenThisRun.size >= maxItems) {
        stoppedReason = `reached-max-${maxItems}`;
        return { captured: [...seenThisRun.values()], stoppedReason };
      }
    }

    opts.onProgress?.({
      seen: seenThisRun.size,
      added: [...seenThisRun.values()].filter((x) => !opts.knownIds.has(x.id)).length,
      scrollStep,
    });

    const scrollRaw = await evalInSafariTab(tab, SCROLL_SNIPPET);
    const scrollInfo = JSON.parse(scrollRaw) as {
      before: number;
      after: number;
      scrollHeight: number;
    };
    scrollStep++;

    if (newInThisView === 0 && scrollInfo.after === scrollInfo.before) {
      idleScrolls++;
      if (idleScrolls >= maxIdleScrolls) {
        stoppedReason = "end-of-feed";
        break;
      }
    } else {
      idleScrolls = 0;
    }

    await Bun.sleep(scrollDelayMs);
  }

  return { captured: [...seenThisRun.values()], stoppedReason };
}

/**
 * Self-contained browser console snippet for manual zero-permission capture.
 */
export function getManualConsoleSnippet(): string {
  return `// Paste into Safari DevTools Console on https://x.com/i/bookmarks
(async () => {
  const seen = new Map();
  let idle = 0;
  while (idle < 5) {
    let added = 0;
    for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
      const t = a.querySelector('time');
      const link = t ? t.closest('a[href*="/status/"]') : a.querySelector('a[href*="/status/"]');
      const m = link?.getAttribute('href')?.match(/^\\/([^/]+)\\/status\\/(\\d+)/);
      if (!m || seen.has(m[2])) continue;
      seen.set(m[2], {
        id: m[2],
        url: 'https://x.com/' + m[1] + '/status/' + m[2],
        author_handle: m[1],
        author_name: a.querySelector('[data-testid="User-Name"] span')?.textContent?.trim() || null,
        created_at: t?.getAttribute('datetime') || null,
        dom_text: a.querySelector('[data-testid="tweetText"]')?.innerText?.trim() || null
      });
      added++;
    }
    const before = window.scrollY;
    window.scrollBy(0, Math.max(window.innerHeight * 0.85, 700));
    await new Promise(r => setTimeout(r, 1200));
    idle = (added === 0 && window.scrollY === before) ? idle + 1 : 0;
    console.log('Captured', seen.size, 'bookmarks...');
  }
  const blob = new Blob([JSON.stringify([...seen.values()], null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'x-bookmarks-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  console.log('Done! Saved', seen.size, 'bookmarks.');
})();`;
}
