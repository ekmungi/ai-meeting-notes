/* AI Meeting Notes — Frontend Logic */

"use strict";

// DOM references
const elEngineSelect = document.getElementById("engine-select");
const elMeetingTypeSelect = document.getElementById("meeting-type-select");
const elBtnStart = document.getElementById("btn-start");
const elBtnStop = document.getElementById("btn-stop");
const elBtnSettings = document.getElementById("btn-settings");
const elBtnMinimize = document.getElementById("btn-minimize");
const elBtnClose = document.getElementById("btn-close");
const elSessionList = document.getElementById("session-list");
const elSessionEmpty = document.getElementById("session-empty");
const elStatusText = document.getElementById("status-text");
const elStatusPrivacy = document.getElementById("status-privacy");
const elSettingsOverlay = document.getElementById("settings-overlay");
const elBtnSettingsClose = document.getElementById("btn-settings-close");
const elBtnSettingsSave = document.getElementById("btn-settings-save");
const elBtnSettingsCancel = document.getElementById("btn-settings-cancel");
const elBtnBrowseOutput = document.getElementById("btn-browse-output");
const elConsentCheck = document.getElementById("consent-check");
const elToastContainer = document.getElementById("toast-container");
const elMergeOverlay = document.getElementById("merge-overlay");
const elMergeNotesPath = document.getElementById("merge-notes-path");
const elBtnMerge = document.getElementById("btn-merge");
const elBtnSkipMerge = document.getElementById("btn-skip-merge");

// Settings inputs
const elApiKey = document.getElementById("setting-api-key");
const elOutputDir = document.getElementById("setting-output-dir");
const elTimestamps = document.getElementById("setting-timestamps");
const elEndpointing = document.getElementById("setting-endpointing");
const elModelSize = document.getElementById("setting-model-size");

// State
let isRecording = false;
let activeRowEl = null;
let elapsedInterval = null;
let recordingStartTime = null;

// -- Initialization --

async function init() {
  // Start with recording disabled until consent is given
  elBtnStart.disabled = true;

  elConsentCheck.addEventListener("change", () => {
    if (!isRecording) {
      elBtnStart.disabled = !elConsentCheck.checked;
    }
  });

  try {
    const settings = await pywebview.api.get_settings();
    applySettings(settings);
    await loadSessionHistory();
  } catch (err) {
    console.error("Init error:", err);
  }
}

function applySettings(s) {
  elEngineSelect.value = s.engine || "cloud";
  elApiKey.value = s.assemblyai_api_key || "";
  elOutputDir.value = s.output_dir || "";
  elTimestamps.value = s.timestamp_mode || "elapsed";
  elEndpointing.value = s.endpointing || "conservative";
  elModelSize.value = s.local_model_size || "small.en";

  // Populate meeting types dropdown
  const types = s.meeting_types || ["Meeting Notes"];
  elMeetingTypeSelect.innerHTML = "";
  types.forEach(t => {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    elMeetingTypeSelect.appendChild(opt);
  });

  updatePrivacyBadge(s.engine);
}

function updatePrivacyBadge(engine) {
  if (engine === "local") {
    elStatusPrivacy.textContent = "Local: on-device processing";
    elStatusPrivacy.className = "status-bar__privacy status-bar__privacy--local";
  } else if (engine === "cloud") {
    elStatusPrivacy.textContent = "Cloud: audio via AssemblyAI";
    elStatusPrivacy.className = "status-bar__privacy status-bar__privacy--cloud";
  } else {
    elStatusPrivacy.textContent = "Auto: engine selected at start";
    elStatusPrivacy.className = "status-bar__privacy";
  }
}

// -- Session History --

async function loadSessionHistory() {
  try {
    const sessions = await pywebview.api.get_session_history();
    renderSessionList(sessions);
  } catch (err) {
    console.error("Failed to load session history:", err);
  }
}

function renderSessionList(sessions) {
  // Remove all non-active rows
  const rows = elSessionList.querySelectorAll(".session-row:not(.session-row--active)");
  rows.forEach(r => r.remove());

  if (sessions.length === 0 && !activeRowEl) {
    elSessionEmpty.hidden = false;
    return;
  }
  elSessionEmpty.hidden = true;

  sessions.forEach(s => {
    const row = document.createElement("div");
    row.className = "session-row session-row--new";
    row.addEventListener("animationend", () => row.classList.remove("session-row--new"));
    row.innerHTML = `
      <div class="session-row__indicator"></div>
      <div class="session-row__info">
        <div class="session-row__title">${escapeHtml(s.title)}</div>
        <div class="session-row__meta">${escapeHtml(s.engine)} | ${escapeHtml(s.segments)} segments</div>
      </div>
      <div class="session-row__duration">${escapeHtml(s.duration)}</div>
    `;
    row.addEventListener("dblclick", () => {
      if (s.path) pywebview.api.open_file(s.path);
    });
    elSessionList.appendChild(row);
  });
}

// -- Recording Controls --

