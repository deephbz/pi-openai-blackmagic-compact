/** Executable semantic authority for Blackmagic continuation and compaction. */

export const SUMMARY_STAYS_READABLE = "SUMMARY_STAYS_READABLE";
export const BLACKMAGIC_READY = "BLACKMAGIC_READY";
export const PROVIDER_MISMATCH = "PROVIDER_MISMATCH";
/** Pi requires a summary string, but the server result supplies older Blackmagic History. */
export const BLACKMAGIC_MODEL_SUMMARY = "";
/** Human-only acknowledgement. It must never enter model context or Session summary text. */
export const BLACKMAGIC_APPLIED_NOTICE = "Server-side compaction applied. Keep this provider.";
export const BLACKMAGIC_READY_NOTICE = "Blackmagic active · keep this provider";
export const PROVIDER_MISMATCH_WARNING = "Blackmagic History unavailable · switch back or use /tree";

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const STATE_MACHINE = deepFreeze({
  "concepts": [
    {
      "name": "History",
      "description": "What Pi carries forward: readable text or opaque provider output."
    },
    {
      "name": "Provider",
      "description": "The selected provider connection. It either supports opaque History or it does not."
    },
    {
      "name": "Compact",
      "description": "Replace older History with a smaller form."
    }
  ],
  "states": [
    {
      "id": "summary",
      "name": SUMMARY_STAYS_READABLE,
      "description": "History is readable text. Pi can continue from it.",
      "footer": null,
      "note": "Readable History works with any selected provider. Blackmagic can make it opaque when the selected provider supports it."
    },
    {
      "id": "ready",
      "name": BLACKMAGIC_READY,
      "description": "Opaque History is usable on the selected provider.",
      "footer": BLACKMAGIC_READY_NOTICE,
      "note": "Opaque History is usable because the selected provider matches it. The footer tells the user to keep that provider. The state recomputes after provider, tree, compaction, or restart changes."
    },
    {
      "id": "mismatch",
      "name": PROVIDER_MISMATCH,
      "description": "Opaque History is unavailable on the selected provider. All actions remain available. Only one persistent footer warning is shown.",
      "footer": PROVIDER_MISMATCH_WARNING,
      "note": "Pi allows every action. The extension shows one persistent footer warning while the condition holds; it does not append a warning for every message or persist warning History. The state recomputes after provider, tree, compaction, or restart changes."
    }
  ],
  "transitions": [
    {
      "id": "summary-stays",
      "source": "summary",
      "event": "Readable History continues",
      "target": "summary",
      "action": "keep readable History",
      "reason": "Server-side compaction unavailable or failed, a local summary, ordinary continue, or restart leaves readable History readable."
    },
    {
      "id": "summary-blackmagic",
      "source": "summary",
      "event": "Compact succeeds or compatible point selected",
      "target": "ready",
      "action": "use opaque History on the matching provider",
      "reason": "Server-side compaction or a compatible Blackmagic tree point gives Pi opaque History that the selected provider can use."
    },
    {
      "id": "summary-mismatch",
      "source": "summary",
      "event": "Incompatible Blackmagic point selected",
      "target": "mismatch",
      "action": "show one persistent footer warning",
      "reason": "The selected tree point has opaque History that the selected provider cannot use; all actions remain available."
    },
    {
      "id": "blackmagic-summary",
      "source": "ready",
      "event": "Readable point selected",
      "target": "summary",
      "action": "use readable History",
      "reason": "Selecting a readable tree point changes History back to readable text, so the derived state is SUMMARY_STAYS_READABLE."
    },
    {
      "id": "blackmagic-ready",
      "source": "ready",
      "event": "Matching provider continues or compacts",
      "target": "ready",
      "action": "use or replace opaque History",
      "reason": "Opaque History and the selected provider still match after ordinary continue or compaction."
    },
    {
      "id": "blackmagic-mismatch",
      "source": "ready",
      "event": "Provider or tree selection makes History unavailable",
      "target": "mismatch",
      "action": "recompute with the footer warning",
      "reason": "The selected provider cannot use opaque History after a provider or tree selection change."
    },
    {
      "id": "mismatch-summary",
      "source": "mismatch",
      "event": "History becomes readable",
      "target": "summary",
      "action": "use readable History",
      "reason": "Tree selection before Blackmagic or a Pi local summary makes History readable again."
    },
    {
      "id": "mismatch-ready",
      "source": "mismatch",
      "event": "Opaque History becomes usable",
      "target": "ready",
      "action": "use the matching opaque History",
      "reason": "Provider restore, compatible tree selection, or successful Blackmagic compaction makes opaque History usable again."
    },
    {
      "id": "mismatch-mismatch",
      "source": "mismatch",
      "event": "Any other allowed action",
      "target": "mismatch",
      "action": "keep all actions available",
      "reason": "Pi allows every action while the footer warning remains; the extension does not append a warning for every message or persist it as Session history."
    }
  ],
  "scenarios": [
    {
      "id": "happy",
      "name": "Happy path",
      "steps": [
        {
          "state": "summary",
          "happened": "Pi starts with readable History.",
          "why": "History is text, so Pi can use it now.",
          "mayDo": "Start server-side compaction when the selected provider supports it."
        },
        {
          "transition": "summary-blackmagic",
          "state": "ready",
          "happened": "Server-side compaction succeeds and creates opaque History on a compatible Blackmagic point.",
          "why": "The selected provider matches the new opaque History.",
          "mayDo": "Continue or compact again on this matching provider."
        }
      ]
    },
    {
      "id": "fallback",
      "name": "Readable fallback and failure",
      "steps": [
        {
          "state": "summary",
          "happened": "Pi starts with readable History.",
          "why": "History is text.",
          "mayDo": "Try server-side compaction on the selected provider."
        },
        {
          "transition": "summary-stays",
          "state": "summary",
          "happened": "Server-side compaction is unavailable, so Pi keeps readable History.",
          "why": "The readable classification stays the same when the provider path is unavailable.",
          "mayDo": "Continue with readable History."
        },
        {
          "transition": "summary-stays",
          "state": "summary",
          "happened": "A later server-side compaction attempt fails.",
          "why": "A failed attempt does not replace existing readable History.",
          "mayDo": "Continue with readable History or try again later."
        }
      ]
    },
    {
      "id": "freedom",
      "name": "Provider mismatch freedom",
      "steps": [
        {
          "state": "ready",
          "happened": "Pi has opaque History on a matching provider.",
          "why": "The provider can use this History.",
          "mayDo": "Continue on the matching provider."
        },
        {
          "transition": "blackmagic-mismatch",
          "state": "mismatch",
          "happened": "A provider or tree selection makes opaque History unavailable.",
          "why": "The selected provider cannot use opaque History.",
          "mayDo": "Use any Pi action. The extension shows one persistent footer warning; it does not append a warning for every message and does not persist the warning as Session history."
        },
        {
          "transition": "mismatch-mismatch",
          "state": "mismatch",
          "happened": "Pi continues while the mismatch holds.",
          "why": "Pi allows every action; only the footer warning stays.",
          "mayDo": "Continue, compact, or switch provider; the footer warning remains until the state changes."
        }
      ]
    },
    {
      "id": "restore",
      "name": "Provider restore",
      "steps": [
        {
          "state": "ready",
          "happened": "Pi has opaque History on a matching provider.",
          "why": "The provider can use this History.",
          "mayDo": "Continue on the matching provider."
        },
        {
          "transition": "blackmagic-mismatch",
          "state": "mismatch",
          "happened": "A provider or tree selection makes opaque History unavailable.",
          "why": "The selected provider cannot use opaque History, so Pi recomputes the classification.",
          "mayDo": "Select the matching provider or choose a compatible tree point."
        },
        {
          "transition": "mismatch-ready",
          "state": "ready",
          "happened": "The selected provider can use opaque History again.",
          "why": "The restored provider supports that History.",
          "mayDo": "Continue on the matching provider; the footer warning clears."
        }
      ]
    },
    {
      "id": "tree",
      "name": "Tree between all three classifications",
      "steps": [
        {
          "state": "summary",
          "happened": "Pi selects a tree point before Blackmagic.",
          "why": "The History there is readable text.",
          "mayDo": "Continue from SUMMARY_STAYS_READABLE."
        },
        {
          "transition": "summary-blackmagic",
          "state": "ready",
          "happened": "Pi selects a compatible Blackmagic tree point.",
          "why": "The selected provider can use opaque History.",
          "mayDo": "Continue from BLACKMAGIC_READY."
        },
        {
          "transition": "blackmagic-mismatch",
          "state": "mismatch",
          "happened": "Pi selects an incompatible provider or Blackmagic tree point.",
          "why": "The selected provider cannot use opaque History.",
          "mayDo": "Use any Pi action; the footer warning shows while the mismatch holds."
        },
        {
          "transition": "mismatch-summary",
          "state": "summary",
          "happened": "Pi selects a readable tree point again.",
          "why": "History becomes readable, so the classification returns to SUMMARY_STAYS_READABLE.",
          "mayDo": "Continue with readable History."
        }
      ]
    },
    {
      "id": "compaction",
      "name": "Mismatch compaction outcomes",
      "steps": [
        {
          "state": "mismatch",
          "happened": "Pi has opaque History on a non-matching provider.",
          "why": "The selected provider cannot use opaque History.",
          "mayDo": "Try local or Blackmagic compaction; all actions remain available."
        },
        {
          "transition": "mismatch-summary",
          "state": "summary",
          "happened": "Pi local summary makes History readable.",
          "why": "Readable History changes the derived classification to SUMMARY_STAYS_READABLE.",
          "mayDo": "Continue with readable History."
        },
        {
          "state": "mismatch",
          "happened": "Pi again has opaque History on a non-matching provider.",
          "why": "This outcome starts from the same derived mismatch classification.",
          "mayDo": "Try Blackmagic compaction on the selected provider."
        },
        {
          "transition": "mismatch-ready",
          "state": "ready",
          "happened": "Successful Blackmagic compaction creates opaque History for the selected provider.",
          "why": "The selected provider can use the new opaque History.",
          "mayDo": "Continue from BLACKMAGIC_READY."
        },
        {
          "state": "mismatch",
          "happened": "Pi again has opaque History on a non-matching provider.",
          "why": "This outcome starts from the same derived mismatch classification.",
          "mayDo": "Try another allowed action."
        },
        {
          "transition": "mismatch-mismatch",
          "state": "mismatch",
          "happened": "A compaction attempt does not make opaque History usable.",
          "why": "The warning-only mismatch remains, and Pi still allows every action.",
          "mayDo": "Continue, compact again, select a tree point, or switch provider."
        }
      ]
    },
    {
      "id": "restart",
      "name": "Restart",
      "steps": [
        {
          "state": "ready",
          "happened": "Pi restarts with opaque History and a matching provider.",
          "why": "Pi recomputes the state after restart.",
          "mayDo": "Continue from BLACKMAGIC_READY."
        },
        {
          "state": "mismatch",
          "happened": "Pi restarts with opaque History and a non-matching provider.",
          "why": "Pi recomputes the state after restart; the selected provider cannot use opaque History.",
          "mayDo": "Use any Pi action; one persistent footer warning shows."
        },
        {
          "state": "summary",
          "happened": "Pi restarts with readable History.",
          "why": "Pi recomputes the state after restart; readable History works with any provider.",
          "mayDo": "Continue from SUMMARY_STAYS_READABLE."
        }
      ]
    }
  ]
});

