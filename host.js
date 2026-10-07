/**
 * dsh-plugin-session-purge — Host half.
 *
 * DSH ships no way to remove a session: it can be archived, never deleted
 * (`dsh-client-ui-workspace` README, "Known Limitations and Deferred Work").
 * This bundle adds exactly one Host operation that removes a session for good,
 * and the two callers that reach it:
 *
 *   - the exact Host Fetch route `/api/session-purge`, which the Client half
 *     calls from the sidebar Session "..." menu, and
 * The Host half registers exactly one thing: that route. There is no agent-facing
 * tool — the user asked for a plugin, and a model-callable delete would be a
 * second door nobody asked for.
 *
 * What "for good" removes, per session:
 *   1. its workspace accounting — every Workspace's `sessionIds`, plus the
 *      registry-global archive and pin sets — through the registry's own API,
 *      so the durable record is rewritten by its owner instead of by us;
 *   2. its projection-cache record through the storage domain's own table
 *      (`session_projcache` / `sessions`), so the cache cannot outlive the log;
 *   3. its session directory under the configured persistence root, which
 *      holds every generation of the append-only log.
 *
 * Deliberately NOT removed:
 *   - attachment bytes: the store is content-addressed and shared by every
 *     session that referenced the same image or file;
 *   - the derived search index: it reconciles from the persistence listing and
 *     drops the rows of any log it can no longer see.
 *
 * Safety, in order of the checks the caller gets back:
 *   - the session the call itself came from is refused;
 *   - an unresolvable session storage root is refused rather than guessed at;
 *   - a session that is live in this process (open in a pane, running a turn,
 *     owned by an agent) is stopped and evicted before anything moves — one
 *     target at a time, subagent sessions included — so the write handle is
 *     released here instead of at process exit. Liveness is therefore reported
 *     on the plan (`live`) and acted on by `execute`, not refused by `survey`.
 *
 * Orphans: a hidden subagent session whose parent is no longer in the session
 * root has no sidebar row, and the parent's dialog was the only surface that
 * ever named it — with the parent gone, nothing in the UI can reach it. `list`
 * reports those under `orphans` so the recycle-bin panel can offer each one on
 * its own, and `plan`/`move` take one like any other session: same two-step
 * delete (bin now, real deletion on the next start), same restore. The exact
 * definition, and why the bin needs no separate case, is on `orphanSessions`.
 *
 * The Host half imports nothing from the dsh installation: every collaborator
 * is reached as a Cordis service, so activation stays independent of module
 * resolution outside this package.
 *
 * @module dsh-plugin-session-purge
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { createZstdDecompress } from 'node:zlib'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * Exact Fetch route this plugin owns on the admitted `/api` carrier.
 *
 * Registration goes through `connection.fetch`, not `connection.rpc.handle`:
 * the channel registry mounts its route with `owner.webServer`, and the
 * context that reaches that owner is the Connection service's own, which no
 * third-party plugin can widen. The exact-route registry only fills a table
 * the already-mounted `/api` route consults, so one registration is enough.
 */
const ROUTE = '/api/session-purge'
/** Cache domain and table the projection cache persists itself under. */
const CACHE_DOMAIN = 'session_projcache'
const CACHE_TABLE = 'sessions'
/**
 * The recycle bin, under the harness home.
 *
 * A delete is two steps now: the session directory is *moved* here — so the row
 * leaves the sidebar while every byte stays recoverable — and the next start
 * really deletes what the bin holds, when no write handle can hold a file back.
 *
 * The bin *is* the pending list: a session id is the directory name and its
 * project directory is the parent, so neither a central manifest nor per-session
 * side files are needed.
 */
const TRASH_ROOT_NAME = 'session-purge-trash'
/** How many purged ids stay in memory for the page to clean up after. */
const LAST_PURGED_CAP = 50
/** Session ids are filesystem path segments here; keep them boring. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/

/**
 * Host services this plugin needs before it may activate.
 */
export const inject = ['connection', 'sessionPersistence', 'workspaceRegistry']

/**
 * Insert the Session Delete row.
 * @param ctx - the bundle row's Host context.
 */
