from pathlib import Path

import pytest

from backend.scale_service import HX711Service


def _make_service(tmp_path: Path, **overrides) -> HX711Service:
    persist_path = tmp_path / "scale_state.json"
    kwargs = {
        "dt_pin": 5,
        "sck_pin": 6,
        "calibration_factor": overrides.get("calibration_factor", 1.0),
        "calibration_offset": overrides.get("calibration_offset", 0.0),
        "calibration_scale": overrides.get("calibration_scale", 1.0),
        "sample_rate_hz": overrides.get("sample_rate_hz", 20.0),
        "filter_window": overrides.get("filter_window", 10),
        "median_window": overrides.get("median_window", 5),
        "ema_alpha": overrides.get("ema_alpha", 0.2),
        "hysteresis_grams": overrides.get("hysteresis_grams", 0.5),
        "debounce_ms": overrides.get("debounce_ms", 0),
        "variance_window": overrides.get("variance_window", 5),
        "variance_threshold": overrides.get("variance_threshold", 4.0),
        "reconnect_max_backoff": overrides.get("reconnect_max_backoff", 5.0),
        "watchdog_timeout": overrides.get("watchdog_timeout", 2.0),
        "persist_path": persist_path,
    }
    service = HX711Service(**kwargs)
    service._set_status(True, None)  # type: ignore[attr-defined]
    return service


def test_hx711_pipeline_filters_spikes(tmp_path):
    service = _make_service(
        tmp_path,
        hysteresis_grams=0.5,
        variance_window=5,
        variance_threshold=5.0,
    )
    baseline = 500.0
    samples = [
        baseline,
        baseline + 1.2,
        baseline - 0.8,
        baseline + 0.6,
        baseline - 1.1,
        baseline + 80.0,  # spike that should be rejected by median filter + variance gate
        baseline - 0.5,
        baseline + 0.3,
        baseline - 0.2,
        baseline,
        baseline + 0.1,
    ]

    for value in samples:
        service._record_sample(value)

    reading = service.get_reading()
    assert reading["ok"]
    assert reading["stable"]
    assert reading["grams"] is not None
    # Final value should remain close to the baseline despite the spike
    assert abs(reading["grams"] - baseline) < 2.0
    assert reading["variance"] is not None
    assert reading["variance"] < 5.0


def test_hx711_hysteresis_prevents_small_bounces(tmp_path):
    service = _make_service(
        tmp_path,
        hysteresis_grams=2.0,
        variance_window=5,
        variance_threshold=2.5,
    )

    for _ in range(5):
        service._record_sample(100.0)

    baseline = service.get_reading()
    assert baseline["ok"]
    assert baseline["stable"]
    assert baseline["grams"] == pytest.approx(100.0, abs=0.5)

    # Apply small oscillation (< hysteresis threshold) - published weight should remain unchanged
    for _ in range(6):
        service._record_sample(101.0)
        service._record_sample(99.5)

    after_small_bounce = service.get_reading()
    assert after_small_bounce["grams"] == pytest.approx(100.0, abs=0.5)

    # Apply a larger change (> hysteresis threshold) and ensure the weight updates
    for _ in range(6):
        service._record_sample(112.0)

    after_large_change = service.get_reading()
    assert after_large_change["ok"]
    assert after_large_change["stable"]
    assert after_large_change["grams"] == pytest.approx(112.0, abs=1.0)


def test_hx711_calibration_two_point_regression(tmp_path):
    service = _make_service(
        tmp_path,
        hysteresis_grams=0.05,
        variance_window=5,
        variance_threshold=0.05,
    )

    result = service.calibrate_from_points(
        [
            (1200.0, 120.0),
            (2400.0, 240.0),
            (3600.0, 360.0),
        ]
    )

    assert result["ok"]
    assert pytest.approx(service._calibration_scale, rel=1e-6) == 0.1  # type: ignore[attr-defined]
    assert pytest.approx(service._calibration_offset, abs=1e-6) == 0.0  # type: ignore[attr-defined]
    assert result["rmse"] < 1e-6

    target_weight = 300.0
    raw_value = target_weight / service._calibration_scale  # type: ignore[attr-defined]
    for _ in range(5):
        service._record_sample(raw_value)
    reading = service.get_reading()
    assert reading["ok"]
    assert reading["stable"]
    assert reading["grams"] == pytest.approx(target_weight, abs=0.5)
