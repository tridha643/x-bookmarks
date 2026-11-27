import { Effect, Layer, Option, Schema } from "effect";
import { Embedder, EmbedderError, type EmbedderShape } from "../../ports/embedder.ts";

const OllamaEmbedResponseSchema = Schema.Struct({
  embeddings: Schema.Array(Schema.Array(Schema.Number)),
});

const OpenAiEmbedResponseSchema = Schema.Struct({
  data: Schema.Array(Schema.Struct({ embedding: Schema.Array(Schema.Number) })),
});

const formatNomicInput = (model: string, kind: "document" | "query", text: string): string => {
  if (!model.toLowerCase().includes("nomic-embed")) return text;
  return kind === "document" ? `search_document: ${text}` : `search_query: ${text}`;
};

const validateVector = (
  vector: ReadonlyArray<number>,
  expectedDims: number,
): Effect.Effect<ReadonlyArray<number>, EmbedderError> =>
  vector.length === expectedDims
    ? Effect.succeed(vector)
    : Effect.fail(
        new EmbedderError({ reason: "dimensions", detail: `expected ${expectedDims} dims, got ${vector.length}` }),
      );

interface HttpEmbedConfig {
  readonly model: string;
  readonly dimensions: number;
  readonly endpoint: string;
  readonly headers: Record<string, string>;
  readonly buildBody: (kind: "document" | "query", text: string) => string;
  readonly extractVector: (raw: unknown) => ReadonlyArray<number> | null;
  readonly fetchFn: typeof fetch;
}

const makeHttpEmbedder = (cfg: HttpEmbedConfig): EmbedderShape => {
  const runEmbed = (kind: "document" | "query", text: string): Effect.Effect<ReadonlyArray<number>, EmbedderError> =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () => cfg.fetchFn(cfg.endpoint, { method: "POST", headers: cfg.headers, body: cfg.buildBody(kind, text) }),
        catch: (err) => new EmbedderError({ reason: "network", detail: String(err) }),
      });
      if (!response.ok) return yield* new EmbedderError({ reason: "http", detail: `HTTP ${response.status}` });
      const vector = yield* Effect.tryPromise({
        try: async (): Promise<ReadonlyArray<number> | null> => cfg.extractVector(await response.json()),
        catch: (err) => new EmbedderError({ reason: "decode", detail: String(err) }),
      });
      if (vector === null)
        return yield* new EmbedderError({ reason: "decode", detail: "missing embedding vector in response" });
      return yield* validateVector(vector, cfg.dimensions);
    });

  return {
    model: cfg.model,
    dimensions: cfg.dimensions,
    embedDocument: (text) => runEmbed("document", text),
    embedQuery: (query) => runEmbed("query", query),
  };
};

export const makeOllamaEmbedder = (opts: {
  readonly baseUrl: string;
  readonly model: string;
  readonly dimensions: number;
  readonly fetchFn?: typeof fetch;
}): EmbedderShape =>
  makeHttpEmbedder({
    model: opts.model,
    dimensions: opts.dimensions,
    endpoint: `${opts.baseUrl.replace(/\/+$/, "")}/api/embed`,
    headers: { "Content-Type": "application/json" },
    buildBody: (kind, text) => JSON.stringify({ model: opts.model, input: formatNomicInput(opts.model, kind, text) }),
    extractVector: (raw) => {
      const dec = Schema.decodeUnknownOption(OllamaEmbedResponseSchema)(raw);
      return Option.isSome(dec) ? (dec.value.embeddings[0] ?? null) : null;
    },
    fetchFn: opts.fetchFn ?? fetch,
  });

export const makeOpenAiEmbedder = (opts: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly dimensions: number;
  readonly fetchFn?: typeof fetch;
}): EmbedderShape =>
  makeHttpEmbedder({
    model: opts.model,
    dimensions: opts.dimensions,
    endpoint: `${opts.baseUrl.replace(/\/+$/, "")}/embeddings`,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
    buildBody: (_kind, text) => JSON.stringify({ model: opts.model, input: text, dimensions: opts.dimensions }),
    extractVector: (raw) => {
      const dec = Schema.decodeUnknownOption(OpenAiEmbedResponseSchema)(raw);
      return Option.isSome(dec) ? (dec.value.data[0]?.embedding ?? null) : null;
    },
    fetchFn: opts.fetchFn ?? fetch,
  });

export const OllamaEmbedderLive = (opts: {
  readonly baseUrl: string;
  readonly model: string;
  readonly dimensions: number;
}): Layer.Layer<Embedder> => Layer.succeed(Embedder, makeOllamaEmbedder(opts));

export const OpenAiEmbedderLive = (opts: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly dimensions: number;
}): Layer.Layer<Embedder> => Layer.succeed(Embedder, makeOpenAiEmbedder(opts));
