"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Browser voice I/O.
 *  - Speech-to-text: Web Speech API (SpeechRecognition). In Chrome/Edge the audio is processed by the
 *    browser vendor's speech service, not by this app; we never record, upload or store audio.
 *  - Text-to-speech: speechSynthesis (local voices).
 * Both are optional: unsupported browsers simply hide the controls.
 */

interface RecognitionResultItem { transcript: string }
interface RecognitionResult { isFinal: boolean; 0: RecognitionResultItem }
interface RecognitionEvent { resultIndex: number; results: ArrayLike<RecognitionResult> }
interface Recognition {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
type RecognitionCtor = new () => Recognition;

const LANG = "en-IN";

const ERRORS: Record<string, string> = {
  "not-allowed": "Microphone access was blocked. Allow the microphone for this site in your browser settings, then try again.",
  "service-not-allowed": "Speech recognition is not allowed in this browser or context.",
  "no-speech": "I didn't hear anything. Tap the mic and try again.",
  "audio-capture": "No microphone was found.",
  network: "Speech recognition needs an internet connection.",
};

/** Make an answer pleasant to hear: "₹8,680" → "8,680 rupees", drop symbols and arrows. */
export function toSpeakable(text: string): string {
  return text
    .replace(/₹\s?([\d,]+)/g, "$1 rupees")
    .replace(/→/g, " to ")
    .replace(/[•·|]/g, ", ")
    .replace(/\bpp\b/g, "per person")
    .replace(/\s+/g, " ")
    .trim();
}

export function useVoice(onError: (message: string) => void) {
  const [sttSupported, setSttSupported] = useState(false);
  const [ttsSupported, setTtsSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const recRef = useRef<Recognition | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
    setSttSupported(Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition));
    setTtsSupported("speechSynthesis" in window);
    return () => {
      recRef.current?.abort();
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, []);

  const stopSpeaking = useCallback(() => {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const speak = useCallback((text: string) => {
    if (!("speechSynthesis" in window)) return;
    const clean = toSpeakable(text).slice(0, 600);
    if (!clean) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = LANG;
    u.rate = 1;
    u.onstart = () => setSpeaking(true);
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(u);
  }, []);

  const stopListening = useCallback(() => {
    recRef.current?.stop();
  }, []);

  /** Listen for one utterance; `onFinal` receives the final transcript. */
  const startListening = useCallback((onFinal: (text: string) => void) => {
    const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return onErrorRef.current("Voice input isn't supported in this browser. Try Chrome or Edge.");
    window.speechSynthesis?.cancel(); // don't transcribe our own voice
    setSpeaking(false);
    const rec = new Ctor();
    rec.lang = LANG;
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let finalText = "";
    rec.onresult = (e) => {
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interimText += r[0].transcript;
      }
      setInterim(finalText || interimText);
    };
    rec.onerror = (e) => {
      if (e.error !== "aborted") onErrorRef.current(ERRORS[e.error] ?? "Voice input failed. Please try again or type your message.");
    };
    rec.onend = () => {
      setListening(false);
      setInterim("");
      recRef.current = null;
      const text = finalText.trim();
      if (text) onFinal(text);
    };
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  }, []);

  return { sttSupported, ttsSupported, listening, interim, speaking, startListening, stopListening, speak, stopSpeaking };
}
