#!/usr/bin/env python3
import sys
import json
import torch
import warnings
import os
from transformers import AutoTokenizer, AutoModelForSequenceClassification
import torch.nn.functional as F

# Suppress warnings for cleaner output
warnings.filterwarnings("ignore")
os.environ['TRANSFORMERS_VERBOSITY'] = 'error'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'


class ConversationTurnDetector:
    def __init__(self):
        try:
            checkpoint = "livekit/turn-detector"
            self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

            print("🔄 Loading tokenizer...", file=sys.stderr, flush=True)
            self.tokenizer = AutoTokenizer.from_pretrained(checkpoint)

            print("🧠 Loading classification model...", file=sys.stderr, flush=True)
            self.model = AutoModelForSequenceClassification.from_pretrained(checkpoint).to(self.device)

            print("✅ Model loaded successfully!", file=sys.stderr, flush=True)
        except Exception as e:
            print(json.dumps({"error": f"Model initialization failed: {str(e)}"}), flush=True)
            sys.exit(1)

    def format_conversation(self, messages):
        try:
            if isinstance(messages, str):
                messages = json.loads(messages)

            if not isinstance(messages, list) or len(messages) == 0:
                return ""

            formatted = []
            for msg in messages:
                role = msg.get('role', '').strip()
                content = msg.get('content', '').strip()
                if role and content:
                    formatted.append(f"<|im_start|>{role}\n{content}<|im_end|>")

            return "\n".join(formatted)
        except Exception as e:
            print(f"Error formatting conversation: {e}", file=sys.stderr, flush=True)
            return ""


    def detect_turn_completion(self, messages):
        try:
            context = self.format_conversation(messages)
            if not context:
                return False

            inputs = self.tokenizer(context, return_tensors="pt", truncation=True, padding=True).to(self.device)
            
            print(context)

            with torch.no_grad():
                outputs = self.model(**inputs)
                probs = F.softmax(outputs.logits, dim=-1)
                yes_prob = probs[0][1].item()

            print(f"Confidence → yes: {yes_prob:.2f}, no: {1 - yes_prob:.2f}", file=sys.stderr, flush=True)

            return yes_prob > 0.55
        except Exception as e:
            print(f"❌ Turn detection failed: {e}", file=sys.stderr, flush=True)
            return False


# Global detector instance
detector = None


def initialize_detector():
    global detector
    if detector is None:
        detector = ConversationTurnDetector()


def main():
    try:
        initialize_detector()
        # print("🟢 Turn Detector gRPC server is running on port 50051", file=sys.stderr, flush=True)

        if len(sys.argv) > 1:
            messages_json = sys.argv[1]
            result = detector.detect_turn_completion(messages_json)
            print("true" if result else "false", flush=True)
        else:
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                if line.lower() == 'exit':
                    break

                result = detector.detect_turn_completion(line)
                print("true" if result else "false", flush=True)

    except Exception as e:
        print(json.dumps({"error": f"Initialization failed: {str(e)}"}), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()