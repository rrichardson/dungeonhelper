@echo off
rem Windows counterpart of bin/dnd. Add this bin folder to PATH to type "dnd".
node "%~dp0..\src\cli\index.ts" %*
