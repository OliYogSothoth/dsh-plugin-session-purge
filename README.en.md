# dsh-plugin-session-purge

English | [中文](README.md)

**Two-step session deletion.** DSH only archives sessions — the `dsh-client-ui-workspace` README says it plainly: *"No Session deletion — sessions can be archived but never deleted"*. This plugin adds deletion.

## Where it shows up

| Entry | Location | Used by |
|---|---|---|
| A **Move to recycle bin** row in the session "…" menu (order 500, after Archive) | Any session row in the sidebar | People |
| A **Recycle bin** entry at the sidebar footer, with a pending count | Sidebar footer, next to Settings | People |

There is exactly one kind of entry and **no agent tool**: the model cannot delete a session by itself — it only happens when you click.

## What gets deleted

When a session is actually deleted, three places go with it:

1. **Workspace accounting** — each Workspace's `sessionIds`, plus the global archive set and pin set. Written through WorkspaceRegistry / WorkspaceHandle.detachSession's own API; the plugin **never edits** `workspace.json` directly.
2. **Projection cache** — through the storage domain's own tables (`session_projcache` / `sessions`), `delete`, so the in-memory table and the on-disk document go together.
3. **Session directory** — `<project key>/<session id>/` under the session storage root, holding every generation of the compressed session log.

The storage root comes from `sessionPersistence.root` (the one the JSONL backend is configured with), falling back to `DSH_HOME/sessions`; **if neither resolves, deletion is refused** rather than guessing a path.

> **When**: those three are **not** cleared at the moment you click. "Move to recycle bin" only moves the directory aside (nothing is deleted, and it can be restored); the real deletion happens on the **next DSH start**. See "Two-step deletion" below.

## What is not deleted

- **Attachment bytes** — content-addressed and shared by several sessions; deleting them would take other sessions down with it.
- **Search index** — derived data; it reconciles itself against the persistence list and drops rows once the log is gone.

## Safety gates

- If the set being deleted contains **the very session the call runs in** → refused.
- If the session storage root cannot be resolved → refused, no path is guessed.
- A session that is **live** in the process (a pane is open, it is running, an agent holds it) is *not* refused. Its work is stopped and its in-memory host entry evicted **before** any file is touched — otherwise on Windows the write handle stays open until the process exits and the files simply cannot be removed. `plan` marks `live` on every target.
- Clicking "Move to recycle bin" first fetches `plan` (the directories involved, plus how many subagent sessions would be carried along), shows it in a confirmation dialog, and only then runs `move`.

**Subagent sessions**: hidden descendants with `origin: "subagent"` (invisible in the sidebar, and unreachable once the parent is gone) are **carried along by default**, and can be unticked in the confirmation dialog. **Visible forked child sessions are never carried along.**

**The ones left behind after unticking**: they have no sidebar row, and the parent's dialog is the only place that ever names them — once the parent leaves the session root, nothing in the UI can reach them again. So the recycle-bin panel has a section of its own, **"Orphaned subagent sessions (N)"**, where each can be moved to the bin individually. The test is just two conditions: `origin === 'subagent'`, and its `parentSession` is not in the session-root listing (a parent that was deleted outright and a parent sitting in the bin both show up as "not in the listing", so no third condition is needed). The semantics are exactly the same: into the bin first, deleted for good on the next start, restorable at any time (after a restore it stays hidden — it has no row).

## Implementation notes

- **The projection cache is read in exactly two places, through the same method**: `restoredProjections(header)` — ① the restore receipt carries `title` / `sessionListMetadata` (so the title is right the moment a session comes back); ② the recycle-bin listing attaches `title` to **every bin row** and **every orphaned subagent row**. Both go only through the cache's own read surface `cachedSnapshot(header, [...])`, ask only for known keys, and **never write and never seed**. When it cannot be read (service missing / no record / read throws / log header unreadable) the title is left empty as `title: ''` and the panel falls back to the **session id** (the id still shows as small grey text when a title exists). **No code outside those two places reads the projection cache.**
- **Host half** registers one exact fetch route, `api/session-purge`, on the already-ready `/api` carrier, with five endpoints: `plan` (listing only) · `move` (into the bin) · `list` (bin + orphaned subagents + their titles) · `restore` (back in place) · `empty` (delete for good right now). Riding that carrier means **authentication (Host/Origin checks + browser cookie) is already done before the handler runs**.
- **Client half** registers two things: one row in the session "…" menu (`sidebar.workspaces.session.menu.item`, order 500) and an overlay confirmation dialog (`shell.overlay`). It only `require`s `react` and loads no Harness client package; colours use `--dsw-alias-*` theme tokens only (with literal fallbacks), so a renamed token loses colour rather than breaking.

