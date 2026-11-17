#!/usr/bin/env python3
"""
osu! co-op bridge
=================

Run this on the HOST computer (the one actually running osu!). It receives your
partner's aim or tap input from the co-op web page and injects it as real mouse
movement / key presses so osu! sees it.

    pip install websockets pynput
    python osu-coop-bridge.py

Then paste the pairing code it prints into the host page.

Options:
    --port 7273                 Port the web page connects to (default 7273)
    --x 0 --y 0 --width W --height H
                                Screen region that maps to the shared video.
                                Defaults to your primary monitor. Set these if
                                osu! runs on a secondary monitor.

Safety: the bridge only listens on 127.0.0.1 (this computer) and only accepts a
page that knows the pairing code. All keys are released when the page
disconnects. Close this window to stop all remote input instantly.
"""

import argparse
import asyncio
import json
import secrets
import sys

try:
    import websockets
    from pynput.keyboard import Controller as KeyboardController, Key, KeyCode
    from pynput.mouse import Controller as MouseController
except ImportError:
    print("Missing dependencies. Run:\n\n    pip install websockets pynput\n")
    sys.exit(1)


def detect_primary_screen():
    if sys.platform == "win32":
        import ctypes

        # Without DPI awareness Windows reports scaled sizes and the cursor lands in the wrong place.
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            try:
                ctypes.windll.user32.SetProcessDPIAware()
            except Exception:
                pass
        user32 = ctypes.windll.user32
        return 0, 0, user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
    try:
        import tkinter

        root = tkinter.Tk()
        root.withdraw()
        size = root.winfo_screenwidth(), root.winfo_screenheight()
        root.destroy()
        return 0, 0, size[0], size[1]
    except Exception:
        return 0, 0, 1920, 1080


KEY_ALIASES = {
    " ": "space",
    "spacebar": "space",
    "control": "ctrl",
    "arrowup": "up",
    "arrowdown": "down",
    "arrowleft": "left",
    "arrowright": "right",
    "capslock": "caps_lock",
    "escape": "esc",
    "pageup": "page_up",
    "pagedown": "page_down",
}


def parse_key(name):
    raw = (name or "").lower()
    name = KEY_ALIASES.get(raw, raw.strip())
    if len(name) == 1:
        return KeyCode.from_char(name)
    key = getattr(Key, name, None)
    if key is None:
        raise ValueError(f"Unknown key: {name!r}")
    return key


class Injector:
    def __init__(self, region):
        self.keyboard = KeyboardController()
        self.mouse = MouseController()
        self.region = region
        self.bindings = {"k1": parse_key("z"), "k2": parse_key("x")}
        self.held = set()

    def aim(self, x, y):
        rx, ry, rw, rh = self.region
        x = min(max(float(x), 0.0), 1.0)
        y = min(max(float(y), 0.0), 1.0)
        self.mouse.position = (int(rx + x * (rw - 1)), int(ry + y * (rh - 1)))

    def key(self, slot, down):
        binding = self.bindings.get(slot)
        if binding is None:
            return
        if down and slot not in self.held:
            self.held.add(slot)
            self.keyboard.press(binding)
        elif not down and slot in self.held:
            self.held.discard(slot)
            self.keyboard.release(binding)

    def release_all(self):
        for slot in list(self.held):
            self.key(slot, False)

    def configure(self, k1, k2):
        self.release_all()
        try:
            self.bindings = {"k1": parse_key(k1), "k2": parse_key(k2)}
            print(f"Key bindings: K1 = {k1!r}, K2 = {k2!r}")
        except ValueError as error:
            print(f"Ignoring key config: {error}")


def make_token():
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(8))


def normalize_token(value):
    return str(value or "").replace("-", "").replace(" ", "").upper()


async def run(args):
    region = detect_primary_screen()
    if args.width and args.height:
        region = (args.x, args.y, args.width, args.height)

    token = make_token()
    injector = Injector(region)
    active = {"ws": None}

    # websockets < 10.1 passes (ws, path); newer versions pass only ws.
    async def handler(ws, *_):
        print("Page connecting...")
        try:
            hello = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        except Exception:
            await ws.close()
            return

        if hello.get("t") != "auth" or not secrets.compare_digest(normalize_token(hello.get("token")), token):
            print("Rejected a page with the wrong pairing code.")
            await asyncio.sleep(1)
            await ws.send(json.dumps({"t": "error", "reason": "bad-token"}))
            await ws.close()
            return

        previous = active["ws"]
        active["ws"] = ws
        if previous is not None:
            await previous.close()

        await ws.send(json.dumps({"t": "ok", "screen": [region[2], region[3]]}))
        print("Host page connected. Remote input is LIVE.")

        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                kind = msg.get("t")
                if kind == "aim":
                    injector.aim(msg.get("x", 0), msg.get("y", 0))
                elif kind == "key" and msg.get("k") in ("k1", "k2"):
                    injector.key(msg["k"], bool(msg.get("down")))
                elif kind == "release":
                    injector.release_all()
                elif kind == "config":
                    injector.configure(msg.get("k1", "z"), msg.get("k2", "x"))
        except websockets.ConnectionClosed:
            pass
        finally:
            injector.release_all()
            if active["ws"] is ws:
                active["ws"] = None
            print("Host page disconnected. All keys released.")

    async with websockets.serve(handler, "127.0.0.1", args.port, max_size=4096, compression=None):
        print("=" * 46)
        print(" osu! co-op bridge is running")
        print(f" Listening on   ws://127.0.0.1:{args.port}")
        print(f" Aim region     {region[2]}x{region[3]} at ({region[0]}, {region[1]})")
        print(f" Pairing code   {token[:4]}-{token[4:]}")
        print("=" * 46)
        print("Paste the pairing code into the host page. Press Ctrl+C to stop.")
        await asyncio.Future()


def main():
    parser = argparse.ArgumentParser(description="osu! co-op input bridge")
    parser.add_argument("--port", type=int, default=7273)
    parser.add_argument("--x", type=int, default=0)
    parser.add_argument("--y", type=int, default=0)
    parser.add_argument("--width", type=int, default=0)
    parser.add_argument("--height", type=int, default=0)
    try:
        asyncio.run(run(parser.parse_args()))
    except KeyboardInterrupt:
        print("\nBridge stopped.")


if __name__ == "__main__":
    main()
