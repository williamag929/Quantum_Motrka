"""Identify the machine a benchmark runs on: local-model results only compare within one machine."""

import json
import os
import platform
import re
import shutil
import socket
import subprocess
import urllib.request


def machine_id() -> str:
    """Stable folder name for this machine's results (override with BENCH_MACHINE)."""
    name = os.getenv("BENCH_MACHINE") or socket.gethostname()
    return re.sub(r"[^a-zA-Z0-9_-]+", "-", name).strip("-").lower() or "machine"


def _run(cmd: list[str]) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=15).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def _nvidia_gpus() -> list[dict]:
    if not shutil.which("nvidia-smi"):
        return []
    out = _run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
    gpus = []
    for line in out.splitlines():
        name, _, mem = line.rpartition(",")
        if name:
            gpus.append({"name": name.strip(), "vram_gb": round(float(mem) / 1024, 1)})
    return gpus


def _windows() -> dict:
    ps = (
        "$c=Get-CimInstance Win32_Processor|Select-Object -First 1;"
        "$m=(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory;"
        "$g=Get-CimInstance Win32_VideoController|Select-Object Name,AdapterRAM;"
        "@{cpu=$c.Name;cores=$c.NumberOfCores;ram=$m;gpus=@($g)}|ConvertTo-Json -Depth 3 -Compress"
    )
    try:
        data = json.loads(_run(["powershell", "-NoProfile", "-Command", ps]) or "{}")
    except ValueError:
        data = {}
    gpus = [
        {"name": g.get("Name", "").strip(), "vram_gb": round((g.get("AdapterRAM") or 0) / 2**30, 1)}
        for g in data.get("gpus") or []
        if g.get("Name") and "Remote Display" not in g.get("Name", "")
    ]
    return {
        "cpu": (data.get("cpu") or platform.processor()).strip(),
        "cores": data.get("cores"),
        "ram_gb": round((data.get("ram") or 0) / 2**30, 1),
        "gpus": gpus,
    }


def _linux() -> dict:
    cpu, cores, ram = platform.processor(), os.cpu_count(), 0.0
    try:
        info = open("/proc/cpuinfo", encoding="utf-8").read()
        cpu = re.search(r"model name\s*:\s*(.+)", info).group(1)
        cores = len(set(re.findall(r"core id\s*:\s*(\d+)", info))) or cores
        mem = open("/proc/meminfo", encoding="utf-8").read()
        ram = int(re.search(r"MemTotal:\s*(\d+)", mem).group(1)) / 2**20
    except (OSError, AttributeError):
        pass
    return {"cpu": cpu, "cores": cores, "ram_gb": round(ram, 1), "gpus": []}


def _ollama_offload(model: str) -> str | None:
    """How much of the loaded local model sits in GPU memory, as Ollama reports it."""
    host = os.getenv("OLLAMA_HOST", "http://localhost:11434")
    host = host if host.startswith("http") else f"http://{host}"
    try:
        with urllib.request.urlopen(f"{host}/api/ps", timeout=5) as resp:
            models = json.load(resp).get("models", [])
    except (OSError, ValueError):
        return None
    for m in models:
        if m.get("name") == model and m.get("size"):
            pct = 100 * (m.get("size_vram") or 0) / m["size"]
            return "CPU only" if pct < 1 else f"{pct:.0f}% on GPU"
    return None


def profile(local_model: str) -> dict:
    system = platform.system()
    info = _windows() if system == "Windows" else _linux()
    nvidia = _nvidia_gpus()
    if nvidia:  # Windows caps AdapterRAM at 4 GB; nvidia-smi is authoritative
        info["gpus"] = nvidia
    info.update({
        "machine": machine_id(),
        "os": f"{system} {platform.release()}",
        "local_model": local_model,
        "local_model_placement": _ollama_offload(local_model),
    })
    return info


def describe(p: dict) -> str:
    gpus = ", ".join(f"{g['name']} ({g['vram_gb']} GB)" for g in p.get("gpus") or []) or "none"
    placement = f", model placement: {p['local_model_placement']}" if p.get("local_model_placement") else ""
    return (f"`{p['machine']}` — {p['cpu']} ({p['cores']} cores), {p['ram_gb']} GB RAM, GPU: {gpus}, "
            f"{p['os']}{placement}")


if __name__ == "__main__":
    from config import GEMMA_MODEL  # noqa: E402  (run from dual_ai/: python -m bench.machine)
    p = profile(GEMMA_MODEL)
    print(json.dumps(p, indent=2))
    print(describe(p))
