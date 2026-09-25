from dataclasses import dataclass


@dataclass
class Reply:
    text: str
    input_tokens: int = 0
    output_tokens: int = 0
