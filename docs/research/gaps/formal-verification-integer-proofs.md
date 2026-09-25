# Gap: formal and symbolic proofs for the integer-level properties

**Date:** 2026-09-26. **Status:** research report with runnable spikes. It feeds the proof plan and needs no production code.
Scripts, harnesses and outputs are in `docs/research/gaps/formal-verification-scripts/` (`py/`, `halmos/`, `halmos-e2e/`).
Tools used: forge 1.8.3 (`cae51ad`, solc 0.8.26, cancun), halmos 0.3.3 (yices 2.6.x default), z3-solver (NIA), sympy (exact
Sturm root counting), mpmath (40 digits).

**Question.** Four groups of load-bearing properties were only fuzz-tested:
1. monotonicity of the WAD Hart/West Φ̂ within each half-line (05 §2.2 R4; quote report open question 6);
2. the integer quote properties E1–E4 and Lemma S, including rounding (quote report §3.3–§5);
3. VCS solvency `B_m ≥ max(outY, outN)` (S3) and `Σ B_m + idle == PM claims` (S4) across all 8 swap cases (swap-path report §2, §6);
4. the ladder-cap prefix computation (LP-vault report §5.1).

Which of these can be proved, with which tool, at what cost? And which real-number theorems need paper proofs?

---

## 0. The answer in one page

1. **Property 1 is false for the current Hart port. It has been disproved, not just left unproven.** The WAD Hart/West
   tail `c(z)` in `05-math-scripts/evm/T.sol::tail` (the planned Φ̂) **increases by 1 wei at some 1-wei steps**. A targeted
   search found 61 counterexamples for z ∈ [5.05, 7.03], for example `tail(6202233335529410195) = 278337293` and
   `tail(6202233335529410196) = 278337294`. 54 of them were replayed on the EVM (forge): 54/54 confirmed
   (`halmos/test/HartCex.t.sol`). So `Φ̂(x+1) < Φ̂(x)` for x > 0 and `Φ̂(−z−1) > Φ̂(−z)`. Estimated density on [5, 7.07]:
   about 1.3·10⁻¹⁰ per wei step (about 3·10⁸ bad steps). **2,000,000 Foundry fuzz runs find none**
   (`HartFuzz.t.sol`), and neither did the 150k + 124k pair scans of report 05.
   - Root cause: floor jitter in the WAD Horner evaluation of n(z) and d(z) makes the integer ratio `n/d` tick upward
     for z ≳ 4.47 (§2.2). When that coincides with `e·n/d` sitting just below an integer, the tail rounds up by 1.
   - Economic impact is nil: 1e-18 of price, only at |d| ≥ 4.47, where Φ ≤ 4e-6 and the band `[p_min, 1 − p_min]`
     normally halts the side. But E4 as a theorem is false as stated.
2. **Fix, which comes with a complete computer-assisted proof.** Carry 18 extra decimals in the Horner accumulators
   (coefficients × 1e18; `HartTail36.sol`).
   - Error is unchanged (42 wei = 4.2e-17). Gas is unchanged: 1,309 unchecked, the same as the 05 WAD figure.
   - The output matches the Python reference bit for bit on 2,004 points (`Hart36Diff.t.sol`).
   - It is proved monotone on all of [0, ∞) by a certificate made of exact-rational interval arithmetic plus Sturm root
     counts (§3). It runs in under 2 minutes on a laptop:
     - (i) the integer Horner ratio is non-increasing at **every** 1-wei step on [0, 7.071), in 708 exact chunks;
     - (ii) solady `expWad` is non-decreasing on its whole non-zero negative domain. That is 61 segment boundaries checked
       exhaustively, plus a within-segment bound: an increase of at least 9.28·10⁹ internal units per wei against
       rounding of at most 1.0033 units;
     - (iii) the continued-fraction branch z ≥ 7.07 has a 6-line paper proof;
     - (iv) the branch junction is checked exactly;
     - (v) Lemma C, which Halmos proves in 0.4 s.
3. **A second, independent integer gap in E4:** the quote's `g⁺ = Φ̂(d) + k·φ̂(d)` is not monotone in integers for
   d > 0, because it adds two separately rounded terms of opposite slope. 1-wei drops occur in **0.4–9% of 1-wei steps**
   (882 to 17,938 of 199,960 per k, for k = 0.1, 0.5, 2), well inside the tradable domain (`py/gplus.py`).
   - The quote report's F7 fuzz used exact mpmath for `Φ + kφ`, so it could not see this.
   - Fix: evaluate `1 − g⁺ = e(d)·(R(d) − k/√2π)` with **one** final rounding. On the enabled set both factors are ≥ 0 and
     non-increasing, so monotonicity follows by composition. 0 drops were found.
4. **Lemma S, Lemma A, Theorem N (all 4 kinds), E1 and E2 are now machine-proved** as integer statements with z3 over
   unbounded integers (NIA), each in 0.03–2 s (`py/z3_integer_lemmas.py`, `out_z3.txt`).
   - **Lemma S (sell side) needs an extra hypothesis:** the result must stay on the increasing branch (`2Λq ≤ β`,
     i.e. the band check). Without it, both z3 and Halmos find counterexamples. A realistic one: Λ = 55,778, b = 0.01002,
     A = 9e14 gives q one unit past the vertex and pays 1 USDC unit more than the curve allows (`py/sell_cex.py`).
     The spec's band check already prevents this, but the lemma and its Solidity test must state the precondition.
5. **Property 3 (VCS S3/S4) is proved symbolically by Halmos in seconds.** This is an inductive step over all 8 swap
   cases plus split, merge, fund, defund, deposit, withdraw, resolve and redeem, with 2 markets and arbitrary prices.
   It holds even with the real v4 `FullMath.mulDiv`/`mulDivRoundingUp` amount layer (573 paths, 7.6 s), because I7
   (price independence) means the solver never has to reason about 512-bit arithmetic.
   - A bounded **end-to-end** Halmos check through the **real v4 PoolManager + PoolSwapTest** also passes: one symbolic
     swap, all 8 cases, symbolic price, asserting S1–S4 (791 paths, 176 s).
   - It needed three harness changes: `dynamic_test_linking = false`, no CREATE2 salt search, and concrete addresses
     (§5.3).
6. **Property 4 (ladder prefix pass = brute-force minimum over all n + 1 regions)** is proved by Halmos for n = 3
   (1.6 s) and n = 4 (7.7 s). The union-bound fast path is sound for n = 3 (154 s in one run; a re-run hit the 300 s per-query cap). The general n is a 3-line induction
   (§6).
