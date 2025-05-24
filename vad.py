import sys
import torch
import numpy as np
import json

# Load model
model, utils = torch.hub.load('snakers4/silero-vad', model='silero_vad')
(get_speech_timestamps, _, _, _, _) = utils

# Constants
sample_rate = 16000
min_chunk_samples = sample_rate // 2  # 0.5 seconds = 8000 samples
frame_bytes = min_chunk_samples * 2  # 16-bit PCM

# min_chunk_samples = int(sample_rate * 0.05)  # 50ms = 800 samples
# frame_bytes = min_chunk_samples * 2          # 1600 bytes

audio_buffer = bytearray()
total_samples_processed = 0

print("ready", file=sys.stderr)

while True:
    data = sys.stdin.buffer.read(1024)
    if not data:
        break
    audio_buffer.extend(data)

    while len(audio_buffer) >= frame_bytes:
        chunk = audio_buffer[:frame_bytes]
        audio_buffer = audio_buffer[frame_bytes:]

        audio_np = np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0
        timestamps = get_speech_timestamps(audio_np, model, sampling_rate=sample_rate)

        # Adjust timestamps to global sample indices
        for ts in timestamps:
            ts['start'] += total_samples_processed
            ts['end'] += total_samples_processed

        total_samples_processed += len(audio_np)
        # print("hello")
        sys.stdout.write(json.dumps({'timestamps': timestamps, 'chunk': chunk.hex()}) + "\n")
        sys.stdout.flush()

# Process remaining buffer if large enough
if len(audio_buffer) >= frame_bytes:
    chunk = audio_buffer[:frame_bytes]
    audio_np = np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0
    timestamps = get_speech_timestamps(audio_np, model, sampling_rate=sample_rate)
    for ts in timestamps:
        ts['start'] += total_samples_processed
        ts['end'] += total_samples_processed
    sys.stdout.write(json.dumps({'timestamps': timestamps, 'chunk': chunk.hex()}) + "\n")
    sys.stdout.flush()