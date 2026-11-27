import { resolve } from "node:path";
import { Schema } from "effect";

const EmbedProviderSchema = Schema.Literals(["ollama", "openai"]);
export type EmbedProvider = typeof EmbedProviderSchema.Type;

const PositiveIntFromString = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThan(0)),
);

const RawEnvSchema = Schema.Struct({
  XBM_DB_PATH: Schema.optional(Schema.String),
  XBM_ORAMA_PATH: Schema.optional(Schema.String),
  XBM_PROFILE_DIR: Schema.optional(Schema.String),
  XBM_HTTP_HOST: Schema.optional(Schema.String),
  XBM_HTTP_PORT: Schema.optional(PositiveIntFromString),
  XBM_AUTH_TOKEN: Schema.optional(Schema.String),
  XBM_EMBED_PROVIDER: Schema.optional(EmbedProviderSchema),
  XBM_EMBED_MODEL: Schema.optional(Schema.String),
  XBM_EMBED_DIMS: Schema.optional(PositiveIntFromString),
  XBM_OLLAMA_URL: Schema.optional(Schema.String),
  XBM_OPENAI_BASE_URL: Schema.optional(Schema.String),
  XBM_OPENAI_API_KEY: Schema.optional(Schema.String),
  XBM_MIN_REQUEST_MS: Schema.optional(PositiveIntFromString),
});
type ParsedEnv = typeof RawEnvSchema.Type;

export interface AppEnv {
  readonly dbPath: string;
  readonly oramaPath: string;
  readonly profileDir: string;
  readonly httpHost: string;
  readonly httpPort: number;
  readonly authToken: string | null;
  readonly embedProvider: EmbedProvider;
  readonly embedModel: string;
  readonly embedDims: number;
  readonly ollamaUrl: string;
  readonly openaiBaseUrl: string;
  readonly openaiApiKey: string | null;
  readonly minRequestMs: number;
}

const buildStoragePaths = (parsed: ParsedEnv, root: string) => ({
  dbPath: parsed.XBM_DB_PATH ?? resolve(root, "data/bookmarks.db"),
  oramaPath: parsed.XBM_ORAMA_PATH ?? resolve(root, "data/orama.msp"),
  profileDir: parsed.XBM_PROFILE_DIR ?? resolve(root, "data/browser-profile"),
});

const buildEmbedConfig = (parsed: ParsedEnv) => ({
  embedProvider: parsed.XBM_EMBED_PROVIDER ?? "ollama",
  embedModel: parsed.XBM_EMBED_MODEL ?? "nomic-embed-text",
  embedDims: parsed.XBM_EMBED_DIMS ?? 768,
  ollamaUrl: parsed.XBM_OLLAMA_URL ?? "http://127.0.0.1:11434",
  openaiBaseUrl: parsed.XBM_OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  openaiApiKey: parsed.XBM_OPENAI_API_KEY ?? null,
});

export const decodeAppEnv = (raw: Record<string, string | undefined>, projectRoot: string): AppEnv => {
  const parsed = Schema.decodeUnknownSync(RawEnvSchema)(raw);
  const rawToken = parsed.XBM_AUTH_TOKEN?.trim() ?? "";
  return {
    ...buildStoragePaths(parsed, projectRoot),
    ...buildEmbedConfig(parsed),
    httpHost: parsed.XBM_HTTP_HOST ?? "127.0.0.1",
    httpPort: parsed.XBM_HTTP_PORT ?? 8787,
    authToken: rawToken === "" ? null : rawToken,
    minRequestMs: parsed.XBM_MIN_REQUEST_MS ?? 1500,
  };
};
