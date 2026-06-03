#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

type JsonSchema = Record<string, unknown>;

interface OpenAPIParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
}

interface OpenAPIOperation {
  operationId: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenAPIParameter[];
  requestBody?: {
    required?: boolean;
    description?: string;
    content?: Record<string, { schema?: JsonSchema }>;
  };
}

interface OpenAPISpec {
  paths: Record<string, Record<string, OpenAPIOperation>>;
  components?: { schemas?: Record<string, JsonSchema> };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  method: string;
  path: string;
  pathParams: string[];
  queryParams: { name: string; required: boolean }[];
  hasBody: boolean;
  bodyContentType: string | null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const LIBREDESK_URL = (process.env.LIBREDESK_URL || "").replace(/\/$/, "");
const LIBREDESK_API_KEY = process.env.LIBREDESK_API_KEY || "";
const LIBREDESK_API_SECRET = process.env.LIBREDESK_API_SECRET || "";

if (!LIBREDESK_URL) {
  console.error(
    "[libredesk-mcp] LIBREDESK_URL is not set. Example: http://localhost:9000",
  );
}
if (!LIBREDESK_API_KEY || !LIBREDESK_API_SECRET) {
  console.error(
    "[libredesk-mcp] LIBREDESK_API_KEY and LIBREDESK_API_SECRET must be set.",
  );
}

function loadSpec(): OpenAPISpec {
  const candidates = [
    join(__dirname, "openapi.json"),
    join(__dirname, "..", "src", "openapi.json"),
  ];
  for (const p of candidates) {
    try {
      const raw = readFileSync(p, "utf-8");
      return JSON.parse(raw) as OpenAPISpec;
    } catch {
      // try next
    }
  }
  throw new Error("Unable to locate bundled openapi.json");
}

function resolveRef(spec: OpenAPISpec, ref: string): JsonSchema {
  if (!ref.startsWith("#/")) return {};
  const segments = ref.slice(2).split("/");
  let current: unknown = spec;
  for (const seg of segments) {
    if (current && typeof current === "object" && seg in (current as object)) {
      current = (current as Record<string, unknown>)[seg];
    } else {
      return {};
    }
  }
  return (current as JsonSchema) ?? {};
}

function dereference(spec: OpenAPISpec, schema: JsonSchema, seen = new Set<string>()): JsonSchema {
  if (!schema || typeof schema !== "object") return schema;
  if (typeof schema.$ref === "string") {
    if (seen.has(schema.$ref)) return {};
    seen.add(schema.$ref);
    return dereference(spec, resolveRef(spec, schema.$ref), seen);
  }
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(schema)) {
    if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        item && typeof item === "object" ? dereference(spec, item as JsonSchema, new Set(seen)) : item,
      );
    } else if (v && typeof v === "object") {
      out[k] = dereference(spec, v as JsonSchema, new Set(seen));
    } else {
      out[k] = v;
    }
  }
  return out;
}

// MCP tool names must be <= 64 chars, alphanumeric+underscore+hyphen.
function toolNameFromOperationId(operationId: string): string {
  let s = operationId.replace(/^handle/, "");
  s = s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  s = s.replace(/[^a-z0-9_]/g, "_");
  if (s.length > 60) s = s.slice(0, 60);
  return s || operationId;
}

