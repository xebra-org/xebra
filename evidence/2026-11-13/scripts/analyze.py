"""Normalise the raw quotes into one row per (pair, size, provider/route) and print markdown."""
import json, os, statistics, csv, sys

BASE = __import__("os").path.dirname(__import__("os").path.dirname(__import__("os").path.abspath(__file__)))
RAW = BASE + "/raw"
SIZES = [10, 100, 1000, 10000, 100000]
PAIRS = [("base", "arb"), ("eth", "base"), ("arb", "eth"), ("stellar", "base"), ("base", "sol"), ("pol", "avax")]
NAMES = {"base": "Base", "arb": "Arbitrum", "eth": "Ethereum", "stellar": "Stellar", "sol": "Solana", "pol": "Polygon", "avax": "Avalanche"}
DOMAIN = {"eth": 0, "avax": 1, "arb": 3, "sol": 5, "base": 6, "pol": 7, "stellar": 27}
NATIVE = {"base": "ethereum", "arb": "ethereum", "eth": "ethereum", "avax": "avalanche-2", "pol": "polygon-ecosystem-token", "sol": "solana", "stellar": "stellar"}

def load(name):
    p = f"{RAW}/{name}.json"
    if not os.path.exists(p):
        return None
    with open(p) as f:
        return json.load(f)

prices = load("prices_coingecko")["body"]
px = lambda chain: prices[NATIVE[chain]]["usd"]

# ---- measured gas (USD) ----
def median_cost(name, chain):
    g = load(name)
    if not g or not g["samples"]:
        return None, g
    c = statistics.median(int(s["totalCostWei"]) for s in g["samples"]) / 1e18
    return c * px(chain), g

DEST_GAS = {}
DEST_GAS_SRC = {}
for ch in ["base", "arb", "eth", "avax"]:
    usd, g = median_cost(f"gas_{ch}", ch)
    DEST_GAS[ch] = usd
    DEST_GAS_SRC[ch] = f"raw/gas_{ch}.json (median of {len(g['samples'])} receiveMessage txs, {g['meta']['fetchedAtUtc']})"
# Solana: no EVM-style sample; use Circle's own forwarding quote minus its $0.05 service fee as the destination cost.
f65 = load("iris_fees_6_5")
DEST_GAS["sol"] = f65["body"][1]["forwardFee"]["med"] / 1e6 - 0.05
DEST_GAS_SRC["sol"] = "Circle forwardFee.med(6->5) minus Circle's $0.05 service fee (raw/iris_fees_6_5.json); recipient USDC account already exists"
f65r = load("iris_fees_6_5_recipientsetup")
SOL_WITH_ATA = f65r["body"][1]["forwardFee"]["med"] / 1e6 - 0.05

SRC_GAS = {}
SRC_GAS_SRC = {}
for ch in ["base", "eth", "pol"]:
    usd, g = median_cost(f"gas_burn_{ch}", ch)
    SRC_GAS[ch] = usd
    SRC_GAS_SRC[ch] = f"raw/gas_burn_{ch}.json (median of {len(g['samples'])} depositForBurn txs)"
gb = load("gas_burn_arb")
SRC_GAS["arb"] = 114000 * int(gb["gasPriceWei"]) / 1e18 * px("arb")
SRC_GAS_SRC["arb"] = "114,000 gas (Base/Ethereum depositForBurn median) x eth_gasPrice on Arbitrum (raw/gas_burn_arb.json); no direct sample in window"
st = load("stellar_xebra_burn_tx")
SRC_GAS["stellar"] = int(st["body"]["fee_charged"]) / 1e7 * px("stellar")
SRC_GAS_SRC["stellar"] = "fee_charged of Xebra's mainnet burn 95efc874... (raw/stellar_xebra_burn_tx.json)"

# ---- CCTP timings from Circle docs (finality-and-block-confirmations) ----
STD_ETA = {"base": "15-19 min", "arb": "15-19 min", "eth": "15-19 min", "stellar": "~5 s", "pol": "~8 s"}
FAST_ETA = {"base": "~8 s", "arb": "~8 s", "eth": "~20 s"}

