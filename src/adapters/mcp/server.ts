import { Option, Schema } from "effect";
import type { BookmarkApiHandlers } from "../../domain/api.ts";
import { TOOLS, ToolError, type McpTool } from "./tools.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS: ReadonlyArray<string> = [MCP_PROTOCOL_VERSION, "2025-03-26", "2024-11-05"];

const SERVER_INSTRUCTIONS =
  "Personal library of X (Twitter) bookmarks. Start with search_bookmarks for topic questions or list_bookmarks to browse recent saves, then get_bookmark for full text. Bookmark ids are numeric tweet ids; status URLs are accepted anywhere an id is.";

export type McpHandlers = BookmarkApiHandlers;

const JsonRpcRequestSchema = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});

const InitializeParamsSchema = Schema.Struct({
  protocolVersion: Schema.optional(Schema.String),
});

const ToolCallParamsSchema = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optional(Schema.Unknown),
});

const TOOLS_BY_NAME = new Map<string, McpTool>(TOOLS.map((t) => [t.name, t]));

const TOOL_LIST = TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({
  name,
  title,
  description,
  inputSchema,
  annotations,
}));

const negotiateVersion = (params: unknown): string => {
  const requested = Option.getOrUndefined(Schema.decodeUnknownOption(InitializeParamsSchema)(params))?.protocolVersion;
  return SUPPORTED_PROTOCOL_VERSIONS.find((v) => v === requested) ?? MCP_PROTOCOL_VERSION;
};

type JsonRpcId = string | number | null | undefined;

const invalidParams = (id: JsonRpcId, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code: -32602, message },
});

const toolFailure = (toolName: string, err: unknown): string => {
  if (err instanceof ToolError) return err.message;
  return `${toolName} failed: ${err instanceof Error ? err.message : String(err)}`;
};

const runTool = async (tool: McpTool, args: unknown, handlers: McpHandlers): Promise<Record<string, unknown>> => {
  try {
    const out = await tool.call(args, handlers);
    return { content: [{ type: "text", text: out.text }], structuredContent: out.structured };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: toolFailure(tool.name, err) }] };
  }
};

const handleToolCall = async (
  id: JsonRpcId,
  params: unknown,
  handlers: McpHandlers,
): Promise<Record<string, unknown>> => {
  const callOpt = Schema.decodeUnknownOption(ToolCallParamsSchema)(params);
  if (Option.isNone(callOpt)) return invalidParams(id, "tools/call params must include a string tool name.");
  const tool = TOOLS_BY_NAME.get(callOpt.value.name);
  if (tool === undefined) {
    return invalidParams(
      id,
      `Unknown tool "${callOpt.value.name}". Available tools: ${TOOLS.map((t) => t.name).join(", ")}.`,
    );
  }
  return { jsonrpc: "2.0", id, result: await runTool(tool, callOpt.value.arguments ?? {}, handlers) };
};

export const handleMcpPayload = async (
  payload: unknown,
  handlers: McpHandlers,
): Promise<Record<string, unknown> | null> => {
  const reqOpt = Schema.decodeUnknownOption(JsonRpcRequestSchema)(payload);
  if (Option.isNone(reqOpt)) return null;
  const { id, method, params } = reqOpt.value;
  if (method === "notifications/initialized") return null;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: negotiateVersion(params),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "x-bookmarks", title: "X Bookmarks", version: "1.0.0" },
        instructions: SERVER_INSTRUCTIONS,
      },
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOL_LIST } };
  if (method === "tools/call") return handleToolCall(id, params, handlers);
  return id === undefined
    ? null
    : { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
};

export const handleMcpMessage = async (
  rawLine: string,
  handlers: McpHandlers,
): Promise<Record<string, unknown> | null> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return null;
  }
  return handleMcpPayload(parsed, handlers);
};

export const runStdioMcpServer = (
  handlers: McpHandlers,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): void => {
  let buffer = "";
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line !== "") {
        void handleMcpMessage(line, handlers).then((resp) => {
          if (resp !== null) output.write(`${JSON.stringify(resp)}\n`);
        });
      }
      idx = buffer.indexOf("\n");
    }
  });
};
