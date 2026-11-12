#!/usr/bin/env node
// Checks the mainnet run against the chain with nothing but Node and public RPC. No keys, no installs.
//
//   node agent/mainnet/verify.mjs              # v2
//   node agent/mainnet/verify.mjs --vault vault # v1
//
// For each exit in the committed evidence it fetches the transaction from the chain, reads the exit
// event the vault logged, and checks its reason_hash against the published note, hashed here. It
// also checks the vault's code hash, its access keys, the spend's status and the members' shares.

import fs from "node:fs";
import path from "node:path";
import { hashNote } from "../src/note.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const which = process.argv.includes("--vault") ? process.argv[process.argv.indexOf("--vault") + 1] : "vault2";
const VAULTS = {
  vault: { id: "vault.dissentfinance.near", code: "3jWHECjP5BCezXDBPR1XuQzb62KpBYaKZzhMXbmoHtWN", notes: path.join(here, "notes") },
  vault2: { id: "vault2.dissentfinance.near", code: process.env.DISSENT_V2_CODE || null, notes: path.join(here, "notes", "vault2") },
};
const V = VAULTS[which];
if (!V) throw new Error(`unknown vault ${which}`);
const RPCS = (process.env.DISSENT_RPC || "https://free.rpc.fastnear.com,https://near.drpc.org,https://rpc.mainnet.near.org,https://rpc.intea.rs").split(",");

let failures = 0;
const pass = (what) => console.log(`PASS  ${what}`);
const fail = (what) => {
  failures++;
  console.log(`FAIL  ${what}`);
};

async function rpc(method, params) {
  let last;
  for (let round = 0; round < 3; round++) {
    for (const url of RPCS) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "verify", method, params }), signal: AbortSignal.timeout(20_000) });
        const j = await r.json();
        if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200));
        if (j.result?.error) throw new Error(j.result.error);
        return j.result;
      } catch (e) {
        last = e;
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw last;
}
const view = async (account, method, args = {}) => {
  const r = await rpc("query", { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  const text = Buffer.from(r.result).toString();
  return text ? JSON.parse(text) : null;
};

async function exitEvent(txHash, sender) {
  const t = await rpc("tx", { tx_hash: txHash, sender_account_id: sender, wait_until: "FINAL" });
  for (const ro of t.receipts_outcome) {
    for (const log of ro.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      const ev = JSON.parse(log.slice("EVENT_JSON:".length));
      if (ev.event === "exit" && ev.data?.[0]?.account_id === sender) return ev.data[0];
    }
  }
  return null;
}

async function main() {
  console.log(`Checking ${V.id} on NEAR mainnet\n`);
  const account = await rpc("query", { request_type: "view_account", finality: "final", account_id: V.id });
  const meta = await view(V.id, "contract_source_metadata").catch(() => null);
  console.log(`      code hash ${account.code_hash}; source ${meta?.link ?? "not stated"}`);
  if (V.code) (account.code_hash === V.code ? pass : fail)(`code hash is the reproducible build ${V.code}`);
  console.log(`      (to rebuild it from source: near contract verify deployed-at ${V.id} network-config mainnet now)`);
  const keys = await rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: V.id });
  console.log(`      access keys on the vault: ${keys.keys.length}${keys.keys.length ? " (it can still be changed by whoever holds them)" : " (keyless)"}`);

  const spend = await view(V.id, "get_spend", { spend_id: 0 });
  (spend?.status === "Cancelled" ? pass : fail)(`spend 0 is ${spend?.status ?? "missing"}`);

  const evidence = fs.readFileSync(path.join(here, "evidence.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .filter((e) => (e.vault ?? "vault.dissentfinance.near") === V.id);
  const exits = [];
  for (const e of evidence) {
    if (e.step === "exit") exits.push({ account: e.account, tx: e.tx });
    if (e.step === "exits_and_cancel") {
      for (const m of ["alice", "dan", "emma"]) exits.push({ account: `${m}.dissentfinance.near`, tx: e[`${m}_exit`] });
    }
  }
  if (!exits.length) fail("no exits found in the evidence for this vault");
  for (const { account: who, tx } of exits) {
    const file = path.join(V.notes, `0-${who}.json`);
    const published = JSON.parse(fs.readFileSync(file, "utf8"));
    const computed = hashNote(published.note);
    const ev = await exitEvent(tx, who);
    if (!ev) {
      fail(`${who}: transaction ${tx} has no exit event`);
      continue;
    }
    (ev.reason_hash === computed ? pass : fail)(`${who}: exit ${tx.slice(0, 8)} carries ${computed.slice(0, 12)}…, the hash of the published note (decision: ${published.note.decision})`);
    const shares = await view(V.id, "get_shares", { account_id: who });
    (shares === "0" ? pass : fail)(`${who}: holds no shares after leaving`);
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(`stopped: ${e?.message ?? e}`);
  process.exit(2);
});
