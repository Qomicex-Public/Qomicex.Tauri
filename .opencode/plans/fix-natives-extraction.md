# Fix LWJGL Natives Extraction on Linux

## Root Cause

Two bugs in `Qomicex.Avalonia/Qomicex.Core/`:

### Bug 1: DeleteExcept hardcodes `.dll` extension (CRITICAL)
**File:** `Qomicex.Core/Modules/Launcher/Launcher.cs:514`
```csharp
Helpers.GeneralHelper.DeleteExcept(nativesDir, ".dll"); // 删除除.dll文件外的所有文件
```
On Linux, LWJGL natives are `.so` files (e.g., `lwjgl64.so`). This line deletes everything except `.dll`, wiping out all `.so` files after extraction. The JVM then can't load `lwjgl64` → `UnsatisfiedLinkError`.

### Bug 2: CheckNatives checks wrong key for classifiers (MODERATE)
**File:** `Qomicex.Core/Modules/Helpers/Resources/LocalResourceHelper.cs:149`
```csharp
if (obj.ContainsKey("classifiers"))  // WRONG: classifiers is inside downloads
```
Should be `obj["downloads"]!.ContainsKey("classifiers")`. This means libraries that use the `downloads.classifiers` format (modern Minecraft JSON format) without a top-level `natives` key are not detected as natives.

## Changes Required

### 1. `Qomicex.Avalonia/Qomicex.Core/Modules/Launcher/Launcher.cs` (line ~514)

Replace:
```csharp
Helpers.GeneralHelper.DeleteExcept(nativesDir, ".dll"); // 删除除.dll文件外的所有文件
```

With:
```csharp
string keepExt = OperatingSystem.IsWindows() ? ".dll" : OperatingSystem.IsMacOS() ? ".dylib" : ".so";
Helpers.GeneralHelper.DeleteExcept(nativesDir, keepExt);
```

### 2. `Qomicex.Avalonia/Qomicex.Core/Modules/Helpers/Resources/LocalResourceHelper.cs` (line ~149)

Replace:
```csharp
if (obj.ContainsKey("downloads"))
{
    if (obj.ContainsKey("classifiers"))
        return true;
}
```

With:
```csharp
if (obj.ContainsKey("downloads") && ((JObject?)obj["downloads"])!.ContainsKey("classifiers"))
    return true;
```

## Verification

After fixing, the user should see:
1. Natives directory (`~/.minecraft/versions/26.2/26.2-natives/`) populated with `.so` files
2. No "no lwjgl64 in java.library.path" error
3. Minecraft launches successfully

Can verify by checking that the backend logs show natives being extracted, or by examining the `-natives` directory after a launch attempt.

## Note

Both files are in the `Qomicex.Avalonia/` submodule (`Qomicex.Core`), which is a separate repo. The backend (`src-backend/`) references this submodule via project reference, so fixing it there fixes both the Tauri frontend and the ASP.NET backend.
