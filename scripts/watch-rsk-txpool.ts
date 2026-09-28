/**
 * Live Rootstock mempool watcher — compact graphical one-line-per-tx view.
 *
 *   npm run watch:txpool
 *   npm run watch:txpool -- --interval 3
 *   npm run watch:txpool -- --no-enrich   # skip on-chain symbol/decimals
 *
 * For the browser dashboard (mempool + Blockscout WS), use: npm run dashboard:live
 */

import { fetchRbtcUsdPrice } from '../src/btcVault/price.ts'
import { fetchTxpoolSnapshot, listAllTxs } from './txpool-poll.ts'
import {
  type DecodeOptions,
  prefetchTokenMeta,
  summarizeTx,
  formatTxOneLine,
  renderBanner,
  CumulativeContractTracker,
  renderContractLeaderboard,
  ansi,
  shortHash,
} from './watch-rsk-txpool-decode.ts'

const DEFAULT_RPC = 'https://public-node.rsk.co'

function parseArgs(argv: string[]) {
  let rpc = process.env.VITE_ROOTSTOCK_RPC || process.env.ROOTSTOCK_RPC || DEFAULT_RPC
  let intervalSec = 5
  let once = false
  let enrichTokens = true
  let clearScreen = true

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--once') once = true
    else if (arg === '--no-enrich') enrichTokens = false
    else if (arg === '--no-clear') clearScreen = false
    else if (arg === '--rpc' && argv[i + 1]) rpc = argv[++i]
    else if (arg === '--interval' && argv[i + 1]) {
      intervalSec = Math.max(1, parseInt(argv[++i], 10) || 5)
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: npm run watch:txpool -- [options]

  --interval <sec>   Poll interval (default: 5)
  --rpc <url>        Rootstock HTTP RPC
  --once             One refresh, then exit
  --no-enrich        Do not eth_call token symbol/decimals
  --no-clear         Do not clear screen between refreshes

Browser dashboard (mempool + Blockscout): npm run dashboard:live
`)
      process.exit(0)
    }
  }

  return { rpc, intervalSec, once, enrichTokens, clearScreen }
}

async function renderTick(
  rpc: string,
  enrichTokens: boolean,
  clearScreen: boolean,
  prevHashes: Set<string> | null,
  data: Awaited<ReturnType<typeof fetchTxpoolSnapshot>>,
  showNewOnly: boolean,
  contractTracker: CumulativeContractTracker
) {
  const pendingTxs = listAllTxs(data.content, 'pending')
  const queuedTxs = listAllTxs(data.content, 'queued')
  const allTxs = [...pendingTxs, ...queuedTxs]

  const [rbtcUsd, tokenMeta] = await Promise.all([
    fetchRbtcUsdPrice(),
    enrichTokens && rpc ? prefetchTokenMeta(rpc, allTxs) : Promise.resolve(undefined),
  ])

  const decodeOpts: DecodeOptions = { rpcUrl: rpc, enrichTokens, rbtcUsd, tokenMeta }

  if (clearScreen) {
    console.clear()
  }

  const time = new Date().toLocaleTimeString()
  for (const line of renderBanner({
    time,
    pending: data.status.pending,
    queued: data.status.queued,
    pendingBlockTxs: data.txCount,
    rpc,
    rbtcUsd,
  })) {
    console.log(line)
  }

  const printPool = (label: string, txs: typeof pendingTxs, prefix: string) => {
    if (txs.length === 0) return
    console.log(ansi.bold + `\n${label} (${txs.length})` + ansi.reset)
    for (const tx of txs) {
      const isNew = prevHashes && tx.hash && !prevHashes.has(tx.hash.toLowerCase())
      if (showNewOnly && prevHashes && !isNew) continue
      const summary = summarizeTx(tx, decodeOpts)
      const line = formatTxOneLine(tx, summary)
      console.log((isNew && prevHashes ? ansi.green + prefix + ansi.reset : prefix) + line)
    }
  }

  printPool('PENDING', pendingTxs, '')
  printPool('QUEUED', queuedTxs, ansi.dim + 'Q ' + ansi.reset)

  if (pendingTxs.length === 0 && queuedTxs.length === 0) {
    console.log(ansi.dim + '\n  (mempool empty on this node)' + ansi.reset)
  }

  contractTracker.ingest(allTxs)
  renderContractLeaderboard(contractTracker.top(rpc, 10), rpc, {
    trackedTxCount: contractTracker.trackedTxCount,
    startedAt: contractTracker.startedAt,
  })

  const newHashes = new Set(allTxs.map((t) => t.hash?.toLowerCase()).filter(Boolean) as string[])
  if (prevHashes) {
    const dropped = [...prevHashes].filter((h) => !newHashes.has(h))
    if (dropped.length > 0) {
      console.log(ansi.dim + `\n− left pool (${dropped.length}): ` + dropped.map(shortHash).join(', ') + ansi.reset)
    }
  }

  console.log(
    ansi.dim +
      `\n◆ token send  ◎ RBTC  ○ contract  ◇ approve  ▲ deploy  │  fee = gasLimit×gasPrice  │  USD via CoinGecko RBTC` +
      ansi.reset
  )
  return newHashes
}

async function main() {
  const { rpc, intervalSec, once, enrichTokens, clearScreen } = parseArgs(process.argv)
  let prevHashes: Set<string> | null = null
  const contractTracker = new CumulativeContractTracker()

  const run = async () => {
    try {
      const data = await fetchTxpoolSnapshot(rpc)
      prevHashes = await renderTick(
        rpc,
        enrichTokens,
        clearScreen,
        prevHashes,
        data,
        false,
        contractTracker
      )
      if (once) process.exit(0)
    } catch (err) {
      console.error(ansi.red + (err instanceof Error ? err.message : String(err)) + ansi.reset)
      if (once) process.exit(1)
    }
  }

  await run()
  if (!once) setInterval(run, intervalSec * 1000)
}

main()
