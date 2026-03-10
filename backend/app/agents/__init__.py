"""MockMaster Agent Registry — Scout, Interviewer, Auditor."""

from .scout_agent import scout_agent
from .interviewer_agent import interviewer_agent
from .auditor_agent import auditor_agent

__all__ = ["scout_agent", "interviewer_agent", "auditor_agent"]
