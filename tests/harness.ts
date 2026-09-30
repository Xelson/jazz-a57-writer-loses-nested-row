import { createAccountManager } from 'jazz-tools'
import { createJazzClient, type JazzClient } from 'jazz-tools/client'
import { type LocalJazzServerHandle, startLocalJazzServer } from 'jazz-tools/testing'

export type { JazzClient, LocalJazzServerHandle }

/** A sync server in memory, with local-first auth so clients need no JWKS. */
export const startServer = (schema: unknown, permissions: unknown) =>
  startLocalJazzServer({
    inMemory: true,
    allowLocalFirstAuth: true,
    schema: schema as never,
    permissions: permissions as never,
  })

/** A client with its own local-first account and a memory store (WASM in Node). */
export const createClient = async (server: LocalJazzServerHandle): Promise<JazzClient> => {
  let stored: string | null = null
  const manager = await createAccountManager({
    appId: server.appId,
    serverUrl: server.url,
    env: 'prod',
    store: {
      read: async () => stored,
      update: async (transform) => {
        stored = transform(stored)
      },
    },
  })
  return createJazzClient({
    appId: server.appId,
    env: 'prod',
    serverUrl: server.url,
    account: manager.createLocalFirst(),
    driver: { type: 'memory' },
  })
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A live `db.subscribe` that records every delivery and every error, so a test
 * can wait for a state and fail at once when the subscription errors.
 */
export const watch = (client: JazzClient, query: unknown, options?: { tier?: 'local' | 'edge' | 'global' }) => {
  const errors: string[] = []
  let rows: unknown[] | undefined
  let deliveries = 0
  const unsubscribe = client.db.subscribe(query as never, {
    onUpdate: (next: unknown[]) => {
      rows = next
      deliveries += 1
    },
    onError: (error: Error) => {
      errors.push(String(error?.message ?? error))
    },
  } as never, options as never) as unknown as () => void

  /** Resolves once `predicate(rows)` holds; rejects on a subscription error or after `ms`. */
  const until = async (label: string, predicate: (rows: unknown[]) => boolean, ms = 4_000) => {
    const deadline = Date.now() + ms
    for (;;) {
      if (errors.length > 0) {
        throw new Error(`subscription errored while waiting for ${label}: ${errors.join(' | ')}`)
      }
      if (rows !== undefined && predicate(rows)) return rows
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${label}; last rows: ${JSON.stringify(rows)}`)
      }
      await pause(5)
    }
  }

  return {
    until,
    unsubscribe,
    get rows() {
      return rows
    },
    get errors() {
      return errors
    },
    get deliveries() {
      return deliveries
    },
  }
}

/** Waits until every write handle is acknowledged by the server. */
export const settled = (...handles: { wait: (options: { tier: 'global' }) => Promise<unknown> }[]) =>
  Promise.all(handles.map((handle) => handle.wait({ tier: 'global' })))
