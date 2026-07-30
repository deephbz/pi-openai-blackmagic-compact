import { createServerCompactionController } from "./controller.mjs";

export default function registerServerCompaction(pi, options = {}) {
  return createServerCompactionController(pi, options);
}
