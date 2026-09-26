# underlying-oracle-prototype (research code, NOT audited)

Companion code for `../underlying-oracle-source-and-sigma-estimator.md`.

- `src/`: `VolOracleV2` (library), `VolOracleHookV2` (oracle-only v4 hook), `V3ObserveAdapter` (v3 `observe`
  wrapper), `IUnderlyingOracle`, `SigmaPolicy`, plus two helpers copied from the report-02 gasbench: `HookBase.sol`
  (a minimal hook base) and `OZOracle.sol` (a copy of the OZ Panoptic `Oracle` library, used in a differential
  test).
- `test/`: fuzz and reference tests, χ² calibration, end-to-end PoolManager test, gas, and mainnet-fork adapter tests.
- `py/`: `bias.py` (fee-band bias tables), `calib.py` (path files and 2,000-path calibration), `bn_check.py`
  (Binance cross-check), and `gql_pairs.py` / `scan_init.py` (pool enumeration). The JSON outputs sit next to them.
- `out_*.txt`: raw outputs quoted in the report.

To run:
1. Make `lib/` contain `forge-std`, `v4-core` (the same commit as report 02) and `solmate`.
2. Run `uv run --with numpy --with scipy python py/calib.py files`. It writes `data/*.bin`; adjust the output path in
   the script.
3. Run `forge test` (the fork tests need the `mainnet` RPC set in `foundry.toml`).
4. For gas figures, run `forge test --match-test test_gas_writes --isolate -vv`.
