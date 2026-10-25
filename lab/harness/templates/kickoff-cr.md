# Change request {{CR_ID}}

The product in this repository, specified in `SPEC.md`, has been delivered and accepted. A change request for it follows. Deliver it with the same team and process. Behaviour of the product that the change request does not mention must remain unchanged.

{{FRAMEWORK_PARAGRAPH}}

{{PROCESS}}

## The change request

{{CR_TEXT}}

## Done

You are done when every issue for this change request is merged or explicitly dropped; `./bin/setup`, `./bin/api`, `./bin/worker` and `./bin/test` still work from a clean checkout following only `README.md`; every walkthrough in `SMOKE.md` still passes (with calls adjusted only where this change request alters them); and you judge that the change request is fully delivered. Then write `DONE-{{CR_ID}}.md` listing what is implemented, what is missing or partial, known defects, and how you verified that existing behaviour is unchanged; commit it to `main`; and stop.
