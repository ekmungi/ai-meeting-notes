"""Tests for DPAPI-based API key encryption in Desktop UI settings."""

import platform

import pytest

from meeting_notes.ui.crypto import decrypt_value, encrypt_value

pytestmark = pytest.mark.skipif(
    platform.system() != "Windows",
    reason="DPAPI only available on Windows",
)

ENC_PREFIX = "dpapi:"


class TestEncryptValue:
    """Tests for encrypt_value()."""

    def test_encrypts_non_empty_string(self) -> None:
        """Non-empty string should return dpapi:-prefixed result."""
        result = encrypt_value("test-api-key-12345")
        assert result.startswith(ENC_PREFIX)
        assert result != ENC_PREFIX

    def test_empty_string_returns_empty(self) -> None:
        """Empty string should pass through unchanged."""
        assert encrypt_value("") == ""

    def test_different_inputs_produce_different_outputs(self) -> None:
        """Two different keys should not produce the same ciphertext."""
        a = encrypt_value("key-alpha")
        b = encrypt_value("key-beta")
        assert a != b


class TestDecryptValue:
    """Tests for decrypt_value()."""

    def test_round_trip(self) -> None:
        """Encrypt then decrypt should return the original value."""
        original = "sk-abc123-secret-key"
        encrypted = encrypt_value(original)
        decrypted = decrypt_value(encrypted)
        assert decrypted == original

    def test_plaintext_passthrough(self) -> None:
        """Legacy plaintext (no prefix) should pass through for migration."""
        assert decrypt_value("plain-old-key") == "plain-old-key"

    def test_empty_string_returns_empty(self) -> None:
        """Empty string should pass through unchanged."""
        assert decrypt_value("") == ""

    def test_corrupt_ciphertext_returns_empty(self) -> None:
        """Corrupted dpapi: value should return empty string, not crash."""
        result = decrypt_value("dpapi:not-valid-base64!!!")
        assert result == ""
