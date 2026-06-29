## Task 6 Report

### Summary

Added frontend TypeScript DTOs for Java download catalog/start/progress flows in `src/types/index.ts`, and added matching API helper functions in `src/api/java.ts`.

### Files Changed

- `src/types/index.ts`
- `src/api/java.ts`

### Details

#### `src/types/index.ts`

Added these exported interfaces after `JavaRuntime`:

- `JavaDownloadVendorInfo`
- `JavaDownloadCatalogResponse`
- `JavaDownloadStartRequest`
- `JavaDownloadStartResponse`
- `JavaDownloadProgressResponse`

#### `src/api/java.ts`

Extended the type import from `../types/index.ts` and added these API helpers:

- `getJavaDownloadCatalog()`
- `startJavaDownload(body)`
- `getJavaDownloadProgress(taskId)`
- `cancelJavaDownload(taskId)`

All local imports retain the required `.ts` file extension.

### Verification

Run:

```bash
npx tsc --noEmit
```

Expected result: no TypeScript errors.

### Self Review

- Change scope matches the task brief exactly.
- No unrelated files were modified.
- API paths and request/response types match the provided contract.
