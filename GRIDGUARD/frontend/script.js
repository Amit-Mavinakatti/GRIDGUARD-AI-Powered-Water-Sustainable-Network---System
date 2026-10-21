"use strict";

/* =========================================================
   GRIDGUARD — INTERACTIVE FRONTEND
   Connects to the existing Flask Python API.
   All telemetry is explicitly treated as simulated data.
   ========================================================= */

const API = {
    health: "/api/health",
    dashboard: "/api/dashboard",
    scada: "/api/scada",
    datasets: "/api/datasets",
    dataset: "/api/dataset",
    simulate: "/api/simulate-leak",
    reset: "/api/reset",
    aiDiagnose: "/api/ai-diagnose"
};

const REFRESH_INTERVAL = 3000;
const MAX_EVENTS = 60;

const state = {
    connected: false,
    dashboard: null,
    scada: null,
    datasets: [],
    selectedDataset: null,
    history: [],
    events: [],
    eventFilter: "all",
    selectedPipe: null,
    refreshTimer: null,
    refreshInProgress: false,
    busy: false,
    chartHoverIndex: null,
    lastPayloadSignature: null
};

const $ = (selector, root = document) => root.querySelector(selector);  const $$ = (selector, root = document) =>
    Array.from(root.querySelectorAll(selector));

const SVG_NS = "http://www.w3.org/2000/svg";

const formatNumber = (value, digits = 2) => {
    const number = Number(value);

    return Number.isFinite(number)
        ? number.toFixed(digits)
        : "—";
};

const signedNumber = (value, digits = 2) => {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return "—";
    }

    return `${number > 0 ? "+" : ""}${number.toFixed(digits)}`;
};

const escapeHTML = (value) =>
    String(value ?? "").replace(/[&<>"']/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[character]);

function localTime() {
    return new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });
}

function eventTimestamp() {
    return new Date().toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });
}

function addEvent(type, title, message) {
    state.events.unshift({
        id: `${Date.now()}-${Math.random()}`,
        type,
        title,
        message,
        time: eventTimestamp()
    });

    state.events = state.events.slice(0, MAX_EVENTS);

    renderEvents();
}

function showToast(title, message, type = "success") {
    const container = $("#toastContainer");

    if (!container) return;

    const toast = document.createElement("div");
    toast.className = `toast${type === "error" ? " toast-error" : ""}`;

    const icon = document.createElement("span");
    icon.className = "toast-icon";
    icon.textContent = type === "error" ? "!" : "✓";

    const content = document.createElement("div");

    const heading = document.createElement("strong");
    heading.textContent = title;

    const description = document.createElement("p");
    description.textContent = message;

    content.append(heading, description);
    toast.append(icon, content);
    container.appendChild(toast);

    window.setTimeout(() => {
        toast.remove();
    }, 5000);
}

async function apiRequest(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            Accept: "application/json",
            ...(options.body ? {
                "Content-Type": "application/json"
            } : {}),
            ...options.headers
        }
    });

    const contentType = response.headers.get("content-type") || "";

    let data;

    if (contentType.includes("application/json")) {
        data = await response.json();
    } else {
        throw new Error(
            `Expected JSON from ${url}. Check that the Python API is running.`
        );
    }

    if (!response.ok) {
        throw new Error(
            data.error || `Request failed (${response.status}).`
        );
    }

    return data;
}

/* =========================================================
   AI INCIDENT CO-PILOT DIAGNOSIS (UPDATED ENDPOINT)
   ========================================================= */

