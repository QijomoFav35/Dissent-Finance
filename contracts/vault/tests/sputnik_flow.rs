//! End to end against an unchanged Sputnik DAO: propose, vote in the DAO, the vault checks the
//! DAO's own record, queues the spend, and members who did not approve leave before it pays.

mod common;
use common::*;
use near_sdk::serde_json::{json, Value};

/// The story from the README: Ben and Cara approve 300 of the fund's 500 USDC to Ben.
/// Alice, Dan and Emma leave with their fifth each; the spend can no longer be paid and is cancelled.
#[tokio::test]
async fn collective_cancel_end_to_end() -> R<()> {
    let w = world().await?;
    w.all_join().await?;
    let b = w.balances().await?;
    assert_eq!(u(&b["usdc"]), 500 * USDC);
    assert_eq!(b["members"], 5);

    let ben = id(&w, "ben");
    let args = w.spend_args(w.last_proposal_id().await?, &ben, w.usdc.account_id().as_str(), 300 * USDC);
    let (pid, kind) = w.propose("ben", &args).await?;
    w.vote("ben", pid, &kind, "VoteApprove").await?;
    assert_eq!(w.proposal_status(pid).await?, "InProgress");
    w.vote("cara", pid, &kind, "VoteApprove").await?;
    assert_eq!(w.proposal_status(pid).await?, "Approved");

    let open = w.open_spends().await?;
    assert_eq!(open.len(), 1, "spend should be queued: {open:?}");
    let spend_id = open[0]["id"].as_u64().unwrap();
    assert_eq!(open[0]["approvers"], json!([id(&w, "ben"), id(&w, "cara")]));

    // An approver can leave during the window, but their part of the spend is held back for it.
    let cara = id(&w, "cara");
    let cost = 300 * USDC + 300 * USDC / 1_000;
    let cara_part = cost.div_ceil(5);
    w.call(&cara, &w.vault, "exit", json!({}), 0, 100).await?.assert_success();
    assert_eq!(w.usdc_of(&cara).await?, 100 * USDC - cara_part, "Cara's fifth, less her part of the spend she approved");
    // Nobody can join while a spend is open.
    let late = id(&w, "fee");
    w.call(&late, &w.vault, "join", json!({}), 10u128.pow(24), 100).await?.assert_failure();

    for m in ["alice", "dan", "emma"] {
        let who = id(&w, m);
        w.call(&who, &w.vault, "exit", json!({ "reason_hash": format!("{m}-note") }), 0, 100)
            .await?
            .assert_success();
        assert_eq!(w.usdc_of(&who).await?, 100 * USDC, "{m} gets exactly a fifth of the USDC");
    }
    // Ben's fifth is all that is free; Cara's part is held for the spend.
    assert_eq!(u(&w.balances().await?["usdc"]), 100 * USDC + cara_part);

    // Too early to execute, and once the window is over it is unaffordable.
    w.call(&ben, &w.vault, "execute_spend", json!({ "spend_id": spend_id }), 0, 100).await?.assert_failure();
    w.wait_out_window().await?;
    w.call(&ben, &w.vault, "execute_spend", json!({ "spend_id": spend_id }), 0, 100).await?.assert_failure();
    w.call(&id(&w, "emma"), &w.vault, "cancel_spend", json!({ "spend_id": spend_id }), 0, 50).await?.assert_success();

    let spend: near_sdk::serde_json::Value = w.view(&w.vault, "get_spend", json!({ "spend_id": spend_id })).await?;
    assert_eq!(spend["status"], "Cancelled");
    assert_eq!(w.usdc_of(&ben).await?, 0, "Ben received nothing");

    // The spend never paid, so what was held back for it goes back to Cara.
    let claim: near_sdk::serde_json::Value = w.view(&w.vault, "get_claimable", json!({ "account_id": cara })).await?;
    assert_eq!(u(&claim[1]), cara_part);
    w.call(&cara, &w.vault, "claim", json!({ "token": "Usdc" }), 0, 100).await?.assert_success();
    assert_eq!(w.usdc_of(&cara).await?, 100 * USDC, "Cara ends with her whole fifth");

    // With the spend gone, the last approver leaves with what remains.
    w.call(&ben, &w.vault, "exit", json!({}), 0, 100).await?.assert_success();
    assert_eq!(w.usdc_of(&ben).await?, 100 * USDC);

    assert_books(&w.ledger("Usdc").await?);
    assert_books(&w.ledger("Near").await?);
    Ok(())
}

