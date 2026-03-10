"""Configuration loader — reads from root .env file."""

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# Load .env from the project root (one level above /backend)
_env_path = Path(__file__).resolve().parents[2] / ".env"
load_dotenv(_env_path)


@dataclass(frozen=True)
class Settings:
    """Application-wide settings loaded once at import time."""

    google_api_key: str = os.getenv("GOOGLE_API_KEY", "")
    project_id: str = os.getenv("PROJECT_ID", "")
    location: str = os.getenv("LOCATION", "us-central1")

    # Model IDs
    scout_model: str = "gemini-3.1-pro-preview"
    interviewer_model: str = "gemini-live-2.5-flash"
    auditor_model: str = "gemini-3.1-flash-lite-preview"


settings = Settings()
