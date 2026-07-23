#!/bin/bash
set -e
if [ "$1" != "true" ]; then
  echo "License not required, skipping LicenseCore.cs fetch"
  exit 0
fi
echo "Fetching LicenseCore.cs..."
curl -sL --fail \
  -H "Authorization: token $2" \
  "https://raw.githubusercontent.com/Qomicex-Public/Qomicex.Tauri.LicenseCore/main/LicenseCore.cs" \
  -o "src-backend/Qomicex.Launcher.Backend.Neo/Services/LicenseCore.cs"
echo "LicenseCore.cs fetched successfully"
