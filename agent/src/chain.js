// Write side: signs exit and cancel_spend with the member's function-call key.
// The key is added by the member to their own account with receiver = the vault and
// method_names = ["exit", "cancel_spend"]. The NEAR runtime refuses anything else signed with it,
// and it cannot attach a deposit, so the worst a leaked key can do is make its owner leave with
// their own money.

import { Account, JsonRpcProvider, teraToGas } from "near-api-js";

export const AGENT_METHODS = ["exit", "cancel_spend"];

export class KeyCaller {
  /**
   * @param {{ accountId: string, secretKey: string, rpcUrl: string, vaultId: string }} cfg
   */
  constructor({ accountId, secretKey, rpcUrl, vaultId }) {
    if (!secretKey?.startsWith("ed25519:")) throw new Error(`no ed25519 key for ${accountId}`);
    this.vaultId = vaultId;
    this.account = new Account(accountId, new JsonRpcProvider({ url: rpcUrl }), secretKey);
  }

  async call(methodName, args) {
    if (!AGENT_METHODS.includes(methodName)) throw new Error(`agent key cannot call ${methodName}`);
    const outcome = await this.account.callFunctionRaw({
      contractId: this.vaultId,
      methodName,
      args,
      gas: teraToGas(100),
      deposit: 0n,
    });
    const hash = outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id;
    const status = outcome?.status ?? outcome?.final_execution_status;
    const failure = status && typeof status === "object" && "Failure" in status ? status.Failure : null;
    return { hash, ok: !failure, failure };
  }

  exit(reasonHash) {
    return this.call("exit", { reason_hash: reasonHash });
  }

  cancelSpend(spendId) {
    return this.call("cancel_spend", { spend_id: spendId });
  }
}
