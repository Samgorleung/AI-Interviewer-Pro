import React, { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { motion, AnimatePresence } from 'motion/react';
import {
  Briefcase,
  MessageSquare,
  FileText,
  Send,
  Download,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Play,
  User,
  Bot
} from 'lucide-react';

// --- Audio helpers ---
class AudioPlayer {
  context: AudioContext;
  nextTime: number;

  constructor(sampleRate = 24000) {
    this.context = new AudioContext({ sampleRate });
    this.nextTime = 0;
  }

  play(float32Array: Float32Array) {
    if (this.context.state === 'suspended') {
      this.context.resume();
    }
    const buffer = this.context.createBuffer(1, float32Array.length, this.context.sampleRate);
    buffer.getChannelData(0).set(float32Array);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);

    const currentTime = this.context.currentTime;
    if (this.nextTime < currentTime) {
      this.nextTime = currentTime;
    }
    source.start(this.nextTime);
    this.nextTime += buffer.duration;
  }

  stop() {
    this.context.close();
    this.context = new AudioContext({ sampleRate: 24000 });
    this.nextTime = 0;
  }
}

function encodePCM16(float32Array: Float32Array): string {
  const pcm16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    pcm16[i] = Math.max(-1, Math.min(1, float32Array[i])) * 0x7FFF;
  }
  const uint8 = new Uint8Array(pcm16.buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < uint8.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(uint8.subarray(i, i + chunkSize)));
  }
  return btoa(binary);
}

function decodePCM16(base64: string): Float32Array {
  const binary = atob(base64);
  const uint8 = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    uint8[i] = binary.charCodeAt(i);
  }
  const pcm16 = new Int16Array(uint8.buffer);
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    float32[i] = pcm16[i] / 0x7FFF;
  }
  return float32;
}

