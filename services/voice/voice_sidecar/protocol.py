"""Python mirror of main/voice/protocol.ts; contract changes belong to integration."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

IdentityString = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class Identity(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    sessionId: IdentityString
    turnId: IdentityString
    generation: int = Field(ge=0, le=9007199254740991)

    def identity(self):
        return {key: getattr(self, key) for key in Identity.model_fields}


class Offer(Identity):
    sdp: str = Field(min_length=1, max_length=100_000)
    type: Literal["offer"]
    keywords: list[Annotated[str, StringConstraints(min_length=1, max_length=100)]] = Field(
        default_factory=list, max_length=100
    )


class Speak(Identity):
    speechId: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=1, max_length=4000)


class Poll(Identity):
    afterSequence: int = Field(ge=0, le=9007199254740991)


class Answer(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    sdp: str = Field(min_length=1, max_length=100_000)
    type: Literal["answer"]


class Transcript(Identity):
    sequence: int = Field(gt=0)
    kind: Literal["transcript"]
    text: str = Field(max_length=32000)
    final: bool


class SpeechEvent(Identity):
    sequence: int = Field(gt=0)
    kind: Literal["speech-started", "speech-ended"]
    speechId: str


class Diagnostic(BaseModel):
    """Mirror of shared/contracts/voice-diagnostics.ts; no free-form provider data."""
    model_config = ConfigDict(extra="forbid", strict=True)
    stage: Literal["microphone", "media", "setup", "meta", "elevenlabs"]
    code: Literal["denied", "not-found", "busy", "auth", "access", "rate-limit",
                  "unavailable", "network", "timeout", "protocol", "tls", "invalid-response", "failed"]
    httpStatus: int | None = Field(default=None, ge=100, le=599)
    closeCode: int | None = Field(default=None, ge=1000, le=4999)


class ErrorEvent(Identity):
    sequence: int = Field(gt=0)
    kind: Literal["error"]
    message: str = Field(max_length=500)
    diagnostic: Diagnostic | None = None


Event = Annotated[Transcript | SpeechEvent | ErrorEvent, Field(discriminator="kind")]


class PollResult(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    events: list[Event] = Field(max_length=100)
