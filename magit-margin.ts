// SPDX-License-Identifier: GPL-3.0-or-later
//
// The right margin of Magit's log buffers, after magit-margin.el: each
// commit's author and age, or date, beside its line, as each buffer's
// margin option says; L toggles it, l cycles its style and d its details.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { currentSection, magitSectionMatch, type Section } from "magit-section";
import { PerBuffer, truthy } from "subr";
import { magitEllipsis, magitFormatTimeString } from "magit-base";
import { transientDefinePrefix } from "transient";

/** A margin's settings, as (INIT STYLE WIDTH AUTHOR AUTHOR-WIDTH): shown at first, age or age-abbreviated or a time format, width, whether the author shows, and how wide. */
export type MarginConfig = [boolean, string, number | string, boolean, number];

const logMargin: MarginConfig = [true, "age", "magit-log-margin-width", true, 18];
e8.defineVariable({ name: "magit-log-margin", doc: "Format of the margin in magit-log-mode buffers: [init, style, width, author, author-width].", value: logMargin as unknown as e8.Value });
// The other buffers' margins, as their options default: [option, shown at first, author shown].
for (const [name, init, author] of [
  ["magit-status-margin", false, false],
  ["magit-reflog-margin", true, false],
  ["magit-stashes-margin", true, false],
  ["magit-cherry-margin", true, true],
  ["magit-log-select-margin", true, true],
  ["magit-refs-margin", false, false],
] as const) {
  e8.defineVariable({ name, doc: `Format of the margin in the buffers ${name.replace(/-margin$/, "")} names, as magit-log-margin.`, value: [init, "age", "magit-log-margin-width", author, 18] as unknown as e8.Value });
}
e8.defineVariable({ name: "magit-log-margin-show-committer-date", doc: "Whether the margin shows the committer date rather than the author date.", value: false });
e8.defineVariable({ name: "magit-margin-default-time-format", doc: "The time format magit-cycle-margin-style goes to after age-abbreviated.", value: null });

/** The time units commit ages are given in, as magit--age-spec: [char, unit, units, seconds]. */
export const magitAgeSpec: [string, string, string, number][] = [
  ["Y", "year", "years", Math.round(60 * 60 * 24 * 365.2425)],
  ["M", "month", "months", Math.round(60 * 60 * 24 * 30.436875)],
  ["w", "week", "weeks", 60 * 60 * 24 * 7],
  ["d", "day", "days", 60 * 60 * 24],
  ["h", "hour", "hours", 60 * 60],
  ["m", "minute", "minutes", 60],
  ["s", "second", "seconds", 1],
];

/** How long ago DATE (seconds since the epoch) was, as a count and its unit, as magit--age. */
export function magitAge(date: number | string, abbreviate = false): [number, string] {
  const age = Math.abs(Date.now() / 1000 - Number(date));
  for (let i = 0; i < magitAgeSpec.length; i++) {
    const [char, unit, units, weight] = magitAgeSpec[i];
    const cnt = Math.round(age / weight);
    if (i === magitAgeSpec.length - 1 || age / weight >= 1) return [cnt, abbreviate ? char : cnt === 1 ? unit : units];
  }
  return [0, "seconds"];
}

/** The margin option for the current buffer's mode, as magit--right-margin-option. */
export function magitRightMarginOption(mode = String(e8.variable("major-mode"))): string | undefined {
  return (
    {
      "magit-cherry-mode": "magit-cherry-margin",
      "magit-log-mode": "magit-log-margin",
      "magit-log-select-mode": "magit-log-select-margin",
      "magit-reflog-mode": "magit-reflog-margin",
      "magit-refs-mode": "magit-refs-margin",
      "magit-stashes-mode": "magit-stashes-margin",
      "magit-status-mode": "magit-status-margin",
    } as { [k: string]: string }
  )[mode];
}

/** Each buffer's margin settings, as magit--right-margin-config. */
const configs = new PerBuffer<MarginConfig>();

