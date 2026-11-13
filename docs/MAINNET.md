# On mainnet: every run, every transaction

[Back to the README](../README.md)

Three live runs on NEAR mainnet with real native USDC, next to one unchanged Sputnik DAO, [dissentfinance.sputnik-dao.near](https://nearblocks.io/address/dissentfinance.sputnik-dao.near). Every transaction the scripts sent is also a line in [`agent/mainnet/evidence.jsonl`](../agent/mainnet/evidence.jsonl), and `node agent/mainnet/verify.mjs` checks the result against the chain.

| Run | Vault | What happened | Key transactions |
|---|---|---|---|
| 1, 11 Nov | v1 `vault.dissentfinance.near` (keyless) | Ben and Cara approve 60% of the fund to Ben; three agents exit, one cancels; Ben gets nothing | [queue](https://nearblocks.io/txns/HkBStJJAqLwADecEu5qnr5F8waPRXPSVzFamXHmJvzL7), [cancel](https://nearblocks.io/txns/EdWntKHfbXwLudqv9ZNMbyEnquCPvpCMVNTVz9knPXvh) |
| 2, 12 Nov | v2 `vault2.dissentfinance.near` | The same story on the reviewed code: queue to cancel in 11.2 s | [queue](https://nearblocks.io/txns/DpKwEZ8L419yKGqnxDrqrv5hQK4UJM7pYCVtEMbAYxwu), [cancel](https://nearblocks.io/txns/4cA4kFtvvuz6bVb5FRjP35Q76sHQKq3hWsabd59xLAAT) |
| 3, 13 Nov | v2, redeployed from `6ae0259` | DAO auto-update turned off; three agents bid 7 times for part of Cara's shares, Dan buys at 95.5% of value; Cara approves a spend and leaves with her part held back; the spend pays | [DAO lock](https://nearblocks.io/txns/C3qanhdzVAaQy2NQVXpmTE1aZ9KCPsoJZtj8rvcr87M4), [offer](https://nearblocks.io/txns/6DxKZ99sg7t84ieVKXA7z9hmvcoPrzpSjjPKrAJvFwFN), [Cara leaves](https://nearblocks.io/txns/53qLDWKV7hAij7P9MeJFRjshBJfeKR8GRaTpsd4ikd6u), [spend pays](https://nearblocks.io/txns/9osUXBVnfdFhMyzKT4xKVKkzFJ56pnwAqoVdRj5kteKX) |

## Run 1: the first vault (v1), 11 November 2026

This first vault, `vault.dissentfinance.near`, runs the code at commit `54ccf1b`, which predates the storage guard, the holder-only approvals, the caps and the other changes described in [HOW-IT-WORKS.md](HOW-IT-WORKS.md). It is keyless, so it can't be upgraded; it stays as the record of the first live run. Its funds have since all been withdrawn by its members. The fixed version runs as v2 (below).

The story ran live on NEAR mainnet on 11 November 2026, scaled down: each member put in 0.1 NEAR and 0.2 USDC (native USDC, `17208628...133a1`), so the vault held 0.5 NEAR and 1 USDC.

| What | Where |
|---|---|
| The DAO, created through the official `sputnik-dao.near` factory, council of the five members, 2 approvals needed | [dissentfinance.sputnik-dao.near](https://nearblocks.io/address/dissentfinance.sputnik-dao.near) |
| The vault, verified and with no access keys | [vault.dissentfinance.near](https://nearblocks.io/address/vault.dissentfinance.near) |
| Members | `alice`, `ben`, `cara`, `dan` and `emma`, each `.dissentfinance.near` |

What happened (the three exits landed before the cancel; the contract refuses a cancel while the spend is still affordable):

| Step | Transaction |
|---|---|
| Ben files proposal 0: 0.6 USDC of the vault's 1 USDC to himself | [4uSodkrW](https://nearblocks.io/txns/4uSodkrWsqQtq1Kpm15X11NQzj7k9h5ESJGXLHEegzSz) |
| Ben approves | [73sYDMhV](https://nearblocks.io/txns/73sYDMhVWQo765hznkCdQzpubSVMgNUDbc98bH7855mj) |
| Cara approves; the DAO calls the vault, which reads the proposal back and queues spend 0 | [HkBStJJA](https://nearblocks.io/txns/HkBStJJAqLwADecEu5qnr5F8waPRXPSVzFamXHmJvzL7) |
| Emma's agent exits (Ben is on her blocked list) | [E44VWZe5](https://nearblocks.io/txns/E44VWZe5r6wozitagvX9tauLKw6JzmFgUBwGCgTJ7Yii) |
| Dan's agent exits (Ben had never been paid by the vault) | [6uKtFnYV](https://nearblocks.io/txns/6uKtFnYVcH9T3UNGZQm45rnHQGZ1SbXxBJb2jXzjTsmP) |
| Alice's agent exits (the spend was 60% of the fund, her limit is 20%) | [7GZAggTS](https://nearblocks.io/txns/7GZAggTS73tcV3ygJT3hzmzWWBrFwgFnVBGXd9GY1RRF) |
| Cara's agent cancels spend 0, now unaffordable | [EdWntKHf](https://nearblocks.io/txns/EdWntKHfbXwLudqv9ZNMbyEnquCPvpCMVNTVz9knPXvh) |

Nobody acted by hand after Cara's vote. By the vault's own timestamps the spend was queued at 21:11:12 UTC, the three exits landed at 21:11:50 and 21:11:51, and the cancel at 21:12:03, 51 seconds after the queue. Most of that time went on the public RPC endpoints rate-limiting the five agents. Afterwards Alice, Dan and Emma each held exactly 0.2 USDC, Ben held none, and the vault held 0.4 USDC and 0.2 NEAR for Ben and Cara. Ben and Cara's agents wrote notes saying stay, since they approved. All five notes are in `agent/mainnet/notes/`, and each exit carries its note's hash on chain.

Ben's agent key was then used to try a USDC `ft_transfer`. The NEAR runtime rejected the transaction before it ran, with `Deposit is not allowed with function call`: a token transfer needs 1 yoctoNEAR attached, and these keys can't attach any, so they can't move tokens at all.

The vault code was then redeployed from a reproducible build of commit `54ccf1b` ([GMcCtwT8](https://nearblocks.io/txns/GMcCtwT8VLZxbKqs2zhDA3m8BX5N7NSNtLEh25oZcz7a)), and its only access key was deleted ([61N8fiHX](https://nearblocks.io/txns/61N8fiHXookvRa6jv7Meo1MUPKSAdLjzX39YjPWE9n5W)). From then on nobody can change its code or move its funds outside the contract's rules. About 2.7 NEAR stays locked in it for its own storage.

Every transaction from setup, including the joins, the rules and the five agent keys, is in `agent/mainnet/evidence.jsonl`.

### Check v1 yourself

With `near` CLI installed, none of these need an account:

```
near contract verify deployed-at vault.dissentfinance.near network-config mainnet now
```

This rebuilds the vault from the commit it names, in the Docker image it names, and should end with `The code obtained from the contract account ID and the code calculated from the repository are the same.` (needs Docker, about 5 minutes).

```
near account view-account-summary vault.dissentfinance.near network-config mainnet now
```

Should show `Account is locked (no access keys)`.

```
near contract call-function as-read-only vault.dissentfinance.near get_spend json-args '{"spend_id":0}' network-config mainnet now
near contract call-function as-read-only vault.dissentfinance.near get_balances json-args '{}' network-config mainnet now
```

Should show spend 0 as `Cancelled`, and (since Ben and Cara later left too) a vault holding 0 USDC with 0 members.

## Runs 2 and 3: v2

`vault2.dissentfinance.near` runs the code described in [HOW-IT-WORKS.md](HOW-IT-WORKS.md), built reproducibly from commit `6ae0259` (code hash `2CkdfmNBiPGukvkBpRm1AygHERiGDdPXf23eXPL58uVM`; `near contract verify deployed-at vault2.dissentfinance.near network-config mainnet now` rebuilds it). It uses the same DAO, [dissentfinance.sputnik-dao.near](https://nearblocks.io/address/dissentfinance.sputnik-dao.near), and the same five members, who each joined with 0.1 NEAR and 0.2 USDC (Ben and Cara first took their 0.2 USDC out of v1 with their v1 agent keys: [A3N4hcUd](https://nearblocks.io/txns/A3N4hcUdexfttBQVedJvZ4ijMwwDiVzwMVJUVGNB3UVQ), [2tYQmA9P](https://nearblocks.io/txns/2tYQmA9PnBD9feRLbCxJy1QpbsNhrGCBmocNcUHSFCtt)).

Before going live, v2 was reviewed three times by an independent reviewer that had not seen it being built. Each review found something (a storage loop through bouncing claims, a transfer check that could count a delivered payment as failed, agent retries that could drain a key's gas allowance, joins with no USDC behind them), and each was fixed and tested before the next step. The vault was deployed while it still had its key, so the last fix went in as a code-only redeploy ([GtacaTNB](https://nearblocks.io/txns/GtacaTNBVg2eD6Go7m8JPmTnuA4KM9CU7p2JjEpzf9Cx)) that kept every member's balance. After the live run below, a fourth review found two more: an exit reason with no length cap, and join share maths that could overflow. Both were fixed and tested in `3f14192` and went in the same way, as a code-only redeploy ([6SKeWDGM](https://nearblocks.io/txns/6SKeWDGMMYGRFvT1Cs5nKJfJ39mQb5m2U3WCkvSuS6fd)) that touched no balance. The share market and held-back exits went in the same way on 13 November, from `6ae0259` ([3sk8on3s](https://nearblocks.io/txns/3sk8on3soYspTR7CpURASBNpxCgGfNvmoNT9vzHMCgNQ)), after `dissentfinance.near` sent the vault 0.3608 NEAR for the larger code's storage ([5sjPXMcj](https://nearblocks.io/txns/5sjPXMcj3mGN7LZCVmaJucXZksJ3iHqCSQoK3se1fixQ)); round 3 below ran on it. v2 still has its full-access key while the last checks run; v1 shows the keyless end state.

The DAO is a stock mainnet Sputnik DAO, so [Trezu](https://trezu.app/dissentfinance.sputnik-dao.near/requests?tab=Approved) lists it like any treasury: both spends appear under Requests, Executed, as `queue_spend` calls on the two vaults, each with 2 approving votes (2 needed) ([screenshot](images/trezu-requests.jpg)).

The same story, live on 12 November 2026:

| Step | Transaction |
|---|---|
| Ben files DAO proposal 1: 0.6 USDC of the vault's 1 USDC to himself | [7eE7dBmf](https://nearblocks.io/txns/7eE7dBmfC5piPPbAoSznGFA5x1hhr97e49k4WcH13v39) |
| Ben approves | [5mdWtmMT](https://nearblocks.io/txns/5mdWtmMTFNvrfaciVcQSdpuNcS2xfBUWnnpAgNsrM9GS) |
| Cara approves; the vault reads the proposal back and queues spend 0 | [DpKwEZ8L](https://nearblocks.io/txns/DpKwEZ8L419yKGqnxDrqrv5hQK4UJM7pYCVtEMbAYxwu) |
| Alice's agent exits (60% of the fund, her limit is 20%) | [CGpp5bJe](https://nearblocks.io/txns/CGpp5bJe2ZB87QZTsnmvN4f28cQsjqS6yoPzzKsQKfKN) |
| Dan's agent exits (Ben had never been paid by v2) | [Msq3yLLH](https://nearblocks.io/txns/Msq3yLLHyQQjYehLowCZJDhQB3u48gAPvhsZrtTkmdg) |
| Emma's agent exits (Ben is on her blocked list) | [GqsAoKSZ](https://nearblocks.io/txns/GqsAoKSZsysmtKKA37Vq5vX3pbsFWgrRMgWkjVWfeTUa) |
| Emma's agent cancels spend 0, now unaffordable | [4cA4kFtv](https://nearblocks.io/txns/4cA4kFtvvuz6bVb5FRjP35Q76sHQKq3hWsabd59xLAAT) |

By the vault's own timestamps the spend was queued at 13:31:09 UTC, the three exits landed at 13:31:17 and 13:31:18, and the cancel at 13:31:21, 11.2 seconds after the queue. Alice, Dan and Emma each got exactly 0.2 USDC back, Ben got nothing, and 0.4 USDC stayed in the vault for Ben and Cara. The exit and cancel transactions above were written to `agent/mainnet/evidence.jsonl` by the story script from the agents' own state files, and the five notes are in `agent/mainnet/notes/vault2/`.

Ben's v2 agent key was then used three ways it should never work, with `agent/mainnet/key-check.mjs`, which records only the runtime's own answer and retries busy RPC endpoints:

| Attempt | NEAR runtime's answer |
|---|---|
| Move USDC (`ft_transfer` on the USDC contract) | `AccessKeyDepositWithFunctionCallActionError: Deposit is not allowed with function call` |
| Call another vault method (`set_rules`) | `AccessKeyMethodNameMismatchActionError: Access key does not allow method set_rules` |
| Attach a deposit to `exit` | `AccessKeyDepositWithFunctionCallActionError: Deposit is not allowed with function call` |

(The story script's own attempt at the first check hit a rate-limited endpoint and recorded that error as a refusal. The evidence file keeps that line and marks it with a correction; the table above comes from `key-check.mjs`.)

### Round 3: the share market and an approver who leaves, 13 November 2026

`agent/mainnet/round3.mjs` ran each stage as a dry run first, printed every cost, then sent it. First the DAO turned off its factory auto-update, so only a council proposal can change its code: Ben filed proposal 2 ([C3qanhdz](https://nearblocks.io/txns/C3qanhdzVAaQy2NQVXpmTE1aZ9KCPsoJZtj8rvcr87M4)) and Ben and Cara approved it ([ECy7Et13](https://nearblocks.io/txns/ECy7Et13jMynfkf34CWjkTfAYuewTdfN37Zk7j8WjSaf), [C6UU1yjP](https://nearblocks.io/txns/C6UU1yjPs885c8on7vEZxuwaf61d3LnCn9pswDJkpxAu)). Then Alice, Dan and Emma joined again with 0.1 USDC each (each attached 0.051 NEAR; the vault kept 0.05 to match the fund and refunded the rest), put 0.1 USDC each into bid funds, and each added a market key that can call only `bid` and `settle_offer`.

| Step | Transaction |
|---|---|
| Alice joins (USDC, then NEAR) | [E5puEVUD](https://nearblocks.io/txns/E5puEVUDZxgwKocr5sVSwYaX8f3hDpGg8EXd5jCPKP9Y), [CjTqZ3ij](https://nearblocks.io/txns/CjTqZ3ijhrwmkLo9FQTKrHw1dJD8PMRth9x9AAQV9r6A) |
| Dan joins | [SoUiKHf6](https://nearblocks.io/txns/SoUiKHf6rbPLX4Lcd9U5NK6bEryi55WHsHMiGeAhb2n), [HPZPMU5M](https://nearblocks.io/txns/HPZPMU5M1w7Vpoc7E2kxS74H8iBVS1mgsz1SKj5wVysm) |
| Emma joins | [EMR9Jepz](https://nearblocks.io/txns/EMR9JepzHATvA1FzfNg8GY2LRbrjBbueEPa1eUAS7arH), [m3VBbweY](https://nearblocks.io/txns/m3VBbweYC743VxbEYLyR5shjwEqk41KEhSPoph2zwJB) |
| Bid funds: Alice, Dan, Emma | [AqXqNhp3](https://nearblocks.io/txns/AqXqNhp3xPWwXV6mJsLwoikBWyikzH34USv5tQEsWuVW), [8zYHmYL5](https://nearblocks.io/txns/8zYHmYL5KqC4NAkAPRxnGAWCXBGVquSpm5CXN6qmneox), [CyQQp5s9](https://nearblocks.io/txns/CyQQp5s966Sbp1JMW2DmCnX6mmJY7KywrBJ5eh3G5EhP) |
| Market keys: Alice, Dan, Emma | [2SC7zmYQ](https://nearblocks.io/txns/2SC7zmYQKCZeHT7Pi5dVXmoott1NmuQbjRipFf26K13H), [3tvfcKje](https://nearblocks.io/txns/3tvfcKjekGWiVELKWb41xVPq5L2quEjmFGVUniP3kQHH), [43pUrSYC](https://nearblocks.io/txns/43pUrSYCkWJyFingP6Ts7qycZg5SCTHKNTVYBP64pnao) |
| Cara offers 16.3% of her shares, worth 0.09 USDC, reserve 0.081 | [6DxKZ99s](https://nearblocks.io/txns/6DxKZ99sg7t84ieVKXA7z9hmvcoPrzpSjjPKrAJvFwFN) |
| Ben proposes 0.07 USDC (10% of the fund) to himself | [Eb1W8TqM](https://nearblocks.io/txns/Eb1W8TqMqq37i46aP53n7A1v97rP56jCAtsczVMnNPsv) |
| Ben and Cara approve; the vault queues spend 1 | [2n5EZm9N](https://nearblocks.io/txns/2n5EZm9NeH4CZaUuojkiv5FouPRmDebaVLEmVaWYQChd), [9MgxBmfv](https://nearblocks.io/txns/9MgxBmfvUvwe5rHET3YPYf9uZTLXJhDYJbG24BxTS61w) |
| Cara, an approver, leaves while spend 1 is open | [53qLDWKV](https://nearblocks.io/txns/53qLDWKV7hAij7P9MeJFRjshBJfeKR8GRaTpsd4ikd6u) |
| Spend 1 pays after its window | [9osUXBVn](https://nearblocks.io/txns/9osUXBVnfdFhMyzKT4xKVKkzFJ56pnwAqoVdRj5kteKX) |

The auction. The NEAR side of Cara's shares was priced at 3.512221 USDC from Ref Finance pool 4512's reserves, read when she made the offer. The three market agents then ran with no one touching them, each re-reading the price at every tick and bidding the least that leads, up to its member's limit: Emma 92% of value (0.0828 USDC), Alice 95% (0.0855), Dan 98% (0.0882). They placed 7 bids in 25 seconds, each 1% above the last; Emma stopped at her limit, then Alice, and Dan led at 0.085979 USDC, 95.5% of the shares' value and one step above Alice's limit, as an English auction should end. After the window an agent settled it with its market key: the shares moved to Dan, 0.085979 USDC went to Cara's wallet, the fund stayed at 0.35 NEAR and 0.7 USDC, and the vault stored the `share_sale`. Every bid and the settle are in `agent/mainnet/evidence.jsonl`, each with the NEAR price that agent read.

The seven bids, in order, each signed by the bidder's market key and priced with the NEAR price that agent read (3.512221 USDC from pool 4512 for all seven):

| Agent | Bid (USDC) | Its limit | Transaction |
|---|---|---|---|
| Alice | 0.080999 | 0.085499 | [EChikqCd](https://nearblocks.io/txns/EChikqCd7ZbLV2dowYnBSiS3SdSv2gUpVvyYAgUkEsba) |
| Dan | 0.081808 | 0.088199 | [CQSAMdzL](https://nearblocks.io/txns/CQSAMdzLSww1GSrGH3Cr8fTuTwVFeq5QYLgjRsXR4RHc) |
| Emma | 0.082626 | 0.082799 | [A1kz1g2i](https://nearblocks.io/txns/A1kz1g2iaUK9fBKuCuyaVZ91BfCqQPwqwL1TnLLWDzGb) |
| Alice | 0.083452 | 0.085499 | [EEYNNBsQ](https://nearblocks.io/txns/EEYNNBsQEpjpNwGSoiYbmmUYBqjMHNfNJcLF88MpuGkW) |
| Dan | 0.084286 | 0.088199 | [JBn5gjU8](https://nearblocks.io/txns/JBn5gjU8HGWXoneadTu5ki8C5s97iwduVmUDBr9dauN8) |
| Alice | 0.085128 | 0.085499 | [DTfDKCM3](https://nearblocks.io/txns/DTfDKCM3f6GvGw7anPAhmRSWDV6doxd32KS7TrMAAYtt) |
| Dan | 0.085979 | 0.088199 | [53pV4pf6](https://nearblocks.io/txns/53pV4pf6bfyCCjvbejj3wTGbxwiW7SxXRVm48nN22pUv) |

Dan's agent settled it after the window: [A1cR7MQV](https://nearblocks.io/txns/A1cR7MQVKxysm1AxbwUU8xAnePaCT3bmCrNBhArXZrmp).


The approver. Cara had approved spend 1, and under the earlier code she could not have left while it was open. She left while it was still open: the vault paid her 0.150593 USDC and all her NEAR, and held back 0.016752 USDC, her 23.9% of the spend's 0.07007 USDC cost with the fee, rounded up. When the spend paid, that held part paid her share of it, so the four members who stayed paid 0.053318 USDC of it: their own share, with the rounding in their favour.

`node agent/mainnet/verify.mjs` read the result at block 224352870: all 22 checks passed, with the vault's remaining full-access key reported as INFO. They include the DAO lock, the market keys, the share sale at or above its reserve and in the record, the held-back money (0 once spend 1 paid), and the USDC contract's balance for the vault covering the fund plus the 0.214021 USDC of bid funds.

The same checks work for v2 without this repo's page:

```
near contract verify deployed-at vault2.dissentfinance.near network-config mainnet now
near contract call-function as-read-only vault2.dissentfinance.near get_spend json-args '{"spend_id":0}' network-config mainnet now
near contract call-function as-read-only vault2.dissentfinance.near get_balances json-args '{}' network-config mainnet now
```

v2 still has its full-access key while it is reviewed once more. Deleting it is the last step.
