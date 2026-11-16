# Community form fixtures

`community-selects.test.mjs` uses inline HTML fixtures, following the existing
test suites. They mimic focus-mounted body portals, Radix-style button triggers,
and lists that mount at most 20 options. These are behavioral fixtures, not
installations of the upstream UI libraries.

`smart_fill_form` first tries visible options. If none match, it focuses the
combobox, fills an editable input when present, and sends up to 100 ArrowDown
keys. Enter is sent only when the active option text matches. The keyboard path
requires a committed value (data-value, data-selected, aria-valuetext, trigger
text, or the value of a closed input combobox) before reporting success. A query
in an open search input is not selection evidence. Unmatched controls remain
unfilled; there is no unbounded scrolling.

Run `node --test test/community-selects.test.mjs` or `npm.cmd test` on Windows.

## Click aftermath

`community-aftermath.test.mjs` serves a wizard with a same-page draft XHR,
navigation on final Submit, and misleading Continue buttons that commit.
Set `observeAftermath: true` on `act_fast`, `batch_actions`, or an individual
batch step, or set `TURBO_BROWSER_OBSERVE_AFTERMATH=true`. An explicit false
disables the observer. It adds one second per allowed click/double-click;
disabled by default, with no observer listeners or added delay.

The `aftermath` result contains before/after URLs, `navigated` (main-frame
origin/path change, excluding query/hash-only changes), and `mutatingRequests`
(fetch/XHR POST, PUT, PATCH, DELETE, with method, URL, and `finalSubmit`).
DELETE and paths containing submit, publish, commit, checkout, payment,
purchase, or delete are considered final-submit signals. Draft requests are
recorded without that classification. When allowSubmit is false, path changes
or final-submit signals set `aftermath.unexpectedSubmit` and a warning.

This is heuristic observation, not prevention or receipt verification. A
wizard navigation can be flagged and a commit to an opaque endpoint can be
missed. Requests after the observation window, other tabs and service-worker
activity may be missed. Existing label/network guards still apply; use
`expect` to verify a receipt. Do not retry solely because a warning appears.
