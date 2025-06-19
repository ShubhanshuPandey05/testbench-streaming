# train_turn_detector.py
from transformers import AutoTokenizer, AutoModelForSequenceClassification, Trainer, TrainingArguments
from datasets import load_dataset
import torch

model_name = "HuggingFaceTB/SmolLM2-135M"
tokenizer = AutoTokenizer.from_pretrained(model_name)

# Load your CSV dataset
dataset = load_dataset('csv', data_files='turn_dataset.csv')

# Tokenize
def tokenize(example):
    return tokenizer(example["text"], truncation=True, padding="max_length", max_length=128)

tokenized = dataset.map(tokenize)

# Format for classification
tokenized = tokenized.rename_column("label", "labels")
tokenized.set_format("torch")

# Load base model for classification
model = AutoModelForSequenceClassification.from_pretrained(model_name, num_labels=2)

# Training configuration
training_args = TrainingArguments(
    output_dir="./smol-turn-checkpoint",
    per_device_train_batch_size=8,
    num_train_epochs=5,
    evaluation_strategy="no",
    save_strategy="epoch",
    logging_dir="./logs",
    logging_steps=10,
    fp16=torch.cuda.is_available(),  # Mixed precision if GPU
)

trainer = Trainer(
    model=model,
    args=training_args,
    train_dataset=tokenized["train"]
)

trainer.train()