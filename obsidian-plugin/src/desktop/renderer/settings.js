/* AI Meeting Notes -- Settings, Meeting Types, and Shared Utilities (Electron) */

"use strict";

// -- Shared Utilities (used by both settings.js and app.js) --

/**
 * Escape HTML special characters to prevent XSS.
 * @param {string} str - Raw string to escape.
 * @returns {string} HTML-safe string.
 */
function escapeHtml(str) {
  if (!str) return "";
  var div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Show a temporary toast notification.
 * @param {string} message - Text to display.
 * @param {string} type - One of "info", "success", "warning", "error".
 */
/**
 * Show a toast notification.
 * @param {string} message - Text or HTML content.
 * @param {string} [type="info"] - Toast style: info, warning, error.
 * @param {number} [durationMs=4000] - Auto-dismiss after ms. 0 = persistent until removed.
 * @param {boolean} [html=false] - If true, message is inserted as innerHTML.
 * @returns {HTMLElement} The toast element (for manual removal).
 */
function showToast(message, type, durationMs, html) {
  type = type || "info";
  if (durationMs === undefined || durationMs === null) durationMs = 4000;
  var toast = document.createElement("div");
  toast.className = "toast toast--" + type;
  if (html) {
    toast.innerHTML = message;
  } else {
    toast.textContent = message;
  }
  var container = document.getElementById("toast-container");
  if (container) container.appendChild(toast);

  if (durationMs > 0) {
    setTimeout(function () {
      toast.style.opacity = "0";
      toast.style.transition = "opacity 0.3s ease";
      setTimeout(function () { toast.remove(); }, 300);
    }, durationMs);
  }
  return toast;
}

// -- Settings DOM References --

var elEngineSelect = document.getElementById("engine-select");
var elMeetingTypeSelect = document.getElementById("meeting-type-select");
var elSettingsOverlay = document.getElementById("settings-overlay");
var elBtnSettings = document.getElementById("btn-settings");
var elBtnSettingsClose = document.getElementById("btn-settings-close");
var elBtnSettingsSave = document.getElementById("btn-settings-save");
var elBtnSettingsCancel = document.getElementById("btn-settings-cancel");
var elBtnBrowseOutput = document.getElementById("btn-browse-output");
var elStatusPrivacy = document.getElementById("status-privacy");

// Settings form inputs
var elApiKey = document.getElementById("setting-api-key");
var elOutputDir = document.getElementById("setting-output-dir");
var elTimestamps = document.getElementById("setting-timestamps");
var elEndpointing = document.getElementById("setting-endpointing");
var elModelSize = document.getElementById("setting-model-size");
var elRecordWav = document.getElementById("setting-record-wav");
var elSpeakerLabels = document.getElementById("setting-speaker-labels");
var elOpenEditor = document.getElementById("setting-open-editor");
var elSilenceThreshold = document.getElementById("setting-silence-threshold");
var elSilenceThresholdValue = document.getElementById("silence-threshold-value");
var elSilenceAutoStop = document.getElementById("setting-silence-auto-stop");
var elIndicatorPosition = document.getElementById("setting-indicator-position");
var elMeetingTypesList = document.getElementById("meeting-types-list");
var elNewMeetingType = document.getElementById("new-meeting-type");
var elBtnAddType = document.getElementById("btn-add-type");

// -- Meeting Type Management --

/** Current meeting types array (mutable in settings modal). */
var currentMeetingTypes = [];

/**
 * Render the meeting types list inside the settings modal.
 * @param {string[]} types - Array of meeting type names.
 */
function renderMeetingTypes(types) {
  currentMeetingTypes = types.slice();
  if (!elMeetingTypesList) return;
  elMeetingTypesList.innerHTML = "";
  types.forEach(function (t, i) {
    var row = document.createElement("div");
    row.className = "meeting-type-row";
    row.innerHTML =
      '<span class="meeting-type-row__name">' + escapeHtml(t) + "</span>" +
      '<button class="meeting-type-row__remove" data-index="' + i + '" title="Remove">&times;</button>';
    row.querySelector(".meeting-type-row__remove").addEventListener("click", function () {
      var updated = currentMeetingTypes.filter(function (_, idx) { return idx !== i; });
      renderMeetingTypes(updated);
    });
    elMeetingTypesList.appendChild(row);
  });
}

if (elBtnAddType) {
  elBtnAddType.addEventListener("click", function () {
    var val = elNewMeetingType.value.trim();
    if (val && !currentMeetingTypes.includes(val)) {
      renderMeetingTypes(currentMeetingTypes.concat([val]));
      elNewMeetingType.value = "";
    }
  });
}

// -- Privacy Badge --

/**
 * Update the privacy badge text based on selected engine.
 * @param {string} engine - "cloud", "local", or "auto".
 */
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

// -- Apply Settings --

/**
 * Populate all settings UI elements from a settings object.
 * Called on init and after settings load.
 * @param {Object} s - Settings object from main process.
 */
function applySettings(s) {
  elEngineSelect.value = s.engine || "cloud";
  elApiKey.value = s.assemblyai_api_key || "";
  elOutputDir.value = s.output_dir || "";
  elTimestamps.value = s.timestamp_mode || "elapsed";
  elEndpointing.value = s.endpointing || "conservative";
  elModelSize.value = s.local_model_size || "small.en";

  // Populate meeting types dropdown
  var types = s.meeting_types || ["Meeting Notes"];
  elMeetingTypeSelect.innerHTML = "";
  types.forEach(function (t) {
    var opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    elMeetingTypeSelect.appendChild(opt);
  });

  // Recording settings
  if (elRecordWav) elRecordWav.checked = s.record_wav || false;
  if (elSpeakerLabels) elSpeakerLabels.checked = s.speaker_labels || false;
  if (elOpenEditor) elOpenEditor.checked = s.open_editor_on_start !== false;
  if (elSilenceThreshold) {
    elSilenceThreshold.value = s.silence_threshold_seconds || 15;
    elSilenceThresholdValue.textContent = (s.silence_threshold_seconds || 15) + "s";
  }
  if (elSilenceAutoStop) elSilenceAutoStop.checked = s.silence_auto_stop || false;
  if (elIndicatorPosition) elIndicatorPosition.value = s.floating_indicator_position || "center-right";

  // Meeting types list in settings
  renderMeetingTypes(s.meeting_types || ["Meeting Notes"]);

  updatePrivacyBadge(s.engine);
}

// -- Silence Slider Live Update --

if (elSilenceThreshold) {
  elSilenceThreshold.addEventListener("input", function () {
    elSilenceThresholdValue.textContent = elSilenceThreshold.value + "s";
  });
}

// -- Settings Modal Handlers --

/** Close the settings modal overlay. */
function closeSettings() {
  elSettingsOverlay.classList.remove("modal-overlay--open");
}

elBtnSettings.addEventListener("click", function () {
  elSettingsOverlay.classList.add("modal-overlay--open");
});

elBtnSettingsClose.addEventListener("click", closeSettings);
elBtnSettingsCancel.addEventListener("click", closeSettings);

elBtnSettingsSave.addEventListener("click", async function () {
  var settings = {
    assemblyai_api_key: elApiKey.value.trim(),
    output_dir: elOutputDir.value.trim(),
    timestamp_mode: elTimestamps.value,
    endpointing: elEndpointing.value,
    local_model_size: elModelSize.value,
    record_wav: elRecordWav ? elRecordWav.checked : false,
    speaker_labels: elSpeakerLabels ? elSpeakerLabels.checked : false,
    open_editor_on_start: elOpenEditor ? elOpenEditor.checked : true,
    silence_threshold_seconds: elSilenceThreshold ? parseInt(elSilenceThreshold.value, 10) : 15,
    silence_auto_stop: elSilenceAutoStop ? elSilenceAutoStop.checked : false,
    floating_indicator_position: elIndicatorPosition ? elIndicatorPosition.value : "top-right",
    meeting_types: currentMeetingTypes.length > 0 ? currentMeetingTypes : ["Meeting Notes"],
  };

  try {
    await window.api.saveSettings(settings);
    showToast("Settings saved", "success");
    closeSettings();
    // Refresh engine badge
    updatePrivacyBadge(elEngineSelect.value);
    // Re-populate meeting type dropdown with saved types
    var types = settings.meeting_types;
    elMeetingTypeSelect.innerHTML = "";
    types.forEach(function (t) {
      var opt = document.createElement("option");
      opt.value = t;
      opt.textContent = t;
      elMeetingTypeSelect.appendChild(opt);
    });
  } catch (err) {
    showToast("Failed to save settings: " + err, "error");
  }
});

elBtnBrowseOutput.addEventListener("click", async function () {
  try {
    var dir = await window.api.browseDirectory();
    if (dir) elOutputDir.value = dir;
  } catch (err) {
    console.error("Browse error:", err);
  }
});

elEngineSelect.addEventListener("change", function () {
  updatePrivacyBadge(elEngineSelect.value);
});
