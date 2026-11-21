' Runs the Forever Market launcher without a console window (the forever-market:// link calls this with wscript.exe).
' Arguments: <path to node.exe> <path to launch.mjs> [the link, passed on: forever-market://item/<id> opens that item]
Set sh = CreateObject("WScript.Shell")
cmd = """" & WScript.Arguments(0) & """ """ & WScript.Arguments(1) & """"
If WScript.Arguments.Count > 2 Then cmd = cmd & " """ & WScript.Arguments(2) & """"
sh.Run cmd, 0, False
