# Running Instances Manager — Design Spec

## Problem

Currently each page that can launch a game (Dashboard, Instances, InstanceDetail) has its own
launch progress dialog and polling. The dialog blocks navigation — user must keep it open while
the game starts. Moreover, clicking the backdrop dismisses the dialog, which is undesirable
during launch. Once the game is running, there is no central place to see running instances,
monitor uptime, or kill them.

## Goals

1. Launch dialog must NOT close on backdrop click — only the X button dismisses it.
2. When game transitions to `running`, dialog auto-closes; user can freely use the app.
3. A persistent "running instances" indicator in the sidebar, always visible from any page.
4. Click/hover the indicator shows a popover with: instance name, elapsed time, stop button.
5. Game exit/crash triggers a toast notification.
6. Remove duplicated launch polling from pages; centralize in a context provider.

## Non-Goals

- No real-time push (WebSocket/SSE). Polling is sufficient for <5 concurrent instances.
- No backend changes — the existing `/api/instance/{id}/launch`, `/cancel`, `/progress` APIs
  are sufficient.
- No log monitor in the sidebar popover — keep it minimal.

## Architecture

```
App.tsx
  └─ RunningProvider                    ← context provider wraps the entire app
       └─ BrowserRouter
            └─ MessageBoxProvider
                 └─ Layout
                      ├─ Sidebar
                      │    └─ RunningInstancePopover  ← popover for running instances
                      ├─ LaunchProgressDialog          ← rendered by context, not route-dependent
                      └─ <Outlet />
```

`RunningProvider` lives **outside** `BrowserRouter` so the dialog survives navigation.

## Data Model

### RunningInstance

```ts
interface RunningInstance {
  instanceId: string
  name: string           // instance display name
  startedAt: number      // Date.now() when stage === 'running'
  stage: string          // always 'running' once registered
  processId?: number | null
}
```

### RunningContextValue

```ts
interface RunningContextValue {
  runningInstances: RunningInstance[]
  launchProgress: LaunchProgress | null   // non-null → show LaunchProgressDialog
  launchInstance: (id: string) => Promise<LaunchResult>
  cancelLaunch: (id: string) => Promise<void>
  killInstance: (id: string) => Promise<void>
}
```

## Components

### RunningProvider (`src/contexts/RunningContext.tsx`)

State:
- `runningInstances: RunningInstance[]`
- `launchProgress: LaunchProgress | null`
- `pollRefs: Map<string, number>` — polling timeout IDs per instance

`launchInstance(id)`:
1. Calls `launchInstance(id)` API
2. If `result.success === false` → return `LaunchResult` (page handles error display)
3. If success → set `launchProgress` to initial progress, start polling `GET /api/instance/{id}/launch/progress`
4. On each poll:
   - `running` stage → clear `launchProgress` (auto-close dialog), add to `runningInstances[]` with `startedAt`, poll at 5s intervals
   - `crashed`/`failed` → remove from `runningInstances`, clear `launchProgress` (if visible), show error toast
   - `completed` → cleanup, show exit toast
   - Other stages → update `launchProgress`

`cancelLaunch(id)`:
- Calls `POST /api/instance/{id}/launch/cancel`
- Clears polling, resets `launchProgress`

`killInstance(id)`:
- Calls `POST /api/instance/{id}/launch/cancel` (same endpoint kills running game)
- Removes from `runningInstances`, clears polling

On unmount: clear all polling timeouts.

### LaunchProgressDialog (`src/components/LaunchProgressDialog.tsx`)

- Uses existing `<Dialog>` component with:
  - `closeOnBackdrop={false}`
  - `closeOnEsc={false}`
- Title: "启动游戏"
- Body: same progress content as current `Instances.tsx` dialog (stage label, progress bar, message)
- Header X button: calls `cancelLaunch` (same as cancelling)
- Reads `launchProgress` from RunningContext

### RunningInstancePopover (`src/components/RunningInstancePopover.tsx`)

- Rendered inside `Sidebar.tsx`
- Trigger: sidebar icon `faPlay` (or `faGamepad`)
  - Gray with no indicator when `runningInstances.length === 0`
  - Green + pulsing dot animation when `runningInstances.length > 0`
- Popover (`<div>` positioned absolutely to the right of sidebar, not browser `popover` API):
  - List of running instances
  - Each item:
    - Instance name (clickable → navigate to `/instances/{id}`)
    - Elapsed time (updated every second via `useEffect`/`setInterval`)
    - 🛑 button: calls `killInstance(id)`
  - Empty state: "暂无运行中的游戏"
- Closes on click outside / ESC
- Uses `<Tooltip>` for icon-only button

## File Changes

### New files

| File | Lines (est.) | Purpose |
|------|-------------|---------|
| `src/contexts/RunningContext.tsx` | ~180 | Provider + context + polling logic |
| `src/components/LaunchProgressDialog.tsx` | ~80 | Global launch progress dialog |
| `src/components/RunningInstancePopover.tsx` | ~120 | Sidebar popover for running instances |

### Modified files

| File | Change |
|------|--------|
| `src/App.tsx` | Wrap `<RunningProvider>` around `<BrowserRouter>` |
| `src/components/Sidebar.tsx` | Add running indicator icon + render `RunningInstancePopover` |
| `src/pages/Dashboard.tsx` | Remove `launchProgress` state, polling, cancel. Use `context.launchInstance(id)` and `context.cancelLaunch(id)` |
| `src/pages/Instances.tsx` | Remove launch dialog markup, polling logic. Use context. Keep `ErrorReportDialog` for launch errors. |
| `src/pages/InstanceDetail.tsx` | Remove launch progress polling. Keep `ErrorReportDialog`. Use context `launchInstance` / `cancelLaunch` |

### What stays unchanged

- `ErrorReportDialog` — still used per-page for launch errors (success === false or crashed/failed)
- `src/api/client.ts` — `launchInstance`, `cancelLaunch`, `getLaunchProgress` API functions
- Backend — no changes

## Interaction Details

### Launch flow

1. User clicks "启动" on any page
2. Page calls `context.launchInstance(id)`
3. Context calls API, starts polling, shows `LaunchProgressDialog` (global, backdrop can't close)
4. Pages are still navigable — dialog floats above everything but doesn't block routing
5. Game reaches `running` → dialog auto-closes, sidebar icon turns green
6. If game crashes before running → dialog shows error, user clicks X to dismiss

### Running state

- Polling continues at 5s intervals for running instances
- Each poll: `stage === 'crashed'/'failed'` → remove + toast; `'completed'` → remove + toast
- Elapsed time computed client-side from `startedAt` timestamp
- User can kill from popover at any time

### Toast notifications

- Game crash: `notify('游戏已崩溃', 'error')`
- Game exit: `notify('游戏已退出', 'info')`
- Same toast system (`notify()` from `../hooks/useNotify.ts`)

## Error Handling

- `launchInstance` returns `LaunchResult`; page checks `result.success` for pre-launch errors
- Network error during polling → clear the instance from running list, show toast
- Cancelling already-exited process → silently ignore API error

## Testing

- Manual test: launch from Dashboard → see dialog → can't backdrop-dismiss → auto-close on running → sidebar indicator → popover shows time → kill works
- Manual test: launch from Instances → same flow
- Manual test: launch from InstanceDetail → same flow
- Manual test: start 2 instances → both appear in popover → kill one → one remains
- Manual test: game crash → toast appears, removed from list