export function apply(ctx) {
  const deleter = new SessionPurger(ctx)
  // One exact route on the shared `/api` carrier: by the time this handler
  // runs, Connection has already applied its Host/Origin fence and browser
  // authentication to the request.
  // Wrapped in an effect so the route is torn down with this plugin's own fiber
  // when the bundle is unloaded, instead of outliving it until the next start.
  ctx.effect(
    () => ctx.connection.fetch.register({
      path: ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => deleter.respond(request),
    }),
    'session-purge: fetch route',
  )
  // Everything earlier runs moved into the recycle bin is deleted here, before
  // any session can be opened again. Deliberately not awaited: activation must
  // not wait on file removal.
  void deleter.purgePending().catch((error) => ctx.logger?.warn?.('session-purge: start-up purge failed', error))

}

/** One JSON response for the exact route. */
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

/** One RPC failure in the shared channel's envelope shape. */
function fail(code, message, details = {}) {
  return { ok: false, error: { code, message, details } }
}

/** One successful RPC result. */
function ok(value) {
  return { ok: true, value }
}

/** A readable message from anything thrown. */
function reason(error) {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

/** The session-purge operation, owned by the plugin context. */
class SessionPurger {
  constructor(ctx) {
    this.ctx = ctx
  }

  /**
   * One HTTP call on this plugin's exact route.
   *
   * The body is `{ endpoint, payload }`; the answer is the same envelope the
   * one shape for every endpoint. A malformed body is the
   * only case that answers a non-200 status, because anything else the caller
   * can act on travels in the envelope.
   *
   * @param request - the admitted Fetch request.
   * @returns the JSON response.
   */
  async respond(request) {
    let body
    try {
      body = await request.json()
    } catch {
      return jsonResponse(fail('session-purge/bad-request', 'the request body is not JSON'), 400)
    }
    if (body === null || typeof body !== 'object') {
      return jsonResponse(fail('session-purge/bad-request', 'the request body must be a JSON object'), 400)
    }
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint : ''
    return jsonResponse(await this.handle(endpoint, body.payload))
  }

  /**
   * One operation call, from either caller.
   * @param endpoint - `plan` or `delete`.
   * @param payload - the caller's request object.
   * @returns the shared result envelope.
   */
  async handle(endpoint, payload) {
    const request = payload !== null && typeof payload === 'object' ? payload : {}
    try {
      if (endpoint === 'plan') {
        const surveyed = await this.survey(request)
        return surveyed.ok === false ? fail(surveyed.code, surveyed.message, surveyed.details) : ok(surveyed.plan)
      }
      if (endpoint === 'move') {
        const surveyed = await this.survey(request)
        if (surveyed.ok === false) return fail(surveyed.code, surveyed.message, surveyed.details)
        return ok(await this.execute(surveyed.plan))
      }
      if (endpoint === 'list') {
        return ok({
          pending: await this.scanBin(),
          lastPurged: this.lastPurged ?? [],
          trashRoot: this.trashRoot(),
          // The one surface that can still name a hidden subagent session whose
          // parent left the session root; the panel offers each id on its own.
          orphans: await this.orphanSessions(),
        })
      }
      if (endpoint === 'restore') {
        const pending = await this.scanBin()
        const entry = pending.find((candidate) => candidate.id === request.sessionId)
        if (entry === undefined) return fail('session-purge/not-binned', `the recycle bin holds no session ${JSON.stringify(request.sessionId)}`)
        const restoredTo = await this.restore(entry)
        return ok({ sessionId: entry.id, restoredTo })
      }
      if (endpoint === 'empty') {
        const pending = await this.scanBin()
        const errors = []
        for (const entry of pending) {
          errors.push(...await this.purgeEntry(entry))
        }
        await this.pruneEmptyProjects()
        return ok({ purged: pending.map((entry) => entry.id), errors })
      }
      return fail('session-purge/unknown-endpoint', `unknown endpoint ${JSON.stringify(endpoint)}`)
    } catch (error) {
      return fail('session-purge/failed', reason(error))
    }
  }

  /**
   * Every session header the persistence layer can currently see, by id.
   *
   * This is the session *root* catalog: a directory that was moved into the
   * recycle bin is no longer part of it, which is what makes "the parent is in
   * the bin" and "the parent was deleted for real" the same observation.
   *
   * @returns a `Map` from session id to its log header.
   */
  async sessionHeaders() {
    const headers = new Map()
    for (const snapshot of await this.ctx.sessionPersistence.list()) {
      const header = snapshot?.header
      if (header !== undefined && typeof header.id === 'string') headers.set(header.id, header)
    }
    return headers
  }

  /**
   * Hidden subagent sessions whose parent is no longer in the session root.
   *
   * The definition is exactly two conditions and nothing more:
   *   1. the header's `origin` is `'subagent'` — the hidden children a session's
   *      own delete flow offers as an optional bundle, which never get a row;
   *   2. the `parentSession` that names its owner is absent from the catalog
   *      (or empty, in which case no parent could ever name it either).
   *
   * "Absent from the catalog" is deliberately the only test for the parent: the
   * bin lives under the harness home, not under the session root, so moving the
   * parent there and deleting it for real both take it out of the catalog. One
   * test covers both, so there is no "the parent is in the bin" case — and no
   * second place that could disagree with the first.
   *
   * These are the sessions nothing else can reach: hidden ones have no sidebar
   * row, the parent's dialog was the only surface that ever named them, and a
   * parent already out of the root cannot open that dialog again. Without this
   * list they stay on disk with no way to select them.
   *
   * @returns the orphan ids, oldest first.
   */
  async orphanSessions() {
    const headers = await this.sessionHeaders()
    const orphans = []
    for (const header of headers.values()) {
      if (header.origin !== 'subagent') continue
      const parent = typeof header.parentSession === 'string' ? header.parentSession : ''
      if (parent !== '' && headers.has(parent)) continue
      orphans.push({ id: header.id, createdAt: typeof header.createdAt === 'number' ? header.createdAt : 0 })
    }
    orphans.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    return orphans.map((orphan) => orphan.id)
  }

  /**
   * Resolve what a delete would touch, and refuse anything unsafe.
   * @param request - `sessionId`, optional `includeSubagents`, `callerSessionId`.
   * @returns `{ ok: true, plan }` or a refusal.
   */
  async survey(request) {
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId.trim() : ''
    if (sessionId === '') return { ok: false, code: 'session-purge/invalid-request', message: 'sessionId is required', details: {} }
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return { ok: false, code: 'session-purge/invalid-request', message: `sessionId is not a plain session id: ${JSON.stringify(sessionId)}`, details: {} }
    }

    const headers = await this.sessionHeaders()
    if (!headers.has(sessionId)) {
      return { ok: false, code: 'session-purge/unknown-session', message: `session persistence holds no session ${sessionId}`, details: {} }
    }

    const includeSubagents = request.includeSubagents === true
    const targets = [headers.get(sessionId)]
    if (includeSubagents) targets.push(...descendants(headers, sessionId))

    // A session that is merely *open* is no longer an obstacle: `execute`
    // stops its work and evicts its in-memory entry before touching any file,
    // which releases the write handle here instead of at process exit. Only
    // the caller's own session stays off limits.
    const live = new Set(targets.filter((header) => this.isLive(header.id)).map((header) => header.id))

    const callerSessionId = typeof request.callerSessionId === 'string' ? request.callerSessionId : undefined
    if (callerSessionId !== undefined && targets.some((header) => header.id === callerSessionId)) {
      return {
        ok: false,
        code: 'session-purge/caller-session',
        message: 'refusing to delete the session this operation is running in',
        details: { callerSessionId },
      }
    }

    const sessionsRoot = this.sessionsRoot()
    if (sessionsRoot === undefined) {
      return {
        ok: false,
        code: 'session-purge/no-sessions-root',
        message: 'cannot locate the session storage root (neither sessionPersistence.root nor DSH_HOME is available), so deletion was refused rather than guessed',
        details: {},
      }
    }

    const planned = []
    for (const header of targets) {
      planned.push({
        id: header.id,
        cwd: typeof header.cwd === 'string' ? header.cwd : null,
        origin: typeof header.origin === 'string' ? header.origin : null,
        createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
        directories: await locateDirectories(sessionsRoot, header.id),
        live: live.has(header.id),
      })
    }

    return {
      ok: true,
      plan: {
        sessionId,
        sessionsRoot,
        includeSubagents,
        targets: planned,
        subagentCount: planned.length - 1,
      },
    }
  }

  /**
   * Perform one surveyed plan: accounting, cache, then log directories.
   * @param plan - the value `survey` returned.
   * @returns the per-session report the caller shows.
   */
  async execute(plan) {
    const report = { sessionId: plan.sessionId, sessionsRoot: plan.sessionsRoot, sessions: [], notes: [] }

    for (const target of plan.targets) {
      const record = {
        id: target.id,
        workspaces: [],
        unarchived: false,
        unpinned: false,
        moved: [],
        workspaces: [],
        evicted: false,
        workStopped: false,
        errors: [],
      }

      // 0. Release the process that holds this session: ask the stop providers
      //    to end its running work, then evict its in-memory store entry (the
      //    store's own teardown path, which also emits session/disposed so the
      //    sidebar drops the row). Without this the write handle stays attached
      //    until DSH exits and the files cannot be removed on Windows.
      const quiesced = await this.quiesce(target.id)
      record.workStopped = quiesced.stopped
      record.evicted = quiesced.evicted
      record.errors.push(...quiesced.errors)

      // 1. Membership is what keeps the row in the sidebar, so this is the step
      //    that makes it leave: the store eviction alone leaves it behind. The
      //    log keeps its own header, so a restore reads `cwd` back and re-attaches.
      const registry = this.ctx.get('workspaceRegistry')
      if (registry !== undefined) {
        try {
          for (const workspace of registry.list()) {
            if (workspace.sessionIds.includes(target.id)) {
              await workspace.detachSession(target.id)
              record.workspaces.push(workspace.id ?? workspace.path)
            }
          }
        } catch (error) {
          record.errors.push(`workspace registry: ${reason(error)}`)
        }
      }

      // Moving to the bin touches nothing else of the harness's own books — no workspace
      // membership, no archive flag, no pin flag, no projection cache. A restore
      // is therefore just a directory rename back; the purge does the cleaning.

      // 3. Into the recycle bin, last: once the directory is out of the
      //    sessions root the session is unreachable, yet every byte stays
      //    recoverable until the next start really deletes it.
      if (target.directories.length === 0) {
        record.errors.push('no session directory was found under the storage root (the session may never have materialized)')
      }
      for (const directory of target.directories) {
        try {
          const destination = await this.moveToTrash(directory)
          record.moved.push({ from: directory, to: destination })
        } catch (error) {
          record.errors.push(`directory ${directory}: ${reason(error)}`)
        }
      }



      report.sessions.push(record)
    }

    report.notes.push('attachments are content-addressed and shared, so they were left in place')
    report.notes.push('the derived search index reconciles itself from the persistence listing')
    return report
  }

  /** The harness home this machine's runtime state lives under. */
  harnessHome() {
    const declared = process.env.DSH_HOME
    if (typeof declared === 'string' && declared.trim() !== '') return resolve(declared)
    return join(homedir(), '.dsh')
  }

  /** The recycle bin: moved-out session directories, keyed by project directory. */
  trashRoot() {
    return join(this.harnessHome(), TRASH_ROOT_NAME)
  }

  /**
   * What the bin holds right now, derived from the directory tree alone: one
   * entry per `<project directory>/<session id>` pair. An absent bin reads as
   * empty, never as an error.
   */
  async scanBin() {
    const root = this.trashRoot()
    const pending = []
    let projects
    try {
      projects = await readdir(root, { withFileTypes: true })
    } catch {
      return pending
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue
      let sessions
      try {
        sessions = await readdir(join(root, project.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const session of sessions) {
        if (!session.isDirectory()) continue
        pending.push({ id: session.name, projectDir: project.name, cwd: null, movedAt: null })
      }
    }
    return pending
  }

  /**
   * Move one session directory out of the sessions root and into the bin.
   *
   * The project directory name is preserved verbatim, so a restore needs no
   * re-encoding: it is the same rename in the other direction. Both ends sit
   * under the harness home, so the move is instant and costs no extra space.
   */
  async moveToTrash(directory) {
    const projectDir = basename(dirname(directory))
    const destination = join(this.trashRoot(), projectDir, basename(directory))
    await mkdir(dirname(destination), { recursive: true })
    await rename(directory, destination)
    return destination
  }

  /**
   * Put one binned session back where it came from.
   *
   * Nothing durable has to be undone: the move never touched the workspace
   * membership, the archive set, the pin set, or the projection cache, so
   * putting the directory back *is* the restore — the session returns to the
   * group it left. Two things do have to be said out loud afterwards, and both
   * are read out of the log that travelled with the directory: which workspace
   * to re-attach to (`attachBack`), and that the row is back (`announceRestored`,
   * the counterpart of the removal notice `quiesce` sent on the way in).
   */
  async restore(entry) {
    const sessionsRoot = this.sessionsRoot()
    if (sessionsRoot === undefined) throw new Error('cannot locate the session storage root, so the restore was refused')
    const source = join(this.trashRoot(), entry.projectDir, entry.id)
    const destination = join(sessionsRoot, entry.projectDir, entry.id)
    await mkdir(dirname(destination), { recursive: true })
    await rename(source, destination)
    const header = await readSessionHeader(destination)
    await this.attachBack(entry.id, header)
    this.announceRestored(entry.id, header)
    return destination
  }

  /**
   * Put a restored session back into the workspace it came from.
   *
   * The session's own log carries the header (`cwd` included), and it travelled
   * with the directory into the bin — so nothing extra has to be recorded
   * anywhere: the answer is read back out of the session itself.
   *
   * @param sessionId - the restored session.
   * @param header - the header of the restored log, or `undefined`.
   * @returns whether the session was attached to a workspace.
   */
  async attachBack(sessionId, header) {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) return false
    const cwd = typeof header?.cwd === 'string' ? header.cwd : undefined
    if (cwd === undefined) return false
    try {
      const workspace = await registry.resolveByPath(cwd)
      if (workspace === undefined) return false
      if (workspace.sessionIds.includes(sessionId)) return true
      await workspace.attachSession(sessionId)
      return true
    } catch {
      return false
    }
  }

  /**
   * Tell the page that a restored session is on the list again.
   *
   * A restore is deliberately not a session creation, so the Host's own
   * `session/created` -> `api-session/added` pair can never fire for it — while
   * the move into the bin *did* send `api-session/removed`, which is exactly what
   * made the row leave. `api-session/added` is therefore the only way back: its
   * consumer upserts the summary by `sessionId`, and an id it does not know is
   * prepended as a row instead of being ignored.
   *
   * The payload is the shape the Host itself builds for a session that is not
   * live (`ApiSessionList.summarizeCold`), projections included when the cache
   * can still serve them. Nothing here creates a session or writes anything.
   *
   * @param sessionId - the restored session.
   * @param header - the header of the restored log, or `undefined`.
   * @returns whether the notice was handed to the event bus.
   */
  announceRestored(sessionId, header) {
    if (header === undefined) return false
    try {
      const projections = this.restoredProjections(header)
      const metadata = projections?.values?.sessionListMetadata
      this.ctx.emit('api-session/added', {
        sessionId,
        // `summarizeCold`'s `updatedAt(header, metadata)`, with a cache miss
        // (`lastPromptAt` absent) falling back to the log's own `createdAt`.
        updatedAt: Math.max(
          Number.isFinite(header.createdAt) ? header.createdAt : 0,
          Number.isFinite(metadata?.lastPromptAt) ? metadata.lastPromptAt : 0,
        ),
        agentAvailable: false,
        running: false,
        // `metadata?.blank ?? false`: a metadata-less cache miss stays visible.
        blank: typeof metadata?.blank === 'boolean' ? metadata.blank : false,
        ...(typeof header.parentSession === 'string' ? { parentSessionId: header.parentSession } : {}),
        ...(typeof header.origin === 'string' ? { origin: header.origin } : {}),
        ...(typeof header.cwd === 'string' ? { cwd: header.cwd } : {}),
        ...(projections === undefined ? {} : { projections }),
      })
      return true
    } catch {
      // The directory is already back where it belongs, so a notice the bus
      // refused must not turn a good restore into a failed one.
      return false
    }
  }

  /**
   * The listing projections of one restored session, read-only.
   *
   * THIS IS THE PLUGIN'S ONLY PROJECTION-CACHE READ, and it exists for exactly
   * one reason: the notice above is the only thing that puts the row back, and a
   * row without its cached title reads as untitled until the next list response.
   * The cache is otherwise untouched by design — the move must not need it, and
   * the purge deletes through the storage domain without ever reading a value.
   *
   * Three things keep the read narrow:
   *
   *   1. it goes through the cache's own listing face (`cachedSnapshot`, the
   *      zero-I/O read over the domain's in-memory table that never seeds a fold
   *      and never writes), so the record's lifecycle identity and every row's
   *      `ver` are checked by their owner — we never reinterpret a record;
   *   2. it asks for two known keys only, `title` and the list metadata the Host
   *      itself folds into a summary, instead of forwarding whatever the record
   *      holds — the payload stays this plugin's own shape rather than becoming a
   *      copy of DSH's internal record layout;
   *   3. every failure is the same answer: no cache service, no record, an
   *      unrelated lifecycle, a refused schema or a thrown read all return
   *      `undefined`, and the caller then sends exactly the notice it sent before
   *      this read existed.
   *
   * @param header - the header of the restored log (the lifecycle witness).
   * @returns the `projections` block for the notice, or `undefined`.
   */
  restoredProjections(header) {
    try {
      const cache = this.ctx.get('sessionProjectionCache')
      if (cache === undefined || typeof cache.cachedSnapshot !== 'function') return undefined
      const block = cache.cachedSnapshot(header, ['title', 'sessionListMetadata'])
        ?? cache.cachedPredecessorTitle?.(header)
      if (block === undefined || typeof block.values !== 'object' || block.values === null) return undefined
      if (Object.keys(block.values).length === 0) return undefined
      // The Host's own envelope for a listed row (`hintsOf`): a header-only read
      // serves a `cached` block whose watermark is the stored record's own, and
      // the client fills those keys only where no live frame already holds them.
      return { kind: 'cached', asOfSeq: block.asOfSeq, values: block.values }
    } catch {
      return undefined
    }
  }

  /**
   * Really delete one binned session: its directory, projection-cache record,
   * spill output — and only now the harness's own books, because while a
   * session can still be restored its membership, archive flag, and pin flag
   * must stay exactly as the user left them.
   */
  async purgeEntry(entry) {
    const errors = []
    const registry = this.ctx.get('workspaceRegistry')
    if (registry !== undefined) {
      try {
        for (const workspace of registry.list()) {
          if (workspace.sessionIds.includes(entry.id)) await workspace.detachSession(entry.id)
        }
        if (registry.archivedSessionIds.includes(entry.id)) await registry.unarchiveSession(entry.id)
        if (registry.pinnedSessionIds.includes(entry.id)) await registry.unpinSession(entry.id)
      } catch (error) {
        errors.push(`workspace registry: ${reason(error)}`)
      }
    }
    try {
      await rm(join(this.trashRoot(), entry.projectDir, entry.id), { recursive: true, force: true, maxRetries: 3 })
    } catch (error) {
      errors.push(`recycle-bin directory: ${reason(error)}`)
    }
    const table = this.ctx.get('storageDomain')?.get?.(CACHE_DOMAIN)?.table?.(CACHE_TABLE)
    if (table !== undefined) {
      try {
        await table.delete(entry.id)
      } catch (error) {
        errors.push(`projection cache: ${reason(error)}`)
      }
    }
    try {
      await removeSpillDirectories(entry.id)
    } catch (error) {
      errors.push(`spill: ${reason(error)}`)
    }
    return errors
  }

  /**
   * Drop project layers the bin no longer needs.
   *
   * Removing a session leaves its `<bin>/<project directory>/` layer behind,
   * and nothing would ever collect it — including layers stranded by an earlier
   * version. The bin root itself is kept: an empty bin must still exist.
   */
  async pruneEmptyProjects() {
    let projects
    try {
      projects = await readdir(this.trashRoot(), { withFileTypes: true })
    } catch {
      return
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const path = join(this.trashRoot(), project.name)
      try {
        if ((await readdir(path)).length === 0) await rm(path, { recursive: true, force: true })
      } catch {
        // Busy or not empty: leave it for the next pass.
      }
    }
  }

  /**
   * The start-up pass: everything earlier runs put in the bin is deleted for
   * real now. At activation no session is open yet, so no write handle can
   * hold a file back — which is the whole reason the deletion waits for it.
   */
  async purgePending() {
    const pending = await this.scanBin()
    // The page asks for these later to clear its own per-session keys, so the
    // list is kept in memory rather than on disk: nothing outlives the process.
    this.lastPurged = pending.map((entry) => entry.id).slice(-LAST_PURGED_CAP)
    if (pending.length === 0) return
    const errors = []
    for (const entry of pending) {
      errors.push(...await this.purgeEntry(entry))
    }
    await this.pruneEmptyProjects()
    if (errors.length > 0) this.ctx.logger?.warn?.(`session-purge: start-up purge reported ${errors.length} problem(s): ${errors.join('; ')}`)
    else this.ctx.logger?.info?.(`session-purge: deleted ${pending.length} binned session(s) on start`)
  }

  /**
   * Release one session's grip on this process before its files are removed.
   *
   * Two steps, each optional by construction, so a DSH version that moves
   * either surface degrades to "remove the files we can" instead of failing:
   *
   *   1. the `workspace/session-stop` providers end the session's running work
   *      — the same parallel event `archiveSession({ stopActivity })` sends,
   *      called directly so the durable archive set is never touched;
   *   2. the in-memory store entry is detached through its own teardown path,
   *      which releases the write handle and emits `session/disposed` (the
   *      event the sidebar drops the row on). This is what makes a session you
   *      have merely *opened* deletable, instead of only at process exit.
   *
   * @param sessionId - the session to release.
   * @returns which steps ran, and why any of them did not.
   */
  async quiesce(sessionId) {
    const result = { stopped: false, evicted: false, announced: false, errors: [] }
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) return result
    const wasLive = sessions.get(sessionId) !== undefined

    if (wasLive && typeof this.ctx.parallel === 'function') {
      try {
        await this.ctx.parallel('workspace/session-stop', { sessionId })
        result.stopped = true
      } catch (error) {
        result.errors.push(`stop providers: ${reason(error)}`)
      }
      // The final checkpoint and the projection-cache write-behind may still
      // flush once after the stop; let them land before the files go.
      await new Promise((settle) => setTimeout(settle, 400))
    }

    try {
      const entry = sessions.store?.get?.(sessionId)
      if (entry !== undefined && typeof entry.detach === 'function') {
        entry.detach()
        result.evicted = true
      }
    } catch (error) {
      result.errors.push(`store detach: ${reason(error)}`)
    }

    // A session that was never opened has no store entry, so the
    // `session/disposed` -> `api-session/removed` pair never fires for it and the
    // page would keep the row (it only moves group). Ask for the removal notice
    // directly: it is a pure notification — nothing is created, nothing is
    // written, and the projected cache of a real session is never touched the way
    // a synthetic `announce` would touch it.
    if (result.evicted === false) {
      try {
        this.ctx.emit('api-session/removed', sessionId)
        result.announced = true
      } catch (error) {
        result.errors.push(`removal notice: ${reason(error)}`)
      }
    }
    return result
  }

  /** Whether a session is live in this process (open, running, or agent-owned). */
  isLive(sessionId) {
    const sessions = this.ctx.get('sessions')
    if (sessions !== undefined && sessions.get(sessionId) !== undefined) return true
    const agents = this.ctx.get('agents')
    return agents !== undefined && agents.get(sessionId) !== undefined
  }

  /**
   * The configured session storage root.
   *
   * The JSONL backend exposes the root it was configured with; when that field
   * is absent (another backend, or a future version), the launcher's own
   * `DSH_HOME` naming is the only remaining source, and an unresolved root is
   * a refusal rather than a guess.
   */
  sessionsRoot() {
    const configured = this.ctx.sessionPersistence?.root
    if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured)
    const home = process.env.DSH_HOME
    if (typeof home === 'string' && home.trim() !== '') return resolve(join(home, 'sessions'))
    return undefined
  }
}