7. **Where Halmos does not scale:** any property whose truth depends on 256-bit **non-linear** arithmetic.
   - It timed out at 900 s on each of the following:
     - `(z+1)²/W/2 ≥ z²/W/2`;
     - one step of the WAD Horner `n(z+1) ≥ n(z)`;
     - `expWad(x+1) ≥ expWad(x)`;
     - `FullMath.mulDiv(a,b,d) == a·b/d` for a, b < 2¹²⁸.
   - The Φ̂ step properties themselves: a 2³²-wide window timed out (329 paths, 1,877 s), the lower branch timed out
     (353 paths, 2,224 s), and the full domain was killed after 40 min.
   - Lemma S with the square root abstracted (1,800 s) and solady `sqrt` floor-correctness for x < 2¹²⁸ (1,800 s) also
     timed out, although z3 over unbounded integers proves Lemma S in under 1 s.
   - This matches Trail of Bits' v4-core audit: 8 of 100 invariants were Halmos-verified, all small stateless library
     facts, and `mulDivRoundingUp` equivalence timed out at 2 h. Halmos abstracts symbolic `mul`/`div` as uninterpreted
     functions and only "refines" to real bit-vector semantics when a candidate counterexample appears
     (`halmos/sevm.py:281-292`, `solve.py:596-620`).
8. **Recommended division of labour:**
   - Integer math lemmas: z3/NIA (or Lean) on the integer model, plus Halmos for model-to-bytecode refinement where it
     is linear.
   - Numerical kernels (Φ̂, expWad, φ̂): certificates in exact arithmetic plus bit-exact differential tests.
   - Ledger and solvency: Halmos inductive steps plus a stateful Foundry campaign through the real PoolManager.
   - Certora (open source, 8.19.2) or Kontrol only if an audit-grade PoolManager-level proof is wanted.
   - Lean/mathlib: optional, for Lemma S and the discrete martingale QV identity only.

---

## 1. What the earlier reports claimed, and what changed

| Property | Before (source) | Now |
|---|---|---|
| Φ̂ monotone within half-lines | "empirical, 0 violations in 150k + 124k pairs" (05 §2.2 [FC]) | **False for the WAD port**: 61 counterexamples, 54 EVM-confirmed. **Proved** for the X36 port (§3) |
| Φ̂ monotone across 0 | Lemma C (paper) | Halmos PASS, 26 paths, 0.39 s |
| Lemma S (floor isqrt exact) | paper + 26k/26k fuzz (quote §3.3) | z3 PROVED (buy: feasible and maximal; sell: sufficient and minimal) **with the added band hypothesis**. Counterexample without it (z3 in 0.25 s, Halmos in 415 s) |
| Lemma A, Theorem N (4 kinds), E1, E2 | paper + fuzz | z3 PROVED, 0.03–2 s each |
| E4 (quote monotone in S) | paper + F7 fuzz on **exact-real** g⁺ | integer `Φ̂ + kφ̂` **not monotone** (0.4–9% of steps). The factored form is monotone by composition once Φ̂'s ratio certificate holds (§4.3) |
| S3/S4 under 8 swap cases | 3 stateful campaigns, 256 × 100 (swap report) | Halmos inductive proof, abstract amounts (96 paths, 1.0 s) and real FullMath amounts (573 paths, 7.6 s), plus other ops (101 paths, 1.3 s) and redeem (19 paths, 0.2 s) |
| Ladder prefix = min over regions | 20k random vs brute force (LP report §5.1) | Halmos PASS n = 3, 4; paper induction for all n; union bound ≤ exact (Halmos n = 3) |

---

## 2. Φ̂: the counterexample and its mechanism

### 2.1 The implementation under test

`HartTail.sol` is a verbatim copy of `05-math-scripts/evm/T.sol:11-27` (`tail`):
`c = ⌊e·n/d⌋`, with `e = expWad(−⌊⌊z²/W⌋/2⌋)`, and `n`, `d` the degree-6/7 Hart polynomials evaluated by Horner with
`h ← ⌊h·z/W⌋ + C_k` (W = 1e18). For z ≥ 7.0710678e18 it uses the continued fraction; the result is clamped at W/2. The
Python twin `py/hart.py::tail` reuses the bit-exact expWad emulation of 05 §2.4.

### 2.2 Why "0 violations" was a sampling artefact

Write `V(z) = e(z)·n(z)/d(z)` as an exact rational, with `c = ⌊V⌋`.
- `e` is a step function of z: an integer that drops by 1 about every `1/(e·z·1e-18)` wei, e.g. every ~2·10⁸ wei at z = 6.5.
- Between drops, V changes only through the integer ratio `n/d`.
- In exact arithmetic `n/d = Φ(−z)e^{z²/2}` has log-derivative `z − φ/Φ(−z) < 0` (Mills). The relative drift per wei is
  about 1.5e-19 at z = 6.5.
- The Horner floors make the per-step differences Δn and Δd jitter. A single early-stage floor wrap propagates to n as
  about z⁵ wei. **The integer ratio ticks up** at some steps, and the fraction of such steps rises steeply with z
  (`py/ratio.py`, 200k consecutive steps each):

| z | 0.5 – 4.3 | 4.47 | 4.5 | 4.6 | 5.0 | 6.0 | 7.0 |
|---|---|---|---|---|---|---|---|
| steps where n/d increases | 0 | 22 | 113 | 1,976 | 5,618 | 6,981 | 7,052 |
| max relative up-tick | 0 | 2.9e-21 | 2.9e-21 | 4.2e-21 | 3.2e-20 | 1.3e-19 | 2.2e-19 |

- A violation needs an up-tick at the exact step where V crosses an integer by *drift* (not by an `e` drop). About 2% of
  integer crossings are drift-driven. Of those, about 2.9% flicker. The fuzzers and the 05 scans almost never land there.
- `py/hunt2.py` goes straight to these events. For random z it finds the `e` plateau by bisection, then the drift
  crossings inside it, then scans ±3,000 wei. Result: 1.2M plateaus, 2,129 drift crossings, **61 violations**, all of
  them +1 wei (`py/out_hunt2_original.txt`).
- Density: `py/est_density.py` integrates the drift-crossing rate: 9.7e9 crossings on [5, 7.07] × 0.0287 ≈ 2.8e8 bad
  steps, about 1.3e-10 per wei. A 1M-run fuzz has about 1e-4 expected hits.

