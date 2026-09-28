/**
 * Compact, human-readable pending tx decoding (one line per tx).
 */
import { ethers } from 'ethers'
import { formatAmount } from '../src/utils/amount.ts'

const MAX_UINT = 2n ** 256n - 1n
const TABLE_WIDTH = 96

const ERC20_IFACE = new ethers.Interface([
  'function transfer(address to, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
  'function approve(address spender, uint256 amount)',
])

const SELECTOR_LABELS: Record<string, string> = {
  '0xa9059cbb': 'transfer',
  '0x23b872dd': 'transferFrom',
  '0x095ea7b3': 'approve',
  '0xd0e30db0': 'deposit',
  '0x2e1a7d4d': 'withdraw',
  '0x1249c58b': 'mint',
  '0x42966c68': 'burn',
  '0x40c10f19': 'mint',
  '0x379607f5': 'claim',
  '0x3d18b912': 'getReward',
  '0xac9650d8': 'multicall',
  '0x5a686699': 'oracle/update',
  '0xdd330e11': 'oracle/push',
}

export const KNOWN_ADDRESSES: Record<string, string> = {
  '0x19da485eea8317ef427f04eef5dc35287c5d39fd4': 'RIF',
  '0x3a15461d8ae0f0fb5fa2629e9da7d66a794a6e37': 'USDRIF',
  '0xd8169270417050dcef119597a7f6f5ee98dd2fd3': 'vUSD',
  '0xf4d27c56595ed59b66cc7f03cff5193e4bd74a61': 'RIFPRO',
  '0x5db91e24bd32059584bbdb831a901f1199f3d459': 'stRIF',
  '0xa27024ed70035e46dba712609fc2afa1c97aa36a': 'MoC-RIF',
  '0x461750b4824b14c3d9b7702bc6fbb82469082b23': 'oracle-MoC',
  '0xbed51d83cc4676660e3fc3819dfad8238549b975': 'oracle-RLabs',
  '0x5b86e6ce7b7db077e710b27f0ea869707734ad97': 'BTC-vault',
  '0xb8a6beba78c3e73f6a66ddacfaeb240ae22ca709': 'MoC-settle',
}

export type PendingTx = {
  hash?: string
  from?: string
  to?: string | null
  value?: string
  gas?: string
  gasPrice?: string
  maxFeePerGas?: string
  maxPriorityFeePerGas?: string
  nonce?: string
  input?: string
}

export type TokenMeta = { symbol: string; decimals: number }

const tokenMetaCache = new Map<string, TokenMeta | null>()

export type DecodeOptions = {
  rpcUrl?: string
  enrichTokens?: boolean
  tokenMeta?: Map<string, TokenMeta | null>
  rbtcUsd?: number | null
}

export function shortAddr(addr: string | null | undefined, width = 14): string {
  if (!addr) return '«deploy»'
  const key = addr.toLowerCase()
  const label = KNOWN_ADDRESSES[key]
  if (label) return label.length <= width ? label : label.slice(0, width - 1) + '…'
  const a = addr.toLowerCase()
  return a.slice(0, 6) + '…' + a.slice(-4)
}

export function shortHash(hash: string | undefined): string {
  if (!hash) return '????????'
  return hash.slice(0, 10) + '…'
}

function selectorFromInput(input: string | undefined): string | null {
  if (!input || input === '0x' || input.length < 10) return null
  return input.slice(0, 10).toLowerCase()
}

async function fetchTokenMeta(rpcUrl: string, tokenAddress: string): Promise<TokenMeta | null> {
  const key = tokenAddress.toLowerCase()
  if (tokenMetaCache.has(key)) return tokenMetaCache.get(key) ?? null

  const ethCall = async (data: string): Promise<string | null> => {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_call',
          params: [{ to: tokenAddress, data }, 'latest'],
          id: 1,
        }),
      })
      const json = (await res.json()) as { result?: string }
      if (!json.result || json.result === '0x') return null
      return json.result
    } catch {
      return null
    }
  }

  try {
    const [symHex, decHex] = await Promise.all([ethCall('0x95d89b41'), ethCall('0x313ce567')])
    let symbol = 'ERC20'
    let decimals = 18
    if (symHex) {
      const [s] = ethers.AbiCoder.defaultAbiCoder().decode(['string'], symHex)
      if (s) symbol = String(s).slice(0, 12)
    }
    if (decHex) {
      const d = Number(BigInt(decHex))
      if (d >= 0 && d <= 36) decimals = d
    }
    const meta = { symbol, decimals }
    tokenMetaCache.set(key, meta)
    return meta
  } catch {
    tokenMetaCache.set(key, null)
    return null
  }
}

