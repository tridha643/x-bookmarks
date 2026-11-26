export type CaptureStopReason =
  | "end-of-feed"
  | "reached-known-bookmarks"
  | "reached-max"
  | "stalled"
  | "rate-limited"
  | "logged-out"
  | "wrong-page"
  | "hidden-tab";

export interface DomExtractedItem {
  id: string;
  url: string;
  author_handle: string | null;
  author_name: string | null;
  created_at: string | null;
  dom_text: string | null;
}

export interface CollectorDrainResult {
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
  missingCollector?: boolean;
}

/**
 * Direct page-context functions for Playwright `page.evaluate(...)`.
 * Passed as real functions so they execute via CDP without `eval()` and never trip X's CSP.
 */
export function installCollectorInPage(token: string): { ok: boolean; initialCount: number } {
  const win = window as any;
  win.__xbmToken = token;

  function extractArticle(article: Element): DomExtractedItem | null {
    const timeEl = article.querySelector("time");
    if (!timeEl) return null;
    const statusLink = timeEl.closest('a[href*="/status/"]');
    if (!statusLink) return null;
    const href = statusLink.getAttribute("href") || "";
    const m = href.match(/^\/([^/]+)\/status\/(\d+)(?:\/?$)/);
    if (!m) return null;

    const author_handle = m[1];
    const id = m[2];
    const url = "https://x.com/" + author_handle + "/status/" + id;
    const created_at = timeEl.getAttribute("datetime") || null;
    const nameEl = article.querySelector('[data-testid="User-Name"] span');
    const author_name = nameEl?.textContent?.trim() || null;

    let dom_text: string | null = null;
    const textNodes = article.querySelectorAll('[data-testid="tweetText"]');
    for (const node of textNodes) {
      if (!node.closest('div[role="link"]')) {
        dom_text = (node as HTMLElement).innerText.trim() || null;
        break;
      }
    }
    return { id, url, author_handle, author_name, created_at, dom_text };
  }

  if (win.__xbm?.observer) {
    try {
      win.__xbm.observer.disconnect();
    } catch {}
  }

  const state = {
    items: new Map<string, DomExtractedItem>(),
    unparsed: new WeakSet<Element>(),
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
    observer: null as MutationObserver | null,
  };

  state.scan();
  state.observer = new MutationObserver(() => state.scan());
  state.observer.observe(document.body, { childList: true, subtree: true });
  win.__xbm = state;
  return { ok: true, initialCount: state.items.size };
}

export function drainCollectorInPage(): CollectorDrainResult {
  const win = window as any;
  if (!win.__xbm) {
    return {
      href: location.href,
      pathname: location.pathname || "",
      visibilityState: document.visibilityState,
      folderId: null,
      folderName: null,
      articleCount: 0,
      hasSpinner: false,
      hasRetry: false,
      hasEmptyState: false,
      scrollY: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
      unparsedCount: 0,
      items: [],
      missingCollector: true,
    };
  }

  win.__xbm.scan();
  const pathname = location.pathname || "";
  const folderMatch = pathname.match(/^\/i\/bookmarks\/(\d+)/);
  const folderId = folderMatch ? folderMatch[1] : null;
  let folderName: string | null = null;
  if (folderId) {
    const h2 = document.querySelector('main h2[role="heading"]');
    folderName = h2?.textContent?.trim() || null;
  }

  const hasSpinner = Boolean(document.querySelector('main [role="progressbar"]'));
  const retryBtn = Array.from(document.querySelectorAll('main button, main [role="button"]')).find((el) =>
    /^retry$/i.test((el.textContent || "").trim())
  );
  const bodyText = (document.querySelector("main") as HTMLElement | null)?.innerText || "";
  const hasRetry = Boolean(retryBtn) || /something went wrong/i.test(bodyText);
  const hasEmptyState = Boolean(document.querySelector('[data-testid="emptyState"]'));

  return {
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
    unparsedCount: win.__xbm.unparsedCount,
    items: Array.from(win.__xbm.items.values()),
  };
}

export function scrollNextInPage(): { before: number; after: number; scrollHeight: number } {
  const before = window.scrollY;
  const cells = document.querySelectorAll('main [data-testid="cellInnerDiv"]');
  const lastCell = cells.length > 0 ? cells[cells.length - 1] : null;
  if (lastCell) {
    lastCell.scrollIntoView({ behavior: "instant", block: "end" });
  }
  if (window.scrollY === before) {
    window.scrollBy(0, Math.max(window.innerHeight * 0.85, 700));
  }
  return {
    before,
    after: window.scrollY,
    scrollHeight: document.documentElement.scrollHeight,
  };
}

export function clickRetryInPage(): string {
  const btn = Array.from(document.querySelectorAll('main button, main [role="button"]')).find((el) =>
    /^retry$/i.test((el.textContent || "").trim())
  ) as HTMLElement | undefined;
  if (btn) {
    btn.click();
    return "clicked";
  }
  return "none";
}

// String wrappers for Safari AppleScript `do JavaScript` (which bypasses page CSP natively)
export function buildInstallCollectorSnippet(token: string): string {
  return `JSON.stringify((${installCollectorInPage.toString()})(${JSON.stringify(token)}))`;
}

export const DRAIN_COLLECTOR_SNIPPET = `JSON.stringify((${drainCollectorInPage.toString()})())`;
export const SCROLL_NEXT_SNIPPET = `JSON.stringify((${scrollNextInPage.toString()})())`;
export const CLICK_RETRY_SNIPPET = `(${clickRetryInPage.toString()})()`;

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
