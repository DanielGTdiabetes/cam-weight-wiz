import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.choose_kiosk_target import determine_target_url, main as choose_main


@pytest.mark.parametrize(
    "mode,expected",
    [
        ("kiosk", "http://localhost/"),
        ("offline", "http://localhost/offline"),
        ("ap", "http://localhost/ap"),
        ("unknown", "http://localhost/"),
        ("", "http://localhost/"),
    ],
)
def test_determine_target_url(mode: str, expected: str) -> None:
    assert determine_target_url({"effective_mode": mode}) == expected


def test_main_uses_mock_status(monkeypatch, capsys):
    payload = {"effective_mode": "offline"}
    monkeypatch.setenv("BASCULA_KIOSK_STATUS_JSON", json.dumps(payload))

    exit_code = choose_main()

    captured = capsys.readouterr()
    assert exit_code == 0
    assert captured.out.strip() == "ready|http://localhost/offline"
