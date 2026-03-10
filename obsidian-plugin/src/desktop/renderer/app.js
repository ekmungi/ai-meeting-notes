/* AI Meeting Notes -- Core App Logic for Electron (recording, sessions, callbacks) */
/* Depends on settings.js being loaded first for: escapeHtml, showToast,
   applySettings, loadSessionHistory (defined here but shared),
   elEngineSelect, elMeetingTypeSelect, updatePrivacyBadge */

"use strict";

// -- DOM References (app-specific) --

var elBtnStart = document.getElementById("btn-start");
var elBtnPause = document.getElementById("btn-pause");
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
var elStartIcon = document.getElementById("start-icon");
var elPauseIcon = document.getElementById("pause-icon");
var elStopIcon = document.getElementById("stop-icon");

// -- Recording State --

var isRecording = false;
var isPaused = false;
var wsConnection = null;
var wsHeartbeat = null;
var activeRowEl = null;
var elapsedInterval = null;
var recordingStartTime = null;
var pausedElapsed = 0;
var segmentCount = 0;
var currentNotesPath = "";
var silenceDismissed = false;
var silenceAutoStopTimer = null;
var silenceToastEl = null;

// -- WebSocket Connection (renderer owns WS lifecycle) --

/**
 * Connect to the server WebSocket for live transcript streaming.
 * Uses the browser WebSocket API (available natively in Electron renderer).
 * @param {string} wsUrl - WebSocket URL (ws://127.0.0.1:PORT/ws).
 */
function connectWebSocket(wsUrl) {
  disconnectWebSocket();

  try {
    wsConnection = new WebSocket(wsUrl);
  } catch (err) {
    console.error("WebSocket connection failed:", err);
    return;
  }

  wsConnection.onopen = function () {
    wsHeartbeat = setInterval(function () {
      if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
        wsConnection.send(JSON.stringify({ type: "ping" }));
      }
    }, 15000);
  };

  wsConnection.onmessage = function (event) {
    try {
      var msg = JSON.parse(event.data);
      handleServerMessage(msg);

      /* Write final transcript segments to file via main process IPC */
      if (msg.type === "transcript" && !msg.is_partial && msg.text && msg.text.trim()) {
        window.api.writeTranscriptSegment(
          msg.text,
          msg.timestamp_start,
          msg.speaker || null
        );
      }
    } catch (err) {
      /* ignore malformed messages */
    }
  };

  wsConnection.onerror = function (err) {
    console.error("WebSocket error:", err);
  };

  wsConnection.onclose = function () {
    if (wsHeartbeat) {
      clearInterval(wsHeartbeat);
      wsHeartbeat = null;
    }
  };
}

/** Send a JSON message to the server via WebSocket. */
function sendWsMessage(msg) {
  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
    wsConnection.send(JSON.stringify(msg));
  }
}

/** Disconnect the WebSocket and clean up heartbeat. */
function disconnectWebSocket() {
  if (wsHeartbeat) {
    clearInterval(wsHeartbeat);
    wsHeartbeat = null;
  }
  if (wsConnection) {
    wsConnection.close();
    wsConnection = null;
  }
}

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
    var settings = await window.api.getSettings();
    applySettings(settings);
    await loadSessionHistory();
  } catch (err) {
    console.error("Init error:", err);
  }
}

// -- Server Message Router --

/**
 * Handle messages forwarded from the main process WebSocket.
 * @param {Object} msg - Server message (transcript, status, error, silence).
 */
function handleServerMessage(msg) {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case "transcript":
      if (!msg.is_partial) {
        appendTranscript(msg.text);
        segmentCount++;
        updateSessionStatus(segmentCount);
      }
      break;
    case "status":
      if (msg.state === "stopped") {
        onRecordingStopped(null);
      }
      break;
    case "error":
      onRecordingError(msg.message);
      break;
    case "silence":
      updateSilenceStatus(msg.silent_seconds);
      if (msg.silent_seconds >= 100) onSilenceWarning();
      break;
  }
}

// -- Session History --

/** Fetch and render the session history list from the main process. */
async function loadSessionHistory() {
  try {
    var sessions = await window.api.getSessionHistory();
    renderSessionList(sessions);
  } catch (err) {
    console.error("Failed to load session history:", err);
  }
}

