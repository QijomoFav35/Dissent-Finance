#!/usr/bin/env node
// Keeps Ben's and Cara's agents on duty for vault2 for a fixed time (.github/workflows/guard.yml).
// Each agent runs in its own watcher process holding only its own member's key. Before starting, it
// reads each key from the chain and refuses it unless it is a function-call key that can call only
// exit and cancel_spend on the vault.
//
//   BEN_AGENT_KEY=ed25519:... CARA_AGENT_KEY=ed25519:... MINUTES=350 node mainnet/guard.mjs

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { KeyPair } from "near-api-js";
import { Rpc } from "../src/rpc.js";
import { AGENT_METHODS } from "../src/chain.js";

const VAULT = "vault2.dissentfinance.near";
const RPCS = (process.env.DISSENT_RPC || "https://free.rpc.fastnear.com,https://near.drpc.org,https://rpc.mainnet.near.org,https://rpc.intea.rs").split(",");
const GUARDS = [
  { account_id: "ben.dissentfinance.near", env: "BEN_AGENT_KEY" },
  { account_id: "cara.dissentfinance.near", env: "CARA_AGENT_KEY" },
];
const minutes = Math.min(350, Math.max(1, Number(process.env.MINUTES || 350)));
const here = path.dirname(new URL(import.meta.url).pathname);
const notesDir = path.join(here, "notes", "guard");
const log = (line) => console.log(`${new Date().toISOString()} ${line}`);

/** The key's permission as the chain holds it, or a reason it can't be used. */
export async function checkKey(rpc, accountId, secret) {
  let publicKey;
  try {
    publicKey = KeyPair.fromString(secret).getPublicKey().toString();
  } catch {
    return { ok: false, why: "not a NEAR key" };
  }
  let key;
  try {
    key = await rpc.query({ request_type: "view_access_key", account_id: accountId, public_key: publicKey });
  } catch (e) {
    return { ok: false, why: `not on ${accountId}: ${String(e?.message ?? e).slice(0, 100)}` };
  }
  const fc = key.permission?.FunctionCall;
  if (!fc) return { ok: false, why: "a full-access key; the guard only runs function-call keys" };
  if (fc.receiver_id !== VAULT) return { ok: false, why: `limited to ${fc.receiver_id}, not ${VAULT}` };
  if ([...fc.method_names].sort().join(",") !== [...AGENT_METHODS].sort().join(",")) return { ok: false, why: `can call ${fc.method_names.join(", ")}` };
  return { ok: true, publicKey, allowance: fc.allowance };
}

async function main() {
  const present = GUARDS.filter((g) => process.env[g.env]);
  if (!present.length) {
    log("no agent keys, nothing to do (set BEN_AGENT_KEY and CARA_AGENT_KEY as repository secrets)");
    return;
  }
  const rpc = new Rpc(RPCS, { finality: "final" });
  const ready = [];
  for (const g of present) {
    const r = await checkKey(rpc, g.account_id, process.env[g.env]);
    if (!r.ok) {
      console.error(`${g.account_id}: refusing this key: ${r.why}`);
      process.exitCode = 1;
      continue;
    }
    const allowance = r.allowance ? `${(Number(BigInt(r.allowance) / 10n ** 20n) / 1e4).toFixed(4)} NEAR of gas allowance left` : "no allowance limit";
    log(`${g.account_id}: key ${r.publicKey.slice(0, 16)}... can call only ${AGENT_METHODS.join(" and ")} on ${VAULT}; ${allowance}`);
    ready.push(g);
  }
  if (!ready.length) return;

  fs.mkdirSync(notesDir, { recursive: true });
  const config = path.join(notesDir, "guard.config.json");
  fs.writeFileSync(config, JSON.stringify({ vault: VAULT, rpc: RPCS, interval_sec: 10, notes_dir: notesDir, members: ready.map((g) => ({ account_id: g.account_id, key_env: "AGENT_KEY" })) }, null, 2));

  // A watcher that dies is started again; one that keeps dying fails the run, so a red run means
  // an agent was not on duty.
  let ending = false;
  const children = new Map();
  const restarts = Object.fromEntries(ready.map((g) => [g.account_id, 0]));
  const start = (g) => {
    const child = spawn(process.execPath, [path.join(here, "..", "src", "watch.js"), config, "--member", g.account_id], {
      env: { PATH: process.env.PATH, AGENT_KEY: process.env[g.env] },
      cwd: path.join(here, ".."),
    });
    const name = g.account_id.split(".")[0].padEnd(4);
    for (const s of [child.stdout, child.stderr]) s.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => console.log(`[${name}] ${l}`)));
    child.on("exit", (code) => {
      if (ending) return;
      restarts[g.account_id]++;
      log(`${g.account_id}'s agent stopped (${code}); restart ${restarts[g.account_id]}`);
      if (restarts[g.account_id] > 5) {
        console.error(`${g.account_id}'s agent keeps stopping; failing the run now`);
        ending = true;
        for (const c of children.values()) c.kill();
        process.exit(1);
      }
      setTimeout(() => start(g), 15_000);
    });
    children.set(g.account_id, child);
  };
  ready.forEach(start);
  log(`${ready.length} agent(s) watching ${VAULT} for ${minutes} minutes`);

  const reader = new Rpc(RPCS, { finality: "final" });
  const beat = setInterval(async () => {
    try {
      const open = await reader.view(VAULT, "get_open_spends");
      log(`on duty: ${open.length} open spend(s)`);
    } catch (e) {
      log(`on duty (vault read failed: ${String(e?.message ?? e).slice(0, 80)})`);
    }
  }, 30 * 60_000);

  await new Promise((r) => setTimeout(r, minutes * 60_000));
  clearInterval(beat);
  ending = true;
  for (const c of children.values()) c.kill();
  log("watch ended; the next scheduled run takes over");
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().catch((e) => {
    console.error(`stopped: ${e?.message ?? e}`);
    process.exit(1);
  });
}
