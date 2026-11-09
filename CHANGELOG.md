# Changelog

## 1.7.0
- **Apple Home connection** setting: HomeKit with watts on TV In Use over Matter (default), **Matter only**, or HomeKit only (`appleHome`).
- Matter only publishes nothing on HomeKit: TV In Use as an outlet with watts and kWh, Poor Reception as an occupancy sensor, Online as a contact sensor; with separate switches, outlets per tuner, In Use (with that HDHomeRun's watts and kWh), All Busy, Online TV and per channel. HDHomeRun accessories show as unreachable while it is offline.
- Energy is also kept per HDHomeRun.
- Fix: an HDHomeRun that changed address was watched at both the old and new address.
- `energy.matter` is replaced by `appleHome` (`energy.matter: false` still means HomeKit only).

## 1.6.0
- TV In Use as a Matter outlet with estimated watts on its Home app tile and kWh counted up (Homebridge 2.3+ with Matter on for the bridge, iOS/tvOS 27+). Falls back to the HAP switch without Matter.
- Estimated energy: 3 W idle + 1 W per busy tuner by default, per device if set, plus optional watts per online stream; kWh per day kept in energy.json.
- Dashboard: live watts and today's kWh next to TV In Use; an energy tile on Statistics, with the cost if a power price is set.

## 1.5.0
- One combined **TV In Use** switch is now the default: on while an HDHomeRun tuner, a Channels DVR online channel or a recording is in use (`homekitLayout: "combined"`, options under `combined`). The tuner, In Use, All Busy and Online TV switches are still available with `homekitLayout: "separate"`.
- The Live tab shows the TV In Use switch and what is keeping it on.
- Upgrading: the per-tuner and Online TV switches are replaced by TV In Use, so automations on them need moving to TV In Use — or choose Separate switches to keep them.

## 1.4.0
- Online channels through Channels DVR (custom M3U sources and TV Everywhere): a Channels DVR accessory with an "Online TV In Use" switch and optional switches per channel, with their own channel-surfing delays; recordings optional.
- Online TV panel on the Live tab: channel, programme, watching device, source, recording; online streams in Sessions and Statistics (counted separately from tuner time).
- HDHomeRun tuners used through Channels DVR show and record the device really watching instead of the Channels DVR server.

## 1.3.0
- Ignore channel surfing: switches turn on after a tuner has streamed for 30 s and off after 2 min idle (`onDelaySeconds`, `offDelaySeconds`).
- Poor Reception occupancy sensor: on when signal quality stays below 60% for 3 min (`poorReceptionThreshold`, `poorReceptionMinutes`); logged, and shown on the dashboard.
- Now and next from SiliconDust's guide on the Live and Channels tabs.
- Recordings tab for Channels DVR: recording now, upcoming, recent and failed, with tuner clash warnings.
- Reception tab: signal per channel or per frequency over 7 or 30 days, with a 14-day trend.

## 1.2.0
- Choose which tuners appear in HomeKit (**Tuners to show**, or `"tuners": [1, 2]`).

## 1.1.0
- Tuners show in HomeKit as switches by default, on while streaming. Tapping one changes nothing; it flips back to what the tuner is doing.
- `sensorType: "occupancy"` keeps occupancy sensors, for Home app notifications.

## 1.0.0
- First release: an accessory per HDHomeRun with a sensor per tuner, In Use, All Busy and Online.
- Dashboard in Homebridge Config UI X and at `http://<homebridge>:8588/`: live tuners with channel, client and signal; statistics; sessions; channels.
- Automatic discovery, and the HDHomeRun control protocol for older firmware.
