"""Live v3 oracle ring span (newest minus oldest observation timestamp) and in-range liquidity of the three 5 bp
WETH/USDC pools; slot0() = 0x3850c7bd, observations(uint256) = 0x252c09d7, liquidity() = 0x1a686502."""
import json, subprocess, time
P = {"arb": ("https://arb1.arbitrum.io/rpc", "0xC6962004f452bE9203591991D15f6b388e09E8D0", False),
     "base": ("https://mainnet.base.org", "0xd0b53D9277642d899DF5C87A3966A349A798F224", False),
     "eth": ("https://ethereum-rpc.publicnode.com", "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640", True)}
def call(u, to, data):
    o = subprocess.run(["curl", "-s", "--max-time", "30", "-X", "POST", u, "-H", "Content-Type: application/json", "-d",
                        json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [{"to": to, "data": data}, "latest"]})], capture_output=True, text=True).stdout
    r = json.loads(o)["result"][2:]; return [int(r[i:i + 64], 16) for i in range(0, len(r), 64)]
for ch, (u, a, flip) in P.items():
    s = call(u, a, "0x3850c7bd"); sp, idx, card = s[0], s[2], s[3]
    L = call(u, a, "0x1a686502")[0]
    new = call(u, a, "0x252c09d7" + f"{idx:064x}"); old = call(u, a, "0x252c09d7" + f"{(idx + 1) % card:064x}")
    if not old[3]: old = call(u, a, "0x252c09d7" + f"{0:064x}")
    Praw = (sp / 2**96) ** 2
    px = 1e12 / Praw if flip else Praw * 1e12
    yv = (L / (sp / 2**96) if flip else L * sp / 2**96) / 1e6
    span = new[0] - old[0]
    print(f"{ch}: price ${px:,.2f}, L {L:.4g}, y_v ${yv/1e6:.1f}M, cardinality {card}, ring span {span/3600:.1f} h "
          f"(oldest {time.strftime('%Y-%m-%d %H:%M', time.gmtime(old[0]))} UTC), observations per hour {card/(span/3600):.0f}")
