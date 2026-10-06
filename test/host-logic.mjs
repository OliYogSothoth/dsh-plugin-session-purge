#!/usr/bin/env node
/**
 * 一次性验证台架：把 dsh-plugin-session-purge 的宿主半边跑在
 * 「真实文件系统 + 假 Cordis 服务」上，验它到底删了什么、拒绝了什么。
 *
 * 目的：宿主代码每改一次都要换一个模块 URL 才能在运行中的 DSH 里生效，
 * 所以先把逻辑在这里跑通，再去装。
 *
 * 用法：node runs\session-purge-harness.mjs
 * 只写 runs\_tmp-sdel\ 这个沙箱目录，不碰 ~\.dsh\sessions\。
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const SANDBOX = join(HERE, '_tmp-sdel')
const ROOT = join(SANDBOX, 'sessions')
// The plugin keeps its recycle bin and manifest under the harness home; point
// that at the sandbox so no test can reach the real one.
process.env.DSH_HOME = SANDBOX
const PLUGIN = fileURLToPath(new URL('../host.js', import.meta.url))

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
function makeCtx({ sessions = [], agents = [], snapshots, registry, cache }) {
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
// -------------------------------------------------------------------- verdict
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
await rm(SANDBOX, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)