/// A spend nobody objects to pays after its window, with the 0.1% fee.
#[tokio::test]
async fn approved_spend_pays_after_the_window() -> R<()> {
    let w = world().await?;
    w.all_join().await?;
    let args = w.spend_args(w.last_proposal_id().await?, &w.shop, w.usdc.account_id().as_str(), 50 * USDC);
    let (pid, kind) = w.propose("alice", &args).await?;
    w.vote("alice", pid, &kind, "VoteApprove").await?;
    w.vote("ben", pid, &kind, "VoteApprove").await?;
    let spend_id = w.open_spends().await?[0]["id"].as_u64().unwrap();

    w.wait_out_window().await?;
    w.call(&id(&w, "cara"), &w.vault, "execute_spend", json!({ "spend_id": spend_id }), 0, 100)
        .await?
        .assert_success();
    assert_eq!(w.usdc_of(&w.shop).await?, 50 * USDC);
    assert_eq!(w.usdc_of(&w.fee).await?, 50_000);
    assert_eq!(u(&w.balances().await?["usdc"]), 500 * USDC - 50 * USDC - 50_000);
    let paid: bool = w.view(&w.vault, "was_paid", json!({ "account_id": w.shop })).await?;
    assert!(paid);
    // Executing twice fails.
    w.call(&id(&w, "cara"), &w.vault, "execute_spend", json!({ "spend_id": spend_id }), 0, 100)
        .await?
        .assert_failure();
    assert_books(&w.ledger("Usdc").await?);
    Ok(())
}

/// A NEAR spend goes through the same path.
#[tokio::test]
async fn near_spend_pays_after_the_window() -> R<()> {
    let w = world().await?;
    w.all_join().await?;
    let amount = 2 * 10u128.pow(24);
    let args = w.spend_args(w.last_proposal_id().await?, &w.shop, "near", amount);
    let (pid, kind) = w.propose("alice", &args).await?;
    w.vote("alice", pid, &kind, "VoteApprove").await?;
    w.vote("ben", pid, &kind, "VoteApprove").await?;
    let spend_id = w.open_spends().await?[0]["id"].as_u64().unwrap();
    w.wait_out_window().await?;
    let before = w.near_of(&w.shop).await?;
    w.call(&id(&w, "cara"), &w.vault, "execute_spend", json!({ "spend_id": spend_id }), 0, 100)
        .await?
        .assert_success();
    assert_eq!(w.near_of(&w.shop).await? - before, amount);
    assert_books(&w.ledger("Near").await?);
    Ok(())
}

/// The vault refuses a call whose args do not match the DAO's record, and Sputnik marks the proposal Failed.
#[tokio::test]
async fn mismatched_proposal_is_refused_and_marked_failed() -> R<()> {
    let w = world().await?;
    w.all_join().await?;
    // Args name the wrong proposal id, so the DAO's record for that id does not match.
    let wrong_id = w.last_proposal_id().await? + 5;
    let args = w.spend_args(wrong_id, &id(&w, "ben"), w.usdc.account_id().as_str(), 300 * USDC);
    let (pid, kind) = w.propose("ben", &args).await?;
    w.vote("ben", pid, &kind, "VoteApprove").await?;
    w.vote("cara", pid, &kind, "VoteApprove").await?;
    assert_eq!(w.proposal_status(pid).await?, "Failed");
    assert!(w.open_spends().await?.is_empty());
    Ok(())
}

/// Nobody but the DAO can queue a spend, even with arguments copied from a real proposal.
#[tokio::test]
async fn only_the_dao_can_queue() -> R<()> {
    let w = world().await?;
    w.all_join().await?;
    let ben = id(&w, "ben");
    let args = w.spend_args(w.last_proposal_id().await?, &ben, w.usdc.account_id().as_str(), 300 * USDC);
    let (pid, kind) = w.propose("ben", &args).await?;
    w.vote("ben", pid, &kind, "VoteApprove").await?;
    let direct: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(&args)?;
    w.call(&ben, &w.vault, "queue_spend", direct, 0, 100).await?.assert_failure();
    assert!(w.open_spends().await?.is_empty());
    Ok(())
}

