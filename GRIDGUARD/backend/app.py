import os
import time
import random
import json
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from google import genai
from google.genai import types

from simulation.pipeline import create_pipeline_network
from simulation.leak_simulator import simulate_leak
from simulation.sensor_simulator import generate_pressure_readings
from detection.leak_detector import detect_leaks
from dataset_loader import list_sensor_datasets, load_sensor_dataset


# ==================================================
# CONFIGURATION
# ==================================================

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")

app = Flask(__name__)
CORS(app)

# Initialize Google GenAI Client
client = genai.Client()

active_leak = None

NODE_POSITIONS = {
    "Tank": {"x": 80, "y": 250},
    "J1": {"x": 220, "y": 250},
    "J2": {"x": 380, "y": 150},
    "J3": {"x": 380, "y": 350},
    "J4": {"x": 540, "y": 250},
    "J5": {"x": 700, "y": 250},
}

OPC_NAMESPACE = "http://gridguard.local/scada"
OPC_ENDPOINT = "opc.tcp://127.0.0.1:4840/gridguard/"


# ==================================================
# PIPELINE
# ==================================================

def get_network():
    return create_pipeline_network()


# ==================================================
# OPC UA READING
# ==================================================

def get_opc_readings():
    """
    Read telemetry from the local OPC UA simulator.
    Returns None if the simulator is unavailable.
    """
    try:
        from scada_bridge import get_scada_readings

        return get_scada_readings()

    except Exception:
        app.logger.exception("OPC UA reading failed")
        return None

@app.route("/about.html")
def about_page():
    about_file = os.path.join(FRONTEND_DIR, "about.html")

    if not os.path.isfile(about_file):
        return jsonify({
            "error": "about.html was not found",
            "expected_location": about_file
        }), 404

    return send_from_directory(FRONTEND_DIR, "about.html")
# ==================================================
# DASHBOARD DATA
# ==================================================

