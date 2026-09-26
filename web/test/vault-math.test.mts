import assert from "node:assert/strict";
import test from "node:test";
import { depositShares, withdrawAssets, maxWithdrawShares, parseVaultAmount, validateVaultAmount } from "../src/lib/vault/math.ts";
import { marketLiability } from "../src/lib/vault/read.ts";
const empty = { idle: 0n, navPlus: 0n, navMinus: 0n, totalShares: 0n, userShares: 0n, usdc: 100_000_000n };
test("shares use 12 decimals and USDC 6 without rounding excess precision", () => {
 assert.equal(depositShares(1_000_000n, empty), 10n ** 12n);
 assert.equal(parseVaultAmount("1.000000000001", "withdraw"), 1_000_000_000_001n);
 assert.equal(parseVaultAmount(".000001", "deposit"), 1n);
 for (const value of ["", "0", "-1", "1e3", "NaN", "1.0000001", " ", "Infinity"]) assert.throws(() => parseVaultAmount(value, "deposit"));
});
test("quotes preserve integer rounding and separate entry/exit NAV", () => {
 const core = { ...empty, navPlus: 20n, navMinus: 9n, totalShares: 10n };
 assert.equal(depositShares(3n, core), 142858n);
 assert.equal(withdrawAssets(1_000_001n, core), 9n);
 assert.throws(() => validateVaultAmount("deposit", 1n << 255n, core), /limits/);
});
test("max withdrawal includes exact floor rounding boundary and never overshoots idle", () => {
 for (let idle = 0n; idle < 12n; idle++) for (let nav = 1n; nav < 20n; nav++) {
  const core = { ...empty, idle, navMinus: nav, userShares: 10_000_000n };
  const max = maxWithdrawShares(core);
  assert.ok(max <= core.userShares);
  assert.ok(withdrawAssets(max, core) <= idle);
  if (max && max < core.userShares) assert.ok(withdrawAssets(max + 1n, core) > idle);
 }
});
test("reject zero, balance, shares, dust and idle violations", () => {
 assert.throws(() => validateVaultAmount("deposit", 0n, empty));
 assert.throws(() => validateVaultAmount("deposit", empty.usdc + 1n, empty), /USDC/);
 assert.throws(() => validateVaultAmount("withdraw", 1n, empty), /shares/);
 assert.throws(() => validateVaultAmount("withdraw", 1n, { ...empty, userShares: 1n }), /small/);
 assert.throws(() => validateVaultAmount("withdraw", 1_000_000n, { ...empty, userShares: 1_000_000n }), /idle/);
});
test("liability matches trading max, settled winner and invalid half rounded up", () => {
 const info = { status: 1, yesWon: false, outYes: 7n, outNo: 2n };
 assert.equal(marketLiability(info), 7n);
 assert.equal(marketLiability({ ...info, status: 2 }), 2n);
 assert.equal(marketLiability({ ...info, status: 2, yesWon: true }), 7n);
 assert.equal(marketLiability({ ...info, status: 3 }), 5n);
});