elBtnStart.addEventListener("click", async () => {
  if (isRecording) return;
  if (!elConsentCheck.checked) return;

  elBtnStart.disabled = true;
  elBtnStart.textContent = "Starting...";
  elStatusText.textContent = "Starting recording...";

  try {
    const engine = elEngineSelect.value;
    const meetingType = elMeetingTypeSelect.value;
    const result = await pywebview.api.start_recording(engine, meetingType);
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

elBtnStop.addEventListener("click", async () => {
  if (!isRecording) return;

  isRecording = false;
  elBtnStop.disabled = true;
  elBtnStart.disabled = true;  // Stay disabled until onRecordingStopped fires
  elStatusText.textContent = "Stopping... processing remaining audio";

  // Update active row to show stopping state
  const titleEl = activeRowEl && activeRowEl.querySelector(".session-row__title");
  if (titleEl) titleEl.textContent = "Stopping...";

  if (elapsedInterval) {
    clearInterval(elapsedInterval);
    elapsedInterval = null;
  }

  try {
    await pywebview.api.stop_recording();
    // Returns immediately — onRecordingStopped() will come from Python when done
  } catch (err) {
    showToast("Error stopping recording: " + err, "error");
  }
});

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
  activeRowEl.addEventListener("animationend", () => activeRowEl && activeRowEl.classList.remove("session-row--new"));
  // Store engine name in data attribute so updateSessionStatus can rebuild correctly
  activeRowEl.innerHTML = `
    <div class="session-row__indicator"></div>
    <div class="session-row__info">
      <div class="session-row__title">Recording... <span class="session-row__engine">${escapeHtml(engineName)}</span></div>
      <div class="session-row__meta" id="active-meta" data-engine="${escapeHtml(engineName)}">0 segments</div>
    </div>
    <div class="session-row__duration" id="active-duration">00:00</div>
  `;
  elSessionList.insertBefore(activeRowEl, elSessionList.firstChild);

  // Start elapsed timer
  elapsedInterval = setInterval(updateElapsedTimer, 1000);
}

function updateElapsedTimer() {
  if (!recordingStartTime) return;
  const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
  const el = document.getElementById("active-duration");
  if (el) el.textContent = formatElapsed(elapsed);
}

// Called from Python: pywebview.api -> evaluate_js
function updateSessionStatus(segmentCount) {
  const el = document.getElementById("active-meta");
  if (el) {
    // Preserve the filename hint if already shown, just update segment count
    const fileName = el.dataset.filename || "";
    if (fileName) {
      el.textContent = segmentCount + " segments | " + fileName;
    } else {
      el.textContent = segmentCount + " segments";
    }
  }
}

// Called from Python to show engine status (model loading, transcribing, etc.)
function updateEngineStatus(message) {
  if (elStatusText) {
    elStatusText.textContent = message;
  }
}

// Called from Python as soon as the output file is created (during recording)
function onRecordingFileReady(filePath) {
  const meta = document.getElementById("active-meta");
  if (meta) {
    const fileName = filePath.split("\\").pop().split("/").pop();
    meta.title = filePath;  // Full path on hover
    meta.dataset.filename = fileName;
    meta.textContent = "Writing to: " + fileName;
  }
}

// Called from Python when recording has fully stopped (audio processed)
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

// Called from Python on engine crash
function onRecordingError(message) {
  showToast(message, "error");
  onRecordingStopped(null);
}

function formatElapsed(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// -- Silence Detection Callbacks (called from Python) --

// Called from Python when silence exceeds threshold
function updateSilenceStatus(seconds) {
  if (seconds > 0) {
    elStatusText.textContent = "Silence detected (" + seconds + "s)";
    elStatusText.className = "status-bar__text status-bar__text--silence";
  } else {
    elStatusText.textContent = "Recording in progress";
    elStatusText.className = "status-bar__text";
  }
}

// Called from Python at 100s of silence
function onSilenceWarning() {
  showToast("Extended silence detected. Recording will auto-stop at 120s.", "warning");
}

// -- Live Transcript Callback (called from Python) --

// Called from Python with each final transcript segment
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

function onMergePrompt(notesPath) {
  if (elMergeNotesPath) {
    elMergeNotesPath.textContent = notesPath;
  }
  if (elMergeOverlay) {
    elMergeOverlay.classList.add("modal-overlay--open");
  }
}

elBtnMerge.addEventListener("click", async () => {
  try {
    const result = await pywebview.api.merge_notes();
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

elBtnSkipMerge.addEventListener("click", () => {
  elMergeOverlay.classList.remove("modal-overlay--open");
  showToast("Merge skipped — notes file preserved", "info");
  loadSessionHistory();
});

// -- Settings --

elBtnMinimize.addEventListener("click", () => {
  pywebview.api.minimize_window();
});

elBtnClose.addEventListener("click", () => {
  pywebview.api.close_window();
});

elBtnSettings.addEventListener("click", () => {
  elSettingsOverlay.classList.add("modal-overlay--open");
});

elBtnSettingsClose.addEventListener("click", closeSettings);
elBtnSettingsCancel.addEventListener("click", closeSettings);

elBtnSettingsSave.addEventListener("click", async () => {
  const settings = {
    assemblyai_api_key: elApiKey.value.trim(),
    output_dir: elOutputDir.value.trim(),
    timestamp_mode: elTimestamps.value,
    endpointing: elEndpointing.value,
    local_model_size: elModelSize.value,
  };

  try {
    await pywebview.api.save_settings(settings);
    showToast("Settings saved", "success");
    closeSettings();
    // Refresh engine badge
    updatePrivacyBadge(elEngineSelect.value);
  } catch (err) {
    showToast("Failed to save settings: " + err, "error");
  }
});

elBtnBrowseOutput.addEventListener("click", async () => {
  try {
    const dir = await pywebview.api.browse_directory();
    if (dir) elOutputDir.value = dir;
  } catch (err) {
    console.error("Browse error:", err);
  }
});

function closeSettings() {
  elSettingsOverlay.classList.remove("modal-overlay--open");
}

elEngineSelect.addEventListener("change", () => {
  updatePrivacyBadge(elEngineSelect.value);
});

// -- Toasts --

function showToast(message, type) {
  type = type || "info";
  const toast = document.createElement("div");
  toast.className = "toast toast--" + type;
  toast.textContent = message;
  elToastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.3s ease";
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// -- Utilities --

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Wait for pywebview API to be ready
window.addEventListener("pywebviewready", init);
