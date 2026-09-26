# Build, test and demo operations for the PredictionHook stack. `make` lists the targets, docs/md/RUNBOOK.md explains them.
SHELL := /bin/bash
export PATH := $(PATH):$(HOME)/.foundry/bin

NETWORK ?= unichain-sepolia
LOCAL_RPC ?= http://127.0.0.1:8545
REHEARSAL := script/rehearsal
SHELL_SCRIPTS := script/local-env.sh script/local-env-stop.sh script/bots.sh script/sepolia.sh

.DEFAULT_GOAL := help
.PHONY: help build test test-scripts test-all local-env local-stop local-status local-wallet rehearse market-local \
	deploy-sepolia fund-sepolia market-sepolia bots bots-stop bots-status bots-logs vendor-interface backup-app

help: ## List the targets
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN { FS = ":.*## " } { printf "  %-18s %s\n", $$1, $$2 }'
	@echo "  NETWORK=$(NETWORK) (bots, vendor-interface, backup-app), LOCAL_RPC=$(LOCAL_RPC)"

# Build and test

build: ## forge build
	forge build

test: ## forge test, then the script checks (rehearsal unit tests, typecheck, shell syntax)
	forge test
	$(MAKE) test-scripts

test-scripts: $(REHEARSAL)/node_modules ## Rehearsal helper tests and typecheck, shell syntax of script/*.sh
	cd $(REHEARSAL) && npm test && npm run typecheck
	for f in $(SHELL_SCRIPTS); do bash -n $$f || exit 1; done

test-all: test ## test, plus the bot and swap-sdk suites
	cd bot && npm run check
	cd packages/swap-sdk && npm test

$(REHEARSAL)/node_modules: $(REHEARSAL)/package.json $(REHEARSAL)/package-lock.json
	cd $(REHEARSAL) && npm ci --no-audit --no-fund
	@touch $@

# Local anvil fork of Unichain Sepolia

local-env: ## Anvil fork of 1301 on :8545, deploy, fund the vault with 500 USDC, start the bots
	script/local-env.sh

local-stop: ## Stop the local bots and anvil (CLEAN=1 also removes logs and deployments/local.json)
	script/local-env-stop.sh

local-status: ## Local anvil and bot status
	@if [[ -f deployments/.run/local/anvil.pid ]] && kill -0 $$(cat deployments/.run/local/anvil.pid) 2>/dev/null; then \
		echo "anvil running (pid $$(cat deployments/.run/local/anvil.pid)), block $$(cast block-number --rpc-url $(LOCAL_RPC))"; \
	else echo "anvil stopped"; fi
	@script/bots.sh status local

rehearse: $(REHEARSAL)/node_modules ## Scripted Alice/Bob demo through UniversalRouter 2.0 on the local env
	cd $(REHEARSAL) && RPC_URL=$(LOCAL_RPC) node rehearse.ts

local-wallet: ## Set ADDR's balances on the local fork to 10 ETH and USDC (default 100) Circle USDC
	@[[ -n "$(ADDR)" ]] || { echo "usage: make local-wallet ADDR=0x... [USDC=100]"; exit 2; }
	@cast rpc anvil_setBalance $(ADDR) 0x8AC7230489E80000 --rpc-url $(LOCAL_RPC) >/dev/null
	@cast rpc anvil_setStorageAt 0x31d0220469e10c4E71834a79b1f276d740d3768F $$(cast index address $(ADDR) 9) \
		$$(cast to-uint256 $$(awk -v x=$(or $(USDC),100) 'BEGIN { printf "%.0f", x * 1e6 }')) --rpc-url $(LOCAL_RPC) >/dev/null
	@echo "$(ADDR): $$(cast balance $(ADDR) --ether --rpc-url $(LOCAL_RPC)) ETH, \
	$$(cast call 0x31d0220469e10c4E71834a79b1f276d740d3768F 'balanceOf(address)(uint256)' $(ADDR) --rpc-url $(LOCAL_RPC)) USDC units"

market-local: ## One-off market on the local env (CreateMarket.s.sol, MARKET_* and QUOTE_* env)
	NETWORK=local DEPLOYMENTS_FILE= FOUNDRY_BROADCAST=deployments/.run/local/broadcast \
		forge script script/CreateMarket.s.sol:CreateMarket --rpc-url $(LOCAL_RPC) --broadcast

# Unichain Sepolia (real network, every target asks for a typed confirmation and refuses in CI)

deploy-sepolia: ## GUARDED deploy of the full stack to Unichain Sepolia -> deployments/unichain-sepolia.json
	script/sepolia.sh deploy

fund-sepolia: ## GUARDED vault deposit of FUND_USDC (default 20) Circle USDC
	script/sepolia.sh fund

market-sepolia: ## GUARDED one-off market on Unichain Sepolia
	script/sepolia.sh market

# Bots and front ends

bots: ## Start the mirror and keeper in the background for deployments/$(NETWORK).json
	script/bots.sh start $(NETWORK)

bots-stop: ## Stop the bots for $(NETWORK)
	script/bots.sh stop $(NETWORK)

bots-status: ## Bot status and last log lines for $(NETWORK)
	script/bots.sh status $(NETWORK)

bots-logs: ## Follow the bot logs for $(NETWORK)
	script/bots.sh logs $(NETWORK)

vendor-interface: ## Point the Uniswap web-app fork at deployments/$(NETWORK).json
	node packages/swap-sdk/scripts/vendor-interface.mjs --deployment deployments/$(NETWORK).json

backup-app: ## Backup page dev server (app/, http://localhost:5173) for deployments/$(NETWORK).json
	cd app && DEPLOYMENT_FILE=../deployments/$(NETWORK).json \
		$(if $(filter local,$(NETWORK)),VITE_RPC_URL=$(LOCAL_RPC)) npm run dev
