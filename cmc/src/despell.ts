// DeSpell's external AI connector: an MCP server (Streamable HTTP, no login)
// with read tools and "prepare" tools that only return a link. We use two:
//
//   find_token    is this token on DeSpell's verified list on this chain?
//   prepare_swap  a 15-minute link that opens one swap card in DeSpell
//
// Nothing here signs, holds keys or moves funds. The link opens a card in
// DeSpell for whoever opens it; their wallet quotes and signs there. Because
// the link is money-adjacent, every prepare_swap answer is checked against
// what was asked (chain, both token addresses, amount) and the link must
// point at the connector's own site, or it is refused.

import { USDC } from "./chains.ts";

/** Production app (open). test.despell.io/api/mcp is the test deployment. */
export const DEFAULT_DESPELL_MCP_URL = "https://app.despell.io/api/mcp";

export class DespellConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DespellConnectorError";
  }
}

export interface DespellConnectorOptions {
  /** Connector endpoint, for example https://app.despell.io/api/mcp. */
  url?: string;
  fetch?: typeof fetch;
}

export interface DespellConnector {
  /** The connector's origin, which is also where handoff links must point. */
  readonly origin: string;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

let nextId = 1;

/** Pull the JSON-RPC message out of a JSON or server-sent-events body. */
function readRpcBody(contentType: string, text: string): unknown {
  if (contentType.includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/u)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data) return JSON.parse(data);
    }
    throw new DespellConnectorError("connector sent an empty event stream");
  }
  return JSON.parse(text);
}

export function createDespellConnector(options: DespellConnectorOptions = {}): DespellConnector {
  const endpoint = new URL(options.url ?? DEFAULT_DESPELL_MCP_URL);
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost" && endpoint.hostname !== "127.0.0.1") {
    throw new DespellConnectorError("connector URL must be https");
  }
  const doFetch = options.fetch ?? fetch;

  return {
    origin: endpoint.origin,
    async callTool(name, args) {
      const body = { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } };
      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify(body),
        });
      } catch (err) {
        throw new DespellConnectorError(`connector unreachable: ${err instanceof Error ? err.message : String(err)}`);
      }
      const text = await res.text();
      if (!res.ok) throw new DespellConnectorError(`connector HTTP ${res.status}`);
      let msg: { result?: { content?: { type?: string; text?: string }[]; isError?: boolean }; error?: { message?: string } };
      try {
        msg = readRpcBody(res.headers.get("content-type") ?? "", text) as typeof msg;
      } catch (err) {
        if (err instanceof DespellConnectorError) throw err;
        throw new DespellConnectorError("connector sent unreadable JSON");
      }
      if (msg.error) throw new DespellConnectorError(`connector error: ${msg.error.message ?? "unknown"}`);
      const content = msg.result?.content?.find((c) => c.type === "text")?.text;
      if (content == null) throw new DespellConnectorError("connector result has no text content");
      try {
        return JSON.parse(content);
      } catch {
        throw new DespellConnectorError("connector tool result is not JSON");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Buyable on DeSpell?

export type Buyability =
  | { buyable: true }
  | { buyable: false; reason: "not_on_despell" | "no_pay_token" | "check_failed"; detail?: string };

interface FindTokenResult {
  ok?: boolean;
  status?: string;
  token?: { chainId?: number; address?: string };
  error?: string;
}

/** True only when find_token resolves this exact address on this chain. */
export async function checkBuyable(connector: DespellConnector, chainId: number, address: string): Promise<Buyability> {
  if (!USDC[chainId]) return { buyable: false, reason: "no_pay_token" };
  let result: FindTokenResult;
  try {
    result = (await connector.callTool("find_token", { query: address, chainId })) as FindTokenResult;
  } catch (err) {
    return { buyable: false, reason: "check_failed", detail: err instanceof Error ? err.message : String(err) };
  }
  if (result.ok === false) return { buyable: false, reason: "check_failed", detail: result.error ?? "find_token failed" };
  const same = result.token?.address?.toLowerCase() === address.toLowerCase() && result.token?.chainId === chainId;
  if (result.status === "resolved" && same) return { buyable: true };
  return { buyable: false, reason: "not_on_despell", detail: result.status ?? "unknown" };
}

// ---------------------------------------------------------------------------
// The handoff link

export interface WrapperBuyRequest {
  chainId: number;
  /** Wrapper token contract on that chain. */
  tokenAddress: string;
  /** USDC to spend, as a plain decimal string ("100"). */
  amount: string;
}

export interface WrapperBuyLink {
  url: string;
  expiresAt: string;
  chainId: number;
  pay: { symbol: string; address: string };
  receive: { symbol: string; address: string };
  amount: string;
}

interface PrepareSwapResult {
  ok?: boolean;
  executed?: boolean;
  url?: string;
  expiresAt?: string;
  error?: string;
  trades?: {
    kind?: string;
    fromChainId?: number;
    toChainId?: number;
    fromToken?: { symbol?: string; address?: string };
    toToken?: { symbol?: string; address?: string };
    amount?: string;
  }[];
}

const HANDOFF_ID_RE = /^[A-Za-z0-9_-]{16,64}$/u;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u;
const AMOUNT_RE = /^\d{1,9}(\.\d{1,6})?$/u;

/** The link must be the connector's own site, path "/", with nothing but a handoff id. */
export function checkHandoffUrl(url: string, origin: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new DespellConnectorError("handoff link is not a URL");
  }
  const params = [...u.searchParams.keys()];
  const id = u.searchParams.get("handoff") ?? "";
  if (u.origin !== origin || u.pathname !== "/" || u.hash || params.length !== 1 || params[0] !== "handoff" || !HANDOFF_ID_RE.test(id)) {
    throw new DespellConnectorError("handoff link does not point at the connector's own site");
  }
  return u.toString();
}

