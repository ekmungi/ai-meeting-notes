"""Tests for CloudEngine fragment merging logic.

The fragment merger buffers short incomplete segments and merges them
with the next complete segment to produce natural sentences.
"""

from __future__ import annotations

from meeting_notes.engines.base import TranscriptSegment
from meeting_notes.engines.cloud import CloudEngine


def make_engine() -> tuple[CloudEngine, list[TranscriptSegment]]:
    """Create a CloudEngine and capture emitted segments."""
    received: list[TranscriptSegment] = []
    engine = CloudEngine(api_key="test", sample_rate=16000)
    engine.on_transcript(lambda seg: received.append(seg))
    engine._session_start = 0.0  # Set for timestamp calculation
    return engine, received


class TestIsFragment:
    """Tests for the _is_fragment() heuristic."""

    def test_single_word_is_fragment(self):
        engine, _ = make_engine()
        assert engine._is_fragment("And.") is True
        assert engine._is_fragment("Right.") is True
        assert engine._is_fragment("Hi.") is True

    def test_two_words_is_fragment(self):
        engine, _ = make_engine()
        assert engine._is_fragment("People will.") is True
        assert engine._is_fragment("Ask not.") is True
        assert engine._is_fragment("Where sometimes.") is True

    def test_two_word_complete_phrases(self):
        engine, _ = make_engine()
        assert engine._is_fragment("Thank you.") is False
        assert engine._is_fragment("Sounds good.") is False
        assert engine._is_fragment("Got it.") is False

    def test_three_word_fragment_with_conjunction(self):
        engine, _ = make_engine()
        assert engine._is_fragment("And then what.") is True
        assert engine._is_fragment("But why not.") is True
        assert engine._is_fragment("Where is that.") is True

    def test_three_word_complete_sentence(self):
        engine, _ = make_engine()
        assert engine._is_fragment("I am fine.") is False
        assert engine._is_fragment("Let me try.") is False

    def test_longer_text_not_fragment(self):
        engine, _ = make_engine()
        assert engine._is_fragment("What your country can do for you.") is False
        assert engine._is_fragment("I'm trying to do a quick test.") is False

    def test_empty_text(self):
        engine, _ = make_engine()
        assert engine._is_fragment("") is True
        assert engine._is_fragment(".") is True


class TestHandleFinalSegment:
    """Tests for _handle_final_segment() fragment buffering and merging."""

    def test_complete_sentence_emitted_directly(self):
        engine, received = make_engine()
        engine._handle_final_segment(
            "What your country can do for you.", 5.0
        )
        assert len(received) == 1
        assert received[0].text == "What your country can do for you."
        assert received[0].is_partial is False

    def test_fragment_buffered_not_emitted(self):
        engine, received = make_engine()
        engine._handle_final_segment("And.", 1.0)
        assert len(received) == 0
        assert len(engine._fragment_buffer) == 1

    def test_fragment_merged_with_next_sentence(self):
        engine, received = make_engine()
        engine._handle_final_segment("Ask.", 1.0)
        engine._handle_final_segment("Not.", 2.0)
        engine._handle_final_segment(
            "What your country can do for you.", 3.0
        )
        assert len(received) == 1
        assert received[0].text == "Ask Not what your country can do for you."
        # Timestamp should start from the first fragment
        assert received[0].timestamp_start == 1.0

    def test_single_fragment_merged_with_continuation(self):
        engine, received = make_engine()
        engine._handle_final_segment("Where sometimes.", 1.0)
        engine._handle_final_segment(
            "People will pause and think.", 3.0
        )
        assert len(received) == 1
        assert received[0].text == "Where sometimes people will pause and think."

    def test_flush_emits_remaining_fragments(self):
        engine, received = make_engine()
        engine._handle_final_segment("And.", 1.0)
        engine._handle_final_segment("Right.", 2.0)
        engine._flush_fragment_buffer()
        assert len(received) == 1
        assert received[0].text == "And Right"

    def test_flush_empty_buffer_is_noop(self):
        engine, received = make_engine()
        engine._flush_fragment_buffer()
        assert len(received) == 0

    def test_consecutive_complete_sentences(self):
        engine, received = make_engine()
        engine._handle_final_segment(
            "I'm trying to do a quick test.", 1.0
        )
        engine._handle_final_segment(
            "How well does it work?", 5.0
        )
        assert len(received) == 2
        assert received[0].text == "I'm trying to do a quick test."
        assert received[1].text == "How well does it work?"

    def test_lowercase_continuation_after_merge(self):
        """When merging, the continuation's first letter should be lowercased."""
        engine, received = make_engine()
        engine._handle_final_segment("People will.", 1.0)
        engine._handle_final_segment(
            "Speak instead of waiting.", 3.0
        )
        assert len(received) == 1
        assert received[0].text == "People will speak instead of waiting."

    def test_acronym_not_lowercased(self):
        """Acronyms (uppercase start) should not be lowercased during merge."""
        engine, received = make_engine()
        engine._handle_final_segment("And then.", 1.0)
        engine._handle_final_segment(
            "AI will take over the world.", 3.0
        )
        assert len(received) == 1
        # "AI" starts with two uppercase letters — should not be lowercased
        assert received[0].text == "And then AI will take over the world."


