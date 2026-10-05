import fs from "node:fs";
import path from "node:path";
import {
  type Abi,
  type AbiFunction,
  type AbiEvent,
  decodeFunctionData,
  decodeEventLog,
  decodeErrorResult,
  decodeFunctionResult,
  parseAbiItem,
  toFunctionSelector,
  toEventSelector,
  getAddress,
  keccak256,
  toBytes,
  toHex,
} from "viem";
import { rpc } from "./rpc.ts";

const CACHE = path.join(import.meta.dirname, "..", ".cache");
fs.mkdirSync(path.join(CACHE, "abi"), { recursive: true });

// keccak256("eip1967.proxy.implementation") - 1
const EIP1967_IMPL = toHex(BigInt(keccak256(toBytes("eip1967.proxy.implementation"))) - 1n, { size: 32 });

// Standard ABIs, used when a contract isn't verified.
export const STD_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "event ApprovalForAll(address indexed owner, address indexed operator, bool approved)",
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
  "event Deposit(address indexed dst, uint256 wad)",
  "event Withdrawal(address indexed src, uint256 wad)",
  "error Error(string)",
  "error Panic(uint256)",
].map((s) => parseAbiItem(s)) as Abi;

export type ContractInfo = { name?: string; abi: Abi; impl?: string };

const contracts = new Map<string, Promise<ContractInfo>>();

async function sourcify(addr: string): Promise<{ name?: string; abi: Abi } | null> {
  const file = path.join(CACHE, "abi", `${addr}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  let out: { name?: string; abi: Abi } | null = null;
  try {
    const r = await fetch(`https://sourcify.dev/server/v2/contract/1/${addr}?fields=abi,compilation`, {
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) {
      const j: any = await r.json();
      if (j.abi) out = { name: j.compilation?.name, abi: j.abi };
    }
    fs.writeFileSync(file, JSON.stringify(out));
  } catch {
    // network trouble: don't cache, just go without
  }
  return out;
}

// Contract name + ABI, following EIP-1967 proxies.
export function contractInfo(url: string, block: string, address: string): Promise<ContractInfo> {
  const addr = address.toLowerCase();
  if (!contracts.has(addr)) {
    contracts.set(
      addr,
      (async () => {
        const [own, slot] = await Promise.all([
          sourcify(addr),
          rpc(url, "eth_getStorageAt", [addr, EIP1967_IMPL, block]).catch(() => "0x"),
        ]);
        const info: ContractInfo = { name: own?.name, abi: own?.abi ?? [] };
        if (slot && BigInt(slot) !== 0n) {
          info.impl = "0x" + slot.slice(-40);
          const impl = await sourcify(info.impl);
          if (impl) {
            info.abi = [...info.abi, ...impl.abi];
            if (!info.name || /proxy/i.test(info.name)) info.name = impl.name ?? info.name;
          }
        }
        return info;
      })(),
    );
  }
  return contracts.get(addr)!;
}

// openchain signature lookups, cached on disk
const SIGS_FILE = path.join(CACHE, "sigs.json");
const sigs: Record<string, string[]> = fs.existsSync(SIGS_FILE) ? JSON.parse(fs.readFileSync(SIGS_FILE, "utf8")) : {};

export async function lookupSignatures(fns: string[], events: string[]) {
  const f = [...new Set(fns)].filter((s) => !(s in sigs));
  const e = [...new Set(events)].filter((s) => !(s in sigs));
  if (!f.length && !e.length) return;
  try {
    const q = new URLSearchParams({ function: f.join(","), event: e.join(","), filter: "true" });
    const r = await fetch(`https://api.openchain.xyz/signature-database/v1/lookup?${q}`, {
      signal: AbortSignal.timeout(10000),
    });
    const j: any = await r.json();
    for (const kind of ["function", "event"]) {
      for (const [sel, list] of Object.entries(j.result?.[kind] ?? {})) {
        sigs[sel] = ((list as any[]) ?? []).map((x) => x.name);
      }
    }
    fs.writeFileSync(SIGS_FILE, JSON.stringify(sigs));
  } catch {}
}

