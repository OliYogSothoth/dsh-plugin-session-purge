#!/usr/bin/env node
/**
 * 一次性验证台架：把 dsh-plugin-session-purge 的宿主半边跑在
 * 「真实文件系统 + 假 Cordis 服务」上，验它到底删了什么、拒绝了什么。
 *
 * 目的：宿主代码每改一次都要换一个模块 URL 才能在运行中的 DSH 里生效，
 * 所以先把逻辑在这里跑通，再去装。
 *
 * 用法：node test\host-logic.mjs
 * 沙箱由 `mkdtempSync` 建在系统临时目录（%TEMP%）下，跑完自删；不碰
 * `~\.dsh\sessions\`。
 */
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

// A fresh directory per run, under the system temp root: the plugin's own
// activation pass (`purgePending`) really deletes what the bin holds, so the
// harness must never point `DSH_HOME` at the real one. `mkdtempSync` makes the
// isolation unconditional — there is no path a caller can forget to set.
const SANDBOX = mkdtempSync(join(tmpdir(), 'dsh-session-purge-test-'))
const ROOT = join(SANDBOX, 'sessions')
// The plugin keeps its recycle bin and manifest under the harness home; point
// that at the sandbox so no test can reach the real one.
process.env.DSH_HOME = SANDBOX
const PLUGIN = fileURLToPath(new URL('../host.js', import.meta.url))
const CLIENT = fileURLToPath(new URL('../client.js', import.meta.url))

const results = []
const check = (name, condition, detail = '') => {
  results.push({ name, pass: condition === true, detail })
  console.log(`${condition === true ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : '  — ' + detail}`)
}

const PARENT = 'session-11111111-1111-4111-8111-111111111111'
const CHILD = 'session-22222222-2222-4222-8222-222222222222'
const FORK = 'session-33333333-3333-4333-8333-333333333333'
const OTHER = 'session-44444444-4444-4444-8444-444444444444'
const PROJECT = '--C-Users-lenovo-Documents-demo--'

const header = (id, extra = {}) => ({
  version: 4,
  id,
  createdAt: Date.now(),
  cwd: 'C:\\Users\\lenovo\\Documents\\demo',
  isSeeded: false,
  ...extra,
})

/** One log line, the way the JSONL backend writes it. */
const logLine = (value) => Buffer.from(`${JSON.stringify(value)}\n`)

/**
 * Materialize one session directory.
 *
 * Without a `log` it only holds the unreadable stub the file-move tests need.
 * With one, exactly that log file is written instead — which is how a test
 * chooses the `.jsonl` or the `.jsonl.zstd` generation that `readSessionHeader`
 * reads the `cwd` out of.
 */
async function seed(id, { log } = {}) {
  const dir = join(ROOT, PROJECT, id)
  await mkdir(dir, { recursive: true })
  if (log === undefined) await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'not-a-real-log')
  else await writeFile(join(dir, log.name), log.bytes)
  return dir
}

/** A fake ctx whose every service the Host half touches is observable. */
function makeCtx({ sessions = [], agents = [], snapshots, registry, cache, projectionCache }) {
  let route
  let tool
  const stops = []
  const evicted = []
  const emitted = []
  // The same emissions, kept structured: `emitted` stringifies the payload (fine
  // for the removal notice, whose payload is the id), while the added notice
  // carries a summary object that only survives as a value.
  const emittedPayloads = []
  const ctx = {
    connection: { fetch: { register: (next) => { route = next; return () => {} } } },
    tools: { register: (definition) => { tool = definition; return () => {} } },
    effect: (fn) => { fn(); return () => {} },
    // The stop providers announce themselves here; the store entry mirrors what
    // the real `sessions` service exposes (`store` Map + per-entry `detach`).
    parallel: async (event, payload) => { stops.push(`${event}:${payload.sessionId}`) },
    emit: (event, payload) => {
      emitted.push(`${event}:${payload}`)
      emittedPayloads.push({ event, payload })
    },
    get(name) {
      if (name === 'sessions') {
        return {
          get: (id) => (sessions.includes(id) ? { id } : undefined),
          store: new Map(sessions.map((id) => [id, { detach: () => { evicted.push(id) } }])),
        }
      }
      if (name === 'agents') return { get: (id) => (agents.includes(id) ? { id } : undefined) }
      if (name === 'workspaceRegistry') return registry
      if (name === 'storageDomain') return cache
      // The persisted projection cache, only ever read for a restore's listing
      // hints. Absent by default, which is a deployment without the cache.
      if (name === 'sessionProjectionCache') return projectionCache
      return undefined
    },
    sessionPersistence: { root: ROOT, list: async () => snapshots.map((h) => ({ header: h, revision: 1 })) },
  }
  return { ctx, route: () => route, tool: () => tool, stops, evicted, emitted, emittedPayloads }
}

