
import networkx as nx


def create_pipeline_network():
    """Create a small virtual water-pipeline network."""
    network = nx.Graph()

    # Water junctions
    junctions = [
        "Tank",
        "J1",
        "J2",
        "J3",
        "J4",
        "J5",
    ]

    network.add_nodes_from(junctions)

    # Pipeline connections and their lengths in metres
    pipes = [
        ("Tank", "J1", 100),
        ("J1", "J2", 120),
        ("J1", "J3", 90),
        ("J2", "J4", 110),
        ("J3", "J4", 80),
        ("J4", "J5", 100),
    ]

    for start, end, length in pipes:
        network.add_edge(start, end, length=length)

    return network


if __name__ == "__main__":
    pipeline = create_pipeline_network()

    print("GRIDGUARD Pipeline Simulation")
    print("Number of junctions:", pipeline.number_of_nodes())
    print("Number of pipes:", pipeline.number_of_edges())
    print("Pipe connections:")

    for start, end, data in pipeline.edges(data=True):
        print(f"{start} -> {end}: {data['length']} metres")
