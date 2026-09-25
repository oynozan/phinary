for y in 2020 2021 2022 2023 2024 2025 2026; do for m in 01 02 03 04 05 06 07 08 09 10 11 12; do
 f=ETHUSDT-1m-$y-$m.zip; [ -f $f ] && continue
 [ "$y$m" \> "202608" ] && continue
 curl -sf -o $f https://data.binance.vision/data/spot/monthly/klines/ETHUSDT/1m/$f || echo miss $f
done; done
for d in $(seq -w 1 24); do f=ETHUSDT-1m-2026-09-$d.zip; [ -f $f ] || curl -sf -o $f https://data.binance.vision/data/spot/daily/klines/ETHUSDT/1m/$f || echo miss $f; done
