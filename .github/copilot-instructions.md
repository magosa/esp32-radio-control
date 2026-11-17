# Copilot Instructions for ESP32 Radio Control

This project is a robotic fleet controller that manages multiple ESP32-based robots (drive/display units and independent camera units) via WebSocket Hub and Next.js web UI.

## Quick Start

```sh
# Install and run development server
npm --prefix web-controller ci
npm run dev

# Run tests (key commands)
npm test                  # Fleet, localization, scene tests
npm run test:appearance   # Accessibility contrast validation
npm run typecheck         # TypeScript validation
npm run test:browser      # Playwright integration tests

# Single test file: npm --prefix web-controller run test:fleet -- <path/to/test.ts>

# Production build
npm run build
npm start
```

**URLs:**
- Fleet control: `http://localhost:3000/control`
- Bluetooth direct: `http://localhost:3000/direct/bluetooth`
- Other screens: `/field`, `/scenes`, `/run`, `/exhibit`, `/localizer`, `/robots`, `/settings`

## Architecture

### Core Components

**[server.ts](web-controller/server.ts)** - HTTP + WebSocket entry point
- Creates Next.js request handler for UI routes
- Manages WebSocket upgrade at `/ws/device` (ESP32), `/ws/client` (browser), `/ws/localizer` (overhead camera)
- Initializes `FleetHub` and `SceneHistoryStore`

**[fleet/hub.ts](web-controller/fleet/hub.ts)** - WebSocket message hub
- Routes messages between devices (robots) and UI clients
- Manages device registry (deviceId → WebSocket connection)
- Dispatches telemetry, commands, expressions, and camera streaming

**[fleet/registry.ts](web-controller/fleet/registry.ts)** - Device and robot configuration
- Tracks connected physical devices (drive/LCD, cameras) and their capabilities
- Maintains logical robot definitions (robotId maps to drive device + camera device)
- Loads/saves robot configuration to `fleet.json`

**[fleet/robotStore.ts](web-controller/fleet/robotStore.ts)** - Robot state management
- Tracks online/offline status, current mode (manual/auto), speed telemetry
- Updates received from device telemetry messages

**[fleet/sceneHistoryStore.ts](web-controller/fleet/sceneHistoryStore.ts)** - Scene persistence
- Loads/saves scene project files with versioning (directory: `data/scene-history/`)
- Prevents corruption by detecting version breaks and duplicate numbers at startup

### Message Protocol

[fleet/protocol.ts](web-controller/fleet/protocol.ts) defines the JSON contract:
- **ESP32 → Hub:** `hello`, `telemetry`, `imageFrame`, `heartbeat`, `poseFrame`, `localizerStatus`
- **Hub → ESP32:** `drive`, `setExpression`, `setDisplayLayout`, `captureImage`, `streamStart`, `streamStop`, `ping`
- **Hub → UI:** `fleetState` (devices, robots, vehicles), `operationResult`, `poseState`
- Capabilities: `"drive"` (motor), `"display"` (LCD), `"camera"`

### Scene Editor and Execution

**[scene/model.ts](web-controller/scene/model.ts)** - Scene data model
- Defines map, timeline, cues, tracks (robot paths), and timed actions
- Immutable updates via reducer-like functions

**[scene/sceneSession.ts](web-controller/scene/sceneSession.ts)** - Scene file I/O and history
- Interacts with server history API to load/save project files
- Manages undo/redo stack locally

**[scene/mapEditSession.ts](web-controller/scene/mapEditSession.ts)** - Floor plan editor
- Handles geometry (fixtures, regions, walls), robot placement, hit detection

**[scene/timelineEdit.ts](web-controller/scene/timelineEdit.ts)** - Timeline editor
- Manages cue sequences and timed actions (track starts, speed changes)

**[fleet/sceneRunner.ts](web-controller/fleet/sceneRunner.ts)** - Scene playback
- Executes scene timeline in real-time (10Hz ticks)
- Tracks robot positions, computes next waypoints from routes

**[fleet/routeEngine.ts](web-controller/fleet/routeEngine.ts)** - Path planning
- Computes waypoint sequences from scene track (start → end via intermediate points)
- Integrates with motion controller for steering commands

**[fleet/motionController.ts](web-controller/fleet/motionController.ts)** - Motor control
- Converts target speed/heading to L/R motor commands (`a`–`e`)
- Sends at 200ms (manual) or 800ms (auto) intervals, with failsafe at 1.5s silence

### Localization and Pose

**[localization/detector.ts](web-controller/localization/detector.ts)** - OpenCV-based ArUco marker detection
- Runs on overhead camera stream to identify robots by ID
- Returns 2D position, orientation, and bounding box

