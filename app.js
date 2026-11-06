import {
  QUIET_WINDOW_MS, freshRun, acceptSignal, beginSpeak, turnParagraph,
  beginReflect, completeRun, pauseSummary, runNotes,
} from './signal-state.mjs';

const $ = (id) => document.getElementById(id);
const el = Object.fromEntries([
  'storyboard-mode', 'live-mode', 'source-notice', 'page-title', 'stage', 'stage-script', 'stage-action-slot',
  'paragraph-position', 'stage-instruction', 'cue-label', 'elapsed', 'previous-paragraph',
  'next-paragraph', 'smaller-type', 'larger-type', 'quiet-panel', 'quiet-title', 'quiet-hint',
  'quiet-rate', 'quiet-unit', 'quiet-progress', 'quiet-progress-fill', 'quiet-window-label',
  'confidence-label', 'breathing-trace', 'trace-path', 'trace-caption', 'run-summary',
  'summary-title', 'summary-source', 'before-rate', 'after-rate', 'before-confidence',
  'after-confidence', 'pause-summary', 'pause-timeline', 'summary-meaning', 'save-notes',
  'start-again', 'save-status', 'script-input', 'paragraph-count', 'apply-script',
  'script-status', 'input-title', 'storyboard-explanation', 'live-setup', 'connection-status',
  'video-input', 'adult-consent', 'adult-consent-label', 'data-consent', 'main-action', 'local-sdk-link',
  'stop-action', 'action-guidance', 'action-hint', 'app-error', 'announcements', 'read-consent',
].map((id) => [id, $(id)]));

let source = 'storyboard';
let paragraphs = splitScript(el['script-input'].value);
let paragraphIndex = 0;
let scriptSize = 34;
let run = null;
let runInputMode = null;
let active = false;
let starting = false;
let ended = false;
let sampleTimer = null;
let sampleOrigin = null;
let events = null;
let connection = 'unchecked';
let serverState = { status: null, keyConfigured: false, videoConfigured: false, hint: '' };
let lastAnnouncedReason = '';
let pendingValidation = null;
let saved = false;

// Keep the same phase action next to the script on narrow rehearsal stages.
const rehearsalAction = document.querySelector('.rehearsal-action');
const desktopActionParent = rehearsalAction.parentElement;
const narrowStage = matchMedia('(max-width: 780px)');
function placePhaseAction() {
  (narrowStage.matches ? el['stage-action-slot'] : desktopActionParent).append(rehearsalAction);
}
narrowStage.addEventListener('change', placePhaseAction);
placePhaseAction();

function splitScript(value) {
  return value.trim().split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
}

function text(node, value) {
  if (node.textContent !== String(value)) node.textContent = value;
}

