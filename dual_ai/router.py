import json
import re
import time
from dataclasses import dataclass

import ollama

from config import CLOUD_HINTS, GEMMA_MODEL, LOCAL_HINTS
from privacy import redact


# Sensitive personal topics (English and Spanish). Unlike secrets, these have no placeholder
# that keeps the request meaningful, so requests about them stay on this machine.
_PERSONAL = re.compile(
    r"\b(?:"
    r"my doctor|mi m[eé]dico|diagnosed with|me diagnosticaron|mi diagn[oó]stico|biops\w*|oncolog\w*|c[aá]ncer|hba1c|glucos[ae]|"
    r"blood pressure|presi[oó]n arterial|prescri\w*|receta m[eé]dica|medica(?:tion|mento)s?|psychiatr\w*|psiquiatr\w*|"
    r"therapist|terapeuta|depressi\w*|depresi[oó]n|anxiety|ansiedad|mental health|salud mental|pregnan\w*|embaraz\w*|"
    r"\d+\s?mg|"
    r"salary|salario|sueldo|my debt|mi deuda|credit card debt|student loans?|pr[eé]stamos?|mortgage|hipoteca|"
    r"\d+(?:\.\d+)?%\s?apr|net worth|bank account|cuenta bancaria|i owe|le debo|tax return|declaraci[oó]n de impuestos|"
    r"divorc\w*|custody|custodia|lawsuit|demanda judicial|my lawyer|mi abogad[oa]|arrest\w*|"
    r"performance review|evaluaci[oó]n de desempe[nñ]o|got fired|was fired|me despidieron|despido|harass\w*|acoso|discriminat\w*|discriminaci[oó]n|"
    r"hr department|recursos humanos|to hr\b|a rrhh|"
    r"pii|data breach|brecha de datos|customer records|datos de clientes"
    r")\b",
    re.IGNORECASE,
)


def looks_personal(message: str) -> bool:
    return bool(_PERSONAL.search(message))


# Intent lexicon (English and Spanish). Cloud cues win over local cues: a request to
# "write a reply" or "explain this email" needs the strong model.
_CLOUD_INTENT = re.compile(
    r"\b(?:write|escrib\w*|implement\w*|function|funci[oó]n|script|fix|arregl\w*|refactor\w*|"
    r"debug\w*|design|diseñ\w*|explain\w*|explica\w*|why|por qu[eé]|how does|how do|c[oó]mo funciona|"
    r"calculat\w*|calcul\w*|how many|how much|cu[aá]nt[oa]s?|probabilit\w*|probabilidad|query|consulta|regex|"
    r"sql|schema|esquema|review|revisa|negotiat\w*|negocia\w*|step by step|paso a paso)\b"
    # "code"/"código" mean programming, except in "status code", "código de estado/error/HTTP".
    r"|(?<!status )(?<!error )(?<!http )\bcode\b|\bc[oó]digos?\b(?! (?:de )?(?:estado|error|http))"
    r"|```|\bdef |\bclass |=>|;\n|\(\)",
    re.IGNORECASE,
)
_LOCAL_INTENT = re.compile(
    r"\b(?:classify|clasifica|label|etiqueta|translate|traduc\w*|summari[sz]e|resum\w*|tl;?dr|rewrite|"
    r"reescrib\w*|extract|extrae|reply|responde|respuesta|email|correo|message|mensaje|what is|what's|"
    r"qu[eé] es|qu[eé] significa|cu[aá]l es|which|what does|convert|convierte)\b",
    re.IGNORECASE,
)


_LABEL_ONLY = re.compile(r"label only|only the label|solo la etiqueta|answer with the label", re.IGNORECASE)


def quick_answer(message: str) -> bool:
    """One-line questions and label-only requests: the local model answers as well without reasoning, 5x faster."""
    return bool(_LABEL_ONLY.search(message)) or ("\n" not in message.strip() and len(message.split()) <= 15)


def intent_route(message: str) -> str:
    """Zero-cost router from request intent: 'local' or 'cloud'."""
    if _CLOUD_INTENT.search(message):
        return "cloud"
    if _LOCAL_INTENT.search(message):
        return "local"
    return "local" if len(message.split()) <= 12 else "cloud"


def route(message: str) -> str:
    """Keyword router: 'local' or 'cloud'. Tie-break: ≤ 8 words → local."""
    lower = message.lower()
    local_score = sum(1 for hint in LOCAL_HINTS if hint in lower)
    cloud_score = sum(1 for hint in CLOUD_HINTS if hint in lower)
    if local_score != cloud_score:
        return "local" if local_score > cloud_score else "cloud"
    return "local" if len(lower.split()) <= 8 else "cloud"


TRIAGE_PROMPT = """Decide where to run a user's request. A small model runs on this computer and is reliable only for simple, well-defined tasks. A strong model runs in the cloud.

route = "local" ONLY for:
- a short factual question or definition with a well-known answer
- classifying or labeling a given email or text, or extracting items from it
- translating, rewriting, or summarizing a short text that the user provides
- a short, routine email or message (thank-you, reschedule, decline, follow-up)

route = "cloud" for everything else, including: writing, fixing, reviewing or explaining code; math, calculations and estimates; explaining how or why something works; design; negotiation or persuasive writing; anything with several steps.

private = true when the request contains passwords, keys or tokens, or personal health, financial, legal, HR or family information.

Answer with JSON only."""

_TRIAGE_SCHEMA = {
    "type": "object",
    "properties": {
        "private": {"type": "boolean"},
        "route": {"type": "string", "enum": ["local", "cloud"]},
    },
    "required": ["private", "route"],
}


TRIAGE_OPTIONS = {"temperature": 0, "num_predict": 40}


@dataclass
class Triage:
    private: bool
    route: str
    latency_s: float


def triage(message: str, model: str = GEMMA_MODEL) -> Triage:
    """Ask the local model whether a request is private and whether it can handle it."""
    t0 = time.perf_counter()
    resp = ollama.chat(
        model=model,
        messages=[
            {"role": "system", "content": TRIAGE_PROMPT},
            {"role": "user", "content": f"<request>\n{message[:4000]}\n</request>"},
        ],
        format=_TRIAGE_SCHEMA,
        options=TRIAGE_OPTIONS,
        think=False,
    )
    data = json.loads(resp.message.content)
    return Triage(bool(data["private"]), data["route"], time.perf_counter() - t0)


@dataclass
class Decision:
    target: str   # "local", "cloud" or "kimi"
    reason: str
    private: bool = False
    redacted: bool = False


def smart_route(message: str, mapping: dict[str, str] | None = None) -> Decision:
    """Redact secrets → keep personal topics local → route by intent. Costs no model call.

    `mapping` collects placeholders for secrets found in the message; callers must send
    the redacted text (privacy.redact with the same mapping) to any cloud model.
    """
    text, _ = redact(message, mapping)
    redacted = text != message
    if looks_personal(text):
        return Decision("local", "private: personal data", private=True)
    target = intent_route(text)
    reason = "simple request" if target == "local" else "complex request"
    if redacted and target == "cloud":
        reason += ", secrets redacted"
    return Decision(target, reason, redacted=redacted)
