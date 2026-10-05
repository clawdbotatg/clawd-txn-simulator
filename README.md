# sim

Local Tenderly-style transaction simulator. Runs a tx on your archive node and tells you what it does.

Needs a node with `debug` enabled (reth: `--http.api eth,net,debug,trace`). Default RPC: `http://192.168.68.74:8545`, change with `--rpc` or `SIM_RPC`.

```
npm i
node sim.ts --from 0x.. --to 0x.. --data 0x.. --value 0.1      # simulate at latest block
node sim.ts ... --block 21000000                                # at a past block
node sim.ts ... --fund                                          # give sender 1M ETH first
node sim.ts --tx 0xhash                                         # replay a mined tx
```

Output: TLDR, pass/fail + revert reason, gas and fee, asset moves, net balance changes, approvals, decoded call trace with events, state changes.

- TLDR uses `claude -p --model haiku`. Skip with `--no-ai`.
- ABIs come from Sourcify, with openchain.xyz signatures as fallback (marked `?`). Cached in `.cache/`.
- `--storage` lists every storage slot change. `--json` dumps raw data.

Not done yet: USD prices, storage-variable names, bundles.
