#!/usr/bin/env node
// Uses Ben's agent key for three things it must not be able to do, and records the network's answer.
// Only an answer from the NEAR runtime about the key's limits counts. A busy or unreachable RPC
// endpoint is retried on the next endpoint, never recorded as a refusal.
//
//   node mainnet/key-check.mjs

import fs from "node:fs";
import path from "node:path";
import { Account, JsonRpcProvider, teraToGas } from "near-api-js";
import { USDC, VAULT, RPCS, AGENT_KEYS, member, log, record } from "./lib.mjs";

// Errors that mean "the key's permissions refused this", as near-api-js names them.
export const REFUSED = /AccessKey|Mismatch|not allowed|InvalidTransaction|InvalidAccessKey/i;
// Errors that say nothing about the key: the request never got a real answer.
const TRANSIENT = /Rate limit|429|fetch failed|ETIMEDOUT|Internal server|unavailable|Exceeded \d+ providers|503|500|timeout/i;

export async function tryWithKey(accountId, privateKey, call) {
  let last;
  for (let round = 0; round < 3; round++) {
    for (const url of RPCS) {
      const account = new Account(accountId, new JsonRpcProvider({ url }), privateKey);
      try {
        const out = await account.callFunctionRaw({ ...call, gas: teraToGas(30) });
        return { refused: false, error: null, out };
      } catch (e) {
        const msg = `${e?.constructor?.name ?? "Error"}: ${String(e?.message ?? e)}`;
        if (REFUSED.test(msg)) return { refused: true, error: msg, endpoint: url };
        if (!TRANSIENT.test(msg)) return { refused: false, error: msg, endpoint: url };
        last = msg;
      }
    }
    await new Promise((r) => setTimeout(r, 20_000));
  }
  return { refused: false, error: `no endpoint gave an answer: ${last}` };
}

async function main() {
  // Flag any earlier "refused" line for this vault whose error was really a busy endpoint.
  const evidence = path.join(path.dirname(new URL(import.meta.url).pathname), "evidence.jsonl");
  const lines = fs.existsSync(evidence) ? fs.readFileSync(evidence, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  for (const e of lines) {
    const corrected = lines.some((c) => c.step === "agent_key_refused_correction" && c.corrects === e.at);
    if (e.step === "agent_key_refused" && e.vault === VAULT && TRANSIENT.test(e.error ?? "") && !REFUSED.test(e.error ?? "") && !corrected) {
      record("agent_key_refused_correction", { corrects: e.at, note: "that line recorded an RPC error, not a refusal: the request never reached the chain. The checks below replace it." });
    }
  }
  const ben = member("ben");
  const { private_key } = JSON.parse(fs.readFileSync(path.join(AGENT_KEYS, `${ben}.json`), "utf8"));
  const cases = [
    { what: "move USDC (ft_transfer on the USDC contract)", call: { contractId: USDC, methodName: "ft_transfer", args: { receiver_id: member("cara"), amount: "1" }, deposit: 1n } },
    { what: "call another method on the vault (set_rules)", call: { contractId: VAULT, methodName: "set_rules", args: { rules: { max_spend_share_bps: null, new_recipient: false, blocked_recipients: [] } }, deposit: 0n } },
    { what: "attach a deposit to exit", call: { contractId: VAULT, methodName: "exit", args: {}, deposit: 1n } },
  ];
  let ok = true;
  for (const c of cases) {
    const r = await tryWithKey(ben, private_key, c.call);
    if (r.refused) {
      log(`refused, as it should be: ${c.what}: ${r.error.slice(0, 160)}`);
      record("agent_key_refused", { account: ben, attempted: c.what, error: r.error.slice(0, 300), endpoint: r.endpoint });
    } else {
      ok = false;
      log(`NOT confirmed: ${c.what}: ${r.error ?? "the call went through"}`);
    }
  }
  if (!ok) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`stopped: ${e?.message ?? e}`);
    process.exit(1);
  });
}