class TestJFKSpeechScenario:
    """Simulate the JFK speech fragment pattern from real AssemblyAI output."""

    def test_jfk_fragments_merged(self):
        """Fragments like the 1408 test output should merge into coherent text."""
        engine, received = make_engine()

        # Simulating what the 1408 test produced with balanced endpointing:
        # "And so, my fellow Americans," — complete enough
        # "Ask." — fragment
        # "Not." — fragment
        # "What your country can do for you." — complete
        # "Ask what you can do for your country." — complete

        engine._handle_final_segment("And so, my fellow Americans,", 2.0)
        engine._handle_final_segment("Ask.", 4.0)
        engine._handle_final_segment("Not.", 5.0)
        engine._handle_final_segment(
            "What your country can do for you.", 8.0
        )
        engine._handle_final_segment(
            "Ask what you can do for your country.", 11.0
        )

        assert len(received) == 3
        assert received[0].text == "And so, my fellow Americans,"
        assert received[1].text == "Ask Not what your country can do for you."
        assert received[2].text == "Ask what you can do for your country."

    def test_user_speech_scenario(self):
        """Simulate the 1410 test output pattern."""
        engine, received = make_engine()

        # From 2026-02-16_1410:
        engine._handle_final_segment("Hi.", 7.0)
        long_text = (
            "I'm trying to do a quick test to understand"
            " what exactly is meeting transcription."
            " How well does it work?"
        )
        engine._handle_final_segment(long_text, 14.0)
        engine._handle_final_segment("Is it good enough?", 16.0)
        engine._handle_final_segment("That it can handle transcriptions.", 21.0)
        engine._handle_final_segment("Where sometimes.", 24.0)
        engine._handle_final_segment("People will pause.", 25.0)
        engine._handle_final_segment("And.", 26.0)
        engine._handle_final_segment("People will.", 29.0)
        engine._handle_final_segment(
            "Speak instead of waiting, instead of talking continuously as if I'm a robot.",
            35.0,
        )
        engine._handle_final_segment(
            "That is not going to happen.", 37.0
        )
        engine._handle_final_segment("Right.", 38.0)

        # Check that fragments got merged
        texts = [seg.text for seg in received]

        # "Hi" is a single-word fragment, merged with the long sentence
        assert any(
            "Hi" in t and "trying" in t for t in texts
        ), f"Expected 'Hi' merged with next: {texts}"

        # "Where sometimes" + "People will pause" should merge
        assert any(
            "Where sometimes" in t and "pause" in t for t in texts
        ), f"Expected merged: {texts}"

        # "And" + "People will" + "Speak..." should merge
        assert any(
            "and" in t.lower()
            and "people will" in t.lower()
            and "speak" in t.lower()
            for t in texts
        ), f"Expected merged: {texts}"

        # "Right" at the end should be flushed or merged with previous
        # Since "That is not going to happen." is a complete sentence,
        # "Right." is a trailing fragment that stays in the buffer


class TestEndpointingPresets:
    """Test that endpointing presets are properly configured."""

    def test_all_presets_exist(self):
        from meeting_notes.engines.cloud import ENDPOINTING_PRESETS

        assert "aggressive" in ENDPOINTING_PRESETS
        assert "balanced" in ENDPOINTING_PRESETS
        assert "conservative" in ENDPOINTING_PRESETS
        assert "very_conservative" in ENDPOINTING_PRESETS

    def test_preset_values_ordered(self):
        from meeting_notes.engines.cloud import ENDPOINTING_PRESETS

        presets = ["aggressive", "balanced", "conservative", "very_conservative"]
        for i in range(len(presets) - 1):
            a = ENDPOINTING_PRESETS[presets[i]]
            b = ENDPOINTING_PRESETS[presets[i + 1]]
            assert a["max_turn_silence"] < b["max_turn_silence"]
            assert (
                a["end_of_turn_confidence_threshold"]
                <= b["end_of_turn_confidence_threshold"]
            )

    def test_default_endpointing_is_conservative(self):
        engine = CloudEngine(api_key="test")
        assert engine._endpointing == "conservative"