/**
 * Every hidden subagent session below one root, transitively.
 *
 * A visible child — a fork, which carries `parentSession` but no `origin` — is
 * its own session with its own life, so the walk stops there instead of
 * sweeping it up with the parent.
 */
function descendants(headers, rootId) {
  const childrenOf = new Map()
  for (const header of headers.values()) {
    if (typeof header.parentSession !== 'string') continue
    const bucket = childrenOf.get(header.parentSession)
    if (bucket === undefined) childrenOf.set(header.parentSession, [header])
    else bucket.push(header)
  }
  const found = []
  const queue = [rootId]
  while (queue.length > 0) {
    for (const child of childrenOf.get(queue.shift()) ?? []) {
      if (child.origin !== 'subagent') continue
      found.push(child)
      queue.push(child.id)
    }
  }
  return found
}

/**
 * The session directory of one id under a storage root.
 *
 * The backend's layout is `<root>/<project key>/<session id>/`; the project key
 * is a lossy human-readable encoding of the session's cwd, so the id segment is
 * what we look for rather than recomputing the key.
 */
async function locateDirectories(sessionsRoot, sessionId) {
  const found = []
  let entries
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = resolve(join(sessionsRoot, entry.name, sessionId))
    try {
      if ((await stat(candidate)).isDirectory()) found.push(candidate)
    } catch {
      // Not this project directory.
    }
  }
  return found
}