/// A member with no USDC storage still exits: their USDC waits as claimable until they register.
#[tokio::test]
async fn exit_without_usdc_storage_becomes_claimable() -> R<()> {
    let w = world().await?;
    w.all_join().await?;
    let alice = id(&w, "alice");
    w.call(&alice, &w.usdc, "storage_unregister", json!({ "force": true }), 1, 30).await?.assert_success();
    w.call(&alice, &w.vault, "exit", json!({}), 0, 100).await?.assert_success();
    let (_near, usdc): (near_sdk::json_types::U128, near_sdk::json_types::U128) =
        w.view(&w.vault, "get_claimable", json!({ "account_id": alice })).await?;
    assert_eq!(usdc.0, 100 * USDC);

    w.call(&alice, &w.usdc, "storage_deposit", json!({}), 12_500_000_000_000_000_000_000, 30).await?.assert_success();
    w.call(&alice, &w.vault, "claim", json!({ "token": "Usdc" }), 0, 100).await?.assert_success();
    assert_eq!(w.usdc_of(&alice).await?, 100 * USDC);
    assert_books(&w.ledger("Usdc").await?);
    Ok(())
}

/// Only accounts in one of the DAO's member groups can hold shares. Anyone else gets their NEAR back
/// and can withdraw their pending USDC.
#[tokio::test]
async fn non_member_join_is_refunded() -> R<()> {
    let w = world().await?;
    w.all_join().await?;
    let outsider = w.shop.clone();
    w.call(&outsider, &w.usdc, "mint", json!({ "amount": near_sdk::json_types::U128(100 * USDC) }), 0, 30).await?.assert_success();
    w.call(
        &outsider,
        &w.usdc,
        "ft_transfer_call",
        json!({ "receiver_id": w.vault.account_id(), "amount": near_sdk::json_types::U128(100 * USDC), "msg": "join" }),
        1,
        100,
    )
    .await?
    .assert_success();
    let before = w.near_of(&outsider).await?;
    w.call(&outsider, &w.vault, "join", json!({}), 10u128.pow(24), 150).await?.assert_success();
    let shares: near_sdk::json_types::U128 = w.view(&w.vault, "get_shares", json!({ "account_id": outsider })).await?;
    assert_eq!(shares.0, 0);
    // The 1 NEAR came back; only gas was spent.
    let after = w.near_of(&outsider).await?;
    assert!(before - after < 10u128.pow(23), "NEAR not refunded: before {before}, after {after}");

    w.call(&outsider, &w.vault, "cancel_join", json!({}), 0, 100).await?.assert_success();
    assert_eq!(w.usdc_of(&outsider).await?, 100 * USDC);
    assert_eq!(w.balances().await?["members"], 5);
    assert_books(&w.ledger("Usdc").await?);
    assert_books(&w.ledger("Near").await?);
    Ok(())
}

