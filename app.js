"use strict";

/* =========================================================

   CONFIG

   ========================================================= */
const STATE_VERSION = 4;
const DEFAULT_EVENTS = [
    "induce",
    "muscle relaxant",
    "intubation",
    "drape_out",
    "surgery_ready",
    "needle",
    "gas_start",
    "gas_ready",
    "trocar1",
    "trocar2",
    "trocar3",
    "empty_event",
];
// General only: add or edit preset definitions here. IDs must remain stable once used in archived cases.
const EVENT_PRESETS = {
    lc_standard: {
        name: "LC Standard",
        description: "Standard LC event markers",
        events: [
            "induce", "muscle relaxant", "intubation", "drape_out",
            "surgery_ready", "needle", "gas_start", "gas_ready",
            "trocar1", "trocar2", "trocar3", "empty_event",
        ],
    },
    demo_test: {
        name: "Demo / Test",
        description: "Temporary example; replace after the study protocol is finalized",
        events: ["baseline", "stimulus_on", "stimulus_off", "response"],
    },
};
const CUSTOM_PRESETS_KEY = "experiment-marker-general-custom-presets-v1";
const MAX_PRESET_EVENTS = 40;

const CSV_COLUMNS = [
    "case_id",
    "experiment_type",
    "event_preset",
    "experiment_start_datetime",
    "experiment_end_datetime",
    "event_index",
    "event_original",
    "event",
    "event_status",
    "note",
    "reference_datetime",
    "eeg_datetime",
    "elapsed_seconds",
    "elapsed_time",
    "renamed_at",
    "removed_at",
    "restored_at",
    "correction_count",
    "clock_offset_s",
    "calibration_reference_time",
    "calibration_eeg_time",
];

/* =========================================================

   STATE

   ========================================================= */

function createInitialState() {
    return {
        version: STATE_VERSION,
        state: "READY",
        case_id: "",
        library_id: null,
        library_saved_at_epoch_ms: null,
        experiment_type: "",
        event_preset: "",
        event_types: [],
        experiment_start_datetime: null,
        experiment_end_datetime: null,
        elapsed_checkpoint_ms: 0,
        saved_at_epoch_ms: null,
        clock_offset_seconds: null,
        calibration_reference_time: null,
        calibration_eeg_time: null,
        events: [],
        removed_stack: [],
    };
}

function normalizeEvent(event) {
    return {
        event_original: event.event_original ?? event.event ?? "",
        event: event.event ?? event.event_original ?? "",
        reference_datetime: event.reference_datetime ?? null,
        elapsed_seconds: Number(event.elapsed_seconds ?? 0),
        note: event.note ?? "",
        status: event.status === "removed" ? "removed" : "active",
        renamed_at: event.renamed_at ?? null,
        removed_at: event.removed_at ?? null,
        restored_at: event.restored_at ?? null,
        correction_count: Number(event.correction_count ?? 0),
    };
}
let caseState = createInitialState();
let runtime = {
    elapsedBaseMs: 0,
    perfAnchor: null,
};

function normalizeLoadedState(parsed) {
    const initial = createInitialState();
    const merged = {
        ...initial,
        ...parsed,
    };
    merged.version = STATE_VERSION;
    // Legacy recorded cases may lack event_types; READY never assumes LC buttons.
    if (!Array.isArray(merged.event_types) || (merged.state !== "READY" && merged.event_types.length === 0)) {
        merged.event_types = merged.state === "READY" ? [] : [...DEFAULT_EVENTS];
    }
    merged.events = Array.isArray(merged.events) ? merged.events.map(normalizeEvent) : [];
    if (merged.clock_offset_seconds === null || merged.clock_offset_seconds === undefined || merged.clock_offset_seconds === "") {
        merged.clock_offset_seconds = null;
    }
    else {
        const parsedOffset = Number(merged.clock_offset_seconds);
        merged.clock_offset_seconds = Number.isFinite(parsedOffset) ? parsedOffset : null;
    }
    if (Array.isArray(merged.removed_stack)) {
        merged.removed_stack = merged.removed_stack.filter((index) => Number.isInteger(index) && index >= 0 && index < merged.events.length && merged.events[index].status === "removed");
    }
    else {
        merged.removed_stack = merged.events.map((event, index) => event.status === "removed" ? index : null).filter((index) => index !== null);
    }
    if (![
        "READY",
        "RUNNING",
        "COMPLETE",
    ].includes(merged.state)) {
        merged.state = "READY";
    }
    return merged;
}

/* =========================================================

   DOM

   ========================================================= */
const readyView = document.querySelector("#readyView");
const runningView = document.querySelector("#runningView");
const completeView = document.querySelector("#completeView");
const statusBadge = document.querySelector("#statusBadge");
const caseIdInput = document.querySelector("#caseIdInput");
const experimentTypeInput = document.querySelector("#experimentTypeInput");
const eventPresetSelect = document.querySelector("#eventPresetSelect");
const eventPresetPreview = document.querySelector("#eventPresetPreview");
const newPresetButton = document.querySelector("#newPresetButton");
const editPresetButton = document.querySelector("#editPresetButton");
const presetEditorOverlay = document.querySelector("#presetEditorOverlay");
const presetEditorDialog = document.querySelector(".preset-editor-dialog");
const presetEditorTitle = document.querySelector("#presetEditorTitle");
const presetEditorClose = document.querySelector("#presetEditorClose");
const presetNameInput = document.querySelector("#presetNameInput");
const presetAddEventForm = document.querySelector("#presetAddEventForm");
const presetEventInput = document.querySelector("#presetEventInput");
const presetEditorEvents = document.querySelector("#presetEditorEvents");
const presetEditorCount = document.querySelector("#presetEditorCount");
const presetEditorError = document.querySelector("#presetEditorError");
const presetEditorDelete = document.querySelector("#presetEditorDelete");
const presetEditorCancel = document.querySelector("#presetEditorCancel");
const presetEditorSave = document.querySelector("#presetEditorSave");
const startButton = document.querySelector("#startButton");
const endButton = document.querySelector("#endButton");
const newCaseButton = document.querySelector("#newCaseButton");
/*
Create Resume Recording dynamically so v0.5b.1 only requires
replacing app.js. Existing HTML remains backward compatible.
*/
let resumeRecordingButton = document.querySelector("#resumeRecordingButton");
if (!resumeRecordingButton && newCaseButton) {
    resumeRecordingButton = document.createElement("button");
    resumeRecordingButton.id = "resumeRecordingButton";
    resumeRecordingButton.type = "button";
    resumeRecordingButton.className = "secondary-button new-case-button";
    resumeRecordingButton.textContent = "Resume Recording";
    newCaseButton.parentNode.insertBefore(resumeRecordingButton, newCaseButton);
}
const exportCsvButton = document.querySelector("#exportCsvButton");
const runningCaseId = document.querySelector("#runningCaseId");
const eventCount = document.querySelector("#eventCount");
const eventNoteInput = document.querySelector("#eventNoteInput");
const eventGrid = document.querySelector("#eventGrid");
const lastRecorded = document.querySelector("#lastRecorded");
const lastEventName = document.querySelector("#lastEventName");
const lastEventElapsed = document.querySelector("#lastEventElapsed");
const timeline = document.querySelector("#timeline");
const undoButton = document.querySelector("#undoButton");
const restoreButton = document.querySelector("#restoreButton");
const runningReferenceTime = document.querySelector("#runningReferenceTime");
const runningEegTime = document.querySelector("#runningEegTime");
const runningApplyCalibration = document.querySelector("#runningApplyCalibration");
const runningClearCalibration = document.querySelector("#runningClearCalibration");
const runningCalibrationStatus = document.querySelector("#runningCalibrationStatus");
const completeCaseId = document.querySelector("#completeCaseId");
const completeSummary = document.querySelector("#completeSummary");
const completeTimeline = document.querySelector("#completeTimeline");
const completeReferenceTime = document.querySelector("#completeReferenceTime");
const completeEegTime = document.querySelector("#completeEegTime");
const completeApplyCalibration = document.querySelector("#completeApplyCalibration");
const completeClearCalibration = document.querySelector("#completeClearCalibration");
const completeCalibrationStatus = document.querySelector("#completeCalibrationStatus");
const caseLibrary = document.querySelector("#caseLibrary");
const libraryCount = document.querySelector("#libraryCount");
const saveLibraryButton = document.querySelector("#saveLibraryButton");
const librarySaveStatus = document.querySelector("#librarySaveStatus");
const exportAllCsvButton = document.querySelector("#exportAllCsvButton");
const backupLibraryButton = document.querySelector("#backupLibraryButton");
const libraryBackupStatus = document.querySelector("#libraryBackupStatus");
let libraryRecords = [];

/* =========================================================
   EVENT PRESETS · GENERAL (BUILT-IN + USER EDITOR)
   Presets are local configuration, separate from scientific case records.
   Existing caseState.event_types remains a frozen snapshot after START.
   ========================================================= */
let customPresets = {};
let presetDraft = null;
let presetDraftEditingId = null;
let presetDraftDirty = false;
let editingDraftEventIndex = null;
let previousEditorFocus = null;
let draggedEvent = null;

