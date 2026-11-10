// Downloads the Sputnik DAO v2 code that the mainnet factory deploys today, unchanged,
// for the sandbox tests. It reads the code from the factory itself and checks that its sha256
// equals the factory's default code hash, so anyone can confirm the DAO in the tests is unmodified.
// Usage (from the repo root): node scripts/fetch-sputnik.mjs [rpc_url]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const RPC = process.argv[2] || "https://rpc.intea.rs";
const FACTORY = "sputnik-dao.near";
const OUT = path.join("contracts", "vault", "res", "sputnikdao2.wasm");
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes) {
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

async function call(method_name, args) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "f",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: FACTORY,
        method_name,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const j = await res.json();
  if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error || j.result.error));
  return Buffer.from(j.result.result);
}

const defaultHash = JSON.parse((await call("get_default_code_hash", {})).toString());
console.log(`factory default code hash: ${defaultHash}`);

// The factory returns the stored wasm as raw bytes.
const code = await call("get_code", { code_hash: defaultHash });
const digest = crypto.createHash("sha256").update(code).digest();
const hash58 = base58(digest);
if (hash58 !== defaultHash) {
  console.error(`hash mismatch: downloaded ${hash58}, factory says ${defaultHash}`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, code);
console.log(
  JSON.stringify(
    { source: `${FACTORY} get_code`, code_hash: hash58, sha256_hex: digest.toString("hex"), bytes: code.length, saved_to: OUT },
    null,
    2,
  ),
);
