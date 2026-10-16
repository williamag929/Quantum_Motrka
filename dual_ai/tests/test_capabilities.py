import json

import pytest

import capabilities as cap
from router import Decision
from session import system_prompt


@pytest.fixture(autouse=True)
def fresh(monkeypatch, tmp_path):
    """No cache between tests; Ollama is unreachable unless a test says otherwise.

    Settings point at an empty temp dir so the real ~/.motkra/settings.json never leaks in.
    """
    cap._cache = None
    monkeypatch.setattr(cap, "MOTKRA_DIR", tmp_path)
    monkeypatch.setattr(cap, "SETTINGS", tmp_path / "settings.json")
    monkeypatch.setattr(cap, "_ollama_models", lambda timeout=1.0: None)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("NVIDIA_API_KEY", raising=False)
    yield
    cap._cache = None


def test_nothing_configured_reports_what_each_lane_needs():
    reg = cap.registry()
    assert cap.ready_lanes(reg) == []
    assert reg["lanes"]["local"]["available"] is False
    assert reg["lanes"]["local"]["needs"] == "start Ollama"
    assert reg["lanes"]["cloud"]["needs"] == "add an Anthropic API key in Settings"
    line = cap.prompt_line(reg)
    assert "not usable yet" in line and "start Ollama" in line


def test_cloud_lane_ready_with_api_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    reg = cap.registry()
    assert cap.ready_lanes(reg) == ["cloud"]
    assert "lanes ready: cloud" in cap.prompt_line(reg)


def test_kimi_lane_ready_with_nvidia_key(monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "nvapi-test")
    reg = cap.registry()
    assert cap.ready_lanes(reg) == ["kimi"]


def test_local_lane_when_ollama_serves_the_model(monkeypatch):
    monkeypatch.setattr(cap, "_ollama_models", lambda timeout=1.0: ["gemma4:e2b", "qwen3:4b"])
    reg = cap.registry()
    assert reg["lanes"]["local"]["available"] is True
    assert reg["lanes"]["local"]["model_present"] is True
    assert reg["lanes"]["local"]["models"] == ["gemma4:e2b", "qwen3:4b"]


def test_local_model_missing_from_ollama_is_flagged(monkeypatch):
    monkeypatch.setattr(cap, "_ollama_models", lambda timeout=1.0: ["qwen3:4b"])
    reg = cap.registry()
    assert reg["lanes"]["local"]["available"] is True
    assert reg["lanes"]["local"]["model_present"] is False


def test_lane_disabled_in_daemon_settings_is_reported(monkeypatch, tmp_path):
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({"providers": {"claude": False}}))
    monkeypatch.setattr(cap, "SETTINGS", settings)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    reg = cap.registry()
    assert cap.ready_lanes(reg) == []  # configured but turned off
    assert "turned off by the user: cloud" in cap.prompt_line(reg)


def test_registry_is_cached_within_ttl(monkeypatch):
    calls = []
    monkeypatch.setattr(cap, "_ollama_models", lambda timeout=1.0: calls.append(1) or [])
    cap.registry(now=100.0)
    cap.registry(now=100.0 + cap._TTL - 1)
    cap.registry(now=100.0 + cap._TTL + 1)
    assert len(calls) == 2


def test_cloud_prompt_carries_the_live_capability_line(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    prompt = system_prompt(Decision("cloud", "complex request"), [{"role": "user", "content": "hi"}], {})
    assert "You are Motkra" in prompt
    assert "Right now on this machine" in prompt
    assert "lanes ready: cloud" in prompt


def test_local_and_personal_prompts_stay_static(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    local = system_prompt(Decision("local", "simple request"), [{"role": "user", "content": "hi"}], {})
    personal = system_prompt(Decision("local", "private: personal data", private=True),
                             [{"role": "user", "content": "hi"}], {})
    assert "You are Motkra" in local
    assert "Right now on this machine" not in local      # CPU latency: no live line locally
    assert "Right now on this machine" not in personal
