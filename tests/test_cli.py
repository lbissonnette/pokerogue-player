from pokerogue_player.cli import build_config, load_dotenv, main  # noqa: F401
import argparse


def test_load_dotenv_does_not_override(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("# c\nOPENROUTER_API_KEY=from-file\nOPENROUTER_MODEL='a/b'\nEMPTY=\n")
    monkeypatch.setenv("OPENROUTER_API_KEY", "from-shell")
    monkeypatch.delenv("OPENROUTER_MODEL", raising=False)
    load_dotenv(env)
    import os
    assert os.environ["OPENROUTER_API_KEY"] == "from-shell"
    assert os.environ["OPENROUTER_MODEL"] == "a/b"
    assert "EMPTY" not in os.environ


def test_build_config_flags():
    ns = argparse.Namespace(url="https://pokerogue.net/", profile="p", headless=True, model="x/y",
                            model_for=["modifier=big/model"], reveal_hidden=True,
                            max_decisions=5, resume=True, starters="25,1", no_llm=True)
    cfg = build_config(ns)
    assert cfg.model == "x/y" and cfg.model_for("modifier") == "big/model" and cfg.model_for("command") == "x/y"
    assert cfg.reveal_hidden and cfg.title_choice == "continue" and cfg.starters == [25, 1] and not cfg.use_llm
    assert cfg.max_decisions == 5
