# QA Log

**Log refreshed:** 2026-03-28 — reconciled open items with current code (Blockscout/RPC resilience, obsolete findings).

---

## Status Update (Latest)

### 2026-06-02 — Review (last 24h working tree)
- **High:** USDRIF mintable can return Not Available if any of the six getter calls fail (single Promise.all). Consider per-call fallbacks or at least return `getTPAvailableToMint` when hand-rolled inputs fail.
- **Medium:** Tooltip positioning uses fixed width (400px) but CSS caps width for small screens; wide tooltips can be mis-centered/offscreen on narrow viewports.
- **Medium:** `jsdom`/`vitest` bumps introduce Node engine `>=20.19.0` via transitive deps; Vercel/CI may fail if pinned to older Node 20.
- **Test gap:** No tests run for this review.
  - **Note:** Findings copied to the agent log at `/Users/tobybox/dev/agent_logs/usdriftracker_QA_cursor_codex-5.2_log.md` to comply with agent-context rules.

### Resolved
- `history.ts`: type safety fix, quota handling, SSR guard, JSON validation
- `MiniLineGraph.tsx`: y-offset fix, `useId` for gradients, placeholder state, min/max optimization
- `App.tsx`: history key constants (`METRIC_KEYS`), BigInt mintable math, 0n handling, removed `MOC_STATE_ABI` usage
- `vite.config.ts`: vitest config typing issue resolved
- `vercel.json`: SPA rewrite verified
- **Refactor Set – Fixes verified (2026-01-24):** RIF collateral unit now `RIF` (MetricsPage); useTokenData uses `ROOTSTOCK_RPC` first; progress timeout cleanup in MintRedeemAnalyser/VaultDepositWithdrawAnalyser; Blockscout v2 uses **client-side** block range filtering only (see Refactor Set below); MintRedeem MoC 50‑tx cap removed; BTC vault uses rpcCall with testnet RPC (proxy whitelist updated)
- **Vercel / `tsc` build (2026-03):** `@types/react` and `@types/react-dom` live in **`dependencies`** in `package.json` so production installs include JSX typings when Vercel runs `npm install` without devDependencies. Verified locally: `npm run build` (`tsc && vite build`) passes.
- **Resilience / errors (2026-03, plan item 4):** `src/utils/asyncRetry.ts` (backoff, transient HTTP/network); `fetchLogsV1` retries 502/503/504/408/429; `fetchLogsV2` per-page backoff; `rpcCall` retries transient failures per endpoint; `getWorkingProvider` uses backoff; vault **gettxinfo** uses backoff; `userFacingError` / `withNetworkHint` for metrics + analysers + BTC vault error UI.
- **Mint/Redeem modularization (2026-03):** `src/mintRedeem/` — `types.ts`, `constants.ts`, `fetchMintRedeemTransactions.ts` (pure pipeline + progress callback); `MintRedeemAnalyser.tsx` is UI + Excel + shell only. **Unit tests:** `src/mintRedeem/fetchMintRedeemTransactions.test.ts` (empty run + one USDRIF Mint); logged in `coder_log.md` (2026-03-26 recap).
- **vUSD Vault modularization (2026-03-26):** `src/vaultDepositWithdraw/` — same pattern (pure `fetchVaultDepositWithdrawTransactions` + thin `VaultDepositWithdrawAnalyser`). **Tests:** `src/vaultDepositWithdraw/fetchVaultDepositWithdrawTransactions.test.ts`. Summary: `coder_log.md` (**vUSD Vault extraction — implemented**).
- **Full retest (2026-03-27):** `npm test` passed (28/28); `npm run build` succeeded (`tsc && vite build`). Added `src/hooks/useTokenData.test.ts`, `src/api/blockscout.test.ts`.
- **Full retest (2026-04-08):** `npm test -- --run` passed (28/28); `npm run build` succeeded (`tsc && vite build`). No new failures observed.
- **MintRedeem / Blockscout QA follow-ups (2026-03-28):**
  - ~~**Duplicate `isDev` in `makeRpcCall` loop**~~ **Obsoleted** — that pattern is not present in the current tree (no `makeRpcCall`; `isDev` only where needed in `useTokenData`, `rpc.ts`, `logger.ts`).
  - ~~**Blockscout “no adaptive backoff”**~~ **Mitigated** — `src/api/blockscout.ts` uses a shared **`BlockscoutRateLimiter`** (throttle + adaptive delay on failures) plus **`withBackoff`** on v2 page fetches and expanded v1 retries for transient HTTP. **Remaining risk:** huge log volumes and **`MAX_PAGES` (100)** truncation on v2; reduce lookback or paginate further if needed.
  - ~~**Silent Blockscout v1 failures**~~ **Mitigated** — `fetchLogsV1` **throws** with message when `status !== '1'`, except recognised “no logs” responses (empty array). Failures surface in analysers via existing error UI / `userFacingError`. **v2:** HTTP errors throw; empty `items` ends pagination normally.

