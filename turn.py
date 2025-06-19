#!/usr/bin/env python3
import sys
import json
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer
import torch.nn.functional as F
import warnings
import os

# Suppress warnings for cleaner output
warnings.filterwarnings("ignore")
os.environ['TRANSFORMERS_VERBOSITY'] = 'error'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'


class ConversationTurnDetector:
    def __init__(self):
        try:
            checkpoint = "livekit/turn-detector"
            self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

            print("Loading tokenizer...", file=sys.stderr)
            self.tokenizer = AutoTokenizer.from_pretrained(checkpoint)

            print("Loading model...", file=sys.stderr)
            self.model = AutoModelForSequenceClassification.from_pretrained(checkpoint).to(self.device)

            print("Model loaded successfully!", file=sys.stderr)
        except Exception as e:
            print(json.dumps({"error": f"Model initialization failed: {str(e)}"}))
            sys.exit(1)
    def has_turn_markers(self, last_text, full_context=""):
        """Enhanced linguistic analysis with conversation context"""
        if not last_text or not last_text.strip():
            return False
            
        text_lower = last_text.lower().strip()
        
        # Strong completion indicators
        completion_indicators = [
            '?' in last_text,  # Questions
            last_text.strip().endswith('.'),
            last_text.strip().endswith('!'),
            any(phrase in text_lower for phrase in [
                'what do you think', 'your turn', 'over to you', 'what about you',
                'that\'s it', 'that\'s all', 'done', 'finished', 'complete',
                'goodbye', 'bye', 'see you', 'talk later', 'thanks', 'thank you'
            ])
        ]
        
        # Strong continuation signals (indicates NOT done)
        continuation_signals = any(phrase in text_lower for phrase in [
            'and also', 'furthermore', 'in addition', 'also', 'plus', 'wait',
            'hold on', 'let me think', 'um', 'uh', 'actually', 'but', 'however',
            'let me tell you', 'i was saying', 'as i was saying'
        ])
        
        # Incomplete sentence endings
        incomplete = last_text.strip().endswith((',', 'and', 'but', 'or', 'so', '...', '-'))
        
        # If strong completion indicators and no continuation signals
        if any(completion_indicators) and not continuation_signals and not incomplete:
            return True
            
        # If clear continuation signals or incomplete
        if continuation_signals or incomplete:
            return False
            
        # For substantial complete sentences without continuation signals
        word_count = len(last_text.split())
        if word_count >= 5 and not incomplete and not continuation_signals:
            # Check if it's a complete thought
            return '.' in last_text or '!' in last_text or '?' in last_text
            
        return False
    
    def format_conversation(self, messages):
        """Join conversation turns with <|endoftext|>"""
        try:
            if isinstance(messages, str):
                messages = json.loads(messages)

            if not isinstance(messages, list) or len(messages) == 0:
                return ""

            turns = []
            for msg in messages:
                content = msg.get('content', '').strip()
                if content:
                    turns.append(content)

            return "<|endoftext|>".join(turns)
        except Exception as e:
            print(f"Error formatting conversation: {e}", file=sys.stderr)
            return ""

    def detect_turn_completion(self, messages):
        """Returns True if last user message is likely a turn end"""
        try:
            context = self.format_conversation(messages)
            if not context:
                return False

            inputs = self.tokenizer(context, return_tensors="pt", truncation=True, padding=True).to(self.device)

            with torch.no_grad():
                logits = self.model(**inputs).logits
                probs = F.softmax(logits, dim=-1)
                yes_prob = probs[0][1].item()

            print(f"Confidence: {yes_prob:.2f}", file=sys.stderr)
            if yes_prob > 0.65:
                return True
            elif yes_prob < 0.35:
                return False
            else:
                # Ambiguous? Use linguistic fallback
                last_msg = messages[-1].get('content', '')
                return self.has_turn_markers(last_msg)

        except Exception as e:
            print(f"Turn detection failed: {e}", file=sys.stderr)
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
        print("LiveKit Turn Detector ready!", file=sys.stderr)

        if len(sys.argv) > 1:
            # Command-line input
            messages_json = sys.argv[1]
            result = detector.detect_turn_completion(messages_json)
            print("true" if result else "false")
        else:
            # Interactive stdin input
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                if line.lower() == 'exit':
                    break

                result = detector.detect_turn_completion(line)
                print("true" if result else "false")
                sys.stdout.flush()

    except Exception as e:
        print(json.dumps({"error": f"Initialization failed: {str(e)}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()