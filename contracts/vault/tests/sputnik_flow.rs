//! End to end against an unchanged Sputnik DAO: propose, vote in the DAO, the vault checks the
//! DAO's own record, queues the spend, and members who did not approve leave before it pays.

mod common;
use common::*;
use near_sdk::serde_json::json;

/// The story from the README: Bayo and Chi approve 300 of the fund's 500 USDC to Bayo.
/// Ada, Dayo and Efe leave with their fifth each; the spend can no longer be paid and is cancelled.
#[tokio::test]
async fn collective_cancel_end_to_end() -> R<()> {
    let w = world().await?;
    w.all_join().await?;
    let b = w.balances().await?;
    assert_eq!(u(&b["usdc"]), 500 * USDC);
    assert_eq!(b["members"], 5);

    let bayo = id(&w, "bayo");
    let args = w.spend_args(w.last_proposal_id().await?, &bayo, w.usdc.account_id().as_str(), 300 * USDC);
    let (pid, kind) = w.propose("bayo", &args).await?;
    w.vote("bayo", pid, &kind, "VoteApprove").await?;
    assert_eq!(w.proposal_status(pid).await?, "InProgress");
    w.vote("chi", pid, &kind, "VoteApprove").await?;
    assert_eq!(w.proposal_status(pid).await?, "Approved");

    let open = w.open_spends().await?;
    assert_eq!(open.len(), 1, "spend should be queued: {open:?}");
    let spend_id = open[0]["id"].as_u64().unwrap();
    assert_eq!(open[0]["approvers"], json!([id(&w, "bayo"), id(&w, "chi")]));

    // An approver cannot leave while their spend is open.
    w.call(&id(&w, "chi"), &w.vault, "exit", json!({}), 0, 100).await?.assert_failure();
    // Nobody can join while a spend is open.
    let late = id(&w, "fee");
    w.call(&late, &w.vault, "join", json!({}), 10u128.pow(24), 100).await?.assert_failure();

    for m in ["ada", "dayo", "efe"] {
        let who = id(&w, m);
        w.call(&who, &w.vault, "exit", json!({ "reason_hash": format!("{m}-note") }), 0, 100)
            .await?
            .assert_success();
        assert_eq!(w.usdc_of(&who).await?, 100 * USDC, "{m} gets exactly a fifth of the USDC");
    }
    assert_eq!(u(&w.balances().await?["usdc"]), 200 * USDC);

    // Too early to execute, and once the window is over it is unaffordable.
    w.call(&bayo, &w.vault, "execute_spend", json!({ "spend_id": spend_id }), 0, 100).await?.assert_failure();
    w.wait_out_window().await?;
    w.call(&bayo, &w.vault, "execute_spend", json!({ "spend_id": spend_id }), 0, 100).await?.assert_failure();
    w.call(&id(&w, "efe"), &w.vault, "cancel_spend", json!({ "spend_id": spend_id }), 0, 50).await?.assert_success();

    let spend: near_sdk::serde_json::Value = w.view(&w.vault, "get_spend", json!({ "spend_id": spend_id })).await?;
    assert_eq!(spend["status"], "Cancelled");
    assert_eq!(w.usdc_of(&bayo).await?, 0, "Bayo received nothing");

    // With the spend gone, the approvers can leave with what remains.
    w.call(&bayo, &w.vault, "exit", json!({}), 0, 100).await?.assert_success();
    assert_eq!(w.usdc_of(&bayo).await?, 100 * USDC);

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
    let (pid, kind) = w.propose("ada", &args).await?;
    w.vote("ada", pid, &kind, "VoteApprove").await?;
    w.vote("bayo", pid, &kind, "VoteApprove").await?;
    let spend_id = w.open_spends().await?[0]["id"].as_u64().unwrap();

    w.wait_out_window().await?;
    w.call(&id(&w, "chi"), &w.vault, "execute_spend", json!({ "spend_id": spend_id }), 0, 100)
        .await?
        .assert_success();
    assert_eq!(w.usdc_of(&w.shop).await?, 50 * USDC);
    assert_eq!(w.usdc_of(&w.fee).await?, 50_000);
    assert_eq!(u(&w.balances().await?["usdc"]), 500 * USDC - 50 * USDC - 50_000);
    let paid: bool = w.view(&w.vault, "was_paid", json!({ "account_id": w.shop })).await?;
    assert!(paid);
    // Executing twice fails.
    w.call(&id(&w, "chi"), &w.vault, "execute_spend", json!({ "spend_id": spend_id }), 0, 100)
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
    let (pid, kind) = w.propose("ada", &args).await?;
    w.vote("ada", pid, &kind, "VoteApprove").await?;
    w.vote("bayo", pid, &kind, "VoteApprove").await?;
    let spend_id = w.open_spends().await?[0]["id"].as_u64().unwrap();
    w.wait_out_window().await?;
    let before = w.near_of(&w.shop).await?;
    w.call(&id(&w, "chi"), &w.vault, "execute_spend", json!({ "spend_id": spend_id }), 0, 100)
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
    let args = w.spend_args(wrong_id, &id(&w, "bayo"), w.usdc.account_id().as_str(), 300 * USDC);
    let (pid, kind) = w.propose("bayo", &args).await?;
    w.vote("bayo", pid, &kind, "VoteApprove").await?;
    w.vote("chi", pid, &kind, "VoteApprove").await?;
    assert_eq!(w.proposal_status(pid).await?, "Failed");
    assert!(w.open_spends().await?.is_empty());
    Ok(())
}

/// Nobody but the DAO can queue a spend, even with arguments copied from a real proposal.
#[tokio::test]
async fn only_the_dao_can_queue() -> R<()> {
    let w = world().await?;
    w.all_join().await?;
    let bayo = id(&w, "bayo");
    let args = w.spend_args(w.last_proposal_id().await?, &bayo, w.usdc.account_id().as_str(), 300 * USDC);
    let (pid, kind) = w.propose("bayo", &args).await?;
    w.vote("bayo", pid, &kind, "VoteApprove").await?;
    let direct: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(&args)?;
    w.call(&bayo, &w.vault, "queue_spend", direct, 0, 100).await?.assert_failure();
    assert!(w.open_spends().await?.is_empty());
    Ok(())
}

/// A member with no USDC storage still exits: their USDC waits as claimable until they register.
#[tokio::test]
async fn exit_without_usdc_storage_becomes_claimable() -> R<()> {
    let w = world().await?;
    w.all_join().await?;
    let ada = id(&w, "ada");
    w.call(&ada, &w.usdc, "storage_unregister", json!({ "force": true }), 1, 30).await?.assert_success();
    w.call(&ada, &w.vault, "exit", json!({}), 0, 100).await?.assert_success();
    let (_near, usdc): (near_sdk::json_types::U128, near_sdk::json_types::U128) =
        w.view(&w.vault, "get_claimable", json!({ "account_id": ada })).await?;
    assert_eq!(usdc.0, 100 * USDC);

    w.call(&ada, &w.usdc, "storage_deposit", json!({}), 12_500_000_000_000_000_000_000, 30).await?.assert_success();
    w.call(&ada, &w.vault, "claim", json!({ "token": "Usdc" }), 0, 100).await?.assert_success();
    assert_eq!(w.usdc_of(&ada).await?, 100 * USDC);
    assert_books(&w.ledger("Usdc").await?);
    Ok(())
}
