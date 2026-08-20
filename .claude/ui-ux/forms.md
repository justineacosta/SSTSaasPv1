# Forms

> **Status: Designed. Not Implemented.** Phase 1 (`FormLayout`, `FormField`), used throughout.

React Hook Form + Zod resolver, using **the same schema the API validates against**, imported
from `packages/contracts`. Client and server therefore cannot disagree about what is valid,
which is the usual source of "it looked fine until I submitted it".

## 1. Rules

1. **Client validation is UX; server validation is truth.** Never assume the client checked.
2. **Never clear a form on failure.** The user's input is theirs; losing it because the server
   said no is the fastest way to make someone abandon a product.
3. **Map server errors back to fields.** A field-level error belongs on the field, not in a
   banner at the top that leaves the user hunting.
4. **Disable submit while pending, and show it.** Double submission is the caller's problem
   only if we let it be.
5. **Warn before discarding unsaved changes**, on navigation and on tab close.
6. **Validate on blur, re-validate on change once a field has errored.** Validating on every
   keystroke from the start means telling someone their email is invalid while they type it.

## 2. Layout

Single column. Labels above inputs. Related fields grouped in `<fieldset>` with a `<legend>`.
Helper text below the label, before the input, so it is read before the field is filled rather
than after. Actions in a sticky footer for long forms; primary action right, cancel left,
destructive separated.

Required fields marked in text, not only with an asterisk colour. Optional fields marked
"(optional)" where most fields are required — marking the minority is less visual noise.

## 3. Validation messages

Name the problem and the fix, in the product's voice, without apology:

- "Enter a valid domain, like `app.example.com`." — not "Invalid input"
- "This project name is already in use in Acme Corp." — not "Duplicate"
- "Passwords must be at least 12 characters. This one is 8."
- "This target isn't covered by the project scope. Add an allow rule for `app.example.com`,
  or pick a different asset."

The last one is the pattern worth generalising: when we refuse something, we say what would
make it work, and we link to where they would do it.

## 4. Multi-step forms

Onboarding, scan creation, and report building are wizards. Each step: persists server-side on
completion so the user can leave and return; validates before advancing; allows going back
without losing entered data; shows progress with named steps, not a bare percentage; and
allows skipping where the step is genuinely optional — clearly marked, never for asset
ownership verification.

## 5. Sensitive inputs

Password fields: `autocomplete` correct (`current-password` / `new-password`), reveal toggle,
strength feedback that reflects the actual policy including the breach check, and no
paste-blocking — blocking paste breaks password managers and makes passwords weaker.

Secrets shown once (API keys, webhook secrets, recovery codes): a clear warning **before**
generation that this is the only time they will see it, a copy button, a download option, and
a confirmation checkbox before the dialog will close.

Credential fields for authenticated scanning: marked as stored encrypted, with a plain
explanation of what we do with them, and never re-displayed after saving.

## 6. Generated forms

Engine configuration forms are generated from the engine's `configurationSchema` JSON Schema.
No bespoke form per engine — adding an engine must not require frontend work
([`../scanners/adding-engines.md`](../scanners/adding-engines.md)). The generator supports
string, number, boolean, enum, array, and nested object, with `title`, `description`,
`default`, and `examples` from the schema driving labels, help text, and placeholders.

## 7. Accessibility

Covered in [`accessibility.md`](accessibility.md) §4. The essentials: visible labels always,
errors associated by `aria-describedby` and `aria-invalid`, focus to the first invalid field on
failed submission, and submission results announced through a live region.