/**
 * Read one session header out of a log directory.
 *
 * Only the first line is needed, and a `.zstd` log is decompressed as a stream
 * that is destroyed the moment that line arrives — a large log never gets
 * expanded in full just to answer "which directory was this session run in?".
 *
 * @param directory - the session directory (in the bin, or back in place).
 * @returns the parsed header, or `undefined` when it cannot be read.
 */
async function readSessionHeader(directory) {
  let names
  try {
    names = await readdir(directory)
  } catch {
    return undefined
  }
  const compressed = names.find((name) => name.endsWith('.jsonl.zstd'))
  const name = compressed ?? names.find((entry) => entry.endsWith('.jsonl'))
  if (name === undefined) return undefined
  const line = await firstLine(join(directory, name), compressed !== undefined)
  if (typeof line !== 'string' || line.trim() === '') return undefined
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/** The first line of a file, optionally through a zstd decompressor. */
function firstLine(path, zstd = false) {
  return new Promise((settle) => {
    const input = createReadStream(path)
    const source = zstd ? input.pipe(createZstdDecompress()) : input
    let buffer = ''
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      input.destroy()
      settle(value)
    }
    source.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const index = buffer.indexOf('\n')
      if (index !== -1) finish(buffer.slice(0, index))
    })
    source.on('error', () => finish(undefined))
    source.on('end', () => finish(buffer === '' ? undefined : buffer))
    input.on('error', () => finish(undefined))
  })
}
/**
 * Remove every spill directory belonging to one session.
 *
 * The spill store names one directory per session after the first 12 hex digits
 * of the SHA-256 of its id, under a `dsh-spill-*` root in the OS temp
 * directory. Only directories carrying that exact name are touched, so another
 * session's spill content is never at risk.
 *
 * @param sessionId - the session whose spilled output goes.
 * @returns the directories actually removed.
 */
async function removeSpillDirectories(sessionId) {
  const suffix = createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
  const removed = []
  let roots
  try {
    roots = await readdir(tmpdir(), { withFileTypes: true })
  } catch {
    return removed
  }
  for (const root of roots) {
    if (!root.isDirectory() || !/^dsh-spill-[A-Za-z0-9]{6}$/.test(root.name)) continue
    const directory = join(tmpdir(), root.name, `session-${suffix}`)
    try {
      if (!(await stat(directory)).isDirectory()) continue
      await rm(directory, { recursive: true, force: true, maxRetries: 3 })
      removed.push(directory)
    } catch {
      // Not this session's directory, or already swept by the OS.
    }
  }
  return removed
}

