import { afterEach, describe, expect, it } from "vitest";
import { clickRetryInPage, drainCollectorInPage, installCollectorInPage, scrollNextInPage } from "./dom-collector.ts";

class FakeHtmlElement {
  clicked = 0;
  scrolledIntoView: Array<unknown> = [];
  readonly attrs: Map<string, string>;
  textContent: string | null;
  readonly children: Map<string, FakeHtmlElement[]> = new Map();
  closestMap: Map<string, FakeHtmlElement | null> = new Map();

  constructor(textContent: string | null = null, attrs: Record<string, string> = {}) {
    this.textContent = textContent;
    this.attrs = new Map(Object.entries(attrs));
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  querySelector(sel: string): FakeHtmlElement | null {
    return this.children.get(sel)?.[0] ?? null;
  }

  querySelectorAll(sel: string): FakeHtmlElement[] {
    return this.children.get(sel) ?? [];
  }

  closest(sel: string): FakeHtmlElement | null {
    return this.closestMap.get(sel) ?? null;
  }

  scrollIntoView(opts?: unknown): void {
    this.scrolledIntoView.push(opts);
  }

  click(): void {
    this.clicked++;
  }
}

const makeArticleEl = (opts: {
  href?: string;
  datetime?: string;
  userName?: string | null;
  tweetTexts?: Array<{ text: string; insideQuote?: boolean }>;
  noTime?: boolean;
}): FakeHtmlElement => {
  const art = new FakeHtmlElement();
  if (!opts.noTime) {
    const timeEl = new FakeHtmlElement(null, opts.datetime !== undefined ? { datetime: opts.datetime } : {});
    const linkEl = opts.href !== undefined ? new FakeHtmlElement(null, { href: opts.href }) : null;
    timeEl.closestMap.set('a[href*="/status/"]', linkEl);
    art.children.set("time", [timeEl]);
  }
  if (opts.userName !== undefined) {
    art.children.set('[data-testid="User-Name"] span', [new FakeHtmlElement(opts.userName)]);
  }
  if (opts.tweetTexts !== undefined) {
    art.children.set(
      '[data-testid="tweetText"]',
      opts.tweetTexts.map((t) => {
        const el = new FakeHtmlElement(t.text);
        el.closestMap.set('div[role="link"]', t.insideQuote ? new FakeHtmlElement() : null);
        return el;
      }),
    );
  }
  return art;
};

describe("adapters/browser/dom-collector", () => {
  const originals = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    MutationObserver: globalThis.MutationObserver,
    HTMLElement: globalThis.HTMLElement,
  };

  const setGlobals = (entries: Record<string, unknown>): void => {
    const g = globalThis as Record<string, unknown>;
    for (const [k, v] of Object.entries(entries)) g[k] = v;
  };

  afterEach(() => {
    setGlobals(originals);
  });

  const buildDocMap = (opts: {
    articles?: FakeHtmlElement[];
    folderHeading?: string;
    hasSpinner?: boolean;
    hasEmptyState?: boolean;
    mainText?: string;
    buttons?: FakeHtmlElement[];
    cells?: FakeHtmlElement[];
  }): Map<string, FakeHtmlElement[]> => {
    const docMap = new Map<string, FakeHtmlElement[]>([
      ['article[data-testid="tweet"]', opts.articles ?? []],
      ['main button, main [role="button"]', opts.buttons ?? []],
      ['main [data-testid="cellInnerDiv"]', opts.cells ?? []],
    ]);
    if (opts.folderHeading !== undefined)
      docMap.set('main h2[role="heading"]', [new FakeHtmlElement(opts.folderHeading)]);
    if (opts.hasSpinner) docMap.set('main [role="progressbar"]', [new FakeHtmlElement()]);
    if (opts.hasEmptyState) docMap.set('[data-testid="emptyState"]', [new FakeHtmlElement()]);
    if (opts.mainText !== undefined) docMap.set("main", [new FakeHtmlElement(opts.mainText)]);
    return docMap;
  };

  const wireCellScroll = (cells: FakeHtmlElement[] | undefined, onAdvance: () => void): void => {
    const last = cells?.[cells.length - 1];
    if (last === undefined) return;
    const origScroll = last.scrollIntoView.bind(last);
    last.scrollIntoView = (arg?: unknown) => {
      origScroll(arg);
      onAdvance();
    };
  };

  const installFakeDom = (opts: {
    pathname: string;
    articles?: FakeHtmlElement[];
    folderHeading?: string;
    hasSpinner?: boolean;
    hasEmptyState?: boolean;
    mainText?: string;
    buttons?: FakeHtmlElement[];
    cells?: FakeHtmlElement[];
    scrollY?: number;
    innerHeight?: number;
    scrollHeight?: number;
    scrollAdvancesOnCell?: boolean;
  }) => {
    const state = {
      scrollY: opts.scrollY ?? 0,
      scrollByCalls: [] as Array<[number, number]>,
      observerCallbacks: [] as Array<() => void>,
      disconnected: 0,
      observedTarget: null as unknown,
      observedOptions: null as unknown,
    };
    const fakeWindow: Record<string, unknown> = {
      get scrollY() {
        return state.scrollY;
      },
      innerHeight: opts.innerHeight ?? 900,
      scrollBy: (x: number, y: number) => {
        state.scrollByCalls.push([x, y]);
        state.scrollY += y;
      },
    };
    const body = new FakeHtmlElement();
    const docMap = buildDocMap(opts);
    if (opts.scrollAdvancesOnCell) wireCellScroll(opts.cells, () => (state.scrollY += 500));

    class FakeObserver {
      constructor(cb: () => void) {
        state.observerCallbacks.push(cb);
      }
      observe(target: unknown, options: unknown): void {
        state.observedTarget = target;
        state.observedOptions = options;
      }
      disconnect(): void {
        state.disconnected++;
      }
    }

    setGlobals({
      window: fakeWindow,
      location: { pathname: opts.pathname },
      document: {
        body,
        documentElement: { scrollHeight: opts.scrollHeight ?? 2000 },
        querySelector: (sel: string) => docMap.get(sel)?.[0] ?? null,
        querySelectorAll: (sel: string) => docMap.get(sel) ?? [],
      },
      MutationObserver: FakeObserver,
      HTMLElement: FakeHtmlElement,
    });

    return { state, fakeWindow, docMap };
  };

  it("reports missingCollector before install, installs observer, extracts outer tweet text, and drains folder state", () => {
    const art1 = makeArticleEl({
      href: "/alice/status/1001",
      datetime: "2026-01-15T10:00:00.000Z",
      userName: "  Alice  ",
      tweetTexts: [
        { text: "Quoted text to skip", insideQuote: true },
        { text: "  Outer tweet body  ", insideQuote: false },
      ],
    });
    const artDup = makeArticleEl({ href: "/alice/status/1001", datetime: "2026-01-15T10:00:00.000Z" });
    const artNoTime = makeArticleEl({ noTime: true });
    const artBadHref = makeArticleEl({ href: "/not-a-status" });
    const artMinimal = makeArticleEl({ href: "/bob/status/1002/", tweetTexts: [{ text: "   " }] });

    const { state, fakeWindow, docMap } = installFakeDom({
      pathname: "/i/bookmarks/42",
      articles: [art1, artDup, artNoTime, artBadHref, artMinimal],
      folderHeading: "  AI Reading  ",
      hasSpinner: true,
      hasEmptyState: false,
      mainText: "Something went wrong. Try reloading.",
    });

    // Before install -> missingCollector: true
    expect(drainCollectorInPage()).toEqual({
      pathname: "/i/bookmarks/42",
      folderId: null,
      folderName: null,
      hasSpinner: false,
      hasRetry: false,
      hasEmptyState: false,
      items: [],
      missingCollector: true,
    });

    expect(installCollectorInPage("tok-1")).toBe(true);
    expect(fakeWindow.__xbmToken).toBe("tok-1");
    expect(state.observedOptions).toEqual({ childList: true, subtree: true });

    // Re-installing disconnects prior observer
    expect(installCollectorInPage("tok-2")).toBe(true);
    expect(state.disconnected).toBe(1);

    // Triggering observer picks up dynamically appended article
    const art3 = makeArticleEl({ href: "/carol/status/1003", tweetTexts: [{ text: "Late tweet" }] });
    docMap.set('article[data-testid="tweet"]', [art1, art3]);
    state.observerCallbacks[state.observerCallbacks.length - 1]?.();

    const drained = drainCollectorInPage();
    expect(drained.missingCollector).toBe(false);
    expect(drained.folderId).toBe("42");
    expect(drained.folderName).toBe("AI Reading");
    expect(drained.hasSpinner).toBe(true);
    expect(drained.hasRetry).toBe(true);
    expect(drained.hasEmptyState).toBe(false);
    expect(drained.items).toEqual([
      {
        id: "1001",
        url: "https://x.com/alice/status/1001",
        authorHandle: "alice",
        authorName: "Alice",
        createdAt: "2026-01-15T10:00:00.000Z",
        domText: "Outer tweet body",
      },
      {
        id: "1002",
        url: "https://x.com/bob/status/1002",
        authorHandle: "bob",
        authorName: null,
        createdAt: null,
        domText: null,
      },
      {
        id: "1003",
        url: "https://x.com/carol/status/1003",
        authorHandle: "carol",
        authorName: null,
        createdAt: null,
        domText: "Late tweet",
      },
    ]);
  });

  it("scrolls via cellIntoView or fallback scrollBy, detects empty state, and clicks Retry button", () => {
    const retryBtn = new FakeHtmlElement("  Retry ");
    const otherBtn = new FakeHtmlElement("Cancel");
    const cell1 = new FakeHtmlElement();
    const cell2 = new FakeHtmlElement();

    const { state } = installFakeDom({
      pathname: "/i/bookmarks",
      buttons: [otherBtn, retryBtn],
      cells: [cell1, cell2],
      hasEmptyState: true,
      innerHeight: 1000,
      scrollHeight: 4000,
      scrollAdvancesOnCell: false,
    });

    installCollectorInPage("tok");
    const drained = drainCollectorInPage();
    expect(drained.folderId).toBeNull();
    expect(drained.folderName).toBeNull();
    expect(drained.hasRetry).toBe(true);
    expect(drained.hasEmptyState).toBe(true);

    // When cell.scrollIntoView does not move scrollY, falls back to scrollBy(0, max(innerHeight*0.85, 700))
    const info1 = scrollNextInPage();
    expect(cell2.scrolledIntoView).toEqual([{ behavior: "instant", block: "end" }]);
    expect(state.scrollByCalls).toEqual([[0, 850]]);
    expect(info1).toEqual({ before: 0, after: 850, scrollHeight: 4000 });

    expect(clickRetryInPage()).toBe(true);
    expect(retryBtn.clicked).toBe(1);
    expect(otherBtn.clicked).toBe(0);

    // When scrollIntoView advances scrollY, scrollBy is NOT called; missing retry button returns false
    const cell3 = new FakeHtmlElement();
    const s2 = installFakeDom({
      pathname: "/i/bookmarks",
      cells: [cell3],
      buttons: [new FakeHtmlElement("Not retry")],
      innerHeight: 400,
      scrollHeight: 3000,
      scrollAdvancesOnCell: true,
    });
    const info2 = scrollNextInPage();
    expect(info2).toEqual({ before: 0, after: 500, scrollHeight: 3000 });
    expect(s2.state.scrollByCalls).toEqual([]);
    expect(clickRetryInPage()).toBe(false);

    // Small viewport (400 * 0.85 = 340 < 700) falls back to 700px scroll step
    const s3 = installFakeDom({ pathname: "/i/bookmarks", cells: [], innerHeight: 400, scrollHeight: 1000 });
    scrollNextInPage();
    expect(s3.state.scrollByCalls).toEqual([[0, 700]]);

    // Negative checks: no spinner, no empty state, non-exact retry button text, prefix path, drain scan without observer
    const s4 = installFakeDom({
      pathname: "/prefix/i/bookmarks/99",
      articles: [makeArticleEl({ href: "/prefix/alice/status/555" })],
      buttons: [new FakeHtmlElement("Retry Now"), new FakeHtmlElement("Click Retry")],
      hasSpinner: false,
      hasEmptyState: false,
    });
    installCollectorInPage("tok4");
    const late = makeArticleEl({ href: "/dave/status/2004", tweetTexts: [{ text: "Scanned on drain" }] });
    s4.docMap.set('article[data-testid="tweet"]', [late]);
    const d4 = drainCollectorInPage();
    expect(d4.folderId).toBeNull();
    expect(d4.folderName).toBeNull();
    expect(d4.hasSpinner).toBe(false);
    expect(d4.hasRetry).toBe(false);
    expect(d4.hasEmptyState).toBe(false);
    expect(d4.items.map((i) => i.id)).toEqual(["2004"]);
    expect(clickRetryInPage()).toBe(false);
  });
});
