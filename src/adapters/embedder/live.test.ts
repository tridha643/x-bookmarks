import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeJsonResponse } from "../../../test/fakes.ts";
import { Embedder } from "../../ports/embedder.ts";
import { OllamaEmbedderLive, OpenAiEmbedderLive, makeOllamaEmbedder, makeOpenAiEmbedder } from "./live.ts";

describe("adapters/embedder/live", () => {
  it("adds nomic-embed prefixes for Ollama documents and queries and strips trailing slashes", async () => {
    const seen: Array<{ url: string; method: string | undefined; contentType: string | undefined; body: string }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({
        url: String(input),
        method: init?.method,
        contentType: headers?.["Content-Type"],
        body: String(init?.body ?? ""),
      });
      return makeJsonResponse({ embeddings: [[0.1, 0.2, 0.3]] });
    };

    const nomic = makeOllamaEmbedder({
      baseUrl: "http://127.0.0.1:11434///",
      model: "nomic-embed-text",
      dimensions: 3,
      fetchFn,
    });
    expect(await Effect.runPromise(nomic.embedDocument("bookmark body"))).toEqual([0.1, 0.2, 0.3]);
    expect(await Effect.runPromise(nomic.embedQuery("find bookmark"))).toEqual([0.1, 0.2, 0.3]);
    expect(seen).toEqual([
      {
        url: "http://127.0.0.1:11434/api/embed",
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ model: "nomic-embed-text", input: "search_document: bookmark body" }),
      },
      {
        url: "http://127.0.0.1:11434/api/embed",
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ model: "nomic-embed-text", input: "search_query: find bookmark" }),
      },
    ]);

    const other = makeOllamaEmbedder({
      baseUrl: "http://127.0.0.1:11434",
      model: "mxbai-embed-large",
      dimensions: 3,
      fetchFn,
    });
    await Effect.runPromise(other.embedDocument("raw text"));
    expect(seen[2]?.body).toBe(JSON.stringify({ model: "mxbai-embed-large", input: "raw text" }));
  });

  it("calls OpenAI-compatible embeddings endpoint with Bearer auth and JSON content type", async () => {
    let capturedAuth: string | undefined;
    let capturedContentType: string | undefined;
    let capturedUrl = "";
    let capturedBody = "";
    const fetchFn: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedBody = String(init?.body ?? "");
      const headers = init?.headers as Record<string, string> | undefined;
      capturedAuth = headers?.Authorization;
      capturedContentType = headers?.["Content-Type"];
      return makeJsonResponse({ data: [{ embedding: [0.5, 0.5] }] });
    };

    const openai = makeOpenAiEmbedder({
      baseUrl: "https://api.openai.com/v1/",
      apiKey: "sk-secret",
      model: "text-embedding-3-small",
      dimensions: 2,
      fetchFn,
    });
    expect(await Effect.runPromise(openai.embedQuery("hello"))).toEqual([0.5, 0.5]);
    expect(capturedUrl).toBe("https://api.openai.com/v1/embeddings");
    expect(capturedAuth).toBe("Bearer sk-secret");
    expect(capturedContentType).toBe("application/json");
    expect(capturedBody).toBe(JSON.stringify({ model: "text-embedding-3-small", input: "hello", dimensions: 2 }));
  });

  it("reports typed EmbedderError for network, HTTP, decode, missing vector, and dimension mismatch", async () => {
    const netErr = makeOllamaEmbedder({
      baseUrl: "http://127.0.0.1:11434",
      model: "nomic-embed-text",
      dimensions: 3,
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect((await Effect.runPromise(Effect.flip(netErr.embedQuery("q")))).reason).toBe("network");

    const httpErr = makeOllamaEmbedder({
      baseUrl: "http://127.0.0.1:11434",
      model: "nomic-embed-text",
      dimensions: 3,
      fetchFn: async () => makeJsonResponse({ error: "fail" }, 503),
    });
    const httpFailure = await Effect.runPromise(Effect.flip(httpErr.embedQuery("q")));
    expect(httpFailure.reason).toBe("http");
    expect(httpFailure.detail).toBe("HTTP 503");

    const badJson = makeOllamaEmbedder({
      baseUrl: "http://127.0.0.1:11434",
      model: "nomic-embed-text",
      dimensions: 3,
      fetchFn: async () => new Response("not-json", { status: 200 }),
    });
    expect((await Effect.runPromise(Effect.flip(badJson.embedQuery("q")))).reason).toBe("decode");

    const missingVec = makeOllamaEmbedder({
      baseUrl: "http://127.0.0.1:11434",
      model: "nomic-embed-text",
      dimensions: 3,
      fetchFn: async () => makeJsonResponse({ embeddings: [] }),
    });
    const missingFail = await Effect.runPromise(Effect.flip(missingVec.embedQuery("q")));
    expect(missingFail.reason).toBe("decode");
    expect(missingFail.detail).toBe("missing embedding vector in response");

    const wrongOllamaSchema = makeOllamaEmbedder({
      baseUrl: "http://127.0.0.1:11434",
      model: "nomic-embed-text",
      dimensions: 3,
      fetchFn: async () => makeJsonResponse({ wrong: true }),
    });
    const wrongOllamaFail = await Effect.runPromise(Effect.flip(wrongOllamaSchema.embedQuery("q")));
    expect(wrongOllamaFail.reason).toBe("decode");
    expect(wrongOllamaFail.detail).toBe("missing embedding vector in response");

    const missingOpenAiVec = makeOpenAiEmbedder({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "k",
      model: "text-embedding-3-small",
      dimensions: 2,
      fetchFn: async () => makeJsonResponse({ data: [] }),
    });
    const missingOpenAiFail = await Effect.runPromise(Effect.flip(missingOpenAiVec.embedQuery("q")));
    expect(missingOpenAiFail.reason).toBe("decode");
    expect(missingOpenAiFail.detail).toBe("missing embedding vector in response");

    const wrongOpenAiSchema = makeOpenAiEmbedder({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "k",
      model: "text-embedding-3-small",
      dimensions: 2,
      fetchFn: async () => makeJsonResponse({ wrong: true }),
    });
    const wrongOpenAiFail = await Effect.runPromise(Effect.flip(wrongOpenAiSchema.embedQuery("q")));
    expect(wrongOpenAiFail.reason).toBe("decode");
    expect(wrongOpenAiFail.detail).toBe("missing embedding vector in response");

    const badDims = makeOllamaEmbedder({
      baseUrl: "http://127.0.0.1:11434",
      model: "nomic-embed-text",
      dimensions: 768,
      fetchFn: async () => makeJsonResponse({ embeddings: [[1, 2]] }),
    });
    const dimsFailure = await Effect.runPromise(Effect.flip(badDims.embedQuery("q")));
    expect(dimsFailure.reason).toBe("dimensions");
    expect(dimsFailure.detail).toContain("768");
  });

  it("constructs live Effect layers with configured model and dimensions", async () => {
    const o = await Effect.runPromise(
      Effect.provide(
        Embedder,
        OllamaEmbedderLive({ baseUrl: "http://127.0.0.1:11434", model: "nomic-embed-text", dimensions: 768 }),
      ),
    );
    expect(o.model).toBe("nomic-embed-text");
    expect(o.dimensions).toBe(768);

    const a = await Effect.runPromise(
      Effect.provide(
        Embedder,
        OpenAiEmbedderLive({
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-x",
          model: "text-embedding-3-small",
          dimensions: 1536,
        }),
      ),
    );
    expect(a.model).toBe("text-embedding-3-small");
    expect(a.dimensions).toBe(1536);
  });
});
