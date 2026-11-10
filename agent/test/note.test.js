import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, hashNote, makeNote, verifyNote } from "../src/note.js";

const base = () =>
  makeNote({
    vault: "vault.near",
    member: "ada.near",
    spend: { id: 0, proposal_id: 3, recipient: "bayo.near", token: "Usdc", amount: "300000000", window_ends: "1" },
    balances: { near: "50", usdc: "500000000" },
    rules: { max_spend_share_bps: 2000 },
    result: { decision: "exit", checks: [{ rule: "max_spend_share_bps", limit: 2000, value: 6000, broken: true }] },
    approved: false,
    at: "2026-11-10T03:00:00.000Z",
  });

test("canonical JSON ignores key order", () => {
  assert.equal(canonical({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }), canonical({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }));
  assert.equal(canonical({ a: undefined, b: 1 }), '{"b":1}');
});

test("the same note always hashes the same", () => {
  assert.equal(hashNote(base()), hashNote(base()));
  assert.match(hashNote(base()), /^[0-9a-f]{64}$/);
});

test("any change to a note changes its hash", () => {
  const n = base();
  const h = hashNote(n);
  n.decision = "stay";
  assert.notEqual(hashNote(n), h);
  const m = base();
  m.checks[0].value = 5999;
  assert.notEqual(hashNote(m), h);
});

test("a published note verifies against the hash sent on chain", () => {
  const n = base();
  const h = hashNote(n);
  const published = JSON.parse(JSON.stringify(n));
  assert.ok(verifyNote(published, h));
  published.member = "mallory.near";
  assert.ok(!verifyNote(published, h));
});

test("notes record what was checked, not the proposal text", () => {
  const n = base();
  assert.ok(!("memo" in n.spend) && !("description" in n.spend));
});
