#!/usr/bin/env node
// Swarm replay: what would a vault of exit agents have done to every real Sputnik transfer that was
// approved over at least one Reject vote?
//
//   node sim/swarm.js ../replay3.json            # summary
//   node sim/swarm.js ../replay3.json --json     # full results
//
// Real: every spend (amount, token, receiver, who approved, who rejected, whether the DAO had paid the
// receiver before), and the decision rule, which is the same evaluate() the live agents run.
// Modelled: the fund size at the time (past balances cannot be read back from the chain), so the fund
// is set to F times the DAO's median earlier transfer in that token, for several F. Each member who did
// not approve gets an agent whose rules are fixed per account, drawn from a population of 40 profiles,
// so the same person keeps the same rules across every spend. Shares are equal.

import fs from "node:fs";
import crypto from "node:crypto";
import { evaluate, unaffordable } from "../src/rules.js";

export const FUND_MULTIPLES = [10, 25, 50, 100];

/** 30 distinct rule profiles: 14 limits on the share of the fund one spend may take, each with and
 * without the new-recipient rule, plus one new-recipient-only profile and one that never exits. */
export function profiles() {
  const out = [];
  for (const bps of [300, 500, 750, 1000, 1250, 1500, 2000, 2500, 3000, 3500, 4000, 5000, 6000, 7500]) {
    out.push({ max_spend_share_bps: bps, new_recipient: false, blocked_recipients: [] });
    out.push({ max_spend_share_bps: bps, new_recipient: true, blocked_recipients: [] });
  }
  out.push({ max_spend_share_bps: null, new_recipient: true, blocked_recipients: [] });
  out.push({ max_spend_share_bps: null, new_recipient: false, blocked_recipients: [] });
  return out;
}

/** The same account always gets the same profile. */
export function profileFor(account, pool) {
  const h = crypto.createHash("sha256").update(account).digest();
  return pool[h.readUInt32BE(0) % pool.length];
}

/** Runs one contested spend through a modelled vault at fund multiple F. */
export function simulate(spend, F, pool) {
  if (!spend.median_earlier_amount || BigInt(spend.median_earlier_amount) === 0n) return null;
  const objectors = [...new Set(spend.rejecters)];
  const absent = Array.from({ length: spend.absent_now_council ?? 0 }, (_, i) => `absent-${i}@${spend.dao}`);
  const members = [...new Set([...spend.approvers, ...objectors, ...absent])];
  const n = BigInt(members.length || 1);
  const start = BigInt(spend.median_earlier_amount) * BigInt(F);
  let fund = start;
  const amount = BigInt(spend.amount);
  // A spend larger than the modelled fund could not have been paid at all; keep it, but note it.
  const s = { id: spend.id, recipient: spend.receiver, token: "Usdc", amount: String(amount) };
  const exits = [];
  for (const m of [...objectors, ...absent]) {
    const rules = profileFor(m, pool);
    const r = evaluate(s, rules, { balances: { near: "0", usdc: String(fund) }, recipientPaidBefore: spend.receiver_paid_before });
    if (r.decision === "exit") {
      const share = start / n; // equal shares: each leaver takes 1/n of the fund as it stood at queue time
      exits.push({ member: m, broken: r.checks.filter((c) => c.broken).map((c) => c.rule) });
      fund -= share;
    }
  }
  const killed = unaffordable(s, { near: "0", usdc: String(fund) });
  return { exits, killed, fund_left: String(fund), over_fund: amount > BigInt(spend.median_earlier_amount) * BigInt(F) };
}

export function run(replay, pool = profiles()) {
  const spends = replay.daos.flatMap((d) => d.contested);
  const groups = { nearweek: (s) => s.dao.startsWith("nearweek-news-contribution"), others: (s) => !s.dao.startsWith("nearweek-news-contribution") };
  const results = [];
  for (const F of FUND_MULTIPLES) {
    const row = { F };
    for (const [g, inGroup] of Object.entries(groups)) {
      const mine = spends.filter(inGroup);
      let judged = 0, anyExit = 0, killed = 0, exits = 0;
      const killedList = [];
      for (const sp of mine) {
        const r = simulate(sp, F, pool);
        if (!r) continue;
        judged++;
        exits += r.exits.length;
        if (r.exits.length) anyExit++;
        if (r.killed) {
          killed++;
          killedList.push({ dao: sp.dao, id: sp.id, amount: sp.amount, token: sp.token, x_median: Number(BigInt(sp.amount) * 100n / BigInt(sp.median_earlier_amount)) / 100, receiver_voted_approve: sp.receiver_voted_approve, exits: r.exits.length });
        }
      }
      row[g] = { spends: mine.length, judged, any_exit: anyExit, exits, killed, killed_list: killedList };
    }
    results.push(row);
  }
  return { total: spends.length, rule_profiles: pool.length, results };
}

function pct(a, b) {
  return b ? `${((100 * a) / b).toFixed(1)}%` : "n/a";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node sim/swarm.js <replay3.json> [--json]");
    process.exit(2);
  }
  const out = run(JSON.parse(fs.readFileSync(file, "utf8")));
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`${out.total} real contested Sputnik transfers, ${out.rule_profiles} distinct agent rule profiles.`);
    console.log(`Fund size is modelled as F x the DAO's median earlier transfer in that token.\n`);
    console.log("F    | group    | judged | >=1 agent left | spend killed");
    for (const r of out.results) {
      for (const g of ["nearweek", "others"]) {
        const x = r[g];
        console.log(`${String(r.F).padEnd(4)} | ${g.padEnd(8)} | ${String(x.judged).padEnd(6)} | ${pct(x.any_exit, x.judged).padEnd(14)} | ${x.killed} (${pct(x.killed, x.judged)})`);
      }
    }
    const f25 = out.results.find((r) => r.F === 25).others.killed_list;
    if (f25.length) {
      console.log(`\nKilled at F=25 outside nearweek:`);
      for (const k of f25) console.log(`  ${k.dao.split(".")[0]} #${k.id}: ${k.x_median}x the DAO's usual size${k.receiver_voted_approve ? ", receiver voted for own payment" : ""}, ${k.exits} exits`);
    }
  }
}
