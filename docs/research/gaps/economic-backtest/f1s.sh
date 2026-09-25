for m in 06 07 08; do f=ETHUSDT-1s-2026-$m.zip; [ -f s1/$f ] || curl -sf -o s1/$f https://data.binance.vision/data/spot/monthly/klines/ETHUSDT/1s/$f || echo miss $f; done
for d in $(seq -w 1 24); do f=ETHUSDT-1s-2026-09-$d.zip; [ -f s1/$f ] || curl -sf -o s1/$f https://data.binance.vision/data/spot/daily/klines/ETHUSDT/1s/$f || echo miss $f; done
echo done