/// The agent's key: added by the member to their own account, limited to the vault's exit and
/// cancel_spend methods, with no way to attach a deposit. The runtime itself refuses anything else,
/// before the transaction is ever included.
#[tokio::test]
async fn agent_key_can_only_exit_or_cancel() -> R<()> {
    use near_api::types::transaction::actions::{AccessKeyPermission, FunctionCallPermission};
    let w = world().await?;
    w.all_join().await?;
    let alice = id(&w, "alice");

    let agent_key = near_api::signer::generate_secret_key()?;
    near_api::Account(alice.clone())
        .add_key(
            AccessKeyPermission::FunctionCall(FunctionCallPermission {
                allowance: Some(near_api::NearToken::from_millinear(250)),
                receiver_id: w.vault.account_id().to_string(),
                method_names: vec!["exit".into(), "cancel_spend".into()],
            }),
            agent_key.public_key(),
        )
        .with_signer(w.signer.clone())
        .send_to(&w.net)
        .await?
        .assert_success();
    let agent = near_api::Signer::from_secret_key(agent_key)?;
    let with_agent = |contract: &near_api::Contract, method: &str, args: near_sdk::serde_json::Value, deposit: u128| {
        contract
            .call_function(method, args)
            .transaction()
            .deposit(near_api::NearToken::from_yoctonear(deposit))
            .gas(near_api::NearGas::from_tgas(100))
            .with_signer(alice.clone(), agent.clone())
    };

    // Another contract: refused by the runtime.
    let r = with_agent(&w.usdc, "ft_transfer", json!({ "receiver_id": id(&w, "ben"), "amount": "1" }), 1).send_to(&w.net).await;
    assert_key_refused(r, "a call to another contract");
    // Another method on the vault: refused.
    let r = with_agent(&w.vault, "set_rules", json!({ "rules": { "max_spend_share_bps": null, "new_recipient": false, "blocked_recipients": [] } }), 0)
        .send_to(&w.net)
        .await;
    assert_key_refused(r, "a method outside its list");
    // An allowed method with a deposit attached: refused.
    let r = with_agent(&w.vault, "exit", json!({}), 1).send_to(&w.net).await;
    assert_key_refused(r, "an attached deposit");
    assert_eq!(w.usdc_of(&alice).await?, 0, "nothing moved yet");

    // The one thing it is for: exit, paying only Alice.
    with_agent(&w.vault, "exit", json!({ "reason_hash": "note-sha256" }), 0).send_to(&w.net).await?.assert_success();
    assert_eq!(w.usdc_of(&alice).await?, 100 * USDC);
    let shares: near_sdk::json_types::U128 = w.view(&w.vault, "get_shares", json!({ "account_id": alice })).await?;
    assert_eq!(shares.0, 0);
    Ok(())
}

/// The members turn off the factory's auto-update with one ordinary proposal, the same one the
/// mainnet DAO passes (agent/mainnet/lock-dao.mjs), so nobody outside the council can replace the
/// DAO's code.
#[tokio::test]
async fn members_turn_off_the_factorys_auto_update() -> R<()> {
    let w = world().await?;
    let info: Value = w.view(&w.dao, "get_factory_info", json!({})).await?;
    assert_eq!(info["auto_update"], true, "a new DAO lets its factory update it");
    let kind = json!({ "FactoryInfoUpdate": { "factory_info": { "factory_id": info["factory_id"], "auto_update": false } } });
    let pid = w.last_proposal_id().await?;
    w.call(&id(&w, "ben"), &w.dao, "add_proposal", json!({ "proposal": { "description": "turn off factory auto-update", "kind": kind } }), PROPOSAL_BOND, 100)
        .await?
        .assert_success();
    w.vote("ben", pid, &kind, "VoteApprove").await?;
    w.vote("cara", pid, &kind, "VoteApprove").await?;
    assert_eq!(w.proposal_status(pid).await?, "Approved");
    let info: Value = w.view(&w.dao, "get_factory_info", json!({})).await?;
    assert_eq!(info["auto_update"], false);
    Ok(())
}

