def detect_leaks(network):
    """Detect possible leaks using simulated SCADA pressure readings."""

    detected_pipes = []

    for start, end, data in network.edges(data=True):
        pressure = data.get("pressure")

        if pressure is None:
            continue

        pressure = float(pressure)

        if pressure < 40:
            severity = min((40 - pressure) / 40, 1.0)

            detected_pipes.append({
                "pipe": f"{start}-{end}",
                "pressure": pressure,
                "severity": round(severity, 2),
                "status": "POSSIBLE LEAK"
            })

    return detected_pipes