"""Tests for floating recording indicator (desktop)."""

from unittest.mock import MagicMock

from meeting_notes.ui.floating_indicator import (
    FloatingIndicator,
    calculate_position,
    build_indicator_html,
    PANEL_WIDTH,
    PANEL_HEIGHT,
    EDGE_MARGIN,
)


class TestCalculatePosition:
    """Test screen position calculation for the floating indicator."""

    def test_top_right(self):
        """Top-right places panel near top-right corner with margin."""
        x, y = calculate_position("top-right", 1920, 1080)
        assert x == 1920 - PANEL_WIDTH - EDGE_MARGIN
        assert y == EDGE_MARGIN

    def test_center_right(self):
        """Center-right places panel vertically centered on right edge."""
        x, y = calculate_position("center-right", 1920, 1080)
        assert x == 1920 - PANEL_WIDTH - EDGE_MARGIN
        assert y == (1080 - PANEL_HEIGHT) // 2

    def test_bottom_left(self):
        """Bottom-left places panel near bottom-left corner with margin."""
        x, y = calculate_position("bottom-left", 1920, 1080)
        assert x == EDGE_MARGIN
        assert y == 1080 - PANEL_HEIGHT - EDGE_MARGIN

    def test_unknown_defaults_to_top_right(self):
        """Unknown position string falls back to top-right."""
        x, y = calculate_position("invalid", 1920, 1080)
        expected_x, expected_y = calculate_position("top-right", 1920, 1080)
        assert x == expected_x
        assert y == expected_y


class TestBuildIndicatorHtml:
    """Test the HTML template for the floating panel."""

    def test_contains_stop_button(self):
        """HTML includes a stop button with expected class."""
        html = build_indicator_html()
        assert "Stop" in html
        assert "mn-float-stop" in html

    def test_contains_nav_button(self):
        """HTML includes a transcript navigation button."""
        html = build_indicator_html()
        assert "Transcript" in html
        assert "mn-float-nav" in html


class TestFloatingIndicatorLifecycle:
    """Test the show/hide state machine."""

    def test_initial_state_is_hidden(self):
        """New indicator starts hidden."""
        fi = FloatingIndicator(main_window=MagicMock(), on_stop=lambda: None)
        assert not fi.is_visible

    def test_show_sets_visible(self):
        """show() marks indicator as visible."""
        fi = FloatingIndicator(main_window=MagicMock(), on_stop=lambda: None)
        fi._create_window = MagicMock()
        fi.show()
        assert fi.is_visible

    def test_hide_after_show(self):
        """hide() after show() returns to not visible."""
        fi = FloatingIndicator(main_window=MagicMock(), on_stop=lambda: None)
        fi._create_window = MagicMock()
        fi._destroy_window = MagicMock()
        fi.show()
        fi.hide()
        assert not fi.is_visible

    def test_show_when_already_visible_is_noop(self):
        """Calling show() twice only creates window once."""
        fi = FloatingIndicator(main_window=MagicMock(), on_stop=lambda: None)
        fi._create_window = MagicMock()
        fi.show()
        fi.show()
        assert fi._create_window.call_count == 1

    def test_hide_when_not_visible_is_noop(self):
        """Calling hide() when not visible does not call destroy."""
        fi = FloatingIndicator(main_window=MagicMock(), on_stop=lambda: None)
        fi._destroy_window = MagicMock()
        fi.hide()
        fi._destroy_window.assert_not_called()


class TestFloatingIndicatorMonitoring:
    """Test focus monitoring lifecycle."""

    def test_start_monitoring_creates_poll_thread(self):
        """start_monitoring() creates a background polling thread."""
        fi = FloatingIndicator(main_window=MagicMock(), on_stop=lambda: None)
        fi._get_main_hwnd = MagicMock(return_value=12345)
        fi._create_window = MagicMock()
        fi.start_monitoring("top-right")
        assert fi._poll_thread is not None
        assert fi._poll_thread.is_alive()
        fi.stop_monitoring()

    def test_stop_monitoring_cleans_up(self):
        """stop_monitoring() stops the thread and hides the indicator."""
        fi = FloatingIndicator(main_window=MagicMock(), on_stop=lambda: None)
        fi._get_main_hwnd = MagicMock(return_value=12345)
        fi._create_window = MagicMock()
        fi._destroy_window = MagicMock()
        fi.start_monitoring("center-right")
        fi.stop_monitoring()
        assert not fi._polling
        assert not fi.is_visible

    def test_stop_monitoring_when_not_monitoring_is_safe(self):
        """stop_monitoring() when not active does not raise."""
        fi = FloatingIndicator(main_window=MagicMock(), on_stop=lambda: None)
        fi.stop_monitoring()

    def test_on_stop_and_hide_calls_callback(self):
        """_on_stop_and_hide triggers the on_stop callback."""
        stop_called = []
        fi = FloatingIndicator(
            main_window=MagicMock(),
            on_stop=lambda: stop_called.append(True),
        )
        fi._destroy_window = MagicMock()
        fi._on_stop_and_hide()
        assert len(stop_called) == 1
