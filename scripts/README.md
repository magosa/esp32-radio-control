# Maintenance Scripts

`esp32_status_check.ps1` collects serial diagnostics. Specify the actual port;
resetting the board requires the explicit `-ResetDevice` switch. It is not run
by npm tests or builds.

```powershell
.\scripts\esp32_status_check.ps1 -Port COM5
.\scripts\esp32_status_check.ps1 -Port COM5 -ResetDevice
```

The second command resets the physical device. Stop the robot and ensure the
motors cannot move the vehicle before using it. Logs may contain network
identifiers; the default output is ignored by Git.