/** The current buffer's margin settings, from its option the first time. */
export function magitRightMarginConfig(): MarginConfig | undefined {
  const option = magitRightMarginOption();
  if (!option) return undefined;
  let c = configs.get(e8.currentBuffer());
  if (!c) {
    const v = (e8.variable(option) as unknown as MarginConfig | null) ?? logMargin;
    c = [Boolean(v[0]), String(v[1]), v[2], Boolean(v[3]), Number(v[4] ?? 18)];
    if (typeof c[2] === "string") c[2] = magitLogMarginWidth(c[1], c[3], c[4]);
    configs.set(e8.currentBuffer(), c);
  }
  return c;
}

/** Whether the right margin shows, as magit--right-margin-active. */
export const magitRightMarginActive = (): boolean => magitRightMarginConfig()?.[0] === true;

/** How wide a margin of STYLE is, with the author DETAILS-WIDTH wide if DETAILS, as magit-log-margin-width. */
export function magitLogMarginWidth(style: string, details: boolean, detailsWidth: number): number {
  const author = details ? 1 + detailsWidth : 0;
  if (style !== "age" && style !== "age-abbreviated") return author + formatTime(style, Date.now() / 1000).length;
  return author + 2 + 1 + (style === "age-abbreviated" ? 1 : 1 + Math.max(...magitAgeSpec.map(([, u, us]) => Math.max(u.length, us.length))));
}

/** DATE formatted by STYLE, a format-time-string format. */
function formatTime(style: string, date: number): string {
  return magitFormatTimeString(style, date);
}

/** Sets the windows' margins for the buffer, as magit-set-buffer-margins; with REFRESH, refreshes it too. */
export function magitSetBufferMargins(reset = false, refresh = false): void {
  if (!magitRightMarginOption()) return;
  if (reset) configs.delete(e8.currentBuffer());
  const c = magitRightMarginConfig()!;
  e8.makeLocalVariable("right-margin-width");
  e8.setVariable("right-margin-width", c[0] ? Number(c[2]) : 0);
  if (refresh && e8.fboundp("magit-refresh")) e8.call("magit-refresh" as e8.CommandName);
}

e8.defun("magit-set-buffer-margins", (reset?: e8.Value, refresh?: e8.Value) => magitSetBufferMargins(truthy(reset ?? null), truthy(refresh ?? null)));

/** Shows STRING in the right margin of the previous line, or of this one, as magit-make-margin-overlay. */
export function magitMakeMarginOverlay(string?: string | e8.PropertizedString, previousLine?: boolean): void {
  const atBol = e8.point() === e8.lineStart(e8.lineOf(e8.point()));
  const line = e8.lineOf(e8.point()) - ((previousLine ?? atBol) ? 1 : 0);
  if (line < 0) return;
  const start = e8.lineStart(line);
  const end = e8.lineEnd(line);
  if (end <= start) return;
  e8.makeOverlay(start + 1, end, { evaporate: true, "magit-margin": true, "before-string": e8.propertize("o", { display: [["margin", "right-margin"], string ?? " "] }) });
}

/** The section types whose headings get a margin overlay, as magit-margin-overlay-conditions. */
const marginConditions = ["unpulled", "unpushed", "recent", "stashes", "local", "cherries", { lineage: ["remote", "branchbuf"] }, { lineage: ["shelved", "branchbuf"] }, { lineage: ["tags", "branchbuf"] }];

/** Puts an empty margin overlay on a section heading, as magit-maybe-make-margin-overlay, so the margin is filled. */
export function magitMaybeMakeMarginOverlay(section: Section | undefined = currentSection()): void {
  if (section && magitSectionMatch(marginConditions, section)) magitMakeMarginOverlay();
}

