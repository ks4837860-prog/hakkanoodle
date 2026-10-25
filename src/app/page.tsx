"use client";

import { useCallback, useRef, useState } from "react";
import { AlertTriangle, Check, Info } from "lucide-react";
import Atmosphere from "@/components/Atmosphere";
import SignalConsole from "@/components/SignalConsole";

type ToastKind = "ok" | "err" | "info";

interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

export default function Home() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const pushToast = useCallback((kind: ToastKind, text: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-2), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);

  return (
    <div className="relative min-h-screen px-4 py-10 sm:px-6">
      <Atmosphere />

      <div className="boot-up relative z-10 mx-auto w-full max-w-[1100px]">
        <header className="relative mb-9 border-b border-borderline pb-6 text-center">
          <div className="status-core mx-auto mb-3.5" />
          <h1 className="glitch-title font-display m-0 text-3xl font-black tracking-[5px] text-textlight sm:text-[2.5rem]">
            VANGUARD CONSOLE
          </h1>
          <p className="mt-2.5 text-[0.85rem] font-semibold tracking-[4px] text-heroblue uppercase">
            Tactical Signal Realignment System
          </p>
        </header>

        <SignalConsole pushToast={pushToast} />

        <footer className="mt-10 border-t border-borderline pt-5 text-center">
          <p className="text-[0.7rem] tracking-[3px] text-textdim uppercase">
            Vanguard Console · secured channels · zero format loss
          </p>
        </footer>
      </div>

      {/* ══════════ toasts ══════════ */}
      <div className="fixed right-5 bottom-8 z-[1000] flex w-full max-w-md flex-col items-end gap-2 px-4 sm:right-10">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className="toast-in flex items-start gap-2.5 rounded border bg-panelalt px-5 py-3.5 text-[0.85rem] font-semibold tracking-wide text-textlight shadow-[0_10px_40px_rgba(0,0,0,0.8)]"
            style={{
              borderColor:
                t.kind === "ok"
                  ? "var(--color-heroblue)"
                  : t.kind === "err"
                    ? "var(--color-herored)"
                    : "var(--color-herogold)",
            }}
          >
            {t.kind === "ok" ? (
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-heroblue" />
            ) : t.kind === "err" ? (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-herored" />
            ) : (
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-herogold" />
            )}
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
