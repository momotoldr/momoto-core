# Momoto Backend — Puzzle Together (jigsaw)

Plan for the backend half of the second activity: **Puzzle Together**, a jigsaw two
people solve in one room, side by side on video. The frontend half — geometry,
rendering, drag, the room shell — lives in `../momoto/PLAN-puzzle.md`; this doc is the
API and the wire contract it consumes.

**Legend:** DoD = Definition of Done.

## Concept

- **Rooms become typed.** A room code is currently activity-blind: `POST /rooms` mints
  a code, `GET /rooms/:id` reports joinability, and the FE assumes "booth". A puzzle
  room needs a different session length, a different body, and a different landing
  route for someone who pastes the code into a join box. So `RoomState` gains an
  `activity` field, minting takes one, and the lookup returns it.
- **The puzzle is the first state the server *interprets*.** Every existing relay
  (`strip:arrange`, `peer:announce`) is forwarded verbatim — the server never reads the
  payload. That works because the host is the single author of the strip design. A
  jigsaw has two authors touching one board at the same time, so something has to
  arbitrate: who is holding piece 14, and did that drop actually land in its slot.
- **Why the server and not the host.** Host-authoritative would be cheaper, but the
  established rule is that *a peer drop must never end the session* — whoever is left
  carries on. Under host authority, the host closing their tab would take the entire
  board with it and leave the guest holding nothing. The server already outlives both
  sockets (it owns the room and the session window), so it is the natural holder.
- **Locks and commits are authoritative; motion is a relay.** Grab and drop mutate
  server state (a few floats). The drag itself — the high-frequency part — is forwarded
  to the other member and never stored. This keeps per-room work at roughly the level
  of `strip:arrange` today.
- **Coordinates on the wire are normalized, never pixels.** A piece position is
  `{x, y}` relative to the finished board rect (`0..1` inside it, roughly `-0.6..1.6`
  in the scatter margin). Two people on a laptop and a phone then agree about where a
  piece is without either side knowing the other's viewport.
- **Nothing here is persisted.** A finished puzzle is a moment, not an artifact: no
  Postgres, no R2, no cart or gallery implications. Puzzle state lives in the room and
  dies with it, exactly like the session window.

## State model

```ts
// src/rooms/puzzleState.ts
interface PuzzlePiece {
  /** Normalized board coords of the piece's top-left. */
  x: number
  y: number
  /** Snapped home and immutable once true. */
  placed: boolean
  /** Socket id currently dragging it, or null. */
  heldBy: string | null
  /** When the hold started — locks expire (see LOCK_TTL_MS). */
  heldAt: number
}

interface PuzzleState {
  /** FE-owned visual seed: drives the tab/blank edge shapes. The server never
   * interprets it, it only mints it so both clients cut identical pieces. */
  seed: number
  rows: number
  cols: number
  /** Opaque FE image id (a preset key). The server stores, never resolves it. */
  imageId: string
  pieces: PuzzlePiece[]
  startedAt: number
  completedAt: number | null
}
```

`RoomState` gains `activity: 'photobooth' | 'puzzle'` and `puzzle: PuzzleState | null`.
Both die with `endSession`, so the existing sweepers need no changes.

**Lock TTL.** A hold is released on drop, on disconnect, and otherwise after
`LOCK_TTL_MS = 10_000`. Without the TTL, a client that grabs a piece and then freezes
(backgrounded tab, dead wifi before the socket notices) leaves that piece unreachable
to the other person for the rest of the session.

**Placed is final.** A placed piece rejects grabs. This is the same instinct as
"a finalized strip ignores peer resets": once the board has a correct piece in it,
nothing another client sends may knock it back out.

## Wire contract (added to `src/types/events.ts`, mirrored byte-for-byte in the FE)

