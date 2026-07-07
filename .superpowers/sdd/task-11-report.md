# Task 11 Report: Connect 页面 — 完整 UI

## What I Implemented
Replaced the placeholder `src/pages/Connect.tsx` with the full 联机 page:
- Two bordered `Card` panels: **创建房间** (two modes: 手填端口 / 选择实例) and **加入房间** (room code).
- Player list (`PlayerList` + `PlayerRow`) showing avatar (base64 or initial fallback) + name (+ 房主 badge) + vendor.
- Status polling every 3s via `setInterval` when `mode !== 'idle'`, with cleanup on unmount / mode change.
- Host-by-port, host-by-instance, join, and leave/close handlers with busy state and error toasts.
- Copy-to-clipboard for room code (host) and server address (guest).

## UI-Component-Prop Deviations from the Brief
**None of the component prop assumptions were wrong.** All verified against real components:
- `Card` (`card.tsx`): named export, forwards `className` via `cn()`. ✔ matches brief.
- `Button` (`button.tsx`): `variant` includes `default/outline/ghost/destructive/secondary/link`, `size` includes `sm/default/lg/icon`. ✔ all used variants (`default/outline/ghost/destructive`) and `size="sm"` exist.
- `Select`/`SelectOption` (`select.tsx`): `Select` takes `value: string` + `onChange: (value: string) => void`. ✔ brief's `onChange={setSelectedInstance}` is correct (receives value, not event).
- `Input` (`input.tsx`): standard input, `onChange` receives event. ✔
- `Label` (`label.tsx`): standard label with children. ✔
- `useMessageBox` (`message-box.tsx`): returns `{ alert, confirm, choose, error, success, prompt, notify }` — `error` exists, so `{ error: msgError }` is valid. ✔
- `ApiError` (`client.ts`): has `displayMessage` getter. ✔
- APIs (`connector.ts`) `hostByPort/hostByInstance/joinRoom/getStatus/leave`, `getInstances` (`instance.ts`), and types `ConnectorStatus/ConnectorPlayer/GameInstance` — all match signatures used. ✔

### Intentional cleanups (per task instructions, to satisfy strict TS)
1. Removed the dead line `{idle === false && !isHost && !isGuest && null}` — it always rendered nothing.
2. Removed the now-unused `const idle = status.mode === 'idle'` declaration (would trigger `noUnusedLocals`).
3. Moved `PlayerList`/`PlayerRow` helper definitions **above** the `Connect` component (declaration order clarity; functions are hoisted anyway, but keeps it clean).

## Build Result
`npm run build` (tsc strict + vite build) **PASSED** — built in ~15.7s. Only pre-existing warnings (dynamic-import chunking, chunk size >500kB); zero type/unused errors.

## Files Changed
- `src/pages/Connect.tsx` (placeholder → full page, 208 insertions).

## Self-Review Findings
- All local imports include `.ts`/`.tsx` extensions. ✔
- No unused locals/params (removed `idle`; every import used). ✔
- Player list shows avatar + name + vendor. ✔
- Both host modes (port / instance) implemented and switchable. ✔
- Polling cleanup via `clearInterval` on unmount / mode change. ✔
- No internal `<a>` nav needed (page has none). ✔

## Concerns
- Minor: the 3s poll effect only starts when leaving `idle`; the initial `refreshStatus()` on mount is a one-shot, so if another client changes state while this client is idle it won't reflect until an action. This matches the brief's design intent; not a defect.
