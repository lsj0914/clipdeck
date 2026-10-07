import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { time } from "./format";
import { useLocale } from "./locale";

// App-owned controls keep inspection shortcuts outside Chromium's media shadow UI.
export function ExportPlayer({ src }: { src: string }) {
  const { t } = useLocale();
  const player = useRef<HTMLVideoElement>(null);
  const errorNotice = useRef<HTMLParagraphElement>(null);
  const currentSource = useRef(src);
  const playbackCommand = useRef(0);
  currentSource.current = src;
  const [durationMs, setDurationMs] = useState(0);
  const [currentMs, setCurrentMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(100);
  const [muted, setMuted] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    playbackCommand.current += 1;
    setDurationMs(0);
    setCurrentMs(0);
    setPlaying(false);
    setFailed(false);
  }, [src]);
  useEffect(() => {
    if (failed) errorNotice.current?.focus({ preventScroll: true });
  }, [failed]);
  async function togglePlayback() {
    const element = player.current;
    if (!element || !durationMs || failed) return;
    const command = ++playbackCommand.current;
    if (!element.paused) element.pause();
    else {
      const requestedSource = src;
      try {
        await element.play();
        if (player.current === element && currentSource.current === requestedSource && playbackCommand.current === command)
          setPlaying(!element.paused);
      } catch {
        if (player.current === element && currentSource.current === requestedSource && playbackCommand.current === command)
          setFailed(true);
      }
    }
  }
  return (
    <div className="export-player">
      <video ref={player} src={src} aria-label={t("Exported video")} preload="metadata"
        onLoadedMetadata={(event) => {
          const duration = event.currentTarget.duration * 1000;
          setDurationMs(Number.isFinite(duration) && duration > 0 ? duration : 0);
        }}
        onTimeUpdate={(event) => setCurrentMs(event.currentTarget.currentTime * 1000)}
        onPlay={() => setPlaying(true)}
        onPause={(event) => { setPlaying(false); setCurrentMs(event.currentTarget.currentTime * 1000); }}
        onEnded={() => setPlaying(false)}
        onError={() => { playbackCommand.current += 1; setPlaying(false); setFailed(true); }}
      />
      {failed && <p ref={errorNotice} role="alert" tabIndex={-1}>
        {t("This exported video could not be played. Show its file or return to editing and export again.")}
      </p>}
      <div className="transport export-player-controls" role="group" aria-label={t("Export playback controls")}>
        <button aria-label={t(playing ? "Pause exported file" : "Play exported file")}
          disabled={!durationMs || failed} onClick={() => void togglePlayback()}>
          <Icon name={playing ? "pause" : "play"} />
          <span>{t(playing ? "Pause" : "Play")}</span>
        </button>
        <span className="export-player-time">{time(currentMs, true)} / {time(durationMs)}</span>
        <input type="range" min="0" max={durationMs} step="1"
          aria-label={t("Exported video position")} value={Math.min(currentMs, durationMs)}
          disabled={!durationMs || failed}
          onChange={(event) => {
            const position = Math.max(0, Math.min(durationMs, Number(event.target.value)));
            if (!Number.isFinite(position) || !player.current) return;
            player.current.currentTime = position / 1000;
            setCurrentMs(position);
          }} />
        <div className="export-player-volume">
          <button aria-label={t(muted ? "Unmute exported video" : "Mute exported video")}
            aria-pressed={muted} onClick={() => {
              if (player.current) player.current.muted = !muted;
              setMuted(!muted);
            }}>{t(muted ? "Unmute" : "Mute")}</button>
          <input type="range" min="0" max="100" step="1" value={volume}
            aria-label={t("Export volume")} onChange={(event) => {
              const next = Math.max(0, Math.min(100, Number(event.target.value)));
              if (!Number.isFinite(next) || !player.current) return;
              player.current.volume = next / 100;
              player.current.muted = false;
              setVolume(next);
              setMuted(false);
            }} />
        </div>
      </div>
    </div>
  );
}
