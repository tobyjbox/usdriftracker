/**
 * Turn Blockscout V2 push payloads into short human labels for the dashboard.
 */
import { KNOWN_ADDRESSES } from './watch-rsk-txpool-decode.ts'
import { shortTopicLabel } from './blockscout-ws-topics.ts'

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] != null) return obj[k]
  }
  return undefined
}

function shortHash(v: unknown): string {
  const s = String(v ?? '')
  if (s.length < 12) return s || '—'
  return `${s.slice(0, 8)}…${s.slice(-4)}`
}

function shortAddr(v: unknown): string {
  const s = String(v ?? '').toLowerCase()
  if (!s.startsWith('0x')) return String(v ?? '—')
  return KNOWN_ADDRESSES[s] ?? `${s.slice(0, 6)}…${s.slice(-4)}`
}

function asRecord(payload: unknown): Record<string, unknown> | null {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>
  }
  return null
}

function nestedRecord(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
  for (const k of keys) {
    const v = obj[k]
    const rec = asRecord(v)
    if (rec) return rec
  }
  return null
}

function formatNumber(v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2)
  const n = Number(v)
  if (!Number.isNaN(n) && String(v).trim() !== '') {
    return Number.isInteger(n) ? String(n) : n.toFixed(2)
  }
  return String(v)
}

export type DashboardField = { label: string; value: string }

export type DashboardEvent = {
  source: 'blockscout' | 'mempool'
  topic: string
  event: string
  category: string
  topicLabel: string
  title: string
  detail: string
  ts: number
  fields: DashboardField[]
  payload: unknown
}

const MAX_PAYLOAD_CHARS = 12_000

function truncatePayload(payload: unknown): unknown {
  const raw = JSON.stringify(payload, null, 2)
  if (raw.length <= MAX_PAYLOAD_CHARS) return payload
  return { _truncated: true, preview: raw.slice(0, MAX_PAYLOAD_CHARS) + `\n… (+${raw.length - MAX_PAYLOAD_CHARS} chars)` }
}

function flattenFields(obj: Record<string, unknown>, prefix = '', depth = 0): DashboardField[] {
  if (depth > 2) return []
  const out: DashboardField[] = []
  for (const [key, value] of Object.entries(obj)) {
    const label = prefix ? `${prefix}.${key}` : key
    if (value == null) {
      out.push({ label, value: '—' })
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      out.push(...flattenFields(value as Record<string, unknown>, label, depth + 1))
    } else if (Array.isArray(value)) {
      out.push({ label, value: `[${value.length} items]` })
    } else {
      out.push({ label, value: String(value) })
    }
  }
  return out
}

function buildFields(topic: string, event: string, payload: unknown): DashboardField[] {
  const fields: DashboardField[] = [
    { label: 'topic', value: topic },
    { label: 'event', value: event },
  ]
  const root = asRecord(payload)
  if (root) fields.push(...flattenFields(root))
  else if (payload != null) fields.push({ label: 'payload', value: String(payload) })
  return fields.slice(0, 48)
}

function finalize(
  topic: string,
  event: string,
  payload: unknown,
  partial: Omit<DashboardEvent, 'fields' | 'payload' | 'source'>
): DashboardEvent {
  return {
    source: 'blockscout',
    ...partial,
    fields: buildFields(topic, event, payload),
    payload: truncatePayload(payload),
  }
}