def build_dashboard_data():
    global active_leak

    network = get_network()

    seed = int(time.time() // 3) % 100000

    leak_pipe = None

    if active_leak:
        leak_pipe = (
            active_leak["pipe_start"],
            active_leak["pipe_end"],
        )

    healthy_pressure = generate_pressure_readings(
        network,
        leak_pipe=None,
        seed=seed,
    )

    pressure = generate_pressure_readings(
        network,
        leak_pipe=leak_pipe,
        seed=seed,
    )

    # Prefer OPC UA readings when available.
    opc_readings = get_opc_readings()

    if opc_readings:
        mapping = {
            "TankPressure": "Tank",
            "J1Pressure": "J1",
            "J2Pressure": "J2",
        }

        for opc_name, junction in mapping.items():
            if opc_name in opc_readings:
                pressure[junction] = float(opc_readings[opc_name])

    rng = random.Random(seed)
    flow = {}

    for index, junction in enumerate(network.nodes):
        base_flow = 24.0 - index * 1.6
        variation = rng.uniform(-0.7, 0.7)

        leak_effect = 0.0

        if active_leak and junction in leak_pipe:
            leak_effect = 8.0 * active_leak["severity"]

        flow[junction] = round(
            max(0.0, base_flow + variation + leak_effect),
            2,
        )

    # Use OPC UA flow if available.
    if opc_readings and "J1Flow" in opc_readings:
        flow["J1"] = float(opc_readings["J1Flow"])

    nodes = []

    leaking_junctions = set(leak_pipe or ())

    for junction in network.nodes:
        nodes.append({
            "id": junction,
            "x": NODE_POSITIONS[junction]["x"],
            "y": NODE_POSITIONS[junction]["y"],
            "pressure": pressure[junction],
            "healthy_pressure": healthy_pressure[junction],
            "flow": flow[junction],
            "leak": junction in leaking_junctions,
            "status": (
                "warning" if pressure[junction] < 40 else "normal"
            ),
        })

    # Calculate pipe pressure from endpoint readings.
    for start, end in network.edges():
        network.edges[start, end]["pressure"] = round(
            (pressure[start] + pressure[end]) / 2,
            2,
        )

    edges = []

    for start, end, data in network.edges(data=True):
        is_leaking = bool(
            active_leak
            and {start, end} == {active_leak["pipe_start"], active_leak["pipe_end"]}
        )
        severity = active_leak["severity"] if is_leaking else 0.0

        edges.append({
            "id": f"{start}-{end}",
            "start": start,
            "end": end,
            "length": data["length"],
            "leak": is_leaking,
            "severity": severity,
            "status": "leak" if is_leaking else "normal",
        })

    # Sensor-based threshold detector.
    raw_detections = detect_leaks(network)

    detections = []

    for item in raw_detections:
        severity = float(item.get("severity", 0.0))

        if severity >= 0.7:
            priority = "High"
        elif severity >= 0.4:
            priority = "Medium"
        else:
            priority = "Low"

        detections.append({
            "pipe": item["pipe"],
            "severity": round(severity, 2),
            "priority": priority,
            "status": "Possible Leak",
            "pressure": item.get("pressure"),
        })

    active_leak_count = sum(1 for edge in edges if edge["leak"])

    average_pressure = round(
        sum(pressure.values()) / len(pressure),
        2,
    ) if pressure else 0

    average_flow = round(
        sum(flow.values()) / len(flow),
        2,
    ) if flow else 0

    return {
        "project": "GRIDGUARD",
        "mode": "OPC UA simulator" if opc_readings else "simulation",
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "network": {
            "node_count": network.number_of_nodes(),
            "pipe_count": network.number_of_edges(),
            "nodes": nodes,
            "edges": edges,
        },
        "telemetry": {
            "pressure": pressure,
            "healthy_pressure": healthy_pressure,
            "flow": flow,
            "average_pressure": average_pressure,
            "average_flow": average_flow,
        },
        "detections": detections,
        "summary": {
            "active_leaks": active_leak_count,
            "network_status": (
                "Attention Required"
                if active_leak_count or detections
                else "All Clear"
            ),
            "average_pressure": average_pressure,
            "average_flow": average_flow,
        },
    }


# ==================================================
# HOME & STATIC FILES
# ==================================================

@app.route("/", methods=["GET"])
def home():
    return send_from_directory(FRONTEND_DIR, "index.html")

@app.route("/dashboard.html", methods=["GET"])
def dashboard_page():
    return send_from_directory(FRONTEND_DIR, "dashboard.html")

@app.route("/style.css", methods=["GET"])
def frontend_css():
    return send_from_directory(FRONTEND_DIR, "style.css")

@app.route("/script.js", methods=["GET"])
def frontend_js():
    return send_from_directory(FRONTEND_DIR, "script.js")


# ==================================================
# HEALTH
# ==================================================

@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({
        "ok": True,
        "service": "GRIDGUARD API",
        "mode": "simulation",
    })


# ==================================================
# DASHBOARD API
# ==================================================

@app.route("/api/dashboard", methods=["GET"])
def dashboard():
    return jsonify(build_dashboard_data())


# ==================================================
# AI DIAGNOSIS API (GEMINI INTEGRATION)
# ==================================================

@app.route("/api/ai-diagnose", methods=["POST"])
def ai_diagnose():
    """
    Receives current active telemetry or anomaly context and runs a fast diagnosis via Gemini API.
    """
    telemetry_data = request.get_json(silent=True)

    if not telemetry_data:
        dashboard_data = build_dashboard_data()
        telemetry_data = {
            "summary": dashboard_data.get("summary"),
            "detections": dashboard_data.get("detections"),
            "telemetry": dashboard_data.get("telemetry"),
            "active_leak": active_leak
        }

    prompt = f"""
    You are an expert Hydraulic Systems AI Assistant for the GRIDGUARD Water Sustainability Network.
    Analyze the following SCADA network telemetry and anomaly detection status:

    Telemetry Data:
    {json.dumps(telemetry_data, indent=2)}

    Provide a concise, practical diagnosis for field operators.
    Respond strictly in valid JSON format using these exact key names:
    - "diagnosis": A concise summary of what occurred (e.g. major burst on Pipe J1-J2, pressure drop at J1, or normal network behavior).
    - "recommended_actions": A list of 2 to 3 concise steps for field operators.
    - "urgency": "CRITICAL", "WARNING", or "STABLE".
    """

    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                temperature=0.2
            )
        )
        parsed_result = json.loads(response.text)
        return jsonify({"ok": True, "data": parsed_result})
    except Exception as e:
        app.logger.exception("Gemini AI Diagnosis failed")
        return jsonify({
            "ok": True,
            "data": {
                "diagnosis": "Automatic fallback: Anomaly detected in telemetry stream. Rapid pressure shift recorded.",
                "recommended_actions": [
                    "Inspect isolation valves upstream of affected pipe nodes.",
                    "Verify physical pressure gauge readings manually."
                ],
                "urgency": "WARNING",
                "fallback": True
            }
        })