/**
 * Render an array of session objects into the session list.
 * Preserves the active recording row if present.
 * @param {Array} sessions - Session history entries.
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
      '<i class="ph ph-file-text session-row__icon"></i>' +
      '<div class="session-row__info">' +
        '<div class="session-row__title">' + escapeHtml(s.title) + '</div>' +
      '</div>' +
      '<div class="session-row__duration">' + escapeHtml(s.duration) + '</div>' +
      '<div class="session-row__actions">' +
        '<button class="session-row__action-btn session-row__action-btn--open" title="Open in editor">' +
          '<i class="ph ph-arrow-square-out"></i>' +
        '</button>' +
        '<button class="session-row__action-btn session-row__action-btn--delete" title="Move to recycle bin">' +
          '<i class="ph ph-trash"></i>' +
        '</button>' +
      '</div>';
    row.querySelector(".session-row__action-btn--open").addEventListener("click", function (e) {
      e.stopPropagation();
      if (s.path) window.api.openFile(s.path);
    });
    row.querySelector(".session-row__action-btn--delete").addEventListener("click", function (e) {
      e.stopPropagation();
      deleteSession(row, s.path, s.title);
    });
    elSessionList.appendChild(row);
  });
}

// -- Recording Controls --

elBtnStart.addEventListener("click", async function () {
  if (isRecording) return;
  if (!elConsentCheck.checked) return;

  elBtnStart.disabled = true;
  elStartIcon.className = "ph ph-spinner";
  elBtnStart.classList.add("action-row__btn--loading");
  elStatusText.textContent = "Starting recording...";

  try {
    var engine = elEngineSelect.value;
    var meetingType = elMeetingTypeSelect.value;
    var result = await window.api.startRecording(engine, meetingType);
    currentNotesPath = result.notes_path || "";
    if (result.error) {
      showToast(result.error, "error");
      elBtnStart.disabled = false;
      elStartIcon.className = "ph-fill ph-record";
      elBtnStart.classList.remove("action-row__btn--loading");
      elStatusText.textContent = "Ready";
      return;
    }
    onRecordingStarted(result.engine_name);
    if (result.ws_url) {
      connectWebSocket(result.ws_url);
    }
  } catch (err) {
    showToast("Failed to start recording: " + err, "error");
    elBtnStart.disabled = false;
    elStartIcon.className = "ph-fill ph-record";
    elBtnStart.classList.remove("action-row__btn--loading");
    elStatusText.textContent = "Ready";
  }
});

elBtnPause.addEventListener("click", async function () {
  if (!isRecording) return;
  try {
    var result = await window.api.pauseRecording();
    if (result.error) {
      showToast(result.error, "error");
      return;
    }
    isPaused = result.paused;
    elPauseIcon.className = isPaused ? "ph-fill ph-play" : "ph-fill ph-pause";
    elBtnPause.title = isPaused ? "Resume Recording" : "Pause Recording";
    elStatusText.textContent = isPaused ? "Recording paused" : "Recording in progress";
    if (isPaused) {
      pausedElapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
      if (elapsedInterval) { clearInterval(elapsedInterval); elapsedInterval = null; }
    } else {
      recordingStartTime = Date.now() - (pausedElapsed * 1000);
      elapsedInterval = setInterval(updateElapsedTimer, 1000);
    }
  } catch (err) {
    showToast("Pause error: " + err, "error");
  }
});

elBtnStop.addEventListener("click", async function () {
  if (!isRecording) return;

  isRecording = false;
  isPaused = false;
  elBtnStop.disabled = true;
  elBtnPause.disabled = true;
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
    var result = await window.api.stopRecording();
    onRecordingStopped(result.output_path || null);
  } catch (err) {
    showToast("Error stopping recording: " + err, "error");
    onRecordingStopped(null);
  }
});

/**
 * Transition UI to recording state.
 * @param {string} engineName - Display name of the active engine.
 */
function onRecordingStarted(engineName) {
  isRecording = true;
  isPaused = false;
  pausedElapsed = 0;
  segmentCount = 0;
  elBtnStart.disabled = true;
  elStartIcon.className = "ph-fill ph-record";
  elBtnStart.classList.remove("action-row__btn--loading");
  elBtnPause.disabled = false;
  elPauseIcon.className = "ph-fill ph-pause";
  elBtnPause.title = "Pause Recording";
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

  // Brief green flash on status text
  elStatusText.classList.add("status-bar__text--started");
  setTimeout(function () { elStatusText.classList.remove("status-bar__text--started"); }, 1500);
}

