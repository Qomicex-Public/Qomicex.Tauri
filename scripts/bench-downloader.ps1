param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $Urls)
if (-not $Urls) {
  $Urls = @(
    "https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar"
  )
}
dotnet run --project "$PSScriptRoot/../src-backend/Qomicex.Downloader.Bench" -- bench @Urls