rows = []
def add(pair, size, provider, route, fee, received, cap, eta, source, ts, note=""):
    rows.append(dict(pair=f"{NAMES[pair[0]]} -> {NAMES[pair[1]]}", size=size, provider=provider, route=route,
                     fee_usd=None if fee is None else round(fee, 4),
                     fee_pct=None if fee is None else round(fee / size * 100, 4),
                     received=None if received is None else round(received, 6),
                     cap=cap, eta=eta, source=source, ts=ts, note=note))

fast_allow = load("iris_fastburn_allowance")
allow = fast_allow["body"]["allowance"]

for (s, d) in PAIRS:
    iris = load(f"iris_fees_{DOMAIN[s]}_{DOMAIN[d]}")
    iris_ts = iris["meta"]["fetchedAtUtc"]
    fast_bps = iris["body"][0]["minimumFee"]
    fwd = iris["body"][1]["forwardFee"]["med"] / 1e6 if "forwardFee" in iris["body"][1] else None
    dgas = DEST_GAS.get(d)
    sgas = SRC_GAS.get(s)
    fast_ok = s in FAST_ETA
    for n in SIZES:
        cap_cctp = "10,000,000 per message (on-chain burnLimitsPerMessage); no aggregate cap"
        # CCTP direct
        add((s, d), n, "Circle CCTP V2 direct", "Standard, integrator mints (self-relay)", dgas, n, cap_cctp,
            STD_ETA[s] + " + mint", f"raw/iris_fees_{DOMAIN[s]}_{DOMAIN[d]}.json + {DEST_GAS_SRC[d]}", iris_ts,
            "Fee = destination mint gas only; needs native gas + a signer on the destination")
        if fast_ok:
            add((s, d), n, "Circle CCTP V2 direct", f"Fast ({fast_bps} bps), self-relay", n * fast_bps / 1e4 + dgas, n - n * fast_bps / 1e4,
                f"Fast allowance {allow:,.0f} USDC global at {fast_allow['meta']['fetchedAtUtc']}; above it falls back to Standard",
                FAST_ETA[s] + " + mint", f"raw/iris_fees_{DOMAIN[s]}_{DOMAIN[d]}.json", iris_ts)
        if fwd is not None:
            add((s, d), n, "Circle CCTP V2 direct", "Standard + Circle Forwarding Service", fwd, n - fwd, cap_cctp,
                STD_ETA[s] + " + forward", f"raw/iris_fees_{DOMAIN[s]}_{DOMAIN[d]}.json (forwardFee.med)", iris_ts,
                "No destination gas or signer needed")
            if fast_ok:
                add((s, d), n, "Circle CCTP V2 direct", "Fast + Circle Forwarding Service", n * fast_bps / 1e4 + fwd, n - n * fast_bps / 1e4 - fwd,
                    "Fast allowance (global)", FAST_ETA[s] + " + forward", f"raw/iris_fees_{DOMAIN[s]}_{DOMAIN[d]}.json", iris_ts)
        # Xebra proposed tiers (Standard finality, CCTP leg)
        if dgas is not None:
            add((s, d), n, "Xebra (proposed)", "T1 0.05 flat, user claims", 0.05 + dgas, n - 0.05,
                "proposed: none below Circle's 10M/message", STD_ETA[s] + " + user claim", "computed: 0.05 + measured dest gas", iris_ts,
                "User still pays destination gas")
            add((s, d), n, "Xebra (proposed)", "T2 0.10 + dest gas, Xebra delivers", 0.10 + dgas, n - 0.10 - dgas,
                "proposed", STD_ETA[s] + " + delivery", "computed: 0.10 + measured dest gas", iris_ts)
            add((s, d), n, "Xebra (proposed)", "T3 0.15 + gas both ends, gasless", 0.15 + dgas + sgas, n - 0.15 - dgas - sgas,
                "proposed", STD_ETA[s] + " + delivery", f"computed: 0.15 + dest gas + source gas ({SRC_GAS_SRC[s]})", iris_ts)
        if fwd is not None:
            add((s, d), n, "Xebra (proposed)", "T2 delivered via Circle Forwarding (how Xebra delivers today)", 0.10 + fwd, n - 0.10 - fwd,
                "proposed", STD_ETA[s] + " + forward", "computed: 0.10 + Iris forwardFee.med", iris_ts)
            add((s, d), n, "Xebra (proposed)", "T3 via Circle Forwarding + source gas", 0.15 + fwd + sgas, n - 0.15 - fwd - sgas,
                "proposed", STD_ETA[s] + " + forward", "computed: 0.15 + Iris forwardFee.med + source gas", iris_ts)
        # Xebra live
        xq = load(f"xebra_quote_{s}_{d}_{n}") if (s, d) == ("stellar", "base") else None
        if xq:
            b = xq["body"]
            if xq["meta"]["httpStatus"] == 200:
                add((s, d), n, "Xebra (live today)", "0.10%, min 0.30", float(b["fees"]["total"]), float(b["recipientGets"]),
                    f"max {b['maximum']} USDC per transfer", "~36 s measured burn-to-wallet (2026-11-12)", f"raw/xebra_quote_{s}_{d}_{n}.json", xq["meta"]["fetchedAtUtc"])
            else:
                add((s, d), n, "Xebra (live today)", "0.10%, min 0.30", None, None, b.get("detail"), "-", f"raw/xebra_quote_{s}_{d}_{n}.json", xq["meta"]["fetchedAtUtc"], "REFUSED: above cap")
        elif (s, d) == ("stellar", "base") and n > 100:
            add((s, d), n, "Xebra (live today)", "0.10%, min 0.30", None, None, "max 100 USDC per transfer", "-", "raw/xebra_quote_stellar_base_1000.json (422)", "", "REFUSED: above cap")

        # Aggregators
        a = load(f"across_{s}_{d}_{n}")
        if a:
            b = a["body"]
            if a["meta"]["httpStatus"] == 200:
                out = int(b["outputAmount"]) / 1e6
                lim = b["limits"]
                add((s, d), n, "Across", "suggested-fees", n - out, out,
                    f"max {int(lim['maxDeposit'])/1e6:,.0f}; instant max {int(lim['maxDepositInstant'])/1e6:,.0f}", f"{b['estimatedFillTimeSec']} s",
                    f"raw/across_{s}_{d}_{n}.json", a["meta"]["fetchedAtUtc"])
            else:
                add((s, d), n, "Across", "-", None, None, b.get("message"), "-", f"raw/across_{s}_{d}_{n}.json", a["meta"]["fetchedAtUtc"], "NO ROUTE")
        elif s not in ("stellar",):
            pass
        r = load(f"relay_{s}_{d}_{n}")
        if r:
            b = r["body"]
            if r["meta"]["httpStatus"] == 200:
                out = float(b["details"]["currencyOut"]["amountFormatted"])
                add((s, d), n, "Relay", "quote", n - out, out, "see 5M probe", f"{b['details']['timeEstimate']} s",
                    f"raw/relay_{s}_{d}_{n}.json", r["meta"]["fetchedAtUtc"], "excl. source gas")
            else:
                add((s, d), n, "Relay", "-", None, None, b.get("message"), "-", f"raw/relay_{s}_{d}_{n}.json", r["meta"]["fetchedAtUtc"], "ERROR")
        l = load(f"lifi_{s}_{d}_{n}")
        if l:
            b = l["body"]
            if l["meta"]["httpStatus"] == 200:
                out = int(b["estimate"]["toAmount"]) / 1e6
                extra = sum(float(c["amountUSD"]) for c in b["estimate"].get("feeCosts", []) if not c.get("included"))
                add((s, d), n, "LI.FI", b["toolDetails"]["name"], n - out + extra, out, "-", f"{b['estimate']['executionDuration']} s",
                    f"raw/lifi_{s}_{d}_{n}.json", l["meta"]["fetchedAtUtc"], "includes LI.FI 0.25% fixed fee (keyless API default)")
            else:
                add((s, d), n, "LI.FI", "-", None, None, str(b)[:80], "-", f"raw/lifi_{s}_{d}_{n}.json", l["meta"]["fetchedAtUtc"], "ERROR")
        db = load(f"debridge_{s}_{d}_{n}")
        if db:
            b = db["body"]
            if db["meta"]["httpStatus"] == 200:
                e = b["estimation"]
                paid = int(e["srcChainTokenIn"]["amount"]) / 1e6
                out = int(e["dstChainTokenOut"]["recommendedAmount"]) / 1e6
                fix = int(b["fixFee"]) / 1e18 * px(s)
                add((s, d), n, "deBridge DLN", "quote", paid - out + fix, out, "-", f"{b['order']['approximateFulfillmentDelay']} s",
                    f"raw/debridge_{s}_{d}_{n}.json", db["meta"]["fetchedAtUtc"], f"user sends {paid:,.6f} (opex prepended) + fixFee {int(b['fixFee'])/1e18:g} native (${fix:.2f})")
        m = load(f"mayan_{s}_{d}_{n}")
        if m and m["meta"]["httpStatus"] == 200 and m["body"].get("quotes"):
            for q in m["body"]["quotes"]:
                out = q["expectedAmountOut"]
                add((s, d), n, "Mayan", q["type"], n - out, out, "-", f"{q['etaSeconds']} s", f"raw/mayan_{s}_{d}_{n}.json", m["meta"]["fetchedAtUtc"])
        o = load(f"oneclick_{s}_{d}_{n}")
        if o:
            b = o["body"]
            if o["meta"]["httpStatus"] in (200, 201):
                out = int(b["quote"]["amountOut"]) / 1e6
                add((s, d), n, "NEAR Intents 1Click", "dry quote, no JWT", n - out, out, "1M base->arb: 'No liquidity available'", f"{b['quote']['timeEstimate']} s",
                    f"raw/oneclick_{s}_{d}_{n}.json", o["meta"]["fetchedAtUtc"])
            else:
                add((s, d), n, "NEAR Intents 1Click", "-", None, None, b.get("message"), "-", f"raw/oneclick_{s}_{d}_{n}.json", o["meta"]["fetchedAtUtc"], "REFUSED: " + str(b.get("message")))

