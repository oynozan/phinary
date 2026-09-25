// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {VolOracleV2} from "../src/VolOracleV2.sol";
import {Oracle as OZOracle} from "../src/OZOracle.sol";

/// Independent reference: integrates the piecewise-constant tick path segment by segment (no lazy two-difference
/// trick, no incremental state), then recomputes every window sum, winsorized squared difference, checkpoint and
/// variance from scratch.
contract RefModel {
    uint32[] public ts; // ts[0] = init time; ts[i] = time of write i
    int24[] public tk; // tk[0] = init tick (also "pretended" before init); tk[i] = tick over (ts[i-1], ts[i]]
    uint32 public H;
    int24 public windowCap;
    int24 public blockCap;

    constructor(uint32 t0, int24 k0, uint32 h, int24 wc, int24 bc) {
        ts.push(t0);
        tk.push(k0);
        H = h;
        windowCap = wc;
        blockCap = bc;
    }

    function push(uint32 t, int24 k) external {
        ts.push(t);
        tk.push(k);
    }

    function n() external view returns (uint256) {
        return ts.length;
    }

    /// cum(T) for T <= last write, or up to `nowT` with tick `curTick` after the last write.
    function cumAt(uint32 T, int24 curTick) public view returns (int256 c) {
        uint256 len = ts.length;
        if (T <= ts[0]) return -int256(tk[0]) * int256(uint256(ts[0] - T));
        for (uint256 i = 1; i < len; i++) {
            uint32 a = ts[i - 1];
            uint32 b = ts[i];
            if (T <= a) break;
            uint32 e = T < b ? T : b;
            c += int256(tk[i]) * int256(uint256(e - a));
        }
        if (T > ts[len - 1]) c += int256(curTick) * int256(uint256(T - ts[len - 1]));
    }

    function D(uint32 g, int24 curTick) public view returns (int256) {
        return cumAt(g * H, curTick) - cumAt(g * H - H, curTick);
    }

    function sqClamp(int256 d, int256 cap) public pure returns (uint256) {
        if (d > cap) d = cap;
        if (d < -cap) d = -cap;
        return uint256(d * d);
    }

    /// wsq accumulated over windows g0+1..g (g0 = init grid)
    function wsqAt(uint32 g, int24 curTick) public view returns (uint256 w) {
        uint32 g0 = ts[0] / H;
        int256 cap = int256(windowCap) * int256(uint256(H));
        int256 prev = D(g0, curTick);
        for (uint32 x = g0 + 1; x <= g; x++) {
            int256 d = D(x, curTick);
            w += sqClamp(d - prev, cap);
            prev = d;
        }
    }

    function bsqAt(uint256 i) public view returns (uint256 w) {
        for (uint256 j = 1; j <= i; j++) {
            w += sqClamp(int256(tk[j]) - int256(tk[j - 1]), blockCap);
        }
    }
}

