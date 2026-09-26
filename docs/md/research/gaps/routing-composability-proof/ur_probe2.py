"""Probe 2: non-zero currency0 pool key (like YES/USDC). Pool does not exist, so a CORRECT decode reaches
PoolManager.swap and reverts PoolNotInitialized(); a WRONG decode reverts earlier with no data.
Also checks msgSender() on each UR."""
import sys; sys.argv=[sys.argv[0]]
exec(open('ur_probe.py').read().split("def main():")[0])
ERRS[sel("PoolNotInitialized()").hex()] = "PoolNotInitialized()"
FAKE1 = "0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF"
for c in ["mainnet", "base", "arbitrum", "unichain"]:
    cfg = CHAINS[c]; usdc = to_checksum_address(cfg["usdc"])
    key = (usdc, FAKE1, 0, 60, ZERO)   # currency0 = USDC != 0, like a YES/USDC or USDC/YES pool
    print(f"=== {c}")
    for urname, ur in cfg["ur"].items():
        res = rpc(cfg["rpc"], "eth_call", [{"from": FROM, "to": ur, "data": "0x"+sel("msgSender()").hex()}, "latest"])
        print(f"-- UR {urname}: msgSender() -> {describe(res)}")
        for label, p in [("5-field hookData=''", encode([f"({KEY_T},bool,uint128,uint128,bytes)"], [(key, True, 10**6, 0, b"")])),
                         ("6-field hookData=''", encode([f"({KEY_T},bool,uint128,uint128,uint256,bytes)"], [(key, True, 10**6, 0, 0, b"")]))]:
            actions = bytes([0x06, 0x0C, 0x0F])
            params = [p, encode(["address","uint256"], [usdc, 10**6]), encode(["address","uint256"], [FAKE1, 0])]
            inp = encode(["bytes","bytes[]"], [actions, params])
            data = "0x" + (sel("execute(bytes,bytes[],uint256)") + encode(["bytes","bytes[]","uint256"], [bytes([0x10]), [inp], 2**40])).hex()
            res = rpc(cfg["rpc"], "eth_call", [{"from": FROM, "to": ur, "data": data, "gas": hex(3_000_000)}, "latest"])
            print(f"   {label:24s} {describe(res)}")
