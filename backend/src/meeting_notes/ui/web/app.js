/* AI Meeting Notes — Core App Logic (recording, sessions, callbacks) */
/* Depends on settings.js being loaded first for: escapeHtml, showToast,
   applySettings, loadSessionHistory (defined here but shared),
   elEngineSelect, elMeetingTypeSelect, updatePrivacyBadge */

"use strict";

// -- DOM References (app-specific) --

var elBtnStart = document.getElementById("btn-start");
var elBtnStop = document.getElementById("btn-stop");
var elBtnMinimize = document.getElementById("btn-minimize");
var elBtnClose = document.getElementById("btn-close");
var elSessionList = document.getElementById("session-list");
var elSessionEmpty = document.getElementById("session-empty");
var elStatusText = document.getElementById("status-text");
var elConsentCheck = document.getElementById("consent-check");
var elMergeOverlay = document.getElementById("merge-overlay");
var elMergeNotesPath = document.getElementById("merge-notes-path");
var elBtnMerge = document.getElementById("btn-merge");
var elBtnSkipMerge = document.getElementById("btn-skip-merge");

// -- Recording State --

var isRecording = false;
var activeRowEl = null;
var elapsedInterval = null;
var recordingStartTime = null;

// -- Initialization --

/** Bootstrap the app: load settings, populate UI, load history. */
async function init() {
  // Start with recording disabled until consent is given
  elBtnStart.disabled = true;

  elConsentCheck.addEventListener("change", function () {
    if (!isRecording) {
      elBtnStart.disabled = !elConsentCheck.checked;
    }
  });

  try {
    var settings = await pywebview.api.get_settings();
    applySettings(settings);
    await loadSessionHistory();
  } catch (err) {
    console.error("Init error:", err);
  }
}

// -- Session History --

/** Fetch and render the session history list from the backend. */
async function loadSessionHistory() {
  try {
    var sessions = await pywebview.api.get_session_history();
    renderSessionList(sessions);
  } catch (err) {
    console.error("Failed to load session history:", err);
  }
}

/**
 * Render an array of session objects into the session list.
 * Preserves the active recording row if present.
 * @param {Array} sessions - Session history entries from Python.
 */
function renderSessionList(sessions) {
  // Remove all non-active rows
  var rows = elSessionList.querySelectorAll(".session-row:not(.session-row--active)");
  rows.forEach(function (r) { r.remove(); });

  if (sessions.length === 0 && !activeRowEl) {
    elSessionEmpty.hidden = false;
    return;
  }
  elSessionEmpty.hidden = true;

  sessions.forEach(function (s) {
    var row = document.createElement("div");
    row.className = "session-row session-row--new";
    row.addEventListener("animationend", function () { row.classList.remove("session-row--new"); });
    row.innerHTML =
      '<div class="session-row__indicator"></div>' +
      '<div class="session-row__info">' +
        '<div class="session-row__title">' + escapeHtml(s.title) + '</div>' +
        '<div class="session-row__meta">' + escapeHtml(s.engine) + ' | ' + escapeHtml(s.segments) + ' segments</div>' +
      '</div>' +
      '<div class="session-row__duration">' + escapeHtml(s.duration) + '</div>';
    row.addEventListener("dblclick", function () {
      if (s.path) pywebview.api.open_file(s.path);
    });
    elSessionList.appendChild(row);
  });
}

// -- Recording Controls --

elBtnStart.addEventListener("click", async function () {
  if (isRecording) return;
  if (!elConsentCheck.checked) return;

  elBtnStart.disabled = true;
  elBtnStart.textContent = "Starting...";
  elStatusText.textContent = "Starting recording...";

  try {
    var engine = elEngineSelect.value;
    var meetingType = elMeetingTypeSelect.value;
    var result = await pywebview.api.start_recording(engine, meetingType);
    if (result.error) {
      showToast(result.error, "error");
      elBtnStart.disabled = false;
      elBtnStart.textContent = "Start Recording";
      elStatusText.textContent = "Ready";
      return;
    }
    onRecordingStarted(result.engine_name);
  } catch (err) {
    showToast("Failed to start recording: " + err, "error");
    elBtnStart.disabled = false;
    elBtnStart.textContent = "Start Recording";
    elStatusText.textContent = "Ready";
  }
});

