/// <reference types="vite/client" />

declare const __DEPLOYMENT__: Record<string, unknown>

interface ImportMetaEnv {
  readonly VITE_RPC_URL?: string
  readonly VITE_PREDICTION_HOOK?: string
  readonly VITE_CHAIN_ID?: string
  readonly VITE_DEV_TOOLS?: string
}
