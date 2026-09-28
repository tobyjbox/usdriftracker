/**
 * Shared Blockscout V2 WebSocket topic lists for spike + dashboard scripts.
 */
import { ethers } from 'ethers'
import { KNOWN_ADDRESSES } from './watch-rsk-txpool-decode.ts'

export const EXPLORERS = {
  mainnet: 'https://rootstock.blockscout.com',
  testnet: 'https://rootstock-testnet.blockscout.com',
} as const

export type BlockscoutNetwork = keyof typeof EXPLORERS

/** Global V2 topics (see block_scout_web/channels/v2/*.ex). */
export const GLOBAL_TOPICS = [
  'blocks:new_block',
  'blocks:indexing',
  'blocks:indexing_internal_transactions',
  'transactions:new_transaction',
  'transactions:new_pending_transaction',
  'transactions:stats',
  'exchange_rate:new_rate',
] as const

export const TOKEN_CONTRACTS = [
  '0x19dA485EeA8317eF427f04EeF5dc35287C5d39fd4', // RIF
  '0x3a15461d8ae0f0fb5fa2629e9da7d66a794a6e37', // USDRIF
  '0xf4d27c56595ed59b66cc7f03cff5193e4bd74a61', // RIFPRO
  '0x5db91e24bd32059584bbdb831a901f1199f3d459', // stRIF
  '0xd8169270417050dcef119597a7f6f5ee98dd2fd3', // vUSD
]

export function checksumAddress(addr: string): string | null {
  try {
    return ethers.getAddress(addr)
  } catch {
    return null
  }
}

export function buildBlockscoutTopics(): string[] {
  const rawAddresses = [...new Set([...Object.keys(KNOWN_ADDRESSES), ...TOKEN_CONTRACTS])]
  const checksummed = rawAddresses.map(checksumAddress).filter((a): a is string => a !== null)
  const addressTopics = checksummed.map((a) => `addresses:${a}`)
  const tokenTopics = checksummed.map((t) => `tokens:${t}`)
  return [...GLOBAL_TOPICS, ...addressTopics, ...tokenTopics]
}

export function topicCategory(topic: string): 'blocks' | 'transactions' | 'addresses' | 'tokens' | 'exchange' | 'other' {
  if (topic.startsWith('blocks:')) return 'blocks'
  if (topic.startsWith('transactions:')) return 'transactions'
  if (topic.startsWith('addresses:')) return 'addresses'
  if (topic.startsWith('tokens:')) return 'tokens'
  if (topic.startsWith('exchange_rate:')) return 'exchange'
  return 'other'
}

export function shortTopicLabel(topic: string): string {
  if (topic.startsWith('addresses:')) {
    const addr = topic.slice('addresses:'.length).toLowerCase()
    return KNOWN_ADDRESSES[addr] ?? `${addr.slice(0, 8)}…`
  }
  if (topic.startsWith('tokens:')) {
    const addr = topic.slice('tokens:'.length).toLowerCase()
    return `token:${KNOWN_ADDRESSES[addr] ?? addr.slice(0, 8)}`
  }
  return topic.split(':').slice(1).join(':') || topic
}
