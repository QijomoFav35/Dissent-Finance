// Read side of the vault, through public views only.

export class VaultReader {
  /** @param {import("./rpc.js").Rpc} rpc @param {string} vaultId */
  constructor(rpc, vaultId) {
    this.rpc = rpc;
    this.vaultId = vaultId;
  }
  openSpends() {
    return this.rpc.view(this.vaultId, "get_open_spends");
  }
  spend(spendId) {
    return this.rpc.view(this.vaultId, "get_spend", { spend_id: spendId });
  }
  balances() {
    return this.rpc.view(this.vaultId, "get_balances");
  }
  rules(accountId) {
    return this.rpc.view(this.vaultId, "get_rules", { account_id: accountId });
  }
  async shares(accountId) {
    return BigInt(await this.rpc.view(this.vaultId, "get_shares", { account_id: accountId }));
  }
  wasPaid(accountId) {
    return this.rpc.view(this.vaultId, "was_paid", { account_id: accountId });
  }
}