/// The share market end to end with the real token: Dan and Emma put bid funds in, Alice offers
/// half her shares, their market keys bid and settle with no deposit, Emma wins, Alice is paid in
/// USDC, and the fund itself never moves.
#[tokio::test]
async fn share_market_with_agent_keys() -> R<()> {
    use near_api::types::transaction::actions::{AccessKeyPermission, FunctionCallPermission};
    let w = world().await?;
    w.all_join().await?;
    let market_methods: Vec<String> = ["bid", "settle_offer"].iter().map(|m| m.to_string()).collect();
    let mut keys = std::collections::HashMap::new();
    for m in ["alice", "dan", "emma"] {
        let who = id(&w, m);
        let key = near_api::signer::generate_secret_key()?;
        near_api::Account(who.clone())
            .add_key(
                AccessKeyPermission::FunctionCall(FunctionCallPermission {
                    allowance: Some(near_api::NearToken::from_millinear(250)),
                    receiver_id: w.vault.account_id().to_string(),
                    method_names: market_methods.clone(),
                }),
                key.public_key(),
            )
            .with_signer(w.signer.clone())
            .send_to(&w.net)
            .await?
            .assert_success();
        keys.insert(m, near_api::Signer::from_secret_key(key)?);
    }
    let market = |m: &str, method: &str, args: Value| {
        w.vault
            .call_function(method, args)
            .transaction()
            .gas(near_api::NearGas::from_tgas(100))
            .with_signer(id(&w, m), keys[m].clone())
    };
    for m in ["dan", "emma"] {
        let who = id(&w, m);
        w.call(&who, &w.usdc, "mint", json!({ "amount": near_sdk::json_types::U128(60 * USDC) }), 0, 30).await?.assert_success();
        w.call(&who, &w.usdc, "ft_transfer_call", json!({ "receiver_id": w.vault.account_id(), "amount": near_sdk::json_types::U128(60 * USDC), "msg": "bid_funds" }), 1, 100)
            .await?
            .assert_success();
        let funds: near_sdk::json_types::U128 = w.view(&w.vault, "get_bid_funds", json!({ "account_id": who })).await?;
        assert_eq!(funds.0, 60 * USDC);
    }
    let alice = id(&w, "alice");
    let shares: near_sdk::json_types::U128 = w.view(&w.vault, "get_shares", json!({ "account_id": alice })).await?;
    let half = shares.0 / 2;
    // A market key cannot offer its member's shares; offering takes the member's own key.
    let r = market("alice", "offer_shares", json!({ "shares": half.to_string(), "reserve": "1" })).send_to(&w.net).await;
    assert_key_refused(r, "offer_shares with a market key");
    w.call(&alice, &w.vault, "offer_shares", json!({ "shares": half.to_string(), "reserve": (45 * USDC).to_string() }), 0, 100).await?.assert_success();
    market("dan", "bid", json!({ "offer_id": 0, "amount": (46 * USDC).to_string() })).send_to(&w.net).await?.assert_success();
    market("emma", "bid", json!({ "offer_id": 0, "amount": (48 * USDC).to_string() })).send_to(&w.net).await?.assert_success();
    // A market key cannot exit.
    let r = market("dan", "exit", json!({})).send_to(&w.net).await;
    assert_key_refused(r, "exit with a market key");

    w.wait_out_window().await?;
    market("emma", "settle_offer", json!({ "offer_id": 0 })).send_to(&w.net).await?.assert_success();
    let offer: Value = w.view(&w.vault, "get_offer", json!({ "offer_id": 0 })).await?;
    assert_eq!(offer["status"], "Sold");
    assert_eq!(w.usdc_of(&alice).await?, 48 * USDC, "Alice is paid Emma's bid");
    let left: near_sdk::json_types::U128 = w.view(&w.vault, "get_shares", json!({ "account_id": alice })).await?;
    assert_eq!(left.0, shares.0 - half);
    assert_eq!(u(&w.balances().await?["usdc"]), 500 * USDC, "the fund never moved");
    // Dan, outbid, takes his funds back with his own key.
    let dan = id(&w, "dan");
    w.call(&dan, &w.vault, "withdraw_bid_funds", json!({ "amount": (60 * USDC).to_string() }), 0, 100).await?.assert_success();
    assert_eq!(w.usdc_of(&dan).await?, 60 * USDC);
    assert_books(&w.ledger("Usdc").await?);
    Ok(())
}

/// The runtime must refuse the transaction because of the key's limits, not for some other reason
/// such as a network error.
fn assert_key_refused<T: std::fmt::Debug, E: std::fmt::Debug>(r: Result<T, E>, what: &str) {
    let err = format!("{:?}", r.expect_err(&format!("the agent key was allowed {what}")));
    println!("refused {what}: {}", &err[..err.len().min(200)]);
    // The sandbox reports these as InvalidTransaction with no detail; a network or RPC failure is a
    // different error, so this still tells a refusal by the key's limits apart from a broken connection.
    assert!(
        ["InvalidTransaction", "AccessKey", "Mismatch", "Deposit"].iter().any(|k| err.contains(k)),
        "refused {what}, but not by the key's limits: {err}"
    );
}
