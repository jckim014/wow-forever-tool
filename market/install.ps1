# Registers the forever-market:// link for this Windows user (no admin needed), so a Chrome bookmark to
# forever-market://open starts Forever Market (launch.mjs, hidden). Run again after moving the repo or reinstalling
# Node. Remove with: Remove-Item -Recurse "HKCU:\Software\Classes\forever-market"
$ErrorActionPreference = 'Stop'
$node = (Get-Command node).Source
$launch = Join-Path $PSScriptRoot 'launch.mjs'
$vbs = Join-Path $PSScriptRoot 'launch-hidden.vbs'
$key = 'HKCU:\Software\Classes\forever-market'

New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name '(default)' -Value 'URL:Forever Market'
New-ItemProperty -Path $key -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
New-Item -Path "$key\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$key\shell\open\command" -Name '(default)' -Value "wscript.exe `"$vbs`" `"$node`" `"$launch`" `"%1`""

"Registered forever-market:// for $env:USERNAME"
"Command: " + (Get-ItemProperty -Path "$key\shell\open\command").'(default)'
