# Dashboard

Next.js 16 front end for the PredictionHook markets. Data is mocked in `src/lib/mock` behind the hooks in `src/lib/data`.

```bash
npm install
npm run dev     # http://localhost:3100
npm run build
npm run lint
```

Mock wallet start states: append `?wallet=disconnected`, `?wallet=wrong-network` or `?wallet=empty` to any URL.

See [DESIGN.md](DESIGN.md) for the design system.