| Event | Dir | Payload | Effect |
| --- | --- | --- | --- |
| `puzzle:setup` | C→S→peer | `{ imageId, difficulty }` | Host's pre-start pick, relayed verbatim (no server state yet). Re-emitted by the host on `room:peer-joined`, like `strip:arrange`. |
| `puzzle:start` | C→S | — | Builds `PuzzleState` (seed, scatter) and broadcasts `puzzle:state`. Ignored if one is already running. |
| `puzzle:state` | S→C | `{ seed, rows, cols, imageId, pieces, startedAt, completedAt }` | Full snapshot: on start, on rejoin, and as the correction path after any rejected action. |
| `puzzle:grab` | C→S | `{ pieceId }` | Locks the piece if free and unplaced. |
| `puzzle:grabbed` | S→C (room) | `{ pieceId, by }` | Lock granted. Silence = refused (the client rolls back). |
| `puzzle:move` | C→S | `{ pieceId, x, y }` | Holder-only. **Relayed, not stored.** |
| `puzzle:moved` | S→peer | `{ pieceId, x, y, by }` | The other person's live drag. |
| `puzzle:drop` | C→S | `{ pieceId, x, y }` | Commits position, runs the snap test, releases the lock. |
| `puzzle:placed` | S→C (room) | `{ pieceId, x, y, placed, by }` | The authoritative resting position. |
| `puzzle:released` | S→C (room) | `{ pieceId }` | Lock dropped without a commit (TTL, disconnect). |
| `puzzle:complete` | S→C (room) | `{ elapsedMs, at }` | Last piece landed. |

`SocketData` gains nothing — the holder check reads `piece.heldBy === socket.id`.

**Membership is the whole authorization check**, as it is for the sync handlers today:
`roomId` comes from `socket.data.roomId`, never from the payload. Both members may
start and both may move pieces — that is the point of the activity — so nothing here is
host-restricted at the server.

## Snap rule (duplicated in both repos, like the events contract)

```ts
// src/rooms/puzzleRules.ts — mirrored at momoto/src/features/puzzle/puzzleRules.ts
export const SNAP_TOLERANCE = 0.35 // fraction of one piece's width/height

export function homeOf(index: number, rows: number, cols: number) {
  return { x: (index % cols) / cols, y: Math.floor(index / cols) / rows }
}

export function snaps(index: number, x: number, y: number, rows: number, cols: number) {
  const home = homeOf(index, rows, cols)
  return (
    Math.abs(x - home.x) <= SNAP_TOLERANCE / cols &&
    Math.abs(y - home.y) <= SNAP_TOLERANCE / rows
  )
}
```

Kept pure and tiny on purpose. The client runs it too, so a drop snaps instantly
instead of after a round trip; the server's answer is what stands if they disagree.
Any change to the tolerance lands in both files in lockstep — same rule as
`types/events.ts`.

---

## Phase B0 — Typed rooms

**Goal:** a room code knows which activity it belongs to, and carries the matching
session length.

**Tasks**
- `config/env.ts`: `puzzleSessionDurationMs` (`PUZZLE_SESSION_DURATION_MS`, default
  `600_000` — 10 minutes; a 24-piece board takes two people 4–8). Add it to the paired-
  value note in the FE env doc: it must equal the FE's `PUZZLE_SESSION_SECONDS`.
- `rooms/roomStore.ts`: `RoomState.activity`; `createRoom(activity)`; `getStatus`
  returns `{ status, activity }`; `startWindow` takes the duration from the room's
  activity rather than a single constant.
- `http/routes/rooms.ts`: `POST /rooms` accepts `{ activity }` (default
  `'photobooth'` so an old client keeps working); `GET /rooms/:id` returns the activity
  alongside the status — `not_found` returns `activity: null`.
- `rooms/sessionManager.ts`: `handleWindowOnJoin` picks the duration per activity.

**DoD:** minting with `{activity:'puzzle'}` yields a code whose lookup reports
`puzzle`; both room types run their own window length; the photobooth path is
byte-identical to before when `activity` is omitted.

## Phase B1 — Puzzle state + start

**Goal:** a room can hold a board.

**Tasks**
- `rooms/puzzleState.ts`: the model above, plus `createPuzzle(rows, cols, imageId)` —
  mints a seed and a deterministic scatter (mulberry32 over the seed) placing every
  piece in the margin around the board, none overlapping its own home.
