"""
TD-Spk-Txt server.

Browser captures mic -> WebSocket here -> Gemini Live STT ->
on turn_complete: OSC /stt + Gemini 3.5 Flash -> OSC /llm + push to browser.

Run:  python app.py
Open: http://localhost:8765
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import webbrowser
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from google import genai
from google.genai import types
from pydantic import BaseModel
from pythonosc.udp_client import SimpleUDPClient

STT_MODEL = "gemini-3.1-flash-live-preview"
LLM_MODEL = "gemini-3.5-flash"
WEB_DIR = Path(__file__).parent / "web"
CONFIG_PATH = Path(__file__).parent / "config.json"
DEFAULT_CONFIG = {
    "api_key":         "",
    "osc_host":        "127.0.0.1",
    "osc_port":        7000,
    "stt_address":     "/stt",
    "llm_address":     "/llm",
    "system_prompt":   "",
    "input_device_id": "",
}


def load_disk_config() -> dict:
    if CONFIG_PATH.exists():
        try:
            return {**DEFAULT_CONFIG, **json.loads(CONFIG_PATH.read_text(encoding="utf-8"))}
        except Exception:
            log.exception("config load failed")
    return DEFAULT_CONFIG.copy()


def save_disk_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


class ConfigBody(BaseModel):
    api_key: str = ""
    osc_host: str = "127.0.0.1"
    osc_port: int = 7000
    stt_address: str = "/stt"
    llm_address: str = "/llm"
    system_prompt: str = ""
    input_device_id: str = ""


_EPA_META = re.compile(
    r"\b(Input:|Actor:|Behavior:|Object\(s\):|Composite EPA|Short explanation)",
    re.IGNORECASE,
)

def extract_scene_prompts(text: str) -> list[str]:
    """Drop EPA metadata paragraphs, keep the four scene paragraphs."""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text.strip()) if p.strip()]
    scenes = [p for p in paragraphs if not _EPA_META.search(p)]
    return scenes[-4:] if len(scenes) >= 4 else scenes

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
log = logging.getLogger("td-spk-txt")

app = FastAPI()
app.mount("/web", StaticFiles(directory=str(WEB_DIR)), name="web")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


@app.get("/api/config")
async def get_config() -> dict:
    return load_disk_config()


@app.post("/api/config")
async def post_config(cfg: ConfigBody) -> dict:
    save_disk_config(cfg.model_dump())
    return {"ok": True}


# ---------------------------------------------------------------------------
# Bridge: one Gemini Live session + OSC client per WebSocket connection
# ---------------------------------------------------------------------------

class Bridge:
    def __init__(self, ws: WebSocket, cfg: dict) -> None:
        self.ws = ws
        self.cfg = cfg
        self.client = genai.Client(api_key=cfg["api_key"])
        self.osc = SimpleUDPClient(cfg["osc_host"], int(cfg["osc_port"]))
        self.audio_q: asyncio.Queue[bytes] = asyncio.Queue(maxsize=128)
        self.stop = asyncio.Event()
        self.accumulated: list[str] = []

    async def push_pcm(self, pcm: bytes) -> None:
        try:
            self.audio_q.put_nowait(pcm)
        except asyncio.QueueFull:
            pass

    async def send_event(self, kind: str, **fields) -> None:
        try:
            await self.ws.send_text(json.dumps({"type": kind, **fields}))
        except Exception:
            pass

    async def run(self) -> None:
        # gemini-3.1-flash-live-preview requires AUDIO modality; we ignore the
        # synthesized audio and only consume input_transcription for STT.
        # Disable Gemini's automatic VAD so it doesn't end the turn on silence —
        # we treat the whole START..STOP window as one continuous "activity".
        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            input_audio_transcription=types.AudioTranscriptionConfig(),
            realtime_input_config=types.RealtimeInputConfig(
                automatic_activity_detection=types.AutomaticActivityDetection(disabled=True),
            ),
        )
        await self.send_event("status", text="CONNECTING")
        try:
            async with self.client.aio.live.connect(model=STT_MODEL, config=config) as session:
                await self.send_event("status", text="LISTENING")
                # Mark the start of one continuous user activity.
                await session.send_realtime_input(activity_start=types.ActivityStart())
                send_task = asyncio.create_task(self._send_audio(session))
                recv_task = asyncio.create_task(self._receive(session))

                # Listen until user requests stop.
                await self.stop.wait()

                # Stop streaming audio first.
                send_task.cancel()
                try: await send_task
                except asyncio.CancelledError: pass

                # Signal end of activity — Gemini will flush the final
                # transcription pieces for our recv loop to consume.
                try:
                    await session.send_realtime_input(activity_end=types.ActivityEnd())
                except Exception:
                    log.exception("activity_end failed")

                # Give Gemini a moment to send the tail of the transcription.
                await asyncio.sleep(1.2)

                # Take everything we've accumulated and analyze.
                transcript = "".join(self.accumulated).strip()
                if transcript:
                    await self.send_event("stt_final", text=transcript)
                    self.osc.send_message(self.cfg["stt_address"], transcript)
                    await self._run_llm(transcript)
                else:
                    await self.send_event("error", text="No speech captured.")

                recv_task.cancel()
                try: await recv_task
                except asyncio.CancelledError: pass
        except Exception as e:
            log.exception("bridge crashed")
            await self.send_event("error", text=f"{type(e).__name__}: {e}")
        finally:
            await self.send_event("status", text="IDLE")
            await self.send_event("done")

    async def _send_audio(self, session) -> None:
        while True:
            pcm = await self.audio_q.get()
            await session.send_realtime_input(
                audio=types.Blob(data=pcm, mime_type="audio/pcm;rate=16000")
            )

    async def _receive(self, session) -> None:
        # Continuously accumulate input_transcription text. We ignore
        # turn_complete on purpose — the LLM only fires when the user
        # presses STOP.
        async for response in session.receive():
            sc = getattr(response, "server_content", None)
            if sc is None:
                continue
            it = getattr(sc, "input_transcription", None)
            if it and getattr(it, "text", None):
                self.accumulated.append(it.text)
                await self.send_event("stt_partial", text="".join(self.accumulated))

    async def _run_llm(self, transcript: str) -> None:
        await self.send_event("status", text="ANALYZING")
        try:
            sys_prompt = (self.cfg.get("system_prompt") or "").strip()
            gen_cfg = types.GenerateContentConfig(
                max_output_tokens=77,
                **({"system_instruction": sys_prompt} if sys_prompt else {}),
            )
            resp = await self.client.aio.models.generate_content(
                model=LLM_MODEL, contents=transcript, config=gen_cfg,
            )
            text = (resp.text or "").strip()
            scenes = extract_scene_prompts(text)

            # Push to UI: full response + isolated scenes.
            await self.send_event("llm", text=text, scenes=scenes)

            # OSC out: send each scene to its own indexed address so TD
            # naturally replaces the previous value in-place instead of
            # accumulating. e.g. /llm/1, /llm/2, /llm/3, /llm/4
            base = self.cfg["llm_address"].rstrip("/")
            payload = scenes if scenes else [text]
            for i, scene in enumerate(payload, 1):
                self.osc.send_message(f"{base}/{i}", scene)
        except Exception as e:
            log.exception("llm failed")
            await self.send_event("error", text=f"LLM: {type(e).__name__}: {e}")


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    bridge: Optional[Bridge] = None
    run_task: Optional[asyncio.Task] = None
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if (data := msg.get("bytes")) is not None:
                if bridge is not None:
                    await bridge.push_pcm(data)
                continue
            text = msg.get("text")
            if text is None:
                continue
            payload = json.loads(text)
            kind = payload.get("type")
            if kind == "start":
                if bridge is not None:
                    continue
                bridge = Bridge(ws, payload["config"])
                run_task = asyncio.create_task(bridge.run())
            elif kind == "stop":
                if bridge is not None:
                    bridge.stop.set()
                    bridge = None
                    if run_task:
                        await run_task
                        run_task = None
    except WebSocketDisconnect:
        pass
    finally:
        if bridge is not None:
            bridge.stop.set()
        if run_task is not None:
            try:
                await run_task
            except Exception:
                pass


if __name__ == "__main__":
    url = "http://localhost:8765"
    log.info("Opening %s", url)
    try:
        webbrowser.open(url)
    except Exception:
        pass
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")
