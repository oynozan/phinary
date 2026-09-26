/** Keep provider error codes actionable without exposing RPC URLs or request data. */
export function walletConnectionError(error: unknown): string {
    let code: number | undefined;
    for (let current = error, depth = 0; current && depth < 8; depth++) {
        if (typeof current !== 'object') break;
        const entry = current as { code?: unknown; cause?: unknown };
        if (typeof entry.code === 'number' && Number.isInteger(entry.code)) {
            code = entry.code;
            if ([4001, -32002, 4100, 4900, 4901, -32603].includes(code)) break;
        }
        current = entry.cause;
    }
    switch (code) {
        case 4001: return 'Connection cancelled';
        case -32002: return 'A connection request is already pending. Open your wallet extension and approve or cancel that request, then try again.';
        case 4100: return 'Wallet access is not authorized. Open your wallet extension, allow this site to connect, then try again.';
        case 4900:
        case 4901: return 'Your wallet is disconnected from its network. Open the extension, check its network connection, then try again.';
        case -32603: return 'Your wallet reported an internal error (-32603). Open the extension, unlock it if needed, then reload this page and try again.';
        default: return `Could not connect wallet${code === undefined ? '' : ` (error ${code})`}. Open the wallet extension, unlock it if needed, then try again.`;
    }
}