// --- Main Application ---
export default function App() {
  const [activeTab, setActiveTab] = useState<'setup' | 'interview' | 'evaluation'>('setup');

  // Setup State
  const [jobDescription, setJobDescription] = useState('');
  const [cvText, setCvText] = useState('');
  const [scoutAnalysis, setScoutAnalysis] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  // Interview State
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [isLiveActive, setIsLiveActive] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState<{ role: string, text: string }[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const audioPlayerRef = useRef<AudioPlayer | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  // Evaluation State
  const [evaluationReport, setEvaluationReport] = useState<string | null>(null);
  const [isEvalLoading, setIsEvalLoading] = useState(false);

  // --- Initialization ---
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [liveTranscript]);

  // --- Handlers ---

  // Call the Scout Agent via the backend /api/analyze endpoint
  const handleAnalyzeAndStart = async () => {
    if (!jobDescription || !cvText.trim()) {
      alert("Please provide both a Job Description and a Resume.");
      return;
    }

    setIsAnalyzing(true);
    try {
      const formData = new FormData();
      formData.append('cv_text', cvText);
      formData.append('jd', jobDescription);

      const res = await fetch('/api/analyze', { method: 'POST', body: formData });
      const data = await res.json();
      setScoutAnalysis(data.analysis);
      setActiveTab('interview');
    } catch (error) {
      console.error("Analysis failed:", error);
      alert("Failed to analyze CV. Make sure the backend is running.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Connect to the ADK backend's Live API WebSocket
  const startLiveInterview = async () => {
    if (!jobDescription) {
      alert("Please provide a Job Description first.");
      return;
    }

    setIsChatLoading(true);
    setLiveTranscript([]);

    try {
      audioPlayerRef.current = new AudioPlayer(24000);

      // Build WebSocket URL (works with Vite proxy)
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/api/live`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("WebSocket connected to backend");

        // Send setup message with JD and CV context
        ws.send(JSON.stringify({
          type: 'setup',
          jd: jobDescription,
          cv_text: scoutAnalysis || cvText || '',
        }));

        setIsLiveActive(true);
        setIsChatLoading(false);

        // Start capturing microphone audio
        navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: 16000,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
          }
        }).then(stream => {
          mediaStreamRef.current = stream;
          audioContextRef.current = new AudioContext({ sampleRate: 16000 });
          const source = audioContextRef.current.createMediaStreamSource(stream);
          const processor = audioContextRef.current.createScriptProcessor(4096, 1, 1);
          processorRef.current = processor;

          processor.onaudioprocess = (e) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            const inputData = e.inputBuffer.getChannelData(0);
            const base64Data = encodePCM16(inputData);
            ws.send(JSON.stringify({ type: 'audio', data: base64Data }));
          };

          source.connect(processor);
          processor.connect(audioContextRef.current.destination);
        }).catch(err => {
          console.error("Microphone error:", err);
          alert("Failed to access microphone.");
          stopLiveInterview();
        });
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'audio' && audioPlayerRef.current) {
          const float32 = decodePCM16(msg.data);
          audioPlayerRef.current.play(float32);
        }

        if (msg.type === 'transcript') {
          const role = msg.role === 'user' ? 'user' : 'model';
          setLiveTranscript(prev => {
            const last = prev[prev.length - 1];
            if (last && last.role === role) {
              return [...prev.slice(0, -1), { role, text: last.text + msg.text }];
            }
            return [...prev, { role, text: msg.text }];
          });
        }

        if (msg.type === 'turn_complete' && audioPlayerRef.current) {
          // Model finished its turn — ready for user to speak
        }
      };

      ws.onclose = () => {
        console.log("WebSocket closed");
        stopLiveInterview();
      };

      ws.onerror = (error) => {
        console.error("WebSocket error:", error);
        setIsChatLoading(false);
      };

    } catch (error) {
      console.error(error);
      setIsChatLoading(false);
      alert("Failed to start live interview.");
    }
  };

  const stopLiveInterview = () => {
    setIsLiveActive(false);
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (audioPlayerRef.current) {
      audioPlayerRef.current.stop();
      audioPlayerRef.current = null;
    }
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'end' }));
      }
      wsRef.current.close();
      wsRef.current = null;
    }
  };

  // Call the Auditor Agent via the backend /api/evaluate endpoint
  const finishInterview = async () => {
    stopLiveInterview();
    setActiveTab('evaluation');
    setIsEvalLoading(true);

    const transcriptText = liveTranscript
      .map(t => `${t.role === 'model' ? 'Interviewer' : 'Candidate'}: ${t.text}`)
      .join('\n');

    try {
      const formData = new FormData();
      formData.append('jd', jobDescription);
      formData.append('transcript', transcriptText || '(No transcript available.)');
      formData.append('cv_text', cvText);

      const res = await fetch('/api/evaluate', { method: 'POST', body: formData });
      const data = await res.json();
      setEvaluationReport(data.report || "No report generated.");
    } catch (error) {
      console.error("Error generating evaluation:", error);
      setEvaluationReport("Failed to generate evaluation report. Make sure the backend is running.");
    } finally {
      setIsEvalLoading(false);
    }
  };

  const downloadPDF = async () => {
    const element = document.getElementById('report-content');
    if (!element) return;

    try {
      const canvas = await html2canvas(element, { scale: 2 });
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (canvas.height * pdfWidth) / canvas.width;

      pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
      pdf.save('MockMaster_Report.pdf');
    } catch (error) {
      console.error("Error generating PDF:", error);
      alert("Failed to generate PDF.");
    }
  };

  // --- Renderers ---
  return (
    <div className="flex h-screen bg-zinc-50 font-sans text-zinc-900 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-zinc-200 flex flex-col">
        <div className="p-6 border-b border-zinc-100">
          <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
            <Bot className="w-6 h-6 text-blue-600" />
            MockMaster
          </h1>
          <p className="text-xs text-zinc-400 mt-1">Powered by Google ADK</p>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          <button
            onClick={() => setActiveTab('setup')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-colors ${activeTab === 'setup' ? 'bg-blue-50 text-blue-700' : 'text-zinc-600 hover:bg-zinc-100'
              }`}
          >
            <Briefcase className="w-5 h-5" />
            Setup Interview
          </button>
          <button
            onClick={() => setActiveTab('interview')}
            disabled={!jobDescription || !cvText.trim()}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-colors ${activeTab === 'interview' ? 'bg-blue-50 text-blue-700' : 'text-zinc-600 hover:bg-zinc-100'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            <MessageSquare className="w-5 h-5" />
            Live Interview
          </button>
          <button
            onClick={() => setActiveTab('evaluation')}
            disabled={!evaluationReport && !isEvalLoading}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-colors ${activeTab === 'evaluation' ? 'bg-blue-50 text-blue-700' : 'text-zinc-600 hover:bg-zinc-100'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            <FileText className="w-5 h-5" />
            Evaluation Report
          </button>
        </nav>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">
          {activeTab === 'setup' && (
            <motion.div
              key="setup"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="max-w-3xl mx-auto p-8 lg:p-12"
            >
              <div className="mb-8">
                <h2 className="text-3xl font-semibold tracking-tight mb-2">Setup Interview</h2>
                <p className="text-zinc-500">Provide the job description and candidate CV to begin the AI interview.</p>
              </div>

              <div className="space-y-6">
                <div className="bg-white p-6 rounded-2xl shadow-sm border border-zinc-200">
                  <label className="block text-sm font-medium text-zinc-700 mb-2">
                    Job Description
                  </label>
                  <textarea
                    value={jobDescription}
                    onChange={(e) => setJobDescription(e.target.value)}
                    placeholder="Paste the full job description here..."
                    className="w-full h-48 p-4 bg-zinc-50 border border-zinc-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none outline-none transition-all"
                  />
                </div>

                <div className="bg-white p-6 rounded-2xl shadow-sm border border-zinc-200">
                  <label className="block text-sm font-medium text-zinc-700 mb-2">
                    Candidate Resume / CV
                  </label>
                  <textarea
                    value={cvText}
                    onChange={(e) => setCvText(e.target.value)}
                    placeholder="Paste the candidate's resume or CV text here..."
                    className="w-full h-48 p-4 bg-zinc-50 border border-zinc-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none outline-none transition-all"
                  />
                </div>

                <div className="pt-4">
                  <button
                    onClick={handleAnalyzeAndStart}
                    disabled={!jobDescription || !cvText.trim() || isAnalyzing}
                    className="w-full flex items-center justify-center gap-2 py-4 px-6 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                  >
                    {isAnalyzing ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        Scout Agent Analyzing...
                      </>
                    ) : (
                      <>
                        <Play className="w-5 h-5" />
                        Start Interview
                      </>
                    )}
                  </button>
                </div>

                {scoutAnalysis && (
                  <div className="bg-white p-6 rounded-2xl shadow-sm border border-zinc-200 mt-4">
                    <h3 className="text-sm font-medium text-zinc-700 mb-3">Scout Agent Analysis</h3>
                    <div className="prose prose-zinc prose-sm max-w-none">
                      <ReactMarkdown>{scoutAnalysis}</ReactMarkdown>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          )}

          {activeTab === 'interview' && (
            <motion.div
              key="interview"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col h-full max-w-4xl mx-auto items-center justify-center"
            >
              <div className="p-6 border-b border-zinc-200 bg-white/80 backdrop-blur-md sticky top-0 z-10 flex justify-between items-center w-full">
                <div>
                  <h2 className="text-xl font-semibold">Live Voice Interview</h2>
                  <p className="text-sm text-zinc-500">Speak directly with the AI interviewer</p>
                </div>
                <button
                  onClick={finishInterview}
                  className="px-4 py-2 bg-zinc-900 text-white text-sm font-medium rounded-lg hover:bg-zinc-800 transition-colors"
                >
                  Finish & Evaluate
                </button>
              </div>

              <div className="flex-1 flex flex-col items-center justify-center w-full p-6">
                {isChatLoading ? (
                  <div className="flex flex-col items-center gap-4">
                    <Loader2 className="w-12 h-12 animate-spin text-blue-600" />
                    <p className="text-zinc-600 font-medium">Connecting to MockMaster backend...</p>
                  </div>
                ) : isLiveActive ? (
                  <div className="flex flex-col items-center gap-8">
                    <div className="relative">
                      <div className="w-32 h-32 bg-blue-100 rounded-full flex items-center justify-center animate-pulse">
                        <Bot className="w-16 h-16 text-blue-600" />
                      </div>
                      <div className="absolute inset-0 border-4 border-blue-500 rounded-full animate-ping opacity-20"></div>
                    </div>
                    <div className="text-center w-full max-w-2xl">
                      <h3 className="text-2xl font-semibold text-zinc-900 mb-2">Interview in Progress</h3>
                      <p className="text-zinc-500 mb-8">Listening to your microphone...</p>

                      <div ref={transcriptRef} className="bg-white/50 backdrop-blur-sm border border-zinc-200 rounded-2xl p-6 h-64 overflow-y-auto flex flex-col gap-4 text-left shadow-inner">
                        {liveTranscript.length === 0 ? (
                          <p className="text-zinc-400 text-center italic mt-auto mb-auto">Transcript will appear here...</p>
                        ) : (
                          liveTranscript.map((msg, idx) => (
                            <div key={idx} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                              <span className={`text-xs font-medium mb-1 ${msg.role === 'user' ? 'text-blue-600' : 'text-emerald-600'}`}>
                                {msg.role === 'user' ? 'You' : 'Interviewer'}
                              </span>
                              <div className={`px-4 py-2 rounded-2xl max-w-[85%] ${msg.role === 'user'
                                ? 'bg-blue-600 text-white rounded-br-sm'
                                : 'bg-zinc-100 text-zinc-800 rounded-bl-sm'
                                }`}>
                                <p className="text-sm leading-relaxed">{msg.text}</p>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                    <button
                      onClick={finishInterview}
                      className="px-8 py-4 bg-rose-600 text-white rounded-xl hover:bg-rose-700 transition-colors font-medium shadow-sm flex items-center gap-2"
                    >
                      End Interview
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-6 text-center max-w-md">
                    <div className="w-20 h-20 bg-zinc-100 rounded-full flex items-center justify-center">
                      <Bot className="w-10 h-10 text-zinc-400" />
                    </div>
                    <div>
                      <h3 className="text-xl font-semibold text-zinc-900 mb-2">Ready to Start?</h3>
                      <p className="text-zinc-500 mb-6">Make sure your microphone is connected. The AI will introduce itself and begin asking questions.</p>
                      <button
                        onClick={startLiveInterview}
                        className="w-full py-4 px-6 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors font-medium shadow-sm flex items-center justify-center gap-2"
                      >
                        <Play className="w-5 h-5" />
                        Start Voice Interview
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          )}

          {activeTab === 'evaluation' && (
            <motion.div
              key="evaluation"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="max-w-4xl mx-auto p-8 lg:p-12"
            >
              <div className="flex justify-between items-center mb-8">
                <div>
                  <h2 className="text-3xl font-semibold tracking-tight mb-2">Evaluation Report</h2>
                  <p className="text-zinc-500">Comprehensive STAR feedback based on your interview.</p>
                </div>
                {evaluationReport && (
                  <button
                    onClick={downloadPDF}
                    className="flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white rounded-lg hover:bg-zinc-800 transition-colors text-sm font-medium"
                  >
                    <Download className="w-4 h-4" />
                    Download PDF
                  </button>
                )}
              </div>

              {isEvalLoading ? (
                <div className="flex flex-col items-center justify-center py-20 bg-white rounded-2xl border border-zinc-200 shadow-sm">
                  <Loader2 className="w-10 h-10 animate-spin text-blue-600 mb-4" />
                  <p className="text-zinc-600 font-medium">Auditor Agent analyzing interview...</p>
                </div>
              ) : evaluationReport ? (
                <div
                  id="report-content"
                  className="bg-white p-8 md:p-12 rounded-2xl shadow-sm border border-zinc-200 prose prose-zinc max-w-none"
                >
                  <ReactMarkdown>{evaluationReport}</ReactMarkdown>
                </div>
              ) : (
                <div className="text-center py-20 bg-zinc-100 rounded-2xl border border-zinc-200 border-dashed">
                  <p className="text-zinc-500">No evaluation report available yet. Complete an interview first.</p>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
