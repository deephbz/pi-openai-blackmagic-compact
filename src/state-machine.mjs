/** Executable semantic authority for Blackmagic continuation and compaction. */

export const SUMMARY_STAYS_READABLE = "SUMMARY_STAYS_READABLE";
export const BLACKMAGIC_READY = "BLACKMAGIC_READY";
export const PROVIDER_MISMATCH = "PROVIDER_MISMATCH";
export const BLACKMAGIC_COMPACTION_MARKER = "[Blackmagic compaction checkpoint — opaque History requires its matching OpenAI Route]";
export const PROVIDER_MISMATCH_WARNING = "Blackmagic History cannot replay on this Route. Pi actions remain available.";

export const CONTINUATION_REPLAY = Object.freeze({
  UNKNOWN: "unknown",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
});
export const COMPACTION_OUTCOME = Object.freeze({
  PENDING: "pending",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
});
export const COMPACTION_DECISION = Object.freeze({
  DELEGATE: "delegate",
  ATTEMPT: "attempt",
  CANCEL: "cancel",
  APPLY: "apply",
});

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
      "description": "What Pi carries forward: readable text or opaque OpenAI output."
    },
    {
      "name": "Route",
      "description": "The selected provider/model connection. It either matches opaque History or it does not."
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
      "note": "Readable History works with any selected Route. Blackmagic can make it opaque when the selected Route supports it."
    },
    {
      "id": "ready",
      "name": BLACKMAGIC_READY,
      "description": "Opaque History is usable on the selected Route.",
      "note": "Opaque History is usable because the selected Route matches it. The state recomputes after Route, tree, compaction, or restart changes."
    },
    {
      "id": "mismatch",
      "name": PROVIDER_MISMATCH,
      "description": "Opaque History and the selected Route do not pair. All actions remain available. Only one persistent footer warning is shown.",
      "note": "Pi allows every action. The extension shows one persistent footer warning while the condition holds; it does not append a warning for every message and does not persist the warning as Session history. The state recomputes after Route, tree, compaction, or restart changes."
    }
  ],
  "transitions": [
    {
      "id": "summary-stays",
      "source": "summary",
      "event": "Readable History continues",
      "target": "summary",
      "action": "keep readable History",
      "reason": "OpenAI compaction unavailable or failed, a local summary, ordinary continue, or restart leaves readable History readable."
    },
    {
      "id": "summary-blackmagic",
      "source": "summary",
      "event": "OpenAI succeeds or compatible point selected",
      "target": "ready",
      "action": "use opaque History on the matching Route",
      "reason": "OpenAI success or a compatible Blackmagic tree point gives Pi opaque History that pairs with the selected Route."
    },
    {
      "id": "summary-mismatch",
      "source": "summary",
      "event": "Incompatible Blackmagic point selected",
      "target": "mismatch",
      "action": "show one persistent footer warning",
      "reason": "The selected tree point has opaque History that does not pair with the selected Route; all actions remain available."
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
      "event": "Matching Route continues or compacts",
      "target": "ready",
      "action": "use or replace opaque History",
      "reason": "Opaque History and the selected Route still match after ordinary continue or compaction."
    },
    {
      "id": "blackmagic-mismatch",
      "source": "ready",
      "event": "Provider, checkpoint, or tree stops matching",
      "target": "mismatch",
      "action": "recompute with the footer warning",
      "reason": "A provider, checkpoint, Route, or tree selection change means opaque History and the selected Route no longer form a usable pair."
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
      "reason": "Route restore, compatible tree selection, or successful Blackmagic compaction on the selected Route makes the pair usable again."
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
          "mayDo": "Start OpenAI compaction when the selected Route supports it."
        },
        {
          "transition": "summary-blackmagic",
          "state": "ready",
          "happened": "OpenAI succeeds and creates opaque History on a compatible Blackmagic point.",
          "why": "The selected Route matches the new opaque History.",
          "mayDo": "Continue or compact again on this matching Route."
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
          "mayDo": "Try OpenAI compaction on the selected Route."
        },
        {
          "transition": "summary-stays",
          "state": "summary",
          "happened": "OpenAI compaction is unavailable, so Pi keeps readable History.",
          "why": "The readable classification stays the same when the provider path is unavailable.",
          "mayDo": "Continue with readable History."
        },
        {
          "transition": "summary-stays",
          "state": "summary",
          "happened": "A later OpenAI compaction attempt fails.",
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
          "happened": "Pi has opaque History on a matching Route.",
          "why": "The Route can use this History.",
          "mayDo": "Continue on the matching Route."
        },
        {
          "transition": "blackmagic-mismatch",
          "state": "mismatch",
          "happened": "A provider, checkpoint, or tree selection stops matching.",
          "why": "Opaque History and the selected Route do not form a usable pair.",
          "mayDo": "Use any Pi action. The extension shows one persistent footer warning; it does not append a warning for every message and does not persist the warning as Session history."
        },
        {
          "transition": "mismatch-mismatch",
          "state": "mismatch",
          "happened": "Pi continues while the mismatch holds.",
          "why": "Pi allows every action; only the footer warning stays.",
          "mayDo": "Continue, compact, or switch Route; the footer warning remains until the state changes."
        }
      ]
    },
    {
      "id": "restore",
      "name": "Route restore",
      "steps": [
        {
          "state": "ready",
          "happened": "Pi has opaque History on a matching Route.",
          "why": "The Route can use this History.",
          "mayDo": "Continue on the matching Route."
        },
        {
          "transition": "blackmagic-mismatch",
          "state": "mismatch",
          "happened": "The selected Route or checkpoint no longer matches opaque History.",
          "why": "The derived pair is no longer usable, so Pi recomputes the classification.",
          "mayDo": "Select the matching Route or choose a compatible tree point."
        },
        {
          "transition": "mismatch-ready",
          "state": "ready",
          "happened": "A matching opaque result becomes available after Route restore.",
          "why": "The matching Route makes the opaque pair usable again.",
          "mayDo": "Continue on the matching Route; the footer warning clears."
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
          "why": "Opaque History and the selected Route form a usable pair.",
          "mayDo": "Continue from BLACKMAGIC_READY."
        },
        {
          "transition": "blackmagic-mismatch",
          "state": "mismatch",
          "happened": "Pi selects an incompatible Route or Blackmagic tree point.",
          "why": "The opaque result does not pair with the selected Route.",
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
          "happened": "Pi has opaque History on a non-matching Route.",
          "why": "The selected Route and opaque History do not form a usable pair.",
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
          "happened": "Pi again has opaque History on a non-matching Route.",
          "why": "This outcome starts from the same derived mismatch classification.",
          "mayDo": "Try Blackmagic compaction on the selected Route."
        },
        {
          "transition": "mismatch-ready",
          "state": "ready",
          "happened": "Successful Blackmagic compaction creates a matching opaque result on the selected Route.",
          "why": "The new opaque History and Route form a usable pair.",
          "mayDo": "Continue from BLACKMAGIC_READY."
        },
        {
          "state": "mismatch",
          "happened": "Pi again has opaque History on a non-matching Route.",
          "why": "This outcome starts from the same derived mismatch classification.",
          "mayDo": "Try another allowed action."
        },
        {
          "transition": "mismatch-mismatch",
          "state": "mismatch",
          "happened": "A compaction attempt does not produce a matching opaque result.",
          "why": "The warning-only mismatch remains, and Pi still allows every action.",
          "mayDo": "Continue, compact again, select a tree point, or switch Route."
        }
      ]
    },
    {
      "id": "restart",
      "name": "Restart",
      "steps": [
        {
          "state": "ready",
          "happened": "Pi restarts with opaque History and a matching Route.",
          "why": "Pi recomputes the state after restart.",
          "mayDo": "Continue from BLACKMAGIC_READY."
        },
        {
          "state": "mismatch",
          "happened": "Pi restarts with opaque History and a non-matching Route.",
          "why": "Pi recomputes the state after restart; the pair is not usable.",
          "mayDo": "Use any Pi action; one persistent footer warning shows."
        },
        {
          "state": "summary",
          "happened": "Pi restarts with readable History.",
          "why": "Pi recomputes the state after restart; readable History works with any Route.",
          "mayDo": "Continue from SUMMARY_STAYS_READABLE."
        }
      ]
    }
  ]
});