function resetBin() {
  return Promise.all([
    rm(join(SANDBOX, 'session-purge-trash'), { recursive: true, force: true }),
    rm(join(SANDBOX, 'session-purge.pending.json'), { force: true }),
  ])
}

/** POST one endpoint through the registered route, as the browser would. */
async function call(route, endpoint, payload) {
  const response = await route.fetch(new Request('http://127.0.0.1/api/session-purge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }),
  }))
  return { status: response.status, body: await response.json() }
}

await rm(SANDBOX, { recursive: true, force: true })
const parentDir = await seed(PARENT)
const childDir = await seed(CHILD)
const forkDir = await seed(FORK)
await seed(OTHER)

const snapshots = [
  header(PARENT),
  header(CHILD, { parentSession: PARENT, origin: 'subagent' }),
  header(FORK, { parentSession: PARENT }),
  header(OTHER),
]

const { apply } = await import(pathToFileURL(PLUGIN).href)

// ---------------------------------------------------------------- happy path
{
  const detached = []
  const unpinned = []
  const unarchived = []
  const cacheDeletes = []
  const workspace = {
    id: 'ws-1',
    path: 'C:\\Users\\lenovo\\Documents\\demo',
    sessionIds: [PARENT, CHILD, OTHER],
    detachSession: async (id) => { detached.push(id) },
  }
  const registry = {
    list: () => [workspace],
    archivedSessionIds: [PARENT],
    pinnedSessionIds: [PARENT],
    unarchiveSession: async (id) => { unarchived.push(id) },
    unpinSession: async (id) => { unpinned.push(id) },
  }
  const cache = { get: (domain) => (domain === 'session_projcache' ? { table: () => ({ delete: async (key) => { cacheDeletes.push(key); return true } }) } : undefined) }
  const { ctx, route, tool, emitted } = makeCtx({ snapshots, registry, cache })
  apply(ctx)

  check('route registered on the exact /api path', route()?.path === '/api/session-purge', route()?.path)
  check('route accepts POST with a buffered body', route()?.methods?.join() === 'POST' && route()?.requestBody === 'buffered')

  const planned = await call(route(), 'plan', { sessionId: PARENT, includeSubagents: true })
  check('plan answers 200 with ok', planned.status === 200 && planned.body.ok === true)
  check('plan includes the hidden subagent but not the visible fork',
    planned.body.value?.targets?.length === 2
      && planned.body.value.targets.some((t) => t.id === CHILD)
      && !planned.body.value.targets.some((t) => t.id === FORK),
    JSON.stringify(planned.body.value?.targets?.map((t) => t.id)))
  check('plan resolves the real log directory',
    planned.body.value?.targets?.[0]?.directories?.[0] === resolve(parentDir),
    planned.body.value?.targets?.[0]?.directories?.[0])
  check('plan reports the subagent count', planned.body.value?.subagentCount === 1)

  const deletedResult = await call(route(), 'move', { sessionId: PARENT, includeSubagents: true })
  check('delete answers ok', deletedResult.status === 200 && deletedResult.body.ok === true)
  check('the move detaches membership but leaves the other books alone',
    detached.join() === [PARENT, CHILD].join() && unarchived.length === 0 && unpinned.length === 0 && cacheDeletes.length === 0,
    `detached=${detached.join()} unarchived=${unarchived.join()} unpinned=${unpinned.join()} cache=${cacheDeletes.join()}`)
  check('parent directory left the sessions root', await stat(parentDir).then(() => false, () => true))
  check('subagent directory left the sessions root', await stat(childDir).then(() => false, () => true))
  check('both directories moved into the recycle bin',
    deletedResult.body.value?.sessions?.every((s) => s.moved.length === 1 && s.moved[0].to.includes('session-purge-trash')),
    JSON.stringify(deletedResult.body.value?.sessions?.map((s) => s.moved)))
  // Neither target is in the fake `sessions` list, so there is no store entry to
  // detach and no `session/disposed` to follow: the removal notice is the only
  // thing that tells the page to drop the row. The visible fork was never a
  // target and must not be announced.
  check('a cold session gets the api-session/removed notice on the move',
    emitted.includes(`api-session/removed:${PARENT}`)
      && emitted.includes(`api-session/removed:${CHILD}`)
      && !emitted.some((event) => event.includes(FORK)),
    emitted.join())
  const binned = await call(route(), 'list', {})
  check('the recycle bin lists both sessions',
    binned.body.value?.pending?.map((entry) => entry.id).join() === [PARENT, CHILD].join(),
    JSON.stringify(binned.body.value?.pending))
  check('visible fork directory untouched', await stat(forkDir).then(() => true, () => false))
  check('other session directory untouched', await stat(join(ROOT, PROJECT, OTHER)).then(() => true, () => false))
  check('report carries no errors', deletedResult.body.value?.sessions?.every((s) => s.errors.length === 0),
    JSON.stringify(deletedResult.body.value?.sessions?.map((s) => s.errors)))
}

