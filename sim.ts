#!/usr/bin/env node
// Local transaction simulator: runs a tx against an archive node and explains what happens.
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { getAddress, parseEther, formatGwei, type Abi } from "viem";
import { rpc, DEFAULT_RPC, type Frame, type PrestateDiff } from "./src/rpc.ts";
import { contractInfo, lookupSignatures, decodeCall, decodeLog, decodeRevert, decodeOutput, fmtValue, type ContractInfo } from "./src/decode.ts";
import { flatten, tokenEvents, netChanges, tokenMeta, fmtAmount, ETH, ZERO, type Move, type TokenMeta } from "./src/assets.ts";

const { values: opt } = parseArgs({
  options: {
    tx: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    data: { type: "string", default: "0x" },
    value: { type: "string", default: "0" },
    gas: { type: "string" },
    block: { type: "string", default: "latest" },
    rpc: { type: "string", default: DEFAULT_RPC },
    fund: { type: "boolean", default: false },
    storage: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    "no-ai": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (opt.help || (!opt.tx && !opt.to)) {
  console.log(`usage:
  sim --from 0x.. --to 0x.. [--data 0x..] [--value 0.1|0xwei] [--block N|latest] [--gas N] [--fund]
  sim --tx 0xhash          replay a mined tx

  --fund      give the sender 1M ETH first
  --storage   list every storage slot change
  --json      raw structured output
  --no-ai     skip the TLDR (uses \`claude -p\`)
  --rpc URL   default ${DEFAULT_RPC} (or SIM_RPC)`);
  process.exit(0);
}

const url = opt.rpc!;
const tty = process.stdout.isTTY && !opt.json;
const c = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const [red, green, yellow, dim, bold, cyan] = [31, 32, 33, 2, 1, 36].map(c);

const callTracer = { tracer: "callTracer", tracerConfig: { withLog: true } };
const diffTracer = { tracer: "prestateTracer", tracerConfig: { diffMode: true } };

// ---- run ----
let root: Frame, diff: PrestateDiff, blockTag: string, sender: string, gasPrice: bigint, header: any;

if (opt.tx) {
  const tx = await rpc(url, "eth_getTransactionByHash", [opt.tx]);
  if (!tx) throw new Error("tx not found");
  blockTag = tx.blockNumber;
  sender = tx.from.toLowerCase();
  [root, diff, header] = await Promise.all([
    rpc(url, "debug_traceTransaction", [opt.tx, callTracer]),
    rpc(url, "debug_traceTransaction", [opt.tx, diffTracer]),
    rpc(url, "eth_getBlockByNumber", [blockTag, false]),
  ]);
  const receipt = await rpc(url, "eth_getTransactionReceipt", [opt.tx]);
  gasPrice = BigInt(receipt.effectiveGasPrice);
} else {
  header = await rpc(url, "eth_getBlockByNumber", [opt.block === "latest" ? "latest" : "0x" + BigInt(opt.block!).toString(16), false]);
  blockTag = header.number;
  sender = (opt.from ?? ZERO).toLowerCase();
  const value = opt.value!.startsWith("0x") ? BigInt(opt.value!) : parseEther(opt.value!);
  const call: Record<string, string> = { from: sender, to: opt.to!, data: opt.data!, value: "0x" + value.toString(16) };
  if (opt.gas) call.gas = "0x" + BigInt(opt.gas).toString(16);
  const overrides = opt.fund ? { stateOverrides: { [sender]: { balance: "0x" + parseEther("1000000").toString(16) } } } : {};
  [root, diff] = await Promise.all([
    rpc(url, "debug_traceCall", [call, blockTag, { ...callTracer, ...overrides }]),
    rpc(url, "debug_traceCall", [call, blockTag, { ...diffTracer, ...overrides }]),
  ]);
  gasPrice = BigInt(header.baseFeePerGas ?? 0);
}

// ---- decode ----
const { logs, ethMoves } = flatten(root);
const tok = tokenEvents(logs);
const moves: Move[] = [...ethMoves, ...tok.moves];
const net = netChanges(moves);

const frames: Frame[] = [];
(function collect(f: Frame) {
  frames.push(f);
  f.calls?.forEach(collect);
})(root);

const contractAddrs = new Set<string>(
  [
    ...frames.map((f) => f.to),
    ...logs.map((l) => l.address),
    ...tok.moves.flatMap((m) => [m.from, m.to]),
    ...tok.approvals.map((a) => a.spender),
  ]
    .filter((a): a is string => !!a && a.toLowerCase() !== ZERO)
    .map((a) => a.toLowerCase()),
);
const infos = new Map<string, ContractInfo>();
await Promise.all([
  ...[...contractAddrs].map(async (a) => infos.set(a, await contractInfo(url, blockTag, a))),
  lookupSignatures(
    frames.flatMap((f) => [f.input?.slice(0, 10), f.error ? f.output?.slice(0, 10) : undefined]).filter((s): s is string => !!s && s.length === 10),
    logs.map((l) => l.topics[0]).filter(Boolean),
  ),
]);

const tokens = new Set<string>([...moves.map((m) => m.token), ...tok.approvals.map((a) => a.token)]);
const metas = new Map<string, TokenMeta>();
await Promise.all([...tokens].map(async (t) => metas.set(t, await tokenMeta(url, blockTag, t))));

// a proxy borrows the ABI of whatever it delegatecalls into
const delegates = new Map<string, Set<string>>();
for (const f of frames) for (const ch of f.calls ?? []) {
  if (ch.type === "DELEGATECALL" && f.to && ch.to) {
    const k = f.to.toLowerCase();
    if (!delegates.has(k)) delegates.set(k, new Set());
    delegates.get(k)!.add(ch.to.toLowerCase());
  }
}
const abiOf = (a?: string): Abi => {
  if (!a) return [];
  const l = a.toLowerCase();
  return [...(infos.get(l)?.abi ?? []), ...[...(delegates.get(l) ?? [])].flatMap((d) => infos.get(d)?.abi ?? [])];
};
const short = (a: string) => { const x = getAddress(a); return `${x.slice(0, 6)}…${x.slice(-4)}`; };
function label(a: string | undefined): string {
  if (!a) return "?";
  const l = a.toLowerCase();
  if (l === sender) return `you(${short(l)})`;
  if (l === ZERO) return "0x0";
  const name = (metas.has(l) && metas.get(l)!.symbol) || infos.get(l)?.name;
  return name ? `${name}(${short(l)})` : short(l);
}
const amt = (token: string, v: bigint) => {
  const m = metas.get(token)!;
  return `${fmtAmount(v, m.decimals)} ${m.symbol}`;
};
const argStr = (v: unknown) => {
  if (v === 2n ** 256n - 1n) return "MAX";
  const s = fmtValue(v);
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return label(s);
  return s.length > 80 ? s.slice(0, 40) + "…" + s.slice(-8) + ` (${(s.length - 2) / 2}b)` : s;
};

const ok = !root.error;
const revert = root.error ? decodeRevert(abiOf(deepestError(root)?.to), deepestError(root)?.output ?? root.output) : null;
function deepestError(f: Frame): Frame | undefined {
  if (!f.error) return undefined;
  for (const ch of f.calls ?? []) {
    const d = deepestError(ch);
    if (d && d.output === f.output) return d; // same revert data bubbled up
  }
  return f;
}

// ---- report ----
const out: string[] = [];
const p = (s = "") => out.push(s);
const gasUsed = BigInt(root.gasUsed);
const fee = gasUsed * gasPrice;

p(`${ok ? green(bold("✅ SUCCESS")) : red(bold("❌ REVERTED"))}  ${opt.tx ? "replay of " + opt.tx.slice(0, 12) + "… " : ""}block ${BigInt(blockTag)}`);
if (!ok) p(red(`   reason: ${revert ?? root.error}`));
p(`   gas ${gasUsed.toLocaleString()}  ·  fee ≈ ${fmtAmount(fee, 18)} ETH @ ${formatGwei(gasPrice)} gwei`);
p(`   ${label(root.from)} → ${label(root.to)}  ${describeCall(root)}`);

if (moves.length) {
  p(); p(bold("Asset moves"));
  for (const m of moves) {
    const what = m.std === "erc721" ? `${metas.get(m.token)!.symbol} #${m.id}` : m.std === "erc1155" ? `${m.amount} × ${metas.get(m.token)!.symbol} #${m.id}` : amt(m.token, m.amount);
    const verb = m.from === ZERO ? "mint" : m.to === ZERO ? "burn" : "";
    p(`  ${what.padEnd(28)} ${label(m.from)} → ${label(m.to)} ${dim(verb)}`);
  }
}

if (net.size) {
  p(); p(bold("Net balance changes"));
  const order = [...net.keys()].sort((a, b) => (a === sender ? -1 : b === sender ? 1 : 0));
  for (const who of order) {
    const parts = [...net.get(who)!].map(([k, v]) => {
      const [token, id] = k.split(":");
      const s = id ? `${v > 0n ? "+" : ""}${metas.get(token)!.symbol} #${id}` : (v > 0n ? "+" : "") + amt(token, v);
      return v > 0n ? green(s) : red(s);
    });
    p(`  ${label(who).padEnd(32)} ${parts.join("  ")}`);
  }
  if (fee) p(dim(`  (plus gas fee for the sender)`));
}

if (tok.approvals.length) {
  p(); p(bold("Approvals"));
  for (const a of tok.approvals) {
    const what = a.all !== undefined ? (a.all ? yellow("ALL tokens (operator)") : "revoked operator") : a.id !== undefined ? `#${a.id}` : a.amount === 0n ? "revoked" : amt(a.token, a.amount!);
    p(`  ${label(a.owner)} lets ${label(a.spender)} spend ${what === "unlimited" || /unlimited/.test(what) ? yellow(what) : what} ${dim("on " + label(a.token))}`);
  }
}

p(); p(bold("Call trace"));
(function printFrame(f: Frame, depth: number) {
  const pad = "  ".repeat(depth + 1);
  const val = f.value && BigInt(f.value) > 0n && f.type !== "DELEGATECALL" ? yellow(` 💰${fmtAmount(BigInt(f.value), 18)} ETH`) : "";
  const err = f.error ? red(` ✗ ${decodeRevert(abiOf(f.to), f.output) ?? f.error}`) : "";
  const outv = !f.error ? decodeOutput(abiOf(f.to), f.input, f.output ?? "") : null;
  const ret = outv ? dim(` → ${outv.map(argStr).join(", ")}`) : "";
  p(`${pad}${dim(f.type)} ${cyan(label(f.to))}.${describeCall(f)}${val}${ret}${err} ${dim(`[${BigInt(f.gasUsed).toLocaleString()}]`)}`);
  const calls = f.calls ?? [];
  for (let i = 0; i <= calls.length; i++) {
    for (const l of (f.logs ?? []).filter((l) => Number(l.position ?? calls.length) === i)) {
      const d = decodeLog(abiOf(l.address), l.topics, l.data);
      const body = d ? `${d.name}(${d.args.map((a) => `${a.name}=${argStr(a.value)}`).join(", ")})${d.guessed ? dim("?") : ""}` : `topic ${l.topics[0]?.slice(0, 10)}`;
      p(`${pad}  ${green("⚡")} ${body}`);
    }
    if (i < calls.length) printFrame(calls[i], depth + 1);
  }
})(root, 0);

function describeCall(f: Frame): string {
  if (f.type.startsWith("CREATE")) return `new contract (${(f.input.length - 2) / 2} bytes)`;
  if (!f.input || f.input === "0x") return "send ETH";
  const d = decodeCall(abiOf(f.to), f.input);
  if (!d) return `${f.input.slice(0, 10)}(…)`;
  return `${d.name}(${d.args.map((a) => argStr(a.value)).join(", ")})${d.guessed ? dim("?") : ""}`;
}

// state changes
const touched = new Set([...Object.keys(diff.pre ?? {}), ...Object.keys(diff.post ?? {})]);
const slotCount = [...touched].reduce((n, a) => n + new Set([...Object.keys(diff.pre?.[a]?.storage ?? {}), ...Object.keys(diff.post?.[a]?.storage ?? {})]).size, 0);
p(); p(bold(`State changes`) + dim(`  ${touched.size} accounts, ${slotCount} storage slots`));
for (const a of touched) {
  const pre = diff.pre?.[a] ?? {}, post = diff.post?.[a] ?? {};
  const bits: string[] = [];
  if (post.balance && post.balance !== pre.balance) {
    const d = BigInt(post.balance) - BigInt(pre.balance ?? 0);
    bits.push(`ETH ${d > 0n ? "+" : ""}${fmtAmount(d, 18)}`);
  }
  if (post.nonce !== undefined && post.nonce !== pre.nonce) bits.push(`nonce ${pre.nonce ?? 0}→${post.nonce}`);
  if (post.code && post.code !== pre.code) bits.push(yellow("code deployed"));
  const slots = new Set([...Object.keys(pre.storage ?? {}), ...Object.keys(post.storage ?? {})]);
  if (slots.size) bits.push(`${slots.size} slot${slots.size > 1 ? "s" : ""}`);
  p(`  ${label(a).padEnd(32)} ${bits.join(", ")}`);
  if (opt.storage) for (const s of slots) p(dim(`      ${s}: ${pre.storage?.[s] ?? "0x0"} → ${post.storage?.[s] ?? "0x0"}`));
}

const report = out.join("\n");

if (opt.json) {
  const replacer = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
  console.log(JSON.stringify({ ok, revert, gasUsed, fee, moves, approvals: tok.approvals, net: Object.fromEntries([...net].map(([k, m]) => [k, Object.fromEntries(m)])), trace: root, stateDiff: diff }, replacer, 2));
  process.exit(0);
}

let tldr = "";
if (!opt["no-ai"]) {
  const plain = report.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 20000);
  try {
    tldr = execFileSync(
      "claude",
      ["-p", "--model", "haiku", "Below is a simulated Ethereum transaction report. 'you' is the sender. In 1-3 short plain-English sentences, say what this transaction does and its outcome for the sender (what they give, what they get, any approvals or risks). Use token amounts. No preamble, no markdown."],
      { input: plain, encoding: "utf8", timeout: 90000 },
    ).trim();
  } catch {
    tldr = dim("(TLDR unavailable)");
  }
}

if (tldr) console.log(bold("TLDR: ") + tldr + "\n");
console.log(report);
