// The exit rules. Pure and deterministic: given the same spend, rules and fund state, anyone gets the
// same decision. They read only numbers and account ids, never the proposal's text, so a proposal
// description cannot talk an agent out of leaving.

/**
 * @typedef {{ max_spend_share_bps?: number|null, new_recipient?: boolean, blocked_recipients?: string[] }} Rules
 * @typedef {{ id: number, proposal_id: number, recipient: string, token: "Near"|"Usdc", amount: string,
 *             approvers: string[], objectors: string[], window_ends: string, status: string }} Spend
 * @typedef {{ near: string, usdc: string }} FundBalances
 */

/** Share of the fund's balance of the spend's token that the spend takes, in basis points, rounded up. */
export function spendShareBps(spend, balances) {
  const amount = BigInt(spend.amount);
  const balance = BigInt(spend.token === "Near" ? balances.near : balances.usdc);
  if (balance === 0n) return 10_000n * 10n; // nothing left: treat as far above any limit
  return (amount * 10_000n + balance - 1n) / balance;
}

/**
 * Checks one spend against one member's rules.
 * @param {Spend} spend
 * @param {Rules|null} rules
 * @param {{ balances: FundBalances, recipientPaidBefore: boolean }} fund
 * @returns {{ decision: "exit"|"stay", checks: { rule: string, limit: unknown, value: unknown, broken: boolean }[] }}
 */
export function evaluate(spend, rules, fund) {
  const checks = [];
  const r = rules ?? {};

  if (r.max_spend_share_bps != null) {
    const share = spendShareBps(spend, fund.balances);
    checks.push({
      rule: "max_spend_share_bps",
      limit: r.max_spend_share_bps,
      value: Number(share),
      broken: share > BigInt(r.max_spend_share_bps),
    });
  }
  if (r.new_recipient) {
    checks.push({
      rule: "new_recipient",
      limit: "recipient must have been paid by this vault before",
      value: fund.recipientPaidBefore ? "paid before" : "never paid",
      broken: !fund.recipientPaidBefore,
    });
  }
  if (r.blocked_recipients?.length) {
    const blocked = r.blocked_recipients.includes(spend.recipient);
    checks.push({ rule: "blocked_recipients", limit: r.blocked_recipients, value: spend.recipient, broken: blocked });
  }

  return { decision: checks.some((c) => c.broken) ? "exit" : "stay", checks };
}

/** True when the vault can no longer pay the spend plus its 0.1% fee. Mirrors the contract's check. */
export function unaffordable(spend, balances) {
  const amount = BigInt(spend.amount);
  const fee = (amount * 10n) / 10_000n;
  const balance = BigInt(spend.token === "Near" ? balances.near : balances.usdc);
  return amount + fee > balance;
}
