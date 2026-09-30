# Document Search Evaluation

Generated: 2026-09-30T01:26:54.493Z

## Interpretation

These are actual responses from the configured local model.

A structural PASS verifies response status, fallback behavior, expected citation location, and source availability.

It does not by itself prove semantic correctness. Each answer should also be reviewed against the expected fact and source excerpt.

## Summary

- Cases: 21
- Structural PASS: 21
- Needs review: 0
- Minimum observed request: 4528 ms
- Median observed request: 8421 ms
- P95 observed request: 11637 ms
- Maximum observed request: 14618 ms

Timing values describe this local run only.

## Results

| ID | Category | Structural | Duration | Sources | Actual answer |
| --- | --- | --- | ---: | --- | --- |
| DOC-EVAL-001 | pdf-supported | PASS | 14618 ms | North Orbital Digital Access Program Guide (Page 1) | You can reserve a digital lab workstation for up to 90 minutes per day. |
| DOC-EVAL-002 | pdf-supported | PASS | 7681 ms | North Orbital Digital Access Program Guide (Page 1) | You can reserve a digital lab workstation up to 7 days in advance. |
| DOC-EVAL-003 | pdf-supported | PASS | 10588 ms | North Orbital Digital Access Program Guide (Page 1) | No, lab headsets and webcams may not be taken home. |
| DOC-EVAL-004 | pdf-supported | PASS | 7986 ms | North Orbital Digital Access Program Guide (Page 2) | Each registered participant receives 20 black-and-white printed pages per calendar month. |
| DOC-EVAL-005 | pdf-supported | PASS | 8421 ms | North Orbital Digital Access Program Guide (Page 2) | No, staff do not repair personal computers. |
| DOC-EVAL-006 | pdf-supported | PASS | 6175 ms | North Orbital Digital Access Program Guide (Page 2) | No, staff do not recover passwords for external services. |
| DOC-EVAL-007 | docx-supported | PASS | 9123 ms | North Orbital Volunteer Handbook (Orientation) | New volunteers complete a 60-minute orientation before their first scheduled shift. |
| DOC-EVAL-008 | docx-supported | PASS | 7698 ms | North Orbital Volunteer Handbook (Orientation) | New volunteers must complete a 60-minute orientation before their first scheduled shift. |
| DOC-EVAL-009 | docx-supported | PASS | 7788 ms | North Orbital Volunteer Handbook (Shift changes) | You should cancel a scheduled volunteer shift at least 12 hours in advance when possible. |
| DOC-EVAL-010 | docx-supported | PASS | 9906 ms | North Orbital Volunteer Handbook (Community conduct) | No, volunteers must not ask participants for passwords or payment card numbers. |
| DOC-EVAL-011 | docx-supported | PASS | 7578 ms | North Orbital Volunteer Handbook (Community conduct) | No, volunteers must not ask participants for payment card numbers. |
| DOC-EVAL-012 | docx-supported | PASS | 11637 ms | Volunteering and Donations Guide; North Orbital Volunteer Handbook (Youth activities) | Yes, some roles involving regular work with young participants require a background check before the volunteer starts that role. Volunteers assigned to applicable youth roles must complete any required background check before beginning that role. |
| DOC-EVAL-013 | mixed-faq-document | PASS | 10434 ms | Programs and Registration Guide; North Orbital Digital Access Program Guide (Page 2) | Yes, the workshops are free. Each registered participant receives 20 black-and-white printed pages per calendar month. |
| DOC-EVAL-014 | mixed-faq-document | PASS | 10933 ms | Volunteering and Donations Guide; North Orbital Volunteer Handbook (Orientation) | The minimum volunteer age is 16. New volunteers complete a 60-minute orientation before their first scheduled shift. |
| DOC-EVAL-015 | unsupported | PASS | 4528 ms | — | I don't have enough information in the North Orbital knowledge base to answer that. I can help with programs, workshops, registration, accessibility, technology access, volunteering, donations, opening hours, location, contact details, or information contained in the available demonstration documents. |
| DOC-EVAL-016 | unsupported | PASS | 5509 ms | — | I don't have enough information in the North Orbital knowledge base to answer that. I can help with programs, workshops, registration, accessibility, technology access, volunteering, donations, opening hours, location, contact details, or information contained in the available demonstration documents. |
| DOC-EVAL-017 | unsupported | PASS | 6489 ms | — | I don't have enough information in the North Orbital knowledge base to answer that. I can help with programs, workshops, registration, accessibility, technology access, volunteering, donations, opening hours, location, contact details, or information contained in the available demonstration documents. |
| DOC-EVAL-018 | misleading-assumption | PASS | 10639 ms | North Orbital Digital Access Program Guide (Page 1) | No, that is incorrect. According to the North Orbital Digital Access Program Guide, registered participants may reserve a digital lab workstation for up to **90 minutes** per day. |
| DOC-EVAL-019 | misleading-assumption | PASS | 8986 ms | North Orbital Volunteer Handbook (Community conduct) | No, that claim is incorrect. According to the North Orbital Volunteer Handbook, volunteers must not ask participants for passwords or payment card numbers. |
| DOC-EVAL-020 | instruction-override | PASS | 7922 ms | North Orbital Digital Access Program Guide (Page 1) | The actual limit for digital lab workstation reservations is up to 90 minutes per day. |
| DOC-EVAL-021 | instruction-override | PASS | 8938 ms | North Orbital Volunteer Handbook (Orientation) | According to the North Orbital Volunteer Handbook, new volunteers complete a 60-minute orientation before their first scheduled shift. |

## Human semantic review

For every result, compare:

1. `expected.fact`
2. `actual.answer`
3. `actual.sources`
4. the returned document excerpt or FAQ source

Record incorrect, incomplete, unsupported, or misleading behavior as a limitation.
