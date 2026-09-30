/**
 * Issue 10: the writer's own live view drops a nested row it just wrote.
 *
 * On 2.0.0-alpha.57 a client subscribes to
 * `messages{attachments{mediaAsset}}` at the `global` tier (the default for a Node
 * client with a `serverUrl`), then inserts an asset, a message and an attachment
 * pointing at both, in one tick, without waiting for acknowledgements. Its live
 * view shows the attachment with its asset, then receives
 * `Remove …>mediaAsset` and keeps `mediaAsset: null`, while a one-shot `db.all` on
 * the same client returns the asset. Nothing re-inserts it.
 *
 * Every case runs RUNS times (default 5) on a fresh server; the red case loses
 * the asset in about 19 runs of 20. The `control:` cases never did in 10 runs each.
 */
import { defineApp, definePermissions, schema } from 'jazz-tools'
import { expect, it } from 'vitest'

import { createClient, type JazzClient, settled, startServer, watch } from './harness'

const app = defineApp({
  media_assets: schema.table(
    { status: schema.string() },
    { message_attachmentsViaMediaAsset: schema.reverse('message_attachments', 'mediaAsset') },
  ),
  messages: schema.table(
    { chatKey: schema.string(), text: schema.string() },
    { message_attachmentsViaMessage: schema.reverse('message_attachments', 'message') },
  ),
  message_attachments: schema.table(
    { messageId: schema.uuid(), mediaAssetId: schema.uuid(), position: schema.int() },
    { message: schema.rel('messages', 'messageId'), mediaAsset: schema.rel('media_assets', 'mediaAssetId') },
  ),
})

const permissions = definePermissions(app, ({ policy }) => {
  for (const table of [policy.media_assets, policy.messages, policy.message_attachments]) {
    table.allowRead.always()
    table.allowInsert.always()
    table.allowUpdate.always()
    table.allowDelete.always()
  }
})

const RUNS = Number(process.env.RUNS ?? 5)
/** How long the asset has to stay in the live view once it has shown up. */
const HOLD_MS = Number(process.env.HOLD_MS ?? 1_000)

type Scenario = {
  /** Whose subscription is watched: the client that writes, or a second one. */
  reader: 'writer' | 'other'
  tier?: 'local' | 'global'
  /** Wait for the server's acknowledgement after each insert. */
  ackEachInsert?: boolean
  /** `messages{attachments{mediaAsset}}` or `attachments{mediaAsset}`. */
  root?: 'messages' | 'attachments'
}

/** Runs the scenario once; returns what the live view ended up with. */
const runOnce = async (scenario: Scenario) => {
  const server = await startServer(app, permissions)
  const writer = await createClient(server)
  const other: JazzClient | undefined = scenario.reader === 'other' ? await createClient(server) : undefined
  const reader = other ?? writer
  try {
    const chatKey = crypto.randomUUID()
    const position = Math.floor(Math.random() * 1e9)
    const query = scenario.root === 'attachments'
      ? app.message_attachments.where({ position }).include({ mediaAsset: true })
      : app.messages.where({ chatKey }).include({ message_attachmentsViaMessage: { mediaAsset: true } })
    const attachmentOf = (rows: any[]) =>
      scenario.root === 'attachments' ? rows[0] : rows[0]?.message_attachmentsViaMessage?.[0]

    const live = watch(reader, query, scenario.tier ? { tier: scenario.tier } : undefined)
    await live.until('the empty open', (rows) => rows.length === 0)

    const ack = async (handle: Parameters<typeof settled>[0]) => {
      if (scenario.ackEachInsert) await settled(handle)
    }
    const asset = writer.db.insert(app.media_assets, { status: 'pending' })
    await ack(asset)
    const message = writer.db.insert(app.messages, { chatKey, text: 'photo' })
    await ack(message)
    const attachment = writer.db.insert(app.message_attachments, {
      messageId: message.value.id,
      mediaAssetId: asset.value.id,
      position,
    })
    await ack(attachment)

    const hasAsset = (rows: any[]) => attachmentOf(rows)?.mediaAsset?.id === asset.value.id
    await live.until('the asset in the live view', hasAsset)
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS))

    const oneShot = (await reader.db.all(query as never, scenario.tier ? { tier: scenario.tier } : undefined)) as any[]
    live.unsubscribe()
    return {
      live: attachmentOf(live.rows as any[])?.mediaAsset?.id === asset.value.id ? 'asset' : 'no asset',
      oneShot: hasAsset(oneShot) ? 'asset' : 'no asset',
      errors: live.errors,
    }
  } finally {
    await writer.shutdown()
    await other?.shutdown()
    await server.stop()
  }
}

const expectKept = async (scenario: Scenario) => {
  for (let run = 1; run <= RUNS; run += 1) {
    const outcome = await runOnce(scenario)
    expect({ run, ...outcome }).toEqual({ run, live: 'asset', oneShot: 'asset', errors: [] })
  }
}

it("the writer's own global subscription keeps the asset it just attached", () =>
  expectKept({ reader: 'writer' }))

it("the writer's own subscription with an explicit { tier: 'global' }", () =>
  expectKept({ reader: 'writer', tier: 'global' }))

it("control: another client's subscription", () => expectKept({ reader: 'other' }))

it("control: the writer's subscription at { tier: 'local' }", () =>
  expectKept({ reader: 'writer', tier: 'local' }))

it('control: each insert acknowledged before the next', () =>
  expectKept({ reader: 'writer', ackEachInsert: true }))

it('control: one level, attachments{mediaAsset}', () =>
  expectKept({ reader: 'writer', root: 'attachments' }))
