Reproduction for docs/md/research/gaps/lp-vault-structure-and-exposure-caps.md

- Python: `uv run --with scipy --with numpy python checks.py` (-> out_checks.txt); `python sigma_extremum.py` (-> out_sigma.txt)
- Foundry prototype: create lib/ with forge-std, solmate and v4-core (v4-core commit 46c6834, 2026-04-02; the
  `src/` tree is identical to the scratchpad clone used by reports 01/06), then `forge test -vv --fuzz-runs 1000`
  (forge 1.8.3, solc 0.8.26, evm cancun, via_ir). Output -> out_forge.txt.
  Research prototype only: pricing is a stub (settable mid), settlement oracle is a stub.
