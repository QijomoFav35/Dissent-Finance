// Write side: signs exit and cancel_spend with the member's function-call key.
// The key is added by the member to their own account with receiver = the vault and
// method_names = ["exit", "cancel_spend"]. The NEAR runtime refuses anything else signed with it,
// and it cannot attach a deposit, so the worst a leaked key can do is make its owner leave with
// their own money.

import { Account, FailoverRpcProvider, JsonRpcProvider, teraToGas } from "near-api-js";

export const AGENT_METHODS = ["exit", "cancel_spend"];
// A second, separate key per member for the share market. It can bid from the member's bid funds
// (already inside the vault) and settle auctions that have ended. It cannot exit, offer the member's
// shares or withdraw bid funds: selling shares takes the member's own key, so a leaked market key
// can at worst win an auction at no more than the member's bid funds.
export const MARKET_METHODS = ["bid", "settle_offer"];

export class KeyCaller {
  /**
   * @param {{ accountId: string, secretKey: string, rpcUrls: string[], vaultId: string }} cfg
   */
  constructor({ accountId, secretKey, rpcUrls, vaultId, methods = AGENT_METHODS }) {
    if (!secretKey?.startsWith("ed25519:")) throw new Error(`no ed25519 key for ${accountId}`);
    this.vaultId = vaultId;
    this.methods = methods;
    // If one endpoint fails, the same signed transaction goes to the next, so an exit is never sent twice.
    const provider = new FailoverRpcProvider(rpcUrls.map((url) => new JsonRpcProvider({ url })));
    this.account = new Account(accountId, provider, secretKey);
  }

  async call(methodName, args, tgas) {
    if (!this.methods.includes(methodName)) throw new Error(`this key cannot call ${methodName}`);
    const outcome = await this.account.callFunctionRaw({
      contractId: this.vaultId,
      methodName,
      args,
      gas: teraToGas(tgas),
      deposit: 0n,
    });
    const hash = outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id;
    const status = outcome?.status ?? outcome?.final_execution_status;
    const failure = status && typeof status === "object" && "Failure" in status ? status.Failure : null;
    return { hash, ok: !failure, failure };
  }

  exit(reasonHash) {
    // exit starts a NEAR transfer and a USDC transfer, each with a callback: 40 Tgas attached, plus its own work.
    return this.call("exit", { reason_hash: reasonHash }, 80);
  }

  cancelSpend(spendId) {
    return this.call("cancel_spend", { spend_id: spendId }, 30);
  }

  bid(offerId, amount) {
    return this.call("bid", { offer_id: offerId, amount: String(amount) }, 30);
  }

  settleOffer(offerId) {
    // A sale sends the seller's USDC with a callback.
    return this.call("settle_offer", { offer_id: offerId }, 60);
  }

}
