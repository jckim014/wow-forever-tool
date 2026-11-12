' Starts the auction sync without a console window (Task Scheduler runs this with wscript.exe).
' Arguments: <path to node.exe> <path to sync.mjs>
Set sh = CreateObject("WScript.Shell")
sh.Run """" & WScript.Arguments(0) & """ """ & WScript.Arguments(1) & """", 0, True