### 2.3 Does it matter?

- **Economically: no.** The error is 1e-18 of price, at |d| ≥ 4.47, where Φ(−4.47) = 3.9e-6.
- **Formally: yes.** E4 ("the quote is monotone in S", quote report §5) cites Φ̂ monotonicity as a premise. The up side
  is enabled at d ≈ −4.5 only if `h₀ + h_inv⁺ + kφ(d) ≥ p_min − 4e-6`. With the report's defaults (h₀ ≤ 1¢, c_inv = 1¢,
  p_min = 2¢) that is reachable only at the extreme corner, so the domain restriction "|d| ≤ z_band + 1/k" does not save
  the lemma in general.
- The honest options are (a) fix Φ̂ (§3), or (b) weaken E4 to ε = 1 wei monotonicity. Option (b) would still need its
  own proof, so (a) is both cheaper and cleaner.

---

## 3. A complete proof of Φ̂ monotonicity for the fixed port (HartX36)

### 3.1 The change

Scale every Horner coefficient by 1e18 and keep dividing by W at each stage, so the accumulators carry 36 decimals
(`HartTail36.sol`, `py/hart.py::tail36`). The code change is limited to the constants. Checked facts:

| check | result | file |
|---|---|---|
| max \|tail36 − Φ(−z)\| on [0, 7.07), step 1e-4 | 42.23 wei (the WAD port also gives 42.23 wei) | `py/out_acc36.txt` |
| bit-exact Solidity vs Python, 2,004 points incl. SPLIT ± 1, 0, 37e18, 400 in [4.4, 7.07] | PASS | `Hart36Diff.t.sol` |
| \|tail36 − tail\| ≤ 2 wei, 100k fuzz on [0, 9e18] | PASS | `Hart36.t.sol` |
| no increase at the 54 counterexamples | PASS | `Hart36.t.sol` |
| gas (unchecked, internal) | 1,309 (checked WAD port: 6,252) | `Hart36.t.sol::test_gas` |
| overflow headroom | n·z ≤ 3.7e59, d·z ≤ 6.4e60, e·n ≤ 5.2e58 ≪ 5.7e76 | analytic |
| same crossing hunt as §2.2 (seeds 1–4 of the original) | 1,008 drift crossings, **0** violations (the original had 28 on the same seeds) | `py/out_hunt36_cf.txt` |

### 3.2 Theorem (Φ̂ monotone)

For the X36 port, `tail(z+1) ≤ tail(z)` for every integer z ≥ 0. Hence (Lemma C) `Φ̂(x) = x ≤ 0 ? tail(−x) : W − tail(x)`
is non-decreasing on all of int256 with |x| ≤ 37e18, and `Φ̂(x) + Φ̂(−x) = W` exactly for x ≠ 0.

The proof is a composition of five pieces, each machine-checked or elementary.

**(P1) Argument.** `w(z) = ⌊⌊z²/W⌋/2⌋` is non-decreasing. Floor division by a positive constant is monotone, and so is
z² on z ≥ 0.

