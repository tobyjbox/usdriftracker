/**
 * Live Rootstock chain dashboard — Blockscout WebSocket + mempool contract calls.
 *
 *   npm run dashboard:live
 *   npm run dashboard:live -- --testnet --interval 5 --rpc https://public-node.rsk.co
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Socket, type Channel } from 'phoenix'
import { fetchRbtcUsdPrice } from '../src/btcVault/price.ts'
import {
  EXPLORERS,
  type BlockscoutNetwork,
  buildBlockscoutTopics,
  topicCategory,
  shortTopicLabel,
} from './blockscout-ws-topics.ts'
import { summarizeBlockscoutEvent, type DashboardEvent } from './blockscout-ws-summarize.ts'
import { fetchTxpoolSnapshot, listAllTxs } from './txpool-poll.ts'
import {
  CumulativeContractTracker,
  prefetchTokenMeta,
  summarizeTx,
  type DecodeOptions,
} from './watch-rsk-txpool-decode.ts'
import { mempoolToDashboardEvent, type MempoolStats } from './mempool-dashboard.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HTML_PATH = path.join(__dirname, 'blockscout-ws-dashboard.html')

const DEFAULT_RPC = 'https://public-node.rsk.co'
const BUCKET_MS = 5_000
const BUCKET_COUNT = 24
const STATS_INTERVAL_MS = 1_000

type SseClient = { id: number; res: http.ServerResponse }

function parseArgs(argv: string[]) {
  let network: BlockscoutNetwork = 'mainnet'
  let port = 8787
  let openBrowser = true
  let rpc = process.env.VITE_ROOTSTOCK_RPC || process.env.ROOTSTOCK_RPC || DEFAULT_RPC
  let intervalSec = 5
  let enrichTokens = true

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--testnet') network = 'testnet'
    else if (arg === '--port' && argv[i + 1]) port = Math.max(1, parseInt(argv[++i], 10) || 8787)
    else if (arg === '--no-open') openBrowser = false
    else if (arg === '--rpc' && argv[i + 1]) rpc = argv[++i]
    else if (arg === '--interval' && argv[i + 1]) intervalSec = Math.max(1, parseInt(argv[++i], 10) || 5)
    else if (arg === '--no-enrich') enrichTokens = false
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: npm run dashboard:live -- [options]

  --testnet       Use rootstock-testnet Blockscout
  --port <n>      HTTP port (default: 8787)
  --rpc <url>     Rootstock HTTP RPC for mempool (default: public-node.rsk.co)
  --interval <s>  Mempool poll interval (default: 5)
  --no-enrich     Skip eth_call token symbol/decimals for mempool
  --no-open       Do not open browser automatically
`)
      process.exit(0)
    }
  }

  return { network, port, openBrowser, rpc, intervalSec, enrichTokens }
}

function sseWrite(res: http.ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

class DashboardState {
  totalEvents = 0
  blockscoutEvents = 0
  mempoolEvents = 0
  socketConnected = false
  joined = 0
  failed = 0
  listening = false
  readonly topicCount: number
  readonly network: BlockscoutNetwork
  readonly socketUrl: string
  readonly rpcUrl: string

  mempool: MempoolStats = {
    pending: 0,
    queued: 0,
    pendingBlockTxs: 0,
    rbtcUsd: null,
    rpcUrl: '',
    trackedTxCount: 0,
    leaderboard: [],
  }

  private readonly categoryCounts = new Map<string, number>()
  private readonly topicCounts = new Map<string, number>()
  private readonly buckets: number[] = Array(BUCKET_COUNT).fill(0)
  private bucketIndex = 0
  private lastBucketAt = Date.now()
  private recentTimestamps: number[] = []

  constructor(network: BlockscoutNetwork, topics: string[], rpcUrl: string) {
    this.network = network
    this.topicCount = topics.length
    this.socketUrl = `${EXPLORERS[network]}/socket/v2`
    this.rpcUrl = rpcUrl
    this.mempool.rpcUrl = rpcUrl
  }

  recordEvent(ev: DashboardEvent) {
    this.totalEvents++
    if (ev.source === 'mempool') this.mempoolEvents++
    else this.blockscoutEvents++

    const cat = ev.source === 'mempool' ? `mempool:${ev.category}` : topicCategory(ev.topic)
    this.categoryCounts.set(cat, (this.categoryCounts.get(cat) ?? 0) + 1)

    const topicKey = ev.source === 'mempool' ? ev.topic : ev.topic
    this.topicCounts.set(topicKey, (this.topicCounts.get(topicKey) ?? 0) + 1)

    const now = Date.now()
    this.recentTimestamps.push(now)
    const cutoff = now - 60_000
    while (this.recentTimestamps.length && this.recentTimestamps[0] < cutoff) {
      this.recentTimestamps.shift()
    }

    if (now - this.lastBucketAt >= BUCKET_MS) {
      this.bucketIndex = (this.bucketIndex + 1) % BUCKET_COUNT
      this.buckets[this.bucketIndex] = 0
      this.lastBucketAt = now
    }
    this.buckets[this.bucketIndex]++
  }

  updateMempool(partial: Partial<MempoolStats>) {
    this.mempool = { ...this.mempool, ...partial, rpcUrl: this.rpcUrl }
  }

  snapshot(): Record<string, unknown> {
    const statusParts: string[] = []
    if (!this.socketConnected) statusParts.push('Blockscout connecting')
    else if (!this.listening) statusParts.push(`Blockscout joining (${this.joined}/${this.topicCount})`)
    else statusParts.push('Blockscout live')
    if (this.mempool.error) statusParts.push(`Mempool error`)
    else statusParts.push('Mempool polling')

    const topTopics = [...this.topicCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([topic, count]) => ({
        label: topic.startsWith('mempool:') ? topic.replace('mempool:', '') : shortTopicLabel(topic),
        count,
      }))

    const orderedBuckets = [...this.buckets.slice(this.bucketIndex + 1), ...this.buckets.slice(0, this.bucketIndex + 1)]

    return {
      totalEvents: this.totalEvents,
      blockscoutEvents: this.blockscoutEvents,
      mempoolEvents: this.mempoolEvents,
      eventsPerMin: this.recentTimestamps.length,
      topicCount: this.topicCount,
      joined: this.joined,
      failed: this.failed,
      socketConnected: this.socketConnected,
      listening: this.listening,
      statusText: statusParts.join(' · '),
      network: this.network,
      socketUrl: this.socketUrl,
      rpcUrl: this.rpcUrl,
      categoryCounts: Object.fromEntries(this.categoryCounts),
      topTopics,
      rateBuckets: orderedBuckets,
      mempool: this.mempool,
    }
  }
}

const INTERNAL_EVENTS = /^phx_|^chan_reply/

function watchChannel(
  channel: Channel,
  topic: string,
  state: DashboardState,
  broadcast: (ev: DashboardEvent) => void
) {
  channel.onMessage = (event, payload, _ref) => {
    if (INTERNAL_EVENTS.test(event)) return payload
    const summarized = summarizeBlockscoutEvent(topic, event, payload)
    state.recordEvent(summarized)
    broadcast(summarized)
    return payload
  }
}

function joinChannel(
  socket: Socket,
  topic: string,
  state: DashboardState,
  broadcast: (ev: DashboardEvent) => void
): Promise<'ok' | 'error'> {
  return new Promise((resolve) => {
    const channel = socket.channel(topic, {})
    watchChannel(channel, topic, state, broadcast)
    channel
      .join()
      .receive('ok', () => {
        state.joined++
        resolve('ok')
      })
      .receive('error', () => {
        state.failed++
        resolve('error')
      })
      .receive('timeout', () => {
        state.failed++
        resolve('error')
      })
  })
}

async function pollMempool(
  rpc: string,
  enrichTokens: boolean,
  state: DashboardState,
  contractTracker: CumulativeContractTracker,
  seenHashes: Set<string>,
  broadcast: (ev: DashboardEvent) => void
) {
  try {
    const data = await fetchTxpoolSnapshot(rpc)
    const pendingTxs = listAllTxs(data.content, 'pending')
    const queuedTxs = listAllTxs(data.content, 'queued')
    const allTxs = [...pendingTxs, ...queuedTxs]

    const [rbtcUsd, tokenMeta] = await Promise.all([
      fetchRbtcUsdPrice(),
      enrichTokens ? prefetchTokenMeta(rpc, allTxs) : Promise.resolve(undefined),
    ])
    const decodeOpts: DecodeOptions = { rpcUrl: rpc, enrichTokens, rbtcUsd, tokenMeta }

    contractTracker.ingest(allTxs)
    const leaderboard = contractTracker.top(rpc, 10).map((e) => ({
      label: e.label,
      calls: e.calls,
      blockscoutUrl: e.blockscoutUrl,
    }))

    state.updateMempool({
      pending: data.status.pending,
      queued: data.status.queued,
      pendingBlockTxs: data.txCount,
      rbtcUsd,
      trackedTxCount: contractTracker.trackedTxCount,
      leaderboard,
      error: undefined,
    })

    const emitPool = (pool: 'pending' | 'queued', txs: typeof pendingTxs) => {
      for (const tx of txs) {
        if (!tx.hash) continue
        const h = tx.hash.toLowerCase()
        if (seenHashes.has(h)) continue
        seenHashes.add(h)
        const summary = summarizeTx(tx, decodeOpts)
        const ev = mempoolToDashboardEvent(tx, summary, pool, rpc)
        state.recordEvent(ev)
        broadcast(ev)
      }
    }

    emitPool('pending', pendingTxs)
    emitPool('queued', queuedTxs)
  } catch (err) {
    state.updateMempool({
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function openBrowser(url: string) {
  const { exec } = await import('node:child_process')
  const platform = process.platform
  const cmd =
    platform === 'darwin' ? `open "${url}"` : platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`
  exec(cmd, () => {})
}

async function main() {
  const { network, port, openBrowser: shouldOpen, rpc, intervalSec, enrichTokens } = parseArgs(process.argv)
  const topics = buildBlockscoutTopics()
  const state = new DashboardState(network, topics, rpc)
  const clients = new Map<number, SseClient>()
  let nextClientId = 1
  const contractTracker = new CumulativeContractTracker()
  const seenMempoolHashes = new Set<string>()

  const broadcastEvent = (ev: DashboardEvent) => {
    for (const client of clients.values()) {
      sseWrite(client.res, 'event', ev)
    }
  }

  const broadcastStats = () => {
    const snap = state.snapshot()
    for (const client of clients.values()) {
      sseWrite(client.res, 'stats', snap)
    }
  }

  const html = fs.readFileSync(HTML_PATH, 'utf8')

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }

    if (url.pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      const id = nextClientId++
      clients.set(id, { id, res })
      sseWrite(res, 'stats', state.snapshot())

      req.on('close', () => {
        clients.delete(id)
      })
      return
    }

    res.writeHead(404)
    res.end('Not found')
  })

  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`
    console.log(`RSK live chain dashboard → ${url}`)
    console.log(`  Blockscout: ${state.socketUrl}`)
    console.log(`  Mempool RPC: ${rpc} (every ${intervalSec}s)`)
    if (shouldOpen) openBrowser(url)
  })

  setInterval(broadcastStats, STATS_INTERVAL_MS)

  await pollMempool(rpc, enrichTokens, state, contractTracker, seenMempoolHashes, broadcastEvent)
  broadcastStats()
  setInterval(
    () => pollMempool(rpc, enrichTokens, state, contractTracker, seenMempoolHashes, broadcastEvent).then(broadcastStats),
    intervalSec * 1000
  )

  const socket = new Socket(state.socketUrl, {
    params: {},
    heartbeatIntervalMs: 30_000,
    reconnectAfterMs: (tries) => [1000, 2000, 5000, 10_000][tries - 1] ?? 10_000,
  })

  socket.onOpen(() => {
    state.socketConnected = true
    broadcastStats()
  })
  socket.onClose(() => {
    state.socketConnected = false
    broadcastStats()
  })
  socket.onError(() => {
    state.socketConnected = false
    broadcastStats()
  })

  socket.connect()
  await new Promise((r) => setTimeout(r, 500))

  for (const topic of topics) {
    await joinChannel(socket, topic, state, broadcastEvent)
    await new Promise((r) => setTimeout(r, 50))
  }

  state.listening = true
  broadcastStats()
  console.log(`Blockscout: ${state.joined}/${topics.length} topics joined`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
