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

function run(url, file = script) {
  return new Promise((resolve) => {
    execFile(process.execPath, [file, "--json"], { env: { ...process.env, DISSENT_RPC: url, DISSENT_ARCHIVAL_RPC: url } }, (err, stdout) => {
      resolve({ code: err ? err.code : 0, out: JSON.parse(stdout) });
    });
  });
}

test("every check passes on the mainnet state, with v2's key reported as INFO", async () => {
  const mock = await startMock();
  try {
    const { code, out } = await run(mock.url);
    assert.equal(code, 0);
    assert.equal(out.failed, 0);
    assert.ok(out.results.length >= 19, `expected at least 19 checks, got ${out.results.length}`);
    assert.deepEqual(out.results.filter((r) => r.status === "INFO").map((r) => r.n), [2]);
    assert.ok(out.results.some((r) => /runs DtHZA1/.test(r.what) && r.status === "PASS"), "the DAO code check");
    assert.ok(out.results.some((r) => /sandbox tests deploy/.test(r.what) && r.status === "PASS"), "the sandbox bytes check");
  } finally {
    mock.close();
  }
});

test("a widened agent key, a wrong note hash and unbalanced books each fail their check", async () => {
  const mock = await startMock({ bad: true });
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
