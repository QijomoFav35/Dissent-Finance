//! End to end against an unchanged Sputnik DAO: propose, vote in the DAO, the vault checks the
//! DAO's own record, queues the spend, and members who did not approve leave before it pays.

mod common;
use common::*;
use near_sdk::serde_json::json;

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

    // An approver cannot leave while their spend is open.
    w.call(&id(&w, "cara"), &w.vault, "exit", json!({}), 0, 100).await?.assert_failure();
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
    assert_eq!(u(&w.balances().await?["usdc"]), 200 * USDC);

    // Too early to execute, and once the window is over it is unaffordable.
    w.call(&ben, &w.vault, "execute_spend", json!({ "spend_id": spend_id }), 0, 100).await?.assert_failure();
    w.wait_out_window().await?;
    w.call(&ben, &w.vault, "execute_spend", json!({ "spend_id": spend_id }), 0, 100).await?.assert_failure();
    w.call(&id(&w, "emma"), &w.vault, "cancel_spend", json!({ "spend_id": spend_id }), 0, 50).await?.assert_success();

    let spend: near_sdk::serde_json::Value = w.view(&w.vault, "get_spend", json!({ "spend_id": spend_id })).await?;
    assert_eq!(spend["status"], "Cancelled");
    assert_eq!(w.usdc_of(&ben).await?, 0, "Ben received nothing");

    // With the spend gone, the approvers can leave with what remains.
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
    assert!(r.is_err(), "the key moved tokens on another contract");
    // Another method on the vault: refused.
    let r = with_agent(&w.vault, "set_rules", json!({ "rules": { "max_spend_share_bps": null, "new_recipient": false, "blocked_recipients": [] } }), 0)
        .send_to(&w.net)
        .await;
    assert!(r.is_err(), "the key called a method outside its list");
    // An allowed method with a deposit attached: refused.
    let r = with_agent(&w.vault, "exit", json!({}), 1).send_to(&w.net).await;
    assert!(r.is_err(), "the key attached a deposit");
    assert_eq!(w.usdc_of(&alice).await?, 0, "nothing moved yet");

    // The one thing it is for: exit, paying only Alice.
    with_agent(&w.vault, "exit", json!({ "reason_hash": "note-sha256" }), 0).send_to(&w.net).await?.assert_success();
    assert_eq!(w.usdc_of(&alice).await?, 100 * USDC);
    let shares: near_sdk::json_types::U128 = w.view(&w.vault, "get_shares", json!({ "account_id": alice })).await?;
    assert_eq!(shares.0, 0);
    Ok(())
}
