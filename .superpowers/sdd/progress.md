# Connect Center - Progress Ledger

Task 1: complete (commits da236ad..1a26514, verified: build succeeded, diff matches brief)
Task 2: complete (commits 1a26514..6a9d1f6, verified: build succeeded, diff matches brief, case order correct)
Task 3: complete (commits 6a9d1f6..8eef614, review clean - spec compliant, approved)
Task 4: complete (commits 8eef614..25bf8cc, review clean - approved, DONE_WITH_CONCERNS resolved)
  Minor (for final review triage):
  - GameProcessInspector.cs:158 WMI ManagementObjectCollection/ManagementObject not disposed (negligible leak)
  - GameProcessInspector.cs:183 ReadToEnd() before WaitForExit(3000) makes timeout decorative for lsof/ps
  - GameProcessInspector.cs:48 Windows only queries AF_INET (IPv4); IPv6-only listener missed (acceptable for MC LAN)
  - Linux /proc/*/fd LinkTarget resolution runtime-unverified (Windows-only build)
Task 5: complete (commits 25bf8cc..bc29338, review clean - approved)
  Minor (for final review triage):
  - ConnectorService.cs:108 GetEasyTierVersion ReadToEnd() before WaitForExit(3000) - same decorative-timeout pattern as Task 4 (low risk)
Task 6: complete (commits bc29338..50ece1d, review clean after fix)
  - Important finding FIXED: GetStatus race-safe (c354075 + 50ece1d): captures _center/_guest locals, all _iconMap access under _iconLock
  Minor (for final review triage):
  - GetStatus sync-over-async GetPlayerListAsync().GetAwaiter().GetResult() (plan-mandated design, acceptable in ASP.NET Core)
Task 7: complete (commits 50ece1d..b85027f, review clean - approved)
  Minor (for final review triage):
  - ConnectorService.cs:132 HostByInstanceAsync PostAsync HttpResponseMessage not disposed (immaterial, body unread)
Task 8: complete (commits b85027f..25b0547, review clean - approved, smoke check /api/connector/status=idle passed). Backend feature complete.
Task 9: complete (commits 25b0547..1ea176e, verified: npm run build passed, extensions present, types match backend camelCase)
Task 10: complete (commits 1ea176e..f6d5212, verified: npm run build passed, nav+route+placeholder correct)
Task 11: complete (commits f6d5212..d1286fb, review clean - approved)
  Minor (for final review triage):
  - Connect.tsx inactive panel shows empty titled card during session (UX polish)
  - Connect.tsx instance-host: hostByInstance POST blocks up to 5min (backend awaits full flow); long-hanging fetch may hit timeout - inherent to plan design
  - Connect.tsx player key uses name+index (no stable id from API)
  - Connect.tsx inputs/select not disabled during busy (buttons are)
Task 12: partial - automated portions done (backend build+smoke check /api/connector/status=idle, frontend build). Full multi-machine E2E (real EasyTier + 2 clients + running MC) NOT performed - requires easytier-core in PATH + two devices + running game. Documented as manual verification for the user.
