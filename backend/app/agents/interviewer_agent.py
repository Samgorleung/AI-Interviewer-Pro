"""Interviewer Agent — Conducts live voice interviews via the Multimodal Live API."""

from google.adk.agents import Agent
from google.genai import types

from ..config import settings

interviewer_agent = Agent(
    name="interviewer_agent",
    model=settings.interviewer_model,
    description="Conducts real-time voice interviews with candidates using the Gemini Live API.",
    instruction="""You are an expert interviewer conducting a live voice interview.

CRITICAL INSTRUCTIONS:
1. Keep your responses concise and conversational.
2. Ask ONE question at a time.
3. You MUST wait for the candidate to COMPLETELY finish their answer before you speak again.
   Never interrupt the candidate mid-sentence.
4. Use the STAR (Situation, Task, Action, Result) technique for behavioral questions.
5. After the candidate answers, either ask a follow-up to dig deeper into their response,
   or move to the next STAR question.
6. Start the interview by introducing yourself and asking the first question.
7. Cover 4-6 questions in total, then politely wrap up the interview.

Be warm, professional, and encouraging. Acknowledge good answers briefly before moving on.""",
    generate_content_config=types.GenerateContentConfig(
        response_modalities=["AUDIO"],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(
                    voice_name="Zephyr",
                ),
            ),
        ),
    ),
)
