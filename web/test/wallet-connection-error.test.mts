import test from 'node:test';
import assert from 'node:assert/strict';
import { walletConnectionError } from '../src/lib/onchain/wallet-connection-error.ts';

test('connection failures distinguish pending approval, rejection and provider faults', () => {
    assert.match(walletConnectionError({ code: -32002 }), /already pending.*approve or cancel/);
    assert.equal(walletConnectionError({ cause: { code: 4001 } }), 'Connection cancelled');
    assert.match(walletConnectionError({ code: 4100 }), /not authorized/);
    for (const code of [4900, 4901]) assert.match(walletConnectionError({ code }), /network/);
    assert.match(walletConnectionError({ code: -32603 }), /internal error \(-32603\)/);
    assert.match(walletConnectionError({ code: 12345 }), /error 12345/);
    for (const error of [null, 'secret RPC URL', { message: 'secret RPC URL' }]) {
        assert.match(walletConnectionError(error), /Could not connect wallet/);
        assert.doesNotMatch(walletConnectionError(error), /secret/);
    }
    const cyclic = { cause: null as unknown }; cyclic.cause = cyclic;
    assert.match(walletConnectionError(cyclic), /Could not connect wallet/);
});
