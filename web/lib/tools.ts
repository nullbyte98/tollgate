/**
 * Lazy tool factories — wrapTool instances are only built on first call so
 * that Next.js page-data collection at build time doesn't trip the env-var
 * loader (`SERVER_WALLET_B64` doesn't exist locally during `next build`).
 */
import BN from "bn.js";
import { wrapTool, WrappedTool } from "@/lib/tollgate";
import {
  serverWallet,
  makeConnection,
  MINT,
  NETWORK,
  BRAVE_API_KEY,
  OPENAI_API_KEY,
} from "./server-config";

let _conn: ReturnType<typeof makeConnection> | null = null;
function commonOpts() {
  if (!_conn) _conn = makeConnection();
  return {
    connection: _conn,
    serverWallet: serverWallet(),
    mint: MINT,
    network: NETWORK,
    deadlineSeconds: 300,
  };
}

let _search: WrappedTool<{ q: string }, { q: string; results: string[] }> | null = null;
export function searchTool() {
  if (_search) return _search;
  _search = wrapTool(
    async ({ q }) => {
      if (typeof q !== "string" || q.length === 0) throw new Error("missing q");
      return {
        q,
        results: [
          `${q} — top result (mocked)`,
          `${q} — second result`,
          `${q} — third result`,
        ],
      };
    },
    { ...commonOpts(), endpointId: "tool:search-v1", amount: new BN(1_000) }
  );
  return _search;
}

let _rerank: WrappedTool<
  { items: string[]; query: string; failMode?: boolean },
  { ranked: string[] }
> | null = null;
export function rerankTool() {
  if (_rerank) return _rerank;
  _rerank = wrapTool(
    async ({ items, query, failMode }) => {
      if (failMode) throw new Error("simulated tool failure — refund triggered");
      if (!Array.isArray(items) || items.length === 0)
        throw new Error("items must be non-empty");
      return {
        ranked: items
          .map((it) => ({
            it,
            s: (it.match(new RegExp(query, "gi")) ?? []).length,
          }))
          .sort((a, b) => b.s - a.s)
          .map(({ it }) => it),
      };
    },
    {
      ...commonOpts(),
      endpointId: "tool:rerank-v1",
      amount: new BN(2_000),
      executionTimeoutMs: 30_000,
    }
  );
  return _rerank;
}

let _openai: WrappedTool<
  { prompt: string; model?: string },
  { content: string; model: string; mocked: boolean }
> | null = null;
export function openaiTool() {
  if (_openai) return _openai;
  _openai = wrapTool(
    async ({ prompt, model }) => {
      if (!prompt) throw new Error("missing prompt");
      const useModel = model ?? "gpt-4o-mini";
      if (!OPENAI_API_KEY) {
        return {
          mocked: true,
          model: useModel,
          content: `[mock] would have asked ${useModel}: "${prompt.slice(0, 80)}". Set OPENAI_API_KEY for real responses.`,
        };
      }
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: useModel,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!r.ok) {
        throw new Error(`openai ${r.status}: ${(await r.text()).slice(0, 200)}`);
      }
      const body = (await r.json()) as any;
      return {
        mocked: false,
        model: useModel,
        content: body.choices?.[0]?.message?.content ?? "",
      };
    },
    { ...commonOpts(), endpointId: "tool:openai-chat-v1", amount: new BN(20_000) }
  );
  return _openai;
}

const braveHeaders = (key: string) => ({
  Accept: "application/json",
  "Accept-Encoding": "gzip",
  "X-Subscription-Token": key,
});

let _brave: WrappedTool<
  { query: string; count?: number; offset?: number },
  { results: any[]; mocked: boolean }
> | null = null;
export function braveWebSearchTool() {
  if (_brave) return _brave;
  _brave = wrapTool(
    async ({ query, count, offset }) => {
      if (!query) throw new Error("missing query");
      if (!BRAVE_API_KEY) {
        return {
          mocked: true,
          results: Array.from({ length: count ?? 3 }, (_, i) => ({
            title: `[mock] result ${i + 1} for "${query}"`,
            url: `https://example.com/mock/${i + 1}`,
            description: `Mock — set BRAVE_API_KEY for real results.`,
          })),
        };
      }
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set(
        "count",
        String(Math.min(20, Math.max(1, count ?? 10)))
      );
      url.searchParams.set(
        "offset",
        String(Math.min(9, Math.max(0, offset ?? 0)))
      );
      const r = await fetch(url, { headers: braveHeaders(BRAVE_API_KEY) });
      if (!r.ok) throw new Error(`brave ${r.status}`);
      const body = (await r.json()) as any;
      return {
        mocked: false,
        results: (body?.web?.results ?? []).map((it: any) => ({
          title: it.title,
          url: it.url,
          description: it.description,
          published: it.published,
        })),
      };
    },
    { ...commonOpts(), endpointId: "tool:brave-web-search-v1", amount: new BN(5_000) }
  );
  return _brave;
}

export function manifest() {
  // Don't require the keypair env var to render the manifest. Use a placeholder
  // when not configured so /api/mcp/manifest is still inspectable in dev.
  let server = "(SERVER_WALLET_B64 not set)";
  try {
    server = serverWallet().publicKey.toBase58();
  } catch {}
  return {
    server,
    version: 1 as const,
    tools: [
      {
        name: "web_search",
        description:
          "Mock paid web search via Tollgate. 0.001 USDC; refunds on handler error.",
        inputSchema: {
          type: "object",
          properties: { q: { type: "string" } },
          required: ["q"],
        },
        endpoint: "/api/tools/search",
        endpointId: "tool:search-v1",
        amount: "1000",
        mint: MINT.toBase58(),
        network: NETWORK,
      },
      {
        name: "rerank",
        description:
          "Mock paid LLM-style rerank. Pass {failMode:true} to exercise auto-refund. 0.002 USDC.",
        inputSchema: {
          type: "object",
          properties: {
            items: { type: "array", items: { type: "string" } },
            query: { type: "string" },
            failMode: { type: "boolean" },
          },
          required: ["items", "query"],
        },
        endpoint: "/api/tools/rerank",
        endpointId: "tool:rerank-v1",
        amount: "2000",
        mint: MINT.toBase58(),
        network: NETWORK,
      },
      {
        name: "openai_chat",
        description: `Paid OpenAI chat via Tollgate (${OPENAI_API_KEY ? "real" : "mock"} mode). 0.020 USDC. Refunds on OpenAI 5xx / 429 / parse error.`,
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            model: { type: "string" },
          },
          required: ["prompt"],
        },
        endpoint: "/api/tools/openai_chat",
        endpointId: "tool:openai-chat-v1",
        amount: "20000",
        mint: MINT.toBase58(),
        network: NETWORK,
      },
      {
        name: "brave_web_search",
        description: `Paid Brave Web Search (${BRAVE_API_KEY ? "real" : "mock"} mode). 0.005 USDC.`,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            count: { type: "number" },
            offset: { type: "number" },
          },
          required: ["query"],
        },
        endpoint: "/api/tools/brave_web_search",
        endpointId: "tool:brave-web-search-v1",
        amount: "5000",
        mint: MINT.toBase58(),
        network: NETWORK,
      },
    ],
  };
}
