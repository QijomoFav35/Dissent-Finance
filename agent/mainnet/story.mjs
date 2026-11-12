#!/usr/bin/env node
// The README story, live: Ben proposes paying himself 60% of the vault's USDC, Ben and Cara approve,
// and then nobody touches anything. Start mainnet/agents.mjs in another terminal first.
//
//   node mainnet/story.mjs

import { Account, teraToGas } from "near-api-js";
import fs from "node:fs";
import path from "node:path";
import { USDC, DAO, VAULT, MEMBERS, member, PROPOSAL_BOND, provider, AGENT_KEYS, log, usdc, signerFor, view, call, record, explorer } from "./lib.mjs";

async function main() {
  const open = await view(VAULT, "get_open_spends");
  if (open.length) throw new Error(`a spend is already open: ${JSON.stringify(open[0]).slice(0, 200)}`);
  const before = await view(VAULT, "get_balances");
  const amount = (BigInt(before.usdc) * 3n) / 5n;
  const ben = member("ben");
  log(`vault: ${usdc(before.usdc)} USDC, ${before.members} members. Ben proposes ${usdc(amount)} USDC to himself.`);

  const proposalId = await view(DAO, "get_last_proposal_id");
  const args = Buffer.from(JSON.stringify({ proposal_id: proposalId, recipient: ben, token_id: USDC, amount: String(amount), memo: "group spend" }));
  const kind = {
    FunctionCall: {
      receiver_id: VAULT,
      actions: [{ method_name: "queue_spend", args: args.toString("base64"), deposit: "0", gas: "60000000000000" }],
    },
  };
  const benAcc = signerFor(ben);
  let hash = await call(benAcc, DAO, "add_proposal", { proposal: { description: "pay Ben", kind } }, { deposit: PROPOSAL_BOND, tgas: 50 });
  log(`proposal ${proposalId} filed ${explorer(hash)}`);
  record("propose", { proposal_id: proposalId, amount: String(amount), tx: hash });

  for (const voter of ["ben", "cara"]) {
    hash = await call(signerFor(member(voter)), DAO, "act_proposal", { id: proposalId, action: "VoteApprove", proposal: kind }, { tgas: 120 });
    log(`${voter} approved ${explorer(hash)}`);
    record("vote", { voter: member(voter), proposal_id: proposalId, tx: hash });
  }
  const p = await view(DAO, "get_proposal", { id: proposalId });
  if (p.status !== "Approved") throw new Error(`proposal is ${p.status}, expected Approved`);
  const spend = await view(VAULT, "get_spend_by_proposal", { proposal_id: proposalId });
  if (!spend) throw new Error("the DAO approved the proposal but the vault did not queue it; check the vote transaction");
  log(`spend ${spend.id} queued. From here on nobody acts by hand. Watching...`);
  const started = Date.now();

  for (;;) {
    const s = await view(VAULT, "get_spend", { spend_id: spend.id });
    if (s.status !== "Queued") {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      log(`spend ${spend.id} is ${s.status}, ${secs}s after it was queued`);
      record("settled", { spend_id: spend.id, status: s.status, seconds_after_queue: Number(secs) });
      break;
    }
    if (Date.now() - started > 15 * 60_000) throw new Error("nothing happened in 15 minutes: are the agents running?");
    await new Promise((r) => setTimeout(r, 2000));
  }

  const after = await view(VAULT, "get_balances");
  log(`vault now: ${usdc(after.usdc)} USDC, ${after.members} members`);
  for (const m of MEMBERS) {
    const id = member(m);
    const shares = BigInt(await view(VAULT, "get_shares", { account_id: id }));
    const held = await view(USDC, "ft_balance_of", { account_id: id });
    log(`  ${m.padEnd(5)} ${shares === 0n ? "left  " : "stayed"} wallet USDC ${usdc(held)}`);
  }

  // The agent key at work outside its two methods: the runtime refuses it before anything runs.
  const key = JSON.parse(fs.readFileSync(path.join(AGENT_KEYS, `${ben}.json`), "utf8")).private_key;
  const agent = new Account(ben, provider, key);
  try {
    await agent.callFunctionRaw({ contractId: USDC, methodName: "ft_transfer", args: { receiver_id: member("cara"), amount: "1" }, deposit: 1n, gas: teraToGas(30) });
    throw new Error("UNEXPECTED: the agent key moved USDC");
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (msg.startsWith("UNEXPECTED")) throw e;
    log(`agent key refused on USDC ft_transfer, as it should be: ${msg.slice(0, 160)}`);
    record("agent_key_refused", { account: ben, attempted: `${USDC}.ft_transfer`, error: msg.slice(0, 300) });
  }
}

main().catch((e) => {
  console.error(`stopped: ${e?.message ?? e}${e?.cause ? ` (${e.cause.code ?? ""} ${e.cause.message ?? ""})` : ""}`);
  if (!process.env.NODE_OPTIONS?.includes("ipv4first")) console.error("NODE_OPTIONS is not set to ipv4first in this terminal: run  source ~/.bashrc  and try again.");
  process.exit(1);
});
