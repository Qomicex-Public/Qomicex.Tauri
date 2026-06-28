# Task 2 Report: Extend Backend Java API

## Summary

- Extended `src-backend/Qomicex.Launcher.Backend/Controllers/JavaController.cs` only, as required.
- Kept `JavaHelper` search implementation unchanged.
- Did not modify frontend or `recommended` endpoint behavior.

## TDD / Failing Test Surrogate

- This repo does not contain a backend test project or test framework.
- Followed the brief's surrogate approach by documenting and verifying the missing controller surface first.
- Verified the pre-change controller only exposed `search`, `validate`, and `recommended` endpoints, with no `custom` or `list` endpoints.

## Implemented Changes

- Injected `JavaRuntimeStore` into `JavaController`.
- Extended `GET /api/java/search` to accept `mode=quick|deep`.
- Added `GET /api/java/custom` to return persisted custom runtimes.
- Added `POST /api/java/custom` to validate and persist a custom runtime through `JavaRuntimeStore.AddCustomAsync`.
- Added `DELETE /api/java/custom` to remove a persisted custom runtime through `JavaRuntimeStore.RemoveCustomAsync`.
- Added `GET /api/java/list` to return scanned + custom runtimes through `JavaRuntimeStore.GetMergedAsync`.
- Implemented strict mode parsing in controller scope only:
  - empty / omitted mode => `Quick`
  - `quick` => `Quick`
  - `deep` => `Deep`
  - any other value => `400 Bad Request` via `ApiException.BadRequest`

## Scope Decisions

- Kept `recommended` using the existing direct `JavaHelper.SearchJava()` call.
- Reused existing `JavaValidateRequest` for add/remove custom runtime payloads to avoid introducing extra DTOs.
- Left `ValidateJava` behavior unchanged.

## Verification

- Ran:
  - `dotnet build "src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj" --configuration Debug`
- Result:
  - Build succeeded.
  - 0 errors.
  - 5 pre-existing nullable warnings from `src-backend/Qomicex.Launcher.Backend/Controllers/AccountController.cs`.

## Commit

- Commit message: `feat: expand java runtime api`

## Concerns

- No automated backend tests exist in this repo, so endpoint behavior was validated by code inspection plus successful project build.
