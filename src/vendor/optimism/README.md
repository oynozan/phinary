# Vendored Optimism libraries

Merkle-Patricia trie and RLP libraries from Optimism's contracts-bedrock, used by `src/oracle/PoolStateProof.sol` to verify
Unichain account and storage proofs.

- Source: https://github.com/ethereum-optimism/optimism
- Tag: `op-contracts/v8.0.0`
- Commit: `f45a5ccfebcdf6da3f5b09cbc512667c063730b7`
- License: MIT (full text below)

| File | Upstream path | Upstream sha256 |
|---|---|---|
| `RLPReader.sol` | `packages/contracts-bedrock/src/libraries/rlp/RLPReader.sol` | `78b6bab28e975e14923202a9ac63a376a63e4f012c101a8f066891fc53074ca6` |
| `RLPErrors.sol` | `packages/contracts-bedrock/src/libraries/rlp/RLPErrors.sol` | `c775036bad8a0e00beeeae9fd20c733dcfdc2ddc57464d70299cb5c148aeec60` |
| `MerkleTrie.sol` | `packages/contracts-bedrock/src/libraries/trie/MerkleTrie.sol` | `9ce13ec201485c87989df0ec89407dde9da8d95d54baf3c4d68fbfeb9d421b0a` |
| `SecureMerkleTrie.sol` | `packages/contracts-bedrock/src/libraries/trie/SecureMerkleTrie.sol` | `755f79cb43e84d30dec6f1f535809bd4d18594c5d9bedf7407fdc6d374489980` |
| `Bytes.sol` | `packages/contracts-bedrock/src/libraries/Bytes.sol` | `235a1dcaf00fb7eeb2033033fdca135790c7415054aeb8303e5e070baca6e879` |

The only change is the import paths, rewritten from `src/libraries/...` to the flat `./<File>.sol` layout. Pragmas are
untouched. `RLPErrors.sol` is included because `RLPReader.sol` imports its errors.

To check a file, download it from
`https://raw.githubusercontent.com/ethereum-optimism/optimism/f45a5ccfebcdf6da3f5b09cbc512667c063730b7/<upstream path>`,
apply the same import rewrite, and diff.

## License

```
(The MIT License)

Copyright 2020-2025 Optimism

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