**(P2) expWad non-decreasing on x ≤ 0** (solady `FixedPointMathLib.sol:204-270`; the solady comment "Monotonically
increasing" at `:206` is only an assertion, and solady's test suite has no expWad monotonicity test).
- Pipeline: `x → x₁ = sdiv(x·2⁷⁸, 5¹⁸)` (monotone; its step per wei is 79,228,162,514 or …515), then
  `k = round(x₁/ln2·2⁹⁶)` (monotone), then `t = x₁ − k·L`, then the rational `r = trunc(p(t)/q(t))`, then `(r·C) ≫ (195 − k)`.
- *Within a k-segment*, `py/expwad_cert.py` shows the following:
  - the reduced argument over the whole domain [−41.45e18, 0] lies in [T₀, T₁] = ±2.7458e28 (computed exactly at every
    segment end; t is monotone inside a segment);
  - `P`, `Q` and `G = P′Q − PQ′` of the floor-free rational have **0 real roots** on [T₀, T₁] (exact Sturm counts in
    sympy), and are positive at 0;
  - a rigorous lower bound (Taylor enclosure on 64 chunks) is `F′ = G/Q² ≥ 0.117`, so F rises by ≥ 9.28·10⁹ internal
    units per wei of x.
- `py/expwad_err.py` bounds the effect of all floors: `|r − F| ≤ 1.0033` units (`e_P ≤ 2^105.8`, `e_Q ≤ 1.52`,
  `Q ≥ 2^114.1`). So r strictly increases within a segment. The final multiply and shift are monotone in r for fixed k.
- *Across segments*, all 61 k-boundaries in [−41.45e18, 0] were checked exhaustively ±2·10⁵ wei (24.2M steps, 0
  decreases; `py/expwad_kcheck.py`).
- At the cut-off, `expWad(−41446531673892822313) = 0` and the next input gives 1.
- Caveat: the Taylor-enclosure lower bound uses one assumption that is checked but not certified, `F < 2⁹⁵` (observed
  r ≤ 2⁹⁴). Replacing it by the exact maximum of F on [T₀, T₁] is a one-line addition.

**(P3) Lower branch z < SPLIT = 7.0710678…e18.** `e(z)` is non-increasing by (P1) and (P2). `py/ratio_cert36.py` proves
that **the integer ratio n(z)/d(z) is non-increasing at every 1-wei step on [0, SPLIT)**. It uses exact `Fraction`
arithmetic and 708 recursively refined chunks, from these bounds (all quantities ≥ 0, z integer, W = 1e18):
```
h_{k+1}(z) = ⌊h_k(z)·z/W⌋ + C_{k+1};  p_k = floor-free Horner;  0 ≤ p_k − h_k ≤ E_k,  E_{k+1} = E_k·z/W + 1
δ_{k+1} := h_{k+1}(z+1) − h_{k+1}(z) = ⌊a⌋ − ⌊b⌋ ∈ {⌊a−b⌋, ⌊a−b⌋+1},   a − b = (h_k(z) + δ_k·(z+1))/W
⇒ ⌊((p_k − E_k) + L_k(z+1))/W⌋ ≤ δ_{k+1} ≤ ⌊(p_k + U_k(z+1))/W⌋ + 1
sufficient on a chunk [z_a, z_b]:  U_n·max d ≤ min n·L_d   (uppers evaluated at z_b, lowers at z_a; all monotone in z)
```
Then `e(z+1)·n(z+1)/d(z+1) ≤ e(z)·n(z+1)/d(z+1) ≤ e(z)·n(z)/d(z)`, so `c = ⌊e·n/d⌋` is non-increasing.
The same certificate on the **original WAD port** proves monotonicity only on **[0, 4.465)**. It fails at 4.4658, and
the first real up-ticks appear at 4.47 (table in §2.2). So the certificate is essentially tight, and the WAD port is
proven monotone for |x| < 4.465.

**(P4) Upper branch z ≥ SPLIT** (continued fraction, unchanged from the WAD port).
- Let `g₄ = z + 0.65W` and `gᵢ = z + ⌊(i+1)W²/g_{i+1}⌋`, down to `f = g₀`.
- Every gᵢ ≥ 7W. If `g′ ∈ {g, g+1}`, then `0 ≤ iW²/g − iW²/g′ ≤ 4/49 < 1`, so `⌊iW²/g′⌋ − ⌊iW²/g⌋ ∈ {−1, 0}`.
- By induction from the innermost level, `Δgᵢ = 1 + Δ⌊…⌋ ∈ {0, 1}`, so f is non-decreasing. Then `⌊f·√2π/W⌋` is
  non-decreasing, and `c = ⌊e·W/⌊f√2π/W⌋⌋` is non-increasing. ∎
- A hunt over 76 drift crossings on [7.07, 9.1] found 0 violations (`out_hunt36_cf.txt`).

**(P5) Junction and ends.**
- `tail36(SPLIT−1) = 768,729 = cf_tail(SPLIT)`, checked exactly.
- For z > 37e18, tail = 0, and e = 0 already there.
- The clamp `min(c, W/2)` is monotone.
- Lemma C (assembly across 0): Halmos `check_lemmaC` PASS, 26 paths, 0.39 s.

**Trusted base.** The Python emulation of the Solidity. Its link to the bytecode is the 2,004-point bit-exact test plus
the 05 differential of expWad. Also trusted: sympy's `count_roots` and Python's `Fraction`.

**Plan recommendation.** Ship HartX36. Put `ratio_cert36.py`, `expwad_cert.py`, `expwad_err.py` and `expwad_kcheck.py`
in CI as the "computer-assisted proof" of R4, and keep the Foundry monotonicity fuzz as a regression test. For extra
assurance the certificate can be re-run in a second implementation, e.g. Julia/Arb or FLINT.

---

## 4. Quote integer properties: E1–E4 and Lemma S

### 4.1 Machine proofs over the integers (z3 NIA)

`py/z3_integer_lemmas.py` encodes floor and ceil by their defining inequalities and isqrt by `s² ≤ X < (s+1)²`,
with no bit-width limits. It asserts the negation of each goal and expects UNSAT. `py/out_z3.txt`:

| Lemma | Result | time |
|---|---|---|
| Lemma S buy (exact-in): `q = ⌊(isqrt(β²+4ΛR) − β)/2Λ⌋` is feasible, maximal and ≥ 0 | PROVED ×3 | 0.15–0.28 s |
| Lemma S sell (exact-out): `q = ⌈(β − isqrt(β²−4ΛR))/2Λ⌉` is sufficient **without** a band | **COUNTEREXAMPLE** R=2, Λ=15, β=14 | 0.25 s |
| same, **with** `2Λq ≤ β` | PROVED | 0.53 s |
| Lemma S sell minimality (with band, q > 0) | PROVED | 0.23 s |
| Lemma A (additivity of N) | PROVED | 1.36 s |
| Theorem N: exact-out buy ⌈⌉+⌈⌉ ≥ ⌈Σ⌉; exact-in sell ⌊⌋+⌊⌋ ≤ ⌊Σ⌋ | PROVED | 0.03 / 0.14 s |
| Theorem N: exact-in buy `q₁ + q₂ ≤ q(A₁+A₂)` (from Lemma A + maximality) | PROVED | 1.34 s |
| E2: `⌊M_b(I+q,q)/D⌋ ≤ ⌈N_a(I,q)/D⌉` for b ≤ a | PROVED | 2.03 s |
| E1/E2 identities `N_a − M_b = 2e6(a−b)q (+2Λq²)` | PROVED | 0.00 s |

**Correction to quote report §3.3.** The sell half of Lemma S holds only on the increasing branch.
- The feasible real interval is `[q_lo, q_hi]` around the vertex `β/2Λ`. `⌈q_lo⌉` can exceed the vertex, and even
  `q_hi`, when the interval is narrower than one unit.
- A realistic instance (`py/sell_cex.py`): Λ = 55,778, b = 0.01002 WAD, I₀ = 0, A = 9·10¹⁴. The discriminant is
  exactly 0, q = 179,640,718,562,874,252 (the vertex is 1.796407185628742e17), and the proceeds come out 1 unit short,
  899,999,999,999,999 < A. The end marginal price is negative.
- Halmos found an independent counterexample in 415 s (`check_lemmaS_sell_noband`).
- The spec's band check "`10⁶p_min ≤ 10⁶·price + Λx` at both endpoints" implies `β − 2Λq ≥ 2·10⁶·p_min > 0`, so
  production is safe. But `QuoteMath.sellExactOut` does not enforce it itself. Its Foundry test assumes it
  (`QuoteMath.t.sol:44`). Make the precondition part of the lemma, and either check it inside the solver or document it
  as a caller obligation.

### 4.2 From integer model to bytecode

The z3 results are about the integer model. To transfer them to `QuoteMath.sol`:
- (a) no silent wraparound. Checked arithmetic reverts, so reverts are the only deviation, and a revert is safe for a
  swap;
- (b) solady `sqrt` returns ⌊√x⌋;
- (c) the Solidity expressions equal the model's.

(c) is straight-line and small. (b) is where symbolic tools struggle:
- `check_sqrt_floor_128` **timed out** (7 paths, 1,800 s), and so did the end-to-end `check_buyExactIn_maximal`
  (21 paths, 1,801 s).
- The only public formal work on solady `sqrt` is `zobront/halmos-solady`. It proves *equivalence with solmate* after
  abstracting the shared tail, not floor-correctness.
- Practical route for (b): solady's in-code argument (`FixedPointMathLib.sol:778-826`: initial estimate within a factor
  of 2.84, 7 Babylonian steps, final `z := sub(z, lt(div(x, z), z))`) written up as a paper lemma, plus exhaustive
  testing for x < 2¹⁶ and fuzzing, or a Lean proof of the Babylonian bound.

