// Write side: signs exit and cancel_spend with the member's function-call key.
// The key is added by the member to their own account with receiver = the vault and
// method_names = ["exit", "cancel_spend"]. The NEAR runtime refuses anything else signed with it,
// and it cannot attach a deposit, so the worst a leaked key can do is make its owner leave with
// their own money.

import { Account, FailoverRpcProvider, JsonRpcProvider, teraToGas } from "near-api-js";

export const AGENT_METHODS = ["exit", "cancel_spend"];

export class KeyCaller {
  /**
   * @param {{ accountId: string, secretKey: string, rpcUrls: string[], vaultId: string }} cfg
   */
  constructor({ accountId, secretKey, rpcUrls, vaultId }) {
    if (!secretKey?.startsWith("ed25519:")) throw new Error(`no ed25519 key for ${accountId}`);
    this.vaultId = vaultId;
    // If one endpoint fails, the same signed transaction goes to the next, so an exit is never sent twice.
    const provider = new FailoverRpcProvider(rpcUrls.map((url) => new JsonRpcProvider({ url })));
    this.account = new Account(accountId, provider, secretKey);
  }

  async call(methodName, args, tgas) {
    if (!AGENT_METHODS.includes(methodName)) throw new Error(`agent key cannot call ${methodName}`);
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
}