export const STATE_NAMES = Object.freeze([SUMMARY_STAYS_READABLE, BLACKMAGIC_READY, PROVIDER_MISMATCH]);
export const TRANSITIONS = STATE_MACHINE.transitions;

/** Project one derived continuation state into the human-only footer. */
export function continuationFooter(state) {
  return STATE_MACHINE.states.find((candidate) => candidate.name === state)?.footer ?? undefined;
}

/** Project machine state into the on-demand human command response. */
export function projectBlackmagicStatus({ state, serverCompactionAvailable = false } = {}) {
  let lines;
  if (state === SUMMARY_STAYS_READABLE) lines = ["History: Readable."];
  else if (state === BLACKMAGIC_READY) lines = ["History: Server-side compacted and available.", "Action: Keep this provider."];
  else if (state === PROVIDER_MISMATCH) lines = ["History: Server-side compacted but unavailable here.", "Action: Switch back, or select a readable point with /tree."];
  else throw new TypeError(`unknown continuation state: ${state}`);
  lines.push(`Next /compact: ${serverCompactionAvailable ? "Server-side compaction." : "Pi compaction."}`);
  return lines.join("\n");
}

/** Classify selected History against the selected provider without changing either input. */
export function classifyContinuation({ blackmagicHistory = false, providerMatches = false, replayFailed = false } = {}) {
  if (!blackmagicHistory) return SUMMARY_STAYS_READABLE;
  return providerMatches && !replayFailed ? BLACKMAGIC_READY : PROVIDER_MISMATCH;
}
