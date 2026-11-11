//! Five members, five separate agent processes, five limited keys. Nobody touches the vault by hand
//! after the vote: the agents read the spend, check it against their owner's rules, publish a note,
//! exit with the note's hash, and cancel the spend once it can no longer be paid.
//!
//! Needs Node and `npm install` in ../../agent. Run with:
//!   cargo test --test swarm_scenario -- --nocapture

mod common;
use common::*;
use near_api::types::transaction::actions::{AccessKeyPermission, FunctionCallPermission};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Kills every agent process when the test ends, pass or fail.
struct Agents(Vec<(String, Child)>);

impl Drop for Agents {
    fn drop(&mut self) {
        for (_, child) in &mut self.0 {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn agent_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../agent")
}

/// The README rules. Bayo and Chi will approve, so their agents must stay whatever their rules say.
fn rules_for(name: &str, w: &World) -> Value {
    match name {
        "ada" => json!({ "max_spend_share_bps": 2000, "new_recipient": false, "blocked_recipients": [] }),
        "dayo" => json!({ "max_spend_share_bps": null, "new_recipient": true, "blocked_recipients": [] }),
        "efe" => json!({ "max_spend_share_bps": null, "new_recipient": false, "blocked_recipients": [id(w, "bayo")] }),
        _ => json!({ "max_spend_share_bps": 1000, "new_recipient": false, "blocked_recipients": [] }),
    }
}

/// Adds a key to the member's own account that can call only `exit` and `cancel_spend` on the vault.
async fn limited_key(w: &World, name: &str) -> R<String> {
    let key = near_api::signer::generate_secret_key()?;
    near_api::Account(id(w, name))
        .add_key(
            AccessKeyPermission::FunctionCall(FunctionCallPermission {
                allowance: Some(near_api::NearToken::from_millinear(250)),
                receiver_id: w.vault.account_id().to_string(),
                method_names: vec!["exit".into(), "cancel_spend".into()],
            }),
            key.public_key(),
        )
        .with_signer(w.signer.clone())
        .send_to(&w.net)
        .await?
        .assert_success();
    Ok(key.to_string())
}

#[tokio::test]
async fn five_agents_leave_and_kill_the_spend_on_their_own() -> R<()> {
    let w = world().await?;
    w.all_join().await?;
    for m in MEMBERS {
        w.call(&id(&w, m), &w.vault, "set_rules", json!({ "rules": rules_for(m, &w) }), 0, 30)
            .await?
            .assert_success();
    }

    // One config, one process per member. Each process sees only its own member's key.
    let dir = std::env::temp_dir().join(format!("dissent-swarm-{}", std::process::id()));
    let notes = dir.join("notes");
    std::fs::create_dir_all(&notes)?;
    let config = dir.join("agents.json");
    std::fs::write(
        &config,
        serde_json::to_vec_pretty(&json!({
            "vault": w.vault.account_id(),
            "rpc": [w.sandbox.rpc_addr],
            "interval_sec": 1,
            "notes_dir": notes,
            "members": MEMBERS.iter().map(|m| json!({ "account_id": id(&w, m), "key_env": "AGENT_KEY" })).collect::<Vec<_>>()
        }))?,
    )?;

    let mut agents = Agents(Vec::new());
    for m in MEMBERS {
        let key = limited_key(&w, m).await?;
        let log = std::fs::File::create(dir.join(format!("{m}.log")))?;
        let child = Command::new("node")
            .arg(agent_dir().join("src/watch.js"))
            .arg(&config)
            .arg("--member")
            .arg(id(&w, m).as_str())
            .env("AGENT_KEY", key)
            .current_dir(agent_dir())
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log))
            .spawn()?;
        agents.0.push((m.to_string(), child));
    }
    println!("agent logs and notes: {}", dir.display());

    // Bayo and Chi approve 300 of the fund's 500 USDC to Bayo. From here on nobody acts by hand.
    let bayo = id(&w, "bayo");
    let args = w.spend_args(w.last_proposal_id().await?, &bayo, w.usdc.account_id().as_str(), 300 * USDC);
    let (pid, kind) = w.propose("bayo", &args).await?;
    w.vote("bayo", pid, &kind, "VoteApprove").await?;
    w.vote("chi", pid, &kind, "VoteApprove").await?;
    let open = w.open_spends().await?;
    assert_eq!(open.len(), 1, "spend should be queued: {open:?}");
    let spend_id = open[0]["id"].as_u64().unwrap();

    // Wait for the agents, well inside the 60 second window.
    let started = Instant::now();
    let status = loop {
        let spend: Value = w.view(&w.vault, "get_spend", json!({ "spend_id": spend_id })).await?;
        let status = spend["status"].as_str().unwrap_or("?").to_string();
        if status != "Queued" || started.elapsed() > Duration::from_secs(55) {
            break status;
        }
        for (m, child) in &mut agents.0 {
            if let Some(code) = child.try_wait()? {
                panic!("{m}'s agent stopped early with {code}; see {}", dir.join(format!("{m}.log")).display());
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    };
    println!("spend {spend_id} settled as {status} after {:?}", started.elapsed());
    assert_eq!(status, "Cancelled", "the agents should have killed the spend; logs in {}", dir.display());
    drop(agents);

    // Who left. The spend dies once two have gone, so the third may or may not have needed to.
    let mut exited = Vec::new();
    for m in MEMBERS {
        let shares: U128 = w.view(&w.vault, "get_shares", json!({ "account_id": id(&w, m) })).await?;
        if shares.0 == 0 {
            exited.push(m);
        }
    }
    println!("exited: {exited:?}");
    assert!(exited.len() >= 2, "at least two members must leave to make 300 of 500 unpayable");
    for m in &exited {
        assert!(["ada", "dayo", "efe"].contains(m), "{m} approved and must not have left");
        assert_eq!(w.usdc_of(&id(&w, m)).await?, 100 * USDC, "{m} gets exactly a fifth of the USDC");
    }
    assert_eq!(w.usdc_of(&bayo).await?, 0, "Bayo received nothing");
    assert_eq!(u(&w.balances().await?["usdc"]), 500 * USDC - 100 * USDC * exited.len() as u128);

    // Every exit carried the hash of the note its agent published, and the note says why.
    let record: Vec<String> = w.view(&w.vault, "get_record", json!({ "from_index": 0, "limit": 100 })).await?;
    let record = record.join("\n");
    for m in &exited {
        let path = notes.join(format!("{spend_id}-{}.json", id(&w, m)));
        let published: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
        assert_eq!(published["note"]["decision"], "exit", "{m}'s note");
        let hash = published["hash"].as_str().unwrap();
        assert!(record.contains(hash), "{m}'s exit on chain does not carry the published note hash {hash}");
    }
    for m in ["bayo", "chi"] {
        let path = notes.join(format!("{spend_id}-{}.json", id(&w, m)));
        let published: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
        assert_eq!(published["note"]["decision"], "stay", "{m} approved, so their agent stays");
    }

    // The spend can never pay out now.
    w.wait_out_window().await?;
    w.call(&bayo, &w.vault, "execute_spend", json!({ "spend_id": spend_id }), 0, 100).await?.assert_failure();
    assert_books(&w.ledger("Usdc").await?);
    assert_books(&w.ledger("Near").await?);
    Ok(())
}
