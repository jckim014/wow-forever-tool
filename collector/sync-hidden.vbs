' Starts the auction sync without a console window (Task Scheduler runs this with wscript.exe).
' Arguments: <path to node.exe> <path to sync.mjs>
' --max-old-space-size=512: Node frees memory lazily, so the steps of one sync stacked up to ~690 MB at peak; with a
' ceiling it cleans up as it goes (the sync needs well under that). --disable-warning: node:sqlite is "experimental".
Set sh = CreateObject("WScript.Shell")
sh.Run """" & WScript.Arguments(0) & """ --max-old-space-size=512 --disable-warning=ExperimentalWarning """ & WScript.Arguments(1) & """", 0, True
