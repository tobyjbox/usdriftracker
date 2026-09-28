/**
 * Map mempool txs to dashboard stream events (expandable cards).
 */
import {
  type PendingTx,
  type TxSummary,
  blockscoutAddressUrl,
  shortHash,
} from './watch-rsk-txpool-decode.ts'
import type { DashboardEvent, DashboardField } from './blockscout-ws-summarize.ts'

const MAX_INPUT_CHARS = 2000

function txFields(tx: PendingTx, summary: TxSummary, pool: 'pending' | 'queued', rpcUrl: string): DashboardField[] {
  const fields: DashboardField[] = [
    { label: 'source', value: 'mempool' },
    { label: 'pool', value: pool },
    { label: 'kind', value: summary.kind },
    { label: 'hash', value: tx.hash ?? '—' },
    { label: 'from', value: tx.from ?? '—' },
    { label: 'to', value: tx.to ?? '«deploy»' },
    { label: 'value (wei)', value: tx.value ?? '0' },
    { label: 'gas', value: tx.gas ?? '—' },
    { label: 'gasPrice', value: tx.gasPrice ?? tx.maxFeePerGas ?? '—' },
    { label: 'nonce', value: tx.nonce ?? '—' },
    { label: 'fee (est.)', value: summary.gas },
  ]
  if (tx.to) {
    fields.push({ label: 'blockscout', value: blockscoutAddressUrl(tx.to, rpcUrl) })
  }
  if (tx.input && tx.input !== '0x') {
    const input = tx.input.length > MAX_INPUT_CHARS ? tx.input.slice(0, MAX_INPUT_CHARS) + '…' : tx.input
    fields.push({ label: 'input', value: input })
  }
  return fields
}

export function mempoolToDashboardEvent(
  tx: PendingTx,
  summary: TxSummary,
  pool: 'pending' | 'queued',
  rpcUrl: string
): DashboardEvent {
  const ts = Date.now()
  const hash = tx.hash ? shortHash(tx.hash) : '????????'
  const poolTag = pool === 'queued' ? 'queued · ' : ''
  return {
    source: 'mempool',
    topic: `mempool:${pool}`,
    event: summary.kind,
    category: summary.kind,
    topicLabel: pool === 'queued' ? 'Mempool (queued)' : 'Mempool (pending)',
    title: hash,
    detail: `${poolTag}${summary.money} · ${summary.route}`,
    ts,
    fields: txFields(tx, summary, pool, rpcUrl),
    payload: tx,
  }
}

export type MempoolStats = {
  pending: number
  queued: number
  pendingBlockTxs: number
  rbtcUsd: number | null
  rpcUrl: string
  trackedTxCount: number
  leaderboard: Array<{ label: string; calls: number; blockscoutUrl: string }>
  error?: string
}