// ------------------------------------------------------------ safety refusals
{
  const cache = { get: () => undefined }
  const registry = { list: () => [], archivedSessionIds: [], pinnedSessionIds: [] }

  {
    // A session that is merely *open* used to be refused until the process
    // exited. It must now be stopped, evicted, and deleted in one call.
    const parentAgain = await seed(PARENT)
    const { ctx, route, stops, evicted, emitted } = makeCtx({ snapshots, sessions: [PARENT], registry, cache })
    apply(ctx)
    const done = await call(route(), 'move', { sessionId: PARENT })
    check('an open session is stopped, evicted and deleted',
      done.body.ok === true
        && stops.join() === `workspace/session-stop:${PARENT}`
        && evicted.join() === PARENT
        && await stat(parentAgain).then(() => false, () => true)
        && done.body.value?.sessions?.[0]?.moved?.length === 1,
      `ok=${done.body.ok} stops=${stops.join()} evicted=${evicted.join()}`)
    // The store detach already emitted `session/disposed`, so this one must not
    // be announced as well — the notice is the cold-session fallback only.
    check('a live session is evicted, not announced', emitted.length === 0, emitted.join())
  }
  {
    // Spill directories are named after a hash of the session id. They outlive
    // the move into the bin and go when the next start deletes for real.
    const { createHash } = await import('node:crypto')
    const { tmpdir } = await import('node:os')
    const suffix = createHash('sha256').update(PARENT).digest('hex').slice(0, 12)
    const spillRoot = join(tmpdir(), 'dsh-spill-TEST01')
    const spillDir = join(spillRoot, `session-${suffix}`)
    await mkdir(spillDir, { recursive: true })
    await writeFile(join(spillDir, 'part.bin'), 'x')
    await seed(PARENT)
    await resetBin()

    const detachedThen = []
    const unarchivedThen = []
    const unpinnedThen = []
    const cacheThen = []
    const registryThen = {
      list: () => [{ id: 'ws', sessionIds: [PARENT], detachSession: async (id) => { detachedThen.push(id) } }],
      archivedSessionIds: [PARENT],
      pinnedSessionIds: [PARENT],
      unarchiveSession: async (id) => { unarchivedThen.push(id) },
      unpinSession: async (id) => { unpinnedThen.push(id) },
    }
    const cacheThenApi = { get: () => ({ table: () => ({ delete: async (id) => { cacheThen.push(id); return true } }) }) }

    const first = makeCtx({ snapshots, registry: registryThen, cache: cacheThenApi })
    apply(first.ctx)
    const moved = await call(first.route(), 'move', { sessionId: PARENT })
    check('the move detaches membership and leaves the other books alone',
      detachedThen.join() === PARENT && unarchivedThen.length === 0 && unpinnedThen.length === 0 && cacheThen.length === 0,
      `detached=${detachedThen.join()} cache=${cacheThen.join()}`)
    check('the spill directory outlives the move into the bin',
      await stat(spillDir).then(() => true, () => false), `ok=${moved.body.ok}`)

    // A fresh activation is the next start: the bin is emptied for real.
    const second = makeCtx({ snapshots, registry: registryThen, cache: cacheThenApi })
    apply(second.ctx)
    let gone = false
    for (let attempt = 0; attempt < 40 && !gone; attempt += 1) {
      await new Promise((settle) => setTimeout(settle, 25))
      gone = await stat(spillDir).then(() => false, () => true)
    }
    check('the start-up pass deletes the binned session and its spill directory', gone)
    check('the recycle bin directory is gone after the start-up pass',
      await stat(join(SANDBOX, 'session-purge-trash', PROJECT, PARENT)).then(() => false, () => true))
    check('the emptied project layer is collected too, while the bin root stays',
      await stat(join(SANDBOX, 'session-purge-trash', PROJECT)).then(() => false, () => true)
        && await stat(join(SANDBOX, 'session-purge-trash')).then(() => true, () => false))
    const listed = await call(second.route(), 'list', {})
    check('the bin reports nothing pending and remembers what it purged',
      listed.body.value?.pending?.length === 0 && listed.body.value?.lastPurged?.includes(PARENT),
      JSON.stringify(listed.body.value?.lastPurged))
    check('the real deletion is where the harness books get cleaned',
      unarchivedThen.join() === PARENT && unpinnedThen.join() === PARENT && cacheThen.join() === PARENT,
      `detached=${detachedThen.join()} unarchived=${unarchivedThen.join()} unpinned=${unpinnedThen.join()} cache=${cacheThen.join()}`)
    await rm(spillRoot, { recursive: true, force: true })
  }
  {
    const { ctx, route } = makeCtx({ snapshots, registry, cache })
    apply(ctx)
    const refused = await call(route(), 'move', { sessionId: PARENT, callerSessionId: PARENT })
    check('the calling session is refused', refused.body.ok === false && refused.body.error.code === 'session-purge/caller-session',
      refused.body.error?.code)
  }
  {
    const { ctx, route } = makeCtx({ snapshots, registry, cache })
    apply(ctx)
    const refused = await call(route(), 'move', { sessionId: 'session-nope' })
    check('an unknown session is refused', refused.body.ok === false && refused.body.error.code === 'session-purge/unknown-session',
      refused.body.error?.code)
  }
  {
    const { ctx, route } = makeCtx({ snapshots, registry, cache })
    apply(ctx)
    const refused = await call(route(), 'move', { sessionId: '../escape' })
    check('a path-shaped id is refused', refused.body.ok === false && refused.body.error.code === 'session-purge/invalid-request',
      refused.body.error?.code)
  }
  {
    const { ctx, route } = makeCtx({ snapshots, registry, cache })
    apply(ctx)
    const refused = await call(route(), 'nope', {})
    check('an unknown endpoint is refused', refused.body.ok === false && refused.body.error.code === 'session-purge/unknown-endpoint',
      refused.body.error?.code)
  }
  {
    const { ctx, route } = makeCtx({ snapshots, registry, cache })
    apply(ctx)
    const response = await route().fetch(new Request('http://127.0.0.1/api/session-purge', { method: 'POST', body: 'not json' }))
    check('a non-JSON body answers 400', response.status === 400)
  }
  {
    const { ctx, route } = makeCtx({ snapshots, registry, cache })
    apply(ctx)
    const refused = await call(route(), 'plan', { sessionId: 'session-55555555-5555-4555-8555-555555555555' })
    check('a session that is gone from persistence is refused', refused.body.ok === false)
  }
}