elBtnStop.addEventListener("click", async function () {
  if (!isRecording) return;

  isRecording = false;
  elBtnStop.disabled = true;
  elBtnStart.disabled = true;
  elStatusText.textContent = "Stopping... processing remaining audio";

  // Update active row to show stopping state
  var titleEl = activeRowEl && activeRowEl.querySelector(".session-row__title");
  if (titleEl) titleEl.textContent = "Stopping...";

  if (elapsedInterval) {
    clearInterval(elapsedInterval);
    elapsedInterval = null;
  }

  try {
    await pywebview.api.stop_recording();
    // Returns immediately -- onRecordingStopped() will come from Python when done
  } catch (err) {
    showToast("Error stopping recording: " + err, "error");
  }
});

/**
 * Transition UI to recording state.
 * @param {string} engineName - Display name of the active engine.
 */
function onRecordingStarted(engineName) {
  isRecording = true;
  elBtnStart.disabled = true;
  elBtnStart.textContent = "Recording...";
  elBtnStop.disabled = false;
  elEngineSelect.disabled = true;
  elMeetingTypeSelect.disabled = true;
  elStatusText.textContent = "Recording in progress";

  // Clear live transcript
  var tbody = document.getElementById("transcript-body");
  if (tbody) tbody.innerHTML = "";
  var tprev = document.getElementById("transcript-preview");
  if (tprev) tprev.hidden = false;

  // Insert active row
  elSessionEmpty.hidden = true;
  recordingStartTime = Date.now();

  activeRowEl = document.createElement("div");
  activeRowEl.className = "session-row session-row--active session-row--new";
  activeRowEl.addEventListener("animationend", function () {
    if (activeRowEl) activeRowEl.classList.remove("session-row--new");
  });
  activeRowEl.innerHTML =
    '<div class="session-row__indicator"></div>' +
    '<div class="session-row__info">' +
      '<div class="session-row__title">Recording... <span class="session-row__engine">' + escapeHtml(engineName) + '</span></div>' +
      '<div class="session-row__meta" id="active-meta" data-engine="' + escapeHtml(engineName) + '">0 segments</div>' +
    '</div>' +
    '<div class="session-row__duration" id="active-duration">00:00</div>';
  elSessionList.insertBefore(activeRowEl, elSessionList.firstChild);

  // Start elapsed timer
  elapsedInterval = setInterval(updateElapsedTimer, 1000);
}

/** Update the elapsed time display on the active recording row. */
function updateElapsedTimer() {
  if (!recordingStartTime) return;
  var elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
  var el = document.getElementById("active-duration");
  if (el) el.textContent = formatElapsed(elapsed);
}

// -- Python Callbacks (called via evaluate_js) --

/**
 * Update the segment count on the active recording row.
 * @param {number} segmentCount - Current number of transcript segments.
 */
function updateSessionStatus(segmentCount) {
  var el = document.getElementById("active-meta");
  if (el) {
    var fileName = el.dataset.filename || "";
    if (fileName) {
      el.textContent = segmentCount + " segments | " + fileName;
    } else {
      el.textContent = segmentCount + " segments";
    }
  }
}

/**
 * Show engine status message (model loading, transcribing, etc.).
 * @param {string} message - Status text from Python.
 */
function updateEngineStatus(message) {
  if (elStatusText) {
    elStatusText.textContent = message;
  }
}

/**
 * Called when the output file is created during recording.
 * @param {string} filePath - Full path to the transcript file.
 */
function onRecordingFileReady(filePath) {
  var meta = document.getElementById("active-meta");
  if (meta) {
    var fileName = filePath.split("\\").pop().split("/").pop();
    meta.title = filePath;
    meta.dataset.filename = fileName;
    meta.textContent = "Writing to: " + fileName;
  }
}

/**
 * Called when recording has fully stopped and audio is processed.
 * @param {string|null} outputPath - Path to saved transcript, or null on error.
 */
