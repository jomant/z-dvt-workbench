Set shell = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = dir
node = dir & "\runtime\node.exe"
If Not fso.FileExists(node) Then node = "C:\Program Files\nodejs\node.exe"
shell.Run """" & node & """ src\server.js", 0, False
