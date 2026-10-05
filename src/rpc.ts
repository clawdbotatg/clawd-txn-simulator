export const DEFAULT_RPC = process.env.SIM_RPC ?? "http://192.168.68.74:8545";

let id = 0;
export async function rpc(url: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const json: any = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

export type Log = { address: string; topics: string[]; data: string; position?: string };

export type Frame = {
  type: string;
  from: string;
  to?: string;
  value?: string;
  gas: string;
  gasUsed: string;
  input: string;
  output?: string;
  error?: string;
  revertReason?: string;
  logs?: Log[];
  calls?: Frame[];
};

export type AccountState = { balance?: string; nonce?: number; code?: string; storage?: Record<string, string> };
export type PrestateDiff = { pre: Record<string, AccountState>; post: Record<string, AccountState> };