function allPresets() {
    return { ...EVENT_PRESETS, ...customPresets };
}

function getPreset(presetId) {
    return Object.hasOwn(EVENT_PRESETS, presetId) ? EVENT_PRESETS[presetId] : customPresets[presetId];
}

function isValidCustomPreset(raw, id) {
    return typeof id === "string" && id.startsWith("custom_") && raw &&
        typeof raw.name === "string" && raw.name.trim().length > 0 && raw.name.length <= 60 &&
        Array.isArray(raw.events) && raw.events.length >= 1 && raw.events.length <= MAX_PRESET_EVENTS &&
        raw.events.every((event) => typeof event === "string" && event.trim().length > 0 && event.length <= 50) &&
        new Set(raw.events.map((event) => event.trim().toLocaleLowerCase())).size === raw.events.length;
}

function loadCustomPresets() {
    try {
        const raw = JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY) || "{}");
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
        for (const [id, value] of Object.entries(raw)) {
            if (isValidCustomPreset(value, id)) {
                customPresets[id] = { name: value.name.trim(), description: "Custom preset", events: value.events.map((s) => s.trim()) };
            }
        }
    } catch (error) {
        console.warn("Preset settings could not be loaded:", error);
    }
}

function storeCustomPresets(nextPresets) {
    // Do not show Save success when persistent storage is unavailable or full.
    try {
        localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(nextPresets));
        customPresets = nextPresets;
        return true;
    } catch (error) {
        showPresetEditorError("Could not save the preset on this device. Check browser storage settings.");
        console.error("Preset save failed:", error);
        return false;
    }
}

function renderPresetPreview() {
    const preset = getPreset(eventPresetSelect.value);
    eventPresetPreview.replaceChildren();
    editPresetButton.disabled = !preset;
    editPresetButton.textContent = preset && Object.hasOwn(customPresets, eventPresetSelect.value) ? "Edit Preset" : "Customize a Copy";
    const summary = document.createElement("div");
    summary.className = "preset-preview-summary";
    if (!preset) {
        summary.textContent = "Select or create a preset to preview events.";
        eventPresetPreview.appendChild(summary);
        return;
    }
    summary.textContent = `${preset.events.length} events · ${preset.description}`;
    const tags = document.createElement("div");
    tags.className = "preset-preview-tags";
    preset.events.forEach((eventName) => {
        const tag = document.createElement("span");
        tag.className = "preset-preview-tag";
        tag.textContent = eventName;
        tags.appendChild(tag);
    });
    eventPresetPreview.append(summary, tags);
}

function renderPresetOptions(selectedId = "") {
    eventPresetSelect.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select an event preset";
    eventPresetSelect.appendChild(placeholder);
    for (const [id, preset] of Object.entries(allPresets())) {
        const option = document.createElement("option");
        option.value = id;
        option.textContent = preset.name;
        eventPresetSelect.appendChild(option);
    }
    eventPresetSelect.value = getPreset(selectedId) ? selectedId : "";
    renderPresetPreview();
}

function showPresetEditorError(message) {
    presetEditorError.textContent = message;
    presetEditorError.classList.toggle("hidden", !message);
}

function markPresetDraftDirty() {
    presetDraftDirty = true;
    showPresetEditorError("");
}

function openPresetEditor(mode = "new") {
    if (caseState.state !== "READY") return;
    const currentId = eventPresetSelect.value;
    const currentPreset = getPreset(currentId);
    presetDraftEditingId = mode === "edit" && Object.hasOwn(customPresets, currentId) ? currentId : null;
    const copy = mode === "copy" || mode === "edit";
    presetDraft = {
        name: copy && currentPreset ? (mode === "copy" ? `${currentPreset.name} Copy` : currentPreset.name) : "",
        events: copy && currentPreset ? [...currentPreset.events] : [],
    };
    presetDraftDirty = false;
    editingDraftEventIndex = null;
    presetEditorTitle.textContent = presetDraftEditingId ? "Edit Preset" : "Create Preset";
    presetNameInput.value = presetDraft.name;
    presetEventInput.value = "";
    presetEditorDelete.classList.toggle("hidden", !presetDraftEditingId);
    showPresetEditorError("");
    renderDraftEvents();
    previousEditorFocus = document.activeElement;
    presetEditorOverlay.classList.remove("hidden");
    document.body.classList.add("preset-editor-open");
    presetNameInput.focus();
}

function closePresetEditor(force = false) {
    if (!force && presetDraftDirty && !window.confirm("Discard unsaved preset changes?")) return;
    presetEditorOverlay.classList.add("hidden");
    document.body.classList.remove("preset-editor-open");
    presetDraft = null;
    editingDraftEventIndex = null;
    draggedEvent = null;
    if (previousEditorFocus?.isConnected) previousEditorFocus.focus();
}

function validEventName(name, skipIndex = -1) {
    const trimmed = name.trim();
    if (!trimmed) return "Enter an event name.";
    if (trimmed.length > 50) return "Event names must be 50 characters or fewer.";
    if (presetDraft.events.some((event, index) => index !== skipIndex && event.toLocaleLowerCase() === trimmed.toLocaleLowerCase())) {
        return "This event already exists in the preset.";
    }
    return "";
}

function addDraftEvent() {
    if (!presetDraft) return;
    const name = presetEventInput.value.trim();
    const error = validEventName(name);
    if (error) { showPresetEditorError(error); return; }
    if (presetDraft.events.length >= MAX_PRESET_EVENTS) {
        showPresetEditorError(`Up to ${MAX_PRESET_EVENTS} event buttons per preset.`);
        return;
    }
    presetDraft.events.push(name);
    markPresetDraftDirty();
    presetEventInput.value = "";
    renderDraftEvents();
    presetEventInput.focus();
}

function moveDraftEvent(from, to) {
    if (!presetDraft || from === to || from < 0 || to < 0 || from >= presetDraft.events.length || to >= presetDraft.events.length) return;
    const [item] = presetDraft.events.splice(from, 1);
    presetDraft.events.splice(to, 0, item);
    editingDraftEventIndex = null;
    markPresetDraftDirty();
    renderDraftEvents();
}

function createDraftAction(text, label, callback, disabled = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "preset-row-action";
    button.textContent = text;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.disabled = disabled;
    button.addEventListener("click", callback);
    return button;
}

function renderDraftEvents() {
    if (!presetDraft) return;
    presetEditorEvents.replaceChildren();
    presetEditorCount.textContent = `${presetDraft.events.length} EVENTS`;
    if (!presetDraft.events.length) {
        const empty = document.createElement("p");
        empty.className = "preset-empty-message";
        empty.textContent = "Add your first event to see it here.";
        presetEditorEvents.appendChild(empty);
        return;
    }
    presetDraft.events.forEach((name, index) => {
        const row = document.createElement("div");
        row.className = "preset-event-item";
        row.dataset.index = String(index);
        const handle = document.createElement("button");
        handle.type = "button";
        handle.className = "preset-drag-handle";
        handle.textContent = "⠿";
        handle.title = `Drag to reorder ${name}`;
        handle.setAttribute("aria-label", `Drag to reorder ${name}`);
        handle.addEventListener("pointerdown", (event) => beginPresetDrag(event, index, handle));
        row.appendChild(handle);
        if (editingDraftEventIndex === index) {
            const input = document.createElement("input");
            input.className = "preset-inline-input";
            input.type = "text";
            input.maxLength = 50;
            input.value = name;
            input.setAttribute("aria-label", `Rename ${name}`);
            const applyEdit = () => {
                const updated = input.value.trim();
                const error = validEventName(updated, index);
                if (error) { showPresetEditorError(error); input.focus(); return; }
                if (updated !== name) { presetDraft.events[index] = updated; markPresetDraftDirty(); }
                editingDraftEventIndex = null;
                renderDraftEvents();
            };
            input.addEventListener("keydown", (event) => {
                if (event.key === "Enter") { event.preventDefault(); applyEdit(); }
                if (event.key === "Escape") { editingDraftEventIndex = null; renderDraftEvents(); }
            });
            row.appendChild(input);
            row.appendChild(createDraftAction("✓", `Save rename for ${name}`, applyEdit));
            row.appendChild(createDraftAction("×", "Cancel rename", () => { editingDraftEventIndex = null; renderDraftEvents(); }));
        } else {
            const title = document.createElement("span");
            title.className = "preset-event-name";
            title.textContent = name;
            row.appendChild(title);
            row.appendChild(createDraftAction("✎", `Rename ${name}`, () => {
                editingDraftEventIndex = index;
                renderDraftEvents();
                presetEditorEvents.querySelector(".preset-inline-input")?.focus();
            }));
            row.appendChild(createDraftAction("↑", `Move ${name} up`, () => moveDraftEvent(index, index - 1), index === 0));
            row.appendChild(createDraftAction("↓", `Move ${name} down`, () => moveDraftEvent(index, index + 1), index === presetDraft.events.length - 1));
            row.appendChild(createDraftAction("×", `Remove ${name}`, () => {
                presetDraft.events.splice(index, 1);
                markPresetDraftDirty();
                renderDraftEvents();
            }));
        }
        presetEditorEvents.appendChild(row);
    });
}

