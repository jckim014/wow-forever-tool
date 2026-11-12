# Registers (or updates) the Windows scheduled task "Forever auction sync": runs collector\sync.mjs 2 minutes after
# logon and every hour at :40 (the collector usually has the new snapshot by :25), below normal priority, no window.
# Run again after moving the repo or reinstalling Node. Remove with: Unregister-ScheduledTask "Forever auction sync"
$ErrorActionPreference = 'Stop'
$node = (Get-Command node).Source
$sync = Join-Path $PSScriptRoot 'sync.mjs'
$vbs = Join-Path $PSScriptRoot 'sync-hidden.vbs'
$user = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`" `"$node`" `"$sync`""

$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
$logon.Delay = 'PT2M'
$first = (Get-Date).Date.AddHours((Get-Date).Hour).AddMinutes(40)
if ($first -lt (Get-Date)) { $first = $first.AddHours(1) }
$hourly = New-ScheduledTaskTrigger -Once -At $first -RepetitionInterval (New-TimeSpan -Hours 1)

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -Priority 7
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName 'Forever auction sync' -Action $action -Trigger @($logon, $hourly) `
  -Settings $settings -Principal $principal -Description 'Downloads WoW Forever auction snapshots from GitHub to F:\ForeverAuctionData (wow-forever-shuffle\collector).' -Force | Out-Null

$t = Get-ScheduledTask -TaskName 'Forever auction sync'
"Registered. Node: $node"
"Triggers: logon (+2 min); hourly from $first, repeat $($t.Triggers[1].Repetition.Interval) for '$($t.Triggers[1].Repetition.Duration)' (empty = forever)"