export async function prefetchTokenMeta(rpcUrl: string, txs: PendingTx[]): Promise<Map<string, TokenMeta | null>> {
  const map = new Map<string, TokenMeta | null>()
  const addrs = new Set<string>()
  for (const tx of txs) {
    const sel = selectorFromInput(tx.input)
    if (!tx.to || !sel) continue
    if (sel === '0xa9059cbb' || sel === '0x23b872dd' || sel === '0x095ea7b3') {
      addrs.add(tx.to.toLowerCase())
    }
  }
  await Promise.all(
    [...addrs].map(async (a) => {
      map.set(a, await fetchTokenMeta(rpcUrl, a))
    })
  )
  return map
}

function tokenMetaFor(contract: string | undefined, opts: DecodeOptions): TokenMeta {
  if (!contract) return { symbol: 'TOKEN', decimals: 18 }
  const key = contract.toLowerCase()
  const fromOpts = opts.tokenMeta?.get(key)
  if (fromOpts) return fromOpts
  const cached = tokenMetaCache.get(key)
  if (cached) return cached
  const label = KNOWN_ADDRESSES[key]
  return { symbol: label ?? 'TOKEN', decimals: 18 }
}

function fmtToken(amount: bigint, contract: string | undefined, opts: DecodeOptions): string {
  const meta = tokenMetaFor(contract, opts)
  return `${formatAmount(amount, meta.decimals)} ${meta.symbol}`
}

function fmtRbtcWei(weiHex: string | undefined): string {
  const wei = weiHex ? BigInt(weiHex) : 0n
  if (wei === 0n) return ''
  return `${formatAmount(wei, 18)} RBTC`
}

/** feeWei = gasLimit × effectiveGasPrice (gasPrice or maxFeePerGas). */
export function estimateFeeWei(tx: PendingTx): bigint | null {
  const gasLimit = tx.gas ? BigInt(tx.gas) : 0n
  const price = tx.gasPrice
    ? BigInt(tx.gasPrice)
    : tx.maxFeePerGas
      ? BigInt(tx.maxFeePerGas)
      : null
  if (gasLimit === 0n || price === null) return null
  return gasLimit * price
}

function formatGasRate(tx: PendingTx): string {
  const gas = tx.gas ? parseInt(tx.gas, 16) : 0
  const gp = tx.gasPrice ? BigInt(tx.gasPrice) : tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : null
  const gasK = gas >= 1000 ? `${Math.round(gas / 1000)}k` : String(gas)
  if (!gp) return `${gasK} gas`
  const gwei = Number(gp) / 1e9
  return `${gasK}@${gwei < 0.01 ? gwei.toExponential(1) : gwei.toFixed(2)}g`
}

export function formatGasWithUsd(tx: PendingTx, rbtcUsd: number | null | undefined): string {
  const rate = formatGasRate(tx)
  const feeWei = estimateFeeWei(tx)
  if (feeWei === null) return rate

  if (rbtcUsd != null && rbtcUsd > 0) {
    const feeUsd = (Number(feeWei) / 1e18) * rbtcUsd
    const usd =
      feeUsd < 0.0001
        ? '<$0.0001'
        : feeUsd < 0.01
          ? `$${feeUsd.toFixed(4)}`
          : `$${feeUsd.toFixed(2)}`
    return `${rate} · ${usd}`
  }

  const feeRbtc = formatAmount(feeWei, 18)
  return `${rate} · ${feeRbtc} RBTC · USD —`
}

