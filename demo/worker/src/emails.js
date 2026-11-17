// Plain-text emails. Kept short: one action per email.

export const confirmEmail = ({ link }) => ({
  subject: "Confirm your locus live demo",
  text: `Hello,

please confirm your email to request a live demo of locus:

${link}

The link works once and expires in 24 hours. After you confirm, we run a few automatic checks and then prepare a dedicated server for you. You will get another email when it is ready, usually within an hour.

If you did not ask for this, ignore this email.

locus`,
});

export const readyEmail = ({ link, windowMinutes }) => ({
  subject: "Your locus demo is ready",
  text: `Hello,

your demo server is ready. Open it here:

${link}

You have ${Math.round(windowMinutes / 60 * 10) / 10} hours from now. After that the server and everything on it are deleted.

This demo runs on a rented server, so please do not paste real confidential data. On your own hardware, nothing leaves the building.

locus`,
});

export const failedEmail = () => ({
  subject: "Your locus demo could not start",
  text: `Hello,

we could not start a demo server for you this time (no suitable machine became available). Nothing was kept. We have been notified and will get back to you.

locus`,
});

export const ownerReviewEmail = ({ demo, decision, approveLink, rejectLink }) => ({
  subject: `[locus demo] review: ${demo.email}`,
  text: `A demo request needs your decision.

Email:   ${demo.email}
Domain:  ${demo.domain}
Country: ${demo.country || "?"}
Outcome: ${decision.decision} (${decision.decided_by})
Reason:  ${decision.reason}

Checks:
${(decision.gates ?? []).map((g) => `  ${g.pass === true ? "ok  " : g.pass === false ? "FAIL" : "??  "} ${g.name}: ${g.detail}`).join("\n")}

Approve: ${approveLink}
Reject:  ${rejectLink}

Approving still respects the spend caps; the demo may wait in the queue.`,
});

export const ownerFailedEmail = ({ demo, reason }) => ({
  subject: `[locus demo] provisioning failed: ${demo.email}`,
  text: `Provisioning failed for ${demo.email} (${demo.id}).

Reason: ${reason}

The Worker destroyed what it created; the 5-minute sweep removes anything left over.`,
});