/** The margin text for a commit by AUTHOR on DATE, as magit-log-format-author-margin. */
export function magitLogFormatAuthorMargin(author: string, date: string | number): e8.PropertizedString | undefined {
  const c = magitRightMarginConfig();
  if (!c) return undefined;
  const [, style, width, details, detailsWidth] = c;
  const parts: e8.PropertizedString[] = [];
  if (details) {
    // Truncated with magit-ellipsis's margin ellipsis, as truncate-string-to-width.
    const ellipsis = magitEllipsis("margin");
    const a = author.length > detailsWidth ? `${author.slice(0, Math.max(0, detailsWidth - ellipsis.length))}${ellipsis}` : author.padEnd(detailsWidth);
    parts.push(e8.propertize(a, { "font-lock-face": "magit-log-author" }), e8.propertize(" ", {}));
  }
  let text: string;
  if (style !== "age" && style !== "age-abbreviated") text = formatTime(style, Number(date));
  else {
    const abbr = style === "age-abbreviated";
    const [cnt, unit] = magitAge(date, abbr);
    const rest = Number(width) - (details ? 1 + detailsWidth : 0);
    text = abbr ? `${String(cnt).padStart(2)}${unit.padEnd(rest - 2)}` : `${String(cnt).padStart(2)} ${unit.padEnd(rest - 3)}`;
  }
  parts.push(e8.propertize(text, { "font-lock-face": "magit-log-date" }));
  return e8.concat(...parts);
}

/** Shows a commit's author and date in the margin of the line just inserted, as magit-log-format-margin. */
export function magitLogFormatMargin(_rev: string, author: string, date: string | number): void {
  if (!magitRightMarginOption()) return;
  const text = magitLogFormatAuthorMargin(author, date);
  if (text) magitMakeMarginOverlay(text);
}

export const magitToggleMargin = e8.defineCommand({
  name: "magit-toggle-margin",
  doc: "Show or hide the right margin.",
  run: () => {
    if (!magitRightMarginOption()) e8.userError("Magit margin isn't supported in this buffer");
    const c = magitRightMarginConfig()!;
    c[0] = !c[0];
    magitSetBufferMargins();
  },
});
export const magitCycleMarginStyle = e8.defineCommand({
  name: "magit-cycle-margin-style",
  doc: "Cycle style used for the right margin: age, abbreviated age, and a date.",
  run: () => {
    if (!magitRightMarginOption()) e8.userError("Magit margin isn't supported in this buffer");
    const c = magitRightMarginConfig()!;
    const def = (e8.variable("magit-margin-default-time-format") as string | null) ?? (((e8.variable(magitRightMarginOption()!) as unknown as MarginConfig) ?? logMargin)[1] as string);
    c[1] = c[1] === "age" ? "age-abbreviated" : c[1] === "age-abbreviated" ? (def !== "age" && def !== "age-abbreviated" ? def : "%Y-%m-%d %H:%M ") : "age";
    c[2] = magitLogMarginWidth(c[1], c[3], c[4]);
    magitSetBufferMargins(false, true);
  },
});
export const magitToggleMarginDetails = e8.defineCommand({
  name: "magit-toggle-margin-details",
  doc: "Show or hide details, the author, in the right margin.",
  run: () => {
    if (!magitRightMarginOption()) e8.userError("Magit margin isn't supported in this buffer");
    const c = magitRightMarginConfig()!;
    c[3] = !c[3];
    c[2] = magitLogMarginWidth(c[1], c[3], c[4]);
    magitSetBufferMargins(false, true);
  },
});

/** What the right margin shows, from a menu, as magit-margin-settings. */
export const magitMarginSettings = transientDefinePrefix("magit-margin-settings", {
  doc: "Change what information is displayed in the right margin.",
  groups: [
    {
      description: "Margin",
      items: [
        ["L", "Toggle visibility", magitToggleMargin, { transient: true }],
        ["l", "Cycle style", magitCycleMarginStyle, { transient: true }],
        ["d", "Toggle details", magitToggleMarginDetails, { transient: true }],
        ["v", "Change verbosity", "magit-refs-set-show-commit-count", { ifDerived: "magit-refs-mode" }],
      ],
    },
  ],
});
