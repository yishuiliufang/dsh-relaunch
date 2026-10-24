' dsh-restart-app: start the restart worker with NO window of any kind.
'
' Why this file exists:
'   The restart worker must run detached from Harness (it kills Harness), and it
'   must not flash a console. Console-subsystem programs (powershell.exe,
'   cmd.exe) always allocate one when started through WMI, which exposes no
'   STARTUPINFO. The Harness executable itself is a GUI-subsystem binary, so in
'   Node mode (ELECTRON_RUN_AS_NODE=1) it runs the worker with no console at
'   all. wscript.exe is also GUI-subsystem, so this launcher adds no window
'   either.
'
' Usage: wscript launch-hidden.vbs <exePath> <scriptPath> <logPath> <delaySeconds>
Option Explicit

Dim sh, exePath, scriptPath, logPath, delay, cmd
Set sh = CreateObject("WScript.Shell")

If WScript.Arguments.Count < 2 Then
  WScript.Quit 1
End If

exePath    = WScript.Arguments(0)
scriptPath = WScript.Arguments(1)
logPath    = ""
delay      = "2"
If WScript.Arguments.Count > 2 Then logPath = WScript.Arguments(2)
If WScript.Arguments.Count > 3 Then delay = WScript.Arguments(3)

' Make the Electron binary behave as a plain Node runtime, and pass the rest of
' the settings to the worker. Child processes inherit these.
sh.Environment("PROCESS")("ELECTRON_RUN_AS_NODE") = "1"

cmd = """" & exePath & """ """ & scriptPath & """ -LogPath """ & logPath & """ -DelaySeconds " & delay

' 0 = hidden window; False = do not wait for the worker to finish.
sh.Run cmd, 0, False
