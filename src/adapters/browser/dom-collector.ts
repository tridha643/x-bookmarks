export type CaptureStopReason =
  | "end-of-feed"
  | "reached-known-bookmarks"
  | "reached-max"
  | "stalled"
  | "rate-limited"
  | "logged-out"
  | "wrong-page";

export interface DomExtractedItem {
  readonly id: string;
  readonly url: string;
  readonly authorHandle: string | null;
  readonly authorName: string | null;
  readonly createdAt: string | null;
  readonly domText: string | null;
}

export interface CollectorDrainResult {
  readonly pathname: string;
  readonly folderId: string | null;
  readonly folderName: string | null;
  readonly hasSpinner: boolean;
  readonly hasRetry: boolean;
  readonly hasEmptyState: boolean;
  readonly items: ReadonlyArray<DomExtractedItem>;
  readonly missingCollector: boolean;
}

export interface ScrollInfo {
  readonly before: number;
  readonly after: number;
  readonly scrollHeight: number;
}

interface CollectorState {
  readonly items: Map<string, DomExtractedItem>;
  readonly scan: () => void;
  observer: MutationObserver | null;
}

declare global {
  interface Window {
    __xbmToken?: string;
    __xbm?: CollectorState;
  }
}

export const installCollectorInPage = (token: string): boolean => {
  window.__xbmToken = token;

  const extractOuterText = (article: Element): string | null => {
    for (const node of article.querySelectorAll('[data-testid="tweetText"]')) {
      if (node.closest('div[role="link"]') === null) {
        return node.textContent?.trim() || null;
      }
    }
    return null;
  };

  const extractArticle = (article: Element): DomExtractedItem | null => {
    const timeEl = article.querySelector("time");
    const statusLink = timeEl?.closest('a[href*="/status/"]');
    const m = /^\/([^/]+)\/status\/(\d+)(?:\/?$)/.exec(statusLink?.getAttribute("href") ?? "");
    if (timeEl === null || m?.[1] === undefined || m[2] === undefined) return null;
    const authorHandle = m[1];
    const id = m[2];
    const nameEl = article.querySelector('[data-testid="User-Name"] span');
    return {
      id,
      url: `https://x.com/${authorHandle}/status/${id}`,
      authorHandle,
      authorName: nameEl?.textContent?.trim() || null,
      createdAt: timeEl.getAttribute("datetime") || null,
      domText: extractOuterText(article),
    };
  };

  window.__xbm?.observer?.disconnect();
  const state: CollectorState = {
    items: new Map<string, DomExtractedItem>(),
    scan() {
      for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
        const parsed = extractArticle(a);
        if (parsed !== null && !state.items.has(parsed.id)) state.items.set(parsed.id, parsed);
      }
    },
    observer: null,
  };
  state.scan();
  state.observer = new MutationObserver(() => state.scan());
  state.observer.observe(document.body, { childList: true, subtree: true });
  window.__xbm = state;
  return true;
};

export const drainCollectorInPage = (): CollectorDrainResult => {
  const pathname = location.pathname || "";
  if (window.__xbm === undefined) {
    return {
      pathname,
      folderId: null,
      folderName: null,
      hasSpinner: false,
      hasRetry: false,
      hasEmptyState: false,
      items: [],
      missingCollector: true,
    };
  }
  window.__xbm.scan();
  const folderId = /^\/i\/bookmarks\/(\d+)/.exec(pathname)?.[1] ?? null;
  const folderName =
    folderId === null ? null : (document.querySelector('main h2[role="heading"]')?.textContent?.trim() ?? null);
  const retryBtn = Array.from(document.querySelectorAll('main button, main [role="button"]')).find((el) =>
    /^retry$/i.test((el.textContent ?? "").trim()),
  );
  const bodyText = document.querySelector("main")?.textContent ?? "";
  return {
    pathname,
    folderId,
    folderName,
    hasSpinner: document.querySelector('main [role="progressbar"]') !== null,
    hasRetry: retryBtn !== undefined || /something went wrong/i.test(bodyText),
    hasEmptyState: document.querySelector('[data-testid="emptyState"]') !== null,
    items: Array.from(window.__xbm.items.values()),
    missingCollector: false,
  };
};

export const scrollNextInPage = (): ScrollInfo => {
  const before = window.scrollY;
  const cells = document.querySelectorAll('main [data-testid="cellInnerDiv"]');
  const lastCell = cells.length > 0 ? cells[cells.length - 1] : undefined;
  lastCell?.scrollIntoView({ behavior: "instant", block: "end" });
  if (window.scrollY === before) window.scrollBy(0, Math.max(window.innerHeight * 0.85, 700));
  return { before, after: window.scrollY, scrollHeight: document.documentElement.scrollHeight };
};

export const clickRetryInPage = (): boolean => {
  const btn = Array.from(document.querySelectorAll('main button, main [role="button"]')).find((el) =>
    /^retry$/i.test((el.textContent ?? "").trim()),
  );
  if (btn instanceof HTMLElement) {
    btn.click();
    return true;
  }
  return false;
};
