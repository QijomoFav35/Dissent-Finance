// Every decision, exit or stay, produces a note. Its sha256 goes on chain in exit(reason_hash),
// so anyone holding the published note can check it is the one the agent acted on.

import crypto from "node:crypto";

/** JSON with keys sorted at every level, so the same note always hashes the same. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashNote(note) {
  return crypto.createHash("sha256").update(canonical(note)).digest("hex");
}

export function makeNote({ vault, member, spend, balances, rules, result, approved, at, agent }) {
  return {
    v: 1,
    agent: agent ?? "dissent-exit-agent/0.1.0",
    vault,
    member,
    spend: {
      id: spend.id,
      proposal_id: spend.proposal_id,
      recipient: spend.recipient,
      token: spend.token,
      amount: spend.amount,
      window_ends: spend.window_ends,
    },
    fund: { near: balances.near, usdc: balances.usdc },
    rules: rules ?? null,
    approved_by_member: approved,
    checks: result.checks,
    decision: result.decision,
    at,
  };
}

export function verifyNote(note, reasonHash) {
  return hashNote(note) === reasonHash;
}
