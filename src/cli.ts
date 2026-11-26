import { readFileSync } from "node:fs";
import {
  addTag,
  getBookmarkById,
  getKnownIds,
  getPendingHydration,
  getStats,
  listRecentBookmarks,
  openDb,
  rebuildFts,
  removeTag,
  saveHydrated,
  searchBookmarks,
  upsertCapturedBatch,
  type BookmarkRow,
  type CapturedBookmark,
} from "./db.ts";
import { fetchFromFxTwitter, parseFxPayload } from "./fxtwitter.ts";
import { captureFromSafari, getManualConsoleSnippet } from "./safari.ts";

function parseArgs(argv: string[]) {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

function parseTweetRef(input: string): { id: string; url: string; handle: string | null } | null {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/(?:x\.com|twitter\.com)\/([^/]+)\/status\/(\d+)/i);
  if (urlMatch) {
    return {
      handle: urlMatch[1],
      id: urlMatch[2],
      url: `https://x.com/${urlMatch[1]}/status/${urlMatch[2]}`,
    };
  }
  if (/^\d{5,}$/.test(trimmed)) {
    return {
      handle: null,
      id: trimmed,
      url: `https://x.com/i/status/${trimmed}`,
    };
  }
  return null;
}

function printRows(rows: BookmarkRow[], asJson = false) {
  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log("No matching bookmarks.");
    return;
  }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const titlePrefix = r.article_title ? `[Article] ${r.article_title} — ` : "";
    const body = titlePrefix + (r.text || r.article_text || r.dom_text || "(no text)");
    const snippet = body.replace(/\s+/g, " ").slice(0, 180);
    const date = r.created_timestamp
      ? new Date(r.created_timestamp * 1000).toISOString().slice(0, 10)
      : (r.created_at || "").slice(0, 10);
    console.log(`${i + 1}. @${r.author_handle || "unknown"} (${date || "n/a"}) — ${r.url}`);
    console.log(`   ${snippet}${body.length > 180 ? "..." : ""}`);
    if (r.domains) console.log(`   domains: ${r.domains}`);
  }
}

async function cmdCapture(flags: Map<string, string | boolean>) {
  if (flags.get("print-js")) {
    console.log(getManualConsoleSnippet());
    return;
  }

  const db = openDb();
  const knownIds = getKnownIds(db);
  const full = Boolean(flags.get("full"));
  const allowFolder = Boolean(flags.get("allow-folder"));
  const maxItems = flags.has("max") ? Number(flags.get("max")) : undefined;
  const stopAfterKnown = flags.has("stop-after") ? Number(flags.get("stop-after")) : 15;
  const scrollDelayMs = flags.has("delay-ms") ? Number(flags.get("delay-ms")) : 1200;

  console.log(
    `Attaching to Safari x.com/i/bookmarks tab (${full ? "full backfill" : `incremental, stop after ${stopAfterKnown} known`})...`
  );

  const { captured, stoppedReason, unparsedCount, folderId, folderName } = await captureFromSafari({
    knownIds,
    full,
    allowFolder,
    maxItems,
    stopAfterKnown,
    scrollDelayMs,
    onProgress: ({ seen, added, unparsed, scrollStep }) => {
      if (scrollStep % 3 === 0) {
        console.log(`  scroll #${scrollStep}: seen=${seen}, new=${added}, unparsed=${unparsed}`);
      }
    },
  });

  const inserted = upsertCapturedBatch(db, captured);
  const folderNote = folderId ? ` [folder: ${folderName || folderId}]` : "";
  console.log(
    `Capture finished (${stoppedReason})${folderNote}: scanned ${captured.length}, added ${inserted} new, unparsed ${unparsedCount}.`
  );

  if (["logged-out", "wrong-page", "hidden-tab", "rate-limited", "stalled"].includes(stoppedReason)) {
    console.warn(`Warning: capture stopped early due to '${stoppedReason}'. Saved all ${captured.length} items seen so far.`);
  }
}

