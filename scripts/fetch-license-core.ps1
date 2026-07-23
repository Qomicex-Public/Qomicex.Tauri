param(
  [string]$licenseRequired = "false",
  [string]$pat = ""
)
if ($licenseRequired -ne "true") {
  Write-Output "License not required, skipping LicenseCore.cs fetch"
  exit 0
}
Write-Output "Fetching LicenseCore.cs..."
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/Qomicex-Public/Qomicex.Tauri.LicenseCore/main/LicenseCore.cs" `
  -Headers @{ Authorization = "token $pat" } `
  -OutFile "src-backend/Qomicex.Launcher.Backend.Neo/Services/LicenseCore.cs"
Write-Output "LicenseCore.cs fetched successfully"
