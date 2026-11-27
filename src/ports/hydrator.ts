import { Context, type Effect } from "effect";
import type { BookmarkId, HydratedFields } from "../domain/bookmark.ts";

export interface HydrateResult {
  readonly status: "ok" | "unavailable" | "error";
  readonly fields: HydratedFields;
  readonly error: string | null;
  readonly rateLimited: boolean;
  readonly retryAfterSeconds: number | null;
}

export interface HydratorShape {
  readonly hydrate: (id: BookmarkId, opts: { readonly fetchThreadIfHint: boolean }) => Effect.Effect<HydrateResult>;
}

export class Hydrator extends Context.Service<Hydrator, HydratorShape>()("x-bookmarks/ports/hydrator") {}
