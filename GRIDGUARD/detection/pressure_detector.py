def detect_pressure_anomalies(healthy_readings, observed_readings, threshold=4.0):
    """Detect junctions with an unusually large pressure drop."""
    anomalies = []

    for junction, healthy_pressure in healthy_readings.items():
        if junction not in observed_readings:
            continue

        observed_pressure = observed_readings[junction]
        drop = healthy_pressure - observed_pressure

        if drop >= threshold:
            anomalies.append({
                "junction": junction,
                "pressure_drop": round(drop, 2),
            })

    return anomalies


if __name__ == "__main__":
    from simulation.pipeline import create_pipeline_network
    from simulation.sensor_simulator import generate_pressure_readings

    pipeline = create_pipeline_network()

    healthy = generate_pressure_readings(pipeline, seed=42)
    observed = generate_pressure_readings(
        pipeline,
        leak_pipe=("J1", "J2"),
        seed=42,
    )

    results = detect_pressure_anomalies(healthy, observed)

    print("GRIDGUARD Pressure Anomaly Detector")
    for result in results:
        print(
            f"Anomaly at {result['junction']}: "
            f"pressure drop = {result['pressure_drop']}"
        )

    if not results:
        print("No pressure anomalies detected.")