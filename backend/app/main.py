"""MockMaster FastAPI Backend — REST + WebSocket endpoints for ADK agents."""

import asyncio
import base64
import json
import os

from fastapi import FastAPI, Form, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from google.adk.agents import LiveRequestQueue
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from .config import settings
from .agents import scout_agent, interviewer_agent, auditor_agent

# ---------------------------------------------------------------------------
# Ensure the API key is available to the google-genai SDK
# ---------------------------------------------------------------------------
os.environ.setdefault("GOOGLE_API_KEY", settings.google_api_key)

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(title="MockMaster API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Shared session service
# ---------------------------------------------------------------------------
session_service = InMemorySessionService()

APP_NAME = "mockmaster"
USER_ID = "default_user"


# ===================================================================
# POST /api/analyze  —  Scout Agent (CV + JD analysis)
# ===================================================================
@app.post("/api/analyze")
async def analyze(
    cv_text: str = Form(...),
    jd: str = Form(...),
):
    """Send CV text + JD text to the Scout Agent and return its analysis."""
    runner = Runner(
        agent=scout_agent,
        app_name=APP_NAME,
        session_service=session_service,
    )

    session = await session_service.create_session(
        app_name=APP_NAME, user_id=USER_ID,
    )

    user_content = types.Content(
        role="user",
        parts=[
            types.Part(text=(
                f"Here is the Candidate's CV / Resume:\n\n{cv_text}\n\n"
                f"Here is the Job Description:\n\n{jd}\n\n"
                "Please analyse this CV against the JD."
            )),
        ],
    )

    result_text = ""
    async for event in runner.run_async(
        user_id=USER_ID,
        session_id=session.id,
        new_message=user_content,
    ):
        if event.content and event.content.parts:
            for part in event.content.parts:
                if part.text:
                    result_text += part.text

    return {"analysis": result_text}


# ===================================================================
# POST /api/evaluate  —  Auditor Agent (STAR feedback report)
# ===================================================================
@app.post("/api/evaluate")
async def evaluate(
    jd: str = Form(...),
    transcript: str = Form(...),
    cv_text: str = Form(""),
):
    """Send the interview transcript to the Auditor Agent for evaluation."""
    runner = Runner(
        agent=auditor_agent,
        app_name=APP_NAME,
        session_service=session_service,
    )

    session = await session_service.create_session(
        app_name=APP_NAME, user_id=USER_ID,
    )

    eval_prompt = (
        "The interview is now complete. Please evaluate the candidate's "
        "INTERVIEW PERFORMANCE based on the transcript below.\n\n"
        f"Job Description:\n{jd}\n\n"
        f"Candidate CV:\n{cv_text}\n\n" if cv_text else ""
        f"Interview Transcript:\n{transcript or '(No transcript available.)'}\n\n"
        "Format the output in clean Markdown."
    )

    user_content = types.Content(
        role="user",
        parts=[types.Part(text=eval_prompt)],
    )

    result_text = ""
    async for event in runner.run_async(
        user_id=USER_ID,
        session_id=session.id,
        new_message=user_content,
    ):
        if event.content and event.content.parts:
            for part in event.content.parts:
                if part.text:
                    result_text += part.text

    return {"report": result_text}


# ===================================================================
# WebSocket /api/live  —  Interviewer Agent (Live voice interview)
# ===================================================================
@app.websocket("/api/live")
async def live_interview(ws: WebSocket):
    """Bidirectional audio streaming via the Interviewer Agent.

    Protocol (JSON messages over WS):
    → Client sends: {"type": "audio", "data": "<base64 PCM16>"}
    → Client sends: {"type": "text",  "text": "..."}
    → Client sends: {"type": "setup", "jd": "...", "cv_text": "..."}
    → Client sends: {"type": "end"}
    ← Server sends: {"type": "audio", "data": "<base64 PCM16>"}
    ← Server sends: {"type": "transcript", "role": "model"|"user", "text": "..."}
    ← Server sends: {"type": "turn_complete"}
    """
    await ws.accept()

    # --- Wait for setup message with JD/CV context ---
    setup_raw = await ws.receive_text()
    setup = json.loads(setup_raw)
    jd_text = setup.get("jd", "")
    cv_text = setup.get("cv_text", "")

    # Prepend context to the interviewer's instruction
    contextual_instruction = (
        f"{interviewer_agent.instruction}\n\n"
        f"--- Job Description ---\n{jd_text}\n\n"
        f"--- Candidate CV ---\n{cv_text}\n"
    )

    # Create a session-scoped runner with contextualized instruction
    runner = Runner(
        agent=interviewer_agent,
        app_name=APP_NAME,
        session_service=session_service,
    )

    session = await session_service.create_session(
        app_name=APP_NAME, user_id=USER_ID,
    )

    live_queue = LiveRequestQueue()

    # --- Background task: forward ADK events → WebSocket client ---
    async def _stream_events():
        try:
            async for event in runner.run_live(
                session=session,
                live_request_queue=live_queue,
            ):
                if not event.content or not event.content.parts:
                    # Check for turn completion signals
                    if event.server_content and getattr(event.server_content, "turn_complete", False):
                        await ws.send_text(json.dumps({"type": "turn_complete"}))
                    continue

                for part in event.content.parts:
                    # Audio data
                    if part.inline_data and part.inline_data.data:
                        await ws.send_text(json.dumps({
                            "type": "audio",
                            "data": part.inline_data.data
                            if isinstance(part.inline_data.data, str)
                            else base64.b64encode(part.inline_data.data).decode(),
                        }))

                    # Model text / transcriptions
                    if part.text:
                        await ws.send_text(json.dumps({
                            "type": "transcript",
                            "role": event.content.role or "model",
                            "text": part.text,
                        }))

                # Also check for turn_complete on events with content
                if event.server_content and getattr(event.server_content, "turn_complete", False):
                    await ws.send_text(json.dumps({"type": "turn_complete"}))

        except WebSocketDisconnect:
            pass
        except Exception as exc:
            print(f"[live] stream error: {exc}")

    stream_task = asyncio.create_task(_stream_events())

    # Send the initial prompt so the interviewer starts speaking
    live_queue.send_content(
        types.Content(
            role="user",
            parts=[types.Part(text="Hello, I am ready for the interview.")],
        )
    )

    # --- Main receive loop: client → LiveRequestQueue ---
    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)

            if msg["type"] == "audio":
                # Realtime audio chunk from the user's microphone
                live_queue.send_realtime(
                    types.Blob(
                        data=msg["data"],
                        mime_type="audio/pcm;rate=16000",
                    )
                )

            elif msg["type"] == "text":
                # Text message from the user
                live_queue.send_content(
                    types.Content(
                        role="user",
                        parts=[types.Part(text=msg["text"])],
                    )
                )

            elif msg["type"] == "end":
                break

    except WebSocketDisconnect:
        pass
    finally:
        live_queue.close()
        stream_task.cancel()
        try:
            await stream_task
        except asyncio.CancelledError:
            pass


# ===================================================================
# Health check
# ===================================================================
@app.get("/api/health")
async def health():
    return {"status": "ok", "app": "MockMaster"}
