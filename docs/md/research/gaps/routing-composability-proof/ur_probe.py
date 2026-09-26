"""Fork eth_call probe: which deployed UniversalRouter decodes the 5-field vs 6-field
IV4Router.ExactInputSingleParams (and 4- vs 5-field ExactInputParams), per chain.

Swap: 0.01 native ETH -> USDC on the hookless 500/10 ETH/USDC v4 pool, paid with msg.value,
UR command V4_SWAP(0x10), actions SWAP_EXACT_IN_SINGLE(0x06) | SETTLE_ALL(0x0c) | TAKE_ALL(0x0f).
TAKE_ALL minAmount = 2**127 forces V4TooLittleReceived(min, actual) which reveals the amount out.
"""
import json, sys, urllib.request, time
from eth_abi import encode, decode
from eth_utils import keccak, to_checksum_address

CHAINS = {
    "mainnet": dict(rpc="https://ethereum-rpc.publicnode.com", usdc="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        ur={"v2.0": "0x66a9893cc07d91d95644aedd05d03f95e1dba8af", "v2.1.1": "0x4c82d1fbfe28c977cbb58d8c7ff8fcf9f70a2cca",
            "v2.1.2": "0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85"}, quoter="0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203"),
    "base": dict(rpc="https://base-rpc.publicnode.com", usdc="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        ur={"v2.0": "0x6ff5693b99212da76ad316178a184ab56d299b43", "v2.1.1": "0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7",
            "v2.1.2": "0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40"}, quoter="0x0d5e0f971ed27fbff6c2837bf31316121532048d"),
    "arbitrum": dict(rpc="https://arbitrum-one-rpc.publicnode.com", usdc="0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        ur={"v2.0": "0xa51afafe0263b40edaef0df8781ea9aa03e381a3", "v2.1.1": "0x8b844f885672f333bc0042cb669255f93a4c1e6b",
            "v2.1.2": "0x2d01411773c8C24805306E89A41F7855C3c4Fe65"}, quoter="0x3972c00f7ed4885e145823eb7c655375d275a1c5"),
    "unichain": dict(rpc="https://unichain-rpc.publicnode.com", usdc="0x078D782b760474a361dDA0AF3839290b0EF57AD6",
        ur={"v2.0": "0xef740bf23acae26f6492b10de645d6b98dc8eaf3", "v2.1.1": "0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7",
            "v2.1.2": "0xD1b797D92d87B688193A2B976eFc8D577D204343"}, quoter="0x333e3c607b141b18ff6de9f258db6e77fe7491e0"),
}
FROM = "0x1111111111111111111111111111111111111111"
AMT = 10**16
ZERO = "0x0000000000000000000000000000000000000000"

def sel(sig): return keccak(text=sig)[:4]
ERRS = {sel(s).hex(): s for s in [
    "V4TooLittleReceived(uint256,uint256)", "V4TooLittleReceivedPerHopSingle(uint256,uint256)",
    "V4TooLittleReceivedPerHop(uint256,uint256,uint256)", "InvalidHopPriceLength()", "SliceOutOfBounds()",
    "ExecutionFailed(uint256,bytes)", "UnexpectedRevertBytes(bytes)", "QuoteSwap(uint256)",
    "NotEnoughLiquidity(bytes32)", "WrappedError(address,bytes4,bytes,bytes)", "DeltaNotNegative(address)",
    "CurrencyNotSettled()", "Panic(uint256)", "Error(string)"]}

