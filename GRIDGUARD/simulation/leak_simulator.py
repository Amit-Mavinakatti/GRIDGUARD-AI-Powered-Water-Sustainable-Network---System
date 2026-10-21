
import networkx as nx
from simulation.pipeline import create_pipeline_network


def simulate_leak(network, pipe_start, pipe_end, leak_severity=0.3):
    """Mark a pipe as leaking in our simplified simulation."""

    if not network.has_edge(pipe_start, pipe_end):
        raise ValueError(
            f"Pipe {pipe_start}-{pipe_end} does not exist."
        )

    if not 0.0 <= leak_severity <= 1.0:
        raise ValueError(
            "Leak severity must be between 0.0 and 1.0."
        )

    network.edges[pipe_start, pipe_end]["leak"] = True
    network.edges[pipe_start, pipe_end]["leak_severity"] = leak_severity

    return network


if __name__ == "__main__":
    pipeline = create_pipeline_network()
    simulate_leak(pipeline, "J1", "J2", leak_severity=0.3)

    leak_data = pipeline.edges["J1", "J2"]

    print("GRIDGUARD Leak Simulator")
    print("Leak successfully simulated!")
    print("Affected pipe: J1 - J2")
    print("Simulated leak severity:", leak_data["leak_severity"])
