# build_dataset.py
import pandas as pd

finished_lines = open("finished.txt", encoding="utf-8").read().splitlines()
unfinished_lines = open("unfinished.txt", encoding="utf-8").read().splitlines()

df = pd.DataFrame({
    "text": finished_lines + unfinished_lines,
    "label": [1] * len(finished_lines) + [0] * len(unfinished_lines)
})

df.to_csv("turn_dataset.csv", index=False)