import asyncio
from asyncua import Client


OPC_URL = "opc.tcp://127.0.0.1:4840/gridguard/"
NAMESPACE_URI = "http://gridguard.local/scada"


async def read_scada():
    async with Client(url=OPC_URL) as client:
        idx = await client.get_namespace_index(NAMESPACE_URI)

        scada = await client.nodes.objects.get_child(
            [f"{idx}:GRIDGUARD_SCADA"]
        )

        sensor_names = [
            "TankPressure",
            "J1Pressure",
            "J2Pressure",
            "J1Flow",
        ]

        readings = {}

        for name in sensor_names:
            node = await scada.get_child([f"{idx}:{name}"])
            readings[name] = await node.read_value()

        return readings


def get_scada_readings():
    """Read current values from the OPC UA simulator."""
    return asyncio.run(read_scada())


if __name__ == "__main__":
    print(get_scada_readings())