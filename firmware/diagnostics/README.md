# Hardware Diagnostics

- `motor_test/motor_test.ino`: historical motor-only diagnostic. Inspect its pin
  assignments and disconnect the wheels from the ground before uploading.
- `wifi_diag_test/wifi_diag_test.ino`: standalone Wi-Fi diagnostic; local
  `wifi_secrets.h` remains ignored by Git.

Diagnostics are not production firmware. No sketch is uploaded automatically.
Current production pin assignments are documented in [firmware.md](../../docs/firmware.md).