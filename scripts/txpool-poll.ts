/**
 * Rootstock txpool RPC polling — shared by CLI watcher and browser dashboard.
 */
import type { PendingTx } from './watch-rsk-txpool-decode.ts'

export type TxpoolStatus = { pending: number; queued: number }

export type TxpoolContent = {
  pending?: Record<string, Record<string, PendingTx[]>>
  queued?: Record<string, Record<string, PendingTx[]>>
}

export type PendingBlock = {
  number: string | null
  hash: string | null
  parentHash?: string
  gasLimit?: string
  gasUsed?: string
  transactions?: string[] | PendingTx[]
}

export type TxpoolSnapshot = {
  status: TxpoolStatus
  content: TxpoolContent
  block: PendingBlock
  txCount: number
  hashes: { pending: Set<string>; queued: Set<string> }
}

export async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: Date.now() }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
  const body = (await res.json()) as { result?: T; error?: { message: string } }
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result as T
}

export function listAllTxs(content: TxpoolContent, pool: 'pending' | 'queued'): PendingTx[] {
  const out: PendingTx[] = []
  const map = pool === 'pending' ? content.pending : content.queued
  if (!map) return out
  for (const byNonce of Object.values(map)) {
    for (const txs of Object.values(byNonce)) out.push(...txs)
  }
  return out.sort((a, b) => (parseInt(a.nonce ?? '0', 16) || 0) - (parseInt(b.nonce ?? '0', 16) || 0))
}

function collectHashes(content: TxpoolContent): { pending: Set<string>; queued: Set<string> } {
  const pending = new Set<string>()
  const queued = new Set<string>()
  const add = (set: Set<string>, pool?: TxpoolContent['pending']) => {
    if (!pool) return
    for (const byNonce of Object.values(pool)) {
      for (const txs of Object.values(byNonce)) {
        for (const tx of txs) if (tx.hash) set.add(tx.hash.toLowerCase())
      }
    }
  }
  add(pending, content.pending)
  add(queued, content.queued)
  return { pending, queued }
}

export async function fetchTxpoolSnapshot(rpcUrl: string): Promise<TxpoolSnapshot> {
  const [statusRaw, content, block] = await Promise.all([
    rpcCall<{ pending: string | number; queued: string | number }>(rpcUrl, 'txpool_status'),
    rpcCall<TxpoolContent>(rpcUrl, 'txpool_content'),
    rpcCall<PendingBlock>(rpcUrl, 'eth_getBlockByNumber', ['pending', false]),
  ])
  const status = {
    pending: typeof statusRaw.pending === 'string' ? parseInt(statusRaw.pending, 10) : statusRaw.pending,
    queued: typeof statusRaw.queued === 'string' ? parseInt(statusRaw.queued, 10) : statusRaw.queued,
  }
  const txCount = Array.isArray(block.transactions) ? block.transactions.length : 0
  return { status, content, block, txCount, hashes: collectHashes(content) }
}
