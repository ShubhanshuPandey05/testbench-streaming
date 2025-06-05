# Semantic Turn Detection with Small Language Model

This script uses a Small Language Model to predict whether the current turn in a conversation is complete. The model runs locally on CPU to analyze the probability of end-of-turn markers.

## Prerequisites

1. **Python Environment**: Ensure you have Python 3.7+ installed.
2. **Python Dependencies**: Install the necessary Python libraries using pip:
   ```bash
   pip install -r requirements.txt
   ```
   This will install `numpy`, `transformers`, and `torch`.

## Running the Script

Simply run the script directly:

```bash
python semantic-turn-detection.py
```

The first time you run the script, it will download the Hugging Face model (`HuggingFaceTB/SmolLM2-360M-Instruct`). This can take some time and requires disk space.

The script will output the end-of-turn prediction for two example conversations:
1. An incomplete turn (expected result: False)
2. A complete turn (expected result: True)

## How it Works

The `EndOfTurnModel` class handles the turn prediction logic:
- It loads the specified model from Hugging Face for local CPU inference
- It takes a list of messages representing the conversation history
- It formats these messages into the ChatML format expected by the model
- It performs inference to get the log probabilities of the next potential tokens
- It processes the output to find the probability of an end-of-turn token (e.g., `<|im_end|>`)
- If this probability is above a predefined threshold, the turn is considered complete

Key parameters in `EndOfTurnModel`:
- `HF_MODEL_ID`: The Hugging Face model identifier
- `MAX_HISTORY`: The maximum number of recent messages to consider for prediction
- `DEFAULT_THRESHOLD`: The probability threshold used to determine if a turn is complete

## Customization

You can customize the model's behavior by modifying the following parameters:
- Adjust the `DEFAULT_THRESHOLD` value to make the detection more or less sensitive
- Change the `MAX_HISTORY` value to consider more or fewer messages in the conversation history
- Modify the list of `target_tokens` in the `process_result` method to look for different end-of-turn indicators