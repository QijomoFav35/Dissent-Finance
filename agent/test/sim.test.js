import { test } from "node:test";
import assert from "node:assert/strict";
import { profiles, profileFor, simulate } from "../sim/swarm.js";

const pool = profiles();
const spend = (over) => ({
  dao: "x.sputnik-dao.near", id: 1, token: "NEAR", amount: "100", receiver: "r.near",
  approvers: ["a.near"], rejecters: ["b.near", "c.near", "d.near"], absent_now_council: 0,
  receiver_paid_before: true, receiver_voted_approve: false, median_earlier_amount: "100", ...over,
});

test("40 profiles, and the same account always gets the same rules", () => {
  assert.equal(pool.length, 40);
  assert.deepEqual(profileFor("b.near", pool), profileFor("b.near", pool));
});

test("a routine payment in a well-funded vault is never killed", () => {
  const r = simulate(spend({}), 100, pool);
  assert.equal(r.killed, false);
  assert.equal(r.exits.length, 0, "1% of the fund to a known receiver breaks no profile");
});

test("a payment 20x the usual size is killed once the objectors leave", () => {
  const r = simulate(spend({ amount: "2000", rejecters: ["b.near", "c.near", "d.near", "e.near"] }), 25, pool);
  assert.ok(r.exits.length > 0);
  assert.equal(r.killed, true);
});

test("a spend with no earlier history is skipped, not guessed", () => {
  assert.equal(simulate(spend({ median_earlier_amount: null }), 25, pool), null);
});