export function summarizeBlockscoutEvent(topic: string, event: string, payload: unknown): DashboardEvent {
  const ts = Date.now()
  const topicLabel = shortTopicLabel(topic)
  const category = topic.split(':')[0] ?? 'other'
  const root = asRecord(payload)
  const obj = root ? nestedRecord(root, ['block', 'transaction', 'token_transfer', 'data']) ?? root : null

  if (obj) {
    const blockNum = pick(obj, ['block_number', 'number', 'height'])
    const txCount = pick(obj, ['transactions_count', 'transaction_count', 'tx_count', 'transactions'])
    if (blockNum != null) {
      const txs =
        txCount != null
          ? ` · ${Array.isArray(txCount) ? txCount.length : formatNumber(txCount)} txs`
          : ''
      return finalize(topic, event, payload, {
        topic,
        event,
        category,
        topicLabel,
        title: `Block ${formatNumber(blockNum)}`,
        detail: `New block${txs}`,
        ts,
      })
    }

    const hash = pick(obj, ['hash', 'transaction_hash', 'tx_hash'])
    if (hash != null) {
      const from = shortAddr(pick(obj, ['from', 'from_address']))
      const to = shortAddr(pick(obj, ['to', 'to_address']))
      return finalize(topic, event, payload, {
        topic,
        event,
        category,
        topicLabel,
        title: shortHash(hash),
        detail: `${from} → ${to}`,
        ts,
      })
    }

    const amount = pick(obj, ['amount', 'value', 'total', 'value_fiat', 'total_value'])
    const token = shortAddr(pick(obj, ['token_contract_address', 'token_address', 'contract_address']))
    const from = shortAddr(pick(obj, ['from', 'from_address', 'sender']))
    const to = shortAddr(pick(obj, ['to', 'to_address', 'receiver']))
    if (amount != null || event.includes('transfer')) {
      const amt = amount != null ? formatNumber(amount) : 'transfer'
      return finalize(topic, event, payload, {
        topic,
        event,
        category,
        topicLabel,
        title: `${token} transfer`,
        detail: `${amt} · ${from} → ${to}`,
        ts,
      })
    }

    const rate = pick(obj, ['exchange_rate', 'rate', 'usd_value', 'value'])
    if (rate != null && category === 'exchange_rate') {
      return finalize(topic, event, payload, {
        topic,
        event,
        category,
        topicLabel,
        title: 'Exchange rate',
        detail: formatNumber(rate),
        ts,
      })
    }
  }

  if (root) {
    if (event === 'new_block' || topic.endsWith('new_block')) {
      const block = nestedRecord(root, ['block']) ?? root
      const blockNum = pick(block, ['number', 'block_number', 'height'])
      const txs = pick(block, ['transaction_count', 'transactions_count', 'tx_count'])
      if (blockNum != null) {
        return finalize(topic, event, payload, {
          topic,
          event,
          category,
          topicLabel,
          title: `Block ${formatNumber(blockNum)}`,
          detail: txs != null ? `${formatNumber(txs)} txs in block` : 'New block',
          ts,
        })
      }
    }

    if (event === 'transaction' || event === 'new_transaction') {
      const count = pick(root, ['transaction', 'transactions', 'count'])
      if (typeof count === 'number' || (typeof count === 'string' && /^\d+$/.test(count))) {
        return finalize(topic, event, payload, {
          topic,
          event,
          category,
          topicLabel,
          title: 'New transactions',
          detail: `${formatNumber(count)} indexed`,
          ts,
        })
      }
    }

    const avgBlock = pick(root, ['average_block_time'])
    if (avgBlock != null) {
      return finalize(topic, event, payload, {
        topic,
        event,
        category,
        topicLabel,
        title: event,
        detail: `avg block ${formatNumber(avgBlock)} ms`,
        ts,
      })
    }

    const keys = Object.keys(root).slice(0, 4)
    if (keys.length > 0) {
      const detail = keys
        .map((k) => {
          const v = root[k]
          if (v && typeof v === 'object') return `${k}=…`
          return `${k}=${String(v).slice(0, 24)}`
        })
        .join(' · ')
      return finalize(topic, event, payload, {
        topic,
        event,
        category,
        topicLabel,
        title: event,
        detail,
        ts,
      })
    }
  }

  const raw = payload == null ? '' : typeof payload === 'string' ? payload : JSON.stringify(payload)
  return finalize(topic, event, payload, {
    topic,
    event,
    category,
    topicLabel,
    title: event,
    detail: raw.slice(0, 120) || '(empty)',
    ts,
  })
}