/** Ask DeSpell for a link that buys `tokenAddress` with `amount` USDC on the same chain, and check what comes back. */
export async function prepareWrapperBuy(connector: DespellConnector, req: WrapperBuyRequest): Promise<WrapperBuyLink> {
  const pay = USDC[req.chainId];
  if (!pay) throw new DespellConnectorError(`no USDC configured for chain ${req.chainId}`);
  if (!ADDRESS_RE.test(req.tokenAddress)) throw new DespellConnectorError("token address is not a 0x address");
  if (!AMOUNT_RE.test(req.amount) || !(Number(req.amount) > 0)) throw new DespellConnectorError("amount is not a positive decimal");

  const result = (await connector.callTool("prepare_swap", {
    trades: [{ fromChainId: req.chainId, fromToken: pay.address, toToken: req.tokenAddress, amount: req.amount }],
  })) as PrepareSwapResult;
  if (result.ok !== true) throw new DespellConnectorError(`prepare_swap refused: ${result.error ?? "unknown"}`);
  if (result.executed !== false) throw new DespellConnectorError("prepare_swap did not confirm that nothing was executed");

  const trades = result.trades ?? [];
  const t = trades[0];
  const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
  if (
    trades.length !== 1 ||
    !t ||
    t.kind !== "swap" ||
    t.fromChainId !== req.chainId ||
    t.toChainId !== req.chainId ||
    !same(t.fromToken?.address, pay.address) ||
    !same(t.toToken?.address, req.tokenAddress) ||
    t.amount !== req.amount
  ) {
    throw new DespellConnectorError("prepare_swap answered with a different trade than asked");
  }
  if (!result.url || !result.expiresAt) throw new DespellConnectorError("prepare_swap returned no link");

  return {
    url: checkHandoffUrl(result.url, connector.origin),
    expiresAt: result.expiresAt,
    chainId: req.chainId,
    pay: { symbol: t.fromToken?.symbol ?? "USDC", address: pay.address },
    receive: { symbol: t.toToken?.symbol ?? "", address: req.tokenAddress.toLowerCase() },
    amount: req.amount,
  };
}
