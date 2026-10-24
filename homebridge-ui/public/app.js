/* global homebridge */
'use strict';
(async () => {
  const el = id => document.getElementById(id);
  let blocks = await homebridge.getPluginConfig();
  let pending;
  let lastDiagnostics;
  const measurementLabels = { pm02: 'PM2.5 (µg/m³)', pm10: 'PM10 (µg/m³)', rco2: 'CO₂ (ppm)',
    atmp: 'Temperature (°C)', rhum: 'Humidity (%)', tvocIndex: 'VOC index (unitless)',
    noxIndex: 'NOx index (unitless)', battPercent: 'Battery (%)' };
  const refresh = () => {
    const selection = el('sensor').value;
    el('sensor').replaceChildren();
    blocks.forEach((block, blockIndex) => (block.sensors || []).forEach((sensor, index) => {
      const option = document.createElement('option');
      option.value = `${blockIndex}:${index}`;
      option.textContent = sensor.serialno;
      el('sensor').append(option);
    }));
    if ([...el('sensor').options].some(option => option.value === selection)) { el('sensor').value = selection; }
  };
  const selected = () => {
    if (!el('sensor').value) { throw new Error('Add a monitor in the settings below first.'); }
    const [block, sensor] = el('sensor').value.split(':').map(Number);
    return blocks[block].sensors[sensor];
  };
  const run = async fn => {
    const buttons = [...document.querySelectorAll('.ag-tools button, #discover, #confirm-add')];
    buttons.forEach(button => { button.disabled = true; });
    el('status').textContent = 'Working…';
    try { await fn(); }
    catch (error) { el('status').textContent = error.message || 'Request failed. Check the Homebridge log and retry.'; }
    finally { buttons.forEach(button => { button.disabled = false; }); }
  };
  const table = (headers, rows) => {
    const wrap = document.createElement('div'); wrap.className = 'ag-values';
    const result = document.createElement('table'); result.className = 'table';
    const head = document.createElement('thead'); const tr = document.createElement('tr');
    headers.forEach(header => { const th = document.createElement('th'); th.scope = 'col'; th.textContent = header; tr.append(th); });
    head.append(tr); result.append(head);
    const body = document.createElement('tbody');
    rows.forEach(row => { const line = document.createElement('tr'); row.forEach(value => {
      const cell = document.createElement('td'); cell.textContent = String(value ?? 'Unavailable'); line.append(cell);
    }); body.append(line); });
    result.append(body); wrap.append(result); el('report').replaceChildren(wrap);
  };
  el('discover').onclick = () => run(async () => {
    const devices = await homebridge.request('/discover');
    el('found').replaceChildren();
    devices.forEach(device => {
      const row = document.createElement('div'); row.className = 'ag-device';
      const text = document.createElement('span'); text.textContent = `${device.serialno} — ${device.model || 'AirGradient'} (${device.host}:${device.port})`;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-outline-primary'; button.textContent = 'Review monitor';
      button.onclick = () => { pending = device; el('add-summary').textContent = text.textContent; el('add-dialog').showModal(); };
      row.append(text, button); el('found').append(row);
    });
    el('status').textContent = devices.length ? `Found ${devices.length} monitor(s). Review a monitor to add it.`
      : 'No monitors discovered. Enter the serial number and optional IP address in settings, then test the connection.';
  });
  el('cancel-add').onclick = () => { pending = undefined; el('add-dialog').close(); };
  el('add-dialog').addEventListener('cancel', () => { pending = undefined; });
  el('confirm-add').onclick = () => run(async () => {
    const candidate = pending;
    if (!candidate) { return; }
    await homebridge.request('/probe', candidate);
    blocks = await homebridge.getPluginConfig();
    if (pending !== candidate) {
      el('status').textContent = 'Monitor add cancelled. Your configuration has not changed.';
      return;
    }
    if (blocks.some(block => (block.sensors || []).some(sensor => String(sensor.serialno).toLowerCase() === candidate.serialno.toLowerCase()))) {
      throw new Error('This monitor is already configured.');
    }
    if (!blocks.length) { blocks = [{ platform: 'AirGradientPlatform', sensors: [] }]; }
    blocks[0].sensors ||= [];
    blocks[0].sensors.push({ serialno: candidate.serialno, host: candidate.host, port: candidate.port });
    await homebridge.updatePluginConfig(blocks);
    refresh(); el('add-dialog').close(); pending = undefined;
    el('status').textContent = 'Monitor staged. Save your settings and restart Homebridge to connect it.';
  });
  el('probe').onclick = () => run(async () => {
    const data = await homebridge.request('/probe', selected());
    table(['Property', 'Device response'], Object.entries(data).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value]));
    el('status').textContent = 'Connection succeeded and the serial number matches.';
  });
  el('diagnostics').onclick = () => run(async () => {
    lastDiagnostics = await homebridge.request('/diagnostics', { serialno: selected().serialno });
    if (!lastDiagnostics) { throw new Error('No diagnostics recorded yet. Save settings and restart Homebridge, then refresh.'); }
    const data = lastDiagnostics;
    table(['Property', 'Last recorded state'], [
      ['Model', data.model], ['Firmware', data.firmware], ['API', data.apiVersion], ['Reading age (seconds)', data.ageSeconds],
      ['Failed polls', data.failures], ['Wi-Fi signal (dBm)', data.wifiRssi], ['Connection error', data.lastError || 'None'],
      ...Object.entries(data.values || {}).map(([key, value]) => [measurementLabels[key] || key, value]),
      ...Object.entries(data.readingTimes || {}).map(([key, value]) => [`${key} last valid`, new Date(value).toLocaleString()]),
    ]);
    el('status').textContent = data.offline ? 'Monitor was offline at its last attempt.' : 'Diagnostics refreshed. Check reading ages before using retained values.';
  });
  el('history').onclick = () => run(async () => {
    const data = await homebridge.request('/history', { serialno: selected().serialno });
    table(['Time', 'PM2.5 (µg/m³)', 'CO₂ (ppm)', 'Temperature (°C)', 'Humidity (%)'], data.map(row => [new Date(row.time).toLocaleString(), row.pm02, row.rco2, row.atmp, row.rhum]));
    if (data.length > 1) {
      const summary = document.createElement('p');
      const trends = [['rco2', 'CO₂', 'ppm'], ['pm02', 'PM2.5', 'µg/m³']].map(([key, label, unit]) => {
        const valid = data.filter(row => Number.isFinite(row[key]));
        if (valid.length < 2) { return `${label}: not enough samples`; }
        const change = Math.round((valid[0][key] - valid.at(-1)[key]) * 10) / 10;
        return `${label}: ${change > 0 ? '+' : ''}${change} ${unit} from oldest to newest shown`;
      });
      summary.textContent = trends.join('. ');
      el('report').prepend(summary);
    }
    el('status').textContent = data.length ? `Showing ${data.length} recent samples, newest first.` : 'No history yet. Enable history retention in settings and restart Homebridge.';
  });
  el('export').onclick = () => run(async () => {
    const data = await homebridge.request('/diagnostics', { serialno: selected().serialno });
    if (!data) { throw new Error('No diagnostics available to export yet.'); }
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'airgradient-diagnostics.json'; link.click(); URL.revokeObjectURL(url);
    el('status').textContent = 'Diagnostics exported. Contains device identity and readings; excludes network addresses and configuration secrets.';
  });
  homebridge.addEventListener('configChanged', event => { blocks = event.data; refresh(); });
  homebridge.showSchemaForm(); refresh();
})().catch(error => { document.getElementById('status').textContent = error.message; });
