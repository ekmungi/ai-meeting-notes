"""Internet connectivity checker."""

from __future__ import annotations

import logging
import time
import urllib.request

logger = logging.getLogger(__name__)

_CACHE_DURATION_S = 30.0
_last_check_time: float = 0.0
_last_check_result: bool = False


def check_connectivity(timeout: float = 3.0) -> bool:
    """Check if the internet is reachable by pinging a reliable endpoint.

    Uses Google's DNS and falls back to AssemblyAI. Results are cached for 30 seconds.
    """
    global _last_check_time, _last_check_result

    now = time.monotonic()
    if now - _last_check_time < _CACHE_DURATION_S:
        return _last_check_result

    # Try multiple endpoints — AssemblyAI's streaming endpoint may not respond to HEAD
    urls = [
        "https://www.google.com",
        "https://api.assemblyai.com",
    ]

    for url in urls:
        try:
            req = urllib.request.Request(url, method="HEAD")
            urllib.request.urlopen(req, timeout=timeout)
            _last_check_result = True
            _last_check_time = now
            return True
        except Exception:
            continue

    _last_check_result = False
    _last_check_time = now
    logger.debug("Connectivity check failed — no internet detected")
    return False