async function cmdHydrate(flags: Map<string, string | boolean>) {
  const db = openDb();
  const limit = flags.has("limit") ? Number(flags.get("limit")) : 200;
  const delayMs = flags.has("delay-ms") ? Number(flags.get("delay-ms")) : 350;
  const retryErrors = Boolean(flags.get("retry-errors"));
  const fetchThreads = Boolean(flags.get("threads"));

  const pending = getPendingHydration(db, limit, retryErrors);
  if (pending.length === 0) {
    console.log("No pending bookmarks to hydrate.");
    return;
  }

  console.log(`Hydrating ${pending.length} bookmarks via api.fxtwitter.com/2/status (with fallbacks)...`);
  let ok = 0;
  let unavailable = 0;
  let errors = 0;
  let consecutiveRateErrors = 0;

  for (let i = 0; i < pending.length; i++) {
    const item = pending[i];
    const res = await fetchFromFxTwitter(item.id, { fetchThreadIfHint: fetchThreads });
    saveHydrated(db, item.id, res.status, res.fields, res.error ?? null, res.retryAfterSeconds ?? null);

    if (res.status === "ok") {
      ok++;
      consecutiveRateErrors = 0;
    } else if (res.status === "unavailable") {
      unavailable++;
      consecutiveRateErrors = 0;
    } else {
      errors++;
      if (res.rateLimited) {
        consecutiveRateErrors++;
        if (consecutiveRateErrors >= 5) {
          console.error("Circuit breaker tripped after 5 consecutive 429/5xx responses. Stopping cleanly.");
          break;
        }
      }
    }

    if ((i + 1) % 10 === 0 || i + 1 === pending.length) {
      console.log(`  [${i + 1}/${pending.length}] ok=${ok} unavailable=${unavailable} error=${errors}`);
    }

    if (i + 1 < pending.length && delayMs > 0) {
      await Bun.sleep(delayMs);
    }
  }
}

async function cmdAdd(positional: string[], flags: Map<string, string | boolean>) {
  if (positional.length === 0) {
    console.error("Usage: bun run add <tweet-url-or-id> [...] [--threads]");
    process.exit(1);
  }
  const db = openDb();
  const batch: CapturedBookmark[] = [];

  for (const raw of positional) {
    const ref = parseTweetRef(raw);
    if (!ref) {
      console.warn(`Skipping unrecognized tweet reference: ${raw}`);
      continue;
    }
    batch.push({
      id: ref.id,
      url: ref.url,
      author_handle: ref.handle,
      capture_source: "manual",
    });
  }

  upsertCapturedBatch(db, batch);
  const fetchThreads = Boolean(flags.get("threads"));

  for (const item of batch) {
    const res = await fetchFromFxTwitter(item.id, { fetchThreadIfHint: fetchThreads });
    saveHydrated(db, item.id, res.status, res.fields, res.error ?? null, res.retryAfterSeconds ?? null);
    const title = res.fields.article_title ? ` — [Article] ${res.fields.article_title}` : "";
    console.log(
      `${item.id}: ${res.status} (${res.fields.hydration_source || "none"})${res.fields.author_handle ? ` @${res.fields.author_handle}` : ""}${title}`
    );
  }
}

function cmdImport(positional: string[], flags: Map<string, string | boolean>) {
  const filePath = positional[0];
  if (!filePath) {
    console.error("Usage: bun run import <file.json|file.txt> [--folder <name>]");
    process.exit(1);
  }
  const db = openDb();
  const rawText = readFileSync(filePath, "utf8");
  const folderName = typeof flags.get("folder") === "string" ? String(flags.get("folder")) : null;
  const items: CapturedBookmark[] = [];

  try {
    const json = JSON.parse(rawText);
    const list = Array.isArray(json) ? json : Array.isArray(json.bookmarks) ? json.bookmarks : [];
    for (const entry of list) {
      const ref = parseTweetRef(String(entry?.url || entry?.tweet_url || entry?.id || entry?.rest_id || ""));
      if (!ref) continue;
      items.push({
        id: ref.id,
        url: ref.url,
        author_handle: entry?.author_handle || entry?.screen_name || entry?.author?.screen_name || ref.handle,
        author_name: entry?.author_name || entry?.name || entry?.author?.name || null,
        created_at: entry?.created_at || null,
        dom_text: entry?.dom_text || entry?.full_text || entry?.text || null,
        capture_source: "import-json",
        folder_id: entry?.folder_id || (folderName ? folderName.toLowerCase().replace(/\s+/g, "-") : null),
        folder_name: entry?.folder_name || folderName,
      });
    }
  } catch {
    for (const line of rawText.split(/\r?\n/)) {
      const ref = parseTweetRef(line);
      if (!ref) continue;
      items.push({
        id: ref.id,
        url: ref.url,
        author_handle: ref.handle,
        capture_source: "import-text",
        folder_id: folderName ? folderName.toLowerCase().replace(/\s+/g, "-") : null,
        folder_name: folderName,
      });
    }
  }

  const inserted = upsertCapturedBatch(db, items);
  console.log(`Imported ${items.length} records (${inserted} new). Run 'bun run hydrate' to enrich via FxTwitter.`);
}

function cmdSearch(positional: string[], flags: Map<string, string | boolean>) {
  const db = openDb();
  const query = positional.join(" ");
  const rows = searchBookmarks(db, {
    query,
    raw: Boolean(flags.get("raw")),
    author: typeof flags.get("author") === "string" ? String(flags.get("author")) : undefined,
    domain: typeof flags.get("domain") === "string" ? String(flags.get("domain")) : undefined,
    folder: typeof flags.get("folder") === "string" ? String(flags.get("folder")) : undefined,
    tag: typeof flags.get("tag") === "string" ? String(flags.get("tag")) : undefined,
    limit: flags.has("limit") ? Number(flags.get("limit")) : 20,
  });
  printRows(rows, Boolean(flags.get("json")));
}