export type Decoded = { name: string; args: { name: string; value: unknown }[]; guessed?: boolean };

function named(inputs: readonly { name?: string }[], values: readonly unknown[] | Record<string, unknown> | undefined) {
  if (!values) return [];
  const arr = Array.isArray(values) ? values : inputs.map((i, k) => (values as any)[i.name || k]);
  return inputs.map((inp, k) => ({ name: inp.name || `arg${k}`, value: arr[k] }));
}

export function decodeCall(abi: Abi, input: string): Decoded | null {
  if (!input || input.length < 10) return null;
  const sel = input.slice(0, 10);
  const fn = abi.find((x): x is AbiFunction => x.type === "function" && toFunctionSelector(x) === sel);
  if (fn) {
    try {
      const d = decodeFunctionData({ abi: [fn], data: input as `0x${string}` });
      return { name: fn.name, args: named(fn.inputs, d.args) };
    } catch {}
  }
  for (const text of sigs[sel] ?? []) {
    try {
      const item = parseAbiItem(`function ${text}`) as AbiFunction;
      const d = decodeFunctionData({ abi: [item], data: input as `0x${string}` });
      return { name: item.name, args: named(item.inputs, d.args), guessed: true };
    } catch {}
  }
  return null;
}

export function decodeOutput(abi: Abi, input: string, output: string): unknown[] | null {
  if (!output || output === "0x" || input.length < 10) return null;
  const fn = abi.find(
    (x): x is AbiFunction => x.type === "function" && toFunctionSelector(x) === input.slice(0, 10),
  );
  if (!fn || !fn.outputs.length) return null;
  try {
    const r = decodeFunctionResult({ abi: [fn], functionName: fn.name, data: output as `0x${string}` });
    return fn.outputs.length === 1 ? [r] : (r as unknown[]);
  } catch {
    return null;
  }
}

export function decodeLog(abi: Abi, topics: string[], data: string): Decoded | null {
  const t0 = topics[0];
  if (!t0) return null;
  for (const a of [abi, STD_ABI]) {
    const ev = a.find((x): x is AbiEvent => x.type === "event" && toEventSelector(x) === t0);
    if (!ev) continue;
    try {
      const d = decodeEventLog({ abi: [ev], topics: topics as any, data: data as `0x${string}` });
      return { name: ev.name, args: named(ev.inputs, d.args as any) };
    } catch {}
  }
  // openchain has no "indexed" info: guess the first N params are indexed
  for (const text of sigs[t0] ?? []) {
    try {
      const ev = parseAbiItem(`event ${text}`) as AbiEvent;
      const inputs = ev.inputs.map((i, k) => ({ ...i, indexed: k < topics.length - 1 }));
      const d = decodeEventLog({ abi: [{ ...ev, inputs }], topics: topics as any, data: data as `0x${string}` });
      return { name: ev.name, args: named(inputs, d.args as any), guessed: true };
    } catch {}
  }
  const first = sigs[t0]?.[0];
  if (first) return { name: first.split("(")[0], args: [], guessed: true };
  return null;
}

export function decodeRevert(abi: Abi, data: string | undefined): string | null {
  if (!data || data === "0x") return null;
  for (const a of [STD_ABI, abi]) {
    try {
      const r = decodeErrorResult({ abi: a, data: data as `0x${string}` });
      if (r.errorName === "Error") return String(r.args?.[0]);
      if (r.errorName === "Panic") return `Panic(0x${(r.args?.[0] as bigint).toString(16)})`;
      return `${r.errorName}(${(r.args ?? []).map(fmtValue).join(", ")})`;
    } catch {}
  }
  const names = sigs[data.slice(0, 10)];
  if (names?.length) return names[0];
  return `unknown error ${data.slice(0, 10)}`;
}

export function fmtValue(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) return getAddress(v);
  if (Array.isArray(v)) return `[${v.map(fmtValue).join(", ")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${k}: ${fmtValue(x)}`).join(", ")}}`;
  return String(v);
}