**[localization/geometry.ts](web-controller/localization/geometry.ts)** - Coordinate transforms
- Converts camera pixel coords → field floor coords via calibration
- Applies marker height correction to 3D pose

**[fleet/poseStore.ts](web-controller/fleet/poseStore.ts)** - Pose history
- Buffers detected poses (10Hz) for scene executor to query robot positions

**[fleet/localizerAccess.ts](web-controller/fleet/localizerAccess.ts)** - Localizer security
- Restricts `/ws/localizer` WebSocket to localhost or `FLEET_LOCALIZER_ALLOW_REMOTE=1`

### Storage

- **fleet.json** (robotId → driveDeviceId + cameraDeviceId + markerId + priority): `FLEET_DATA_DIR` (default `web-controller/data/`)
- **field.json** (camera height, region bounds, black reference): same directory
- **scene-history/** (versioned scene projects): `SCENE_HISTORY_DIR` (default `web-controller/data/scene-history/`)

All paths are relative to the Hub process's working directory; use absolute paths for consistency. Git ignores `web-controller/data/` and `wifi_secrets.h` in firmware sketches.

## Key Conventions

### TypeScript paths and naming
- Path alias `@/*` maps to `web-controller/` root
- Reusable state/UI hooks in `web-controller/hooks/` (e.g., `useSceneProject`, `useFleetSocket`)
- Component directories parallel the UI route structure (e.g., `app/(console)/control/` for `/control` page)

### React Hooks and State
- Hooks interact with server-side stores via WebSocket or HTTP (e.g., `useFleetSocket`, `usePlayback`)
- State is not Redux; prefer local React state + hooks for UI-local concerns
- Avoid exposing server state directly; derive computed values in hooks

### Device telemetry and failsafe
- ESP32 motors stop after 1.5 seconds without a drive command (`a`–`d`)
- Manual mode resends commands at 200ms; auto mode at 800ms
- Both intervals are independent of the failsafe and do not trigger it
- Camera heartbeat expected every 1 second; camera marked offline after 5 seconds

### Scene and timeline execution
- Scenes are immutable data; edits return new objects, not mutations
- Timeline cues are 0-indexed; tracks define robot motion per cue
- Execution ticks at ~10Hz; short-lived timed actions (e.g., expression) sync via multiple ticks
- Route computation is lazy; routes cache intermediate waypoints until track changes

### Map editor and geometry
- Floor plans are defined in scene model (not stored separately)
- Fixtures, regions, and walls are stored as canvas geometric primitives (circles, rectangles, polygons)
- Hit detection uses bounding-box and point-in-polygon checks (avoid expensive geometry ops in render)

### Accessibility and appearance
- Tailwind CSS + Lucide icons (web-controller only; no external icon libraries)
- Contrast validation tested via `npm run test:appearance` (WCAG AA)
- Color pairs intentionally checked; do not change without re-validating

### Testing
- Unit tests in `web-controller/scripts/` run via `tsx --test` (Node.js built-in test runner)
- Playwright browser tests in `web-controller/browser-tests/`
- Simulation helpers (fake device/localizer/fleet) in `web-controller/scripts/fakeDevice.ts`, etc.
- Do not export from test files; keep helpers isolated

### Firmware and ESP32 specifics
- Drive firmware: [esp32_rc_car.ino](firmware/esp32_rc_car/esp32_rc_car.ino) with ideaspark ESP32 + ST7789 LCD or LilyGO T-Display-S3
- Camera firmware: [camera_xiao_s3.ino](firmware/camera_xiao_s3/camera_xiao_s3.ino) for XIAO ESP32S3 Sense (independent, streams JPEG over WebSocket)
- Transport modes: 0 (WebSocket), 1 (BLE/NUS), 2 (Classic BT/SPP) selected at compile time
- GPIO pins are hardware-specific; check `docs/firmware.md` and board-specific sections before reusing pins

### Git and CI
- Node.js 20+
- No real credentials in repo; use `wifi_secrets.example.h` as template
- Sensitive data (past credentials in history) has been sanitized; do not re-add

## Documentation

- [docs/fleet.md](docs/fleet.md) - Communication protocol, device capabilities, robot configuration, storage
- [docs/firmware.md](docs/firmware.md) - Wiring, library dependencies, compile commands, partition schemes, GPIO pinouts
- [docs/migration.md](docs/migration.md) - Feature changes, backward compatibility, staged rollout
- [archive/workshop/ARCHIVE.md](archive/workshop/ARCHIVE.md) - Legacy materials (OLED, BLE, Bluetooth, Slidev, Archify tool)