### Open (Recommendations)
- Accessibility improvements (ARIA labels, keyboard hints)
- Skeleton loaders
- Add error tracking (e.g. Sentry) for production
- E2E tests
- Env var validation (startup checks / documented required `VITE_*` and server env)
- Consider websocket updates for live metrics (optional)
- **Optional:** extend retry/backoff to **other** third-party calls not yet covered (e.g. ad-hoc `fetch` outside Blockscout/RPC helpers) if new features add them

### Refactor Set Review (Latest)
- ~~**`useTokenData` ignores custom RPC env**~~ **Fixed**
  - ~~`getWorkingProvider` only uses `ROOTSTOCK_RPC_ALTERNATIVES`~~ Now uses `[CONFIG.ROOTSTOCK_RPC, ...(ROOTSTOCK_RPC_ALTERNATIVES || [])]` so `VITE_ROOTSTOCK_RPC` is tried first.
- ~~**Blockscout v2 block range**~~ **Mitigated** (2026-03)
  - **Rootstock** Blockscout returns **422** if `filter[from_block]` / `filter[to_block]` are sent on `/api/v2/addresses/{addr}/logs`. Those query params are **not** used.
  - **`src/api/blockscout.ts` `fetchLogsV2`:** Paginates with `block_number` / `index` / `items_count` from `next_page_params`; enforces range by **client-side** `block_number` filter (`fromBlock`–`toBlock`). Console warning when `MAX_PAGES` (100) reached.
- ~~**Mint/Redeem MoC enrichment capped to 50 tx hashes**~~ **Fixed**
  - Cap removed; all unique tx hashes are now queried for MoC event enrichment.
- ~~**Potential setState after unmount**~~ **Fixed**
  - MintRedeemAnalyser and VaultDepositWithdrawAnalyser now use `progressTimeoutRef` and clear timeout on unmount.
- ~~**Unit mismatch for RIF collateral display**~~ **Fixed**
  - RIF Collateral Backing USDRIF now uses `unit="RIF"` (was RIFPRO).
- ~~**BTC vault analyser uses direct RPC in browser**~~ **Fixed**
  - `BTCVaultAnalyser` now uses `rpcCall('eth_blockNumber', [], CONFIG.RSK_TESTNET_RPC)`. Testnet RPC added to api/rpc whitelist; requests go through proxy in production.

### Tests — `ethers.id` mock (**resolved**)
- **`App.test.tsx`** extends the `ethers` mock with `id` so lazy-loaded `Analytics` → `BTCVaultAnalyser` does not throw `TypeError: ethers.id is not a function`.

