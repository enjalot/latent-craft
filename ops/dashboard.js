const number = value => value == null ? 'Unavailable' : Math.round(value).toLocaleString();
const bytes = value => value == null ? 'Unavailable' : `${(value / 1024 ** 3).toFixed(2)} GiB`;
const money = value => value == null ? 'Not connected' : `$${value.toFixed(value < 1 ? 4 : 2)}`;
function line(parent, text, className = '') { const p = document.createElement('p'); p.textContent = text; p.className = className; parent.append(p); return p; }
function pairs(parent, entries) { const list = document.createElement('dl'); for (const [name, value] of entries) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; dd.textContent = value; list.append(dt, dd); } parent.append(list); }
const progressLabel = value => `${value.state}${value.stale ? ` · no progress update for ${Math.round(value.progress_age_seconds / 60) || '?'} minutes; check the job` : ''}`;
function card(name, observation, render) {
  const body = document.querySelector(`#${name} .content`); body.replaceChildren();
  if (!observation) { line(body, 'Awaiting first provider observation…'); return; }
  if (observation.state !== 'ok') line(body, `Unavailable: ${observation.error}. ${observation.data ? 'Showing the last successful observation.' : 'No zero-cost assumption.'}`, 'warning');
  if (observation.data) { render(body, observation.data); line(body, observation.data.scope || '', 'small'); line(body, observation.data.note || '', 'small'); }
  line(body, `Checked ${new Date(observation.checked_at).toLocaleString()}${observation.last_success_at ? ` · last success ${new Date(observation.last_success_at).toLocaleString()}` : ''}`, 'small');
}
async function refresh() {
  try {
    const response = await fetch('/api/status'); if (!response.ok) throw Error(`HTTP ${response.status}`);
    const state = await response.json(), build = state.build;
    document.querySelector('#updated').textContent = `Local status ${new Date(state.at).toLocaleTimeString()} · provider reports refresh every ${state.refresh_seconds / 60} minutes`;
    const percent = build.total_rows ? 100 * build.completed_rows / build.total_rows : 0;
    document.querySelector('#progress').value = percent;
    const buildBox = document.querySelector('#build'); buildBox.replaceChildren();
    line(buildBox, `${number(build.completed_rows)} / ${number(build.total_rows)} images · ${percent.toFixed(1)}%`, 'metric');
    pairs(buildBox, [['State', progressLabel(build)], ['Completed shards', `${number(build.completed_shards)} / ${number(build.total_shards)}`], ['Encoded files so far', bytes(build.bytes)], ['Workers', number(build.workers)]]);
    const rate = build.completed_rows / build.elapsed_seconds, hours = (build.total_rows - build.completed_rows) / rate / 3600;
    document.querySelector('#build-note').textContent = build.error || (build.state === 'building' && Number.isFinite(hours) ? `Rough remaining time: ${hours.toFixed(1)} hours at the average observed rate. This includes completed shards only; it excludes upload and deployment. Checkpointed, original 256px files untouched.` : 'The full manifest is published only after all shards complete and validate.');
    const jobs = document.querySelector('#upload'); jobs.replaceChildren();
    for (const [label, job] of [['R2 thumbnails', state.upload], ['R2 map and metadata', state.static_upload], ['HF publication', state.deployment]]) {
      line(jobs, `${label}: ${progressLabel(job)}${job.files_done != null ? ` · ${number(job.files_done)} / ${number(job.files_total)} files · ${bytes(job.bytes_done)}` : ''}${job.phase ? ` · ${job.phase}` : ''}`, job.stale || job.state === 'failed' ? 'warning' : '');
    }
    if (state.deployment.state === 'complete' && state.deployment.url) {
      const link = document.createElement('a'); link.href = state.deployment.url; link.textContent = 'Open verified MONET Space ↗'; jobs.append(link);
    }
    card('modal', state.providers.modal, (body, data) => { line(body, `${money(data.gross_usd)} month to date`, 'metric'); pairs(body, data.apps.map(app => [app.name, money(app.usd)])); });
    card('gcp', state.providers.gcp, (body, data) => { line(body, bytes(data.storage_bytes.value), 'metric'); pairs(body, [['Objects', number(data.objects.value)], ['Bytes sent · month to date', bytes(data.sent_bytes.value)], ['Requests · month to date', number(data.requests.value)], ['Actual billed cost', money(data.billed_usd)]]); line(body, `Storage sample: ${data.storage_bytes.observed_at ? new Date(data.storage_bytes.observed_at).toLocaleString() : 'unavailable'}`, 'small'); });
    card('hf', state.providers.hf, (body, data) => { for (const space of data.spaces) { line(body, space.repo); pairs(body, [['Stage', space.stage], ['Hardware', space.hardware || '—'], ['Compute rate', space.hourly_compute_usd == null ? 'Not estimated' : `${money(space.hourly_compute_usd)} / hour`]]); } });
    card('r2', state.providers.r2, (body, data) => {
      if (data.connection !== 'connected') { line(body, data.connection, 'warning'); line(body, 'Estimated full 128px store: about 277 GiB. Storage run rate roughly $4–5/month, before requests; not measured R2 usage.'); return; }
      const latest = data.storage[0]?.max;
      line(body, bytes(latest?.payloadSize), 'metric');
      pairs(body, [['Objects', number(latest?.objectCount)], ['Pending multipart uploads', number(latest?.uploadCount)], ['Storage run rate before free allowance', latest ? `${money((latest.payloadSize + latest.metadataSize) / 1e9 * .015)} / month (estimate)` : 'Unavailable']]);
      line(body, `Storage sample: ${data.storage[0]?.dimensions.datetime ? new Date(data.storage[0].dimensions.datetime).toLocaleString() : 'awaiting provider metric'}`, 'small');
      pairs(body, data.operations.map(op => [`${op.dimensions.actionType} · ${op.dimensions.actionStatus}`, number(op.sum.requests)]));
    });
  } catch (error) { document.querySelector('#updated').textContent = `Local dashboard unavailable: ${error.message}. Previous observations may be stale.`; }
}
await refresh(); setInterval(refresh, 10000);
