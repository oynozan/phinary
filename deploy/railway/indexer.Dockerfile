FROM node:24-bookworm-slim
WORKDIR /app
COPY packages/swap-sdk/package*.json ./packages/swap-sdk/
RUN cd packages/swap-sdk && npm ci --omit=dev
COPY packages/swap-sdk/src ./packages/swap-sdk/src
COPY indexer/package*.json ./indexer/
COPY indexer/patches ./indexer/patches
RUN cd indexer && npm ci
COPY deployments/unichain-sepolia.json ./deployments/unichain-sepolia.json
COPY indexer ./indexer
COPY deploy/railway/start-indexer.sh ./deploy/railway/start-indexer.sh
RUN chown -R node:node /app
ENV NODE_ENV=production PORT=42069 PONDER_NETWORK=unichain-sepolia
USER node
WORKDIR /app/indexer
EXPOSE 42069
CMD ["sh", "/app/deploy/railway/start-indexer.sh"]
