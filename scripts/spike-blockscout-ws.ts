/**
 * Blockscout V2 WebSocket spike — log every event on all joinable topics we care about.
 *
 * Blockscout has no single "firehose" channel; this joins global + RoC contract topics
 * and prints every push via channel.onMessage.
 *
 *   npm run spike:blockscout-ws
 *   npm run spike:blockscout-ws -- --testnet
 *   npm run spike:blockscout-ws -- --duration 120
 */

import { Socket, type Channel } from 'phoenix'
import { EXPLORERS, buildBlockscoutTopics } from './blockscout-ws-topics.ts'

function parseArgs(argv: string[]) {
  let network: keyof typeof EXPLORERS = 'mainnet'
  let durationSec = 0
  let maxPayloadChars = 1200

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--testnet') network = 'testnet'
    else if (arg === '--duration' && argv[i + 1]) durationSec = Math.max(0, parseInt(argv[++i], 10) || 0)
    else if (arg === '--max-chars' && argv[i + 1]) maxPayloadChars = Math.max(200, parseInt(argv[++i], 10) || 1200)
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: npm run spike:blockscout-ws -- [options]

  --testnet        Use rootstock-testnet.blockscout.com
  --duration <s>   Exit after N seconds (default: run until Ctrl+C)
  --max-chars <n>  Truncate JSON payload in log (default: 1200)
`)
      process.exit(0)
    }
  }

  return { network, durationSec, maxPayloadChars }
}

function truncateJson(value: unknown, maxChars: number): string {
  const raw = JSON.stringify(value, null, 0)
  if (raw.length <= maxChars) return raw
  return raw.slice(0, maxChars) + `… (+${raw.length - maxChars} chars)`
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`

let eventCount = 0

function logEvent(topic: string, event: string, payload: unknown, maxChars: number) {
  eventCount++
  const ts = new Date().toISOString()
  console.log(
    `${dim(ts)} ${bold(`#${eventCount}`)} ${cyan(topic)} ${yellow(event)} ${dim(truncateJson(payload, maxChars))}`
  )
}

const INTERNAL_EVENTS = /^phx_|^chan_reply/

function watchChannel(channel: Channel, topic: string, maxChars: number) {
  channel.onMessage = (event, payload, _ref) => {
    if (INTERNAL_EVENTS.test(event)) return payload
    logEvent(topic, event, payload, maxChars)
    return payload
  }
}

function joinChannel(socket: Socket, topic: string, maxChars: number): Promise<'ok' | 'error'> {
  return new Promise((resolve) => {
    const channel = socket.channel(topic, {})
    watchChannel(channel, topic, maxChars)
    channel
      .join()
      .receive('ok', () => {
        console.log(dim(`  joined ${topic}`))
        resolve('ok')
      })
      .receive('error', (err) => {
        console.log(`\x1b[31m  join failed ${topic}: ${truncateJson(err, 400)}\x1b[0m`)
        resolve('error')
      })
      .receive('timeout', () => {
        console.log(`\x1b[31m  join timeout ${topic}\x1b[0m`)
        resolve('error')
      })
  })
}

async function main() {
  const { network, durationSec, maxPayloadChars } = parseArgs(process.argv)
  const origin = EXPLORERS[network]
  const socketUrl = `${origin}/socket/v2`

  const allTopics = buildBlockscoutTopics()

  console.log(bold('Blockscout V2 WebSocket event firehose (spike)'))
  console.log(dim(`Socket: ${socketUrl}`))
  console.log(dim(`Topics: ${allTopics.length}`))
  console.log(dim('Press Ctrl+C to stop\n'))

  const socket = new Socket(socketUrl, {
    params: {},
    heartbeatIntervalMs: 30_000,
    reconnectAfterMs: (tries) => [1000, 2000, 5000, 10_000][tries - 1] ?? 10_000,
  })

  socket.onOpen(() => console.log(green('socket connected')))
  socket.onClose(() => console.log(dim('socket closed')))
  socket.onError((err) => console.log(`\x1b[31msocket error: ${String(err)}\x1b[0m`))

  socket.connect()

  await new Promise((r) => setTimeout(r, 500))

  let joined = 0
  let failed = 0
  for (const topic of allTopics) {
    const result = await joinChannel(socket, topic, maxPayloadChars)
    if (result === 'ok') joined++
    else failed++
    await new Promise((r) => setTimeout(r, 50))
  }

  console.log(dim(`\nListening — joined ${joined}/${allTopics.length} (${failed} failed)\n`))

  if (durationSec > 0) {
    setTimeout(() => {
      console.log(dim(`\nDuration ${durationSec}s elapsed — ${eventCount} events received.`))
      socket.disconnect()
      process.exit(0)
    }, durationSec * 1000)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