function onRecordingStopped(outputPath) {
  isRecording = false;
  elConsentCheck.checked = false;
  elBtnStart.disabled = true;
  elBtnStart.textContent = "Start Recording";
  elBtnStop.disabled = true;
  elEngineSelect.disabled = false;
  elMeetingTypeSelect.disabled = false;
  elStatusText.textContent = "Ready";

  // Clear timer if stop was triggered from Python side (crash/watchdog)
  if (elapsedInterval) {
    clearInterval(elapsedInterval);
    elapsedInterval = null;
  }

  // Convert active row to completed
  if (activeRowEl) {
    activeRowEl.classList.remove("session-row--active");
    activeRowEl = null;
  }
  recordingStartTime = null;

  // Reload session history to get accurate data
  loadSessionHistory();

  if (outputPath) {
    showToast("Transcript saved", "success");
  }
}

/**
 * Called on engine crash to show error and reset UI.
 * @param {string} message - Error message from Python.
 */
function onRecordingError(message) {
  showToast(message, "error");
  onRecordingStopped(null);
}

/**
 * Format total seconds into HH:MM:SS or MM:SS string.
 * @param {number} totalSeconds - Elapsed seconds.
 * @returns {string} Formatted time string.
 */
function formatElapsed(totalSeconds) {
  var h = Math.floor(totalSeconds / 3600);
  var m = Math.floor((totalSeconds % 3600) / 60);
  var s = totalSeconds % 60;
  if (h > 0) {
    return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

// -- Silence Detection Callbacks (called from Python) --

/**
 * Update status bar with silence duration.
 * @param {number} seconds - Seconds of silence (0 = speech resumed).
 */
function updateSilenceStatus(seconds) {
  if (seconds > 0) {
    elStatusText.textContent = "Silence detected (" + seconds + "s)";
    elStatusText.className = "status-bar__text status-bar__text--silence";
  } else {
    elStatusText.textContent = "Recording in progress";
    elStatusText.className = "status-bar__text";
  }
}

/** Show a warning toast at 100s of silence. */
function onSilenceWarning() {
  showToast("Extended silence detected. Recording will auto-stop at 120s.", "warning");
}

// -- Live Transcript Callback (called from Python) --

/**
 * Append a transcript line to the live preview panel.
 * @param {string} text - Final transcript segment text.
 */
function appendTranscript(text) {
  var el = document.getElementById("transcript-body");
  var container = document.getElementById("transcript-preview");
  if (!el || !container) return;
  container.hidden = false;
  var p = document.createElement("p");
  p.className = "transcript-preview__line";
  p.textContent = text;
  el.appendChild(p);
  el.scrollTop = el.scrollHeight;
}

// -- Merge Dialog (called from Python when notes file needs merging) --

/**
 * Show the merge dialog with the notes file path.
 * @param {string} notesPath - Path to the notes file to merge.
 */
function onMergePrompt(notesPath) {
  if (elMergeNotesPath) {
    elMergeNotesPath.textContent = notesPath;
  }
  if (elMergeOverlay) {
    elMergeOverlay.classList.add("modal-overlay--open");
  }
}

elBtnMerge.addEventListener("click", async function () {
  try {
    var result = await pywebview.api.merge_notes();
    if (result.error) {
      showToast("Merge failed: " + result.error, "error");
    } else {
      showToast("Notes merged with transcript", "success");
    }
  } catch (err) {
    showToast("Merge error: " + err, "error");
  }
  elMergeOverlay.classList.remove("modal-overlay--open");
  loadSessionHistory();
});

elBtnSkipMerge.addEventListener("click", function () {
  elMergeOverlay.classList.remove("modal-overlay--open");
  showToast("Merge skipped -- notes file preserved", "info");
  loadSessionHistory();
});

// -- Window Controls --

elBtnMinimize.addEventListener("click", function () {
  pywebview.api.minimize_window();
});

elBtnClose.addEventListener("click", function () {
  pywebview.api.close_window();
});

// -- Bootstrap --

window.addEventListener("pywebviewready", init);
