/* HDHomeRun Monitor dashboard — runs both standalone (:8588) and inside Homebridge Config UI X. */
(function () {
  'use strict';

  const PERIODS = [
    ['today', 'Today'],
    ['yesterday', 'Yesterday'],
    ['last7', '7 days'],
    ['last30', '30 days'],
    ['all', 'All time'],
  ];

  // ---------- helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function dur(sec, short) {
    sec = Math.max(0, Math.round(sec || 0));
    if (sec < 60) return `${sec} s`;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h >= 100) return `${h} h`;
    if (h) return short ? `${h}h ${String(m).padStart(2, '0')}m` : `${h} h ${m} min`;
    return `${m} min`;
  }

  function hours(sec) {
    const h = (sec || 0) / 3600;
    return h >= 10 ? `${Math.round(h)} h` : `${h.toFixed(1)} h`;
  }

  function when(t) {
    const d = new Date(t);
    const now = new Date();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return `Today ${time}`;
    const y = new Date(now); y.setDate(y.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
    return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
  }

  function ago(t) {
    if (!t) return 'never';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 10) return 'just now';
    if (s < 60) return `${s} s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    return when(t);
  }

  const level = (v) => (v === undefined || v === null ? '' : v >= 80 ? 'good' : v >= 55 ? 'fair' : 'poor');
  const mhz = (f) => (f ? `${(f / 1e6).toFixed(f % 1e6 ? 1 : 0)} MHz` : '');
  const mbps = (b) => (b ? `${(b / 1e6).toFixed(1)} Mb/s` : '');

  function fwDate(v) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(v || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  }

  const channelText = (o) => [o.channelNumber, o.channelName].filter(Boolean).join(' ') || (o.frequency ? mhz(o.frequency) : 'Unknown channel');
  const clientText = (o) => (o.clientName ? `${o.clientName}` : o.client || '');

  // ---------- transports ----------
  function standaloneTransport() {
    return {
      snapshot: async () => (await fetch('api/snapshot', { cache: 'no-store' })).json(),
      live(onLive, onStatus) {
        let es;
        const open = () => {
          es = new EventSource('api/events');
          es.addEventListener('live', (e) => { onStatus(true); onLive(JSON.parse(e.data)); });
          es.onerror = () => { onStatus(false); };
        };
        open();
        return { full: 60000 };
      },
      resetStats: async () => {
        const r = await fetch('api/reset-stats', { method: 'POST', headers: { 'x-hdhr-dashboard': '1' } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      },
    };
  }

  function homebridgeTransport() {
    const hb = window.homebridge;
    let cfg = {};
    const params = () => ({ port: cfg.dashboard?.port || 8588, dashboardEnabled: cfg.dashboard?.enabled !== false });
    return {
      async init() {
        const list = await hb.getPluginConfig();
        cfg = list[0] || {};
      },
      config: () => cfg,
      snapshot: () => hb.request('/snapshot', params()),
      live() { return { full: 4000 }; },
      resetStats: () => hb.request('/reset-stats', params()),
      discover: () => hb.request('/discover'),
      probe: (host) => hb.request('/probe', { host }),
      async addDevice(dev) {
        const list = await hb.getPluginConfig();
        const c = list[0] || { platform: 'HDHomeRunMonitor', name: 'HDHomeRun Monitor' };
        c.devices = c.devices || [];
        const id = String(dev.deviceId || '').toUpperCase();
        const existing = c.devices.find((d) => (id && String(d.deviceId || '').toUpperCase() === id) || (dev.host && d.host === dev.host));
        if (existing) Object.assign(existing, { host: dev.host, deviceId: id || existing.deviceId });
        else c.devices.push({ name: dev.name || undefined, host: dev.host, deviceId: id || undefined });
        if (!list.length) list.push(c);
        await hb.updatePluginConfig(list);
        cfg = c;
        hb.hideSchemaForm();
        hb.showSchemaForm();
      },
      dashboardUrl() {
        const host = (location.hostname || 'localhost');
        return `http://${host.includes(':') ? `[${host}]` : host}:${params().port}/`;
      },
    };
  }

  // ---------- app ----------
  function start(root, opts) {
    const mode = opts.mode;
    const api = mode === 'homebridge' ? homebridgeTransport() : standaloneTransport();
    const ui = {
      tab: readPref('tab', 'live'),
      period: readPref('period', 'today'),
      sessionFilter: '',
      sessionLimit: 50,
      channelFilter: '',
      channelDevice: '',
      recPeriod: readPref('recPeriod', 'd7'),
      recDevice: '',
      recGroup: readPref('recGroup', 'channel'),
      resetArmed: 0,
      chartNote: '',
    };
    let snap = null;
    let connected = false;
    let lastData = 0;

    // theme
    const setTheme = (t) => root.setAttribute('data-theme', t === 'dark' ? 'dark' : 'light');
    if (opts.theme) setTheme(opts.theme);
    else {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      setTheme(mq.matches ? 'dark' : 'light');
      mq.addEventListener?.('change', (e) => setTheme(e.matches ? 'dark' : 'light'));
    }

    const tabs = [['live', 'Live'], ['recordings', 'Recordings'], ['reception', 'Reception'], ['stats', 'Statistics'], ['sessions', 'Sessions'], ['channels', 'Channels']];
    if (mode === 'homebridge') tabs.push(['settings', 'Settings']);
    if (!tabs.some(([k]) => k === ui.tab)) ui.tab = 'live';

    root.innerHTML = `
      <div class="wrap">
        <div class="top">
          <div class="brand"><img src="icon.svg" alt=""><div><h1>HDHomeRun Monitor</h1><small id="hd-sub">Connecting…</small></div></div>
          <span class="live" id="hd-live"><i></i><span>Connecting</span></span>
          ${mode === 'homebridge' ? '<a class="btn" id="hd-open" target="_blank" rel="noopener">Open dashboard ↗</a>' : ''}
        </div>
        <nav class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${k === ui.tab}">${l}</button>`).join('')}</nav>
        <div id="hd-controls"></div>
        <div id="hd-body"></div>
      </div>`;
    const $ = (sel) => root.querySelector(sel);

    root.querySelector('.tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]');
      if (!b) return;
      ui.tab = b.dataset.tab;
      writePref('tab', ui.tab);
      root.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      renderControls();
      render();
    });

    // ---------- data ----------
    async function refresh() {
      try {
        snap = await api.snapshot();
        connected = true;
        lastData = Date.now();
      } catch (e) {
        connected = false;
        console.warn('HDHomeRun Monitor:', e);
      }
      render();
    }

    function onLive(live) {
      if (!snap) return;
      snap.devices = live.devices;
      snap.open = live.open;
      snap.online = live.online;
      snap.dvrStreams = live.dvrStreams;
      snap.combined = live.combined;
      snap.connection = live.connection;
      if (live.energy && snap.energy) { snap.energy.watts = live.energy.watts; snap.energy.periods.today = live.energy.todayWh; }
      lastData = Date.now();
      if (ui.tab === 'live') render();
      else renderStatus();
    }

    // ---------- status line ----------
    function renderStatus() {
      const el = $('#hd-live');
      const stale = snap?.via === 'files' || (lastData && Date.now() - lastData > 30000);
      el.className = `live ${connected && !stale ? 'on' : stale ? 'stale' : ''}`;
      let text = connected ? 'Live' : 'Not connected';
      if (snap?.via === 'files') text = snap.stateAge != null && snap.stateAge < 120000 ? 'From saved data' : 'Plugin not running — saved data';
      el.querySelector('span').textContent = text;
      const sub = $('#hd-sub');
      if (sub && snap) {
        const n = snap.devices.length;
        sub.textContent = `${n} device${n === 1 ? '' : 's'} · v${snap.version || '?'}`;
      }
      const open = $('#hd-open');
      if (open && api.dashboardUrl) {
        open.href = api.dashboardUrl();
        open.style.display = api.config?.().dashboard?.enabled === false ? 'none' : '';
      }
    }

    // ---------- controls (kept across renders so inputs keep focus) ----------
    function renderControls() {
      const c = $('#hd-controls');
      if (mode === 'homebridge') {
        if (ui.tab === 'settings') window.homebridge.showSchemaForm();
        else window.homebridge.hideSchemaForm();
      }
      if (ui.tab === 'stats') {
        c.innerHTML = `<div class="toolbar">
          <div class="seg" id="hd-period">${PERIODS.map(([k, l]) => `<button data-p="${k}" aria-pressed="${k === ui.period}">${l}</button>`).join('')}</div>
          <span class="spacer"></span>
          <button class="btn danger" id="hd-reset">Reset statistics</button></div>`;
        $('#hd-period').addEventListener('click', (e) => {
          const b = e.target.closest('button[data-p]');
          if (!b) return;
          ui.period = b.dataset.p;
          writePref('period', ui.period);
          root.querySelectorAll('#hd-period button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
          render();
        });
        $('#hd-reset').addEventListener('click', onReset);
      } else if (ui.tab === 'sessions') {
        c.innerHTML = `<div class="toolbar"><input type="search" id="hd-sf" placeholder="Filter by channel, client or tuner" value="${esc(ui.sessionFilter)}"></div>`;
        $('#hd-sf').addEventListener('input', (e) => { ui.sessionFilter = e.target.value; render(); });
      } else if (ui.tab === 'reception') {
        c.innerHTML = `<div class="toolbar"><select id="hd-rd"></select>
          <div class="seg" id="hd-rp"><button data-v="d7" aria-pressed="${ui.recPeriod === 'd7'}">7 days</button><button data-v="d30" aria-pressed="${ui.recPeriod === 'd30'}">30 days</button></div>
          <div class="seg" id="hd-rg"><button data-v="channel" aria-pressed="${ui.recGroup === 'channel'}">By channel</button><button data-v="frequency" aria-pressed="${ui.recGroup === 'frequency'}">By frequency</button></div></div>`;
        const seg = (id, key) => $(id).addEventListener('click', (e) => {
          const b = e.target.closest('button[data-v]');
          if (!b) return;
          ui[key] = b.dataset.v;
          writePref(key, ui[key]);
          root.querySelectorAll(`${id} button`).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
          render();
        });
        seg('#hd-rp', 'recPeriod');
        seg('#hd-rg', 'recGroup');
        $('#hd-rd').addEventListener('change', (e) => { ui.recDevice = e.target.value; render(); });
      } else if (ui.tab === 'channels') {
        c.innerHTML = `<div class="toolbar"><select id="hd-cd"></select><input type="search" id="hd-cf" placeholder="Search channels" value="${esc(ui.channelFilter)}"><span class="spacer"></span><span class="links" id="hd-clinks"></span></div>`;
        $('#hd-cf').addEventListener('input', (e) => { ui.channelFilter = e.target.value; render(); });
        $('#hd-cd').addEventListener('change', (e) => { ui.channelDevice = e.target.value; render(); });
      } else {
        c.innerHTML = '';
      }
    }

    function onReset() {
      const b = $('#hd-reset');
      if (!ui.resetArmed) {
        ui.resetArmed = setTimeout(() => { ui.resetArmed = 0; b.textContent = 'Reset statistics'; b.classList.remove('armed'); }, 6000);
        b.textContent = 'Sure? Click again';
        b.classList.add('armed');
        return;
      }
      clearTimeout(ui.resetArmed);
      ui.resetArmed = 0;
      b.textContent = 'Resetting…';
      api.resetStats()
        .then(() => { toast('success', 'Statistics reset'); return refresh(); })
        .catch((e) => toast('error', `Could not reset: ${e.message || e}`))
        .finally(() => { b.textContent = 'Reset statistics'; b.classList.remove('armed'); });
    }

    function toast(kind, msg) {
      if (mode === 'homebridge' && window.homebridge?.toast) window.homebridge.toast[kind](msg);
      else if (kind === 'error') alert(msg);
    }

    // ---------- render ----------
    function render() {
      renderStatus();
      const body = $('#hd-body');
      if (ui.tab === 'settings') return renderSettings(body);
      if (!snap) {
        body.innerHTML = `<div class="panel empty"><strong>${connected ? 'Loading…' : 'Waiting for the plugin'}</strong>${connected ? '' : 'Is Homebridge running with HDHomeRun Monitor?'}</div>`;
        return;
      }
      if (ui.tab === 'live') body.innerHTML = renderLive();
      else if (ui.tab === 'stats') { body.innerHTML = renderStats(); bindChart(); }
      else if (ui.tab === 'sessions') {
        body.innerHTML = renderSessions();
        $('#hd-more')?.addEventListener('click', () => { ui.sessionLimit += 100; render(); });
      }
      else if (ui.tab === 'channels') body.innerHTML = renderChannels();
      else if (ui.tab === 'recordings') body.innerHTML = renderRecordings();
      else if (ui.tab === 'reception') body.innerHTML = renderReception();
    }

    function renderLive() {
      if (!snap.devices.length && !snap.online) {
        return `<div class="panel empty"><strong>No HDHomeRun found yet</strong>
          The plugin looks for tuners on the network every 10 minutes. You can also add one by its address${mode === 'homebridge' ? ' on the Settings tab' : ' in the plugin settings'}.</div>`;
      }
      return `<div class="stack">${renderCombined()}${snap.devices.map(renderDevice).join('')}${renderOnline()}</div>`;
    }

    function renderDevice(d) {
      const i = d.info || {};
      const busy = d.tuners.filter((t) => t.inUse).length;
      const status = d.online
        ? `<span class="badge ${busy ? 'accent' : ''}">${busy ? `${busy} of ${d.tuners.length} tuners in use` : 'All tuners idle'}</span>`
        : `<span class="badge bad">Offline · seen ${esc(ago(d.lastSeen))}</span>`;
      const meta = [
        i.ModelNumber && `${esc(i.FriendlyName || 'HDHomeRun')} ${esc(i.ModelNumber)}`,
        d.deviceId && `ID ${esc(d.deviceId)}`,
        d.host && esc(d.host),
        i.FirmwareVersion && `Firmware ${esc(i.FirmwareVersion)}${fwDate(i.FirmwareVersion) ? '' : ''}`,
        d.lineupCount ? `${d.lineupCount} channels` : '',
      ].filter(Boolean).map((x) => `<span>${x}</span>`).join('');
      const upgrade = i.UpgradeAvailable ? `<span class="badge warn" title="Update from the HDHomeRun app or the device page">Firmware ${esc(i.UpgradeAvailable)} available</span>` : '';
      const tuners = d.tuners.length ? d.tuners : [{ index: 0 }, { index: 1 }];
      return `<section class="panel">
        <div class="device-head">
          <div class="title">
            <h2><span class="dot ${d.online ? 'on' : 'off'}"></span>${esc(d.name)}</h2>
            <div class="meta">${meta}</div>
          </div>
          ${d.reception?.active ? `<span class="badge bad" title="Signal quality below ${d.reception.threshold}% for ${d.reception.minutes} min">Poor reception${d.reception.detail ? ` · Tuner ${d.reception.detail.tuner + 1} ${d.reception.detail.signalQuality}%` : ''}</span>` : ''}
          ${upgrade} ${status}
          ${d.baseUrl ? `<span class="links"><a href="${esc(d.baseUrl)}/" target="_blank" rel="noopener">Device page ↗</a></span>` : ''}
        </div>
        ${d.online ? '' : d.error ? `<p class="muted" style="margin:-4px 0 12px">${esc(d.error)}</p>` : ''}
        <div class="tuners">${tuners.map((t) => renderTuner(d, t)).join('')}</div>
      </section>`;
    }

    function renderTuner(d, t) {
      const label = `<div class="label"><span>Tuner ${t.index + 1}</span><span class="state">${!d.online ? 'Offline' : t.inUse ? 'Streaming' : 'Idle'}</span></div>`;
      if (!d.online || !t.inUse) {
        return `<div class="tuner">${label}<div class="idle-text">${d.online ? 'Not in use' : '—'}</div></div>`;
      }
      const id = d.deviceId || d.key;
      const session = (snap.open || []).find((s) => s.deviceId === id && s.tuner === t.index);
      const meters = [['Strength', t.signalStrength], ['Quality', t.signalQuality], ['Symbol', t.symbolQuality]]
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `<div class="meter"><span>${k}</span><div class="track"><div class="fill ${level(v)}" style="width:${Math.max(2, Math.min(100, v))}%"></div></div><b>${v}%</b></div>`).join('');
      const hist = ((snap.history[id] || {})[t.index] || []).slice(-60);
      return `<div class="tuner busy">${label}
        <div class="channel">${t.channelNumber ? `<span class="num">${esc(t.channelNumber)}</span>` : ''}<span class="cname" title="${esc(t.channelName || '')}">${esc(t.channelName || (t.channelNumber ? '' : mhz(t.frequency) || 'Tuned'))}</span></div>
        ${programme(id, t.channelNumber)}
        ${viaDvr(id, t) || `<div class="client" title="${esc(t.client || '')}">${t.client ? `→ ${esc(clientText(t))}${t.clientName ? ` <span class="faint">${esc(t.client)}</span>` : ''}` : '<span class="faint">No client address</span>'}</div>`}
        ${meters ? `<div class="meters">${meters}</div>` : ''}
        <div class="foot">
          <span>${session ? `for ${dur(session.seconds)}` : ''}${t.bitrate ? `<br>${mbps(t.bitrate)}` : ''}${t.frequency ? ` · ${mhz(t.frequency)}` : ''}</span>
          ${sparkline(hist)}
        </div>
      </div>`;
    }

    /** An HDHomeRun tuner streaming to Channels DVR: who is watching through it. */
    function viaDvr(id, t) {
      const st = (snap.dvrStreams || []).find((x) => x.kind === 'tuner' && x.deviceId === id && String(x.channelNumber) === String(t.channelNumber))
        || (t.via ? { activity: /recording/i.test(t.clientName || '') ? 'recording' : 'watching', device: t.clientName, ip: t.client } : null);
      if (!st) return '';
      if (st.activity === 'recording') return `<div class="client" title="Recording in Channels DVR">● Recording${st.title ? ` ${esc(st.title)}` : ''} <span class="faint">Channels DVR</span></div>`;
      return `<div class="client" title="${esc(st.ip || '')} through Channels DVR">→ ${esc(st.device || st.ip || 'a device')} <span class="faint">via Channels DVR</span></div>`;
    }

    /** The single "TV In Use" HomeKit switch, and what is keeping it on. */
    function renderCombined() {
      const c = snap.combined;
      if (!c) return '';
      const pending = c.active !== c.on;
      const why = c.reasons?.length ? c.reasons.map(esc).join(' · ') : 'Nothing is being watched or recorded';
      return `<section class="panel combined ${c.on ? 'on' : ''}">
        <span class="hk-switch ${c.on ? 'on' : ''}" aria-hidden="true"><i></i></span>
        <div class="title"><b>${esc(c.name)}</b> <span class="muted">is ${c.on ? 'on' : 'off'} in the Home app</span>
          ${snap.energy?.watts !== null && snap.energy?.watts !== undefined ? `<span class="badge" title="Estimated — the HDHomeRun has no power meter">${fmtW(snap.energy.watts)} · today ${fmtKWh(snap.energy.periods.today)}</span>` : ''}
          ${c.matter === 'ready' ? `<span class="badge accent" title="Shown in the Home app as a Matter outlet, with watts on its tile">${snap.connection === 'matterOnly' ? 'Matter only' : 'Matter'}</span>` : c.matter === 'starting' ? '<span class="badge warn">Matter starting…</span>' : ''}
          ${pending ? `<span class="badge warn" title="Waiting out the channel-surfing delay">turning ${c.active ? 'on' : 'off'}…</span>` : ''}
          <div class="meta"><span>${why}</span></div></div>
      </section>`;
    }

    function fmtW(w) {
      return `${w >= 10 ? Math.round(w) : (Math.round(w * 10) / 10)} W`;
    }

    function fmtKWh(wh) {
      if (!wh) return '0 kWh';
      return wh < 1000 ? `${(wh / 1000).toFixed(wh < 100 ? 3 : 2)} kWh` : `${(wh / 1000).toFixed(1)} kWh`;
    }

    function priceFor(wh) {
      const price = snap.energy?.pricePerKwh ?? (mode === 'homebridge' ? Number(api.config?.().energy?.pricePerKwh) || null : null);
      return price ? `$${((wh / 1000) * price).toFixed(2)}` : '';
    }

    function renderOnline() {
      const o = snap.online;
      if (!o) return '';
      const busy = o.tuners.filter((t) => t.inUse);
      const chips = (o.switches || []).map((w) => `<span class="chip ${w.on ? 'on' : ''}" title="HomeKit switch">${esc(w.name)}</span>`).join('');
      const status = !o.online ? '<span class="badge bad">Channels DVR not answering</span>'
        : `<span class="badge ${busy.length ? 'accent' : ''}">${busy.length ? `${busy.length} online stream${busy.length === 1 ? '' : 's'}` : 'Nothing online streaming'}</span>`;
      const cards = busy.map((t) => {
        const session = (snap.open || []).find((s) => s.deviceId === 'ONLINE' && s.tuner === t.index);
        const rec = t.activity === 'recording';
        const p = t.programme;
        return `<div class="tuner busy online ${rec ? 'rec' : ''}">
          <div class="label"><span>${esc(t.source || 'Online')}</span><span class="state">${rec ? '● Recording' : 'Watching'}</span></div>
          <div class="channel">${t.channelNumber ? `<span class="num">${esc(t.channelNumber)}</span>` : ''}<span class="cname" title="${esc(t.channelName || '')}">${esc(t.channelName || '')}</span></div>
          ${p ? `<div class="prog"><b>${esc(p.title)}</b>${p.episodeTitle ? ` <span class="faint">${esc(p.episodeTitle)}</span>` : ''}<span class="until"> until ${clock(p.end)}</span>${progress(p)}</div>` : rec && t.title ? `<div class="prog"><b>${esc(t.title)}</b></div>` : ''}
          <div class="client">${rec ? 'Recording in Channels DVR' : t.client || t.clientName ? `→ ${esc(t.clientName || t.client)}${t.clientName && t.client ? ` <span class="faint">${esc(t.client)}</span>` : ''}` : ''}</div>
          <div class="foot"><span>${session ? `for ${dur(session.seconds)}` : ''}</span></div>
        </div>`;
      }).join('');
      return `<section class="panel">
        <div class="device-head">
          <div class="title"><h2><span class="dot ${o.online ? 'on' : 'off'}"></span>${esc(o.name || 'Online TV')} <span class="faint" style="font-weight:400">· Channels DVR online channels</span></h2>
            ${chips ? `<div class="chips">${chips}</div>` : ''}</div>
          ${status}
        </div>
        ${cards ? `<div class="tuners">${cards}</div>` : `<p class="muted" style="margin:0">Channels from your M3U and other online sources show here while they are watched.</p>`}
      </section>`;
    }

    function sparkline(points) {
      if (points.length < 2) return '';
      const w = 110; const h = 26;
      const vals = points.map((p) => p[2]);
      const min = Math.min(50, ...vals); const max = 100;
      const xy = vals.map((v, i) => [(i / (vals.length - 1)) * w, h - 2 - ((v - min) / (max - min || 1)) * (h - 4)]);
      const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
      return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="Signal quality, last hour"><title>Signal quality, last ${vals.length} min</title>
        <polygon class="area" points="0,${h} ${line} ${w},${h}"></polygon><polyline points="${line}"></polyline></svg>`;
    }

    function renderStats() {
      const s = snap.stats;
      const p = s.periods[ui.period] || { seconds: 0, sessions: 0, allBusy: 0, peak: 0, devices: {}, channels: [], clients: [] };
      const label = PERIODS.find(([k]) => k === ui.period)?.[1] || '';
      const totalTuners = snap.devices.reduce((n, d) => n + (d.tuners.length || 0), 0);
      const noData = !p.seconds && !p.sessions && !p.onlineSeconds;

      const kpis = `<div class="kpis">
        <div class="kpi"><div class="k">Tuner time</div><div class="v">${hours(p.seconds)}</div><div class="s">${label}</div></div>
        <div class="kpi"><div class="k">Sessions</div><div class="v">${p.sessions}</div><div class="s">a channel watched on one tuner</div></div>
        <div class="kpi"><div class="k">All tuners busy</div><div class="v">${dur(p.allBusy, true)}</div><div class="s">time a recording could have missed out</div></div>
        <div class="kpi"><div class="k">Most tuners at once</div><div class="v">${p.peak}${totalTuners ? `<span class="faint" style="font-size:15px"> / ${totalTuners}</span>` : ''}</div><div class="s">${label}</div></div>
        ${snap.energy ? `<div class="kpi" title="Estimated from tuner use — the HDHomeRun has no power meter"><div class="k">Energy (estimated)</div><div class="v">${fmtKWh(snap.energy.periods[ui.period] || 0)}</div><div class="s">${[priceFor(snap.energy.periods[ui.period] || 0), `now ${fmtW(snap.energy.watts || 0)}`].filter(Boolean).join(' · ')}</div></div>` : ''}
        ${p.onlineSeconds ? `<div class="kpi"><div class="k">Online channels</div><div class="v">${hours(p.onlineSeconds)}</div><div class="s">watched through Channels DVR</div></div>` : ''}
      </div>`;

      const max = Math.max(...s.daily.map((d) => d.seconds), 1);
      const chart = columnChart(s.daily);
      const hoursChart = hourChart(s.hours);

      const chMax = Math.max(...p.channels.map((c) => c.seconds), 1);
      const channels = p.channels.length ? `<div class="bars">${p.channels.slice(0, 10).map((c) => barRow(`${c.number ? `<b>${esc(c.number)}</b> ` : ''}${esc(c.name || '')}`, c.key?.startsWith('ONLINE|') ? 'online' : '', c.seconds, chMax)).join('')}</div>` : '<p class="muted">Nothing watched in this period.</p>';
      const clMax = Math.max(...p.clients.map((c) => c.seconds), 1);
      const clients = p.clients.length ? `<div class="bars">${p.clients.map((c) => barRow(esc(c.name || c.ip), c.name ? esc(c.ip) : '', c.seconds, clMax)).join('')}</div>` : '<p class="muted">No clients in this period.</p>';

      const tunerRows = [];
      for (const [id, dev] of Object.entries(p.devices)) {
        if (dev.virtual) {
          if (dev.seconds) tunerRows.push({ label: `${dev.name} (online, Channels DVR)`, seconds: dev.seconds });
          continue;
        }
        const n = Math.max(Object.keys(dev.tuners).length, (snap.devices.find((d) => (d.deviceId || d.key) === id)?.tuners.length) || 0);
        for (let i = 0; i < n; i++) tunerRows.push({ label: `${dev.name} · Tuner ${i + 1}`, seconds: dev.tuners[i] || 0 });
      }
      const tMax = Math.max(...tunerRows.map((r) => r.seconds), 1);
      const tuners = tunerRows.length ? `<div class="bars">${tunerRows.map((r) => barRow(esc(r.label), '', r.seconds, tMax)).join('')}</div>` : '<p class="muted">No tuner use in this period.</p>';

      return `<div class="stack">
        ${kpis}
        ${noData && ui.period !== 'all' ? `<p class="muted">No viewing recorded ${ui.period === 'today' ? 'today yet' : 'in this period'}${s.since ? ` — statistics start ${esc(new Date(s.since).toLocaleDateString())}` : ''}.</p>` : ''}
        <section class="panel"><h2>Tuner hours per day <span class="faint" style="font-weight:400">· last 30 days</span></h2>${chart}<div class="chart-note" id="hd-note">${max > 1 ? 'Point at a day for details.' : 'No data yet.'}</div></section>
        <div class="grid two">
          <section class="panel"><h2>Top channels <span class="faint" style="font-weight:400">· ${esc(label)}</span></h2>${channels}</section>
          <section class="panel"><h2>Watching devices <span class="faint" style="font-weight:400">· ${esc(label)}</span></h2>${clients}</section>
          <section class="panel"><h2>Use per tuner <span class="faint" style="font-weight:400">· ${esc(label)}</span></h2>${tuners}</section>
          <section class="panel"><h2>When the tuners are used <span class="faint" style="font-weight:400">· hour of day, last 30 days</span></h2>${hoursChart}</section>
        </div>
      </div>`;
    }

    function barRow(name, sub, seconds, max) {
      return `<div class="barrow"><span class="name">${name}${sub ? `<span class="faint">${sub}</span>` : ''}</span><span class="val">${dur(seconds, true)}</span>
        <div class="track"><div class="fill" style="width:${Math.max(1, (seconds / max) * 100).toFixed(1)}%"></div></div></div>`;
    }

    function columnChart(daily) {
      const maxH = Math.max(1, ...daily.map((d) => d.seconds / 3600));
      const step = niceStep(maxH);
      const top = Math.ceil(maxH / step) * step;
      const n = daily.length;
      const grid = [];
      for (let v = 0; v <= top + 1e-9; v += step) grid.push(`<span style="bottom:${(v / top) * 100}%"><em>${+v.toFixed(1)}h</em></span>`);
      const cols = daily.map((d, i) => {
        const h = d.seconds / 3600;
        const date = new Date(d.day + 'T12:00:00');
        const lab = (n - 1 - i) % 5 === 0 ? `<i>${date.toLocaleDateString([], { day: 'numeric', month: 'short' })}</i>` : '';
        return `<div class="c${i === n - 1 ? ' today' : ''}" data-i="${i}"><b style="height:${h ? Math.max(1, (h / top) * 100) : 0}%"></b>${lab}</div>`;
      }).join('');
      return `<div class="cols" id="hd-chart" role="img" aria-label="Tuner hours per day, last 30 days"><div class="grid-lines">${grid.join('')}</div><div class="bars-row">${cols}</div></div>`;
    }

    function bindChart() {
      const chart = $('#hd-chart');
      const note = $('#hd-note');
      if (!chart || !note) return;
      chart.addEventListener('mouseover', (e) => {
        const c = e.target.closest('[data-i]');
        if (!c) return;
        const d = snap.stats.daily[Number(c.dataset.i)];
        const date = new Date(d.day + 'T12:00:00').toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
        note.textContent = `${date}: ${dur(d.seconds)} of tuner time, ${d.sessions} session${d.sessions === 1 ? '' : 's'}`;
      });
    }

    function hourChart(hrs) {
      const max = Math.max(1, ...hrs);
      if (max <= 1) return '<p class="muted">No data yet.</p>';
      const cols = hrs.map((v, h) => {
        const lab = h % 3 === 0 ? `<i>${h === 0 ? '12a' : h === 12 ? '12p' : h < 12 ? `${h}a` : `${h - 12}p`}</i>` : '';
        return `<div class="c" title="${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00 · ${dur(v)}"><b style="height:${v ? Math.max(1, (v / max) * 100) : 0}%"></b>${lab}</div>`;
      }).join('');
      return `<div class="cols short" role="img" aria-label="Tuner use by hour of day"><div class="bars-row">${cols}</div></div>`;
    }

    function niceStep(max) {
      const raw = max / 4;
      const pow = Math.pow(10, Math.floor(Math.log10(raw || 1)));
      const n = raw / pow;
      return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
    }

    function renderSessions() {
      const q = ui.sessionFilter.trim().toLowerCase();
      const open = (snap.open || []).map((s) => ({ ...s, live: true }));
      const rows = open.concat(snap.sessions).filter((s) => !q || [s.channelNumber, s.channelName, s.client, s.clientName, s.device, s.source, s.deviceId === 'ONLINE' ? 'online' : `tuner ${s.tuner + 1}`].join(' ').toLowerCase().includes(q));
      if (!rows.length) return `<div class="panel empty"><strong>${q ? 'No matching sessions' : 'No sessions yet'}</strong>${q ? '' : 'Each time a tuner streams a channel it shows up here.'}</div>`;
      const multi = snap.devices.length > 1;
      return `<section class="panel"><div class="table-wrap"><table>
        <thead><tr><th>Started</th><th>Channel</th><th>Watched on</th><th>Tuner</th><th class="num">Duration</th><th class="num hide-sm">Signal</th></tr></thead>
        <tbody>${rows.slice(0, ui.sessionLimit).map((s) => `<tr>
          <td>${esc(when(s.start))}${s.live ? ' <span class="badge accent">Live</span>' : ''}</td>
          <td><b>${esc(s.channelNumber || '')}</b> ${esc(s.channelName || '')}</td>
          <td>${esc(clientText(s) || '—')}${s.clientName ? `<span class="sub">${esc(s.client)}</span>` : ''}</td>
          <td>${s.deviceId === 'ONLINE' ? `<span class="badge">${esc(s.source || 'Online')}</span>${s.activity === 'recording' ? ' <span class="badge bad">Rec</span>' : ''}` : `${multi ? `${esc(s.device)} · ` : ''}${s.tuner + 1}`}</td>
          <td class="num">${dur(s.seconds)}</td>
          <td class="num hide-sm">${s.signalQuality !== undefined ? `<span class="sq ${level(s.signalQuality)}" title="Average signal quality${s.minSignalQuality !== undefined ? `, lowest ${s.minSignalQuality}%` : ''}">${s.signalQuality}%</span>` : '<span class="faint">—</span>'}</td>
        </tr>`).join('')}</tbody></table></div>
        ${rows.length > ui.sessionLimit ? `<div style="text-align:center;margin-top:12px"><button class="btn" id="hd-more">Show more (${rows.length - ui.sessionLimit} older)</button></div>` : ''}</section>`;
    }

    function renderChannels() {
      const ids = Object.keys(snap.lineups || {});
      const sel = $('#hd-cd');
      if (sel) {
        if (!ids.includes(ui.channelDevice)) ui.channelDevice = ids[0] || '';
        const opts = ids.map((id) => `<option value="${esc(id)}" ${id === ui.channelDevice ? 'selected' : ''}>${esc(snap.devices.find((d) => d.deviceId === id)?.name || id)}</option>`).join('');
        if (sel.innerHTML !== opts) sel.innerHTML = opts;
        sel.style.display = ids.length > 1 ? '' : 'none';
      }
      const dev = snap.devices.find((d) => d.deviceId === ui.channelDevice);
      const links = $('#hd-clinks');
      if (links) links.innerHTML = dev?.baseUrl ? `<a href="${esc(dev.baseUrl)}/lineup.m3u" target="_blank" rel="noopener">Playlist (.m3u) ↗</a><a href="${esc(dev.baseUrl)}/lineup.html" target="_blank" rel="noopener">Device lineup ↗</a>` : '';
      const list = snap.lineups[ui.channelDevice] || [];
      if (!list.length) return `<div class="panel empty"><strong>No channels yet</strong>The channel list is read from the device every 30 minutes. If it stays empty, run a channel scan in the HDHomeRun app.</div>`;
      const watched = {};
      for (const c of snap.stats.periods.last30?.channels || []) {
        const [id, num] = c.key.split('|');
        if (id === ui.channelDevice) watched[num] = c.seconds;
      }
      const live = new Set((dev?.tuners || []).filter((t) => t.inUse).map((t) => String(t.channelNumber)));
      const q = ui.channelFilter.trim().toLowerCase();
      const rows = list.filter((c) => !q || `${c.GuideNumber} ${c.GuideName}`.toLowerCase().includes(q));
      const status = dev?.lineupStatus;
      const hasGuide = Object.keys(snap.guide?.[ui.channelDevice]?.channels || {}).length > 0;
      return `<section class="panel">
        <p class="muted" style="margin:0 0 10px">${list.length} channels${status?.Source ? ` · ${esc(status.Source)}` : ''}${status?.ScanInProgress ? ' · <span class="badge warn">Scan in progress</span>' : ''}</p>
        <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Name</th>${hasGuide ? '<th>On now</th><th class="hide-sm">Next</th>' : ''}<th class="hide-sm">Format</th><th class="num">Watched (30 days)</th></tr></thead>
        <tbody>${rows.map((c) => `<tr>
          <td><b>${esc(c.GuideNumber)}</b></td>
          <td>${esc(c.GuideName)} ${c.HD ? '<span class="badge">HD</span>' : ''} ${c.Favorite ? '<span class="badge">★</span>' : ''} ${live.has(String(c.GuideNumber)) ? '<span class="badge accent">On now</span>' : ''} ${c.DRM ? '<span class="badge warn">DRM</span>' : ''}</td>
          ${hasGuide ? guideCells(ui.channelDevice, c.GuideNumber) : ''}
          <td class="hide-sm faint">${esc([c.VideoCodec, c.AudioCodec].filter(Boolean).join(' / ').toUpperCase())}</td>
          <td class="num">${watched[c.GuideNumber] ? dur(watched[c.GuideNumber], true) : '<span class="faint">—</span>'}</td>
        </tr>`).join('')}</tbody></table></div></section>`;
    }

    // ---------- guide ----------
    const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const guideFor = (id, num) => (num === undefined || num === null ? null : snap.guide?.[id]?.channels?.[String(num)]);

    function programme(id, num) {
      const g = guideFor(id, num);
      if (!g || (!g.now && !g.next)) return '';
      const now = g.now ? `<div class="prog" title="${esc(g.now.title)}${g.now.episodeTitle ? ` — ${esc(g.now.episodeTitle)}` : ''}"><b>${esc(g.now.title)}</b>${g.now.episodeTitle ? ` <span class="faint">${esc(g.now.episodeTitle)}</span>` : ''}<span class="until"> until ${clock(g.now.end)}</span>${progress(g.now)}</div>` : '';
      const next = g.next ? `<div class="prog next">Next ${clock(g.next.start)} · ${esc(g.next.title)}</div>` : '';
      return now + next;
    }

    function progress(p) {
      const f = Math.max(0, Math.min(1, (Date.now() - p.start) / (p.end - p.start || 1)));
      return `<div class="pbar"><i style="width:${(f * 100).toFixed(1)}%"></i></div>`;
    }

    function guideCells(id, num) {
      const g = guideFor(id, num);
      const cell = (p, cls = '') => `<td class="${cls}">${p ? `${esc(p.title)}<span class="sub">${clock(p.start)}–${clock(p.end)}</span>` : '<span class="faint">—</span>'}</td>`;
      return cell(g?.now) + cell(g?.next, 'hide-sm');
    }

    // ---------- recordings (Channels DVR) ----------
    function channelLabel(num) {
      if (!num) return '';
      for (const list of Object.values(snap.lineups || {})) {
        const c = list.find((l) => String(l.GuideNumber) === String(num));
        if (c) return `<b>${esc(num)}</b> ${esc(c.GuideName)}`;
      }
      return `<b>${esc(num)}</b>`;
    }

    function dvrLink(url) {
      try {
        const u = new URL(url);
        if (['127.0.0.1', 'localhost'].includes(u.hostname) && location.hostname) u.hostname = location.hostname;
        return u.toString().replace(/\/$/, '');
      } catch { return url; }
    }

    function when2(t) {
      const d = new Date(t);
      const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
      const day = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
      return `${day} ${clock(t)}`;
    }

    function renderRecordings() {
      const r = snap.recordings || { status: 'off' };
      if (r.status === 'off') {
        return `<div class="panel empty"><strong>Channels DVR not connected</strong>
          Add your Channels DVR server's address, for example <code>http://192.168.1.5:8089</code>, under <b>Channels DVR</b> in the plugin's settings${mode === 'homebridge' ? ' (Settings tab)' : ''}. If it runs on this Homebridge machine it is found by itself.</div>`;
      }
      const head = `<div class="toolbar" style="margin-bottom:0"><span class="muted">Channels DVR at ${esc(r.url)} · checked ${esc(ago(r.checkedAt))}</span><span class="spacer"></span>
        <a class="btn" href="${esc(dvrLink(r.url))}" target="_blank" rel="noopener">Open Channels DVR ↗</a></div>`;
      const err = r.status === 'error' ? `<div class="panel alert bad"><b>Channels DVR isn't answering</b> — ${esc(r.error || '')}. Showing what was last read.</div>` : '';
      const warnings = (r.warnings || []).length ? `<section class="panel alert ${r.warnings.some((w) => w.level === 'bad') ? 'bad' : 'warn'}">
        <h2>Tuner clashes</h2><ul class="warns">${r.warnings.map((w) => `<li><b>${esc(w.title)}</b> <span class="muted">${esc(when2(w.start))}</span> — ${esc(w.text)}</li>`).join('')}</ul>
        <p class="note" style="margin-bottom:0">Counts the ${r.tuners} tuners on your HDHomeRun${snap.devices.length > 1 ? 's' : ''}. If Channels DVR also has other tuners or sources, it may still manage.</p></section>` : '';
      const nowCards = (r.recordingNow || []).map((j) => `<div class="tuner busy rec"><div class="label"><span>Recording</span><span class="state">● until ${clock(j.end)}</span></div>
        <div class="channel"><span class="cname">${esc(j.title)}</span></div>${j.episodeTitle ? `<div class="client">${esc(j.episodeTitle)}</div>` : ''}
        <div class="client">${channelLabel(j.channel)}</div>${progress(j)}</div>`).join('');
      const upcoming = (r.upcoming || []).length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Programme</th><th>Channel</th><th class="num">Length</th><th></th></tr></thead><tbody>
        ${r.upcoming.map((j) => `<tr><td>${esc(when2(j.start))}</td><td>${esc(j.title)}${j.episodeTitle ? `<span class="sub">${esc(j.episodeTitle)}</span>` : ''}</td><td>${channelLabel(j.channel)}</td>
          <td class="num">${dur((j.end - j.start) / 1000)}</td><td>${j.warning ? `<span class="badge ${j.warning.level === 'bad' ? 'bad' : 'warn'}" title="${esc(j.warning.text)}">${j.warning.level === 'bad' ? 'Clash' : 'All tuners'}</span>` : ''}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">Nothing scheduled in the next 7 days.</p>';
      const recent = (r.recent || []).length ? `<div class="table-wrap"><table><thead><tr><th>Recorded</th><th>Programme</th><th>Channel</th><th class="num">Length</th></tr></thead><tbody>
        ${r.recent.map((x) => `<tr><td>${x.recordedAt ? esc(when(x.recordedAt)) : ''}</td><td>${esc(x.title)}${x.episodeTitle ? `<span class="sub">${esc(x.episodeTitle)}</span>` : ''}${x.completed ? '' : ' <span class="badge accent">Recording</span>'}</td>
          <td>${channelLabel(x.channel)}</td><td class="num">${x.duration ? dur(x.duration) : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No recordings yet.</p>';
      const failed = (r.failed || []).length ? `<section class="panel alert bad"><h2>Failed recordings</h2><ul class="warns">${r.failed.map((j) => `<li><b>${esc(j.title)}</b> <span class="muted">${esc(when2(j.start))}</span>${j.error ? ` — ${esc(j.error)}` : ''}</li>`).join('')}</ul></section>` : '';
      return `<div class="stack">${head}${err}${warnings}${failed}
        ${nowCards ? `<section class="panel"><h2>Recording now</h2><div class="tuners">${nowCards}</div></section>` : ''}
        <section class="panel"><h2>Upcoming <span class="faint" style="font-weight:400">· next 7 days</span></h2>${upcoming}</section>
        <section class="panel"><h2>Recent recordings</h2>${recent}</section></div>`;
    }

    // ---------- reception per channel ----------
    function renderReception() {
      const ids = Object.keys(snap.reception || {});
      const sel = $('#hd-rd');
      if (!ids.includes(ui.recDevice)) ui.recDevice = ids[0] || '';
      if (sel) {
        const opts = ids.map((id) => `<option value="${esc(id)}" ${id === ui.recDevice ? 'selected' : ''}>${esc(snap.devices.find((d) => d.deviceId === id)?.name || id)}</option>`).join('');
        if (sel.innerHTML !== opts) sel.innerHTML = opts;
        sel.style.display = ids.length > 1 ? '' : 'none';
      }
      const all = snap.reception?.[ui.recDevice] || [];
      const rows = all.filter((r) => r[ui.recPeriod]);
      if (!rows.length) {
        return `<div class="panel empty"><strong>No reception readings ${all.length ? 'in the last 7 days' : 'yet'}</strong>A channel's signal is measured while it is being watched or recorded, so this fills in as the tuners are used.</div>`;
      }
      const period = ui.recPeriod === 'd7' ? '7 days' : '30 days';
      const pct = (v) => (v === undefined || v === null ? '<span class="faint">—</span>' : `<span class="sq ${level(v)}">${v}%</span>`);
      let table;
      if (ui.recGroup === 'frequency') {
        const groups = new Map();
        for (const r of rows) {
          const k = r.frequency || 0;
          const g = groups.get(k) || { frequency: r.frequency, n: 0, ss: 0, snq: 0, seq: 0, lowest: 100, channels: [] };
          const x = r[ui.recPeriod];
          g.n += x.samples; g.ss += x.signalStrength * x.samples; g.snq += x.signalQuality * x.samples; g.seq += x.symbolQuality * x.samples;
          g.lowest = Math.min(g.lowest, x.lowest);
          g.channels.push(r);
          groups.set(k, g);
        }
        const list = [...groups.values()].map((g) => ({ ...g, ss: Math.round(g.ss / g.n), snq: Math.round(g.snq / g.n), seq: Math.round(g.seq / g.n) })).sort((a, b) => a.snq - b.snq);
        table = `<table><thead><tr><th>Frequency</th><th>Channels</th><th class="num">Strength</th><th class="num">Quality</th><th class="num hide-sm">Symbol</th><th class="num">Lowest</th></tr></thead><tbody>
          ${list.map((g) => `<tr><td><b>${g.frequency ? mhz(g.frequency) : 'Unknown'}</b></td><td>${g.channels.map((c) => `${esc(c.number)} ${esc(c.name || '')}`).join(', ')}</td>
            <td class="num">${pct(g.ss)}</td><td class="num">${pct(g.snq)}</td><td class="num hide-sm">${pct(g.seq)}</td><td class="num">${pct(g.lowest)}</td></tr>`).join('')}</tbody></table>`;
      } else {
        table = `<table><thead><tr><th>Channel</th><th class="hide-sm">Frequency</th><th class="num">Strength</th><th class="num">Quality</th><th class="num hide-sm">Symbol</th><th class="num">Lowest</th><th class="hide-sm">Last 14 days</th><th class="hide-sm">Measured</th></tr></thead><tbody>
          ${rows.map((r) => { const x = r[ui.recPeriod]; return `<tr><td><b>${esc(r.number)}</b> ${esc(r.name || '')}</td><td class="hide-sm faint">${r.frequency ? mhz(r.frequency) : ''}</td>
            <td class="num">${pct(x.signalStrength)}</td><td class="num">${pct(x.signalQuality)}</td><td class="num hide-sm">${pct(x.symbolQuality)}</td><td class="num">${pct(x.lowest)}</td>
            <td class="hide-sm">${trend(r.trend)}</td><td class="hide-sm faint">${esc(ago(r.last))}</td></tr>`; }).join('')}</tbody></table>`;
      }
      return `<div class="stack"><section class="panel"><h2>Reception per ${ui.recGroup === 'frequency' ? 'frequency' : 'channel'} <span class="faint" style="font-weight:400">· average while watched, ${period} · weakest first</span></h2>
        <div class="table-wrap">${table}</div>
        <p class="note">Channels on the same frequency share one signal from the transmitter, so <b>By frequency</b> shows where reception is weak. Quality (signal-to-noise) matters most: below about 60% the picture may break up. Strength alone can be high on a poor signal.</p></section></div>`;
    }

    function trend(values) {
      return `<span class="trend" title="Average quality per day">${values.map((v) => `<i class="${v === null ? 'none' : level(v)}" style="height:${v === null ? 2 : Math.max(3, v * 0.2)}px"></i>`).join('')}</span>`;
    }

    // ---------- settings (Config UI X) ----------
    let found = null;
    let searching = false;
    function renderSettings(body) {
      const configured = api.config().devices || [];
      const row = (f) => {
        const already = configured.some((d) => String(d.deviceId || '').toUpperCase() === f.deviceId || d.host === f.ip);
        return `<div class="found-row"><div class="title"><b>${esc(f.name || 'HDHomeRun')}</b> ${f.model ? `<span class="faint">${esc(f.model)}</span>` : ''}
          <div class="meta"><span>ID ${esc(f.deviceId)}</span><span>${esc(f.ip)}</span>${f.tunerCount ? `<span>${f.tunerCount} tuners</span>` : ''}${f.firmware ? `<span>Firmware ${esc(f.firmware)}</span>` : ''}</div></div>
          ${already ? '<span class="badge accent">In settings</span>' : `<button class="btn primary" data-add="${esc(f.deviceId)}">Add</button>`}</div>`;
      };
      body.innerHTML = `<section class="panel">
        <h2>Find HDHomeRuns on the network</h2>
        <p class="muted" style="margin:0 0 12px">With automatic discovery on, the plugin finds tuners by itself. Adding one here gives it a name and a fixed address, and keeps it even with discovery off.</p>
        <div class="toolbar" style="margin:0"><button class="btn primary" id="hd-find">${searching ? 'Searching…' : found ? 'Search again' : 'Search'}</button>
          <span class="spacer"></span><input type="search" id="hd-host" placeholder="Or test an address, e.g. 192.168.1.30"><button class="btn" id="hd-test">Test</button></div>
        <div class="found" id="hd-found">${found ? (found.length ? found.map(row).join('') : '<p class="muted">No HDHomeRun answered. It may be on another subnet or VLAN: enter its address above.</p>') : ''}</div>
        <p class="note">After adding, review the device below and click <b>Save</b>; then restart Homebridge (or the child bridge).</p>
      </section>`;
      $('#hd-find').addEventListener('click', async () => {
        searching = true; renderSettings(body);
        try { found = await api.discover(); } catch (e) { toast('error', `Search failed: ${e.message || e}`); found = []; }
        searching = false; renderSettings(body);
      });
      $('#hd-test').addEventListener('click', async () => {
        const host = $('#hd-host').value.trim();
        if (!host) return;
        const r = await api.probe(host).catch((e) => ({ ok: false, error: e.message }));
        if (!r.ok) return toast('error', `No HDHomeRun at ${host}: ${r.error}`);
        const i = r.info;
        found = (found || []).filter((f) => f.deviceId !== String(i.DeviceID).toUpperCase());
        found.unshift({ deviceId: String(i.DeviceID).toUpperCase(), ip: host, name: i.FriendlyName, model: i.ModelNumber, firmware: i.FirmwareVersion, tunerCount: i.TunerCount });
        toast('success', `Found ${i.FriendlyName || 'HDHomeRun'} ${i.ModelNumber || ''} at ${host}`);
        renderSettings(body);
      });
      $('#hd-found').addEventListener('click', async (e) => {
        const b = e.target.closest('button[data-add]');
        if (!b) return;
        const f = found.find((x) => x.deviceId === b.dataset.add);
        await api.addDevice({ host: f.ip, deviceId: f.deviceId, name: f.name });
        toast('success', 'Added — click Save to keep it');
        renderSettings(body);
      });
    }

    // ---------- boot ----------
    (async () => {
      try { await api.init?.(); } catch (e) { console.warn(e); }
      renderControls();
      render();
      await refresh();
      const { full } = api.live(onLive, (ok) => { connected = ok; renderStatus(); });
      setInterval(() => { if (ui.tab !== 'settings' || !snap) refresh(); }, full);
      setInterval(renderStatus, 5000);
    })();
  }

  function readPref(k, d) { try { return localStorage.getItem(`hdhr.${k}`) || d; } catch { return d; } }
  function writePref(k, v) { try { localStorage.setItem(`hdhr.${k}`, v); } catch { /* storage off */ } }

  window.HDHRDashboard = { start };
})();