/** Update the elapsed time display on the active recording row. */
function updateElapsedTimer() {
  if (!recordingStartTime) return;
  var elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
  var el = document.getElementById("active-duration");
  if (el) el.textContent = formatElapsed(elapsed);
}

// -- Callbacks --

/**
 * Update the segment count on the active recording row.
 * @param {number} count - Current number of transcript segments.
 */
function updateSessionStatus(count) {
  var el = document.getElementById("active-meta");
  if (el) {
    var fileName = el.dataset.filename || "";
    if (fileName) {
      el.textContent = count + " segments | " + fileName;
    } else {
      el.textContent = count + " segments";
    }
  }
}

/**
 * Show engine status message (model loading, transcribing, etc.).
 * @param {string} message - Status text.
 */
function updateEngineStatus(message) {
  if (elStatusText) {
    elStatusText.textContent = message;
  }
}

/**
 * Called when recording has fully stopped and audio is processed.
 * @param {string|null} outputPath - Path to saved transcript, or null on error.
 */
function onRecordingStopped(outputPath) {
  disconnectWebSocket();
  clearSilenceAutoStop();
  removeSilenceToast();
  silenceDismissed = false;
  isRecording = false;
  isPaused = false;
  elConsentCheck.checked = false;
  elBtnStart.disabled = true;
  elStartIcon.className = "ph-fill ph-record";
  elBtnStart.classList.remove("action-row__btn--loading");
  elBtnPause.disabled = true;
  elPauseIcon.className = "ph-fill ph-pause";
  elBtnPause.title = "Pause Recording";
  elBtnStop.disabled = true;
  elEngineSelect.disabled = false;
  elMeetingTypeSelect.disabled = false;
  elStatusText.textContent = "Ready";

  // Clear timer if stop was triggered from server side
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

  if (outputPath && currentNotesPath) {
    onMergePrompt(currentNotesPath);
  }
}

/**
 * Called on engine crash to show error and reset UI.
 * @param {string} message - Error message.
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

// -- Session Delete with Undo --

/**
 * Delete a session file with undo support.
 * Animates the row out, shows undo toast for 5 seconds, then calls API.
 * @param {HTMLElement} rowEl - The session row DOM element.
 * @param {string} filePath - File path to delete.
 * @param {string} title - Session title for the toast.
 */
function deleteSession(rowEl, filePath, title) {
  rowEl.classList.add("session-row--deleting");

  var undone = false;
  var toastEl = document.createElement("div");
  toastEl.className = "toast toast--info";
  toastEl.innerHTML =
    '<span>Deleted &quot;' + escapeHtml(title) + '&quot;</span>' +
    '<button class="toast__undo">Undo</button>';

  var container = document.getElementById("toast-container");
  container.appendChild(toastEl);

  toastEl.querySelector(".toast__undo").addEventListener("click", function () {
    undone = true;
    rowEl.classList.remove("session-row--deleting");
    toastEl.remove();
  });

  setTimeout(async function () {
    toastEl.remove();
    if (undone) return;

    try {
      var result = await window.api.deleteSession(filePath);
      if (result.error) {
        showToast("Delete failed: " + result.error, "error");
        rowEl.classList.remove("session-row--deleting");
      } else {
        rowEl.remove();
        var remaining = elSessionList.querySelectorAll(".session-row");
        if (remaining.length === 0) elSessionEmpty.hidden = false;
      }
    } catch (err) {
      showToast("Delete error: " + err, "error");
      rowEl.classList.remove("session-row--deleting");
    }
  }, 5000);
}

// -- Silence Detection Callbacks --

/**
 * Update status bar with silence duration and show extend/dismiss toast at 100s.
 * @param {number} seconds - Seconds of silence (0 = speech resumed).
 */
function updateSilenceStatus(seconds) {
  if (seconds <= 0) {
    elStatusText.textContent = "Recording in progress";
    elStatusText.className = "status-bar__text";
    silenceDismissed = false;
    clearSilenceAutoStop();
    return;
  }

  elStatusText.textContent = "Silence detected (" + seconds + "s)";
  elStatusText.className = "status-bar__text status-bar__text--silence";

  if (seconds >= 100 && !silenceDismissed && !silenceAutoStopTimer) {
    onSilenceWarning();
  }
}