function clearPresetDragHighlight() {
    presetEditorEvents.querySelectorAll(".preset-drop-target, .preset-drag-origin").forEach((row) => {
        row.classList.remove("preset-drop-target", "preset-drag-origin");
    });
}

function beginPresetDrag(event, index, handle) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (editingDraftEventIndex !== null) return;
    event.preventDefault();
    draggedEvent = { pointerId: event.pointerId, origin: index, target: index };
    handle.setPointerCapture?.(event.pointerId);
    handle.closest(".preset-event-item")?.classList.add("preset-drag-origin");
    const pointMove = (move) => {
        if (!draggedEvent || move.pointerId !== draggedEvent.pointerId) return;
        const target = document.elementFromPoint(move.clientX, move.clientY)?.closest(".preset-event-item");
        clearPresetDragHighlight();
        handle.closest(".preset-event-item")?.classList.add("preset-drag-origin");
        if (target && presetEditorEvents.contains(target)) {
            draggedEvent.target = Number(target.dataset.index);
            target.classList.add("preset-drop-target");
        }
    };
    const finish = (end) => {
        if (!draggedEvent || end.pointerId !== draggedEvent.pointerId) return;
        const { origin, target } = draggedEvent;
        draggedEvent = null;
        handle.removeEventListener("pointermove", pointMove);
        handle.removeEventListener("pointerup", finish);
        handle.removeEventListener("pointercancel", cancel);
        clearPresetDragHighlight();
        moveDraftEvent(origin, target);
    };
    const cancel = (end) => {
        if (end.pointerId !== draggedEvent?.pointerId) return;
        draggedEvent = null;
        handle.removeEventListener("pointermove", pointMove);
        handle.removeEventListener("pointerup", finish);
        handle.removeEventListener("pointercancel", cancel);
        clearPresetDragHighlight();
    };
    handle.addEventListener("pointermove", pointMove);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", cancel);
}

