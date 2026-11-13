#!/usr/bin/env node
// Checks the mainnet run against the chain with nothing but Node and public RPC. No keys, no installs.
//
//   node agent/mainnet/verify.mjs               # v2
//   node agent/mainnet/verify.mjs --vault vault # v1
//   node agent/mainnet/verify.mjs --json        # the same checks as JSON, for scripts and CI
//
// The state checks read one final block, so they see one consistent state. Each prints PASS, FAIL
// or INFO. A read that gets no answer from any endpoint fails its check; it never passes. The exit
// code is the number of failed checks (0 when everything passes).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { hashNote } from "../src/note.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.join(here, "..", "..");
const arg = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null);

export const DAO = "dissentfinance.sputnik-dao.near";
export const FACTORY = "sputnik-dao.near";
export const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const MEMBERS = ["alice", "ben", "cara", "dan", "emma"].map((m) => `${m}.dissentfinance.near`);
export const VAULTS = {
  vault: { id: "vault.dissentfinance.near", label: "v1", code: "3jWHECjP5BCezXDBPR1XuQzb62KpBYaKZzhMXbmoHtWN", notes: path.join(here, "notes"), keyless: true },
  vault2: { id: "vault2.dissentfinance.near", label: "v2", code: process.env.DISSENT_V2_CODE || "2CkdfmNBiPGukvkBpRm1AygHERiGDdPXf23eXPL58uVM", notes: path.join(here, "notes", "vault2"), keyless: false },
};
const RPCS = (process.env.DISSENT_RPC || "https://free.rpc.fastnear.com,https://near.drpc.org,https://rpc.mainnet.near.org,https://rpc.intea.rs").split(",");
// Old transactions are only served by archival nodes.
const ARCHIVAL = (process.env.DISSENT_ARCHIVAL_RPC || "https://archival-rpc.mainnet.fastnear.com,https://archival-rpc.mainnet.near.org").split(",");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes) {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

async function rpc(method, params, urls = RPCS) {
  let last;
  for (let round = 0; round < 3; round++) {
    for (const url of urls) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "verify", method, params }), signal: AbortSignal.timeout(20_000) });
        const j = await r.json();
        if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200));
        if (j.result?.error) throw new Error(j.result.error);
        return j.result;
      } catch (e) {
        // A method the contract does not have is an answer, not an outage: no retry.
        if (/MethodNotFound|METHOD_NOT_FOUND/.test(String(e?.message ?? e))) throw e;
        last = e;
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw last;
}