/** Show silence warning toast with Extend / Dismiss / Stop buttons. */
function onSilenceWarning() {
  /* Remove any existing silence toast before creating a new one */
  removeSilenceToast();

  silenceToastEl = showToast(
    'No speech detected for 100s. Auto-stop at 120s.' +
    '<div style="display:flex;gap:6px;margin-top:6px">' +
    '<button class="toast-btn" id="silence-extend">Extend</button>' +
    '<button class="toast-btn" id="silence-dismiss">Dismiss</button>' +
    '<button class="toast-btn" id="silence-stop">Stop</button>' +
    '</div>',
    "warning",
    0,    /* persistent */
    true  /* html */
  );

  /* Wire button handlers after DOM insertion */
  var extBtn = document.getElementById("silence-extend");
  var disBtn = document.getElementById("silence-dismiss");
  var stpBtn = document.getElementById("silence-stop");
  if (extBtn) extBtn.addEventListener("click", extendSilence);
  if (disBtn) disBtn.addEventListener("click", dismissSilence);
  if (stpBtn) stpBtn.addEventListener("click", stopFromSilence);

  /* Auto-stop after 20s if user does not interact */
  silenceAutoStopTimer = setTimeout(function () {
    silenceAutoStopTimer = null;
    removeSilenceToast();
    showToast("Auto-stopping: 120s of silence detected.", "error");
    document.getElementById("btn-stop").click();
  }, 20000);
}

/** Extend: reset server silence counter, clear auto-stop. */
function extendSilence() {
  sendWsMessage({ type: "reset_silence" });
  clearSilenceAutoStop();
  removeSilenceToast();
  silenceDismissed = false;
  showToast("Silence timer reset.", "info");
}

/** Dismiss: hide notice permanently for this session. */
function dismissSilence() {
  silenceDismissed = true;
  clearSilenceAutoStop();
  removeSilenceToast();
}

/** Stop recording from silence warning. */
function stopFromSilence() {
  clearSilenceAutoStop();
  removeSilenceToast();
  document.getElementById("btn-stop").click();
}

/** Remove the persistent silence toast from DOM. */
function removeSilenceToast() {
  if (silenceToastEl) {
    silenceToastEl.remove();
    silenceToastEl = null;
  }
}

/** Clear any pending auto-stop timer. */
function clearSilenceAutoStop() {
  if (silenceAutoStopTimer) {
    clearTimeout(silenceAutoStopTimer);
    silenceAutoStopTimer = null;
  }
}

// -- Live Transcript --

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

// -- Merge Dialog --

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
    var result = await window.api.mergeNotes();
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

elBtnSkipMerge.addEventListener("click", async function () {
  try {
    var result = await window.api.discardTranscript();
    if (result && result.error) {
      showToast("Discard failed: " + result.error, "error");
    } else {
      showToast("Transcript discarded -- notes preserved", "info");
    }
  } catch (err) {
    showToast("Discard error: " + err, "error");
  }
  elMergeOverlay.classList.remove("modal-overlay--open");
  loadSessionHistory();
});

// -- Window Controls --

elBtnMinimize.addEventListener("click", function () {
  window.api.minimizeWindow();
});

elBtnClose.addEventListener("click", function () {
  window.api.closeWindow();
});

// -- Float Stop Handling --

window.api.onFloatStop(function () {
  if (isRecording) elBtnStop.click();
});

// -- Keyboard Shortcuts --

document.addEventListener("keydown", function (e) {
  var tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  if (e.key === "Escape") {
    if (elMergeOverlay.classList.contains("modal-overlay--open")) {
      elMergeOverlay.classList.remove("modal-overlay--open");
      return;
    }
    if (elSettingsOverlay.classList.contains("modal-overlay--open")) {
      closeSettings();
      return;
    }
  }

  if (e.code === "Space" && isRecording) {
    e.preventDefault();
    elBtnPause.click();
    return;
  }

  if (e.key === "Enter" && !isRecording && elConsentCheck.checked) {
    e.preventDefault();
    elBtnStart.click();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    elSettingsOverlay.classList.add("modal-overlay--open");
    return;
  }
});

// -- Bootstrap --

document.addEventListener("DOMContentLoaded", init);