## Two-step deletion

1. **Move to recycle bin** (the moment you click the menu): stop that session's work → evict its in-memory host entry → **detach it from the workspace membership** (this is the switch that makes the sidebar row disappear) → move the **whole session directory** into the recycle bin.
   Nothing is deleted at this stage, and the archive / pin / projection cache are untouched.
2. **Delete for good** (on the next DSH start): sweep the bin → delete each directory, its projection cache, its spill overflow files, its workspace membership and its archive / pin entries, and clear this page's persistent keys that carry the session id.

The bin's listing has **exactly one source: the directories themselves** (the session id is the directory name and the original project directory is the level above), so there is no manifest file and no side-car metadata. Restore = move the directory back; `cwd` is read back from the session's own log header, and the session returns to its original workspace.

**Location**: `<DSH_HOME>\session-purge-trash\<project directory>\<session id>\` (`DSH_HOME` defaults to `~/.dsh`).

**Empty the recycle bin before uninstalling** (the panel's "Empty recycle bin" deletes for good right away). Once uninstalled no code is running any more, and the bin can only be handled by hand: deleting a directory = deleting for good; moving a session directory back to `<DSH_HOME>\sessions\<the same project directory>\` = restoring it.

## Install

**In the UI**: DSH's **Plugins** page → **Add plugin** (top right) → paste this line → **Install**:

```
https://github.com/OliYogSothoth/dsh-plugin-session-purge
```

Then **restart Harness**. This route **copies** the package into your profile, so **you do not need to keep any local directory**.

> It lives on GitHub only for now (there is no npm package name yet).

> **The agent's equivalent** (only when you have the model do it for you; `plugin_manager` is the tool DSH exposes to the model, and it goes through the **same underlying service** the UI buttons use):
> ```
> plugin_manager → install_bundle → target: github:OliYogSothoth/dsh-plugin-session-purge
> ```
> Or on the command line: `dsh plugin --profile web add github:OliYogSothoth/dsh-plugin-session-purge`

### Install from a local directory (only when you edit the source)

Take this route only if **you have changed the source and want the change live immediately**: it uses pnpm's `link:`, and your profile merely points at your source directory. So first, where that "local path" comes from:

1. **Get the repository onto your machine** (this is the step that produces the "local directory"):
   ```
   git clone https://github.com/OliYogSothoth/dsh-plugin-session-purge
   ```
2. **Paste the absolute path of the directory you just cloned** into "Plugins → Add plugin", for example:
   ```
   C:\Users\you\Documents\dsh-plugin-session-purge
   ```

> ⚠️ **Only this route needs the source directory to stay put**: the package is **not** copied into your profile, so deleting the directory disables the plugin.
> What takes effect how: `client.js` → **refresh the page**; `host.js` → **restart Harness** (reinstalling under the same name does not work).

## Uninstall

**In the UI**: DSH's **Plugins** page → find `dsh-plugin-session-purge` → **Uninstall**.

This only unmounts the plugin; it **does not** roll back sessions that were already deleted.

> **The agent's equivalent** (only when you have the model do it for you; it goes through the **same underlying service** the UI buttons use, and because it writes the profile — which persists across sessions — it asks for one escalation approval first):
> ```
> plugin_manager → remove_bundle → target: dsh-plugin-session-purge
> ```

## Files

| File | Purpose |
|---|---|
| `host.js` | Host half: the exact route (`plan` / `move` / `list` / `restore` / `empty`) |
| `client.js` | Browser half: menu row + confirmation dialog + recycle-bin panel + result toasts |
| `cordis.patch.yml` | Bundle patch: inserts this plugin's row |
| `locale/zh.json` · `locale/en.json` | Title and description on the plugin page card |
| `icon.svg` | Plugin page icon |
| `README.md` · `README.en.md` | Chinese (primary) · English |
