# 03: On-chain fixed-point math for binary Black–Scholes

**Topic:** How to compute `YES = e^(-rτ) · N(d2)` on-chain accurately and cheaply: fixed-point libraries (ln, exp, sqrt), normal-CDF algorithms, a formula chain specialized to Uniswap, error propagation, gas, and a differential-testing harness.
**Date:** 2026-09-25
**Status:** Research note, fact-checked on 2026-09-25 (see the Verification log at the end). It is input to the implementation plan, not a design decision.

**How the numbers were produced.** I measured every accuracy and gas figure in this note myself unless it says otherwise:
- **Algorithm error.** An mpmath script at 50–60 digits compared each approximation against `mpmath.ncdf` on 40,001 points in [-10, 10], then refined around the worst point.
- **Fixed-point error and gas.** I ran a Foundry project that calls the actual Solidity implementations on 25,017 CDF vectors plus 8,500, 3,000, 3,000 and 3,000 binary-price vectors, and compared the outputs to 60-digit mpmath references built from the exact integer inputs.
- **Toolchain.** forge 1.8.3 (`cae51ad`), solc 0.8.37, `evm_version = osaka` (osaka is needed only because DeFiMath uses CLZ), optimizer on with runs = 10,000 and `via_ir = false`.
- **Where the scripts are.** All scripts and sources are in the session scratchpad. The paths are in Appendix C. That directory is temporary, so Appendix A reproduces the key code.

Anything I could not verify is marked **UNVERIFIED**. Passages marked **[Corrected]** or **[Added]** were changed or added by the fact-check; the Verification log lists the evidence for each.

---

## 0. Summary

1. **Normal CDF.** Use a double-precision algorithm: Hart 1968 #5666 as published by West (2005), or Cody (1969).
   - Hart with Solady `expWad`, in WAD fixed point: measured max absolute error **4.2e-17**, about **900 gas**.
   - Cody: **1.7e-18**, about **1,030 gas**.
   - **[Corrected]** The prototype's Cody constant `Q1` (copied from Equinox) has a transcription typo compared with netlib. Its numerical effect is below 1e-22, but it must be fixed (§4.1).
   - The textbook Abramowitz & Stegun formulas are only about 50–100 gas cheaper, but have errors of 7e-8 to 1.3e-7. On-chain gas is not the constraint here; accuracy is.
2. **Existing on-chain CDFs are uneven** (my measurements):

   | Implementation | Measured max abs error | Gas |
   |---|---|---|
   | solstat | 4.15e-8 | ~4.4k |
   | Premia v3 (Shore approximation, PRB math) | 6.6e-7 | ~36.6k avg, 42k max |
   | Premia v2 (Choudhury) | 1.4e-4 | not measured |
   | RMM-core | **3.6e-3** | not measured |
   | Lyra v1 (Hart) | 4.1e-17 | ~7.1k |
   | DeFiMath (Hart) | 7.7e-17 | ~710, but needs the Osaka EVM (CLZ opcode) |

   RMM-core's error comes from a constant-reuse bug: √2 is used where the A&S coefficient `a3 = 1.421413741` should be (§3.5). Its own Echidna "reference" reuses the same wrong constant, so its property test cannot catch the bug.
3. **Library choice.** For the hot path, use Solady `FixedPointMathLib` (`lnWad`, `expWad`, `sqrt`) plus a ~40-line custom CDF.
   - PRB math is 5–10× more gas for `ln`/`exp`. Measured: `ln` 6.4k vs 0.58k, `exp` 2.9k vs 0.46k.
   - ABDK 64.64 has a narrower range and a BSD-4 license.
   - **[Corrected]** CLZ (needed by DeFiMath) is **live** on Ethereum, Unichain, Base, OP Mainnet and Arbitrum One. I checked this with `eth_call` on 2026-09-25 (§2.4). So CLZ is no longer a blocker, but v4-core's `PoolManager.sol` still pins `pragma solidity 0.8.26`.
4. **Work in log space and with per-second variance.** Let `x = ln(S/K)` and `w = σ_s²·τ` (σ_s² is variance per second, τ is seconds to expiry). Then `d2 = (x + rτ − w/2)/√w`. The chain needs no annualization and only one `sqrt`.
   - `x` from a tick-cumulative difference costs about 200 gas with ≤ 1e-18 error.
   - `x` from `sqrtPriceX96` costs about 880 gas with ≤ 3e-18 error.
   - **[Added]** Per-second variance must be kept at 1e36 scale (or as annual σ² in WAD). Per-second variance in WAD carries an 8.8e-11 relative truncation, which is up to about 1e-11 in price and so breaks the 1e-12 target (§5.2).
5. **Measured end-to-end numerical error:**

   | Path | Max abs error | Gas |
   |---|---|---|
   | Pool path: `sqrtPriceX96`, ln-strike, variance per second, τ | **2.7e-16** | ~2.2k |
   | Core: (x, w, rτ) | 8.2e-16 | ~1.7k |
   | Spot/strike/σ/r inputs | 1.1e-14 | ~2.7k |
   | DeFiMath `BinaryOptions.call`, same vectors | 7.8e-15 | ~2.2k |
   | Premia-v3-style PRB pipeline | 6.6e-7 | ~33.6k avg, 56k max |

6. **Input errors are 10¹⁰–10¹⁴ times larger than numerical error.**
   - One tick (1 bp) of spot uncertainty moves an at-the-money binary by up to **4.8e-2** at 1 minute to expiry and **1.3e-3** at 1 day (σ = 60%).
   - A 10% error in σ moves the price by up to **2.3e-2**.
   - One 12-second block of time decay moves it by up to **2.7e-2** at 1 minute to expiry.

   So the numerical target (I recommend **≤ 1e-12 absolute per $1 payoff**, which is met by about 100×) matters for provable solvency and rounding. The spread, trading cutoff and σ policy must cover model and input risk.
7. **[Added] Precision is not the same as manipulation resistance.** Reading `sqrtPriceX96` from the underlying pool's `slot0` is the most *precise* spot input. It is also *atomically manipulable*: in the same transaction, an attacker can push ETH/USDC, trade YES, and push it back. Near expiry, one tick moves the price by up to 4.8 cents per $1. The spot-source policy (TWAP, a lagged or start-of-block price, or a manipulation-cost bound) belongs to the security and oracle research. The math in this note assumes the input is already trusted.
8. **Estimating variance from ticks** (these feed the σ research):
   - Rounding ticks down adds about 1/6 tick² of variance per return. That biases σ up by **7% at 1-second sampling**, 0.6% at 12 s, and 0.12% at 1 minute.
   - Differences of consecutive TWAP means understate σ² by a factor of **2/3** (simulated 0.6665).
9. **Harness.** The harness I built is the pattern I recommend for the real project:
   - mpmath vectors stored as ABI-encoded `.bin` files and read with `vm.readFileBinary`, so CI needs no FFI;
   - references at 1e24 scale so sub-wei errors are visible;
   - fuzzed properties (bounds, exact YES+NO=1, monotonicity), all of which passed 100k runs;
   - consecutive-wei seam scans, which found 0 violations in 800k pairs.
   - **[Corrected]** The prototype differential tests only *log* max error and gas; they do not yet assert bounds. The real project must add `assertLe(maxErr, ε)`. The 100k fuzz runs come from `FOUNDRY_FUZZ_RUNS=100000`; the bsbench `foundry.toml` sets no fuzz runs, so the default is 256.
   - **[Added]** The prototype `hartWest` returns 0.5 for `x = type(int256).min` (unchecked-negation overflow). It is unreachable from `priceYes`, but it must be fixed; the bounded fuzz domain missed it (Appendix A).

---

## 1. Problem statement and the formula to implement

A cash-or-nothing binary call pays $1 if `S_T > K`. Its price under Black–Scholes (GBM) is:

```
d2  = [ ln(S/K) + (r − σ²/2)·T ] / (σ·√T)          σ annualised, T in years
YES = e^(−rT) · N(d2)
NO  = e^(−rT) · N(−d2) = e^(−rT) − YES             (= 1 − YES exactly when r = 0)
```

For an on-chain AMM we must compute four things from integer state:
- `ln(S/K)`: one or two `ln` calls, or none if S and K are tick-based;
- `√(σ²T)`: one `sqrt`;
- `N(·)`: the normal CDF, which is the only transcendental needed beyond `exp`;
- `e^(−rT)`: optional.

Everything is in fixed point, and the rounding direction matters for solvency.

Units identity used throughout:

```
σ_a² · T_years = σ_s² · τ_seconds      with σ_s² = σ_a² / 31,536,000   (365-day year, as Lyra & DeFiMath use)
w  := σ_s² · τ                         (total variance to expiry, dimensionless)
d2 = (x + ρ − w/2) / √w                with x = ln(S/K), ρ = r_s·τ (= r_a·T)
```

---

## 2. Fixed-point libraries

### 2.1 Solady `FixedPointMathLib`

Version 0.1.26, commit `2afba69` (2026-09-02). Source: `repos/solady/src/utils/FixedPointMathLib.sol`.

