import numpy as np
from transformers import AutoTokenizer, AutoModelForCausalLM
import torch
from typing import Any


class EndOfTurnModel:
    HF_MODEL_ID = "HuggingFaceTB/SmolLM2-360M-Instruct"

    MAX_HISTORY = 6    # Maximum number of messages to consider in history
    DEFAULT_THRESHOLD = 0.05   # Default probability threshold for determining end of turn

    def __init__(self, threshold: float = DEFAULT_THRESHOLD):
        self.threshold = threshold
        
        print(f"Loading model {self.HF_MODEL_ID} for local CPU inference. This may take a while...")
        self.tokenizer = AutoTokenizer.from_pretrained(
            self.HF_MODEL_ID,
            truncation_side="left",  # Truncate from the left if messages exceed max length
        )
        self.model = AutoModelForCausalLM.from_pretrained(self.HF_MODEL_ID)
        self.model.to("cpu")  # Ensure model is on CPU
        self.model.eval()     # Set model to evaluation mode
        print("Model loaded successfully.")
        print("\n" + "="*70 + "\n")


    def _convert_messages_to_chatml(self, messages: list[dict[str, Any]]) -> str:
        """
        Converts a list of messages into a single string in ChatML format.
        The EOT token (<|im_end|>) is removed from the last utterance, as the model
        is expected to predict its presence.

        Args:
            messages (list[dict[str, Any]]): A list of message dictionaries,
                                             each with "role" and "content".

        Returns:
            str: A string representing the conversation in ChatML format.
        """
        if not messages:
            return ""

        # Apply the chat template to format messages (e.g., adding special tokens like <|im_start|>)
        tokenized_convo = self.tokenizer.apply_chat_template(
            messages,
            add_generation_prompt=False,  # Do not add an assistant prompt for generation
            add_special_tokens=False,     # Special tokens are handled by the template
            tokenize=False,
        )

        # Important: Remove the end-of-turn token from the very end of the latest utterance,
        # as we want the model to predict this token.
        eot_token = "<|im_end|>"
        last_eot_index = tokenized_convo.rfind(eot_token)
        if last_eot_index != -1:
            text = tokenized_convo[:last_eot_index]
            return text
        return tokenized_convo


    def get_next_token_logprobs(self, prompt_text: str) -> dict[str, float]:
        """
        Performs local inference to get log probabilities for the next token.
        
        Args:
            prompt_text (str): The formatted conversation text.
            
        Returns:
            dict[str, float]: Dictionary mapping tokens to their log probabilities.
        """
        inputs = self.tokenizer(prompt_text, return_tensors="pt", add_special_tokens=False).to("cpu")

        with torch.no_grad():
            outputs = self.model(**inputs)
        
        next_token_logits = outputs.logits[0, -1, :]  # Batch size 1, last token position
        log_softmax_probs = torch.nn.functional.log_softmax(next_token_logits, dim=-1)
        
        # Get top N logprobs (e.g., 20)
        k = 20 
        top_logprobs_vals, top_logprobs_ids = torch.topk(log_softmax_probs, k)
        
        top_logprobs_dict = {}
        for i in range(k):
            token_id = top_logprobs_ids[i].item()
            # Decode the token ID to its string representation
            token_str = self.tokenizer.decode([token_id]) 
            logprob_val = top_logprobs_vals[i].item()
            top_logprobs_dict[token_str] = logprob_val
            
        # Directly return the dictionary of token -> logprob
        return top_logprobs_dict
    

    def process_result(
        self, top_logprobs: dict[str, float], target_tokens: list[str] = ["<|im_end|>"]
    ) -> tuple[float, str]:
        """
        Processes the model's output to find the maximum probability
        among specified target tokens (e.g., EOT markers, punctuation).

        Args:
            top_logprobs (dict[str, float]): Dictionary mapping tokens to their log probabilities.
            target_tokens (list[str], optional): A list of tokens to look for.
                                                Defaults to common EOT indicators.

        Returns:
            tuple[float, str]: A tuple containing the maximum probability found for any
                              target token, and the token itself. Returns (0.0, "") if
                              no target tokens are found or if there's an error.
        """
        try:
            token_probs = {token: f"{np.exp(logprob):.4f}" for token, logprob in top_logprobs.items()}
            print(f"Token probabilities: {token_probs}")
            
            # Check for target tokens (like <|im_end|>)
            max_prob = 0.0
            best_token = ""

            for token_str, logprob in top_logprobs.items():
                # The tokenizer might add leading spaces to tokens, so strip them.
                stripped_token = token_str.strip()
                if stripped_token in target_tokens:
                    # Convert log probability back to probability (exp(logprob)).
                    prob = np.exp(logprob)
                    if prob > max_prob:
                        max_prob = prob
                        best_token = stripped_token
            
            # If we found a target token, show its probability
            if best_token:
                print(f"Found target token: '{best_token}' with probability: {max_prob:.4f}")
            
            return max_prob, best_token

        except (KeyError, TypeError) as e:
            print(f"Error processing result: {type(e).__name__} - {e}")
            return 0.0, ""


    def predict_eot_prob(self, messages: list[dict[str, Any]]) -> float:
        """
        Predicts the probability that the current turn is complete.

        Args:
            messages (list[dict[str, Any]]): The list of messages.

        Returns:
            float: The probability (0.0 to 1.0) that the turn is complete.
        """
        # Consider only the most recent messages, up to MAX_HISTORY.
        truncated_messages = messages[-self.MAX_HISTORY:]

        # Convert messages to the ChatML string format required by the model.
        text_input = self._convert_messages_to_chatml(truncated_messages)
    
        print(f"EOT Input: '...{text_input}'")

        # Get log probabilities for the next token
        top_logprobs = self.get_next_token_logprobs(text_input)

        # Process the result to extract the probability of an EOT-indicating token.
        eot_prob, _ = self.process_result(top_logprobs)

        print(f"EOT Probability: {eot_prob:.4f}")

        return eot_prob


    def predict_eot(self, messages: list[dict[str, Any]]) -> bool:
        """
        Predicts whether the current turn in the conversation is complete.

        Args:
            messages (list[dict[str, Any]]): The list of messages in the conversation.

        Returns:
            bool: True if the turn is predicted to be complete, False otherwise.
        """
        try:
            eot_prob = self.predict_eot_prob(messages)
            return eot_prob >= self.threshold
        except Exception as e:
            print(f"EOT prediction failed due to error: {str(e)}. Defaulting to True.")
            return True


def main():
    model = EndOfTurnModel()

    # Example 1: Incomplete turn
    print("\n--- Example 1: Incomplete turn ---")
    conversation1 = [
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "How may I help you today?"},
        {"role": "user", "content": "Can I have two chicken McNuggets and"}
    ]
    is_eot1 = model.predict_eot(conversation1)
    print(f"Conversation 1 - Is EOT? {is_eot1}")  # Expected: False
    
    print("\n" + "="*70 + "\n")

    # Example 2: Complete turn
    print("--- Example 2: Complete turn ---")
    conversation2 = [
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "How may I help you today?"},
        {"role": "user", "content": "I have a problem with my card."}
    ]
    is_eot2 = model.predict_eot(conversation2)
    print(f"Conversation 2 - Is EOT? {is_eot2}")


if __name__ == "__main__":
    main()
