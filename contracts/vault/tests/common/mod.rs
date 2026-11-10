//! Shared sandbox setup: an unchanged Sputnik DAO (mainnet wasm), a test USDC and the vault.
#![allow(dead_code)]

use near_api::{Account, AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer};
use near_sdk::base64::{engine::general_purpose::STANDARD, Engine};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use std::sync::Arc;

pub const USDC: u128 = 1_000_000;
pub const MEMBERS: [&str; 5] = ["ada", "bayo", "chi", "dayo", "efe"];
pub const WINDOW_NS: u64 = 60 * 1_000_000_000;
pub const PROPOSAL_BOND: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR

pub type R<T> = testresult::TestResult<T>;

pub struct World {
    pub sandbox: near_sandbox::Sandbox,
    pub net: NetworkConfig,
    pub signer: Arc<Signer>,
    pub dao: Contract,
    pub usdc: Contract,
    pub vault: Contract,
    pub fee: AccountId,
    pub shop: AccountId,
}

pub fn id(world: &World, name: &str) -> AccountId {
    let _ = world;
    format!("{name}.sandbox").parse().unwrap()
}

fn sputnik_wasm() -> Vec<u8> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/res/sputnikdao2.wasm");
    std::fs::read(path).unwrap_or_else(|_| {
        panic!("missing {path}: run `node scripts/fetch-sputnik.mjs` from the repo root to download the mainnet DAO code")
    })
}

fn test_usdc_wasm() -> Vec<u8> {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-usdc");
    let status = std::process::Command::new("cargo")
        .args(["near", "build", "non-reproducible-wasm"])
        .current_dir(dir)
        .status()
        .expect("cargo near build for test-usdc");
    assert!(status.success(), "test-usdc build failed");
    std::fs::read(format!("{dir}/target/near/test_usdc.wasm")).expect("test_usdc.wasm")
}

fn vault_wasm() -> Vec<u8> {
    let path = cargo_near_build::build_with_cli(Default::default()).expect("vault build");
    std::fs::read(path).expect("vault.wasm")
}

async fn create(sandbox: &near_sandbox::Sandbox, name: &str, near: u128) -> R<Account> {
    let account_id: AccountId = format!("{name}.sandbox").parse()?;
    sandbox
        .create_account(account_id.as_str().parse()?)
        .initial_balance(NearToken::from_near(near))
        .send()
        .await?;
    Ok(Account(account_id))
}

pub fn policy(members: &[AccountId]) -> Value {
    json!({
        "roles": [{
            "name": "council",
            "kind": { "Group": members },
            "permissions": ["*:*"],
            "vote_policy": {}
        }],
        "default_vote_policy": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": "2" },
        "proposal_bond": PROPOSAL_BOND.to_string(),
        "proposal_period": "604800000000000",
        "bounty_bond": PROPOSAL_BOND.to_string(),
        "bounty_forgiveness_period": "86400000000000"
    })
}

pub async fn world() -> R<World> {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let signer = Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;

    let mut members = Vec::new();
    for m in MEMBERS {
        members.push(create(&sandbox, m, 50).await?.0);
    }
    let fee = create(&sandbox, "fee", 5).await?.0;
    let shop = create(&sandbox, "shop", 5).await?.0;
    let dao = create(&sandbox, "dao", 30).await?.as_contract();
    let usdc = create(&sandbox, "usdc", 10).await?.as_contract();
    let vault = create(&sandbox, "vault", 20).await?.as_contract();

    Contract::deploy(usdc.account_id().clone())
        .use_code(test_usdc_wasm())
        .with_init_call("new", json!({}))?
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    Contract::deploy(dao.account_id().clone())
        .use_code(sputnik_wasm())
        .with_init_call(
            "new",
            json!({
                "config": { "name": "group", "purpose": "a shared fund", "metadata": "" },
                "policy": policy(&members)
            }),
        )?
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    Contract::deploy(vault.account_id().clone())
        .use_code(vault_wasm())
        .with_init_call(
            "new",
            json!({
                "dao": dao.account_id(),
                "usdc": usdc.account_id(),
                "fee_account": fee,
                "window_ns": WINDOW_NS.to_string()
            }),
        )?
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    let w = World { sandbox, net, signer, dao, usdc, vault, fee, shop };

    // The vault, the shop and the fee account must hold USDC storage to receive it.
    for holder in [w.vault.account_id().clone(), w.fee.clone(), w.shop.clone()] {
        w.call(&id(&w, "ada"), &w.usdc, "storage_deposit", json!({ "account_id": holder }), 12_500_000_000_000_000_000_000, 30)
            .await?
            .assert_success();
    }
    Ok(w)
}

impl World {
    pub async fn call(
        &self,
        who: &AccountId,
        contract: &Contract,
        method: &str,
        args: Value,
        deposit_yocto: u128,
        tgas: u64,
    ) -> R<near_api::types::transaction::result::TransactionResult> {
        Ok(contract
            .call_function(method, args)
            .transaction()
            .deposit(NearToken::from_yoctonear(deposit_yocto))
            .gas(NearGas::from_tgas(tgas))
            .with_signer(who.clone(), self.signer.clone())
            .send_to(&self.net)
            .await?)
    }

