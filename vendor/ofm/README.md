# Vendored OFM wire layer

These files are copied from
[`dsh-our-free-model`](https://github.com/Ebony-Vinyl/dsh-our-free-model), not
maintained here. The action vendors the dependency closure it needs so it can
run from any repository without a second checkout or an npm install.

| File | Why it is here |
| --- | --- |
| `o2a.js` | Generated request-shaping bundle (official prompt, tool contracts, session identity, headers). |
| `upstream.js` | Public shaping API, endpoint selection, conversation session map. |
| `http.js` | Free-lane POST/GET transport and failure classification. |
| `kilo.js` | Kilo free-pool listing and streaming POST. |
| `stream.js` | SSE-to-chunks projection for chat/messages/responses wires. |
| `egress.js` | Direct/relay/proxy routing and the Bun requirement for OpenCode POSTs. |
| `bun-fetch.js` | Bun executable discovery and the Bun fetch bridge. |
| `store.js` | `$DSH_HOME` resolution and the session-map store. |
| `open-external.js` | Private-file permission helper used by `store.js` and `egress.js`. |

`PROVENANCE.json` records the exact upstream version and commit. The action
calls `src/o2a.js`; upstream generates that file from `src/o2a/`. **Do not
hand-edit `o2a.js`**: the gateway compares the official prompt and the 13 tool
definitions byte-for-byte and answers a mismatch with `429 FreeUsageLimitError`.

## Updating

From a checkout that has `dsh-our-free-model` next to this directory:

```bash
node scripts/sync-vendor.mjs
node scripts/sync-vendor.mjs --check
```

The sync script verifies that every relative import in the closure resolves to
another vendored file. If upstream adds a new dependency, the sync fails
instead of shipping a `MODULE_NOT_FOUND` at the first call.

## License

MIT, Copyright (c) 2026 Ebony-Vinyl. See the repository root `LICENSE`.