def rpc(url, method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    for i in range(4):
        try:
            req = urllib.request.Request(url, data=body, headers={"content-type": "application/json", "user-agent": "curl/8"})
            return json.load(urllib.request.urlopen(req, timeout=30))
        except Exception as e:
            err = e; time.sleep(1 + i)
    return {"error": {"message": str(err)}}

def describe(res):
    if "result" in res:
        return "OK " + (res["result"][:10] if res["result"] != "0x" else "(empty return)")
    e = res["error"]; data = e.get("data")
    if isinstance(data, dict): data = data.get("data")
    if not data or data == "0x": return f"REVERT no-data ({e.get('message','')[:60]})"
    s = data[2:10]; name = ERRS.get(s, "unknown 0x" + s)
    out = f"REVERT {name}"
    raw = bytes.fromhex(data[10:])
    try:
        if name.startswith("ExecutionFailed"):
            idx, inner = decode(["uint256", "bytes"], raw)
            s2 = inner[:4].hex(); n2 = ERRS.get(s2, "0x" + s2)
            out += f" -> cmd{idx}: {n2}"
            if n2.startswith("V4TooLittleReceived("):
                mn, act = decode(["uint256", "uint256"], inner[4:]); out += f" (min={mn}, actual={act})"
            elif n2.startswith("V4TooLittleReceivedPerHopSingle"):
                mn, act = decode(["uint256", "uint256"], inner[4:]); out += f" (minPrice={mn}, priceX36={act})"
        elif name.startswith("V4TooLittleReceived("):
            mn, act = decode(["uint256", "uint256"], raw); out += f" (min={mn}, actual={act})"
    except Exception as ex:
        out += f" [decode err {ex}]"
    return out

KEY_T = "(address,address,uint24,int24,address)"
def single5(key, amt, hook_data):
    return encode([f"({KEY_T},bool,uint128,uint128,bytes)"], [(key, True, amt, 0, hook_data)])
def single6(key, amt, hook_data, min_hop=0):
    return encode([f"({KEY_T},bool,uint128,uint128,uint256,bytes)"], [(key, True, amt, 0, min_hop, hook_data)])
PATH_T = "(address,uint24,int24,address,bytes)"
def multi4(usdc, amt):  # ExactInputParams v2.0: currencyIn, PathKey[] path, amountIn, amountOutMinimum
    return encode([f"(address,{PATH_T}[],uint128,uint128)"], [(ZERO, [(usdc, 500, 10, ZERO, b"")], amt, 0)])
def multi5(usdc, amt, hop=None):  # v2.1.x: currencyIn, path, uint256[] minHopPriceX36, amountIn, amountOutMinimum
    return encode([f"(address,{PATH_T}[],uint256[],uint128,uint128)"], [(ZERO, [(usdc, 500, 10, ZERO, b"")], hop or [], amt, 0)])

def execute_calldata(action_byte, swap_param, usdc, take_min):
    actions = bytes([action_byte, 0x0C, 0x0F])
    params = [swap_param, encode(["address", "uint256"], [ZERO, AMT]), encode(["address", "uint256"], [usdc, take_min])]
    inp = encode(["bytes", "bytes[]"], [actions, params])
    return "0x" + (sel("execute(bytes,bytes[],uint256)") + encode(["bytes", "bytes[]", "uint256"], [bytes([0x10]), [inp], 2**40])).hex()

def main():
    chains = sys.argv[1:] or list(CHAINS)
    for c in chains:
        cfg = CHAINS[c]; usdc = to_checksum_address(cfg["usdc"])
        key = (ZERO, usdc, 500, 10, ZERO)
        blk = rpc(cfg["rpc"], "eth_blockNumber", [])
        print(f"\n=== {c} block {int(blk.get('result','0x0'),16)}")
        hd = b"\x11" * 32
        cases = [
            ("single 5-field, hookData=''", 0x06, single5(key, AMT, b"")),
            ("single 5-field, hookData=32B", 0x06, single5(key, AMT, hd)),
            ("single 6-field, minHop=0, hookData=''", 0x06, single6(key, AMT, b"")),
            ("single 6-field, minHop=0, hookData=32B", 0x06, single6(key, AMT, hd)),
            ("single 6-field, minHop=2^200", 0x06, single6(key, AMT, b"", 2**200)),
            ("multi 4-field (v2.0 ExactInputParams)", 0x07, multi4(usdc, AMT)),
            ("multi 5-field (v2.1 ExactInputParams)", 0x07, multi5(usdc, AMT)),
            ("multi 5-field, minHop=[2^200]", 0x07, multi5(usdc, AMT, [2**200])),
        ]
        for urname, ur in cfg["ur"].items():
            code = rpc(cfg["rpc"], "eth_getCode", [ur, "latest"]).get("result", "0x")
            print(f"-- UR {urname} {ur} codeLen={len(code)//2-1}")
            for label, act, p in cases:
                data = execute_calldata(act, p, usdc, 2**127)
                tx = {"from": FROM, "to": ur, "data": data, "value": hex(AMT), "gas": hex(3_000_000)}
                res = rpc(cfg["rpc"], "eth_call", [tx, "latest", {FROM: {"balance": hex(10**19)}}])
                print(f"   {label:42s} {describe(res)}")
                time.sleep(0.3)
        # Quoter: quoteExactInputSingle((PoolKey,bool,uint128,bytes)) and msgSender()
        q = cfg["quoter"]
        qd = "0x" + (sel("quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))") +
                     encode([f"({KEY_T},bool,uint128,bytes)"], [(key, True, AMT, b"")])).hex()
        res = rpc(cfg["rpc"], "eth_call", [{"from": FROM, "to": q, "data": qd}, "latest"])
        if "result" in res:
            a, g = decode(["uint256", "uint256"], bytes.fromhex(res["result"][2:])); print(f"-- Quoter {q}: amountOut={a} gasEstimate={g}")
        else: print(f"-- Quoter {q}: {describe(res)}")
        res = rpc(cfg["rpc"], "eth_call", [{"from": FROM, "to": q, "data": "0x" + sel("msgSender()").hex()}, "latest"])
        print(f"-- Quoter msgSender(): {describe(res)} {res.get('result','')[:66]}")

main()
