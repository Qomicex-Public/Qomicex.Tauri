# Task 9 Report: 前端类型与 API 封装

## What I implemented
- Appended `ConnectorPlayer`, `ConnectorGameInfo`, `ConnectorStatus` interfaces to `src/types/index.ts` after `RoomCodeResponse` (lines 145-171).
- Created `src/api/connector.ts` with `hostByPort`, `hostByInstance`, `joinRoom`, `getStatus`, `leave`, importing `get`/`post` from `./client.ts` and `ConnectorStatus` from `../types/index.ts` (both with `.ts` extensions).

## Deviations
None. Implemented exactly per brief.

## Build result
`npm run build` (tsc && vite build) succeeded — no type errors. Only pre-existing warnings (dynamic import chunking, chunk size) unrelated to this change. Built in 10.83s.

## Files changed
- `src/types/index.ts` (modified)
- `src/api/connector.ts` (created)

## Self-review findings
- All local imports include `.ts` extension (verified `./client.ts`, `../types/index.ts`).
- Types match backend camelCase DTOs: verified against `ConnectorController.cs`:
  - `POST /connector/host/port` → `{ roomCode }` ✓
  - `POST /connector/host/instance` → `{ status }` (backend returns "hosting") ✓
  - `POST /connector/join` → `{ mcHost, mcPort }` ✓
  - `GET /connector/status` → `ConnectorStatus` ✓
  - `POST /connector/leave` → `{ status }` (backend returns "idle") ✓
- Nullable fields correctly mapped to `| null` (`roomCode`, `mcHost`, `mcPort`, `gameInfo`, `iconBase64`, `loader`, `loaderVersion`).

## Concerns
None.