function cmdList(flags: Map<string, string | boolean>) {
  const db = openDb();
  const limit = flags.has("limit") ? Number(flags.get("limit")) : 20;
  const by = flags.get("by") === "created" ? "created" : "bookmarked";
  const rows = listRecentBookmarks(db, limit, by);
  printRows(rows, Boolean(flags.get("json")));
}

function cmdTag(positional: string[]) {
  const [action, idOrRef, ...tagWords] = positional;
  const db = openDb();
  if (action === "add" && idOrRef && tagWords.length > 0) {
    const ref = parseTweetRef(idOrRef);
    const id = ref?.id || idOrRef;
    for (const t of tagWords) addTag(db, id, t);
    console.log(`Tagged ${id}: ${tagWords.join(", ")}`);
    return;
  }
  if ((action === "rm" || action === "remove") && idOrRef && tagWords.length > 0) {
    const ref = parseTweetRef(idOrRef);
    const id = ref?.id || idOrRef;
    for (const t of tagWords) removeTag(db, id, t);
    console.log(`Removed tags from ${id}: ${tagWords.join(", ")}`);
    return;
  }
  if (action === "show" && idOrRef) {
    const ref = parseTweetRef(idOrRef);
    const info = getBookmarkById(db, ref?.id || idOrRef);
    console.log(info.tags.length > 0 ? info.tags.join(", ") : "(no tags)");
    return;
  }
  console.error("Usage: bun run tag <add|rm|show> <tweet-id-or-url> [tags...]");
  process.exit(1);
}

function cmdStats() {
  const db = openDb();
  const stats = getStats(db);
  console.log(`Total bookmarks: ${stats.total} (articles: ${stats.articles}, threads: ${stats.threads})`);
  console.log("By status:");
  for (const s of stats.byStatus) console.log(`  ${s.hydration_status}: ${s.count}`);
  console.log("By source:");
  for (const s of stats.bySource) console.log(`  ${s.source}: ${s.count}`);
  if (stats.topAuthors.length > 0) {
    console.log("Top authors:");
    for (const a of stats.topAuthors) console.log(`  @${a.author_handle}: ${a.count}`);
  }
  if (stats.topDomains.length > 0) {
    console.log("Top domains:");
    for (const d of stats.topDomains) console.log(`  ${d.domain}: ${d.count}`);
  }
}

function cmdReindex() {
  const db = openDb();
  const rows = db
    .query("SELECT id, raw_fx_json FROM bookmarks WHERE raw_fx_json IS NOT NULL")
    .all() as { id: string; raw_fx_json: string }[];

  let count = 0;
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.raw_fx_json);
      if (payload?.status && payload.status.type !== "tombstone") {
        const fields = parseFxPayload(payload);
        saveHydrated(db, row.id, "ok", fields, null);
        count++;
      }
    } catch {
      // skip malformed or non-fx rows
    }
  }
  rebuildFts(db);
  console.log(`Re-parsed ${count} archived FxTwitter payloads and rebuilt FTS5 index locally.`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);

  switch (command) {
    case "sync":
      await cmdCapture(flags);
      await cmdHydrate(flags);
      break;
    case "capture":
      await cmdCapture(flags);
      break;
    case "hydrate":
      await cmdHydrate(flags);
      break;
    case "add":
      await cmdAdd(positional, flags);
      break;
    case "import":
      cmdImport(positional, flags);
      break;
    case "search":
      cmdSearch(positional, flags);
      break;
    case "list":
      cmdList(flags);
      break;
    case "tag":
      cmdTag(positional);
      break;
    case "stats":
      cmdStats();
      break;
    case "reindex":
      cmdReindex();
      break;
    default:
      console.log(`x-bookmarks — local X bookmark indexer (DOM capture + FxTwitter v2 + SQLite FTS5)

Commands:
  bun run sync [--full] [--max N] [--threads]    Capture from Safari tab, then hydrate via FxTwitter
  bun run capture [--full] [--allow-folder] [--print-js]
  bun run hydrate [--limit N] [--retry-errors] [--threads]
  bun run add <url-or-id...> [--threads]         Add and hydrate specific tweet URLs or IDs
  bun run import <file.json|txt> [--folder name] Import exported JSON or URL list
  bun run search <query> [--raw] [--author u] [--domain d] [--folder f] [--tag t] [--limit N] [--json]
  bun run list [--by bookmarked|created] [--limit N] [--json]
  bun run tag <add|rm|show> <id-or-url> [tags...]
  bun run stats                                  Show index counts, top authors & domains
  bun run reindex                                Re-parse archived FxTwitter JSON & rebuild FTS5
  bun run mcp                                    Start read-only local MCP server on stdio`);
      break;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
