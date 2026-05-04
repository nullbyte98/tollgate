/**
 * Brave Search REST client + tool definitions.
 *
 * Forked from the official MCP Brave Search server:
 *   https://github.com/modelcontextprotocol/servers-archived/tree/main/src/brave-search
 * (License: MIT, Anthropic. The package is archived but the API contract is
 * still used in the wild — see `mcp-server-brave-search` and downstream
 * forks.)
 *
 * Differences from upstream:
 *   - Pure HTTP server (Express), not stdio MCP. The MCP transport lives in
 *     ../mcp/ and treats this as a paid HTTP backend.
 *   - Each tool's handler is wrapped with @tollgate/sdk's wrapTool, so a
 *     successful call settles an on-chain escrow and a thrown call refunds it.
 *   - If BRAVE_API_KEY is unset, tools fall back to a clearly-marked mock so
 *     the demo flow works without a real key.
 */

const ENDPOINT_WEB = "https://api.search.brave.com/res/v1/web/search";
const ENDPOINT_POIS = "https://api.search.brave.com/res/v1/local/pois";
const ENDPOINT_DESCS = "https://api.search.brave.com/res/v1/local/descriptions";

export interface BraveWebResult {
  title: string;
  url: string;
  description: string;
  published?: string;
}

export interface BraveLocalResult {
  id: string;
  name: string;
  address: string;
  rating?: { value?: number; count?: number };
  phone?: string;
  hours?: string[];
}

const headers = (apiKey: string) => ({
  Accept: "application/json",
  "Accept-Encoding": "gzip",
  "X-Subscription-Token": apiKey,
});

export async function performWebSearch(opts: {
  apiKey: string | null;
  query: string;
  count?: number;
  offset?: number;
}): Promise<{ results: BraveWebResult[]; mocked: boolean }> {
  if (!opts.apiKey) {
    return {
      mocked: true,
      results: Array.from({ length: opts.count ?? 3 }, (_, i) => ({
        title: `[mock] result ${i + 1} for "${opts.query}"`,
        url: `https://example.com/mock/${i + 1}`,
        description: `Mock result — set BRAVE_API_KEY for real Brave Search responses.`,
      })),
    };
  }
  const url = new URL(ENDPOINT_WEB);
  url.searchParams.set("q", opts.query);
  url.searchParams.set("count", String(Math.min(20, Math.max(1, opts.count ?? 10))));
  url.searchParams.set("offset", String(Math.min(9, Math.max(0, opts.offset ?? 0))));

  const r = await fetch(url, { headers: headers(opts.apiKey) });
  if (!r.ok) {
    throw new Error(`Brave API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const body = (await r.json()) as any;
  const items = body?.web?.results ?? [];
  return {
    mocked: false,
    results: items.map((it: any) => ({
      title: it.title,
      url: it.url,
      description: it.description,
      published: it.published,
    })),
  };
}

export async function performLocalSearch(opts: {
  apiKey: string | null;
  query: string;
  count?: number;
}): Promise<{ results: BraveLocalResult[]; mocked: boolean; fellBackToWeb: boolean }> {
  if (!opts.apiKey) {
    return {
      mocked: true,
      fellBackToWeb: false,
      results: Array.from({ length: Math.min(3, opts.count ?? 3) }, (_, i) => ({
        id: `mock-${i}`,
        name: `[mock] place ${i + 1} for "${opts.query}"`,
        address: "1 Mock Street",
        rating: { value: 4.2, count: 10 },
        phone: "+1 555-MOCK",
      })),
    };
  }

  // Step 1: web search to get location IDs
  const probe = new URL(ENDPOINT_WEB);
  probe.searchParams.set("q", opts.query);
  probe.searchParams.set("search_lang", "en");
  probe.searchParams.set("result_filter", "locations");
  probe.searchParams.set("count", String(Math.min(20, opts.count ?? 5)));
  const probeRes = await fetch(probe, { headers: headers(opts.apiKey) });
  if (!probeRes.ok) {
    throw new Error(`Brave probe ${probeRes.status}`);
  }
  const probeBody = (await probeRes.json()) as any;
  const locationIds: string[] =
    (probeBody?.locations?.results ?? [])
      .map((l: any) => l.id)
      .filter(Boolean)
      .slice(0, 20);

  if (locationIds.length === 0) {
    // Fallback to web search
    const web = await performWebSearch({
      apiKey: opts.apiKey,
      query: opts.query,
      count: opts.count,
    });
    return {
      mocked: false,
      fellBackToWeb: true,
      results: web.results.map((r, i) => ({
        id: `web-${i}`,
        name: r.title,
        address: r.url,
      })),
    };
  }

  // Step 2: fetch POIs + descriptions in parallel
  const idsQs = locationIds.map((i) => `ids=${encodeURIComponent(i)}`).join("&");
  const [poisRes, descRes] = await Promise.all([
    fetch(`${ENDPOINT_POIS}?${idsQs}`, { headers: headers(opts.apiKey) }),
    fetch(`${ENDPOINT_DESCS}?${idsQs}`, { headers: headers(opts.apiKey) }),
  ]);
  if (!poisRes.ok) throw new Error(`Brave POIs ${poisRes.status}`);
  const pois = ((await poisRes.json()) as any)?.results ?? [];
  const descs = descRes.ok
    ? ((await descRes.json()) as any)?.descriptions ?? {}
    : {};

  return {
    mocked: false,
    fellBackToWeb: false,
    results: pois.map((p: any) => ({
      id: p.id,
      name: p.name ?? "",
      address: [
        p.address?.streetAddress,
        p.address?.addressLocality,
        p.address?.addressRegion,
        p.address?.postalCode,
      ]
        .filter(Boolean)
        .join(", "),
      rating: p.rating
        ? { value: p.rating.ratingValue, count: p.rating.ratingCount }
        : undefined,
      phone: p.phone,
      hours: p.openingHours,
    })),
  };
}
