"""DPAPI-based encryption for sensitive settings on Windows.

Uses Windows Data Protection API (CryptProtectData / CryptUnprotectData)
via ctypes. The encryption is tied to the current Windows user profile --
only the same user on the same machine can decrypt.

On non-Windows platforms, values pass through unencrypted.
"""

from __future__ import annotations

import base64
import ctypes
import ctypes.wintypes
import logging
import platform

logger = logging.getLogger(__name__)

# Prefix that marks a value as DPAPI-encrypted base64
_ENC_PREFIX = "dpapi:"
_IS_WINDOWS = platform.system() == "Windows"


class _DataBlob(ctypes.Structure):
    """Win32 DATA_BLOB structure for CryptProtectData/CryptUnprotectData."""

    _fields_ = [
        ("cbData", ctypes.wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_char)),
    ]


def _dpapi_encrypt(plaintext: bytes) -> bytes:
    """Encrypt bytes using Windows DPAPI (CryptProtectData).

    Args:
        plaintext: Raw bytes to encrypt.

    Returns:
        Encrypted bytes that can only be decrypted by the same Windows user.

    Raises:
        OSError: If CryptProtectData fails.
    """
    blob_in = _DataBlob(len(plaintext), ctypes.create_string_buffer(plaintext, len(plaintext)))
    blob_out = _DataBlob()

    if not ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(blob_in),
        None,
        None,
        None,
        None,
        0,
        ctypes.byref(blob_out),
    ):
        raise OSError("CryptProtectData failed")

    encrypted = ctypes.string_at(blob_out.pbData, blob_out.cbData)
    ctypes.windll.kernel32.LocalFree(blob_out.pbData)
    return encrypted


def _dpapi_decrypt(ciphertext: bytes) -> bytes:
    """Decrypt bytes using Windows DPAPI (CryptUnprotectData).

    Args:
        ciphertext: Encrypted bytes previously produced by _dpapi_encrypt.

    Returns:
        Original plaintext bytes.

    Raises:
        OSError: If CryptUnprotectData fails (wrong user, corrupt data, etc.).
    """
    blob_in = _DataBlob(
        len(ciphertext), ctypes.create_string_buffer(ciphertext, len(ciphertext))
    )
    blob_out = _DataBlob()

    if not ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blob_in),
        None,
        None,
        None,
        None,
        0,
        ctypes.byref(blob_out),
    ):
        raise OSError("CryptUnprotectData failed")

    decrypted = ctypes.string_at(blob_out.pbData, blob_out.cbData)
    ctypes.windll.kernel32.LocalFree(blob_out.pbData)
    return decrypted


def encrypt_value(plaintext: str) -> str:
    """Encrypt a string using DPAPI. Returns dpapi:-prefixed base64 on Windows.

    On non-Windows platforms the value passes through unchanged (no-op).
    On encryption failure, falls back to returning the plaintext with a warning.

    Args:
        plaintext: The string to encrypt (e.g. an API key).

    Returns:
        On Windows: "dpapi:<base64-encoded-ciphertext>" string.
        On non-Windows or on failure: the original plaintext.
    """
    if not plaintext:
        return ""
    if not _IS_WINDOWS:
        return plaintext
    try:
        encrypted = _dpapi_encrypt(plaintext.encode("utf-8"))
        return _ENC_PREFIX + base64.b64encode(encrypted).decode("ascii")
    except OSError:
        logger.warning("DPAPI encryption failed -- storing plaintext")
        return plaintext


def decrypt_value(stored: str) -> str:
    """Decrypt a stored value. Handles dpapi:-prefixed and legacy plaintext.

    Plaintext values (no prefix) are returned as-is to support migration from
    old settings files that predate encryption.

    Args:
        stored: The value read from settings.json.

    Returns:
        The decrypted plaintext string, or "" on failure.
    """
    if not stored:
        return ""
    if not stored.startswith(_ENC_PREFIX):
        # Legacy plaintext -- pass through for auto-migration on next save
        return stored
    if not _IS_WINDOWS:
        logger.warning("Cannot decrypt DPAPI value on non-Windows platform")
        return ""
    try:
        ciphertext = base64.b64decode(stored[len(_ENC_PREFIX):])
        return _dpapi_decrypt(ciphertext).decode("utf-8")
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        logger.warning("DPAPI decryption failed: %s", exc)
        return ""
