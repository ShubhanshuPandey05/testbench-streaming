from transformers import AutoTokenizer, AutoModelForSequenceClassification
import torch

# Load the model and tokenizer
model_name = "livekit/turn-detector"
tokenizer = AutoTokenizer.from_pretrained(model_name)
model = AutoModelForSequenceClassification.from_pretrained(model_name)

# Example conversation context (up to 8 turns works best)
conversation = [
    "Hi, I want to ask something.",
    "I just saw a promotional offer, can you...",
    "Where can I find it?",
    "I'm a bit confused about this product.",
    "Can you tell me how long delivery might take?",
    "Thanks for your help, I want to...",
    "I still have some questions about this.",
    "What should I do next?"
]


# Combine into the input string expected by the model
# This model expects turns joined by <|endoftext|>
joined = "<|endoftext|>".join(conversation)

# Tokenize
inputs = tokenizer(joined, return_tensors="pt", truncation=True)

# Inference
with torch.no_grad():
    logits = model(**inputs).logits
    probs = torch.softmax(logits, dim=-1)

# Output
confidence = probs[0][1].item()
print("Finished speaking:" if confidence > 0.5 else "Not finished speaking:")
print(f"Confidence: {confidence:.2f}")