function announce(message) { text(el.announcements, message); }
function seconds(ms) { return (ms / 1000).toFixed(1); }
function elapsed(ms) {
  const total = Math.max(0, Math.floor((ms ?? 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
function inputMode() { return document.querySelector('input[name="input-mode"]:checked').value; }
function consentGiven() { return el['adult-consent'].checked && el['data-consent'].checked; }
function liveReady() {
  return connection === 'connected' && serverState.keyConfigured &&
    ['ready', 'idle'].includes(serverState.status) &&
    (inputMode() === 'camera' || serverState.videoConfigured);
}

function setError(message) {
  el['app-error'].hidden = !message;
  text(el['app-error'], message || '');
}

async function api(path, body = {}) {
  const response = await fetch(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    keepalive: path === '/api/stop',
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The local service stopped. Check its terminal and try again.');
  return data;
}

function closeEvents() {
  if (events) events.close();
  events = null;
  connection = 'unchecked';
}

function connectEvents() {
  if (events) return;
  connection = 'connecting';
  events = new EventSource('/api/events');
  events.addEventListener('state', (event) => {
    connection = 'connected';
    handleServerState(JSON.parse(event.data));
  });
  events.addEventListener('signal', (event) => {
    if (source !== 'smartspectra' || !active || !run) return;
    const signal = JSON.parse(event.data);
    if (pendingValidation && signal.tMs >= pendingValidation.tMs) pendingValidation = null;
    receiveSignal(signal);
  });
  events.addEventListener('validation', (event) => {
    const validation = JSON.parse(event.data);
    pendingValidation = validation;
    if (source !== 'smartspectra' || !active || !run || validation.code === 0) return;
    receiveSignal({
      source: 'smartspectra', tMs: validation.tMs,
      rate: null, confidence: null, upperTrace: null, talking: null,
      validation: { code: validation.code, hint: validation.hint },
    });
  });
  events.addEventListener('error', (event) => {
    if (event.data) {
      const error = JSON.parse(event.data);
      setError(error.message || 'The SDK stopped. End this run, check the local service, then start again.');
    } else {
      connection = 'offline';
      if (active && source === 'smartspectra') {
        run = { ...run, signal: null, feedback: null, quietReady: false, quietMs: 0,
          quietStartMs: null, quietReason: 'waiting', trace: [], lastTalking: null, pauseStartMs: null };
        setError('The local signal connection stopped. End this run, check the server, then start again.');
      }
    }
    render();
  });
  render();
}

function handleServerState(state) {
  const priorStatus = serverState.status;
  serverState = { ...serverState, ...state };
  el['video-input'].disabled = active || !serverState.videoConfigured;
  if (!serverState.videoConfigured && inputMode() === 'file') {
    document.querySelector('input[name="input-mode"][value="camera"]').checked = true;
  }
  if (active && source === 'smartspectra' && priorStatus === 'running' && state.status === 'idle') {
    finishEarly('The video input ended. Your available notes are kept here. Start again with a longer recording to finish both quiet windows.');
    return;
  }
  if (active && source === 'smartspectra' && state.status === 'error') {
    finishEarly(state.hint || 'The SDK stopped. Check the local server before a new run.');
    return;
  }
  render();
}

function chooseSource(next) {
  if (active || starting || next === source) return;
  source = next;
  run = null;
  runInputMode = null;
  ended = false;
  saved = false;
  pendingValidation = null;
  el['adult-consent'].checked = false;
  el['data-consent'].checked = false;
  setError('');
  if (source === 'smartspectra') connectEvents();
  else closeEvents();
  render();
  announce(source === 'storyboard'
    ? 'Storyboard selected. Example breathing and talking signals play in this browser.'
    : 'Live SDK selected. Read the input and data notice, then give consent for this session.');
}

function applyScript() {
  if (active || starting) return;
  const next = splitScript(el['script-input'].value);
  if (!next.length) {
    text(el['script-status'], 'Add at least one paragraph to begin.');
    el['script-status'].classList.remove('sr-only');
    el['script-input'].setAttribute('aria-invalid', 'true');
    setError('Add at least one paragraph in Your words, then start the rehearsal.');
    el['script-input'].focus();
    return false;
  }
  paragraphs = next;
  setError('');
  el['script-status'].classList.add('sr-only');
  el['script-input'].setAttribute('aria-invalid', 'false');
  paragraphIndex = Math.min(paragraphIndex, paragraphs.length - 1);
  el['apply-script'].hidden = true;
  text(el['script-status'], `${paragraphs.length} paragraph${paragraphs.length === 1 ? '' : 's'} ready.`);
  render();
  return true;
}

async function startRun() {
  if (starting || active) return;
  if (!applyScript()) return;
  if (source === 'smartspectra' && (!consentGiven() || !liveReady())) {
    setError('Read the adult input and data notice, check both consent boxes, and connect the local SDK service to begin.');
    return;
  }
  setError('');
  saved = false;
  ended = false;
  paragraphIndex = 0;
  runInputMode = source === 'storyboard' ? 'illustrated' : inputMode();
  run = freshRun(source);
  lastAnnouncedReason = '';
  active = true;
  if (source === 'storyboard') {
    sampleOrigin = performance.now();
    sampleTimer = setInterval(sampleTick, 200);
    sampleTick();
    announce('Storyboard started. Stay quiet for the illustrated 30-second starting window.');
    render();
    return;
  }
  starting = true;
  render();
  try {
    const state = await api('/api/start', { mode: runInputMode, consent: true });
    serverState = { ...serverState, ...state };
    announce('Local SDK session started. Keep still and quiet with your face and chest visible.');
  } catch (error) {
    active = false;
    run = null;
    setError(error.message);
  } finally {
    starting = false;
    render();
  }
}

function sampleTick() {
  if (!active || !run || source !== 'storyboard') return;
  const tMs = Math.floor(performance.now() - sampleOrigin);
  const phaseMs = Math.max(0, tMs - (run.phaseStartMs ?? 0));
  // A repeatable sample: six seconds speaking, then a two-second pause.
  const talking = run.phase === 'speak' && phaseMs >= 1000 && ((phaseMs - 1000) % 8000 < 6000);
  const quietStart = run.quietStartMs ?? tMs;
  const windowComplete = !talking && tMs - quietStart >= QUIET_WINDOW_MS;
  const rate = run.phase === 'reflect' ? 13.8 : 14.6;
  receiveSignal({
    source: 'storyboard', tMs, rate,
    confidence: windowComplete ? 0.92 : 0,
    upperTrace: Math.sin((tMs / 1000) * (rate / 60) * Math.PI * 2),
    talking, validation: { code: 0, hint: 'Illustrated clear-camera validation.' },
  });
}

function receiveSignal(signal) {
  if (!active || !run) return;
  if (pendingValidation && signal.source === 'smartspectra' &&
      pendingValidation.tMs > signal.tMs && pendingValidation.code !== 0) return;
  const wasReady = run.quietReady;
  run = acceptSignal(run, signal);
  render();
  if (run.quietReady && !wasReady) {
    announce(run.phase === 'settle'
      ? 'Thirty continuous seconds quiet. Your starting point is ready. Choose Begin speaking.'
      : 'Your second quiet window is ready. Choose View run notes.');
  } else if (run.quietReason === 'quality' && lastAnnouncedReason !== 'quality') {
    announce(run.signal?.validation?.hint || 'Adjust camera framing and lighting to start a new quiet window.');
  }
  lastAnnouncedReason = run.quietReason;
}

function startSpeaking() {
  const next = beginSpeak(run);
  if (next === run) return;
  run = next;
  render();
  announce('Speak started. Read your paragraph aloud; breathing feedback is paused. Use Next paragraph when you are ready.');
}

function startReflecting() {
  const next = beginReflect(run);
  if (next === run) return;
  run = next;
  render();
  announce('Reflect started. Rest your voice and keep still for a fresh 30-second quiet window.');
}

function stopSample() {
  if (sampleTimer !== null) clearInterval(sampleTimer);
  sampleTimer = null;
}

async function stopNative() {
  if (source !== 'smartspectra') return;
  try { serverState = { ...serverState, ...await api('/api/stop') }; }
  catch (error) { setError(`Local session cleanup stopped: ${error.message} Close the SDK process in its terminal.`); }
}

async function viewNotes() {
  const next = completeRun(run);
  if (next === run) return;
  run = next;
  active = false;
  stopSample();
  render();
  announce('Run notes ready. Your script stays in the browser. Save run notes downloads an anonymous copy.');
  el['summary-title'].focus({ preventScroll: true });
  el['run-summary'].scrollIntoView({ block: 'start', behavior: 'auto' });
  await stopNative();
  render();
}

async function finishEarly(message = '') {
  if (!run) return;
  // Keep a finished reflection when EOF or End arrives before View run notes.
  if (run.phase === 'reflect' && run.quietReady) return viewNotes();
  if (run.phase === 'speak') run = beginReflect(run);
  active = false;
  starting = false;
  ended = true;
  stopSample();
  render();
  if (message) setError(message);
  announce('Run ended. Available notes stay here until you start again or reload.');
  await stopNative();
  render();
}

async function resetRun() {
  if (active || starting) return;
  stopSample();
  run = null;
  runInputMode = null;
  ended = false;
  saved = false;
  paragraphIndex = 0;
  pendingValidation = null;
  el['adult-consent'].checked = false;
  el['data-consent'].checked = false;
  setError('');
  render();
  el['script-input'].focus({ preventScroll: true });
  el['script-input'].scrollIntoView({ block: 'center', behavior: 'auto' });
  announce('Ready for another rehearsal. Edit your script or start again. Live sessions need fresh consent.');
}

function moveParagraph(direction) {
  if (run && ['reflect', 'complete'].includes(run.phase)) return;
  const next = Math.max(0, Math.min(paragraphs.length - 1, paragraphIndex + direction));
  if (next === paragraphIndex) return;
  if (run) run = turnParagraph(run, paragraphIndex, next);
  paragraphIndex = next;
  render();
  announce(`Paragraph ${paragraphIndex + 1} of ${paragraphs.length}.`);
}

function changeType(delta) {
  scriptSize = Math.max(24, Math.min(48, scriptSize + delta));
  document.documentElement.style.setProperty('--script-size', `${scriptSize}px`);
  document.documentElement.style.setProperty('--mobile-script-size', `${Math.round(scriptSize * 27 / 34)}px`);
  el['smaller-type'].disabled = scriptSize <= 24;
  el['larger-type'].disabled = scriptSize >= 48;
}

function quietCopy() {
  if (!active || !run) return ['A quiet starting point', 'Start the rehearsal to collect a 30-second quiet window.'];
  if (run.phase === 'speak') return ['Let your voice lead', 'Breathing feedback is paused for the whole speaking stage.'];
  const title = run.phase === 'reflect' ? 'A quiet moment after' : 'A quiet starting point';
  const sample = source === 'storyboard';
  switch (run.quietReason) {
    case 'quality': return [title, run.signal?.validation?.hint || 'Adjust framing and lighting, then hold still and rest your voice.'];
    case 'talking': return [title, 'Speech detected. A fresh quiet window begins when your voice rests.'];
    case 'waiting-talking': return [title, 'Waiting for the SDK talking signal. Keep still and quiet.'];
    case 'collecting': return [title, 'Hold still and rest your voice. Let the quiet window fill.'];
    case 'confidence': return [title, `30 seconds quiet collected. Waiting for a positive ${sample ? 'sample' : 'SDK'} confidence value.`];
    case 'rate': return [title, 'Quiet window collected. Waiting for a breathing rate in the SDK’s 5–40 range.'];
    case 'ready': return [title, run.phase === 'settle' ? 'Your starting point is ready. Begin speaking when you’re ready.' : 'Your second quiet moment is ready. View your run notes.'];
    default: return [title, run.signal?.validation?.hint || 'Waiting for the input’s camera-quality and talking signals.'];
  }
}

function renderWave(trace, ready) {
  if (trace.length >= 2 && ready) {
    const firstTime = trace[0].tMs;
    const duration = Math.max(1, trace.at(-1).tMs - firstTime);
    const values = trace.map((point) => point.value);
    const low = Math.min(...values);
    const range = Math.max(0.01, Math.max(...values) - low);
    const path = trace.map((point, index) => {
      const x = (point.tMs - firstTime) / duration * 620;
      const y = 42 - (point.value - low) / range * 34;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');
    el['trace-path'].setAttribute('d', path);
    const label = `${source === 'storyboard' ? 'Sample' : 'SDK'} upper-chest breathing waveform, relative units, from the current valid quiet window.`;
    el['breathing-trace'].setAttribute('aria-label', label);
    text(el['trace-caption'], `${source === 'storyboard' ? 'Sample upper-chest' : 'Upper-chest'} waveform, relative units.`);
  } else {
    el['trace-path'].setAttribute('d', '');
    el['breathing-trace'].setAttribute('aria-label', 'Upper-chest breathing waveform. Waiting for a valid quiet window.');
    text(el['trace-caption'], run?.phase === 'speak'
      ? 'Breathing waveform paused during Speak.'
      : `${source === 'storyboard' ? 'Sample waveform' : 'Upper-chest waveform'} appears after a valid quiet window.`);
  }
}

function renderSummary() {
  const complete = run?.phase === 'complete';
  el['run-summary'].hidden = !complete && !ended;
  if (!run || (!complete && !ended)) return;
  text(el['summary-title'], complete ? 'Two quiet moments. Your own pace.' : 'This run is kept here.');
  text(el['summary-source'], source === 'storyboard' ? 'Storyboard examples'
    : runInputMode === 'file' ? 'SmartSpectra SDK. Recorded camera input.' : 'SmartSpectra SDK. Live camera input.');
  text(el['before-rate'], run.before ? run.before.rate.toFixed(1) : '—');
  text(el['after-rate'], run.after ? run.after.rate.toFixed(1) : '—');
  text(el['before-confidence'], run.before ? `30 s quiet / confidence ${run.before.confidence.toFixed(2)}` : 'Starting quiet window pending');
  text(el['after-confidence'], run.after ? `30 s quiet / confidence ${run.after.confidence.toFixed(2)}` : 'Reflection quiet window pending');
  const pauses = pauseSummary(run);
  text(el['pause-summary'], `${pauses.count} detected pause${pauses.count === 1 ? '' : 's'}. ${seconds(pauses.totalMs)} seconds of space${pauses.count ? `; longest ${seconds(pauses.longestMs)} seconds` : ''}. Speech detected for ${seconds(run.talkingMs)} seconds.`);
  const duration = (run.speakEndMs ?? run.tMs ?? 0) - (run.speakStartMs ?? 0);
  el['pause-timeline'].replaceChildren();
  for (const pause of run.pauses) {
    const mark = document.createElement('span');
    mark.style.left = `${Math.max(0, (pause.startMs - run.speakStartMs) / Math.max(1, duration) * 100)}%`;
    mark.style.width = `${pause.durationMs / Math.max(1, duration) * 100}%`;
    el['pause-timeline'].append(mark);
  }
  el['pause-timeline'].setAttribute('aria-label', `${pauses.count} detected pauses across ${seconds(duration)} seconds in Speak. Blue marks show the pause locations.`);
  text(el['summary-meaning'], source === 'storyboard'
    ? 'Generated breathing and talking examples illustrate this run. Live SDK notes use the same quiet-window and talking rules.'
    : 'Each available breathing value is the SDK’s 30-second average from a valid quiet window. These are observations of your own rehearsal.');
  text(el['save-status'], saved ? 'Run notes downloaded. Your script stays in this browser.' : 'Anonymous notes stay in memory. Save downloads a copy to your device.');
}

function renderConnection() {
  let message;
  if (connection === 'connecting') message = 'Connecting to the local SDK service…';
  else if (connection === 'offline') message = 'For live signals, run QuietCue’s Node server on this device and open http://127.0.0.1:3795.';
  else if (!serverState.keyConfigured) message = 'Configure SMARTSPECTRA_API_KEY on the local server to enable live input.';
  else if (active) message = serverState.hint || 'The SDK is running on this device.';
  else if (['running', 'starting', 'stopping', 'error'].includes(serverState.status)) message = serverState.hint || 'Finish the local SDK session before starting another.';
  else message = serverState.videoConfigured ? 'Local SDK ready. Camera or configured video available.' : 'Local SDK ready. Camera available; configure a video file on the server to use video input.';
  text(el['connection-status'], message);
  el['local-sdk-link'].hidden = connection !== 'offline';
}

function render() {
  const phase = run?.phase ?? 'settle';
  const isComplete = phase === 'complete';
  const sample = source === 'storyboard';
  const locked = active || starting;
  el['storyboard-mode'].setAttribute('aria-pressed', String(sample));
  el['live-mode'].setAttribute('aria-pressed', String(!sample));
  el['storyboard-mode'].disabled = locked;
  el['live-mode'].disabled = locked;
  el['source-notice'].classList.toggle('is-live', !sample);
  const recordedInput = (runInputMode || inputMode()) === 'file';
  const notice = sample
    ? '<span class="source-dot" aria-hidden="true"></span><span><strong>Storyboard.</strong> Example signals play in this browser.</span>'
    : recordedInput
      ? '<span class="source-dot" aria-hidden="true"></span><span><strong>SDK video replay.</strong> SmartSpectra processes your authorized recorded camera input after consent and session start.</span>'
      : `<span class="source-dot" aria-hidden="true"></span><span><strong>Live SDK.</strong> ${run?.signal ? 'Presage SmartSpectra signals from this run’s live camera input.' : 'Signals arrive from your local camera after consent and session start.'}</span>`;
  if (el['source-notice'].innerHTML !== notice) el['source-notice'].innerHTML = notice;
  el['storyboard-explanation'].hidden = !sample;
  el['live-setup'].hidden = sample;
  text(el['input-title'], sample ? 'Try the whole rehearsal' : 'Use your local SDK');
  el['script-input'].readOnly = locked;
  for (const radio of document.querySelectorAll('input[name="input-mode"]')) {
    radio.disabled = locked || (radio.value === 'file' && !serverState.videoConfigured);
  }
  el['adult-consent'].disabled = locked;
  el['data-consent'].disabled = locked;
  text(el['adult-consent-label'], inputMode() === 'file'
    ? 'I am 18 or older and have permission to process this recording of a consenting adult for this rehearsal.'
    : 'I am 18 or older and consent to using my camera for this rehearsal.');
  text(el['paragraph-count'], `${paragraphs.length} paragraph${paragraphs.length === 1 ? '' : 's'}`);

  for (const step of document.querySelectorAll('.track-step')) {
    const key = step.dataset.step;
    const current = key === phase || (isComplete && key === 'reflect');
    step.classList.toggle('is-current', current);
    step.classList.toggle('is-done', !current && (isComplete || (phase === 'speak' && key === 'settle') || (phase === 'reflect' && key !== 'reflect')));
    if (current) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  }

  el.stage.dataset.phase = phase;
  const signal = active ? run?.signal : null;
  const qualityOk = signal?.validation?.code === 0;
  const cue = signal && qualityOk && signal.talking === true ? 'talking'
    : signal && qualityOk && signal.talking === false ? 'quiet'
    : active ? 'unknown' : 'idle';
  el.stage.dataset.cue = cue;
  let cueLabel = 'Your stage is ready';
  if (ended) cueLabel = 'Run ended. Notes kept here.';
  else if (isComplete) cueLabel = 'Rehearsal complete';
  else if (active && phase === 'speak') cueLabel = cue === 'talking' ? 'Speaking' : cue === 'quiet' ? 'A pause' : 'Waiting for talking signal';
  else if (active) cueLabel = cue === 'talking' ? 'Voice detected. Quiet window reset.' : cue === 'quiet' ? 'A quiet moment' : 'Waiting for clear input';
  if (sample && active) cueLabel += ' (sample)';
  text(el['cue-label'], cueLabel);
  text(el.elapsed, elapsed(run?.tMs));

  let stageText = paragraphs[paragraphIndex] || 'Write a paragraph, then make room to rehearse it.';
  let position = `Paragraph ${paragraphIndex + 1} of ${paragraphs.length}`;
  let instruction = active ? 'Read silently. Keep still.' : 'Read this to yourself first.';
  if (phase === 'speak') instruction = 'Read aloud. Take your pauses.';
  if (phase === 'reflect' && !ended) {
    stageText = 'Rest your voice.\nGive the last thought some space.';
    position = 'After the words';
    instruction = 'Stay still & quiet.';
  }
  if (isComplete) {
    stageText = 'Your rehearsal is here.\nLook back at the quiet moments and the spaces between words.';
    position = 'Your run notes are ready';
    instruction = 'Keep what helps you.';
  }
  if (ended) {
    stageText = 'This rehearsal has ended.\nYour available notes stay here until you start again.';
    position = 'Run ended';
    instruction = 'Start again when ready.';
  }
  text(el['stage-script'], stageText);
  text(el['paragraph-position'], position);
  text(el['stage-instruction'], instruction);
  const paragraphNavigation = !['reflect', 'complete'].includes(phase) && !ended;
  el['previous-paragraph'].disabled = !paragraphNavigation || paragraphIndex === 0;
  el['next-paragraph'].disabled = !paragraphNavigation || paragraphIndex >= paragraphs.length - 1;

  el['quiet-panel'].hidden = isComplete || ended;
  el['quiet-panel'].classList.toggle('is-paused', phase === 'speak');
  const [quietTitle, quietHint] = quietCopy();
  text(el['quiet-title'], quietTitle);
  text(el['quiet-hint'], quietHint);
  const feedback = active ? run?.feedback : null;
  text(el['quiet-rate'], feedback ? feedback.rate.toFixed(1) : '—');
  text(el['quiet-unit'], phase === 'speak' ? 'quiet stages only' : 'breaths / min');
  const quietSeconds = active && phase !== 'speak' ? Math.min(30, Math.floor(run.quietMs / 1000)) : 0;
  el['quiet-progress-fill'].style.width = `${quietSeconds / 30 * 100}%`;
  el['quiet-progress'].setAttribute('aria-valuenow', String(quietSeconds));
  text(el['quiet-window-label'], phase === 'speak' ? 'Quiet window paused during Speak' : `${quietSeconds} / 30 seconds quiet`);
  text(el['confidence-label'], feedback ? `${sample ? 'Sample' : 'SDK'} confidence ${feedback.confidence.toFixed(2)}`
    : phase === 'speak' ? 'Talking signal only' : active ? 'Breathing confidence pending' : 'Waiting for signal');
  renderWave(run?.trace || [], Boolean(feedback));
  renderSummary();
  if (!sample) renderConnection();

  let buttonLabel;
  let disabled = false;
  let guidance;
  let hint;
  if (starting) {
    buttonLabel = 'Starting local SDK…'; disabled = true;
    guidance = 'Keep the camera fixed, with your face and chest visible.';
    hint = 'The SDK is checking your input before the quiet window begins.';
  } else if (ended || isComplete) {
    buttonLabel = 'Start again';
    guidance = 'Save the parts you want to keep, then make room for another run.';
    hint = 'Starting again clears the current notes from this browser.';
  } else if (!active) {
    buttonLabel = sample ? 'Start Storyboard' : 'Start local SDK';
    disabled = !paragraphs.length || (!sample && (!consentGiven() || !liveReady()));
    guidance = sample ? 'Read silently first. The quiet window gets ready before you begin speaking.' : 'Read the notice and give consent for this session before starting.';
    hint = sample ? 'About one minute of quiet, plus your speaking time.' : 'Both consent boxes are required for each new SDK session.';
  } else if (phase === 'settle') {
    buttonLabel = 'Begin speaking'; disabled = !run.quietReady;
    guidance = 'Stay still and quiet for your starting point. Then read aloud.';
    hint = run.quietReady ? 'Your first 30-second quiet window is ready.' : 'This button opens after a valid 30-second quiet window.';
  } else if (phase === 'speak') {
    buttonLabel = 'Finish speaking';
    guidance = paragraphIndex < paragraphs.length - 1 ? 'Read your words, then choose Next paragraph. Finish speaking when your rehearsal is done.' : 'Give your last thought time to land, then finish speaking.';
    hint = sample ? 'Gold follows a sample cycle: 6 seconds speaking, 2 seconds pause.' : 'Gold follows the SDK talking signal. Paragraph changes are yours to choose.';
  } else {
    buttonLabel = 'View run notes'; disabled = !run.quietReady;
    guidance = 'Rest your voice and hold still for one fresh quiet window.';
    hint = run.quietReady ? 'Your second quiet window is ready. Look back at this rehearsal.' : 'Reflection begins a new 30-second continuous quiet window.';
  }
  const actionText = el['main-action'].childNodes[0];
  if (actionText?.nodeType === Node.TEXT_NODE) actionText.nodeValue = buttonLabel;
  else el['main-action'].prepend(document.createTextNode(buttonLabel));
  el['main-action'].disabled = disabled;
  el['main-action'].querySelector('svg').toggleAttribute('hidden', active || starting || ended || isComplete);
  el['stop-action'].hidden = !active || starting;
  el['read-consent'].hidden = sample || locked || ended || isComplete || consentGiven();
  text(el['action-guidance'], guidance);
  text(el['action-hint'], hint);
}

el['storyboard-mode'].addEventListener('click', () => chooseSource('storyboard'));
el['live-mode'].addEventListener('click', () => chooseSource('smartspectra'));
el['script-input'].addEventListener('input', () => {
  if (active || starting) return;
  const count = splitScript(el['script-input'].value).length;
  el['apply-script'].hidden = false;
  text(el['paragraph-count'], `${count} paragraph${count === 1 ? '' : 's'} drafted`);
});
el['apply-script'].addEventListener('click', applyScript);
el['previous-paragraph'].addEventListener('click', () => moveParagraph(-1));
el['next-paragraph'].addEventListener('click', () => moveParagraph(1));
el['smaller-type'].addEventListener('click', () => changeType(-2));
el['larger-type'].addEventListener('click', () => changeType(2));
el['main-action'].addEventListener('click', () => {
  if (starting) return;
  if (ended || run?.phase === 'complete') resetRun();
  else if (!active) startRun();
  else if (run.phase === 'settle') startSpeaking();
  else if (run.phase === 'speak') startReflecting();
  else if (run.phase === 'reflect') viewNotes();
});
el['stop-action'].addEventListener('click', () => finishEarly());
el['start-again'].addEventListener('click', resetRun);
el['adult-consent'].addEventListener('change', render);
el['data-consent'].addEventListener('change', render);
for (const input of document.querySelectorAll('input[name="input-mode"]')) {
  input.addEventListener('change', () => {
    el['adult-consent'].checked = false;
    el['data-consent'].checked = false;
    render();
  });
}
el['save-notes'].addEventListener('click', () => {
  if (!run || (run.phase !== 'complete' && !ended)) return;
  const notes = { ...runNotes(run, runInputMode), status: ended ? 'ended' : 'complete' };
  const blob = new Blob([JSON.stringify(notes, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `quietcue-${source === 'storyboard' ? 'storyboard' : 'sdk'}-notes.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  saved = true;
  renderSummary();
  announce('Anonymous run notes downloaded. The file contains signals and pause timings; your script stays in this browser.');
});

// Stage shortcuts stay out of the editor, consent controls and other form inputs.
document.addEventListener('keydown', (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return;
  if (event.target.closest('textarea,input,button,summary,a')) return;
  if (event.key === 'ArrowRight') { event.preventDefault(); moveParagraph(1); }
  if (event.key === 'ArrowLeft') { event.preventDefault(); moveParagraph(-1); }
});

window.addEventListener('pagehide', () => {
  if (active && source === 'smartspectra') navigator.sendBeacon('/api/stop');
});

render();
