# Stochastic Jue

A real-time pipeline that takes spoken input, runs it through Google's Gemini
Live API for speech-to-text, sends the transcript to Gemini 3.5 Flash for an
EPA (Evaluation / Potency / Activity) semantic-affective analysis and four
diffusion-prompt scenes, then forwards the result over OSC to a real-time
StreamDiffusion patch in TouchDesigner.

```
mic  →  browser (Web Audio @ 16 kHz PCM)
            │
            ▼
        WebSocket
            │
            ▼
   FastAPI server (app.py)
       │            │
       │            ├──►  Gemini 3.1 Flash Live  (STT, manual VAD)
       │            ├──►  Gemini 3.5 Flash       (EPA analysis + scenes)
       │            └──►  OSC UDP                /stt  +  /llm
       │                                            │
       │                                            ▼
       │                                    TouchDesigner
       ▼
   Browser UI: floating windows, ASCII brutalist HUD
```

## Authors

- **Metaesthetica** — <https://www.metaesthetica.xyz>
- **Iason Paterakis**
- **Nefeli Manoudaki**

## Stack

- **Backend**: Python 3.10+ • FastAPI • `google-genai` • `python-osc`
- **Frontend**: vanilla HTML / CSS / JS • Web Audio API + AudioWorklet
- **Models**: `gemini-3.1-flash-live-preview` (STT) · `gemini-3.5-flash` (analysis)
- **Output**: OSC over UDP to TouchDesigner

## Run

```bash
pip install -r requirements.txt
python app.py
```

Then open <http://localhost:8765>. The first time you launch:

1. Paste your Google AI Studio API key into the `_ GOOGLE_API_KEY` field.
2. Click anywhere outside the field — it auto-saves to `config.json`
   (this file is git-ignored).
3. Set the OSC host / port to match your TouchDesigner `OSC In` operator
   (default `127.0.0.1:7000`).
4. Edit the system prompt in `[02] SYSTEM_PROMPT` if you want a different
   analysis template.

## Use

1. Click the big circular **▶ START** button.
2. Allow microphone access when Chrome asks.
3. Speak as long as you like — multiple sentences, pauses, anything.
   Gemini's automatic voice-activity detection is disabled, so silence
   between phrases does **not** end the turn.
4. Click **■ STOP** to finalize. The whole transcript is sent to Gemini 3.5
   Flash, which returns the EPA analysis + four scene prompts.
5. Only the four scene prompts (flourishing forest / decaying forest /
   cellular / cosmic) are forwarded to TouchDesigner over OSC as four
   string arguments to `/llm`. The transcript itself goes to `/stt`.

## OSC schema

| Address   | Args     | Sent when            |
|-----------|----------|----------------------|
| `/stt`    | `string` | After STOP, before LLM call. The full transcript. |
| `/llm/1`  | `string` | After LLM returns. Flourishing forest scene prompt. |
| `/llm/2`  | `string` | After LLM returns. Decaying forest scene prompt. |
| `/llm/3`  | `string` | After LLM returns. Microscopic cellular scene prompt. |
| `/llm/4`  | `string` | After LLM returns. Cosmic-scale scene prompt. |

Each scene is sent to its **own address** rather than as four args of a single
`/llm` message — this makes TD's `OSC In DAT` / `OSC In CHOP` replace the
previous value in-place instead of accumulating across analyses.

If you set `llm_address` to something other than `/llm`, the suffixes (`/1`
through `/4`) are appended to whatever you set, e.g. `/scenes/1`, `/scenes/2`, ...

## Configuration

All settings live in `config.json` next to `app.py`:

```json
{
  "api_key":       "...",
  "osc_host":      "127.0.0.1",
  "osc_port":      7000,
  "stt_address":   "/stt",
  "llm_address":   "/llm",
  "system_prompt": "..."
}
```

This file is **not** committed (see `.gitignore`). It is written by the UI
whenever you change a field and click outside it, or click **SAVE LAYOUT & CFG**.

## Window layout

The four panels are draggable by their headers, resizable from the
bottom-right corner, and snap to each other (and to the workspace edges)
within 10 px. Layout state is persisted to the browser's `localStorage`.

The circular START button is a separate fixed overlay — drag it anywhere on
the viewport; its position is also persisted.

## Notes

- `gemini-3.1-flash-live-preview` currently only accepts
  `response_modalities=["AUDIO"]`. We ignore the synthesized audio and only
  consume `input_audio_transcription` for STT.
- The Live API's auto-VAD is disabled and we control turn boundaries
  manually with `ActivityStart` / `ActivityEnd` so long monologues with
  pauses aren't cut short.
- OSC is UDP, so messages are fire-and-forget. If TouchDesigner isn't
  listening, no error surfaces.