### 4.3 E4 in integers: Φ̂ + kφ̂ is not monotone, and how to fix it

`py/gplus.py` evaluates the naive on-chain form `g⁺ = Φ̂36(d) + ⌊k·φ̂(d)/W⌋`, with `φ̂ = ⌊expWad(−d²/2)·W/√2π⌋`, over
40 × 5,000 consecutive 1-wei steps of d ∈ (0, 0.9/k):

| k | naive: decreasing steps | factored: decreasing steps (enabled set) |
|---|---|---|
| 0.1 | 882 / 199,960 | 0 |
| 0.5 | 10,219 / 199,960 | 0 |
| 2.0 | 17,938 / 199,960 | 0 |

The factored form, for d > 0, is `g⁺ = W − ⌊e·(n·√2π − k·d_H)/(d_H·√2π)⌋ = W − ⌊e·(R − κ)⌋`, with κ = k/√2π.
- On `{R ≥ κ}` both factors are ≥ 0 and non-increasing: e by (P1)/(P2), R by the ratio certificate. So the composition
  is monotone.
- `{R ≥ κ}` is a half-line because R is non-increasing, and the up side can be enabled only where `1 − g⁺ ≥ p_min > 0`.
  This is Lemma M in integers.
- For d ≤ 0: `g⁺ = ⌈e·(R(|d|) + κ)⌉`. Both factors are positive and non-decreasing as d ↑ 0.
- g⁻ is symmetric.
- At d = 0 both forms give `e(0)·(R(0) ± κ)`. With `c(0) ≤ ½` (clamp) the junction is monotone, but this should be
  asserted in the certificate with the chosen rounding directions.
- **Plan change:** specify `epochQuote` in this factored form. Re-run the quote report's F7 against the *integer*
  implementation, not the mpmath reference.

---

## 5. Symbolic execution spike: what ran, how long, and why

### 5.1 Halmos 0.3.3 results (this session, Apple Silicon, `--solver-timeout-assertion 900s`)

| check (harness) | shape | result |
|---|---|---|
| `check_lemmaC` | 4 symbolic int256, no arithmetic beyond compare/sub | **PASS** 26 paths, 0.39 s |
| `check_S3S4_swapAbs` | 2-market VCS model, symbolic pre-state satisfying S3/S4, symbolic (isYes, buying, q, cash) | **PASS** 96 paths, 1.03 s |
| `check_S3S4_swapReal` | same, 8 cases with real v4 `FullMath.mulDiv`/`mulDivRoundingUp`, symbolic a, ask, bid | **PASS** 573 paths, 7.64 s (re-run: 574 paths, 19.1 s) |
| `check_S3S4_otherOps` | split, merge, fund, defund, deposit, withdraw, resolve | **PASS** 101 paths, 1.31 s |
| `check_S3S4_redeem` | resolved market, redeem | **PASS** 19 paths, 0.18 s |
| `check_ladder3` / `check_ladder4` | `ladderMin` == min over n+1 brute-force regions, uint64 inputs, `--loop 32` | **PASS** 271 paths, 1.55 s / 1,173 paths, 7.70 s |
| `check_unionBound3` | `cash + Σ min(invY, invN) ≤ ladderMin` | **PASS** 272 paths, 154 s in run 1; **TIMEOUT** (300 s per-query cap) in run 2 (`logs/ledger_ladder.log`). Solver time is not stable across runs, so CI needs generous caps |
| `check_lemmaS_sell_noband` | abstract isqrt, bounded widths | **FAIL (true counterexample)** 415 s |
| `check_lemmaS_buy_abstract` / `_sell_abstract` | abstract isqrt, bounded widths, band | **TIMEOUT** 17 paths, 1,801 s / 23 paths, 1,801 s. The same statements are PROVED by z3/NIA in < 1 s (§4.1): the bit-vector encoding, not the math, is the obstacle |
| `check_sqrt_floor_128` | solady sqrt, x < 2¹²⁸ | **TIMEOUT** 7 paths, 1,801 s |
| `check_buyExactIn_maximal` | full `QuoteMath` path (sqrt + divUp) | **TIMEOUT** 21 paths, 1,801 s |
| `check_arg_step` | `(z+1)²/W/2 ≥ z²/W/2` | **TIMEOUT** 900 s |
| `check_num_step` | one WAD Horner step monotone | **TIMEOUT** 900 s |
| `check_expWad_step` | `expWad(x+1) ≥ expWad(x)` | **TIMEOUT** 904 s |
| `check_mulDiv_matches` | `FullMath.mulDiv(a,b,d) == a·b/d`, a, b < 2¹²⁸ | **TIMEOUT** 901 s |
| `check_tail_step*` (full, lower branch, 2³²-wide window) | `tail(z+1) ≤ tail(z)` | **TIMEOUT**: window 329 paths, 1,877 s; lower branch 353 paths, 2,224 s; full domain killed after 40 min. A counterexample exists (§2), and Halmos did not find it either |
| `HalmosE2E.check_e2e_oneSwap` | real v4 PoolManager + PoolSwapTest + proto hook (flash accounting, transient deltas, 6909 claims, on-demand `sync`/`mint`/`settle`), symbolic isYes, buying, exactIn, amount (uint64), mid, halfSpread; asserts S1–S4 | **PASS** 791 paths, 176 s (`--loop 4`); 786 paths, 207 s (`--loop 16`). Bounded: Halmos warns that some paths hit the loop-unrolling bound (the loop was not identified, UNVERIFIED). It needed 3 harness changes (§5.3) |

### 5.2 Why the pattern is so sharp

- Halmos keeps symbolic×symbolic `MUL`, `DIV`, `MOD`, `SDIV` and `EXP` as **uninterpreted functions**
  (`halmos/sevm.py:281-292`, `arith` at `:2129`). It adds only `x/y ≤ x` and `x%y ≤ y`.
  - An UNSAT under abstraction is a sound proof. This is why S3/S4 with mulDiv pass: the proof never needs the value
    of mulDiv.
  - A SAT under abstraction triggers a second query in which the functions are replaced by real `bvmul`/`bvudiv`
    (`solve.py:596-620`). Non-linear 256-bit bit-vector problems (monotonicity of floors of products) then time out.
- The default branching timeout is 1 ms. Undecided branches are explored both ways, which is sound but slower.
- The consequence for this project: **anything whose truth is "the arithmetic is right" goes to the integer model
  (z3/NIA, Lean) or to exact certificates. Anything whose truth is "the bookkeeping is right" goes to Halmos.**

