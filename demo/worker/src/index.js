// locus-demo Worker: serves /api/demo/* behind the Pages site (service binding DEMO).
// Routes, Workflows and the sweep are added in the following commits.

import { fail } from "./http.js";

export default {
  async fetch() {
    return fail(404, "Not found.");
  },
};
