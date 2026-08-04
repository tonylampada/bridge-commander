#!/usr/bin/env bash
# Cut a calm window out of a CC0 track, wrap it into a seamless loop, level it,
# and encode it small — the recipe the five files in ui/audio/ were made with.
# Where each one came from and under what licence is in ui/audio/README.md.
#
#   ./dev/build-loops.sh <source> <start-seconds> <loop-seconds> <out.m4a> [xfade] [lead]
#
# Three decisions, each of them found by measuring rather than by taste:
#
# 1. THE WRAP IS A CROSSFADE, NOT A BUTT JOINT.
#
#      out(t) = a(L+t)·fade_out(t) + a(t)·fade_in(t)   for t < X
#               a(t)                                    for X ≤ t < L
#
#    so out(L⁻) = a(L⁻) runs into out(0) = a(L): the two samples that ever end
#    up adjacent were adjacent in the original. Continuous by construction.
#
# 2. LEVELLING IS A MEASUREMENT AND THEN ONE CONSTANT GAIN.
#    `loudnorm` in its one-pass form is a DYNAMIC normaliser: its gain moves
#    across the file, which means a different gain at the end than at the
#    start, and the difference lands exactly on the loop point. The first cut
#    of these files had a 7dB step there. Measure with it, then apply a single
#    `volume=`.
#
# 3. THE FILE IS ONE PERIOD PLUS A SECOND OF THE SAME LOOP AT EITHER END.
#    An AAC encoder has no signal before its first frame and none after its
#    last, and hands back tens of milliseconds of wrong samples at both ends —
#    measured at 35dB above the noise the content otherwise makes, i.e. a tick,
#    once a minute, forever. So the loop points sit a second inside the file,
#    where the decoder is on solid ground; ui/js/music.js loopPoints() is the
#    other half of that. It is also what makes this robust: the file is
#    periodic over its WHOLE length, so any window of exactly one period is a
#    whole loop, and a decoder that pads the front by a frame moves where the
#    loop sits without touching whether it joins.
#
# Verifying a result is not a matter of opinion either: decode it, take the
# window the player will loop, and compare the step across the joint with the
# steps the waveform takes everywhere else. All five ship with a joint step
# below the 99.9th percentile of their own ordinary sample-to-sample motion —
# a click is an outlier, and these are not outliers.
set -euo pipefail
src=$1 start=$2 L=$3 out=$4 X=${5:-6} P=${6:-1} TARGET=${7:--20}
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
END=$(python3 -c "print($L + $X)")

wav() { ffmpeg -v error -y "$@"; }
wav -ss "$start" -t "$END" -i "$src" \
  -af aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo "$T/w.wav"
wav -i "$T/w.wav" -t "$X" "$T/head.wav"
wav -ss "$X" -to "$L" -i "$T/w.wav" "$T/body.wav"
wav -ss "$L" -i "$T/w.wav" "$T/tail.wav"
wav -i "$T/tail.wav" -i "$T/head.wav" \
  -filter_complex "[0:a][1:a]acrossfade=d=$X:c1=tri:c2=tri" "$T/wrap.wav"
wav -i "$T/wrap.wav" -i "$T/body.wav" -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1" "$T/loop.wav"

# one period, with a period's worth of context either side of it
wav -ss "$(python3 -c "print($L - $P)")" -i "$T/loop.wav" "$T/pre.wav"
wav -i "$T/loop.wav" -t "$P" "$T/post.wav"
wav -i "$T/pre.wav" -i "$T/loop.wav" -i "$T/post.wav" \
  -filter_complex "[0:a][1:a][2:a]concat=n=3:v=0:a=1" "$T/ext.wav"

read -r I TP < <(ffmpeg -hide_banner -nostats -i "$T/ext.wav" \
  -af loudnorm=print_format=json -f null - 2>&1 |
  python3 -c "import sys,json; s=sys.stdin.read(); d=json.loads(s[s.rindex('{'):s.rindex('}')+1]); print(d['input_i'], d['input_tp'])")
GAIN=$(python3 -c "print(min($TARGET - ($I), -2 - ($TP)))")
ffmpeg -v error -y -i "$T/ext.wav" -af "volume=${GAIN}dB" \
  -c:a aac -b:a 64k -movflags +faststart "$out"
printf '%-12s loop=%ss lead=%ss  measured I=%s TP=%s  gain=%sdB  -> %s bytes, %ss\n' \
  "$(basename "$out")" "$L" "$P" "$I" "$TP" "$GAIN" "$(stat -c%s "$out")" \
  "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out")"

# ── what made the five in ui/audio/ ───────────────────────────────────────
# The window in each source is the calmest stretch of it — least movement in
# level and in brightness, no near-silence — found by scanning rather than by
# ear, then the crossfade lengthened where the joint still measured badly.
#
#   ./dev/build-loops.sh Ambient-Loop-isaiah658.wav      0 18 ui/audio/warm.m4a    6
#   ./dev/build-loops.sh steller_dreams.flac            42 75 ui/audio/drift.m4a   6
#   ./dev/build-loops.sh claimed_by_the_void_loop.flac 106 75 ui/audio/void.m4a    6
#   ./dev/build-loops.sh dark_cavern_ambient_002.ogg     1 75 ui/audio/cavern.m4a  6
#   ./dev/build-loops.sh Searching.ogg                  13 70 ui/audio/deep.m4a   14
