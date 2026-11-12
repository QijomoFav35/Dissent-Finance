#!/usr/bin/env node
// Ben and Cara leave the v1 vault now that spend 0 is settled. v1 has no access keys, so nobody can
// move its funds except through its own rules; they exit with the agent keys they gave their agents,
// which can call only exit and cancel_spend on v1.
//
//   node mainnet/v1-exit.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KeyCaller } from "../src/chain.js";
import { ROOT, RPCS, USDC, member, log, usdc, near, view, record, explorer } from "./lib.mjs";

const V1 = `vault.${ROOT}`;
const KEYS = path.join(os.homedir(), ".near-credentials", "dissent-agents");

async function main() {
  for (const m of ["ben", "cara"]) {
    const id = member(m);
    const shares = BigInt(await view(V1, "get_shares", { account_id: id }));
    if (shares === 0n) {
      log(`${m} already left v1`);
      continue;
    }
    const before = BigInt(await view(USDC, "ft_balance_of", { account_id: id }));
    const { private_key } = JSON.parse(fs.readFileSync(path.join(KEYS, `${id}.json`), "utf8"));
    const caller = new KeyCaller({ accountId: id, secretKey: private_key, rpcUrls: RPCS, vaultId: V1 });
    const r = await caller.exit("v1-settled: spend 0 was cancelled, leaving to join v2");
    if (r.ok === false) throw new Error(`${m}'s exit failed: ${JSON.stringify(r.failure)}`);
    const after = BigInt(await view(USDC, "ft_balance_of", { account_id: id }));
    log(`${m} left v1 with ${usdc(after - before)} USDC ${explorer(r.hash)}`);
    record("v1_exit", { vault: V1, account: id, tx: r.hash, usdc: String(after - before) });
  }
  const b = await view(V1, "get_balances");
  log(`v1 now holds ${usdc(b.usdc)} USDC and ${near(b.near)} NEAR for ${b.members} members`);
}

main().catch((e) => {
  console.error(`stopped: ${e?.message ?? e}`);
  process.exit(1);
});
