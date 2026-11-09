# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Homebridge dynamic platform that shows SiliconDust HDHomeRun TV tuners (and, optionally, Channels DVR) in Apple Home, with a live web dashboard. It only reads from the devices; nothing it publishes can change them. Written in JavaScript (ES modules), no build step. Supports HomeKit (HAP) and, on Homebridge 2.3+ with Matter on for the bridge, Matter.

## Commands

- **Lint**: `npm run lint` (eslint with zero warnings allowed)
- **Lint + fix**: `npm run lint:fix`
- **Test**: `npm test` (vitest, about 75 seconds - the end-to-end test runs real timers)
- **Pretend HDHomeRun**: `node test/mock-hdhomerun.js --auto` (a device at 127.0.0.1:8080 that changes channels)

CI runs lint, then the tests on Node 22, 24 and 26.

## Code Style

Uses `@antfu/eslint-config` with these key rules:
- Single quotes, no semicolons, 1tbs brace style
- Sorted imports/exports via `perfectionist`
- Node globals imported from `node:` modules (`Buffer`, `process`)
- Zero warnings tolerance (`--max-warnings=0`)

## Architecture

### Entry Point and Platform (`lib/index.js`)
Registers `HDHomeRunPlatform` under the alias "HDHomeRun". The platform:
- starts a `DeviceMonitor` per HDHomeRun (configured by host or ID, or found by UDP discovery every 10 minutes)
- builds the HomeKit accessories: one combined "TV In Use" switch (default) or separate switches per tuner, plus a Poor Reception sensor and an optional Online sensor per device
- decides what goes over Matter (`appleHome`: `homekit`, `matter` or `matterOnly`) in `setupMatter()`
- estimates energy (idle watts plus watts per busy tuner) for the Matter outlets
- runs the dashboard and records sessions and statistics

### Talking to Devices
- `lib/hdhr.js`: the HDHomeRun HTTP API, the native control protocol (TCP 65001, used when `status.json` is missing) and UDP discovery
- `lib/monitor.js`: polls one device and emits `update` snapshots
- `lib/channels.js`: Channels DVR's read-only API (recordings, live activity); found at 127.0.0.1:8089 by itself if no address is set
- `lib/activity.js`: parses Channels DVR's activity lines - keep it free of regexes that backtrack (there is a test with a long line)
- `lib/guide.js`: now and next from SiliconDust's guide service

### HomeKit and Matter
- `lib/accessory.js`, `lib/combined-accessory.js`, `lib/online-accessory.js`: the HAP accessories. Every switch is report-only: a tap is put back.
- `lib/matter.js`: `MatterPublisher` registers Matter accessories one at a time and confirms each by reading state back. It always registers on the first attempt, because Homebridge restores cached accessories before the plugin starts and only the plugin's registration gives them back their handlers.

### Recording and Dashboard
- `lib/recorder.js`: sessions, statistics, signal history and state files under `<storage>/hdhomerun-monitor/` (the folder name is kept from the plugin's earlier name, so existing statistics carry over)
- `lib/stats.js`, `lib/reception.js`, `lib/energy.js`, `lib/snapshot.js`: the numbers the dashboard shows
- `lib/dashboard.js`: the web dashboard and its JSON/server-sent-events API on port 8588
- `lib/homebridge-ui/`: the Homebridge UI tab. `public/app.js` is shared by the tab and the standalone dashboard; escape every value from the network with `esc()`.

## Tests

- `lib/*.test.js`: unit tests next to the code they cover
- `test/e2e.test.js`: the plugin in a stand-in Homebridge (`test/fake-homebridge.js`, including a fake Matter API that restores accessories like Homebridge does) against a pretend HDHomeRun (`test/mock-hdhomerun.js`) and Channels DVR (`test/mock-services.js`)
- `test/config-schema.test.js`: keeps `config.schema.json` valid for the Homebridge UI and Homebridge verification

## Configuration

`config.schema.json` defines the Homebridge UI form. The plugin also has a custom UI tab (`customUi`), which shows the dashboard and finds tuners on the network.
