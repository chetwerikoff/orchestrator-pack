@ECHO OFF
SETLOCAL EnableDelayedExpansion
SET "GUARD_DIR=%~dp0"
SET "EXECUTABLE=%~1"
SHIFT
SET "SH="
IF EXIST "%ProgramFiles%\Git\usr\bin\sh.exe" SET "SH=%ProgramFiles%\Git\usr\bin\sh.exe"
IF NOT DEFINED SH IF EXIST "%ProgramFiles%\Git\bin\sh.exe" SET "SH=%ProgramFiles%\Git\bin\sh.exe"
IF NOT DEFINED SH IF EXIST "%ProgramFiles(x86)%\Git\bin\sh.exe" SET "SH=%ProgramFiles(x86)%\Git\bin\sh.exe"
IF NOT DEFINED SH (
  FOR /F "delims=" %%S IN ('WHERE sh 2^>NUL') DO (
    IF NOT DEFINED SH SET "SH=%%S"
  )
)
IF NOT DEFINED SH (
  >&2 ECHO review-test-budget:{"executable":"%EXECUTABLE%","decision":"skipped_or_denied_slow_test","reason":"command guard sh unavailable on Windows"}
  EXIT /B 127
)
"%SH%" "%GUARD_DIR%%EXECUTABLE%" %*
EXIT /B %ERRORLEVEL%
