
import numpy as np


def generate_pressure_readings(
    network,
    leak_pipe=None,
    noise_level=0.5,
    seed=42,
):
    """Generate simplified illustrative pressure readings."""
    rng = np.random.default_rng(seed)
    readings = {}

    for index, junction in enumerate(network.nodes):
        pressure = 50.0 - 2.0 * index

        # Apply a simulated pressure drop at the leak's endpoints.
        if leak_pipe and junction in leak_pipe:
            pressure -= 8.0

        pressure += rng.normal(0.0, noise_level)
        readings[junction] = round(float(pressure), 2)

    return readings


if __name__ == "__main__":
    from simulation.pipeline import create_pipeline_network

    pipeline = create_pipeline_network()

    healthy = generate_pressure_readings(
        pipeline,
        seed=42,
    )

    leaking = generate_pressure_readings(
        pipeline,
        leak_pipe=("J1", "J2"),
        seed=42,
    )

    print("GRIDGUARD Pressure Comparison")
    print("-" * 48)
    print(f"{'Junction':<12}{'Healthy':>12}{'Leaking':>12}{'Change':>12}")

    for junction in pipeline.nodes:
        change = leaking[junction] - healthy[junction]
        print(
            f"{junction:<12}"
            f"{healthy[junction]:>12.2f}"
            f"{leaking[junction]:>12.2f}"
            f"{change:>12.2f}"
        )
