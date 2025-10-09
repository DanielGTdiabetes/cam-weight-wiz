import sys
import time
from pathlib import Path

import pytest
import tkinter as tk

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from bascula.state import AppState
from bascula.ui.widgets import TimerController


def test_timer_controller_counts_down_to_zero() -> None:
    try:
        root = tk.Tk()
    except tk.TclError as exc:  # pragma: no cover - depends on CI environment
        pytest.skip(f"Tk no disponible: {exc}")
    else:
        root.withdraw()

    state = AppState()
    controller = TimerController(root, state)

    controller.start(3)

    deadline = time.time() + 4.5
    while time.time() < deadline:
        root.update()
        time.sleep(0.1)

    remaining = state.get_timer_state().remaining_seconds
    controller.cancel()
    root.destroy()

    assert remaining == 0
