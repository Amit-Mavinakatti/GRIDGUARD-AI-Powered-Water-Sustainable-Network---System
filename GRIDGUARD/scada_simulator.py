import asyncio
from asyncua import Server, ua


async def main():
    server = Server()

    await server.init()

    server.set_endpoint("opc.tcp://127.0.0.1:4840/gridguard/")

    uri = "http://gridguard.local/scada"
    idx = await server.register_namespace(uri)

    objects = server.nodes.objects

    scada = await objects.add_object(idx, "GRIDGUARD_SCADA")

    tank_pressure = await scada.add_variable(
        idx, "TankPressure", 50.0
    )
    j1_pressure = await scada.add_variable(
        idx, "J1Pressure", 42.0
    )
    j2_pressure = await scada.add_variable(
        idx, "J2Pressure", 38.0
    )
    j1_flow = await scada.add_variable(
        idx, "J1Flow", 25.0
    )

    variables = [
        tank_pressure,
        j1_pressure,
        j2_pressure,
        j1_flow,
    ]

    for variable in variables:
        await variable.set_writable()

    print("GRIDGUARD OPC UA Simulator Started")
    print("Endpoint: opc.tcp://127.0.0.1:4840/gridguard/")
    print("Press Ctrl+C to stop.")

    async with server:
        while True:
            await asyncio.sleep(2)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("SCADA simulator stopped.")