### Code Review (2026-01-28)
- **High:** `api/rpc.ts` forwards any JSON-RPC method to whitelisted endpoints without a method allowlist; combined with 100 req/min/IP this still permits heavy abuse on public nodes.
- **High (conditional):** `api/security.ts` + CORS headers: if `ALLOWED_ORIGINS` is unset, cross-origin API calls fail; `Access-Control-Allow-Headers` does not include `X-Client-Version`, which can break cross-origin preflights for `/api/rpc` and `/api/analytics`.
- **Medium:** `middleware.ts` hard-fails `/api/rpc` when `x-client-version` is missing/mismatched; non-browser scripts/monitors without the header receive 410.
- **Medium:** `src/vaultDepositWithdraw/fetchVaultDepositWithdrawTransactions.ts` caps tx-status lookups at 100; remaining txs default to `Success`, skewing accuracy.
- **Medium:** `src/api/blockscout.ts` v2 pagination hard-caps at `MAX_PAGES = 100` with warning only; busy contracts can be truncated.
- **Medium:** `api/export-excel.ts` accepts arbitrary transaction payload size; large requests can cause high memory/CPU and slow responses (and route appears unused in `src/`).
- **Medium:** `api/analytics.ts` falls back to `projects[0]` if `VERCEL_PROJECT_ID` missing; may return metrics for wrong project.
- **Medium:** `src/vaultDepositWithdraw/fetchVaultDepositWithdrawTransactions.ts` (explorer fetch) has no timeout; slow Blockscout can stall the pipeline.
- **Medium:** `api/scores.ts` logs player-submitted names and metadata; consider privacy/log hygiene in production.
- **Low:** `tsconfig.json` excludes `src/**/*.test.ts(x)` from `tsc` so CI builds won’t typecheck tests unless vitest runs.
- **Low:** Hard-coded external Giphy URL in `src/pages/MetricsPage.tsx` adds a third-party dependency/privacy risk.
- **Note:** No new tests were run for this review (static analysis only).

### ~~BTC Vault UI Findings (2026-01-28)~~ — **Addressed (2026-03-27)**
- ~~**Amount (RBTC) always `0`**~~ **`BTCVaultAnalyser`:** `buildParamMap` merges Blockscout `decoded.parameters` with **`ethers.Interface.parseLog`** (`BTC_VAULT_ABI`); **`pickUint`** tries **`amount` → `assets` → `value`**.
- ~~**User column empty/incorrect**~~ **`pickAddr`** chain **`user` → `owner` → `account` → `caller` → `sender`**, then **`receiver`** as last resort; empty user shows **`—`** (no broken explorer link).
- ~~**Missing shares column**~~ Table **Shares** column (18 decimals, same display style as amount); Excel column order aligned (**Amount**, **Shares**, **USD Equiv.**, User, Receiver, …).
- *Earlier QA note “Vitest failing due to missing `ethers.id`” — **closed**; `App.test.tsx` mock.*

### Ongoing — maintainers / ops
- **RPC proxy whitelist (`api/rpc.ts` ↔ env)**  
  - Production browser calls use `/api/rpc?target=...`; **`ALLOWED_RPC_ENDPOINTS`** must include every URL you pass from **`config.ts`** / **`VITE_ROOTSTOCK_RPC`** / **`ROOTSTOCK_RPC_ALTERNATIVES`**.  
  - Current whitelist (verify in repo):  
    `https://public-node.rsk.co`, `https://rsk.publicnode.com`, `https://public-node.testnet.rsk.co`  
  - **Symptom if misaligned:** non-whitelisted target → **400** from `/api/rpc` in production.  
  - **Action:** When adding a new RPC host, update **`ALLOWED_RPC_ENDPOINTS`** and defaults/docs together.

### ~~New Issue (Vercel Build)~~ — **Resolved**
- **Was:** `tsc` on Vercel could miss JSX types if `@types/react*` sat only in `devDependencies`.
- **Now:** **`package.json`** → `dependencies` includes `@types/react` and `@types/react-dom` (keep them there; do not move back to `devDependencies` unless you also change install policy). Alternatives if policy changes: `VERCEL_USE_NODE_ENV=development` or `npm install --include=dev`.

---

## Code Review Summary - USDRIF Tracker (Resolved Items)

- useEffect dependency warning (fixed)
- async state update after unmount (fixed)
- refresh interval text hardcoded (fixed)
- missing error boundary (fixed)
- formatAmount edge cases (fixed)
- NaN handling in display (fixed)
- test suite added (vitest + RTL)

---

## Complete Code Review - USDRIF Tracker (Resolved Items)

- Unused `MOC_STATE_ABI` (resolved)
- Missing maxMintable implementation (resolved)
- Repeated address checksumming (resolved)
- Tests out of date (resolved)
- Unused config values (resolved)

---

## Vercel Deployment Review (Resolved Items)

- localStorage SSR safety (guarded access)
- git commit hash uses Vercel env when available
- history data validation improvements
- `vercel.json` SPA rewrites verified
