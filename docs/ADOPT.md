# Adding Dissent Finance to a DAO you already run

[Back to the README](../README.md)

This adds Dissent Finance to a Sputnik DAO that already exists. The DAO keeps its members, roles, policy and votes. Only the money you want protected moves into the vault. This is the same sequence the mainnet vaults went through; `agent/mainnet/setup.mjs` scripts it end to end for the demo DAO and can be read as a worked example.

## 1. Create and deploy the vault

1. Create a new account for it, for example `vault.yourdao.near`.
2. Fund the account so it can pay for its own storage: about 3.4 NEAR in all. That is about 3.1 NEAR for the 306 KB contract and its first state, and a reserve of 0.25 NEAR so exits and cancels always have room.
3. Deploy the reproducible build and initialise it in the same transaction. Build it yourself with `cargo near build reproducible-wasm` in `contracts/vault`, and check that it hashes to the code hash in JUDGE.md (`2CkdfmNB...` for commit `6ae0259`).

   ```
   near contract deploy vault.yourdao.near use-file vault.wasm with-init-call new json-args '{
     "dao": "yourdao.sputnik-dao.near",
     "usdc": "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
     "fee_account": "yourdao.near",
     "window_ns": "86400000000000"
   }' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config mainnet sign-with-legacy-keychain send
   ```

4. Register the vault on the USDC contract, so it can receive USDC. Without this, the first USDC sent to it fails:

   ```
   near contract call-function as-transaction 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 storage_deposit json-args '{"account_id":"vault.yourdao.near","registration_only":true}' prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as yourdao.near network-config mainnet sign-with-legacy-keychain send
   ```

These settings are fixed at creation:
- **`window_ns`:** how long every spend waits, so how long members have to leave. The example is one day. The mainnet demo vaults use 10 minutes so a whole cycle can be watched.
- **`fee_account`:** receives 0.1% of every spend that pays.

## 2. Members join

Only accounts in one of the DAO's role groups can join: the vault reads the DAO's policy to check. Someone who is not in a role yet needs a DAO proposal (`AddMemberToRole`) first. Each member should also have a USDC storage registration of their own (`storage_deposit`, as above, with their account); without one, the USDC from their exit waits in the vault as claimable until they register and call `claim`.

First they send USDC with `ft_transfer_call`:

```
near contract call-function as-transaction 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 ft_transfer_call json-args '{"receiver_id":"vault.yourdao.near","amount":"1000000","msg":"join"}' prepaid-gas '60 Tgas' attached-deposit '1 yoctoNEAR' sign-as alice.near network-config mainnet sign-with-legacy-keychain send
```

Then they call `join` with NEAR attached, in the fund's ratio of NEAR to USDC (`get_balances` shows it):

```
near contract call-function as-transaction vault.yourdao.near join json-args '{}' prepaid-gas '100 Tgas' attached-deposit '0.5 NEAR' sign-as alice.near network-config mainnet sign-with-legacy-keychain send
```

Shares are issued at the fund's current ratio, and any extra is refunded. The first member sets the ratio. `get_balances` shows the fund. Each member then sets their exit rules with `set_rules`: the largest share of the fund one spend may take, whether the receiver must have been paid before, and blocked receivers.

## 3. Give each member's agent a key that can only take them out

Each member adds a function-call key to their own account. Its receiver is the vault, its methods are only `exit` and `cancel_spend`, and it has a gas allowance of about 0.25 NEAR. With near-cli this is close to the following (check the flags with `near account add-key --help` for your version; `agent/mainnet/setup.mjs` adds the same key with near-api-js):

```
near account add-key alice.near grant-function-call-access --allowance '0.25 NEAR' --contract-account-id vault.yourdao.near --function-names 'exit, cancel_spend' autogenerate-new-keypair save-to-legacy-keychain network-config mainnet sign-with-legacy-keychain send
```

The agent runs on that key alone:

```
node agent/src/watch.js agent.config.json --member alice.near
```

Copy the config from `agent/agent.config.example.json`. Before starting, the guard (`agent/mainnet/guard.mjs`) reads the key from chain and refuses it if it can do anything more.

## 4. Spend from the vault through the DAO

A spend is an ordinary DAO proposal: a `FunctionCall` to the vault's `queue_spend`.

```json
{
  "proposal": {
    "description": "pay the designer",
    "kind": { "FunctionCall": {
      "receiver_id": "vault.yourdao.near",
      "actions": [{
        "method_name": "queue_spend",
        "args": "<base64 of {\"proposal_id\":N,\"recipient\":\"designer.near\",\"token_id\":\"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1\",\"amount\":\"250000000\",\"memo\":\"logo\"}>",
        "deposit": "0",
        "gas": "60000000000000"
      }]
    }}
  }
}
```

`proposal_id` must be the id the DAO will give this proposal: `get_last_proposal_id` read just before filing. When the proposal passes, the vault reads it back from the DAO, checks the arguments byte for byte, and starts the window. Members who did not approve can leave during the window. After it, anyone calls `execute_spend`, or `cancel_spend` if the vault can no longer pay. `agent/mainnet/story.mjs` files one of these from start to finish.

## 5. Lock it down

1. **Turn off the DAO's factory auto-update** with a `FactoryInfoUpdate` proposal:

   ```json
   { "FactoryInfoUpdate": { "factory_info": { "factory_id": "sputnik-dao.near", "auto_update": false } } }
   ```

   After that, only a passed council proposal can change the DAO's code. While it is on, the factory can push new DAO code that deploys after two weeks unless the council rejects it.

2. **Delete the vault account's full-access key.** From then on nobody can change the vault's code or move its funds outside its rules.

3. **Check the result.** `agent/mainnet/verify.mjs` is written for the demo vaults: the account names at its top and the live story it replays. Its checks are the list to run on yours: the code hash, no access keys, the DAO's code and auto-update, agent keys limited to their methods, and the books.

## Costs and the business model

| What | Cost |
|---|---|
| The vault's storage | About 3.4 NEAR, paid once and kept in the vault account |
| Each agent key | Under 0.001 NEAR of storage, plus the gas it burns, capped by its allowance |
| Every spend that pays | A 0.1% fee to `fee_account` |

Members never pay to leave.

For the demo DAO the fee goes to `dissentfinance.near`. A DAO that runs its own vault can point the fee at its own treasury, or at whoever runs its agents for it. The fee is the only revenue the contract has, and it is visible in `get_ledger`.
