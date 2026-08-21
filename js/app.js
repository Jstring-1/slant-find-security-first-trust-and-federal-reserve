// Fretboard.site — client-side rewrite of the PHP renderer.
// Variable names mirror the original PHP ($x, $rev, $hilight_url) for traceability.

(function () {
  'use strict';

  const D = window.SF_DATA;
  const KEYS = D.keys;
  const ALLNOTES = D.allnotes;
  const DEGREES = D.degrees;            // ["1","♭2","2","♭3","3","4","♭5","5","♭6","6","♭7","7"]
  const EXTENSIONS = D.extensions;
  const URL_NOTE_CHECK = D.url_note_check;
  const URL_CHECK = D.url_check;
  const DEF_X = D.def_x;
  const SCALES = D.scales;
  const CHORDS = D.chords;
  const GRID = D.grid;
  const TUNINGS = D.tunings;

  // ---------- audio (Web Audio API synth, off by default) -------------
  // Persistence in localStorage so the user's preference survives reload
  // without polluting the URL. Opt-in: nothing plays unless the ♪ toggle
  // in the Fretboard summary is on.
  let _audioCtx = null;
  function audioOn() {
    return localStorage.getItem('sf_audio') === 'on';
  }
  function setAudioOn(on) {
    if (on) localStorage.setItem('sf_audio', 'on');
    else    localStorage.removeItem('sf_audio');
  }
  function ensureAudioCtx() {
    if (_audioCtx) return _audioCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    _audioCtx = new Ctx();
    return _audioCtx;
  }
  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  // ---- Tone.js sampler / synth voices ------------------------------
  // Tone.js loads from a CDN and is optional. If it didn't load
  // (offline / blocked) every call here returns null and playMidi
  // falls back to the built-in triangle blip below.
  const TONE_INSTRUMENTS = {
    'piano': {
      label: 'Piano',
      type: 'sampler',
      baseUrl: 'https://tonejs.github.io/audio/salamander/',
      release: 1.2,
      urls: {
        A0:'A0.mp3',  C1:'C1.mp3',  'D#1':'Ds1.mp3','F#1':'Fs1.mp3',
        A1:'A1.mp3',  C2:'C2.mp3',  'D#2':'Ds2.mp3','F#2':'Fs2.mp3',
        A2:'A2.mp3',  C3:'C3.mp3',  'D#3':'Ds3.mp3','F#3':'Fs3.mp3',
        A3:'A3.mp3',  C4:'C4.mp3',  'D#4':'Ds4.mp3','F#4':'Fs4.mp3',
        A4:'A4.mp3',  C5:'C5.mp3',  'D#5':'Ds5.mp3','F#5':'Fs5.mp3',
        A5:'A5.mp3',  C6:'C6.mp3',  'D#6':'Ds6.mp3','F#6':'Fs6.mp3',
        A6:'A6.mp3',  C7:'C7.mp3',  'D#7':'Ds7.mp3','F#7':'Fs7.mp3',
        A7:'A7.mp3',  C8:'C8.mp3'
      }
    },
    'guitar-acoustic': {
      label: 'Acoustic Guitar',
      type: 'sampler',
      baseUrl: 'https://tonejs.github.io/audio/casio/',
      release: 0.8,
      urls: { A1:'A1.mp3', A2:'A2.mp3', A3:'A3.mp3', A4:'A4.mp3', A5:'A5.mp3', A6:'A6.mp3' }
    },
    'electric-piano': {
      label: 'Electric Piano',
      type: 'fmsynth'
    },
    'organ': {
      label: 'Organ',
      type: 'amsynth'
    },
    'synth': {
      label: 'Synth Lead',
      type: 'polysynth',
      options: { oscillator: { type: 'sawtooth' },
                 envelope: { attack: 0.02, decay: 0.1, sustain: 0.4, release: 0.4 } }
    },
    'pad': {
      label: 'Pad',
      type: 'polysynth',
      options: { oscillator: { type: 'triangle' },
                 envelope: { attack: 0.4, decay: 0.5, sustain: 0.7, release: 1.5 } }
    },
    'triangle': {
      label: 'Triangle (built-in)',
      type: 'fallback'
    }
  };
  const _DEFAULT_INSTRUMENT = 'piano';
  // Delegate to the unified SETTINGS registry so the choice round-trips
  // through both URL and localStorage. Page-load reads URL > localStorage
  // > default; setting the dropdown writes to both.
  function getInstrumentPref() {
    const v = getSetting('instrument');
    return (TONE_INSTRUMENTS[v] ? v : _DEFAULT_INSTRUMENT);
  }
  function setInstrumentPref(k) {
    setSetting('instrument', TONE_INSTRUMENTS[k] ? k : _DEFAULT_INSTRUMENT);
  }

  let _toneInstrument = null;
  let _toneInstrumentKey = null;
  let _toneStarted = false;
  // Lazy-load the Tone.js library on first call. Injecting at this
  // point — inside a user gesture — keeps the AudioContext / deprecated
  // ScriptProcessorNode probes off the console until the user
  // actually needs audio.
  let _toneLoadingPromise = null;
  function loadTone() {
    if (typeof window.Tone !== 'undefined') return Promise.resolve(window.Tone);
    if (_toneLoadingPromise) return _toneLoadingPromise;
    _toneLoadingPromise = new Promise(function (resolve) {
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/tone@14.7.77/build/Tone.js';
      s.async = true;
      s.onload  = function () { resolve(window.Tone || null); };
      s.onerror = function () { resolve(null); };
      document.head.appendChild(s);
    });
    return _toneLoadingPromise;
  }

  // Lazy-build a Tone.js voice based on the user's preference. Returns
  // a promise that resolves to the instrument node OR null when Tone
  // isn't available / the user chose the built-in fallback. Subsequent
  // calls with the same key reuse the cached node; switching keys
  // disposes the previous one.
  function ensureToneInstrument() {
    const key = getInstrumentPref();
    if ((TONE_INSTRUMENTS[key] || {}).type === 'fallback') return Promise.resolve(null);
    return loadTone().then(function (Tone) {
      if (!Tone) return null;
    const startP = _toneStarted ? Promise.resolve()
                                : window.Tone.start().then(function () { _toneStarted = true; });
    return startP.then(function () {
      if (_toneInstrumentKey === key && _toneInstrument) return _toneInstrument;
      if (_toneInstrument && typeof _toneInstrument.dispose === 'function') {
        try { _toneInstrument.dispose(); } catch (_) {}
      }
      const cfg = TONE_INSTRUMENTS[key] || TONE_INSTRUMENTS[_DEFAULT_INSTRUMENT];
      let inst;
      if (cfg.type === 'sampler') {
        inst = new window.Tone.Sampler({ urls: cfg.urls, baseUrl: cfg.baseUrl,
                                          release: cfg.release || 1 });
      } else if (cfg.type === 'fmsynth') {
        inst = new window.Tone.PolySynth(window.Tone.FMSynth);
      } else if (cfg.type === 'amsynth') {
        inst = new window.Tone.PolySynth(window.Tone.AMSynth);
      } else {
        inst = new window.Tone.PolySynth(window.Tone.Synth, cfg.options || {});
      }
      // Subtle reverb on the chain so chords don't sound dry.
      const reverb = new window.Tone.Reverb({ decay: 1.2, wet: 0.18 });
      inst.chain(reverb, window.Tone.Destination);
      _toneInstrument = inst;
      _toneInstrumentKey = key;
      return inst;
    });
    }).catch(function () { return null; });
  }
  // Warming pre-loads Tone on first user gesture. NOT called at page
  // load — kept off the boot path so the autoplay-policy + deprecated-
  // node warnings don't fire until the user actually wants audio.
  function preWarmTone() { ensureToneInstrument(); }

  // Play a single MIDI note. Routes through Tone.js when available;
  // falls back to the original triangle-wave WebAudio blip otherwise.
  function playMidi(m, durSec) {
    if (!audioOn()) return;
    const dur = (typeof durSec === 'number' && durSec > 0) ? durSec : 0.9;
    const wantsTone = (TONE_INSTRUMENTS[getInstrumentPref()] || {}).type !== 'fallback';
    if (!wantsTone) { _playMidiFallback(m, dur); return; }
    // Tone may not be loaded yet on the very first note — kick off the
    // lazy load via ensureToneInstrument. If the load + AudioContext-
    // resume haven't finished by the time this returns, play the
    // triangle fallback so the click feels responsive. Subsequent
    // notes go through Tone.
    const inst = (typeof window.Tone !== 'undefined' && _toneInstrument
                  && _toneInstrumentKey === getInstrumentPref()) ? _toneInstrument : null;
    if (inst) {
      try {
        inst.triggerAttackRelease(midiToFreq(m), dur);
        return;
      } catch (_) { /* fall through to fallback */ }
    }
    // Warm Tone for next time.
    ensureToneInstrument();
    _playMidiFallback(m, dur);
  }
  function _playMidiFallback(m, dur) {
    const ctx = ensureAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (_) {} }
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = midiToFreq(m);
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.55, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  // Chord ID is always on. The section can be visually collapsed via
  // the <details> summary in the strip — that state lives in
  // id_closed (see SETTINGS). Click-to-pick keeps working regardless.
  function chordIdOn(/* sectionId */) { return true; }
  function setChordIdOn(/* sectionId, on */) { /* no-op kept for legacy call sites */ }

  // Pitch-class lookup keyed by display note name (sharp form as KEYS uses).
  const NOTE_PC = {
    'C':0, 'C♯':1, 'D':2, 'D♯':3, 'E':4, 'F':5,
    'F♯':6, 'G':7, 'G♯':8, 'A':9, 'A♯':10, 'B':11,
    // Flat aliases for tunings stored that way (rare in this app's data).
    'D♭':1, 'E♭':3, 'G♭':6, 'A♭':8, 'B♭':10, 'C♭':11
  };
  function notePc(n) {
    const k = String(n || '').replace('#', '♯').replace('b', '♭');
    return NOTE_PC[k] != null ? NOTE_PC[k] : 0;
  }

  // Given an array of string note letters in LOW-TO-HIGH pitch order,
  // produce a parallel array of MIDI numbers using the heuristic:
  //  - lowest string lands closest to a per-string-count target
  //  - each subsequent string steps up by the smallest non-negative
  //    semitone delta from the previous (same letter ⇒ +12)
  // Handles standard guitar (40,45,50,55,59,64), bass (28..43), uke
  // (treated as ascending — re-entrant high-G uke will sound an octave
  // low, fixable later via per-string ± buttons).
  const _STR_COUNT_TARGET = { 4: 28, 5: 23, 6: 40, 7: 35, 8: 36, 9: 33, 10: 33, 11: 31, 12: 38 };
  function fretboardStringMidis(lowToHighNotes) {
    const N = lowToHighNotes.length;
    const target = _STR_COUNT_TARGET[N] || 40;
    const midis = [];
    let prev = -1;
    for (let i = 0; i < N; i++) {
      const p = notePc(lowToHighNotes[i]);
      let m;
      if (i === 0) {
        // Closest MIDI in [12,108] with (m % 12 === p) to the target
        let best = 60, diff = Infinity;
        for (let k = 12; k <= 108; k++) {
          if (k % 12 !== p) continue;
          const d = Math.abs(k - target);
          if (d < diff) { best = k; diff = d; }
        }
        m = best;
      } else {
        let step = ((p - (prev % 12)) + 12) % 12;
        if (step === 0) step = 12;
        m = prev + step;
      }
      midis.push(m);
      prev = m;
    }
    return midis;
  }

  // ---------- helpers ----------
  // URL with every current param except hl + pk — used by the site-header
  // Clear pill so a single click drops both the colored degree highlights
  // AND the yellow chord-ID picks.
  function clearHlHref() {
    const params = new URLSearchParams(window.location.search);
    params.delete('hl');
    params.delete('pk');
    // Emit explicit empty hl= and pk= so the unlinked-mode merger can
    // distinguish "click intends to clear" from "click didn't touch
    // these fields" (the latter would leave the section override alone
    // and the highlights / picks wouldn't actually clear).
    params.set('hl', '');
    params.set('pk', '');
    const qs = params.toString();
    // Always include the leading "?" so the link interceptor catches it.
    return qs ? '?' + qs : '?';
  }
  // URL that clears ONLY the colored hl= highlights, preserving the
  // yellow chord-ID picks (pk=). Used by the per-section "None" pill so
  // the user can drop the colored highlights without losing chord-ID
  // selections that may still be in progress.
  function clearHlOnlyHref() {
    const params = new URLSearchParams(window.location.search);
    params.delete('hl');
    params.set('hl', '');
    // Active chord-ID chip marker — clear with hl so the engaged chip
    // disengages alongside its highlights.
    params.delete('idn');
    const qs = params.toString();
    return qs ? '?' + qs : '?';
  }

  // Escape a string so it's safe to drop inside a CSS `content: "..."` value.
  // Non-ASCII (♭, ♯) is fine, but we must escape backslashes and double quotes.
  function escapeCssString(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // ---------- URL note encoding ----------
  // We use lowercase 's' for sharp and lowercase 'b' for flat in URLs:
  //   F♯  ↔  Fs    (was F%23 — saves 4 chars per sharp, no escaping)
  //   B♭  ↔  Bb
  // Both old (#-encoded as %23) and new ('s') URLs decode the same way, so
  // links from before this change keep working.
  function urlNote(s) {
    return String(s)
      .replace(/♭/g, 'b')
      .replace(/♯/g, 's')
      .replace(/ /g, '');
  }
  function reverseSpaceStr(s) {
    return String(s).split(' ').reverse().join(' ');
  }
  function bToFlat(s) { return String(s).replace(/b/g, '♭'); }
  function flatToB(s) { return String(s).replace(/♭/g, 'b'); }
  // sharpToHash is the URL→display path: it accepts BOTH '#' (legacy URLs
  // that pre-date the 's' encoding) and 's' immediately after a capital
  // A-G note letter. Either becomes the unicode ♯.
  function sharpToHash(s) {
    return String(s)
      .replace(/#/g, '♯')
      .replace(/([A-G])s/g, '$1♯');
  }

  // Canonical order for URL params — every URL the app generates should
  // emit known params in this order so shared / bookmarked URLs read
  // consistently. Unknown / legacy params (e.g. s1..s12) are appended
  // alphabetically at the end.
  const URL_PARAM_ORDER = ['k', 'x', 's', 'hl', 'pk', 'y', 'z', 'c', 'f', 'fc', 'fcp', 'td', 'sort', 'id', 'idn', 'idc', 'cmp', 'ext', 'ik', 'disp', 'inst', 'qpc', 'prog', 'tempo', 'ord', 'u'];
  function canonicalQS(params) {
    const known = new Set(URL_PARAM_ORDER);
    const out = new URLSearchParams();
    URL_PARAM_ORDER.forEach(function (k) {
      if (params.has(k)) {
        params.getAll(k).forEach(function (v) { out.append(k, v); });
      }
    });
    const unknown = [];
    params.forEach(function (_v, k) {
      if (!known.has(k) && unknown.indexOf(k) === -1) unknown.push(k);
    });
    unknown.sort();
    unknown.forEach(function (k) {
      params.getAll(k).forEach(function (v) { out.append(k, v); });
    });
    // URLSearchParams.toString() percent-encodes commas as %2C, but
    // commas are legal in query strings (RFC 3986 sub-delims) and
    // we use them as a separator in our comma-list params (c=, ord=,
    // hl=, sort=, …). Decode them back for readable, shareable URLs.
    // None of our param values intentionally contain a literal comma
    // that needs to stay encoded.
    return out.toString().replace(/%2C/g, ',');
  }

  // ---------- Settings registry (URL > localStorage > default) ----------
  // Single source-of-truth for non-state-driving display toggles.
  //   - URL is authoritative when the param is present (so a shared
  //     bookmark reproduces the receiver's view exactly).
  //   - localStorage is the user's persistent preference when the URL
  //     is bare.
  //   - Built-in `def` is the third tier.
  // setSetting writes to BOTH stores so the toggle survives reload AND
  // shows up in the URL for sharing. Per-section settings (e.g. chord
  // ID) namespace under `s<N>_<key>` when the page is unlinked; in
  // linked mode they collapse to a single global URL key.
  // NOTE: audio is intentionally NOT in this registry — it stays
  // localStorage-only so a shared URL never auto-enables sound.
  const SETTINGS = {
    chord_id: {
      url:    'id',  ls: 'sf_chord_id',  perSection: true,
      parse:  function (v) { return v !== '0' && v !== 'off'; },
      lsFmt:  function (v) { return v ? '' : 'off'; },     // '' → remove
      urlFmt: function (v) { return v ? '' : '0'; },       // default = on
      def:    true,
    },
    compact: {
      url:    'cmp', ls: 'sf_compact_grids',
      parse:  function (v) { return v === '1' || v === 'on' || v === 'true'; },
      lsFmt:  function (v) { return v ? '1' : ''; },
      urlFmt: function (v) { return v ? '1' : ''; },
      def:    false,
    },
    extras: {
      url:    'ext', ls: 'sf_identify_extras',
      parse:  function (v) { return v === 'all' ? Infinity : (parseInt(v, 10) || 1); },
      lsFmt:  function (v) { return v === 1 ? '' : (v === Infinity ? 'all' : String(v)); },
      urlFmt: function (v) { return v === 1 ? '' : (v === Infinity ? 'all' : String(v)); },
      def:    1,
    },
    inkey: {
      url:    'ik',  ls: 'sf_identify_inkey',
      parse:  function (v) { return v === '1' || v === 'on' || v === 'true'; },
      lsFmt:  function (v) { return v ? '1' : ''; },
      urlFmt: function (v) { return v ? '1' : ''; },
      def:    false,
    },
    // Note / degree / both display mode toggle in the sticky header.
    // Drives label spans across fretboard, grids, progression bars,
    // keyboard. Default 'both' = show everything (current behavior).
    display_mode: {
      url:    'disp', ls: 'sf_display_mode',
      parse:  function (v) { v = String(v || '').toLowerCase();
                              return (v === 'notes' || v === 'degrees' || v === 'none') ? v : 'both'; },
      lsFmt:  function (v) { return v === 'both' ? '' : v; },
      urlFmt: function (v) { return v === 'both' ? '' : v; },
      def:    'both',
    },
    // Tone.js voice selector (sticky-header dropdown). Default 'piano'
    // = Salamander Grand sampler. URL key 'inst' so a shared link
    // recreates the receiver's listening experience.
    instrument: {
      url:    'inst', ls: 'sf_instrument',
      parse:  function (v) { return v ? String(v) : 'piano'; },
      lsFmt:  function (v) { return v === 'piano' ? '' : v; },
      urlFmt: function (v) { return v === 'piano' ? '' : v; },
      def:    'piano',
    },
    // Quick-picks bucket open/closed state (per slot). Stored as a
    // comma-list of CLOSED slot ids ('fb_quick_picks', 'kb_quick_picks').
    // Default (absent) = both open. Per-slot key is the slot id; the
    // SETTINGS framework here only handles single-value settings, so
    // qp_closed is read/written directly via the helpers below.
    qp_closed: {
      url:    'qpc', ls: 'sf_qp_closed',
      parse:  function (v) { return String(v || '').split(',').filter(Boolean); },
      lsFmt:  function (v) { return Array.isArray(v) && v.length ? v.join(',') : ''; },
      urlFmt: function (v) { return Array.isArray(v) && v.length ? v.join(',') : ''; },
      def:    [],
    },
    // Chord-ID box open/closed state (per section). Same comma-list
    // shape as qp_closed; entries are 'section_2' / 'section_4'.
    id_closed: {
      url:    'idc', ls: 'sf_id_closed',
      parse:  function (v) { return String(v || '').split(',').filter(Boolean); },
      lsFmt:  function (v) { return Array.isArray(v) && v.length ? v.join(',') : ''; },
      urlFmt: function (v) { return Array.isArray(v) && v.length ? v.join(',') : ''; },
      def:    [],
    },
    // User-customized section order. Comma-list of section numbers
    // (e.g. "11,2,3,6,9,4,7,8,10" — Progressions moved to top).
    // Empty / absent = default order (whatever is in index.html).
    section_order: {
      url:    'ord', ls: 'sf_section_order',
      parse:  function (v) { return String(v || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean); },
      lsFmt:  function (v) { return Array.isArray(v) && v.length ? v.join(',') : ''; },
      urlFmt: function (v) { return Array.isArray(v) && v.length ? v.join(',') : ''; },
      def:    [],
    },
  };
  function _settingURLKey(name, sectionId) {
    const cfg = SETTINGS[name];
    if (!cfg) return null;
    const linked = document.body.getAttribute('data-apply-all') !== 'off';
    if (sectionId && cfg.perSection && !linked) {
      const m = String(sectionId).match(/^section_(\d+)$/);
      if (m) return 's' + m[1] + '_' + cfg.url;
    }
    return cfg.url;
  }
  function _settingLSKey(name, sectionId) {
    const cfg = SETTINGS[name];
    if (!cfg) return null;
    if (sectionId && cfg.perSection) {
      const suffix = sectionId === 'section_4' ? '_kb' : '_fb';
      return cfg.ls + suffix;
    }
    return cfg.ls;
  }
  function getSetting(name, sectionId) {
    const cfg = SETTINGS[name];
    if (!cfg) return null;
    const params = new URLSearchParams(window.location.search);
    const urlKey = _settingURLKey(name, sectionId);
    if (params.has(urlKey)) return cfg.parse(params.get(urlKey));
    try {
      const v = localStorage.getItem(_settingLSKey(name, sectionId));
      if (v != null) return cfg.parse(v);
    } catch (_) {}
    return cfg.def;
  }
  function setSetting(name, value, sectionId) {
    const cfg = SETTINGS[name];
    if (!cfg) return;
    const urlVal = cfg.urlFmt(value);
    const lsVal  = cfg.lsFmt(value);
    const params = new URLSearchParams(window.location.search);
    const urlKey = _settingURLKey(name, sectionId);
    if (urlVal === '') params.delete(urlKey);
    else               params.set(urlKey, urlVal);
    const qs = canonicalQS(params);
    history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
    const lsKey = _settingLSKey(name, sectionId);
    try {
      if (lsVal === '') localStorage.removeItem(lsKey);
      else              localStorage.setItem(lsKey, lsVal);
    } catch (_) {}
  }

  // Tokenize a single hl value into degree symbols. Accepts ALL three
  // historical forms transparently:
  //   - separator-free  ?hl=1b35     (current canonical, shortest URL)
  //   - comma-separated ?hl=1,b3,5   (legacy emitted form, ~2026-05)
  //   - multi-key       ?hl=1&hl=b3&hl=5   (oldest legacy)
  // Degree alphabet is unambiguous: each token is `b?[1-7]`, so a run
  // like "1b35" parses left-to-right as 1 / b3 / 5 with no ambiguity.
  function _tokenizeHl(v) {
    const s = String(v || '').trim();
    if (!s.length) return [];
    if (s.indexOf(',') !== -1) {
      return s.split(',').map(function (t) { return t.trim(); }).filter(Boolean);
    }
    return s.match(/b?[1-7]/g) || [];
  }
  function readHlParam(params) {
    return params.getAll('hl').flatMap(_tokenizeHl);
  }

  // Pick-set tokenizer. Each note is `[A-G]` followed by an optional
  // sharp / flat modifier (`s`, `b`, `♯`, or `♭`). Same three input
  // forms as hl: separator-free (?pk=ACsE), comma (?pk=A,Cs,E), or
  // multi-key (?pk=A&pk=Cs&pk=E).
  function _tokenizePk(v) {
    const s = String(v || '').trim();
    if (!s.length) return [];
    if (s.indexOf(',') !== -1) {
      return s.split(',').map(function (t) { return t.trim(); }).filter(Boolean);
    }
    return s.match(/[A-G][sb♯♭]?/g) || [];
  }
  function readPkParam(params) {
    return params.getAll('pk').flatMap(_tokenizePk);
  }

  // Read the custom-tuning strings from URL params. Accepts:
  //   - new compact form ?s=ACsEFGACE (note tokens, no separator) — same
  //     format as ?x=, so tunings encode the same way everywhere
  //   - legacy dot-separated  ?s=A.Cs.E.F.G.A.C.E
  //   - legacy individual     ?s1=A&s2=Cs&…
  // Positions 0..N-1 correspond to s1..sN; missing slots become null.
  function readCustomStrings(params) {
    const single = params.get('s');
    if (single != null) {
      let list;
      if (single.indexOf('.') !== -1) {
        list = single.split('.');
      } else {
        // Parse a contiguous run of [A-G][sb]? tokens. If a string has any
        // gaps the user must use the legacy dot-separated form.
        list = single.match(/[A-G][sb♯♭]?/g) || [];
      }
      const out = {};
      for (let i = 0; i < list.length && i < 12; i++) {
        if (list[i]) out['s' + (i + 1)] = list[i];
      }
      return out;
    }
    const out = {};
    for (let i = 1; i <= 12; i++) {
      const v = params.get('s' + i);
      if (v != null) out['s' + i] = v;
    }
    return out;
  }

  // ---------- parse URL → x ----------
  function parseState(searchOverride) {
    // searchOverride: optional `?k=A&hl=…` string. Used by the per-
    // section rerender path when "Apply: all" is off — we parse the
    // link's URL into a state object without actually navigating, then
    // hand that state to a single section's renderer.
    const x = {};
    let def = '';

    const params = new URLSearchParams(
      (searchOverride != null) ? searchOverride : window.location.search
    );
    const hasParams = Array.from(params.keys()).length > 0;

    if (hasParams) {
      // Build raw map of key → array (for hl which is multi-valued).
      // Skip the multi-value keys here; we hydrate them from helpers below.
      const raw = {};
      for (const [k, v] of params.entries()) {
        if (k === 'hl' || k === 's') continue;
        const val = bToFlat(sharpToHash(v));
        if (!raw[k]) raw[k] = [];
        raw[k].push(val);
      }
      // Hydrate hl (compact ?hl=1,b3,5 OR legacy ?hl=1&hl=b3&hl=5)
      const hlList = readHlParam(params).map(function (v) { return bToFlat(v); });
      if (hlList.length) raw.hl = hlList;
      // Hydrate s1..s12 (compact ?s=A.Cs.E.F.G.A.C.E OR legacy ?s1=…&s2=…).
      // Each parsed value is validated against the same A-G + ♯/♭ alphabet
      // the single-value note params use; anything weird from a hand-edited
      // URL gets dropped so it can't slip into the dropdowns or display.
      const cstr = readCustomStrings(params);
      const _noteRe = /^[A-G♯♭]+$/;
      for (const sk in cstr) {
        const _v = bToFlat(sharpToHash(cstr[sk]));
        if (_noteRe.test(_v)) raw[sk] = [_v];
      }
      // Track how many s-strings the URL actually carried (post-validation,
      // so invalid notes from a hand-edited URL don't bump the count).
      // Used to override the fretboard string count when custom is engaged.
      let _csCountUrl = 0;
      for (let i = 1; i <= 12; i++) {
        if (raw['s' + i] && raw['s' + i][0]) _csCountUrl = i;
        else break;
      }
      x._customStrsFromUrl = _csCountUrl;

      // Validate x (tuning key)
      if (raw.x && raw.x[0]) {
        if (Object.prototype.hasOwnProperty.call(TUNINGS, raw.x[0])) {
          x.x = raw.x[0];
        } else {
          def = 'y';
        }
      }

      // Validate single-value note params (k, s1..s12)
      // Allow flats too — custom string-note dropdowns can produce e.g.
      // B♭ which is a valid note. Without ♭ here, any URL containing a
      // flat custom string failed validation and triggered the "use
      // defaults for everything" fallback below, silently dropping z=y
      // and disengaging custom tuning whenever the user touched any
      // form control (key, tuning, custom string).
      const noteOk = /^[A-G♯♭]+$/;
      for (const n of URL_NOTE_CHECK) {
        if (raw[n] && raw[n][0]) {
          if (noteOk.test(raw[n][0])) {
            x[n] = raw[n][0];
          } else {
            def = 'y';
          }
        }
      }

      // Validate y, z
      for (const o of URL_CHECK) {
        if (raw[o] && raw[o][0]) {
          if (/^[yn]$/.test(raw[o][0])) {
            x[o] = raw[o][0];
          } else {
            def = 'y';
          }
        }
      }

      // Validate hl (multi-value)
      if (raw.hl && raw.hl.length) {
        const joined = raw.hl.join(' ');
        // valid chars: 1-7 and ♭ (which arrived as "b" → already converted to ♭)
        if (/^[1-7♭ ]+$/.test(joined)) {
          x.hl = joined;
        } else {
          def = 'y';
        }
      } else {
        x.hl = 'nothing';
      }

      // Validate pk (chord-identifier picks). Notes are canonicalized to
      // the sharp form ALLNOTES uses so ?pk=Bb and ?pk=As both land as A♯.
      const FLAT_TO_SHARP = {
        'A♭': 'G♯', 'B♭': 'A♯', 'C♭': 'B',
        'D♭': 'C♯', 'E♭': 'D♯', 'F♭': 'E',
        'G♭': 'F♯'
      };
      const pkRaw = readPkParam(params).map(function (v) {
        const f = bToFlat(sharpToHash(v));
        return FLAT_TO_SHARP[f] || f;
      });
      const validPk = pkRaw.filter(function (n) {
        return ALLNOTES.indexOf(n) !== -1;
      });
      x.pk = validPk.join(' ');
    }

    // Apply defaults
    if (def === 'y' || !hasParams) {
      for (const k in DEF_X) x[k] = DEF_X[k];
    } else {
      for (const k in DEF_X) {
        if (x[k] === undefined || x[k] === '' || Array.isArray(x[k])) x[k] = DEF_X[k];
      }
    }

    // Merge in the chosen tuning
    const tun = TUNINGS[x.x];
    for (const k in tun) x[k] = tun[k];
    // Override the precomputed url_notes so emitted URLs use the new
    // 's' form for sharps (data.js still has %23-encoded values).
    x.url_notes = urlNote(x.notes);

    // Build x.s from s1..s12 (custom-tuning notes assembled in reverse order).
    // Cap at the URL-derived count when present; otherwise cap at the main
    // tuning's string count so a bare-URL load with a 6-string main doesn't
    // surface the legacy 12-string DEF_X entries in the header.
    const _sCount = (x._customStrsFromUrl > 0) ? x._customStrsFromUrl : (+x.strs || 12);
    let ess = '';
    for (let i = _sCount; i >= 1; i--) {
      if (KEYS.indexOf(x['s' + i]) !== -1) ess += x['s' + i] + ' ';
    }
    ess = ess.trim();
    x.s = ess;
    x.rev_s = reverseSpaceStr(ess);

    if (x.z === 'y') {
      x.d_name = 'Custom';
      x.d_notes = x.s;
      // When custom tuning is engaged, the fretboard's string count comes
      // from how many strings were actually in the URL — NOT from x.sN
      // (which DEF_X defaults backfill for the unused slots). That way
      // switching from a 12-string custom to a 6-string custom drops
      // the visible fretboard down to 6 rows even though x.s7..x.s12
      // still hold default fallback values.
      if (x._customStrsFromUrl > 0) x.strs = x._customStrsFromUrl;
    } else {
      x.d_name = x.name;
      x.d_notes = x.notes;
    }
    x.rev_yy = 'High to Low';
    x.yy = 'Low to High';

    // notesplode = reversed split of tuning notes; x.x1..x12 are fretboard string notes (top→bottom)
    const notesplode = x.notes.split(' ').reverse();
    for (let a = 1; a <= 12; a++) {
      x['x' + a] = notesplode[a - 1];
    }

    // url_s: single dot-separated 's' param holding s1..s12 in order, with
    // sharps written as 's' (urlNote handles the ♯→s transform). Cap the
    // build at _customStrsFromUrl so chord/scale chip URLs (which embed
    // url_s) don't pull in DEF_X defaults for s7..s12 and silently turn
    // a 6-string custom into a 12-string custom on click. If no s was in
    // the URL at all, emit nothing — the chip URL has no business
    // inventing a custom tuning that the user never set up.
    let url_s = '';
    if (x._customStrsFromUrl > 0) {
      const _sLimit = x._customStrsFromUrl;
      let _sParts = [];
      for (let a = 1; a <= _sLimit; a++) {
        _sParts.push(x['s' + a] ? urlNote(x['s' + a]) : '');
      }
      while (_sParts.length && !_sParts[_sParts.length - 1]) _sParts.pop();
      if (_sParts.length) {
        const _hasGap = _sParts.some(function (v) { return !v; });
        url_s = 's=' + _sParts.join(_hasGap ? '.' : '') + '&';
      }
    }

    // Print colors are always on now — body keeps the .print-colors class
    // permanently so highlight bg's print as colors. Toggle was removed.

    // Tunings table sort: ?sort=<col>:<a|d>
    const sortRaw = params.get('sort');
    if (sortRaw && /^\d+:[ad]$/.test(sortRaw)) {
      const parts = sortRaw.split(':');
      x._sort = { col: parseInt(parts[0], 10), dir: parts[1] };
    } else {
      // Default: sort by Strings ascending (column 0) so 6-strings land
      // at the top whenever the URL doesn't specify a sort.
      x._sort = { col: 0, dir: 'a' };
    }

    // Tunings filter: ?f=<text>. Length-capped + control chars stripped to keep
    // the URL sane and to ensure nothing weird ends up on the page (we still
    // only ever set this via .value / textContent, never innerHTML).
    const fRaw = params.get('f');
    x._filter = '';
    if (typeof fRaw === 'string') {
      x._filter = fRaw.replace(/[\x00-\x1F\x7F]/g, '').slice(0, 64);
    }
    // String-count quick filters — independent for the Tunings List section
    // (?fc=) and the fretboard tuning popover (?fcp=). Persisted separately
    // in the URL so a user who only plays 6-string can pin both filters.
    function _validStrs(v) {
      return (v === '4' || v === '5' || v === '6' || v === '8' || v === '10' || v === '12') ? v : '';
    }
    x._filterStrs    = _validStrs(params.get('fc'));
    x._pickerStrs    = _validStrs(params.get('fcp'));

    // Progression-builder palette mode. Source of truth is the
    // _PROG_MODES dictionary defined later — accept any key from
    // there. Unknown / missing values fall back to 'major'.
    const pmodeRaw = (params.get('pmode') || '').toLowerCase();
    x._pmode = (typeof _PROG_MODES === 'object' && _PROG_MODES && _PROG_MODES[pmodeRaw])
      ? pmodeRaw : 'major';

    // Progression tokens. Each is independently either:
    //   • Roman ('I', 'bIII', '♯iv°') — mode-relative, transposes with
    //     the page key. Added when the user clicks a palette chip.
    //   • Absolute ('Cmaj7', 'F♯m', 'Bb7') — a specific chord. Added
    //     when the user clicks the add-box ghost or edits a bar's
    //     note / voicing dropdown.
    // Per-token format detection: leading [A-G] → absolute, else Roman.
    const progRaw = params.get('prog');
    x._prog = [];
    if (typeof progRaw === 'string' && progRaw.length) {
      x._prog = progRaw.split('.')
        .map(function (t) { return t.trim(); })
        .filter(Boolean)
        .map(function (t) {
          if (/^[A-G]/.test(t)) {
            // Absolute chord name — URL accidentals to display.
            const m = t.match(/^([A-G])([sb#♭♯])?(.*)$/);
            if (!m) return t;
            const letter = m[1];
            const acc = m[2];
            const suffix = m[3] || '';
            let root = letter;
            if (acc === 's' || acc === '#' || acc === '♯') root = letter + '♯';
            else if (acc === 'b' || acc === '♭')           root = letter + '♭';
            return root + suffix;
          }
          // Roman: 'b' prefix → '♭', 's' prefix → '♯', 'o' suffix → '°'.
          let s = t;
          if (s[0] === 'b')      s = '♭' + s.slice(1);
          else if (s[0] === 's') s = '♯' + s.slice(1);
          if (s.slice(-1) === 'o') s = s.slice(0, -1) + '°';
          return s;
        })
        .slice(0, 24);   // hard cap so URLs don't grow unbounded
    }
    // Active chord-ID chip name — set by applyChordHref, cleared by
    // clearHlOnlyHref. Pins the engaged-state visual to the specific
    // chip the user clicked instead of every chip whose pitch classes
    // match xs.hl.
    x._id_active = String(params.get('idn') || '');

    // Playback tempo for the progression builder (BPM). 40-240 valid;
    // anything else falls back to default 100.
    const tempoRaw = parseInt(params.get('tempo') || '', 10);
    x._tempo = (tempoRaw >= 40 && tempoRaw <= 240) ? tempoRaw : 100;

    // hl_arr → flags
    if (x.hl === undefined || x.hl === null) x.hl = '';
    const hlArr = String(x.hl).split(' ').filter(v => v !== '' && v !== 'nothing');
    // Compact single-key form for emitted URLs (?hl=1,b3,5).
    x.url_hl = hlArr.length ? 'hl=' + hlArr.map(flatToB).join('') + '&' : '';
    // Legacy multi-key form, kept ONLY for matching against SCALES / CHORDS /
    // GRID values in data.js (which are still expressed as &hl=…&hl=…). Not
    // emitted into any URL. If we later regen data.js with the compact form,
    // this can collapse onto x.url_hl.
    let url_hl_match = '';
    for (const v of hlArr) url_hl_match += 'hl=' + flatToB(v) + '&';
    x._url_hl_match = url_hl_match;

    for (const v of DEGREES) {
      const key = 'hl_' + flatToB(v);
      x[key] = hlArr.indexOf(v) !== -1 ? 'y' : 'n';
    }

    // Click-to-pick chord-identifier set. Renderers paint these cells with
    // a yellow ring and the identify strip scans this set.
    if (x.pk === undefined || x.pk === null) x.pk = '';
    const pkArr = String(x.pk).split(' ').filter(function (v) { return v.length; });
    x._pk_set = new Set(pkArr);
    x.url_pk = pkArr.length
      ? 'pk=' + pkArr.map(function (n) { return urlNote(n); }).join('') + '&'
      : '';

    // notedegrees: degree → note based on current key
    const a0 = KEYS.indexOf(x.k);
    const notedegrees = {};
    for (let b = 0; b <= 11; b++) {
      notedegrees[DEGREES[b]] = KEYS[a0 + b];
    }
    x._notedegrees = notedegrees;

    // sdgs1..12 — degree of each custom-tuning string in current key
    const sdgs = [];
    for (let i = 12; i >= 1; i--) {
      const d = findKey(notedegrees, x['s' + i]);
      x['sdgs' + i] = d;
      sdgs[i] = d;
    }
    // implode in 1..12 order? PHP does sdgs[1..12] via loop 12→1, then implode preserves keys 12..1
    // Cap the degree readout at the URL-derived custom-string count, same
    // as x.s above, so a 6-string custom tuning's degrees aren't padded
    // out with DEF_X defaults' degrees.
    let sdgsStr = '';
    for (let i = _sCount; i >= 1; i--) if (sdgs[i] !== undefined) sdgsStr += sdgs[i] + ' ';
    x.sdgs = sdgsStr.trim();
    x.rev_sdgs = reverseSpaceStr(x.sdgs);

    // hl_name lookup — match against the legacy multi-key form (data.js
    // SCALES / CHORDS / GRID values still use &hl=…&hl=…).
    x.hl_name = 'Highlighted: ';
    x.hl_n = '';
    const targetHl = '&' + x._url_hl_match;
    function checkSet(set, suffix) {
      for (const a in set) {
        if (targetHl === set[a] + '&') {
          x.hl_name += a.replace(/_/g, ' ') + suffix;
          x.hl_n += a.replace(/_/g, ' ');
          return true;
        }
      }
      return false;
    }
    // Check GRID before CHORDS so the chord-name casing matches what the
    // builder grid + quick-pick chips iterate (GRID has 'aug', 'dim', 'dom7',
    // etc. — lowercase — while the legacy CHORDS map has 'Aug', 'Dim',
    // 'Dom7'). With CHORDS first, x.hl_n didn't match the chip names.
    if (!checkSet(SCALES, ' Scale')) {
      if (!checkSet(GRID, ' Chord')) checkSet(CHORDS, ' Chord');
    }
    x.hl_name += ' (' + x.hl + ')';

    x.url_s = url_s;
    x.url_x = 'x=' + x.url_notes + '&';
    x.url_k = 'k=' + x.k + '&';
    x.url_y = 'y=' + x.y + '&';
    x.url_z = 'z=' + x.z + '&';

    x._self = '?';
    x._hilight_url = x._self + x.url_k + x.url_x + x.url_y + x.url_z + x.url_s + x.url_pk;

    // ---- Unlinked mode + per-section overrides ---------------------------
    // ?u=1 flips the page into "each section drives its own state" mode.
    // While unlinked, params named like s<num>_<key> (e.g. s4_k=D,
    // s4_hl=1,b3,5) override the same key for that section only. Stripped
    // automatically when the user re-Links via the toggle button.
    // Unlinked mode is retired — always treat the page as linked. Older
    // bookmarks containing ?u=1 still load, but section-specific
    // overrides are ignored so every section reflects the global state.
    x._unlinked = false;
    x._sectionOverrides = {};
    if (false) {
      for (const [k, v] of params.entries()) {
        const m = k.match(/^s(\d+)_(.+)$/);
        if (!m) continue;
        const sec = 'section_' + m[1];
        const field = m[2];
        x._sectionOverrides[sec] = x._sectionOverrides[sec] || {};
        x._sectionOverrides[sec][field] = v;
      }
    }

    return x;
  }

  // Build a "virtual" query string for a section by stripping any
  // s<n>_* prefixed keys from the URL and overlaying that section's
  // overrides on top of the global params. Pass the result back into
  // parseState() to get a fully-derived per-section state with all
  // the mask helpers (_hl_set, _pk_set, etc.) recomputed properly.
  function virtualSearchForSection(sectionId, baseSearch) {
    const m = String(sectionId || '').match(/^section_(\d+)$/);
    if (!m) return baseSearch;
    const sNum = m[1];
    const inP = new URLSearchParams(baseSearch);
    const sectionOverrides = {};   // field → comma-joined raw value
    inP.forEach((v, k) => {
      const mm = k.match(/^s(\d+)_(.+)$/);
      if (mm && mm[1] === sNum) sectionOverrides[mm[2]] = v;
    });
    const out = new URLSearchParams();
    inP.forEach((v, k) => {
      if (/^s\d+_/.test(k)) return;       // drop ALL section overrides from base
      if (k === 'u')        return;       // virtual URL parses as "linked"
      // hl / pk / s are multi/special — preserve their relative order
      out.append(k, v);
    });
    // Apply this section's overrides on top
    for (const [field, raw] of Object.entries(sectionOverrides)) {
      // Multi-value fields go comma-separated when prefixed; expand
      // back to repeated keys so the parser path matches the canonical
      // global form.
      if (field === 'hl' || field === 'pk') {
        // strip any existing
        const exist = out.getAll(field);
        if (exist.length) {
          // delete all instances
          out.delete(field);
        }
        // Tokenize the section override using the same parser the global
        // path uses, so legacy comma overrides AND the new separator-free
        // form both expand back to repeated `?hl=…` / `?pk=…` keys.
        const tokens = (field === 'hl' ? _tokenizeHl(raw) : _tokenizePk(raw));
        tokens.forEach(p => p && out.append(field, p));
      } else {
        out.set(field, raw);
      }
    }
    return out.toString();
  }

  // Resolve the right state for a particular section: when unlinked,
  // re-parse the URL with that section's overrides folded in; when
  // linked, just return the global x.
  function stateForSection(sectionId, x) {
    if (!x || !x._unlinked) return x;
    if (!x._sectionOverrides[sectionId]) return x;
    const virt = virtualSearchForSection(sectionId, window.location.search);
    return parseState(virt);
  }

  function findKey(obj, val) {
    for (const k in obj) if (obj[k] === val) return k;
    return false;
  }

  // ---------- renderers ----------
  function renderTitle(x) {
    const a = document.querySelector('#section_1 h1 a');
    if (a) a.href = x._self;
  }

  function renderOptions(x) {
    const root = document.getElementById('options_root');
    let h = '<div id="tunings_drop">';

    // Row 1: tuning picker. The string-direction (y) toggle now lives in
    // the fretboard's bottom row (replacing the open-string "X" marker)
    // and only flips the row order on the fretboard — the picker label
    // stays in the canonical low → high order regardless.
    h += '<div class="opt_row opt_row_main">';
    const curLabel = '(' + x.strs + '-string) ' + x.name + ' — ' + x.notes + ' — (' + x.dgs + ')';
    h += '<div class="tun_picker" id="tun_picker">';
    h +=   '<button type="button" class="tun_picker_btn inputs" id="tun_picker_btn" aria-haspopup="dialog" aria-expanded="false">';
    h +=     '<span class="tun_btn_main">' + escHtml(curLabel) + '</span>';
    h +=     '<span class="tun_btn_caret" aria-hidden="true">▾</span>';
    h +=   '</button>';
    h +=   '<select class="inputs tun_hidden_select" name="x" aria-hidden="true" tabindex="-1">';
    h +=     '<option value="' + escHtml(x.x) + '" selected>' + escHtml(curLabel) + '</option>';
    h +=   '</select>';
    h +=   '<div class="tun_pop" id="tun_pop" hidden role="dialog" aria-label="Choose a tuning"></div>';
    h += '</div>';
    h += '</div>';

    // (Key dropdown + Clear live in the section title bars now, not in the form.)

    // Row 3: highlight degree pickers (link-style toggle pills) — placed
    // ABOVE the note-letter row so the user reads the abstract degree
    // first and the concrete pitch directly under it. Note row reorders
    // when the key changes (root note sits under degree 1).
    // Combined degree+note pill row: 12 stacked buttons, each showing
    // degree on top and the resolved note (in the current key) below.
    h += comboPillsHtml(x, 'fb_hl_row');

    // All / None pair for the combined pill row.
    h += allNoneRowHtml('fb_allnone_row');

    h += '</div>';
    root.innerHTML = h;
  }

  // ---------- tuning picker popover ----------
  // Sortable / filterable replacement for the native <select name="x">.
  // Sort + filter state persists in module-scope vars across re-renders so the
  // user keeps their column sort and search after picking a tuning.
  let _tunPickerSort = { col: 'strs', dir: 'asc' };
  let _tunPickerFilter = '';
  let _tunPickerStrFilter = '';   // '' = all; '6' / '8' / '10' / '12' for quick string-count filter

  function _tunPickerRows(x) {
    const rev = (x.y === 'y') ? 'rev_' : '';
    const rows = [];
    for (const key in TUNINGS) {
      const t = TUNINGS[key];
      rows.push({
        key:   key,
        strs:  t.strs,
        name:  t.name,
        notes: t[rev + 'notes'],
        dgs:   t[rev + 'dgs'],
        info:  t.info || ''
      });
    }
    return rows;
  }

  function _tunPickerSorted(rows) {
    const { col, dir } = _tunPickerSort;
    const mul = dir === 'desc' ? -1 : 1;
    return rows.slice().sort(function (a, b) {
      let av = a[col], bv = b[col];
      if (col === 'strs') { av = +av; bv = +bv; }
      else { av = String(av).toLowerCase(); bv = String(bv).toLowerCase(); }
      if (av < bv) return -1 * mul;
      if (av > bv) return  1 * mul;
      // Stable secondary sort by name then notes
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      return a.notes.localeCompare(b.notes);
    });
  }

  function _tunPickerFiltered(rows) {
    let out = rows;
    if (_tunPickerStrFilter) {
      const want = +_tunPickerStrFilter;
      out = out.filter(function (r) { return +r.strs === want; });
    }
    const q = _tunPickerFilter.trim().toLowerCase();
    if (q) {
      // tokenise so "8 a6" matches "8-string A6 ..."
      const toks = q.split(/\s+/);
      out = out.filter(function (r) {
        const hay = (r.strs + ' ' + r.name + ' ' + r.notes + ' ' + r.dgs + ' ' + r.info).toLowerCase();
        return toks.every(function (t) { return hay.indexOf(t) !== -1; });
      });
    }
    return out;
  }

  function renderTuningPicker(x) {
    const pop = document.getElementById('tun_pop');
    if (!pop) return;
    const rows = _tunPickerFiltered(_tunPickerSorted(_tunPickerRows(x)));
    const cols = [
      { k: 'strs',  label: 'Str' },
      { k: 'name',  label: 'Name' },
      { k: 'notes', label: 'Notes' },
      { k: 'dgs',   label: 'Degrees' },
      { k: 'info',  label: 'Info' }
    ];
    let h = '';
    h += '<div class="tun_pop_head">';
    h += '  <input type="search" class="tun_pop_filter" placeholder="filter — e.g. ‘8 A6’ or ‘E9 emmons’" value="' + escHtml(_tunPickerFilter) + '" autocomplete="off" spellcheck="false">';
    h += '  <span class="tun_pop_count">' + rows.length + ' / ' + Object.keys(TUNINGS).length + '</span>';
    h += '  <button type="button" class="tun_pop_csv section_export" data-export="tunings"'
       +    ' title="Download the currently filtered tunings as CSV">CSV</button>';
    h += '</div>';
    // Quick string-count radios — one click filter for the most common
    // selectors. The filter text input still works on top of this.
    const quick = ['', '4', '5', '6', '8', '10', '12'];
    h += '<div class="tun_pop_strs" role="radiogroup" aria-label="Filter by string count">';
    quick.forEach(function (v) {
      const active = (_tunPickerStrFilter === v) ? ' active' : '';
      const label = v === '' ? 'All' : v + '-string';
      h += '<button type="button" class="tun_pop_str_btn' + active + '" '
        +  'data-strs="' + v + '" role="radio" aria-checked="' + (_tunPickerStrFilter === v) + '">'
        +  escHtml(label) + '</button>';
    });
    h += '</div>';
    h += '<div class="tun_pop_body">';
    h += '<table class="tun_pop_table"><thead><tr>';
    cols.forEach(function (c) {
      const arrow = (_tunPickerSort.col === c.k)
        ? (_tunPickerSort.dir === 'asc' ? ' ▲' : ' ▼')
        : '';
      const colHCls = c.k === 'strs' ? ' c_strs_h' : '';
      h += '<th data-col="' + c.k + '" class="tun_pop_th' + (_tunPickerSort.col === c.k ? ' active' : '') + colHCls + '">'
        + escHtml(c.label) + '<span class="tun_pop_arrow">' + arrow + '</span></th>';
    });
    h += '</tr></thead><tbody>';
    rows.forEach(function (r) {
      const sel = (r.key === x.x) ? ' tun_pop_row_selected' : '';
      h += '<tr class="tun_pop_row' + sel + '" data-key="' + escAttr(r.key) + '" tabindex="0">';
      h += '<td class="c_strs">' + r.strs + '</td>';
      h += '<td class="c_name">' + escHtml(r.name) + '</td>';
      h += '<td class="c_notes">' + escHtml(r.notes) + '</td>';
      h += '<td class="c_dgs">' + escHtml(r.dgs) + '</td>';
      h += '<td class="c_info">' + escHtml(r.info) + '</td>';
      h += '</tr>';
    });
    if (!rows.length) {
      h += '<tr><td colspan="5" class="tun_pop_empty">No tunings match.</td></tr>';
    }
    h += '</tbody></table></div>';
    pop.innerHTML = h;
  }

  function escAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function bindTuningPicker(x) {
    const btn = document.getElementById('tun_picker_btn');
    const pop = document.getElementById('tun_pop');
    if (!btn || !pop) return;
    // Seed the popover's quick-filter from URL state on each render so
    // the persisted ?fcp=… choice stays selected across reloads.
    _tunPickerStrFilter = x._pickerStrs || '';

    function open() {
      pop.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      renderTuningPicker(x);
      // focus the filter input for instant typing
      setTimeout(function () {
        const f = pop.querySelector('.tun_pop_filter');
        if (f) f.focus({ preventScroll: true });
        const selRow = pop.querySelector('.tun_pop_row_selected');
        // Manual scroll-within-popup so the selected row centers in the
        // popup's own scrollable body — `scrollIntoView` would also
        // scroll the page itself, causing a visible jump on open.
        const popBody = pop.querySelector('.tun_pop_body');
        if (selRow && popBody) {
          const rowTop    = selRow.offsetTop;
          const rowHeight = selRow.offsetHeight;
          popBody.scrollTop = rowTop - (popBody.clientHeight - rowHeight) / 2;
        }
      }, 0);
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onKeydown, true);
    }
    function close() {
      pop.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onKeydown, true);
    }
    function onDocDown(e) {
      if (!pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) close();
    }
    function onKeydown(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); }
    }

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      pop.hidden ? open() : close();
    });

    // Delegated handlers for the popover contents (re-rendered on filter/sort
    // changes, so attaching once on `pop` keeps wiring trivial).
    pop.addEventListener('input', function (e) {
      if (e.target.classList && e.target.classList.contains('tun_pop_filter')) {
        _tunPickerFilter = e.target.value;
        // Preserve focus + caret across re-render
        const at = e.target.selectionStart;
        renderTuningPicker(x);
        const f = pop.querySelector('.tun_pop_filter');
        if (f) { f.focus(); try { f.setSelectionRange(at, at); } catch (_) {} }
      }
    });
    pop.addEventListener('click', function (e) {
      const strBtn = e.target.closest && e.target.closest('.tun_pop_str_btn');
      if (strBtn) {
        const want = strBtn.getAttribute('data-strs') || '';
        _tunPickerStrFilter = want;
        // Persist popover string-count choice to ?fcp= so a user who only
        // plays 6-string can pin "6-string" once and keep it across reloads.
        const params = new URLSearchParams(window.location.search);
        if (want) params.set('fcp', want); else params.delete('fcp');
        const qs = canonicalQS(params);
        history.replaceState({}, '', qs ? '?' + qs : window.location.pathname);
        renderTuningPicker(x);
        return;
      }
      const th = e.target.closest && e.target.closest('.tun_pop_th');
      if (th) {
        const col = th.getAttribute('data-col');
        if (_tunPickerSort.col === col) {
          _tunPickerSort.dir = _tunPickerSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          _tunPickerSort = { col: col, dir: col === 'strs' ? 'asc' : 'asc' };
        }
        renderTuningPicker(x);
        return;
      }
      const row = e.target.closest && e.target.closest('.tun_pop_row');
      if (row) {
        const key = row.getAttribute('data-key');
        if (key) {
          close();
          // Apply the new tuning by setting the hidden select + dispatching
          // change → bindAutoSubmit → gatherAndNavigate, which preserves every
          // other URL param.
          const sel = document.querySelector('.tun_hidden_select');
          if (sel) {
            // Make sure the option exists before setting value (single-option select)
            const opt = document.createElement('option');
            opt.value = key;
            opt.selected = true;
            sel.innerHTML = '';
            sel.appendChild(opt);
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      }
    });
    pop.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        const row = document.activeElement && document.activeElement.closest && document.activeElement.closest('.tun_pop_row');
        if (row) { e.preventDefault(); row.click(); }
      }
    });
  }

  // Quick-pick chord/scale chips. Reused above the fretboard AND above the
  // keyboard so the user can drive selections from either section without
  // scrolling to a builder grid. Two side-by-side buckets (chord chips
  // left, scale chips right), wrapped in a <details> so the whole strip
  // can be collapsed when the user wants more vertical real estate.
  // Open/closed state persists in localStorage per slot (id).
  function quickPicksHtml(x, idAttr) {
    const slotId = idAttr || 'quick_picks';
    // Closed slot ids live in a single comma-list (URL: qpc, LS:
    // sf_qp_closed). Default = empty list = all open.
    const closed = getSetting('qp_closed') || [];
    const qpOpen = closed.indexOf(slotId) === -1;
    let h = '';
    h += '<details class="qp_box"' + (qpOpen ? ' open' : '')
      + ' data-qp-id="' + escAttr(idAttr || 'quick_picks') + '"'
      + (idAttr ? ' id="' + idAttr + '"' : '') + '>';
    h += '<summary class="qp_summary">';
    h +=   '<span class="qp_summary_title">Chord &amp; Scale Picks</span>';
    h += '</summary>';
    h += '<div class="qp_buckets">';
    // Chord bucket (left)
    h += '<div class="qp_bucket qp_bucket_chords">';
    h +=   '<div class="qp_bucket_label">Chords</div>';
    h +=   '<div class="qp_row">';
    for (const a in GRID) {
      const label = a.replace(/b/g, '♭').replace(/#/g, '♯');
      const chipDegs = fragToDegrees(GRID[a]);
      const isSelected = degSetsEqual(chipDegs, x.hl);
      // Selected → empty `hl=` so the merger explicitly clears s<n>_hl
      // (without it, an absent hl param would leave the section override
      // intact and the chip would stay highlighted).
      const href = isSelected ? (x._hilight_url + 'hl=') : (x._hilight_url + hlMultiToCsv(GRID[a]));
      const cls = 'qp_link' + (isSelected ? ' cg_selected' : '');
      const tip = degsAndNotesTip(label, chipDegs, x.k, 'chord');
      h += '<a class="' + cls + '" href="' + href + '" title="' + escAttr(tip) + '">' + escHtml(label) + '</a>';
    }
    h +=   '</div>';
    h += '</div>';
    // Scale bucket (right)
    h += '<div class="qp_bucket qp_bucket_scales">';
    h +=   '<div class="qp_bucket_label">Scales</div>';
    h +=   '<div class="qp_row">';
    for (const name in SCALES) {
      const label = name.replace(/_/g, ' ');
      const chipDegs = fragToDegrees(SCALES[name]);
      const isSelected = degSetsEqual(chipDegs, x.hl);
      const href = isSelected ? (x._hilight_url + 'hl=') : (x._hilight_url + hlMultiToCsv(SCALES[name]));
      const cls = 'qp_link' + (isSelected ? ' cg_selected' : '');
      const tip = degsAndNotesTip(label, chipDegs, x.k, 'scale');
      h += '<a class="' + cls + '" href="' + href + '" title="' + escAttr(tip) + '">' + escHtml(label) + '</a>';
    }
    h +=   '</div>';
    h += '</div>';
    h += '</div>';   // .qp_buckets
    h += '</details>';
    return h;
  }
  // Persist quick-picks open/closed state to localStorage so the user's
  // preference survives page reloads. Delegated handler since the
  // <details> elements are recreated on every applyState.
  if (typeof document !== 'undefined' && !document.body._qpToggleBound) {
    // Defer to DOMContentLoaded to make sure document.body exists.
    const _wireQp = function () {
      if (document.body._qpToggleBound) return;
      document.body._qpToggleBound = true;
      document.body.addEventListener('toggle', function (e) {
        const det = e.target;
        if (!det || !det.classList) return;
        // Transient toggles fired by Chrome as the parser inserts
        // <details> via innerHTML must not be persisted — they're not
        // user clicks. applyState raises this flag around every render.
        if (window._suppressDetailsToggle) return;
        if (det.classList.contains('qp_box')) {
          const id = det.getAttribute('data-qp-id') || 'quick_picks';
          const closed = (getSetting('qp_closed') || []).filter(function (s) { return s !== id; });
          if (!det.open) closed.push(id);
          setSetting('qp_closed', closed);
        } else if (det.classList.contains('identify_box')) {
          const sec = det.getAttribute('data-id-section');
          if (!sec) return;
          const closed = (getSetting('id_closed') || []).filter(function (s) { return s !== sec; });
          if (!det.open) closed.push(sec);
          setSetting('id_closed', closed);
        }
      }, true);  // capture: <details> toggle events don't bubble
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _wireQp);
    } else {
      _wireQp();
    }
  }

  // Per-degree colors used for the highlight-pill on-state, mirroring the
  // fretboard cell colors (#_1_ etc. in styles.css). Keep in sync with that map.
  const HL_PILL_COLORS = {
    '1':  '#ff0000', 'b2': '#674ea7', '2':  '#9900ff',
    'b3': '#f6b26b', '3':  '#ff6d01', '4':  '#00ffff',
    'b5': '#3d85c6', '5':  '#0000ff',
    'b6': '#6aa84f', '6':  '#0cc016',
    'b7': '#a64d79', '7':  '#ff00ff'
  };
  // Degrees whose background reads dark enough that white text wins.
  const HL_PILL_LIGHT_TEXT = { '1':1, 'b2':1, '2':1, '3':1, 'b5':1, '5':1, 'b6':1, 'b7':1, '7':1 };

  // Highlight degree pills as toggle LINKS (not checkboxes). Used both inside
  // the fretboard form AND above the keyboard section so the two stay in sync.
  // Each pill flips its own `&hl=<deg>` in the URL, so the link interceptor
  // re-renders in place. On-state pills are coloured to match the degree.
  // ---------- key-signature reference data ----------
  // Two parallel orders of the major keys: sharp side (C through C♯) and
  // flat side (F through C♭). Each row carries:
  //   key      — display name, including unicode accidentals
  //   setKey   — value to set k= to (URL state uses ♯-spellings only)
  //   count    — sharps or flats in the signature
  //   notes    — the actual accidental notes in canonical signature order
  const KEY_SIGS_SHARP = [
    { key: 'C',  setKey: 'C',  count: 0, notes: '—' },
    { key: 'G',  setKey: 'G',  count: 1, notes: 'F♯' },
    { key: 'D',  setKey: 'D',  count: 2, notes: 'F♯ C♯' },
    { key: 'A',  setKey: 'A',  count: 3, notes: 'F♯ C♯ G♯' },
    { key: 'E',  setKey: 'E',  count: 4, notes: 'F♯ C♯ G♯ D♯' },
    { key: 'B',  setKey: 'B',  count: 5, notes: 'F♯ C♯ G♯ D♯ A♯' },
    { key: 'F♯', setKey: 'F♯', count: 6, notes: 'F♯ C♯ G♯ D♯ A♯ E♯' },
    { key: 'C♯', setKey: 'C♯', count: 7, notes: 'F♯ C♯ G♯ D♯ A♯ E♯ B♯' }
  ];
  const KEY_SIGS_FLAT = [
    { key: 'F',  setKey: 'F',  count: 1, notes: 'B♭' },
    { key: 'B♭', setKey: 'A♯', count: 2, notes: 'B♭ E♭' },
    { key: 'E♭', setKey: 'D♯', count: 3, notes: 'B♭ E♭ A♭' },
    { key: 'A♭', setKey: 'G♯', count: 4, notes: 'B♭ E♭ A♭ D♭' },
    { key: 'D♭', setKey: 'C♯', count: 5, notes: 'B♭ E♭ A♭ D♭ G♭' },
    { key: 'G♭', setKey: 'F♯', count: 6, notes: 'B♭ E♭ A♭ D♭ G♭ C♭' },
    { key: 'C♭', setKey: 'B',  count: 7, notes: 'B♭ E♭ A♭ D♭ G♭ C♭ F♭' }
  ];

  // Pull a "1 ♭3 5" style degree readout out of a GRID / SCALES URL
  // fragment ("&hl=1&hl=b3&hl=5"). Empty string if the fragment is empty.
  function fragToDegrees(frag) {
    return String(frag || '').split('&hl=').slice(1)
      .map(function (s) { return s.replace(/&.*$/, '').replace(/b/g, '♭'); })
      .filter(function (s) { return s.length; })
      .join(' ');
  }

  // True when two degree sets contain the same items (order-independent).
  // Used to auto-highlight every chord/scale chip whose degrees match the
  // active hl, not just the one whose name x.hl_n happened to land on.
  function degSetsEqual(a, b) {
    const A = new Set(String(a || '').split(/\s+/).filter(Boolean));
    const B = new Set(String(b || '').split(/\s+/).filter(Boolean));
    if (A.size !== B.size) return false;
    for (const v of A) if (!B.has(v)) return false;
    return true;
  }

  // Compose a hover tooltip showing a chord/scale's degrees + the resulting
  // notes for the current site key. e.g.
  //   "Maj7\nDegrees: 1 3 5 7\nNotes: A C♯ E G♯"
  // degsStr arrives space-separated ("1 ♭3 5"); key is x.k.
  function degsAndNotesTip(label, degsStr, key, kind) {
    const degs = String(degsStr || '').split(' ').filter(function (d) { return d.length; });
    const head = (kind === 'chord' ? 'CHORD: ' : kind === 'scale' ? 'SCALE: ' : '') + label;
    if (!degs.length) return head;
    const notes = (function () {
      const i1 = KEYS.indexOf(key);
      if (i1 < 0) return [];
      return degs.map(function (d) {
        const off = DEGREES.indexOf(d);
        return off < 0 ? '' : KEYS[i1 + off];
      }).filter(Boolean);
    })();
    let tip = head + '\nDegrees: ' + degs.join(' ');
    if (notes.length) tip += '\nNotes: ' + notes.join(' ');
    // For scales: also include the W-H step pattern (intervals between
    // consecutive scale tones). Helps make the scale's "shape" portable
    // — e.g. Major reads as W-W-H-W-W-W-H regardless of key.
    if (kind === 'scale' && typeof _scaleStepPattern === 'function') {
      const sp = _scaleStepPattern(degs);
      if (sp) tip += '\nIntervals: ' + sp;
    }
    // Cross-reference: chord ↔ scale containment, so users can see which
    // scales include this chord (or which chords live in this scale).
    if (typeof _scalesContainingChord === 'function' &&
        typeof _chordsInScale === 'function') {
      if (kind === 'chord') {
        const hits = _scalesContainingChord(degs);
        if (hits.length) tip += '\nFound in: ' + hits.slice(0, 6).join(', ')
                              + (hits.length > 6 ? ' (+' + (hits.length - 6) + ' more)' : '');
      } else if (kind === 'scale') {
        const hits = _chordsInScale(degs);
        if (hits.length) tip += '\nContains chords: ' + hits.slice(0, 8).join(', ')
                              + (hits.length > 8 ? ' (+' + (hits.length - 8) + ' more)' : '');
      }
    }
    return tip;
  }

  // GRID / SCALES / CHORDS values in data.js are still in the legacy
  // multi-key form (&hl=1&hl=3&hl=5). Convert on the fly so chord/scale
  // chip URLs land in the same compact comma form as everything else.
  function hlMultiToCsv(frag) {
    const matches = (String(frag).match(/&hl=([^&]+)/g) || [])
      .map(function (s) { return s.slice(4); });
    if (!matches.length) return frag;
    const stripped = String(frag).replace(/&hl=[^&]+/g, '');
    return stripped + '&hl=' + matches.join('');
  }

  // Build a URL with the given hl list as a single separator-free `hl=`
  // param (preserves every other current param exactly). Tokens are
  // unambiguously parseable as b?[1-7] so no separator is needed —
  // saves the `%2C`-encoded commas the old form used.
  function buildHlHref(hlList) {
    const p = new URLSearchParams(window.location.search);
    p.delete('hl');
    let qs = p.toString();
    // Always emit `hl=` (even when empty) so unlinked-mode merging can
    // distinguish "click intends to clear" from "click didn't touch hl".
    qs += (qs ? '&' : '') + 'hl=' + (hlList.length ? hlList.join('') : '');
    return qs ? '?' + qs : '?';
  }

  // Mirror of buildHlHref for the chord-identifier pick set.
  // Build a URL that updates the chord-identifier pick set. In linked
  // mode the picks are global (`pk=…`); in unlinked mode each section
  // owns its own picks via `s<n>_pk=…`, so callers pass a sectionId so
  // the fretboard and keyboard identifiers don't share state.
  function buildPkHref(pkList, sectionId) {
    const unlinked = document.body.getAttribute('data-apply-all') === 'off';
    const p = new URLSearchParams(window.location.search);
    if (unlinked && sectionId) {
      const m = String(sectionId).match(/^section_(\d+)$/);
      if (m) {
        const key = 's' + m[1] + '_pk';
        // Always SET (never just delete) so an "empty picks" state
        // remains an explicit section override of "none", instead of
        // dropping the override entirely and silently inheriting the
        // global pk. Without this, unclicking the last pick made the
        // global picks reappear.
        if (pkList.length) {
          p.set(key, pkList.map(function (n) { return urlNote(n); }).join(''));
        } else {
          p.set(key, '');
        }
        p.set('u', '1');
        const qs = p.toString();
        return qs ? '?' + qs : '?';
      }
    }
    p.delete('pk');
    let qs = p.toString();
    if (pkList.length) {
      qs += (qs ? '&' : '') + 'pk=' + pkList.map(function (n) { return urlNote(n); }).join('');
    }
    return qs ? '?' + qs : '?';
  }
  // Read the section's effective pk array. Falls back to the global
  // pk= when there's no section override (or in linked mode).
  function readPkArrForSection(sectionId) {
    const params = new URLSearchParams(window.location.search);
    const unlinked = params.get('u') === '1';
    const m = String(sectionId || '').match(/^section_(\d+)$/);
    if (unlinked && m && params.has('s' + m[1] + '_pk')) {
      return _tokenizePk(params.get('s' + m[1] + '_pk') || '');
    }
    return readPkParam(params);
  }

  function highlightPillsLinkHtml(x, rowCls) {
    let h = '<div class="opt_row opt_row_highlights ' + (rowCls || '') + '">';
    // Use the section's EFFECTIVE highlight set (`x.hl`) — not the
    // global URL's `hl=` — so that in unlinked mode the pills toggle
    // against this section's s<n>_hl, instead of the empty global.
    // x.hl is space-joined ("1 ♭3 5"); convert to the array form the
    // builder uses (with ♭ already → "b" for URL safety).
    const cur = String(x.hl || '').split(' ')
                                  .filter(function (v) { return v && v !== 'nothing'; })
                                  .map(function (v) { return flatToB(v); });
    DEGREES.forEach(function (a, i) {
      const ab = flatToB(a);
      const on = (x['hl_' + ab] === 'y');
      let next;
      if (on) {
        next = cur.filter(function (d) { return d !== ab; });
      } else {
        next = cur.filter(function (d) { return d !== ab; }).concat([ab]);
      }
      const href = buildHlHref(next);
      const cls = 'hl_pill' + (on ? ' hl_pill_on' : '');
      let style = '';
      if (on) {
        const bg = HL_PILL_COLORS[ab] || '#888';
        const fg = HL_PILL_LIGHT_TEXT[ab] ? '#fff' : '#000';
        // !important on every property — the base .hl_pill rule and the
        // global a:link rule both use !important, which would otherwise
        // win over the inline declaration.
        style = ' style="background:' + bg + ' !important;color:' + fg
              + ' !important;border-color:' + bg + ' !important;"';
      }
      h += '<a class="' + cls + '" href="' + escHtml(href) + '"' + style + '>'
        + escHtml(a) + escHtml(EXTENSIONS[i]) + '</a>';
    });
    h += '</div>';
    return h;
  }

  // Combined degree + note pill row — one button per chromatic degree
  // showing the degree label on top and the note name (in the current
  // key) below. Replaces the two separate rows; toggling either part
  // toggles the same hl= entry.
  function comboPillsHtml(x, rowCls) {
    let h = '<div class="opt_row opt_row_combo ' + (rowCls || '') + '">';
    const i1 = KEYS.indexOf(x.k);
    const cur = String(x.hl || '').split(' ')
                                  .filter(function (v) { return v && v !== 'nothing'; })
                                  .map(function (v) { return flatToB(v); });
    DEGREES.forEach(function (deg, off) {
      const ab = flatToB(deg);
      const on = (x['hl_' + ab] === 'y');
      const noteIdx = i1 >= 0 ? (i1 + off) % ALLNOTES.length : off;
      const note = i1 >= 0 ? ALLNOTES[noteIdx] : '';
      let next;
      if (on) next = cur.filter(function (d) { return d !== ab; });
      else    next = cur.filter(function (d) { return d !== ab; }).concat([ab]);
      const href = buildHlHref(next);
      const cls = 'combo_pill' + (on ? ' combo_pill_on' : '');
      let style = '';
      if (on) {
        const bg = HL_PILL_COLORS[ab] || '#888';
        const fg = HL_PILL_LIGHT_TEXT[ab] ? '#fff' : '#000';
        style = ' style="background:' + bg + ' !important;color:' + fg
              + ' !important;border-color:' + bg + ' !important;"';
      }
      h += '<a class="' + cls + '" href="' + escHtml(href) + '"' + style + '>'
        +    '<span class="combo_pill_deg">' + escHtml(deg) + '</span>'
        +    '<span class="combo_pill_note">' + escHtml(note) + '</span>'
        +  '</a>';
    });
    h += '</div>';
    return h;
  }

  // Single All / None button pair — sits below the degree pill row so we
  // don't repeat the same controls at the end of both pill rows.
  function allNoneRowHtml(rowCls) {
    const allHref = buildHlHref(DEGREES.map(flatToB));
    const noneHref = clearHlOnlyHref();
    return '<div class="opt_row opt_row_allnone ' + (rowCls || '') + '">'
         + '<a class="hl_pill hl_all_pill" href="' + escHtml(allHref) + '">All</a>'
         + '<a class="hl_pill hl_none_pill" href="' + escHtml(noneHref) + '">None</a>'
         + '</div>';
  }

  // Note-letter highlight pills — drive the SAME hl= URL param as the degree
  // pills. Each note pill toggles the degree it represents in the current
  // key (e.g. in key of E, the "E" pill toggles degree 1). The two pill
  // rows are two views of the same control: the labels reshuffle when the
  // key changes but the underlying selection state stays put.
  function notePillsLinkHtml(x, rowCls) {
    let h = '<div class="opt_row opt_row_notes ' + (rowCls || '') + '">';
    const i1 = KEYS.indexOf(x.k);
    // Section-aware: use the SECTION's effective hl (x.hl) instead of
    // the global URL — mirrors the highlightPillsLinkHtml fix so
    // unlinked-mode pills toggle cumulatively against this section.
    const cur = String(x.hl || '').split(' ')
                                  .filter(function (v) { return v && v !== 'nothing'; })
                                  .map(function (v) { return flatToB(v); });
    // Iterate by DEGREE position (0..11) so the column-order under the
    // degree row matches degree-by-degree: position 0 = root, position
    // 1 = ♭2, etc. When the key changes, the notes rotate to keep the
    // root sitting directly under degree 1.
    for (let off = 0; off < ALLNOTES.length; off++) {
      const noteIdx = i1 >= 0 ? (i1 + off) % ALLNOTES.length : off;
      const note = ALLNOTES[noteIdx];
      const deg = i1 >= 0 ? DEGREES[off] : '';
      const ab = deg ? flatToB(deg) : '';
      const on = ab && (x['hl_' + ab] === 'y');
      let next;
      if (on) {
        next = cur.filter(function (d) { return d !== ab; });
      } else if (ab) {
        next = cur.filter(function (d) { return d !== ab; }).concat([ab]);
      } else {
        next = cur;
      }
      const href = buildHlHref(next);
      const cls = 'note_pill' + (on ? ' note_pill_on' : '');
      // Inline styling on the on-state mirrors the degree's pill color so
      // the two rows agree visually when the same item is engaged.
      let style = '';
      if (on) {
        const bg = HL_PILL_COLORS[ab] || '#888';
        const fg = HL_PILL_LIGHT_TEXT[ab] ? '#fff' : '#000';
        style = ' style="background:' + bg + ' !important;color:' + fg
              + ' !important;border-color:' + bg + ' !important;"';
      }
      h += '<a class="' + cls + '" href="' + escHtml(href) + '"' + style + '>' + escHtml(note) + '</a>';
    }
    h += '</div>';
    return h;
  }

  // Render the highlight pills + chord/scale chips above the keyboard so the
  // keyboard section is fully usable when the fretboard section is collapsed.
  function renderKeyboardPicks(x) {
    const root = document.getElementById('kb_picks_root');
    if (!root) return;
    // Combined degree+note pill row + All/None + quick picks.
    root.innerHTML = comboPillsHtml(x, 'kb_hl_row')
                   + allNoneRowHtml('kb_allnone_row')
                   + quickPicksHtml(x, 'kb_quick_picks');
  }

  function renderFretboard(x) {
    const root = document.getElementById('fretboard_root');
    const rev = (x.y === 'y') ? 'rev_' : '';
    const tuningName = (x.z === 'y') ? 'Custom' : x.name;
    const tuningNotes = (x.z === 'y')
      ? String(x[rev + 's']).replace(/ /g, '')
      : String(x[rev + 'notes']).replace(/ /g, '');
    const tuningDgs = (x.z === 'y')
      ? String(x[rev + 'sdgs']).replace(/ /g, '')
      : String(x[rev + 'dgs']).replace(/ /g, '');

    // Tuning + Key info now lives in each section's title bar (rendered by
    // renderSummaryStatus). The fretboard header only carries the form.
    let h = '';
    h += '<div class="fb_header">';
    h += '  <div id="options_root"></div>';
    h += '</div>';

    // Quick-pick chord/scale links — copies of the chord_grid + scale_grid
    // top rows, parked above the fretboard so the user doesn't have to
    // scroll down to a builder section to apply a chord or scale.
    h += quickPicksHtml(x, 'quick_picks');

    h += '<table id="fretboard">';

    const cyoState = x.z === 'y' ? 'on' : 'off';
    const cyoNextZ = x.z === 'y' ? 'n' : 'y';
    // Build a toggle URL that flips just the z param (preserving the rest)
    const toggleParams = new URLSearchParams(window.location.search);
    if (cyoNextZ === 'y') toggleParams.set('z', 'y'); else toggleParams.delete('z');
    const toggleHref = '?' + toggleParams.toString();
    // String-direction (y) toggle that lives in place of the open-string "X"
    // marker — one in each fretnums row so flipping the order is reachable
    // from either end of the fretboard without scrolling back to the form.
    const yToggleParams = new URLSearchParams(window.location.search);
    if (x.y !== 'y') yToggleParams.set('y', 'y'); else yToggleParams.delete('y');
    const yToggleHref = '?' + yToggleParams.toString();
    const yState = x.y === 'y' ? 'on' : 'off';
    const yLabel = x.y === 'y' ? 'H→L' : 'L→H';
    const yTitle = x.y === 'y'
      ? 'Strings shown High → Low. Click to flip to Low → High.'
      : 'Strings shown Low → High. Click to flip to High → Low.';
    const f0Cell = '<td id="f0" class="f0_y_switch"><a href="' + escHtml(yToggleHref)
                 + '" class="y_switch y_switch_sm y_' + yState + '" title="' + escAttr(yTitle)
                 + '" aria-label="Toggle string direction">' + yLabel + '</a></td>';
    const fretnumsTop = '<tr id="fretnums"><td class="fb_sm cyo_switch cyo_' + cyoState + '" id="' + (x.z === 'y' ? 'f_cyo' : 'f_cyo_dark') + '">' +
      '<a href="' + escHtml(toggleHref) + '" title="Click to toggle custom tuning">' + cyoState.toUpperCase() + '</a>' +
      '</td><td id="f0">X</td>'
      + '<td id="f1"><span class="fret_minor">1</span></td>'
      + '<td id="f2"><span class="fret_minor">2</span></td>'
      + '<td id="f3">3</td>'
      + '<td id="f4"><span class="fret_minor">4</span></td>'
      + '<td id="f5">5</td>'
      + '<td id="f6"><span class="fret_minor">6</span></td>'
      + '<td id="f7">7</td>'
      + '<td id="f8"><span class="fret_minor">8</span></td>'
      + '<td id="f9">9</td>'
      + '<td id="f10"><span class="fret_minor">10</span></td>'
      + '<td id="f11"><span class="fret_minor">11</span></td>'
      + '<td id="f12">12</td></tr>';
    h += fretnumsTop;

    const str = {};
    for (let a = 1; a <= 12; a++) {
      str[a] = String(x.z === 'y' ? x['s' + a] : x['x' + a]).trim();
    }

    // Compute open-string MIDI for every string (1..N) using the heuristic
    // in fretboardStringMidis. Convention here: s1 is the TOP row (highest
    // pitch) so the lowest pitch is sN — feed the helper in low-to-high
    // order and remap the result back by string number.
    const _midiByStr = (function () {
      const lowToHigh = [];
      for (let a = x.strs; a >= 1; a--) lowToHigh.push(str[a].toUpperCase());
      const midis = fretboardStringMidis(lowToHigh);
      const out = {};
      for (let i = 0; i < midis.length; i++) {
        // i=0 corresponds to a=N (lowest pitch), i=N-1 to a=1 (highest).
        out[x.strs - i] = midis[i];
      }
      return out;
    })();

    // String-direction toggle (y) flips the row order on the fretboard. y=y
    // walks the strings high-index-first; y=n walks 1..N. The tuning data
    // itself is untouched so the section header text stays canonical.
    for (let i = 0; i < x.strs; i++) {
      const a = (x.y === 'y') ? (x.strs - i) : (i + 1);
      const strizzle = str[a];
      const c = KEYS.indexOf(strizzle.toUpperCase());
      let nutDeg = findKey(x._notedegrees, strizzle.toUpperCase());
      let nutBg = (x['hl_' + flatToB(nutDeg)] === 'y') ? flatToB(nutDeg) : 'no_highlight';
      const f_cyo = (x.z === 'n') ? 'f_cyo_dark' : 'f_cyo';
      const nutNote = strizzle.toUpperCase();
      // pk yellow-ring picks have been retired — clicks now toggle hl,
      // chord ID reads from hl, and the note_pk class is no longer applied.
      const nutPkCls = '';

      h += '<tr>';
      h += '<td id="' + f_cyo + '"><select class="inputs" name="s' + a + '">';
      h += '<option value="' + escHtml(x['s' + a]) + '">' + escHtml(x['s' + a]) + '</option>';
      for (const note of ALLNOTES) {
        h += '<option value="' + escHtml(note) + '">' + escHtml(note) + '</option>';
      }
      h += '</select></td>';
      const _openMidi = _midiByStr[a];
      h += '<td class="nut' + nutPkCls + '" data-note="' + escHtml(nutNote) + '" data-midi="' + _openMidi + '" id="_' + nutBg + '_">' + escHtml(strizzle) + '(' + escHtml(nutDeg || '') + ')</td>';

      for (let b = 1; b <= 12; b++) {
        const cb = c + b;
        const noteAtFret = KEYS[cb];
        let degAtFret = findKey(x._notedegrees, noteAtFret);
        let fbId = (x['hl_' + flatToB(degAtFret)] === 'y') ? flatToB(degAtFret) : 'no_highlight';
        const cls = (b === 1) ? 'nut1' : 'fb_td';
        const cellPkCls = '';
        h += '<td class="' + cls + cellPkCls + '" data-note="' + escHtml(noteAtFret) + '" data-midi="' + (_openMidi + b) + '" id="_' + fbId + '_">'
           + '<span class="disp_note">' + escHtml(noteAtFret) + '</span>'
           + '<span class="disp_deg">(' + escHtml(degAtFret || '') + ')</span>'
           + '</td>';
      }
      h += '</tr>';
    }

    // "Load preset into custom" dropdown — sits in the bottom-left empty
    // cell. Picking a preset populates s1..sN with that tuning's notes
    // (mapped high → low to match the s1=top-string convention) and
    // navigates. Doesn't touch x or fcp filters; always shows every
    // tuning in the database. Visible whether custom tuning is on or
    // off — users may want to set up a custom tuning before engaging.
    const _customLoaderRows = Object.keys(TUNINGS).map(function (k) {
      const t = TUNINGS[k];
      return { key: k, strs: +t.strs, name: t.name, notes: t.notes };
    });
    _customLoaderRows.sort(function (a, b) {
      if (a.strs !== b.strs) return a.strs - b.strs;
      if (a.name === b.name) return a.notes.localeCompare(b.notes);
      return a.name.localeCompare(b.name);
    });
    let customLoaderHtml = '<select class="custom_tun_loader" aria-label="Load a preset tuning into custom strings">';
    customLoaderHtml += '<option value="">Load…</option>';
    for (const t of _customLoaderRows) {
      const lbl = '(' + t.strs + ') ' + t.name + ' — ' + t.notes;
      customLoaderHtml += '<option value="' + escAttr(t.key) + '">' + escHtml(lbl) + '</option>';
    }
    customLoaderHtml += '</select>';

    const fretnumsBot = '<tr id="fretnums">'
      + '<td id="f_cyo">' + customLoaderHtml + '</td>' + f0Cell
      + '<td id="f1"><span class="fret_minor">1</span></td>'
      + '<td id="f2"><span class="fret_minor">2</span></td>'
      + '<td id="f3">3</td>'
      + '<td id="f4"><span class="fret_minor">4</span></td>'
      + '<td id="f5">5</td>'
      + '<td id="f6"><span class="fret_minor">6</span></td>'
      + '<td id="f7">7</td>'
      + '<td id="f8"><span class="fret_minor">8</span></td>'
      + '<td id="f9">9</td>'
      + '<td id="f10"><span class="fret_minor">10</span></td>'
      + '<td id="f11"><span class="fret_minor">11</span></td>'
      + '<td id="f12">12</td></tr>';
    h += fretnumsBot + '</table>';

    root.innerHTML = h;
  }

  // Mini key picker for the chord-grid / scale-grid / keyboard sections so the
  // user can change key without expanding the fretboard section. Renders a
  // hidden <select name="k"> (so gatherAndNavigate keeps working unchanged)
  // plus 12 visible buttons. A click on a button updates the hidden select
  // and dispatches a change event — the existing pipeline runs from there.
  function keyPickerHtml(x) {
    return keyButtonsHtml(x.k);
  }
  function keyButtonsHtml(currentKey) {
    // Display order starts at E (guitar's lowest open string in standard
    // tuning) and walks chromatically upward; URL state still uses the
    // canonical ALLNOTES order, so this is purely a UI tweak.
    const startIdx = ALLNOTES.indexOf('E');
    const displayKeys = [];
    if (startIdx >= 0) {
      for (let i = 0; i < ALLNOTES.length; i++) {
        displayKeys.push(ALLNOTES[(startIdx + i) % ALLNOTES.length]);
      }
    } else {
      displayKeys.push.apply(displayKeys, ALLNOTES);
    }
    let h = '<span class="section_key_picker section_key_row">';
    h += '<span class="key_label">KEY:</span>';
    // Hidden select for legacy gatherAndNavigate compatibility. Keep
    // the canonical alphabetical order so the form value matches.
    h += '<select class="inputs key_hidden_select" name="k">';
    for (const a of ALLNOTES) {
      const sel = (a === currentKey) ? ' selected' : '';
      h += '<option value="' + escHtml(a) + '"' + sel + '>' + escHtml(a) + '</option>';
    }
    h += '</select>';
    for (const a of displayKeys) {
      const cls = (a === currentKey) ? ' active' : '';
      h += '<button type="button" class="key_btn' + cls + '" '
         + 'data-key="' + escHtml(a) + '">' + escHtml(a) + '</button>';
    }
    h += '</span>';
    return h;
  }

  // Each section's title bar gets its own Clear link, plus a row of 12
  // chromatic key buttons injected as a sibling element directly below
  // the summary so they're centred under the section title (not in the
  // right-side header strip).
  function renderSummaryExtras(x) {
    // Keep the sticky-header global Clear link in sync with the
    // current URL (so it always strips hl/pk while preserving key,
    // tuning, etc.).
    const siteClear = document.getElementById('site_clear');
    if (siteClear) siteClear.setAttribute('href', clearHlHref());
    // Populate the single global key row in the sticky header (replaces
    // the per-section rows). Uses the page-level x.k as the effective
    // key — sections that opted into per-section keys via s<n>_k= still
    // work in URL state, but the user-facing picker is now global.
    const globalRow = document.getElementById('global_key_row');
    if (globalRow) globalRow.innerHTML = keyButtonsHtml(x.k);
    // Sweep any leftover per-section key rows from prior renders. The
    // CSS hides them too, but removing keeps the DOM tidy.
    document.querySelectorAll('.section_key_row_outer').forEach(function (el) { el.remove(); });
    const slots = document.querySelectorAll('.summary_extras');
    if (!slots.length) return;
    slots.forEach(function (s) {
      const target = s.getAttribute('data-summary-for');
      // Only emit the compact toggle for sections that opt in. Per-section
      // Clear and key rows are gone — the sticky header owns those now.
      let prefix = (target === 'section_3' || target === 'section_6') ? compactToggleHtml() : '';
      s.innerHTML = prefix;
    });
  }

  // Tuning indicator lives next to the Fretboard section title — that's
  // the only place it's relevant. Shows tuning name + notes + degrees; a
  // "(custom)" pill indicates when z=y so users can see the custom path
  // is engaged at a glance.
  // When custom tuning is engaged, look up the loaded preset by matching
  // x.s (the assembled custom notes, low-to-high) against TUNINGS[].notes.
  // Returns the preset's name if found, '' otherwise (manual edit).
  function findCustomTuningName(x) {
    const want = String(x.s || '').trim();
    if (!want) return '';
    for (const k in TUNINGS) {
      if (TUNINGS[k].notes === want) return TUNINGS[k].name;
    }
    return '';
  }

  function renderSummaryStatus(x) {
    const isCustom = (x.z === 'y');
    // For custom tuning, show the name of the loaded preset if the notes
    // match one in TUNINGS. Falls back to "Custom" for hand-edited tunings.
    const tuningName = isCustom
      ? (findCustomTuningName(x) || 'Custom')
      : x.name;
    // Tuning text in the section title bar always reads in canonical
    // (low → high) order — the y switch only flips fretboard rows, not
    // this textual representation.
    const notesStr = isCustom ? x.s    : x.notes;
    const dgsStr   = isCustom ? x.sdgs : x.dgs;
    const tunEl = document.getElementById('site_tuning');
    if (tunEl) {
      let html = '';
      html += '<span class="st_lab">Tuning</span>';
      html += '<span class="st_val">' + escHtml(tuningName) + '</span>';
      if (notesStr) {
        html += '<span class="st_sep" aria-hidden="true">·</span>';
        html += '<span class="st_notes">' + escHtml(String(notesStr).trim()) + '</span>';
      }
      if (dgsStr) {
        html += '<span class="st_sep" aria-hidden="true">·</span>';
        html += '<span class="st_dgs">(' + escHtml(String(dgsStr).trim()) + ')</span>';
      }
      if (isCustom) {
        html += '<span class="st_custom_pill" aria-label="custom tuning engaged">custom</span>';
      }
      tunEl.innerHTML = html;
    }
    // Per-section .summary_status spans stay in the markup as flex spacers
    // (their `flex: 1` rule keeps the title left and buttons right) but no
    // longer carry visible text. Empty them so any prior content clears.
    document.querySelectorAll('.summary_status').forEach(function (s) {
      s.innerHTML = '';
    });
  }

  // Restrict the toggle to clicks on the .summary_title (which now hosts the
  // ▼/▶ arrow via ::before, so the arrow stays clickable). Anywhere else on
  // the summary bar — empty status spacer, button row, or padding around
  // them — is a no-op. Stops the section from collapsing when the user is
  // just trying to click a button or pick a key.
  function bindSummaryToggleScope() {
    document.querySelectorAll('details.collapsible > summary').forEach(function (summary) {
      if (summary._toggleScopeBound) return;
      summary._toggleScopeBound = true;
      summary.addEventListener('click', function (e) {
        if (e.target.closest && e.target.closest('.summary_title')) return;
        e.preventDefault();
      });
    });
  }

  // Stop summary clicks on the dropdown / Clear link from toggling the parent <details>.
  // For the <a> Clear link we ALSO need to drive navigation here, because
  // stopPropagation blocks bindLinkInterceptor from seeing the click.
  function bindSummaryExtras() {
    document.body.addEventListener('mousedown', function (e) {
      if (e.target.closest && e.target.closest('.summary_extras')) e.stopPropagation();
    }, true);
    document.body.addEventListener('click', function (e) {
      const extras = e.target.closest && e.target.closest('.summary_extras');
      if (!extras) return;
      e.stopPropagation();  // don't toggle the parent <details>
      const link = e.target.closest('a');
      if (link) {
        const href = link.getAttribute('href');
        if (href && href.charAt(0) === '?') {
          e.preventDefault();
          navigateTo(href);
        }
      }
    }, true);
  }

  // Compact grid mode — when on, the chord/scale grids skip empty (#_x_)
  // cells so each row reads as just the populated notes side by side.
  // Lives in the unified settings registry: URL `cmp=1` (omitted when
  // off) plus localStorage fallback.
  function compactGridsOn() { return getSetting('compact'); }
  function setCompactGrids(v) {
    setSetting('compact', !!v);
    if (window.SF_X) {
      renderChordGrid(window.SF_X);
      renderScaleGrid(window.SF_X);
      renderSummaryExtras(window.SF_X);   // refresh the icon's on/off state
      bindAutoSubmit();                   // re-bind change handlers on the
                                          // freshly rendered key pickers
    }
  }
  // (Hover-staff popover removed — pitch class without per-string octave
  // info wasn't useful for transcription. Always-visible Key Signatures
  // staves stay; see keySigStaffSvg above.)

  // Icon button for the section header — same shape as section_print/help.
  // Two SVGs: "stacked rows" when on (click spreads), "spread grid" when off
  // (click compacts). Lives inside summary_extras so the existing
  // bindSummaryExtras handler keeps clicks from toggling the parent <details>.
  function compactToggleHtml() {
    const on = compactGridsOn();
    const title = on ? 'Compact mode on — click to show empty cells'
                     : 'Compact mode off — click to hide empty cells';
    // |<-->|  – two outer bars with a horizontal double-headed arrow.
    // Same icon for both states; the on-state is signalled by the button's
    // accent-coloured background, not a different icon.
    const icon = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
              + '<rect x="1" y="3" width="2" height="10"/>'
              + '<rect x="13" y="3" width="2" height="10"/>'
              + '<rect x="4.5" y="7.4" width="7" height="1.2"/>'
              + '<polygon points="6,5 4,8 6,11"/>'
              + '<polygon points="10,5 12,8 10,11"/>'
              + '</svg>';
    return '<button type="button" class="section_compact' + (on ? ' section_compact_on' : '')
         + '" title="' + escAttr(title) + '" aria-label="' + escAttr(title)
         + '" aria-pressed="' + (on ? 'true' : 'false') + '">'
         + icon
         + '</button>';
  }
  function bindCompactToggles() {
    if (document.body._compactToggleBound) return;
    document.body._compactToggleBound = true;
    document.body.addEventListener('click', function (e) {
      const btn = e.target.closest && e.target.closest('.section_compact');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      setCompactGrids(!compactGridsOn());
    }, true);   // capture so it runs before bindSummaryExtras' stopPropagation
  }

  // Make every cell in a chord-grid / scale-grid row act as a click on
  // that row's chord/scale link. The leftmost + rightmost cells already
  // wrap the chord name in an <a>; this delegate handles clicks on the
  // interior note cells so the entire row is a target.
  function bindGridRowClicks() {
    if (document.body._gridRowBound) return;
    document.body._gridRowBound = true;
    document.body.addEventListener('click', function (e) {
      // Don't hijack clicks already on something interactive.
      if (e.target.closest('a, button, input, select, th')) return;
      const tr = e.target.closest && e.target.closest(
        '#chord_grid tbody tr, #scale_grid tbody tr, #chord_grid > tbody > tr, #scale_grid > tbody > tr'
      );
      if (!tr) return;
      // chord_grid / scale_grid have no thead/tbody wrapper — match any
      // tr that's a direct child of #chord_grid or #scale_grid.
      const a = tr.querySelector('a[href]');
      if (!a) return;
      a.click();
    });
  }

  function renderChordGrid(x) {
    const root = document.getElementById('chord_grid_root');
    const i1 = KEYS.indexOf(x.k);
    const noteLetters = {
      _1_:  KEYS[i1],     _b2_: KEYS[i1 + 1], _2_:  KEYS[i1 + 2], _b3_: KEYS[i1 + 3],
      _3_:  KEYS[i1 + 4], _4_:  KEYS[i1 + 5], _b5_: KEYS[i1 + 6], _5_:  KEYS[i1 + 7],
      _b6_: KEYS[i1 + 8], _6_:  KEYS[i1 + 9], _b7_: KEYS[i1 + 10], _7_: KEYS[i1 + 11]
    };

    // 12-column layout. Every extension folds back into its basic-octave
    // column (9 → 2, ♭13 → ♭6, ♯11 → ♭5, etc.) since they share a pitch
    // class. The label inside each cell still shows the chord's
    // theoretical degree — so an extension that has no basic equivalent
    // active in this chord still reads "9" or "♭13", just sitting in the
    // "2" or "♭6" column where it belongs harmonically.
    const DEG_COLS = ['_1_','_b2_','_2_','_b3_','_3_','_4_','_b5_','_5_','_b6_','_6_','_b7_','_7_'];

    function buildDegHeader(idAttr, opts) {
      const cornersOnly = opts && opts.cornersOnly;
      let s = '<tr' + (idAttr ? ' id="' + idAttr + '"' : '') + '>'
            + '<td class="cg_corner_label">Chords</td>';
      if (!cornersOnly) {
        DEG_COLS.forEach(function (degId, i) {
          const note = noteLetters[degId];
          s += '<td class="cg_deg_header" id="' + degId + '">'
             + '<span class="disp_note">' + escHtml(note) + '</span>'
             + '<span class="disp_deg">(' + escHtml(DEGREES[i]) + ')</span>'
             + '</td>';
        });
      }
      s += '<td class="cg_corner_label">Chords</td></tr>';
      return s;
    }

    const compact = compactGridsOn();
    let h = '<table id="chord_grid"' + (compact ? ' class="cg_compact"' : '') + '>';
    h += buildDegHeader('above_chord_grid', { cornersOnly: compact });
    let chordIdx = 0;
    for (const a in GRID) {
      const label = a.replace(/b/g, '♭').replace(/#/g, '♯');
      const chipDegs = fragToDegrees(GRID[a]);
      const isSelected = degSetsEqual(chipDegs, x.hl);
      // Selected → empty `hl=` so the merger explicitly clears s<n>_hl
      // (without it, an absent hl param would leave the section override
      // intact and the chip would stay highlighted).
      const href = isSelected ? (x._hilight_url + 'hl=') : (x._hilight_url + hlMultiToCsv(GRID[a]));
      const labelTdCls = 'cg_chord_label' + (isSelected ? ' cg_selected' : '');
      const tip = degsAndNotesTip(label, chipDegs, x.k, 'chord');
      const labelCell = '<td class="' + labelTdCls + '">'
                      + '<a href="' + href + '" title="' + escAttr(tip) + '">' + escHtml(label) + '</a>'
                      + '</td>';
      h += '<tr' + (isSelected ? ' class="cg_row_selected"' : '') + '>' + labelCell;

      // Bucket the chord's filled slots by basic degree column. SF_GRID_ROWS
      // lists extensions first (rows 0–11) and basic-octave last (rows 12–
      // 23); take the first non-null write per column so extension labels
      // win if both end up populated for the same pitch class.
      const cellsByDeg = {};
      for (const slot of window.SF_GRID_ROWS) {
        const v = slot.cells[chordIdx];
        if (v !== null && cellsByDeg[slot.degId] === undefined) {
          cellsByDeg[slot.degId] = v;
        }
      }

      for (const degId of DEG_COLS) {
        if (cellsByDeg[degId] !== undefined) {
          const note = noteLetters[degId];
          h += '<td id="' + degId + '">'
             + '<span class="disp_note">' + escHtml(note) + '</span>'
             + '<span class="disp_deg">(' + escHtml(cellsByDeg[degId]) + ')</span>'
             + '</td>';
        } else if (!compact) {
          h += '<td id="_x_"></td>';
        }
      }
      h += labelCell + '</tr>';
      chordIdx++;
    }
    h += buildDegHeader('under_chord_grid', { cornersOnly: compact });
    h += '</table>';
    root.innerHTML = h;
  }

  function renderScaleGrid(x) {
    const root = document.getElementById('scale_grid_root');
    if (!root) return;
    const i1 = KEYS.indexOf(x.k);
    const noteLetters = {
      _1_:  KEYS[i1],     _b2_: KEYS[i1 + 1], _2_:  KEYS[i1 + 2], _b3_: KEYS[i1 + 3],
      _3_:  KEYS[i1 + 4], _4_:  KEYS[i1 + 5], _b5_: KEYS[i1 + 6], _5_:  KEYS[i1 + 7],
      _b6_: KEYS[i1 + 8], _6_:  KEYS[i1 + 9], _b7_: KEYS[i1 + 10], _7_: KEYS[i1 + 11]
    };

    // Single-octave column order: 1, ♭2, 2, …, 7. The chord grid stacks an
    // octave on top of this; the scale grid sticks to the basic seven.
    const COLS = window.SF_GRID_ROWS.slice(12).reverse();

    // Parse SCALES["..."] = "&hl=1&hl=2&hl=b3..." into a Set of degree symbols
    const scaleDegrees = {};
    for (const name in SCALES) {
      const degs = SCALES[name].split('&hl=').slice(1)
        .map(function (s) { return s.replace(/&/g, ''); })
        .filter(function (s) { return s.length > 0; })
        .map(function (s) { return s.replace(/b/g, '♭'); });
      scaleDegrees[name] = degs;
    }

    function buildDegHeader(idAttr, opts) {
      const cornersOnly = opts && opts.cornersOnly;
      let s = '<tr' + (idAttr ? ' id="' + idAttr + '"' : '') + '>'
            + '<td class="cg_corner_label">Scales</td>';
      if (!cornersOnly) {
        for (const col of COLS) {
          const note = noteLetters[col.degId];
          s += '<td class="cg_deg_header" id="' + col.degId + '">'
             + '<span class="disp_note">' + escHtml(note) + '</span>'
             + '<span class="disp_deg">' + escHtml(col.intervalLabel) + '</span>'
             + '</td>';
        }
      }
      s += '<td class="cg_corner_label">Scales</td></tr>';
      return s;
    }

    // Display-label overrides for the long scale names so each row
    // fits in the leftmost column without wrapping.
    const SCALE_LABEL_OVERRIDES = {
      'Phrygian_Dominant': 'Phrygian Dom',
      'Lydian_Dominant':   'Lydian Dom',
      'Hungarian_Minor':   'Hungarian Min',
      'Bebop_Dominant':    'Bebop Dom',
      'Major_Pentatonic':  'maj pentatonic',
      'Minor_Pentatonic':  'min pentatonic'
    };
    const compact = compactGridsOn();
    let h = '<table id="scale_grid"' + (compact ? ' class="cg_compact"' : '') + '>';
    h += buildDegHeader('above_scale_grid', { cornersOnly: compact });
    for (const name in SCALES) {
      const label = SCALE_LABEL_OVERRIDES[name] || name.replace(/_/g, ' ');
      const chipDegs = fragToDegrees(SCALES[name]);
      const isSelected = degSetsEqual(chipDegs, x.hl);
      const href = isSelected ? (x._hilight_url + 'hl=') : (x._hilight_url + hlMultiToCsv(SCALES[name]));
      const labelTdCls = 'cg_chord_label' + (isSelected ? ' cg_selected' : '');
      const tip = degsAndNotesTip(label, chipDegs, x.k, 'scale');
      const labelCell = '<td class="' + labelTdCls + '">'
                      + '<a href="' + href + '" title="' + escAttr(tip) + '">' + escHtml(label) + '</a>'
                      + '</td>';
      h += '<tr' + (isSelected ? ' class="cg_row_selected"' : '') + '>' + labelCell;
      for (const col of COLS) {
        const degSym = col.intervalLabel.replace(/[()]/g, '');
        if (scaleDegrees[name].indexOf(degSym) !== -1) {
          const note = noteLetters[col.degId];
          h += '<td id="' + col.degId + '">'
             + '<span class="disp_note">' + escHtml(note) + '</span>'
             + '<span class="disp_deg">(' + escHtml(degSym) + ')</span>'
             + '</td>';
        } else if (!compact) {
          h += '<td id="_x_"></td>';
        }
      }
      h += labelCell + '</tr>';
    }
    h += buildDegHeader('under_scale_grid', { cornersOnly: compact });
    h += '</table>';
    root.innerHTML = h;
  }

  // Build a URL that switches the key to `k` while preserving every other
  // current param. Used by the Key Signatures table rows.
  function buildKeySetHref(k) {
    const p = new URLSearchParams(window.location.search);
    p.set('k', urlNote(k));
    const qs = canonicalQS(p);
    return qs ? '?' + qs : '?';
  }

  // Jazz hand-signal indicator: a CSS sprite of img/fingers-up.png (or
  // fingers-down.png for flats), each holding 5 hand panels side by side.
  // Counts 1–5 render a single panel; 6 renders 5+1 and 7 renders 5+2 to
  // mirror the real-world two-hand signal for those keys.
  function fingerSvg(count, direction) {
    if (count <= 0) return '';
    const dirCls = direction === 'down' ? 'ks_hand_down' : 'ks_hand_up';
    const hands = count <= 5 ? [count] : [5, count - 5];
    // The source sprite shows one hand orientation. When two hands are
    // rendered (6 / 7 keys), mirror the second hand horizontally so the
    // thumbs face each other — matches what the gesture looks like IRL.
    const html = hands
      .map(function (n, i) {
        const mirror = (i > 0) ? ' ks_hand_mirror' : '';
        return '<span class="ks_hand ' + dirCls + ' ks_hand_' + n + mirror + '"></span>';
      })
      .join('');
    return '<span class="ks_fingers">' + html + '</span>';
  }

  // Render a treble-clef staff with `count` sharps or flats laid out in
  // canonical order. Uses inline SVG for the staff lines + Unicode glyphs
  // (𝄞, ♯, ♭) for the clef and accidentals — the latter two render in
  // every modern OS without a custom font dependency.
  function keySigStaffSvg(count, direction) {
    const isFlat = direction === 'down';
    // Treble-clef staff y-positions (line spacing 6px). Lines 1–5 from
    // bottom to top. Spaces are halfway between adjacent lines.
    const LINE_5 = 8;   // F5 (top line)        SPACE_4 = 11   E5 (top space)
    const LINE_4 = 14;  // D5                   SPACE_3 = 17   C5
    const LINE_3 = 20;  // B4 (middle line)     SPACE_2 = 23   A4
    const LINE_2 = 26;  // G4                   SPACE_1 = 29   F4
    const LINE_1 = 32;  // E4 (bottom line)
    const ABOVE_5 = 5;  // G5 (above the staff)
    // Canonical sharp positions: F♯ C♯ G♯ D♯ A♯ E♯ B♯
    const SHARP_Y = [LINE_5, 17, ABOVE_5, LINE_4, 23, 11, LINE_3];
    // Canonical flat positions: B♭ E♭ A♭ D♭ G♭ C♭ F♭
    const FLAT_Y  = [LINE_3, 11, 23, LINE_4, LINE_2, 17, 29];
    const yList   = isFlat ? FLAT_Y : SHARP_Y;
    const symbol  = isFlat ? '♭' : '♯';

    const cleffW = 12;
    const accW   = 6;
    const padR   = 4;
    const totalW = cleffW + count * accW + padR;
    const totalH = 38;

    let s = '<svg class="ks_staff" viewBox="0 0 ' + totalW + ' ' + totalH
          + '" width="' + totalW + '" height="' + totalH + '" aria-hidden="true">';
    // 5 staff lines
    for (let i = 0; i < 5; i++) {
      const y = LINE_5 + i * 6;
      s += '<line x1="0" y1="' + y + '" x2="' + totalW + '" y2="' + y
        +  '" stroke="currentColor" stroke-width="0.7"/>';
    }
    // Treble clef glyph — relies on system music-symbol fonts. Worst case
    // it shows as a missing-glyph box but the staff + accidentals still
    // convey the key signature.
    s += '<text x="-1" y="' + (LINE_1 + 2)
      +  '" font-family="\'Noto Music\',\'Bravura\',\'Segoe UI Symbol\',\'Apple Symbols\',serif"'
      +  ' font-size="26" fill="currentColor">𝄞</text>';
    // Accidentals
    for (let i = 0; i < count; i++) {
      const yMid = yList[i];
      const x = cleffW + i * accW;
      // ♯ has its visual center near baseline-3, ♭ near baseline-2; nudge
      // the y so the glyph straddles the target staff position.
      const yText = isFlat ? yMid + 2 : yMid + 3.5;
      s += '<text x="' + x + '" y="' + yText
        +  '" font-size="10.5" fill="currentColor" font-family="serif">'
        +  symbol + '</text>';
    }
    s += '</svg>';
    return s;
  }

  function renderKeySignatures(x) {
    const root = document.getElementById('key_signatures_root');
    if (!root) return;
    // Build a single combined table: sharps top→bottom = C# (7♯) … C (0),
    // then flats top→bottom = F (1♭) … C♭ (7♭). C major sits in the
    // middle as the shared 0-accidental row.
    // Three of the FLAT-side rows share a setKey with their SHARP-side
    // enharmonic twin (B/C♭, F♯/G♭, C♯/D♭). We only want ONE row to
    // light up for the current key — sharps render first, so the sharp
    // row wins and the flat-side dupe stays unhighlighted.
    const _curKnorm = urlNote(x.k);
    const _seenActive = Object.create(null);
    // Colour-code the accidental notes by their natural letter (F C G D A E B)
    // — light, desaturated tints so the column reads clearer at a glance.
    function colorizeAccidentals(notes) {
      const s = String(notes || '').trim();
      if (!s || s === '—') return escHtml(s);
      return s.split(' ').filter(function (n) { return n.length; })
        .map(function (n) {
          const letter = n.charAt(0);
          return '<span class="ks_acc ks_acc_' + letter + '">' + escHtml(n) + '</span>';
        }).join(' ');
    }
    // Relative minor label for each major key — same key signature, root
    // on the 6th degree. Pre-tabulated so we get sharp-or-flat spelling
    // matching the major key's accidental style without round-tripping
    // through KEYS (which is sharp-only).
    const REL_MIN = {
      'C': 'Am',  'G': 'Em',  'D': 'Bm',  'A': 'F♯m', 'E': 'C♯m',
      'B': 'G♯m', 'F♯':'D♯m', 'C♯':'A♯m', 'F':'Dm',   'B♭':'Gm',
      'E♭':'Cm',  'A♭':'Fm',  'D♭':'B♭m', 'G♭':'E♭m', 'C♭':'A♭m'
    };
    function rowHtml(r, isFlat) {
      const setKnorm = urlNote(r.setKey);
      const matches  = (setKnorm === _curKnorm);
      const isCurrent = matches && !_seenActive[setKnorm];
      if (isCurrent) _seenActive[setKnorm] = true;
      const cls = 'ks_row' + (isCurrent ? ' ks_row_current' : '');
      const sig = r.count === 0
        ? '0'
        : r.count + (isFlat ? '♭' : '♯');
      const direction = isFlat ? 'down' : 'up';
      const staff = keySigStaffSvg(r.count, direction);
      const fingers = r.count > 0 ? fingerSvg(r.count, direction) : '';
      const href = escHtml(buildKeySetHref(r.setKey));
      const relMinor = REL_MIN[r.key] || '';
      let row = '<tr class="' + cls + '">';
      row += '<td class="ks_notes"><a href="' + href + '">' + colorizeAccidentals(r.notes) + '</a></td>';
      row += '<td class="ks_key"><a href="' + href + '">'
        +    escHtml(r.key) + ' <span class="ks_major">major</span>'
        +    (relMinor ? ' <span class="ks_relmin">/ ' + escHtml(relMinor) + '</span>' : '')
        +  '</a></td>';
      row += '<td class="ks_sig_count">' + escHtml(sig) + '</td>';
      row += '<td class="ks_sig_staff">' + staff + '</td>';
      row += '<td class="ks_sig_hand">'  + fingers + '</td>';
      row += '</tr>';
      return row;
    }
    let h = '<div class="ks_layout">';
    h +=   '<div class="ks_panel">';
    h +=     '<table class="ks_table"><tbody>';
    // Sharps reversed: most-sharps first, C major last (the 0-row).
    for (const r of KEY_SIGS_SHARP.slice().reverse()) h += rowHtml(r, false);
    // Flats in natural order: 1 flat first (F major) … 7 flats last (C♭).
    for (const r of KEY_SIGS_FLAT) h += rowHtml(r, true);
    h +=   '</tbody></table>';
    // Enharmonic equivalents — three pairs of keys that sound identical
    // but spell their accidentals differently. Helps explain why the
    // table has both B-major and C♭-major rows pointing to the same pitches.
    h +=   '<div class="ks_enharm">'
      +    '<strong>Enharmonic spellings</strong> — same pitches, different names: '
      +    'B = C♭ · F♯ = G♭ · C♯ = D♭. '
      +    'The simpler spelling (fewer accidentals) is preferred in practice.'
      +  '</div>';
    h +=   '</div>';
    // Right half: an interactive circle of fifths PLUS the "In <key>
    // major" cheat-sheet sitting directly below it. Each outer wedge
    // is a major key, each inner wedge is its relative minor — clicking
    // either applies that key (same href as the table on the left).
    h +=   '<div class="ks_side">';
    h +=     circleOfFifthsSvg(x);
    h +=     keyContainsHtml(x);
    h +=   '</div>';
    h += '</div>';
    root.innerHTML = h;
  }

  // "In <key> major" cheat-sheet — renders into the .ks_side panel
  // directly below the Circle of Fifths so they share the same column.
  function keyContainsHtml(x) {
    const notes = _majorScaleNotes(x.k);
    if (!notes.length) return '';
    const i1 = KEYS.indexOf(x.k);
    const relMinor = KEYS[(i1 + 9) % KEYS.length];
    const dominant = notes[4];
    const subdom   = notes[3];
    function keyHref(k) { return escHtml(buildKeySetHref(k)); }
    let h = '<div class="kx_block kx_contains kx_in_side">';
    h +=   '<h3 class="kx_block_title">In ' + escHtml(x.k) + ' major</h3>';
    h +=   '<dl class="kx_dl">';
    h +=     '<dt>Notes</dt><dd>' + notes.map(escHtml).join(' · ') + '</dd>';
    h +=     '<dt>Relative minor</dt><dd><a href="' + keyHref(relMinor) + '">' + escHtml(relMinor) + ' minor</a></dd>';
    h +=     '<dt>Parallel minor</dt><dd>' + escHtml(x.k) + ' minor (same root, lowered 3 6 7)</dd>';
    h +=     '<dt>Dominant key (V)</dt><dd><a href="' + keyHref(dominant) + '">' + escHtml(dominant) + ' major</a></dd>';
    h +=     '<dt>Subdominant key (IV)</dt><dd><a href="' + keyHref(subdom) + '">' + escHtml(subdom) + ' major</a></dd>';
    h +=   '</dl>';
    h += '</div>';
    return h;
  }

  // -------- Circle of Fifths (SVG) ---------------------------------------
  // 12 wedges, 30° each, top = C major / A minor, going clockwise through
  // the sharps (G, D, A, …) to the bottom (F♯/G♭) and then up through the
  // flats. Three positions show enharmonic spellings (B/C♭, F♯/G♭, C♯/D♭).
  // Chromatic semitone offsets keyed by the URL-encoded note name. Used
  // to compute degree labels relative to the currently selected key.
  const COF_SEMI = {
    'C': 0,  'Cs': 1, 'Db': 1, 'D': 2, 'Ds': 3, 'Eb': 3, 'E': 4, 'Fb': 4,
    'F': 5,  'Es': 5, 'Fs': 6, 'Gb': 6, 'G': 7, 'Gs': 8, 'Ab': 8, 'A': 9,
    'As': 10,'Bb': 10,'B': 11, 'Cb': 11,
  };
  // Roman-numeral scale degrees (major-scale frame) for the 12 chromatic
  // intervals from a chosen tonic.
  const COF_DEGREES = ['I','♭II','II','♭III','III','IV','♭V','V','♭VI','VI','♭VII','VII'];
  function circleOfFifthsSvg(x) {
    // [majorLabel, majorSetKey, minorLabel, minorSetKey, enharmonicMajor?, enharmonicMajorSetKey?]
    const POS = [
      ['C',  'C',  'Am',  'A'],                         //  0  top
      ['G',  'G',  'Em',  'E'],                         //  1
      ['D',  'D',  'Bm',  'B'],                         //  2
      ['A',  'A',  'F♯m', 'Fs'],                        //  3
      ['E',  'E',  'C♯m', 'Cs'],                        //  4
      ['B',  'B',  'G♯m', 'Gs', 'C♭', 'Cb'],            //  5
      ['F♯', 'Fs', 'D♯m', 'Ds', 'G♭', 'Gb'],            //  6  bottom
      ['C♯', 'Cs', 'A♯m', 'As', 'D♭', 'Db'],            //  7
      // The app's canonical KEYS list is sharp-only, so flat keys round-trip
      // through their sharp enharmonic on URL state (the key-sig table on
      // the left does the same — its B♭/E♭/A♭ rows have setKey A♯/D♯/G♯).
      // Use those same setKeys here so clicking the circle highlights the
      // matching row in the table.
      ['A♭', 'Gs', 'Fm',  'F'],                         //  8
      ['E♭', 'Ds', 'Cm',  'C'],                         //  9
      ['B♭', 'As', 'Gm',  'G'],                         // 10
      ['F',  'F',  'Dm',  'D'],                         // 11
    ];
    const SIZE  = 360;
    const CX    = SIZE / 2;
    const CY    = SIZE / 2;
    const R_OUT = 175;   // outer ring outer radius
    const R_MID = 120;   // outer ring inner radius / inner ring outer
    const R_IN  = 65;    // inner ring inner radius (centre hole edge)
    const R_HOLE= 35;    // empty centre circle visible radius
    const STROKE = '#5a5a5a';
    const FILL_MAJ = 'rgba(255,255,255,0.06)';
    const FILL_MIN = 'rgba(255,255,255,0.02)';

    function pt(r, deg) {
      const rad = (deg - 90) * Math.PI / 180;
      return [CX + r * Math.cos(rad), CY + r * Math.sin(rad)];
    }
    // Annular wedge path between rOuter / rInner from degStart → degEnd (clockwise).
    function wedgePath(rOuter, rInner, degStart, degEnd) {
      const [x1, y1] = pt(rOuter, degStart);
      const [x2, y2] = pt(rOuter, degEnd);
      const [x3, y3] = pt(rInner, degEnd);
      const [x4, y4] = pt(rInner, degStart);
      const large = (degEnd - degStart) > 180 ? 1 : 0;
      return 'M ' + x1.toFixed(2) + ' ' + y1.toFixed(2)
        +  ' A ' + rOuter + ' ' + rOuter + ' 0 ' + large + ' 1 ' + x2.toFixed(2) + ' ' + y2.toFixed(2)
        +  ' L ' + x3.toFixed(2) + ' ' + y3.toFixed(2)
        +  ' A ' + rInner + ' ' + rInner + ' 0 ' + large + ' 0 ' + x4.toFixed(2) + ' ' + y4.toFixed(2)
        +  ' Z';
    }

    let s = '<svg class="cof_svg" viewBox="0 0 ' + SIZE + ' ' + SIZE + '" xmlns="http://www.w3.org/2000/svg" aria-label="Circle of fifths">';

    // Highlighted current key — match against major OR minor setKey.
    const curK = urlNote(x.k);
    // Tonic semitone for degree labels. Falls back to 0 (C) if the
    // selected key isn't recognised (shouldn't happen in practice).
    const tonicSemi = COF_SEMI[curK] != null ? COF_SEMI[curK] : 0;

    for (let i = 0; i < 12; i++) {
      const slot     = POS[i];
      const majLabel = slot[0], majKey = slot[1];
      const minLabel = slot[2], minKey = slot[3];
      const enLabel  = slot[4], enKey  = slot[5];
      const a0 = i * 30 - 15;
      const a1 = i * 30 + 15;
      const labAng = i * 30;   // wedge centre

      // Major + relative minor share the same key signature so they sit
      // in the same wedge position. Highlight by major name only — if
      // we ALSO matched the minor name, picking "A" would light up both
      // position 3 (A major) AND position 0 (C major, whose relative
      // minor is Am), which is misleading. Major-only keeps it 1:1.
      const wedgeActive = (urlNote(majKey) === curK)
        || (enKey && urlNote(enKey) === curK);
      const majActive = wedgeActive;
      const minActive = wedgeActive;

      // Outer (major) wedge — wrapped in <a> so it's clickable.
      s += '<a class="cof_wedge cof_maj' + (majActive ? ' cof_active' : '') + '" href="'
        +  escHtml(buildKeySetHref(majKey)) + '">';
      s += '<path d="' + wedgePath(R_OUT, R_MID, a0, a1) + '" fill="' + (majActive ? 'rgba(95,232,224,0.22)' : FILL_MAJ)
        +  '" stroke="' + STROKE + '" stroke-width="1"/>';
      // Major label
      const [lx, ly] = pt((R_OUT + R_MID) / 2, labAng);
      s += '<text x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1) + '" class="cof_lab cof_lab_maj"'
        +  ' text-anchor="middle" dominant-baseline="central">' + escHtml(majLabel) + '</text>';
      // Enharmonic small label (e.g. C♭ next to B), tucked outward.
      if (enLabel) {
        const [ex, ey] = pt((R_OUT + R_MID) / 2 + 12, labAng + 7);
        s += '<text x="' + ex.toFixed(1) + '" y="' + ey.toFixed(1) + '" class="cof_lab cof_lab_enh"'
          +  ' text-anchor="middle" dominant-baseline="central">' + escHtml(enLabel) + '</text>';
      }
      s += '</a>';

      // Inner (minor) wedge — link to the wedge's MAJOR setKey so that
      // clicking the relative minor still highlights the same wedge
      // position. (Picking the minor's root would jump highlighting to
      // a different wedge whose major key shares that root.)
      s += '<a class="cof_wedge cof_min' + (minActive ? ' cof_active' : '') + '" href="'
        +  escHtml(buildKeySetHref(majKey)) + '">';
      s += '<path d="' + wedgePath(R_MID, R_IN, a0, a1) + '" fill="' + (minActive ? 'rgba(95,232,224,0.22)' : FILL_MIN)
        +  '" stroke="' + STROKE + '" stroke-width="1"/>';
      const [mx, my] = pt((R_MID + R_IN) / 2, labAng);
      s += '<text x="' + mx.toFixed(1) + '" y="' + my.toFixed(1) + '" class="cof_lab cof_lab_min"'
        +  ' text-anchor="middle" dominant-baseline="central">' + escHtml(minLabel) + '</text>';
      s += '</a>';
    }

    // Empty centre hole — draw a filled circle so the donut reads cleanly.
    s += '<circle cx="' + CX + '" cy="' + CY + '" r="' + R_HOLE + '" fill="var(--bg-elevated)" stroke="' + STROKE + '" stroke-width="1"/>';

    s += '</svg>';
    return s;
  }

  // ====================================================================
  // Music-theory teaching tools — diatonic chart, progressions, modes,
  // "this key contains", interval explorer, inversions, cadences. All
  // rooted in the current `x.k` (or section state when unlinked).
  // ====================================================================

  // Major-scale step pattern (semitones from root): 0,2,4,5,7,9,11.
  // Use to derive the 7 notes of any major key.
  const _MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];

  // Diatonic chord templates, expressed as the *scale-degree set*
  // (1..7, no accidentals — the major key signature handles those).
  // Triads first, 7ths second. Function: T = tonic, S = subdominant,
  // D = dominant — colour-coded in the chart.
  const _DIATONIC = [
    { roman: 'I',     romanLc: 'I',    quality: '',     q7: 'maj7', degs:  [1,3,5],   degs7: [1,3,5,7], fn: 'T' },
    { roman: 'ii',    romanLc: 'ii',   quality: 'm',    q7: 'm7',   degs:  [2,4,6],   degs7: [2,4,6,1], fn: 'S' },
    { roman: 'iii',   romanLc: 'iii',  quality: 'm',    q7: 'm7',   degs:  [3,5,7],   degs7: [3,5,7,2], fn: 'T' },
    { roman: 'IV',    romanLc: 'IV',   quality: '',     q7: 'maj7', degs:  [4,6,1],   degs7: [4,6,1,3], fn: 'S' },
    { roman: 'V',     romanLc: 'V',    quality: '',     q7: '7',    degs:  [5,7,2],   degs7: [5,7,2,4], fn: 'D' },
    { roman: 'vi',    romanLc: 'vi',   quality: 'm',    q7: 'm7',   degs:  [6,1,3],   degs7: [6,1,3,5], fn: 'T' },
    { roman: 'vii°',  romanLc: 'vii',  quality: '°',    q7: 'ø7',   degs:  [7,2,4],   degs7: [7,2,4,6], fn: 'D' },
  ];

  // ----- Custom progression builder ---------------------------------------
  // Palettes for the chord-mode dropdown. Each mode supplies the 7 diatonic
  // Roman numerals at its degrees; clicking a chip appends that Roman to
  // the user's progression. "custom" is special: it has no Roman palette,
  // and instead lets the user pick any (root, voicing) combination.
  const _PROG_MODES = {
    'major':      { label: 'Major',          romans: ['I',   'ii',  'iii',  'IV',     'V',  'vi',   'vii°'] },
    'minor':      { label: 'Natural Minor',  romans: ['i',   'ii°', '♭III', 'iv',     'v',  '♭VI',  '♭VII'] },
    'dorian':     { label: 'Dorian',         romans: ['i',   'ii',  '♭III', 'IV',     'v',  'vi°',  '♭VII'] },
    'phrygian':   { label: 'Phrygian',       romans: ['i',   '♭II', '♭III', 'iv',     'v°', '♭VI',  '♭vii'] },
    'lydian':     { label: 'Lydian',         romans: ['I',   'II',  'iii',  '♯iv°',   'V',  'vi',   'vii']  },
    'mixolydian': { label: 'Mixolydian',     romans: ['I',   'ii',  'iii°', 'IV',     'v',  'vi',   '♭VII'] },
    'harmonic':   { label: 'Harmonic Minor', romans: ['i',   'ii°', '♭III', 'iv',     'V',  '♭VI',  'vii°'] },
    'melodic':    { label: 'Melodic Minor',  romans: ['i',   'ii',  '♭III', 'IV',     'V',  'vi°',  'vii°'] },
    // ----- Style / vocabulary palettes (not single modes) -----
    // Country / secondary dominants — II major (V/V) and VI major (V/ii)
    // give the classic "Wagon Wheel" / bluegrass sound.
    'country':    { label: 'Country (sec. dom.)',
                                              romans: ['I',   'II',  'III',  'IV',     'V',  'VI',   '♭VII'] },
    // Modal mixture / borrowed chords — major key with the parallel
    // minor's ♭III, iv, ♭VI, ♭VII available for color.
    'mixture':    { label: 'Modal Mixture',  romans: ['I',   'ii',  '♭III', 'iv',     'V',  '♭VI',  '♭VII'] },
    // Mixolydian rock — I, ♭VII, IV is the Stones / Allman / Skynyrd
    // vocabulary. Listed against IVm and v for breadth.
    'mixo_pop':   { label: 'Mixolydian Rock',romans: ['I',   '♭VII','IV',   'V',      'vi',  'V',    'I']    },
    // Aeolian / minor pop — i, ♭VI, ♭VII opener (Linkin Park, modern
    // alt). Strict minor (no V; vii is the modal one).
    'aeolian':    { label: 'Aeolian Pop',    romans: ['i',   'iv',  '♭VI',  '♭VII',   'v',  '♭III', 'i']    },
    // Major pentatonic palette — only chords whose roots fall on
    // pent notes (1, 2, 3, 5, 6).
    'pent_maj':   { label: 'Pentatonic Major',
                                              romans: ['I',   'ii',  'iii',  'V',      'vi'] },
    // Minor pentatonic palette — roots on b3, 4, 5, b7 (plus i).
    'pent_min':   { label: 'Pentatonic Minor',
                                              romans: ['i',   '♭III','iv',   'v',      '♭VII'] },
    // ----- Style-specific ready-made progressions ------
    // The user requested three blues palettes side-by-side. Each is a
    // complete progression: clicking any chip simply appends to your
    // strip, so use them as starting templates.
    'blues_1':    { label: 'Blues (basic 7ths)',
                                              romans: ['I7',  '♭III7','IV7', 'V7',     '♭VII7'] },
    'blues_2':    { label: 'Blues (jump / swing)',
                                              romans: ['I9',  'ii',  'IV9',  'V9',     '♭VI9', 'VI7'] },
    'blues_3':    { label: 'Blues (jazz-blues)',
                                              romans: ['I6',  'ii',  'IV9',  'V7',     'VI7'] },
    // Jazz ii–V–I — the bedrock cadence in major. m7 / 9 / Maj7 voicings.
    'jazz_251':   { label: 'Jazz ii–V–I',     romans: ['ii7', 'V9',  'IMaj7','iiim7',  'VI7',  'iim7','V9'] },
    // Jazz minor ii–V–i — half-dim → dom7♭9 → minor tonic.
    'jazz_min251':{ label: 'Jazz ii°–V–i',    romans: ['iiø', 'V7♭9','im',   '♭VIMaj7','iiø',  'V7♭9','im'] },
    // Rhythm Changes — Gershwin "I Got Rhythm" turnarounds. The
    // A-section cycle is I VI7 iim7 V7 (×3) then III7 VI7 iim7 V7
    // for the variation. These five chips cover both halves of that
    // turnaround so the user can build either phrase by clicking.
    'rhythm':     { label: 'Rhythm Changes',  romans: ['I',   'VI7', 'iim7', 'V7',     'III7'] },
    // Bubblegum / 60s pop — I vi IV V is the doo-wop / bubblegum
    // backbone. Pair it with a IV I ii V turnaround for the cycle.
    // Five chips cover both phrases.
    'bubblegum':  { label: 'Bubblegum',       romans: ['I',   'vi',  'IV',   'V',      'ii'] },
  };
  // Order modes in the dropdown deliberately — most-used at the top.
  // 'custom' is intentionally NOT in this list: it's no longer a
  // selectable mode. The add-box ghost handles the "add an arbitrary
  // chord" path; editing any bar's note/voicing dropdown flips the
  // progression into custom format automatically (URL: pmode=custom).
  const _PROG_MODE_ORDER = [
    'major','minor','dorian','phrygian','lydian','mixolydian','harmonic','melodic',
    'country','mixture','mixo_pop','aeolian','pent_maj','pent_min',
    'blues_1','blues_2','blues_3',
    'jazz_251','jazz_min251','rhythm','bubblegum',
  ];

  // Curated voicings for Custom mode. Order = display priority. Each
  // entry maps a UI label to the suffix appended to the root (e.g.
  // root="C" + suffix="m7" → "Cm7"). Empty suffix = bare major triad.
  const _PROG_VOICINGS = [
    ['Maj',     ''],
    ['m',       'm'],
    ['7',       '7'],
    ['m7',      'm7'],
    ['Maj7',    'Maj7'],
    ['m-Maj7',  'min-Maj7'],
    ['dim',     'dim'],
    ['dim7',    'dim7'],
    ['m7♭5',    'm7b5'],
    ['aug',     'aug'],
    ['sus2',    'sus2'],
    ['sus4',    'sus4'],
    ['6',       'Maj6'],
    ['m6',      'min6'],
    ['9',       '9th'],
    ['m9',      'min9'],
    ['Maj9',    'Maj9'],
    ['add9',    'add9'],
    ['11',      '11th'],
    ['13',      '13th'],
  ];

  // Chromatic root list for Custom mode's note picker. Display form
  // (with ♯). Maps cleanly via NOTE_TO_PC → pitch class.
  const _PROG_ROOTS = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];

  // 12-position chromatic Romans (semitone offset from key tonic).
  // Used by Custom-mode bars' degree dropdown so the user can swap a
  // bar's root by picking a scale position relative to the page key,
  // rather than scrubbing through 12 note names.
  const _PROG_CHROMATIC_ROMANS = [
    'I','♭II','II','♭III','III','IV','♯IV','V','♭VI','VI','♭VII','VII'
  ];

  // Substitution suggestions per Roman numeral. Each entry is
  // [substituteRoman, why-it-works-blurb]. Click a suggestion in the
  // bar's ⋯ menu to swap the bar in place.
  const _PROG_SUBS = {
    'I':    [['IV',   'subdominant — moves harmony forward'],
             ['vi',   'relative minor — same key sig']],
    'ii':   [['IV',   'shares 2 tones with ii'],
             ['vi',   'shares 2 tones, darker colour']],
    'iii':  [['I',    'I in 1st inversion (3 in bass)'],
             ['vi',   'iii\'s relative — closely related']],
    'IV':   [['ii',   'ii shares 2 tones — substitute pre-dominant'],
             ['iv',   'borrowed minor IV (modal mixture)']],
    'V':    [['vii°', 'shares the leading-tone tritone'],
             ['♭VII', 'softer dominant alternative (Mixolydian)']],
    'vi':   [['I',    'I shares 2 tones with vi'],
             ['IV',   'subdominant of the relative key']],
    'vii°': [['V',    'V shares the same tritone'],
             ['♭II',  'tritone substitution']],
    '♭III': [['vi',   'parallel-major equivalent']],
    '♭VI':  [['IV',   'parallel-major equivalent']],
    '♭VII': [['V',    'parallel-major equivalent']],
    'iv':   [['IV',   'parallel-major version']],
    'v':    [['V',    'parallel-major version (stronger pull)']],
  };

  // Convert a display-form Roman ("♭VII", "vii°") to a URL-safe form
  // ("bVII", "viio") and back. Lets us round-trip the user's progression
  // through the address bar without percent-encoding hell.
  function _romanToUrl(r) {
    return String(r || '')
      .replace(/♭/g, 'b')
      .replace(/♯/g, 's')
      .replace(/°/g, 'o');
  }
  function _urlToRoman(s) {
    let r = String(s || '');
    if (r[0] === 'b')      r = '♭' + r.slice(1);
    else if (r[0] === 's') r = '♯' + r.slice(1);
    if (r.slice(-1) === 'o') r = r.slice(0, -1) + '°';
    return r;
  }
  // Absolute chord name → URL form (♯ → 's', ♭ → 'b' on the root letter).
  function _chordNameToUrl(n) {
    return String(n || '')
      .replace(/^([A-G])♯/, '$1s')
      .replace(/^([A-G])♭/, '$1b');
  }

  // Build a URL that replaces ?prog=… and (optionally) ?pmode=… with
  // the given list + mode. Empty list strips ?prog=. Mode 'major' is
  // the default and gets stripped too. Tokens are encoded per-format:
  // absolute chords URL-encode their accidentals, Romans use the
  // 'b'/'s'/'o' shorthand. Tokens of different formats coexist freely.
  function buildProgHref(tokens, pmode) {
    const p = new URLSearchParams(window.location.search);
    const mode = pmode || (window.SF_X && window.SF_X._pmode) || 'major';
    if (!tokens || !tokens.length) p.delete('prog');
    else {
      p.set('prog', tokens.map(function (t) {
        return /^[A-G]/.test(t) ? _chordNameToUrl(t) : _romanToUrl(t);
      }).join('.'));
    }
    if (mode && mode !== 'major') p.set('pmode', mode);
    else p.delete('pmode');
    // Any progression navigation (palette chip, ghost +, dropdown change,
    // input apply) should keep section_11 open. Strip 11 from c= and
    // set localStorage so applyCollapseFromUrl doesn't close it.
    const cParam = p.get('c');
    if (cParam) {
      const remaining = cParam.split(',').filter(function (s) { return s && s !== '11'; });
      if (remaining.length) p.set('c', remaining.join(','));
      else p.delete('c');
    }
    try { window.localStorage.setItem('sf_collapse_section_11', 'open'); } catch (_) {}
    const qs = canonicalQS(p);
    return qs ? '?' + qs : '?';
  }
  // Build a URL that switches the palette mode without touching prog.
  // Tokens stay put — they're per-format and can mix freely with any
  // mode. The palette content (chips) and mode-default qualities are
  // the only things that change.
  function buildPmodeHref(newMode) {
    const tokens = (window.SF_X && window.SF_X._prog) || [];
    return buildProgHref(tokens, newMode);
  }

  // 7 modes derived from the major scale — degree-relative set + the
  // *characteristic note* that distinguishes each mode from its modal
  // siblings. Highlighted separately when the user picks a mode.
  const _MODES = [
    { name: 'Ionian',     degs: [1,2,3,4,5,6,7],     bright: '',    char: '',     sig: '(major)'      },
    { name: 'Dorian',     degs: [1,2,'b3',4,5,6,'b7'],bright:'minor',char: '6',    sig: '♭3 ♭7'        },
    { name: 'Phrygian',   degs: [1,'b2','b3',4,5,'b6','b7'], bright:'minor', char: 'b2', sig: '♭2 ♭3 ♭6 ♭7' },
    // Lydian's "♯4" is enharmonically the same pitch class as ♭5 — and
    // the scale grid + parseState only accept the flat-side degree
    // alphabet (1-7, ♭). Store as b5 so the row matches.
    { name: 'Lydian',     degs: [1,2,3,'b5',5,6,7],  bright:'major',char: '♯4',   sig: '♯4'           },
    { name: 'Mixolydian', degs: [1,2,3,4,5,6,'b7'],  bright:'major',char: 'b7',   sig: '♭7'           },
    { name: 'Aeolian',    degs: [1,2,'b3',4,5,'b6','b7'], bright:'minor', char: '', sig: '♭3 ♭6 ♭7 (nat. minor)' },
    { name: 'Locrian',    degs: [1,'b2','b3',4,'b5','b6','b7'], bright:'minor', char: 'b5', sig: '♭2 ♭3 ♭5 ♭6 ♭7' },
  ];

  // Common chord progressions — sequences of Roman numerals over a
  // major-key context. Click a progression's ▶ to play the chords
  // sequentially with the synth (audio toggle must be on).
  const _PROGRESSIONS = [
    { name: 'I – IV – V',                 style: 'rock / blues',  romans: ['I','IV','V'] },
    { name: 'I – V – vi – IV',            style: 'pop',           romans: ['I','V','vi','IV'] },
    { name: 'ii – V – I',                 style: 'jazz',          romans: ['ii','V','I'] },
    { name: 'I – vi – IV – V',            style: '50s doo-wop',   romans: ['I','vi','IV','V'] },
    { name: 'vi – IV – I – V',            style: 'pop minor',     romans: ['vi','IV','I','V'] },
    { name: 'I – vi – ii – V',            style: 'jazz turnaround', romans: ['I','vi','ii','V'] },
    { name: 'I – ♭VII – IV',              style: 'rock (mixolydian)', romans: ['I','♭VII','IV'] },
    { name: '12-bar blues',               style: 'blues',         romans: ['I','I','I','I','IV','IV','I','I','V','IV','I','V'] },
  ];

  // Cadences — a small reference. Each is a 2-chord progression that
  // resolves a phrase. The user can audition each from the Key Signatures
  // section.
  const _CADENCES = [
    { name: 'Authentic',  desc: 'V → I — strong resolution',         romans: ['V','I']  },
    { name: 'Plagal',     desc: 'IV → I — "amen" cadence',           romans: ['IV','I'] },
    { name: 'Half',       desc: '? → V — pauses on the dominant',    romans: ['I','V']  },
    { name: 'Deceptive',  desc: 'V → vi — diverts away from tonic',  romans: ['V','vi'] },
  ];

  // ----- shared helpers --------------------------------------------------
  function _majorScaleNotes(key) {
    const i1 = KEYS.indexOf(key);
    if (i1 < 0) return [];
    return _MAJOR_STEPS.map(function (n) { return KEYS[i1 + n]; });
  }

  // Degree-symbol → semitone offset from root. Accepts both the display
  // form ("♭3") and the URL form ("b3"); 'b' and '♭' are interchangeable.
  const _DEG_TO_SEMI = (function () {
    const m = {};
    DEGREES.forEach(function (d, i) { m[d] = i; });
    ['1','b2','2','b3','3','4','b5','5','b6','6','b7','7'].forEach(function (d, i) { m[d] = i; });
    return m;
  })();

  function _semiStepLabel(s) {
    return s === 1 ? 'H' : s === 2 ? 'W' : s === 3 ? 'W+H' : s === 4 ? '2W' : (s + 'st');
  }

  // Walk a scale's degrees as semitone offsets and emit the W-H step
  // pattern (each step is between consecutive notes; a final wrap step
  // closes the octave, so a 7-note scale yields 7 steps).
  function _scaleStepPattern(degsArr) {
    const semis = degsArr.map(function (d) { return _DEG_TO_SEMI[d]; })
                         .filter(function (v) { return v != null; })
                         .sort(function (a, b) { return a - b; });
    if (semis.length < 2) return '';
    const steps = [];
    for (let i = 1; i < semis.length; i++) steps.push(_semiStepLabel(semis[i] - semis[i - 1]));
    steps.push(_semiStepLabel((semis[0] + 12) - semis[semis.length - 1]));
    return steps.join('-');
  }

  // Compact "1-3-5-♭7" formula from a degree set. Display form (♭ not b).
  function _formulaFromDegs(degsArr) {
    return degsArr.filter(Boolean).join('-');
  }

  // Pre-build pitch-class sets for every scale and chord in the data so
  // tooltip cross-references can do "scales containing chord X" / "chords
  // contained in scale Y" with a fast subset test on each render.
  function _pcSetFromFrag(frag) {
    const out = {};
    String(frag || '').split('&hl=').slice(1)
      .map(function (s) { return s.replace(/&.*$/, ''); })
      .forEach(function (d) {
        const sym = d.replace(/b/g, '♭');
        const off = _DEG_TO_SEMI[sym];
        if (off != null) out[off] = true;
      });
    return out;
  }
  const _SCALE_PCS = (function () {
    const m = {};
    for (const k in SCALES) m[k] = _pcSetFromFrag(SCALES[k]);
    return m;
  })();
  const _CHORD_PCS = (function () {
    const m = {};
    for (const k in GRID) m[k] = _pcSetFromFrag(GRID[k]);
    return m;
  })();
  function _pcSetFromDegs(degsArr) {
    const out = {};
    degsArr.forEach(function (d) {
      const off = _DEG_TO_SEMI[d];
      if (off != null) out[off] = true;
    });
    return out;
  }
  function _isSubset(small, big) {
    for (const k in small) if (!big[k]) return false;
    return true;
  }
  function _scalesContainingChord(degsArr) {
    const target = _pcSetFromDegs(degsArr);
    const hits = [];
    for (const name in _SCALE_PCS) {
      if (_isSubset(target, _SCALE_PCS[name])) hits.push(name.replace(/_/g, ' '));
    }
    return hits;
  }
  function _chordsInScale(degsArr) {
    const set = _pcSetFromDegs(degsArr);
    const hits = [];
    for (const name in _CHORD_PCS) {
      if (_isSubset(_CHORD_PCS[name], set)) hits.push(name);
    }
    return hits;
  }
  // Convert a degree list (1..7) into a comma-joined hl URL fragment.
  function _degsToHlCsv(degs) {
    return 'hl=' + degs.map(function (d) {
      return String(d).replace('♭', 'b').replace('♯', '#');
    }).join('');
  }
  // Play a list of MIDI numbers simultaneously (chord blip) and then
  // schedule the next chord after `gap` seconds. `chords` is an array
  // of arrays of MIDI numbers.
  function _playChordSequence(chords, gap) {
    if (!audioOn()) return;
    if (!chords || !chords.length) return;
    let t = 0;
    chords.forEach(function (notes) {
      setTimeout(function () {
        notes.forEach(function (m) { playMidi(m, gap * 0.95); });
      }, t * 1000);
      t += gap;
    });
  }
  // Resolve a Roman numeral within the current key to: chord name (e.g.
  // "Dm"), degree set, root note, root MIDI (octave 4 anchor for synth).
  // Supports ♭VII / ♭III / ♭VI for borrowed-mode progressions.
  function _resolveRoman(roman, key) {
    const notes = _majorScaleNotes(key);
    if (!notes.length) return null;
    // Major-scale degree intervals (semitones from root).
    const STEPS = _MAJOR_STEPS;
    // Accidental modifier on the leading edge of the roman: ♭ (or 'b'),
    // ♯ (or '#'). Sharp support is for modes like Lydian where the
    // raised-4 is a half-step above the natural 4 (♯iv°).
    let flat = false, sharp = false;
    let body = String(roman || '');
    if (body.indexOf('♭') === 0 || body.indexOf('b') === 0) { flat = true; body = body.slice(1); }
    else if (body.indexOf('♯') === 0 || body.indexOf('#') === 0) { sharp = true; body = body.slice(1); }
    // Greedy Roman match (VII before VI before V, etc.) plus an optional
    // ° / ø dim marker, plus an optional extension tail (7, 9, m, m7, …).
    const m = body.match(/^(VII|vii|VI|vi|V|v|IV|iv|III|iii|II|ii|I|i)([°ø])?(.*)$/);
    if (!m) return null;
    const baseRoman = m[1];
    const dimSym = m[2] || '';
    const tail = m[3] || '';
    const isMinor = baseRoman === baseRoman.toLowerCase();
    const isDim = !!dimSym;
    const ROMAN_NUM = { 'I':1,'II':2,'III':3,'IV':4,'V':5,'VI':6,'VII':7 };
    const num = ROMAN_NUM[baseRoman.toUpperCase()];
    if (!num) return null;
    let semi = STEPS[num - 1];
    if (flat)  semi = (semi - 1 + 12) % 12;
    if (sharp) semi = (semi + 1) % 12;
    const i1 = KEYS.indexOf(key);
    const root = KEYS[(i1 + semi) % KEYS.length] || notes[num - 1];
    // Determine the chord suffix:
    //   - Tail starting with an explicit quality (m / min / dim / °) wins
    //     so 'IIm' is unambiguously minor, 'IIdim' diminished, etc.
    //   - 'ø' (half-dim) implies m7♭5 — that's the jazz convention; bare
    //     'iiø' and 'iiø7' both resolve to m7b5.
    //   - 'vii°7' / 'vii°' diminished — the trailing 7 makes it the
    //     fully-diminished 7 (1, b3, b5, bb7=6).
    //   - Otherwise the case + ° symbol picks the base quality, and the
    //     tail is appended as an extension (e.g. 'I' + '7' → '7' suffix
    //     = dom7; 'i' + '7' → 'm7' suffix).
    let suffix;
    if (/^(m(?!aj)|min|dim)/i.test(tail)) {
      suffix = tail.replace(/^min/i, 'm').replace(/^dim/i, 'dim');
    } else if (dimSym === 'ø') {
      suffix = 'm7b5';
    } else if (isDim && tail === '7') {
      suffix = 'dim7';
    } else if (isDim && !tail) {
      suffix = 'dim';
    } else {
      let qual = '';
      if (isMinor) qual = 'm';
      suffix = qual + tail;
    }
    // For a clean diatonic match (no flat/sharp, no tail, no explicit dim),
    // pull the degree set from the diatonic template — that's the
    // canonical voicing the rest of the app expects. Match
    // case-SENSITIVELY so 'III' (which the user wrote major) does NOT
    // pick up the 'iii' template (which is minor); same for 'i' vs 'I'.
    const isPlainDiatonic = !flat && !sharp && !tail && !isDim;
    const dia = _DIATONIC.find(function (d) {
      return d.romanLc === baseRoman;
    });
    let degSet = [1, 3, 5];
    let name3 = root + suffix;
    let name7 = name3;
    if (dia && isPlainDiatonic) {
      degSet = dia.degs;
      name3  = root + dia.quality;
      name7  = root + dia.q7;
    } else {
      // Non-diatonic OR extended chord — pull degrees from the suffix
      // alias map / data.js grid so I7/I9/m7b5/etc. resolve correctly.
      const grid = (window.SF_DATA && window.SF_DATA.grid) || {};
      const aliased = _normalizeSuffix(suffix);
      const frag = grid[suffix] || grid[aliased];
      if (frag) {
        const arr = String(frag).split('&hl=').slice(1)
          .map(function (s) { return s.replace(/&.*$/, ''); })
          .filter(Boolean);
        // Convert "1", "b3", "5", "b7", etc. → numeric scale degrees
        // for the existing degSet pipeline (uses the same 1-7 numbering).
        const degMap = { '1':1,'b2':'b2','2':2,'b3':'b3','3':3,'4':4,'b5':'b5','5':5,'b6':'b6','6':6,'b7':'b7','7':7 };
        degSet = arr.map(function (d) { return degMap[d] != null ? degMap[d] : d; });
      }
      name7 = name3;
    }
    return { roman: roman, root: root, name: name3, name7: name7, degs: degSet, semitone: semi };
  }
  // Convert a chord (root + qualityFlag) to the MIDI notes for a
  // synth blip. Plays the triad in 4th-octave range (root ≥ 48).
  function _chordToMidi(rootName, intervals) {
    const ROOT_PC = { 'C':0,'C♯':1,'D':2,'D♯':3,'E':4,'F':5,'F♯':6,'G':7,'G♯':8,'A':9,'A♯':10,'B':11 };
    const pc = ROOT_PC[rootName];
    if (pc == null) return [];
    const baseMidi = 48 + pc;          // C4 = 60, anchor root around C3-B3
    return intervals.map(function (i) { return baseMidi + i; });
  }

  // ----- 1. Diatonic Chord Chart ----------------------------------------
  // A row of the 7 diatonic chords for the current key, colour-coded
  // by harmonic function (T / S / D). Triads by default; click "7ths"
  // pill to switch to 7th-chord versions.
  let _diatonic7th = false;
  function setDiatonic7th(v) {
    _diatonic7th = !!v;
    if (window.SF_X) {
      const xCG = stateForSection('section_3', window.SF_X);
      renderDiatonicChart(xCG);
    }
  }
  function renderDiatonicChart(x) {
    const root = document.getElementById('diatonic_root');
    if (!root) return;
    const notes = _majorScaleNotes(x.k);
    if (!notes.length) { root.innerHTML = ''; return; }
    const FUNC_LABEL = { T: 'tonic', S: 'subdominant', D: 'dominant' };
    let h = '<div class="dia_chart">';
    h +=   '<div class="dia_head">'
      +    '<span class="dia_title">Diatonic chords in ' + escHtml(x.k) + ' major</span>'
      +    '<button type="button" class="dia_toggle' + (_diatonic7th ? ' on' : '')
      +      '" data-dia-toggle title="Switch between triads and 7th chords">'
      +      (_diatonic7th ? '7ths' : 'Triads') + '</button>'
      +  '</div>';
    h += '<div class="dia_row">';
    _DIATONIC.forEach(function (d) {
      const root = notes[d.degs[0] - 1] || notes[(d.degs[0] - 1) % 7];
      const quality = _diatonic7th ? d.q7 : d.quality;
      const chordName = root + quality;
      const degs = _diatonic7th ? d.degs7 : d.degs;
      const href = x._hilight_url + _degsToHlCsv(degs);
      const fnLabel = FUNC_LABEL[d.fn];
      h += '<a class="dia_cell dia_fn_' + d.fn + '" href="' + escHtml(href)
        +  '" title="' + escAttr(d.roman + ' (' + fnLabel + ') — ' + chordName) + '">'
        +  '<span class="dia_roman">' + (_diatonic7th ? d.roman + (d.fn === 'D' && d.roman === 'V' ? '7' : (d.q7 === 'maj7' ? 'maj7' : d.q7 === 'ø7' ? 'ø7' : '7')) : d.roman) + '</span>'
        +  '<span class="dia_chord">' + escHtml(chordName) + '</span>'
        +  '<span class="dia_fn">' + d.fn + '</span>'
        +  '</a>';
    });
    h += '</div>';
    h +=   '<div class="dia_legend">'
      +    '<span class="dia_swatch dia_fn_T"></span>Tonic'
      +    '<span class="dia_swatch dia_fn_S"></span>Subdominant'
      +    '<span class="dia_swatch dia_fn_D"></span>Dominant'
      +    '<span class="dia_legend_sep"></span>'
      +    '<span class="dia_legend_rn"><strong>I</strong> = major triad</span>'
      +    '<span class="dia_legend_rn"><strong>i</strong> = minor triad</span>'
      +    '<span class="dia_legend_rn"><strong>°</strong> = diminished</span>'
      +  '</div>';
    h += '</div>';
    root.innerHTML = h;
  }

  // ----- 2. Progressions -------------------------------------------------
  // Bind diatonic toggle once. The chart re-renders on each applyState
  // so we delegate from document.body.
  if (!document.body._diaToggleBound) {
    document.body._diaToggleBound = true;
    document.addEventListener('click', function (e) {
      const btn = e.target.closest && e.target.closest('[data-dia-toggle]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      setDiatonic7th(!_diatonic7th);
    });
  }

  // Resolve a Roman to the triad MIDI list for synth playback.
  function _romanToMidi(roman, key) {
    const r = _resolveRoman(roman, key);
    if (!r) return [];
    // Translate the degree set _resolveRoman attached (numeric labels
    // like 1, 'b3', 5, 'b7' OR the diatonic-template numbers 1-7 from
    // a plain diatonic match) into chord-tone semitone offsets so the
    // synth plays the actual chord, not a triad fallback.
    const SCALE_DEG_SEMI = { 1:0, 2:2, 3:4, 4:5, 5:7, 6:9, 7:11 };
    const STR_DEG_SEMI = {
      '1':0,'b2':1,'♭2':1,'2':2,'b3':3,'♭3':3,'3':4,'4':5,
      'b5':6,'♭5':6,'5':7,'b6':8,'♭6':8,'6':9,'b7':10,'♭7':10,'7':11,
    };
    const intervals = [];
    (r.degs || []).forEach(function (d) {
      if (typeof d === 'number' && SCALE_DEG_SEMI[d] != null) intervals.push(SCALE_DEG_SEMI[d]);
      else if (STR_DEG_SEMI[d] != null) intervals.push(STR_DEG_SEMI[d]);
    });
    if (!intervals.length) intervals.push(0, 4, 7);   // safe fallback
    return _chordToMidi(r.root, intervals);
  }

  // Resolve a Custom-mode token (absolute chord name, e.g. "Cmaj7",
  // "C♯m", "Bb7sus4") into the same shape _resolveRoman returns:
  //   { root, suffix, name, degs (1-N like [1,3,5,b7]), pc }
  // Falls back to a major triad if the suffix isn't in our voicing list.
  // Many chord suffixes have multiple common spellings (m vs min, 7 vs
  // dom7, 9 vs 9th, …). The data.js grid keys are the long forms, but
  // user-facing labels + Roman extensions use the short ones. This map
  // bridges short → long so _resolveCustomChord can find the degree
  // set regardless of which spelling came in.
  const _SUFFIX_ALIASES = {
    '': 'Maj', 'maj': 'Maj', 'M': 'Maj',
    'm': 'min', 'mi': 'min', '-': 'min',
    '7': 'dom7', 'dom': 'dom7',
    'm7': 'min7', 'mi7': 'min7', 'min7': 'min7', '-7': 'min7',
    'maj7': 'Maj7', 'M7': 'Maj7', 'Δ7': 'Maj7', 'Δ': 'Maj7',
    'mMaj7': 'min-Maj7', 'm-maj7': 'min-Maj7', 'mΔ7': 'min-Maj7', 'min-maj7': 'min-Maj7',
    '6': 'Maj6', 'maj6': 'Maj6',
    'm6': 'min6', 'min6': 'min6',
    '9': '9th', 'dom9': '9th',
    'm9': 'min9', 'min9': 'min9',
    'maj9': 'Maj9', 'M9': 'Maj9',
    '11': '11th',
    'm11': 'min11', 'min11': 'min11',
    '13': '13th',
    'm13': 'min13', 'min13': 'min13',
    '°': 'dim', 'o': 'dim',
    '°7': 'dim7', 'o7': 'dim7',
    'ø': 'm7b5', 'ø7': 'm7b5', 'm7♭5': 'm7b5', 'm7b5': 'm7b5',
    '+': 'aug', 'aug7': 'aug7',
    '7♭5': '7b5', '7b5': '7b5',
    '7♯9': '7#9', '7#9': '7#9',
    '7♯11': '7#11', '7#11': '7#11',
    '7♭9': '7b9', '7b9': '7b9',
    '6/9': '6add9', '6add9': '6add9',
  };
  function _normalizeSuffix(suffix) {
    const s = String(suffix || '');
    if (_SUFFIX_ALIASES[s] !== undefined) return _SUFFIX_ALIASES[s];
    return s;
  }
  function _resolveCustomChord(token, currentKey) {
    const m = String(token || '').match(/^([A-G][♯♭]?)(.*)$/);
    if (!m) return null;
    const root = m[1];
    const rawSuffix = m[2] || '';
    const suffix = rawSuffix;     // keep the user's spelling for display
    const rootPc = NOTE_TO_PC[root];
    if (rootPc == null) return null;
    // Find the matching voicing (URL form). If unknown, treat as bare major.
    const voicing = _PROG_VOICINGS.find(function (v) { return v[1] === suffix; });
    const grid = (window.SF_DATA && window.SF_DATA.grid) || {};
    // Pull degree set from the grid (data.js values look like
    // "&hl=1&hl=3&hl=5&hl=b7" — fragToDegrees splits the right way).
    // Try both the user's spelling and a normalized alias before
    // falling back to a bare major triad.
    const aliased = _normalizeSuffix(suffix);
    const frag = grid[suffix] || grid[aliased] || grid['Maj'] || '&hl=1&hl=3&hl=5';
    const degsArr = String(frag).split('&hl=').slice(1)
      .map(function (s) { return s.replace(/&.*$/, '').replace(/b/g, '♭'); })
      .filter(Boolean);
    return {
      root: root,
      suffix: suffix,
      name: token,
      degs: degsArr,        // string degree labels: "1", "♭3", "5", etc.
      pc: rootPc,
      voicingLabel: voicing ? voicing[0] : suffix,
    };
  }
  // Compose an `&hl=…` href fragment from a set of degree labels for the
  // CURRENT key. Used by Custom-mode bars so clicking a bar still lights
  // the chord across the fretboard / keyboard. Falls through degsToHlCsv's
  // semantics — empty hl when the chord can't be resolved.
  function _customDegsToHl(custom, currentKey) {
    if (!custom) return 'hl=';
    // Convert the chord's degree labels (relative to the chord's root)
    // into degrees relative to the page's current key. Each chord-tone
    // pc = (rootPc + offset) % 12; degree-vs-key = (pc - keyPc + 12) % 12.
    const keyPc = NOTE_TO_PC[currentKey];
    if (keyPc == null) return 'hl=';
    const DEG_LBL = ['1','♭2','2','♭3','3','4','♭5','5','♭6','6','♭7','7'];
    const intervalMap = {
      '1': 0, '♭2':1, '2':2, '♭3':3, '3':4, '4':5,
      '♭5':6, '5':7, '♭6':8, '6':9, '♭7':10, '7':11,
    };
    const out = [];
    custom.degs.forEach(function (d) {
      const off = intervalMap[d];
      if (off == null) return;
      const pc = (custom.pc + off) % 12;
      const inKey = (pc - keyPc + 12) % 12;
      out.push(DEG_LBL[inKey].replace('♭', 'b'));
    });
    return 'hl=' + out.join('');
  }
  // MIDI list for a Custom-mode chord, for synth playback.
  function _customToMidi(custom) {
    if (!custom) return [];
    const intervalMap = {
      '1': 0, '♭2':1, '2':2, '♭3':3, '3':4, '4':5,
      '♭5':6, '5':7, '♭6':8, '6':9, '♭7':10, '7':11,
    };
    const intervals = custom.degs.map(function (d) { return intervalMap[d]; })
                                  .filter(function (v) { return v != null; });
    return _chordToMidi(custom.root, intervals);
  }

  function renderProgressions(x) {
    const root = document.getElementById('progressions_root');
    if (!root) return;
    if (!_majorScaleNotes(x.k).length) { root.innerHTML = ''; return; }
    const prog = Array.isArray(x._prog) ? x._prog : [];
    const tempo = +x._tempo || 100;
    const pmode = x._pmode || 'major';
    const modeData = _PROG_MODES[pmode] || _PROG_MODES['major'];

    // Per-token format detection. Tokens can mix freely:
    //   • leading [A-G] → absolute chord (Cmaj7, F♯m, …)
    //   • everything else → Roman (mode-relative)
    function tokenIsAbsolute(t) { return /^[A-G]/.test(String(t)); }
    function resolveToken(tok) {
      return tokenIsAbsolute(tok)
        ? _resolveCustomChord(tok, x.k)
        : _resolveRoman(tok, x.k);
    }

    // ----- Heading: input + ♯/♭ + mode + Play + Tempo, all on one
    // centered row. Apply removed; spacebar / Enter auto-apply.
    let h = '<div class="prog_panel">';
    // Centering by `margin: 0 auto` + `width: fit-content`. The
    // .prog_panel parent is a flex column, and `margin: auto` on a
    // flex item is the spec'd way to center on the cross axis — it
    // beats every align-items / justify-content rule in the cascade.
    h += '<div class="prog_input_row" style="display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:10px;width:fit-content;max-width:100%;margin:0 auto;">';
    h +=   '<span class="prog_input_label">Chord progression:</span>';
    const placeholder = 'I IV V  or  C Am F G  or  Cmaj7 Dm7 G7';
    h +=   '<input type="text" id="prog_input" class="prog_input"'
       +     ' placeholder="' + escHtml(placeholder) + '"'
       +     ' value="' + escHtml(prog.join(' ')) + '"'
       +     ' autocomplete="off" spellcheck="false" maxlength="120">';
    // Quick-insert buttons for the proper accidental glyphs. Click
    // either to drop ♯ or ♭ at the cursor in the input — keys for
    // these aren't on a standard keyboard.
    h +=   '<button type="button" class="prog_input_sym" data-sym="♯" title="Insert sharp">♯</button>';
    h +=   '<button type="button" class="prog_input_sym" data-sym="♭" title="Insert flat">♭</button>';
    h +=   '<span class="prog_input_sep" aria-hidden="true">/</span>';
    // Mode (palette) dropdown — moved into the input row per user
    // request, sits to the left of Play.
    h +=   '<select class="prog_mode_select" title="Palette source">';
    _PROG_MODE_ORDER.forEach(function (key) {
      const cfg = _PROG_MODES[key];
      const sel = (key === pmode) ? ' selected' : '';
      h += '<option value="' + escAttr(key) + '"' + sel + '>' + escHtml(cfg.label) + '</option>';
    });
    h +=   '</select>';
    h +=   '<button type="button" class="prog_play_btn"' + (prog.length ? '' : ' disabled')
       +     ' title="Play progression (audio toggle must be on)">▶ Play</button>';
    h +=   '<label class="prog_tempo_label">Tempo';
    h +=     '<input type="range" id="prog_tempo" min="40" max="200" step="2" value="' + tempo + '">';
    h +=     '<span class="prog_tempo_val">' + tempo + ' bpm</span>';
    h +=   '</label>';
    h += '</div>';   // .prog_input_row

    // ----- Palette body — sits ABOVE the strip per user request. The
    // mode dropdown in the input row selects which 7 diatonic Romans are
    // listed. Click a chip to append that Roman to the progression.
    h += '<div class="prog_palette" style="display:flex;flex-direction:column;align-items:center;gap:4px;">';
    h += '<div class="prog_palette_row" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:center;">';
    modeData.romans.forEach(function (roman) {
      const r = _resolveRoman(roman, x.k);
      const chordName = r ? r.name : '?';
      const appendHref = buildProgHref(prog.concat([roman]), pmode);
      h += '<a class="prog_palette_chip" href="' + escHtml(appendHref) + '"'
        +    ' title="' + escAttr('Add ' + roman + ' (' + chordName + ')') + '">'
        +    '<span class="prog_palette_roman">' + escHtml(roman) + '</span>'
        +    '<span class="prog_palette_name">' + escHtml(chordName) + '</span>'
        +  '</a>';
    });
    h += '</div>';
    h += '</div>';

    // ----- Strip of bars (the user's current progression) -------------
    h += '<div class="prog_strip" style="display:flex;flex-wrap:wrap;justify-content:center;gap:6px;">';
    prog.forEach(function (tok, idx) {
      const isAbs = tokenIsAbsolute(tok);
      const r = resolveToken(tok);
      const chordName = r ? r.name : '?';
      const removeHref = buildProgHref(prog.filter(function (_, i) { return i !== idx; }), pmode);
      // Highlight URL: clicking the bar lights up the chord across
      // the fretboard / keyboard. Absolute chords need re-projection
      // onto the page key's degree alphabet (so an Eb7 in the key
      // of C lights up b3, 5, b7, b2 — its chord tones in C-degree).
      const highlightHref = r
        ? (isAbs
            ? (x._hilight_url + _customDegsToHl(r, x.k))
            : (x._hilight_url + _degsToHlCsv(r.degs)))
        : '#';
      // Resolve the bar to a Custom-style chord so we can drive the
      // note + voicing dropdowns. Romans get normalized via
      // _resolveCustomChord on their resolved chord name.
      let cr;
      if (isAbs) {
        cr = r;
      } else if (r) {
        const normalized = (r.name || '').replace(/°/g, 'dim').replace(/ø7/g, 'm7b5');
        cr = _resolveCustomChord(normalized, x.k);
      }
      h += '<div class="prog_bar prog_bar_custom_layout"'
         +   ' draggable="true"'
         +   ' data-idx="' + idx + '" data-token="' + escAttr(tok) + '">';
      if (cr) {
        // Degree dropdown:
        //   Roman bar:    list the current mode's 7 diatonic Romans;
        //                 selected = current Roman. Pick another to
        //                 swap to that mode-degree.
        //   Absolute bar: list the 12 chromatic Romans relative to the
        //                 page key. Pick one to swap the bar's root
        //                 to that scale position; voicing preserved.
        if (!isAbs) {
          const inMode = modeData.romans.indexOf(tok) !== -1;
          h += '<select class="prog_bar_degree_select" data-idx="' + idx + '"'
             +   ' title="Change degree (within ' + escAttr(modeData.label) + ')">';
          if (!inMode) {
            // Roman doesn't fit current mode (e.g. user switched modes
            // after building). Surface it as the selected option so the
            // user can see what's there.
            h += '<option value="' + escAttr(tok) + '" selected>' + escHtml(tok) + '</option>';
          }
          modeData.romans.forEach(function (deg) {
            const sel = (inMode && deg === tok) ? ' selected' : '';
            h += '<option value="' + escAttr(deg) + '"' + sel + '>' + escHtml(deg) + '</option>';
          });
          h += '</select>';
        } else {
          // Absolute bar: chromatic Romans relative to the page key.
          const keyPc = NOTE_TO_PC[x.k];
          const rootPc = NOTE_TO_PC[cr.root];
          const curOffset = (keyPc != null && rootPc != null)
            ? ((rootPc - keyPc + 12) % 12) : -1;
          h += '<select class="prog_bar_degree_select" data-idx="' + idx + '"'
             +   ' title="Change degree (chromatic, relative to ' + escAttr(x.k) + ')">';
          _PROG_CHROMATIC_ROMANS.forEach(function (deg, i) {
            const sel = (i === curOffset) ? ' selected' : '';
            h += '<option value="' + escAttr(deg) + '"' + sel + '>' + escHtml(deg) + '</option>';
          });
          h += '</select>';
        }
        // Note + voicing on a single inline row beneath the degree.
        h += '<div class="prog_bar_chord_row">';
        h +=   '<select class="prog_bar_note_select prog_bar_inline_select" data-idx="' + idx + '"'
           +     ' title="Change note">';
        _PROG_ROOTS.forEach(function (n) {
          const sel = (n === cr.root) ? ' selected' : '';
          h += '<option value="' + escAttr(n) + '"' + sel + '>' + escHtml(n) + '</option>';
        });
        h +=   '</select>';
        h +=   '<select class="prog_bar_voicing_select prog_bar_inline_select" data-idx="' + idx + '"'
           +     ' title="Change voicing">';
        _PROG_VOICINGS.forEach(function (v) {
          const sel = (v[1] === cr.suffix) ? ' selected' : '';
          h += '<option value="' + escAttr(v[1]) + '"' + sel + '>' + escHtml(v[0]) + '</option>';
        });
        h +=   '</select>';
        h += '</div>';
      } else {
        h +=   '<span class="prog_bar_roman">' + escHtml(tok) + '</span>';
        h +=   '<span class="prog_bar_chord">' + escHtml(chordName) + '</span>';
      }
      // Bar menu — replaces the old "Try instead" subs popup. Single
      // option for now: highlight the chord on the fretboard / keyboard.
      h += '<button type="button" class="prog_bar_menu" title="Bar actions" aria-label="Actions">⋯</button>';
      h += '<div class="prog_bar_menu_pop" hidden>';
      h +=   '<a class="prog_bar_menu_item" href="' + escHtml(highlightHref) + '">'
         +     'Highlight on fretboard / keyboard'
         +   '</a>';
      h += '</div>';
      h +=   '<a class="prog_bar_remove" href="' + escHtml(removeHref) + '"'
         +     ' title="Remove this bar" aria-label="Remove">×</a>';
      h += '</div>';
    });
    // Ghost "add" bar — always present at the end of the strip. × glyph
    // when empty (start indicator), + once at least one bar exists.
    // Click adds an ABSOLUTE chord (current key + bare Maj triad) — so
    // the new bar is fully editable via its dropdowns. Romans for the
    // diatonic palette are still added by clicking the chips below.
    const addToken = (x.k || 'C');
    const addHref = buildProgHref(prog.concat([addToken]), pmode);
    const glyph = '+';
    h += '<a class="prog_bar_add" href="' + escHtml(addHref) + '"'
       +   ' title="Add a chord (' + escAttr(addToken) + ')">'
       +   '<span class="prog_bar_add_glyph">' + glyph + '</span>'
       + '</a>';
    h += '</div>';

    // (Mode dropdown + Play + Tempo are now part of .prog_input_row above;
    //  palette moved above the strip per user request.)

    h += '</div>';   // .prog_panel
    root.innerHTML = h;

    // Mirror a Clear pill into the section header's .section_actions
    // (right next to Print) — easier to reach than down in the form,
    // and visually consistent with how other sections expose top-level
    // actions. Always present (even when prog is empty) so it's a
    // predictable place to reset progression state. Clears prog,
    // pmode, and tempo — site-header Clear stays focused on hl + pk.
    const sectionActions = document.querySelector('#section_11 .section_actions');
    if (sectionActions) {
      const old = sectionActions.querySelector('.prog_clear_link');
      if (old) old.remove();
      const clearA = document.createElement('a');
      clearA.className = 'prog_clear_link section_clear_pill';
      // Build a URL that drops only the progression-related params.
      const _pClear = new URLSearchParams(window.location.search);
      _pClear.delete('prog');
      _pClear.delete('pmode');
      _pClear.delete('tempo');
      const _qsClear = canonicalQS(_pClear);
      clearA.href = _qsClear ? '?' + _qsClear : '?';
      clearA.title = 'Clear progression (does not affect the rest of the page)';
      clearA.textContent = 'Clear';
      if (!prog.length) {
        clearA.classList.add('prog_clear_link_idle');
        clearA.title = 'Nothing to clear';
      }
      const printBtn = sectionActions.querySelector('.section_print');
      if (printBtn) sectionActions.insertBefore(clearA, printBtn);
      else sectionActions.prepend(clearA);
    }

    // Wire delegated handlers once.
    if (root._progBound) return;
    root._progBound = true;

    // Drag-and-drop reordering of bars in the strip. HTML5 drag API:
    // dragstart records the source index, dragover marks the drop
    // target with a class hint (left/right edge), drop reorders the
    // prog array and navigates. The dropdowns inside each bar still
    // function — drag only initiates after a real mouse-drag gesture.
    let _progDragSrc = -1;
    root.addEventListener('dragstart', function (e) {
      const bar = e.target.closest && e.target.closest('.prog_bar');
      if (!bar) return;
      _progDragSrc = parseInt(bar.getAttribute('data-idx') || '-1', 10);
      bar.classList.add('prog_bar_dragging');
      try {
        e.dataTransfer.effectAllowed = 'move';
        // Required for Firefox to actually start the drag.
        e.dataTransfer.setData('text/plain', String(_progDragSrc));
      } catch (_) {}
    });
    root.addEventListener('dragend', function (e) {
      const bar = e.target.closest && e.target.closest('.prog_bar');
      if (bar) bar.classList.remove('prog_bar_dragging');
      root.querySelectorAll('.prog_bar_drop_before, .prog_bar_drop_after')
        .forEach(function (el) {
          el.classList.remove('prog_bar_drop_before');
          el.classList.remove('prog_bar_drop_after');
        });
      _progDragSrc = -1;
    });
    root.addEventListener('dragover', function (e) {
      const bar = e.target.closest && e.target.closest('.prog_bar');
      if (!bar) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
      const rect = bar.getBoundingClientRect();
      const before = (e.clientX - rect.left) < rect.width / 2;
      root.querySelectorAll('.prog_bar_drop_before, .prog_bar_drop_after')
        .forEach(function (el) {
          el.classList.remove('prog_bar_drop_before');
          el.classList.remove('prog_bar_drop_after');
        });
      bar.classList.add(before ? 'prog_bar_drop_before' : 'prog_bar_drop_after');
    });
    root.addEventListener('drop', function (e) {
      const bar = e.target.closest && e.target.closest('.prog_bar');
      if (!bar || _progDragSrc < 0) return;
      e.preventDefault();
      const dstIdx = parseInt(bar.getAttribute('data-idx') || '-1', 10);
      const rect = bar.getBoundingClientRect();
      const before = (e.clientX - rect.left) < rect.width / 2;
      const xCur = window.SF_X;
      const cur = (xCur && Array.isArray(xCur._prog)) ? xCur._prog.slice() : [];
      const src = _progDragSrc;
      _progDragSrc = -1;
      if (src < 0 || src >= cur.length) return;
      let dst = dstIdx + (before ? 0 : 1);
      // Removing src first shifts indices left for any dst > src.
      const moved = cur.splice(src, 1)[0];
      if (src < dst) dst -= 1;
      if (dst < 0) dst = 0;
      if (dst > cur.length) dst = cur.length;
      if (dst === src) {
        // No-op move; refresh just the visual class without navigating.
        return;
      }
      cur.splice(dst, 0, moved);
      navigateTo(buildProgHref(cur, (xCur && xCur._pmode) || 'major'));
    });

    // Click delegate for buttons + the apply / custom-add flow.
    root.addEventListener('click', function (e) {
      // ♯ / ♭ insertion buttons: drop the symbol at the input's caret.
      const symBtn = e.target.closest && e.target.closest('.prog_input_sym');
      if (symBtn) {
        e.preventDefault();
        e.stopPropagation();
        const inp = root.querySelector('#prog_input');
        if (!inp) return;
        const sym = symBtn.getAttribute('data-sym') || '';
        const start = (typeof inp.selectionStart === 'number') ? inp.selectionStart : inp.value.length;
        const end   = (typeof inp.selectionEnd   === 'number') ? inp.selectionEnd   : inp.value.length;
        inp.value = inp.value.slice(0, start) + sym + inp.value.slice(end);
        inp.focus();
        const newPos = start + sym.length;
        try { inp.setSelectionRange(newPos, newPos); } catch (_) {}
        return;
      }
      // ⋯ button → toggle the per-bar action menu (currently a single
      // "Highlight" item). Closes any other open menus first.
      const menuBtn = e.target.closest && e.target.closest('.prog_bar_menu');
      if (menuBtn) {
        e.preventDefault();
        e.stopPropagation();
        const bar = menuBtn.closest('.prog_bar');
        const menu = bar && bar.querySelector('.prog_bar_menu_pop');
        if (!menu) return;
        root.querySelectorAll('.prog_bar_menu_pop').forEach(function (m) {
          if (m !== menu) m.hidden = true;
        });
        menu.hidden = !menu.hidden;
        return;
      }
      // ▶ play current progression.
      const playBtn = e.target.closest && e.target.closest('.prog_play_btn');
      if (playBtn && !playBtn.disabled) {
        e.preventDefault();
        e.stopPropagation();
        const xCur = window.SF_X;
        if (!xCur) return;
        const curProg = Array.isArray(xCur._prog) ? xCur._prog : [];
        if (!curProg.length) return;
        const beat = 60 / (+xCur._tempo || 100);   // seconds per beat
        // Each token plays via its own resolver (Roman or absolute).
        const chords = curProg.map(function (tok) {
          if (/^[A-G]/.test(tok)) {
            return _customToMidi(_resolveCustomChord(tok, xCur.k));
          }
          return _romanToMidi(tok, xCur.k);
        });
        _playChordSequence(chords, beat);
        return;
      }
    });

    // Mode dropdown + per-bar dropdowns navigate on change. Use 'change'
    // so navigation fires only when a selection is committed.
    root.addEventListener('change', function (e) {
      const modeSel = e.target && e.target.closest && e.target.closest('.prog_mode_select');
      if (modeSel) {
        navigateTo(buildPmodeHref(modeSel.value));
        return;
      }
      // Convert a Roman token to its absolute chord name (for swapping
      // root / suffix on a bar that started life as a Roman). Absolute
      // tokens pass through unchanged.
      function _toAbsolute(t, key) {
        if (/^[A-G]/.test(t)) return t;
        const rr = _resolveRoman(t, key);
        if (!rr) return t;
        return (rr.name || t).replace(/°/g, 'dim').replace(/ø7/g, 'm7b5');
      }
      const voiceSel = e.target && e.target.closest && e.target.closest('.prog_bar_voicing_select');
      if (voiceSel) {
        const xCur = window.SF_X;
        if (!xCur) return;
        const idx = parseInt(voiceSel.getAttribute('data-idx') || '-1', 10);
        const curProg = Array.isArray(xCur._prog) ? xCur._prog.slice() : [];
        if (idx < 0 || idx >= curProg.length) return;
        // This bar becomes absolute; siblings stay as-is.
        const absToken = _toAbsolute(curProg[idx], xCur.k);
        const m = String(absToken).match(/^([A-G][♯♭]?)(.*)$/);
        if (!m) return;
        curProg[idx] = m[1] + voiceSel.value;
        navigateTo(buildProgHref(curProg, xCur._pmode));
        return;
      }
      const noteSel = e.target && e.target.closest && e.target.closest('.prog_bar_note_select');
      if (noteSel) {
        const xCur = window.SF_X;
        if (!xCur) return;
        const idx = parseInt(noteSel.getAttribute('data-idx') || '-1', 10);
        const curProg = Array.isArray(xCur._prog) ? xCur._prog.slice() : [];
        if (idx < 0 || idx >= curProg.length) return;
        const absToken = _toAbsolute(curProg[idx], xCur.k);
        const m = String(absToken).match(/^([A-G][♯♭]?)(.*)$/);
        if (!m) return;
        curProg[idx] = noteSel.value + (m[2] || '');
        navigateTo(buildProgHref(curProg, xCur._pmode));
        return;
      }
      // Degree dropdown — behaves per token:
      //   Roman bar: swap to the selected mode-degree (stays Roman).
      //   Absolute bar: swap root to the selected chromatic scale
      //                 position (relative to the page key); voicing
      //                 suffix preserved.
      const degSel = e.target && e.target.closest && e.target.closest('.prog_bar_degree_select');
      if (degSel) {
        const xCur = window.SF_X;
        if (!xCur) return;
        const idx = parseInt(degSel.getAttribute('data-idx') || '-1', 10);
        const curProg = Array.isArray(xCur._prog) ? xCur._prog.slice() : [];
        if (idx < 0 || idx >= curProg.length) return;
        const isAbs = /^[A-G]/.test(String(curProg[idx]));
        if (isAbs) {
          const offset = _PROG_CHROMATIC_ROMANS.indexOf(degSel.value);
          if (offset < 0) return;
          const keyPc = NOTE_TO_PC[xCur.k];
          if (keyPc == null) return;
          const newRoot = PC_TO_NOTE[(keyPc + offset) % 12];
          const m = String(curProg[idx]).match(/^([A-G][♯♭]?)(.*)$/);
          const suffix = m ? (m[2] || '') : '';
          curProg[idx] = newRoot + suffix;
        } else {
          // Roman bar — value from dropdown is a Roman token.
          curProg[idx] = degSel.value;
        }
        navigateTo(buildProgHref(curProg, xCur._pmode));
        return;
      }
    });

    // Apply the current input value: parse tokens and navigate. Each
    // token may be an absolute chord ('Cmaj7') or a Roman ('I', 'bIII').
    // Triggered automatically by Enter or spacebar — the explicit
    // Apply button is gone.
    function applyProgInput() {
      const inp = root.querySelector('#prog_input');
      if (!inp) return;
      const xCur = window.SF_X;
      const curMode = (xCur && xCur._pmode) || 'major';
      const raw = String(inp.value || '').split(/[\s,.\-_;|/]+/)
        .map(function (t) { return t.trim(); }).filter(Boolean);
      // A token is valid if either:
      //   - it starts with a note letter (absolute chord, parses through
      //     _resolveCustomChord), OR
      //   - _resolveRoman accepts it as a Roman with optional ° / ø dim
      //     and an extension tail (7, 9, 11, 13, m, m7, Maj7, etc.).
      const _curKey = (xCur && xCur.k) || 'C';
      const tokens = raw.map(function (t) {
        if (/^[A-G]/.test(t)) {
          const m = t.match(/^([A-G])([sb#♯♭])?(.*)$/);
          if (!m) return null;
          const letter = m[1];
          const acc = m[2];
          const suffix = m[3] || '';
          let root = letter;
          if (acc === 's' || acc === '#' || acc === '♯') root = letter + '♯';
          else if (acc === 'b' || acc === '♭')           root = letter + '♭';
          return root + suffix;
        }
        const norm = _urlToRoman(t);
        return _resolveRoman(norm, _curKey) ? norm : null;
      }).filter(Boolean).slice(0, 24);
      navigateTo(buildProgHref(tokens, curMode));
      // Refocus the new input so spacebar auto-apply doesn't lose
      // focus on every keystroke. Also ensure the value ends in a
      // space — without it, the next chord the user types runs into
      // the previous token (e.g. typing "F" after "C" produces "CF",
      // which parses as one absolute chord and clobbers the
      // progression).
      const newInp = document.querySelector('#prog_input');
      if (newInp) {
        if (!/\s$/.test(newInp.value)) newInp.value += ' ';
        newInp.focus();
        const len = newInp.value.length;
        try { newInp.setSelectionRange(len, len); } catch (_) {}
      }
    }
    // Enter on the input commits. Spacebar also commits — completed
    // tokens auto-apply as the user types. Use keyup for space so the
    // just-typed character is in the value before we parse.
    root.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      const inp = e.target && e.target.closest && e.target.closest('#prog_input');
      if (!inp) return;
      e.preventDefault();
      applyProgInput();
    });
    root.addEventListener('keyup', function (e) {
      if (e.key !== ' ' && e.code !== 'Space') return;
      const inp = e.target && e.target.closest && e.target.closest('#prog_input');
      if (!inp) return;
      applyProgInput();
    });

    // Tempo slider — replaceState only (no navigate / re-render needed).
    root.addEventListener('input', function (e) {
      const inp = e.target && e.target.id === 'prog_tempo' ? e.target : null;
      if (!inp) return;
      const v = parseInt(inp.value || '100', 10);
      if (!(v >= 40 && v <= 240)) return;
      const lbl = root.querySelector('.prog_tempo_val');
      if (lbl) lbl.textContent = v + ' bpm';
      const params = new URLSearchParams(window.location.search);
      if (v === 100) params.delete('tempo');
      else           params.set('tempo', String(v));
      const qs = canonicalQS(params);
      history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
      if (window.SF_X) window.SF_X._tempo = v;
    });
  }

  // ----- 3. Modes Visualizer --------------------------------------------
  function renderModes(x) {
    const root = document.getElementById('modes_root');
    if (!root) return;
    const notes = _majorScaleNotes(x.k);
    if (!notes.length) { root.innerHTML = ''; return; }
    let h = '<div class="modes_panel">';
    h += '<div class="modes_intro">'
      +  'All 7 modes share the notes of <strong>' + escHtml(x.k) + ' major</strong> '
      +  '— only the tonal centre changes. Each mode\'s interval signature '
      +  '(vs. major) gives it its sound.'
      +  '</div>';
    h += '<div class="modes_grid">';
    _MODES.forEach(function (m, i) {
      const modeRoot = notes[i];
      const href = x._hilight_url + _degsToHlCsv(m.degs);
      const sigLabel = m.sig || '';
      h += '<a class="mode_cell mode_' + m.bright + '" href="' + escHtml(href)
        +  '" title="' + escAttr(modeRoot + ' ' + m.name + ' — parent: ' + x.k + ' major'
              + (sigLabel ? ' • vs major: ' + sigLabel : '')
              + (m.char ? ' • characteristic: ' + m.char : '')) + '">'
        +  '<span class="mode_root">' + escHtml(modeRoot) + '</span>'
        +  '<span class="mode_name">' + escHtml(m.name) + '</span>'
        +  '<span class="mode_sig">' + escHtml(sigLabel || '·') + '</span>'
        +  '<span class="mode_char">' + (m.char ? 'char: ' + escHtml(m.char) : '') + '</span>'
        +  '</a>';
    });
    h += '</div></div>';
    root.innerHTML = h;
  }

  // ----- 4. "This key contains" cheat sheet -----------------------------
  // ----- 5. Interval explorer (tier 2) ----------------------------------
  // ----- 7. Cadence reference (tier 2) ----------------------------------
  function renderKeyExtras(x) {
    const root = document.getElementById('key_extras_root');
    if (!root) return;
    if (!_majorScaleNotes(x.k).length) { root.innerHTML = ''; return; }
    const notes = _majorScaleNotes(x.k);
    const i1 = KEYS.indexOf(x.k);
    const relMinor = KEYS[(i1 + 9) % KEYS.length];   // 6th degree
    const parMinor = x.k;                             // same root, minor
    const dominant = notes[4];                        // 5th degree
    const subdom   = notes[3];                        // 4th degree
    function keyHref(k) { return escHtml(buildKeySetHref(k)); }

    let h = '<div class="kx_panel">';

    // ----- LEFT column (sits under the accidentals table) -----
    h +=   '<div class="kx_block kx_intervals">';
    h +=     '<h3 class="kx_block_title">Intervals from ' + escHtml(x.k) + '</h3>';
    h +=     '<table class="kx_intv_table">';
    const INTERVALS = [
      ['P1','Perfect unison'], ['m2','Minor 2nd'], ['M2','Major 2nd'],
      ['m3','Minor 3rd'],      ['M3','Major 3rd'], ['P4','Perfect 4th'],
      ['TT','Tritone'],        ['P5','Perfect 5th'],['m6','Minor 6th'],
      ['M6','Major 6th'],      ['m7','Minor 7th'], ['M7','Major 7th'],
    ];
    INTERVALS.forEach(function (iv, semi) {
      const note = KEYS[(i1 + semi) % KEYS.length];
      h += '<tr><td class="kx_intv_short">' + escHtml(iv[0]) + '</td>'
        +  '<td class="kx_intv_long">' + escHtml(iv[1]) + '</td>'
        +  '<td class="kx_intv_semi">' + semi + ' st</td>'
        +  '<td class="kx_intv_note">' + escHtml(note || '–') + '</td></tr>';
    });
    h +=     '</table>';
    h +=   '</div>';

    // ----- RIGHT column (sits under the circle of fifths) -----
    // 7. Cadences
    h +=   '<div class="kx_block kx_cadences">';
    h +=     '<h3 class="kx_block_title">Cadences</h3>';
    h +=     '<ul class="kx_cad_list">';
    _CADENCES.forEach(function (c, idx) {
      const chordChips = c.romans.map(function (rn) {
        const r = _resolveRoman(rn, x.k);
        return r ? '<span class="kx_cad_chip" title="' + escAttr(rn + ' = ' + r.name) + '">'
                  +  '<span class="kx_cad_roman">' + escHtml(rn) + '</span>'
                  +  '<span class="kx_cad_name">' + escHtml(r.name) + '</span>'
                  +  '</span>'
                : '';
      }).join('<span class="kx_cad_arrow">→</span>');
      h += '<li class="kx_cad_row">'
        +  '<button type="button" class="kx_cad_play" data-cadence="' + idx + '" title="Play">▶</button>'
        +  '<span class="kx_cad_name_l">' + escHtml(c.name) + '</span>'
        +  '<span class="kx_cad_chips">' + chordChips + '</span>'
        +  '<span class="kx_cad_desc">' + escHtml(c.desc) + '</span>'
        +  '</li>';
    });
    h +=     '</ul>';
    h +=   '</div>';

    h += '</div>';     // .kx_panel
    root.innerHTML = h;

    // Bind cadence play.
    if (root._kxBound) return;
    root._kxBound = true;
    root.addEventListener('click', function (e) {
      const btn = e.target.closest && e.target.closest('.kx_cad_play');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const idx = +btn.getAttribute('data-cadence');
      const c = _CADENCES[idx];
      if (!c) return;
      const xCur = window.SF_X;
      if (!xCur) return;
      const chords = c.romans.map(function (rn) {
        const r = _resolveRoman(rn, xCur.k);
        if (!r) return [];
        const baseQ = r.name.replace(r.root, '');
        const intervals = baseQ === 'm' ? [0,3,7]
                        : baseQ === '°' ? [0,3,6]
                                        : [0,4,7];
        return _chordToMidi(r.root, intervals);
      });
      _playChordSequence(chords, 0.7);
    });
  }

  // ----- 6. Inversions Panel (tier 2) -----------------------------------
  function renderInversions(x) {
    const root = document.getElementById('inversions_root');
    if (!root) return;
    // Only show when a chord is currently highlighted (x.hl has a 3- or
    // 4-note degree set) — otherwise the panel sits empty.
    const hlArr = String(x.hl || '').split(' ').filter(function (v) { return v && v !== 'nothing'; });
    if (hlArr.length < 3 || hlArr.length > 4) { root.innerHTML = ''; return; }
    // Resolve note names from the current key for each highlighted degree.
    const notedegrees = x._notedegrees || {};
    const chordNotes = hlArr.map(function (d) { return notedegrees[d] || ''; }).filter(Boolean);
    if (chordNotes.length < 3) { root.innerHTML = ''; return; }
    const invLabels = chordNotes.length === 3
      ? ['Root position', '1st inversion', '2nd inversion']
      : ['Root position', '1st inversion', '2nd inversion', '3rd inversion'];
    let h = '<div class="inv_panel">';
    h += '<div class="inv_intro">Inversions of the current chord (' + chordNotes.join(' ') + '):</div>';
    h += '<div class="inv_grid">';
    for (let i = 0; i < chordNotes.length; i++) {
      const rotated = chordNotes.slice(i).concat(chordNotes.slice(0, i));
      h += '<div class="inv_cell"><div class="inv_label">' + escHtml(invLabels[i]) + '</div>'
        +  '<div class="inv_notes">' + rotated.map(function (n, j) {
             return '<span class="inv_note' + (j === 0 ? ' inv_note_bass' : '') + '">' + escHtml(n) + '</span>';
           }).join('') + '</div>'
        +  '<div class="inv_bass">bass: ' + escHtml(rotated[0]) + '</div>'
        +  '</div>';
    }
    h += '</div></div>';
    root.innerHTML = h;
  }

  function renderTuningsTable(x) {
    const root = document.getElementById('tunings_root');
    // Tunings List section was removed — the dropdown picker handles
    // browsing now. Bail if no host element is present.
    if (!root) return;
    const rev = (x.y === 'y') ? 'rev_' : '';
    const tunUrl = x._self + x.url_k + x.url_y + x.url_z + x.url_s + x.url_hl;

    let h = '';
    // Filter bar: text input + quick-string-count buttons. Both fold into
    // the URL via ?f=… and ?fc=… so a filtered view is bookmarkable.
    h += '<div class="tunings_filter_bar">';
    h += '  <input type="search" id="filter" class="tunings_filter_input" placeholder="Filter — name, notes, info…" maxlength="64" value="' + escHtml(x._filter || '') + '" autocomplete="off" spellcheck="false">';
    h += '  <div class="tunings_strs" role="radiogroup" aria-label="Filter by string count">';
    ['', '4', '5', '6', '8', '10', '12'].forEach(function (v) {
      const active = (x._filterStrs === v) ? ' active' : '';
      const label = v === '' ? 'All' : v + '-string';
      h += '<button type="button" class="tunings_str_btn' + active + '" '
        +  'data-strs="' + v + '" role="radio" aria-checked="' + (x._filterStrs === v) + '">'
        +  escHtml(label) + '</button>';
    });
    h += '  </div>';
    h += '</div>';
    h += '<table class="sortable" id="tunings">';
    h += '<thead><tr>';
    h += '<th width="10%" class="num name"><button>Strings<span aria-hidden="true"></span></button></th>';
    h += '<th width="12%" class="name"><button>Name<span aria-hidden="true"></span></button></th>';
    h += '<th width="20%"><button>Tuning<span aria-hidden="true"></span></button></th>';
    h += '<th width="16%"><button>Degrees<span aria-hidden="true"></span></button></th>';
    h += '<th width="16%"><button>Unique Degrees<span aria-hidden="true"></span></button></th>';
    h += '<th width="26%"><button>Notes<span aria-hidden="true"></span></button></th>';
    h += '</tr></thead><tbody>';
    for (const key in TUNINGS) {
      const v = TUNINGS[key];
      // Compute fresh in the new 's'-for-sharp format; data.js still ships
      // the legacy %23-encoded url_notes field.
      const addUrl = '&x=' + urlNote(v.notes);
      let udgs = String(v.udgs).replace('1 3 5', '(1 3 5)').replace('1 ♭3 5', '(1 ♭3 5)');
      const trCls = (key === x.x) ? ' class="tun_selected"' : '';
      h += '<tr' + trCls + '>';
      h += '<td id="pad" class="name">' + v.strs + '-String</td>';
      h += '<td id="pad" class="name"><a href="' + tunUrl + addUrl + '">' + escHtml(v.name) + '</a></td>';
      h += '<td id="pad"><a href="' + tunUrl + addUrl + '">' + escHtml(v[rev + 'notes']) + '</a></td>';
      h += '<td id="pad">' + escHtml(v[rev + 'dgs']) + '</td>';
      h += '<td id="pad">' + escHtml(udgs) + '</td>';
      h += '<td id="pad">' + escHtml(v.info) + '</td>';
      h += '</tr>';
    }
    h += '</tbody></table>';
    root.innerHTML = h;
  }

  // ---------- About / per-section help popups ----------
  const SECTION_HELP = {
    fretboard: [
      '',
      '  ███████ ██████  ███████ ████████ ██████   ██████   █████  ██████  ██████',
      '  ██      ██   ██ ██         ██    ██   ██ ██    ██ ██   ██ ██   ██ ██   ██',
      '  █████   ██████  █████      ██    ██████  ██    ██ ███████ ██████  ██   ██',
      '  ██      ██   ██ ██         ██    ██   ██ ██    ██ ██   ██ ██  ██  ██   ██',
      '  ██      ██   ██ ███████    ██    ██████   ██████  ██   ██ ██   ██ ██████  .site',
      '',
      '  Fretboard',
      '  =========',
      '',
      '  An interactive fretboard for 4- to 12-string instruments — guitar,',
      '  bass, ukulele, banjo, mandolin, lap steel, pedal steel, and anything',
      '  in between. Each row is a string; columns 0–12 are frets. Each cell',
      '  shows the note name and its scale degree relative to the current Key.',
      '',
      '  Reading the board:',
      '    • Column 0 (left of the thick light-coloured nut) is the open',
      '      string — the pitch when no fret is held down.',
      '    • The thick vertical bar between fret 0 and fret 1 is the NUT.',
      '    • Cells are coloured by the chord/scale you have highlighted —',
      '      every "1" is one shade, every "♭3" is another, etc.',
      '',
      '  Controls in this section:',
      '    • TUNING picker (top-left) — click to open a sortable / filterable',
      '      table of 176 preset tunings. The number of strings + the preset',
      '      drive what each row shows.',
      '    • CUSTOM toggle — turns on per-string dropdowns so you can build',
      '      your own tuning. Sticks until you turn it off.',
      '    • L→H / H→L — flips the string order (high pitch on top vs.',
      '      bottom). Personal preference.',
      '    • DEGREE / NOTE PILLS — twelve stacked buttons across the top, one',
      '      per chromatic step. Click any pill to add or remove that degree',
      '      from the highlight set. "All" turns every pill on; "None" drops',
      '      just the colored highlights (chord-ID picks stay).',
      '    • CHORD / SCALE / KEY-SET CHIPS — quick-pick rows of common chord',
      '      shapes, common scales, and one-click "set to this key" buttons.',
      '',
      '  Sticky header (top of page):',
      '    • LOGO — center, click to reset the URL.',
      '    • TUNING — left, current tuning + notes + degrees.',
      '    • KEY — center row, twelve A–G♯ buttons. Picks apply page-wide.',
      '    • Audio (♪) — right, turn on a small synth so cell / chip / chord',
      '      clicks play.',
      '    • Clear — right, wipes every highlight AND every chord-ID pick.',
      '',
      '  Click-to-pick lives in the Chord ID sub-section (below the board).',
      '',
      '  Bookmark / share: every selection (tuning, key, custom strings,',
      '  highlights, picks, collapsed sections, sort, filter, progression)',
      '  lives in the URL. Copy the address bar and you have a shareable view.',
      ''
    ].join('\n'),

    chord_id: [
      '',
      '  Chord ID',
      '  ========',
      '',
      '  Tells you what chord(s) the currently HIGHLIGHTED notes form.',
      '  Anything that adds a note to the color-highlight set feeds it:',
      '',
      '    • Note buttons in the fretboard/keyboard summary row.',
      '    • Clicking a fret cell or a piano key (toggles that note).',
      '    • Chord & Scale Picks chips (one-shot replace).',
      '    • Chord/Scale builder grid rows.',
      '',
      '  Once 3 or more notes are highlighted, suggestion chips appear',
      '  in three buckets:',
      '    EXACT — chords whose notes exactly match the highlights.',
      '    CONTAINS — chords that fit inside the highlights (you have',
      '               extras, but those notes are a chord by themselves).',
      '    COULD BE (+ extras) — chords the highlights are PART of; the',
      '               +1 / +2 / +All toggle controls how many extra',
      '               notes are allowed.',
      '',
      '  Click any chip to highlight that chord across the fretboard /',
      '  keyboard. The chip turns blue while engaged. Click it again to',
      '  drop the highlights.',
      '',
      '  Filters:',
      '    • IN KEY pill — narrows suggestions to chords whose ROOT',
      '      matches the current key.',
      '    • +1 / +2 / +All — caps the "could be" bucket\'s extras count.',
      '',
      '  Above the strip:',
      '    • ◀ / ▶ shift bar — bumps the site key ±1 semitone, sliding',
      '      every highlight up/down the neck.',
      '    • Clear (right side of the strip) — drops every highlight.',
      ''
    ].join('\n'),

    chord_grid: [
      '',
      '  Chord Builder Grid',
      '  ==================',
      '',
      '  A grid of 28+ chord types (Maj, Min, 7, m7, Maj7, dim, dim7, aug,',
      '  sus2, sus4, 6, m6, 9, m9, Maj9, 11, 13, add9, …) showing which',
      '  scale degrees make up each chord.',
      '',
      '  How to read it:',
      '    • Each ROW is one chord type. The label on either end shows the',
      '      chord name and its degree formula (e.g. "Maj7  1-3-5-7").',
      '    • Each COLUMN is a scale degree (1 / ♭2 / 2 / ♭3 / 3 / 4 / ♭5 /',
      '      5 / ♭6 / 6 / ♭7 / 7). The header shows the actual note name in',
      '      the current key.',
      '    • A filled cell means that degree IS part of that chord. Cells',
      '      are coloured by their degree.',
      '    • Click ANYWHERE on a row to highlight that chord across the',
      '      fretboard and keyboard — every position lights up.',
      '',
      '  Above the grid:',
      '    • DIATONIC CHORDS — the 7 chords built on each note of the',
      '      current major scale (I, ii, iii, IV, V, vi, vii°). Coloured',
      '      by harmonic function: tonic / subdominant / dominant. Toggle',
      '      between triads and 7th chords with the pill on the right.',
      '    • INVERSIONS — when a chord is highlighted, this panel shows',
      '      the chord rotated so each chord tone sits in the bass.',
      '      "Root position" puts the chord\'s own root in the bass; 1st',
      '      inversion puts the 3rd in the bass; 2nd puts the 5th there.',
      '',
      '  Below: PROGRESSIONS — common chord progressions in the current',
      '  key with audio playback (Audio pill must be on).',
      '',
      '  Use the KEY picker or click a different cell to change context.',
      '  Hover any cell for a tooltip with degrees, notes, and which scales',
      '  contain that chord.',
      ''
    ].join('\n'),

    scale_grid: [
      '',
      '  Scale Builder Grid',
      '  ==================',
      '',
      '  Every common scale, laid out by degree.',
      '',
      '  Scales included:',
      '    • The 7 modes of major: Ionian, Dorian, Phrygian, Lydian,',
      '      Mixolydian, Aeolian (natural minor), Locrian',
      '    • Melodic Minor, Harmonic Minor',
      '    • Phrygian Dominant, Hungarian Minor',
      '    • Major Pentatonic, Minor Pentatonic, Blues',
      '    • Whole Tone, Diminished',
      '',
      '  How to read it:',
      '    • Each ROW is one scale. The label shows scale name and degree',
      '      formula (e.g. "Dorian  1-2-♭3-4-5-6-♭7"). Hover for the W-H',
      '      step pattern (W = whole step, H = half step).',
      '    • Each COLUMN is a degree. A filled cell means that degree',
      '      belongs to that scale.',
      '    • Click ANYWHERE on a row to highlight that scale across the',
      '      fretboard and keyboard.',
      '',
      '  Above the grid: MODES — all 7 modes derived from the current key',
      '  shown side-by-side. They share the same notes; only the tonal',
      '  centre changes. Each mode\'s "interval signature" tells you how it',
      '  differs from major (e.g. Dorian = ♭3 ♭7).',
      '',
      '  Notation note: scales that classically include ♯4, ♯5, or ♯6',
      '  display the enharmonic equivalents ♭5, ♭6, ♭7 because the site\'s',
      '  12-tone alphabet has only one slot per pitch class.',
      ''
    ].join('\n'),

    keyboard: [
      '',
      '  Keyboard',
      '  ========',
      '',
      '  An 88-key piano view from A0 to C8. The same key + highlight state',
      '  drives this section as the fretboard, so anything you select on one',
      '  shows up on the other.',
      '',
      '  Each note also has reference data labelled on the row above:',
      '    • OCTAVE NUMBER (0–8)',
      '    • STEEL STRING GAUGE that targets that pitch (.072 down to .011)',
      '    • 10-BAND EQ frequency centre that note falls into',
      '    • FREQUENCY in Hz',
      '    • INSTRUMENT RANGE bands for guitar and bass',
      '',
      '  How highlights work:',
      '    By default keys read as a real piano (white keys white, black',
      '    keys dark). When you highlight one or more degrees, the matching',
      '    notes pick up the degree colour — every other note stays plain',
      '    so your selection pops. Highlight every degree to see the full',
      '    rainbow.',
      '',
      '  Above the keyboard:',
      '    • DEGREE / NOTE PILLS — twelve stacked buttons, one per chromatic',
      '      step. Click to add or remove that degree from the highlight set.',
      '      "All" turns every pill on; "None" drops just the colored',
      '      highlights (chord-ID picks stay).',
      '',
      '  Click-to-pick lives in the Chord ID sub-section below the keyboard.',
      '  Click keys with Chord ID toggled on, and the strip names every',
      '  chord your picks form. See the Chord ID help (?) for details.',
      ''
    ].join('\n'),

    tunings: [
      '',
      '  Tunings List',
      '  ============',
      '',
      '  176 preset tunings — standard and drop tunings for guitar and bass,',
      '  ukulele variations, banjo open tunings, mandolin, plus the steel-',
      '  guitar staples (lap A6 / C6 / E13, pedal E9 / B6 / C6 / Universal).',
      '',
      '  How to use:',
      '    • Click any COLUMN HEADER to sort. Click again to reverse direction.',
      '    • Use the FILTER input to narrow the list — matches across name,',
      '      notes, degrees, info, and string count.',
      '    • Use the STRING-COUNT BUTTONS to pin a specific count. They\'re',
      '      toggles, so clicking the same one again clears the filter.',
      '    • Click ANYWHERE on a row to load that tuning into the fretboard.',
      '      The current Key and highlights stay put.',
      '    • Hit CSV in the section header to download the currently visible',
      '      (sorted + filtered) tunings as a comma-separated file.',
      '',
      '  Sort, filter, and the chosen tuning all live in the URL, so a',
      '  filtered view is bookmarkable / shareable.',
      ''
    ].join('\n'),

    progressions: [
      '',
      '  Progressions',
      '  ============',
      '',
      '  A chord progression builder. Type chords, pick from the palette,',
      '  or hit the + add-box; mix Roman numerals (transpose with the key)',
      '  with absolute chord names (stay put) freely.',
      '',
      '  Top row (centered):',
      '    • CHORD PROGRESSION input — type the progression, e.g.',
      '         "I IV V"          (Romans, transpose with the key)',
      '         "C Am F G"        (absolute chords, stay put)',
      '         "Cmaj7 Dm7 G7"    (with voicings)',
      '       Press SPACE or ENTER to apply. Tokens auto-apply as you type.',
      '       The Roman regex accepts ♭ / ♯ prefixes, lowercase = minor,',
      '       and a trailing ° for diminished or 7 for sevenths.',
      '    • ♯ / ♭ buttons — click to insert the proper accidental glyph at',
      '       the cursor (typing # or b in the input also works).',
      '    • PALETTE MODE dropdown — pick the diatonic flavour the chip row',
      '       below uses: Major, Minor, Dorian, Phrygian, Lydian, Mixolydian,',
      '       Harmonic, Melodic. Roman tokens already in the progression do',
      '       NOT change when you switch modes — only the palette does.',
      '    • ▶ Play — auditions the progression with a soft triangle-wave',
      '       synth. The sticky-header Audio (♪) toggle must be on.',
      '    • Tempo — 40–200 bpm slider. Live; updates without re-rendering.',
      '',
      '  Palette chips:',
      '    Seven Roman-numeral chips for the current mode (I, ii, iii, IV,',
      '    V, vi, vii° for major; flavours change for other modes). Click',
      '    any chip to APPEND that Roman to your progression.',
      '',
      '  The bar strip:',
      '    Each chord you add becomes a bar with three dropdowns:',
      '      DEGREE — change to a different Roman / chromatic degree.',
      '      NOTE   — pick a different root letter (turns the bar absolute).',
      '      VOICING — Maj, m, 7, m7, Maj7, m-Maj7, dim, dim7, m7♭5, aug,',
      '                sus2, sus4, 6, m6, 9, m9, Maj9, add9, 11, 13.',
      '    The ⋯ corner button opens a per-bar action menu (right now just',
      '    "Highlight on fretboard / keyboard"). The × in the corner removes',
      '    the bar. Bars can be reordered or removed without losing siblings.',
      '    The dashed + box at the end of the strip appends a new bar',
      '    pre-filled with the current key + Maj.',
      '',
      '  Section header buttons:',
      '    • Clear — clears just the progression (prog + pmode + tempo).',
      '       Does not affect the rest of the page.',
      '    • Print — prints the progression as a portrait chord chart, big',
      '       text, four bars wide.',
      '',
      '  Bookmark-friendly: prog, pmode, and tempo all live in the URL.',
      ''
    ].join('\n'),

    key_signatures: [
      '',
      '  Key Signatures',
      '  ==============',
      '',
      '  A reference table of every major key, paired with its Circle of',
      '  Fifths and a few cheat-sheet panels.',
      '',
      '  The table:',
      '    • Sharp keys on top (C, G, D, A, E, B, F♯, C♯), then flats',
      '      (F, B♭, E♭, A♭, D♭, G♭, C♭).',
      '    • Each row shows: the accidental notes in canonical order, the',
      '      key name (with its relative minor next to it — they share the',
      '      same key signature), the count of sharps or flats, the staff',
      '      with the actual accidental marks, and a hand-signal mnemonic.',
      '    • Click any row to jump to that key. The current key is',
      '      highlighted cyan.',
      '',
      '  Hand-signal mnemonic: fingers UP = sharps, fingers DOWN = flats.',
      '  Number of fingers = count. So 3 fingers up = A major (3 ♯), 2',
      '  fingers down = B♭ major (2 ♭).',
      '',
      '  Circle of Fifths:',
      '    Twelve wedges, each labelled with a major key (outer ring) and',
      '    its relative minor (inner ring). Going clockwise, each wedge is',
      '    a perfect fifth higher; going counter-clockwise, a perfect fourth.',
      '    Click any wedge to switch to that key. Three positions show',
      '    enharmonic spellings (B / C♭, F♯ / G♭, C♯ / D♭) — same pitches,',
      '    different name.',
      '',
      '  Cheat-sheet panels:',
      '    • Intervals from the current key — every interval (P1 through M7)',
      '      named, in semitones, with the resulting note.',
      '    • In <key> major — the notes, relative minor, parallel minor,',
      '      dominant key (V), and subdominant key (IV) for the current key.',
      '    • Cadences — the four most common 2-chord cadences (Authentic,',
      '      Plagal, Half, Deceptive) with audio playback.',
      ''
    ].join('\n'),

    tab: [
      '',
      '  Tab Editor',
      '  ==========',
      '',
      '  An in-page tablature editor for 4- to 12-string instruments. Type',
      '  fret numbers and articulation symbols, print finished tab, or print',
      '  a stack of empty staves for handwriting.',
      '',
      '  Setup controls (top row):',
      '    • TITLE — printed at the top of every page.',
      '    • STRINGS — 4 through 12.',
      '    • TUNING — preset tunings filtered to your string count.',
      '    • MEASURES — total length.',
      '    • BEATS / MEASURE — time signature top number.',
      '    • SUBDIVISIONS — 1 (quarters), 2 (8ths), 3 (triplets), 4 (16ths).',
      '    • MEASURES / LINE — how many bars wrap onto each printed row.',
      '',
      '  Editing:',
      '    • Type 0–99 in any cell for a fret number.',
      '    • Articulation symbols: h hammer, p pull, / slide up, \\\\ slide',
      '      down, ~ vibrato, x mute.',
      '    • Tab moves right, Enter moves down, arrow keys go anywhere.',
      '    • Edit string labels on the left edge directly. ↑ / ↓ moves',
      '      between strings; Enter drops into the first cell on that row.',
      '    • ⇅ flip strings reverses row order (highest pitch on top vs.',
      '      bottom).',
      '',
      '  Capture from fretboard:',
      '    Open the "Capture from fretboard" panel, hit ⏺ to record, then',
      '    click frets on the mini-board. Each click writes that fret number',
      '    into the cursor cell and advances. ⫳ stacks notes in the same',
      '    column (chord). ⊘ rests. ⌫ erases. ⏮ resets the cursor.',
      '',
      '  Chord boxes:',
      '    Open chord-box diagrams shown above your tab when printed. Click',
      '    a fret to add a dot, click above the box to toggle × (mute) or ○',
      '    (open string). −/+ shifts the box up or down the neck.',
      '',
      '  Print:',
      '    • PRINT BLANK — empty staves at your string count, no bar lines',
      '      (handwriting practice).',
      '    • PRINT TAB — your written tab, no chord boxes.',
      '    • PRINT BOXES — just the chord boxes.',
      '    • PRINT ALL — chord boxes + tab.',
      ''
    ].join('\n'),

    sheetmusic: [
      '',
      '  Sheet Music',
      '  ===========',
      '',
      '  A searchable library of chord progressions extracted from a 4,000+',
      '  jazz / pop fake-book collection. Each entry shows the song title,',
      '  key, time signature, and chord changes — both as concrete chord',
      '  names AND as Nashville-style scale degrees so you can transpose.',
      '',
      '  This section is currently under construction; data wiring is in',
      '  progress. The placeholder text describes what will land here once',
      '  the catalogue is published.',
      ''
    ].join('\n'),

    ear_training: [
      '',
      '  Ear Training',
      '  ============',
      '',
      '  Random interval- and chord-identification drills. The site plays a',
      '  root note and one or more follow-up notes; you guess what you heard.',
      '',
      '  Modes:',
      '    • INTERVALS — root + one other note. Pick any subset of the 12',
      '      chromatic intervals to drill (m2, M2, m3, M3, P4, TT, P5, m6,',
      '      M6, m7, M7). Buttons show the short name; hover for the long',
      '      name.',
      '    • CHORDS — root + the rest of a triad or 7th chord. Pool covers',
      '      Major, minor, diminished, augmented, dom7, Maj7, min7, m7♭5.',
      '',
      '  Playback:',
      '    • ↑ Melodic — notes one after another, low → high',
      '    • ↓ Melodic — notes one after another, high → low',
      '    • ⧉ Harmonic — every note struck at once',
      '    • ↑ then ⧉ — melodic first, then harmonic',
      '',
      '  Uses whatever instrument voice you have selected elsewhere in the',
      '  site. Score (correct / wrong) persists in localStorage and can be',
      '  reset from the score row. Pool + playback preferences persist too.',
      ''
    ].join('\n'),

    learn: [
      '',
      '  Quiz',
      '  ====',
      '',
      '  Endless random multiple-choice quiz to drill scale, chord, and key',
      '  signature recall. Every question is freshly generated — there is no',
      '  fixed bank to memorise.',
      '',
      '  Question types (rotate randomly):',
      '    • Show degrees → name the SCALE',
      '         e.g.  "1 2 ♭3 4 5 6 ♭7"  →  Dorian',
      '    • Show degrees → name the CHORD',
      '         e.g.  "1 3 5 ♭7"  →  dom7',
      '    • Show notes in a key → name the SCALE or CHORD',
      '         e.g.  "In C: C E G B"  →  Maj7',
      '    • Mode characteristic note',
      '         e.g.  "Which mode has a ♯4?"  →  Lydian',
      '    • Cadence recognition',
      '         e.g.  "V → I"  →  Authentic cadence',
      '    • Key signature drills (sharps / flats / accidental notes)',
      '',
      '  Use the SIDEBAR to enable / disable categories — your selection',
      '  persists in localStorage. Click any answer to mark it: green for',
      '  correct, red for wrong. Click NEXT for a fresh question. There is',
      '  no score and no time pressure.',
      ''
    ].join('\n')
  };

  function closeViewSourceModal() {
    const m = document.getElementById('view_source_modal');
    if (m) m.remove();
    document.removeEventListener('keydown', escClose);
  }
  function escClose(e) {
    if (e.key === 'Escape') closeViewSourceModal();
  }
  function showInfoModal(content, opts) {
    closeViewSourceModal();
    const overlay = document.createElement('div');
    overlay.id = 'view_source_modal';
    if (opts && opts.className) overlay.className = opts.className;
    overlay.innerHTML =
      '<div class="vs_backdrop"></div>' +
      '<div class="vs_panel" role="dialog" aria-label="About">' +
        '<button class="vs_close" type="button" aria-label="Close">×</button>' +
        '<pre class="vs_pre"></pre>' +
      '</div>';
    const pre = overlay.querySelector('.vs_pre');
    if (opts && opts.html) {
      pre.innerHTML = content;
    } else {
      pre.textContent = content;
    }
    overlay.querySelector('.vs_backdrop').addEventListener('click', closeViewSourceModal);
    overlay.querySelector('.vs_close').addEventListener('click', closeViewSourceModal);
    document.body.appendChild(overlay);

    // Optional anchor: position the panel near the cursor (used by the
    // Witherfork footer popup). Clamps inside the viewport so a click near
    // an edge doesn't push the panel off-screen.
    if (opts && opts.anchor) {
      const panel = overlay.querySelector('.vs_panel');
      const margin = 12;
      const w = panel.offsetWidth;
      const h = panel.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = opts.anchor.x - w / 2;
      let top  = opts.anchor.y - h - margin;       // prefer above the cursor
      if (top < margin) top = opts.anchor.y + margin;  // not enough room above → below
      left = Math.max(margin, Math.min(left, vw - w - margin));
      top  = Math.max(margin, Math.min(top,  vh - h - margin));
      panel.style.position = 'fixed';
      panel.style.left = left + 'px';
      panel.style.top  = top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.transform = 'none';
    }

    document.addEventListener('keydown', escClose);
  }

  function bindFooterWitherfork() {
    const link = document.getElementById('footer_witherfork');
    if (!link || link._wfBound) return;
    link._wfBound = true;
    link.addEventListener('click', function (e) {
      e.preventDefault();
      const html =
        '<a class="wf_link" href="https://seadisco.com" target="_blank" rel="noopener noreferrer">SeaDisco.com</a>';
      showInfoModal(html, {
        html: true,
        className: 'wf_compact',
        anchor: { x: e.clientX, y: e.clientY }
      });
    });
  }

  function printSection(sectionId) {
    const section = document.getElementById(sectionId);
    if (!section) return;
    let restoreClosed = false;
    if (section.tagName === 'DETAILS' && !section.open) {
      restoreClosed = true;
      section.open = true;
    }
    document.body.setAttribute('data-print', sectionId);
    // Per-section page orientation override. Chrome ignores
    // `body[data-print="..."] { page: <name>; }`, so we inject a fresh
    // top-level @page rule into the head right before printing and
    // remove it after. Default landscape stays for everything else.
    let pageStyle = null;
    if (sectionId === 'section_11') {
      pageStyle = document.createElement('style');
      pageStyle.id = 'sf_print_page_override';
      pageStyle.textContent = '@page { size: portrait; margin: 0.6cm; }';
      document.head.appendChild(pageStyle);
    }
    function cleanup() {
      document.body.removeAttribute('data-print');
      if (pageStyle && pageStyle.parentNode) pageStyle.parentNode.removeChild(pageStyle);
      if (restoreClosed) section.open = false;
      window.removeEventListener('afterprint', cleanup);
    }
    window.addEventListener('afterprint', cleanup);
    setTimeout(function () { window.print(); }, 50);
  }

  function bindPrintButtons() {
    document.querySelectorAll('.section_print').forEach(function (btn) {
      if (btn._printBtnBound) return;
      btn._printBtnBound = true;
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        e.preventDefault();
        const sectionId = btn.getAttribute('data-print-section');
        if (sectionId) printSection(sectionId);
      });
    });
  }

  // Quote a value per RFC 4180 — wrap in double quotes if it contains a
  // comma, quote, or newline; double up any internal quotes.
  function csvQuote(v) {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // Build a CSV from the *visible* rows of the on-page tunings table, so the
  // user's current sort + filter (and the section's own filter input) are
  // honoured. Falls back to dumping the full TUNINGS object if the table
  // hasn't rendered yet.
  function buildTuningsCsv() {
    const cols = ['Strings', 'Name', 'Notes', 'Notes (Reverse)', 'Degrees', 'Degrees (Reverse)', 'Info'];
    const lines = [cols.map(csvQuote).join(',')];
    // Honor the tunings dropdown's current filter + sort if it's
    // populated; fall back to the full TUNINGS dictionary otherwise.
    const x = window.SF_X;
    let rows = null;
    if (x && typeof _tunPickerRows === 'function') {
      try { rows = _tunPickerFiltered(_tunPickerSorted(_tunPickerRows(x))); }
      catch (_) { rows = null; }
    }
    if (rows && rows.length) {
      rows.forEach(function (r) {
        const t = TUNINGS[r.key] || {};
        lines.push([r.strs, r.name, r.notes, t.rev_notes || '', r.dgs, t.rev_dgs || '', r.info || '']
          .map(csvQuote).join(','));
      });
    } else {
      Object.keys(TUNINGS).forEach(function (key) {
        const t = TUNINGS[key];
        lines.push([t.strs, t.name, t.notes, t.rev_notes, t.dgs, t.rev_dgs, t.info || '']
          .map(csvQuote).join(','));
      });
    }
    return lines.join('\r\n');
  }

  function downloadCsv(filename, content) {
    const blob = new Blob(['﻿' + content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 200);
  }

  function bindExportButtons() {
    // Delegate at document.body so the CSV button rendered inside the
    // tunings dropdown popup (which gets rebuilt on each open) wires
    // automatically without a re-bind pass.
    if (document.body._exportDelegated) return;
    document.body._exportDelegated = true;
    document.body.addEventListener('click', function (e) {
      const btn = e.target.closest && e.target.closest('.section_export');
      if (!btn) return;
      e.stopPropagation();
      e.preventDefault();
      if (btn.getAttribute('data-export') === 'tunings') {
        const stamp = new Date().toISOString().slice(0, 10);
        downloadCsv('fretboard-tunings-' + stamp + '.csv', buildTuningsCsv());
      }
    });
  }

  function bindHelpButtons() {
    // Delegate at document.body so dynamically-rendered help buttons
    // (e.g. the one inside the Chord ID box, which is rebuilt every
    // applyState) work without re-binding.
    if (document.body._helpDelegated) return;
    document.body._helpDelegated = true;
    document.body.addEventListener('click', function (e) {
      const btn = e.target.closest && e.target.closest('.section_help');
      if (!btn) return;
      e.stopPropagation();
      e.preventDefault();
      const key = btn.getAttribute('data-help');
      showInfoModal(SECTION_HELP[key] || '');
    });
  }

  // ---------- auto-submit on any control change ----------
  function gatherAndNavigate() {
    // Flush collapse state to URL synchronously. Without this, a
    // form-control change RIGHT AFTER opening a section would
    // navigate with the pre-toggle c= snapshot and slam the section
    // shut on the next applyCollapseFromUrl.
    if (typeof updateClosedInUrl === 'function') {
      try { updateClosedInUrl(); } catch (_) {}
    }
    const opt = document.getElementById('options_root');
    const fb = document.getElementById('fretboard_root');
    const parts = [];

    function pushSelect(sel) {
      if (!sel || !sel.name) return;
      // Sharps emit as 's' (lowercase), no encoding needed. Flats emit as 'b'.
      // Decoder accepts both 's' and legacy '%23' so old links still work.
      const v = urlNote(sel.value);
      parts.push(sel.name + '=' + v);
    }
    pushSelect(opt.querySelector('select[name="x"]'));
    // Key dropdown lives in each section's title bar (.section_key_picker) since
    // the form no longer has its own. Read from any of them — bindAutoSubmit's
    // sync handler keeps every section's key picker at the same value. Falls
    // back to window.SF_X.k (parsed state) if no picker is in the DOM yet,
    // so the URL always carries k= once any change fires.
    //
    // In UNLINKED mode each picker shows its own section's effective key,
    // so reading from "the first picker" can clobber the global k. Use
    // window.SF_X.k (the parsed global) instead — it survives unchanged
    // until the user explicitly toggles back to Linked.
    const _unlinkedNow = document.body.getAttribute('data-apply-all') === 'off';
    const _kPick = document.querySelector('.section_key_picker select[name="k"]');
    if (_unlinkedNow && window.SF_X && window.SF_X.k) {
      parts.push('k=' + urlNote(window.SF_X.k));
    } else if (_kPick) {
      pushSelect(_kPick);
    } else if (window.SF_X && window.SF_X.k) {
      parts.push('k=' + urlNote(window.SF_X.k));
    }

    // y (low/high direction) and z (custom-tuning toggle) are now link-
    // driven switches, not checkboxes — they live entirely in the URL.
    // Carry whatever the URL has so changing a string-note dropdown
    // doesn't accidentally drop "z=y" and disengage custom tuning.
    const _curParams = new URLSearchParams(window.location.search);
    ['y', 'z'].forEach(function (name) {
      const v = _curParams.get(name);
      if (v === 'y') parts.push(name + '=y');
    });

    // Highlight pills are link-driven; carry whatever's currently in the URL
    // so other form controls don't drop the active highlights. Emit as a
    // single comma-separated `hl=` value (parseState accepts the legacy
    // multi-key form too).
    const hlList = readHlParam(new URLSearchParams(window.location.search));
    if (hlList.length) parts.push('hl=' + hlList.join(','));

    // Click-to-pick chord identifier set (pk) — carry as-is.
    const pkList = readPkParam(new URLSearchParams(window.location.search));
    if (pkList.length) parts.push('pk=' + pkList.join(','));

    // Progression state (prog, pmode, tempo) — carry whatever the URL
    // currently has so changing the key (or any other form control)
    // doesn't blow away the user's chord progression. Roman tokens in
    // prog still transpose with key changes at render time; absolute
    // tokens (Cmaj7) stay as written.
    const _curProg = _curParams.getAll('prog');
    _curProg.forEach(function (v) { parts.push('prog=' + encodeURIComponent(v)); });
    const _curPmode = _curParams.get('pmode');
    if (_curPmode) parts.push('pmode=' + encodeURIComponent(_curPmode));
    const _curTempo = _curParams.get('tempo');
    if (_curTempo) parts.push('tempo=' + encodeURIComponent(_curTempo));

    // Carry every persistence-only param: collapsed sections (c),
    // display mode, instrument, quick-picks closed list, chord-id
    // closed list, sort, tab-capture extras, section order, etc.
    // Without these, a form-control change (key picker, tuning
    // select, …) would strip them — re-opening collapsed sections
    // and reverting display settings on every navigation.
    ['c', 'disp', 'inst', 'qpc', 'idc', 'sort', 'td', 'fc', 'fcp',
     'ext', 'ik', 'cmp', 'ord', 'id', 'idn'].forEach(function (k) {
      const vals = _curParams.getAll(k);
      vals.forEach(function (v) { parts.push(k + '=' + encodeURIComponent(v)); });
    });

    // Custom-tuning strings combined into one no-separator `s=` param.
    // Three cases:
    //   z=y               → read selects, rebuild s=
    //   z=n + URL has s   → preserve URL s untouched (avoids overwriting
    //                       a 6-string custom with 12 form-select slots
    //                       when the main tuning has more strings)
    //   z=n + no URL s    → read selects so the URL captures the active
    //                       custom (e.g. on first state change after a
    //                       fresh page load with DEF_X defaults)
    const _zIsY = (_curParams.get('z') === 'y');
    const _curS = _curParams.get('s');
    function _readSFromForm() {
      const sels = fb.querySelectorAll('select[name^="s"]');
      const sVals = [];
      sels.forEach(function (sel) {
        const m = sel.name && sel.name.match(/^s(\d+)$/);
        if (!m) return;
        sVals[parseInt(m[1], 10) - 1] = urlNote(sel.value);
      });
      while (sVals.length && !sVals[sVals.length - 1]) sVals.pop();
      if (!sVals.length) return null;
      const normalized = sVals.map(function (v) { return v || ''; });
      const hasGap = normalized.some(function (v) { return !v; });
      return normalized.join(hasGap ? '.' : '');
    }
    if (fb && _zIsY) {
      const _v = _readSFromForm();
      if (_v) parts.push('s=' + _v);
    } else if (_curS) {
      parts.push('s=' + _curS);
    } else if (fb) {
      // No s in URL yet — write the form's current selects so the user's
      // first state change captures the active custom in the URL.
      const _v = _readSFromForm();
      if (_v) parts.push('s=' + _v);
    } else {
      // Legacy individual ?s1=…&s2=… preservation (rare).
      for (let i = 1; i <= 12; i++) {
        const _v = _curParams.get('s' + i);
        if (_v != null) parts.push('s' + i + '=' + _v);
      }
    }

    // Preserve unlinked-mode metadata so a tuning / chord-form change
    // doesn't accidentally re-link everything: keep the u flag and
    // every section-namespaced override (s<num>_k, s<num>_hl, ...).
    if (_unlinkedNow) {
      if (_curParams.get('u') === '1') parts.push('u=1');
      _curParams.forEach(function (v, k) {
        if (/^s\d+_/.test(k)) parts.push(k + '=' + encodeURIComponent(v));
      });
    }

    navigateTo('?' + parts.join('&'));
  }

  function navigateTo(search) {
    // Canonicalize param order so every navigation emits the same shape.
    let _norm = search;
    try {
      const _p = new URLSearchParams(String(search || '').replace(/^\?/, ''));
      // BEFORE canonicalising, override the c= param (collapsed
      // sections) with what's currently in the DOM. This is the last
      // line of defense against stale collapse state: the <details>
      // toggle event is async, so callers that snapshot
      // window.location.search before the event has fired could
      // otherwise navigate with an out-of-date c=. Also sync LS for
      // each section so applyCollapseFromUrl's LS fallback can't
      // re-close a section the user has open.
      // Skip on bare-clear navigations (site_clear) — those want a
      // truly empty URL.
      const _domSections = document.querySelectorAll('details.collapsible');
      if (_domSections.length && _norm !== '?' && _norm !== '') {
        const domClosed = [];
        _domSections.forEach(function (d) {
          const open = !!d.open;
          if (!open) domClosed.push(d.id.replace('section_', ''));
          try { window.localStorage.setItem('sf_collapse_' + d.id, open ? 'open' : 'closed'); } catch (e) {}
        });
        if (domClosed.length) _p.set('c', domClosed.join(','));
        else _p.delete('c');
      }
      const _qs = canonicalQS(_p);
      _norm = _qs ? '?' + _qs : '?';
    } catch (_) {}
    if (_norm === window.location.search || (_norm === '?' && !window.location.search)) return;
    const target = (_norm === '?' || _norm === '') ? window.location.pathname : _norm;
    // Preserve scroll across the re-render — pushState shouldn't move the page,
    // but some layout shifts during innerHTML swaps can cause a jump.
    const sx = window.scrollX || window.pageXOffset || 0;
    const sy = window.scrollY || window.pageYOffset || 0;
    history.pushState({}, '', target);
    applyState();
    window.scrollTo(sx, sy);
  }

  function bindAutoSubmit() {
    const handler = function (e) {
      // Key-picker changes have two modes depending on the "Apply: all"
      // toggle in the fretboard summary:
      //   ENGAGED (default) — propagate the new key to every section's
      //                        picker, then build a new URL → full re-
      //                        render. Single global key.
      //   DISENGAGED        — only the section whose picker changed is
      //                        re-rendered with the new key as a per-
      //                        section override. URL state untouched, so
      //                        other sections keep whatever key they had.
      if (e && e.target && e.target.matches && e.target.matches('select[name="k"]')) {
        const unlinked = document.body.getAttribute('data-apply-all') === 'off';
        if (unlinked) {
          // Project the new key onto the current URL as a section-
          // namespaced param so it persists + is shareable. Other
          // sections + the global k stay put.
          const sectionEl = e.target.closest('details.section, details.collapsible');
          if (sectionEl) {
            const fakeLinkSearch = '?k=' + encodeURIComponent(urlNote(e.target.value));
            const merged = mergeSectionOverrideUrl(sectionEl.id, fakeLinkSearch);
            if (merged != null) {
              navigateTo(merged);
              return;
            }
          }
          return;  // safety: don't fall through to global navigate
        }
        document.querySelectorAll('.section_key_picker select[name="k"]').forEach(function (sel) {
          if (sel !== e.target) sel.value = e.target.value;
        });
      }
      gatherAndNavigate();
    };
    document.querySelectorAll(
      '#options_root select, #options_root input[type="checkbox"], #fretboard_root select:not(.custom_tun_loader), .section_key_picker select[name="k"]'
    ).forEach(function (el) {
      el.addEventListener('change', handler);
    });
    // Chromatic key buttons in each section. Click → set the matching
    // hidden <select> and fire a change event so the existing handler
    // does the rest (URL build, propagation, navigate).
    if (!document.body.dataset.keyBtnDelegated) {
      document.body.dataset.keyBtnDelegated = '1';
      document.addEventListener('click', function (e) {
        const btn = e.target.closest && e.target.closest('.section_key_row .key_btn');
        if (!btn) return;
        const row = btn.closest('.section_key_row');
        const sel = row && row.querySelector('select.key_hidden_select');
        const newKey = btn.getAttribute('data-key');
        if (!sel || !newKey) return;
        sel.value = newKey;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
  }

  // ---- Per-section rerender (used when "Apply: all" is off) ---------
  // Calls only the targeted section's renderer(s) with the supplied
  // state object. Used both for key-picker changes (state = SF_X with k
  // overridden) and for chord/scale/keysig link clicks (state = the
  // link's URL parsed into a SF_X-shape via parseState).
  function rerenderSectionWithState(sectionId, x) {
    if (!x) return;
    switch (sectionId) {
      case 'section_2':
        if (typeof renderFretboard === 'function') renderFretboard(x);
        break;
      case 'section_3':
        if (typeof renderChordGrid === 'function') renderChordGrid(x);
        break;
      case 'section_4':
        if (typeof applyKeyboardColors === 'function') applyKeyboardColors(x);
        if (typeof renderKeyboardPicks === 'function') renderKeyboardPicks(x);
        break;
      case 'section_6':
        if (typeof renderScaleGrid === 'function') renderScaleGrid(x);
        break;
      case 'section_9':
        if (typeof renderKeySignatures === 'function') renderKeySignatures(x);
        break;
    }
  }
  function rerenderSectionWithKey(sectionId, k) {
    // Thin compatibility wrapper. Builds an override state by parsing
    // the current URL fresh (so other URL params are preserved) and
    // swapping in the new key, then routes through the generic helper.
    if (!k) return;
    const x = parseState();
    x.k = k;
    rerenderSectionWithState(sectionId, x);
  }

  // Take a "linked-style" URL (the kind the chord/scale/keysig links
  // pre-build, e.g. `?k=A&hl=1&hl=3&hl=5`) and merge its params into
  // the CURRENT URL as section-namespaced overrides for `sectionId`.
  // Used by the link interceptor when the page is in unlinked mode.
  // Returns the new query string (with leading "?"), or null if the
  // section ID doesn't match the s<num>_* convention.
  function mergeSectionOverrideUrl(sectionId, linkSearch) {
    const m = String(sectionId || '').match(/^section_(\d+)$/);
    if (!m) return null;
    const sNum = m[1];
    const cur = new URLSearchParams(window.location.search);
    const link = new URLSearchParams(linkSearch);

    // Project each interesting link param into a section-namespaced one.
    // ONLY touch the fields the link actually sets — don't blanket-drop
    // every s<n>_* param up front, or unrelated overrides for this
    // section get wiped out (e.g. clicking a degree pill, whose href
    // only carries hl, used to drop s2_pk and other section state).
    //
    // For single-value fields, also skip the projection when the link's
    // value equals the current GLOBAL — that means the click is just
    // preserving k=/x=/etc. (a hl-pill click, say) and shouldn't clobber
    // a section override that intentionally diverges from global.
    const single = ['k', 'x', 'y', 'z', 's'];
    single.forEach(f => {
      const k = 's' + sNum + '_' + f;
      if (link.has(f)) {
        const linkVal   = link.get(f);
        const curGlobal = cur.get(f);
        if (linkVal !== curGlobal) cur.set(k, linkVal);
      }
    });
    ['hl', 'pk'].forEach(f => {
      const k = 's' + sNum + '_' + f;
      if (!link.has(f)) return;            // click didn't touch this field
      // Skip if the link's value is identical to the current global —
      // that means the click is just preserving the URL field, not
      // changing it (e.g. a hl pill click whose href still carries
      // pk=… from the URL). Without this guard, every pill click would
      // overwrite the section's picks with the global picks.
      const linkAll = link.getAll(f).join(',');
      const curAll  = cur.getAll(f).join(',');
      if (linkAll === curAll) return;
      // Otherwise the click is changing this field for the section.
      // Three cases:
      //   - non-empty value → write the new value.
      //   - explicit empty (`hl=` / `pk=`) → keep the section override
      //       but with an empty value, so the section stays cleared
      //       instead of inheriting the global value.
      const arr = link.getAll(f).filter(function (v) { return v.length; });
      if (arr.length) cur.set(k, arr.join(','));
      else            cur.set(k, '');
    });

    // Make sure the unlinked flag stays on; otherwise on next render
    // we'd parse the s<n>_* params as junk.
    cur.set('u', '1');
    const qs = cur.toString();
    return qs ? ('?' + qs) : '?';
  }

  // ---- Linked / Unlinked toggle (fretboard summary) -----------------
  // URL is the source of truth: `u=1` → unlinked (each section can
  // hold its own state via s<n>_* params). No `u` → linked (one
  // global state, current behavior). The toggle navigates the URL,
  // so reload + share preserve whichever mode you were in.
  let _applyAllBound = false;
  function paintApplyAllToggle() {
    // Unlinked mode is retired — always force linked so any code still
    // reading body[data-apply-all] gets a deterministic answer.
    document.body.setAttribute('data-apply-all', 'on');
    const $btn = document.getElementById('apply_all_toggle');
    if (!$btn) return;
    const params = new URLSearchParams(window.location.search);
    const unlinked = params.get('u') === '1';
    document.body.setAttribute('data-apply-all', unlinked ? 'off' : 'on');
    $btn.classList.toggle('on', !unlinked);
    $btn.textContent = unlinked ? 'Unlinked' : 'Linked';
    $btn.setAttribute('aria-pressed', unlinked ? 'false' : 'true');
  }
  // ---- Audio toggle (♪) — Fretboard summary ----------------------
  let _audioToggleBound = false;
  function paintAudioToggle() {
    const $btn = document.getElementById('audio_toggle');
    if (!$btn) return;
    const on = audioOn();
    $btn.classList.toggle('on', on);
    $btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    $btn.title = on
      ? 'Audio on — click again to mute. Notes play when you click a fret or key.'
      : 'Audio off — click to play notes when you click a fret or key.';
  }
  function bindAudioToggle() {
    paintAudioToggle();
    bindInstrumentSelect();
    if (_audioToggleBound) return;
    const $btn = document.getElementById('audio_toggle');
    if (!$btn) return;
    _audioToggleBound = true;
    $btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      const turningOn = !audioOn();
      setAudioOn(turningOn);
      paintAudioToggle();
      // Pre-warm both audio paths on the activating gesture so the
      // first played note doesn't have any user-gesture latency.
      if (turningOn) {
        ensureAudioCtx();
        preWarmTone();
      }
    });
  }
  // ---- Display mode (notes / degrees / both) -----------------------
  // Drives whether note names, degree labels, or both are shown in the
  // fretboard cells, chord/scale grid cells, and progression bars.
  // Round-trips through URL + localStorage via the SETTINGS registry.
  function getDisplayMode() { return getSetting('display_mode'); }
  function setDisplayMode(m) {
    setSetting('display_mode', m);   // normalizes + writes URL + LS
    document.body.setAttribute('data-display', getDisplayMode());
    paintDisplayModeButtons();
    if (window.SF_X) applyKeyboardLabels(window.SF_X);
  }
  function paintDisplayModeButtons() {
    const cur = getDisplayMode();
    document.querySelectorAll('.display_mode_btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-display') === cur);
    });
  }
  let _displayModeBound = false;
  function bindDisplayModeButtons() {
    document.body.setAttribute('data-display', getDisplayMode());
    paintDisplayModeButtons();
    if (_displayModeBound) return;
    _displayModeBound = true;
    document.body.addEventListener('click', function (e) {
      const btn = e.target.closest && e.target.closest('.display_mode_btn');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      setDisplayMode(btn.getAttribute('data-display'));
    });
  }
  // Tag every keyboard label cell with both note + degree spans so the
  // CSS display-mode rules can show one or the other. Runs after
  // applyKeyboardColors (which sets data-note on each cell).
  function applyKeyboardLabels(x) {
    const DEG_LBL = ['1','♭2','2','♭3','3','4','♭5','5','♭6','6','♭7','7'];
    const keyPc = NOTE_PC[x.k];
    if (keyPc == null) return;
    document.querySelectorAll('.ritz .waffle [data-note]').forEach(function (el) {
      const note = el.getAttribute('data-note');
      const notePc = NOTE_PC[note];
      if (notePc == null) return;
      const off = (notePc - keyPc + 12) % 12;
      const deg = DEG_LBL[off] || '';
      // Some cells use a softmerge wrapper for the C♯ at the right
      // edge — write to that instead so the layout doesn't break.
      const inner = el.querySelector('.softmerge-inner');
      const tgt = inner || el;
      // Only rewrite if the current content isn't already our two-span
      // form (avoids stomping click handlers / repeated DOM churn).
      if (!tgt.querySelector('.disp_note')) {
        tgt.innerHTML = '<span class="disp_note">' + note + '</span>'
                       + '<span class="disp_deg">' + deg + '</span>';
      } else {
        const ns = tgt.querySelector('.disp_note');
        const ds = tgt.querySelector('.disp_deg');
        if (ns && ns.textContent !== note) ns.textContent = note;
        if (ds && ds.textContent !== deg)  ds.textContent = deg;
      }
    });
  }

  let _instrumentSelectBound = false;
  function bindInstrumentSelect() {
    const $sel = document.getElementById('instrument_select');
    if (!$sel) return;
    // Populate options on first paint (and re-populate if needed).
    if (!$sel._populated) {
      $sel.innerHTML = '';
      const cur = getInstrumentPref();
      Object.keys(TONE_INSTRUMENTS).forEach(function (k) {
        const cfg = TONE_INSTRUMENTS[k];
        const opt = document.createElement('option');
        opt.value = k;
        opt.textContent = cfg.label;
        if (k === cur) opt.selected = true;
        $sel.appendChild(opt);
      });
      $sel._populated = true;
    } else {
      $sel.value = getInstrumentPref();
    }
    if (_instrumentSelectBound) return;
    _instrumentSelectBound = true;
    $sel.addEventListener('change', function (e) {
      e.stopPropagation();
      setInstrumentPref($sel.value);
      // Force the cached Tone instrument to rebuild on next play.
      preWarmTone();
    });
  }

  function bindApplyAllToggle() {
    paintApplyAllToggle();          // always repaint to reflect URL state
    if (_applyAllBound) return;
    const $btn = document.getElementById('apply_all_toggle');
    if (!$btn) return;
    _applyAllBound = true;
    $btn.addEventListener('click', function () {
      const params = new URLSearchParams(window.location.search);
      const wasUnlinked = params.get('u') === '1';
      if (wasUnlinked) {
        // Re-link → snap the global state to the FRETBOARD's current
        // effective view (its overrides become the new globals).
        // virtualSearchForSection already drops u= and every s<n>_*
        // prefix, then folds section_2's overrides on top of globals,
        // so the resulting query is exactly the linked-mode URL we
        // want — no full reset, no other section's overrides leak.
        const newSearch = virtualSearchForSection('section_2', window.location.search);
        navigateTo(newSearch ? ('?' + newSearch) : '?');
      } else {
        // Engage unlinked → flip the flag, leave existing state alone
        // so the current view becomes each section's starting point.
        params.set('u', '1');
        const qs = params.toString();
        navigateTo(qs ? ('?' + qs) : '?');
      }
    });
  }

  // Wire the custom-tuning preset loader. When the user picks a preset
  // from this dropdown, we map the preset's notes (low → high in the
  // data) into s1..sN (high → low — s1 is the topmost / highest string)
  // and navigate. The main x= tuning is left untouched, so the user can
  // mix a different preset's notes into a different-string-count main
  // tuning if they want.
  function bindCustomTuningLoader() {
    const sel = document.querySelector('.custom_tun_loader');
    if (!sel || sel._customLoaderBound) return;
    sel._customLoaderBound = true;
    sel.addEventListener('change', function () {
      const key = sel.value;
      if (!key || !TUNINGS[key]) return;
      const preset = TUNINGS[key];
      const noteList = String(preset.notes).split(/\s+/).reverse(); // high → low
      const params = new URLSearchParams(window.location.search);
      // Drop legacy s1..s12 + the compact s= so we can rewrite cleanly.
      params.delete('s');
      for (let i = 1; i <= 12; i++) params.delete('s' + i);
      const sVals = noteList.slice(0, 12).map(function (n) { return urlNote(n); });
      while (sVals.length && !sVals[sVals.length - 1]) sVals.pop();
      if (sVals.length) {
        // Same encoding as ?x= — note tokens with no separator unless
        // there's an internal gap (which the loader never produces).
        const _hasGap = sVals.some(function (v) { return !v; });
        params.set('s', sVals.join(_hasGap ? '.' : ''));
      }
      const qs = params.toString();
      navigateTo(qs ? '?' + qs : '?');
    });
  }

  // Intercept clicks on any same-page link so we update via pushState
  // instead of triggering a full page navigation. Catches both '?foo=bar'
  // hrefs AND bare-pathname hrefs (which fire when, say, deselecting the last
  // highlight pill empties the query string and the helper returns the path).
  function bindLinkInterceptor() {
    document.body.addEventListener('click', function (e) {
      const a = e.target.closest && e.target.closest('a');
      if (!a) return;
      // Honor modifier-clicks (open in new tab/window) and middle-click
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return;
      const raw = a.getAttribute('href');
      if (!raw) return;
      // Build the URL from the raw href attribute, NOT `a.href`. SVG <a>
      // elements (e.g. inside the Circle of Fifths) expose `a.href` as
      // an SVGAnimatedString, which makes `new URL(a.href, …)` throw and
      // skip our interceptor → browser does a full reload (scrolls to top).
      let url;
      try { url = new URL(raw, window.location.href); } catch (_) { return; }
      // External or different-page links: let the browser handle them.
      if (url.origin !== window.location.origin) return;
      if (url.pathname !== window.location.pathname) return;
      e.preventDefault();
      // "Unlinked" mode → state-mutating clicks (chord cells, scale
      // cells, keysig rows, highlight pills) write section-namespaced
      // params (s<n>_k, s<n>_hl, s<n>_x, ...) onto the CURRENT URL
      // instead of replacing it. This way other sections keep their
      // overrides AND the unlinked state survives reload + share.
      const unlinked = document.body.getAttribute('data-apply-all') === 'off';
      if (unlinked) {
        const sectionEl = a.closest('details.section, details.collapsible');
        if (sectionEl) {
          const merged = mergeSectionOverrideUrl(sectionEl.id, url.search || '');
          if (merged != null) {
            navigateTo(merged);
            return;
          }
        }
      }
      // Site-wide Clear: navigate to a truly bare URL — skip the
      // PRESERVE merge so c=, disp, inst, qpc, idc, sort, ord, etc.
      // all get wiped from the URL. localStorage is left intact so
      // the user's section open/close preferences (and other per-
      // browser settings) survive.
      if (a.id === 'site_clear') {
        navigateTo(url.search || '?');
        return;
      }
      // Before snapshotting the URL, flush the collapse state to URL
      // synchronously. The <details> toggle event is async; without
      // this flush, clicking a link RIGHT AFTER opening a section
      // would navigate using a stale URL whose c= still listed the
      // section as closed — and applyCollapseFromUrl on the new URL
      // would slam the section back shut.
      if (typeof updateClosedInUrl === 'function') {
        try { updateClosedInUrl(); } catch (_) {}
      }
      // Merge persistence-only params (collapsed sections, display
      // mode, instrument, qp/id closed lists, progressions, sort,
      // etc.) from the CURRENT URL into the navigation target. The
      // chip's href only carries state-driving keys (k/x/y/z/s/pk +
      // hl); everything else lives in window.location and must be
      // folded in fresh at click time — NOT baked into the href at
      // render time, because params like c= change every time the
      // user opens/closes a section.
      const PRESERVE = ['c', 'disp', 'inst', 'qpc', 'idc',
                        'prog', 'pmode', 'tempo',
                        'sort', 'td', 'fc', 'fcp', 'ext', 'ik', 'cmp'];
      const target = new URLSearchParams((url.search || '').replace(/^\?/, ''));
      const cur    = new URLSearchParams(window.location.search);
      PRESERVE.forEach(function (k) {
        if (target.has(k)) return;        // href already set this key
        if (!cur.has(k))   return;        // nothing to carry over
        cur.getAll(k).forEach(function (v) { target.append(k, v); });
      });
      const qs = canonicalQS(target);
      navigateTo(qs ? '?' + qs : '?');
    });
  }

  // ---------- print colors (always on) ----------
  function applyPrintColors() {
    document.body.classList.add('print-colors');
  }

  // ---------- tunings sort + filter (URL-backed) ----------
  function applyTuningsSort(x) {
    if (!x._sort) return;
    const table = document.getElementById('tunings');
    if (!table || !table._sortableInstance) return;
    const ths = table.querySelectorAll('thead th');
    const col = x._sort.col;
    if (col < 0 || col >= ths.length) return;
    const ariaSort = x._sort.dir === 'd' ? 'descending' : 'ascending';
    ths.forEach(function (t) { t.removeAttribute('aria-sort'); });
    ths[col].setAttribute('aria-sort', ariaSort);
    table._sortableInstance.sortColumn(col, ariaSort, ths[col].classList.contains('num'));
  }

  function bindTuningsSortObserver() {
    const table = document.getElementById('tunings');
    if (!table) return;
    table.querySelectorAll('thead th button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        // SortableTable's handler runs first (bound earlier); we read aria-sort after
        const ths = table.querySelectorAll('thead th');
        let col = -1, dir = null;
        for (let i = 0; i < ths.length; i++) {
          const a = ths[i].getAttribute('aria-sort');
          if (a) { col = i; dir = a === 'descending' ? 'd' : 'a'; break; }
        }
        const params = new URLSearchParams(window.location.search);
        if (col >= 0 && dir) params.set('sort', col + ':' + dir);
        else params.delete('sort');
        const qs = canonicalQS(params);
        history.replaceState({}, '', qs ? '?' + qs : window.location.pathname);
      });
    });
  }

  // Filter the visible tunings table rows by both the text filter (matches
  // any cell's text, multi-token AND search) and the active string-count
  // button (6/8/10/12 or All). Either or both may be empty.
  function applyTuningsFilter(textValue, strsValue) {
    const table = document.getElementById('tunings');
    if (!table) return;
    const txt = String(textValue || '').toLowerCase().trim();
    const toks = txt ? txt.split(/\s+/) : [];
    const wantStrs = String(strsValue || '');
    table.querySelectorAll('tbody tr').forEach(function (tr) {
      const cells = tr.querySelectorAll('td');
      if (!cells.length) { tr.style.display = 'none'; return; }
      // First cell is the "N-String" label — pull the leading number out.
      const strsHere = String((cells[0].textContent || '').match(/^\d+/) || '');
      if (wantStrs && wantStrs !== strsHere) { tr.style.display = 'none'; return; }
      if (toks.length) {
        const hay = Array.prototype.map.call(cells, function (td) {
          return (td.textContent || '').toLowerCase();
        }).join(' ');
        const allMatch = toks.every(function (t) { return hay.indexOf(t) !== -1; });
        if (!allMatch) { tr.style.display = 'none'; return; }
      }
      tr.style.display = '';
    });
  }

  let _filterDebounce = null;
  function bindTuningsFilter() {
    const input = document.getElementById('filter');
    const root = document.getElementById('tunings_root');
    if (!input || !root) return;

    // Read current state from URL on bind so re-renders pick up persisted vals
    function urlState() {
      const p = new URLSearchParams(window.location.search);
      return {
        text: (p.get('f') || ''),
        strs: (function () {
          const v = p.get('fc');
          return (v === '4' || v === '5' || v === '6' || v === '8' || v === '10' || v === '12') ? v : '';
        })()
      };
    }
    function persist(text, strs) {
      const params = new URLSearchParams(window.location.search);
      if (text) params.set('f', text); else params.delete('f');
      if (strs) params.set('fc', strs); else params.delete('fc');
      const qs = canonicalQS(params);
      history.replaceState({}, '', qs ? '?' + qs : window.location.pathname);
    }
    function refresh() {
      const s = urlState();
      applyTuningsFilter(s.text, s.strs);
      // Sync button active states with URL
      root.querySelectorAll('.tunings_str_btn').forEach(function (btn) {
        const v = btn.getAttribute('data-strs') || '';
        if (v === s.strs) btn.classList.add('active');
        else btn.classList.remove('active');
        btn.setAttribute('aria-checked', v === s.strs ? 'true' : 'false');
      });
    }

    refresh();

    // Input listener attaches per-render (input is recreated each time).
    input.addEventListener('input', function () {
      const value = String(input.value || '').slice(0, 64);
      if (input.value !== value) input.value = value;
      const s = urlState();
      applyTuningsFilter(value, s.strs);
      if (_filterDebounce) clearTimeout(_filterDebounce);
      _filterDebounce = setTimeout(function () { persist(value, s.strs); }, 300);
    });

    // Click delegate on the stable parent — guard against multiple
    // re-renders stacking redundant listeners on the same root.
    if (root._fcBound) return;
    root._fcBound = true;
    root.addEventListener('click', function (e) {
      const btn = e.target.closest && e.target.closest('.tunings_str_btn');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const want = btn.getAttribute('data-strs') || '';
      const cur = urlState();
      const nextStrs = (cur.strs === want) ? '' : want;
      persist(cur.text, nextStrs);
      refresh();
    });
    // Whole-row click → trigger that row's first anchor link (the
    // tuning's name / notes cell). Lets the user click anywhere in
    // the row instead of having to hit the small text targets.
    root.addEventListener('click', function (e) {
      // Bail when the click was on something interactive — input,
      // button, header (sort), or an anchor (let the link interceptor
      // handle that). Otherwise translate the row click into a click
      // on the first anchor in that row.
      if (e.target.closest('a, button, input, th, .tunings_filter_bar')) return;
      const tr = e.target.closest && e.target.closest('#tunings tbody tr');
      if (!tr) return;
      const a = tr.querySelector('a[href]');
      if (!a) return;
      a.click();
    });
  }

  // ---------- collapsible-section state persistence ----------
  // URL is the source of truth: ?c=2,3 means sections 2 and 3 are closed.
  // localStorage is kept as a fallback when the URL has no 'c' param, so a
  // user who collapses a section then revisits without a query string still
  // gets their preferred view.

  function applyCollapseFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const cParam = params.get('c');
    const fromUrl = cParam !== null;
    const closedSet = fromUrl ? new Set(cParam.split(',').filter(function (s) { return s.length; })) : null;

    // Guard the toggle handlers — when applyCollapseFromUrl restores state
    // from localStorage on page load, removing the `open` attr fires a
    // <details> "toggle" event that would otherwise write c=… back to
    // the URL bar immediately. Suppress that during initial restore so a
    // bare URL stays bare.
    _suppressCollapseUrl = true;
    document.querySelectorAll('details.collapsible').forEach(function (d) {
      const num = d.id.replace('section_', '');
      let isClosed;
      if (fromUrl) {
        isClosed = closedSet.has(num);
      } else {
        let saved = null;
        try { saved = window.localStorage.getItem('sf_collapse_' + d.id); } catch (e) {}
        if (saved === null) {
          // First visit (no URL state, no localStorage memory): every main
          // section opens, but the nested Tunings List starts collapsed so
          // the page isn't dominated by the 172-row table on load.
          isClosed = (d.id === 'section_5');
        } else {
          isClosed = saved === 'closed';
        }
      }
      if (isClosed) d.removeAttribute('open'); else d.setAttribute('open', '');
      // Sync LS to whatever we just resolved. The toggle event would
      // normally do this, but it fires asynchronously and can lag
      // behind a follow-up navigation — so if a user opened a section
      // and immediately clicked a link inside, the next applyState
      // could re-read a stale LS='closed' and slam the section shut.
      try { window.localStorage.setItem('sf_collapse_' + d.id, isClosed ? 'closed' : 'open'); } catch (e) {}
    });
    // Clear the guard on the next tick so any user-triggered toggles
    // dispatched after this microtask still write to the URL normally.
    setTimeout(function () { _suppressCollapseUrl = false; }, 0);
  }
  let _suppressCollapseUrl = false;

  // ---------- Section reordering (drag-and-drop) ----------
  function _sectionEls() {
    return Array.prototype.slice.call(
      document.querySelectorAll('body > details.collapsible.section')
    );
  }
  function _sectionNum(el) {
    const m = el && el.id && el.id.match(/^section_(\d+)$/);
    return m ? m[1] : null;
  }
  function _defaultSectionOrder() {
    // Whatever order the static index.html ships in. Cached on first
    // call so a later DOM reorder doesn't change the "default".
    if (!_defaultSectionOrder._cached) {
      _defaultSectionOrder._cached = _sectionEls().map(_sectionNum).filter(Boolean);
    }
    return _defaultSectionOrder._cached.slice();
  }
  function applySectionOrder() {
    const def = _defaultSectionOrder();
    if (!def.length) return;
    const want = (getSetting('section_order') || []).filter(function (n) {
      return def.indexOf(n) !== -1;
    });
    if (!want.length) { updateResetOrderVisibility(); return; }
    // Final order = saved-order entries first (in their saved order),
    // then any section not mentioned in saved order (in default order).
    const seen = new Set(want);
    const finalOrder = want.concat(def.filter(function (n) { return !seen.has(n); }));
    // Re-attach each section ahead of the footer in finalOrder.
    // insertBefore moves the element if it's already in the DOM, so
    // we don't need to detach first. We anchor on the footer (NOT on
    // body.appendChild) so the footer stays at the end of the page.
    const footer = document.getElementById('site_footer');
    finalOrder.forEach(function (num) {
      const el = document.getElementById('section_' + num);
      if (!el) return;
      if (footer) document.body.insertBefore(el, footer);
      else        document.body.appendChild(el);
    });
    updateResetOrderVisibility();
  }
  function _currentDomOrder() {
    return _sectionEls().map(_sectionNum).filter(Boolean);
  }
  function _orderEquals(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function persistSectionOrderFromDom() {
    const cur = _currentDomOrder();
    const def = _defaultSectionOrder();
    setSetting('section_order', _orderEquals(cur, def) ? [] : cur);
    updateResetOrderVisibility();
  }
  function updateResetOrderVisibility() {
    const link = document.getElementById('reset_section_order');
    if (!link) return;
    const cur = _currentDomOrder();
    const def = _defaultSectionOrder();
    link.style.display = _orderEquals(cur, def) ? 'none' : '';
  }
  function injectDragHandles() {
    _sectionEls().forEach(function (sec) {
      const summary = sec.querySelector(':scope > summary');
      if (!summary) return;
      if (summary.querySelector(':scope > .section_drag')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'section_drag';
      btn.setAttribute('draggable', 'true');
      btn.setAttribute('aria-label', 'Drag to reorder section');
      btn.setAttribute('title', 'Drag to reorder section');
      btn.textContent = '⋮⋮';
      // Inside summary so it stays visible when the section is
      // collapsed (the rest of details > content is display:none).
      // First child = leftmost. Clicks on the handle must NOT toggle
      // the details — click handler below preventDefaults.
      summary.insertBefore(btn, summary.firstChild);
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
      });
    });
  }
  let _dragSourceEl = null;
  function bindSectionDrag() {
    if (document.body._sectionDragBound) return;
    document.body._sectionDragBound = true;

    document.body.addEventListener('dragstart', function (e) {
      const handle = e.target.closest && e.target.closest('.section_drag');
      if (!handle) return;
      const section = handle.closest('details.collapsible.section');
      if (!section) return;
      _dragSourceEl = section;
      section.classList.add('section_dragging');
      try {
        e.dataTransfer.effectAllowed = 'move';
        // Firefox requires non-empty dataTransfer to fire a drag.
        e.dataTransfer.setData('text/plain', section.id);
      } catch (_) {}
    });

    document.body.addEventListener('dragend', function (e) {
      const handle = e.target.closest && e.target.closest('.section_drag');
      if (!handle) return;
      _sectionEls().forEach(function (s) {
        s.classList.remove('section_dragging');
        s.classList.remove('section_drop_before');
        s.classList.remove('section_drop_after');
      });
      _dragSourceEl = null;
    });

    // Find the section whose rect's vertical range contains clientY.
    // If the cursor is in a gap between sections (or below the last
    // one), snap to the nearest section — drop areas are effectively
    // unbounded vertically, so a drag can land in the empty space
    // between two sections without losing the drop.
    function _sectionAtY(clientY) {
      const sections = _sectionEls().filter(function (s) { return s !== _dragSourceEl; });
      if (!sections.length) return null;
      let inside = null;
      let nearest = null;
      let nearestDist = Infinity;
      for (let i = 0; i < sections.length; i++) {
        const r = sections[i].getBoundingClientRect();
        if (clientY >= r.top && clientY <= r.bottom) { inside = sections[i]; break; }
        const d = clientY < r.top ? (r.top - clientY) : (clientY - r.bottom);
        if (d < nearestDist) { nearestDist = d; nearest = sections[i]; }
      }
      return inside || nearest;
    }
    function _clearAllDropIndicators() {
      _sectionEls().forEach(function (s) {
        s.classList.remove('section_drop_before');
        s.classList.remove('section_drop_after');
      });
    }

    document.body.addEventListener('dragover', function (e) {
      if (!_dragSourceEl) return;
      // ALWAYS preventDefault during a section drag, even when the
      // cursor isn't directly over a section. Without this, the
      // browser rejects the drop the instant the cursor drifts off
      // a section (or onto a non-section element like body padding).
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
      const target = _sectionAtY(e.clientY);
      if (!target) { _clearAllDropIndicators(); return; }
      const r = target.getBoundingClientRect();
      // Cursor in upper half (or above the section entirely) → drop
      // BEFORE the section. Lower half (or below it) → drop AFTER.
      const above = (e.clientY < r.top) || ((e.clientY - r.top) < (r.height / 2));
      _sectionEls().forEach(function (s) {
        if (s === target) {
          s.classList.toggle('section_drop_before', above);
          s.classList.toggle('section_drop_after', !above);
        } else {
          s.classList.remove('section_drop_before');
          s.classList.remove('section_drop_after');
        }
      });
    });

    document.body.addEventListener('drop', function (e) {
      if (!_dragSourceEl) return;
      e.preventDefault();
      const target = _sectionAtY(e.clientY);
      if (!target || target === _dragSourceEl) return;
      const r = target.getBoundingClientRect();
      const above = (e.clientY < r.top) || ((e.clientY - r.top) < (r.height / 2));
      if (above) target.parentNode.insertBefore(_dragSourceEl, target);
      else       target.parentNode.insertBefore(_dragSourceEl, target.nextSibling);
      persistSectionOrderFromDom();
    });
  }

  function bindResetSectionOrder() {
    const link = document.getElementById('reset_section_order');
    if (!link || link._bound) return;
    link._bound = true;
    link.addEventListener('click', function (e) {
      e.preventDefault();
      // Restore the static index.html order, keeping the footer last.
      const def = _defaultSectionOrder();
      const footer = document.getElementById('site_footer');
      def.forEach(function (num) {
        const el = document.getElementById('section_' + num);
        if (!el) return;
        if (footer) document.body.insertBefore(el, footer);
        else        document.body.appendChild(el);
      });
      setSetting('section_order', []);
      updateResetOrderVisibility();
    });
  }

  function updateClosedInUrl() {
    const params = new URLSearchParams(window.location.search);
    const closed = [];
    document.querySelectorAll('details.collapsible').forEach(function (d) {
      if (!d.open) closed.push(d.id.replace('section_', ''));
    });
    if (closed.length) params.set('c', closed.join(','));
    else params.delete('c');
    const qs = canonicalQS(params);
    const target = qs ? '?' + qs : window.location.pathname;
    if (target === window.location.pathname + window.location.search) return;
    if (target === window.location.search) return;
    // replaceState — don't pollute history with every collapse toggle
    history.replaceState({}, '', target);
  }

  function bindCollapsibles() {
    document.querySelectorAll('details.collapsible').forEach(function (d) {
      if (d._collapseBound) return;
      d._collapseBound = true;
      d.addEventListener('toggle', function () {
        try { window.localStorage.setItem('sf_collapse_' + d.id, d.open ? 'open' : 'closed'); } catch (e) {}
        // Only push c=… to the URL on real user toggles. Suppressed during
        // applyCollapseFromUrl's initial DOM-attribute restore so bare URLs
        // don't gain a c=… param the moment the page loads.
        if (!_suppressCollapseUrl) updateClosedInUrl();
      });
    });

    // Force the fretboard open during print so collapsed-state doesn't suppress it
    const fb = document.getElementById('section_2');
    if (fb && !fb._printBound) {
      fb._printBound = true;
      let restoreClosed = false;
      window.addEventListener('beforeprint', function () {
        restoreClosed = !fb.open;
        if (restoreClosed) fb.open = true;
      });
      window.addEventListener('afterprint', function () {
        if (restoreClosed) fb.open = false;
      });
    }
  }

  // ---------- keyboard color override (per current key) ----------
  // Map each note to the keyboard cell classes that visually represent it.
  // White-note positions get a background color; black-note positions get a text color
  // (the cell itself stays dark, only the "A♯" / "C♯" / etc. label gets tinted).
  // `cls`  = every cell that should pick up the bg/color tint for this note
  //          (white-note columns also tint a small spacer cell on the black-key
  //          row above so the column reads as one tinted strip).
  // `lbl`  = the subset of those cells that actually display the note letter
  //          (e.g. "A", "C♯"). Only these get the `::after` degree label so we
  //          don't print the degree twice on white keys (once on the spacer
  //          above and once on the white-key cell below).
  const KEYBOARD_NOTE_CLASSES = {
    'A':  { mode: 'bg',    cls: ['s32', 's47'], lbl: ['s47'] },
    'B':  { mode: 'bg',    cls: ['s34', 's48'], lbl: ['s48'] },
    'C':  { mode: 'bg',    cls: ['s35', 's49'], lbl: ['s49'] },
    'D':  { mode: 'bg',    cls: ['s37', 's50'], lbl: ['s50'] },
    'E':  { mode: 'bg',    cls: ['s39', 's51'], lbl: ['s51'] },
    'F':  { mode: 'bg',    cls: ['s40', 's52'], lbl: ['s52'] },
    'G':  { mode: 'bg',    cls: ['s42', 's53'], lbl: ['s53'] },
    'A♯': { mode: 'color', cls: ['s33', 's44'], lbl: ['s33', 's44'] },
    'C♯': { mode: 'color', cls: ['s36', 's45'], lbl: ['s36', 's45'] },
    'D♯': { mode: 'color', cls: ['s38'],        lbl: ['s38'] },
    'F♯': { mode: 'color', cls: ['s41'],        lbl: ['s41'] },
    'G♯': { mode: 'color', cls: ['s43'],        lbl: ['s43'] }
  };
  const KEYBOARD_DEGREE_COLORS = {
    '1':  '#ff0000', '♭2': '#674ea7', '2':  '#9900ff',
    '♭3': '#f6b26b', '3':  '#ff6d01', '4':  '#00ffff',
    '♭5': '#3d85c6', '5':  '#0000ff',
    '♭6': '#6aa84f', '6':  '#0cc016',
    '♭7': '#a64d79', '7':  '#ff00ff'
  };

  function applyKeyboardColors(x) {
    let style = document.getElementById('keyboard_dynamic_style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'keyboard_dynamic_style';
      document.head.appendChild(style);
    }
    // Tag every keyboard label cell with data-note so the click-to-pick
    // delegated handler can read it. We set this each render in case the
    // keyboard DOM was just rebuilt.
    for (const note in KEYBOARD_NOTE_CLASSES) {
      const def = KEYBOARD_NOTE_CLASSES[note];
      (def.lbl || def.cls).forEach(function (c) {
        document.querySelectorAll('.ritz .waffle .' + c).forEach(function (el) {
          el.setAttribute('data-note', note);
        });
      });
    }
    // Assign data-midi by walking white- and black-key cells in DOM order.
    // The visible piano spans A0 (MIDI 21) → C8 (MIDI 108). White keys
    // step through the diatonic offsets [0,2,3,5,7,8,10] from each A.
    // Black keys step through [1,4,6,9,11].
    (function () {
      const tbl = document.getElementById('keyboard');
      if (!tbl) return;
      const rows = tbl.querySelectorAll('tr');
      // Find the black-key and white-key rows by inspecting their first td label.
      let whiteRow = null, blackRow = null;
      rows.forEach(function (r) {
        const first = r.querySelector('td');
        if (!first) return;
        const txt = (first.textContent || '').trim().toLowerCase();
        if (txt === 'white keys') whiteRow = r;
        else if (txt === 'black keys') blackRow = r;
      });
      const WHITE_OFF = [0, 2, 3, 5, 7, 8, 10];   // A B C D E F G from A
      const BLACK_OFF = [1, 4, 6, 9, 11];         // A♯ C♯ D♯ F♯ G♯
      function assign(row, offs) {
        if (!row) return;
        const cells = row.querySelectorAll('td[data-note]');
        cells.forEach(function (cell, idx) {
          const cycle = Math.floor(idx / offs.length);
          const pos   = idx % offs.length;
          const midi  = 21 + 12 * cycle + offs[pos];
          cell.setAttribute('data-midi', String(midi));
        });
      }
      assign(whiteRow, WHITE_OFF);
      assign(blackRow, BLACK_OFF);
    })();
    // If any highlights are set, dim notes outside the set so the chosen ones pop.
    // White keys dimmed → plain white bg with text close to white (label fades).
    // Black keys dimmed → label color close to the dark cell bg (also fades).
    const anyHighlighted = DEGREES.some(function (d) {
      return x['hl_' + d.replace('♭', 'b')] === 'y';
    });
    // Real piano: white keys are white, black keys are dark. Dimmed = label fades into bg.
    // Match the fretboard's light-grey "tabletop" so both reference surfaces feel the same.
    const DIM_WHITE_BG    = '#a8a8a8';
    const DIM_WHITE_TEXT  = '#888888';   // readable medium grey on the light bg
    const DIM_BLACK_TEXT  = '#3a3a3a';   // visible-but-quiet on the dark cell bg

    // Plain-piano colours used when no highlights are set: clean white keys
    // with black text + dark black keys with white text. The degree label
    // below each note stays so users still see the relationship to the
    // current key, just rendered in a neutral muted tone.
    const PLAIN_WHITE_BG   = '#f4f4f4';
    const PLAIN_WHITE_TEXT = '#111';
    const PLAIN_BLACK_BG   = '#1a1a1a';
    const PLAIN_BLACK_TEXT = '#f4f4f4';
    const PLAIN_DEG_ON_WHITE = '#666';
    const PLAIN_DEG_ON_BLACK = '#bbb';

    const i1 = KEYS.indexOf(x.k);
    let css = '';
    for (const note in KEYBOARD_NOTE_CLASSES) {
      const noteIdx = KEYS.indexOf(note);
      const semi = ((noteIdx - i1) + 12) % 12;
      const deg = DEGREES[semi];
      const inHighlightSet = anyHighlighted && (x['hl_' + deg.replace('♭', 'b')] === 'y');
      const def = KEYBOARD_NOTE_CLASSES[note];
      // Yellow-ring pk picks are gone; chord ID now reads from hl,
      // and clicks toggle hl directly. Keyboard cells get only the
      // colored hl background (below) — no extra inset stroke.
      def.cls.forEach(function (c) {
        const sel = '.ritz .waffle .' + c;
        if (def.mode === 'bg') {
          // White-key column.
          if (inHighlightSet) {
            // Highlighted note: degree-coloured bg + dark label.
            css += sel + ' { background-color: ' + KEYBOARD_DEGREE_COLORS[deg] + ' !important; '
                  +       'color: #000 !important; }\n';
          } else if (anyHighlighted) {
            // Some other note is highlighted: keep the plain white bg but
            // dim the label to a middle grey so the highlighted notes pop.
            css += sel + ' { background-color: ' + PLAIN_WHITE_BG + ' !important; '
                  +       'color: ' + DIM_WHITE_TEXT + ' !important; }\n';
          } else {
            // No highlights anywhere: plain piano look.
            css += sel + ' { background-color: ' + PLAIN_WHITE_BG + ' !important; '
                  +       'color: ' + PLAIN_WHITE_TEXT + ' !important; }\n';
          }
        } else {
          // Black-key cell.
          if (inHighlightSet) {
            css += sel + ' { background-color: ' + PLAIN_BLACK_BG + ' !important; '
                  +       'color: ' + KEYBOARD_DEGREE_COLORS[deg] + ' !important; }\n';
          } else if (anyHighlighted) {
            // Dim non-highlighted black keys' labels to the same middle grey.
            css += sel + ' { background-color: ' + PLAIN_BLACK_BG + ' !important; '
                  +       'color: ' + DIM_BLACK_TEXT + ' !important; }\n';
          } else {
            css += sel + ' { background-color: ' + PLAIN_BLACK_BG + ' !important; '
                  +       'color: ' + PLAIN_BLACK_TEXT + ' !important; }\n';
          }
        }
      });

      // Add the degree (e.g. "1", "♭3") on a second line below the note label.
      // Only on cells that actually carry the note letter (avoids duplicate
      // labels on the spacer cells above each white key).
      (def.lbl || def.cls).forEach(function (c) {
        const sel = '.ritz .waffle .' + c;
        let degColor;
        if (def.mode === 'bg') {
          degColor = inHighlightSet     ? '#000'
                   : anyHighlighted     ? DIM_WHITE_TEXT
                                        : PLAIN_DEG_ON_WHITE;
        } else {
          degColor = inHighlightSet     ? KEYBOARD_DEGREE_COLORS[deg]
                   : anyHighlighted     ? DIM_BLACK_TEXT
                                        : PLAIN_DEG_ON_BLACK;
        }
        css += sel + '::after { content: "(' + escapeCssString(deg) + ')"; display: block; '
                  +  'font-size: 0.78em; line-height: 1; opacity: 0.85; '
                  +  'color: ' + degColor + '; }\n';
      });
    }
    style.textContent = css;
  }

  // ---------- click-to-pick + chord identifier ----------
  // Pitch-class index used by the chord-identifier lookup. MUST match the
  // C-indexed numbering in js/chord_lookup.js (C=0, C♯=1, ..., B=11).
  // Don't be tempted to derive this from ALLNOTES — that's A-indexed and
  // would put the masks one fifth away from where they belong.
  const NOTE_TO_PC = {
    'C': 0, 'C♯': 1, 'D': 2, 'D♯': 3, 'E': 4, 'F': 5,
    'F♯': 6, 'G': 7, 'G♯': 8, 'A': 9, 'A♯': 10, 'B': 11
  };
  const PC_TO_NOTE = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];

  // "+N" cap for the "Selected ⊂ Chord" identify bucket — handled by
  // the unified settings registry: URL `ext=2` / `ext=all` plus
  // localStorage fallback. Default 1.
  function getIdentifyInKey() { return !!getSetting('inkey'); }
  function setIdentifyInKey(v) { setSetting('inkey', !!v); applyState(); }
  function getIdentifyExtras() { return getSetting('extras'); }
  function setIdentifyExtras(v) {
    setSetting('extras', v);
    if (window.SF_X) {
      // Re-render with the same per-section states we last saw.
      const xFB = stateForSection('section_2', window.SF_X);
      const xKB = stateForSection('section_4', window.SF_X);
      renderIdentifyStrips(xFB, xKB);
    }
  }

  // Toggle the clicked note in the pk= URL list. Suppresses default link
  // behavior so the page stays put; uses the same history.replaceState path
  // as the rest of the navigation (via the shared link interceptor), so the
  // app re-renders in place.
  function bindNotePick() {
    function handler(e) {
      const cell = e.target.closest && e.target.closest('[data-note]');
      if (!cell) return;
      // Don't capture clicks on form controls inside cells (the s1..sN selects).
      if (e.target.closest('select, input, button, a')) return;
      let note = cell.getAttribute('data-note');
      if (!note) return;
      // Normalize flat-spelled tuning notes (e.g. nut "B♭") into the
      // sharp form everything internal uses, so toggling a flat-named
      // cell matches degree math anchored on sharps.
      const _FLAT_TO_SHARP = { 'A♭':'G♯','B♭':'A♯','C♭':'B','D♭':'C♯','E♭':'D♯','F♭':'E','G♭':'F♯' };
      note = _FLAT_TO_SHARP[note] || note;
      e.preventDefault();
      // Audio playback (off by default, toggled via the ♪ button in the
      // Fretboard summary). Reads data-midi from the cell.
      if (audioOn()) {
        const midiStr = cell.getAttribute('data-midi');
        const m = midiStr ? parseInt(midiStr, 10) : NaN;
        if (!isNaN(m)) playMidi(m);
      }
      const _isKb = !!e.target.closest('.ritz');
      // Click-to-toggle now writes hl (color highlights) — same as
      // clicking a note pill above the section. Yellow-ring pk picks
      // are gone; chord ID reads from hl.
      const x = window.SF_X || {};
      const key = x.k || 'C';
      const tonicPc = NOTE_TO_PC[key];
      const notePc  = NOTE_TO_PC[note];
      if (tonicPc == null || notePc == null) return;
      const off = (notePc - tonicPc + 12) % 12;
      const DEG_LBL = ['1','♭2','2','♭3','3','4','♭5','5','♭6','6','♭7','7'];
      const deg = DEG_LBL[off];
      const curArr = hlStrToArr(x.hl);
      const i = curArr.indexOf(deg);
      const next = i === -1 ? curArr.concat([deg]) : curArr.filter(function (d) { return d !== deg; });
      const href = buildHlHref(next);
      const qs = href.slice(1);
      const newUrl = window.location.pathname + (qs ? '?' + canonicalQS(new URLSearchParams(qs)) : '');
      // Anchor scroll to the clicked element so the page doesn't appear to
      // shift when the identify strip grows / shrinks above it. The fretboard
      // table is rebuilt by applyState; the keyboard table is static. Either
      // way we find the anchor again by id/class after the re-render and
      // compensate for any vertical delta.
      const anchorSel = _isKb ? '#section_4' : '#fretboard';
      const anchorBefore = (function () {
        const el = document.querySelector(anchorSel);
        return el ? el.getBoundingClientRect().top : null;
      })();
      history.replaceState(null, '', newUrl);
      applyState();
      if (anchorBefore !== null) {
        const el = document.querySelector(anchorSel);
        if (el) {
          const delta = el.getBoundingClientRect().top - anchorBefore;
          if (delta) window.scrollBy(0, delta);
        }
      }
    }
    const fb = document.getElementById('fretboard');
    if (fb && !fb._pickBound) {
      fb._pickBound = true;
      fb.addEventListener('click', handler);
    }
    document.querySelectorAll('.ritz .waffle [data-note]').forEach(function (el) {
      // Visual cue that keys are clickable
      el.style.cursor = 'pointer';
    });
    const kb = document.querySelector('.ritz .waffle');
    if (kb && !kb._pickBound) {
      kb._pickBound = true;
      kb.addEventListener('click', handler);
    }
  }

  // ---------- chord identify strip ----------
  // Convert a pk Set (notes like "A","C♯") to a 12-bit pitch-class mask.
  function pkSetToMask(pkSet) {
    let m = 0;
    pkSet.forEach(function (n) {
      const pc = NOTE_TO_PC[n];
      if (pc !== undefined) m |= (1 << pc);
    });
    return m;
  }
  // Degree-string offsets used to project hl onto an absolute pitch
  // class. '1'→0, '♭2'→1, '2'→2, … '7'→11. Accepts either ♭ or 'b'.
  const _DEG_OFFSET = {
    '1': 0,  '♭2': 1, 'b2': 1, '2': 2,
    '♭3': 3, 'b3': 3, '3': 4, '4': 5,
    '♭5': 6, 'b5': 6, '5': 7,
    '♭6': 8, 'b6': 8, '6': 9,
    '♭7':10, 'b7':10, '7':11
  };
  // Convert an hl-degree array (e.g. ['1','♭3','5']) to a 12-bit pitch
  // class mask anchored at `key`. Empty / null returns 0.
  function hlArrToMask(hlArr, key) {
    if (!hlArr || !hlArr.length) return 0;
    const tonic = NOTE_TO_PC[key];
    if (tonic == null) return 0;
    let m = 0;
    hlArr.forEach(function (d) {
      const off = _DEG_OFFSET[d];
      if (off != null) m |= 1 << ((tonic + off) % 12);
    });
    return m;
  }
  // Parse xs.hl ("1 ♭3 5" / "nothing" / "") into a clean degree array.
  function hlStrToArr(hlStr) {
    const s = String(hlStr || '').trim();
    if (!s || s === 'nothing') return [];
    return s.split(/\s+/).filter(Boolean);
  }
  // Build a URL that replaces hl= with the given degree array (or
  // strips it when empty). Preserves every other URL param.
  function buildHlHref(degArr) {
    const p = new URLSearchParams(window.location.search);
    p.delete('hl');
    if (degArr && degArr.length) {
      // Separator-free form (same shape as the rest of the site).
      const enc = degArr.slice().sort(function (a, b) {
        const ao = _DEG_OFFSET[a]; const bo = _DEG_OFFSET[b];
        return (ao == null ? 99 : ao) - (bo == null ? 99 : bo);
      }).map(function (d) { return d.replace('♭', 'b'); }).join('');
      p.append('hl', enc);
    }
    // No specific chord chip is engaged when the user is hand-building
    // a highlight set — drop idn so no chip lights up spuriously.
    p.delete('idn');
    return '?' + canonicalQS(p);
  }
  function popcount(n) {
    let c = 0;
    while (n) { n &= n - 1; c++; }
    return c;
  }

  // Score chords against the picks. Returns three arrays:
  //   exact:     chord.mask == sel
  //   subset:    chord.mask ⊂ sel  (chord lives inside what you played)
  //   superset:  sel ⊂ chord.mask  (you played part of a chord), capped by
  //              the +N extras setting
  // 12-bit pitch-class mask of the major scale of `key`. Returns 0xFFF
  // (all bits set, i.e. no filtering) when key is unknown so a bad key
  // never silently hides every chord.
  function _majorKeyPcMask(key) {
    const root = NOTE_TO_PC[key];
    if (root == null) return 0xFFF;
    const STEPS = [0, 2, 4, 5, 7, 9, 11];
    let mask = 0;
    STEPS.forEach(function (s) { mask |= 1 << ((root + s) % 12); });
    return mask;
  }
  function classifyChords(selMask, keyMask, rootKey) {
    const data = (window.SLANT_CHORDS && window.SLANT_CHORDS.chords) || [];
    const selSize = popcount(selMask);
    const exact = [];
    const subset = [];
    const superset = [];
    const extrasCap = getIdentifyExtras();
    // "in key" filter is now a ROOT-only filter: keep chords whose root
    // letter matches the current key (e.g. key=E → only E*, key=F♯ →
    // only F♯*). The keyMask scale-check is kept for backwards-compat
    // callers that still pass a non-default mask.
    const filterKey = (typeof keyMask === 'number' && keyMask !== 0xFFF);
    const rootFilter = (typeof rootKey === 'string' && rootKey.length) ? rootKey : null;
    function chordRoot(name) {
      const m = String(name).match(/^([A-G][♯♭]?)/);
      return m ? m[1] : '';
    }
    for (let i = 0; i < data.length; i++) {
      const m = data[i][0];
      const name = data[i][1];
      if (rootFilter && chordRoot(name) !== rootFilter) continue;
      if (filterKey && (m & ~keyMask & 0xFFF) !== 0) continue;
      if (m === selMask) {
        exact.push(name);
        continue;
      }
      // chord ⊂ sel: every chord bit is set in sel
      if ((m & selMask) === m && m !== 0 && m !== selMask) {
        subset.push({ name: name, size: popcount(m) });
        continue;
      }
      // sel ⊂ chord: every sel bit is set in chord, with a cap on extras
      if ((m & selMask) === selMask && m !== selMask) {
        const extras = popcount(m) - selSize;
        if (extras <= extrasCap) superset.push({ name: name, extras: extras });
      }
    }
    // Sort: subset by chord size desc, then name; superset by extras asc, then name
    subset.sort(function (a, b) {
      if (a.size !== b.size) return b.size - a.size;
      return a.name.localeCompare(b.name);
    });
    superset.sort(function (a, b) {
      if (a.extras !== b.extras) return a.extras - b.extras;
      return a.name.localeCompare(b.name);
    });
    return { exact: exact.sort(), subset: subset, superset: superset };
  }

  // Build a URL that pre-loads the chord — we set k= to the chord's root and
  // hl= to its degrees relative to that root. Strip pk= so the user moves
  // from "what is this?" to "show me this chord on the board" cleanly.
  function applyChordHref(chordName, chordMask) {
    // Translate the chord's pitch classes into degrees relative to the
    // CURRENT site key — don't reset k. Users were finding it jarring
    // that clicking a chord chip would warp the page to a new key.
    // Now: page key stays put, the chord's notes light up at whatever
    // degrees they happen to be in that key (a I-chord always shows
    // 1/3/5; a IV chord in C shows 4/6/1; an Em chip while in C shows
    // 3/5/7, etc.).
    const x = window.SF_X;
    const tonic = (x && x.k) ? x.k : 'C';
    const tonicPc = NOTE_TO_PC[tonic];
    if (tonicPc == null) return null;
    const DEG_LBL = ['1','♭2','2','♭3','3','4','♭5','5','♭6','6','♭7','7'];
    const degs = [];
    for (let pc = 0; pc < 12; pc++) {
      if ((chordMask >> pc) & 1) {
        const off = (pc - tonicPc + 12) % 12;
        degs.push(DEG_LBL[off]);
      }
    }
    if (!degs.length) return null;
    const p = new URLSearchParams(window.location.search);
    p.delete('hl');
    // Sort by canonical degree order so the URL is stable regardless
    // of the bit-iteration order above.
    degs.sort(function (a, b) { return DEG_LBL.indexOf(a) - DEG_LBL.indexOf(b); });
    // Separator-free hl form (same shape as the rest of the site).
    p.append('hl', degs.map(function (d) { return d.replace('♭', 'b'); }).join(''));
    // Record which chord-ID chip is the "active" one. Many chord names
    // share the same pitch-class set (Em7 = G6), so without this every
    // chip whose notes match xs.hl would light up. idn pins the
    // engagement to the exact chip the user clicked.
    if (chordName) p.set('idn', chordName);
    else           p.delete('idn');
    return '?' + canonicalQS(p);
  }

  // ◀ / ▶ semitone-shift bar — sits between the fretboard/keyboard and
  // the Chord ID strip. Shifts BOTH the colored hl highlights (by
  // bumping the site key k by ±1 semitone, which moves every degree
  // up/down the neck) AND the yellow pk picks (note-by-note).
  function renderShiftBars(x) {
    const PCS = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
    const FLAT_TO_SHARP = { 'A♭':'G♯','B♭':'A♯','C♭':'B','D♭':'C♯','E♭':'D♯','F♭':'E','G♭':'F♯' };
    function toSharp(n) {
      const norm = bToFlat(sharpToHash(String(n)));
      return FLAT_TO_SHARP[norm] || norm;
    }
    function shiftHtml(sectionId) {
      const hlVal = String(x.hl || '').trim();
      const enabled = !!hlVal && hlVal !== 'nothing';
      const dis = enabled ? '' : ' disabled';
      return '<div class="semi_shift_bar">'
           +   '<button type="button" class="semi_shift_btn" data-shift="-1" data-section="'
           +     escAttr(sectionId) + '"' + dis
           +     ' title="Shift highlighted notes down 1 semitone">◀</button>'
           +   '<button type="button" class="semi_shift_btn" data-shift="1" data-section="'
           +     escAttr(sectionId) + '"' + dis
           +     ' title="Shift highlighted notes up 1 semitone">▶</button>'
           + '</div>';
    }
    const fbEl = document.getElementById('fb_shift_root');
    const kbEl = document.getElementById('kb_shift_root');
    if (fbEl) fbEl.innerHTML = shiftHtml('section_2');
    if (kbEl) kbEl.innerHTML = shiftHtml('section_4');

    // One-shot click delegate at body level — handles both bars.
    if (!document.body._semiShiftBound) {
      document.body._semiShiftBound = true;
      const DEG_LBL = ['1','♭2','2','♭3','3','4','♭5','5','♭6','6','♭7','7'];
      document.body.addEventListener('click', function (e) {
        const btn = e.target.closest && e.target.closest('.semi_shift_btn');
        if (!btn || btn.disabled) return;
        e.preventDefault();
        e.stopPropagation();
        const delta = parseInt(btn.getAttribute('data-shift'), 10) || 0;
        // Shift each highlighted DEGREE by ±1 semitone. The site key
        // stays as the user set it; only the hl set rotates around
        // the same tonal centre. Visually identical to bumping k
        // (highlights move chromatically up/down the neck) but the
        // grids, diatonic chart, and section header stay anchored
        // on the chosen key.
        const x = window.SF_X || {};
        const cur = hlStrToArr(x.hl);
        const next = cur.map(function (d) {
          const off = _DEG_OFFSET[d];
          if (off == null) return d;
          return DEG_LBL[(off + delta + 12) % 12];
        });
        navigateTo(buildHlHref(next));
      });
    }
  }

  function renderIdentifyStrips(xFB, xKB) {
    const fbHost = document.getElementById('fb_identify_root');
    const kbHost = document.getElementById('kb_identify_root');
    if (!fbHost && !kbHost) return;

    // Each section gets its OWN identify strip (rendered from its own
    // section state) so picks don't leak across in unlinked mode.
    function buildHtml(xs, sectionId) {

    // Chord ID strip is now driven by the hl (color highlight) set,
    // not the legacy pk yellow-ring set. The <details> wrapper, the
    // Clear text, and the ? help link have all been removed — the
    // strip renders just the readout + suggestion chips.
    function headerBtnsHtml(_showClear) { return ''; }

    const hlArr = hlStrToArr(xs.hl);
    let html;
    if (hlArr.length < 3) {
      // Placeholder — keeps the strip's vertical space reserved so the
      // page doesn't jump when chord ID data starts arriving.
      html = '<div class="identify_strip identify_placeholder">'
           + '</div>';
    } else {
      const selMask = hlArrToMask(hlArr, xs.k);
      const inKeyOnly = getIdentifyInKey();
      // "in key" now means "root letter == current key" — pass the key
      // string to classifyChords; keyMask kept open (0xFFF = no scale
      // restriction) so chord notes outside the diatonic scale still show.
      const buckets = classifyChords(selMask, 0xFFF, inKeyOnly ? xs.k : null);
      const clearHref = buildHlHref([]);

      function chipsHtml(items, extractName) {
        if (!items.length) return '<span class="identify_empty">none</span>';
        return items.map(function (it) {
          const name = extractName ? extractName(it) : it;
          // Find this chord's mask so we can build an apply URL + tooltip.
          const data = (window.SLANT_CHORDS && window.SLANT_CHORDS.chords) || [];
          let mask = 0;
          for (let j = 0; j < data.length; j++) {
            if (data[j][1] === name) { mask = data[j][0]; break; }
          }
          // Resolve root + degree set so we can render tooltip + detect
          // engagement (chip is "on" when x.k matches this chord's root and
          // x.hl matches its degree set).
          let root = null, rootPc = -1;
          for (const n of PC_TO_NOTE) {
            if (name.indexOf(n) === 0 && (root === null || n.length > root.length)) {
              root = n; rootPc = NOTE_TO_PC[n];
            }
          }
          let tip = name;
          let degsStr = '';      // chord degrees relative to its OWN root (for tooltip)
          if (mask && rootPc >= 0) {
            const DEG_LBL = ['1','♭2','2','♭3','3','4','♭5','5','♭6','6','♭7','7'];
            const degs = [], notes = [];
            for (let i = 0; i < 12; i++) {
              if ((mask >> ((rootPc + i) % 12)) & 1) {
                degs.push(DEG_LBL[i]);
                notes.push(PC_TO_NOTE[(rootPc + i) % 12]);
              }
            }
            degsStr = degs.join(' ');
            tip = name + '\nDegrees: ' + degsStr + '\nNotes: ' + notes.join(' ');
          }
          // Engagement is pinned to the exact chip the user clicked via
          // ?idn=<name>. Multiple names can describe the same notes
          // (Em7 = G6), so a degrees-match would light all of them up.
          const isEngaged = !!(xs._id_active && xs._id_active === name);
          let href;
          if (isEngaged) {
            // Disengage: drop hl= but keep pk= (yellow chord-ID picks)
            // and every other URL param. Same helper the None pill uses,
            // so unlinked-mode merging behaves consistently.
            href = clearHlOnlyHref();
          } else {
            href = applyChordHref(name, mask) || '#';
          }
          const cls = 'identify_chip' + (isEngaged ? ' identify_chip_on' : '');
          return '<a class="' + cls + '" href="' + escHtml(href) + '" title="' + escAttr(tip) + '">' + escHtml(name) + '</a>';
        }).join('');
      }

      const extras = getIdentifyExtras();
      const extrasPills = ['1', '2', 'All'].map(function (lbl) {
        const v = lbl === 'All' ? Infinity : +lbl;
        const on = (extras === v) ? ' identify_pill_on' : '';
        return '<a class="identify_pill' + on + '" href="#" data-extras="' + lbl + '">+' + lbl + '</a>';
      }).join('');

      const inKeyPill = '<a class="identify_pill identify_pill_inkey'
        +    (inKeyOnly ? ' identify_pill_on' : '')
        +    '" href="#" data-inkey="toggle" title="'
        +    (inKeyOnly
              ? 'Showing only chords rooted on ' + xs.k + '. Click to show all.'
              : 'Show only chords rooted on ' + xs.k + '.')
        +    '">' + escHtml(xs.k) + ' root</a>';
      // Notes corresponding to the current hl degrees, anchored on xs.k.
      const tonicPc = NOTE_TO_PC[xs.k];
      const noteStr = (tonicPc == null)
        ? ''
        : hlArr.slice().sort(function (a, b) {
            const ao = _DEG_OFFSET[a]; const bo = _DEG_OFFSET[b];
            return (ao == null ? 99 : ao) - (bo == null ? 99 : bo);
          }).map(function (d) {
            const off = _DEG_OFFSET[d];
            return off == null ? '' : PC_TO_NOTE[(tonicPc + off) % 12];
          }).filter(Boolean).join(' ');
      html = ''
        + '<div class="identify_strip">'
        + headerBtnsHtml(true)
        + '  <div class="identify_head">'
        + '    <span class="identify_picks">' + escHtml(noteStr) + '</span>'
        + '    <span class="identify_filter">' + inKeyPill + '</span>'
        + '  </div>'
        + '  <div class="identify_row">'
        + '    <span class="identify_chips">' + chipsHtml(buckets.exact) + '</span>'
        + '  </div>'
        + '  <div class="identify_row">'
        + '    <span class="identify_chips">'
        +        chipsHtml(buckets.subset, function (it) { return it.name; })
        + '    </span>'
        + '  </div>'
        + '  <div class="identify_row">'
        + '    <span class="identify_extras_toggle">' + extrasPills + '</span>'
        + '    <span class="identify_chips">'
        +        chipsHtml(buckets.superset, function (it) { return it.name; })
        + '    </span>'
        + '  </div>'
        + '</div>';
    }
      return html;
    }

    if (fbHost) fbHost.innerHTML = buildHtml(xFB, 'section_2');
    if (kbHost) kbHost.innerHTML = buildHtml(xKB, 'section_4');

    // Wire +N pills + anchor-scroll for any link click inside the strip
    // (delegated, idempotent). Without anchor-scroll, the Clear-picks link
    // shrinks the strip, which lets every section above it slide up — and
    // the user sees the page jump toward the URL bar.
    [fbHost, kbHost].forEach(function (host) {
      if (!host || host._extrasBound) return;
      host._extrasBound = true;
      const anchorSel = (host === fbHost) ? '#fretboard' : '#section_4';
      host.addEventListener('click', function (e) {
        // (Chord ID on/off toggle button removed — Chord ID is always on.
        // The <details> wrapper still lets users minimize the strip; that
        // open/closed state is persisted via the 'toggle' listener wired
        // alongside the quick-picks one further down.)
        // +N extras pill — local toggle, no navigation.
        const pill = e.target.closest && e.target.closest('.identify_pill');
        if (pill) {
          e.preventDefault();
          e.stopPropagation();
          if (pill.getAttribute('data-inkey') === 'toggle') {
            setIdentifyInKey(!getIdentifyInKey());
            return;
          }
          const lbl = pill.getAttribute('data-extras');
          if (lbl) setIdentifyExtras(lbl === 'All' ? Infinity : +lbl);
          return;
        }
        // Any link inside the strip (Clear picks, chord chips). Capture the
        // anchor's viewport position before the URL change and adjust scroll
        // afterward so the section the user is interacting with stays put.
        const link = e.target.closest && e.target.closest('a');
        if (!link) return;
        let url;
        try { url = new URL(link.href, window.location.href); } catch (_) { return; }
        if (url.origin !== window.location.origin) return;
        if (url.pathname !== window.location.pathname) return;
        e.preventDefault();
        e.stopPropagation();
        const anchorEl = document.querySelector(anchorSel);
        const before = anchorEl ? anchorEl.getBoundingClientRect().top : null;
        navigateTo(url.search || '?');
        if (before !== null) {
          const el = document.querySelector(anchorSel);
          if (el) {
            const delta = el.getBoundingClientRect().top - before;
            if (delta) window.scrollBy(0, delta);
          }
        }
      });
    });
  }

  // ---------- learn / quiz ----------
  let _quizCurrent = null;

  function _qDegList(hl) {
    return hl.split('&hl=').slice(1).filter(function (s) { return s.length; }).map(function (s) { return s.replace(/b/g, '♭'); });
  }
  function _qPrettyChord(s) { return s.replace(/b/g, '♭').replace(/#/g, '♯'); }
  function _qPrettyScale(s) { return s.replace(/_/g, ' '); }
  function _qPickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function _qPickN(arr, n) {
    const copy = arr.slice();
    const out = [];
    while (out.length < n && copy.length) {
      out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
    }
    return out;
  }
  function _qShuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  // Site-key-aware degree → note mapping.
  function _qDegsToNotes(degs, key) {
    const i1 = KEYS.indexOf(key);
    if (i1 < 0) return [];
    return degs.map(function (d) {
      const off = DEGREES.indexOf(d);
      return off < 0 ? '' : KEYS[i1 + off];
    });
  }

  // ----- Quiz category registry -----------------------------------------
  // Each category gets a toggle in the sidebar so the user can practice
  // only the topics they want. Disabled set persists in localStorage.
  function _quizEnabled(id) {
    let off = [];
    try { off = JSON.parse(localStorage.getItem('sf_quiz_off') || '[]'); } catch (_) {}
    return off.indexOf(id) === -1;
  }
  function _quizSetEnabled(id, on) {
    let off = [];
    try { off = JSON.parse(localStorage.getItem('sf_quiz_off') || '[]'); } catch (_) {}
    const idx = off.indexOf(id);
    if (on && idx >= 0) off.splice(idx, 1);
    else if (!on && idx === -1) off.push(id);
    try { localStorage.setItem('sf_quiz_off', JSON.stringify(off)); } catch (_) {}
  }

  function generateQuizQuestion(x) {
    const enabled = _QUIZ_CATEGORIES.filter(function (c) { return _quizEnabled(c.id); });
    const pool = enabled.length ? enabled : _QUIZ_CATEGORIES;
    const cat = pool[Math.floor(Math.random() * pool.length)];
    return cat.gen(x);
  }

  // ----- Additional question generators (use Tier-1/2 theory data) -----
  function _qDiatonicChord(x) {
    const key = _qPickRandom(ALLNOTES);
    const notes = _majorScaleNotes(key);
    if (!notes.length) return _qKeySignature();
    const idx = Math.floor(Math.random() * 7);
    const dia = _DIATONIC[idx];
    const root = notes[idx];
    const target = root + dia.quality;
    const distractors = [];
    let safety = 30;
    while (distractors.length < 3 && safety-- > 0) {
      const i = Math.floor(Math.random() * 7);
      if (i === idx) continue;
      const d2 = _DIATONIC[i];
      const candidate = notes[i] + d2.quality;
      if (candidate !== target && distractors.indexOf(candidate) === -1) {
        distractors.push(candidate);
      }
    }
    while (distractors.length < 3) distractors.push(_qPickRandom(ALLNOTES) + 'm');
    const choices = _qShuffle([target].concat(distractors));
    const fnLabel = dia.fn === 'T' ? 'Tonic' : dia.fn === 'S' ? 'Subdominant' : 'Dominant';
    return {
      prompt: 'In ' + key + ' major, what is the ' + dia.roman + ' chord?',
      showcase: dia.roman,
      showcaseSub: fnLabel,
      showcaseSubLabel: 'Function',
      choices: choices,
      answer: target,
    };
  }

  function _qModeByChar(x) {
    const modesWithChar = _MODES.filter(function (m) { return m.char; });
    const target = _qPickRandom(modesWithChar);
    const distractors = _qPickN(_MODES.filter(function (m) { return m.name !== target.name; }), 3);
    const choices = _qShuffle([target].concat(distractors)).map(function (m) { return m.name; });
    return {
      prompt: 'Which mode is characterised by ' + target.char + '?',
      showcase: target.char,
      showcaseSub: target.bright === 'major' ? 'Bright (major-like)' : 'Dark (minor-like)',
      showcaseSubLabel: 'Quality',
      choices: choices,
      answer: target.name,
    };
  }

  function _qCadenceType(x) {
    const target = _qPickRandom(_CADENCES);
    const distractors = _qPickN(_CADENCES.filter(function (c) { return c.name !== target.name; }), 3);
    const choices = _qShuffle([target].concat(distractors)).map(function (c) { return c.name; });
    return {
      prompt: 'What kind of cadence is this?',
      showcase: target.romans.join(' → '),
      showcaseSub: target.desc,
      showcaseSubLabel: 'Hint',
      choices: choices,
      answer: target.name,
    };
  }

  function _qRelativeMinor(x) {
    const all = KEY_SIGS_SHARP.concat(KEY_SIGS_FLAT);
    const target = _qPickRandom(all);
    const notes = _majorScaleNotes(target.setKey);
    if (!notes.length) return _qKeySignature();
    const relMinor = notes[5] + ' minor';
    const allMinors = ALLNOTES.map(function (n) { return n + ' minor'; });
    const distractors = _qPickN(allMinors.filter(function (n) { return n !== relMinor; }), 3);
    const choices = _qShuffle([relMinor].concat(distractors));
    return {
      prompt: 'What is the relative minor of ' + target.key + ' major?',
      showcase: target.key + ' major',
      showcaseSub: 'Same key signature, lowered 3 6 7',
      showcaseSubLabel: 'Hint',
      choices: choices,
      answer: relMinor,
    };
  }

  // Registry — declared after the generators so the function refs resolve.
  // Order here is the order the toggles render in the sidebar.
  const _QUIZ_CATEGORIES = [
    { id: 'sig_byname',  label: 'Key sig by name',        gen: _qKeySignature },
    { id: 'sig_bycount', label: 'Key sig: # accidentals', gen: _qKeySignatureCount },
    { id: 'scale_degs',  label: 'Scale by degrees',       gen: _qScaleByDegrees },
    { id: 'chord_degs',  label: 'Chord by degrees',       gen: _qChordByDegrees },
    { id: 'in_key',      label: 'Notes → name',           gen: _qInKey },
    { id: 'diatonic',    label: 'Diatonic chords',        gen: _qDiatonicChord },
    { id: 'mode_char',   label: 'Modes (by characteristic)', gen: _qModeByChar },
    { id: 'cadence',     label: 'Cadence types',          gen: _qCadenceType },
    { id: 'relative',    label: 'Relative minor',         gen: _qRelativeMinor },
  ];

  function _qScaleByDegrees(x) {
    const names = Object.keys(SCALES);
    const target = _qPickRandom(names);
    const distractors = _qPickN(names.filter(function (n) { return n !== target; }), 3);
    const choices = _qShuffle([target].concat(distractors)).map(_qPrettyScale);
    const degs = _qDegList(SCALES[target]);
    return {
      prompt: 'Which scale has these degrees?',
      showcase: degs.join('  '),
      showcaseSub: _qDegsToNotes(degs, x.k).join('  '),
      showcaseSubLabel: 'In key of ' + x.k,
      choices: choices,
      answer: _qPrettyScale(target)
    };
  }

  function _qChordByDegrees(x) {
    const names = Object.keys(GRID);
    const target = _qPickRandom(names);
    const distractors = _qPickN(names.filter(function (n) { return n !== target; }), 3);
    const choices = _qShuffle([target].concat(distractors)).map(_qPrettyChord);
    const degs = _qDegList(GRID[target]);
    return {
      prompt: 'Which chord has these degrees?',
      showcase: degs.join('  '),
      showcaseSub: _qDegsToNotes(degs, x.k).join('  '),
      showcaseSubLabel: 'In key of ' + x.k,
      choices: choices,
      answer: _qPrettyChord(target)
    };
  }

  function _qInKey() {
    const key = _qPickRandom(ALLNOTES);
    const isScale = Math.random() < 0.5;
    const pool = isScale ? SCALES : GRID;
    const names = Object.keys(pool);
    const target = _qPickRandom(names);
    const distractors = _qPickN(names.filter(function (n) { return n !== target; }), 3);
    const fmt = isScale ? _qPrettyScale : _qPrettyChord;
    const choices = _qShuffle([target].concat(distractors)).map(fmt);

    const degs = _qDegList(pool[target]);
    const notes = _qDegsToNotes(degs, key);

    return {
      prompt: 'In the key of ' + key + ', which ' + (isScale ? 'scale' : 'chord') + ' has these notes?',
      showcase: notes.join('  '),
      showcaseSub: degs.join('  '),
      showcaseSubLabel: 'Degrees',
      choices: choices,
      answer: fmt(target)
    };
  }

  // "What key has N sharps/flats?" — answer is one of the major keys.
  function _qKeySignature() {
    const useFlats = Math.random() < 0.5;
    const set = useFlats ? KEY_SIGS_FLAT : KEY_SIGS_SHARP.slice(1); // skip C (0 accidentals)
    const target = _qPickRandom(set);
    const distractors = _qPickN(set.filter(function (r) { return r.key !== target.key; }), 3);
    const allKeyNames = (KEY_SIGS_SHARP.concat(KEY_SIGS_FLAT)).map(function (r) { return r.key; });
    // Pad distractors with random keys if there aren't enough in this side
    while (distractors.length < 3) {
      const random = _qPickRandom(allKeyNames);
      if (random !== target.key && !distractors.some(function (d) { return d.key === random; })) {
        distractors.push({ key: random });
      }
    }
    const choices = _qShuffle([target].concat(distractors)).map(function (r) {
      return r.key + ' major';
    });
    return {
      prompt: 'Which key has ' + target.count + ' ' + (useFlats ? 'flat' : 'sharp')
        + (target.count === 1 ? '' : 's') + '?',
      showcase: target.notes,
      showcaseSubLabel: '',
      choices: choices,
      answer: target.key + ' major'
    };
  }

  // "How many sharps/flats are in <key> major?" — answer is the count.
  function _qKeySignatureCount() {
    const all = KEY_SIGS_SHARP.concat(KEY_SIGS_FLAT.filter(function (r) { return r.count > 0; }));
    const target = _qPickRandom(all);
    const isFlat = KEY_SIGS_FLAT.indexOf(target) !== -1;
    const word = isFlat ? 'flats' : 'sharps';
    const correct = String(target.count);
    const distractors = _qShuffle(['0', '1', '2', '3', '4', '5', '6', '7']
      .filter(function (n) { return n !== correct; })).slice(0, 3);
    const choices = _qShuffle([correct].concat(distractors));
    return {
      prompt: 'How many ' + word + ' in ' + target.key + ' major?',
      showcase: target.notes,
      showcaseSubLabel: '',
      choices: choices,
      answer: correct
    };
  }

  // ------------------------------------------------------------------
  // Ear Training (section_12)
  // ------------------------------------------------------------------
  // Random interval / chord identification drills. Uses playMidi() so
  // playback honours the user's selected instrument. Pool + mode + score
  // persist to localStorage only — not the URL — since these are personal
  // practice prefs, not shareable state.
  const _EAR_INT_SHORT = ['P1','m2','M2','m3','M3','P4','TT','P5','m6','M6','m7','M7'];
  const _EAR_INT_LONG  = ['Unison','Minor 2nd','Major 2nd','Minor 3rd','Major 3rd',
                          'Perfect 4th','Tritone','Perfect 5th','Minor 6th',
                          'Major 6th','Minor 7th','Major 7th'];
  const _EAR_CHORDS = [
    { id:'Maj',  name:'Major',      semis:[0,4,7]    },
    { id:'min',  name:'Minor',      semis:[0,3,7]    },
    { id:'dim',  name:'Diminished', semis:[0,3,6]    },
    { id:'aug',  name:'Augmented',  semis:[0,4,8]    },
    { id:'dom7', name:'Dom 7',      semis:[0,4,7,10] },
    { id:'Maj7', name:'Maj 7',      semis:[0,4,7,11] },
    { id:'min7', name:'min 7',      semis:[0,3,7,10] },
    { id:'m7b5', name:'m7♭5',       semis:[0,3,6,10] }
  ];
  const _EAR_NOTE_NAMES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
  const _EAR_LS = 'sf_ear_prefs';
  function _earLoadPrefs() {
    const dflt = {
      mode: 'intervals',
      play: 'melodic_up',
      root: 'random',   // 'random' or one of _EAR_NOTE_NAMES
      intervals: [0,1,1,1,1,1,1,1,1,1,1,1],   // skip unison by default
      chords: { Maj:1, min:1, dim:1, aug:1, dom7:1, Maj7:1, min7:1, m7b5:1 },
      score: { right: 0, wrong: 0 }
    };
    try {
      const raw = window.localStorage.getItem(_EAR_LS);
      if (!raw) return dflt;
      const parsed = JSON.parse(raw);
      // shallow merge, keep defaults for missing keys
      const out = Object.assign({}, dflt, parsed);
      out.intervals = (parsed.intervals && parsed.intervals.length === 12)
                       ? parsed.intervals.slice() : dflt.intervals.slice();
      out.chords = Object.assign({}, dflt.chords, parsed.chords || {});
      out.score = Object.assign({}, dflt.score, parsed.score || {});
      return out;
    } catch (_) { return dflt; }
  }
  function _earSavePrefs(p) {
    try { window.localStorage.setItem(_EAR_LS, JSON.stringify(p)); } catch (_) {}
  }

  let _earPrefs = null;
  let _earCurrent = null;   // { kind, root, interval | familyId }
  let _earRevealed = false;
  let _earLastGuess = null; // interval # or chord id — for red highlight on wrong

  // Resolve the current root selection to a MIDI number. 'random' picks
  // fresh across a comfortable C3..C5 span; a pinned note sits in the
  // C4 octave (MIDI 60 + pitch class) so it stays in a singable range.
  function _earPickRootMidi() {
    const r = _earPrefs && _earPrefs.root;
    if (!r || r === 'random') return 48 + Math.floor(Math.random() * 25);
    const pc = notePc(r);
    return 60 + pc;
  }

  function _earPickChallenge() {
    _earRevealed = false;
    _earLastGuess = null;
    const root = _earPickRootMidi();
    if (_earPrefs.mode === 'intervals') {
      const enabled = [];
      for (let i = 0; i < 12; i++) if (_earPrefs.intervals[i]) enabled.push(i);
      if (!enabled.length) enabled.push(7);
      const interval = enabled[Math.floor(Math.random() * enabled.length)];
      _earCurrent = { kind: 'interval', root: root, interval: interval };
    } else {
      const pool = _EAR_CHORDS.filter(function (f) { return _earPrefs.chords[f.id]; });
      const fam = (pool.length ? pool : [_EAR_CHORDS[0]])[Math.floor(Math.random() * (pool.length || 1))];
      _earCurrent = { kind: 'chord', root: root, familyId: fam.id };
    }
  }

  function _earNotes() {
    if (!_earCurrent) return [];
    if (_earCurrent.kind === 'interval') return [_earCurrent.root, _earCurrent.root + _earCurrent.interval];
    const fam = _EAR_CHORDS.find(function (f) { return f.id === _earCurrent.familyId; });
    return fam ? fam.semis.map(function (s) { return _earCurrent.root + s; }) : [];
  }

  // Play any list of MIDI notes using the currently-selected playback
  // mode. Shared by the challenge play and the reference-interval /
  // reference-chord buttons.
  function _earPlayNotes(notes) {
    if (!notes || !notes.length) return;
    // Ear training is inherently audio-driven — the site-wide ♪ pill is
    // opt-in to keep the page silent on first load, but by the time the
    // user clicks a challenge here they've explicitly consented. Flip
    // it on if it's off, warm both audio paths, and repaint the pill so
    // its on-state stays in sync.
    if (typeof audioOn === 'function' && !audioOn()) {
      setAudioOn(true);
      ensureAudioCtx();
      if (typeof paintAudioToggle === 'function') paintAudioToggle();
    }
    // Warm the Tone voice on the very first click so subsequent notes
    // route through the sampler instead of the triangle fallback.
    if (typeof ensureToneInstrument === 'function') ensureToneInstrument();
    const play = _earPrefs.play;
    const step = 550;   // ms between melodic notes
    if (play === 'harmonic') {
      notes.forEach(function (n) { playMidi(n, 1.8); });
    } else if (play === 'melodic_down') {
      notes.slice().reverse().forEach(function (n, i) {
        setTimeout(function () { playMidi(n, 0.7); }, i * step);
      });
    } else if (play === 'both') {
      notes.forEach(function (n, i) {
        setTimeout(function () { playMidi(n, 0.7); }, i * step);
      });
      setTimeout(function () {
        notes.forEach(function (n) { playMidi(n, 1.8); });
      }, notes.length * step + 250);
    } else {   // melodic_up (default)
      notes.forEach(function (n, i) {
        setTimeout(function () { playMidi(n, 0.7); }, i * step);
      });
    }
  }

  function _earPlay() {
    if (!_earCurrent) return;
    _earPlayNotes(_earNotes());
  }

  // Reference: play any interval on demand (no scoring, no reveal
  // state change). Uses the current root selection — pinned or fresh
  // random each click.
  function _earPlayReferenceInterval(semis) {
    const root = _earPickRootMidi();
    _earPlayNotes([root, root + semis]);
  }
  function _earPlayReferenceChord(familyId) {
    const root = _earPickRootMidi();
    const fam = _EAR_CHORDS.find(function (f) { return f.id === familyId; });
    if (!fam) return;
    _earPlayNotes(fam.semis.map(function (s) { return root + s; }));
  }

  function _earHandleGuess(choice) {
    if (!_earCurrent || _earRevealed) return;
    _earLastGuess = choice;
    let correct;
    if (_earCurrent.kind === 'interval') correct = (choice === _earCurrent.interval);
    else correct = (choice === _earCurrent.familyId);
    _earPrefs.score[correct ? 'right' : 'wrong']++;
    _earRevealed = true;
    _earSavePrefs(_earPrefs);
    renderEar();
  }

  function renderEar() {
    const root = document.getElementById('ear_root');
    if (!root) return;
    if (!_earPrefs) _earPrefs = _earLoadPrefs();

    const mode = _earPrefs.mode;
    // Mode row
    let h = '<div class="ear_mode_row">'
          + '<button type="button" class="ear_mode_btn' + (mode === 'intervals' ? ' ear_mode_on' : '') + '" data-ear-mode="intervals">Intervals</button>'
          + '<button type="button" class="ear_mode_btn' + (mode === 'chords'    ? ' ear_mode_on' : '') + '" data-ear-mode="chords">Chords</button>'
          + '</div>';

    // Play mode row
    const PLAY = [
      { id: 'melodic_up',   lbl: '↑ Melodic'  },
      { id: 'melodic_down', lbl: '↓ Melodic'  },
      { id: 'harmonic',     lbl: '⧉ Together' },
      { id: 'both',         lbl: '↑ then ⧉'   }
    ];
    h += '<div class="ear_play_row"><span class="ear_lbl">Playback</span>';
    PLAY.forEach(function (o) {
      h += '<button type="button" class="ear_play_btn' + (_earPrefs.play === o.id ? ' ear_play_on' : '')
         + '" data-ear-play="' + o.id + '">' + o.lbl + '</button>';
    });
    h += '</div>';

    // Root note row — 'Random' or pinned to a specific pitch class
    const curRoot = _earPrefs.root || 'random';
    h += '<div class="ear_root_row"><span class="ear_lbl">Root</span>'
       + '<button type="button" class="ear_root_btn' + (curRoot === 'random' ? ' ear_root_on' : '')
       + '" data-ear-root="random">Random</button>';
    _EAR_NOTE_NAMES.forEach(function (n) {
      h += '<button type="button" class="ear_root_btn' + (curRoot === n ? ' ear_root_on' : '')
         + '" data-ear-root="' + escHtml(n) + '">' + escHtml(n) + '</button>';
    });
    h += '</div>';

    // Pool row
    h += '<div class="ear_pool_row"><span class="ear_lbl">Pool</span>';
    if (mode === 'intervals') {
      for (let i = 0; i < 12; i++) {
        h += '<label class="ear_pool_lbl" title="' + _EAR_INT_LONG[i] + '">'
           + '<input type="checkbox" class="ear_pool_cb" data-ear-int="' + i + '"'
           + (_earPrefs.intervals[i] ? ' checked' : '') + '> '
           + _EAR_INT_SHORT[i] + '</label>';
      }
    } else {
      _EAR_CHORDS.forEach(function (f) {
        h += '<label class="ear_pool_lbl">'
           + '<input type="checkbox" class="ear_pool_cb" data-ear-fam="' + f.id + '"'
           + (_earPrefs.chords[f.id] ? ' checked' : '') + '> '
           + f.name + '</label>';
      });
    }
    h += '</div>';

    // Transport + score row
    h += '<div class="ear_transport_row">'
       + '<button type="button" class="ear_go_btn ear_go_new" id="ear_new">▶ New challenge</button>'
       + '<button type="button" class="ear_go_btn" id="ear_replay">↻ Replay</button>'
       + '<button type="button" class="ear_go_btn" id="ear_reveal">👁 Reveal</button>'
       + '<span class="ear_score">'
       +   'Correct: <strong>' + _earPrefs.score.right + '</strong>'
       +   ' &nbsp; Wrong: <strong>' + _earPrefs.score.wrong + '</strong>'
       +   ' &nbsp; <a href="#" class="ear_reset_score">reset</a>'
       + '</span>'
       + '</div>';

    // Reveal / prompt row
    if (_earRevealed && _earCurrent) {
      const label = _earCurrent.kind === 'interval'
        ? _EAR_INT_LONG[_earCurrent.interval]
        : ((_EAR_CHORDS.find(function (f) { return f.id === _earCurrent.familyId; }) || {}).name || '?');
      const wrong = _earLastGuess != null && (
        _earCurrent.kind === 'interval' ? _earLastGuess !== _earCurrent.interval
                                        : _earLastGuess !== _earCurrent.familyId
      );
      h += '<div class="ear_reveal ' + (wrong ? 'ear_reveal_wrong' : 'ear_reveal_right') + '">'
         + (wrong ? '✗ ' : '✓ ') + 'Answer: <strong>' + label + '</strong>'
         + '</div>';
    } else if (_earCurrent) {
      h += '<div class="ear_reveal ear_reveal_prompt">Listening — pick your guess below.</div>';
    } else {
      h += '<div class="ear_reveal ear_reveal_empty">Press <strong>▶ New challenge</strong> to start.</div>';
    }

    // Guess grid
    h += '<div class="ear_guess_grid">';
    if (mode === 'intervals') {
      for (let i = 0; i < 12; i++) {
        if (!_earPrefs.intervals[i]) continue;
        let cls = '';
        if (_earRevealed && _earCurrent && _earCurrent.kind === 'interval') {
          if (i === _earCurrent.interval)         cls = ' ear_guess_right';
          else if (i === _earLastGuess)           cls = ' ear_guess_wrong';
        }
        h += '<button type="button" class="ear_guess_btn' + cls
           + '" data-ear-guess-int="' + i + '">'
           + '<span class="ear_guess_short">' + _EAR_INT_SHORT[i] + '</span>'
           + '<span class="ear_guess_long">'  + _EAR_INT_LONG[i]  + '</span>'
           + '</button>';
      }
    } else {
      _EAR_CHORDS.forEach(function (f) {
        if (!_earPrefs.chords[f.id]) return;
        let cls = '';
        if (_earRevealed && _earCurrent && _earCurrent.kind === 'chord') {
          if (f.id === _earCurrent.familyId)  cls = ' ear_guess_right';
          else if (f.id === _earLastGuess)    cls = ' ear_guess_wrong';
        }
        h += '<button type="button" class="ear_guess_btn' + cls
           + '" data-ear-guess-fam="' + f.id + '">'
           + '<span class="ear_guess_short">' + f.name + '</span>'
           + '</button>';
      });
    }
    h += '</div>';

    // Reference row — tap any interval / chord to hear it on the current
    // root. No scoring, no reveal change. Always visible so it doubles
    // as a lookup even mid-quiz.
    const refLabel = mode === 'intervals' ? 'Play any interval' : 'Play any chord';
    h += '<div class="ear_ref_head"><span class="ear_lbl">Reference</span>'
       + '<span class="ear_ref_hint">' + refLabel + ' &mdash; uses current Root + Playback</span></div>';
    h += '<div class="ear_ref_grid">';
    if (mode === 'intervals') {
      for (let i = 0; i < 12; i++) {
        h += '<button type="button" class="ear_ref_btn" data-ear-ref-int="' + i + '"'
           + ' title="' + _EAR_INT_LONG[i] + '">' + _EAR_INT_SHORT[i] + '</button>';
      }
    } else {
      _EAR_CHORDS.forEach(function (f) {
        h += '<button type="button" class="ear_ref_btn" data-ear-ref-fam="' + f.id + '"'
           + ' title="' + f.name + '">' + f.name + '</button>';
      });
    }
    h += '</div>';

    root.innerHTML = h;
  }

  function bindEarTraining() {
    const root = document.getElementById('ear_root');
    if (!root || root._earBound) return;
    root._earBound = true;

    root.addEventListener('click', function (e) {
      const t = e.target;
      const closest = function (sel) { return t.closest && t.closest(sel); };

      const modeBtn = closest('.ear_mode_btn');
      if (modeBtn) {
        _earPrefs.mode = modeBtn.getAttribute('data-ear-mode');
        _earCurrent = null; _earRevealed = false; _earLastGuess = null;
        _earSavePrefs(_earPrefs); renderEar(); return;
      }
      const playBtn = closest('.ear_play_btn');
      if (playBtn) {
        _earPrefs.play = playBtn.getAttribute('data-ear-play');
        _earSavePrefs(_earPrefs); renderEar(); return;
      }
      const rootBtn = closest('.ear_root_btn');
      if (rootBtn) {
        _earPrefs.root = rootBtn.getAttribute('data-ear-root');
        _earSavePrefs(_earPrefs); renderEar(); return;
      }
      const refInt = closest('[data-ear-ref-int]');
      if (refInt) {
        _earPlayReferenceInterval(parseInt(refInt.getAttribute('data-ear-ref-int'), 10));
        return;
      }
      const refFam = closest('[data-ear-ref-fam]');
      if (refFam) {
        _earPlayReferenceChord(refFam.getAttribute('data-ear-ref-fam'));
        return;
      }
      const resetLink = closest('.ear_reset_score');
      if (resetLink) {
        e.preventDefault();
        _earPrefs.score = { right: 0, wrong: 0 };
        _earSavePrefs(_earPrefs); renderEar(); return;
      }
      if (t.id === 'ear_new') {
        _earPickChallenge(); renderEar(); _earPlay(); return;
      }
      if (t.id === 'ear_replay') {
        if (!_earCurrent) { _earPickChallenge(); renderEar(); }
        _earPlay(); return;
      }
      if (t.id === 'ear_reveal') {
        if (!_earCurrent) return;
        _earRevealed = true; renderEar(); return;
      }
      const gInt = closest('[data-ear-guess-int]');
      if (gInt) { _earHandleGuess(parseInt(gInt.getAttribute('data-ear-guess-int'), 10)); return; }
      const gFam = closest('[data-ear-guess-fam]');
      if (gFam) { _earHandleGuess(gFam.getAttribute('data-ear-guess-fam')); return; }
    });

    root.addEventListener('change', function (e) {
      const t = e.target;
      if (!t || !t.classList || !t.classList.contains('ear_pool_cb')) return;
      if (t.hasAttribute('data-ear-int')) {
        const i = parseInt(t.getAttribute('data-ear-int'), 10);
        if (!isNaN(i)) _earPrefs.intervals[i] = t.checked ? 1 : 0;
      } else if (t.hasAttribute('data-ear-fam')) {
        _earPrefs.chords[t.getAttribute('data-ear-fam')] = t.checked ? 1 : 0;
      }
      _earSavePrefs(_earPrefs);
      renderEar();
    });
  }

  function renderQuiz() {
    const root = document.getElementById('quiz_root');
    if (!root) return;
    // Pass current site state in so degree-based questions can echo the
    // notes for the user's chosen key on a sub-line below the degrees.
    const q = generateQuizQuestion(window.SF_X || { k: 'A' });
    _quizCurrent = q;
    let h = '<div class="quiz_layout">';
    // Sidebar — one toggle per question category. Click to add / remove
    // that subject from the rotation.
    h += '<aside class="quiz_sidebar">';
    h +=   '<div class="quiz_sidebar_title">Subjects</div>';
    _QUIZ_CATEGORIES.forEach(function (c) {
      const on = _quizEnabled(c.id);
      h += '<button type="button" class="quiz_subj' + (on ? ' on' : '')
        +  '" data-quiz-cat="' + escAttr(c.id) + '" aria-pressed="' + (on ? 'true' : 'false')
        +  '" title="' + (on ? 'Remove from quiz' : 'Add to quiz')
        +  '">' + escHtml(c.label) + '</button>';
    });
    h += '</aside>';
    h += '<div class="quiz_card">';
    h += '<div class="quiz_prompt">' + escHtml(q.prompt) + '</div>';
    h += '<div class="quiz_showcase">' + escHtml(q.showcase) + '</div>';
    // Reserve the showcase-sub slot every render — even when there's no
    // sub text — so questions that DO carry a "In key of …" line don't
    // bump the choices down and re-flow the page on appearance.
    h += '<div class="quiz_showcase_sub' + (q.showcaseSub ? '' : ' quiz_showcase_sub_empty') + '">';
    if (q.showcaseSub) {
      h += (q.showcaseSubLabel ? '<span class="quiz_sub_label">' + escHtml(q.showcaseSubLabel) + ':</span> ' : '')
         + escHtml(q.showcaseSub);
    } else {
      h += '&nbsp;';
    }
    h += '</div>';
    h += '<div class="quiz_choices">';
    q.choices.forEach(function (c) {
      h += '<button type="button" class="quiz_choice">' + escHtml(c) + '</button>';
    });
    h += '</div>';
    h += '<div class="quiz_skip_row"><button type="button" class="quiz_skip">Skip →</button></div>';
    h += '<div class="quiz_feedback"></div>';
    h += '</div>';   // .quiz_card
    h += '</div>';   // .quiz_layout
    root.innerHTML = h;
    root.querySelectorAll('.quiz_choice').forEach(function (btn) {
      btn.addEventListener('click', _quizHandleChoice);
    });
    const skip = root.querySelector('.quiz_skip');
    if (skip) skip.addEventListener('click', renderQuiz);
    // Subject-toggle sidebar — click flips that category on/off and re-
    // renders the quiz so the next question respects the new pool.
    root.querySelectorAll('[data-quiz-cat]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const id = btn.getAttribute('data-quiz-cat');
        _quizSetEnabled(id, !_quizEnabled(id));
        renderQuiz();
      });
    });
  }

  function _quizHandleChoice(e) {
    const btn = e.currentTarget;
    const choice = btn.textContent;
    const correct = choice === _quizCurrent.answer;
    const feedback = document.querySelector('#quiz_root .quiz_feedback');
    feedback.innerHTML = '';

    const status = document.createElement('span');
    status.className = correct ? 'quiz_correct' : 'quiz_wrong';
    status.textContent = correct ? '✓ Correct' : '✗ Wrong';
    feedback.appendChild(status);

    document.querySelectorAll('#quiz_root .quiz_choice').forEach(function (b) { b.disabled = true; });
    btn.classList.add(correct ? 'quiz_correct' : 'quiz_wrong');

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'quiz_next';
    next.textContent = 'Next →';
    next.addEventListener('click', renderQuiz);
    feedback.appendChild(next);
  }

  // ---------- per-state render ----------
  function applyState() {
    // Suppress transient <details> toggle events fired by Chrome as
    // the parser swaps qp_box / identify_box via innerHTML below.
    // Without this, the toggle delegate would persist them into
    // qp_closed / id_closed (writing ?qpc=… / ?idc=… into the URL via
    // setSetting's history.replaceState) even though no user clicked
    // a summary.
    window._suppressDetailsToggle = true;
    const x = parseState();
    window.SF_X = x;
    renderTitle(x);
    // When the URL says "unlinked", each section gets its own state
    // built by overlaying that section's s<n>_* overrides onto the
    // global params. Sections without overrides use the global x.
    // Linked mode (default) → every section sees the same x.
    const xFB = stateForSection('section_2', x);
    const xKB = stateForSection('section_4', x);
    const xCG = stateForSection('section_3', x);
    const xSG = stateForSection('section_6', x);
    const xKS = stateForSection('section_9', x);
    renderFretboard(xFB);   // creates #options_root in the middle column
    // Form (tuning picker + degree/note pill rows) lives in the FRETBOARD
    // section, so it must reflect that section's effective state. In
    // linked mode xFB === x, so this is identical to passing the global
    // x; in unlinked mode it ensures the pills paint from s2_hl etc.
    renderOptions(xFB);
    renderChordGrid(xCG);
    renderScaleGrid(xSG);
    renderDiatonicChart(xCG);  // Chord Builder: 7 diatonic chords (T/S/D)
    renderInversions(xCG);     // Chord Builder: inversions of current chord
    renderProgressions(xCG);   // Chord Progressions section
    renderModes(xSG);          // Scale Builder: 7 modes from current key
    renderTuningsTable(x);
    renderKeySignatures(xKS);
    renderKeyExtras(xKS);      // Key Sigs: this-key-contains + cadences + intervals
    applyKeyboardColors(xKB);
    applyKeyboardLabels(xKB);
    renderKeyboardPicks(xKB);
    bindTuningPicker(x);
    applyCollapseFromUrl();

    renderSummaryExtras(x);  // populate summary dropdowns BEFORE binding
    renderSummaryStatus(x);  // compact key/tuning text in each title bar
    bindAutoSubmit();        // so the change-listener catches them
    bindCustomTuningLoader();// custom-tuning preset loader (bottom-left cell)
    bindCompactToggles();    // chord/scale grid compact-mode checkboxes
    bindGridRowClicks();     // whole-row click → triggers row's chord/scale link
    bindNotePick();          // click fret cells / keyboard keys to pick notes
    bindApplyAllToggle();    // one-time wire of the Apply: all chip in fretboard summary
    bindAudioToggle();       // one-time wire of the ♪ audio toggle in fretboard summary
    bindDisplayModeButtons();// notes / degrees / both pill group in sticky header
    if (window.SF_TabCapture && typeof window.SF_TabCapture.refresh === 'function') {
      // Site key may have changed — re-render the tab capture mini-fretboard
      // so its degree labels reflect the new key.
      window.SF_TabCapture.refresh();
    }
    renderShiftBars(x);             // ◀ / ▶ semitone shift bar above each Chord ID strip
    renderIdentifyStrips(xFB, xKB); // chord-identify strips below fretboard + keyboard
    applyPrintColors();

    // Sortable tables get rebuilt every render — bind a fresh instance each time
    document.querySelectorAll('table.sortable').forEach(function (t) {
      if (typeof SortableTable !== 'undefined') {
        try { t._sortableInstance = new SortableTable(t); t._sortableInit = true; } catch (e) {}
      }
    });
    applyTuningsSort(x);
    bindTuningsSortObserver();
    bindTuningsFilter();
    // Release the suppression on the next tick — toggle events queued
    // by the parser during this synchronous render fire as microtasks
    // / timer tasks, all of which run before the 0-ms timeout below.
    setTimeout(function () { window._suppressDetailsToggle = false; }, 0);
  }

  // ---------- init ----------
  function init() {
    // Reflect URL-driven display preferences on the body BEFORE the
    // first render so there's no flash of the default mode while CSS
    // rules wait for bindDisplayModeButtons.
    document.body.setAttribute('data-display', getDisplayMode());
    // Section reordering — cache the default order BEFORE we ever
    // touch the DOM, inject drag handles, apply the saved order,
    // then wire the drag delegates.
    _defaultSectionOrder();
    injectDragHandles();
    applySectionOrder();
    bindSectionDrag();
    bindResetSectionOrder();
    applyState();
    bindCollapsibles();
    bindLinkInterceptor();
    bindHelpButtons();
    bindPrintButtons();
    bindExportButtons();
    bindSummaryExtras();
    bindSummaryToggleScope();
    bindFooterWitherfork();
    renderQuiz();
    renderEar();
    bindEarTraining();
    window.addEventListener('popstate', applyState);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
