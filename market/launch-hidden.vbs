' Runs the Forever Market launcher without a console window (the forever-market:// link calls this with wscript.exe).
' Arguments: <path to node.exe> <path to launch.mjs> [the link, ignored]
Set sh = CreateObject("WScript.Shell")
sh.Run """" & WScript.Arguments(0) & """ """ & WScript.Arguments(1) & """", 0, False
