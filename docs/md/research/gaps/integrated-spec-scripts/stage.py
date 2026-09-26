"""Parallel runner. usage: python stage.py <name> <kind: bt|lat> <json list of cfg overrides> [Ds json]
Results: out/<name>/<key>.pkl"""
import sys, json, os, pickle, hashlib
from multiprocessing import Pool

def key(c): return hashlib.md5(json.dumps(c, sort_keys=True).encode()).hexdigest()[:10]

def job(args):
    kind, c, Ds, name = args
    fn = f'out/{name}/{key(c)}.pkl'
    if os.path.exists(fn): return fn
    if kind == 'bt':
        import bt2
        r = bt2.run(c, Ds=tuple(Ds))
        r.pop('extra', None)
    else:
        import lat2
        base = dict(chain='L1', w=120, cut='wb', h0=0.01, lam_block=0.1, B_usd=20000.0, Bs=3.0, noise_usd=1000.0)
        cc = dict(base); cc.update(c)
        r = dict(cfg=cc, lat={D: lat2.lat_charge(cc, D) for D in Ds})
    pickle.dump(r, open(fn, 'wb'))
    return fn

if __name__ == '__main__':
    name, kind, cfgs = sys.argv[1], sys.argv[2], json.loads(open(sys.argv[3]).read())
    Ds = json.loads(sys.argv[4]) if len(sys.argv) > 4 else [1.0, 2.0, 3.0, 5.0, 8.0]
    os.makedirs(f'out/{name}', exist_ok=True)
    with Pool(int(os.environ.get('NP', 9))) as p:
        for fn in p.imap_unordered(job, [(kind, c, Ds, name) for c in cfgs]):
            print('done', fn, flush=True)
