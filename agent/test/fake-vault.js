// An in-memory vault with the contract's exit and cancel rules, for testing the agent without a chain.

export class FakeVault {
  constructor({ near, usdc, members }) {
    this.near = BigInt(near);
    this.usdc = BigInt(usdc);
    this.holdings = new Map(members.map(([a, s]) => [a, BigInt(s)]));
    this.total = [...this.holdings.values()].reduce((a, b) => a + b, 0n);
    this.spends = [];
    this.rulesOf = new Map();
    this.paid = new Set();
    this.calls = [];
  }

  queue({ recipient, token, amount, approvers, objectors = [] }) {
    const id = this.spends.length;
    this.spends.push({
      id,
      proposal_id: id,
      recipient,
      token,
      amount: String(amount),
      memo: "",
      approvers,
      objectors,
      queued_at: "0",
      window_ends: "600000000000",
      status: "Queued",
    });
    return id;
  }

  // ----- reader interface -----
  async openSpends() {
    return this.spends.filter((s) => s.status === "Queued").map((s) => structuredClone(s));
  }
  async balances() {
    return { near: String(this.near), usdc: String(this.usdc), total_shares: String(this.total) };
  }
  async rules(a) {
    return this.rulesOf.get(a) ?? null;
  }
  async shares(a) {
    return this.holdings.get(a) ?? 0n;
  }
  async wasPaid(a) {
    return this.paid.has(a);
  }

  // ----- what a member's limited key may call -----
  callerFor(account, { failTimes = 0 } = {}) {
    let failures = failTimes;
    return {
      exit: async (reasonHash) => {
        this.calls.push({ account, method: "exit", reasonHash });
        if (failures > 0) {
          failures--;
          throw new Error("RPC unavailable");
        }
        return this.exit(account);
      },
      cancelSpend: async (id) => {
        this.calls.push({ account, method: "cancel_spend", id });
        return this.cancel(id);
      },
    };
  }

  exit(account) {
    const s = this.holdings.get(account) ?? 0n;
    if (s === 0n) return { ok: false, failure: "ERR_NO_SHARES" };
    // Like the vault: an approver can leave, but their part of each open spend they approved stays
    // behind for it (rounded up). The fake keeps it in the balance; the real vault also ring-fences it.
    let n = (this.near * s) / this.total;
    let u = (this.usdc * s) / this.total;
    for (const sp of this.spends) {
      if (sp.status !== "Queued" || !sp.approvers.includes(account)) continue;
      const cost = BigInt(sp.amount) + (BigInt(sp.amount) * 10n) / 10_000n;
      const part = (cost * s + this.total - 1n) / this.total;
      if (sp.token === "Near") n -= part < n ? part : n;
      else u -= part < u ? part : u;
    }
    this.near -= n;
    this.usdc -= u;
    this.total -= s;
    this.holdings.delete(account);
    return { ok: true, hash: `tx-exit-${account}` };
  }

  cancel(id) {
    const sp = this.spends[id];
    const amount = BigInt(sp.amount);
    const bal = sp.token === "Near" ? this.near : this.usdc;
    if (sp.status !== "Queued") return { ok: false, failure: "ERR_ALREADY_EXECUTED" };
    if (amount + (amount * 10n) / 10_000n <= bal) return { ok: false, failure: "ERR_SPEND_AFFORDABLE" };
    sp.status = "Cancelled";
    return { ok: true, hash: `tx-cancel-${id}` };
  }
}

export const USDC = 1_000_000n;
export const NEAR = 10n ** 24n;
