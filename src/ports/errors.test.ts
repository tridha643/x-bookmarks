import { describe, expect, it } from "vitest";
import { CaptureError } from "./capture.ts";
import { EmbedderError } from "./embedder.ts";
import { SearchIndexError } from "./search-index.ts";
import { StoreError } from "./store.ts";

describe("ports/errors", () => {
  it("formats human-readable messages and tags for all port errors", () => {
    const cap = new CaptureError({ reason: "locked", detail: "pid 42" });
    expect(cap._tag).toBe("CaptureError");
    expect(cap.message).toBe("capture locked: pid 42");

    const emb = new EmbedderError({ reason: "http", detail: "HTTP 503" });
    expect(emb._tag).toBe("EmbedderError");
    expect(emb.message).toBe("embedder http: HTTP 503");

    const idx = new SearchIndexError({ operation: "search", cause: new Error("boom") });
    expect(idx._tag).toBe("SearchIndexError");
    expect(idx.message).toBe("search index search failed");

    const st = new StoreError({ operation: "list", cause: new Error("sql") });
    expect(st._tag).toBe("StoreError");
    expect(st.message).toBe("store list failed");
  });
});