function buildTools(spec: OpenAPISpec): ToolDef[] {
  const tools: ToolDef[] = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const lower = method.toLowerCase();
      if (!["get", "post", "put", "patch", "delete"].includes(lower)) continue;

      const name = toolNameFromOperationId(op.operationId);
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      const pathParams: string[] = [];
      const queryParams: { name: string; required: boolean }[] = [];

      for (const param of op.parameters || []) {
        const schema = param.schema ? dereference(spec, param.schema) : { type: "string" };
        const desc = [param.description, `(${param.in} parameter)`].filter(Boolean).join(" ");
        properties[param.name] = { ...schema, description: desc };
        if (param.in === "path") {
          pathParams.push(param.name);
          required.push(param.name);
        } else if (param.in === "query") {
          queryParams.push({ name: param.name, required: !!param.required });
          if (param.required) required.push(param.name);
        }
      }

      let hasBody = false;
      let bodyContentType: string | null = null;
      if (op.requestBody?.content) {
        const json = op.requestBody.content["application/json"];
        const firstContent = json
          ? { ct: "application/json", schema: json.schema }
          : Object.entries(op.requestBody.content).map(([ct, v]) => ({ ct, schema: v.schema }))[0];
        if (firstContent?.schema) {
          hasBody = true;
          bodyContentType = firstContent.ct;
          const resolved = dereference(spec, firstContent.schema);
          if (resolved.type === "object" && resolved.properties) {
            // Flatten body fields into top-level tool args (no path/query name collisions in this API).
            const bodyProps = resolved.properties as Record<string, JsonSchema>;
            const bodyRequired = (resolved.required as string[] | undefined) || [];
            for (const [bk, bv] of Object.entries(bodyProps)) {
              if (properties[bk]) {
                properties[`body_${bk}`] = { ...bv, description: `(body) ${(bv as JsonSchema).description || ""}` };
                if (op.requestBody.required && bodyRequired.includes(bk)) required.push(`body_${bk}`);
              } else {
                properties[bk] = { ...bv, description: `(body) ${(bv as JsonSchema).description || ""}` };
                if (op.requestBody.required && bodyRequired.includes(bk)) required.push(bk);
              }
            }
          } else {
            properties["body"] = { ...resolved, description: "Request body" };
            if (op.requestBody.required) required.push("body");
          }
        }
      }

      const description = [
        op.summary || op.operationId,
        op.description,
        `${method.toUpperCase()} ${path}`,
        op.tags?.length ? `Tags: ${op.tags.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      tools.push({
        name,
        description,
        inputSchema: {
          type: "object",
          properties,
          required: [...new Set(required)],
          additionalProperties: true,
        },
        method: lower,
        path,
        pathParams,
        queryParams,
        hasBody,
        bodyContentType,
      });
    }
  }
  return tools;
}

function authHeader(): string {
  // Libredesk supports either:
  //   Authorization: token <api_key>:<api_secret>
  //   Authorization: Basic base64(<api_key>:<api_secret>)
  // We use token auth; it's the documented preferred form.
  return `token ${LIBREDESK_API_KEY}:${LIBREDESK_API_SECRET}`;
}

async function callOperation(tool: ToolDef, args: Record<string, unknown>): Promise<string> {
  let url = `${LIBREDESK_URL}${tool.path}`;
  for (const p of tool.pathParams) {
    const v = args[p];
    if (v === undefined || v === null || v === "") {
      throw new Error(`Missing required path parameter: ${p}`);
    }
    url = url.replace(`{${p}}`, encodeURIComponent(String(v)));
  }

  const qs = new URLSearchParams();
  for (const q of tool.queryParams) {
    const v = args[q.name];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) qs.append(q.name, String(item));
    } else {
      qs.append(q.name, String(v));
    }
  }
  const qsStr = qs.toString();
  if (qsStr) url += (url.includes("?") ? "&" : "?") + qsStr;

  const headers: Record<string, string> = {
    Authorization: authHeader(),
    Accept: "application/json",
  };

  let body: string | undefined;
  if (tool.hasBody) {
    const usedKeys = new Set([...tool.pathParams, ...tool.queryParams.map((q) => q.name)]);
    const bodyObj: Record<string, unknown> = {};
    if ("body" in args && typeof args.body === "object" && args.body !== null) {
      Object.assign(bodyObj, args.body as Record<string, unknown>);
    }
    for (const [k, v] of Object.entries(args)) {
      if (usedKeys.has(k) || k === "body") continue;
      const realKey = k.startsWith("body_") ? k.slice(5) : k;
      bodyObj[realKey] = v;
    }
    if (Object.keys(bodyObj).length > 0) {
      body = JSON.stringify(bodyObj);
      headers["Content-Type"] = tool.bodyContentType || "application/json";
    }
  }

  const res = await fetch(url, {
    method: tool.method.toUpperCase(),
    headers,
    body,
  });

  const text = await res.text();
  const meta = `HTTP ${res.status} ${res.statusText} — ${tool.method.toUpperCase()} ${url}`;
  if (!res.ok) {
    return `${meta}\n\n${text}`;
  }
  try {
    const parsed = JSON.parse(text);
    return `${meta}\n\n${JSON.stringify(parsed, null, 2)}`;
  } catch {
    return `${meta}\n\n${text}`;
  }
}

async function main() {
  const spec = loadSpec();
  const tools = buildTools(spec);
  const byName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: "libredesk-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
      };
    }
    try {
      const result = await callOperation(tool, (req.params.arguments || {}) as Record<string, unknown>);
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: msg }] };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[libredesk-mcp] ready — ${tools.length} tools loaded against ${LIBREDESK_URL || "<unset>"}`);
}

main().catch((err) => {
  console.error("[libredesk-mcp] fatal:", err);
  process.exit(1);
});