export const STATE_NAMES = Object.freeze([SUMMARY_STAYS_READABLE, BLACKMAGIC_READY, PROVIDER_MISMATCH]);
export const TRANSITIONS = STATE_MACHINE.transitions;

/** Classify the selected History/Route pair without changing either input. */
export function classifyContinuation({ opaqueHistory = false, routeMatches = false, replay = CONTINUATION_REPLAY.UNKNOWN } = {}) {
  if (!opaqueHistory) return SUMMARY_STAYS_READABLE;
  if (!routeMatches || replay === CONTINUATION_REPLAY.FAILED) return PROVIDER_MISMATCH;
  return BLACKMAGIC_READY;
}

/** Decide extension ownership and its Pi hook result without side effects. */
export function decideCompaction({ routeSupported = false, authorized = false, outcome = COMPACTION_OUTCOME.PENDING, compaction, failureClass } = {}) {
  if (!routeSupported || !authorized) return Object.freeze({ kind: COMPACTION_DECISION.DELEGATE });
  if (outcome === COMPACTION_OUTCOME.PENDING) return Object.freeze({ kind: COMPACTION_DECISION.ATTEMPT });
  if (outcome === COMPACTION_OUTCOME.SUCCEEDED) {
    if (!compaction || typeof compaction !== "object") throw new TypeError("successful compaction requires a CompactionResult");
    return Object.freeze({ kind: COMPACTION_DECISION.APPLY, compaction });
  }
  return Object.freeze({ kind: COMPACTION_DECISION.CANCEL, failureClass: typeof failureClass === "string" ? failureClass : "unclassified" });
}
