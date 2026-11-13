// mainnet/verify.mjs against a stand-in for mainnet: every check passes on the real state, and each
// planted fault turns its check into a FAIL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { startMock } from "./fixtures/mainnet-mock.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const script = path.join(here, "..", "mainnet", "verify.mjs");

function run(url, file = script, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [file, "--json"], { env: { ...process.env, DISSENT_RPC: url, DISSENT_ARCHIVAL_RPC: url, ...env } }, (err, stdout) => {
      resolve({ code: err ? err.code : 0, out: JSON.parse(stdout) });
    });
  });
}

test("on code from before the market, the market checks say so as INFO", async () => {
  const mock = await startMock();
  try {
    const { code, out } = await run(mock.url);
    assert.equal(code, 0);
    assert.equal(out.failed, 0);
    assert.ok(out.results.length >= 22, `expected at least 22 checks, got ${out.results.length}`);
    // INFO, not PASS or FAIL: v2's key, and the market checks on code from before the market.
    const info = out.results.filter((r) => r.status === "INFO").map((r) => r.what);
    assert.equal(info.length, 4);
    assert.match(info[0], /still has 1 access key/);
    assert.match(info[1], /before held-back exits/);
    assert.match(info[2], /before held-back exits/);
    assert.match(info[3], /before the share market/);
    assert.ok(out.results.some((r) => /runs DtHZA1/.test(r.what) && r.status === "PASS"), "the DAO code check");
    assert.ok(out.results.some((r) => /sandbox tests deploy/.test(r.what) && r.status === "PASS"), "the sandbox bytes check");
  } finally {
    mock.close();
  }
});

test("the DAO's auto-update switched back on fails its check", async () => {
  const mock = await startMock({ round3: true, autoUpdate: true });
  try {
    const { code, out } = await run(mock.url);
    assert.equal(code, 1);
    assert.match(out.results.find((r) => r.status === "FAIL").what, /auto-update is on/);
  } finally {
    mock.close();
  }
});

test("once v2 is keyless, any access key on it fails the keys check", async () => {
  const mock = await startMock({ round3: true });
  try {
    const { code, out } = await run(mock.url, script, { DISSENT_V2_KEYLESS: "1" });
    assert.equal(code, 1);
    assert.match(out.results.find((r) => r.status === "FAIL").what, /still has 1 access key/);
  } finally {
    mock.close();
  }
});

test("a widened agent key, a wrong note hash and unbalanced books each fail their check", async () => {
  const mock = await startMock({ bad: true, round3: true });
  try {
    const { code, out } = await run(mock.url);
    assert.equal(code, 3);
    const failed = out.results.filter((r) => r.status === "FAIL").map((r) => r.what);
    assert.equal(failed.length, 3);
    assert.match(failed[0], /cara\.dissentfinance\.near/);
    assert.match(failed[1], /^dan: the exit carries/);
    assert.match(failed[2], /^NEAR books/);
  } finally {
    mock.close();
  }
});

test("after the third run: the DAO lock, rejoined leavers, market keys and a share sale all pass", async () => {
  const mock = await startMock({ round3: true });
  try {
    const { code, out } = await run(mock.url);
    assert.equal(code, 0, JSON.stringify(out.results.filter((r) => r.status === "FAIL")));
    const by = (re) => out.results.find((r) => re.test(r.what));
    assert.equal(by(/auto-update is off/).status, "PASS");
    assert.match(by(/agent key on their own account/).what, /4 market key\(s\) can call only bid/);
    assert.match(by(/members who left/).what, /3 did, after the cancel/);
    assert.equal(by(/held back for open spends/).status, "PASS");
    assert.match(by(/share sale/).what, /offer 0: cara to dan for 0\.097 USDC after 3 bids/);
    assert.match(by(/USDC contract says/).what, /300000 of it bid funds/);
    assert.equal(by(/approved spend 1 and left while it was open/).status, "PASS");
    assert.match(by(/approved spend 1/).what, /cara approved spend 1 and left while it was open; it is Executed/);
    assert.deepEqual(out.results.filter((r) => r.status === "INFO").map((r) => r.n), [2]);
  } finally {
    mock.close();
  }
});

test("a sale below its reserve fails the market check", async () => {
  const mock = await startMock({ round3: true, sale: "below" });
  try {
    const { code, out } = await run(mock.url);
    assert.equal(code, 1);
    assert.match(out.results.find((r) => r.status === "FAIL").what, /share sale/);
  } finally {
    mock.close();
  }
});

test("started through a symlinked path, it still runs its checks (macOS /tmp is a symlink)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-"));
  const link = path.join(dir, "verify.mjs");
  fs.symlinkSync(script, link);
  const mock = await startMock();
  try {
    const { code, out } = await run(mock.url, link);
    assert.equal(code, 0);
    assert.ok(out.results.length >= 19);
  } finally {
    mock.close();
    fs.rmSync(dir, { recursive: true });
  }
});
