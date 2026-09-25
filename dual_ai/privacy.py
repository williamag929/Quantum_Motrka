import re
from typing import Optional

# Ordered most specific first; mirrors dual_ai_ext/core/privacy-scanner.js plus PII patterns.
_PATTERNS = [
    (re.compile(r"sk-[a-zA-Z0-9_\-]{20,}"), "API key (sk-)"),
    (re.compile(r"nvapi-[a-zA-Z0-9_\-]{20,}"), "NVIDIA API key"),
    (re.compile(r"AKIA[0-9A-Z]{16}"), "AWS access key"),
    (re.compile(r"AIza[0-9A-Za-z\-_]{35}"), "Google API key"),
    (re.compile(r"gh[pousr]_[a-zA-Z0-9]{36}"), "GitHub token"),
    (re.compile(r"xox[baprs]-[0-9a-zA-Z\-]{10,}"), "Slack token"),
    (re.compile(r"Bearer\s+[a-zA-Z0-9\-._~+/]{20,}={0,2}"), "Bearer token"),
    (re.compile(r"-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE KEY-----"), "PEM private key"),
    (re.compile(r"(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis)://[^\"'\s]{10,}", re.I), "DB connection string"),
    (re.compile(r"(?:password|passwd|contraseña|secret|api[_\-]?key|auth[_\-]?token)\s*[:=]\s*[\"']?[^\s\"']{8,}", re.I), "credential assignment"),
    (re.compile(r"\b\d{3}-\d{2}-\d{4}\b"), "US SSN"),
]

_CARD = re.compile(r"\b(?:\d[ -]?){12,18}\d\b")


def _luhn_ok(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2:
            d = d * 2 - 9 if d > 4 else d * 2
        total += d
    return total % 10 == 0


def scan(text: str) -> Optional[str]:
    """Return a label for the first secret/PII pattern found in text, or None."""
    for pattern, label in _PATTERNS:
        if pattern.search(text):
            return label
    for m in _CARD.finditer(text):
        digits = re.sub(r"\D", "", m.group())
        if 13 <= len(digits) <= 19 and _luhn_ok(digits):
            return "card number"
    return None


# Spans to hide from cloud models. Where a pattern has a group, only the group is hidden,
# so the model still sees the structure (e.g. which variable or URL scheme it is).
_REDACT = [
    (re.compile(r"-----BEGIN[^-]*PRIVATE KEY-----.*?-----END[^-]*PRIVATE KEY-----", re.S), "PRIVATE_KEY"),
    (re.compile(r"(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp)://[^:/@\s]*:([^@\s]+)@", re.I), "PASSWORD"),
    (re.compile(r"Bearer\s+([a-zA-Z0-9\-._~+/]{20,}={0,2})"), "TOKEN"),
    (re.compile(r"(?:sk|rk|pk)[-_](?:live|test|proj|ant)?[-_]?[a-zA-Z0-9_\-]{12,}"), "API_KEY"),
    (re.compile(r"nvapi-[a-zA-Z0-9_\-]{20,}"), "API_KEY"),
    (re.compile(r"AKIA[0-9A-Z]{16}"), "AWS_KEY_ID"),
    (re.compile(r"AIza[0-9A-Za-z\-_]{35}"), "API_KEY"),
    (re.compile(r"gh[pousr]_[a-zA-Z0-9]{36}"), "TOKEN"),
    (re.compile(r"xox[baprs]-[0-9a-zA-Z\-]{10,}"), "TOKEN"),
    (re.compile(r"(?:password|passwd|contraseña|secret|api[_\-]?key|auth[_\-]?token|access[_\-]?key)[A-Z_]*\s*[:=]\s*[\"']?([^\s\"']{8,})", re.I), "SECRET"),
    (re.compile(r"\b(\d{3}-\d{2}-\d{4})\b"), "SSN"),
]


def redact(text: str, mapping: dict[str, str] | None = None) -> tuple[str, dict[str, str]]:
    """Replace secrets with placeholders like [SECRET_1]; return text and placeholder→value map.

    Pass the same mapping across a conversation so a secret keeps one placeholder in every turn.
    """
    mapping = {} if mapping is None else mapping
    by_value = {v: k for k, v in mapping.items()}
    for value, placeholder in by_value.items():
        text = text.replace(value, placeholder)

    def hide(value: str, kind: str, hint: str = "") -> str:
        if value in mapping:  # already a placeholder
            return value
        if value not in by_value:
            by_value[value] = f"[{kind}_{len(mapping) + 1}{hint}]"
            mapping[by_value[value]] = value
        return by_value[value]

    for pattern, kind in _REDACT:
        def sub(m: re.Match, kind=kind) -> str:
            if m.lastindex:
                start, end = m.span(1)
                return m.group(0)[: start - m.start()] + hide(m.group(1), kind) + m.group(0)[end - m.start():]
            return hide(m.group(0), kind)
        text = pattern.sub(sub, text)

    def card(m: re.Match) -> str:
        digits = re.sub(r"\D", "", m.group())
        if not (13 <= len(digits) <= 19 and _luhn_ok(digits)):
            return m.group()
        # Receipts show the last four digits; keeping them lets the model write "card ending in 1111".
        return hide(m.group(), "CARD", f" ending {digits[-4:]}")
    text = _CARD.sub(card, text)
    return text, mapping


# Bump when redaction output changes, so cached benchmark answers to redacted requests are re-measured.
REDACTION_VERSION = 2

REDACTION_NOTE = (
    "\n\nSome values in this conversation were replaced before it left the user's computer: tokens such as "
    "[PASSWORD_1], [API_KEY_2] or [CARD_3 ending 1234] stand for real secrets. Treat each one as a valid value "
    "of that kind (not as literal brackets). Write a placeholder in your answer only where the real value is "
    "genuinely required, such as code or configuration the user will run; never put one in a message meant for "
    "other people (refer to a card by its last four digits instead)."
)


def restore(text: str, mapping: dict[str, str]) -> str:
    for placeholder, value in mapping.items():
        text = text.replace(placeholder, value)
    return text


class StreamRestorer:
    """Restore placeholders in streamed text whose chunks may split a placeholder."""

    def __init__(self, mapping: dict[str, str]) -> None:
        self.mapping = mapping
        self.pending = ""

    def feed(self, chunk: str) -> str:
        self.pending += chunk
        cut = self.pending.rfind("[")
        if cut == -1 or "]" in self.pending[cut:] or len(self.pending) - cut > 40:
            out, self.pending = self.pending, ""
        else:
            out, self.pending = self.pending[:cut], self.pending[cut:]
        return restore(out, self.mapping)

    def flush(self) -> str:
        out, self.pending = self.pending, ""
        return restore(out, self.mapping)
