FROM node:24-bookworm-slim AS build
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY packages/swap-sdk/package*.json ./packages/swap-sdk/
RUN cd packages/swap-sdk && npm ci --omit=dev
COPY packages/swap-sdk/src ./packages/swap-sdk/src
COPY web/package*.json ./web/
RUN cd web && npm ci --install-links
COPY deployments/unichain-sepolia.json ./deployments/unichain-sepolia.json
COPY web ./web
ARG NEXT_PUBLIC_PRIVY_APP_ID
ARG NEXT_PUBLIC_PRIVY_CLIENT_ID
ARG NEXT_PUBLIC_PHINARY_RPC_URL
WORKDIR /app/web
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
WORKDIR /app/web
EXPOSE 3000
CMD ["sh", "-c", "exec node node_modules/next/dist/bin/next start --hostname :: --port \"${PORT:-3000}\""]