contract VolOracleV2Test is Test {
    using VolOracleV2 for VolOracleV2.Oracle;

    VolOracleV2.Oracle internal o;
    OZOracle.Observation[65535] internal oz;
    uint16 internal ozIdx;
    uint16 internal ozCard;
    uint16 internal ozCardNext;

    uint32 constant T0 = 1_790_000_000; // multiple of 100 but not of 300 -> first window straddles init
    VolOracleV2.Params P;

    // ------------------------------------------------------------ helpers
    function _init(int24 k0, VolOracleV2.Params memory p) internal returns (RefModel r) {
        P = p;
        o.initialize(T0 + 17, k0, p);
        (ozCard, ozCardNext) = OZOracle.initialize(oz, T0 + 17, k0);
        r = new RefModel(T0 + 17, k0, p.H, p.windowCap, p.blockCap);
    }

    function _write(RefModel r, uint32 t, int24 k) internal {
        bool w = o.write(t, k, P);
        assertTrue(w, "write");
        (ozIdx, ozCard) = OZOracle.write(oz, ozIdx, t, k, ozCard, ozCardNext, type(int24).max);
        r.push(t, k);
    }

    function _rand(uint256 seed, uint256 i) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, i)));
    }

    /// Full comparison of all stored state against the reference.
    function _checkAll(RefModel r, bool[] memory expectAvail, uint32 gInit) internal view {
        VolOracleV2.State memory st = o.st;
        VolOracleV2.Observation memory last = o.obs[st.index];
        uint256 n = r.n();
        uint32 tLast = r.ts(n - 1);
        assertEq(last.blockTimestamp, tLast, "ts");
        assertEq(int256(last.tickCumulative), r.cumAt(tLast, 0), "tickCumulative");
        assertEq(int256(last.tickCumulative), int256(oz[ozIdx].tickCumulative), "tickCumulative == OZ Oracle");
        assertEq(uint256(last.blockSqCumulative), r.bsqAt(n - 1), "blockSq");
        assertEq(uint256(last.windowSqCumulative), r.wsqAt(st.lastGrid, 0), "windowSq");
        assertEq(st.lastGrid, tLast / P.H, "lastGrid");
        assertEq(int256(st.cumAtLastGrid), r.cumAt(st.lastGrid * P.H, 0), "cumAtLastGrid");
        assertEq(int256(st.lastWindowSum), r.D(st.lastGrid, 0), "lastWindowSum");
        assertEq(uint256(st.nWin), uint256(st.lastGrid - gInit), "nWin");
        // checkpoint ring: every retained grid must be exact; availability must follow the catch-up rule
        uint32 lo = st.lastGrid >= P.ringSize ? st.lastGrid - P.ringSize + 1 : 0;
        if (lo < gInit) lo = gInit;
        for (uint32 g = lo; g <= st.lastGrid; g++) {
            VolOracleV2.Checkpoint memory c = o.ckpt[g % P.ringSize];
            bool avail = c.grid == g;
            assertEq(avail, expectAvail[g - gInit], "availability");
            if (!avail) continue;
            assertEq(int256(c.cum), r.cumAt(g * P.H, 0), "ckpt.cum");
            assertEq(uint256(c.wsq), r.wsqAt(g, 0), "ckpt.wsq");
            assertEq(uint256(c.nWin), uint256(g - gInit), "ckpt.nWin");
        }
    }

    // ------------------------------------------------------------ fuzzed paths
    function testFuzz_pathMatchesReference(uint256 seed) public {
        VolOracleV2.Params memory p = VolOracleV2.Params({H: 300, blockCap: 15, windowCap: 25, maxCatchUp: 6, ringSize: 16});
        int24 k = int24(int256(_rand(seed, 999) % 2000)) - 1000;
        RefModel r = _init(k, p);
        uint32 gInit = (T0 + 17) / p.H;
        if (_rand(seed, 998) % 2 == 0) {
            o.grow(8);
            OZOracle.grow(oz, ozCardNext, 8);
            ozCardNext = 8;
        }
        bool[] memory avail = new bool[](4000);
        avail[0] = true;
        uint32 t = T0 + 17;
        uint256 nw = 30 + _rand(seed, 997) % 30;
        for (uint256 i; i < nw; i++) {
            uint256 x = _rand(seed, i);
            uint256 kind = x % 10;
            uint32 gap;
            if (kind < 4) gap = uint32(1 + (x >> 8) % 30); // same or next window
            else if (kind < 7) gap = uint32(150 + (x >> 8) % 900); // 1-3 boundaries (g == g1 and g > g1 branches)
            else if (kind < 9) gap = uint32(2000 + (x >> 8) % 4000); // multi-window gaps, beyond maxCatchUp
            else gap = uint32(p.H - (t % p.H)); // land exactly on a grid boundary
            uint256 y = x >> 64;
            int24 step = int24(int256(y % 21)) - 10;
            if ((y >> 8) % 7 == 0) step = int24(int256((y >> 16) % 200)) - 100; // jumps that bind both caps
            if ((y >> 24) % 11 == 0) step = 0;
            k += step;
            uint32 gPrev = t / p.H;
            t += gap;
            uint32 g = t / p.H;
            if (g > gPrev) {
                uint32 from = gPrev + 1;
                if (g - from + 1 > p.maxCatchUp) from = g - p.maxCatchUp + 1;
                for (uint32 gg = gPrev + 1; gg <= g; gg++) avail[gg - gInit] = gg >= from;
            }
            _write(r, t, k);
        }
        _checkAll(r, avail, gInit);
        // observation ring wrap-around: the last `card` observations must be the last `card` writes
        VolOracleV2.State memory st = o.st;
        uint256 n = r.n();
        for (uint256 j; j < st.cardinality && j < n; j++) {
            uint256 slot = (uint256(st.index) + st.cardinality - j) % st.cardinality;
            assertEq(o.obs[slot].blockTimestamp, r.ts(n - 1 - j), "ring order");
            assertEq(int256(o.obs[slot].tickCumulative), r.cumAt(r.ts(n - 1 - j), 0), "ring cum");
        }
        // virtual (view) checkpoint for grids completed after the last write, with a live tick
        int24 cur = k + int24(int256(_rand(seed, 5000) % 41)) - 20;
        uint32 nowT = t + uint32(_rand(seed, 5001) % 1500) + 1;
        uint32 gNow = nowT / p.H;
        if (gNow > st.lastGrid) {
            VolOracleV2.Checkpoint memory c = o.checkpointAt(gNow, nowT, cur, p);
            assertEq(int256(c.cum), r.cumAt(gNow * p.H, cur), "virtual cum");
            assertEq(uint256(c.wsq), r.wsqAt(gNow, cur), "virtual wsq");
        }
        // variance over the last retained windows equals the reference formula
        uint32 nWin = 3;
        (bool okA, bool okB) = (_avail(gNow - nWin, nowT, cur, p), _avail(gNow, nowT, cur, p));
        if (okA && okB && gNow - nWin > gInit) {
            (uint256 v,,, uint32 dN) = o.varianceE36(nWin, nowT, cur, p);
            uint256 dq = r.wsqAt(gNow, cur) - r.wsqAt(gNow - nWin, cur);
            assertEq(dN, nWin);
            assertEq(v, VolOracleV2.mulDiv(dq * 3, VolOracleV2.LN_TICK_SQ_E36, 2 * uint256(p.H) ** 3 * nWin), "variance");
        }
    }

    function _avail(uint32 g, uint32 nowT, int24 cur, VolOracleV2.Params memory p) internal view returns (bool) {
        try this.ckptExt(g, nowT, cur, p) returns (VolOracleV2.Checkpoint memory) {
            return true;
        } catch {
            return false;
        }
    }

    function ckptExt(uint32 g, uint32 nowT, int24 cur, VolOracleV2.Params memory p)
        external
        view
        returns (VolOracleV2.Checkpoint memory)
    {
        return o.checkpointAt(g, nowT, cur, p);
    }

    // ------------------------------------------------------------ deterministic branch tests
    function test_capBinding() public {
        VolOracleV2.Params memory p = VolOracleV2.Params({H: 300, blockCap: 50, windowCap: 30, maxCatchUp: 8, ringSize: 64});
        RefModel r = _init(0, p);
        uint32 g0 = (T0 + 17) / p.H;
        uint32 t = (g0 + 1) * p.H + 5;
        _write(r, t, 0); // crosses g0+1 with no move
        t += 12;
        _write(r, t, 0);
        // jump of 1000 ticks, held: block cap (50) and window cap (30*300) both bind
        t += 12;
        _write(r, t, 0); // the tick passed is the PRE-swap tick; the jump shows up in the next write
        t += 12;
        _write(r, t, 1000);
        t = (g0 + 4) * p.H + 1; // crosses 2 boundaries -> g > g1 branch with both diffs saturated
        _write(r, t, 1000);
        VolOracleV2.Observation memory last = o.obs[o.st.index];
        assertEq(uint256(last.blockSqCumulative), 50 * 50, "block cap binds once");
        // untruncated cumulative (truncation would bias RV and TWAP settlement)
        assertEq(int256(last.tickCumulative), r.cumAt(t, 0), "cum untruncated");
        uint256 capD2 = uint256(30 * 300) ** 2;
        // window diffs: g0+2 contains part of the jump, g0+3 the rest; both exceed the cap
        assertGt(r.D(g0 + 2, 0) - r.D(g0 + 1, 0), int256(30 * 300));
        assertGt(r.D(g0 + 3, 0) - r.D(g0 + 2, 0), int256(30 * 300));
        assertEq(uint256(last.windowSqCumulative), 2 * capD2, "window cap binds on both windows");
        assertEq(uint256(last.windowSqCumulative), r.wsqAt(o.st.lastGrid, 0));
    }

    function test_multiWindowGapBranches() public {
        VolOracleV2.Params memory p = VolOracleV2.Params({H: 300, blockCap: 9116, windowCap: 1000, maxCatchUp: 4, ringSize: 32});
        RefModel r = _init(100, p);
        uint32 g0 = (T0 + 17) / p.H;
        bool[] memory avail = new bool[](200);
        avail[0] = true;
        uint32 t = T0 + 17;
        // (a) same window, no crossing
        t += 12;
        _write(r, t, 103);
        // (b) exactly one boundary: g == g1
        t = (g0 + 1) * p.H + 3;
        _write(r, t, 110);
        avail[1] = true;
        // (c) two boundaries: g == g1 + 1
        t = (g0 + 3) * p.H + 3;
        _write(r, t, 90);
        avail[2] = true;
        avail[3] = true;
        // (d) land exactly on a boundary time
        t = (g0 + 4) * p.H;
        _write(r, t, 95);
        avail[4] = true;
        // (e) 10-window gap with maxCatchUp = 4: grids g0+5..g0+10 skipped, g0+11..g0+14 written
        t = (g0 + 14) * p.H + 100;
        _write(r, t, 120);
        for (uint32 i = 11; i <= 14; i++) avail[i] = true;
        _checkAll(r, avail, g0);
        vm.expectRevert(abi.encodeWithSelector(VolOracleV2.CheckpointUnavailable.selector, g0 + 7));
        this.ckptExt(g0 + 7, t + 1, 120, p);
        // window statistics are still exact across the gap: variance g0+4 .. g0+14 is not readable (start missing),
        // but g0+11 .. g0+14 is, and nWin counts every window in the gap (zero-return windows are real data)
        VolOracleV2.Checkpoint memory a = o.checkpointAt(g0 + 11, t + 1, 120, p);
        VolOracleV2.Checkpoint memory b = o.checkpointAt(g0 + 14, t + 1, 120, p);
        assertEq(b.nWin - a.nWin, 3);
        assertEq(uint256(b.wsq - a.wsq), r.wsqAt(g0 + 14, 0) - r.wsqAt(g0 + 11, 0));
    }

    function test_ringWrapAround() public {
        VolOracleV2.Params memory p = VolOracleV2.Params({H: 60, blockCap: 9116, windowCap: 1000, maxCatchUp: 8, ringSize: 8});
        RefModel r = _init(0, p);
        uint32 g0 = (T0 + 17) / p.H;
        o.grow(4);
        OZOracle.grow(oz, ozCardNext, 4);
        ozCardNext = 4;
        uint32 t = T0 + 17;
        int24 k;
        for (uint256 i; i < 50; i++) {
            t += 37;
            k += int24(int256(i % 7)) - 3;
            _write(r, t, k);
        }
        VolOracleV2.State memory st = o.st;
        assertEq(st.cardinality, 4);
        // old grids overwritten -> unavailable; the last 8 grids exact
        vm.expectRevert(abi.encodeWithSelector(VolOracleV2.CheckpointUnavailable.selector, st.lastGrid - 8));
        this.ckptExt(st.lastGrid - 8, t, k, p);
        for (uint32 g = st.lastGrid - 7; g <= st.lastGrid; g++) {
            VolOracleV2.Checkpoint memory c = o.checkpointAt(g, t, k, p);
            assertEq(int256(c.cum), r.cumAt(g * p.H, 0));
            assertEq(uint256(c.wsq), r.wsqAt(g, 0));
            assertEq(uint256(c.nWin), uint256(g - g0));
        }
    }

    function test_sameBlockWriteIsNoop() public {
        VolOracleV2.Params memory p = VolOracleV2.Params({H: 300, blockCap: 9116, windowCap: 1000, maxCatchUp: 8, ringSize: 64});
        _init(0, p);
        uint32 t = T0 + 400;
        assertTrue(o.write(t, 5, p));
        VolOracleV2.Observation memory a = o.obs[o.st.index];
        // any number of later "swaps" in the same block pass manipulated ticks: nothing changes
        assertFalse(o.write(t, 5000, p));
        assertFalse(o.write(t, -5000, p));
        VolOracleV2.Observation memory b = o.obs[o.st.index];
        assertEq(abi.encode(a), abi.encode(b));
        (int24 sob,) = o.sobTick(t, 5000);
        assertEq(sob, 5, "SoB ignores live tick once written this block");
    }
}
