#!/usr/bin/env python3
import sys
import json
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
import warnings
import os

# Suppress warnings for cleaner output
warnings.filterwarnings("ignore")
os.environ['TRANSFORMERS_VERBOSITY'] = 'error'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'

class ConversationTurnDetector:
    def __init__(self):
        try:
            checkpoint = "HuggingFaceTB/SmolLM-1.7B"
            self.device = "cpu"
            
            print("Loading tokenizer...", file=sys.stderr)
            self.tokenizer = AutoTokenizer.from_pretrained(checkpoint)
            
            print("Loading model (this may take a few minutes on first run)...", file=sys.stderr)
            self.model = AutoModelForCausalLM.from_pretrained(
                checkpoint,
                torch_dtype=torch.float16,
                low_cpu_mem_usage=True,
                device_map="auto"
            )
            
            # Set pad token properly
            if self.tokenizer.pad_token is None:
                self.tokenizer.pad_token = self.tokenizer.eos_token
                self.tokenizer.pad_token_id = self.tokenizer.eos_token_id
                
            print("Model loaded successfully!", file=sys.stderr)
                
        except Exception as e:
            print(json.dumps({"error": f"Model initialization failed: {str(e)}"}))
            sys.exit(1)
    
    def format_conversation(self, messages):
        """Format messages array into conversation context"""
        try:
            if isinstance(messages, str):
                # If it's a JSON string, parse it
                messages = json.loads(messages)
            
            if not isinstance(messages, list) or len(messages) == 0:
                return ""
            
            conversation = []
            for msg in messages:
                role = msg.get('role', 'user')
                content = msg.get('content', '').strip()
                
                if content:
                    if role == 'user':
                        conversation.append(f"User: {content}")
                    elif role == 'assistant':
                        conversation.append(f"Assistant: {content}")
                    else:
                        conversation.append(f"{role}: {content}")
            
            return "\n".join(conversation)
            
        except Exception as e:
            print(f"Error formatting conversation: {e}", file=sys.stderr)
            return ""
    
    def analyze_conversation_context(self, messages):
        """Analyze full conversation context for turn completion"""
        conversation_text = self.format_conversation(messages)
        
        if not conversation_text:
            return False
        
        # Get the last message
        try:
            if isinstance(messages, str):
                messages = json.loads(messages)
            
            if not messages:
                return False
                
            last_message = messages[-1]
            last_content = last_message.get('content', '').strip()
            last_role = last_message.get('role', 'user')
            
            # Quick linguistic analysis
            linguistic_result = self.has_turn_markers(last_content, conversation_text)
            
            # For short messages or clear indicators, use linguistic analysis
            if len(last_content.split()) < 5 or '?' in last_content:
                return linguistic_result
            
            # Use AI analysis for complex cases
            return self.ai_analysis_with_context(conversation_text, last_content, last_role)
            
        except Exception as e:
            print(f"Error in context analysis: {e}", file=sys.stderr)
            return False
    
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
    
    def ai_analysis_with_context(self, conversation_context, last_message, last_role):
        """Use AI model for contextual turn detection"""
        try:
            prompt = f"""Analyze this conversation to determine if the last speaker has finished their turn:

CONVERSATION:
{conversation_context}

QUESTION: Has the {last_role} finished speaking their turn? Consider:
- Is their last message a complete thought?
- Are they asking a question that expects a response?
- Are there signs they want to continue (incomplete sentences, trailing words)?
- Does the context suggest they're done or still talking?

Answer only "YES" if they're completely done speaking, or "NO" if they want to continue."""

            # Tokenize with proper attention mask
            inputs = self.tokenizer(
                prompt, 
                return_tensors="pt", 
                truncation=True, 
                max_length=1024,
                padding=True
            )
            
            with torch.no_grad():
                outputs = self.model.generate(
                    inputs['input_ids'],
                    attention_mask=inputs['attention_mask'],
                    max_new_tokens=3,
                    temperature=0.1,
                    do_sample=True,
                    pad_token_id=self.tokenizer.pad_token_id,
                    eos_token_id=self.tokenizer.eos_token_id
                )
            
            response = self.tokenizer.decode(
                outputs[0][len(inputs['input_ids'][0]):], 
                skip_special_tokens=True
            ).strip().upper()
            
            return "YES" in response
            
        except Exception as e:
            print(f"AI analysis failed: {e}", file=sys.stderr)
            # Fallback to linguistic analysis
            return self.has_turn_markers(last_message)
    
    def detect_turn_completion(self, messages_input):
        """Main detection function - returns True if turn is complete"""
        try:
            return self.analyze_conversation_context(messages_input)
        except Exception as e:
            print(f"Turn detection error: {e}", file=sys.stderr)
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
        print("Conversation turn detector ready!", file=sys.stderr)
        
        if len(sys.argv) > 1:
            # Command line argument mode - expect JSON string
            messages_json = sys.argv[1]
            result = detector.detect_turn_completion(messages_json)
            print("true" if result else "false")
        else:
            # Interactive mode - read JSON from stdin
            try:
                for line in sys.stdin:
                    line = line.strip()
                    if not line:
                        continue
                        
                    if line.lower() == 'exit':
                        break
                    
                    # Expect JSON input
                    result = detector.detect_turn_completion(line)
                    print("true" if result else "false")
                    sys.stdout.flush()
                    
            except KeyboardInterrupt:
                pass
            except Exception as e:
                print(json.dumps({"error": str(e)}))
                
    except Exception as e:
        print(json.dumps({"error": f"Initialization failed: {str(e)}"}))
        sys.exit(1)

if __name__ == "__main__":
    main()