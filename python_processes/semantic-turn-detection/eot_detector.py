from fastapi import FastAPI, Request
from pydantic import BaseModel
from typing import List, Union
import traceback
from semantic_turn_detection import EndOfTurnModel # Assuming model is defined in this module

model = EndOfTurnModel()

app = FastAPI()

class Message(BaseModel):
    role: str
    content: str

from fastapi import FastAPI, Request

app = FastAPI()

@app.post("/predict_eot")
async def predict_eot(request: Request):
    data = await request.json()
    if not isinstance(data, dict):
        return {"error": "Input must be a JSON object"}

    messages = data.get("messages", [])
    if not isinstance(messages, list):
        return {"error": "messages must be a list of message dicts"}

    print(f"Received messages: {messages}")
    is_complete = bool(model.predict_eot(messages))  # 👈 Cast to native Python bool
    return {"eot": is_complete}
