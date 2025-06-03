import sys
import json
from transformers import AutoTokenizer, AutoModelForSequenceClassification
import torch

def main(messages):
    try:
        # Load tokenizer and model
        tokenizer = AutoTokenizer.from_pretrained('livekit/turn-detector')
        model = AutoModelForSequenceClassification.from_pretrained('livekit/turn-detector')

        # Format conversation using chat template
        text = tokenizer.apply_chat_template(messages, add_generation_prompt=False, tokenize=False)

        # Tokenize input
        inputs = tokenizer(text, return_tensors="pt", padding=True, truncation=True)

        # Run inference
        with torch.no_grad():
            outputs = model(**inputs)
            probabilities = torch.softmax(outputs.logits, dim=-1)
            eou_probability = probabilities[0][1].item()  # Assuming index 1 is EOU class

        # Output in JSON format as per system prompt
        print(json.dumps({
            "output": f"End of utterance probability: {eou_probability}",
            "outputType": "text"
        }))
    except Exception as e:
        print(json.dumps({
            "output": f"Error: {str(e)}",
            "outputType": "text"
        }))

if __name__ == "__main__":
    try:
        messages = json.load(sys.stdin)
        main(messages)
    except json.JSONDecodeError as e:
        print(json.dumps({
            "output": f"JSON Decode Error: {str(e)}",
            "outputType": "text"
        }))