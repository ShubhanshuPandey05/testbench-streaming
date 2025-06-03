# Use a pipeline as a high-level helper
from transformers import pipeline

pipe = pipeline("text-classification", model="livekit/turn-detector")
text = "Can you help me in"
result = pipe(text)
print(result)
