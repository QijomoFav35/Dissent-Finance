//! The proposal check: the vault only queues a spend that matches, byte for byte,
//! a FunctionCall proposal the DAO itself records as Approved.

use near_sdk::base64::{engine::general_purpose::STANDARD, Engine};
use near_sdk::serde_json::Value;
use near_sdk::AccountId;

use crate::ERR_PROPOSAL_MISMATCH;

#[derive(Debug, Clone, PartialEq)]
pub struct ProposalCheck {
    /// Accounts that voted Approve.
    pub approvers: Vec<AccountId>,
    /// Accounts that voted Reject or Remove.
    pub objectors: Vec<AccountId>,
}

/// Checks a Sputnik v2 `get_proposal` result against the call the vault received.
///
/// Passes only when the proposal is `Approved`, its kind is `FunctionCall` to `vault`,
/// it carries exactly one action, that action calls `method`, and the action's decoded args
/// equal `raw_args` byte for byte.
pub fn check_proposal(
    proposal: &Value,
    vault: &AccountId,
    method: &str,
    raw_args: &[u8],
) -> Result<ProposalCheck, &'static str> {
    let fail = ERR_PROPOSAL_MISMATCH;
    if proposal.get("status").and_then(Value::as_str) != Some("Approved") {
        return Err(fail);
    }
    let call = proposal.get("kind").and_then(|k| k.get("FunctionCall")).ok_or(fail)?;
    if call.get("receiver_id").and_then(Value::as_str) != Some(vault.as_str()) {
        return Err(fail);
    }
    let actions = call.get("actions").and_then(Value::as_array).ok_or(fail)?;
    if actions.len() != 1 {
        return Err(fail);
    }
    let action = &actions[0];
    if action.get("method_name").and_then(Value::as_str) != Some(method) {
        return Err(fail);
    }
    let args_b64 = action.get("args").and_then(Value::as_str).ok_or(fail)?;
    let args = STANDARD.decode(args_b64).map_err(|_| fail)?;
    if args.as_slice() != raw_args {
        return Err(fail);
    }

    let votes = proposal.get("votes").and_then(Value::as_object).ok_or(fail)?;
    let mut approvers = Vec::new();
    let mut objectors = Vec::new();
    for (account, vote) in votes {
        let account: AccountId = account.parse().map_err(|_| fail)?;
        match vote.as_str() {
            Some("Approve") => approvers.push(account),
            Some("Reject") | Some("Remove") => objectors.push(account),
            _ => return Err(fail),
        }
    }
    if approvers.is_empty() {
        return Err(fail);
    }
    approvers.sort();
    objectors.sort();
    Ok(ProposalCheck { approvers, objectors })
}

/// True when `account` is listed in any `Group` role of a Sputnik v2 policy (the DAO's members).
/// `Everyone` and token-weighted `Member` roles do not count: shares are for named members only.
pub fn is_member(policy: &Value, account: &AccountId) -> bool {
    policy
        .get("roles")
        .and_then(Value::as_array)
        .map(|roles| {
            roles.iter().any(|role| {
                role.get("kind")
                    .and_then(|k| k.get("Group"))
                    .and_then(Value::as_array)
                    .map(|group| group.iter().any(|m| m.as_str() == Some(account.as_str())))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}