export type TxSummary = {
  kind: 'rbtc' | 'token' | 'approve' | 'contract' | 'deploy'
  money: string
  route: string
  gas: string
}

const KIND_ICON: Record<TxSummary['kind'], string> = {
  rbtc: '◎',
  token: '◆',
  approve: '◇',
  contract: '○',
  deploy: '▲',
}

function moneyLine(kind: TxSummary['kind'], text: string): string {
  return `${KIND_ICON[kind]} ${text}`
}

export function summarizeTx(tx: PendingTx, opts: DecodeOptions = {}): TxSummary {
  const input = tx.input ?? '0x'
  const selector = selectorFromInput(input)
  const rbtcWei = tx.value ? BigInt(tx.value) : 0n
  const from = shortAddr(tx.from, 10)
  const gas = formatGasWithUsd(tx, opts.rbtcUsd)

  if (!tx.to) {
    const rbtc = fmtRbtcWei(tx.value)
    return {
      kind: 'deploy',
      money: moneyLine('deploy', rbtc ? `DEPLOY + ${rbtc}` : 'DEPLOY'),
      route: `${from} → «new»`,
      gas,
    }
  }

  const to = shortAddr(tx.to, 12)
  const route = `${from} → ${to}`

  if (!selector) {
    const rbtc = fmtRbtcWei(tx.value)
    return {
      kind: 'rbtc',
      money: rbtcWei > 0n ? moneyLine('rbtc', `SEND ${rbtc} → ${to}`) : moneyLine('rbtc', 'EMPTY (0 RBTC)'),
      route,
      gas,
    }
  }

  if (selector === '0xa9059cbb' || selector === '0x23b872dd') {
    try {
      const parsed = ERC20_IFACE.parseTransaction({ data: input })
      if (parsed?.name === 'transfer' && parsed.args) {
        const recipient = String(parsed.args[0])
        const amount = BigInt(parsed.args[1])
        const rbtc = fmtRbtcWei(tx.value)
        const send = moneyLine('token', `SEND ${fmtToken(amount, tx.to, opts)} → ${shortAddr(recipient, 12)}`)
        return {
          kind: 'token',
          money: rbtc ? `${send} + ${rbtc}` : send,
          route,
          gas,
        }
      }
      if (parsed?.name === 'transferFrom' && parsed.args) {
        const holder = String(parsed.args[0])
        const recipient = String(parsed.args[1])
        const amount = BigInt(parsed.args[2])
        const rbtc = fmtRbtcWei(tx.value)
        const send = moneyLine(
          'token',
          `MOVE ${fmtToken(amount, tx.to, opts)}  ${shortAddr(holder, 8)}→${shortAddr(recipient, 8)}`
        )
        return {
          kind: 'token',
          money: rbtc ? `${send} + ${rbtc}` : send,
          route: `${shortAddr(tx.from, 10)} → ${to}`,
          gas,
        }
      }
    } catch {
      /* fall through */
    }
  }

  if (selector === '0x095ea7b3') {
    try {
      const parsed = ERC20_IFACE.parseTransaction({ data: input })
      if (parsed?.args) {
        const spender = String(parsed.args[0])
        const amount = BigInt(parsed.args[1])
        const amt = amount >= MAX_UINT / 2n ? '∞' : fmtToken(amount, tx.to, opts)
        return {
          kind: 'approve',
          money: moneyLine('approve', `APPROVE ${amt} for ${shortAddr(spender, 12)}`),
          route,
          gas,
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (selector === '0xd0e30db0') {
    const rbtc = fmtRbtcWei(tx.value)
    return {
      kind: 'rbtc',
      money: moneyLine('rbtc', rbtc ? `DEPOSIT ${rbtc} → ${to}` : `DEPOSIT → ${to}`),
      route,
      gas,
    }
  }

  if (selector === '0x2e1a7d4d') {
    try {
      const [amount] = ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], '0x' + input.slice(10))
      return {
        kind: 'contract',
        money: moneyLine('contract', `WITHDRAW ${fmtToken(BigInt(amount), tx.to, opts)} from ${to}`),
        route,
        gas,
      }
    } catch {
      /* ignore */
    }
  }

  const label = SELECTOR_LABELS[selector] ?? selector
  const rbtc = fmtRbtcWei(tx.value)
  return {
    kind: 'contract',
    money: rbtc
      ? moneyLine('contract', `CALL ${label} + ${rbtc}`)
      : moneyLine('contract', `CALL ${label}`),
    route,
    gas,
  }
}

// ── Terminal layout (ANSI) ─────────────────────────────────────────────

const ESC = '\x1b['
export const ansi = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  cyan: `${ESC}36m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  magenta: `${ESC}35m`,
  blue: `${ESC}34m`,
  red: `${ESC}31m`,
  white: `${ESC}37m`,
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

export function padVisible(text: string, width: number): string {
  const plain = stripAnsi(text)
  if (plain.length >= width) {
    if (plain.length > width) return plain.slice(0, width - 1) + '…'
    return text
  }
  return text + ' '.repeat(width - plain.length)
}

function colorMoney(summary: TxSummary): string {
  const plain = summary.money
  const col =
    summary.kind === 'token'
      ? ansi.bold + ansi.green
      : summary.kind === 'rbtc'
        ? ansi.bold + ansi.yellow
        : summary.kind === 'approve'
          ? ansi.bold + ansi.blue
          : ansi.white
  return col + plain + ansi.reset
}

/** HASH │ route │ value (icon + send) │ gas+usd */
export function formatTxOneLine(_tx: PendingTx, summary: TxSummary): string {
  const sep = ansi.dim + '│' + ansi.reset
  const hash = padVisible(ansi.dim + shortHash(_tx.hash) + ansi.reset, 11)
  const route = padVisible(ansi.cyan + summary.route + ansi.reset, 22)
  const money = padVisible(colorMoney(summary), 44)
  const gas = padVisible(ansi.dim + summary.gas + ansi.reset, 18)
  return `${hash} ${sep} ${route} ${sep} ${money} ${sep} ${gas}`
}

const BLOCKSCOUT_ORIGINS = {
  mainnet: 'https://rootstock.blockscout.com',
  testnet: 'https://rootstock-testnet.blockscout.com',
} as const

export function blockscoutExplorerOrigin(rpcUrl: string): string {
  if (/testnet/i.test(rpcUrl)) return BLOCKSCOUT_ORIGINS.testnet
  return BLOCKSCOUT_ORIGINS.mainnet
}

export function blockscoutAddressUrl(address: string, rpcUrl: string): string {
  return `${blockscoutExplorerOrigin(rpcUrl)}/address/${address}`
}

/** OSC 8 clickable link (iTerm, VS Code, Windows Terminal, etc.). */
export function terminalLink(url: string, label: string): string {
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`
}

export type ContractLeaderboardEntry = {
  address: string
  calls: number
  label: string
  blockscoutUrl: string
}

function leaderboardFromCounts(
  counts: Map<string, number>,
  rpcUrl: string,
  limit: number
): ContractLeaderboardEntry[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([address, calls]) => {
      const label = KNOWN_ADDRESSES[address] ?? `${address.slice(0, 10)}…${address.slice(-6)}`
      return {
        address,
        calls,
        label,
        blockscoutUrl: blockscoutAddressUrl(address, rpcUrl),
      }
    })
}

