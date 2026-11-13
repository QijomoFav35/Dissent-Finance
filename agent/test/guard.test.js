// The guard refuses every key that could do more than an agent key: only a function-call key for
// exit and cancel_spend on vault2, as the chain records it, is run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyPair } from "near-api-js";
import { checkKey } from "../mainnet/guard.mjs";

const kp = KeyPair.fromRandom("ed25519");
const secret = kp.toString();
const onChain = (permission) => ({ query: async (p) => {
  assert.equal(p.request_type, "view_access_key");
  assert.equal(p.public_key, kp.getPublicKey().toString());
  if (permission === null) throw new Error("UNKNOWN_ACCESS_KEY");
  return { permission };
} });
const fc = (receiver_id, method_names) => ({ FunctionCall: { allowance: "250000000000000000000000", receiver_id, method_names } });

test("an agent key for exit and cancel_spend on vault2 is accepted", async () => {
  const r = await checkKey(onChain(fc("vault2.dissentfinance.near", ["exit", "cancel_spend"])), "ben.dissentfinance.near", secret);
  assert.equal(r.ok, true);
  assert.equal(r.publicKey, kp.getPublicKey().toString());
});

test("a full-access key is refused", async () => {
  const r = await checkKey(onChain("FullAccess"), "ben.dissentfinance.near", secret);
  assert.equal(r.ok, false);
  assert.match(r.why, /full-access/);
});

test("a key for another contract, or for more methods, is refused", async () => {
  assert.match((await checkKey(onChain(fc("vault.dissentfinance.near", ["exit", "cancel_spend"])), "ben.dissentfinance.near", secret)).why, /limited to vault\.dissentfinance\.near/);
  assert.match((await checkKey(onChain(fc("vault2.dissentfinance.near", ["exit", "cancel_spend", "set_rules"])), "ben.dissentfinance.near", secret)).why, /can call exit, cancel_spend, set_rules/);
});

test("a key the account does not have, or a string that is not a key, is refused", async () => {
  assert.match((await checkKey(onChain(null), "ben.dissentfinance.near", secret)).why, /not on ben/);
  const why = (await checkKey(onChain(null), "ben.dissentfinance.near", "hunter2")).why;
  assert.match(why, /not a NEAR key \(7 characters, does not start with ed25519:\)/);
  assert.doesNotMatch(why, /hunter2/, "the refusal never repeats the value");
});