- `rooms/puzzleRules.ts`: `homeOf`, `snaps`, `SNAP_TOLERANCE`.
- `types/events.ts`: the events + payloads above, in both repos.
- `socket/handlers/puzzleHandlers.ts`: `puzzle:setup` relay, `puzzle:start` →
  build + broadcast `puzzle:state`.
- `socket/server.ts`: register the handlers.
- On `room:join`, if the room has a puzzle, send that socket a `puzzle:state`
  snapshot — this is the whole reconnect story, and it is free because the state is
  server-side.

**DoD:** two sockets in a puzzle room, one emits `puzzle:start`, both receive the same
snapshot; a third connection replacing a dropped one receives the current board, not a
fresh one.

## Phase B2 — Grab / move / drop

**Goal:** the board actually moves, and two people can't fight over one piece.

**Tasks**
- `puzzle:grab`: refuse if `placed`, or if `heldBy` is another live socket whose hold is
  inside `LOCK_TTL_MS`. Otherwise set the hold and broadcast `puzzle:grabbed`.
  Refusal is **silence** — the grabbing client rolls its optimistic pick-up back.
- `puzzle:move`: holder-only, bounds-checked, relayed to the peer. No write.
- `puzzle:drop`: holder-only. Run `snaps()`: on a hit, write the exact home and
  `placed: true`; otherwise write the dropped position. Clear the hold, broadcast
  `puzzle:placed`. If every piece is placed, set `completedAt` and broadcast
  `puzzle:complete`.
- `disconnect`: release every piece this socket holds and broadcast `puzzle:released`
  for each — but only when the socket is a *real* leave. A superseded socket (the
  reconnect case `roomStore.leave` already reports as `null`) must not drop the locks
  its own replacement may have taken.

**DoD:** a piece held by A cannot be grabbed by B; a drop within tolerance lands
exactly on the home for both clients; killing A's tab mid-drag frees the piece for B
within a second; the last piece emits exactly one `puzzle:complete`.

## Phase B3 — Hardening

**Goal:** the same standard as the existing socket surface.

**Tasks**
- `socket/validate.ts`: `isPuzzleSetup`, `isPuzzleAction` (`pieceId` an integer in
  `[0, LIMITS.pieces)`, `x`/`y` finite in `[-2, 3]`), `LIMITS.pieces = 64`,
  `LIMITS.puzzleImageIdLen = 64`. Difficulty is validated against the allowed
  `rows × cols` set — this is one of the few payloads whose *domain* the server must
  check, since it sizes an allocation.
- `socket/rateLimits.ts`: `puzzleMoveLimiter` (60 / 1s — a rAF-throttled drag emits
  ~30/s and two hands never share one socket), `puzzleActionLimiter` (20 / 1s for
  grab/drop/start). Both into `socketLimiters` for the sweep.
- Structured logs: `puzzle.start`, `puzzle.complete` (with `elapsedMs`, piece count),
  `puzzle.grab.refused`, `puzzle.ratelimited`.

**DoD:** malformed and oversized payloads are ignored, never thrown on; a flooding
client is capped without affecting its peer; `npm run typecheck` + `lint` clean.

## Phase B4 — Admin / ops visibility *(small, optional)*

- `roomStore.stats()` gains a per-activity breakdown, so the admin console's room count
  can say how many of each are live.

## Verification

- Two browser tabs against a local server: start, drag, snap, complete.
- Kill one tab mid-drag → the piece frees; reopen on the same code → the board comes
  back intact with the remaining time.
- Let the window expire mid-puzzle → both are closed out by `session:expired` exactly
  as the booth is, and the code is retired.
- `curl -X POST /rooms -d '{"activity":"puzzle"}'` then `GET /rooms/:id` → reports
  `open` + `puzzle`.

## Non-goals (v1)

- No persistence of a completed puzzle, no cart/gallery/payment surface.
- No server-hosted puzzle images: `imageId` is an opaque key to an FE static asset.
  User-uploaded / own-strip images are a later phase (they need signed URLs both
  members can read — see the FE plan's open questions).
- No spectators or rooms larger than two: `ROOM_CAPACITY` stays 2.
- No Redis. Puzzle state is in-memory alongside the room, and follows it whenever the
  room store moves (the existing Phase 5 scale note).
