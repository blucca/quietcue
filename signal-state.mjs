// Timing belongs to the input stream: SDK time for live/file, sample time for Storyboard.
export const QUIET_WINDOW_MS = 30_000;
export const MIN_PAUSE_MS = 500;

export function freshRun(source) {
  return {
    source,
    phase: 'settle',
    tMs: null,
    phaseStartMs: null,
    quietStartMs: null,
    quietMs: 0,
    quietReady: false,
    quietReason: 'waiting',
    signal: null,
    feedback: null,
    trace: [],
    before: null,
    after: null,
    speakStartMs: null,
    speakEndMs: null,
    lastTalking: null,
    pauseStartMs: null,
    pauses: [],
    talkingMs: 0,
    paragraphTurns: [],
  };
}

function quietSnapshot(run) {
  return {
    rate: run.feedback.rate,
    confidence: run.feedback.confidence,
    tMs: run.tMs,
    quietWindowMs: QUIET_WINDOW_MS,
  };
}

export function acceptSignal(previous, signal) {
  if (previous.phase === 'complete' || signal.source !== previous.source) return previous;
  if (!Number.isFinite(signal.tMs) || signal.tMs < 0) return previous;
  if (previous.tMs !== null && signal.tMs < previous.tMs) return previous;

  const run = { ...previous, tMs: signal.tMs, signal };
  if (run.phaseStartMs === null) run.phaseStartMs = signal.tMs;
  const qualityOk = signal.validation?.code === 0;
  const talkingKnown = typeof signal.talking === 'boolean';
  const quiet = qualityOk && signal.talking === false;
  const rateOk = Number.isFinite(signal.rate) && signal.rate >= 5 && signal.rate <= 40;
  const confidenceOk = Number.isFinite(signal.confidence) && signal.confidence > 0;

  if (run.phase === 'speak') {
    run.quietStartMs = null;
    run.quietMs = 0;
    run.quietReady = false;
    run.quietReason = 'speaking-phase';
    run.feedback = null;
    run.trace = [];

    // A measured pause begins after detected speech.
    if (qualityOk && talkingKnown) {
      const previousQualityOk = previous.signal?.validation?.code === 0;
      if (previousQualityOk && previous.lastTalking === true && previous.tMs !== null) {
        run.talkingMs += signal.tMs - previous.tMs;
      }
      if (signal.talking === false && previous.lastTalking === true) {
        run.pauseStartMs = signal.tMs;
      }
      if (signal.talking === true && previous.pauseStartMs !== null) {
        const durationMs = signal.tMs - previous.pauseStartMs;
        if (durationMs >= MIN_PAUSE_MS) {
          run.pauses = [...previous.pauses, {
            startMs: previous.pauseStartMs,
            endMs: signal.tMs,
            durationMs,
          }];
        }
        run.pauseStartMs = null;
      }
      run.lastTalking = signal.talking;
    } else {
      // Quality loss breaks the measured interval.
      run.lastTalking = null;
      run.pauseStartMs = null;
    }
    return run;
  }

  if (quiet) {
    if (run.quietStartMs === null) run.quietStartMs = signal.tMs;
    run.quietMs = signal.tMs - run.quietStartMs;
  } else {
    run.quietStartMs = null;
    run.quietMs = 0;
  }

  run.quietReady = quiet && run.quietMs >= QUIET_WINDOW_MS && confidenceOk && rateOk;
  run.feedback = run.quietReady ? { rate: signal.rate, confidence: signal.confidence } : null;
  if (!qualityOk) run.quietReason = signal.validation?.code == null ? 'waiting' : 'quality';
  else if (!talkingKnown) run.quietReason = 'waiting-talking';
  else if (signal.talking) run.quietReason = 'talking';
  else if (run.quietMs < QUIET_WINDOW_MS) run.quietReason = 'collecting';
  else if (!confidenceOk) run.quietReason = 'confidence';
  else if (!rateOk) run.quietReason = 'rate';
  else run.quietReason = 'ready';

  if (run.quietReady && Number.isFinite(signal.upperTrace)) {
    run.trace = [...previous.trace, { tMs: signal.tMs, value: signal.upperTrace }].slice(-100);
  } else if (!run.quietReady) {
    run.trace = [];
  }
  return run;
}

export function beginSpeak(previous) {
  if (previous.phase !== 'settle' || !previous.quietReady) return previous;
  return {
    ...previous,
    before: quietSnapshot(previous),
    phase: 'speak',
    phaseStartMs: previous.tMs,
    speakStartMs: previous.tMs,
    quietStartMs: null,
    quietMs: 0,
    quietReady: false,
    quietReason: 'speaking-phase',
    feedback: null,
    trace: [],
    lastTalking: null,
  };
}

export function turnParagraph(previous, from, to) {
  if (previous.phase !== 'speak' || previous.tMs === null || from === to) return previous;
  return {
    ...previous,
    paragraphTurns: [...previous.paragraphTurns, { tMs: previous.tMs, from: from + 1, to: to + 1 }],
  };
}

export function beginReflect(previous) {
  if (previous.phase !== 'speak' || previous.tMs === null) return previous;
  let pauses = previous.pauses;
  if (previous.pauseStartMs !== null && previous.lastTalking === false) {
    const durationMs = previous.tMs - previous.pauseStartMs;
    if (durationMs >= MIN_PAUSE_MS) {
      pauses = [...pauses, { startMs: previous.pauseStartMs, endMs: previous.tMs, durationMs }];
    }
  }
  const quiet = previous.signal?.validation?.code === 0 && previous.signal?.talking === false;
  return {
    ...previous,
    phase: 'reflect',
    phaseStartMs: previous.tMs,
    speakEndMs: previous.tMs,
    quietStartMs: quiet ? previous.tMs : null,
    quietMs: 0,
    quietReady: false,
    quietReason: quiet ? 'collecting' : 'waiting',
    feedback: null,
    trace: [],
    lastTalking: null,
    pauseStartMs: null,
    pauses,
  };
}

export function completeRun(previous) {
  if (previous.phase !== 'reflect' || !previous.quietReady) return previous;
  return { ...previous, phase: 'complete', after: quietSnapshot(previous) };
}

export function pauseSummary(run) {
  return {
    count: run.pauses.length,
    totalMs: run.pauses.reduce((sum, pause) => sum + pause.durationMs, 0),
    longestMs: run.pauses.reduce((longest, pause) => Math.max(longest, pause.durationMs), 0),
  };
}

export function runNotes(run, inputMode) {
  return {
    app: 'QuietCue',
    format: 1,
    source: run.source,
    input: inputMode,
    provenance: run.source === 'storyboard' ? 'Generated breathing and talking examples from this browser.'
      : inputMode === 'file' ? 'Presage SmartSpectra SDK signals computed from recorded camera input.'
      : 'Presage SmartSpectra SDK signals from live camera input.',
    timing: run.source === 'storyboard' ? 'Relative sample timeline in milliseconds.' : 'Relative SDK monotonic timeline in milliseconds.',
    phase: run.phase,
    before: run.before,
    after: run.after,
    speakDurationMs: run.speakEndMs !== null ? run.speakEndMs - run.speakStartMs : null,
    talkingDetectedMs: run.talkingMs,
    pauses: run.pauses,
    pauseThresholdMs: MIN_PAUSE_MS,
    paragraphTurns: run.paragraphTurns,
  };
}
