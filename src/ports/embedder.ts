import { Context, Data, type Effect } from "effect";

export class EmbedderError extends Data.TaggedError("EmbedderError")<{
  readonly reason: "network" | "http" | "decode" | "dimensions";
  readonly detail: string;
}> {
  override get message(): string {
    return `embedder ${this.reason}: ${this.detail}`;
  }
}

export interface EmbedderShape {
  readonly model: string;
  readonly dimensions: number;
  readonly embedDocument: (text: string) => Effect.Effect<ReadonlyArray<number>, EmbedderError>;
  readonly embedQuery: (query: string) => Effect.Effect<ReadonlyArray<number>, EmbedderError>;
}

export class Embedder extends Context.Service<Embedder, EmbedderShape>()("x-bookmarks/ports/embedder") {}