# ==================================================
# SCADA API — OPC UA
# ==================================================

@app.route("/api/scada", methods=["GET"])
def scada_telemetry():
    readings = get_opc_readings()

    if readings is None:
        return jsonify({
            "project": "GRIDGUARD",
            "source": "OPC_UA_SIMULATOR",
            "connected": False,
            "protocol": "OPC UA",
            "endpoint": OPC_ENDPOINT,
            "error": "Cannot connect to the OPC UA simulator.",
            "start_command": "python scada_simulator.py",
        }), 503

    pressure_mapping = {
        "TankPressure": "Tank",
        "J1Pressure": "J1",
        "J2Pressure": "J2",
    }

    points = []

    for sensor_name, sensor_id in pressure_mapping.items():
        pressure_value = float(readings[sensor_name])

        flow_key = "J1Flow" if sensor_id == "J1" else None
        flow_value = float(readings.get(flow_key, 0)) if flow_key else 0

        points.append({
            "sensor_id": sensor_id,
            "pressure_sensor": sensor_name,
            "pressure_psi": pressure_value,
            "flow_sensor": flow_key,
            "flow": flow_value if flow_key else None,
            "status": (
                "WARNING"
                if pressure_value < 40
                else "NORMAL"
            ),
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        })

    pressures = [point["pressure_psi"] for point in points]

    return jsonify({
        "project": "GRIDGUARD",
        "source": "OPC_UA_SIMULATOR",
        "connected": True,
        "protocol": "OPC UA",
        "endpoint": OPC_ENDPOINT,
        "mode": "industrial_simulation",
        "points": points,
        "average_pressure": round(sum(pressures) / len(pressures), 2),
        "average_flow": float(readings.get("J1Flow", 0)),
    })


# ==================================================
# SIMULATE LEAK
# ==================================================

@app.route("/api/simulate-leak", methods=["POST"])
def simulate_leak_route():
    global active_leak

    body = request.get_json(silent=True) or {}

    pipe_start = body.get("pipe_start", "J1")
    pipe_end = body.get("pipe_end", "J2")

    try:
        severity = float(body.get("severity", 0.7))
    except (ValueError, TypeError):
        return jsonify({
            "ok": False,
            "error": "Severity must be a number.",
        }), 400

    if not 0 < severity <= 1:
        return jsonify({
            "ok": False,
            "error": "Severity must be between 0 and 1.",
        }), 400

    network = get_network()

    if not network.has_edge(pipe_start, pipe_end):
        return jsonify({
            "ok": False,
            "error": "The selected pipe does not exist.",
        }), 400

    simulate_leak(
        network,
        pipe_start,
        pipe_end,
        leak_severity=severity,
    )

    active_leak = {
        "pipe_start": pipe_start,
        "pipe_end": pipe_end,
        "severity": severity,
    }

    return jsonify({
        "ok": True,
        "message": "Simulated leak activated.",
        "pipe": f"{pipe_start}-{pipe_end}",
        "severity": severity,
    })


# ==================================================
# RESET
# ==================================================

@app.route("/api/reset", methods=["POST"])
def reset_simulation():
    global active_leak

    active_leak = None

    return jsonify({
        "ok": True,
        "message": "Simulation reset successfully.",
    })


# ==================================================
# DATASET API
# ==================================================

@app.route("/api/datasets", methods=["GET"])
def datasets_route():
    return jsonify({
        "datasets": list_sensor_datasets(),
    })

@app.route("/api/dataset", methods=["POST"])
def dataset_route():
    body = request.get_json(silent=True) or {}
    filename = body.get("filename", "")

    if not isinstance(filename, str) or not filename.strip():
        return jsonify({
            "error": "Filename required.",
        }), 400

    try:
        result = load_sensor_dataset(filename.strip())

        return jsonify({
            "ok": True,
            "dataset": result,
        })

    except FileNotFoundError:
        return jsonify({
            "error": "Dataset not found.",
        }), 404

    except Exception:
        app.logger.exception("Dataset loading failed")

        return jsonify({
            "error": "Dataset loading failed.",
        }), 500


# ==================================================
# RUN
# ==================================================

if __name__ == "__main__":
    app.run(
        host="127.0.0.1",
        port=5000,
        debug=False,
    )