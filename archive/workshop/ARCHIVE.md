# Workshop Archive

This directory preserves the historical Bluetooth/OLED workshop, Slidev deck,
diagram sources, generated diagram pages, and the bundled Archify tool.
It is not the current firmware or Fleet setup guide.

Current entry point: [Repository README](../../README.md).

The deck, components, public assets, diagram sources, and npm lockfile stay
together so their relative references are preserved.

From the repository root:

```sh
npm --prefix archive/workshop ci
npm run workshop:dev
npm run workshop:build
```

Generated outputs and dependencies are not source files. Historical wiring,
sensor choices, and command examples may not apply to the current hardware.
Archify retains its original licenses and notices; its own README documents its
installation and generation commands.