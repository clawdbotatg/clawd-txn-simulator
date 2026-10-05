import { decodeAbiParameters, hexToString, toEventSelector } from "viem";
import { rpc, type Frame, type Log } from "./rpc.ts";

const T_TRANSFER = toEventSelector("Transfer(address,address,uint256)");
const T_APPROVAL = toEventSelector("Approval(address,address,uint256)");
const T_APPROVAL_ALL = toEventSelector("ApprovalForAll(address,address,bool)");
const T_SINGLE = toEventSelector("TransferSingle(address,address,address,uint256,uint256)");
const T_BATCH = toEventSelector("TransferBatch(address,address,address,uint256[],uint256[])");
const T_DEPOSIT = toEventSelector("Deposit(address,uint256)");
const T_WITHDRAWAL = toEventSelector("Withdrawal(address,uint256)");
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
export const ZERO = "0x0000000000000000000000000000000000000000";
export const ETH = "ETH";
const MAX = 2n ** 256n - 1n;

export type FlatLog = Log & { depth: number };
export type Move = { token: string; std: "eth" | "erc20" | "erc721" | "erc1155"; from: string; to: string; amount: bigint; id?: bigint };
export type Approval = { token: string; owner: string; spender: string; amount?: bigint; all?: boolean; id?: bigint };
export type TokenMeta = { symbol: string; decimals: number; name?: string };

const addr = (topic: string) => ("0x" + topic.slice(-40)).toLowerCase();
const uint = (hex: string) => (hex === "0x" ? 0n : BigInt(hex));

// Walk the call tree in execution order. Logs and ETH moves inside reverted frames are dropped.
export function flatten(root: Frame) {
  const logs: FlatLog[] = [];
  const moves: Move[] = [];
  const walk = (f: Frame, depth: number, failed: boolean) => {
    failed = failed || !!f.error;
    const v = f.value ? BigInt(f.value) : 0n;
    if (!failed && v > 0n && f.type !== "DELEGATECALL" && f.type !== "STATICCALL" && f.to) {
      moves.push({ token: ETH, std: "eth", from: f.from.toLowerCase(), to: f.to.toLowerCase(), amount: v });
    }
    const calls = f.calls ?? [];
    const fl = f.logs ?? [];
    for (let i = 0; i <= calls.length; i++) {
      if (!failed) for (const l of fl.filter((l) => Number(l.position ?? calls.length) === i)) logs.push({ ...l, depth });
      if (i < calls.length) walk(calls[i], depth + 1, failed);
    }
    // logs with no/odd position that weren't matched above
    if (!failed) for (const l of fl.filter((l) => Number(l.position ?? calls.length) > calls.length)) logs.push({ ...l, depth });
  };
  walk(root, 0, false);
  return { logs, ethMoves: moves };
}

export function tokenEvents(logs: FlatLog[]) {
  const moves: Move[] = [];
  const approvals: Approval[] = [];
  for (const l of logs) {
    const token = l.address.toLowerCase();
    const [t0, t1, t2, t3] = l.topics;
    try {
      if (t0 === T_TRANSFER && l.topics.length === 3) moves.push({ token, std: "erc20", from: addr(t1), to: addr(t2), amount: uint(l.data) });
      else if (t0 === T_TRANSFER && l.topics.length === 4) moves.push({ token, std: "erc721", from: addr(t1), to: addr(t2), amount: 1n, id: BigInt(t3) });
      else if (t0 === T_APPROVAL && l.topics.length === 3) approvals.push({ token, owner: addr(t1), spender: addr(t2), amount: uint(l.data) });
      else if (t0 === T_APPROVAL && l.topics.length === 4) approvals.push({ token, owner: addr(t1), spender: addr(t2), id: BigInt(t3) });
      else if (t0 === T_APPROVAL_ALL) approvals.push({ token, owner: addr(t1), spender: addr(t2), all: uint(l.data) !== 0n });
      else if (t0 === T_SINGLE) {
        const [id, value] = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], l.data as `0x${string}`);
        moves.push({ token, std: "erc1155", from: addr(t2), to: addr(t3), amount: value, id });
      } else if (t0 === T_BATCH) {
        const [ids, values] = decodeAbiParameters([{ type: "uint256[]" }, { type: "uint256[]" }], l.data as `0x${string}`);
        ids.forEach((id, k) => moves.push({ token, std: "erc1155", from: addr(t2), to: addr(t3), amount: values[k], id }));
      } else if (token === WETH && t0 === T_DEPOSIT) moves.push({ token, std: "erc20", from: ZERO, to: addr(t1), amount: uint(l.data) });
      else if (token === WETH && t0 === T_WITHDRAWAL) moves.push({ token, std: "erc20", from: addr(t1), to: ZERO, amount: uint(l.data) });
    } catch {}
  }
  return { moves, approvals };
}

// holder -> token key -> delta. NFTs are keyed by token:id.
export function netChanges(moves: Move[]) {
  const net = new Map<string, Map<string, bigint>>();
  const add = (who: string, key: string, d: bigint) => {
    if (who === ZERO) return;
    if (!net.has(who)) net.set(who, new Map());
    const m = net.get(who)!;
    m.set(key, (m.get(key) ?? 0n) + d);
  };
  for (const m of moves) {
    const key = m.id !== undefined ? `${m.token}:${m.id}` : m.token;
    add(m.from, key, -m.amount);
    add(m.to, key, m.amount);
  }
  for (const [who, m] of net) {
    for (const [k, v] of m) if (v === 0n) m.delete(k);
    if (!m.size) net.delete(who);
  }
  return net;
}

const metaCache = new Map<string, Promise<TokenMeta>>();
export function tokenMeta(url: string, block: string, token: string): Promise<TokenMeta> {
  if (token === ETH) return Promise.resolve({ symbol: "ETH", decimals: 18 });
  if (!metaCache.has(token)) {
    const call = (data: string) => rpc(url, "eth_call", [{ to: token, data }, block]).catch(() => "0x");
    metaCache.set(
      token,
      Promise.all([call("0x95d89b41"), call("0x313ce567"), call("0x06fdde03")]).then(([s, d, n]) => ({
        symbol: str(s) || token.slice(0, 8),
        decimals: d && d !== "0x" ? Number(BigInt(d.slice(0, 66))) : 0,
        name: str(n),
      })),
    );
  }
  return metaCache.get(token)!;
}

function str(hex: string): string {
  if (!hex || hex === "0x") return "";
  try {
    return decodeAbiParameters([{ type: "string" }], hex as `0x${string}`)[0];
  } catch {
    try {
      return hexToString(hex.slice(0, 66) as `0x${string}`).replace(/\0/g, "");
    } catch {
      return "";
    }
  }
}

export function fmtAmount(v: bigint, decimals: number, maxFrac = 6): string {
  if (v === MAX || v >= MAX / 2n) return "unlimited";
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  if (!frac && whole === 0n && v > 0n) return (neg ? "-" : "") + "<0." + "0".repeat(maxFrac - 1) + "1";
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + w + (frac ? "." + frac : "");
}
