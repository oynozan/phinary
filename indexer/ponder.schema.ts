import { onchainTable } from 'ponder'

export const market = onchainTable('market', (t) => ({
  id: t.bigint().primaryKey(),
  up: t.hex().notNull(),
  down: t.hex().notNull(),
  upPoolId: t.hex().notNull(),
  downPoolId: t.hex().notNull(),
  lnStrikeWad: t.bigint().notNull(),
  openTime: t.integer().notNull(),
  expiry: t.integer().notNull(),
  window: t.integer().notNull(),
  cutoffBuffer: t.integer().notNull(),
  status: t.text({ enum: ['trading', 'settled', 'invalid'] }).notNull(),
  upWon: t.boolean(),
  avgNormTickTimesWindow: t.bigint(),
  settleTx: t.hex(),
  volumeUsdc: t.bigint().notNull(),
  tradeCount: t.integer().notNull(),
  createdAt: t.integer().notNull(),
}))

export const trade = onchainTable('trade', (t) => ({
  id: t.text().primaryKey(),
  marketId: t.bigint().notNull(),
  account: t.hex().notNull(),
  side: t.text({ enum: ['UP', 'DOWN'] }).notNull(),
  isBuy: t.boolean().notNull(),
  qty: t.bigint().notNull(),
  usdc: t.bigint().notNull(),
  avgPriceWad: t.bigint().notNull(),
  timestamp: t.integer().notNull(),
  txHash: t.hex().notNull(),
  attributedBy: t.text({ enum: ['transfer', 'txFrom'] }).notNull(),
}))

export const position = onchainTable('position', (t) => ({
  id: t.text().primaryKey(),
  account: t.hex().notNull(),
  marketId: t.bigint().notNull(),
  side: t.text({ enum: ['UP', 'DOWN'] }).notNull(),
  origin: t.text({ enum: ['trade', 'received'] }).notNull(),
  qty: t.bigint().notNull(),
  cost: t.bigint().notNull(),
  realized: t.bigint().notNull(),
}))

export const transfer = onchainTable('transfer', (t) => ({
  id: t.text().primaryKey(),
  token: t.hex().notNull(),
  marketId: t.bigint().notNull(),
  side: t.text({ enum: ['UP', 'DOWN'] }).notNull(),
  from: t.hex().notNull(),
  to: t.hex().notNull(),
  amount: t.bigint().notNull(),
  kind: t.text({ enum: ['redeem', 'peer'] }).notNull(),
  timestamp: t.integer().notNull(),
  txHash: t.hex().notNull(),
}))

export const priceSnapshot = onchainTable('price_snapshot', (t) => ({
  id: t.text().primaryKey(),
  marketId: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  timestamp: t.integer().notNull(),
  midUp: t.bigint().notNull(),
  askUp: t.bigint().notNull(),
  bidUp: t.bigint().notNull(),
  ethLnWad: t.bigint().notNull(),
  varE36: t.bigint().notNull(),
  tau: t.bigint().notNull(),
}))

export const vaultSnapshot = onchainTable('vault_snapshot', (t) => ({
  blockNumber: t.bigint().primaryKey(),
  timestamp: t.integer().notNull(),
  navPlus: t.bigint().notNull(),
  navMinus: t.bigint().notNull(),
  totalShares: t.bigint().notNull(),
  idle: t.bigint().notNull(),
}))

export const vaultEvent = onchainTable('vault_event', (t) => ({
  id: t.text().primaryKey(),
  account: t.hex().notNull(),
  kind: t.text({ enum: ['deposit', 'withdraw'] }).notNull(),
  assets: t.bigint().notNull(),
  shares: t.bigint().notNull(),
  timestamp: t.integer().notNull(),
  txHash: t.hex().notNull(),
}))

export const accountStats = onchainTable('account_stats', (t) => ({
  account: t.hex().primaryKey(),
  volumeUsdc: t.bigint().notNull(),
  realizedTrade: t.bigint().notNull(),
  marketsTraded: t.integer().notNull(),
}))