function reader(height) {
  const query = (p) => rpc("query", { block_id: height, ...p });
  const view = async (account, method, args = {}) => {
    const r = await query({ request_type: "call_function", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
    const text = Buffer.from(r.result).toString();
    return text ? JSON.parse(text) : null;
  };
  return { query, view };
}

const PROTECT = "cancel_spend,exit";
const MARKET = "bid,settle_offer";

async function readRecord(view, id, len) {
  const out = [];
  for (let from = 0; from < len; from += 100) out.push(...(await view(id, "get_record", { from_index: from, limit: 100 })).map((x) => JSON.parse(x)));
  return out;
}

/** The exit event as the transaction itself logged it, or null if no endpoint still serves the transaction. */
async function exitEventOnTx(txHash, sender) {
  let t;
  try {
    t = await rpc("tx", { tx_hash: txHash, sender_account_id: sender, wait_until: "FINAL" }, [...RPCS, ...ARCHIVAL]);
  } catch {
    return null;
  }
  for (const ro of t.receipts_outcome) {
    for (const log of ro.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      const ev = JSON.parse(log.slice("EVENT_JSON:".length));
      if (ev.event === "exit" && ev.data?.[0]?.account_id === sender) return ev.data[0];
    }
  }
  return { missing: true };
}

export async function runChecks(V, { out = () => {} } = {}) {
  const results = [];
  const add = (status, what) => {
    results.push({ n: results.length + 1, status, what });
    out(status, results.length, what);
  };
  // fn returns [status, text]. A check whose reads fail is recorded as FAIL with the reason.
  const check = async (name, fn) => {
    try {
      const [status, what] = await fn();
      add(status, what);
    } catch (e) {
      add("FAIL", `${name}: could not read (${String(e?.message ?? e).slice(0, 120)})`);
    }
  };

  const block = await rpc("block", { finality: "final" });
  const height = block.header.height;
  const { query, view } = reader(height);

  // ---- the vault's code, keys and configuration ----
  await check("vault code", async () => {
    const account = await query({ request_type: "view_account", account_id: V.id });
    const meta = await view(V.id, "contract_source_metadata").catch(() => null);
    const commit = meta?.link?.split("/tree/")[1] ?? null;
    return [account.code_hash === V.code ? "PASS" : "FAIL", `${V.id} runs code ${account.code_hash}, the reproducible build of commit ${commit ? commit.slice(0, 7) : "?"} (rebuild it: near contract verify deployed-at ${V.id} network-config mainnet now)`];
  });
  await check("vault keys", async () => {
    const n = (await query({ request_type: "view_access_key_list", account_id: V.id })).keys.length;
    if (n === 0) return ["PASS", `${V.id} has no access keys: nobody can change its code or move its funds outside its rules`];
    return [V.keyless ? "FAIL" : "INFO", `${V.id} still has ${n} access key(s): whoever holds them can redeploy it`];
  });
  await check("vault config", async () => {
    const c = await view(V.id, "get_config");
    return [c.dao === DAO && c.usdc === USDC ? "PASS" : "FAIL", `the vault takes spends only from ${c.dao} and holds native USDC (${c.usdc.slice(0, 8)}...); spend window ${Number(BigInt(c.window_ns) / 1_000_000_000n)} s`];
  });

  // ---- the DAO: stock factory code, the same bytes the sandbox tests run ----
  let daoCode = null;
  await check("dao code", async () => {
    const a = await query({ request_type: "view_account", account_id: DAO });
    daoCode = a.global_contract_hash || a.code_hash;
    const factoryHash = await view(FACTORY, "get_default_code_hash");
    const version = await view(FACTORY, "get_default_version").catch(() => null);
    return [daoCode === factoryHash ? "PASS" : "FAIL", `${DAO} runs ${daoCode}, the code ${FACTORY} publishes as its default${version ? ` (Sputnik ${version.join(".")})` : ""}: an unmodified DAO`];
  });
  await check("sandbox bytes", async () => {
    const file = path.join(repo, "contracts", "vault", "res", "sputnikdao2.wasm");
    if (!fs.existsSync(file)) return ["INFO", "contracts/vault/res/sputnikdao2.wasm is not in this checkout, so the sandbox DAO was not compared"];
    const h = base58(crypto.createHash("sha256").update(fs.readFileSync(file)).digest());
    return [h === daoCode ? "PASS" : "FAIL", `the Sputnik DAO the sandbox tests deploy (contracts/vault/res/sputnikdao2.wasm) hashes to ${h}, the same code as the DAO on mainnet`];
  });
  await check("dao policy", async () => {
    const policy = await view(DAO, "get_policy");
    const council = policy.roles.find((r) => r.name === "council");
    const group = council?.kind?.Group ?? [];
    const sameMembers = group.length === MEMBERS.length && MEMBERS.every((m) => group.includes(m));
    const oneRole = policy.roles.length === 1 && Object.keys(council?.vote_policy ?? {}).length === 0;
    const noEveryone = policy.roles.every((r) => r.kind !== "Everyone");
    const t = policy.default_vote_policy;
    const ok = sameMembers && oneRole && noEveryone && t.weight_kind === "RoleWeight" && String(t.threshold) === "2";
    return [ok ? "PASS" : "FAIL", `DAO policy: ${policy.roles.length} role, a council of the ${group.length} named members with no per-proposal overrides, no Everyone role, a proposal passes with ${t.threshold} council votes`];
  });
  await check("dao lock", async () => {
    const info = await view(DAO, "get_factory_info");
    if (info.auto_update === false) return ["PASS", `the DAO's factory auto-update is off: ${DAO} refuses code from ${info.factory_id}, so only a passed council proposal can change its code`];
    return ["INFO", `the DAO's factory auto-update is on: ${info.factory_id} can push new DAO code, which in the Sputnik source opens an upgrade proposal and is deployed after two weeks unless the council rejects it`];
  });

  // ---- the agents' keys, read from each member's own account ----
  await check("agent keys", async () => {
    const bad = [];
    let market = 0;
    for (const m of MEMBERS) {
      const keys = await query({ request_type: "view_access_key_list", account_id: m });
      const fc = keys.keys.map((k) => k.access_key.permission?.FunctionCall).filter((p) => p?.receiver_id === V.id);
      const methods = fc.map((p) => [...p.method_names].sort().join(","));
      // Two kinds of key may call the vault: the protection agent's and the market agent's.
      const guard = methods.filter((x) => x === PROTECT).length;
      market += methods.filter((x) => x === MARKET).length;
      if (!guard || methods.some((x) => x !== PROTECT && x !== MARKET)) bad.push(m);
    }
    if (bad.length) return ["FAIL", `agent keys missing or not limited to exit and cancel_spend (or, for market agents, ${MARKET.replaceAll(",", ", ")}): ${bad.join(", ")}`];
    const tail = market ? `; ${market} market key(s) can call only bid and settle_offer: never exit, offer shares or withdraw funds` : "";
    return ["PASS", `each of the ${MEMBERS.length} members has an agent key on their own account that can call only exit and cancel_spend on ${V.id}${tail}`];
  });

  // ---- spend 0, the DAO's proposal and its votes ----
  const spend = await view(V.id, "get_spend", { spend_id: 0 });
  if (!spend) {
    add("FAIL", "spend 0 is missing");
    return { results, height };
  }
  const proposal = await view(DAO, "get_proposal", { id: spend.proposal_id });
  await check("spend", async () => [spend.status === "Cancelled" ? "PASS" : "FAIL", `spend 0 (${Number(spend.amount) / 1e6} USDC to ${spend.recipient}) is ${spend.status}: it was never paid`]);
  await check("proposal", async () => {
    const fc = proposal.kind?.FunctionCall;
    const action = fc?.actions?.[0];
    const a = action ? JSON.parse(Buffer.from(action.args, "base64").toString()) : {};
    const ok = proposal.status === "Approved" && fc?.receiver_id === V.id && action?.method_name === "queue_spend" && a.recipient === spend.recipient && a.amount === spend.amount && a.token_id === USDC;
    return [ok ? "PASS" : "FAIL", `DAO proposal ${spend.proposal_id} is ${proposal.status}: a call to ${fc?.receiver_id}.queue_spend paying ${a.amount} USDC units to ${a.recipient}, the spend the vault queued`];
  });
  await check("votes", async () => {
    const approvers = Object.keys(proposal.votes || {}).filter((a) => proposal.votes[a] === "Approve").sort();
    const ok = approvers.length > 0 && approvers.join(",") === [...spend.approvers].sort().join(",");
    return [ok ? "PASS" : "FAIL", `the DAO's Approve votes (${approvers.map((a) => a.split(".")[0]).join(", ")}) are the spend's approvers; the other ${MEMBERS.length - approvers.length} members did not approve`];
  });

  // ---- the vault's own record: exits inside the window, then the cancel ----
  const len = await view(V.id, "get_record_len");
  const record = (await view(V.id, "get_record", { from_index: 0, limit: Math.min(len, 100) })).map((s) => JSON.parse(s));
  const queued = record.find((e) => e.event === "queue_spend" && e.data?.[0]?.spend_id === 0);
  const cancel = record.find((e) => e.event === "cancel_spend" && e.data?.[0]?.spend_id === 0);
  const inWindow = queued && cancel ? record.filter((e) => e.event === "exit" && BigInt(e.ts) > BigInt(queued.ts) && BigInt(e.ts) < BigInt(cancel.ts)) : [];
  await check("order", async () => {
    const ok = queued && cancel && inWindow.length > 0 && BigInt(cancel.ts) < BigInt(spend.window_ends);
    const secs = queued && cancel ? Number((BigInt(cancel.ts) - BigInt(queued.ts)) / 1_000_000n) / 1000 : 0;
    return [ok ? "PASS" : "FAIL", `the vault's record: spend queued, ${inWindow.length} exits, cancelled ${secs} s later, before its window closed`];
  });

  const evidence = fs.readFileSync(path.join(here, "evidence.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .filter((e) => (e.vault ?? "vault.dissentfinance.near") === V.id);
  const txOf = {};
  for (const e of evidence) {
    if (e.step === "exit") txOf[e.account] = e.tx;
    if (e.step === "exits_and_cancel") for (const m of ["alice", "dan", "emma"]) txOf[`${m}.dissentfinance.near`] = e[`${m}_exit`];
  }
  for (const ev of inWindow) {
    const who = ev.data[0].account_id;
    await check(`exit ${who}`, async () => {
      const published = JSON.parse(fs.readFileSync(path.join(V.notes, `0-${who}.json`), "utf8"));
      const computed = hashNote(published.note);
      const broken = published.note.checks.filter((c) => c.broken).map((c) => c.rule).join(", ");
      const tx = txOf[who];
      const onTx = tx ? await exitEventOnTx(tx, who) : null;
      const txOk = !onTx || onTx.reason_hash === computed;
      const ok = published.note.decision === "exit" && ev.data[0].reason_hash === computed && txOk;
      // The transaction is re-read when an endpoint still serves it; old ones need an archival node.
      const where = onTx && !onTx.missing ? `exit transaction ${tx.slice(0, 8)} and the vault's record carry` : `the vault's record of the exit carries (transaction ${tx ? tx.slice(0, 8) : "?"} not served by these RPC endpoints, so only the record was compared)`;
      if (!ok) return ["FAIL", `${who.split(".")[0]}: the exit carries ${String(onTx?.reason_hash ?? ev.data[0].reason_hash).slice(0, 12)}..., but the published note hashes to ${computed.slice(0, 12)}... (decision: ${published.note.decision})`];
      return ["PASS", `${who.split(".")[0]}: ${where} ${computed.slice(0, 12)}..., the hash of the published note computed here (rule broken: ${broken})`];
    });
  }
  const fullRecord = len > 100 ? await readRecord(view, V.id, len) : record;
  await check("leavers", async () => {
    // A leaver holds no shares, unless the record shows them joining again after spend 0 was cancelled.
    const back = new Set(fullRecord.filter((e) => e.event === "join" && cancel && BigInt(e.ts) > BigInt(cancel.ts)).map((e) => e.data[0].account_id));
    const shares = await Promise.all(inWindow.map((ev) => view(V.id, "get_shares", { account_id: ev.data[0].account_id })));
    const ok = shares.length > 0 && shares.every((s, i) => s === "0" || back.has(inWindow[i].data[0].account_id));
    const rejoined = inWindow.filter((ev) => back.has(ev.data[0].account_id)).length;
    return [ok ? "PASS" : "FAIL", `the ${shares.length} members who left took their whole stake: none held shares again${rejoined ? ` until they joined afresh (${rejoined} did, after the cancel)` : ""}`];
  });

  // ---- the books ----
  await check("shares", async () => {
    const balances = await view(V.id, "get_balances");
    const members = await view(V.id, "get_members", { from_index: 0, limit: 100 });
    const sum = members.reduce((a, [, s]) => a + BigInt(s), 0n);
    return [sum === BigInt(balances.total_shares) && members.length === balances.members ? "PASS" : "FAIL", `${members.length} remaining members' shares add up to the vault's total of ${balances.total_shares}`];
  });
  for (const token of ["Usdc", "Near"]) {
    await check(`books ${token}`, async () => {
      const l = await view(V.id, "get_ledger", { token });
      const held = BigInt(l.balance) + BigInt(l.pending_joins);
      const accounted = BigInt(l.deposited) - BigInt(l.spent) - BigInt(l.fees) - BigInt(l.exited) - BigInt(l.refunded);
      return [held === accounted ? "PASS" : "FAIL", `${token.toUpperCase()} books balance: held ${l.balance} + pending ${l.pending_joins} = deposited ${l.deposited} - spent ${l.spent} - fees ${l.fees} - exited ${l.exited} - refunded ${l.refunded}`];
    });
  }
  // Code from before the share market has no bid funds, holds or offers; those checks report INFO.
  // Only "no such method" means old code; any other failed read is a failed read, not a pass.
  const bidTotals = await view(V.id, "get_bid_funds_totals").catch((e) => {
    if (/MethodNotFound|METHOD_NOT_FOUND/.test(String(e?.message ?? e))) return null;
    throw e;
  });
  await check("usdc held", async () => {
    const l = await view(V.id, "get_ledger", { token: "Usdc" });
    const bids = bidTotals ? BigInt(bidTotals[0]) : 0n;
    const owed = BigInt(l.balance) + BigInt(l.pending_joins) + BigInt(l.claimable) + bids;
    const held = BigInt(await view(USDC, "ft_balance_of", { account_id: V.id }));
    return [held >= owed ? "PASS" : "FAIL", `the USDC contract says the vault holds ${held} units; the vault counts ${owed} as members' money${bidTotals ? ` (${bids} of it bid funds)` : ""}`];
  });
  await check("held back", async () => {
    if (!bidTotals) return ["INFO", `${V.id} runs code from before held-back exits: an approver could not leave while their spend was open`];
    const open = await view(V.id, "get_open_spends");
    const parts = { Usdc: 0n, Near: 0n };
    for (const sp of open) for (const [, n] of await view(V.id, "get_holds", { spend_id: sp.id })) parts[sp.token] += BigInt(n);
    const l = { Usdc: await view(V.id, "get_ledger", { token: "Usdc" }), Near: await view(V.id, "get_ledger", { token: "Near" }) };
    const ok = ["Usdc", "Near"].every((t) => BigInt(l[t].held) === parts[t] && BigInt(l[t].held) <= BigInt(l[t].balance));
    return [ok ? "PASS" : "FAIL", `held back for open spends from approvers who left: ${l.Usdc.held} USDC units and ${l.Near.held} yoctoNEAR, the sum of the ${open.length} open spend(s)' holds`];
  });
  await check("market", async () => {
    if (!bidTotals) return ["INFO", `${V.id} runs code from before the share market`];
    const sales = fullRecord.filter((e) => e.event === "share_sale").map((e) => e.data[0]);
    // Unsold offers are removed, so pages can be short; page by the count of offers ever made.
    const count = Number(await view(V.id, "get_offer_count"));
    const offers = [];
    for (let from = 0; from < count; from += 100) offers.push(...(await view(V.id, "get_offers", { from_index: from, limit: 100 })));
    const sold = offers.filter((o) => o.status === "Sold");
    const fair = sold.every((o) => BigInt(o.best_bid) >= BigInt(o.reserve) && o.best_bidder !== o.seller);
    const matched = sold.length === sales.length && sold.every((o) => sales.some((x) => Number(x.offer_id) === Number(o.id) && String(x.usdc) === String(o.best_bid)));
    if (!sold.length) return ["INFO", `no shares sold on ${V.id}'s market yet (${offers.length} open offer(s))`];
    const desc = sold.map((o) => `offer ${o.id}: ${o.seller.split(".")[0]} to ${o.best_bidder.split(".")[0]} for ${Number(o.best_bid) / 1e6} USDC after ${o.bids} bids`).join("; ");
    return [fair && matched ? "PASS" : "FAIL", `${sold.length} share sale(s), each at or above its reserve, each in the vault's record: ${desc}`];
  });
  return { results, height };
}

async function main() {
  const V = VAULTS[arg("--vault") || "vault2"];
  if (!V) throw new Error(`unknown vault ${arg("--vault")}`);
  const asJson = process.argv.includes("--json");
  if (!asJson) console.log(`Checking ${V.id} (${V.label}) on NEAR mainnet\n`);
  const { results, height } = await runChecks(V, { out: asJson ? () => {} : (s, n, what) => console.log(`${s.padEnd(5)} ${String(n).padStart(2)}. ${what}`) });
  const failed = results.filter((r) => r.status === "FAIL").length;
  if (asJson) console.log(JSON.stringify({ vault: V.id, block: height, failed, results }, null, 2));
  else console.log(`\nState read at final block ${height}. ${failed ? `${failed} check(s) failed` : "All checks passed"}`);
  process.exit(failed);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().catch((e) => {
    console.error(`stopped: ${e?.message ?? e}`);
    process.exit(99);
  });
}
