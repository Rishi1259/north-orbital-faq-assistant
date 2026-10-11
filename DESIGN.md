---
version: alpha
name: North Orbital account
description: A practical organization workbench alongside the existing public chat.
colors:
  background: "#eef2f7"
  surface: "#ffffff"
  text: "#172033"
  muted: "#eef4ff"
  primary: "#2457a7"
  danger: "#a51d32"
typography:
  sans:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
  mono:
    fontFamily: "ui-monospace, monospace"
rounded:
  DEFAULT: "12px"
spacing:
  panel: "1.5rem"
  field: "1rem"
components:
  account:
    width: "850px"
    textColor: "{colors.text}"
  secondary:
    backgroundColor: "{colors.muted}"
  destructive:
    textColor: "{colors.danger}"
---

## Overview

Preserve the accepted account panel: a light, readable operational workbench for organization administrators. The knowledge list pairs a recognizable source name with its sync state and dates. This is product UI, not a marketing page. English is the existing interface language; no Japan-market behavior is inferred.

Runtime CSS is canonical. Existing values come from `frontend/src/styles.scss` and `account.ts`; knowledge controls consume the `--admin-*` variables in the global stylesheet. This file mirrors those values. Public chat styling remains unchanged.

## Colors

White surfaces and dark navy text retain the account identity. Pale blue supports secondary information. Primary blue marks keyboard focus; red is reserved for a named delete action or error, always with text.

## Typography

Inherit the existing sans-serif stack. Headings identify sections; regular text explains status. Technical URLs wrap rather than truncate. No external fonts are fetched.

## Layout

Natural document scrolling, 850px account width, stacked fields and source rows. Controls wrap at narrow widths. Status regions reserve one line. Avoid viewport-locked forms.

## Elevation & Depth

Use borders and spacing for hierarchy. Native modal dialog backdrop distinguishes deletion confirmation.

## Shapes

Preserve the account's 12px panel radius. Controls use native platform semantics.

## Components

Knowledge controls share one component and shared delete confirmation for both source kinds. Native selects are intentional: operating-system popup behavior is accepted. Dates use the user's locale and time zone. No decorative motion. Disabled actions explain pending state through a live region.

## Do's and Don'ts

- Keep source mutations available only to owner/admin roles.
- Preserve customer text as escaped text and provide explicit deletion consequences.
- Do not redesign the accepted account or public chat for this milestone.
- Do not display raw network errors, HTML, embeddings or credentials.

## M29 contact management

Lead settings, paginated leads, and follow-up details extend the same workbench. `frontend/src/app/admin-workbench.scss` now owns the shared knowledge/contact field, button, row, focus, feedback and dialog styles; its colors still resolve to `--admin-*` in `styles.scss`. Natural document scrolling and platform-native selects remain deliberate. Dense lists show contact summaries and status, while visitor messages appear in details. The widget uses its existing Shadow DOM palette and adds an inline contact form, preserving the main chat. No new fonts, theme or decorative motion.
