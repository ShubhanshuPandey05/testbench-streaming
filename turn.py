import math
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from typing import Any, List, Dict, Tuple

class ConversationTurnDetector:
    HF_MODEL_ID = "HuggingFaceTB/SmolLM2-360M-Instruct"
    MAX_HISTORY = 4
    DEFAULT_THRESHOLD = 0.03

    def __init__(self, threshold: float = DEFAULT_THRESHOLD):
        self.threshold = threshold
        self.tokenizer = AutoTokenizer.from_pretrained(self.HF_MODEL_ID, truncation_side="left")
        self.model = AutoModelForCausalLM.from_pretrained(self.HF_MODEL_ID)
        self.model.to("cpu")
        self.model.eval()

    def _convert_messages_to_chatml(self, messages: List[Dict[str, Any]]) -> str:
        """
        Converts a list of messages into a single string in ChatML format.
        Removes the EOT token from the last message so the model can predict it.
        """
        if not messages:
            return ""

        tokenized_convo = self.tokenizer.apply_chat_template(
            messages,
            add_generation_prompt=False,
            add_special_tokens=False,
            tokenize=False,
        )

        eot_token = "<|im_end|>"
        last_eot_index = tokenized_convo.rfind(eot_token)
        if last_eot_index != -1:
            return tokenized_convo[:last_eot_index]
        return tokenized_convo

    def get_next_token_logprobs(self, prompt_text: str) -> Dict[str, float]:
        """
        Performs local inference to get log probabilities for the next token.
        """
        inputs = self.tokenizer(prompt_text, return_tensors="pt", add_special_tokens=False).to("cpu")

        with torch.no_grad():
            outputs = self.model(**inputs)

        next_token_logits = outputs.logits[0, -1, :]
        log_softmax_probs = torch.nn.functional.log_softmax(next_token_logits, dim=-1)

        k = 20
        top_logprobs_vals, top_logprobs_ids = torch.topk(log_softmax_probs, k)

        top_logprobs_dict = {}
        for i in range(k):
            token_id = top_logprobs_ids[i].item()
            token_str = self.tokenizer.decode([token_id])
            logprob_val = top_logprobs_vals[i].item()
            top_logprobs_dict[token_str] = logprob_val

        return top_logprobs_dict

    def process_result(self, top_logprobs: Dict[str, float], target_tokens: List[str] = ["<|im_end|>"]) -> Tuple[float, str]:
        """
        Extracts the max probability among the specified target tokens.
        """
        max_prob = 0.0
        best_token = ""

        for token_str, logprob in top_logprobs.items():
            stripped_token = token_str.strip()
            if stripped_token in target_tokens:
                prob = math.exp(logprob)
                if prob > max_prob:
                    max_prob = prob
                    best_token = stripped_token

        return max_prob, best_token

    def predict_eot_prob(self, messages: List[Dict[str, Any]]) -> float:
        """
        Predicts the probability that the current turn is complete.
        """
        truncated_messages = messages[-self.MAX_HISTORY:]
        text_input = self._convert_messages_to_chatml(truncated_messages)

        print(f"EOT Input: '...{text_input}'")
        top_logprobs = self.get_next_token_logprobs(text_input)
        eot_prob, _ = self.process_result(top_logprobs)
        print(f"EOT Probability: {eot_prob:.4f}")
        return eot_prob
    
    def detect_turn_completion(self, messages: List[Dict[str, Any]]) -> bool:
        """
        Returns True if end-of-turn probability exceeds threshold.
        """
        eot_prob = self.predict_eot_prob(messages)
        return eot_prob > self.threshold

    

# model = EndOfTurnModel()
# messages = [
#     {"role": "user", "content": "What's the weather like today?"},
#     {"role": "assistant", "content": "It's sunny and 25 degrees Celsius."}
# ]
# prob = model.predict_eot_prob(messages)
# print("Is end of turn likely?", prob > model.threshold)