{
  // Restore is a pure rename back: the directory returns, the bin empties, and
  // nothing else had to be undone because the move never touched it. It also
  // re-attaches: `cwd` is read back out of the session's own log, which
  // travelled with the directory into the bin — and the page is told the row is
  // back, because the move's removal notice is what dropped it.
  const restoredHeader = header(PARENT, { cwd: 'C:/demo' })
  await seed(PARENT, { log: { name: 'session.v4.jsonl', bytes: logLine(restoredHeader) } })
  await resetBin()
  const attached = []
  const resolved = []
  const binRegistry = {
    list: () => [],
    archivedSessionIds: [],
    pinnedSessionIds: [],
    resolveByPath: async (cwd) => {
      resolved.push(cwd)
      return { sessionIds: [], attachSession: async (id) => { attached.push(id) } }
    },
  }
  const binCache = { get: () => undefined }
  const { ctx, route, emittedPayloads } = makeCtx({ snapshots, registry: binRegistry, cache: binCache })
  apply(ctx)
  const moved = await call(route(), 'move', { sessionId: PARENT })
  const restored = await call(route(), 'restore', { sessionId: PARENT })
  const afterRestore = await call(route(), 'list', {})
  check('restore puts the directory back and empties the bin',
    moved.body.ok === true
      && restored.body.ok === true
      && await stat(parentDir).then(() => true, () => false)
      && afterRestore.body.value?.pending?.length === 0,
    JSON.stringify(restored.body))
  check('restore re-attaches the session to the workspace its log names',
    restored.body.ok === true && resolved.join() === 'C:/demo' && attached.join() === PARENT,
    `resolved=${resolved.join()} attached=${attached.join()}`)
  // The removal notice of the move and the addition notice of the restore are
  // one pair: without the second the row the first dropped never comes back.
  check('a round trip sends the removal notice and then the addition notice',
    emittedPayloads.length === 2
      && emittedPayloads[0].event === 'api-session/removed' && emittedPayloads[0].payload === PARENT
      && emittedPayloads[1].event === 'api-session/added' && emittedPayloads[1].payload?.sessionId === PARENT,
    JSON.stringify(emittedPayloads.map((entry) => `${entry.event}:${JSON.stringify(entry.payload)}`)))
  const announced = emittedPayloads.find((entry) => entry.event === 'api-session/added')?.payload
  // The shape the Host itself sends for a session that is not live
  // (`ApiSessionList.summarizeCold`), minus the projection block: a restore must
  // not read (or write) the projection cache, and the Host's rule for a cache
  // miss is a visible row.
  check('the addition notice is a cold-session summary with no projection block',
    announced?.running === false && announced?.agentAvailable === false && announced?.blank === false
      && announced?.cwd === 'C:/demo'
      && announced?.updatedAt === restoredHeader.createdAt
      && announced?.projections === undefined
      && !('projections' in (announced ?? {})),
    JSON.stringify(announced))
  const gone = await call(route(), 'restore', { sessionId: PARENT })
  check('restoring what is not binned is refused',
    gone.body.ok === false && gone.body.error.code === 'session-purge/not-binned',
    gone.body.error?.code)
}
{
  // The other generation a session directory can hold: the head line is zstd
  // compressed, and the same `cwd` has to come back out through the
  // decompressor before the registry can be asked about it.
  await rm(parentDir, { recursive: true, force: true })
  await seed(PARENT, {
    log: { name: 'session.v4.jsonl.zstd', bytes: zstdCompressSync(logLine(header(PARENT, { cwd: 'C:/demo-zstd' }))) },
  })
  await resetBin()
  const attached = []
  const resolved = []
  const zstdRegistry = {
    list: () => [],
    archivedSessionIds: [],
    pinnedSessionIds: [],
    resolveByPath: async (cwd) => {
      resolved.push(cwd)
      return { sessionIds: [], attachSession: async (id) => { attached.push(id) } }
    },
  }
  const { ctx, route, emittedPayloads } = makeCtx({ snapshots, registry: zstdRegistry, cache: { get: () => undefined } })
  apply(ctx)
  const moved = await call(route(), 'move', { sessionId: PARENT })
  const restored = await call(route(), 'restore', { sessionId: PARENT })
  check('a zstd log head is decompressed so the session re-attaches too',
    moved.body.ok === true && restored.body.ok === true
      && resolved.join() === 'C:/demo-zstd' && attached.join() === PARENT,
    `resolved=${resolved.join()} attached=${attached.join()}`)
  // The notice is built from the same header read, so the compressed generation
  // has to carry it too rather than announcing a summary with no `cwd`.
  const announced = emittedPayloads.find((entry) => entry.event === 'api-session/added')?.payload
  check('a zstd restore announces the session with the cwd from the compressed log',
    announced?.sessionId === PARENT && announced?.cwd === 'C:/demo-zstd' && announced?.running === false,
    JSON.stringify(emittedPayloads.map((entry) => `${entry.event}:${JSON.stringify(entry.payload)}`)))
}
{
  // A cold row without its cached title reads "untitled" until the next list
  // response, so the notice asks the cache's own listing face for the two keys
  // it knows how to place — the title and the list metadata — and nothing else.
  await rm(parentDir, { recursive: true, force: true })
  const cachedHeader = header(PARENT, { cwd: 'C:/demo' })
  await seed(PARENT, { log: { name: 'session.v4.jsonl', bytes: logLine(cachedHeader) } })
  await resetBin()
  const asked = []
  const projectionCache = {
    cachedSnapshot: (meta, keys) => {
      asked.push(`${meta?.id}:${(keys ?? []).join('+')}`)
      return {
        asOfSeq: 7,
        values: {
          title: 'Restored title',
          sessionListMetadata: { blank: false, lastPromptAt: cachedHeader.createdAt + 5000 },
        },
      }
    },
  }
  const { ctx, route, emittedPayloads } = makeCtx({
    snapshots,
    registry: { list: () => [], archivedSessionIds: [], pinnedSessionIds: [] },
    cache: { get: () => undefined },
    projectionCache,
  })
  apply(ctx)
  const moved = await call(route(), 'move', { sessionId: PARENT })
  const restored = await call(route(), 'restore', { sessionId: PARENT })
  const notice = emittedPayloads.find((entry) => entry.event === 'api-session/added')?.payload
  check('the addition notice carries the cached title and its list metadata',
    moved.body.ok === true && restored.body.ok === true
      && asked.join() === `${PARENT}:title+sessionListMetadata`
      && notice?.projections?.kind === 'cached' && notice?.projections?.asOfSeq === 7
      && notice?.projections?.values?.title === 'Restored title'
      // The Host's own `updatedAt(header, metadata)`: the row sorts where it did
      // before the move, not at its creation time.
      && notice?.updatedAt === cachedHeader.createdAt + 5000
      && notice?.blank === false,
    JSON.stringify(notice))
}
{
  // Every way the read can come up empty — no cache service, no record for this
  // lifecycle, a read that throws — must leave the notice exactly as it was
  // before the read existed, and must never fail the restore.
  const registry = { list: () => [], archivedSessionIds: [], pinnedSessionIds: [] }
  const runCycle = async (read) => {
    await rm(parentDir, { recursive: true, force: true })
    const cycleHeader = header(PARENT, { cwd: 'C:/demo' })
    await seed(PARENT, { log: { name: 'session.v4.jsonl', bytes: logLine(cycleHeader) } })
    await resetBin()
    const { ctx, route, emittedPayloads } = makeCtx({
      snapshots,
      registry,
      cache: { get: () => undefined },
      projectionCache: read === undefined ? undefined : { cachedSnapshot: read },
    })
    apply(ctx)
    await call(route(), 'move', { sessionId: PARENT })
    const restored = await call(route(), 'restore', { sessionId: PARENT })
    return { restored, cycleHeader, payload: emittedPayloads.find((entry) => entry.event === 'api-session/added')?.payload }
  }
  const noService = await runCycle(undefined)
  const noRecord = await runCycle(() => undefined)
  const failedRead = await runCycle(() => { throw new Error('cache read failed') })
  const degraded = (cycle) => cycle.restored.body.ok === true
    && cycle.payload !== undefined
    && !('projections' in cycle.payload)
    && cycle.payload.updatedAt === cycle.cycleHeader.createdAt
    && cycle.payload.blank === false
    && cycle.payload.running === false && cycle.payload.agentAvailable === false
    && cycle.payload.cwd === 'C:/demo'
  check('a missing or failing cache read degrades to the previous notice and the restore still succeeds',
    degraded(noService) && degraded(noRecord) && degraded(failedRead),
    [noService, noRecord, failedRead]
      .map((cycle) => `${cycle.restored.body.ok}:${JSON.stringify(cycle.payload)}`)
      .join(' | '))
}
// ------------------------------------------------- orphan subagent sessions
{
  // `origin: 'subagent'` children never get a row, and the parent's dialog is the
  // only surface that names them — so once the parent leaves the session root the
  // child has no way in. The catalog here is *mutable* on purpose: the real
  // `sessionPersistence.list()` only sees the session root, so moving a parent
  // into the bin (or deleting it for real) removes it from the listing, and that
  // single fact is what makes the child an orphan. Splicing mirrors exactly that.
  const ORPHAN_A = 'session-66666666-6666-4666-8666-666666666666' // parent long gone
  const ORPHAN_B = 'session-77777777-7777-4777-8777-777777777777' // no parentSession at all
  const catalog = [
    header(PARENT),
    header(CHILD, { parentSession: PARENT, origin: 'subagent' }),
    header(FORK, { parentSession: PARENT }),
    header(ORPHAN_A, { parentSession: 'session-99999999-9999-4999-8999-999999999999', origin: 'subagent' }),
    header(ORPHAN_B, { origin: 'subagent' }),
  ]
  const registry = { list: () => [], archivedSessionIds: [], pinnedSessionIds: [] }
  const cache = { get: () => undefined }
  const { ctx, route } = makeCtx({ snapshots: catalog, registry, cache })
  apply(ctx)
  await rm(join(ROOT, PROJECT, ORPHAN_A), { recursive: true, force: true })
  await rm(join(ROOT, PROJECT, ORPHAN_B), { recursive: true, force: true })
  await seed(ORPHAN_A)
  await seed(ORPHAN_B)
  await rm(childDir, { recursive: true, force: true })
  await seed(CHILD)
  await resetBin()

  const orphanIds = (value) => (value?.orphans ?? []).map((entry) => entry.id)
  const first = await call(route(), 'list', {})
  check('an orphan whose parent is gone from the catalog is listed',
    orphanIds(first.body.value).includes(ORPHAN_A), JSON.stringify(first.body.value?.orphans))
  check('a subagent with no parentSession at all is listed too',
    orphanIds(first.body.value).includes(ORPHAN_B), JSON.stringify(first.body.value?.orphans))
  check('a subagent whose parent is still in the catalog is not listed',
    orphanIds(first.body.value).includes(CHILD) === false, JSON.stringify(first.body.value?.orphans))
  check('a visible fork is never an orphan',
    orphanIds(first.body.value).includes(FORK) === false, JSON.stringify(first.body.value?.orphans))

  // The orphan travels the ordinary path: plan accepts it (no subagent bundle to
  // add), and move puts its directory in the bin — the same two-step delete.
  const planned = await call(route(), 'plan', { sessionId: ORPHAN_A })
  check('plan accepts an orphan and counts no subagents',
    planned.body.ok === true
      && planned.body.value?.targets?.length === 1
      && planned.body.value?.targets?.[0]?.id === ORPHAN_A
      && planned.body.value?.subagentCount === 0,
    JSON.stringify(planned.body.value?.targets?.map((t) => t.id)))
  const movedOrphan = await call(route(), 'move', { sessionId: ORPHAN_A })
  check('move puts an orphan into the recycle bin like any other session',
    movedOrphan.body.ok === true
      && movedOrphan.body.value?.sessions?.[0]?.moved?.length === 1
      && movedOrphan.body.value.sessions[0].moved[0].to.includes('session-purge-trash')
      && await stat(join(ROOT, PROJECT, ORPHAN_A)).then(() => false, () => true),
    JSON.stringify(movedOrphan.body.value?.sessions?.[0]?.moved))

  // The user's exact case: the parent is moved *alone* (the subagent box was
  // unticked), so the child stays in the root with no parent in the catalog.
  await rm(parentDir, { recursive: true, force: true })
  await seed(PARENT)
  const movedParentAlone = await call(route(), 'move', { sessionId: PARENT })
  catalog.splice(catalog.findIndex((h) => h.id === PARENT), 1)
  const afterParentLeft = await call(route(), 'list', {})
  check('unticking the subagent box leaves the child behind, which then reads as an orphan',
    movedParentAlone.body.ok === true
      && await stat(childDir).then(() => true, () => false)
      && orphanIds(afterParentLeft.body.value).includes(CHILD),
    JSON.stringify(afterParentLeft.body.value?.orphans))
  const movedChild = await call(route(), 'move', { sessionId: CHILD })
  check('that leftover child can then be binned on its own',
    movedChild.body.ok === true
      && movedChild.body.value?.sessions?.[0]?.moved?.length === 1
      && await stat(childDir).then(() => false, () => true),
    JSON.stringify(movedChild.body.value?.sessions?.[0]?.moved))
  const restoredChild = await call(route(), 'restore', { sessionId: CHILD })
  check('an orphan restores the same way: the directory comes back',
    restoredChild.body.ok === true && await stat(childDir).then(() => true, () => false),
    JSON.stringify(restoredChild.body))

  // Negative controls: the surfaces that do refuse still refuse, and an orphan
  // that is live in this process still goes through the stop-and-evict path
  // rather than around it.
  const refusedCaller = await call(route(), 'move', { sessionId: ORPHAN_B, callerSessionId: ORPHAN_B })
  check('refusing the caller session still applies to an orphan',
    refusedCaller.body.ok === false && refusedCaller.body.error.code === 'session-purge/caller-session',
    JSON.stringify(refusedCaller.body.error))
  const missing = await call(route(), 'plan', { sessionId: 'session-88888888-8888-4888-8888-888888888888' })
  check('an id that is in no catalog is still refused', missing.body.ok === false, JSON.stringify(missing.body.error))

  await rm(join(ROOT, PROJECT, ORPHAN_B), { recursive: true, force: true })
  await seed(ORPHAN_B)
  await resetBin()
  const live = makeCtx({ snapshots: catalog, sessions: [ORPHAN_B], registry, cache })
  apply(live.ctx)
  const livePlan = await call(live.route(), 'plan', { sessionId: ORPHAN_B })
  check('a live orphan is reported as live on the plan',
    livePlan.body.value?.targets?.[0]?.live === true,
    JSON.stringify(livePlan.body.value?.targets))
  const movedLive = await call(live.route(), 'move', { sessionId: ORPHAN_B })
  check('a live orphan is stopped and evicted before it moves, not waved through',
    movedLive.body.ok === true
      && live.stops.join() === `workspace/session-stop:${ORPHAN_B}`
      && live.evicted.join() === ORPHAN_B
      && movedLive.body.value?.sessions?.[0]?.moved?.length === 1,
    `ok=${movedLive.body.ok} stops=${live.stops.join()} evicted=${live.evicted.join()}`)
}
// ------------------------------------------------------ titles in the panel
{
  // The panel shows the title the session's own cache record holds, and falls
  // back to the id when there is none. The Host reads it through the same narrow
  // method the restore notice uses; this block fakes that cache and checks both
  // directions — including the client's pure fallback, loaded out of client.js.
  const TITLED = 'session-aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
  const UNTITLED = 'session-aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
  const ORPHAN_TITLED = 'session-aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
  const ORPHAN_PLAIN = 'session-aaaaaaa4-aaaa-4aaa-8aaa-aaaaaaaaaaa4'
  const catalog = [
    header(TITLED),
    header(UNTITLED),
    header(ORPHAN_TITLED, { parentSession: 'session-bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbb1', origin: 'subagent' }),
    header(ORPHAN_PLAIN, { parentSession: 'session-bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2', origin: 'subagent' }),
  ]
  const titled = new Map([[TITLED, 'A titled session'], [ORPHAN_TITLED, 'A titled orphan']])
  const asked = []
  const projectionCache = {
    cachedSnapshot: (meta, keys) => {
      asked.push({ id: meta?.id, keys: (keys ?? []).join('+') })
      const title = titled.get(meta?.id)
      return title === undefined ? undefined : { asOfSeq: 4, values: { title } }
    },
  }
  const registry = { list: () => [], archivedSessionIds: [], pinnedSessionIds: [] }
  const { ctx, route } = makeCtx({
    snapshots: catalog,
    registry,
    cache: { get: () => undefined },
    projectionCache,
  })
  apply(ctx)
  await resetBin()
  // TITLED gets a real log head; UNTITLED keeps the unreadable stub, so one row
  // exercises the cache read and the other the "head unreadable" fallback.
  await rm(join(ROOT, PROJECT, TITLED), { recursive: true, force: true })
  await seed(TITLED, { log: { name: 'session.v4.jsonl', bytes: logLine(header(TITLED, { cwd: 'C:/demo' })) } })
  await seed(UNTITLED)
  await seed(ORPHAN_TITLED)
  await seed(ORPHAN_PLAIN)
  await call(route(), 'move', { sessionId: TITLED })
  await call(route(), 'move', { sessionId: UNTITLED })
  const listed = await call(route(), 'list', {})
  const byId = new Map((listed.body.value?.pending ?? []).map((entry) => [entry.id, entry]))
  check('a binned session reports the title its cache record holds',
    byId.get(TITLED)?.title === 'A titled session', JSON.stringify(byId.get(TITLED)))
  check('a binned session with no readable head and no cache record reports an empty title, not an error',
    byId.get(UNTITLED)?.title === '', JSON.stringify(byId.get(UNTITLED)))
  const orphanById = new Map((listed.body.value?.orphans ?? []).map((entry) => [entry.id, entry]))
  check('an orphan reports its cached title too',
    orphanById.get(ORPHAN_TITLED)?.title === 'A titled orphan', JSON.stringify(listed.body.value?.orphans))
  check('an orphan with no cache record keeps an empty title and is still listed',
    orphanById.has(ORPHAN_PLAIN) && orphanById.get(ORPHAN_PLAIN).title === '',
    JSON.stringify(listed.body.value?.orphans))
  // The read stays the narrow shape it always was: the two known keys, through
  // the cache's own listing face, and nothing else — the fake exposes no write
  // at all, so any write attempt would have degraded every title to ''. The
  // unreadable-head row is *not* asked about: there is no lifecycle witness to
  // hand the cache, so the read is skipped rather than guessed.
  check('every title read asks for the same two keys through cachedSnapshot, and a headless row is never asked about',
    asked.length === 3
      && asked.every((call) => call.keys === 'title+sessionListMetadata')
      && asked.some((call) => call.id === TITLED)
      && !asked.some((call) => call.id === UNTITLED),
    JSON.stringify(asked))

  // The client half's rule, executed straight out of client.js with a two-line
  // loader shim: no browser, no React render, both branches covered.
  let loaded
  globalThis.window = { __ModuleLoader__: { load: (definition) => { loaded = definition } } }
  await import(pathToFileURL(CLIENT).href)
  const client = loaded.factory((name) => (name === 'react' ? { createElement: () => ({}) } : undefined))
  check('the client shows the title, with the id as the secondary line',
    JSON.stringify(client.rowLabel({ id: TITLED, title: 'A titled session' }))
      === JSON.stringify({ primary: 'A titled session', secondary: TITLED }),
    JSON.stringify(client.rowLabel({ id: TITLED, title: 'A titled session' })))
  check('the client falls back to the session id whenever the title is missing or blank',
    JSON.stringify(client.rowLabel({ id: UNTITLED, title: '' })) === JSON.stringify({ primary: UNTITLED, secondary: null })
      && JSON.stringify(client.rowLabel({ id: UNTITLED })) === JSON.stringify({ primary: UNTITLED, secondary: null })
      && JSON.stringify(client.rowLabel({ id: UNTITLED, title: '   ' })) === JSON.stringify({ primary: UNTITLED, secondary: null }),
    JSON.stringify([client.rowLabel({ id: UNTITLED, title: '' }), client.rowLabel({ id: UNTITLED }), client.rowLabel({ id: UNTITLED, title: '   ' })]))
}
// -------------------------------------------------------------------- verdict
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
await rm(SANDBOX, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)
