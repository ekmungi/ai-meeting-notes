"""Audio device enumeration and selection."""

from __future__ import annotations

from dataclasses import dataclass

import pyaudiowpatch as pyaudio


@dataclass
class AudioDevice:
    index: int
    name: str
    max_input_channels: int
    default_sample_rate: float
    is_loopback: bool = False

    def __str__(self) -> str:
        kind = "LOOPBACK" if self.is_loopback else "INPUT"
        return f"[{self.index}] ({kind}) {self.name} @ {int(self.default_sample_rate)}Hz"


def list_devices() -> list[AudioDevice]:
    """List all available input and loopback audio devices."""
    p = pyaudio.PyAudio()
    devices = []

    try:
        for i in range(p.get_device_count()):
            info = p.get_device_info_by_index(i)
            # Only include devices with input channels or loopback devices
            is_loopback = bool(info.get("isLoopbackDevice", False))
            has_input = info.get("maxInputChannels", 0) > 0

            if has_input or is_loopback:
                devices.append(
                    AudioDevice(
                        index=i,
                        name=info["name"],
                        max_input_channels=info["maxInputChannels"],
                        default_sample_rate=info["defaultSampleRate"],
                        is_loopback=is_loopback,
                    )
                )
    finally:
        p.terminate()

    return devices


def find_loopback_device() -> AudioDevice | None:
    """Find the default WASAPI loopback device (system audio capture)."""
    p = pyaudio.PyAudio()

    try:
        # Get WASAPI host API info
        wasapi_info = p.get_host_api_info_by_type(pyaudio.paWASAPI)
        default_output_idx = wasapi_info["defaultOutputDevice"]
        default_output = p.get_device_info_by_index(default_output_idx)
        output_name_prefix = default_output["name"][:30]

        # Find the loopback counterpart of the default output device
        for i in range(p.get_device_count()):
            info = p.get_device_info_by_index(i)
            if info.get("isLoopbackDevice") and info["name"].startswith(output_name_prefix):
                return AudioDevice(
                    index=i,
                    name=info["name"],
                    max_input_channels=info["maxInputChannels"],
                    default_sample_rate=info["defaultSampleRate"],
                    is_loopback=True,
                )
    finally:
        p.terminate()

    return None


def find_default_mic() -> AudioDevice | None:
    """Find the default microphone input device."""
    p = pyaudio.PyAudio()

    try:
        wasapi_info = p.get_host_api_info_by_type(pyaudio.paWASAPI)
        default_input_idx = wasapi_info["defaultInputDevice"]
        info = p.get_device_info_by_index(default_input_idx)

        if info["maxInputChannels"] > 0:
            return AudioDevice(
                index=default_input_idx,
                name=info["name"],
                max_input_channels=info["maxInputChannels"],
                default_sample_rate=info["defaultSampleRate"],
                is_loopback=False,
            )
    finally:
        p.terminate()

    return None
