# Account knowledge management

Authority: M28 implementation brief; `backend/src/security/http.ts`, `sources/router.ts`, `sources/service.ts`, and `docs/milestone-27-verification.md`. Visual context: [DESIGN.md](DESIGN.md).

| Capability | Canonical owner | Behavior | Verification |
|---|---|---|---|
| Select/Listbox | Native select in account/knowledge | Platform popup; labelled; disabled while pending | Angular tests |
| Form | Knowledge component, Angular Forms | Inline validation, preserve input on failure, clear after successful save | knowledge.spec.ts |
| CRUD | SourceService API + Knowledge component | Refresh owning list; explicit sync queue acknowledgement; members read only | DB + Angular tests |
| Toast | Component status live region | Stable location; safe actionable text | Angular tests |
| Scrollbar | styles.scss | Visible platform scrollbars, global colors, forced-color fallback | Static audit |
| Confirmation | Knowledge native dialog | Name object/consequence, Cancel first, Escape closes, native focus restoration | Angular + browser when available |
| Date | Angular DatePipe | Local display of UTC server instants; no date entry | Angular build |

Lists use server pagination with 25 rows. Pagination is transient component state because the accepted account is an in-memory panel without routed account URLs. Organization/bot changes clear previous results and ignore stale responses. Saves serialize locally; server authorization/CSRF/rate limits remain authoritative. Editing drafts disable bot switching; Cancel explicitly discards the draft. Deleting a source cascades knowledge and work immediately; no Undo is promised. Failed requests retain fields and offer a refresh/retry. A source's last successful index remains available on failed resync; disabled/deleted sources are unavailable.

No redesign or unrelated migration of M27 account controls is authorized. Existing account controls remain the sibling reference; new knowledge workflows share their behavior internally.

## M29 contact and follow-up workflows

Business authority: M29 implementation brief; `backend/src/leads/model.ts`, `service.ts`, `router.ts`; existing tenant authorization in `security/http.ts`. API and lifecycle reference: `docs/milestone-29-verification.md`.

| Capability | Canonical owner | Behavior | Verification |
|---|---|---|---|
| Contact/settings forms | Leads component + Angular Forms; widget contact form | Labels, bounded plain text, explicit consent, preserve failed submissions | leads.spec.ts / widget.test.ts |
| Form/control/list styles | admin-workbench.scss + styles.scss tokens | Shared with Knowledge; natural scroll, native select, visible focus | Angular build / static inspection |
| Follow-up state | LeadService | Read-only members; owner/admin actions; conflict on stale revision | PostgreSQL integration |
| Pagination | LeadService list + Leads component | 25 rows, hasMore; reset on filter/delete; transient panel state | Angular + PostgreSQL tests |
| Details | Leads component inline region | Full message only in details; focus detail region after loading | Angular tests |
| Deletion confirmation | Native dialog pattern from Knowledge | Cancel first; explicit hard-delete/cascade consequence; native Escape/focus restoration | Angular tests; browser acceptance pending |
| Feedback | Component status live region | Stable placement; busy guard; safe errors; refresh/reopen after conflicts | Angular tests |
| Visitor retry | Widget in-memory request | Freeze accepted-attempt payload/key on ambiguous failure; retry same request, never persist in storage | Widget tests |

Organization changes clear previous data; stale responses are ignored. Settings drafts disable chatbot switching until save/cancel. Each new deliberate widget submission receives a UUID; retries retain it for the current form. Contact form dismissal discards its in-memory values and restores CTA focus. Empty queue/list states and previous/next boundaries remain explicit. Consent settings do not assert legal compliance. No automatic submission, transcript persistence, email notification, or live operator takeover is implied.
