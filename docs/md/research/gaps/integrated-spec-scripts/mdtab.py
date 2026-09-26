import pickle
rows = pickle.load(open('out/select_rows.pkl', 'rb'))
def f(x): return '∞' if x == float('inf') else f'{x:.2f}'
for ch in ('L1', 'L2'):
    print(f'\n**{ch}** — cells: D*_IS / D*_OOS (with latency charge) · OOS edge per series at D = 5 ($) · noise filled per series at D = 8 ($k)\n')
    print('| w | h0 | cutoff (min) | normal, λB 0.1 | normal, λB 0.5 | t, λB 0.1 | t, λB 0.5 |')
    print('|---|---|---|---|---|---|---|')
    keys = sorted({(z['c']['w'], z['c']['h0'], z['cut']) for z in rows if z['c']['chain'] == ch})
    for w, h0, cut in keys:
        cells = []
        for k in ('normal', 't'):
            for lam in (0.1, 0.5):
                zz = [z for z in rows if z['c']['chain'] == ch and z['c']['w'] == w and z['c']['h0'] == h0 and z['cut'] == cut and z['c']['kernel'] == k and z['c']['lam_block'] == lam]
                if zz: z = zz[0]; cells.append(f"{f(z['D_IS'])} / {f(z['D_OOS'])} · {z['e5_OOS']:+,.0f} · {z['fill8']/1e3:,.0f}")
                else: cells.append('—')
        print(f'| {w} min | {h0*100:.1f}¢ | {cut} | ' + ' | '.join(cells) + ' |')