/** Tracks unique txs (by hash) seen in the pool since the watcher started. */
export class CumulativeContractTracker {
  private readonly counts = new Map<string, number>()
  private readonly seenTxHashes = new Set<string>()
  private totalTracked = 0
  readonly startedAt = new Date()

  /** Record new txs; returns how many were newly counted this tick. */
  ingest(txs: PendingTx[]): number {
    let added = 0
    for (const tx of txs) {
      if (!tx.to || !tx.hash) continue
      const hash = tx.hash.toLowerCase()
      if (this.seenTxHashes.has(hash)) continue
      this.seenTxHashes.add(hash)
      const addr = tx.to.toLowerCase()
      this.counts.set(addr, (this.counts.get(addr) ?? 0) + 1)
      this.totalTracked++
      added++
    }
    return added
  }

  get trackedTxCount(): number {
    return this.totalTracked
  }

  top(rpcUrl: string, limit = 10): ContractLeaderboardEntry[] {
    return leaderboardFromCounts(this.counts, rpcUrl, limit)
  }
}

export function renderContractLeaderboard(
  entries: ContractLeaderboardEntry[],
  rpcUrl: string,
  opts: { trackedTxCount: number; startedAt: Date }
): void {
  const w = TABLE_WIDTH
  const runtime = formatRuntime(opts.startedAt)
  console.log(
    ansi.bold +
      `\n▣ TOP 10 CONTRACTS (cumulative since start — ${opts.trackedTxCount} unique txs, ${runtime})` +
      ansi.reset
  )
  if (entries.length === 0) {
    console.log(ansi.dim + '  (none yet — waiting for contract calls in mempool)' + ansi.reset)
    return
  }

  const rankW = 3
  const callsW = 5
  const nameW = 28
  console.log(
    ansi.dim +
      padVisible('#', rankW) +
      '  ' +
      padVisible('CALLS', callsW) +
      '  ' +
      padVisible('CONTRACT', nameW) +
      '  BLOCKSCOUT' +
      ansi.reset
  )
  console.log(ansi.dim + '─'.repeat(Math.min(w, 78)) + ansi.reset)

  entries.forEach((e, i) => {
    const rank = padVisible(String(i + 1), rankW)
    const calls = padVisible(String(e.calls), callsW)
    const name = padVisible(
      e.label.length <= nameW - 12 ? e.label : e.label.slice(0, nameW - 2) + '…',
      nameW
    )
    const linkLabel = ansi.cyan + 'open ↗' + ansi.reset
    const link = terminalLink(e.blockscoutUrl, linkLabel)
    console.log(
      `${ansi.bold}${rank}${ansi.reset}  ${ansi.yellow}${calls}${ansi.reset}  ${name}  ${link} ${ansi.dim}${e.blockscoutUrl}${ansi.reset}`
    )
  })

  console.log(
    ansi.dim +
      `  (${blockscoutExplorerOrigin(rpcUrl)} — each tx counted once when first seen in pool)` +
      ansi.reset
  )
}