    pub async fn view<T: near_sdk::serde::de::DeserializeOwned + Send + Sync>(
        &self,
        contract: &Contract,
        method: &str,
        args: Value,
    ) -> R<T> {
        Ok(contract.call_function(method, args).read_only().fetch_from(&self.net).await?.data)
    }

    pub async fn usdc_of(&self, who: &AccountId) -> R<u128> {
        let b: U128 = self.view(&self.usdc, "ft_balance_of", json!({ "account_id": who })).await?;
        Ok(b.0)
    }

    pub async fn near_of(&self, who: &AccountId) -> R<u128> {
        Ok(Account(who.clone()).tokens().near_balance().fetch_from(&self.net).await?.total.as_yoctonear())
    }

    /// Mints USDC to a member and runs both join steps.
    pub async fn join(&self, name: &str, near: u128, usdc: u128) -> R<()> {
        let who = id(self, name);
        self.call(&who, &self.usdc, "mint", json!({ "amount": U128(usdc) }), 0, 30).await?.assert_success();
        self.call(
            &who,
            &self.usdc,
            "ft_transfer_call",
            json!({ "receiver_id": self.vault.account_id(), "amount": U128(usdc), "msg": "join" }),
            1,
            100,
        )
        .await?
        .assert_success();
        self.call(&who, &self.vault, "join", json!({}), near * 10u128.pow(24), 150).await?.assert_success();
        Ok(())
    }

    pub async fn all_join(&self) -> R<()> {
        for m in MEMBERS {
            self.join(m, 10, 100 * USDC).await?;
        }
        Ok(())
    }

    /// The exact bytes Sputnik will pass to the vault.
    pub fn spend_args(&self, proposal_id: u64, recipient: &AccountId, token_id: &str, amount: u128) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "proposal_id": proposal_id,
            "recipient": recipient,
            "token_id": token_id,
            "amount": U128(amount),
            "memo": "group spend"
        }))
        .unwrap()
    }

    pub fn spend_kind(&self, args: &[u8]) -> Value {
        json!({ "FunctionCall": {
            "receiver_id": self.vault.account_id(),
            "actions": [{
                "method_name": "queue_spend",
                "args": STANDARD.encode(args),
                "deposit": "0",
                "gas": "150000000000000"
            }]
        }})
    }

    pub async fn last_proposal_id(&self) -> R<u64> {
        self.view(&self.dao, "get_last_proposal_id", json!({})).await
    }

    /// Files a FunctionCall proposal and returns its id and kind.
    pub async fn propose(&self, proposer: &str, args: &[u8]) -> R<(u64, Value)> {
        let id_before = self.last_proposal_id().await?;
        let kind = self.spend_kind(args);
        self.call(
            &id(self, proposer),
            &self.dao,
            "add_proposal",
            json!({ "proposal": { "description": "pay for the group", "kind": kind } }),
            PROPOSAL_BOND,
            100,
        )
        .await?
        .assert_success();
        Ok((id_before, kind))
    }

    pub async fn vote(&self, voter: &str, proposal_id: u64, kind: &Value, action: &str) -> R<()> {
        self.call(
            &id(self, voter),
            &self.dao,
            "act_proposal",
            json!({ "id": proposal_id, "action": action, "proposal": kind }),
            0,
            300,
        )
        .await?
        .assert_success();
        Ok(())
    }

    pub async fn proposal_status(&self, proposal_id: u64) -> R<String> {
        let p: Value = self.view(&self.dao, "get_proposal", json!({ "id": proposal_id })).await?;
        Ok(p["status"].as_str().unwrap_or("?").to_string())
    }

    pub async fn open_spends(&self) -> R<Vec<Value>> {
        self.view(&self.vault, "get_open_spends", json!({})).await
    }

    pub async fn balances(&self) -> R<Value> {
        self.view(&self.vault, "get_balances", json!({})).await
    }

    pub async fn ledger(&self, token: &str) -> R<Value> {
        self.view(&self.vault, "get_ledger", json!({ "token": token })).await
    }

    pub async fn wait_out_window(&self) -> R<()> {
        // Sandbox blocks are about a second apart; 200 blocks clear a 60 second window.
        self.sandbox.fast_forward(200).await?;
        Ok(())
    }
}

pub fn u(v: &Value) -> u128 {
    v.as_str().and_then(|s| s.parse().ok()).unwrap_or_else(|| panic!("not a U128: {v}"))
}

/// balance + pending == deposited - spent - fees - exited - refunded, once every transfer has settled.
pub fn assert_books(ledger: &Value) {
    let lhs = u(&ledger["balance"]) + u(&ledger["pending_joins"]);
    let rhs = u(&ledger["deposited"]) - u(&ledger["spent"]) - u(&ledger["fees"]) - u(&ledger["exited"]) - u(&ledger["refunded"]);
    assert_eq!(lhs, rhs, "books do not balance: {ledger}");
    assert_eq!(u(&ledger["in_flight"]), 0, "transfers still in flight: {ledger}");
}
