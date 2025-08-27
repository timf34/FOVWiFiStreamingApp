# save as test_ws_server.py
import asyncio
import websockets
import json
import time
import random

async def handler(websocket):
    print("Client connected")
    try:
        while True:
            # Example coordinate message with randomized coordinates
            message = {
                "x": round(random.uniform(0, 100), 2),
                "y": round(random.uniform(0, 100), 2),
                "t": time.time()
            }
            await websocket.send(json.dumps(message))
            await asyncio.sleep(0.2)  # ~5fps like your target
    except websockets.ConnectionClosed:
        print("Client disconnected")

async def main():
    async with websockets.serve(handler, "0.0.0.0", 8765):
        print("WebSocket server running on ws://localhost:8765")
        await asyncio.Future()  # run forever

if __name__ == "__main__":
    asyncio.run(main())
