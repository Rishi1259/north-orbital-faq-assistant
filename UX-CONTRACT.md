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