async function runAiDiagnosis() {
    const idleBanner = $("#aiIdleBanner");
    const loader = $("#aiLoader");
    const responseBox = $("#aiResponseBox");
    const btn = $("#aiAnalyzeBtn");

    if (idleBanner) idleBanner.style.display = "none";
    if (responseBox) responseBox.style.display = "none";
    if (loader) loader.style.display = "flex";
    if (btn) btn.disabled = true;

    try {
        // 1. Retrieve Gemini API Key saved locally
        const apiKey = localStorage.getItem("gg_gemini_key") || "";

        if (!apiKey) {
            showToast("API Key Required", "Please save a valid Gemini API key in the configuration panel.", "error");
            if (loader) loader.style.display = "none";
            if (idleBanner) idleBanner.style.display = "flex";
            return;
        }

        // 2. Build telemetry payload from current application state
        const activeEdges = state.dashboard?.network?.edges || [];
        const activeNodes = state.dashboard?.network?.nodes || [];
        const leakingPipes = activeEdges.filter(e => e.leak);

        const telemetryPayload = {
            network_summary: {
                active_fault_pipe: leakingPipes.length > 0 ? leakingPipes.map(p => p.id).join(", ") : "None detected",
                average_pressure_psi: state.dashboard?.telemetry?.average_pressure ?? "—",
                warning_junction_count: activeNodes.filter(n => n.status === "warning").length
            },
            junction_readings: activeNodes.map(node => ({
                junction_id: node.id,
                current_pressure_psi: formatNumber(node.pressure),
                healthy_baseline_psi: formatNumber(node.healthy_pressure),
                delta_psi: signedNumber(Number(node.pressure) - Number(node.healthy_pressure))
            }))
        };

        // 3. Construct structured prompt asking for JSON response
        const promptText = `You are GRIDGUARD's AI Water Infrastructure Co-Pilot.
Analyze the following real-time network telemetry payload:

${JSON.stringify(telemetryPayload, null, 2)}

Provide your response strictly in raw JSON format (without code block formatting) matching this key structure:
{
  "urgency": "CRITICAL" | "WARNING" | "STABLE",
  "diagnosis": "A short 1-2 sentence overview of network health and identified leaks.",
  "recommended_actions": [
    "Step 1 action",
    "Step 2 action",
    "Step 3 action"
  ]
}`;

        // 4. Call Google Gemini API using gemini-3.8-flash
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`;

        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                contents: [{
                    parts: [{ text: promptText }]
                }]
            })
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error?.message || `Gemini API returned status ${response.status}`);
        }

        const result = await response.json();
        const candidateText = result.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!candidateText) {
            throw new Error("No text content returned from Gemini API.");
        }

        // 5. Clean up markdown JSON wrapper if returned by model
        const cleanedJsonText = candidateText.replace(/```json/g, "").replace(/```/g, "").trim();
        const data = JSON.parse(cleanedJsonText);

        // 6. Update UI elements
        const urgencyElem = $("#aiUrgencyBadge");
        if (urgencyElem) {
            const urgency = data.urgency || "STABLE";
            urgencyElem.textContent = urgency;
            if (urgency === "CRITICAL") {
                urgencyElem.className = "urgency-pill urgency-critical";
            } else if (urgency === "WARNING") {
                urgencyElem.className = "urgency-pill urgency-warning";
            } else {
                urgencyElem.className = "urgency-pill urgency-stable";
            }
        }

        const diagText = $("#aiDiagnosisText");
        if (diagText) {
            diagText.textContent = data.diagnosis || "All network parameters within operational thresholds.";
        }

        const actionsList = $("#aiActionsList");
        if (actionsList) {
            actionsList.replaceChildren();
            (data.recommended_actions || []).forEach(action => {
                const li = document.createElement("li");
                li.textContent = action;
                actionsList.appendChild(li);
            });
        }

        if (loader) loader.style.display = "none";
        if (responseBox) responseBox.style.display = "flex";

        addEvent(
            "system",
            "AI Diagnosis Generated",
            `System urgency assessed as: ${data.urgency || "STABLE"}.`
        );

        showToast("Diagnosis Complete", "Gemini AI analysis generated successfully.");

    } catch (err) {
        console.error("AI Analysis error:", err);
        if (loader) loader.style.display = "none";
        if (idleBanner) idleBanner.style.display = "flex";
        showToast("AI Diagnosis Failed", err.message || "Could not complete AI analysis.", "error");
    } finally {
        if (btn) btn.disabled = false;
    }
}
/* =========================================================
   CONNECTION STATUS
   ========================================================= */

function setConnectionStatus(connected, message = "") {
    state.connected = connected;

    const dotSelectors = [
        "#sidebarStatusDot",
        "#topStatusDot"
    ];

    dotSelectors.forEach(selector => {
        const dot = $(selector);

        if (dot) {
            dot.classList.toggle("offline", !connected);
        }
    });

    const sidebarLabel = $("#connectionLabel");
    const sidebarDescription = $("#connectionDescription");
    const topStatusText = $("#topStatusText");
    const footerStatus = $("#footerApiStatus");
    const refreshButton = $("#refreshButton");

    if (sidebarLabel) {
        sidebarLabel.textContent = connected
            ? "Python API connected"
            : "API disconnected";
    }

    if (sidebarDescription) {
        sidebarDescription.textContent = connected
            ? "Receiving data from the local GRIDGUARD service."
            : message || "Cannot reach the Python API.";
    }

    if (topStatusText) {
        topStatusText.textContent = connected
            ? "API connected"
            : "Offline";
    }

    if (footerStatus) {
        footerStatus.textContent = connected
            ? "Connected"
            : "Disconnected";
    }

    if (refreshButton) {
        refreshButton.disabled = !connected;
    }
}

async function checkConnection() {
    try {
        await apiRequest(API.health);
        setConnectionStatus(true);
        return true;
    } catch (error) {
        setConnectionStatus(false, error.message);
        return false;
    }
}

/* =========================================================
   INITIALIZATION
   ========================================================= */

document.addEventListener("DOMContentLoaded", initialize);

function initialize() {
    bindNavigation();
    bindSimulator();
    bindMonitoringFilters();
    bindAlertFilters();
    bindModal();
    bindButtons();
    bindDatasetPanel();
    bindAssistant();
    bindChartInteraction();
    bindKeyboardShortcuts();

    updateSeverityDisplay();

    addEvent(
        "system",
        "Dashboard initialized",
        "GRIDGUARD frontend is ready to connect to the Python simulation."
    );

    startPolling();
}

function startPolling() {
    if (state.refreshTimer) {
        window.clearInterval(state.refreshTimer);
    }

    refreshDashboard();
    refreshScada();
    loadDatasets();

    state.refreshTimer = window.setInterval(() => {
        refreshDashboard();
        refreshScada();
    }, REFRESH_INTERVAL);
}

async function refreshScada() {
    try {
        const data = await apiRequest(API.scada);
        state.scada = data;
        renderScada(data);
    } catch (error) {
        state.scada = null;
        renderScadaUnavailable(error.message);
    }
}

function renderScada(data) {
    const pill = $("#scadaConnectionPill");
    const label = $("#scadaConnectionLabel");
    const source = $("#scadaSourceLabel");
    const updated = $("#scadaUpdatedAt");
    const endpoint = $("#scadaEndpoint");
    const tbody = $("#scadaTableBody");

    pill?.classList.add("scada-online");
    pill?.classList.remove("scada-offline");
    if (label) label.textContent = "OPC UA connected";
    if (source) source.textContent = "Live readings from GRIDGUARD_SCADA";
    if (updated) updated.textContent = `Last read ${localTime()}`;
    if (endpoint && data.endpoint) endpoint.textContent = data.endpoint;
    if (!tbody) return;

    tbody.replaceChildren();

    (data.points || []).forEach(point => {
        const row = document.createElement("tr");
        const sensor = document.createElement("td");
        sensor.className = "junction-cell";
        sensor.textContent = point.sensor_id;

        const pressure = document.createElement("td");
        pressure.className = "pressure-value";
        pressure.textContent = `${formatNumber(point.pressure_psi, 1)} PSI`;

        const flow = document.createElement("td");
        flow.textContent = point.flow_sensor
            ? `${formatNumber(point.flow, 1)} L/s`
            : "—";

        const statusCell = document.createElement("td");
        const badge = document.createElement("span");
        const warning = point.status === "WARNING";
        badge.className = `status-badge ${warning ? "status-warning" : "status-normal"}`;
        badge.textContent = warning ? "Low pressure" : "Normal";
        statusCell.appendChild(badge);

        row.append(sensor, pressure, flow, statusCell);
        tbody.appendChild(row);
    });

    if (!tbody.children.length) {
        appendTableMessage(tbody, "No SCADA sensor points were returned.", 4);
    }
}

function renderScadaUnavailable(message) {
    const pill = $("#scadaConnectionPill");
    const label = $("#scadaConnectionLabel");
    const source = $("#scadaSourceLabel");
    const updated = $("#scadaUpdatedAt");
    const tbody = $("#scadaTableBody");

    pill?.classList.add("scada-offline");
    pill?.classList.remove("scada-online");
    if (label) label.textContent = "SCADA offline";
    if (source) source.textContent = "Start the OPC UA simulator to stream sensor values.";
    if (updated) updated.textContent = message || "Waiting for OPC UA connection.";
    if (tbody) {
        tbody.replaceChildren();
        appendTableMessage(tbody, "SCADA is unavailable. Run python scada_simulator.py from the GRIDGUARD project folder.", 4);
    }
}

function appendTableMessage(tbody, message, columnCount) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = columnCount;
    cell.className = "empty-state";
    cell.textContent = message;
    row.appendChild(cell);
    tbody.appendChild(row);
}

function bindDatasetPanel() {
    $("#loadDatasetButton")?.addEventListener("click", () => {
        loadDataset($("#datasetSelect")?.value || "");
    });

    $("#datasetSelect")?.addEventListener("change", event => {
        state.selectedDataset = event.target.value;
    });
}

async function loadDatasets() {
    const select = $("#datasetSelect");
    const button = $("#loadDatasetButton");
    if (!select) return;

    try {
        const result = await apiRequest(API.datasets);
        state.datasets = result.datasets || [];
        select.replaceChildren();

        if (!state.datasets.length) {
            select.add(new Option("No CSV datasets found", ""));
            if (button) button.disabled = true;
            setText("#datasetSummary", "No CSV datasets are available in GRIDGUARD/data.");
            return;
        }

        state.datasets.forEach(dataset => {
            select.add(new Option(dataset.title, dataset.filename));
        });

        const leakDb = state.datasets.find(dataset =>
            dataset.filename === "LeakDB_Scenario6_Labels.csv"
        );
        select.value = leakDb?.filename || state.datasets[0].filename;
        state.selectedDataset = select.value;
        if (button) button.disabled = false;
        await loadDataset(select.value);
    } catch (error) {
        select.replaceChildren(new Option("Dataset list unavailable", ""));
        if (button) button.disabled = true;
        setText("#datasetSummary", error.message);
    }
}

async function loadDataset(filename) {
    if (!filename) return;

    const button = $("#loadDatasetButton");
    if (button) button.disabled = true;
    setText("#datasetSummary", "Loading dataset preview...");

    try {
        const result = await apiRequest(API.dataset, {
            method: "POST",
            body: JSON.stringify({ filename })
        });
        state.selectedDataset = filename;
        renderDatasetPreview(result.dataset);
    } catch (error) {
        setText("#datasetSummary", error.message);
        const tbody = $("#datasetPreviewBody");
        if (tbody) {
            tbody.replaceChildren();
            appendTableMessage(tbody, "Could not load this dataset.", 1);
        }
    } finally {
        if (button) button.disabled = false;
    }
}

function renderDatasetPreview(dataset) {
    const head = $("#datasetPreviewHead");
    const body = $("#datasetPreviewBody");
    if (!head || !body) return;

    const columns = dataset.columns || [];
    head.replaceChildren();
    body.replaceChildren();

    const headerRow = document.createElement("tr");
    columns.forEach(column => {
        const cell = document.createElement("th");
        cell.textContent = column;
        headerRow.appendChild(cell);
    });
    head.appendChild(headerRow);

    (dataset.preview || []).slice(0, 8).forEach(record => {
        const row = document.createElement("tr");
        columns.forEach(column => {
            const cell = document.createElement("td");
            const value = record[column];
            cell.textContent = value === null || value === undefined
                ? "—"
                : String(value);
            row.appendChild(cell);
        });
        body.appendChild(row);
    });

    if (!body.children.length) {
        appendTableMessage(body, "This dataset has no preview rows.", Math.max(columns.length, 1));
    }

    setText(
        "#datasetSummary",
        `${dataset.description} ${Number(dataset.rows).toLocaleString()} rows · ${columns.length} columns · ${dataset.filename}`
    );
}

/* =========================================================
   DASHBOARD DATA
   ========================================================= */

async function refreshDashboard(manual = false) {
    if (state.refreshInProgress) return;

    state.refreshInProgress = true;

    try {
        const data = await apiRequest(API.dashboard);

        state.dashboard = data;

        setConnectionStatus(true);
        renderDashboard(data);

        if (manual) {
            showToast(
                "Data refreshed",
                "Latest data received from the Python API."
            );
        }
    } catch (error) {
        setConnectionStatus(false, error.message);

        if (manual) {
            showToast(
                "Refresh failed",
                error.message,
                "error"
            );
        }
    } finally {
        state.refreshInProgress = false;
    }
}

function renderDashboard(data) {
    renderMetrics(data);
    renderNetwork(data);
    renderPipeOptions(data);
    renderMonitoring(data);
    renderDetections(data);
    renderPressureChart(data);
    renderSimulatorStatus(data);
    updateTimestamps(data);
}

function updateTimestamps(data) {
    const lastUpdated = $("#lastUpdated");

    if (lastUpdated) {
        lastUpdated.textContent = data.generated_at || localTime();
    }
}

/* =========================================================
   METRIC CARDS
   ========================================================= */

function renderMetrics(data) {
    const network = data.network || {};
    const telemetry = data.telemetry || {};
    const summary = data.summary || {};
    const detections = data.detections || [];
    const leakingPipes = (network.edges || []).filter(edge => edge.leak);
    const activeLeakCount = Number(summary.active_leaks ?? leakingPipes.length);

    setText("#junctionCount", network.node_count ?? 0);
    setText("#pipeCount", network.pipe_count ?? 0);

    setText(
        "#averagePressure",
        formatNumber(telemetry.average_pressure)
    );

    setText("#activeLeakCount", activeLeakCount);
    setText("#navLeakCount", detections.length);

    setText(
        "#leakStatusText",
        activeLeakCount
            ? "Simulated leak detected"
            : detections.length
                ? "Potential leak flagged"
                : "No simulated leaks"
    );

    setText(
        "#networkHealthLabel",
        activeLeakCount || detections.length
            ? "Attention required"
            : "Network stable"
    );

    setText(
        "#networkStatusText",
        summary.network_status || "Unknown"
    );

    const leakDot = $("#leakStatusDot");

    if (leakDot) {
        leakDot.style.color = activeLeakCount || detections.length
            ? "var(--red)"
            : "var(--green)";
    }

    const activeConnections = $("#activeConnections");

    if (activeConnections) {
        activeConnections.textContent =
            `${network.pipe_count ?? 0} segments`;
    }
}

function setText(selector, value) {
    const element = $(selector);

    if (element) {
        element.textContent = String(value);
    }
}

/* =========================================================
   PIPELINE SVG MAP
   ========================================================= */

function svgElement(tag, attributes = {}, textContent = null) {
    const element = document.createElementNS(SVG_NS, tag);

    Object.entries(attributes).forEach(([key, value]) => {
        element.setAttribute(key, String(value));
    });

    if (textContent !== null) {
        element.textContent = textContent;
    }

    return element;
}

function renderNetwork(data) {
    const svg = $("#networkSvg");

    if (!svg) return;

    const network = data.network || {};
    const nodes = network.nodes || [];
    const edges = network.edges || [];

    svg.replaceChildren();

    if (!nodes.length) {
        svg.appendChild(
            svgElement(
                "text",
                {
                    x: 50,
                    y: 50,
                    "text-anchor": "middle",
                    fill: "#9aabc5",
                    "font-size": 4
                },
                "No pipeline data available"
            )
        );

        return;
    }

    const positions = new Map(
        nodes.map(node => [node.id, node])
    );

    edges.forEach(edge => {
        const start = positions.get(edge.start);
        const end = positions.get(edge.end);

        if (!start || !end) return;

        const group = svgElement("g", {
            class: `network-edge${edge.leak ? " is-leaking" : ""}`,
            tabindex: 0,
            role: "button",
            "aria-label": `Inspect pipe ${edge.id}`,
            "data-pipe-id": edge.id
        });

        group.appendChild(
            svgElement("line", {
                x1: start.x,
                y1: start.y,
                x2: end.x,
                y2: end.y,
                class: "pipe-hitbox"
            })
        );

        group.appendChild(
            svgElement("line", {
                x1: start.x,
                y1: start.y,
                x2: end.x,
                y2: end.y,
                class: "pipe-sheen"
            })
        );

        group.appendChild(
            svgElement("line", {
                x1: start.x,
                y1: start.y,
                x2: end.x,
                y2: end.y,
                class: "pipe-base"
            })
        );

        group.appendChild(
            svgElement("line", {
                x1: start.x,
                y1: start.y,
                x2: end.x,
                y2: end.y,
                class: "pipe-overlay"
            })
        );

        const midX = (Number(start.x) + Number(end.x)) / 2;
        const midY = (Number(start.y) + Number(end.y)) / 2;

        const label = svgElement(
            "text",
            {
                x: midX,
                y: midY - 2.1,
                "text-anchor": "middle",
                class: `pipe-label${edge.leak ? " leak-label" : ""}`
            },
            edge.id
        );

        label.setAttribute("aria-hidden", "true");

        group.appendChild(label);

        if (edge.leak) {
            const leakBadge = svgElement(
                "text",
                {
                    x: midX,
                    y: midY - 8.5,
                    "text-anchor": "middle",
                    class: "pipe-leak-badge",
                    "aria-hidden": "true"
                },
                `LEAK · ${Math.round(Number(edge.severity || 0) * 100)}%`
            );

            group.appendChild(leakBadge);
            group.appendChild(
                svgElement("circle", {
                    cx: midX,
                    cy: midY,
                    r: 5,
                    class: "leak-pulse"
                })
            );
        }

        group.addEventListener("click", () => {
            openPipeDetails(edge);
        });

        group.addEventListener("keydown", event => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openPipeDetails(edge);
            }
        });

        svg.appendChild(group);
    });

    nodes.forEach(node => {
        const group = svgElement("g", {
            class: `network-node${node.id === "Tank" ? " is-source" : ""}${node.leak ? " node-leaking" : ""}${node.status === "warning" ? " node-warning" : ""}`,
            tabindex: 0,
            role: "button",
            "aria-label": `Inspect junction ${node.id}`,
            "data-node-id": node.id
        });

        if (node.leak) {
            group.appendChild(
                svgElement("circle", {
                    cx: node.x,
                    cy: node.y,
                    r: 7.5,
                    class: "junction-leak-pulse",
                    "aria-hidden": "true"
                })
            );
        }

        group.appendChild(
            svgElement("circle", {
                cx: node.x,
                cy: node.y,
                r: 4.7,
                class: "node-halo"
            })
        );

        group.appendChild(
            svgElement("circle", {
                cx: node.x,
                cy: node.y,
                r: 3.5,
                class: "node-core"
            })
        );

        if (node.id === "Tank") {
            group.appendChild(
                svgElement("path", {
                    d: `M ${Number(node.x) - 1.8} ${Number(node.y) - 0.6} h 3.6 v 1.6 a 1.8 0.7 0 0 1 -3.6 0 z M ${Number(node.x) - 1.8} ${Number(node.y) - 0.6} a 1.8 0.7 0 0 1 3.6 0`,
                    class: "source-mark",
                    "aria-hidden": "true"
                })
            );
        }

        const labelY = Number(node.y) - 10;

        group.appendChild(
            svgElement(
                "text",
                {
                    x: node.x,
                    y: labelY,
                    "text-anchor": "middle",
                    "font-size": 5,
                    class: "node-label"
                },
                node.id
            )
        );

        if (node.leak) {
            group.appendChild(
                svgElement(
                    "text",
                    {
                        x: node.x,
                        y: Number(node.y) + 13,
                        "text-anchor": "middle",
                        class: "junction-leak-badge",
                        "aria-hidden": "true"
                    },
                    "LEAK ZONE"
                )
            );
        }

        group.appendChild(
            svgElement(
                "text",
                {
                    x: node.x,
                    y: Number(node.y) + 7,
                    "text-anchor": "middle",
                    "font-size": 3.5,
                    class: "node-value"
                },
                `${formatNumber(node.pressure, 1)} PSI`
            )
        );

        group.addEventListener("click", () => {
            openJunctionDetails(node);
        });

        group.addEventListener("keydown", event => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openJunctionDetails(node);
            }
        });

        svg.appendChild(group);
    });
}

/* =========================================================
   PIPE DETAILS MODAL
   ========================================================= */

function bindModal() {
    const backdrop = $("#pipeModalBackdrop");

    $("#closePipeModal")?.addEventListener("click", closePipeModal);
    $("#closePipeModalButton")?.addEventListener("click", closePipeModal);

    backdrop?.addEventListener("click", event => {
        if (event.target === backdrop) {
            closePipeModal();
        }
    });

    document.addEventListener("keydown", event => {
        if (event.key === "Escape") {
            closePipeModal();
        }
    });
}

function openModal(title, html) {
    setText("#pipeModalTitle", title);

    const content = $("#pipeModalContent");

    if (content) {
        content.innerHTML = html;
    }

    $("#pipeModalBackdrop")?.classList.remove("hidden");
    $("#closePipeModal")?.focus();
}

function closePipeModal() {
    $("#pipeModalBackdrop")?.classList.add("hidden");
}

function openPipeDetails(edge) {
    const start = state.dashboard?.network?.nodes?.find(
        node => node.id === edge.start
    );

    const end = state.dashboard?.network?.nodes?.find(
        node => node.id === edge.end
    );

    const status = edge.leak
        ? "Simulated leak"
        : "Normal in simulation";

    const severity = edge.leak
        ? `${Math.round(Number(edge.severity) * 100)}%`
        : "0%";

    const description = edge.leak
        ? "This segment is marked as leaking in the current simulation. The displayed detector result is based on the simulator's leak label."
        : "This segment is not marked as leaking in the current simulation. This does not prove that a real-world pipe is leak-free.";

    const html = `
        <div class="modal-detail-grid">
            <div class="modal-detail">
                <span>Pipe identifier</span>
                <strong>${escapeHTML(edge.id)}</strong>
            </div>
            <div class="modal-detail">
                <span>Segment length</span>
                <strong>${formatNumber(edge.length, 0)} m</strong>
            </div>
            <div class="modal-detail">
                <span>Simulation status</span>
                <strong>${escapeHTML(status)}</strong>
            </div>
            <div class="modal-detail">
                <span>Configured severity</span>
                <strong>${severity}</strong>
            </div>
            <div class="modal-detail">
                <span>Start junction</span>
                <strong>${escapeHTML(edge.start)}</strong>
                <small>${formatNumber(start?.pressure)} PSI*</small>
            </div>
            <div class="modal-detail">
                <span>End junction</span>
                <strong>${escapeHTML(edge.end)}</strong>
                <small>${formatNumber(end?.pressure)} PSI*</small>
            </div>
        </div>
        <p class="modal-description">${escapeHTML(description)}</p>
    `;

    state.selectedPipe = edge.id;
    openModal(`Pipe ${edge.id}`, html);
}

function openJunctionDetails(node) {
    const simulationStatus = node.leak
        ? "Leak zone"
        : node.status || "normal";

    const html = `
        <div class="modal-detail-grid">
            <div class="modal-detail">
                <span>Junction identifier</span>
                <strong>${escapeHTML(node.id)}</strong>
            </div>
            <div class="modal-detail">
                <span>Simulation status</span>
                <strong>${escapeHTML(simulationStatus)}</strong>
            </div>
            <div class="modal-detail">
                <span>Current pressure</span>
                <strong>${formatNumber(node.pressure)} PSI*</strong>
            </div>
            <div class="modal-detail">
                <span>Healthy baseline</span>
                <strong>${formatNumber(node.healthy_pressure)} PSI*</strong>
            </div>
            <div class="modal-detail">
                <span>Current flow</span>
                <strong>${formatNumber(node.flow)}</strong>
            </div>
            <div class="modal-detail">
                <span>Pressure variance</span>
                <strong>${signedNumber(
                    Number(node.pressure) - Number(node.healthy_pressure)
                )} PSI*</strong>
            </div>
        </div>
        <p class="modal-description">
            Junction readings are generated by the GRIDGUARD simulation.
            They are illustrative values, not physical sensor measurements.
        </p>
    `;

    openModal(`Junction ${node.id}`, html);
}

/* =========================================================
   PIPE SELECTOR
   ========================================================= */

function renderPipeOptions(data) {
    const select = $("#pipeSelect");

    if (!select) return;

    const edges = data.network?.edges || [];
    const previousValue = select.value;

    select.replaceChildren();

    if (!edges.length) {
        select.add(new Option("No pipe segments available", ""));
        return;
    }

    edges.forEach(edge => {
        const label = `${edge.id} · ${edge.length} m`;
        select.add(new Option(label, edge.id));
    });

    if (edges.some(edge => edge.id === previousValue)) {
        select.value = previousValue;
    } else if (edges.some(edge => edge.id === "J1-J2")) {
        select.value = "J1-J2";
    }
}

/* =========================================================
   SIMULATOR CONTROLS
   ========================================================= */

function bindSimulator() {
    $("#severitySlider")?.addEventListener("input", updateSeverityDisplay);

    $("#leakForm")?.addEventListener("submit", async event => {
        event.preventDefault();

        if (state.busy) return;

        const selectedPipe = $("#pipeSelect")?.value;
        const severity = Number($("#severitySlider")?.value || 50) / 100;

        if (!selectedPipe) {
            showToast(
                "Select a pipe",
                "Choose a valid pipe segment first.",
                "error"
            );
            return;
        }

        const [pipe_start, pipe_end] = selectedPipe.split("-");

        if (!pipe_start || !pipe_end) {
            showToast(
                "Invalid pipe",
                "The selected pipe identifier is not valid.",
                "error"
            );
            return;
        }

        setBusy(true);

        try {
            const result = await apiRequest(API.simulate, {
                method: "POST",
                body: JSON.stringify({
                    pipe_start,
                    pipe_end,
                    severity
                })
            });

            if (result.dashboard) {
                state.dashboard = result.dashboard;
                renderDashboard(result.dashboard);
            } else {
                await refreshDashboard();
            }

            const percent = Math.round(severity * 100);

            addEvent(
                "leak",
                "Leak simulation activated",
                `Pipe ${selectedPipe} · Configured severity ${percent}%.`
            );

            showToast(
                "Simulation updated",
                `A simulated leak is active on ${selectedPipe}.`
            );
        } catch (error) {
            showToast(
                "Could not simulate leak",
                error.message,
                "error"
            );
        } finally {
            setBusy(false);
        }
    });

    $("#resetButton")?.addEventListener("click", async () => {
        if (state.busy) return;

        setBusy(true);

        try {
            const result = await apiRequest(API.reset, {
                method: "POST",
                body: JSON.stringify({})
            });

            if (result.dashboard) {
                state.dashboard = result.dashboard;
                renderDashboard(result.dashboard);
            } else {
                await refreshDashboard();
            }

            addEvent(
                "system",
                "Simulation reset",
                "The active simulated leak has been cleared."
            );

            showToast(
                "Network reset",
                "The simulation has returned to its healthy baseline."
            );
        } catch (error) {
            showToast(
                "Reset failed",
                error.message,
                "error"
            );
        } finally {
            setBusy(false);
        }
    });
}

function setBusy(busy) {
    state.busy = busy;

    const simulateButton = $("#simulateButton");
    const resetButton = $("#resetButton");

    if (simulateButton) {
        simulateButton.disabled = busy;
        simulateButton.textContent = busy
            ? "Processing..."
            : "⚡ Simulate leak";
    }

    if (resetButton) {
        resetButton.disabled = busy;
        resetButton.textContent = busy
            ? "Please wait..."
            : "↺ Reset network";
    }
}

function updateSeverityDisplay() {
    const slider = $("#severitySlider");

    if (!slider) return;

    const value = Number(slider.value);
    const label = $("#severityValue");
    const description = $("#severityDescription");
    const dot = $(".severity-preview-dot");

    if (label) {
        label.textContent = `${value}%`;
    }

    if (description) {
        if (value < 35) {
            description.textContent = "Minor simulated leak";
        } else if (value < 70) {
            description.textContent = "Moderate simulated leak";
        } else {
            description.textContent = "High-severity simulated leak";
        }
    }

    if (dot) {
        dot.style.background = value >= 70
            ? "var(--red)"
            : value >= 35
                ? "var(--orange)"
                : "var(--teal)";
    }
}

function renderSimulatorStatus(data) {
    const element = $("#simulatorStatus");

    if (!element) return;

    const activeLeaks = (data.network?.edges || []).filter(edge => edge.leak);
    const activeLeak = activeLeaks.length > 0;

    element.classList.toggle("has-leak", activeLeak);

    const icon = $(".simulator-status-icon", element);
    const strong = $("strong", element);
    const paragraph = $("p", element);

    if (icon) {
        icon.textContent = activeLeak ? "!" : "✓";
    }

    if (strong) {
        strong.textContent = activeLeak
            ? "Leak scenario active"
            : "Network ready";
    }

    if (paragraph) {
        paragraph.textContent = activeLeak
            ? `${activeLeaks.length} simulated leak(s) currently marked.`
            : "No leak currently marked in the simulation.";
    }
}

/* =========================================================
   LIVE MONITORING TABLE
   ========================================================= */

function bindMonitoringFilters() {
    $("#junctionSearch")?.addEventListener(
        "input",
        () => renderMonitoring(state.dashboard || {})
    );

    $("#junctionStatusFilter")?.addEventListener(
        "change",
        () => renderMonitoring(state.dashboard || {})
    );
}

function renderMonitoring(data) {
    const tbody = $("#monitoringTableBody");

    if (!tbody) return;

    const nodes = data.network?.nodes || [];
    const searchTerm = (
        $("#junctionSearch")?.value || ""
    ).trim().toLowerCase();

    const statusFilter = $("#junctionStatusFilter")?.value || "all";

    const filtered = nodes.filter(node => {
        const matchesSearch = node.id.toLowerCase().includes(searchTerm);

        const matchesStatus = statusFilter === "all"
            || node.status === statusFilter;

        return matchesSearch && matchesStatus;
    });

    tbody.replaceChildren();

    if (!filtered.length) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");

        cell.colSpan = 6;
        cell.className = "empty-state";
        cell.textContent = nodes.length
            ? "No junctions match the selected filters."
            : "Waiting for Python telemetry...";

        row.appendChild(cell);
        tbody.appendChild(row);
    } else {
        filtered.forEach(node => {
            const row = document.createElement("tr");

            const variance = Number(node.pressure) -
                Number(node.healthy_pressure);

            const varianceClass = variance < -0.1
                ? "variance-negative"
                : variance > 0.1
                    ? "variance-positive"
                    : "variance-neutral";

            const status = node.leak
                ? "Leak zone"
                : node.status === "warning"
                    ? "Warning"
                    : "Normal";

            const cells = [
                {
                    className: "junction-cell",
                    html: `
                        <span class="junction-indicator ${node.leak ? "leaking" : node.status === "warning" ? "warning" : ""}"></span>
                        ${escapeHTML(node.id)}
                    `
                },
                {
                    className: "pressure-value",
                    text: `${formatNumber(node.pressure)} PSI`
                },
                {
                    className: "",
                    text: `${formatNumber(node.healthy_pressure)} PSI`
                },
                {
                    className: "",
                    text: formatNumber(node.flow)
                },
                {
                    className: varianceClass,
                    text: `${signedNumber(variance)} PSI`
                },
                {
                    className: "",
                    html: `
                        <span class="status-badge ${node.leak ? "status-leak" : node.status === "warning" ? "status-warning" : "status-normal"}">
                            ${status}
                        </span>
                    `
                }
            ];

            cells.forEach(item => {
                const cell = document.createElement("td");

                if (item.className) {
                    cell.className = item.className;
                }

                if (item.html) {
                    cell.innerHTML = item.html;
                } else {
                    cell.textContent = item.text;
                }

                row.appendChild(cell);
            });

            tbody.appendChild(row);
        });
    }

    setText(
        "#monitoringRecordCount",
        `${filtered.length} of ${nodes.length} monitoring points`
    );
}

/* =========================================================
   DETECTION RESULTS
   ========================================================= */

function renderDetections(data) {
    const container = $("#detectionList");

    if (!container) return;

    const detections = data.detections || [];

    setText("#detectionResultCount", `${detections.length} results`);

    container.replaceChildren();

    if (!detections.length) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent =
            "No simulated leak labels are currently active.";

        container.appendChild(empty);
        return;
    }

    detections.forEach(item => {
        const element = document.createElement("div");
        element.className = "detection-item";

        const severity = Math.round(Number(item.severity) * 100);

        const priority = String(item.priority || "Low").toLowerCase();

        const icon = document.createElement("div");
        icon.className = "detection-icon";
        icon.textContent = "!";

        const copy = document.createElement("div");
        copy.className = "detection-copy";

        const heading = document.createElement("strong");
        heading.textContent = `Pipe ${item.pipe}`;

        const description = document.createElement("small");
        description.textContent =
            `Configured severity: ${severity}% · Status: ${item.status || "Detected"}`;

        copy.append(heading, description);

        const badge = document.createElement("span");
        badge.className = `priority-badge priority-${priority}`;
        badge.textContent = `${item.priority || "Low"} priority`;

        element.append(icon, copy, badge);

        element.style.cursor = "pointer";
        element.title = "Open pipe details";

        element.addEventListener("click", () => {
            const edge = data.network?.edges?.find(
                candidate => candidate.id === item.pipe
            );

            if (edge) {
                openPipeDetails(edge);
            }
        });

        container.appendChild(element);
    });
}

/* =========================================================
   PRESSURE CHART — NATIVE CANVAS
   ========================================================= */

function bindChartInteraction() {
    const canvas = $("#pressureChart");

    if (!canvas) return;

    canvas.addEventListener("mousemove", event => {
        const rect = canvas.getBoundingClientRect();

        const x = event.clientX - rect.left;
        const chartWidth = rect.width;

        const nodes = state.dashboard?.network?.nodes || [];

        if (!nodes.length) return;

        const left = 37;
        const right = 13;
        const plotWidth = chartWidth - left - right;

        const position = Math.max(
            0,
            Math.min(
                nodes.length - 1,
                Math.round((x - left) / (plotWidth / Math.max(1, nodes.length - 1)))
            )
        );

        state.chartHoverIndex = position;
        renderPressureChart(state.dashboard || {});
    });

    canvas.addEventListener("mouseleave", () => {
        state.chartHoverIndex = null;
        renderPressureChart(state.dashboard || {});
    });

    window.addEventListener("resize", () => {
        if (state.dashboard) {
            renderPressureChart(state.dashboard);
        }
    });
}

function renderPressureChart(data) {
    const canvas = $("#pressureChart");

    if (!canvas) return;

    const container = $("#pressureChartContainer");

    const nodes = data.network?.nodes || [];

    const current = nodes.map(node => Number(node.pressure));
    const baseline = nodes.map(node => Number(node.healthy_pressure));
    const labels = nodes.map(node => node.id);

    const currentAverage = current.length
        ? current.reduce((sum, value) => sum + value, 0) / current.length
        : NaN;

    const baselineAverage = baseline.length
        ? baseline.reduce((sum, value) => sum + value, 0) / baseline.length
        : NaN;

    setText("#chartCurrentAverage", formatNumber(currentAverage));
    setText("#chartBaselineAverage", formatNumber(baselineAverage));

    setText(
        "#chartDifference",
        Number.isFinite(currentAverage) && Number.isFinite(baselineAverage)
            ? `${signedNumber(currentAverage - baselineAverage)} PSI`
            : "—"
    );

    if (!container) return;

    const width = Math.max(260, container.clientWidth - 2);
    const height = Math.max(160, container.clientHeight);

    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);

    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");

    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const padding = {
        top: 18,
        right: 13,
        bottom: 29,
        left: 36
    };

    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;

    if (!nodes.length) {
        ctx.fillStyle = "#71829e";
        ctx.font = "11px Segoe UI, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(
            "Waiting for telemetry data",
            width / 2,
            height / 2
        );
        return;
    }

    const allValues = [...current, ...baseline].filter(
        value => Number.isFinite(value)
    );

    if (!allValues.length) return;

    const minimum = Math.floor(Math.min(...allValues) - 3);
    const maximum = Math.ceil(Math.max(...allValues) + 3);
    const range = Math.max(1, maximum - minimum);

    const xPosition = index => {
        if (nodes.length === 1) {
            return padding.left + plotWidth / 2;
        }

        return padding.left +
            (index / (nodes.length - 1)) * plotWidth;
    };

    const yPosition = value =>
        padding.top +
        ((maximum - value) / range) * plotHeight;

    ctx.lineWidth = 1;
    ctx.font = "9px Segoe UI, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    for (let tick = 0; tick <= 4; tick++) {
        const value = maximum - (range * tick) / 4;
        const y = yPosition(value);

        ctx.strokeStyle = "rgba(143, 167, 205, 0.12)";
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(width - padding.right, y);
        ctx.stroke();

        ctx.fillStyle = "#7e91af";
        ctx.fillText(value.toFixed(0), padding.left - 8, y);
    }

    function drawSeries(values, stroke, fill, dashed = false) {
        if (!values.length) return;

        ctx.beginPath();

        values.forEach((value, index) => {
            const x = xPosition(index);
            const y = yPosition(value);

            if (index === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        });

        if (fill && values.length > 1) {
            const lastX = xPosition(values.length - 1);
            const firstX = xPosition(0);
            const baseY = padding.top + plotHeight;

            ctx.lineTo(lastX, baseY);
            ctx.lineTo(firstX, baseY);
            ctx.closePath();

            ctx.fillStyle = fill;
            ctx.fill();

            ctx.beginPath();

            values.forEach((value, index) => {
                const x = xPosition(index);
                const y = yPosition(value);

                if (index === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            });
        }

        ctx.setLineDash(dashed ? [4, 4] : []);
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 2;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke();
        ctx.setLineDash([]);

        values.forEach((value, index) => {
            const x = xPosition(index);
            const y = yPosition(value);

            ctx.beginPath();
            ctx.arc(x, y, 3, 0, Math.PI * 2);
            ctx.fillStyle = stroke;
            ctx.fill();
        });
    }

    drawSeries(
        baseline,
        "#79a8ff",
        "rgba(121, 168, 255, 0.035)",
        true
    );

    drawSeries(
        current,
        "#5de4c7",
        "rgba(93, 228, 199, 0.09)"
    );

    ctx.fillStyle = "#8b9fbd";
    ctx.font = "9px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    labels.forEach((label, index) => {
        ctx.fillText(
            label,
            xPosition(index),
            height - padding.bottom + 10
        );
    });

    const hoverIndex = state.chartHoverIndex;

    if (
        hoverIndex !== null &&
        hoverIndex >= 0 &&
        hoverIndex < nodes.length
    ) {
        const x = xPosition(hoverIndex);
        const y = yPosition(current[hoverIndex]);

        ctx.strokeStyle = "rgba(205, 223, 250, 0.28)";
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(x, padding.top);
        ctx.lineTo(x, padding.top + plotHeight);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#5de4c7";
        ctx.strokeStyle = "#0e1b2e";
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();

        const tooltipWidth = 128;
        const tooltipHeight = 51;

        const tooltipX = Math.min(
            width - tooltipWidth - 5,
            Math.max(5, x + 10)
        );

        const tooltipY = Math.max(
            4,
            Math.min(height - tooltipHeight - 4, y - 35)
        );

        ctx.fillStyle = "#1a2a43";
        ctx.strokeStyle = "rgba(151, 175, 211, 0.28)";
        ctx.lineWidth = 1;

        ctx.beginPath();
        ctx.roundRect(
            tooltipX,
            tooltipY,
            tooltipWidth,
            tooltipHeight,
            7
        );
        ctx.fill();
        ctx.stroke();

        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.font = "bold 10px Segoe UI, sans-serif";
        ctx.fillStyle = "#e8f0ff";
        ctx.fillText(labels[hoverIndex], tooltipX + 9, tooltipY + 7);

        ctx.font = "9px Segoe UI, sans-serif";
        ctx.fillStyle = "#5de4c7";
        ctx.fillText(
            `Current: ${formatNumber(current[hoverIndex])} PSI`,
            tooltipX + 9,
            tooltipY + 22
        );

        ctx.fillStyle = "#91b8ff";
        ctx.fillText(
            `Baseline: ${formatNumber(baseline[hoverIndex])} PSI`,
            tooltipX + 9,
            tooltipY + 36
        );
    }
}

/* =========================================================
   EVENT CENTER
   ========================================================= */

function bindAlertFilters() {
    $$(".filter-chip").forEach(button => {
        button.addEventListener("click", () => {
            $$(".filter-chip").forEach(item => {
                item.classList.remove("active");
            });

            button.classList.add("active");
            state.eventFilter = button.dataset.alertFilter || "all";

            renderEvents();
        });
    });

    $("#clearAlertsButton")?.addEventListener("click", () => {
        state.events = [];
        renderEvents();

        showToast(
            "Events cleared",
            "The local dashboard event history has been cleared."
        );
    });
}

function renderEvents() {
    const container = $("#eventList");

    if (!container) return;

    const filtered = state.events.filter(event => {
        return state.eventFilter === "all"
            || event.type === state.eventFilter;
    });

    container.replaceChildren();

    if (!filtered.length) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent = state.events.length
            ? "No events match this filter."
            : "No events recorded in this dashboard session.";

        container.appendChild(empty);
        return;
    }

    filtered.forEach(event => {
        const item = document.createElement("div");
        item.className = "event-item";

        const icon = document.createElement("div");
        icon.className = `event-icon ${event.type === "leak" ? "event-leak" : "event-system"}`;
        icon.textContent = event.type === "leak" ? "!" : "◈";

        const copy = document.createElement("div");
        copy.className = "event-copy";

        const title = document.createElement("strong");
        title.textContent = event.title;

        const message = document.createElement("p");
        message.textContent = event.message;

        const time = document.createElement("time");
        time.textContent = event.time;

        copy.append(title, message, time);
        item.append(icon, copy);
        container.appendChild(item);
    });
}

/* =========================================================
   NAVIGATION AND GENERAL BUTTONS
   ========================================================= */

function bindNavigation() {
    const navLinks = $$(".nav-link");

    navLinks.forEach(link => {
        link.addEventListener("click", () => {
            navLinks.forEach(item => item.classList.remove("active"));
            link.classList.add("active");

            const sectionName = link.dataset.section || "overview";

            setText(
                "#breadcrumbCurrent",
                link.querySelector("span:nth-child(2)")?.textContent
                    || "Overview"
            );

            if (sectionName === "network") {
                window.setTimeout(() => {
                    if (state.dashboard) {
                        renderNetwork(state.dashboard);
                    }
                }, 100);
            }

            $("#sidebar")?.classList.remove("open");
            $("#menuToggle")?.setAttribute("aria-expanded", "false");
        });
    });

    $("#menuToggle")?.addEventListener("click", () => {
        const sidebar = $("#sidebar");

        if (!sidebar) return;

        const isOpen = sidebar.classList.toggle("open");

        $("#menuToggle")?.setAttribute(
            "aria-expanded",
            String(isOpen)
        );
    });

    if ("IntersectionObserver" in window) {
        const observer = new IntersectionObserver(entries => {
            const visible = entries
                .filter(entry => entry.isIntersecting)
                .sort((a, b) =>
                    b.intersectionRatio - a.intersectionRatio
                )[0];

            if (!visible) return;

            const id = visible.target.id;

            const link = $(`.nav-link[data-section="${id}"]`);

            if (link) {
                navLinks.forEach(item => {
                    item.classList.toggle("active", item === link);
                });

                const label = link.querySelector("span:nth-child(2)");

                if (label) {
                    setText("#breadcrumbCurrent", label.textContent);
                }
            }
        }, {
            rootMargin: "-18% 0px -65% 0px",
            threshold: [0, 0.15, 0.35]
        });

        navLinks.forEach(link => {
            const section = document.getElementById(
                link.dataset.section
            );

            if (section) {
                observer.observe(section);
            }
        });
    }
}

function bindButtons() {
    $("#refreshButton")?.addEventListener("click", () => {
        refreshDashboard(true);
    });

    $("#fitNetworkButton")?.addEventListener("click", () => {
        if (state.dashboard) {
            renderNetwork(state.dashboard);
        }

        showToast(
            "Network view refreshed",
            "The pipeline map has been redrawn from the latest API data."
        );
    });

    $("#viewNetworkDetails")?.addEventListener("click", () => {
        const data = state.dashboard;

        if (!data) {
            showToast(
                "Data unavailable",
                "Wait for the Python API to return network data.",
                "error"
            );
            return;
        }

        const network = data.network || {};
        const activePipeCount = (network.edges || []).filter(edge => edge.leak).length;

        openModal(
            "Network overview",
            `
                <div class="modal-detail-grid">
                    <div class="modal-detail">
                        <span>Junction count</span>
                        <strong>${Number(network.node_count) || 0}</strong>
                    </div>
                    <div class="modal-detail">
                        <span>Pipe count</span>
                        <strong>${Number(network.pipe_count) || 0}</strong>
                    </div>
                    <div class="modal-detail">
                        <span>Simulation mode</span>
                        <strong>Enabled</strong>
                    </div>
                    <div class="modal-detail">
                        <span>Active simulated leaks</span>
                        <strong>${activePipeCount}</strong>
                    </div>
                </div>
                <p class="modal-description">
                    These details are taken from the current response from the
                    GRIDGUARD Python API. Network size and readings represent
                    the current virtual pipeline model.
                </p>
            `
        );
    });

    $("#apiStatusButton")?.addEventListener("click", async () => {
        const connected = await checkConnection();

        showToast(
            connected ? "API is connected" : "API is unavailable",
            connected
                ? "The local GRIDGUARD Python service responded successfully."
                : "Check that the Flask server is running in your terminal.",
            connected ? "success" : "error"
        );
    });
}

function bindKeyboardShortcuts() {
    document.addEventListener("keydown", event => {
        const target = event.target;

        const isTyping = target instanceof HTMLElement
            && (
                target.isContentEditable
                || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)
            );

        if (isTyping || event.ctrlKey || event.metaKey || event.altKey) {
            return;
        }

        if (event.key.toLowerCase() === "r") {
            refreshDashboard(true);
        }

        if (event.key === "Escape") {
            $("#sidebar")?.classList.remove("open");
            $("#menuToggle")?.setAttribute("aria-expanded", "false");
        }
    });
}

/* =========================================================
   GRIDGUIDE — FAST, CONTEXT-AWARE DASHBOARD ASSISTANT
   ========================================================= */

function bindAssistant() {
    const panel = $("#assistantPanel");
    const launcher = $("#assistantLauncher");
    if (!panel || !launcher) return;

    const setOpen = open => {
        panel.hidden = !open;
        launcher.setAttribute("aria-expanded", String(open));
        launcher.classList.toggle("assistant-launcher-active", open);
        if (open) {
            window.setTimeout(() => $("#assistantInput")?.focus(), 80);
            renderAssistantContext();
        }
    };

    launcher.addEventListener("click", () => setOpen(panel.hidden));
    $("#assistantClose")?.addEventListener("click", () => setOpen(false));
    $("#assistantForm")?.addEventListener("submit", event => {
        event.preventDefault();
        const input = $("#assistantInput");
        const question = input?.value.trim();
        if (!question) return;
        input.value = "";
        askGridGuide(question);
    });
    $$("[data-assistant-prompt]").forEach(button => {
        button.addEventListener("click", () => askGridGuide(button.dataset.assistantPrompt || ""));
    });
}

function renderAssistantContext() {
    const context = $("#assistantContext");
    if (!context) return;
    const dashboard = state.dashboard;
    if (!dashboard) {
        context.innerHTML = '<span>◉</span> Waiting for the first network update';
        return;
    }
    const activePipes = (dashboard.network?.edges || []).filter(edge => edge.leak).map(edge => edge.id);
    const condition = activePipes.length
        ? `${activePipes.length} simulated leak${activePipes.length === 1 ? "" : "s"} · ${activePipes.join(", ")}`
        : "No simulated leak active";
    context.innerHTML = `<span>◉</span> ${escapeHTML(condition)} · ${escapeHTML(dashboard.mode || "simulation")}`;
}

function assistantAnswer(question) {
    const q = question.toLowerCase();
    const dashboard = state.dashboard || {};
    const network = dashboard.network || {};
    const nodes = network.nodes || [];
    const edges = network.edges || [];
    const telemetry = dashboard.telemetry || {};
    const scada = state.scada || {};
    const liveLeaks = edges.filter(edge => edge.leak);
    const weakest = nodes.filter(node => Number.isFinite(Number(node.pressure)))
        .slice().sort((a, b) => Number(a.pressure) - Number(b.pressure))[0];
    const warningNodes = nodes.filter(node => node.status === "warning");
    const pipeMatch = q.match(/\b(tank|j[1-5])\s*(?:-|to|–|—)\s*(tank|j[1-5])\b/i);
    const namedPipe = pipeMatch
        ? edges.find(edge => [edge.start.toLowerCase(), edge.end.toLowerCase()].includes(pipeMatch[1].toLowerCase())
            && [edge.start.toLowerCase(), edge.end.toLowerCase()].includes(pipeMatch[2].toLowerCase()))
        : null;

    if (/\b(hello|hi|hey)\b/.test(q)) {
        return "Hi! I can explain the current leak status, pressure and flow readings, SCADA connection, pipeline map, simulator, or LeakDB labels. Try ‘What needs attention right now?’";
    }
    if (namedPipe) {
        const length = Number(namedPipe.length);
        return namedPipe.leak
            ? `${namedPipe.id} is the active simulated leak segment${Number.isFinite(length) ? ` (${length} m)` : ""}. It is highlighted on the pipeline map. Severity is ${Math.round(Number(namedPipe.severity || 0) * 100)}%. The simulator is virtual; this is not a physical pipe alarm.`
            : `${namedPipe.id} is currently marked as a normal segment${Number.isFinite(length) ? ` (${length} m)` : ""}. No active simulated leak is attached to this pipe. A separate detector result can still be a possible leak and should be checked against the map and readings.`;
    }
    if (/\b(attention|right now|status|overview|summary|what.*happen|issue|problem|leak|leaking)\b/.test(q)) {
        if (!dashboard.network) return "I’m waiting for the latest network update. Once it arrives, I can summarize active simulated leaks and pressure warnings.";
        const leakText = liveLeaks.length
            ? `The simulator has an active leak on ${liveLeaks.map(edge => edge.id).join(", ")}. `
            : "There is no active simulated leak at the moment. ";
        const pressureText = warningNodes.length
            ? `Pressure is flagged low at ${warningNodes.map(node => `${node.id} ${formatNumber(node.pressure)} PSI`).join(" and ")}. `
            : weakest ? `The lowest current reading is ${weakest.id} ${formatNumber(weakest.pressure)} PSI; no junction is currently marked low. ` : "";
        const detectorCount = (dashboard.detections || []).length;
        const detectorText = detectorCount
            ? `The detector has ${detectorCount} possible leak result${detectorCount === 1 ? "" : "s"}; those are suggestions and can differ from the simulator’s active leak. `
            : "The detector has no possible leak results. ";
        return `${leakText}${pressureText}${detectorText}Select the highlighted pipe on the network map for its details. All readings are simulated.`;
    }
    if (/\b(pressure|psi|low pressure|baseline|drop|variance)\b/.test(q)) {
        if (!nodes.length) return "Pressure is measured in PSI in this demo. I’m waiting for live dashboard values before comparing junctions.";
        const current = nodes.map(node => `${node.id} ${formatNumber(node.pressure)} PSI`).join(" · ");
        return `Current pressure: ${current}. The dashboard compares these values with a simulated healthy baseline; a lower reading is a clue to investigate, not proof of a real leak.`;
    }
    if (/\b(scada|opc|sensor|telemetry|connected|connection)\b/.test(q)) {
        if (scada.connected) {
            const points = (scada.points || []).map(point => `${point.sensor_id}: ${formatNumber(point.pressure_psi)} PSI`).join(" · ");
            return `SCADA is connected through ${scada.protocol || "OPC UA"} (${scada.endpoint || "local simulator"}). Latest points: ${points || "readings are arriving"}. This is a local simulated SCADA feed.`;
        }
        return "The dashboard’s OPC UA simulator is currently offline. The network page can still show Python simulation values.";
    }
    return "I can help with water-network and dashboard questions. Try asking about a specific pipe or junction, pressure, flow, SCADA, LeakDB, or a simulated leak.";
}

function askGridGuide(question) {
    const messages = $("#assistantMessages");
    if (!messages || !question) return;
    const userMessage = document.createElement("article");
    userMessage.className = "assistant-message assistant-message-user";
    const userText = document.createElement("p");
    userText.textContent = question;
    userMessage.appendChild(userText);
    messages.appendChild(userMessage);

    const answer = assistantAnswer(question);
    const botMessage = document.createElement("article");
    botMessage.className = "assistant-message assistant-message-bot";
    const label = document.createElement("span");
    label.className = "assistant-message-label";
    label.textContent = "GRIDGUIDE · LIVE CONTEXT";
    const text = document.createElement("p");
    text.textContent = answer;
    botMessage.append(label, text);

    if (/highlighted pipe|active simulated leak/i.test(answer)) {
        const mapLink = document.createElement("button");
        mapLink.type = "button";
        mapLink.className = "assistant-map-link";
        mapLink.textContent = "View pipeline map →";
        mapLink.addEventListener("click", () => {
            window.location.hash = "network";
            if (state.dashboard) window.setTimeout(() => renderNetwork(state.dashboard), 120);
        });
        botMessage.appendChild(mapLink);
    }
    messages.appendChild(botMessage);
    while (messages.children.length > 16) messages.removeChild(messages.firstElementChild);
    messages.scrollTop = messages.scrollHeight;
    renderAssistantContext();
}