| Function | Signature | Semantics / domain | Precision (documented or measured) | Gas |
|---|---|---|---|---|
| `mulWad` | `(uint256 x, uint256 y) → uint256` | `x*y/1e18`, floor, reverts `MulWadFailed` on overflow (L64-76) | exact floor | ~60–100 (estimated) |
| `sMulWad` | `(int256,int256) → int256` | rounds **toward zero**, overflow check incl. `-1 * min` (L79-90) | exact | ~100 (estimated) |
| `sDivWad` | `(int256,int256) → int256` | `x*1e18/y`, toward zero, reverts on `y=0` or overflow (L146-157) | exact | ~100 (estimated) |
| `rawMulWad` / `rawSMulWad` | unchecked variants (L93-106) | no overflow checks | exact | ~20 (estimated) |
| `expWad` | `(int256 x) → int256` | returns **0** for `x ≤ −41446531673892822313`, i.e. when the true result is below 1 wei (Solady's own test: `expWad(−41446531673892822312) == 1`); reverts `ExpOverflow` for `x ≥ 135305999368893231589` (L207-274) | Remco Bloemen: "maximum absolute error on the reduced range … 10⁻²⁰ … relative error of at most 10⁻²⁰"; comment says "Monotonically increasing" (L206) | Remco: 411; **measured 463** incl. harness |
| `lnWad` | `(int256 x) → int256` | reverts `LnWadUndefined` for `x ≤ 0` (L277-350) | Remco: "maximum absolute error … about 10⁻¹⁸"; monotone (L276) | Remco: 585–614; **measured 580** |
| `powWad` | `(int256 x, int256 y)` | `expWad(lnWad(x)*y/1e18)`, approximation (L199-202) | inherits both | ~1.1k (estimated) |
| `sqrt` | `(uint256) → uint256` | floor √, fixed 7 Babylonian steps, branch-free (L778-834) | exact floor | **measured ~460** for `sqrt(x·1e18)` incl. harness |
| `sqrtWad` | `(uint256) → uint256` | `sqrt(x·1e18)`, with an overflow branch (L860-872) | floor (±1 wei) | ~450 (estimated) |

Algorithms:
- **`expWad`:** convert to 2⁹⁶ base, reduce the range to `(−½ln2, ½ln2)` via `k = round(x/ln2)`, apply a (6,7)-term rational function, then multiply by 2ᵏ.
- **`lnWad`:** normalize to `(1,2)·2⁹⁶` using the most-significant bit, then apply an (8,8)-term rational function.
- **[Added] Precision caveat.** Remco's "relative error ≤ 1e-20" applies to the rational approximation *before* the final truncation to WAD. The returned integer is floored, so its absolute error is up to 1 wei, and its relative error is large when the result is only a few wei. For example, `expWad(−40.5e18)` ≈ 2.6 wei. That is harmless for our CDF, where only absolute error matters.

Source for both: Remco Bloemen, "Fixed-point exp and ln", <https://xn--2-umb.com/22/exp-ln/> (my WebFetch of it returned 411 gas for exp, 614/585 for ln, and the error figures above).

Solady's `expWad` coefficients differ from Remco's original. Lyra's vendored copy (`lyra-v1/contracts/libraries/FixedPointMathLib.sol` L126-140) has `p = x + 2772001395605857295435445496992 …`, while Solady has `y = x + 1346386616545796478920950773328 …` (L227-240). So the approximation was revised between Remco's original and Solady. Solady's own tests assert last-digit exactness at many points, e.g. `expWad(1e18) == 2718281828459045235` (`test/FixedPointMathLib.t.sol` L8-45).

**Audits.** The Solady `audits/` folder holds:
- Cantina 2023, whose parsed scope is ERC20/721/1155, LibClone, MerkleProofLib, SignatureCheckerLib and ECDSA;
- Spearbit/Coinbase 2025;
- Ackee (its PDF text did not extract, so I could not check its scope);
- shung's ERC721 audit;
- a formal proof for `cbrt` only.

Neither Cantina report text mentions `FixedPointMathLib`, `expWad` or `lnWad` (re-checked). Solady's test suite asserts exact values for `expWad`/`lnWad` at fixed points but does **not** fuzz their monotonicity. It fuzzes monotonicity only for `lambertW0Wad`.

I found no audit of `expWad`/`lnWad` in the scopes I could parse; that is **UNVERIFIED as exhaustive**. The code is still widely used in production; for example, Aloe II's `Volatility` imports it (`aloe-ii/core/src/libraries/Volatility.sol` L4; note that Aloe is AGPL-3.0, so use it as a reference only).

### 2.2 PRBMath

Version 4.2.0, released 2026-08-03 (`CHANGELOG.md`); the clone's HEAD is `71af01d` (2026-09-21). Source: `repos/prb-math/src`.

**[Corrected]** Every "README" gas figure below comes from the PRB README table at L320-341. That table says it is "based on the v2.0.1 and the v3.0.0 releases", not on v4.2. My v4.2 measurements are the ones marked **measured**.

| Function (SD59x18) | Algorithm | Domain | Notes | Gas |
|---|---|---|---|---|
| `mul` (sd59x18/Math.sol L557-586) | `Common.mulDiv18`, 512-bit | none can be `MIN_SD59x18` | **rounds toward zero** | README: 459 avg |
| `div` (L123-152) | `Common.mulDiv(x, 1e18, y)` | y ≠ 0 | toward zero | README: 451 |
| `exp` (L170-185) | `exp2(x · log2(e))` | `x ≤ 133.084258667509499440e18` (`uEXP_MAX_INPUT`, Constants.sol L12); 0 below `-41.446531673892822322e18` (L16) | the product `x·LOG2_E/1e18` is truncated first, which adds ~1e-18·\|x\| relative error | README avg 2,263; **measured 2,855** |
| `exp2` (L209-240) | binary-fraction method in 192.64 (`Common.exp2`, Common.sol L57); negative x gives `1e36 / exp2(-x)` | `x < 192e18` | | README avg 2,104 |
| `ln` (L348-352) | `log2(x)·1e18/log2(e)` | `x > 0` | "precision isn't sufficiently fine-grained to return exactly UNIT when the input is E" | README avg 4,724; **measured (UD60x18) 6,395** |
| `log2` (L492-541) | integer part via msb, then up to 60-iteration squaring loop | `x > 0` | "results are not perfectly accurate to the last decimal" | README avg 4,243 |
| `sqrt` (L718-733) | `Common.sqrt(x·1e18)` Babylonian, floor | `0 ≤ x ≤ MAX/1e18` | | README 716; **measured 862** |

Assessment:
- **Pros:** strong typing (`SD59x18`/`UD60x18` with operator overloading), excellent NatSpec, domain checks with custom errors, widely used (Premia v3, Sablier).
- **Cons:** `ln` and `exp` are 5–10× more expensive than Solady. The Premia-style pipeline built on PRB math cost **33.6k gas on average and 56k at worst** in my measurement, versus 2.2–2.7k for Solady-based pipelines.

### 2.3 ABDK Math 64.64

Copy at `repos/rmm-core/contracts/libraries/ABDKMath64x64.sol`, used by Primitive RMM-01 and Premia v2.

- **Format:** signed 64.64 in `int128`. Resolution is 2⁻⁶⁴ ≈ 5.4e-20; the maximum is about 9.2e18.
- **`exp`:** `exp_2(x·log2e)`. It requires `x < 64` (the `0x400000000000000000` check) and returns 0 below −64 (L627-634).
- **`ln`:** `log_2(x)·ln2` (L527-533), where `log_2` is a 64-iteration squaring loop (L476-520).
- **`sqrt`:** rounds down (L463).
- **Gas** (PRB README L343-356, "based on the v3.0 release of ABDKMath"): `ln` ~7,126, `exp` ~2,687, `sqrt` ~699, `mul` 111, `div` 168.
- **License:** `BSD-4-Clause` (header L1), which is less convenient than MIT.

Every value would need converting from WAD, Q64.96 and USDC 6-decimal units. **Not recommended.**

### 2.4 DeFiMath

MerkleBlue/defimath, commit `27b4f67` (2026-09-02), MIT license. A newer library aimed specifically at option math.

- `Math.exp` (L93-176): range reduction to `[0, ln2/64]`, a Padé[3/3] approximant, then 6 squarings.
- `Math.sqrt` (L391-424): seeds with `clz`, then 5 Newton steps.
- `Math.stdNormCDF` (L657-709): Hart rational with `expPositive`.
- `BinaryOptions.call` (`contracts/derivatives/BinaryOptions.sol` L68-98): the full binary price.

The README advertises `stdNormCDF` at 618 gas with error < 3e-15, and binary `call` at 1,913 gas with error < 2e-12. I measured 7.7e-17 and 708 gas for `stdNormCDF`, and 7.8e-15 and about 2,050 gas (after removing harness overhead) for `call`.

**Constraints:**
- The files require `pragma ^0.8.31` and `evmVersion osaka` because of the **CLZ** opcode (EIP-7939).
- I confirmed the file fails to compile for `cancun`: `The "clz" instruction is only available for Osaka-compatible VMs`.
- v4-core itself pins `solc 0.8.26` / `evm_version = "cancun"` (`v4-core/foundry.toml` L6-7). `PoolManager.sol` uses an **exact** `pragma solidity 0.8.26`, while interfaces and libraries use floating pragmas (`IPoolManager` `^0.8.24`, `StateLibrary` `^0.8.0`). `v4-template` uses solc 0.8.30 with cancun. A hook using DeFiMath would therefore need Foundry's per-file multi-version compilation to deploy `PoolManager` in tests, and an osaka EVM target.
- Ethereum mainnet activated Fusaka, which includes EIP-7939 CLZ, on 2025-12-03 at 21:49:11 UTC (EF blog).
- **[Corrected: this was UNVERIFIED; it is now verified]** CLZ is **live today** on Unichain, Base, OP Mainnet, Arbitrum One and Ethereum mainnet. On 2026-09-25 I ran `eth_call` with init code `0x60011e60005260206000f3` (`CLZ(1)`) against each public RPC, and every chain returned `0xff`. As a control, the undefined opcode `0x21` returned `OpcodeNotFound` on Unichain. How each chain got CLZ:
  - OP-Stack chains, including Unichain, got it with the **Karst** upgrade ("Osaka on L2", which includes EIP-7939), scheduled for 2026-07-08 16:00:01 UTC;
  - Base got it with its own **Azul** upgrade (reported 2026-05-28);
  - Arbitrum got it with **ArbOS 50 "Dia"**.

  The Jovian upgrade (2025-12-02) was only "Fusaka readiness" and did **not** enable CLZ on L2. The upgrade names and dates come from web sources; the `eth_call` probe is the primary evidence.
- I found no audit of DeFiMath (README lists none).

### 2.5 Recommendation (libraries)

Use **Solady `FixedPointMathLib`** for `lnWad`, `expWad` and `sqrt`, plus our own CDF (Appendix A, about 40 lines, cancun-compatible, no CLZ):
- It gives about 1e-18 error with the fewest gas of the cancun-compatible options;
- it is MIT-licensed and battle-tested;
- `expWad` and `lnWad` are documented as monotone;
- it takes plain `int256`/`uint256`, which fits Uniswap's Q64.96 and tick integers without wrapper types.

Keep PRB math only as a readable reference or for tests if convenient. Osaka is now available on all candidate chains (§2.4). Even so, a cancun-compatible CDF avoids coupling the hook's EVM target to CLZ. Vendoring DeFiMath's `stdNormCDF` + `expPositive` is an equally good CDF choice: I checked that neither uses CLZ, whose only uses in `Math.sol` are at L212, L263, L399, L411 and L442, inside `ln`, `sqrt` and `sqrtTime`. DeFiMath is unaudited either way.

---

## 3. Normal-CDF implementations found in the wild

My measurements for all of them are in the table in §3.9.

### 3.1 solstat `Gaussian.sol`

Primitive, commit `80c603f`, 2023-11. The README says "This library is in beta. It's not ready for production."

- **Algorithm:** Numerical Recipes `erfcc` (a Chebyshev fit), with `Φ(x) = erfc(−x/√2)/2` (`src/Gaussian.sol` L183-188).
- **Constants** (L50-59): `ERFC_A = 1.26551223, ERFC_B = 1.00002368, … ERFC_J = 0.17087277`.
- **Core** (L94-119):
  ```solidity
  uint256 z = input.abs();
  int256 t = diviWad(ONE, (ONE + int256(z.divWadDown(DOUBLE_WAD))));   // 1/(1+z/2)
  ... k = (-z*z - ERFC_A) + t*(B + t*(C + ... t*J));
  int256 exp = k.expWad();  int256 r = muliWad(t, exp);
  output = (input < 0) ? TWO - r : r;
  ```
  The domain is clamped at `|input| ≥ 6.24` (L38).
- **Stated error:** "Fractional error less than 1.2e-7" (L84) and "Maximum error of 1e-15 compared to Gaussian.js library" (L85, L180).
- **What the differential test really checks.** It uses `vm.ffi` to run an npm script and loads ABI-encoded data with `cat` (`src/test/DifferentialTests.t.sol` L29-62, `EPSILON = 1e3` wei). But `cli/cli.ts` L3-21 **re-implements the same NR `erfc` formula**. **[Corrected detail]** The `cdf` reference vectors (`test/differential/scripts/generate.ts` L18-19) come from the npm `gaussian` package. I fetched that package's `lib/gaussian.js` from unpkg: its `erfc` is the *same* NR Chebyshev formula (1.26551223, 1.00002368, … 0.17087277), and `cdf = 0.5·erfc(−x/√2)`. So the "1e-15" is consistency with the same approximation, not accuracy against the true Φ.
- **Measured:** true max absolute error **4.15e-8** (at x ≈ −0.056); **~4.4k gas**. The gas is high because of checked `muliWad` calls plus solmate `expWad`.

### 3.2 Lyra v1 `BlackScholes.sol`

Newport (#11), 2023-09, `contracts/libraries/BlackScholes.sol`.

- **Algorithm:** the Hart/West double-precision method. The comment says "borrowed from a C++ implementation https://stackoverflow.com/a/23119456" (L351-380).
- **Precision:** internally 27 decimals (`PRECISE_UNIT = 1e27`). But `lnPrecise`/`expPrecise` divide by 1e9, call the 1e18 routines and multiply back, and are commented "Loses 9 last significant digits of precision" (`FixedPointMathLib.sol` L7-15).
- **Constants** (L54-69): `SPLIT = 7.07106781186547`, `N0..N6 = 220.206867912376 … 0.0352624965998911`, `M0..M7 = 440.413735824752 … 0.0883883476483184`.
- **Branches:**
  - `|x| ≤ 37` with `z < SPLIT`: `c = P(z)/Q(z)·e^{−z²/2}`;
  - `z ≥ SPLIT`: a continued fraction `e / ((z + 1/(z + 2/(z + 3/(z + 4/(z + 0.65))))) · √(2π))`.
- **`_d1d2`** (L179-199) clamps `T ≥ 1 s` and `σ ≥ 0.001%` "to not break computation in extreme scenarios". It uses `SECONDS_PER_YEAR = 31536000` (L45).
- **Tests** accept 0.05% relative error (`test/utils/assert.ts` `assertCloseToPercentage` default `0.0005`).
- **Measured:** CDF **4.1e-17**, **~7.1k gas**. The gas is high because of `DecimalMath` rounding helpers and the 1e27↔1e18 conversions. Binary price built from Lyra's `_d1d2` and `_stdNormalCDF`: 1.3e-16, ~14.8k gas.
- **Audits:** Lyra docs mention Avalon audits by Halborn, Sherlock and Iosiro, and earlier audits by Certora, Iosiro and CertiK. **UNVERIFIED** that `BlackScholes.sol` in Newport was in scope.

### 3.3 Premia v2 `OptionMath.sol`

`Premian-Labs_premia-contracts`, 2023-09, BUSL-1.1.

- **Algorithm:** Choudhury (2014) in ABDK 64.64 (`contracts/libraries/OptionMath.sol` L40-43, L197-208):
  ```
  N(x) ≈ e^{−x²/2} / (2260/3989 + 6400/3989·|x| + 3300/3989·√(x²+3))     (for x ≤ 0; 1 − that for x > 0)
  ```
- **Measured (exact arithmetic):** max error **1.40e-4**, with a 2.8e-4 jump at x = 0 because `x > 0` picks the other branch. Away from 0 the error is 1.38e-4. Unsuitable for us.

### 3.4 Premia v3 `OptionMath.sol`

`Premian-Labs/v3-contracts`, 2024-07, uses PRB math.

- **Algorithm:** Haim Shore's "Accurate RMM-based approximations for the CDF of the normal distribution" (L35-57):
  ```solidity
  SD59x18 a = (ALPHA / LAMBDA) * S1;                     // ALPHA=-6.37309208, LAMBDA=-0.61228883
  SD59x18 b = (S1 * x + iONE).pow(LAMBDA / S1) - iONE;   // S1=-0.11105481, S2=0.44334159
  result = ((a * b + S2 * x).exp() * (-iTWO.ln())).exp();
  normalCdf(x) = (1 + helper(-x) - helper(x)) / 2,  clamped to 0/1 for |x| ≥ 9
  ```
- **Test vectors** (`test/libraries/OptionMath.t.sol` L60-93) are the approximation's own outputs, checked with tolerance 1e-16. For example `N(-1) = 0.158655459434782014` versus the true value 0.158655253931457 (a 2.1e-7 difference). Again this is a consistency test, not an accuracy test.
- **Measured:** max error **6.6e-7** (at x ≈ ±3.79); **36.6k gas on average, 42k max**, because of PRB `pow` + 2×`exp` + `ln`, evaluated twice.
- **Audit:** Arbitrary Execution, May–July 2023 (per Premia docs).

### 3.5 Primitive RMM-core `CumulativeNormalDistribution.sol`: constant-reuse bug

`rmm-core/contracts/libraries/CumulativeNormalDistribution.sol` L17-48 implements A&S 7.1.26 in 64.64. Decoding the constants gives:

```
CDF0 = 0.3275911 (p)   CDF1 = 0.254829592 (a1)   CDF2 = -0.284496736 (a2)
CDF3 = 1.414213562373… (√2)   CDF4 = -1.453152027 (a4)   CDF5 = 1.061405429 (a5)
```

`CDF3` is used both as the divisor in `z = x / √2` (L29) and as **`a3`** in the polynomial (L44). A&S 7.1.26 requires `a3 = 1.421413741`.

As a result, `Σaᵢ = 0.99280` instead of 1, so `erf(0⁺) = 0.0072`. The measured CDF error is **3.6e-3 near x = 0**. The NatSpec says "Maximum error: 3.15x10-3" on `getCDF` (L26), yet "1.5×10−7" on `getErrorFunction` (L41).

I confirmed this in the decoded hex: `CDF3 = 0x16a09e667f3bcc908 / 2⁶⁴ = 1.4142135623730951`. `getCDF` is used in production code, namely `ReplicationMath.sol`, the RMM-01 trading invariant. The repo's `audits/` folder lists ABDK, ChainSecurity, Dedaub, Sherlock and Trail of Bits. **[Added]** The repo's own Echidna property `compareCDFimplementations` (`contracts/crytic/LibraryMathEchidna.sol` L86-92) compares `getCDF` to a "paper" version, `getCDFPaper`/`getErrorFunctionPaper` (L56-78). But that version *also* uses `CDF3` as `a3`, so the property passes while the bug stays.

**Lesson:** constant-reuse and transcription bugs are real in audited code, and even fuzzing does not catch them when the reference shares the constants. Differential testing against an independent high-precision reference (mpmath), not a re-implementation of the same approximation, is mandatory.

### 3.6 DeFiMath `Math.stdNormCDF`

See §2.4. It uses the Hart rational **for the whole range |x| < 16.447, with no continued-fraction branch**:

```solidity
uint256 num = (35262496599891100*t4 + 700383064443688000*t3 + 6373962203531650000*t2)/1e18*t2 + 33912866078383000000*t3 + ... + 220206867912376000000e18;
uint256 denom = (88388347648318400*t4 + ... )/1e18*t3 + ... + 440413735824752000000e18;
uint256 expRes = expPositive(t2 >> 1);            // e^{+x²/2}
res = 1e36 / expRes * num / denom;                // Φ(-|x|)
```

My mpmath check shows that dropping the continued fraction costs nothing in absolute terms (same 4.1e-17 over [-10, 10]). **[Corrected]** The draft said the rational tends to exactly the Mills-ratio asymptote. It does not. The rational tends to `(N6/M7)/z = 0.3989496/z`, while the exact asymptote is `1/√(2π) = 0.3989423`. That is a relative difference of 1.8e-5 as z → ∞. The measured relative error of the rational-only tail is 2.9e-9 at z = 7.07, 2.0e-8 at z = 9, and 4.0e-7 at z = 16. West's continued fraction is 6e-9 at z = 9 and 1e-10 at z = 16. The absolute error is negligible, because Φ(−9) ≈ 1.1e-19. So the rational-only form is fine for absolute accuracy but is not tail-exact. The saturation bound 16.447 is really chosen by the domain of `e^{x²/2}` (e^135), not by Φ.

DeFiMath's Foundry suite fuzzes `test_MONO_stdNormCDF` (`test/foundry/Math.t.sol` L230-235). Its Hardhat suite checks against `math-erf`, `black-scholes` and similar JavaScript packages, which are float64-limited.

### 3.7 Others

- **Equinox** (nodesproof/equinox, a 2026 hackathon project on Arbitrum; I checked it against the clone):
  - its Solidity control implementation `contracts/src/math/BlackScholesSol.sol` L55-98 uses **Cody's CALERF** on PRB math;
  - its constants are in `BsConstants.sol`, generated from a Python spec, and its tests are bit-exact against that spec;
  - it measures `normCdf` at 5,435 gas and price+4 Greeks at 24,536 gas (its README).
- **Thales AMM** (positional "ETH above $X" markets, Optimism):
  - their docs say "Thales AMM uses the Black–Scholes algorithm to derive a realistic price for each Positional Token";
  - `ThalesAMMUtils.calculateOdds(price, strike, timeLeftInDays, volatility)` exists in their ABIs, and `ln` apparently comes from DeciMath (RickGriff/decimath);
  - the `thales-markets/contracts` repo now returns 404, so **the implementation is UNVERIFIED**. It is still the closest product precedent: a binary crypto market priced by BS N(d2) on-chain, with spread and skew on top.
- **Dopex SSOV, Hegic, Buffer, Aevo, Panoptic, Deri:** not reviewed in source. As far as I know most use off-chain or oracle pricing, or non-BS curves (Panoptic uses streaming premia). **UNVERIFIED.**

### 3.8 Aloe II volatility

Not a CDF, but relevant to σ. `Volatility.estimate` (`aloe-ii/core/src/libraries/Volatility.sol` L33-86) derives implied volatility from Uniswap v3 fee growth, `IV = 2γ√(volume/valueOfLiquidity)`, using Solady `fullMulDiv`/`sqrt`. It is a possible alternative σ source; see Open questions.

### 3.9 Measured comparison (Foundry, real Solidity, 25,017 points on [-10, 10])

| Implementation | Algorithm | Max abs error (measured) | At x | Avg gas | Max gas |
|---|---|---|---|---|---|
| **ours `NormalCdf.hartWest`** | Hart/West rational + Solady `expWad` | **4.21e-17** | −0.0176 | **899** | 975 |
| ours `NormalCdf.cody` | Cody 1969, 3 ranges + `expWad` | **1.67e-18** | 0.601 | 1,028 | 1,194 |
| ours `NormalCdf.as26217` | A&S 26.2.17 + `expWad` | 7.45e-8 | 0.7173 | 800 | 868 |
| DeFiMath `stdNormCDF` | Hart rational + Padé exp | 7.69e-17 | −0.308 | 708 | 729 |
| Lyra `_stdNormalCDF` | Hart/West at 1e27 | 4.13e-17 | −0.019 | 7,059 | 8,154 |
| solstat `Gaussian.cdf` | NR erfcc + solmate `expWad` | 4.15e-8 | −0.056 | 4,409 | 4,846 |
| Premia v3 `normalCdf` | Shore RMM on PRB math | 6.61e-7 | −3.793 | 36,648 | 42,051 |

The gas figures subtract the 52-gas function-pointer and `gasleft` overhead, measured with an identity function. Saturated inputs (|x| ≥ 9) cost about 140 gas for ours.

---

## 4. Candidate approximation algorithms: formulas, constants and verified errors

I measured every row below in **exact arithmetic** with mpmath at 50 digits, on a 40,001-point uniform grid on [-10, 10] plus local refinement at the worst point. This isolates the algorithm error from fixed-point rounding. Script: `scratchpad/cdf_algos.py`; output: `cdf_algos_40k.txt`.

| Algorithm | Published bound | **Verified max \|Φ̂ − Φ\|** | Worst x | Needs exp? | Fixed-point achievable (WAD) | Gas (measured / estimated) |
|---|---|---|---|---|---|---|
| A&S 26.2.17 (Hastings / Zelen–Severo) | \|ε\| < 7.5e-8 | **7.45e-8** | ±0.717 | yes | 7.45e-8 (measured) | 800 (measured) |
| A&S 7.1.26 (erf) → Φ | erf: 1.5e-7, so Φ ≤ 7.5e-8 | **6.97e-8** | ±0.064 | yes | ≈7e-8 | ~800 (estimated; same shape as 26.2.17) |
| A&S 26.2.19 (no exp) | 1.5e-7 | **1.30e-7** | ±2.761 | **no** (4 squarings + reciprocal) | ≈1.3e-7 | ~350 (estimated) |
| Numerical Recipes `erfcc` (Chebyshev) | fractional < 1.2e-7 on erfc | **4.15e-8** | ±0.056 | yes | 4.15e-8 (solstat, measured) | ~900 if written like ours (estimated); solstat: 4.4k |
| **Hart 1968 #5666 / West 2005** | "accurate to double precision throughout the real line" (West) | **4.10e-17** | ±0.0192 | yes | **4.2e-17 (measured)** | **~900 (measured)** |
| Hart rational only, no continued fraction (DeFiMath) | – | **4.10e-17** on [-10, 10] | ±0.0192 | yes | 7.7e-17 (DeFiMath, measured) | 708 (measured) |
| **Cody 1969 (CALERF)** | Paper abstract: "maximal relative errors ranging down to between 6×10⁻¹⁹ and 3×10⁻²⁰" (Math. Comp. 23, 1969). netlib `specfun/erf` (CALERF) header: "rational functions that theoretically approximate erf(x) and erfc(x) to at least 18 significant decimal digits" | **2.93e-19** | ±0.663 | yes | **1.7e-18 (measured)** | 1,028 (measured) |
| Marsaglia 2004 Taylor series `½ + φ(x)(x + x³/3 + x⁵/15 + …)` | exact in the limit | 1e-19 needs 16 terms (\|x\|=1), 35 (3), 56 (5), 95 (8), ~110 (9) | – | yes | needs extra precision near \|x\| large because of cancellation | ~2–7k (estimated; loop) |
| Choudhury 2014 (Premia v2) | – | **1.40e-4** | 0 | yes | – | – |
| Shore RMM (Premia v3) | – | **6.61e-7** | ±3.793 | exp, ln, pow | 6.6e-7 (measured) | 36.6k (measured) |
| RMM-core 7.1.26 with the a3=√2 bug | (3.15e-3 in its NatSpec) | **3.60e-3** | 0⁺ | yes | – | – |

### 4.1 Formulas and constants

- **A&S 26.2.17.** For z = |x|, let `t = 1/(1+p z)` with `p = 0.2316419`. Then
  `Q(z) = φ(z)·(b1 t + b2 t² + b3 t³ + b4 t⁴ + b5 t⁵)`,
  with `b = [0.319381530, −0.356563782, 1.781477937, −1.821255978, 1.330274429]`.
  Φ(x) = 1 − Q for x ≥ 0, else Q.
- **A&S 7.1.26.** `erf(z) ≈ 1 − (a1 t + … + a5 t⁵) e^{−z²}` with `t = 1/(1+0.3275911 z)`,
  `a = [0.254829592, −0.284496736, 1.421413741, −1.453152027, 1.061405429]`, and `Φ(x) = ½(1 + erf(x/√2))`.
- **A&S 26.2.19.** `Q(z) = ½(1 + d1 z + … + d6 z⁶)^{−16}`,
  `d = [0.0498673470, 0.0211410061, 0.0032776263, 0.0000380036, 0.0000488906, 0.0000053830]`.
  This is the only option with no `exp`, but it is 1.3e-7 accurate.
- **NR `erfcc`.** `erfc(z) ≈ t·exp(−z² − 1.26551223 + t(1.00002368 + t(0.37409196 + t(0.09678418 + t(−0.18628806 + t(0.27886807 + t(−1.13520398 + t(1.48851587 + t(−0.82215223 + t·0.17087277)))))))))` with `t = 1/(1+z/2)`.
- **Hart/West.** For `z = |x|`:
  - if `z > 37`, the tail is 0;
  - if `z < 7.07106781186547` (= 10/√2), `tail = e^{−z²/2}·P(z)/Q(z)` with
    `P = [220.206867912376, 221.213596169931, 112.079291497871, 33.912866078383, 6.37396220353165, 0.700383064443688, 0.0352624965998911]` (ascending powers) and
    `Q = [440.413735824752, 793.826512519948, 637.333633378831, 296.564248779674, 86.7807322029461, 16.064177579207, 1.75566716318264, 0.0883883476483184]`;
  - otherwise `tail = e^{−z²/2} / (2.506628274631 · (z + 1/(z + 2/(z + 3/(z + 4/(z + 0.65))))))`.

  Φ = 1 − tail for x > 0, else tail. Source: West (2005), "Better approximations to cumulative normal functions", Wilmott; I extracted the pseudocode from the PDF (p. 3). Note that `P0/Q0 = 0.5` exactly, so Φ(0) = 0.5 exactly.
- **Cody (CALERF).** Three ranges for `y = |x|/√2`:
  - `y ≤ 0.46875`: erf rational `x·(A…)/(B…)`;
  - `0.46875 < y ≤ 4`: `erfc = e^{−y²}·(C…)/(D…)` (degree 8/8);
  - `y > 4`: `erfc = e^{−y²}/y·(1/√π − y⁻²·(P…)/(Q…))`.

  The full constants are in `NormalCdf.cody` (Appendix A lists where). They are netlib's double-precision coefficients truncated to 18 decimals. For example, `C8 = 2.1531153547e-8` loses its trailing digits, which contributes ≪ 1e-18 after multiplication by t⁸. I diffed all 37 A/B/C/D/P/Q constants against `equinox/contracts/src/math/BsConstants.sol`: they are identical (ours names the B-array `CB0..CB3`). **[Corrected] They do *not* all match netlib.**
  - Diffing against the raw `https://www.netlib.org/specfun/erf` (L181/L187), 36 of 37 agree to within 1 wei.
  - **`Q1` is wrong in both ours and Equinox**: `1872952849923467250` (1.87295284992346725) versus netlib's **1.87295284992346047**, a transcription error in the last 3 digits (relative 3.6e-15).
  - `Q` is used only in the |x| > 4√2 ≈ 5.657 range, where Φ(−|x|) < 7.7e-9. The numerical effect is therefore below 1e-22, far under 1 wei, and the measured error is unchanged.
  - It is, however, a second live example of the RMM-style lesson: copying constants from another implementation propagates its mistakes. Take constants from the primary source (netlib) and diff them mechanically in CI.

### 4.2 Domain handling and saturation

- **Symmetry.** Compute the tail `c = Φ(−|x|)` once and return `x < 0 ? c : 1 − c`. With a shared tail computation, **`Φ(x) + Φ(−x) = 1e18` holds exactly in fixed point**. I checked this by fuzzing (100k runs) for our Hart implementation. This makes NO = 1 − YES exact.
- **Saturation.** Φ(−8) = 6.2e-16, Φ(−8.3) = 5.2e-17, Φ(−8.5) = 9.5e-18, **Φ(−9) = 1.13e-19 (below 1 wei)**, Φ(−10) = 7.6e-24. Clamping at |x| ≥ 9 costs at most 0.11 wei. It also keeps `z²/2 ≤ 40.5`, inside `expWad`'s range, which returns 0 below −41.45.

---

## 5. Full binary-price algorithm specialized to Uniswap

### 5.1 Getting x = ln(S/K) without, or with one, on-chain ln

**Orientation.** v4 pools are sorted by currency address.
- For **native ETH (currency0) / USDC (currency1)**, the raw price `P = token1/token0 = S_usd · 10^(6−18) = S·1e-12`. Examples: `tick(S=3000) ≈ −196,256.3`, `tick(K=5000) ≈ −191,147.8`.
- For **WETH/USDC** on mainnet, USDC (0xA0b8…) < WETH (0xC02a…), so USDC is currency0 and `P = 1e12/S`, which flips the sign of `x`.

Store a sign `s = ±1` per market and use `x = s·(ln P_S − ln P_K)`.

The pool's `sqrtPriceX96` and tick come from `StateLibrary.getSlot0(manager, poolId)` (`v4-core/src/libraries/StateLibrary.sol` L40-63), which is one `extsload` of the packed slot.

Three front-ends:

| Source of S | Formula (WAD) | Measured error | Gas |
|---|---|---|---|
| Spot `sqrtPriceX96` (exact pool price) | `lnP = 2·(lnWad(sqrtPriceX96) + LN_OFFSET)`, `LN_OFFSET = ln(1e18) − 96·ln2 = −25.095597659861927392e18` | ≤ **2.6e-18** (3,003 vectors, incl. MIN/MAX sqrt price) | **878** |
| TWAP from a tick-cumulative difference | `lnP = Δcum · LN_1_0001_E36 / (dt · 1e18)`, `LN_1_0001_E36 = 99995000333308335333166680951131` | ≤ **1.0e-18** (3,000 vectors) | **202** |
| Exact tick (e.g. a strike stored as a tick) | `lnP = tick · LN_1_0001_E36 / 1e18` | ≤ 1e-18 | ~150 (estimated) |

Notes:
- The naïve `(tick_S − tick_K)·ln(1.0001)` is exact only if both are exact ticks. A pool's current tick is normally **floor(log₁.₀₀₀₁ P)**, so using it for S adds up to 1 tick (1e-4 in ln) of error. See §6 for the price impact, which is large near expiry.
- **[Added] `slot0.tick` is not always `getTickAtSqrtPrice(slot0.sqrtPriceX96)`.** Suppose a zeroForOne swap ends exactly on an initialized-tick boundary. Then v4 sets `tick = tickNext − 1` while the price equals the boundary price, so the tick is **one less** than the floor. The v4-core source comment says so explicitly (`v4-core/src/libraries/Pool.sol` L409-412, L431). Anything that compares or prices with `slot0.tick`, including settlement written as a tick comparison, must allow for this. Comparing on `sqrtPriceX96` avoids the problem.
- `ln(1.0001)` in WAD (`99995000333308`) has 0.33 wei of representation error, which is 3.3e-15 relative error per tick of distance. Use the 1e36 constant instead.
- The Uniswap v3 `OracleLibrary.consult` **floors** the mean tick. It computes `arithmeticMeanTick = int24(tickCumulativesDelta / secondsAgo)`, which truncates toward zero, then decrements for negative non-exact values ("Always round to negative infinity"; `v3-periphery/contracts/libraries/OracleLibrary.sol`, the `consult` body, fetched from GitHub `main`; the line numbers in the fetched copy are approximate). That is up to 1 tick of error. **Keep `Δcum/dt` fractional instead**, as in the table above.
- Even an un-truncated TWAP tick is the time average of *floored* ticks. It is biased low by the mean fractional part, which is in [0, 1) and about 0.5 tick on average. Adding `+0.5` tick (`+4.99975e-5` in ln) centers the bias to within ±0.5 tick.
- v4-core has **no built-in oracle**. A TWAP needs an oracle hook on the underlying pool; for example OpenZeppelin's `BaseOracleHook` with Panoptic's truncated oracle (`oz-uniswap-hooks/src/oracles/panoptic/libraries/Oracle.sol` L23-60, whose `Observation` includes `tickCumulative` and a `maxAbsTickDelta`-clamped `tickCumulativeTruncated`).
- **[Added] Manipulation.** Spot `sqrtPriceX96` is exact but can be moved atomically within the same transaction (see Summary item 7). The table above ranks inputs by *numerical* precision only.
- **Strike storage.** Store `lnStrikeWad` (int256, computed once at market creation, e.g. `lnWad(K·10^(dec1−dec0)·1e18)`, or passed in and validated) **and** the strike as `sqrtPriceX96_K` or a tick. Settlement `S_T > K` then becomes an exact integer comparison (`sqrtPriceX96_T > sqrtPriceX96_K`, or for a TWAP settlement `Δcum > tickK·dt`), with no `ln` needed at settlement. The stored `sqrtPriceX96_K` or tick is then the *canonical* strike, because K·1e-12 is generally not exactly representable. Define the market's strike as that integer, and derive `lnStrikeWad` from it, so that pricing and settlement use the same K.

### 5.2 Getting w = σ²τ (variance) from the same Uniswap market

With tick samples `tick_i` at times `t_i` (for example, sampled by a hook on the underlying pool), the realized variance per second is:

```
σ̂_s² = ln(1.0001)² · Σ (Δtick_i)² / Σ Δt_i
```

- **Accumulate exact integers.** Keep `sumSq += Δtick²` (uint) and `sumDt += Δt`. Then:
  `varE36 = sumSq · LN_TICK_SQ_E36 / sumDt`, with `LN_TICK_SQ_E36 = ln(1.0001)²·1e36 = 9999000091658334094374450926` (rounded to nearest; the exact value is …925.98, so floor is …925).
  This has one rounding, so the relative error is about 1e-28.
- **Do not store variance per second in WAD.** For σ_a = 60%, σ_s² = 1.14e-8, which is only `11415525114` in WAD: about 10 significant digits, and a 8.8e-11 relative truncation error. Use 1e36 scale, or store annualized σ² in WAD and compute `w = σ_a²·τ/31536000` with a single rounding.
  - **[Added] Why this matters for the 1e-12 target.** Since ∂P/∂ln w = −n(d2)·d1/2, and |n(d2)·d1| ≤ ≈0.24 (§6.1), a relative error of 8.8e-11 in w moves P by up to about 0.12 × 8.8e-11 ≈ **1e-11**. That is 10× the 1e-12 target.
  - The measured "pool path" error of 2.65e-16 does **not** show this, because its mpmath reference is built from the already-truncated `varPerSecWad` integer. So `varE36` (or annual σ² in WAD) is required, not merely recommended.
- **Tick-rounding bias.** Each observed Δtick includes the difference of two floor-rounding errors, which adds about **1/6 tick²** of variance per return. With σ = 60%:

  | Sampling interval | True variance per return (tick²) | σ bias |
  |---|---|---|
  | 1 s | 1.14 | **+7.1%** |
  | 2 s | 2.28 | +3.6% |
  | 12 s | 13.7 | +0.61% |
  | 1 min | 68.5 | +0.12% |
  | 5 min | 342 | +0.02% |

  Either sample at ≥ 1 minute, or subtract `(1/6)·n` tick² from `sumSq`, or use `sqrtPriceX96`-based log returns.
- **TWAP-mean differences.** If returns are formed from consecutive TWAP means over windows Δ, the variance of their differences is **(2/3)σ²Δ** for Brownian motion (Working 1960; my simulation gives 0.6665), and first differences are autocorrelated. Multiply by 3/2.
- **Sampling error.** σ̂ has relative standard error of about `1/√(2n)` for Gaussian returns: 14% for n = 24, 4.2% for n = 288, 1.9% for n = 1,440. **[Added]** With excess kurtosis κ, which is typical for crypto returns, it is about `√((2+κ)/(4n))`, so it is larger. This, not the math, dominates the pricing error (§6).
- **[Added] Model caveat for the 1/6 figure.** The 1/6 tick² comes from a continuous-diffusion model. I re-simulated it: +0.1669 tick² at 1.14 tick² per return, and σ bias +7.06%. For returns below about 0.5 tick², the excess departs from 1/6; at 0.1 tick² the simulation gives +0.152. Real pool prices move only on swaps (piecewise constant with jumps), so validate the correction on historical pool data.
- **Then:** `w = varE36 · τ / 1e18` (WAD). For an EWMA variant, the decay factor `e^{−Δt/H}` costs one `expWad` (~460 gas).

### 5.3 The price

```
Inputs: x (WAD, int), w (WAD, uint), ρ = r_s·τ (WAD, uint; 0 by default)
1. if w == 0: return x > 0 ? 1e18 : 0                       // no variance left: step function
2. sqrtW = sqrt(w · 1e18)                                   // WAD, floor (Solady, ~400 gas)
3. d2    = (x + ρ − w/2) · 1e18 / sqrtW                     // WAD, sdiv truncates toward 0
4. P     = Φ(d2)                                            // Hart/West, ~900 gas, 4.2e-17
5. if ρ ≠ 0: P = P · expWad(−ρ) / 1e18                      // discount (only if r > 0)
YES = P;   NO = (ρ == 0) ? 1e18 − P : e^{−ρ}·Φ(−d2)
```

Measured results for this core (`BinaryPricer.priceYes`, Appendix A), on 8,500 vectors: annualized σ from 5% to 300%, τ from 1 s to 400 days, |moneyness| up to 6σ√τ, plus 2,000 near-expiry at-the-money stress cases and 500 extreme-tail cases:
- **max error 8.15e-16**; the worst case was x = 3 ticks, √w = 3.1e-4;
- gas 787 min / 1,727 avg / 2,070 max, including about 100 gas of harness array reads.

Full pool path (`priceYesFromPool`: `sqrtPriceX96` → `lnWad` → x, then `w = var·τ`), 3,000 vectors: **2.65e-16**, 2,238 gas on average.

### 5.4 r = 0 versus r > 0

- **r = 0** (recommended for short crypto markets): `d2 = (x − w/2)/√w`, and **YES + NO = 1 exactly**. This is consistent with complete-set minting of 1 USDC ↔ 1 YES + 1 NO, which redeems for exactly 1 USDC.
- **r > 0**: YES + NO = e^{−rτ} < 1. The hook would then buy or sell a complete set below the 1 USDC it redeems for at expiry. That is only coherent if the collateral actually earns r (for example, it sits in a yield vault). Otherwise it is a transfer to whoever buys sets: they buy at e^{−rτ} and redeem at 1 while the pool's collateral earns nothing. It is a riskless gain for anyone whose funding cost is below r.

  The per-second rate is `r_s = r_a/31,536,000`, and `ρ = r_s·τ ≤ 0.1·(90/365)` is tiny, so one `expWad` costs about 460 gas. The measured spot/strike path with random r ∈ [0, 10%] had max error 1.07e-14.

### 5.5 Edge cases

| Case | Behaviour / recommendation |
|---|---|
| τ ≤ 0 (at or after expiry) | No trading. Settle YES = 1 iff `S_T > K` (exact integer compare in sqrt-price or tick space); tie `S_T == K` goes to NO, per the spec. |
| τ → 0 before expiry | Mathematically fine: the pipeline stays accurate. The measured worst at √w = 3.6e-5 is ≤ 1e-15 numerical error. But price sensitivity explodes (§6), so a **trading cutoff** is needed; e.g. stop when √w < 3e-3, which is about 13 min at σ = 60%. Lyra clamps T ≥ 1 s and σ ≥ 0.001% (`_d1d2` L189-190). |
| σ → 0 (w = 0) | Guard: return the step function `x > 0 ? 1 : 0`. (The prototype returns the *undiscounted* step even when ρ ≠ 0; that is harmless when r = 0.) Also enforce a σ floor, e.g. 5%, so an oracle glitch cannot produce a near-step price. |
| \|d2\| large | Saturate at \|d2\| ≥ 9 (error < 0.12 wei). No overflow. **[Corrected bound]** v4 ticks lie in ±887,272, so \|ln P\| ≤ 887272·ln(1.0001) ≈ 88.7 and \|x\| ≤ ≈177.4. The draft's "≈ 222" was a looser but still safe bound. The minimum `sqrtW` is 1e9 when w = 1 wei, so \|d2\| ≤ ≈1.8e29 in WAD, far from overflow. |
| x = 0, w small | P = Φ(−√w/2) ≈ ½ − 0.2√w, continuous; no special case. |
| Rounding | Truncation toward zero in `sdiv`, plus floors in `sqrt` and Φ. The total numerical ε is bounded (§6.2). **Quote conservatively:** `ask = min(1e18, P + ε)`, `bid = P > ε ? P − ε : 0`, and compute USDC amounts with `mulDivUp` for trader-pays and `mulDiv` (floor) for trader-receives, at 6 decimals. |

---

## 6. Error propagation

### 6.1 Analytic sensitivities (r = 0)

With `P = Φ(d2)`, `d2 = x/√w − √w/2` and `d1 = d2 + √w`:

```
∂P/∂x  = n(d2)/√w                       → |δP| ≤ 0.39894·|δx|/√w
∂P/∂σ  = −n(d2)·d1/σ                    → |δP| ≤ n(d2)|d1|·|δσ/σ|  (max over x of n(d)|d| = n(1) = 0.242)
∂P/∂w  = −n(d2)·d1/(2w)
Numerical: |δP| ≤ ε_Φ + 0.39894·( |δx| + |δ(w/2)| + |d2|·|δ√w| + 1e-18·√w ) / √w
```

At the money, σ errors barely matter: δP ≈ n(0)·(√w/2)·(δσ/σ). Away from the money, up to 0.242·δσ/σ as √w → 0.

**[Corrected]** Because d1 = d2 + √w, the exact maximum over x of n(d2)·|d1| is n(d*)·(d* + √w), where d* = (−√w + √(w+4))/2. That grows with √w: 0.242 at √w → 0, about 0.25 at √w = 0.03, and **0.32 at √w = 0.30**. This matches the σ +10% column below, which rises from 2.3e-2 to 3.1e-2.

### 6.2 Numbers (σ = 60%, r = 0; worst case over moneyness)

Script: `scratchpad/error_budget.py`. The fact-check recomputed every column except "δx = 1e-6" and "numerical δx", which follow from the same formula; all values matched (`scratchpad/fc03/check2.py`).

| τ | √w | 1 tick (spot floor) | 0.5 tick (TWAP bias) | δx = 1e-6 | numerical δx = 2e-18 | σ +1% | σ +5% | σ +10% | σ +10% at ATM | 12-s time step | 1-s time step |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 min | 8.3e-4 | **4.8e-2** | 2.4e-2 | 4.8e-4 | 9.6e-16 | 2.4e-3 | 1.2e-2 | 2.3e-2 | 1.7e-5 | **2.7e-2** | 2.0e-3 |
| 5 min | 1.9e-3 | 2.2e-2 | 1.1e-2 | 2.2e-4 | 4.3e-16 | 2.4e-3 | 1.2e-2 | 2.3e-2 | 3.7e-5 | 5.0e-3 | 4.1e-4 |
| 1 h | 6.4e-3 | 6.2e-3 | 3.1e-3 | 6.2e-5 | 1.2e-16 | 2.4e-3 | 1.2e-2 | 2.3e-2 | 1.3e-4 | 4.1e-4 | 3.4e-5 |
| 1 day | 3.1e-2 | 1.3e-3 | 6.4e-4 | 1.3e-5 | 2.5e-17 | 2.5e-3 | 1.2e-2 | 2.4e-2 | 6.3e-4 | 1.7e-5 | 1.4e-6 |
| 7 days | 8.3e-2 | 4.8e-4 | 2.4e-4 | 4.8e-6 | 9.6e-18 | 2.6e-3 | 1.3e-2 | 2.5e-2 | 1.7e-3 | 2.6e-6 | 2.2e-7 |
| 30 days | 0.17 | 2.3e-4 | 1.2e-4 | 2.3e-6 | 4.6e-18 | 2.8e-3 | 1.4e-2 | 2.7e-2 | 3.4e-3 | 6.6e-7 | 5.5e-8 |
| 90 days | 0.30 | 1.3e-4 | 6.7e-5 | 1.3e-6 | 2.7e-18 | 3.2e-3 | 1.6e-2 | 3.1e-2 | 5.9e-3 | 2.5e-7 | 2.1e-8 |

The CDF approximation error is additive:

| CDF | Error |
|---|---|
| Hart (ours) | 4.2e-17 |
| Cody (ours) | 1.7e-18 |
| A&S / NR | 4e-8 to 1.3e-7 |
| Shore (Premia v3) | 6.6e-7 |

Error budget of the measured pipeline, conservative:
- `lnWad` path: δx ≤ 3e-18.
- `w` rounding: ≤ 1e-18.
- `√w` floor: ≤ 1e-18.
- `d2` division: ≤ 1e-18.
- So `δd2 ≤ (4e-18 + 1e-18·|d2|)/√w + 1e-18`, and for √w ≥ 1e-5 (below any sane trading cutoff), `δP ≤ 0.4·δd2 + ε_Φ ≲ 3e-13`. The fact-check tightened this: max over d of n(d)(4+|d|) = 1.64, reached at d ≈ 0.24, which gives δP ≲ 1.7e-13 + ε_Φ. So 3e-13 is a safe, conservative bound.
- **[Added]** This budget assumes the *inputs* are exactly what the model is evaluated on. Input representation errors are separate and can be larger. For example, per-second variance stored in WAD contributes up to about 1e-11 (§5.2).

Measured maxima are far below that bound: **8.2e-16** (core), **2.7e-16** (pool path), **1.1e-14** (spot/strike inputs, where two `lnWad`s and annual→per-second rounding at τ = 60 s drive it).

### 6.3 Recommended accuracy target

**|P_onchain − P_model(onchain inputs)| ≤ 1e-12 absolute per $1 payoff**, over the supported domain (√w ≥ 1e-5, |x| ≤ 5).

Rationale:
- USDC has 6 decimals, so 1e-12 × $1M notional = 1 USDC base unit. The numerical error is below 1 wei of USDC for any trade up to $1M.
- We meet it with about 100× margin. Measured errors are ≤ 1.1e-14, and ≤ 1e-15 on the Uniswap-native paths.
- A&S-class CDFs (7.5e-8) would be economically tolerable ($0.075 per $1M) but would fail tight "matches the model" proofs. They also save only about 100 gas, so there is no reason to use them.

The *model and input* uncertainty is 1e-4 to 5e-2 (the tables above). That must be priced by spread, fees and a cutoff, not by math precision.

**Choice of algorithm:** **Hart/West** (single branch for |z| < 9, about 900 gas, 4.2e-17, symmetric, fuzz-monotone), or **Cody** if we want about 1e-18 (about 1,030 gas, three branches plus seams).

---

## 7. Gas

Measured with `gasleft()` deltas around internal library calls, legacy optimizer, runs = 10,000.

| Operation | Gas (avg) | Notes |
|---|---|---|
| Solady `expWad` / `lnWad` / `sqrt(x·1e18)` | 463 / 580 / 460 | includes ~20–40 gas of harness; Remco documents 411 and 585–614 |
| PRB v4.2 `exp` / `ln` (UD60x18) / `sqrt` | 2,855 / 6,395 / 862 | |
| ln P from tick-cumulative delta | **202** | |
| ln P from `sqrtPriceX96` | **878** | |
| Φ, ours Hart / Cody / A&S | **899** / 1,028 / 800 | 52-gas harness subtracted |
| Φ, DeFiMath / Lyra / solstat / Premia v3 | 708 / 7,059 / 4,409 / 36,648 | |
| **Binary core `priceYes(x, w, ρ)`** | **1,727** (max 2,070) | includes ~100 gas of array reads |
| **Full pool path `priceYesFromPool`** | **2,238** (max 2,559) | includes ~130 gas of harness |
| Spot/strike path `priceYesSK` (2×`lnWad`, annualized inputs) | 2,747 (max 3,380) | |
| DeFiMath `BinaryOptions.call` | 2,213 (max 2,446) | README: 1,913 without harness; about 2,050 after subtracting the estimated harness overhead |
| Lyra-based binary (`_d1d2` + CDF + `expPrecise`) | 14,827 | |
| Premia-v3-style PRB pipeline | **33,574** (max 56,022) | |

**Estimated full pricing cost in a hook swap** (the storage costs are estimates, not measured):
- compute: about 2.2k;
- `getSlot0` via `extsload`: the PoolManager address is warm inside the callback; the *underlying* pool's slot is usually cold in a prediction-market swap (2,100 gas) plus a warm CALL (~100) and ABI overhead, so about 2.5k;
- market parameters (ln-strike, expiry, sign) packed in 1–2 cold slots: 2.1–4.2k;
- variance state: 1–2 cold slots, 2.1–4.2k.

That is **about 9–13k gas**, well inside the 30–50k target. Two caveats:
- A binary search over a large oracle ring buffer (v3-style `observe`) costs about log₂(cardinality) cold SLOADs, i.e. 20k+. Prefer storing our own cumulative snapshots.
- If we integrate a price-impact curve over the order size, add one more `priceYes` evaluation (about 1.7k).

The math is no longer the bottleneck; storage reads are.

---

## 8. Reference implementations and differential-testing harness

### 8.1 How others test

| Project | Reference | Mechanism | Caveat |
|---|---|---|---|
| solstat | JavaScript re-implementation of the same NR formula + `gaussian` npm package | `vm.ffi(["npm", …, "generate"])` writes files; `vm.ffi(["cat", path])` + `abi.decode(int256[129])`; `EPSILON = 1e3` wei (`src/test/DifferentialTests.t.sol` L17-62) | Compares against the same algorithm, so it does not measure true error. Their `ffi = true`, `fuzz.runs = 100000` (foundry.toml). |
| DeFiMath | JavaScript packages `math-erf`, `black-scholes`, `greeks`, `simple-statistics` (float64) | 755 Hardhat tests + 114 Foundry properties × 32k runs (monotonicity, identities, bounds, seams) | Float64 references cap verifiable error at ~1e-15. |
| Equinox | Python executable spec | Generated constants + vectors, **bit-exact** equality in Solidity and Rust | Proves consistency, not accuracy, unless the spec is itself checked against mpmath. |
| Premia v3 | Hard-coded vectors | `assertApproxEqAbs(…, 1e-16)` against the approximation's own values | Consistency only (true error 6.6e-7). |
| Lyra | TypeScript `stdNormalCDF` | `assertCloseToPercentage` 0.05% | Loose. |

### 8.2 Recommended harness (built and exercised in `scratchpad/bsbench`)

1. **Reference generator (Python, uv, mpmath at 60 digits).** `gen_vectors.py` computes every reference from the **exact integer inputs** the contract receives, e.g. `ncdf(mpf(x)/1e18)` and `2·ln(v/2⁹⁶)`. It rounds to the nearest integer at **1e24 scale** so sub-wei errors are visible. It uses a deterministic seed and writes one ABI-encoded `int256[]` per column (`0x20 ‖ len ‖ words`).

   Vector families: a uniform grid step of 1e-3 on [-10, 10]; random 18-decimal values in [-4, 4]; branch seams (7.0710678…, ±9, Cody 0.46875·√2 and 4·√2); near-expiry ATM stress (τ ≤ 600 s, x within ±5 ticks); far tails; Uniswap extremes (`MIN_SQRT_PRICE`, `MAX_SQRT_PRICE−1`, 2⁹⁶).
2. **Foundry reads the files without FFI.** `abi.decode(vm.readFileBinary("vectors/x.bin"), (int256[]))` with `fs_permissions = [{access="read", path="./vectors"}]`. This is deterministic and fast: 25k vectors × 7 implementations ran in 1.4 s. Each test records max |error| (1e-24 units), the argument at the max, and gas min/avg/max. **[Corrected]** The prototype `test/Differential.t.sol` only logs these values and contains no `assert`. The production suite must add `assertLe(maxErr, ε_fn)` so that a regression fails CI. I re-ran it on 2026-09-25 and it reproduced every figure in Appendix B exactly.
3. **FFI fuzz profile** (optional, slow): `vm.ffi(["uv","run","ref.py","cdf",vm.toString(x)])` with Foundry-fuzzed inputs, around 500–2,000 runs, in a separate profile with `ffi = true`. This finds regions the fixed vectors miss.
4. **Property fuzzing.** 100k runs each (set with `FOUNDRY_FUZZ_RUNS=100000`, because the prototype `foundry.toml` has no `[fuzz]` section and the default is 256); all pass for ours. I re-ran them on 2026-09-25 and all 6 passed at 100k runs. Inputs are bounded to |x| ≤ 12e18 (CDF) or |x| ≤ 30e18 with w ∈ [1e9, 5e18] (pricer). So the **`type(int256).min` defect in Appendix A was outside the fuzzed domain**. Always include unbounded-input properties, or explicit input validation, in production.
   - bounds `0 ≤ Φ ≤ 1e18`;
   - **`Φ(x) + Φ(−x) == 1e18` exactly**;
   - monotone in x (random pairs and adjacent ≤ 1000 wei);
   - `priceYes` monotone in spot;
   - YES + NO = 1e18 exactly with the shared `d2`.
5. **Seam scans.** Check every consecutive-wei pair around branch points and `exp` range-reduction seams. Results: 800,000 random consecutive pairs gave **0 violations** for ours (Hart and Cody) and for DeFiMath; ±200k wei around Cody's 4 seams gave 0 violations. I re-ran both and got the same result. They are logged, not asserted, in the prototype. This is evidence, not proof.
6. **Gas budgets.** Subtract a measured harness baseline (52 gas here) or use `vm.snapshotGasLastCall` / `forge snapshot --check`, and assert budgets, e.g. `priceYes < 2,500`.
7. **End-to-end (next phase).** Run real `PoolManager` swaps (v4 `Deployers`, `PoolSwapTest` / Universal Router), then assert:
   - the realized `BalanceDelta` matches `amount × P_mpmath` within `amount·ε + 1` base unit;
   - the rounding direction always favors the pool;
   - `YES.totalSupply − NO.totalSupply` accounting and solvency invariants hold under stateful fuzzing.
8. **Optional bit-exact Python emulation** of the Solidity (big-int EVM semantics: `sdiv` truncation, `sar` floor). This allows 10⁷–10⁸ offline points and exhaustive seam sweeps; it is the Equinox-style "executable spec" and should itself be validated against mpmath.
9. **Tooling notes.** forge 1.8.3 and solc 0.8.37 run fine from standalone binaries (no `foundryup` needed). Target `cancun` with solc 0.8.26+ to match v4-core, unless osaka-only libraries such as DeFiMath are used. Osaka is live on every candidate chain (§2.4). But `PoolManager.sol` is pinned to exactly `0.8.26`, so a DeFiMath dependency (`^0.8.31`) forces a mixed-compiler build.

---

## Implications for our design

1. **Math stack.** Solady `FixedPointMathLib` (`lnWad`, `expWad`, `sqrt`) plus our own `NormalCdf.hartWest` (Appendix A), or Cody where we want about 1e-18. The code is cancun-compatible, MIT and about 2.2k gas per quote. Do **not** use PRB math on the hot path (15× gas), or Premia v3, solstat or RMM-core CDFs (errors 4e-8 to 3.6e-3). All candidate chains now have CLZ (§2.4), so DeFiMath is technically usable. It is still unaudited and forces solc ≥ 0.8.31/osaka next to v4-core's pinned 0.8.26. Vendoring its two CLZ-free functions is fine.
2. **Represent state in log and per-second-variance space:**
   - `lnStrikeWad` (int256) + `sqrtPriceX96_K` (or a tick) for settlement;
   - an orientation sign `s`;
   - variance as `varE36` (per second, 1e36), or annual σ² in WAD — **never per-second variance in WAD**;
   - `τ` in seconds from `block.timestamp`.

   Then `d2 = (x − w/2)/√w`, with one `sqrt` and no annualization.
3. **Spot input:** for *precision*, take S from `sqrtPriceX96` via `lnWad` (3e-18), not from the floored tick. Note that `slot0.tick` can even be floor − 1 at a tick boundary (§5.1). **[Added] For safety, a same-block spot read is manipulable.** Whether S comes from spot, a lagged spot or a TWAP is a security decision (see the hook-security research), and the numerical results here hold for any of them. A 1-tick error alone is up to 4.8e-2 in price near expiry. For a TWAP input, keep `Δcum/dt` fractional (no `int24` truncation as in `OracleLibrary.consult`) and consider the +0.5-tick floor-bias correction.
4. **Variance estimator:**
   - integer `Σ(Δtick)²` and `ΣΔt`, converted with `LN_TICK_SQ_E36`;
   - sample at intervals of 1 minute or more, or subtract the 1/6-tick² floor noise per sample;
   - apply the 3/2 factor if returns are built from differences of TWAP means;
   - expect about 1/√(2n) relative σ error from sampling (more with fat tails).
5. **r = 0 by default.** YES + NO = 1 exactly, consistent with 1 USDC ↔ 1 YES + 1 NO complete sets. r > 0 breaks that unless collateral earns r.
6. **Conservative quoting:** `ask = P + ε`, `bid = P − ε`. Use ε = 1e-13 by default: it covers the measured worst case of 1.1e-14 on the spot/strike path and sits below the analytic bound of about 3e-13 for √w ≥ 1e-5. ε = 1e-15 is enough for the Uniswap-native paths, whose measured errors are ≤ 8.2e-16. Use `mulDivUp` when the trader pays and floor when the trader receives, at USDC's 6 decimals. Numerical error then can never extract value from LPs.
7. **Protection against input and model risk:** spread and fees plus a trading cutoff or a fee that scales with 1/√w. Near expiry, one L1 block (12 s) or one tick moves the ATM price by 2–5 cents per $1. On Unichain, with 1-s blocks, the per-block time step is about 2e-3 at 1 minute to expiry; the tick sensitivity is unchanged. A 10% σ error moves prices by up to 2.3 cents at any tenor. These dominate numerical error by 10¹⁰×.
8. **Saturation and guards:** `|d2| ≥ 9` → 0/1; `w == 0` → step function; a σ floor and cap; no trading at `τ ≤ cutoff`; settlement by exact integer comparison (on `sqrtPriceX96`, or on ticks with the floor − 1 caveat); fix the `int256.min` case in `hartWest`; validate input ranges instead of relying on `unchecked` everywhere.
9. **Gas budget:** about 2.2k compute + 5–10k storage reads per swap. Choose algorithms for accuracy; gas is not a constraint for the math. Keep oracle reads O(1): our own snapshots, not a binary search.
10. **Proof strategy:**
    - accuracy vs mpmath (1e24-scale vectors, ε ≤ 1e-12 asserted; the prototype only logs, so add the asserts);
    - algebraic properties (exact YES+NO, monotonicity, bounds);
    - seam scans;
    - gas budgets;
    - then end-to-end swaps through the real `PoolManager`, with rounding-direction and solvency invariants.

---

## Open questions

1. **σ source and manipulation resistance.**
   - Does the ETH/USDC v4 pool we read have (or can it get) an oracle or variance hook? We cannot observe another pool's swaps unless we are its hook.
   - Alternatives: sample `slot0` on our own interactions (sparse, manipulable), read a v3 pool's `observe()`, use Aloe-style fee-growth implied volatility, or maintain an EWMA updated by keepers.
2. **Settlement definition.** Spot at the first block ≥ expiry, or a TWAP window? The TWAP gives a different payoff (an Asian binary), which Black–Scholes N(d2) misprices near expiry. Confirm the rule that a tie (`S_T == K`) goes to NO.
3. **Trading cutoff and near-expiry policy.** What minimum √w (for example 3e-3, about 13 min at σ = 60%) or fee schedule? Should the price switch to a TWAP of S late in the market's life?
4. **Order-size impact.** One marginal price per swap (constant, exploitable by size), or an integrated impact curve (two or more evaluations)? And how do LP exposure limits feed back into price?
5. **Hart vs Cody**, and whether "bit-exact vs a Python integer spec" should be an additional acceptance criterion alongside "≤ 1e-12 vs mpmath".
6. **Chain / EVM version.** **[Resolved by the fact-check]** CLZ is live on Unichain, Base, OP Mainnet, Arbitrum One and Ethereum mainnet (`eth_call` probe, 2026-09-25). The remaining question is only whether we *want* an osaka / solc ≥ 0.8.31 build next to v4-core's pinned 0.8.26.
7. **Annualization convention for the UI** (365 vs 365.25 days). It does not matter on-chain if variance is per second.
8. **Precedents.** Thales AMM's on-chain N(d2) code (repo no longer public) and Dopex/Hegic/Buffer pricing are **UNVERIFIED**; worth a look for spread and skew mechanisms rather than math.
9. **Audit status of Solady `expWad`/`lnWad`.** Not found in the parsed audit scopes (Cantina 2023 and Cantina/Spearbit-Coinbase 2025 contain no mention; the Ackee PDF did not parse). Solady's own tests do not fuzz exp/ln monotonicity. Decide whether to fuzz them ourselves (monotonicity and error vs mpmath across the full domain), which the harness already supports.

---

## Appendix A: prototype code (research quality, not audited)

`NormalCdf.hartWest` (Solady `expWad`):

```solidity
import {FixedPointMathLib as S} from "solady/utils/FixedPointMathLib.sol";
library NormalCdf {
    int256 internal constant WAD = 1e18;
    int256 internal constant N0 = 220206867912376000000;  int256 internal constant N1 = 221213596169931000000;
    int256 internal constant N2 = 112079291497871000000;  int256 internal constant N3 = 33912866078383000000;
    int256 internal constant N4 = 6373962203531650000;    int256 internal constant N5 = 700383064443688000;
    int256 internal constant N6 = 35262496599891100;
    int256 internal constant M0 = 440413735824752000000;  int256 internal constant M1 = 793826512519948000000;
    int256 internal constant M2 = 637333633378831000000;  int256 internal constant M3 = 296564248779674000000;
    int256 internal constant M4 = 86780732202946100000;   int256 internal constant M5 = 16064177579207000000;
    int256 internal constant M6 = 1755667163182640000;    int256 internal constant M7 = 88388347648318400;
    int256 internal constant CUTOFF = 9e18; // Phi(-9) = 1.13e-19 < 1 wei

    function hartWest(int256 x) internal pure returns (uint256) {
        unchecked {
            int256 z = x < 0 ? -x : x;   // BUG (see note below): x == type(int256).min gives z < 0
            if (z >= CUTOFF) return x < 0 ? 0 : 1e18;   // fix: `if (z >= CUTOFF || z < 0)`
            int256 num = N6;
            num = num * z / WAD + N5; num = num * z / WAD + N4; num = num * z / WAD + N3;
            num = num * z / WAD + N2; num = num * z / WAD + N1; num = num * z / WAD + N0;
            int256 den = M7;
            den = den * z / WAD + M6; den = den * z / WAD + M5; den = den * z / WAD + M4;
            den = den * z / WAD + M3; den = den * z / WAD + M2; den = den * z / WAD + M1;
            den = den * z / WAD + M0;
            int256 e = S.expWad(-(z * z / 2e18));   // e^{-z²/2}
            int256 tail = e * num / den;            // Φ(-|x|); e*num < 2^130
            return x < 0 ? uint256(tail) : uint256(WAD - tail);
        }
    }
}
```

`NormalCdf.cody` (Cody CALERF constants ×1e18) is in `scratchpad/bsbench/src/ours/NormalCdf.sol`. The constants are the same as `equinox/contracts/src/math/BsConstants.sol`: A0–A4, B0–B3, C0–C8, D0–D7, P0–P5, Q0–Q4, `SQRPI = 564189583547756287`, `INV_SQRT2 = 707106781186547524`. **[Corrected]** `Q1` must be changed to `1872952849923460470`, which is netlib's 1.87295284992346047; the prototype and Equinox both carry the typo `1872952849923467250` (§4.1).

`BinaryPricer` (Uniswap-specialized):

```solidity
library BinaryPricer {
    int256 internal constant WAD = 1e18;
    int256 internal constant LN_1_0001_E36 = 99995000333308335333166680951131; // ln(1.0001)·1e36
    int256 internal constant LN_OFFSET = -25095597659861927392;               // ln(1e18) − 96·ln2, WAD
    // ln(1.0001)²·1e36 = 9999000091658334094374450926 (for Σ(Δtick)² → variance)

    function lnPriceFromSqrtPriceX96(uint160 sqrtPriceX96) internal pure returns (int256) {
        return 2 * (S.lnWad(int256(uint256(sqrtPriceX96))) + LN_OFFSET);
    }
    function lnPriceFromTickCumulative(int256 tickCumDelta, uint256 dt) internal pure returns (int256) {
        unchecked { return tickCumDelta * LN_1_0001_E36 / (int256(dt) * 1e18); }
    }
    /// YES per 1 payoff (WAD) = e^{-ρ}·Φ((x + ρ − w/2)/√w); x = ln(S/K), w = σ_s²·τ, ρ = r_s·τ (all WAD)
    function priceYes(int256 x, uint256 w, uint256 rho) internal pure returns (uint256 p) {
        unchecked {
            if (w == 0) return x > 0 ? 1e18 : 0;
            uint256 sqrtW = S.sqrt(w * 1e18);
            int256 d2 = (x + int256(rho) - int256(w / 2)) * WAD / int256(sqrtW);
            p = NormalCdf.hartWest(d2);
            if (rho != 0) p = p * uint256(S.expWad(-int256(rho))) / 1e18;
        }
    }
    function priceYesFromPool(uint160 sqrtPriceX96, int256 lnStrike, uint256 varPerSecWad, uint256 tau)
        internal pure returns (uint256)
    {
        unchecked {
            int256 x = lnPriceFromSqrtPriceX96(sqrtPriceX96) - lnStrike;   // × orientation sign in production
            return priceYes(x, varPerSecWad * tau, 0);                      // production: varE36·τ/1e18
        }
    }
}
```

**[Added] Defect found by the fact-check.** For `x = type(int256).min`, the unchecked negation `-x` overflows back to `min`, so `z < 0`. The `z >= CUTOFF` guard then fails, and the Horner loop runs on garbage. `z*z` wraps to 0, so `expWad(0) = 1e18`. I ran this through the prototype in Foundry: `hartWest(type(int256).min)` returns **5e17 (0.5)**, but the correct result is 0. Inside `priceYes`, it is unreachable, because |d2| ≤ ≈1.8e29 there (§5.5). As a library function, though, it breaks the monotonicity and bounds properties at one input. The fuzz tests missed it because they bound x to ±12e18. Fix: saturate when `z < 0 || z >= CUTOFF`, or require `x > type(int256).min`. Other edge values behave correctly: `hartWest(type(int256).max) = 1e18`, `hartWest(0) = 5e17`, `priceYes(0, 1, 0) = 5e17`, `priceYes(±177e18, 1, 0) = 1e18 / 0`.

Production hardening still to do:
- the `int256.min` fix above;
- checked math at the boundaries (input validation instead of `unchecked` everywhere);
- the orientation sign;
- `varE36`;
- explicit ε-rounding helpers;
- NatSpec error bounds tied to asserted tests.

## Appendix B: raw measurement output (abridged)

CDF, errors in units of 1e-24; gas includes 52 gas of harness:

```
ours Hart     maxErr 42062927            gas 193/951/1027
ours Cody     maxErr 1672651             gas 125/1080/1246
ours A&S      maxErr 74516753033653681   gas 193/852/920
DeFiMath      maxErr 76945586            gas 740/760/781
Lyra          maxErr 41302367            gas 6719/7111/8206
solstat       maxErr 41506375279920169   gas 713/4461/4898
Premia v3     maxErr 660736453013290994  gas 273/36700/42103
```

Binary price and ln paths:

```
priceYes core      maxErr 814900824   gas 787/1727/2070   (worst: x=2.99977e-4, w=9.886e-8)
priceYesFromPool   maxErr 265305126   gas 1725/2238/2559
priceYesSK (ours)  maxErr 10739361436 gas 2097/2747/3380
DeFiMath call      maxErr 7773962170  gas 1801/2213/2446
Lyra binary        maxErr 128026225   gas 9526/14827/17445
Premia-style PRB   maxErr 660637298289740301 gas 10674/33574/56022
ln sqrtPriceX96    maxErr 2631008     gas 878
ln tickCumulative  maxErr 999906      gas 202
```

Property tests (100,000 fuzz runs each, all PASS):

```
testFuzz_hart_bounds, testFuzz_hart_symmetry_exact, testFuzz_hart_monotone,
testFuzz_hart_monotone_adjacent, testFuzz_price_monotone_in_spot, testFuzz_yes_plus_no
```

Seam scans:

```
800k consecutive-wei pairs: 0 violations (ours Hart, ours Cody, DeFiMath)
Cody seams ±200k wei: 0 violations
```

## Appendix C: artifact locations (session scratchpad, ephemeral)

Base directory: `/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-UniswapPrediction/1b01c4fe-2032-47bf-9776-990202883598/scratchpad/`

- `cdf_algos.py`, `cdf_algos_40k.txt`: algorithm-error scan in exact arithmetic.
- `error_budget.py`: tables in §6 and §5.2.
- `bsbench/`: Foundry project.
  - `gen_vectors.py`
  - `src/ours/{NormalCdf,BinaryPricer}.sol`
  - vendored `src/{solady,solstat,solmate,lyra,defimath,premia}`
  - `test/{Differential,Properties,MonotoneScan,SeamScan}.t.sol`
  - `final.log`
- `foundry-bin/`: forge 1.8.3, solc 0.8.37 and 0.8.26 binaries.
- `repos/`: cloned sources cited above, plus `defimath`, `premia-v3-contracts`, `equinox`, `aloe-ii`.

## Sources

- Local sources, cited by file:line in the text: solady, prb-math, solstat (+ solmate `ed67fed` FixedPointMathLib), lyra-v1, Premian-Labs premia-contracts (v2), Premian-Labs/v3-contracts, rmm-core, v4-core, oz-uniswap-hooks, aloe-ii, MerkleBlue/defimath, nodesproof/equinox, Uniswap v3-periphery `OracleLibrary.sol` (raw GitHub).
- Remco Bloemen, "Fixed-point exp and ln": https://xn--2-umb.com/22/exp-ln/
- G. West (2005), "Better approximations to cumulative normal functions", Wilmott: https://s2.smu.edu/~aleskovs/emis/sqc2/accuratecumnorm.pdf
- Abramowitz & Stegun (1964/1972), Handbook of Mathematical Functions, 7.1.26, 26.2.17, 26.2.19.
- W. J. Cody (1969), "Rational Chebyshev approximations for the error function", Math. Comp. 23; netlib specfun CALERF.
- G. Marsaglia (2004), "Evaluating the Normal Distribution", J. Stat. Software 11(4).
- A. Choudhury (2014), "A simple approximation to the area under standard normal curve".
- H. Shore (2005), "Accurate RMM-based approximations for the CDF of the normal distribution".
- DeFiMath: https://github.com/MerkleBlue/defimath
- Equinox: https://github.com/nodesproof/equinox
- Premia v3 docs and audits: https://docs.premia.blue/resources/audits ; OptionMath docs: https://docs-solidity.premia.finance/contracts/libraries/OptionMath.sol/library.OptionMath.html
- Lyra v1 security and audits: https://v1.docs.lyra.finance/security-and-audits
- Thales AMM docs: https://docs.thalesmarket.io/using-thales/thales-amm-design
- EIP-7939 (CLZ): https://eips.ethereum.org/EIPS/eip-7939 ; OP Stack Upgrade 17 / Jovian: https://gov.optimism.io/t/upgrade-17-jovian-hardfork-and-fusaka-readiness/10400
- Fusaka mainnet announcement (EF blog, activation 2025-12-03 21:49:11 UTC): https://blog.ethereum.org/2025/11/06/fusaka-mainnet-announcement
- OP Stack Fusaka notice ("This is NOT Fusaka adoption on L2"): https://docs.optimism.io/notices/fusaka-notice ; Upgrade 19 / Karst ("Osaka on L2", incl. EIP-7939; Unichain listed): https://docs.optimism.io/notices/upgrade-19
- Arbitrum ArbOS 50 "Dia" / Fusaka compatibility: https://docs.arbitrum.io/notices/fusaka-upgrade-notice
- netlib specfun CALERF source (coefficients and the 18-digit statement): https://www.netlib.org/specfun/erf
- Cody (1969) abstract (error range 6e-19 to 3e-20): https://www.ams.org/journals/mcom/1969-23-107/S0025-5718-1969-0247736-4/S0025-5718-1969-0247736-4.pdf
- npm `gaussian` source (NR erfc): https://unpkg.com/gaussian/lib/gaussian.js
- Uniswap v3-periphery OracleLibrary (`consult` rounding): https://raw.githubusercontent.com/Uniswap/v3-periphery/main/contracts/libraries/OracleLibrary.sol

---

## Verification log (fact-check, 2026-09-25)

**Method.**
- **Local sources.** Every source citation was re-read in the local clones: solady `2afba69`, prb-math `71af01d`, v4-core `46c6834`, lyra-v1 `ea9e36a`, solstat `80c603f`, rmm-core `8d3ef9b`, premia-v3 `fe3b821`, defimath `27b4f67`, oz-uniswap-hooks `80bd724`.
- **Independent numerics.** I wrote my own mpmath (50 digits) and numpy scripts in `scratchpad/fc03/`: `check1.py`, `check2.py`, `tickbias.py` and `mars.py`. They do not reuse the draft's `cdf_algos.py` or `error_budget.py`.
- **Foundry re-runs.** I re-ran the bsbench suite: `Differential` as-is; `Properties`, `MonotoneScan` and `SeamScan` with `FOUNDRY_FUZZ_RUNS=100000`; and a temporary edge-case test, since deleted.
- **Live-chain probe.** I ran `eth_call` against public RPCs to test for the CLZ opcode.

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | Solady `expWad` returns 0 for x ≤ −41446531673892822313, reverts for x ≥ 135305999368893231589, is (6,7) rational, and is commented "Monotonically increasing" | Confirmed | `solady/src/utils/FixedPointMathLib.sol` L206-274. mpmath: ln(1e-18)·1e18 = −41446531673892822312.3 and ln((2²⁵⁵−1)/1e18)·1e18 = 135305999368893231589.07. Solady test L9-10 asserts `expWad(−…312) == 1` and `expWad(−…313) == 0`. |
| 2 | Solady `lnWad` reverts for x ≤ 0 and is monotone; `sqrt` is floor, 7 Babylonian steps, branch-free; `sMulWad` rounds toward zero | Confirmed | Same file: L276-293, L778-834 (7 `shr(1, add(z, div(x, z)))` steps then a floor correction), L78-90. |
| 3 | Remco: exp 411 gas, rel. err ≤ 1e-20; ln 614/585 gas, abs err ≈ 1e-18 | Confirmed (with caveat) | WebFetch of xn--2-umb.com/22/exp-ln. The caveat that the bound is on the pre-truncation value was added to §2.1. |
| 4 | Measured gas: Solady exp/ln/sqrt 463/580/460; PRB exp/ln/sqrt 2855/6395/862 | Confirmed | Re-ran `forge test --match-contract DifferentialTest`; output identical to `final.log`. |
| 5 | PRB "README" gas figures (exp 2,263, ln 4,724, …) describe v4.2 | Corrected | `prb-math/README.md` L320-323: "Gas estimations based on the v2.0.1 and the v3.0.0 releases". PRB constants `uEXP_MAX_INPUT = 133_084258667509499440` (Constants.sol L12) and `uEXP_MIN_THRESHOLD = −41_446531673892822322` (L16) confirmed; v4.2.0 dated 2026-08-03 in CHANGELOG L40. |
| 6 | CDF accuracy/gas table (§3.9): Hart 4.21e-17 / 899, Cody 1.67e-18 / 1,028, A&S 7.45e-8 / 800, DeFiMath 7.69e-17 / 708, Lyra 4.13e-17 / 7,059, solstat 4.15e-8 / 4,409, Premia v3 6.61e-7 / 36,648 | Confirmed | Re-run reproduced every maxErr and gas value (after subtracting the 52-gas baseline). The reference generator `gen_vectors.py` uses `mpmath.ncdf` at `mp.dps = 60` on the exact integer inputs (L10, L37). |
| 7 | Algorithm-level errors (exact arithmetic): Hart 4.10e-17 @ 0.0192; A&S 26.2.17 7.45e-8 @ 0.717; 7.1.26 6.97e-8 @ 0.064; 26.2.19 1.30e-7 @ 2.761; NR 4.15e-8 @ 0.056; Choudhury 1.40e-4 @ 0; Shore 6.61e-7 @ 3.793; RMM bug 3.6e-3 @ 0⁺ | Confirmed | Independent `fc03/check1.py` (8,001-point grid plus the listed points): 4.096e-17, 7.452e-8, 6.969e-8, 1.302e-7, 4.151e-8, 1.399e-4, 6.607e-7, 3.60e-3. |
| 8 | DeFiMath's rational-only form tends to the "correct Mills-ratio asymptote" 0.398942/z | Corrected | N6/M7 = 0.3989496 vs 1/√(2π) = 0.3989423 (rel. 1.8e-5). Tail relative error is 2.0e-8 at z = 9 and 4.0e-7 at z = 16. Absolute accuracy is unaffected. |
| 9 | RMM-core uses √2 as A&S a3 | Confirmed (strengthened) | `CumulativeNormalDistribution.sol` L20 (`CDF3 = 0x16a09e667f3bcc908` = 1.41421356…), L29, L44. Also: the Echidna "paper" reference (`crytic/LibraryMathEchidna.sol` L56-92) reuses `CDF3` as a3. `getCDF` is used by `ReplicationMath.sol`. |
| 10 | solstat's differential test compares against the same NR formula | Confirmed (refined) | `cli/cli.ts` L3-21 is NR erfc. The `cdf` vectors come from npm `gaussian` (`generate.ts` L18-19), whose `erfc` (unpkg `lib/gaussian.js`) is the identical NR formula. |
| 11 | Premia v3 test vectors are the approximation's own outputs (N(−1) = 0.158655459434782014, 2.1e-7 from the true value, tol 1e-16) | Confirmed | `OptionMath.t.sol` L71, L88-91 (tolerance `0.0000000000000001e18`). mpmath: Shore(−1) = 0.15865545943478202 and true Φ(−1) = 0.15865525393145705, a difference of 2.06e-7. |
| 12 | Lyra v1 Hart/West at 1e27, `SPLIT` / N / M constants, `MIN_T` = 1 s, `MIN_VOL` = 0.001%, `SECONDS_PER_YEAR` = 31536000, `lnPrecise`/`expPrecise` lose 9 digits | Confirmed | `BlackScholes.sol` L45-69, L179-199, L353-400; `FixedPointMathLib.sol` L7-15. |
| 13 | DeFiMath needs `^0.8.31` and osaka (CLZ) and fails on cancun; `stdNormCDF` / `expPositive` are CLZ-free | Confirmed | Compiled `Math.sol` with solc 0.8.37 `--evm-version cancun` and got `The "clz" instruction is only available for Osaka-compatible VMs` (L212); osaka compiles with 0 errors. The only `clz` uses are at L212, L263, L399, L411 and L442. README: `stdNormCDF` 618 gas / 3.0e-15 and `call` 1,913 / 2e-12 (L101, L144). |
| 14 | Whether Unichain / Base / Arbitrum support CLZ is UNVERIFIED | Corrected (now verified) | `eth_call {data: 0x60011e60005260206000f3}` returned `0x…ff` (CLZ(1) = 255) on mainnet.unichain.org, mainnet.base.org, arb1.arbitrum.io, ethereum-rpc.publicnode.com and mainnet.optimism.io. The control opcode 0x21 gave `OpcodeNotFound`. OP docs: Karst ("Osaka on L2", incl. EIP-7939; Unichain listed), and Jovian was not L2 adoption. |
| 15 | Fusaka activated on mainnet on 2025-12-03 | Confirmed | EF blog "Fusaka Mainnet Announcement": epoch 411392, 2025-12-03 21:49:11 UTC. |
| 16 | v4-core pins solc 0.8.26 / cancun; `getSlot0` = one `extsload` (StateLibrary L40-63) | Confirmed (with an added detail) | `v4-core/foundry.toml` L6-7; `StateLibrary.sol` L40-63. `PoolManager.sol` L2 is an exact `pragma solidity 0.8.26`. |
| 17 | Current tick = floor(log₁.₀₀₀₁ P) | Corrected (qualified) | `v4-core/src/libraries/Pool.sol` L409-412, L431: after a zeroForOne swap that stops exactly at a boundary, `slot0.tick` is 1 less than `getTickAtSqrtPrice(slot0.sqrtPrice)`. |
| 18 | v3 `OracleLibrary.consult` truncates the mean tick | Corrected (wording) | The fetched source computes `int24(delta / secondsAgo)`, then `arithmeticMeanTick--` if the delta is negative and not exact ("Always round to negative infinity"), i.e. floor. |
| 19 | Constants `LN_1_0001_E36`, `LN_OFFSET`, `LN_TICK_SQ_E36`, and ticks for 3000 / 5000 | Confirmed (one rounding note) | mpmath: floor(ln(1.0001)·1e36) = 99995000333308335333166680951131; nint((ln 1e18 − 96 ln 2)·1e18) = −25095597659861927392; ln(1.0001)²·1e36 = …925.98, so the draft's …926 is round-to-nearest; tick(3000) = −196256.35, tick(5000) = −191147.84; ln(1.0001) in WAD has 0.335 wei representation error. |
| 20 | Saturation values Φ(−8)…Φ(−10), and clamping at 9 costs < 0.12 wei | Confirmed | mpmath: 6.22e-16, 5.21e-17, 9.48e-18, 1.1286e-19, 7.62e-24. |
| 21 | Sensitivity table §6.2 (1 tick, σ ±1/5/10%, ATM, 12 s / 1 s) | Confirmed | `fc03/check2.py` recomputed every value (e.g. 1 min: 0.048 / 2.4e-3 / 2.3e-2 / 1.7e-5 / 2.7e-2 / 2.0e-3; 90 d: 1.3e-4 / 3.2e-3 / 3.1e-2 / 5.9e-3 / 2.5e-7 / 2.1e-8). |
| 22 | max over x of n(d2)·\|d1\| = n(1) = 0.242 | Corrected | Exact maximum n(d*)(d* + √w) with d* = (−√w + √(w+4))/2: 0.242 → 0.32 at √w = 0.3. The draft's own table (3.1e-2 at 90 d) already reflected this. |
| 23 | Tick-floor adds about 1/6 tick² per return, giving σ bias +7.1% (1 s), +0.61% (12 s), +0.12% (1 min) | Confirmed (model caveat added) | Random-walk simulation, 4M steps: excess +0.1669 (v = 1.14), bias +7.06%; +0.57% at 13.7; +0.118% at 68.5. The excess is not 1/6 for v ≲ 0.5 tick² (+0.152 at 0.1). |
| 24 | Differences of consecutive TWAP means have variance (2/3)σ²Δ | Confirmed | Simulation ratio 0.668; the analytic result for Brownian motion is 2/3 (Working 1960). |
| 25 | Per-second variance in WAD: 11415525114, 8.8e-11 relative truncation | Confirmed (impact added) | 0.36/31536000 = 1.14155251e-8. The resulting price error of up to about 1e-11 exceeds the 1e-12 target. The measured pool-path error hides it because the reference uses the truncated integer. |
| 26 | Property fuzz (6 properties × 100k) all pass; 800k consecutive-wei pairs and Cody seams ±200k show 0 violations | Confirmed (scope caveat) | Re-ran with `FOUNDRY_FUZZ_RUNS=100000`: 6/6 PASS; MonotoneScan 0/0/0; SeamScan 0 on all 4 seams. The fuzz domain is bounded to ±12e18 / ±30e18. |
| 27 | Differential harness "asserts maxErr ≤ ε" | Corrected | `test/Differential.t.sol` contains no `assert`; it only logs. |
| 28 | Appendix A `hartWest` is correct on its whole input domain | Corrected (defect) | Foundry: `hartWest(type(int256).min)` = 5e17, but the correct value is 0 (unchecked `-x` overflow). Unreachable from `priceYes`. |
| 29 | Cody constants match Equinox and netlib | Corrected | All 37 constants are identical between ours and Equinox. Diffed against raw netlib `specfun/erf` (curl; `fc03/netlib.py`): 36/37 match, but **Q1 = 1.87295284992346725 (ours and Equinox) ≠ 1.87295284992346047 (netlib L181, L187)**. The numerical effect is below 1e-22 because Q applies only for \|x\| > 5.657. Fix it anyway. |
| 30 | Cody's published bound was UNVERIFIED | Confirmed | AMS abstract: "maximal relative errors ranging down to between 6×10⁻¹⁹ and 3×10⁻²⁰". The netlib CALERF header (L36) says "to at least 18 significant decimal digits". |
| 31 | Marsaglia term counts 16/35/56/95/109 | Confirmed (±1) | `fc03/mars.py`: 16/35/56/95/110; the difference comes from how terms are counted. |
| 32 | OZ `BaseOracleHook` / Panoptic `Observation` has `tickCumulative` and `tickCumulativeTruncated` | Confirmed | `oz-uniswap-hooks/src/oracles/panoptic/libraries/Oracle.sol` L23-29. |
| 33 | Solady audits contain no `expWad`/`lnWad` scope | Unverifiable (as exhaustive) | Cantina and Cantina/Spearbit-Coinbase texts have 0 matches for FixedPointMathLib, expWad or lnWad; the Ackee PDF text did not extract; the folder also contains shung's ERC721 audit and the xuwinnie cbrt proof. |
| 34 | Lyra and Premia audit scopes, Thales on-chain code, and Dopex/Hegic/Buffer pricing | Unverifiable | Not checked in primary sources. `github.com/thales-markets/contracts` returns HTTP 404 (re-checked). |
