### Task 5: InstanceInstallService GetAllActiveStates

**Files:**
- Modify: `src-backend/Qomicex.Launcher.Backend/Services/InstanceInstallService.cs:80`

**Interfaces:**
- Produces: `InstanceInstallService.GetAllActiveStates()` → `List<InstallState>`

- [ ] **Step 1: Add GetAllActiveStates method**

Add after `GetState` method (after line 80):

```csharp
    public List<InstallState> GetAllActiveStates()
    {
        return _tasks.Values
            .Where(t => !t.IsCompleted && t.Stage != "completed" && t.Stage != "cancelled" && t.Stage != "failed")
            .Select(t => new InstallState
            {
                InstanceId = t.InstanceId,
                Stage = t.Stage,
                Progress = t.Progress,
                Error = t.Error,
                TotalFiles = t.TotalFiles,
                CompletedFiles = t.CompletedFiles,
                FailedFiles = t.FailedFiles,
                CurrentFile = t.CurrentFile,
                Speed = t.Speed,
                IsPaused = t.IsPaused,
            })
            .ToList();
    }
```

- [ ] **Step 2: Verify build**

Run: `dotnet build src-backend/Qomicex.Launcher.Backend/Qomicex.Launcher.Backend.csproj`
Expected: Build succeeded.

- [ ] **Step 3: Commit**

```bash
git add src-backend/Qomicex.Launcher.Backend/Services/InstanceInstallService.cs
git commit -m "feat(install): add GetAllActiveStates to InstanceInstallService"
```

---

