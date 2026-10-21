import asyncio
from asyncua import Client


async def main():
    url = "opc.tcp://127.0.0.1:4840/gridguard/"
    namespace_uri = "http://gridguard.local/scada"

    print("Connecting to GRIDGUARD OPC UA Simulator...")

    async with Client(url=url) as client:
        idx = await client.get_namespace_index(namespace_uri)

        scada = await client.nodes.objects.get_child(
            [f"{idx}:GRIDGUARD_SCADA"]
        )

        sensors = [
            "TankPressure",
            "J1Pressure",
            "J2Pressure",
            "J1Flow",
        ]

        print("\nGRIDGUARD — LIVE OPC UA READINGS")
        print("-" * 40)

        for sensor in sensors:
            node = await scada.get_child([f"{idx}:{sensor}"])
            value = await node.read_value()
            print(f"{sensor}: {value}")

        print("\nOPC UA connection successful!")


if __name__ == "__main__":
    asyncio.run(main())