function formatRuntime(since: Date): string {
  const sec = Math.max(0, Math.floor((Date.now() - since.getTime()) / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ${sec % 60}s`
  const hr = Math.floor(min / 60)
  return `${hr}h ${min % 60}m`
}

export function renderBanner(opts: {
  time: string
  pending: number
  queued: number
  pendingBlockTxs: number
  rpc: string
  rbtcUsd: number | null
}): string[] {
  const w = TABLE_WIDTH
  const line = '─'.repeat(w - 2)
  const title = ` ◉ RSK MEMPOOL  ${opts.time} `
  const price =
    opts.rbtcUsd != null
      ? ` RBTC $${opts.rbtcUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })} `
      : ' RBTC/USD — (CoinGecko) '
  const stats = ` ● ${opts.pending} pending   ○ ${opts.queued} queued   ▣ ${opts.pendingBlockTxs} next block${price}`
  const rpc = ` ${opts.rpc.slice(0, w - 6)} `
  const hdr = 'HASH       ROUTE                  WHAT (token / RBTC)                         FEE (est.)'
  return [
    ansi.bold + ansi.cyan + `╭${line}╮` + ansi.reset,
    ansi.bold + ansi.cyan + `│` + ansi.reset + ansi.bold + padVisible(title, w - 2) + ansi.cyan + `│` + ansi.reset,
    ansi.cyan + `│` + ansi.reset + padVisible(stats, w - 2) + ansi.cyan + `│` + ansi.reset,
    ansi.cyan + `│` + ansi.reset + ansi.dim + padVisible(rpc, w - 2) + ansi.cyan + `│` + ansi.reset,
    ansi.bold + ansi.cyan + `╰${line}╯` + ansi.reset,
    ansi.dim + padVisible(hdr, w) + ansi.reset,
    ansi.dim + '─'.repeat(w) + ansi.reset,
  ]
}
