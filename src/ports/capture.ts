import { Context, Data, type Effect } from "effect";
import type { CapturedBookmark } from "../domain/bookmark.ts";

export class CaptureError extends Data.TaggedError("CaptureError")<{
  readonly reason: "logged-out" | "locked" | "missing-profile" | "browser";
  readonly detail: string;
}> {
  override get message(): string {
    return `capture ${this.reason}: ${this.detail}`;
  }
}

export interface CaptureOptions {
  readonly knownIds: ReadonlySet<string>;
  readonly full: boolean;
  readonly maxItems: number | undefined;
}

export interface CaptureResult {
  readonly captured: ReadonlyArray<CapturedBookmark>;
  readonly stoppedReason: string;
}

export interface CaptureSourceShape {
  readonly capture: (opts: CaptureOptions) => Effect.Effect<CaptureResult, CaptureError>;
}

export class CaptureSource extends Context.Service<CaptureSource, CaptureSourceShape>()(
  "x-bookmarks/ports/capture/CaptureSource",
) {}
