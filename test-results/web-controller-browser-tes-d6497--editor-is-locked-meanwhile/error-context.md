# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: web-controller\browser-tests\run.spec.ts >> a scene runs from /run to the end with a simulated robot; the editor is locked meanwhile
- Location: web-controller\browser-tests\run.spec.ts:6:1

# Error details

```
Error: browserType.launch: Executable doesn't exist at C:\Users\nwtwh\AppData\Local\ms-playwright\chromium_headless_shell-1254\chrome-headless-shell-win64\chrome-headless-shell.exe
╔════════════════════════════════════════════════════════════╗
║ Looks like Playwright was just installed or updated.       ║
║ Please run the following command to download new browsers: ║
║                                                            ║
║     npx playwright install                                 ║
║                                                            ║
║ <3 Playwright Team                                         ║
╚════════════════════════════════════════════════════════════╝
```