function savePresetDraft() {
    if (!presetDraft) return;
    const name = presetNameInput.value.trim();
    if (!name || name.length > 60) { showPresetEditorError("Enter a preset name (up to 60 characters)."); return; }
    if (!presetDraft.events.length) { showPresetEditorError("Add at least one event before saving."); return; }
    const duplicate = Object.entries(allPresets()).some(([id, preset]) =>
        id !== presetDraftEditingId && preset.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (duplicate) { showPresetEditorError("A preset with this name already exists."); return; }
    const id = presetDraftEditingId || `custom_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const updated = { ...customPresets, [id]: { name, description: "Custom preset", events: [...presetDraft.events] } };
    if (!storeCustomPresets(updated)) return;
    presetDraftDirty = false;
    closePresetEditor(true);
    renderPresetOptions(id);
}

function deleteSelectedPreset() {
    if (!presetDraftEditingId || !Object.hasOwn(customPresets, presetDraftEditingId)) return;
    if (!window.confirm(`Delete preset “${customPresets[presetDraftEditingId].name}”? Previously saved cases will not be changed.`)) return;
    const next = { ...customPresets };
    delete next[presetDraftEditingId];
    if (!storeCustomPresets(next)) return;
    presetDraftDirty = false;
    closePresetEditor(true);
    renderPresetOptions("");
}

function initializeEventPresets() {
    loadCustomPresets();
    renderPresetOptions();
    eventPresetSelect.addEventListener("change", () => {
        if (caseState.state !== "READY") return;
        renderPresetPreview();
    });
    newPresetButton.addEventListener("click", () => openPresetEditor("new"));
    editPresetButton.addEventListener("click", () => openPresetEditor(Object.hasOwn(customPresets, eventPresetSelect.value) ? "edit" : "copy"));
    presetNameInput.addEventListener("input", markPresetDraftDirty);
    presetAddEventForm.addEventListener("submit", (event) => { event.preventDefault(); addDraftEvent(); });
    presetEditorSave.addEventListener("click", savePresetDraft);
    presetEditorDelete.addEventListener("click", deleteSelectedPreset);
    presetEditorClose.addEventListener("click", () => closePresetEditor());
    presetEditorCancel.addEventListener("click", () => closePresetEditor());
    document.addEventListener("keydown", (event) => {
        if (presetEditorOverlay.classList.contains("hidden")) return;
        if (event.key === "Escape") { event.preventDefault(); closePresetEditor(); }
        if (event.key === "Tab") {
            const focusable = [...presetEditorDialog.querySelectorAll('button:not([disabled]):not(.hidden), input:not([disabled])')].filter(el => el.getClientRects().length);
            if (!focusable.length) return;
            const first = focusable[0], last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
    });
}

/* =========================================================

   STORAGE

   ========================================================= */

function saveState() {
    caseState.version = STATE_VERSION;
    /*

    saved_at_epoch_ms now updates for every

    meaningful state change, not only RUNNING.


    This lets IndexedDB and the emergency mirror

    determine which copy is newest.

    */
    if (caseState.state === "RUNNING") {
        caseState.elapsed_checkpoint_ms = getCurrentElapsedMs();
    }
    caseState.saved_at_epoch_ms = Date.now();
    return savePersistentCase(caseState);
}

async function clearSavedState() {
    await deletePersistentCase();
}

/* =========================================================

   TIMER

   ========================================================= */

function initializeRuntimeTimer() {
    if (caseState.state !== "RUNNING") {
        runtime.elapsedBaseMs = Number(caseState.elapsed_checkpoint_ms || 0);
        runtime.perfAnchor = null;
        return;
    }
    const savedElapsed = Number(caseState.elapsed_checkpoint_ms || 0);
    const savedAt = Number(caseState.saved_at_epoch_ms || Date.now());
    const downtime = Math.max(0, Date.now() - savedAt);
    runtime.elapsedBaseMs = savedElapsed + downtime;
    runtime.perfAnchor = performance.now();
}

function getCurrentElapsedMs() {
    if (caseState.state !== "RUNNING") {
        return Number(caseState.elapsed_checkpoint_ms || 0);
    }
    if (runtime.perfAnchor === null) {
        return runtime.elapsedBaseMs;
    }
    return (runtime.elapsedBaseMs + (performance.now() - runtime.perfAnchor));
}

/* =========================================================

   TIME FORMAT

   ========================================================= */

function pad2(value) {
    return String(value).padStart(2, "0");
}

function pad3(value) {
    return String(value).padStart(3, "0");
}

function formatElapsed(ms) {
    const safeMs = Math.max(0, Number(ms) || 0);
    const totalSeconds = safeMs / 1000;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const milliseconds = Math.floor(safeMs % 1000);
    return (`${pad2(hours)}:` + `${pad2(minutes)}:` + `${pad2(seconds)}.` + `${pad3(milliseconds)}`);
}

function formatClock(value) {
    if (!value) {
        return "";
    }
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "";
    }
    return (`${pad2(date.getHours())}:` + `${pad2(date.getMinutes())}:` + `${pad2(date.getSeconds())}.` + `${pad3(date.getMilliseconds())}`);
}

function formatDateTimeLocal(value) {
    if (!value) {
        return "";
    }
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "";
    }
    return (`${date.getFullYear()}-` + `${pad2(date.getMonth() + 1)}-` + `${pad2(date.getDate())} ` + `${pad2(date.getHours())}:` + `${pad2(date.getMinutes())}:` + `${pad2(date.getSeconds())}.` + `${pad3(date.getMilliseconds())}`);
}

/* =========================================================

   CALIBRATION

   ========================================================= */

function parseClockText(rawValue) {
    const value = rawValue.trim();
    const match = value.match(/^(\d{1,2}):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$/);
    if (!match) {
        return null;
    }
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    if (hours < 0 || hours > 23) {
        return null;
    }
    const milliseconds = Number((match[4] || "0").padEnd(3, "0"));
    return (((hours * 60 * 60) + (minutes * 60) + seconds) * 1000 + milliseconds);
}

function formatClockMsOfDay(ms) {
    const dayMs = 24 * 60 * 60 * 1000;
    let safe = (Number(ms) % dayMs + dayMs) % dayMs;
    const hours = Math.floor(safe / 3600000);
    safe %= 3600000;
    const minutes = Math.floor(safe / 60000);
    safe %= 60000;
    const seconds = Math.floor(safe / 1000);
    const milliseconds = Math.floor(safe % 1000);
    return (`${pad2(hours)}:` + `${pad2(minutes)}:` + `${pad2(seconds)}.` + `${pad3(milliseconds)}`);
}

function normalizeClockDifferenceMs(difference) {
    const dayMs = 24 * 60 * 60 * 1000;
    const halfDayMs = dayMs / 2;
    let result = difference;
    if (result > halfDayMs) {
        result -= dayMs;
    }
    else if (result < -halfDayMs) {
        result += dayMs;
    }
    return result;
}

function applyCalibration(referenceInput, eegInput) {
    const referenceMs = parseClockText(referenceInput.value);
    const eegMs = parseClockText(eegInput.value);
    if (referenceMs === null || eegMs === null) {
        alert("Please enter both clocks as HH:MM:SS or HH:MM:SS.mmm.");
        return;
    }
    const rawDifference = referenceMs - eegMs;
    const offsetMs = normalizeClockDifferenceMs(rawDifference);
    caseState.clock_offset_seconds = offsetMs / 1000;
    caseState.calibration_reference_time = formatClockMsOfDay(referenceMs);
    caseState.calibration_eeg_time = formatClockMsOfDay(eegMs);
    saveState();
    render();
}

function clearCalibration() {
    caseState.clock_offset_seconds = null;
    caseState.calibration_reference_time = null;
    caseState.calibration_eeg_time = null;
    saveState();
    render();
}

function hasCalibration() {
    return Number.isFinite(caseState.clock_offset_seconds);
}

function getEegDatetime(referenceDatetime) {
    if (!referenceDatetime || !hasCalibration()) {
        return null;
    }
    const reference = new Date(referenceDatetime);
    if (Number.isNaN(reference.getTime())) {
        return null;
    }
    return new Date(reference.getTime() - (caseState.clock_offset_seconds * 1000));
}

function formatSignedOffset(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value)) {
        return "Not calibrated";
    }
    const sign = value > 0 ? "+" : "";
    return (`${sign}${value.toFixed(3)} s`);
}

function renderCalibration(referenceInput, eegInput, statusElement) {
    referenceInput.value = caseState.calibration_reference_time || "";
    eegInput.value = caseState.calibration_eeg_time || "";
    if (!hasCalibration()) {
        statusElement.textContent = "Not calibrated";
        return;
    }
    statusElement.textContent = `Offset ${formatSignedOffset(caseState.clock_offset_seconds)} · EEG time = Reference time − offset`;
}

/* =========================================================
   THREE-COLUMN CLOCK PICKER (UI ONLY)

   The picker only writes HH:MM:SS into the existing input.
   Apply Calibration remains the sole operation that changes
   the saved clock offset. Previously saved millisecond values
   are untouched until a new selection is confirmed/applied.
   ========================================================= */
const CLOCK_WHEEL_ROW_HEIGHT = 48;
const clockPickerParts = [
    { name: "hour", label: "Hour", count: 24 },
    { name: "minute", label: "Minute", count: 60 },
    { name: "second", label: "Second", count: 60 },
];
const clockPickerState = {
    overlay: null,
    target: null,
    opener: null,
    previousBodyOverflow: "",
    wheels: {},
};

function getClockPickerSelection(value) {
    const match = String(value || "").trim().match(/^(\d{1,2}):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?$/);
    if (match && Number(match[1]) <= 23) {
        return {
            hour: Number(match[1]),
            minute: Number(match[2]),
            second: Number(match[3]),
        };
    }
    const now = new Date();
    return {
        hour: now.getHours(),
        minute: now.getMinutes(),
        second: now.getSeconds(),
    };
}

function getSelectedClockWheelValue(part) {
    const wheel = clockPickerState.wheels[part.name];
    const value = Math.round(wheel.scrollTop / CLOCK_WHEEL_ROW_HEIGHT);
    return Math.max(0, Math.min(part.count - 1, value));
}

function updateClockWheelSelection(part) {
    const wheel = clockPickerState.wheels[part.name];
    const selected = getSelectedClockWheelValue(part);
    wheel.querySelectorAll(".clock-picker-option").forEach((option) => {
        const active = Number(option.dataset.value) === selected;
        option.classList.toggle("selected", active);
        option.setAttribute("aria-selected", String(active));
    });
}

function setClockWheelValue(part, value) {
    const wheel = clockPickerState.wheels[part.name];
    const selected = Math.max(0, Math.min(part.count - 1, value));
    wheel.scrollTop = selected * CLOCK_WHEEL_ROW_HEIGHT;
    updateClockWheelSelection(part);
}

function closeClockPicker() {
    if (!clockPickerState.target) {
        return;
    }
    clockPickerState.overlay.classList.add("hidden");
    document.body.style.overflow = clockPickerState.previousBodyOverflow;
    const opener = clockPickerState.opener;
    clockPickerState.target = null;
    clockPickerState.opener = null;
    if (opener && opener.isConnected) {
        opener.focus({ preventScroll: true });
    }
}

function acceptClockPicker() {
    if (!clockPickerState.target) {
        return;
    }
    const chosen = clockPickerParts.map((part) => pad2(getSelectedClockWheelValue(part)));
    // This does not apply/save the calibration; it fills the existing field.
    clockPickerState.target.value = chosen.join(":");
    clockPickerState.target.dispatchEvent(new Event("input", { bubbles: true }));
    closeClockPicker();
}

function openClockPicker(target, opener = target) {
    if (!clockPickerState.overlay) {
        return;
    }
    const initial = getClockPickerSelection(target.value);
    clockPickerState.target = target;
    clockPickerState.opener = opener;
    clockPickerState.previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    clockPickerState.overlay.classList.remove("hidden");
    clockPickerState.overlay.querySelector("#clockPickerTitle").textContent = target.id.toLowerCase().includes("reference") ? "Reference clock" : "EEG / device clock";
    // Force the opened panel to layout before placing the scroll wheels.
    // Set their values synchronously: a pending animation frame must never
    // overwrite a fast tap/selection made immediately after opening.
    void clockPickerState.overlay.offsetHeight;
    clockPickerParts.forEach((part) => setClockWheelValue(part, initial[part.name]));
    clockPickerState.wheels.hour.focus({ preventScroll: true });
}

function initializeClockPicker() {
    const fields = [
        runningReferenceTime,
        runningEegTime,
        completeReferenceTime,
        completeEegTime,
    ];
    const overlay = document.createElement("div");
    overlay.id = "clockPickerOverlay";
    overlay.className = "clock-picker-overlay hidden";
    overlay.innerHTML = `
        <div class="clock-picker-backdrop"></div>
        <section class="clock-picker-dialog" role="dialog"
                 aria-modal="true" aria-labelledby="clockPickerTitle">
            <div class="clock-picker-header">
                <div>
                    <div class="clock-picker-eyebrow">TIME CALIBRATION</div>
                    <h2 id="clockPickerTitle">Choose time</h2>
                </div>
                <button type="button" class="clock-picker-close"
                        aria-label="Cancel time selection">×</button>
            </div>
            <div class="clock-picker-wheel-labels" aria-hidden="true">
                <span>HOUR</span><span>MINUTE</span><span>SECOND</span>
            </div>
            <div class="clock-picker-wheel-group">
                <div class="clock-picker-highlight" aria-hidden="true"></div>
            </div>
            <div class="clock-picker-footer">
                <button type="button" class="clock-picker-cancel">Cancel</button>
                <button type="button" class="clock-picker-confirm">Confirm</button>
            </div>
        </section>
    `;
    document.body.appendChild(overlay);
    clockPickerState.overlay = overlay;
    const wheelGroup = overlay.querySelector(".clock-picker-wheel-group");
    clockPickerParts.forEach((part) => {
        const wheel = document.createElement("div");
        wheel.className = "clock-picker-wheel";
        wheel.dataset.part = part.name;
        wheel.tabIndex = 0;
        wheel.setAttribute("role", "listbox");
        wheel.setAttribute("aria-label", part.label);
        const topSpacer = document.createElement("div");
        topSpacer.className = "clock-picker-spacer";
        topSpacer.setAttribute("aria-hidden", "true");
        wheel.appendChild(topSpacer);
        for (let value = 0; value < part.count; value++) {
            const option = document.createElement("div");
            option.className = "clock-picker-option";
            option.dataset.value = String(value);
            option.textContent = pad2(value);
            option.setAttribute("role", "option");
            option.setAttribute("aria-selected", "false");
            wheel.appendChild(option);
        }
        const bottomSpacer = document.createElement("div");
        bottomSpacer.className = "clock-picker-spacer";
        bottomSpacer.setAttribute("aria-hidden", "true");
        wheel.appendChild(bottomSpacer);
        clockPickerState.wheels[part.name] = wheel;
        wheelGroup.appendChild(wheel);
        wheel.addEventListener("scroll", () => {
            updateClockWheelSelection(part);
        }, { passive: true });
        wheel.addEventListener("click", (event) => {
            const option = event.target.closest(".clock-picker-option");
            if (!option) {
                return;
            }
            setClockWheelValue(part, Number(option.dataset.value));
        });
        wheel.addEventListener("keydown", (event) => {
            const selected = getSelectedClockWheelValue(part);
            let next = selected;
            if (event.key === "ArrowDown")
                next += 1;
            else if (event.key === "ArrowUp")
                next -= 1;
            else if (event.key === "Home")
                next = 0;
            else if (event.key === "End")
                next = part.count - 1;
            else
                return;
            event.preventDefault();
            setClockWheelValue(part, next);
        });
    });
    overlay.querySelector(".clock-picker-backdrop").addEventListener("click", closeClockPicker);
    overlay.querySelector(".clock-picker-close").addEventListener("click", closeClockPicker);
    overlay.querySelector(".clock-picker-cancel").addEventListener("click", closeClockPicker);
    overlay.querySelector(".clock-picker-confirm").addEventListener("click", acceptClockPicker);
    document.addEventListener("keydown", (event) => {
        if (!clockPickerState.target) {
            return;
        }
        if (event.key === "Escape") {
            event.preventDefault();
            closeClockPicker();
        }
        else if (event.key === "Tab") {
            // Keep keyboard focus within this modal while it is open.
            const focusables = [
                overlay.querySelector(".clock-picker-close"),
                ...clockPickerParts.map((part) => clockPickerState.wheels[part.name]),
                overlay.querySelector(".clock-picker-cancel"),
                overlay.querySelector(".clock-picker-confirm"),
            ];
            const current = focusables.indexOf(document.activeElement);
            if (event.shiftKey && current <= 0) {
                event.preventDefault();
                focusables[focusables.length - 1].focus();
            }
            else if (!event.shiftKey && current === focusables.length - 1) {
                event.preventDefault();
                focusables[0].focus();
            }
        }
    });
    const coarsePointer = window.matchMedia("(pointer: coarse)");
    const configureTouchInputs = () => {
        fields.forEach((field) => {
            field.readOnly = coarsePointer.matches;
            if (coarsePointer.matches) {
                field.setAttribute("inputmode", "none");
                field.setAttribute("aria-haspopup", "dialog");
            }
            else {
                field.removeAttribute("inputmode");
                field.removeAttribute("aria-haspopup");
            }
        });
    };
    configureTouchInputs();
    if (typeof coarsePointer.addEventListener === "function") {
        coarsePointer.addEventListener("change", configureTouchInputs);
    }
    fields.forEach((field) => {
        field.addEventListener("click", () => {
            if (coarsePointer.matches) {
                openClockPicker(field);
            }
        });
        field.addEventListener("keydown", (event) => {
            if (coarsePointer.matches && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                openClockPicker(field);
            }
        });
        const trigger = document.querySelector(`.calibration-time-trigger[data-time-target="${field.id}"]`);
        if (trigger) {
            trigger.addEventListener("click", () => {
                openClockPicker(field, trigger);
            });
        }
    });
}

/* =========================================================

   CASE ACTIONS

   ========================================================= */

function startExperiment() {
    const caseId = caseIdInput.value.trim();
    const experimentType = experimentTypeInput.value.trim();
    if (!caseId) {
        alert("Please enter a Case ID.");
        caseIdInput.focus();
        return;
    }
    if (!experimentType) {
        alert("Please enter an Experiment type.");
        experimentTypeInput.focus();
        return;
    }
    const selectedPresetId = eventPresetSelect.value;
    const selectedPreset = getPreset(selectedPresetId);
    if (!selectedPreset || selectedPreset.events.length === 0) {
        alert("Please select a valid event preset.");
        eventPresetSelect.focus();
        return;
    }
    // All required fields are valid; capture the start timestamp before storage work.
    const now = new Date();
    caseState.case_id = caseId;
    caseState.library_id = null;
    caseState.library_saved_at_epoch_ms = null;
    caseState.experiment_type = experimentType;
    // Snapshot the chosen preset before recording. Future preset edits cannot alter this case.
    caseState.event_preset = selectedPresetId;
    caseState.event_types = [...selectedPreset.events];
    caseState.state = "RUNNING";
    caseState.experiment_start_datetime = now.toISOString();
    caseState.experiment_end_datetime = null;
    caseState.elapsed_checkpoint_ms = 0;
    caseState.saved_at_epoch_ms = Date.now();
    caseState.events = [];
    caseState.removed_stack = [];
    runtime.elapsedBaseMs = 0;
    runtime.perfAnchor = performance.now();
    saveState();
    render();
}

function recordEvent(eventName) {
    if (caseState.state !== "RUNNING") {
        return;
    }
    /*

    Timestamp first.


    Scientific timing values are captured

    before localStorage work.

    */
    const now = new Date();
    const elapsedMs = getCurrentElapsedMs();
    const note = eventNoteInput.value.trim();
    const event = {
        event_original: eventName,
        event: eventName,
        reference_datetime: now.toISOString(),
        elapsed_seconds: elapsedMs / 1000,
        note: note,
        status: "active",
        renamed_at: null,
        removed_at: null,
        restored_at: null,
        correction_count: 0,
    };
    caseState.events.push(event);
    eventNoteInput.value = "";
    saveState();
    render();
}

function endExperiment() {
    if (caseState.state !== "RUNNING") {
        return;
    }
    const confirmed = window.confirm("End experiment?\n\n" + "This will stop active recording " + "and move the case to COMPLETE.");
    if (!confirmed) {
        return;
    }
    /*
    Capture elapsed time and absolute end time
    only after the user confirms.
    */
    const elapsed = getCurrentElapsedMs();
    const now = new Date();
    caseState.elapsed_checkpoint_ms = elapsed;
    caseState.experiment_end_datetime = now.toISOString();
    caseState.state = "COMPLETE";
    caseState.saved_at_epoch_ms = Date.now();
    runtime.elapsedBaseMs = elapsed;
    runtime.perfAnchor = null;
    saveState();
    render();
}

function resumeExperiment() {
    if (caseState.state !== "COMPLETE") {
        return;
    }
    /*
    An archived case is formally finalized.
    It cannot return to RUNNING.
    */
    if (caseState.library_id) {
        alert("This case has already been saved to Case Library " + "and cannot be resumed.");
        return;
    }
    const confirmed = window.confirm("Resume this experiment?\n\n" + "The current end time will be cleared. " + "Elapsed time will continue through the interruption.");
    if (!confirmed) {
        return;
    }
    const endTime = caseState.experiment_end_datetime ? new Date(caseState.experiment_end_datetime) : null;
    let interruptionMs = 0;
    if (endTime && !Number.isNaN(endTime.getTime())) {
        interruptionMs = Math.max(0, Date.now() - endTime.getTime());
    }
    /*
    The experiment itself did not truly stop, so time spent
    in accidental COMPLETE state remains part of elapsed time.
    */
    const resumedElapsed = Number(caseState.elapsed_checkpoint_ms || 0) + interruptionMs;
    caseState.elapsed_checkpoint_ms = resumedElapsed;
    caseState.experiment_end_datetime = null;
    caseState.state = "RUNNING";
    runtime.elapsedBaseMs = resumedElapsed;
    runtime.perfAnchor = performance.now();
    saveState();
    render();
}

async function newCase() {
    const confirmed = window.confirm(caseState.library_id ? ("Start a new case? " + "The saved Case Library copy will remain. " + "Any QC changes made since the last library save " + "will not be archived unless you update it first.") : ("Discard this current case and start a new one? " + "This case has not been saved to Case Library."));
    if (!confirmed) {
        return;
    }
    await clearSavedState();
    caseState = createInitialState();
    renderPresetOptions("");
    runtime = {
        elapsedBaseMs: 0,
        perfAnchor: null,
    };
    render();
}

/* =========================================================

   RUNNING UNDO / RESTORE

   ========================================================= */

function undoLastEvent() {
    if (caseState.state !== "RUNNING") {
        return;
    }
    for (let index = caseState.events.length - 1; index >= 0; index--) {
        const event = caseState.events[index];
        if (event.status !== "active") {
            continue;
        }
        event.status = "removed";
        event.removed_at = new Date().toISOString();
        event.correction_count = Number(event.correction_count || 0) + 1;
        if (!caseState.removed_stack.includes(index)) {
            caseState.removed_stack.push(index);
        }
        saveState();
        render();
        return;
    }
}

function restoreLastRemovedEvent() {
    if (caseState.state !== "RUNNING") {
        return;
    }
    while (caseState.removed_stack.length > 0) {
        const index = caseState.removed_stack.pop();
        const event = caseState.events[index];
        if (!event || event.status !== "removed") {
            continue;
        }
        event.status = "active";
        event.restored_at = new Date().toISOString();
        event.correction_count = Number(event.correction_count || 0) + 1;
        saveState();
        render();
        return;
    }
}

/* =========================================================

   COMPLETE QC ACTIONS

   ========================================================= */

function renameEventAtIndex(index) {
    if (caseState.state !== "COMPLETE") {
        return;
    }
    const event = caseState.events[index];
    if (!event) {
        return;
    }
    const newName = window.prompt("Correct event label:", event.event);
    if (newName === null) {
        return;
    }
    const cleanName = newName.trim();
    if (!cleanName) {
        alert("Event label cannot be empty.");
        return;
    }
    if (cleanName === event.event) {
        return;
    }
    /*

    Only the interpreted label changes.


    Original event label,

    reference timestamp and elapsed time

    remain untouched.

    */
    event.event = cleanName;
    event.renamed_at = new Date().toISOString();
    event.correction_count = Number(event.correction_count || 0) + 1;
    saveState();
    render();
}

function toggleEventStatusAtIndex(index) {
    if (caseState.state !== "COMPLETE") {
        return;
    }
    const event = caseState.events[index];
    if (!event) {
        return;
    }
    if (event.status === "active") {
        event.status = "removed";
        event.removed_at = new Date().toISOString();
        event.correction_count = Number(event.correction_count || 0) + 1;
        if (!caseState.removed_stack.includes(index)) {
            caseState.removed_stack.push(index);
        }
    }
    else {
        event.status = "active";
        event.restored_at = new Date().toISOString();
        event.correction_count = Number(event.correction_count || 0) + 1;
        caseState.removed_stack = caseState.removed_stack.filter((savedIndex) => savedIndex !== index);
    }
    saveState();
    render();
}

/* =========================================================
   CASE LIBRARY ACTIONS
   ========================================================= */

async function refreshLibraryRecords() {
    try {
        libraryRecords = await listLibraryCases();
    }
    catch (error) {
        console.error("Unable to load Case Library:", error);
        libraryRecords = [];
    }
}

/* =========================================================
   BATCH CSV EXPORT
   ========================================================= */

function hasCalibrationForState(sourceState) {
    return Number.isFinite(sourceState?.clock_offset_seconds);
}

function getEegDatetimeForState(referenceDatetime, sourceState) {
    if (!referenceDatetime || !hasCalibrationForState(sourceState)) {
        return null;
    }
    const reference = new Date(referenceDatetime);
    if (Number.isNaN(reference.getTime())) {
        return null;
    }
    return new Date(reference.getTime() - (sourceState.clock_offset_seconds * 1000));
}

function buildCsvForState(rawState) {
    const sourceState = normalizeLoadedState(rawState || {});
    const rows = [
        makeCsvRow(CSV_COLUMNS),
    ];
    sourceState.events.forEach((event, index) => {
        const eegDatetime = getEegDatetimeForState(event.reference_datetime, sourceState);
        const record = {
            case_id: sourceState.case_id,
            experiment_type: sourceState.experiment_type,
            event_preset: sourceState.event_preset || "",
            experiment_start_datetime: formatDateTimeLocal(sourceState.experiment_start_datetime),
            experiment_end_datetime: formatDateTimeLocal(sourceState.experiment_end_datetime),
            event_index: index + 1,
            event_original: event.event_original,
            event: event.event,
            event_status: event.status,
            note: event.note,
            reference_datetime: formatDateTimeLocal(event.reference_datetime),
            eeg_datetime: eegDatetime ? formatDateTimeLocal(eegDatetime) : "",
            elapsed_seconds: Number(event.elapsed_seconds).toFixed(3),
            elapsed_time: formatElapsed(Number(event.elapsed_seconds) * 1000),
            renamed_at: formatDateTimeLocal(event.renamed_at),
            removed_at: formatDateTimeLocal(event.removed_at),
            restored_at: formatDateTimeLocal(event.restored_at),
            correction_count: event.correction_count,
            clock_offset_s: hasCalibrationForState(sourceState) ? Number(sourceState.clock_offset_seconds).toFixed(3) : "",
            calibration_reference_time: sourceState.calibration_reference_time || "",
            calibration_eeg_time: sourceState.calibration_eeg_time || "",
        };
        rows.push(makeCsvRow(CSV_COLUMNS.map((column) => record[column])));
    });
    return rows.join("\r\n");
}

function getDosDateTime(value) {
    const date = value instanceof Date ? value : new Date(value || Date.now());
    const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
    const year = Math.max(1980, safeDate.getFullYear());
    const dosTime = (safeDate.getHours() << 11) | (safeDate.getMinutes() << 5) | Math.floor(safeDate.getSeconds() / 2);
    const dosDate = ((year - 1980) << 9) | ((safeDate.getMonth() + 1) << 5) | safeDate.getDate();
    return {
        dosTime,
        dosDate,
    };
}

function crc32(bytes) {
    let crc = 4294967295;
    for (let index = 0; index < bytes.length; index++) {
        crc ^= bytes[index];
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 3988292384 : 0);
        }
    }
    return (crc ^ 4294967295) >>> 0;
}

function concatUint8Arrays(arrays) {
    const totalLength = arrays.reduce((total, array) => total + array.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    arrays.forEach((array) => {
        result.set(array, offset);
        offset += array.length;
    });
    return result;
}

function buildStoredZip(files) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;
    files.forEach((file) => {
        const nameBytes = encoder.encode(file.name);
        const contentBytes = file.bytes;
        const checksum = crc32(contentBytes);
        const { dosTime, dosDate, } = getDosDateTime(file.modifiedAt);
        const localHeader = new Uint8Array(30 + nameBytes.length);
        const localView = new DataView(localHeader.buffer);
        localView.setUint32(0, 67324752, true);
        localView.setUint16(4, 20, true);
        localView.setUint16(6, 2048, true);
        localView.setUint16(8, 0, true);
        localView.setUint16(10, dosTime, true);
        localView.setUint16(12, dosDate, true);
        localView.setUint32(14, checksum, true);
        localView.setUint32(18, contentBytes.length, true);
        localView.setUint32(22, contentBytes.length, true);
        localView.setUint16(26, nameBytes.length, true);
        localView.setUint16(28, 0, true);
        localHeader.set(nameBytes, 30);
        localParts.push(localHeader, contentBytes);
        const centralHeader = new Uint8Array(46 + nameBytes.length);
        const centralView = new DataView(centralHeader.buffer);
        centralView.setUint32(0, 33639248, true);
        centralView.setUint16(4, 20, true);
        centralView.setUint16(6, 20, true);
        centralView.setUint16(8, 2048, true);
        centralView.setUint16(10, 0, true);
        centralView.setUint16(12, dosTime, true);
        centralView.setUint16(14, dosDate, true);
        centralView.setUint32(16, checksum, true);
        centralView.setUint32(20, contentBytes.length, true);
        centralView.setUint32(24, contentBytes.length, true);
        centralView.setUint16(28, nameBytes.length, true);
        centralView.setUint16(30, 0, true);
        centralView.setUint16(32, 0, true);
        centralView.setUint16(34, 0, true);
        centralView.setUint16(36, 0, true);
        centralView.setUint32(38, 0, true);
        centralView.setUint32(42, localOffset, true);
        centralHeader.set(nameBytes, 46);
        centralParts.push(centralHeader);
        localOffset += localHeader.length + contentBytes.length;
    });
    const localData = concatUint8Arrays(localParts);
    const centralData = concatUint8Arrays(centralParts);
    const endRecord = new Uint8Array(22);
    const endView = new DataView(endRecord.buffer);
    endView.setUint32(0, 101010256, true);
    endView.setUint16(4, 0, true);
    endView.setUint16(6, 0, true);
    endView.setUint16(8, files.length, true);
    endView.setUint16(10, files.length, true);
    endView.setUint32(12, centralData.length, true);
    endView.setUint32(16, localData.length, true);
    endView.setUint16(20, 0, true);
    return concatUint8Arrays([
        localData,
        centralData,
        endRecord,
    ]);
}

function createBatchCsvFilename(record, usedNames) {
    const sourceState = record.case_data || {};
    const baseName = safeFilenamePart(sourceState.case_id || record.case_id || "case") + "_" + formatFilenameTimestamp(sourceState.experiment_start_datetime || record.saved_at_epoch_ms);
    let filename = `${baseName}.csv`;
    if (!usedNames.has(filename)) {
        usedNames.add(filename);
        return filename;
    }
    const librarySuffix = safeFilenamePart(record.library_id || "archive").slice(-8);
    filename = `${baseName}_${librarySuffix}.csv`;
    let counter = 2;
    while (usedNames.has(filename)) {
        filename = `${baseName}_${librarySuffix}_${counter}.csv`;
        counter++;
    }
    usedNames.add(filename);
    return filename;
}

async function exportAllLibraryCsv() {
    try {
        await refreshLibraryRecords();
        if (libraryRecords.length === 0) {
            alert("No archived cases to export.");
            return;
        }
        const encoder = new TextEncoder();
        const usedNames = new Set();
        const files = libraryRecords.map((record) => {
            const sourceState = record.case_data || {};
            const csv = buildCsvForState(sourceState);
            return {
                name: createBatchCsvFilename(record, usedNames),
                bytes: encoder.encode("\uFEFF" + csv),
                modifiedAt: sourceState.experiment_start_datetime || record.saved_at_epoch_ms || Date.now(),
            };
        });
        const zipBytes = buildStoredZip(files);
        const createdAt = new Date();
        const blob = new Blob([zipBytes], {
            type: "application/zip",
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "experiment-marker-csv-export_" + formatFilenameTimestamp(createdAt) + ".zip";
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => {
            URL.revokeObjectURL(url);
        }, 1000);
    }
    catch (error) {
        console.error("Unable to export Case Library CSV files:", error);
        alert("Unable to export all Case Library CSV files.");
    }
}

async function exportLibraryBackup() {
    try {
        /*
        Read the archive again immediately before export so the
        backup reflects the latest Case Library state.
        The current working case is intentionally excluded.
        */
        await refreshLibraryRecords();
        if (libraryRecords.length === 0) {
            if (libraryBackupStatus) {
                libraryBackupStatus.textContent = "No archived cases to back up.";
            }
            alert("No archived cases to back up.");
            return;
        }
        const createdAt = new Date();
        const backup = {
            backup_format: "experiment-marker-library",
            backup_version: 1,
            created_at: createdAt.toISOString(),
            app_state_version: STATE_VERSION,
            case_count: libraryRecords.length,
            cases: libraryRecords.map((record) => ({
                library_id: record.library_id,
                case_id: record.case_id ?? record.case_data?.case_id ?? "",
                saved_at_epoch_ms: record.saved_at_epoch_ms ?? null,
                case_data: record.case_data,
            })),
        };
        const json = JSON.stringify(backup, null, 2);
        const blob = new Blob([json], {
            type: "application/json;charset=utf-8",
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "experiment-marker-library-backup_" + formatFilenameTimestamp(createdAt) + ".json";
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => {
            URL.revokeObjectURL(url);
        }, 1000);
        if (libraryBackupStatus) {
            libraryBackupStatus.textContent = `${libraryRecords.length} archived case` + (libraryRecords.length === 1 ? "" : "s") + " backed up as JSON.";
        }
    }
    catch (error) {
        console.error("Unable to back up Case Library:", error);
        if (libraryBackupStatus) {
            libraryBackupStatus.textContent = "Backup failed.";
        }
        alert("Unable to back up Case Library.");
    }
}

async function archiveCurrentCase() {
    if (caseState.state !== "COMPLETE") {
        return;
    }
    const updating = Boolean(caseState.library_id);
    const confirmed = window.confirm(updating ? "Update the saved Case Library copy with the current QC state?" : "Save this completed case to Case Library?");
    if (!confirmed) {
        return;
    }
    try {
        const archived = await saveCaseToLibrary(caseState);
        caseState.library_id = archived.library_id;
        caseState.library_saved_at_epoch_ms = archived.library_saved_at_epoch_ms;
        await saveState();
        await refreshLibraryRecords();
        render();
    }
    catch (error) {
        console.error("Unable to save case to library:", error);
        alert("Unable to save this case to Case Library.");
    }
}

async function openLibraryCase(libraryId) {
    const record = libraryRecords.find((item) => item.library_id === libraryId);
    if (!record || !record.case_data) {
        return;
    }
    caseState = normalizeLoadedState(record.case_data);
    caseState.state = "COMPLETE";
    await saveState();
    initializeRuntimeTimer();
    render();
}

async function removeLibraryCase(libraryId) {
    const record = libraryRecords.find((item) => item.library_id === libraryId);
    if (!record) {
        return;
    }
    const name = record.case_id || "this case";
    const confirmed = window.confirm(`Delete ${name} from Case Library? ` + "This cannot be undone.");
    if (!confirmed) {
        return;
    }
    try {
        await deleteLibraryCase(libraryId);
        await refreshLibraryRecords();
        render();
    }
    catch (error) {
        console.error("Unable to delete library case:", error);
        alert("Unable to delete this Case Library record.");
    }
}

/* =========================================================

   EVENT HELPERS

   ========================================================= */

function getLatestActiveEvent() {
    for (let index = caseState.events.length - 1; index >= 0; index--) {
        const event = caseState.events[index];
        if (event.status === "active") {
            return event;
        }
    }
    return null;
}

function hasActiveEvent() {
    return caseState.events.some((event) => event.status === "active");
}

function hasRestorableEvent() {
    return caseState.removed_stack.some((index) => caseState.events[index] && caseState.events[index].status === "removed");
}

/* =========================================================

   CSV EXPORT

   ========================================================= */

function csvEscape(value) {
    if (value === null || value === undefined) {
        return "";
    }
    const text = String(value);
    if (text.includes(",") || text.includes("\"") || text.includes("\n") || text.includes("\r")) {
        return ("\"" + text.replace(/"/g, "\"\"") + "\"");
    }
    return text;
}

function makeCsvRow(values) {
    return values.map(csvEscape).join(",");
}

function buildCsv() {
    return buildCsvForState(caseState);
}

function safeFilenamePart(value) {
    const text = String(value || "case").trim();
    return (text.replace(/[\\\\/:*?"<>|]/g, "_").replace(/\s+/g, "_") || "case");
}

function formatFilenameTimestamp(value) {
    const date = new Date(value || Date.now());
    if (Number.isNaN(date.getTime())) {
        return "unknown_time";
    }
    return (`${date.getFullYear()}` + `${pad2(date.getMonth() + 1)}` + `${pad2(date.getDate())}` + "_" + `${pad2(date.getHours())}` + `${pad2(date.getMinutes())}` + `${pad2(date.getSeconds())}`);
}

function exportCsv() {
    if (caseState.state !== "COMPLETE") {
        return;
    }
    const csv = buildCsv();
    /*

    UTF-8 BOM improves compatibility

    with Excel and Chinese text.

    */
    const blob = new Blob([
        "\uFEFF",
        csv,
    ], {
        type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const filename = safeFilenamePart(caseState.case_id) + "_" + formatFilenameTimestamp(caseState.experiment_start_datetime) + ".csv";
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => {
        URL.revokeObjectURL(url);
    }, 1000);
}

/* =========================================================

   RENDER

   ========================================================= */

function render() {
    readyView.classList.add("hidden");
    runningView.classList.add("hidden");
    completeView.classList.add("hidden");
    statusBadge.textContent = caseState.state;
    if (caseState.state === "READY") {
        renderReady();
        return;
    }
    if (caseState.state === "RUNNING") {
        renderRunning();
        return;
    }
    renderComplete();
}

function renderCaseLibrary() {
    caseLibrary.innerHTML = "";
    libraryCount.textContent = libraryRecords.length > 0 ? `· ${libraryRecords.length}` : "";
    if (exportAllCsvButton) {
        exportAllCsvButton.disabled = libraryRecords.length === 0;
    }
    if (backupLibraryButton) {
        backupLibraryButton.disabled = libraryRecords.length === 0;
    }
    if (libraryBackupStatus) {
        libraryBackupStatus.textContent = libraryRecords.length === 0 ? "No archived cases to back up." : `${libraryRecords.length} archived case` + (libraryRecords.length === 1 ? "" : "s") + " ready for JSON backup.";
    }
    if (libraryRecords.length === 0) {
        const empty = document.createElement("div");
        empty.className = "library-empty";
        empty.textContent = "No cases saved yet.";
        caseLibrary.appendChild(empty);
        return;
    }
    libraryRecords.forEach((record) => {
        const item = document.createElement("div");
        item.className = "library-item";
        const topRow = document.createElement("div");
        topRow.className = "library-top-row";
        const info = document.createElement("div");
        const caseId = document.createElement("div");
        caseId.className = "library-case-id";
        caseId.textContent = record.case_id || "Unnamed Case";
        const meta = document.createElement("div");
        meta.className = "library-meta";
        const data = record.case_data || {};
        const storedEventCount = Array.isArray(data.events) ? data.events.length : 0;
        meta.textContent = `${data.experiment_type || "—"}` + ` · ${storedEventCount} events` + " · " + formatDateTimeLocal(record.saved_at_epoch_ms);
        info.appendChild(caseId);
        info.appendChild(meta);
        topRow.appendChild(info);
        item.appendChild(topRow);
        const actions = document.createElement("div");
        actions.className = "library-actions";
        const openButton = document.createElement("button");
        openButton.type = "button";
        openButton.className = "mini-button";
        openButton.textContent = "Open / Review";
        openButton.addEventListener("click", () => {
            openLibraryCase(record.library_id);
        });
        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "mini-button";
        deleteButton.textContent = "Delete";
        deleteButton.addEventListener("click", () => {
            removeLibraryCase(record.library_id);
        });
        actions.appendChild(openButton);
        actions.appendChild(deleteButton);
        item.appendChild(actions);
        caseLibrary.appendChild(item);
    });
}

function renderReady() {
    readyView.classList.remove("hidden");
    caseIdInput.value = caseState.case_id || "";
    experimentTypeInput.value = caseState.experiment_type || "";
    renderPresetPreview();
    renderCaseLibrary();
}

function renderRunning() {
    runningView.classList.remove("hidden");
    runningCaseId.textContent = caseState.case_id;
    eventCount.textContent = String(caseState.events.filter((event) => event.status === "active").length);
    renderEventButtons();
    renderLastRecorded();
    renderTimeline(timeline, false);
    renderCalibration(runningReferenceTime, runningEegTime, runningCalibrationStatus);
    undoButton.disabled = !hasActiveEvent();
    restoreButton.disabled = !hasRestorableEvent();
}

function renderEventButtons() {
    eventGrid.innerHTML = "";
    const latestActive = getLatestActiveEvent();
    const latestName = latestActive ? latestActive.event : null;
    caseState.event_types.forEach((eventName) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "event-button";
        button.textContent = eventName;
        if (eventName === latestName) {
            button.classList.add("selected");
        }
        button.addEventListener("click", () => {
            recordEvent(eventName);
        });
        eventGrid.appendChild(button);
    });
}

function renderLastRecorded() {
    const event = getLatestActiveEvent();
    if (!event) {
        lastRecorded.classList.add("hidden");
        return;
    }
    lastRecorded.classList.remove("hidden");
    lastEventName.textContent = event.event;
    lastEventElapsed.textContent = formatElapsed(event.elapsed_seconds * 1000);
}

function renderTimeline(target, allowCorrections) {
    target.innerHTML = "";
    if (caseState.events.length === 0) {
        const empty = document.createElement("div");
        empty.className = "timeline-empty";
        empty.textContent = "No events recorded yet.";
        target.appendChild(empty);
        return;
    }
    caseState.events.forEach((event, index) => {
        const item = document.createElement("div");
        item.className = "timeline-item";
        if (event.status === "removed") {
            item.classList.add("removed");
        }
        const mainRow = document.createElement("div");
        mainRow.className = "timeline-main-row";
        const left = document.createElement("div");
        left.className = "timeline-main";
        const nameRow = document.createElement("div");
        nameRow.className = "timeline-name-row";
        const name = document.createElement("div");
        name.className = "timeline-name";
        name.textContent = `${String(index + 1).padStart(2, "0")} · ` + event.event;
        nameRow.appendChild(name);
        if (event.status === "removed") {
            const chip = document.createElement("span");
            chip.className = "status-chip";
            chip.textContent = "REMOVED";
            nameRow.appendChild(chip);
        }
        left.appendChild(nameRow);
        if (event.event_original !== event.event) {
            const original = document.createElement("div");
            original.className = "timeline-meta";
            original.textContent = `Original: ${event.event_original}`;
            left.appendChild(original);
        }
        const meta = document.createElement("div");
        meta.className = "timeline-meta";
        const referenceText = `Ref ${formatClock(event.reference_datetime)}`;
        const eegDatetime = getEegDatetime(event.reference_datetime);
        if (eegDatetime) {
            meta.textContent = referenceText + ` · EEG ${formatClock(eegDatetime)}`;
        }
        else {
            meta.textContent = referenceText;
        }
        left.appendChild(meta);
        if (event.note) {
            const note = document.createElement("div");
            note.className = "timeline-meta";
            note.textContent = `Note: ${event.note}`;
            left.appendChild(note);
        }
        if (event.correction_count > 0) {
            const correction = document.createElement("div");
            correction.className = "timeline-meta";
            correction.textContent = `Corrections: ${event.correction_count}`;
            left.appendChild(correction);
        }
        const time = document.createElement("div");
        time.className = "timeline-time";
        time.textContent = formatElapsed(event.elapsed_seconds * 1000);
        mainRow.appendChild(left);
        mainRow.appendChild(time);
        item.appendChild(mainRow);
        if (allowCorrections) {
            const actions = document.createElement("div");
            actions.className = "timeline-actions";
            const renameButton = document.createElement("button");
            renameButton.type = "button";
            renameButton.className = "mini-button";
            renameButton.textContent = "Rename";
            renameButton.addEventListener("click", () => {
                renameEventAtIndex(index);
            });
            const statusButton = document.createElement("button");
            statusButton.type = "button";
            statusButton.className = "mini-button";
            statusButton.textContent = event.status === "removed" ? "Restore" : "Remove";
            statusButton.addEventListener("click", () => {
                toggleEventStatusAtIndex(index);
            });
            actions.appendChild(renameButton);
            actions.appendChild(statusButton);
            item.appendChild(actions);
        }
        target.appendChild(item);
    });
}

function renderComplete() {
    completeView.classList.remove("hidden");
    completeCaseId.textContent = caseState.case_id;
    const activeCount = caseState.events.filter((event) => event.status === "active").length;
    const removedCount = caseState.events.length - activeCount;
    completeSummary.textContent = `${activeCount} active` + (removedCount > 0 ? ` · ${removedCount} removed` : "") + ` · ${caseState.events.length} total` + " · " + formatElapsed(caseState.elapsed_checkpoint_ms);
    renderCalibration(completeReferenceTime, completeEegTime, completeCalibrationStatus);
    renderTimeline(completeTimeline, true);
    if (caseState.library_id) {
        saveLibraryButton.textContent = "UPDATE SAVED CASE";
        librarySaveStatus.textContent = "Saved to Case Library. Save again after QC changes to update the archived copy.";
    }
    else {
        saveLibraryButton.textContent = "SAVE TO CASE LIBRARY";
        librarySaveStatus.textContent = "Not saved to Case Library.";
    }
    newCaseButton.textContent = caseState.library_id ? "New Case" : "Discard Case";
    if (caseState.library_id) {
        resumeRecordingButton.classList.add("hidden");
    }
    else {
        resumeRecordingButton.classList.remove("hidden");
    }
}

/* =========================================================

   EVENT LISTENERS

   ========================================================= */
startButton.addEventListener("click", startExperiment);
endButton.addEventListener("click", endExperiment);
newCaseButton.addEventListener("click", newCase);
resumeRecordingButton.addEventListener("click", resumeExperiment);
saveLibraryButton.addEventListener("click", archiveCurrentCase);
exportCsvButton.addEventListener("click", exportCsv);
if (exportAllCsvButton) {
    exportAllCsvButton.addEventListener("click", exportAllLibraryCsv);
}
if (backupLibraryButton) {
    backupLibraryButton.addEventListener("click", exportLibraryBackup);
}
undoButton.addEventListener("click", undoLastEvent);
restoreButton.addEventListener("click", restoreLastRemovedEvent);
runningApplyCalibration.addEventListener("click", () => {
    applyCalibration(runningReferenceTime, runningEegTime);
});
runningClearCalibration.addEventListener("click", clearCalibration);
completeApplyCalibration.addEventListener("click", () => {
    applyCalibration(completeReferenceTime, completeEegTime);
});
completeClearCalibration.addEventListener("click", clearCalibration);

/* =========================================================
   GENERAL WELCOME · first use, never interrupt RUNNING/COMPLETE
   This flag stores ONLY whether onboarding was seen, not case data.
   ========================================================= */
const WELCOME_SEEN_KEY = "experiment-marker-general-welcome-v1-seen";
const welcomeGate = document.querySelector("#welcomeGate");
const welcomeFrame = document.querySelector("#welcomeFrame");

function markWelcomeSeen() {
    try { localStorage.setItem(WELCOME_SEEN_KEY, "1"); }
    catch (error) { console.warn("Welcome preference could not be saved:", error); }
}

function isWelcomeSeen() {
    try { return localStorage.getItem(WELCOME_SEEN_KEY) === "1"; }
    catch (error) { return false; }
}

function maybeShowWelcome(storedCase) {
    if (!welcomeGate || !welcomeFrame) return;

    // RUNNING / COMPLETE：优先恢复实验，不显示 Welcome
    if (caseState.state !== "READY") return;

    // READY：每次重新加载应用都显示 Welcome
    welcomeGate.hidden = false;
    document.body.classList.add("welcome-visible");
    welcomeFrame.src = "./welcome.html";
}

let welcomeExitInProgress = false;

function finishWelcomeExit() {
    // Do not touch persisted cases, presets, or runtime timers.
    welcomeGate.hidden = true;
    welcomeGate.classList.remove("is-exiting");
    document.body.classList.remove("welcome-visible", "welcome-exiting");
    welcomeFrame.removeAttribute("src");
    welcomeExitInProgress = false;
    if (caseState.state === "READY") {
        readyView.setAttribute("tabindex", "-1");
        readyView.focus({ preventScroll: true });
    }
}

function exitWelcome() {
    if (!welcomeGate || welcomeGate.hidden || welcomeExitInProgress) return;
    welcomeExitInProgress = true; // Double clicks/messages must not restart the transition.
    const isPreview = new URLSearchParams(window.location.search).get("welcome") === "preview";
    if (!isPreview) markWelcomeSeen();

    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        finishWelcomeExit();
        return;
    }

    document.body.classList.add("welcome-exiting");
    welcomeGate.classList.add("is-exiting");
    let finished = false;
    let fallbackTimer;
    const onTransitionEnd = (event) => {
        if (event.target === welcomeGate && event.propertyName === "opacity") finish();
    };
    function finish() {
        if (finished) return;
        finished = true;
        welcomeGate.removeEventListener("transitionend", onTransitionEnd);
        window.clearTimeout(fallbackTimer);
        finishWelcomeExit();
    }
    welcomeGate.addEventListener("transitionend", onTransitionEnd);
    // Guard against interrupted CSS transitions (e.g. tab backgrounding).
    fallbackTimer = window.setTimeout(finish, 600);
}

window.addEventListener("message", (event) => {
    const sameOrigin = event.origin === window.location.origin ||
        (window.location.protocol === "file:" && event.origin === "null");
    if (event.source !== welcomeFrame.contentWindow || !sameOrigin) return;
    if (event.data && event.data.type === "experiment-marker-welcome-complete" && event.data.version === 1) {
        exitWelcome();
    }
});

/* =========================================================

   INITIALIZE

   ========================================================= */

async function initializeApplication() {
    try {
        const stored = await loadPersistentCase();
        await refreshLibraryRecords();
        caseState = stored ? normalizeLoadedState(stored) : createInitialState();
        initializeRuntimeTimer();
        render();
        // Welcome is nonessential: any problem here must NOT reset the loaded case.
        try { maybeShowWelcome(stored); }
        catch (welcomeError) {
            console.warn("Welcome unavailable; showing the restored app:", welcomeError);
            if (welcomeGate) welcomeGate.hidden = true;
            document.body.classList.remove("welcome-visible");
        }
    }
    catch (error) {
        console.error("Application initialization failed:", error);
        /*

        Fail safely into a usable empty state.

        */
        caseState = createInitialState();
        initializeRuntimeTimer();
        render();
        // If storage hydration fails, do not block the app behind onboarding.
    }
    finally {
        document.body.classList.remove("app-booting");
    }
}
initializeClockPicker();
initializeEventPresets();
initializeApplication();