with open(BASE + "/quotes.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)
with open(BASE + "/quotes.json", "w") as f:
    json.dump({"prices": prices, "destGasUsd": DEST_GAS, "destGasSource": DEST_GAS_SRC, "srcGasUsd": SRC_GAS, "srcGasSource": SRC_GAS_SRC, "solanaWithAtaUsd": SOL_WITH_ATA, "rows": rows}, f, indent=1)

def fmt(r):
    if r["fee_usd"] is None:
        return "n/a"
    return f"${r['fee_usd']:,.2f} ({r['fee_pct']:.3f}%)" if r["fee_usd"] >= 0.01 else f"${r['fee_usd']:,.4f} ({r['fee_pct']:.4f}%)"

mode = sys.argv[1] if len(sys.argv) > 1 else "matrix"
for (s, d) in PAIRS:
    pn = f"{NAMES[s]} -> {NAMES[d]}"
    pr = [r for r in rows if r["pair"] == pn]
    keys = []
    for r in pr:
        k = (r["provider"], r["route"])
        if k not in keys and not (r["route"] == "-" and any(x["provider"] == r["provider"] and x["route"] != "-" for x in pr)):
            keys.append(k)
    if mode == "matrix":
        print(f"\n#### {pn}\n")
        print("| Provider | Route | " + " | ".join(f"{n:,}" for n in SIZES) + " |")
        print("|" + "---|" * (2 + len(SIZES)))
        for k in keys:
            cells = []
            for n in SIZES:
                rr = [r for r in pr if (r["provider"], r["route"]) == k and r["size"] == n]
                if not rr:
                    rr = [r for r in pr if r["provider"] == k[0] and r["size"] == n and r["route"] == "-"]
                cells.append(fmt(rr[0]) if rr else "-")
                if rr and rr[0]["fee_usd"] is None:
                    cells[-1] = "refused" if "REFUSED" in rr[0]["note"] else "no route"
            print(f"| {k[0]} | {k[1]} | " + " | ".join(cells) + " |")
    else:
        print(f"\n<details><summary>{pn}: every row</summary>\n")
        print("| Size | Provider | Route | Fee USD | Fee % | Received | Cap / limit | ETA | Source | Fetched (UTC) | Note |")
        print("|---|---|---|---|---|---|---|---|---|---|---|")
        for r in pr:
            print(f"| {r['size']:,} | {r['provider']} | {r['route']} | {'' if r['fee_usd'] is None else r['fee_usd']} | {'' if r['fee_pct'] is None else r['fee_pct']} | {'' if r['received'] is None else r['received']} | {r['cap']} | {r['eta']} | `{r['source']}` | {r['ts']} | {r['note']} |")
        print("\n</details>")
print("\nDEST_GAS", json.dumps(DEST_GAS), "\nSRC_GAS", json.dumps(SRC_GAS), "\nSOL_ATA", SOL_WITH_ATA, file=sys.stderr)