### 5.3 Practical limitations hit in the spike

- **forge ≥ 1.x `dynamic_test_linking` breaks Halmos setUp.**
  - forge 1.8.3 defaults to `dynamic_test_linking = true` (`forge config`). It rewrites `new C()` in test files into
    `vm.deployCode(...)`.
  - Halmos 0.3.3 does not implement `deployCode(string)` (`halmos/utils.py:1400` lists it as unsupported), so
    `setUp()` fails with "No successful path found".
  - Fix: `dynamic_test_linking = false` in `foundry.toml`. Also avoid `deployCodeTo` for hooks with flag-bits
    addresses: deploy normally, then `vm.etch(flaggedAddr, address(tmp).code)`. That works when the constructor only
    sets immutables, as ours does.
- **CREATE2 salt searches do not terminate symbolically.** The proto's `_deployOrdered` loops over salts until the
  keccak-predicted CREATE2 address sorts on the requested side of USDC. Under Halmos, setUp ran for 340 s and then
  found no successful path. For the spike it was replaced by a plain `new OutcomeToken` (diff in
  `halmos-e2e/PredictionHookProto.halmos.diff`), which touches only market creation. The swap path handles both
  orderings. The production hook should take the outcome tokens' addresses as inputs, or mine salts off-chain, so the
  same bytecode can be verified.
- **`makeAddr` yields symbolic addresses** (`f_vmaddr(...)`) in Halmos. The proto's `trader = makeAddr("trader")`
  made setUp branch ("Multiple paths were found in setUp()"). Use concrete addresses in Halmos setUps.
- **via-IR with `optimizer_runs = 44,444,444`** made the Halmos build take 258 s, versus 28 s for incremental builds.
  Use a separate `halmos` profile with lower runs. Halmos executes bytecode, so via-IR is supported.
- **Transient storage (EIP-1153) is supported** (`OP_TLOAD`/`OP_TSTORE`, `halmos/sevm.py:150-151`, and a
  `transient_storage` map per exec at `:1161`). The PoolManager's `unlock` → callback → `NonzeroDeltaCount` flow
  executes symbolically. Delta slots are `keccak(target, currency)`, which Halmos handles with its keccak model.
- **Loops:** a full NoOp swap never enters `Pool.swap`'s tick loop. `amountToSwap = 0` returns at
  `v4-core/src/libraries/Pool.sol:320`. So the only loops are the hook's own (the ladder pass, n ≤ 30). The per-series
  ladder loop makes symbolic paths grow about 4× per strike, so symbolic checks stop at n ≈ 4–5 and the induction
  proof covers the rest.
- **Maintenance risk.** Halmos's last release is v0.3.3 (2025-07-31), with the last push on 2025-08-06, over a year
  old on 2026-09-26. In the same period hevm (`argotorg/hevm`, 0.58.0, 2026-06-26, supports TLOAD/TSTORE/MCOPY since
  0.54 and bitwuzla), Kontrol (v1.0.255, 2026-06-24; KEVM has `TLOAD`/`TSTORE`/`MCOPY` rules, `evm.md:1644-1658`) and
  Certora (open source, 8.19.2, 2026-09-07) all released. Pin halmos in CI, and keep harnesses in plain
  `check_*`/`prove_*` Foundry form so hevm can run them too.

### 5.4 Harness shapes to use in the plan

1. **Inductive-step ledger harness** (proved, `LedgerHalmos.t.sol`).
   - A harness contract exposes `set(...)` for the storage of one or two markets.
   - The test assumes the invariant on a symbolic pre-state, calls one symbolic operation inside `try/catch`
     (a revert is a legal outcome), and asserts the invariant.
   - The price layer is either abstracted (arbitrary q, cash) or real.
   - Scale to the real hook by making the harness *inherit* the hook and expose storage setters. Only the ledger code
     then runs symbolically. The PoolManager calls are stubbed by a mock PM with ERC-6909 balance mapping semantics.
2. **End-to-end single-swap harness** (`halmos-e2e/test/HalmosE2E.t.sol`).
   - A concrete setUp (fresh PM, routers, etched hook, funded market, one concrete trade), then one symbolic swap
     through `PoolSwapTest` with symbolic side, direction, amount and price, asserting S1–S4.
   - This checks the delta plumbing (`BeforeSwapDelta` signs, sync/settle mint, claims mint/burn) against the real PM.
   - Depth 1 is enough because the ledger induction (1) covers sequences.
