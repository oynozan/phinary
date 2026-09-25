Scripts for `../integrated-spec-rerun-backtest.md`.

Run from a working copy that also contains `lib.py` and `engine.py` from `../economic-backtest/` and a `data/` link to the
backtest data (see `../economic-acceptance-criteria-and-backtest.md` appendix), plus `../economic-backtest/out/arrays.pkl` at `../econ/out/arrays.pkl`.

Order: `spec.py` (constants) -> `costcurve.py` -> `prep2.py`, `prep3.py`, `prep4.py` -> `stage.py stageA bt cfgA.json` (+cfgA2) ->
`mkcfg.py`; `stage.py latB lat cfgL.json '[2,5]'`; `stage.py stageB bt cfgB.json` -> `select_cfg.py stageB`, `mdtab.py` ->
`mkfinal.py`; `stage.py latF lat cfgFL.json '[0.5,2,5]'`; `stage.py stageF bt cfgF.json '[0.25,0.5,1,2,3,5,8]'` ->
`final.py stageF latF cfgF.json`, `strict.py`, `m2charge.py`, `m2dstar.py`, `frozen_eval.py`, `peryear.py`.
Theorem checks: `qf/` (`MODE=asian|ramp|t uv run --with mpmath python quote_fuzz_asian.py N`, `lemmaM.py`).
All with `uv run --with numpy --with scipy --with numba [--with mpmath] python ...`.
