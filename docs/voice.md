# Voice: TTS, dictation, call mode, push

Everything here is optional. A board with none of it configured works the same, silently.

## What each feature needs

| Feature | What you get | Needs |
|---|---|---|
| **TTS** | 🔊 on lieutenant messages; new messages spoken aloud | a TTS engine ([voxbench](https://github.com/tonylampada/voxbench)) + `tts` config + a voice picked |
| **Dictation** | 🎤 in the chat composer | an STT engine ([whisper_server](https://github.com/tonylampada/whisper_server)) + `stt` config + **https** |
| **Call mode** | 📞 in a lieutenant's chat header: hands-free voice call | **both** TTS and STT + **https** |
| **Push** | board events and chat on your phone's lock screen | **https** only — no engine, no config (see the README) |

The two engines want an NVIDIA GPU. The setup this is written for is one 24 GB card running
both: voxcpm2 holds ~6–9 GB, whisper `large-v3-turbo` ~2 GB.

## The servers

| Service | Repo | Port | Run with |
|---|---|---|---|
| TTS | [voxbench](https://github.com/tonylampada/voxbench#readme), engine **voxcpm2** | 8883 | `engines/tts up voxcpm2` (Docker) |
| STT | [whisper_server](https://github.com/tonylampada/whisper_server#readme) | 8878 | `uv run python server.py`, or the systemd user unit in its README |

Run them on the same machine as the board server. The board's server proxies both
(`/api/tts/*`, `/api/stt/*` on the board's own origin), so the browser — phone included — never
talks to an engine directly, and the engines can stay on loopback.

## Config

In `<workspace>/.bridge-commander/config.json`. The server reads it on every request, so a
reload of the board picks up a change.

```json
{
  "tts": {
    "url": "http://127.0.0.1:8883",
    "lang": "pt",
    "voice": "kokoro-pf-dora-pt",
    "params": {"cfg_value": 3, "inference_timesteps": 14}
  },
  "stt": {"url": "http://127.0.0.1:8878"},
  "publicUrl": "https://myboard.tail1234.ts.net"
}
```

- **`tts.url`** — the engine's base URL, as the board's server reaches it. Required; anything
  malformed means "no TTS".
- **`tts.lang`** — `pt` or `en`, sent with every request.
- **`tts.voice`** — the default voice id, from `engines/tts voices voxcpm2`. `null` means no
  voice until someone picks one in ⚙️ → voice — **and with no voice the board stays silent**,
  on purpose, and says so.
- **`tts.params`** — engine knobs, passed as-is (`curl localhost:8883/v1/params` lists them).
- **`stt.url`** — the whisper server's base URL. Absent = no 🎤, no 📞.
- **`publicUrl`** — the board's https address, if it has one. A page opened over plain http
  points there when it needs the microphone.

## https

Browsers give the microphone and Web Push only to a secure context: https, or `localhost` on
the same machine. A phone on `http://100.x.y.z:4780` has neither. Pick one:

- **`tailscale serve`** (private, recommended). On the board's machine:

  ```bash
  tailscale serve --bg 4780          # https://<machine>.<tailnet>.ts.net → 127.0.0.1:4780
  tailscale serve status
  ```

  Needs MagicDNS and HTTPS certificates enabled in the tailnet's admin console. Only tailnet
  devices reach it. Put the printed address in `publicUrl`.
- **Cloudflare tunnel** (reachable off the tailnet). `cloudflared tunnel` to
  `http://127.0.0.1:4780`, and **put it behind Cloudflare Access** — the board has no auth of
  its own, and a bare public hostname hands anyone on the internet your board and the ability
  to start workers. Server-sent events already carry `no-transform`, so the tunnel streams
  them unbuffered.

## Network exposure

None of the three — board, TTS engine, STT server — has authentication. The bind address
is the auth boundary:

- Default everything to loopback (`127.0.0.1`). With engines and board on one machine, that
  is all you need.
- Something must be reachable from another device: bind that machine's **tailnet IP**
  (`engines/tts up voxcpm2 --host "$(tailscale ip -4)"`, `WHISPER_HOST=<tailnet ip>`, board
  `host`).
- **Never `0.0.0.0`.** voxbench and whisper_server refuse it; don't route around that.

## Muting a call

- 🎙 button beside hang-up (phone and docked desktop call), `M` on a keyboard, or the AirPods
  stem press. Muted: mic track disabled, VAD fed nothing, the utterance open at the press is
  dropped; replies keep playing. Status line shows 🔇 Muted; a falling two-note earcon on mute,
  rising on unmute.
- Mute survives screen-off pause/resume and a mic change; a new call starts unmuted.
- AirPods: while a call is live it holds the Media Session (`metadata` "Bridge Commander call",
  `playbackState` 'playing') with `play`, `pause` and `togglemicrophone` handlers, all toggling
  mute; cleared on hang-up. A stem press during a reply should toggle mute, not pause the reply
  (the handler replaces the default action). Unverified on a real iPhone: whether iOS routes the
  press to a page whose only audio is Web Audio. If it does not, the press does nothing (or
  pauses another app) and the on-screen button is the way.

## Checklist

On the board's machine, with the GPU stack working (`docker run --rm --gpus all ubuntu
nvidia-smi` prints your card):

1. **TTS engine up**

   ```bash
   git clone https://github.com/tonylampada/voxbench.git && cd voxbench
   engines/tts up voxcpm2        # first run: image build + ~5 GB weights + minutes of warmup
   curl -s http://127.0.0.1:8883/health
   # {"status":"ok","engine":"voxcpm2"}
   engines/tts say voxcpm2 "O deploy está verde, capitão." --lang pt --out /tmp/ok.wav
   engines/tts voices voxcpm2 | head -c 400     # pick a voice id
   ```

   Play `/tmp/ok.wav`. If one sentence takes many seconds, the engine fell back to CPU — see
   voxbench's GPU notes.

2. **STT server up**

   ```bash
   git clone https://github.com/tonylampada/whisper_server.git && cd whisper_server
   uv sync
   uv run python server.py        # or install the systemd unit from its README
   curl -s http://127.0.0.1:8878/health
   # {"status":"ok","model":"large-v3-turbo"}
   curl -s http://127.0.0.1:8878/transcribe -F file=@/tmp/ok.wav -F language=pt
   # {"text":"O deploy está verde, capitão.", ...}
   ```

3. **Config** — add `tts`, `stt` (and `publicUrl` once step 4 is done) to
   `.bridge-commander/config.json`, then check the board sees them through its own proxy:

   ```bash
   curl -s http://127.0.0.1:4780/api/config
   # {"voices":null,"tts":{"enabled":true,...,"url":"/api/tts"},"stt":true,...}
   curl -s http://127.0.0.1:4780/api/tts/health
   curl -s http://127.0.0.1:4780/api/stt/health
   ```

4. **https** — `tailscale serve --bg 4780` (or the tunnel), open that address on the phone.

5. **In the browser**
   - ⚙️ → voice: pick a voice, turn 🔊 on, press 🔊 on a lieutenant message — it speaks.
   - 🎤 in the composer: say a sentence — it lands in the text box.
   - 📞 in a lieutenant's chat header: say something ending in "câmbio" — the turn posts, the
     reply is spoken back. Hang up.
   - ⚙️ → 📲: turn push on, press **test** — the notification arrives with the board closed.
     iPhone: open the board from its home-screen icon first.
