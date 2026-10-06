import { useLocale } from "./locale";
import React, { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Cut, SafeAsset } from "../shared/contracts";
import { time } from "./format";
/** Chunk long labels before rendering: full saved text stays readable without huge nodes. */
export function AssemblyScript({
  cuts,
  assets,
  selected,
  onInspect,
  onSource,
  onMove,
}: {
  cuts: Cut[];
  assets: SafeAsset[];
  selected: string;
  onInspect: (cut: Cut) => void;
  onSource: (cut: Cut) => void;
  onMove: (id: string, position: number) => void;
}) {
  const { t } = useLocale();
  const scroll = useRef<HTMLDivElement>(null);
  const rows = useMemo(
    () =>
      cuts.flatMap((cut, index) => {
        const result: Array<{
          cut: Cut;
          index: number;
          text: string;
          first: boolean;
        }> = [];
        const text = cut.text || t("Video range");
        for (let offset = 0; offset < text.length; offset += 800)
          result.push({
            cut,
            index,
            text: text.slice(offset, offset + 800),
            first: offset === 0,
          });
        return result;
      }),
    [cuts],
  );
  const virtual = useVirtualizer({
    // Scroll notifications can originate during React's layout/selection effects.
    // Let React schedule the range update instead of forcing a nested flush.
    useFlushSync: false,
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 180,
    overscan: 3,
    initialRect: { width: 600, height: 600 },
  });
  return (
    <div
      className="assembly-script"
      role="region"
      aria-label={t("Assembly script")}
      ref={scroll}
    >
      <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
        {virtual.getVirtualItems().map((row) => {
          const item = rows[row.index]!;
          return (
            <article
              key={row.key}
              data-index={row.index}
              ref={virtual.measureElement}
              className={`script-passage${selected === item.cut.id ? " active" : ""}`}
              style={{ transform: `translateY(${row.start}px)` }}
            >
              {item.first && (
                <header>
                  <strong>
                    {item.index + 1} ·{" "}
                    {assets.find((a) => a.id === item.cut.assetId)?.name}
                  </strong>
                  <span>{time(item.cut.endMs - item.cut.startMs, true)}</span>
                  <button
                    aria-label={`${t("Edit cut")} ${item.index + 1}`}
                    onClick={() => onInspect(item.cut)}
                  >
                    {t("Edit cut")}
                  </button>
                  {selected === item.cut.id && (
                    <>
                      <button onClick={() => onSource(item.cut)}>
                        {t("View in source")}
                      </button>
                      <label>
                        {t("Position")}
                        <input
                          aria-label={t("Cut position")}
                          type="number"
                          min={1}
                          max={cuts.length}
                          defaultValue={item.index + 1}
                          key={item.index}
                          onBlur={(e) =>
                            onMove(item.cut.id, Number(e.target.value) - 1)
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                          }}
                        />
                      </label>
                    </>
                  )}
                </header>
              )}
              <p>{item.text}</p>
              {item.first && item.cut.needsReview && (
                <p className="warning">{t("Review this cut before export.")}</p>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
