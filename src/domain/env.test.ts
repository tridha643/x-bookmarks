import { describe, expect, it } from "vitest";
import { decodeAppEnv } from "./env.ts";

describe("domain/env", () => {
  it("applies defaults anchored at projectRoot with local Ollama nomic-embed-text", () => {
    const env = decodeAppEnv({}, "/srv/x-bookmarks");
    expect(env).toEqual({
      dbPath: "/srv/x-bookmarks/data/bookmarks.db",
      oramaPath: "/srv/x-bookmarks/data/orama.msp",
      profileDir: "/srv/x-bookmarks/data/browser-profile",
      httpHost: "127.0.0.1",
      httpPort: 8787,
      embedProvider: "ollama",
      embedModel: "nomic-embed-text",
      embedDims: 768,
      ollamaUrl: "http://127.0.0.1:11434",
      openaiBaseUrl: "https://api.openai.com/v1",
      openaiApiKey: null,
      minRequestMs: 1500,
    });
  });

  it("parses explicit environment overrides", () => {
    const env = decodeAppEnv(
      {
        XBM_DB_PATH: "/tmp/custom.db",
        XBM_ORAMA_PATH: "/tmp/custom.msp",
        XBM_PROFILE_DIR: "/tmp/prof",
        XBM_HTTP_HOST: "0.0.0.0",
        XBM_HTTP_PORT: "9090",
        XBM_EMBED_PROVIDER: "openai",
        XBM_EMBED_MODEL: "text-embedding-3-small",
        XBM_EMBED_DIMS: "1536",
        XBM_OLLAMA_URL: "http://localhost:11435",
        XBM_OPENAI_BASE_URL: "https://proxy.example/v1",
        XBM_OPENAI_API_KEY: "sk-test",
        XBM_MIN_REQUEST_MS: "2500",
      },
      "/srv/x-bookmarks",
    );
    expect(env).toEqual({
      dbPath: "/tmp/custom.db",
      oramaPath: "/tmp/custom.msp",
      profileDir: "/tmp/prof",
      httpHost: "0.0.0.0",
      httpPort: 9090,
      embedProvider: "openai",
      embedModel: "text-embedding-3-small",
      embedDims: 1536,
      ollamaUrl: "http://localhost:11435",
      openaiBaseUrl: "https://proxy.example/v1",
      openaiApiKey: "sk-test",
      minRequestMs: 2500,
    });
    expect(decodeAppEnv({ XBM_EMBED_PROVIDER: "ollama" }, "/srv").embedProvider).toBe("ollama");
  });

  it("rejects non-positive ports or invalid embed providers", () => {
    expect(() => decodeAppEnv({ XBM_HTTP_PORT: "0" }, "/srv")).toThrow();
    expect(() => decodeAppEnv({ XBM_EMBED_DIMS: "-5" }, "/srv")).toThrow();
    expect(() => decodeAppEnv({ XBM_EMBED_PROVIDER: "bogus" }, "/srv")).toThrow();
  });
});
