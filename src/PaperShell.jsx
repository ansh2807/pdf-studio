import { useEffect, useRef, useState } from "react";
import { RotateCcw, Volume2, VolumeX } from "lucide-react";
import ballUrl from "./assets/crumpled-ball.png";
import * as paperSound from "./paperSound";

/*
  PaperShell wraps the whole app in the Paper Studio "desk + sheet" frame:
  a kraft-paper desk, a floating cream sheet that unfolds from a tossed
  crumpled-paper ball on first load, and the mute / replay controls.

  It plays the intro once per mount (with sound), keeps the sheet's
  crumple-unfold animation in sync, and exposes nothing else - view switching
  and its page-flip sound live in the app, which calls paperSound.playFlip().
*/
export default function PaperShell({ children, introOnLoad = true }) {
  const [playIntro, setPlayIntro] = useState(introOnLoad);
  const [soundOn, setSoundOn] = useState(true);
  const introTimer = useRef(null);

  useEffect(() => {
    paperSound.setEnabled(true);
    if (introOnLoad) {
      paperSound.playIntro();
      introTimer.current = setTimeout(() => setPlayIntro(false), 3000);
    }
    const onGesture = () => paperSound.resumeOnGesture();
    window.addEventListener("pointerdown", onGesture);
    return () => {
      clearTimeout(introTimer.current);
      window.removeEventListener("pointerdown", onGesture);
    };
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const replay = () => {
    if (playIntro) return;
    clearTimeout(introTimer.current);
    setPlayIntro(true);
    paperSound.playIntro();
    introTimer.current = setTimeout(() => setPlayIntro(false), 3000);
  };

  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    paperSound.setEnabled(next);
    if (next) paperSound.playFlip();
  };

  return (
    <div className="desk">
      <div className="desk-grain" />

      <div className={`sheet-frame ${playIntro ? "intro-unfold" : ""}`}>
        <div className="sheet-grain" />
        {playIntro && <div className="crease-overlay" />}
        {children}
      </div>

      <div className="paper-controls">
        <button
          className="paper-fab"
          onClick={toggleSound}
          title={soundOn ? "Mute paper sounds" : "Unmute paper sounds"}
          aria-label={soundOn ? "Mute paper sounds" : "Unmute paper sounds"}
        >
          {soundOn ? <Volume2 size={15} /> : <VolumeX size={15} />}
        </button>
        <button className="paper-replay" onClick={replay}>
          <RotateCcw size={14} />Replay intro
        </button>
      </div>

      {playIntro && (
        <div className="intro-overlay">
          <div className="intro-cover" />
          <div className="intro-arc">
            <div className="intro-ball">
              <img src={ballUrl} alt="Crumpled paper idea" />
            </div>
          </div>
          <div className="intro-cue">toss the idea in&nbsp;&nbsp;&rsaquo;</div>
        </div>
      )}
    </div>
  );
}