3. **Differential/equivalence harness** for assembly-vs-reference (the ToB UNI-DIFF style). Use it for
   `HartTail36` vs a checked reference when gas optimisation changes the code. Halmos proves equality only when the two
   are structurally close (as ToB's mulDiv v3/v4).
4. **What not to attempt symbolically:** Φ̂/expWad/sqrt/mulDiv value properties, and multi-step stateful invariants
   over PoolManager with loops. The latter stays with Foundry/Medusa campaigns (swap report: 3 campaigns; ToB used
   Echidna/Medusa for 88 of 100).

### 5.5 Certora and Kontrol (not run; from primary sources)

- **Certora.** Its v4-core engagement verified PoolManager-level rules, including transient-storage delta rules
  `must_terminate_with_zero_delta`, `nonZeroCorrect` and `isLockedAndDeltaZero`.
  - The assumptions were: "We assume mulDiv behaves correctly", "all loops (especially swap loop) iterate at most once",
    and "Calculations of storage slots through StateLibrary are correct" (Certora draft report pp. 14–15).
  - That is exactly the summarisation our hook needs: summarise `QuoteLib` as a NONDET or ghost function, write S3/S4 as
    CVL invariants over `beforeSwap`, and summarise PM `mint`/`burn`/`sync`/`settle`.
  - The prover is open source now, but a local setup was not attempted. **UNVERIFIED:** effort 1–2 weeks for an
    experienced CVL author.
- **Kontrol.** KEVM semantics include TLOAD/TSTORE/MCOPY. Kontrol reuses Foundry `test`/`prove` functions and supports
  user lemmas for non-linear arithmetic, which is its advantage over Halmos for Φ̂-type properties. Expect weeks of
  lemma engineering for expWad. The certificate route (§3) is cheaper. **UNVERIFIED:** runtimes.

---

## 6. Ladder prefix: paper proof (complete)

Let the strikes be sorted K₁ < … < K_n with the tie rule `S_T ≤ K ⇒ NO`. Region j (0 ≤ j ≤ n) pays YES in markets
1..j and NO in j+1..n. Terminal wealth is `W_j = cash + Σ_{i≤j} invY_i + Σ_{i>j} invN_i`.

`ladderMin` sets `run₀ = cash + Σ_i invN_i = W₀`, then `run_j = run_{j−1} + invY_j − invN_j`.
- By induction, `run_j = W_j`: moving from W_{j−1} to W_j replaces invN_j with invY_j.
- It returns `min_{0≤j≤n} run_j`.
- Casts: `int256(uint256(uint128))` cannot overflow, and the sum of ≤ 31 terms < 2¹³⁴ is far from 2²⁵⁵. ∎

Union bound: for any j, `W_j = cash + Σ_{i≤j} invY_i + Σ_{i>j} invN_i ≥ cash + Σ_i min(invY_i, invN_i)`. ∎

Halmos confirms both for n ≤ 4 and n = 3 (§5.1). The remaining obligation is the storage-to-array refinement in
`SeriesHook.sol:357-368`. Cover it with the Solidity differential test the LP report already lists (V6).

---

## 7. Real-number theorems: which need full paper proofs, and which are worth mechanising

| Theorem (source) | Paper proof in plan | Mechanise? |
|---|---|---|
| T1 range, T2 parity, T4 homogeneity (05 §2.1) | 2–3 lines each | no |
| T3 monotonicity, T5 vega sign, T6 theta sign, T7 limits, T8 Lipschitz | 1 page with the Greeks (05 §1.2) | no. The integer statements now rest on §3 and §4.3, not on T3 |
| **T9 martingale + QV identity** `Σ E[ΔP²] = P₀(1−P₀)` (05 §4.5) | full (½ page: orthogonal increments, P_N² = P_N) | **optional, Lean/mathlib**. Discrete-time, uses `MeasureTheory.Martingale` and conditional expectation. About 1–2 weeks for a Lean-literate engineer (UNVERIFIED). It is the one model-free identity that Theorem L and the LVR bound rest on |
| **Lemma M** (Mills-ratio monotonicity, quote §5) | full, including a proof of Gordon's inequality `1 − Φ(x) < φ(x)/x` (x > 0), which the report only cites numerically | no (a 5-line calculus proof) |
| **Theorem N, Lemma A, Lemma S, E1, E2** | full, with the Lemma S band precondition | **done in z3/NIA** (§4.1). Lean via `Nat.sqrt` lemmas is optional (≈1 day) |
| E4 (integer) | full: the §4.3 factored form plus §3's theorem | no; computer-assisted |
| **Theorem L** (per-epoch extraction bound) | full; relies on E2 (now machine-checked) and the single-variable path argument | no |
| Theorem A (error propagation), Theorem D (ε-monotone) | ½ page | no |
| Asian/TWAP closed form (05 §6.2) | full derivation: ∫ of Brownian motion is Gaussian with variance σ²(τ − 2w/3) (Kemna–Vorst). Keep the MC checks | no |
| RV estimator unbiasedness with stopping-time sampling (05 §5.1) | full (Wald's second identity), noting the fixed-endpoint condition | no |
| VCS ↔ complete-set bijection (swap report §5) | full (already written) | covered by Halmos S3/S4 steps |
| **Φ̂ monotonicity theorem (§3.2)** | full proof text plus the certificate scripts as appendix | computer-assisted (exact arithmetic) |

---

## 8. Recommended proof deliverables and effort

| # | Deliverable | Tooling | Effort (1 engineer) |
|---|---|---|---|
| D1 | Replace the WAD Hart port with HartX36. CI job runs `ratio_cert36.py`, `expwad_cert.py`, `expwad_err.py`, `expwad_kcheck.py` plus `Hart36Diff.t.sol` | Python + forge | 1–2 days (done in spike form) |
| D2 | Rewrite `epochQuote` in the factored `e·(R ± κ)` form. Integer E4 fuzz against the Solidity quote (not mpmath). Integer Lemma M proof | forge + paper | 2–3 days |
| D3 | `z3_integer_lemmas.py` as CI proof of Lemma S (with band), A, N, E1, E2. Add the band check to `sellExactOut` or document it | z3 | 0.5 day (done) |
| D4 | Model-to-bytecode for QuoteMath: Halmos where linear, differential fuzz where not. Paper lemma for solady `sqrt` floor-correctness plus exhaustive x < 2¹⁶ | Halmos / forge | 2 days |
| D5 | Halmos inductive S1–S4 on the real hook, via an inheriting harness with a mock PM and a single-swap E2E harness | Halmos | 3–4 days |
| D6 | Ladder: paper induction plus Halmos n ≤ 4 plus Solidity differential V6 | Halmos / forge | 0.5 day |
| D7 | Paper proofs appendix (§7) | LaTeX/Markdown | 3–4 days |
| D8 (optional) | Lean: discrete QV identity; Lemma S | Lean 4 + mathlib | 1–2 weeks |
| D9 (optional) | Certora CVL spec for S3/S4 over `beforeSwap` with PM summaries | Certora | 1–2 weeks |

---

## 9. Open questions

1. **ε-monotone fallback.** If the WAD port must be kept (e.g. an already-audited library), prove
   `tail(z′) ≤ tail(z) + 1` for all z′ > z. The same certificate machinery can bound the up-tick magnitude
   (≤ 2.2e-19 relative, so ≤ 1 wei). Not done here.
2. **φ̂ used alone** (the gamma half-spread `kφ(d)`, the Q_epoch cap `√w/φ`) is monotone on each half-line by (P1)/(P2).
   Its use inside `max_i` and `min_i` across dual sources keeps monotonicity by the quote report's argument. Check the
   rounding directions when the factored form is adopted.
3. **lnWad monotonicity** (for S → x): the same segment-plus-boundary certificate as expWad applies. It was not run
   here; 05 reports 100k consecutive-integer checks.
4. **Should Halmos remain the default** given its dormancy? A two-week trial of hevm 0.58 on the same `check_*`
   harnesses would answer it.

---

## Reproduce

```
cd docs/research/gaps/formal-verification-scripts/py
python3 hunt2.py 5.0,7.07 1 150000            # Φ̂ counterexamples (WAD port), ~6 min per seed
python3 ratio_cert.py 7.07 0.001              # WAD port: certificate stops at 4.465
python3 ratio_cert36.py 7.071067811865470 0.01 # X36: certified on [0, SPLIT)
uv run --python 3.12 --with sympy python expwad_cert.py && uv run --python 3.12 --with sympy python expwad_err.py
python3 expwad_kcheck.py                      # 61 k-boundaries, ~1 min
uv run --with z3-solver python z3_integer_lemmas.py
python3 gplus.py; python3 sell_cex.py
# Solidity (needs lib/forge-std, lib/solady, lib/v4-core; see foundry.toml):
cd ../halmos && forge test && halmos --contract LedgerHalmos --loop 32
# E2E: copy halmos-e2e/test into the swap-path prototype, apply PredictionHookProto.halmos.diff,
#      set dynamic_test_linking = false, then: halmos --contract HalmosE2E --loop 4
```

## Verification

**Verified in this session (primary evidence):**
- Counterexamples to Φ̂ monotonicity:
  - 61 found by `py/hunt2.py` over 8 seeds (`py/out_hunt2_original.txt`);
  - 54 replayed on the EVM with forge 1.8.3 / solc 0.8.26: 54/54 confirmed (`HartCex.t.sol`);
  - 2 × 1M-run Foundry fuzz misses them (`HartFuzz.t.sol`).
- `HartTail.sol` is a textual copy of `05-math-scripts/evm/T.sol:11-27` (same constants and branches).
- Ratio certificates:
  - WAD port certified on [0, 4.465) and fails beyond; the first observed up-ticks are at 4.47 (`py/out_ratio.txt`);
  - X36 certified on [0, 7.0710678) in 708 chunks.
- expWad certificate: range, Sturm counts, F′ ≥ 0.117, error ≤ 1.0033 (`py/out_expwad_cert.txt`); 61 boundaries,
  24.2M steps, 0 decreases.
- X36:
  - accuracy 42.23 wei (`out_acc36.txt`);
  - bit-exact vs Python on 2,004 points;
  - gas 1,309;
  - 0 violations in 1,008 + 76 drift crossings (`out_hunt36_cf.txt`).
- z3 results (`py/out_z3.txt`). Sell-side Lemma S counterexample reproduced independently in Python
  (`out_sell_cex.txt`), z3 and Halmos.
- g⁺ naive vs factored (`py/out_gplus.txt`).
- Halmos results in §5.1, including the E2E PASS through the real PoolManager (`halmos/logs/e2e5.log`, `e2e6.log`) after the
  setUp failures documented in §5.3 (`e2e.log`–`e2e4.log`). Filtered logs are in `formal-verification-scripts/halmos/logs/`.
- Halmos internals: `sevm.py:150-151, 281-292, 1161, 2129`; `solve.py:565-620`; `utils.py:1400`, read in the installed
  0.3.3 package.
- `forge config` shows `dynamic_test_linking = true` by default in 1.8.3, and setting it `false` was required.
- v4-core `46c6834`: `PoolManager.swap` at `src/PoolManager.sol:187-227`; `Pool.swap` early return at
  `src/libraries/Pool.sol:320`.
- ToB v4-core report (local text copy of the jsDelivr PDF):
  - "100 invariants, of which eight have been formally verified by Halmos" (p. 8);
  - Halmos policy "Timeout of 2 hours" (p. 16);
  - verified stateless invariants UNI-PROTOFEE-1/2 and UNI-LIQMATH-1/2 (p. 23);
  - UNI-DIFFV3-1/3/4/5 verified; "UNI-DIFFV3-2 could not be verified by Halmos (timeout two hours)" (p. 24).
- Certora v4-core draft report: assumptions "We assume mulDiv behaves correctly" (p. 14) and "all loops … iterate at
  most once" (p. 15); rule `must_terminate_with_zero_delta` Verified (p. 15).
- Release data from the GitHub API on 2026-09-26: halmos v0.3.3 (2025-07-31, last push 2025-08-06); hevm 0.58.0
  (2026-06-26); Kontrol v1.0.255 (2026-06-24); CertoraProver 8.19.2 (2026-09-07). KEVM `evm.md` TLOAD/TSTORE/MCOPY rules
  were fetched raw from GitHub.

**Not verified / UNVERIFIED:**
- The violation density (1.3e-10 per wei, about 2.8e8 bad steps) is an integral estimate × the observed flicker rate,
  not a count. Violations in [4.47, 5.0) are predicted but none were sampled.
- The Taylor-enclosure bound in `expwad_cert.py` assumes `F < 2⁹⁵` (observed, not certified). The Python-to-bytecode link
  for X36 rests on differential testing (2,004 points), not on a proof.
- The d = 0 junction of the factored g± with the final rounding directions is argued, not machine-checked.
- Certora and Kontrol were not run, so their effort estimates are judgement. The Lean effort estimates are judgement.
- The claim that solady's `sqrt` has no public floor-correctness proof is based on a web search that found only
  `zobront/halmos-solady` (equivalence with solmate).

**Sources:**
- [Trail of Bits, Uniswap v4 Core Security Assessment (2024-09-05)](https://cdn.jsdelivr.net/npm/@uniswap/v4-core@1.0.2/docs/security/audits/TrailOfBits_audit_core.pdf)
- Certora, Uniswap v4 core draft report (`v4-core/docs/security/audits/DRAFT_Certora_audit_core.pdf`)
- [Trail of Bits blog, Building secure Uniswap v4 hooks (2026-07-30)](https://blog.trailofbits.com/2026/07/30/building-secure-uniswap-v4-hooks/)
- [Trail of Bits blog, The call for invariant-driven development](https://blog.trailofbits.com/2025/02/12/the-call-for-invariant-driven-development/)
- [a16z/halmos](https://github.com/a16z/halmos) (v0.3.3)
- [argotorg/hevm CHANGELOG](https://github.com/argotorg/hevm/blob/main/CHANGELOG.md)
- [runtimeverification/kontrol](https://github.com/runtimeverification/kontrol), [KEVM evm.md](https://github.com/runtimeverification/evm-semantics)
- [Certora/CertoraProver](https://github.com/Certora/CertoraProver)
- [zobront/halmos-solady](https://github.com/zobront/halmos-solady)
- [mathlib Gaussian (Real)](https://leanprover-community.github.io/mathlib4_docs/Mathlib/Probability/Distributions/Gaussian/Real.html); [Formalization of Brownian motion in Lean (arXiv 2511.20118)](https://arxiv.org/pdf/2511.20118)
- Previous reports: 05 §2.2–2.4, §3, §4.5, §6.2; quote-function §2–5, §9–10; swap-path §2, §5–6; LP-vault §5; 06 (Bunni/Cork)
